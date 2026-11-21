// Runs INSIDE a real VS Code (extension host) via @vscode/test-electron: npm run test:vscode
// (A) the real extension activates, registers its commands and opens the agent panel;
// (B) the real VS Code reviewer + applier + write gate do per-hunk accept/reject, open diffs, apply as ONE
//     undo step, and undo. Quick picks are scripted by replacing showQuickPick on this test's vscode API.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { WriteGate } from '../../src/mcp/gate';
import { NodeReadFs } from '../../src/mcp/nodeFs';
import { PROPOSED_SCHEME, ProposedContentProvider, VsCodeApplier, VsCodeReviewer } from '../../src/mcp/vscodeHost';

const ORIGINAL = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n';
const PROPOSED = 'line1\nLINE2\nline3\nline4\nline5\nline6\nLINE7\nline8\n'; // two separate hunks

type Step = { name: string; fn: () => Promise<void> };
const steps: Step[] = [];
const it = (name: string, fn: () => Promise<void>) => steps.push({ name, fn });

const root = (): vscode.Uri => {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) throw new Error('no workspace folder opened for the test');
  return f.uri;
};

it('extension activates and registers its commands', async () => {
  const ext = vscode.extensions.getExtension('codecraft-dev.codecraft');
  assert.ok(ext, 'extension codecraft-dev.codecraft not found');
  await ext.activate();
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['codecraft.openAgentPanel', 'codecraft.undoLastChange', 'codecraft.stopRun']) assert.ok(cmds.includes(c), `missing command ${c}`);
});

it('CodeCraft: Open Agent Panel opens the webview panel', async () => {
  await vscode.commands.executeCommand('codecraft.openAgentPanel');
  // Wait until the tab really appears (up to 15 s; a fixed 500 ms was too short on a slow start), then assert.
  const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
  const started = Date.now();
  while (!tabs().includes('CodeCraft Agent') && Date.now() - started < 15_000) await new Promise((r) => setTimeout(r, 100));
  const groups = vscode.window.tabGroups.all.map((g, i) => `group ${i + 1}${g.isActive ? ' (active)' : ''}: [${g.tabs.map((t) => t.label).join(', ')}]`).join('; ');
  assert.ok(tabs().includes('CodeCraft Agent'), `after ${Date.now() - started} ms the Agent tab is missing; tab state: ${groups || '(no tab groups)'}`);
  console.log(`        (Agent tab appeared after ${Date.now() - started} ms)`);
});

it('Code Town: opens, builds the town from the index, and follows the journal live (provider errors only on the power plant)', async () => {
  fs.writeFileSync(path.join(root().fsPath, 'town_probe.py'), 'x = 1\n');
  const api = vscode.extensions.getExtension('codecraft-dev.codecraft')!.exports as { journal?: { append(e: unknown): Promise<void> }; town(): { buildings: Record<string, { state: string }>; power: { status: string }; stats: { failed: number } } | undefined };
  await vscode.commands.executeCommand('codecraft.openCodeTown');
  const wait = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(ok(), what);
  };
  const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
  await wait(() => tabs().includes('CodeCraft: Code Town'), `Code Town tab; tabs: ${tabs().join(', ')}`);
  await wait(() => Boolean(api.town()?.buildings['town_probe.py']), 'the index file appears as a building');
  assert.ok(api.journal, 'journal handle');
  await api.journal!.append({ t: 'run_started', request: 'vscode town test' });
  await api.journal!.append({ t: 'file_read', path: 'town_probe.py' });
  await api.journal!.append({ t: 'provider_error', model: 'test/model', cls: 'rate_limit' });
  await wait(() => api.town()?.buildings['town_probe.py']?.state === 'read', 'the read reaches the town live');
  assert.equal(api.town()!.power.status, 'retrying');
  assert.equal(api.town()!.stats.failed, 0, 'a provider error never marks a building failed');
});

it('Code Town: closing the panel leaves no journal listener behind (clean shutdown)', async () => {
  const api = vscode.extensions.getExtension('codecraft-dev.codecraft')!.exports as { journal?: { listenerCount: number }; town(): unknown };
  const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === 'CodeCraft: Code Town');
  assert.ok(tab, 'the Code Town panel is open from the previous test');
  assert.equal(api.journal!.listenerCount, 1);
  await vscode.window.tabGroups.close(tab!);
  for (let i = 0; i < 30 && api.town() !== undefined; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(api.town(), undefined, 'the panel is gone');
  assert.equal(api.journal!.listenerCount, 0, 'its journal listener was removed');
  await vscode.commands.executeCommand('codecraft.openCodeTown');
  for (let i = 0; i < 30 && api.journal!.listenerCount === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(api.journal!.listenerCount, 1, 'reopening subscribes exactly once');
});

it('CodeCraft: Undo Last Change with nothing to undo does not throw', async () => {
  await vscode.commands.executeCommand('codecraft.undoLastChange');
});

it('per-hunk review in VS Code: accept hunk 1, reject hunk 2; diff opened; only the accepted hunk is written and saved', async () => {
  const file = path.join(root().fsPath, 'sample.txt');
  fs.writeFileSync(file, ORIGINAL);
  const provider = new ProposedContentProvider();
  const reg = vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, provider);
  const answers = ['Review by group', 'Review hunks in this group', 'Accept this hunk', 'Reject this hunk'];
  const asked: string[] = [];
  const original = vscode.window.showQuickPick;
  (vscode.window as { showQuickPick: unknown }).showQuickPick = async (items: readonly vscode.QuickPickItem[], opts?: vscode.QuickPickOptions) => {
    const want = answers.shift();
    asked.push(`${opts?.title ?? ''} -> ${want}`);
    return items.find((i) => want !== undefined && i.label.includes(want));
  };
  try {
    const gate = new WriteGate(new NodeReadFs(root().fsPath), new VsCodeApplier(root()), new VsCodeReviewer(root(), provider));
    gate.recordRead('sample.txt', ORIGINAL);
    const r = await gate.proposeSet('uppercase two lines', [{ intent: 'implement', files: [{ path: 'sample.txt', newContent: PROPOSED }] }]);
    assert.equal(r.status, 'partially_applied', JSON.stringify(r));
    assert.deepEqual([r.acceptedHunks, r.rejectedHunks], [1, 1]);
    assert.equal(fs.readFileSync(file, 'utf8'), 'line1\nLINE2\nline3\nline4\nline5\nline6\nline7\nline8\n', 'saved to disk');
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    assert.ok(tabs.some((t) => t.includes('CodeCraft [implement] sample.txt')), `diff tab missing; tabs: ${tabs.join(', ')}`);
    assert.equal(asked.length, 4, asked.join(' | '));

    // ONE native undo step reverts the whole applied change
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), ORIGINAL, 'one undo step restores the original');
    await vscode.commands.executeCommand('redo');
    assert.equal(doc.getText(), 'line1\nLINE2\nline3\nline4\nline5\nline6\nline7\nline8\n');
    await doc.save();

    // CodeCraft's own undo (what "CodeCraft: Undo Last Change" calls) reverts it as well
    const u = await gate.undoLast();
    assert.equal(u.status, 'applied', JSON.stringify(u));
    assert.equal(fs.readFileSync(file, 'utf8'), ORIGINAL);
  } finally {
    (vscode.window as { showQuickPick: unknown }).showQuickPick = original;
    reg.dispose();
  }
});

it('Stop Run while the review quick pick is open closes it via its cancellation token; nothing is written', async () => {
  const file = path.join(root().fsPath, 'stop.txt');
  fs.writeFileSync(file, ORIGINAL);
  const provider = new ProposedContentProvider();
  const reg = vscode.workspace.registerTextDocumentContentProvider(`${PROPOSED_SCHEME}-stop`, provider);
  const original = vscode.window.showQuickPick;
  let sawCancel = false;
  let shown = false;
  // A quick pick that stays open until its cancellation token fires, like a real user who has not chosen yet.
  (vscode.window as { showQuickPick: unknown }).showQuickPick = (_items: unknown, _opts: unknown, token?: vscode.CancellationToken) =>
    new Promise((resolve) => {
      shown = true;
      token?.onCancellationRequested(() => {
        sawCancel = true;
        resolve(undefined);
      });
    });
  try {
    const gate = new WriteGate(new NodeReadFs(root().fsPath), new VsCodeApplier(root()), new VsCodeReviewer(root(), provider));
    gate.recordRead('stop.txt', ORIGINAL);
    const pending = gate.propose('stop.txt', PROPOSED, 'r');
    // press Stop while the review is really open (opening the diff takes longer with other editors open)
    for (let i = 0; i < 100 && !shown; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(shown, 'the review quick pick opened');
    gate.stop();
    const r = await pending;
    assert.equal(sawCancel, true, 'the quick pick received the cancellation');
    assert.equal(r.status, 'refused');
    assert.match(r.message, /stopped by the user/);
    assert.equal(fs.readFileSync(file, 'utf8'), ORIGINAL);
  } finally {
    (vscode.window as { showQuickPick: unknown }).showQuickPick = original;
    reg.dispose();
  }
});

it('Esc in the review rejects everything; nothing is written', async () => {
  const file = path.join(root().fsPath, 'esc.txt');
  fs.writeFileSync(file, ORIGINAL);
  const provider = new ProposedContentProvider();
  const reg = vscode.workspace.registerTextDocumentContentProvider(`${PROPOSED_SCHEME}-esc`, provider);
  const original = vscode.window.showQuickPick;
  (vscode.window as { showQuickPick: unknown }).showQuickPick = async () => undefined;
  try {
    const gate = new WriteGate(new NodeReadFs(root().fsPath), new VsCodeApplier(root()), new VsCodeReviewer(root(), provider));
    gate.recordRead('esc.txt', ORIGINAL);
    const r = await gate.propose('esc.txt', PROPOSED, 'r');
    assert.equal(r.status, 'rejected');
    assert.equal(fs.readFileSync(file, 'utf8'), ORIGINAL);
  } finally {
    (vscode.window as { showQuickPick: unknown }).showQuickPick = original;
    reg.dispose();
  }
});

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const s of steps) {
    try {
      await s.fn();
      console.log(`  PASS  ${s.name}`);
    } catch (e) {
      console.log(`  FAIL  ${s.name}\n        ${e instanceof Error ? e.message : String(e)}`);
      failures.push(s.name);
    }
  }
  console.log(`vscode suite: ${steps.length - failures.length} passed, ${failures.length} failed`);
  if (failures.length) throw new Error(`${failures.length} VS Code test(s) failed`);
}
