import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { buildTownHtml } from './html';
import { HostToTown, parseTownMessage } from './protocol';
import { SceneState, TownEvent, TownFileInput } from './types';
import { initSceneFromFiles, sceneReducer } from './reducer';

export class CodeTownPanel {
  private static current: CodeTownPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private state: SceneState;
  private readonly journal: TownEvent[] = [];

  static show(
    context: vscode.ExtensionContext,
    loadFiles: () => Promise<TownFileInput[]>,
    onOpenFile: (path: string) => Promise<void>,
  ): CodeTownPanel {
    if (CodeTownPanel.current) {
      CodeTownPanel.current.panel.reveal();
      return CodeTownPanel.current;
    }

    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'out');
    const panel = vscode.window.createWebviewPanel(
      'codecraft.codetown',
      'CodeCraft: Code Town',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [mediaRoot],
        retainContextWhenHidden: true,
      },
    );

    CodeTownPanel.current = new CodeTownPanel(panel, mediaRoot, loadFiles, onOpenFile);
    return CodeTownPanel.current;
  }

  static currentPanel(): CodeTownPanel | undefined {
    return CodeTownPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    mediaRoot: vscode.Uri,
    loadFiles: () => Promise<TownFileInput[]>,
    onOpenFile: (path: string) => Promise<void>,
  ) {
    this.panel = panel;
    this.state = initSceneFromFiles([]);

    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codetown.js'))
      .toString();

    panel.webview.html = buildTownHtml({
      cspSource: panel.webview.cspSource,
      nonce,
      scriptUri,
    });

    const post = (msg: HostToTown): void => {
      void panel.webview.postMessage(msg);
    };

    // Load initial workspace files
    void loadFiles().then((files) => {
      this.state = initSceneFromFiles(files);
      post({ type: 'scene', state: this.state });
      if (this.journal.length > 0) {
        post({ type: 'journal', events: this.journal });
      }
    });

    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = parseTownMessage(raw);
      if (!msg) return;

      if (msg.type === 'open_file') {
        try {
          await onOpenFile(msg.path);
        } catch {
          void vscode.window.showErrorMessage(`CodeCraft: Could not open file "${msg.path}"`);
        }
      } else if (msg.type === 'replay_run') {
        if (this.journal.length > 0) {
          post({ type: 'journal', events: this.journal });
        }
      }
    });

    panel.onDidDispose(() => {
      CodeTownPanel.current = undefined;
    });
  }

  public dispatchEvent(event: TownEvent): void {
    if (event.type !== 'reset' && event.type !== 'init') {
      this.journal.push(event);
    }
    this.state = sceneReducer(this.state, event);
    void this.panel.webview.postMessage({ type: 'event', event });
  }

  public setScene(state: SceneState): void {
    this.state = state;
    void this.panel.webview.postMessage({ type: 'scene', state });
  }

  public getState(): SceneState {
    return this.state;
  }
}
