// Multi-file change sets grouped by intent (P3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { WriteGate } from '../src/mcp/gate';
import { DiskApplier, ScriptedReviewer, acceptAll, byGroup, readDisk, tempWorkspace } from './helpers';

const FILES: Record<string, string> = {
  'lib.py': 'def old_name():\n    return 1\n',
  'app.py': 'from lib import old_name\nprint(old_name())\n',
  'test_lib.py': 'from lib import old_name\n\ndef test_it():\n    assert old_name() == 1\n',
};
const SET = [
  { intent: 'rename', files: [{ path: 'lib.py', newContent: 'def new_name():\n    return 1\n' }] },
  { intent: 'update callers', files: [{ path: 'app.py', newContent: 'from lib import new_name\nprint(new_name())\n' }] },
  { intent: 'fix tests', files: [{ path: 'test_lib.py', newContent: 'from lib import new_name\n\ndef test_it():\n    assert new_name() == 1\n' }] },
];

async function setup(answer: ConstructorParameters<typeof ScriptedReviewer>[0], readAll = true) {
  const ws = await tempWorkspace(FILES);
  const applier = new DiskApplier(ws.root);
  const reviewer = new ScriptedReviewer(answer);
  const gate = new WriteGate(ws.fs, applier, reviewer);
  if (readAll) for (const [p, c] of Object.entries(FILES)) gate.recordRead(p, c);
  return { ws, applier, reviewer, gate };
}

test('set: groups reach the reviewer with intents and the plan; accept all applies every file in ONE apply call', async () => {
  const { ws, applier, reviewer, gate } = await setup(acceptAll);
  try {
    const r = await gate.proposeSet('rename old_name to new_name', SET);
    assert.equal(r.status, 'applied');
    assert.deepEqual(reviewer.requests[0]!.groups.map((g) => `${g.intent}:${g.files.map((f) => f.path).join(',')}`), ['rename:lib.py', 'update callers:app.py', 'fix tests:test_lib.py']);
    assert.equal(reviewer.requests[0]!.plan, 'rename old_name to new_name');
    assert.equal(applier.calls.length, 1);
    assert.deepEqual(applier.calls[0]!.map((c) => c.path).sort(), ['app.py', 'lib.py', 'test_lib.py']);
    assert.deepEqual(r.files?.map((f) => `${f.intent}:${f.path}:${f.acceptedHunks}`), ['rename:lib.py:1', 'update callers:app.py:1', 'fix tests:test_lib.py:2']);
  } finally {
    await ws.cleanup();
  }
});

test('set: rejecting a whole group leaves its files untouched; other groups apply', async () => {
  const { ws, gate } = await setup(byGroup(['rename', 'update callers']));
  try {
    const r = await gate.proposeSet('plan', SET);
    assert.equal(r.status, 'partially_applied');
    assert.match(await readDisk(ws.root, 'lib.py'), /new_name/);
    assert.match(await readDisk(ws.root, 'app.py'), /new_name/);
    assert.equal(await readDisk(ws.root, 'test_lib.py'), FILES['test_lib.py']);
  } finally {
    await ws.cleanup();
  }
});

test('set: one unread file refuses the WHOLE set before review; nothing written', async () => {
  const { ws, applier, reviewer, gate } = await setup(acceptAll, false);
  try {
    gate.recordRead('lib.py', FILES['lib.py']!);
    gate.recordRead('app.py', FILES['app.py']!);
    const r = await gate.proposeSet('plan', SET);
    assert.equal(r.status, 'refused');
    assert.match(r.message, /read test_lib\.py/);
    assert.equal(reviewer.requests.length, 0);
    assert.equal(applier.calls.length, 0);
  } finally {
    await ws.cleanup();
  }
});

test('set: one stale file refuses the whole set before review; nothing written', async () => {
  const { ws, applier, reviewer, gate } = await setup(acceptAll);
  try {
    await fs.writeFile(path.join(ws.root, 'app.py'), 'user edit\n');
    const r = await gate.proposeSet('plan', SET);
    assert.equal(r.status, 'refused');
    assert.match(r.message, /app\.py changed since it was read/);
    assert.equal(reviewer.requests.length, 0);
    assert.equal(applier.calls.length, 0);
    assert.equal(await readDisk(ws.root, 'lib.py'), FILES['lib.py']);
  } finally {
    await ws.cleanup();
  }
});

test('set: a file changed during review refuses the whole set at apply time', async () => {
  let root = '';
  const { ws, applier, gate } = await setup((req) => {
    nodeFs.writeFileSync(path.join(root, 'test_lib.py'), 'edited during review\n');
    return acceptAll(req);
  });
  root = ws.root;
  try {
    const r = await gate.proposeSet('plan', SET);
    assert.equal(r.status, 'refused');
    assert.match(r.message, /test_lib\.py changed after the proposal/);
    assert.equal(applier.calls.length, 0);
    assert.equal(await readDisk(ws.root, 'lib.py'), FILES['lib.py']);
  } finally {
    await ws.cleanup();
  }
});

test('set: duplicate paths, empty sets and unauthorised sets are refused; decisions are single use', async () => {
  const { ws, applier, gate } = await setup(acceptAll);
  try {
    const dup = await gate.proposeSet('plan', [SET[0]!, { intent: 'again', files: [{ path: 'lib.py', newContent: 'x\n' }] }]);
    assert.equal(dup.status, 'refused');
    assert.match(dup.message, /more than once/);
    assert.equal((await gate.proposeSet('plan', [])).status, 'refused');
    assert.equal((await gate.applyApprovedSet(SET)).status, 'refused');
    assert.equal((await gate.proposeSet('plan', SET)).status, 'applied');
    assert.equal((await gate.applyApprovedSet(SET)).status, 'refused');
    assert.equal(applier.calls.length, 1);
  } finally {
    await ws.cleanup();
  }
});

test('set: undo reverts every file of the last set in one call (removing created files), or nothing if any file changed', async () => {
  const { ws, applier, gate } = await setup(acceptAll);
  try {
    await gate.proposeSet('plan', [...SET, { intent: 'docs', files: [{ path: 'NOTES.md', newContent: 'renamed\n' }] }]);
    assert.equal((await gate.undoLast()).status, 'applied');
    for (const [p, c] of Object.entries(FILES)) assert.equal(await readDisk(ws.root, p), c);
    assert.ok(applier.calls[1]!.some((c) => c.path === 'NOTES.md' && c.text === undefined));
    assert.equal(applier.calls.length, 2);

    for (const [p, c] of Object.entries(FILES)) gate.recordRead(p, c);
    await gate.proposeSet('plan', SET);
    await fs.writeFile(path.join(ws.root, 'app.py'), 'user\n');
    assert.equal((await gate.undoLast()).status, 'refused');
    assert.match(await readDisk(ws.root, 'lib.py'), /new_name/);
  } finally {
    await ws.cleanup();
  }
});
