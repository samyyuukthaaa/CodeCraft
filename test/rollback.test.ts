// P5: rollback to any checkpoint (before the first apply, after each applied change set), planned from the
// journal and executed by the write gate from the content store. Real files on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FileContentStore } from '../src/journal/contentStore';
import { Journal, MemorySink } from '../src/journal/journal';
import { WriteGate } from '../src/mcp/gate';
import { MemorySnapshots, checkpoints, latestRunWithChanges, planRollback } from '../src/trust/rollback';
import { DiskApplier, ScriptedReviewer, acceptAll, readDisk, tempWorkspace } from './helpers';

async function threeChanges() {
  const ws = await tempWorkspace({ 'a.py': 'a = 1\n', 'b.py': 'b = 1\n' });
  const journal = new Journal(new MemorySink());
  journal.runId = 'run-1';
  const contents = new MemorySnapshots();
  const applier = new DiskApplier(ws.root);
  const gate = new WriteGate(ws.fs, applier, new ScriptedReviewer(acceptAll), journal, contents);
  gate.recordRead('a.py', 'a = 1\n');
  gate.recordRead('b.py', 'b = 1\n');
  assert.equal((await gate.proposeSet('p', [{ intent: 'implement', files: [{ path: 'a.py', newContent: 'a = 2\n' }] }])).status, 'applied'); // change 1
  assert.equal((await gate.proposeSet('p', [{ intent: 'add file', files: [{ path: 'c.py', newContent: 'c = 1\n' }, { path: 'b.py', newContent: 'b = 2\n' }] }])).status, 'applied'); // change 2
  assert.equal((await gate.proposeSet('p', [{ intent: 'tweak', files: [{ path: 'a.py', newContent: 'a = 3\n' }] }])).status, 'applied'); // change 3
  return { ws, journal, contents, applier, gate };
}

test('rollback: checkpoints are "before the first change" and "after each applied change set", from the journal', async () => {
  const { ws, journal } = await threeChanges();
  try {
    assert.equal(latestRunWithChanges(journal.all()), 'run-1');
    const cps = checkpoints(journal.all(), 'run-1');
    assert.deepEqual(cps.map((c) => [c.index, c.label, c.revert.length]), [
      [0, 'Before the first change of this run', 3],
      [1, 'After group 1: [implement] a.py', 2],
      [2, 'After group 2: [add file] c.py, b.py', 1],
      [3, 'After group 3: [tweak] a.py', 0],
    ]);
  } finally {
    await ws.cleanup();
  }
});

test('rollback: to "after change 1" reverts changes 3 and 2 in one step (created file deleted), journaled', async () => {
  const { ws, journal, applier, gate } = await threeChanges();
  try {
    const plan = planRollback(journal.all(), 'run-1', 1)!;
    assert.deepEqual(plan.files.map((f) => [f.path, f.restoreHash === null]), [['a.py', false], ['b.py', false], ['c.py', true]]);
    const calls = applier.calls.length;
    const r = await gate.rollback(plan);
    assert.equal(r.status, 'applied', r.message);
    assert.equal(applier.calls.length, calls + 1, 'one applyAll = one undo step');
    assert.equal(await readDisk(ws.root, 'a.py'), 'a = 2\n', 'back to after change 1');
    assert.equal(await readDisk(ws.root, 'b.py'), 'b = 1\n');
    await assert.rejects(readDisk(ws.root, 'c.py'), 'c.py did not exist at that checkpoint');
    const tail = journal.all().slice(-3).map((e) => e.t);
    assert.deepEqual(tail, ['op_undone', 'op_undone', 'rollback']);
    assert.equal(journal.appliedOps().size, 1, 'only change 1 is still applied');
    // the checkpoint list now ends at change 1; rolling back to the start reverts it too
    const again = planRollback(journal.all(), 'run-1', 0)!;
    assert.deepEqual(again.opIds.length, 1);
    assert.equal((await gate.rollback(again)).status, 'applied');
    assert.equal(await readDisk(ws.root, 'a.py'), 'a = 1\n');
    assert.equal(latestRunWithChanges(journal.all()), undefined);
    assert.match(journal.completedSteps('run-1'), /rolled back to "Before the first change of this run"/);
  } finally {
    await ws.cleanup();
  }
});

test('rollback: refused (nothing written) when a file changed after CodeCraft wrote it', async () => {
  const { ws, journal, applier, gate } = await threeChanges();
  try {
    await fs.writeFile(path.join(ws.root, 'b.py'), 'b = 99  # edited by hand\n', 'utf8');
    const calls = applier.calls.length;
    const r = await gate.rollback(planRollback(journal.all(), 'run-1', 0)!);
    assert.equal(r.status, 'refused');
    assert.match(r.message, /b\.py changed since CodeCraft wrote it; nothing was rolled back/);
    assert.equal(applier.calls.length, calls);
    assert.equal(await readDisk(ws.root, 'a.py'), 'a = 3\n');
  } finally {
    await ws.cleanup();
  }
});

test('rollback: refused when the saved content is missing; nothing to roll back after the last change', async () => {
  const { ws, journal, contents, gate } = await threeChanges();
  try {
    assert.equal(planRollback(journal.all(), 'run-1', 3), undefined, 'the latest checkpoint has nothing to revert');
    contents.blobs.clear();
    const r = await gate.rollback(planRollback(journal.all(), 'run-1', 0)!);
    assert.equal(r.status, 'refused');
    assert.match(r.message, /saved content of a\.py at that checkpoint is missing/);
  } finally {
    await ws.cleanup();
  }
});

test('rollback: after a rollback, Undo Last Change no longer reverts the rolled-back operations', async () => {
  const { ws, journal, gate } = await threeChanges();
  try {
    await gate.rollback(planRollback(journal.all(), 'run-1', 2)!); // revert change 3 only
    assert.equal(gate.undoDepth, 2);
    assert.equal((await gate.undoLast()).status, 'applied'); // undoes change 2
    assert.equal(await readDisk(ws.root, 'b.py'), 'b = 1\n');
    assert.equal(await readDisk(ws.root, 'a.py'), 'a = 2\n');
  } finally {
    await ws.cleanup();
  }
});

test('rollback: a checkpoint after EACH applied group, also between two groups of one change set', async () => {
  const ws = await tempWorkspace({ 'src/app.py': 'x = 1\n' });
  try {
    const journal = new Journal(new MemorySink());
    journal.runId = 'run-g';
    const gate = new WriteGate(ws.fs, new DiskApplier(ws.root), new ScriptedReviewer(acceptAll), journal, new MemorySnapshots());
    // as the trust session does: one change_group entry per applied group, with the operation ID
    gate.setHooks({ onApplied: (i) => void Promise.all(i.groups.map((g) => journal.append({ t: 'change_group', opId: i.opId, intent: g.intent, files: g.files, reason: 'r', plain: 'p', confidence: 'sure', why: [], tests: 'not run yet' }))) });
    gate.recordRead('src/app.py', 'x = 1\n');
    const r = await gate.proposeSet('p', [
      { intent: 'implement', files: [{ path: 'src/app.py', newContent: 'x = 2\n' }] },
      { intent: 'add test', files: [{ path: 'tests/test_app.py', newContent: 'def test_x():\n    pass\n' }] },
    ]);
    assert.equal(r.status, 'applied');
    await new Promise((res) => setTimeout(res, 10));
    const cps = checkpoints(journal.all(), 'run-g');
    assert.deepEqual(cps.map((c) => c.label), ['Before the first change of this run', 'After group 1: [implement] src/app.py', 'After group 2: [add test] tests/test_app.py']);

    const plan = planRollback(journal.all(), 'run-g', 1)!;
    assert.deepEqual(plan.opIds, [], 'the change set is only partly reverted');
    assert.deepEqual(plan.partial?.map((p) => p.files), [['tests/test_app.py']]);
    assert.equal((await gate.rollback(plan)).status, 'applied');
    await assert.rejects(readDisk(ws.root, 'tests/test_app.py'), 'the test file did not exist after group 1');
    assert.equal(await readDisk(ws.root, 'src/app.py'), 'x = 2\n', 'group 1 stays applied');
    assert.ok(journal.all().some((e) => e.t === 'files_undone'));
    assert.deepEqual(checkpoints(journal.all(), 'run-g').map((c) => c.index), [0, 1], 'only group 1 is left');

    // Undo Last Change now reverts only what is still applied of that change set
    assert.equal((await gate.undoLast()).status, 'applied');
    assert.equal(await readDisk(ws.root, 'src/app.py'), 'x = 1\n');
    assert.equal(latestRunWithChanges(journal.all()), undefined);
  } finally {
    await ws.cleanup();
  }
});

test('content store on disk: content-addressed, verified on read, rejects a wrong hash', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codecraft-contents-'));
  try {
    const store = new FileContentStore(dir);
    const text = 'def f():\n    return 1\n';
    const h = createHash('sha256').update(text).digest('hex');
    await store.put(h, text);
    await store.put(h, text); // idempotent
    assert.equal(await store.get(h), text);
    await assert.rejects(store.put(h, 'other'), /does not match its hash/);
    await fs.writeFile(path.join(dir, h.slice(0, 2), h), 'tampered', 'utf8');
    assert.equal(await store.get(h), undefined, 'a tampered copy is never restored');
    assert.equal(await store.get('../../etc/passwd'), undefined, 'only sha256 names are ever read');
    await assert.rejects(store.put('../../x', 'x'), /invalid content hash|does not match/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
