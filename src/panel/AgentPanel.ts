import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { buildHtml } from './html';
import { HostToWebview, parseWebviewMessage } from './protocol';

type Post = (m: HostToWebview) => void;

export interface PanelHandlers {
  onPrompt: (text: string, post: Post) => Promise<void>;
  /** "Test providers" button. */
  onTestProviders?: (post: Post) => Promise<void>;
  /** "Inject fault…" button (testing failover): the host asks which fault to arm for the next run. */
  onInjectFault?: (post: Post) => Promise<void>;
  /** The user's answer to the agent's question (arrives while a run is in progress). */
  onAnswer?: (text: string) => void;
  /** "Roll back…" button: the host shows the journal's checkpoints. */
  onRollback?: (post: Post) => Promise<void>;
  /** "Export report" button. */
  onExportReport?: (post: Post) => Promise<void>;
  /** Called once the panel exists, e.g. to send the current provider health. */
  onReady?: (post: Post) => void;
}

export class AgentPanel {
  private static current: AgentPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  readonly post: Post;

  static show(context: vscode.ExtensionContext, handlers: PanelHandlers): AgentPanel {
    if (AgentPanel.current) {
      AgentPanel.current.panel.reveal();
      return AgentPanel.current;
    }
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'out');
    const panel = vscode.window.createWebviewPanel('codecraft.agent', 'CodeCraft Agent', vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    });
    AgentPanel.current = new AgentPanel(panel, mediaRoot, handlers);
    return AgentPanel.current;
  }

  /** The open panel, if any (for pushing provider health updates). */
  static currentPanel(): AgentPanel | undefined {
    return AgentPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, mediaRoot: vscode.Uri, handlers: PanelHandlers) {
    this.panel = panel;
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js')).toString();
    panel.webview.html = buildHtml({ cspSource: panel.webview.cspSource, nonce, scriptUri });
    const post: Post = (m) => void panel.webview.postMessage(m);
    this.post = post;
    let busy = false;
    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = parseWebviewMessage(raw);
      if (!msg) return;
      if (msg.type === 'answer') return void handlers.onAnswer?.(msg.text); // only meaningful during a run
      if (busy) return;
      busy = true;
      const notes: Partial<Record<typeof msg.type, string>> = { testProviders: 'testing providers', injectFault: 'choosing a fault', rollback: 'choosing a checkpoint', exportReport: 'exporting the report' };
      const note = notes[msg.type];
      post({ type: 'status', state: 'running', ...(note ? { note } : {}) });
      try {
        if (msg.type === 'prompt') await handlers.onPrompt(msg.text, post);
        else if (msg.type === 'testProviders') await handlers.onTestProviders?.(post);
        else if (msg.type === 'injectFault') await handlers.onInjectFault?.(post);
        else if (msg.type === 'rollback') await handlers.onRollback?.(post);
        else await handlers.onExportReport?.(post);
      } finally {
        busy = false;
        post({ type: 'status', state: 'idle' });
      }
    });
    panel.onDidDispose(() => {
      AgentPanel.current = undefined;
    });
    handlers.onReady?.(post);
  }
}
