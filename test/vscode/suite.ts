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
  await new Promise((r) => setTimeout(r, 500));
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
  assert.ok(tabs.includes('CodeCraft Agent'), `tabs: ${tabs.join(', ')}`);
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
