// P4/P5: append-only journal, operation IDs (no edit applied twice), checkpoint resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, MemorySink } from '../src/journal/journal';
import { WriteGate, operationId } from '../src/mcp/gate';
import type { TurnEvent } from '../src/trueforge/client';
import { AgentAttempt, CONTINUE_PROMPT, FAILOVER_NOTE, runWithFailover } from '../src/trueforge/failover';
import type { TurnDriver } from '../src/trueforge/run';
import { DiskApplier, ScriptedReviewer, acceptAll, readDisk, rejectAll, tempWorkspace } from './helpers';

test('journal: append-only JSONL, redacted, reloadable; torn last line ignored', async () => {
  const sink = new MemorySink();
  const j = new Journal(sink, () => 42);
  j.runId = 'r1';
  const fake = 'AIza' + 'K'.repeat(35);
  await j.append({ t: 'run_started', request: `use key ${fake}` });
  await j.append({ t: 'run_finished', status: 'done' });
  assert.equal(sink.lines.length, 2);
  assert.ok(!sink.lines.join('\n').includes(fake));
  assert.deepEqual(JSON.parse(sink.lines[1]!), { t: 'run_finished', status: 'done', runId: 'r1', at: 42 });
  sink.lines.push('{"t":"op_appl'); // crash mid-write
  const again = new Journal(sink);
  await again.load();
  assert.equal(again.all().length, 2);
});

test('gate+journal: op_started is written before the apply, op_applied after; undo records op_undone', async () => {
  const ws = await tempWorkspace({ 'a.py': 'x = 1\n' });
  try {
    const sink = new MemorySink();
    const journal = new Journal(sink);
    journal.runId = 'run-1';
    let journalAtApply = 0;
    const applier = new DiskApplier(ws.root);
    const orig = applier.applyAll.bind(applier);
    applier.applyAll = async (c) => {
      journalAtApply = sink.lines.length;
      await orig(c);
    };
    const gate = new WriteGate(ws.fs, applier, new ScriptedReviewer(acceptAll), journal);
    gate.recordRead('a.py', 'x = 1\n');
    assert.equal((await gate.propose('a.py', 'x = 2\n', 'r')).status, 'applied');
    const types = journal.all().map((e) => e.t);
    assert.deepEqual(types, ['op_started', 'op_applied']);
    assert.equal(journalAtApply, 1, 'op_started was already in the journal when the write happened');
    const applied = journal.all()[1] as Extract<ReturnType<Journal['all']>[number], { t: 'op_applied' }>;
    assert.equal(applied.opId, operationId([{ path: 'a.py', before: 'x = 1\n', after: 'x = 2\n' }]));
    assert.deepEqual(applied.files.map((f) => [f.path, f.accepted, f.rejected]), [['a.py', 1, 0]]);
    assert.equal(journal.appliedOps().size, 1);
    await gate.undoLast();
    assert.equal(journal.all().at(-1)?.t, 'op_undone');
    assert.equal(journal.appliedOps().size, 0, 'an undone operation may be applied again');
  } finally {
    await ws.cleanup();
  }
});

test('gate+journal: the same operation is never applied twice (e.g. a retried run after a crash)', async () => {
  const ws = await tempWorkspace({ 'a.py': 'x = 1\n' });
  try {
    const journal = new Journal(new MemorySink());
    const applier = new DiskApplier(ws.root);
    const gate1 = new WriteGate(ws.fs, applier, new ScriptedReviewer(acceptAll), journal);
    gate1.recordRead('a.py', 'x = 1\n');
    assert.equal((await gate1.propose('a.py', 'x = 2\n', 'r')).status, 'applied');
    // simulate the file being reverted outside CodeCraft (no op_undone) and a retried run replaying the op
    await applier.applyAll([{ path: 'a.py', text: 'x = 1\n' }]);
    const gate2 = new WriteGate(ws.fs, applier, new ScriptedReviewer(acceptAll), journal);
    gate2.recordRead('a.py', 'x = 1\n');
    const r = await gate2.propose('a.py', 'x = 2\n', 'r');
    assert.equal(r.status, 'refused');
    assert.match(r.message, /already applied \(operation [0-9a-f]{16}\)/);
    assert.equal(await readDisk(ws.root, 'a.py'), 'x = 1\n');
    assert.equal(journal.all().at(-1)?.t, 'op_refused');
  } finally {
    await ws.cleanup();
  }
});

test('gate+journal: rejections are journaled', async () => {
  const ws = await tempWorkspace({ 'a.py': 'x = 1\n' });
  try {
    const journal = new Journal(new MemorySink());
    const gate = new WriteGate(ws.fs, new DiskApplier(ws.root), new ScriptedReviewer(rejectAll), journal);
    gate.recordRead('a.py', 'x = 1\n');
    await gate.propose('a.py', 'x = 2\n', 'r');
    assert.deepEqual(journal.all().map((e) => e.t), ['op_rejected']);
  } finally {
    await ws.cleanup();
  }
});

// ---------- checkpoint resume ----------
const ev = (e: unknown): TurnEvent => e as TurnEvent;
const gen = (events: TurnEvent[]) =>
  (async function* () {
    yield* events;
  })();
const errorTurn = (msg: string): TurnEvent[] => [ev({ type: 'turn.done', id: 'b', threadId: null, state: { status: 'error', message: msg } })];
const okTurn = (text: string): TurnEvent[] => [ev({ type: 'turn.done', id: 'b', threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'm', content: text }, requiredActions: [] } })];
function attempt(agent: string, turns: TurnEvent[][], prompts: string[]): AgentAttempt {
  let n = 0;
  const driver: TurnDriver = {
    start: (t) => {
      prompts.push(`${agent}:${t}`);
      return gen(turns[n++] ?? []);
    },
    resumePaused: () => gen([]),
    newTurnWithApprovals: () => gen([]),
  };
  return { agent, model: `${agent}/m`, driver: async () => driver };
}

test('checkpoint resume: the failover and continue prompts carry what the journal says this run already did', async () => {
  const journal = new Journal(new MemorySink());
  journal.runId = 'run-7';
  await journal.append({ t: 'op_applied', opId: 'abc', files: [{ path: 'src/flask/cli.py', intent: 'implement', before: 'h1', after: 'h2', accepted: 2, rejected: 0 }] });
  await journal.append({ t: 'tests', passed: false, exitCode: 1 });
  await journal.append({ t: 'op_applied', runId: 'other-run', opId: 'zzz', files: [{ path: 'x.py', intent: 'edit', before: null, after: 'h', accepted: 1, rejected: 0 }] });
  const note = journal.completedSteps();
  assert.equal(note, 'Already done in this run (do not redo; read files again before changing them): src/flask/cli.py (implement: 2 hunk(s) applied after review); tests failed (exit 1).');

  const prompts: string[] = [];
  const DEMAND = '[Model Error] Request failed (503): high demand';
  await runWithFailover('task', [attempt('primary', [errorTurn(DEMAND), errorTurn(DEMAND), errorTurn(DEMAND)], prompts), attempt('fallback', [okTurn('ok')], prompts)], {
    approver: { approve: async () => ({ allow: true }) },
    delay: async () => undefined,
    progressNote: () => journal.completedSteps(),
  });
  assert.equal(prompts[1], `primary:${CONTINUE_PROMPT}\n${note}`);
  assert.equal(prompts.at(-1), `fallback:task\n\n${FAILOVER_NOTE}\n${note}`);
});
