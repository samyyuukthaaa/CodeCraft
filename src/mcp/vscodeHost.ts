// VS Code-specific implementations of the gate's interfaces. Thin by design: all decisions live in
// WriteGate; this file only shows UI and performs the single approved edit.
import * as cp from 'node:child_process';
import * as vscode from 'vscode';
import { redact } from '../util/redact';
import { Applier, Decision, FileProposal, ReviewRequest, Reviewer, hunkKey } from './gate';
import { parseTestCommand, scrubEnv } from './safeTests';
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

type Choice<T> = vscode.QuickPickItem & { value: T };

async function pick<T>(token: vscode.CancellationToken, items: Array<Choice<T>>, title: string, placeHolder: string): Promise<T | undefined> {
  if (token?.isCancellationRequested) return undefined;
  const r = await vscode.window.showQuickPick(items, { title, placeHolder, ignoreFocusOut: true }, token);
  return r?.value;
}

/**
 * Grouped review: accept or reject everything, or go group by group (accept group, reject group, or
 * hunk by hunk). Esc at any point rejects everything not yet decided. Nothing is written by this class.
 */
export class VsCodeReviewer implements Reviewer {
  private cts = new vscode.CancellationTokenSource();

  /** Stop Run: closes the open review quick pick; it then counts as reject. */
  cancel(): void {
    this.cts.cancel();
    this.cts.dispose();
    this.cts = new vscode.CancellationTokenSource();
  }

  constructor(
    private readonly root: vscode.Uri,
    private readonly provider: ProposedContentProvider,
  ) {}

  private async showDiff(f: FileProposal, intent: string): Promise<void> {
    const proposed = this.provider.set(f.path, f.newText);
    const left = f.isNew ? this.provider.set(`(empty)/${f.path}`, '') : vscode.Uri.joinPath(this.root, f.path);
    await vscode.commands.executeCommand('vscode.diff', left, proposed, `CodeCraft [${intent}] ${f.path}${f.isNew ? ' (new file)' : ''}`, { preview: true });
  }

  async review(req: ReviewRequest): Promise<Record<string, Decision>> {
    const token = this.cts.token;
    const out: Record<string, Decision> = {};
    const setFile = (f: FileProposal, d: Decision): void => {
      for (const h of f.hunks) out[hunkKey(f.path, h.id)] = d;
    };
    const setGroups = (from: number, d: Decision): void => {
      for (const g of req.groups.slice(from)) for (const f of g.files) setFile(f, d);
    };
    const hunkCount = req.groups.reduce((n, g) => n + g.files.reduce((m, f) => m + f.hunks.length, 0), 0);
    const fileCount = req.groups.reduce((n, g) => n + g.files.length, 0);
    const first = req.groups[0]?.files[0];
    if (first) await this.showDiff(first, req.groups[0]!.intent);

    const top = await pick(
      token,
      [
        { label: '$(check-all) Accept all', detail: `${req.groups.length} group(s), ${fileCount} file(s), ${hunkCount} hunk(s)`, value: 'all' as const },
        { label: '$(close-all) Reject all', detail: 'Nothing is written', value: 'none' as const },
        { label: '$(list-tree) Review by group…', detail: req.groups.map((g) => `${g.intent} (${g.files.length})`).join(' · '), value: 'groups' as const },
      ],
      'CodeCraft: review change set',
      redact(req.plan.replace(/\s+/g, ' ').slice(0, 240)) || 'Nothing is written until you accept. Esc rejects all.',
    );
    if (!top || top === 'none') {
      setGroups(0, 'reject');
      return out;
    }
    if (top === 'all') {
      setGroups(0, 'accept');
      return out;
    }

    for (let gi = 0; gi < req.groups.length; gi++) {
      const g = req.groups[gi]!;
      for (const f of g.files) await this.showDiff(f, g.intent);
      const hunks = g.files.reduce((n, f) => n + f.hunks.length, 0);
      const choice = await pick(
      token,
        [
          { label: '$(check) Accept this group', value: 'accept' as const },
          { label: '$(close) Reject this group', value: 'reject' as const },
          { label: '$(list-selection) Review hunks in this group…', value: 'hunks' as const },
          { label: '$(check-all) Accept this and all remaining groups', value: 'accept-rest' as const },
          { label: '$(close-all) Reject this and all remaining groups', value: 'reject-rest' as const },
        ],
        `Group ${gi + 1} of ${req.groups.length}: ${g.intent}`,
        `${g.files.map((f) => f.path).join(', ')} (${hunks} hunk(s))`,
      );
      if (!choice || choice === 'reject-rest') {
        setGroups(gi, 'reject');
        return out;
      }
      if (choice === 'accept-rest') {
        setGroups(gi, 'accept');
        return out;
      }
      if (choice === 'accept' || choice === 'reject') {
        for (const f of g.files) setFile(f, choice);
        continue;
      }
      // hunk by hunk inside this group
      let stop: Decision | undefined;
      for (const f of g.files) {
        for (const h of f.hunks) {
          if (stop) {
            out[hunkKey(f.path, h.id)] = stop;
            continue;
          }
          const preview = [...h.oldLines.slice(0, 4).map((l) => `- ${l.trimEnd()}`), ...h.newLines.slice(0, 4).map((l) => `+ ${l.trimEnd()}`)].join('   ');
          const c = await pick(
      token,
            [
              { label: '$(check) Accept this hunk', value: 'accept' as const },
              { label: '$(close) Reject this hunk', value: 'reject' as const },
              { label: '$(check-all) Accept the rest of this group', value: 'accept-rest' as const },
              { label: '$(close-all) Reject the rest of this group', value: 'reject-rest' as const },
            ],
            `[${g.intent}] ${f.path}: hunk ${h.id + 1} of ${f.hunks.length} (line ${h.oldStart + 1}, −${h.oldLines.length} +${h.newLines.length})`,
            preview.slice(0, 200),
          );
          if (!c) {
            // Esc: reject everything not yet decided; keep decisions already made
            for (const rg of req.groups.slice(gi)) for (const rf of rg.files) for (const rh of rf.hunks) out[hunkKey(rf.path, rh.id)] ??= 'reject';
            return out;
          }
          if (c === 'accept-rest' || c === 'reject-rest') {
            stop = c === 'accept-rest' ? 'accept' : 'reject';
            out[hunkKey(f.path, h.id)] = stop;
          } else {
            out[hunkKey(f.path, h.id)] = c;
          }
        }
      }
    }
    return out;
  }
}

/** Applies all approved changes as ONE WorkspaceEdit (one undo step), refusing files with unsaved changes. */
export class VsCodeApplier implements Applier {
  constructor(private readonly root: vscode.Uri) {}

  async applyAll(changes: Array<{ path: string; text: string | undefined }>): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    for (const c of changes) {
      const uri = vscode.Uri.joinPath(this.root, c.path);
      if (c.text === undefined) {
        edit.deleteFile(uri, { ignoreIfNotExists: true });
        continue;
      }
      let exists = true;
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        exists = false;
      }
      if (!exists) {
        edit.createFile(uri, { ignoreIfExists: false });
        edit.insert(uri, new vscode.Position(0, 0), c.text);
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (doc.isDirty) throw new Error(`${c.path} has unsaved changes in the editor; save or revert it first`);
        edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), c.text);
      }
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code refused the edit');
    for (const c of changes) {
      if (c.text === undefined) continue;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.root, c.path));
      await doc.save();
    }
  }
}

const TEST_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL = 8000;

/** Runs the configured test command in the workspace, only after an explicit modal confirmation. */
export class VsCodeTestRunner implements TestRunner {
  private child: cp.ChildProcess | undefined;

  /** Stop Run: kills a running test command. */
  cancel(): void {
    this.child?.kill();
  }

  constructor(
    private readonly cwd: string,
    private readonly command: () => string,
  ) {}

  async run(): Promise<TestResult> {
    const parsed = parseTestCommand(this.command());
    if (!parsed.ok) return { ran: false, output: '', message: parsed.error };
    const { command } = parsed;
    const { env, removed } = scrubEnv(process.env);
    const choice = await vscode.window.showWarningMessage(
      `CodeCraft wants to run your test command in the workspace:\n\n${command.display}`,
      {
        modal: true,
        detail:
          'TrueForge has no sandbox on Windows, so this runs directly on your machine, without shell operators, with a time limit' +
          (removed.length ? ` and without these environment variables: ${removed.join(', ')}.` : '.'),
      },
      'Run tests',
    );
    if (choice !== 'Run tests') return { ran: false, output: '', message: 'the user declined to run the tests' };
    return new Promise<TestResult>((resolve) => {
      // No shell on POSIX. On Windows a shell is needed to find .cmd launchers (npm.cmd); the arguments were
      // validated to contain no shell operators, so nothing can be chained or redirected.
      const child = cp.spawn(command.file, command.args, { cwd: this.cwd, env, shell: process.platform === 'win32', windowsHide: true });
      this.child = child;
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
