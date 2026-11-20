import * as vscode from 'vscode';
import { createSession, runTurn } from './forge/client';
import { redact } from './util/redact';

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('CodeCraft');
  context.subscriptions.push(out);

  context.subscriptions.push(
    vscode.commands.registerCommand('codecraft.helloForge', async () => {
      const cfg = vscode.workspace.getConfiguration('forge');
      const baseUrl = cfg.get<string>('baseUrl', 'http://localhost:8790');
      const model = cfg.get<string>('primaryModel', 'google-gemini/gemini-3-1-flash-lite');
      out.show(true);
      try {
        out.appendLine(`Creating TrueForge session (model ${model}) at ${baseUrl}`);
        const sid = await createSession(baseUrl, model);
        const r = await runTurn(baseUrl, sid, 'Reply with exactly: CODECRAFT HELLO');
        if (r.status === 'done') {
          out.appendLine(`TrueForge replied via ${r.model}: ${redact(r.content ?? '')}`);
          void vscode.window.showInformationMessage(`TrueForge replied: ${r.content ?? ''}`);
        } else {
          out.appendLine(`Turn ended with status ${r.status}: ${redact(r.errorMessage ?? 'no message')}`);
          void vscode.window.showWarningMessage('TrueForge turn failed; see the CodeCraft output channel.');
        }
      } catch (e) {
        out.appendLine(`Error: ${redact(e instanceof Error ? e.message : String(e))}`);
        void vscode.window.showErrorMessage('Could not reach TrueForge; see the CodeCraft output channel.');
      }
    }),
  );
}

export function deactivate(): void {}
