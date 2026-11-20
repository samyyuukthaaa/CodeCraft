import * as vscode from 'vscode';
import {
  agentsApi,
  createClient,
  createSession,
  describeError,
  ensureAgents,
  streamTurn,
} from './trueforge/client';
import { CodeCraftConfig, PRIMARY_AGENT_NAME, validateConfig } from './trueforge/config';
import { toDisplay } from './trueforge/events';
import { AgentPanel } from './panel/AgentPanel';
import type { HostToWebview } from './panel/protocol';
import { redact } from './util/redact';

function readConfig(): CodeCraftConfig {
  const c = vscode.workspace.getConfiguration('codecraft');
  return validateConfig({
    baseUrl: c.get<string>('baseUrl'),
    primaryModel: c.get<string>('primaryModel'),
    fallbackModel: c.get<string>('fallbackModel'),
  } as Partial<CodeCraftConfig>);
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('CodeCraft');
  context.subscriptions.push(out);
  let sessionId: string | undefined;
  let sessionKey = '';

  async function runPrompt(text: string, post: (m: HostToWebview) => void): Promise<void> {
    try {
      const cfg = readConfig();
      const client = createClient(cfg);
      const key = `${cfg.baseUrl}|${cfg.primaryModel}|${cfg.fallbackModel}`;
      if (!sessionId || key !== sessionKey) {
        const outcome = await ensureAgents(agentsApi(client), cfg);
        out.appendLine(`Agents: ${JSON.stringify(outcome)}`);
        sessionId = await createSession(client, PRIMARY_AGENT_NAME);
        sessionKey = key;
        out.appendLine(`Session ${sessionId} (agent ${PRIMARY_AGENT_NAME}, model ${cfg.primaryModel})`);
      }
      for await (const ev of streamTurn(client, sessionId, text)) {
        const d = toDisplay(ev);
        if (d.summary || !d.delta) out.appendLine(`${d.type} ${d.summary}`.trimEnd());
        post({ type: 'event', event: d });
      }
    } catch (e) {
      const msg = redact(describeError(e));
      out.appendLine(`Error: ${msg}`);
      post({ type: 'event', event: { type: 'error', summary: msg, failed: true } });
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codecraft.openAgentPanel', () => {
      out.show(true);
      AgentPanel.show(context, runPrompt);
    }),
  );
}

export function deactivate(): void {}
