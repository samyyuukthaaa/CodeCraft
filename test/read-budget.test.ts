// Per-run read budget of the editor tools: caps, identical-repeat cache, plain messages, reset per run, and the
// plan-before-first-proposal rule unchanged. Observed live before it: 104 read_file / 10 list_files in one run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READ_LIMITS, ReadBudget, BudgetView, callKey, cachedMessage, cappedMessage } from '../src/mcp/budget';
import { WriteGate } from '../src/mcp/gate';
import { PlanStore, createHandlers } from '../src/mcp/tools';
import { DiskApplier, ScriptedReviewer, acceptAll, tempWorkspace } from './helpers';

async function boot(views: BudgetView[] = []) {
  const files: Record<string, string> = { 'src/app.py': 'print("a")\n', 'README.md': 'hello\n' };
  for (let i = 0; i < 40; i++) files[`pkg/m${i}.py`] = `x = ${i}\n`;
  const ws = await tempWorkspace(files);
  const gate = new WriteGate(ws.fs, new DiskApplier(ws.root), new ScriptedReviewer(acceptAll));
  const budget = new ReadBudget((v) => views.push(v));
  const plan = new PlanStore();
  const h = createHandlers({ fs: ws.fs, gate, tests: { run: async () => ({ ran: true, exitCode: 0, output: 'ok' }) }, plan, budget });
  return { h, budget, ws, plan };
}
const body = (r: { text: string }) => JSON.parse(r.text) as Record<string, any>;

test('limits: read_file 25, list_files 6, search_text 10 per run', () => {
  assert.deepEqual({ ...READ_LIMITS }, { read_file: 25, list_files: 6, search_text: 10 });
});

test('cap: the 26th distinct read_file is refused with a plain "stop reading, submit your plan" message', async () => {
  const { h, budget, ws } = await boot();
  try {
    for (let i = 0; i < 25; i++) assert.equal((await h.read_file({ path: `pkg/m${i}.py` })).isError, false, `read ${i}`);
    const r = await h.read_file({ path: 'pkg/m30.py' });
    assert.equal(r.isError, true);
    assert.equal(body(r).error, cappedMessage('read_file', 25));
    assert.match(body(r).error, /^Read budget reached: read_file 25 of 25 calls in this run\. Stop reading now\. Call submit_plan .* then propose_changes/);
    assert.equal(budget.view().used.read_file, 25, 'a refused call does not count');
  } finally {
    await ws.cleanup();
  }
});

test('caps: list_files after 6 and search_text after 10; search_text listing files internally does not count as list_files', async () => {
  const { h, budget, ws } = await boot();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await h.search_text({ query: `q${i}` })).isError, false);
    assert.equal(budget.view().used.list_files, 0, 'internal listing is not counted');
    assert.equal((await h.search_text({ query: 'q99' })).isError, true);
    for (let i = 0; i < 6; i++) assert.equal((await h.list_files({ prefix: `pkg/m${i}.py` })).isError, false);
    const r = await h.list_files({ prefix: 'src' });
    assert.equal(r.isError, true);
    assert.match(body(r).error, /^Read budget reached: list_files 6 of 6 calls/);
  } finally {
    await ws.cleanup();
  }
});

test('cache: an identical repeat (same tool, same arguments, any key order) is answered briefly, not re-read, not counted', async () => {
  const views: BudgetView[] = [];
  const { h, budget, ws } = await boot(views);
  try {
    const first = await h.read_file({ path: 'src/app.py', startLine: 1 });
    assert.equal(first.isError, false);
    const again = await h.read_file({ startLine: 1, path: 'src/app.py' } as never);
    assert.equal(again.isError, false);
    assert.equal(body(again).cached, true);
    assert.equal(body(again).note, cachedMessage('read_file', 'src/app.py lines 1-1 of 1'));
    assert.doesNotMatch(again.text, /print\("a"\)/, 'no file content in the cached answer');
    assert.equal(budget.view().used.read_file, 1);
    assert.equal(budget.view().cached, 1);
    // a different page or file is a new call
    assert.notEqual(callKey('read_file', { path: 'src/app.py' }), callKey('read_file', { path: 'src/app.py', startLine: 2 }));
    assert.equal(callKey('read_file', { path: 'a', startLine: 1 }), callKey('read_file', { startLine: 1, path: 'a' }));
    assert.ok(views.length >= 2, 'the panel is told about every change');
  } finally {
    await ws.cleanup();
  }
});

test('reset: a new run starts from zero (counts and cache)', async () => {
  const { h, budget, ws } = await boot();
  try {
    await h.read_file({ path: 'src/app.py' });
    await h.read_file({ path: 'src/app.py' });
    budget.reset();
    assert.deepEqual(budget.view(), { used: { read_file: 0, list_files: 0, search_text: 0 }, limits: { ...READ_LIMITS }, cached: 0 });
    assert.equal(body(await h.read_file({ path: 'src/app.py' })).cached, undefined, 'read again for real after a reset');
  } finally {
    await ws.cleanup();
  }
});

test('plan-before-first-proposal is unchanged, and an error result is not cached', async () => {
  const { h, ws } = await boot();
  try {
    await h.read_file({ path: 'src/app.py' });
    const r = await h.propose_changes({ plan: '1. x', groups: [{ intent: 'implement', files: [{ path: 'src/app.py', newContent: 'print("b")\n' }] }] });
    assert.equal(r.isError, true);
    assert.match(r.text, /submit_plan/);
    const missing = await h.read_file({ path: 'nope.py' });
    assert.equal(missing.isError, true);
    assert.equal((await h.read_file({ path: 'nope.py' })).isError, true, 'still a real error, not a cached success');
  } finally {
    await ws.cleanup();
  }
});

test('without a budget (low-level use) nothing changes', async () => {
  const ws = await tempWorkspace({ 'a.py': 'x\n' });
  try {
    const h = createHandlers({ fs: ws.fs, gate: new WriteGate(ws.fs, new DiskApplier(ws.root), new ScriptedReviewer(acceptAll)), tests: { run: async () => ({ ran: true, exitCode: 0, output: '' }) } });
    for (let i = 0; i < 30; i++) assert.equal((await h.read_file({ path: 'a.py' })).isError, false);
  } finally {
    await ws.cleanup();
  }
});
