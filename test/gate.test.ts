import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { applyHunks, computeHunks } from '../src/mcp/diff';
import { WriteGate } from '../src/mcp/gate';
import { normalizeRelPath } from '../src/mcp/paths';
import { DiskApplier, ScriptedReviewer, acceptAll, readDisk, rejectAll, tempWorkspace } from './helpers';

const ORIGINAL = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n';
const CHANGED = 'line1\nLINE2\nline3\nline4\nline5\nline6\nLINE7\nline8\nextra\n';

test('diff: hunks reconstruct the new text when all accepted and the old text when none', () => {
  const hunks = computeHunks(ORIGINAL, CHANGED);
  assert.equal(hunks.length, 3);
  assert.equal(applyHunks(ORIGINAL, hunks, new Set(hunks.map((h) => h.id))), CHANGED);
  assert.equal(applyHunks(ORIGINAL, hunks, new Set()), ORIGINAL);
});

test('diff: a subset of hunks applies independently', () => {
  const hunks = computeHunks(ORIGINAL, CHANGED);
  const out = applyHunks(ORIGINAL, hunks, new Set([hunks[1]!.id]));
  assert.equal(out, 'line1\nline2\nline3\nline4\nline5\nline6\nLINE7\nline8\n');
});

test('diff: new file, deletion and empty cases', () => {
  assert.equal(applyHunks('', computeHunks('', 'a\nb\n'), new Set([0])), 'a\nb\n');
  const del = computeHunks('a\nb\nc\n', 'a\nc\n');
  assert.equal(applyHunks('a\nb\nc\n', del, new Set([0])), 'a\nc\n');
  assert.deepEqual(computeHunks('same\n', 'same\n'), []);
});

test('paths: traversal, absolute, secrets and .git are refused', () => {
  assert.equal(normalizeRelPath('src\\a/./b.ts'), 'src/a/b.ts');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', '.env', 'cfg/.env.local', '.git/config', 'node_modules/x/y.js', 'k/id_rsa', 'a\0b', '']) {
    assert.throws(() => normalizeRelPath(bad), Error, bad);
  }
});

async function setup(reviewerAnswer = acceptAll) {
  const ws = await tempWorkspace({ 'a.txt': ORIGINAL });
  const applier = new DiskApplier(ws.root);
  const reviewer = new ScriptedReviewer(reviewerAnswer);
  const gate = new WriteGate(ws.fs, applier, reviewer);
  return { ws, applier, reviewer, gate };
}

test('gate: a write without a stored decision is refused and nothing is written', async () => {
  const { ws, applier, gate } = await setup();
  try {
    const r = await gate.applyApproved('a.txt', CHANGED);
    assert.equal(r.status, 'refused');
    assert.match(r.message, /no stored decision/);
    assert.equal(applier.writes.length, 0);
    assert.equal(await readDisk(ws.root, 'a.txt'), ORIGINAL);
  } finally {
    await ws.cleanup();
  }
});

test('gate: a decision for different content does not authorise other content', async () => {
  const { ws, applier, gate } = await setup();
  try {
    gate.recordRead('a.txt', ORIGINAL);
    assert.equal((await gate.propose('a.txt', CHANGED, 'why')).status, 'applied');
    // decision for CHANGED exists no more (single use) and never covered this text
    const r = await gate.applyApproved('a.txt', CHANGED + 'tampered\n');
    assert.equal(r.status, 'refused');
    assert.equal(applier.writes.length, 1);
  } finally {
    await ws.cleanup();
  }
});

test('gate: rejected hunks are never written (reject all)', async () => {
  const { ws, applier, gate } = await setup(rejectAll);
  try {
    gate.recordRead('a.txt', ORIGINAL);
    const r = await gate.propose('a.txt', CHANGED, 'why');
    assert.equal(r.status, 'rejected');
    assert.equal(applier.writes.length, 0);
    assert.equal(await readDisk(ws.root, 'a.txt'), ORIGINAL);
  } finally {
    await ws.cleanup();
  }
});

test('gate: only accepted hunks are applied, the rejected one stays as it was', async () => {
  const { ws, applier, gate } = await setup((req) => ({ [req.hunks[0]!.id]: 'reject', [req.hunks[1]!.id]: 'accept', [req.hunks[2]!.id]: 'reject' }));
  try {
    gate.recordRead('a.txt', ORIGINAL);
    const r = await gate.propose('a.txt', CHANGED, 'why');
    assert.equal(r.status, 'partially_applied');
    assert.equal(r.acceptedHunks, 1);
    assert.equal(r.rejectedHunks, 2);
    assert.equal(applier.writes.length, 1); // one apply call = one undo step
    const disk = await readDisk(ws.root, 'a.txt');
    assert.ok(disk.includes('LINE7'));
    assert.ok(!disk.includes('LINE2'));
    assert.ok(!disk.includes('extra'));
  } finally {
    await ws.cleanup();
  }
});

test('gate: a missing decision for a hunk counts as reject', async () => {
  const { ws, gate } = await setup(() => ({}));
  try {
    gate.recordRead('a.txt', ORIGINAL);
    assert.equal((await gate.propose('a.txt', CHANGED, 'why')).status, 'rejected');
    assert.equal(await readDisk(ws.root, 'a.txt'), ORIGINAL);
  } finally {
    await ws.cleanup();
  }
});

test('gate: stale file (changed since read) is refused before review and nothing is written', async () => {
  const { ws, applier, reviewer, gate } = await setup();
  try {
    gate.recordRead('a.txt', ORIGINAL);
    await fs.writeFile(path.join(ws.root, 'a.txt'), ORIGINAL + 'edited by user\n');
    const r = await gate.propose('a.txt', CHANGED, 'why');
    assert.equal(r.status, 'refused');
    assert.match(r.message, /changed since it was read/);
    assert.equal(reviewer.requests.length, 0);
    assert.equal(applier.writes.length, 0);
  } finally {
    await ws.cleanup();
  }
});

test('gate: file changed during review is refused at apply time', async () => {
  const ws = await tempWorkspace({ 'a.txt': ORIGINAL });
  const applier = new DiskApplier(ws.root);
  const reviewer = new ScriptedReviewer((req) => {
    // the user edits the file while the review is open
    nodeFs.writeFileSync(path.join(ws.root, 'a.txt'), 'changed during review\n');
    return acceptAll(req);
  });
  const gate = new WriteGate(ws.fs, applier, reviewer);
  try {
    gate.recordRead('a.txt', ORIGINAL);
    const r = await gate.propose('a.txt', CHANGED, 'why');
    assert.equal(r.status, 'refused');
    assert.match(r.message, /changed after the proposal/);
    assert.equal(applier.writes.length, 0);
    assert.equal(await readDisk(ws.root, 'a.txt'), 'changed during review\n');
  } finally {
    await ws.cleanup();
  }
});

test('gate: an existing file must be read first; a new file need not be', async () => {
  const { ws, gate } = await setup();
  try {
    const r = await gate.propose('a.txt', CHANGED, 'why');
    assert.equal(r.status, 'refused');
    assert.match(r.message, /read the file/);
    const n = await gate.propose('new/b.txt', 'hello\n', 'create');
    assert.equal(n.status, 'applied');
    assert.equal(await readDisk(ws.root, 'new/b.txt'), 'hello\n');
  } finally {
    await ws.cleanup();
  }
});

test('gate: a decision is single use (an operation is never applied twice)', async () => {
  const { ws, applier, gate } = await setup();
  try {
    gate.recordRead('a.txt', ORIGINAL);
    assert.equal((await gate.propose('a.txt', CHANGED, 'why')).status, 'applied');
    assert.equal((await gate.applyApproved('a.txt', CHANGED)).status, 'refused');
    assert.equal(applier.writes.length, 1);
  } finally {
    await ws.cleanup();
  }
});

test('gate: protected and traversal paths are refused', async () => {
  const { ws, applier, gate } = await setup();
  try {
    for (const p of ['.env', '../outside.txt', '.git/config', '/abs.txt']) {
      assert.equal((await gate.propose(p, 'x\n', 'why')).status, 'refused', p);
    }
    assert.equal(applier.writes.length, 0);
  } finally {
    await ws.cleanup();
  }
});

test('gate: undo reverts the last change, and refuses if the file changed since', async () => {
  const { ws, applier, gate } = await setup();
  try {
    gate.recordRead('a.txt', ORIGINAL);
    await gate.propose('a.txt', CHANGED, 'why');
    assert.equal((await gate.undoLast()).status, 'applied');
    assert.equal(await readDisk(ws.root, 'a.txt'), ORIGINAL);
    assert.equal((await gate.undoLast()).status, 'refused'); // nothing left

    gate.recordRead('a.txt', ORIGINAL);
    await gate.propose('a.txt', CHANGED, 'again');
    await fs.writeFile(path.join(ws.root, 'a.txt'), 'user edit\n');
    assert.equal((await gate.undoLast()).status, 'refused');
    assert.equal(await readDisk(ws.root, 'a.txt'), 'user edit\n');
    assert.equal(applier.writes.length, 3);
  } finally {
    await ws.cleanup();
  }
});

test('gate: undo of a created file removes it', async () => {
  const { ws, applier, gate } = await setup();
  try {
    await gate.propose('made.txt', 'x\n', 'create');
    assert.equal((await gate.undoLast()).status, 'applied');
    assert.deepEqual(applier.removed, ['made.txt']);
  } finally {
    await ws.cleanup();
  }
});
