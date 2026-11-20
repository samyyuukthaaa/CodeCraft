import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
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

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('CodeCraft');
  context.subscriptions.push(out);

  const folder = vscode.workspace.workspaceFolders?.[0];
  const provider = new ProposedContentProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, provider));

  // Editor-tool host (created only when a folder is open).
  const host = folder
    ? (() => {
        const fs = new NodeReadFs(folder.uri.fsPath);
        const gate = new WriteGate(fs, new VsCodeApplier(folder.uri), new VsCodeReviewer(folder.uri, provider));
        const tests = new VsCodeTestRunner(folder.uri.fsPath, () => vscode.workspace.getConfiguration('codecraft').get<string>('testCommand', 'npm test'));
        return { fs, gate, handlers: createHandlers({ fs, gate, tests, onActivity: (l) => out.appendLine(`[tool] ${l}`) }) };
      })()
    : undefined;

  let server: RunningServer | undefined;
  const token = randomBytes(24).toString('hex'); // ephemeral, in memory only, never logged
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
    server ??= await startMcpServer(host.handlers, token);
    await registerEditorServer(client, server.url, token);
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
      const attempts = [attemptFor(client, PRIMARY_AGENT_NAME, cfg.primaryModel), attemptFor(client, FALLBACK_AGENT_NAME, cfg.fallbackModel)];
      const result = await runWithFailover(text, attempts, {
        signal: abort.signal,
        onSwitch: (s) => {
          out.appendLine(`[failover] ${s.from} failed (${redact(s.reason)}); switching to ${s.to}`);
          post({ type: 'event', event: { type: 'model.switched', summary: `${s.from} failed; now using ${s.to}`, failed: false } });
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
      if (outcome.status === 'error' || outcome.status === 'unsupported') {
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
}

export function deactivate(): void {}
