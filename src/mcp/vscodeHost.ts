// VS Code-specific implementations of the gate's interfaces. Thin by design: all decisions live in
// WriteGate; this file only shows UI and performs the single approved edit.
import * as cp from 'node:child_process';
import * as vscode from 'vscode';
import { redact } from '../util/redact';
import type { Applier, Decision, ReviewRequest, Reviewer } from './gate';
import type { TestResult, TestRunner } from './tools';

const SCHEME = 'codecraft-proposed';

/** Serves proposed content for the diff view. Read-only virtual documents. */
export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  set(relPath: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${relPath}` });
    this.docs.set(uri.path, text);
    return uri;
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? '';
  }
}

export const PROPOSED_SCHEME = SCHEME;

export class VsCodeReviewer implements Reviewer {
  constructor(
    private readonly root: vscode.Uri,
    private readonly provider: ProposedContentProvider,
  ) {}

  async review(req: ReviewRequest): Promise<Record<number, Decision>> {
    const current = vscode.Uri.joinPath(this.root, req.path);
    const proposed = this.provider.set(req.path, req.newText);
    // For a new file there is nothing on disk to diff against, so diff against an empty virtual document.
    const left = req.oldText === '' ? this.provider.set(`(empty)/${req.path}`, '') : current;
    await vscode.commands.executeCommand('vscode.diff', left, proposed, `CodeCraft proposal: ${req.path}`, { preview: true });

    const all = (d: Decision): Record<number, Decision> => Object.fromEntries(req.hunks.map((h) => [h.id, d]));
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(check-all) Accept all', detail: `${req.hunks.length} hunk(s). ${req.reason}`, action: 'all' as const },
        { label: '$(close-all) Reject all', detail: 'Nothing is written', action: 'none' as const },
        { label: '$(list-selection) Review hunk by hunk…', detail: 'Accept or reject each hunk', action: 'each' as const },
      ],
      { title: `CodeCraft: review change to ${req.path}`, placeHolder: 'Nothing is written until you accept. Esc rejects all.', ignoreFocusOut: true },
    );
    if (!pick || pick.action === 'none') return all('reject');
    if (pick.action === 'all') return all('accept');

    const out: Record<number, Decision> = {};
    for (const h of req.hunks) {
      const del = h.oldLines.length;
      const add = h.newLines.length;
      const preview = [...h.oldLines.slice(0, 4).map((l) => `- ${l.trimEnd()}`), ...h.newLines.slice(0, 4).map((l) => `+ ${l.trimEnd()}`)].join('   ');
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(check) Accept this hunk', value: 'accept' as const },
          { label: '$(close) Reject this hunk', value: 'reject' as const },
          { label: '$(check-all) Accept this and all remaining', value: 'accept-rest' as const },
          { label: '$(close-all) Reject this and all remaining', value: 'reject-rest' as const },
        ],
        { title: `Hunk ${h.id + 1} of ${req.hunks.length} (line ${h.oldStart + 1}, −${del} +${add})`, placeHolder: preview.slice(0, 200), ignoreFocusOut: true },
      );
      if (!choice || choice.value === 'reject' || choice.value === 'reject-rest') {
        out[h.id] = 'reject';
        if (!choice || choice.value === 'reject-rest') {
          for (const r of req.hunks) if (r.id > h.id) out[r.id] = 'reject';
          break;
        }
      } else if (choice.value === 'accept-rest') {
        for (const r of req.hunks) if (r.id >= h.id) out[r.id] = 'accept';
        break;
      } else {
        out[h.id] = 'accept';
      }
    }
    return out;
  }
}

/** Applies the single approved edit as ONE undo step, refusing if the file has unsaved changes. */
export class VsCodeApplier implements Applier {
  constructor(private readonly root: vscode.Uri) {}

  async apply(relPath: string, newText: string): Promise<void> {
    const uri = vscode.Uri.joinPath(this.root, relPath);
    const edit = new vscode.WorkspaceEdit();
    let exists = true;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      exists = false;
    }
    if (!exists) {
      edit.createFile(uri, { ignoreIfExists: false });
      edit.insert(uri, new vscode.Position(0, 0), newText);
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.isDirty) throw new Error(`${relPath} has unsaved changes in the editor; save or revert it first`);
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), newText);
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused the edit to ${relPath}`);
    const saved = await vscode.workspace.openTextDocument(uri);
    await saved.save();
  }

  async remove(relPath: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(vscode.Uri.joinPath(this.root, relPath), { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(edit);
  }
}

const TEST_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL = 8000;

/** Runs the configured test command in the workspace, only after an explicit modal confirmation. */
export class VsCodeTestRunner implements TestRunner {
  constructor(
    private readonly cwd: string,
    private readonly command: () => string,
  ) {}

  async run(): Promise<TestResult> {
    const cmd = this.command();
    const choice = await vscode.window.showWarningMessage(
      `CodeCraft wants to run your test command in the workspace:\n\n${cmd}`,
      { modal: true, detail: 'TrueForge has no sandbox on Windows, so this runs directly on your machine.' },
      'Run tests',
    );
    if (choice !== 'Run tests') return { ran: false, output: '', message: 'the user declined to run the tests' };
    return new Promise<TestResult>((resolve) => {
      const child = cp.spawn(cmd, { cwd: this.cwd, shell: true, windowsHide: true });
      let out = '';
      const add = (b: Buffer): void => {
        out = (out + b.toString('utf8')).slice(-OUTPUT_TAIL);
      };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const timer = setTimeout(() => child.kill(), TEST_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ran: false, output: '', message: `could not start the test command: ${redact(e.message)}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ran: true, exitCode: code ?? -1, output: out });
      });
    });
  }
}
