import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { Journal, JournalEntry } from '../journal/journal';
import { buildTownHtml } from './html';
import { HostToTown, parseTownMessage } from './protocol';
import { SceneState, TownEvent, TownFileInput } from './types';
import { foldEvents, initialSceneState, sceneReducer } from './reducer';
import { finishedRuns, townEventsFor, townEventsFromJournal } from './fromJournal';

/** codecraft.townReducedMotion: 'auto' follows the OS; 'on' / 'off' override it. */
function motionSetting(): 'on' | 'off' | 'auto' {
  const v = vscode.workspace.getConfiguration('codecraft').get<string>('townReducedMotion', 'auto');
  return v === 'on' || v === 'off' ? v : 'auto';
}

/** codecraft.scout: 'muted' hides Scout and its tips (Ask Scout stays available on request). */
function scoutSetting(): 'on' | 'muted' {
  return vscode.workspace.getConfiguration('codecraft').get<string>('scout', 'on') === 'muted' ? 'muted' : 'on';
}

export interface TownSources {
  /** The repository index (layout). */
  loadFiles: () => Promise<TownFileInput[]>;
  /** The append-only journal: the only source of what happened. */
  journal: Journal;
  onOpenFile: (path: string) => Promise<void>;
}

/**
 * Hosts the Code Town webview. The scene = the index (layout) folded with the town events projected from the
 * journal (src/town/fromJournal.ts). Nothing is recorded here: a reload rebuilds the same scene from the journal.
 */
export class CodeTownPanel {
  private static current: CodeTownPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private state: SceneState = initialSceneState();
  private ready = false;
  /** The index files of the last build: the base town for replays. */
  private files: TownFileInput[] = [];
  private readonly disposables: Array<() => void> = [];

  static show(context: vscode.ExtensionContext, sources: TownSources): CodeTownPanel {
    if (CodeTownPanel.current) {
      CodeTownPanel.current.panel.reveal();
      return CodeTownPanel.current;
    }
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'out');
    const panel = vscode.window.createWebviewPanel('codecraft.codetown', 'CodeCraft: Code Town', vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
      retainContextWhenHidden: true,
    });
    CodeTownPanel.current = new CodeTownPanel(panel, mediaRoot, sources);
    return CodeTownPanel.current;
  }

  static currentPanel(): CodeTownPanel | undefined {
    return CodeTownPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, mediaRoot: vscode.Uri, private readonly sources: TownSources) {
    this.panel = panel;
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codetown.js')).toString();
    panel.webview.html = buildTownHtml({ cspSource: panel.webview.cspSource, nonce, scriptUri, reducedMotion: motionSetting(), scout: scoutSetting() });
    const cfg = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codecraft.townReducedMotion') || e.affectsConfiguration('codecraft.scout')) this.post({ type: 'settings', reducedMotion: motionSetting(), scout: scoutSetting() });
    });
    this.disposables.push(() => cfg.dispose());

    // Live: every new journal entry is projected and applied (after the initial scene is built).
    this.disposables.push(sources.journal.onAppend((e) => this.onJournal(e)));
    void this.rebuild();

    const sub = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = parseTownMessage(raw);
      if (!msg) return;
      if (msg.type === 'open_file') {
        try {
          await sources.onOpenFile(msg.path);
        } catch {
          void vscode.window.showErrorMessage(`CodeCraft: could not open "${msg.path}"`);
        }
      } else if (msg.type === 'navigate') {
        // Only a building that is in the town: journal the click (Scout walks there, replay reproduces it), then open it.
        if (!this.state.buildings[msg.path]) return;
        await sources.journal.append({ t: 'scout_navigate', path: msg.path });
        try {
          await sources.onOpenFile(msg.path);
        } catch {
          void vscode.window.showErrorMessage(`CodeCraft: could not open "${msg.path}"`);
        }
      } else if (msg.type === 'replay_run') {
        this.postReplay(msg.runId);
      }
    });
    this.disposables.push(() => sub.dispose());
    panel.onDidDispose(() => this.dispose());
  }

  private post(msg: HostToTown): void {
    void this.panel.webview.postMessage(msg);
  }

  /** Index + journal -> scene. */
  private async rebuild(): Promise<void> {
    await this.sources.journal.load();
    const files = await this.sources.loadFiles();
    const events = townEventsFromJournal(this.sources.journal.all());
    const first = events[0];
    const init: TownEvent = { type: 'init', files, at: first && first.type !== 'reset' ? first.at : 0 };
    this.state = foldEvents(sceneReducer(initialSceneState(), init), events);
    this.ready = true;
    this.files = files;
    this.post({ type: 'scene', state: this.state });
    this.post({ type: 'runs', runs: finishedRuns(this.sources.journal.all()) });
  }

  /** A finished run, replayed through the same reducer: the town before it (index only) plus its journal events. */
  private postReplay(runId: string | undefined): void {
    const runs = finishedRuns(this.sources.journal.all());
    const run = runId ? runs.find((r) => r.runId === runId) : runs[0];
    if (!run) return;
    const base = sceneReducer(initialSceneState(), { type: 'init', files: this.files, at: run.at });
    this.post({ type: 'replay', runId: run.runId, base, events: townEventsFromJournal(this.sources.journal.all(), run.runId) });
  }

  private onJournal(e: JournalEntry): void {
    if (!this.ready) return; // the rebuild reads the journal itself
    for (const ev of townEventsFor(e)) {
      this.state = sceneReducer(this.state, ev);
      this.post({ type: 'event', event: ev });
    }
    if (e.t === 'run_finished') this.post({ type: 'runs', runs: finishedRuns(this.sources.journal.all()) });
  }

  getState(): SceneState {
    return this.state;
  }

  private dispose(): void {
    for (const d of this.disposables.splice(0)) d();
    CodeTownPanel.current = undefined;
  }
}
