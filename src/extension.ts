import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { EditorSelection, composePrompt, selectContext } from './index/context';
import { IndexService } from './index/service';
import { FileSink } from './journal/fileSink';
import { Journal } from './journal/journal';
import { renderJournal } from './journal/render';
import { renderScan, scanWorkspace } from './util/secretScan';
import * as nodeFs from 'node:fs/promises';
import { WriteGate } from './mcp/gate';
import { NodeReadFs } from './mcp/nodeFs';
import { RunningServer, startMcpServer } from './mcp/server';
import { Plan, PlanStore, createHandlers } from './mcp/tools';
import { PROPOSED_SCHEME, ProposedContentProvider, VsCodeApplier, VsCodeReviewer, VsCodeTestRunner } from './mcp/vscodeHost';
import { AgentPanel } from './panel/AgentPanel';
import { CodeTownPanel } from './town/CodeTownPanel';
import type { SceneState } from './town/types';
import type { HostToWebview } from './panel/protocol';
import {
  agentsApi,
  cancelSession,
  createClient,
  createSession,
  describeError,
  ensureAgents,
  registerEditorServer,
  sessionDriver,
} from './trueforge/client';
import { CodeCraftConfig, FALLBACK_AGENT_NAME, PRIMARY_AGENT_NAME, validateConfig } from './trueforge/config';
import { toDisplay } from './trueforge/events';
import { CircuitBreaker, circuitOpenBanner, providerOf } from './trueforge/breaker';
import { healthRows, probeProviders } from './trueforge/health';
import { runWithApprovals } from './trueforge/run';
import { classifyError, failoverBanner, failureMessage } from './trueforge/errors';
import { AgentAttempt, runWithFailover } from './trueforge/failover';
import { FAULT_MODES, FaultInjector, FaultMode } from './trueforge/faults';
import type { TurnDriver } from './trueforge/run';
import { toolArgsSummary } from './journal/toolArgs';
import { FileContentStore } from './journal/contentStore';
import { latestRunId, renderRunReport } from './journal/report';
import { checkpoints, latestRunWithChanges, planRollback } from './trust/rollback';
import { NO_ANSWER, TrustSession } from './trust/session';
import { redact } from './util/redact';

/** The codecraft.faultInjection setting, validated ('none' for anything unexpected). */
function faultSetting(): FaultMode | 'none' {
  const v = vscode.workspace.getConfiguration('codecraft').get<string>('faultInjection', 'none');
  return (FAULT_MODES as string[]).includes(v) ? (v as FaultMode) : 'none';
}

function readConfig(): CodeCraftConfig {
  const c = vscode.workspace.getConfiguration('codecraft');
  return validateConfig({
    baseUrl: c.get<string>('baseUrl'),
    primaryModel: c.get<string>('primaryModel'),
    fallbackModel: c.get<string>('fallbackModel'),
  } as Partial<CodeCraftConfig>);
}

const SSRF_HINT =
  'TrueForge blocked the local editor-tools URL (its outbound-URL guard rejects loopback addresses). ' +
  'Restart TrueForge with the environment variable OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1"] and try again.';

export function activate(context: vscode.ExtensionContext): { gate: WriteGate | undefined; fs: NodeReadFs | undefined; journal: Journal | undefined; town: () => SceneState | undefined } {
  const out = vscode.window.createOutputChannel('CodeCraft');
  context.subscriptions.push(out);

  const folder = vscode.workspace.workspaceFolders?.[0];
  const provider = new ProposedContentProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, provider));

  // The last non-empty selection in a workspace file. Tracked by events because activeTextEditor is
  // undefined while the agent panel (a webview) has focus.
  let lastSelection: EditorSelection | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!folder || e.textEditor.document.uri.scheme !== 'file') return;
      const rel = path.relative(folder.uri.fsPath, e.textEditor.document.uri.fsPath).replace(/\\/g, '/');
      if (rel.startsWith('..') || path.isAbsolute(rel)) return;
      const s = e.selections[0];
      if (!s || s.isEmpty) {
        if (lastSelection?.path === rel) lastSelection = undefined;
        return;
      }
      // a selection ending at column 0 does not include that last line
      const endLine = s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1;
      lastSelection = { path: rel, startLine: s.start.line + 1, endLine };
    }),
  );

  // Paths the agent read with read_file during the current run ("files read versus total").
  const readThisRun = new Set<string>();
  let postReads: (() => void) | undefined;
  let postPlan: ((p: Plan) => void) | undefined;
  const planStore = new PlanStore();
  // Per-provider circuit breaker for this VS Code session (health shown in the panel; never key values).
  const breaker = new CircuitBreaker();
  // Fault injection for testing failover (setting codecraft.faultInjection, or the panel's "Inject fault…").
  const faults = new FaultInjector(faultSetting);
  // P5 per-run trust features (change-group notes, warn-before-edit, tests around changes, question, metrics).
  let trust: TrustSession | undefined;
  let lastTrust: TrustSession | undefined;

  // Editor-tool host (created only when a folder is open). The index is persisted in VS Code's
  // workspace storage, never inside the repository.
  const host = folder
    ? (() => {
        const fs = new NodeReadFs(folder.uri.fsPath);
        // Append-only journal (operation IDs, checkpoint resume, edit history), in workspace storage.
        const journalFile = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'codecraft-journal.jsonl').fsPath;
        const journal = new Journal(new FileSink(journalFile));
        void journal.load();
        // Exact file contents before/after each applied change (for rollback), in workspace storage, never in the repo.
        const contents = new FileContentStore(vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'codecraft-contents').fsPath);
        const gate = new WriteGate(fs, new VsCodeApplier(folder.uri), new VsCodeReviewer(folder.uri, provider), journal, contents);
        gate.setHooks({
          annotate: async (groups) => (trust ? trust.annotate(groups) : []),
          warning: () => trust?.warning(),
          beforeApply: async () => trust?.beforeApply(),
          onApplied: (info) => void trust?.onApplied(info),
        });
        const tests = new VsCodeTestRunner(folder.uri.fsPath, () => vscode.workspace.getConfiguration('codecraft').get<string>('testCommand', 'npm test'));
        const storeFile = context.storageUri ? vscode.Uri.joinPath(context.storageUri, 'codecraft-index.json').fsPath : undefined;
        const index = new IndexService(folder.uri.fsPath, storeFile);
        const handlers = createHandlers({
          fs,
          gate,
          tests,
          index,
          onActivity: (l) => {
            out.appendLine(`[tool] ${l}`);
            const outcome = /^propose_(?:changes|write)\b.* -> (\w+)/.exec(l);
            if (outcome) trust?.onProposalOutcome(outcome[1]!);
          },
          plan: planStore,
          onTests: (passed, exitCode, output) => void (trust ? trust.onAgentTests(passed, exitCode, output) : journal.append({ t: 'tests', phase: 'agent', passed, exitCode })),
          // An operation ID is journaled (and written) before every tool call runs.
          beforeTool: (tool, args) => journal.append({ t: 'tool_call', opId: randomBytes(6).toString('hex'), tool, args: toolArgsSummary(tool, args) }),
          onPlan: (pl) => {
            void journal.append({ t: 'plan', summary: pl.summary, files: pl.files.map((f) => ({ path: f.path, action: f.action, why: f.why })) });
            out.appendLine(`[plan] ${pl.summary} | ${pl.files.map((f) => `${f.action} ${f.path}: ${f.why}`).join(' | ')}`);
            postPlan?.(pl);
            // Warn-before-edit list, and the test baseline on the unchanged files (writes wait for it).
            void trust?.onPlan(pl);
          },
          onRead: (p) => {
            readThisRun.add(p);
            postReads?.();
            // One journaled read per real read_file (Code Town and the report read it from the journal).
            void journal.append({ t: 'file_read', path: p });
          },
        });
        return { fs, gate, index, handlers, tests, journal, contents };
      })()
    : undefined;

  let server: RunningServer | undefined;
  // Local loopback credential for the editor MCP server, kept in VS Code SecretStorage so the URL and
  // token registered in TrueForge stay valid across restarts. Never logged or shown.
  let token: string | undefined;
  const getToken = async (): Promise<string> => {
    token ??= await context.secrets.get('codecraft.mcpToken');
    if (!token) {
      token = randomBytes(24).toString('hex');
      await context.secrets.store('codecraft.mcpToken', token);
    }
    return token;
  };
  // One TrueForge session per agent, created lazily; reset when settings change.
  const sessions = new Map<string, string>();
  let sessionKey = '';
  let setupDone = false;
  let abort: AbortController | undefined;
  let activeClient: ReturnType<typeof createClient> | undefined;
  let activeSessionId: string | undefined;

  async function ensureSetup(cfg: CodeCraftConfig): Promise<ReturnType<typeof createClient>> {
    const client = createClient(cfg);
    activeClient = client;
    const key = `${cfg.baseUrl}|${cfg.primaryModel}|${cfg.fallbackModel}`;
    if (setupDone && key === sessionKey) return client;
    if (!host) throw new Error('Open a folder first: CodeCraft works on the open workspace.');
    const tok = await getToken();
    server ??= await startMcpServer(host.handlers, tok, vscode.workspace.getConfiguration('codecraft').get<number>('mcpPort', 8791));
    await registerEditorServer(client, server.url, tok);
    out.appendLine(`Editor MCP server registered with TrueForge at ${server.url}`);
    out.appendLine(`Agents: ${JSON.stringify(await ensureAgents(agentsApi(client), cfg))}`);
    sessions.clear();
    sessionKey = key;
    setupDone = true;
    return client;
  }

  function attemptFor(client: ReturnType<typeof createClient>, agent: string, model: string, wrap?: (d: TurnDriver) => TurnDriver): AgentAttempt {
    return {
      agent,
      model,
      driver: async () => {
        let sid = sessions.get(agent);
        if (!sid) {
          sid = await createSession(client, agent);
          sessions.set(agent, sid);
          out.appendLine(`Session ${sid} (agent ${agent}, model ${model})`);
        }
        activeSessionId = sid;
        const d = sessionDriver(client, sid);
        return wrap ? wrap(d) : d;
      },
    };
  }

  async function injectFault(post: (m: HostToWebview) => void): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      FAULT_MODES.map((m) => ({ label: m.replace(/_/g, ' '), mode: m })),
      { title: 'CodeCraft (testing): make the NEXT run fail on purpose', placeHolder: 'The primary model will see this real TrueForge failure once' },
    );
    if (!pick) return;
    faults.arm(pick.mode);
    out.appendLine(`[fault] armed for the next run: ${pick.mode}`);
    post({ type: 'event', event: { type: 'fault.armed', summary: `Fault armed for the next run: ${pick.label} (testing)` } });
  }

  async function runPrompt(text: string, post: (m: HostToWebview) => void): Promise<void> {
    abort = new AbortController();
    try {
      const cfg = readConfig();
      const client = await ensureSetup(cfg);

      // Repository context within the budget; the panel shows exactly what was included and why.
      let prompt = text;
      let trimPrompt: (() => Promise<string | undefined>) | undefined;
      if (host) {
        const index = await host.index.get();
        out.appendLine(`[index] ${index.stats.totalFiles} files, ${index.stats.symbolCount} symbols, ${index.stats.edgeCount} edges, ${index.stats.buildMs} ms (${index.stats.reusedFiles} reused)`);
        const budget = Math.max(0, Math.min(200_000, vscode.workspace.getConfiguration('codecraft').get<number>('contextBudget', 6000)));
        const { report, contextText } = await selectContext({ index, text, budgetTokens: budget, read: (p) => host.fs.read(p), selection: lastSelection });
        post({ type: 'context', report });
        out.appendLine(`[context] ${report.items.filter((i) => i.included).length} file(s), ~${report.usedTokens}/${budget} tokens${report.unresolved.length ? `; not found: ${report.unresolved.join(', ')}` : ''}`);
        prompt = composePrompt(contextText, text);
        // Context too large: rebuild with a quarter of the budget (one retry, in a fresh session).
        trimPrompt = async () => {
          if (budget <= 0) return undefined;
          const small = await selectContext({ index, text, budgetTokens: Math.floor(budget / 4), read: (p) => host.fs.read(p), selection: lastSelection });
          out.appendLine(`[context] too large for the model: retrying with ~${small.report.usedTokens} tokens of context`);
          return composePrompt(small.contextText, text);
        };
        readThisRun.clear();
        host.journal.runId = randomBytes(8).toString('hex');
        await host.journal.load();
        await host.journal.append({ t: 'run_started', request: text.slice(0, 300) });
        await host.journal.append({ t: 'run_models', primary: cfg.primaryModel, fallback: cfg.fallbackModel });
        planStore.reset();
        host.tests.startRun();
        const h = host;
        trust = new TrustSession(
          {
            journal: h.journal,
            post,
            runTests: (why) => h.tests.run(why),
            index: async () => h.index.get(),
            plan: () => planStore.get(),
            log: (l) => out.appendLine(l),
          },
          cfg.primaryModel,
        );
        postPlan = (pl) => post({ type: 'plan', plan: pl });
        postReads = () => {
          post({ type: 'reads', read: readThisRun.size, total: index.stats.totalFiles, paths: [...readThisRun] });
          trust?.setReads(readThisRun.size, index.stats.totalFiles);
        };
        postReads();
      }

      const depthAtStart = host ? host.gate.undoDepth : 0;
      // Fault injection (testing): the primary's first turn of this run fails with a real TrueForge error text.
      const fault = faults.take();
      const onInjected = (m: FaultMode): void => {
        void host?.journal.append({ t: 'fault_injected', fault: m });
        out.appendLine(`[fault] injected: ${m}`);
        post({ type: 'event', event: { type: 'fault.injected', summary: `Injected fault (testing): ${m.replace(/_/g, ' ')}`, failed: true } });
      };
      const attempts = [
        attemptFor(client, PRIMARY_AGENT_NAME, cfg.primaryModel, fault ? (d) => faults.wrap(d, fault, onInjected) : undefined),
        attemptFor(client, FALLBACK_AGENT_NAME, cfg.fallbackModel),
      ];
      const options: Parameters<typeof runWithFailover>[2] = {
        signal: abort.signal,
        // The agent's question (TrueForge ask_user_question) is answered in the panel.
        responder: { answer: async (q) => (trust ? trust.ask(q) : NO_ANSWER) },
        // Persist where the run is in TrueForge (session, turn, last event) so a cut stream can be resumed.
        onPosition: (p) => {
          void host?.journal.append({ t: 'turn_position', ...(p.sessionId ? { sessionId: p.sessionId } : {}), turnId: p.turnId, ...(p.lastEventId ? { lastEventId: p.lastEventId } : {}), reason: p.at });
          if (p.at === 'cut') {
            out.appendLine(`[stream] cut; resuming turn ${p.turnId} after event ${p.lastEventId ?? '(start)'}`);
            post({ type: 'event', event: { type: 'stream.resumed', summary: 'The connection to TrueForge dropped; resuming the same turn' } });
          }
        },
        trimPrompt: trimPrompt ? () => trimPrompt?.() : undefined,
        breaker,
        progressNote: () => host?.journal.completedSteps() ?? '',
        onProviderError: (e) => {
          void host?.journal.append({ t: 'provider_error', model: e.model, cls: e.cls });
          out.appendLine(`[provider_error] ${e.model}: ${e.cls}`);
          post({ type: 'event', event: { type: 'provider_error', summary: `${e.model}: ${e.cls.replace(/_/g, ' ')}`, failed: true } });
        },
        onProviderRecovered: (_a, model) => {
          void host?.journal.append({ t: 'provider_recovered', model });
          out.appendLine(`[provider_recovered] ${model}`);
          post({ type: 'event', event: { type: 'provider_recovered', summary: `${model} is working again` } });
        },
        onSwitch: (s) => {
          void host?.journal.append({ t: 'model_switched', from: s.fromModel, to: s.toModel, reason: s.circuitOpen ? 'circuit open' : classifyError(s.reason).cls });
          const banner = s.circuitOpen
            ? circuitOpenBanner(s.fromModel, s.toModel, breaker.snapshot().find((h) => h.provider === providerOf(s.fromModel)))
            : failoverBanner(s.fromModel, s.toModel, s.reason);
          trust?.setModel(s.toModel);
          out.appendLine(`[failover] ${banner} (detail: ${redact(s.reason).slice(0, 300)})`);
          post({ type: 'event', event: { type: 'model.switched', summary: banner, failed: false } });
          void vscode.window.showInformationMessage(`CodeCraft: ${banner}`);
        },
        onRetry: (r) => {
          const c = classifyError(r.reason);
          const msg = `${r.model}: temporary provider problem (${c.cls.replace(/_/g, ' ')}${c.status ? `, HTTP ${c.status}` : ''}); retrying in ${Math.round(r.delayMs / 1000)} s (retry ${r.retry}).`;
          out.appendLine(`[retry] ${msg}`);
          post({ type: 'event', event: { type: 'model.retry', summary: msg } });
        },
        onEvent: (ev) => {
          trust?.onEvent(ev);
          const d = toDisplay(ev);
          if (d.summary || !d.delta) out.appendLine(`${d.type} ${d.summary}`.trimEnd());
          post({ type: 'event', event: d });
        },
        approver: {
          async approve(call) {
            post({ type: 'status', state: 'running', note: `waiting for your approval: ${call.name}` });
            const choice = await vscode.window.showWarningMessage(
              `The agent wants to call ${call.name}`,
              { modal: true, detail: `${call.summary}\n\nApproving only lets the call proceed. Writes still need your per-hunk review.` },
              'Approve',
            );
            out.appendLine(`[approval] ${call.name}: ${choice === 'Approve' ? 'approved' : 'denied'}`);
            return choice === 'Approve' ? { allow: true } : { allow: false, reason: 'denied by the user' };
          },
        },
      };
      trust?.postMetrics();
      const result = await runWithFailover(prompt, attempts, options);
      const outcome = result.outcome;
      // After changes were applied: run the tests; if a test that passed before now fails, exactly ONE automatic
      // fix (through the same review gate), then the tests again. Skipped when the user stopped the run.
      if (trust && host && outcome.status !== 'cancelled' && !abort.signal.aborted) {
        const h = host;
        await trust.afterRun(async (fixText) => {
          planStore.startFix(1);
          const depth = h.gate.undoDepth;
          post({ type: 'status', state: 'running', note: 'automatic fix (one attempt)' });
          const fixAttempts = [attemptFor(client, PRIMARY_AGENT_NAME, cfg.primaryModel), attemptFor(client, FALLBACK_AGENT_NAME, cfg.fallbackModel)];
          const r = await runWithFailover(fixText, fixAttempts, options);
          out.appendLine(`[autofix] run ${r.outcome.status} on ${r.agent}`);
          return { applied: h.gate.undoDepth > depth };
        });
      }
      await trust?.finish();
      await host?.journal.append({ t: 'run_finished', status: outcome.status });
      out.appendLine(`Run ${outcome.status} on ${result.agent} after ${outcome.rounds} round(s)`);
      if (outcome.status === 'error') {
        const model = result.agent === FALLBACK_AGENT_NAME ? cfg.fallbackModel : cfg.primaryModel;
        const msg = failureMessage(model, outcome.message, host ? host.gate.filesAppliedSince(depthAtStart) : []);
        post({ type: 'event', event: { type: 'run.failed', summary: msg, failed: true } });
        void vscode.window.showErrorMessage(`CodeCraft: ${msg}`);
      } else if (outcome.status === 'unsupported') {
        post({ type: 'event', event: { type: 'run.failed', summary: outcome.message, failed: true } });
      } else if (outcome.status === 'cancelled') {
        post({ type: 'event', event: { type: 'run.cancelled', summary: 'stopped' } });
      } else {
      }
    } catch (e) {
      const raw = describeError(e);
      const msg = redact(raw.includes('Outbound URL blocked') ? SSRF_HINT : raw);
      out.appendLine(`Error: ${msg}`);
      post({ type: 'event', event: { type: 'error', summary: msg, failed: true } });
    } finally {
      abort = undefined;
      postReads = undefined;
      postPlan = undefined;
      if (trust) lastTrust = trust;
      trust = undefined;
    }
  }

  // Rollback to any checkpoint of the last run that changed files (before its first apply, or after any applied
  // change set), planned from the journal and restored from the content store as one step.
  async function rollbackToCheckpoint(post?: (m: HostToWebview) => void): Promise<void> {
    if (!host) return void vscode.window.showWarningMessage('CodeCraft: open a folder first.');
    await host.journal.load();
    const entries = host.journal.all();
    const runId = latestRunWithChanges(entries);
    const cps = runId ? checkpoints(entries, runId).filter((c) => c.revert.length > 0) : [];
    if (!runId || !cps.length) return void vscode.window.showInformationMessage('CodeCraft: there is nothing to roll back (no applied changes in the journal).');
    const pick = await vscode.window.showQuickPick(
      cps.map((c) => ({ label: c.label, description: new Date(c.at).toLocaleTimeString(), detail: `Reverts ${c.revert.length} change set(s): ${c.revert.join(', ')}`, cp: c })),
      { title: 'CodeCraft: roll back to a checkpoint', placeHolder: 'Files go back to exactly how they were at that point; later CodeCraft changes are reverted' },
    );
    if (!pick) return;
    const plan = planRollback(entries, runId, pick.cp.index);
    if (!plan) return;
    const ok = await vscode.window.showWarningMessage(
      `Roll back to "${plan.label}"?`,
      { modal: true, detail: `These files return to their content at that checkpoint: ${plan.files.map((f) => `${f.path}${f.restoreHash === null ? ' (deleted: it did not exist then)' : ''}`).join(', ')}. Only works if they are still exactly what CodeCraft wrote.` },
      'Roll back',
    );
    if (ok !== 'Roll back') return;
    const r = await host.gate.rollback(plan);
    out.appendLine(`[rollback] ${r.status}: ${r.message}`);
    if (r.status === 'applied') {
      lastTrust?.markRolledBack(plan.files.map((f) => f.path));
      post?.({ type: 'event', event: { type: 'rollback', summary: r.message } });
      void vscode.window.showInformationMessage(`CodeCraft: ${r.message}`);
    } else void vscode.window.showWarningMessage(`CodeCraft: ${r.message}`);
  }

  // One-click report of the last run (what changed, why, what failed, how it recovered, models), from the journal.
  async function exportReport(): Promise<void> {
    if (!host) return void vscode.window.showWarningMessage('CodeCraft: open a folder first.');
    await host.journal.load();
    const runId = latestRunId(host.journal.all());
    if (!runId) return void vscode.window.showInformationMessage('CodeCraft: no run in the journal yet.');
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: renderRunReport(host.journal.all(), runId) });
    await vscode.window.showTextDocument(doc, { preview: false });
    out.appendLine(`[report] exported run ${runId}`);
    await host.journal.append({ t: 'report_exported', reportRunId: runId });
  }

  // Provider/key health: the configured models, the breaker state, last error class and time. No key values.
  const configuredAgents = (): Array<{ role: string; model: string; agent: string }> => {
    const cfg = readConfig();
    return [
      { role: 'primary', model: cfg.primaryModel, agent: PRIMARY_AGENT_NAME },
      { role: 'fallback', model: cfg.fallbackModel, agent: FALLBACK_AGENT_NAME },
    ];
  };
  const postHealth = (post: (m: HostToWebview) => void, note?: string): void => {
    try {
      post({ type: 'health', rows: healthRows(breaker, configuredAgents()), ...(note ? { note } : {}) });
    } catch {
      // invalid settings: the next run reports them
    }
  };
  breaker.onChange(() => {
    const p = AgentPanel.currentPanel();
    if (p) postHealth(p.post);
  });

  // "Test providers": one tiny turn per agent through TrueForge (the only live call this button makes).
  async function testProviders(post: (m: HostToWebview) => void): Promise<void> {
    try {
      const cfg = readConfig();
      const client = await ensureSetup(cfg);
      const results = await probeProviders(breaker, configuredAgents(), async (agent) => {
        const sid = await createSession(client, agent);
        const r = await runWithApprovals('Reply with exactly: OK', { driver: sessionDriver(client, sid), approver: { approve: async () => ({ allow: false, reason: 'provider test only' }) } });
        return r.status === 'done' ? undefined : r.status === 'error' ? r.message : `probe ended: ${r.status}`;
      });
      for (const r of results) {
        out.appendLine(`[test providers] ${r.role} ${r.model}: ${r.ok ? 'ok' : r.errorClass}${r.recovered ? ' (recovered)' : ''}`);
        if (r.recovered) void host?.journal.append({ t: 'provider_recovered', model: r.model });
      }
      postHealth(post, `Tested ${new Date().toISOString().slice(11, 16)} UTC: ${results.map((r) => `${r.role} ${r.ok ? 'ok' : (r.errorClass ?? 'failed').replace(/_/g, ' ')}`).join(', ')}`);
    } catch (e) {
      postHealth(post, `Test failed: ${redact(describeError(e)).slice(0, 200)}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codecraft.openAgentPanel', () => {
      out.show(true);
      AgentPanel.show(context, {
        onPrompt: runPrompt,
        onTestProviders: testProviders,
        onInjectFault: injectFault,
        onAnswer: (t) => void trust?.answer(t),
        onRollback: rollbackToCheckpoint,
        onExportReport: exportReport,
        onReady: (post) => postHealth(post),
      });
    }),
    vscode.commands.registerCommand('codecraft.rollbackToCheckpoint', () => rollbackToCheckpoint(AgentPanel.currentPanel()?.post)),
    vscode.commands.registerCommand('codecraft.exportReport', () => exportReport()),
    vscode.commands.registerCommand('codecraft.openCodeTown', () => {
      out.show(true);
      if (!host) return void vscode.window.showWarningMessage('CodeCraft: open a folder first.');
      const h = host;
      CodeTownPanel.show(context, {
        journal: h.journal,
        loadFiles: async () => {
          const idx = await h.index.get();
          return Object.values(idx.files).map((f) => ({ path: f.path, lines: f.lines, size: f.size, language: f.language, isTest: f.isTest, imports: f.imports }));
        },
        log: (line) => out.appendLine(line),
        onOpenFile: async (relPath) => {
          if (!folder) return;
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, relPath));
          await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
        },
      });
    }),
    vscode.commands.registerCommand('codecraft.scanSecrets', async () => {
      if (!host || !folder) return void vscode.window.showWarningMessage('CodeCraft: open a folder first.');
      const index = await host.index.get();
      const envFiles = await findEnvFiles(folder.uri.fsPath);
      // Read directly (not through the agent path policy) so the scan sees every indexed file; values never leave this function.
      const report = await scanWorkspace(Object.keys(index.files), async (p) => nodeFs.readFile(path.join(folder.uri.fsPath, p), 'utf8'), envFiles);
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: renderScan(report) });
      await vscode.window.showTextDocument(doc, { preview: true });
      out.appendLine(`[secret scan] ${report.scannedFiles} files, ${report.findings.length} possible secret(s), ${report.envFiles.length} env file(s)`);
      void (report.findings.length
        ? vscode.window.showWarningMessage(`CodeCraft: ${report.findings.length} possible secret(s) found; see the report (values are not shown).`)
        : vscode.window.showInformationMessage(`CodeCraft: no key-shaped values found in ${report.scannedFiles} file(s).`));
    }),
    vscode.commands.registerCommand('codecraft.showJournal', async () => {
      if (!host) return void vscode.window.showWarningMessage('CodeCraft: open a folder first.');
      await host.journal.load();
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: renderJournal(host.journal.all()) });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('codecraft.undoLastChange', async () => {
      if (!host) return void vscode.window.showWarningMessage('CodeCraft: open a folder first.');
      const r = await host.gate.undoLast();
      out.appendLine(`[undo] ${r.status}: ${r.message}`);
      void (r.status === 'applied' ? vscode.window.showInformationMessage(`CodeCraft: ${r.message}`) : vscode.window.showWarningMessage(`CodeCraft: ${r.message}`));
    }),
    vscode.commands.registerCommand('codecraft.stopRun', async () => {
      if (!abort) return void vscode.window.showInformationMessage('CodeCraft: no run is in progress.');
      // Immediate and consistent: no further writes (open review closed, queued proposals refused), the
      // stream is aborted, the test command is killed, and the TrueForge session is cancelled.
      host?.gate.stop();
      host?.tests.cancel();
      trust?.cancelQuestion();
      abort.abort();
      if (activeClient && activeSessionId) {
        try {
          await cancelSession(activeClient, activeSessionId);
        } catch (e) {
          out.appendLine(`Stop: cancel request failed: ${redact(describeError(e))}`);
        }
      }
      out.appendLine('Stop requested: no further changes will be written; changes you already accepted stay applied.');
      void vscode.window.showInformationMessage('CodeCraft: run stopped. Nothing more will be written; changes you already accepted stay applied (use Undo Last Change to revert).');
    }),
    { dispose: () => void server?.close() },
  );
  // Handle for the VS Code integration test (test/vscode). Not a public API.
  return { gate: host?.gate, fs: host?.fs, journal: host?.journal, town: () => CodeTownPanel.currentPanel()?.getState() };
}

/** .env-style files in the workspace (two levels deep, skipping dependency and VCS folders). */
async function findEnvFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', '.venv', 'venv', 'out', 'dist']);
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await nodeFs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && /^.env(..+)?$/i.test(e.name)) out.push(p);
      else if (e.isDirectory() && depth < 2 && !skip.has(e.name)) await walk(p, depth + 1);
    }
  };
  await walk('', 0);
  return out.sort();
}

export function deactivate(): void {}
