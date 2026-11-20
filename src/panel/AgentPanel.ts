import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { buildHtml } from './html';
import { HostToWebview, parseWebviewMessage } from './protocol';

export class AgentPanel {
  private static current: AgentPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static show(
    context: vscode.ExtensionContext,
    onPrompt: (text: string, post: (m: HostToWebview) => void) => Promise<void>,
  ): AgentPanel {
    if (AgentPanel.current) {
      AgentPanel.current.panel.reveal();
      return AgentPanel.current;
    }
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'out');
    const panel = vscode.window.createWebviewPanel('codecraft.agent', 'CodeCraft Agent', vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    });
    AgentPanel.current = new AgentPanel(panel, mediaRoot, onPrompt);
    return AgentPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    mediaRoot: vscode.Uri,
    onPrompt: (text: string, post: (m: HostToWebview) => void) => Promise<void>,
  ) {
    this.panel = panel;
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js')).toString();
    panel.webview.html = buildHtml({ cspSource: panel.webview.cspSource, nonce, scriptUri });
    const post = (m: HostToWebview): void => void panel.webview.postMessage(m);
    let busy = false;
    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = parseWebviewMessage(raw);
      if (!msg || busy) return;
      busy = true;
      post({ type: 'status', state: 'running' });
      try {
        await onPrompt(msg.text, post);
      } finally {
        busy = false;
        post({ type: 'status', state: 'idle' });
      }
    });
    panel.onDidDispose(() => {
      AgentPanel.current = undefined;
    });
  }
}
