import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { EditorSelection, composePrompt, selectContext } from './index/context';
import { IndexService } from './index/service';
import { WriteGate } from './mcp/gate';
import { NodeReadFs } from './mcp/nodeFs';
import { RunningServer, startMcpServer } from './mcp/server';
import { createHandlers } from './mcp/tools';
import { PROPOSED_SCHEME, ProposedContentProvider, VsCodeApplier, VsCodeReviewer, VsCodeTestRunner } from './mcp/vscodeHost';
import { AgentPanel } from './panel/AgentPanel';
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
import { classifyError, failoverBanner, failureMessage } from './trueforge/errors';
import { AgentAttempt, runWithFailover } from './trueforge/failover';
import { redact } from './util/redact';

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

export function activate(context: vscode.ExtensionContext): { gate: WriteGate | undefined; fs: NodeReadFs | undefined } {
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

  // Editor-tool host (created only when a folder is open). The index is persisted in VS Code's
  // workspace storage, never inside the repository.
  const host = folder
    ? (() => {
        const fs = new NodeReadFs(folder.uri.fsPath);
        const gate = new WriteGate(fs, new VsCodeApplier(folder.uri), new VsCodeReviewer(folder.uri, provider));
        const tests = new VsCodeTestRunner(folder.uri.fsPath, () => vscode.workspace.getConfiguration('codecraft').get<string>('testCommand', 'npm test'));
        const storeFile = context.storageUri ? vscode.Uri.joinPath(context.storageUri, 'codecraft-index.json').fsPath : undefined;
        const index = new IndexService(folder.uri.fsPath, storeFile);
        const handlers = createHandlers({
          fs,
          gate,
          tests,
          index,
          onActivity: (l) => out.appendLine(`[tool] ${l}`),
          onRead: (p) => {
            readThisRun.add(p);
            postReads?.();
          },
        });
        return { fs, gate, index, handlers };
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

  function attemptFor(client: ReturnType<typeof createClient>, agent: string, model: string): AgentAttempt {
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
        return sessionDriver(client, sid);
      },
    };
  }

  async function runPrompt(text: string, post: (m: HostToWebview) => void): Promise<void> {
    abort = new AbortController();
    try {
      const cfg = readConfig();
      const client = await ensureSetup(cfg);

      // Repository context within the budget; the panel shows exactly what was included and why.
      let prompt = text;
      if (host) {
        const index = await host.index.get();
        out.appendLine(`[index] ${index.stats.totalFiles} files, ${index.stats.symbolCount} symbols, ${index.stats.edgeCount} edges, ${index.stats.buildMs} ms (${index.stats.reusedFiles} reused)`);
        const budget = Math.max(0, Math.min(200_000, vscode.workspace.getConfiguration('codecraft').get<number>('contextBudget', 6000)));
        const { report, contextText } = await selectContext({ index, text, budgetTokens: budget, read: (p) => host.fs.read(p), selection: lastSelection });
        post({ type: 'context', report });
        out.appendLine(`[context] ${report.items.filter((i) => i.included).length} file(s), ~${report.usedTokens}/${budget} tokens${report.unresolved.length ? `; not found: ${report.unresolved.join(', ')}` : ''}`);
        prompt = composePrompt(contextText, text);
        readThisRun.clear();
        postReads = () => post({ type: 'reads', read: readThisRun.size, total: index.stats.totalFiles, paths: [...readThisRun] });
        postReads();
      }

      const depthAtStart = host ? host.gate.undoDepth : 0;
      const attempts = [attemptFor(client, PRIMARY_AGENT_NAME, cfg.primaryModel), attemptFor(client, FALLBACK_AGENT_NAME, cfg.fallbackModel)];
      const result = await runWithFailover(prompt, attempts, {
        signal: abort.signal,
        onSwitch: (s) => {
          const banner = failoverBanner(s.fromModel, s.toModel, s.reason);
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
      });
      const outcome = result.outcome;
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
      }
    } catch (e) {
      const raw = describeError(e);
      const msg = redact(raw.includes('Outbound URL blocked') ? SSRF_HINT : raw);
      out.appendLine(`Error: ${msg}`);
      post({ type: 'event', event: { type: 'error', summary: msg, failed: true } });
    } finally {
      abort = undefined;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codecraft.openAgentPanel', () => {
      out.show(true);
      AgentPanel.show(context, runPrompt);
    }),
    vscode.commands.registerCommand('codecraft.undoLastChange', async () => {
      if (!host) return void vscode.window.showWarningMessage('CodeCraft: open a folder first.');
      const r = await host.gate.undoLast();
      out.appendLine(`[undo] ${r.status}: ${r.message}`);
      void (r.status === 'applied' ? vscode.window.showInformationMessage(`CodeCraft: ${r.message}`) : vscode.window.showWarningMessage(`CodeCraft: ${r.message}`));
    }),
    vscode.commands.registerCommand('codecraft.stopRun', async () => {
      if (!abort) return void vscode.window.showInformationMessage('CodeCraft: no run is in progress.');
      abort.abort();
      if (activeClient && activeSessionId) {
        try {
          await cancelSession(activeClient, activeSessionId);
        } catch (e) {
          out.appendLine(`Stop: cancel request failed: ${redact(describeError(e))}`);
        }
      }
      out.appendLine('Stop requested');
    }),
    { dispose: () => void server?.close() },
  );
  // Handle for the VS Code integration test (test/vscode). Not a public API.
  return { gate: host?.gate, fs: host?.fs };
}

export function deactivate(): void {}
