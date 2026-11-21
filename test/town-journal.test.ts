// Code Town step 1: the scene comes from ONE source of truth (index layout + journal events), with the real
// write gate producing the journal. Deterministic, persistent across reloads, provider errors on the power plant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, MemorySink } from '../src/journal/journal';
import { WriteGate } from '../src/mcp/gate';
import { entriesOfRun, townEventsFor, townEventsFromJournal } from '../src/town/fromJournal';
import { foldEvents, initialSceneState, sceneReducer } from '../src/town/reducer';
import type { SceneState, TownEvent, TownFileInput } from '../src/town/types';
import { DiskApplier, ScriptedReviewer, tempWorkspace } from './helpers';
import { hunkKey } from '../src/mcp/gate';

const FILES: TownFileInput[] = [
  { path: 'src/app.py', lines: 40, language: 'python' },
  { path: 'src/cli.py', lines: 120, language: 'python' },
  { path: 'tests/test_app.py', lines: 30, language: 'python', isTest: true },
];
const scene = (events: TownEvent[]): SceneState => foldEvents(sceneReducer(initialSceneState(), { type: 'init', files: FILES, at: 0 }), events);

test('projection: every relevant journal entry maps to town events with the entry timestamp', () => {
  const at = 1234;
  const base = { runId: 'r', at };
  assert.deepEqual(townEventsFor({ ...base, t: 'op_proposed', files: [{ path: 'a.py', intent: 'implement', hunks: 2, created: false }], reason: 'why' }), [{ type: 'hunk_proposed', path: 'a.py', intent: 'implement', hunks: 2, reason: 'why', at }]);
  assert.deepEqual(townEventsFor({ ...base, t: 'review', files: [{ path: 'a.py', accepted: 1, rejected: 1 }] }), [{ type: 'hunk_decided', path: 'a.py', accepted: 1, rejected: 1, at }]);
  assert.deepEqual(townEventsFor({ ...base, t: 'op_applied', opId: 'o1', files: [{ path: 'n.py', intent: 'add', before: null, after: 'h', accepted: 1, rejected: 0 }] }), [{ type: 'file_written', path: 'n.py', opId: 'o1', accepted: 1, rejected: 0, created: true, at }]);
  assert.deepEqual(townEventsFor({ ...base, t: 'files_undone', opId: 'o1', files: ['n.py'] }), [{ type: 'file_reverted', path: 'n.py', opId: 'o1', at }]);
  assert.deepEqual(townEventsFor({ ...base, t: 'tests', passed: false, exitCode: 1, phase: 'after', failing: ['tests/test_app.py::test_x'] }), [{ type: 'test_run', passed: false, failing: ['tests/test_app.py::test_x'], phase: 'after', at }]);
  assert.deepEqual(townEventsFor({ ...base, t: 'regression', tests: ['tests/test_app.py::test_x', '(the test command)'] }), [{ type: 'file_failed', path: 'tests/test_app.py', reason: 'a test that passed before now fails: tests/test_app.py::test_x', at }]);
  assert.deepEqual(townEventsFor({ ...base, t: 'provider_error', model: 'g/a', cls: 'rate_limit' }), [{ type: 'provider', status: 'retrying', model: 'g/a', detail: 'rate limit', at }]);
  assert.deepEqual(townEventsFor({ ...base, t: 'model_switched', from: 'g/a', to: 'g/b', reason: 'rate_limit' }), [{ type: 'provider', status: 'failed_over', model: 'g/b', detail: 'from g/a (rate limit)', at }]);
  assert.deepEqual(townEventsFor({ ...base, t: 'provider_recovered', model: 'g/a' }), [{ type: 'provider', status: 'recovered', model: 'g/a', detail: 'g/a works again', at }]);
  assert.deepEqual(townEventsFor({ ...base, t: 'plan', summary: 's', files: [{ path: 'src/app.py', action: 'edit' }, { path: 'src/cli.py', action: 'context' }] }), [{ type: 'file_planned', path: 'src/app.py', action: 'edit', at }]);
  assert.deepEqual(townEventsFor({ ...base, t: 'tool_call', opId: 'x', tool: 'read_file', args: 'path=a.py' }), [], 'tool_call is not a read: only the journaled file_read is');
});

test('propose_changes through the real gate: per-hunk decisions give rejected / applied buildings; one read event per read', async () => {
  const ws = await tempWorkspace({ 'src/app.py': 'a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\ng = 7\nh = 8\n', 'src/cli.py': 'x = 1\n' });
  try {
    const journal = new Journal(new MemorySink(), (() => { let t = 100; return () => (t += 10); })());
    journal.runId = 'r1';
    await journal.append({ t: 'run_started', request: 'change things' });
    // accept the first hunk of app.py, reject its second; reject cli.py entirely; accept the new file
    const reviewer = new ScriptedReviewer((req) => {
      const out: Record<string, 'accept' | 'reject'> = {};
      for (const g of req.groups) for (const f of g.files) f.hunks.forEach((h, i) => (out[hunkKey(f.path, h.id)] = f.path === 'src/cli.py' || (f.path === 'src/app.py' && i === 1) ? 'reject' : 'accept'));
      return out;
    });
    const gate = new WriteGate(ws.fs, new DiskApplier(ws.root), reviewer, journal);
    for (const p of ['src/app.py', 'src/cli.py']) {
      gate.recordRead(p, (await ws.fs.read(p))!);
      await journal.append({ t: 'file_read', path: p }); // what the extension journals for each real read
    }
    const r = await gate.proposeSet('plan', [
      { intent: 'implement', files: [{ path: 'src/app.py', newContent: 'A = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\ng = 7\nH = 8\n' }, { path: 'src/new.py', newContent: 'n = 1\n' }] },
      { intent: 'callers', files: [{ path: 'src/cli.py', newContent: 'x = 2\n' }] },
    ]);
    assert.equal(r.status, 'partially_applied');
    const events = townEventsFromJournal(journal.all());
    assert.equal(events.filter((e) => e.type === 'file_read').length, 2, 'exactly one read event per real read');
    const s = scene(events);
    assert.equal(s.buildings['src/cli.py']!.state, 'rejected');
    assert.equal(s.buildings['src/app.py']!.state, 'applied');
    assert.match(s.buildings['src/app.py']!.lastAction!.detail, /changed: 1 hunk\(s\) applied, 1 rejected/);
    const created = s.buildings['src/new.py']!;
    assert.equal(created.state, 'applied');
    assert.equal(created.placeholder, true, 'not in the index: a placeholder lot');
    assert.match(created.lastAction!.detail, /^created/);
  } finally {
    await ws.cleanup();
  }
});

test('provider errors change the power plant, never a building', () => {
  let s = scene([{ type: 'run_started', runId: 'r', at: 1 }, { type: 'file_read', path: 'src/app.py', at: 2 }]);
  s = sceneReducer(s, { type: 'provider', status: 'retrying', model: 'g/a', detail: 'rate limit', at: 3 });
  assert.deepEqual(s.power, { status: 'retrying', model: 'g/a', detail: 'rate limit', at: 3 });
  assert.equal(s.buildings['src/app.py']!.state, 'read');
  assert.equal(s.stats.failed, 0);
  s = sceneReducer(s, { type: 'provider', status: 'failed_over', model: 'g/b', detail: 'from g/a', at: 4 });
  assert.equal(s.power.status, 'failed_over');
  assert.equal(s.power.model, 'g/b');
  s = sceneReducer(s, { type: 'provider', status: 'recovered', model: 'g/a', at: 5 });
  assert.equal(s.power.status, 'recovered');
  assert.equal(s.stats.failed, 0);
});

test('test runs: failing test files fail, then recover when they pass; applied files carry the real test status', () => {
  let s = scene([
    { type: 'run_started', runId: 'r', at: 1 },
    { type: 'file_written', path: 'src/app.py', opId: 'o', accepted: 1, rejected: 0, created: false, at: 2 },
    { type: 'test_run', passed: false, failing: ['tests/test_app.py::test_add'], phase: 'after', at: 3 },
  ]);
  assert.equal(s.buildings['tests/test_app.py']!.state, 'failed');
  assert.equal(s.buildings['tests/test_app.py']!.testStatus, 'failed');
  assert.equal(s.buildings['src/app.py']!.state, 'applied');
  assert.equal(s.buildings['src/app.py']!.testStatus, 'failed');
  assert.deepEqual(s.tests, { passed: false, failing: ['tests/test_app.py::test_add'], phase: 'after', at: 3 });
  s = sceneReducer(s, { type: 'test_run', passed: true, failing: [], phase: 'after_fix', at: 4 });
  assert.equal(s.buildings['tests/test_app.py']!.state, 'recovered');
  assert.equal(s.buildings['tests/test_app.py']!.testStatus, 'passed');
  assert.equal(s.buildings['src/app.py']!.testStatus, 'passed');
  assert.equal(s.stats.recovered, 1);
  // a failure of the whole command (no per-test IDs) neither fails nor "recovers" a test file
  const whole = sceneReducer(s, { type: 'test_run', passed: false, failing: ['(the test command)'], phase: 'agent', at: 5 });
  assert.equal(whole.buildings['tests/test_app.py']!.state, 'recovered');
  assert.equal(whole.buildings['src/app.py']!.testStatus, 'failed');
});

test('planned, then read; a later read never downgrades a proposed or applied building', () => {
  const s = scene([
    { type: 'file_planned', path: 'src/cli.py', action: 'edit', at: 1 },
    { type: 'file_planned', path: 'src/app.py', action: 'edit', at: 2 },
    { type: 'file_read', path: 'src/app.py', at: 3 },
    { type: 'hunk_proposed', path: 'src/cli.py', intent: 'i', hunks: 1, at: 4 },
    { type: 'file_read', path: 'src/cli.py', at: 5 },
  ]);
  assert.equal(s.buildings['src/app.py']!.state, 'read');
  assert.equal(s.buildings['src/cli.py']!.state, 'proposed');
  assert.equal(s.buildings['src/cli.py']!.lastAction!.detail, 'read by the agent');
});

test('deterministic: the reducer never reads the clock, and the same journal always gives the same scene', () => {
  const events: TownEvent[] = [
    { type: 'run_started', runId: 'r', at: 1 },
    { type: 'file_read', path: 'src/app.py', at: 2 },
    { type: 'file_written', path: 'src/app.py', opId: 'o', accepted: 1, rejected: 0, created: false, at: 3 },
    { type: 'provider', status: 'retrying', at: 4 },
  ];
  const realNow = Date.now;
  Date.now = () => {
    throw new Error('the reducer read the clock');
  };
  try {
    const a = scene(events);
    const b = scene(events);
    assert.deepEqual(a, b);
    assert.equal(a.buildings['src/app.py']!.lastUpdated, 3);
  } finally {
    Date.now = realNow;
  }
});

test('persistence: a reloaded journal (same sink) rebuilds exactly the same scene; only the latest run is shown', async () => {
  const sink = new MemorySink();
  const j = new Journal(sink, (() => { let t = 0; return () => ++t; })());
  j.runId = 'old';
  await j.append({ t: 'run_started', request: 'old run' });
  await j.append({ t: 'file_read', path: 'src/cli.py' });
  j.runId = 'new';
  await j.append({ t: 'run_started', request: 'new run' });
  await j.append({ t: 'file_read', path: 'src/app.py' });
  await j.append({ t: 'provider_error', model: 'g/a', cls: 'unavailable_or_timeout' });
  j.runId = '';
  await j.append({ t: 'op_undone', opId: 'o', files: ['src/app.py'] }); // outside a run (Undo Last Change), after it
  const live = scene(townEventsFromJournal(j.all()));
  const reloaded = new Journal(sink);
  await reloaded.load();
  assert.deepEqual(scene(townEventsFromJournal(reloaded.all())), live);
  assert.equal(live.runId, 'new');
  assert.equal(live.buildings['src/cli.py']!.state, 'idle', 'the old run is not shown');
  assert.equal(live.buildings['src/app.py']!.state, 'idle');
  assert.match(live.buildings['src/app.py']!.lastAction!.detail, /reverted/);
  assert.equal(entriesOfRun(reloaded.all(), 'old').length, 2, 'a specific run can still be picked (replay)');
});

test('journal listener: every appended entry is delivered once, already redacted', async () => {
  const j = new Journal(new MemorySink());
  const seen: string[] = [];
  const off = j.onAppend((e) => seen.push(e.t === 'run_started' ? e.request : e.t));
  await j.append({ t: 'run_started', request: `key AIza${'Z'.repeat(35)}` });
  off();
  await j.append({ t: 'run_finished', status: 'done' });
  assert.equal(seen.length, 1);
  assert.ok(!seen[0]!.includes('AIza'));
});
