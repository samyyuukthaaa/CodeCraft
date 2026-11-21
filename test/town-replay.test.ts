// Code Town step 5: replay a finished run from the journal through the same reducer, with play, pause, speed
// and seek; the webview may only ask for a run by a valid run ID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, MemorySink } from '../src/journal/journal';
import { finishedRuns, townEventsFromJournal } from '../src/town/fromJournal';
import { parseTownMessage } from '../src/town/protocol';
import { foldEvents, initialSceneState, sceneReducer } from '../src/town/reducer';
import { MAX_STEP_MS, MIN_STEP_MS, SPEEDS, createPlayer, delayToNext, isFinished, pause, play, positionText, seek, setSpeed, step } from '../src/town/replay';
import type { TownEvent, TownFileInput } from '../src/town/types';

const FILES: TownFileInput[] = [{ path: 'src/app.py', lines: 100 }, { path: 'src/cli.py', lines: 300 }, { path: 'tests/test_cli.py', lines: 80, isTest: true }];
const base = () => sceneReducer(initialSceneState(), { type: 'init', files: FILES, at: 0 });
const T0 = Date.UTC(2026, 10, 21, 14, 0, 0);
const EVENTS: TownEvent[] = [
  { type: 'run_started', runId: 'aaaaaaaaaaaaaaaa', at: T0 },
  { type: 'file_read', path: 'src/cli.py', at: T0 + 2_000 },
  { type: 'file_read', path: 'src/app.py', at: T0 + 2_010 },
  { type: 'hunk_proposed', path: 'src/cli.py', intent: 'i', hunks: 1, at: T0 + 30_000 },
  { type: 'file_written', path: 'src/cli.py', opId: 'o', accepted: 1, rejected: 0, created: false, at: T0 + 31_000 },
  { type: 'test_run', passed: true, failing: [], phase: 'after', at: T0 + 40_000 },
  { type: 'run_finished', status: 'done', at: T0 + 41_000 },
];

test('replay: stepping through every event gives the same scene as folding the run (same reducer)', () => {
  let p = play(createPlayer('aaaaaaaaaaaaaaaa', base(), EVENTS));
  assert.equal(p.playing, true);
  let n = 0;
  while (!isFinished(p)) {
    p = step(p);
    n++;
  }
  assert.equal(n, EVENTS.length);
  assert.equal(p.playing, false, 'stops at the end');
  assert.deepEqual(p.scene, foldEvents(base(), EVENTS));
  assert.equal(p.scene.buildings['src/cli.py']!.state, 'applied');
  assert.deepEqual(step(p), { ...p, playing: false }, 'no-op at the end');
});

test('replay: seek is identical to stepping there, backwards and forwards', () => {
  const start = createPlayer('aaaaaaaaaaaaaaaa', base(), EVENTS);
  let stepped = start;
  for (let i = 0; i < 4; i++) stepped = step(stepped);
  const sought = seek(seek(start, 6), 4);
  assert.deepEqual(sought.scene, stepped.scene);
  assert.equal(sought.index, 4);
  assert.deepEqual(seek(start, 99).index, EVENTS.length);
  assert.deepEqual(seek(start, -3).scene, start.scene);
});

test('replay: play, pause, restart at the end, speed', () => {
  let p = createPlayer('aaaaaaaaaaaaaaaa', base(), EVENTS);
  p = pause(play(p));
  assert.equal(p.playing, false);
  const end = seek(p, EVENTS.length);
  const again = play(end);
  assert.deepEqual([again.index, again.playing], [0, true], 'play at the end restarts from the beginning');
  assert.equal(setSpeed(p, 4).speed, 4);
  assert.equal(setSpeed(p, 3).speed, 1, 'only the offered speeds');
  assert.deepEqual([...SPEEDS], [0.5, 1, 2, 4, 8]);
});

test('replay pacing: real gaps between journal timestamps, scaled by speed, clamped', () => {
  const at = (i: number, speed = 1) => delayToNext(setSpeed(seek(createPlayer('aaaaaaaaaaaaaaaa', base(), EVENTS), i), speed));
  assert.equal(at(1), MAX_STEP_MS, 'a 2 s gap is clamped');
  assert.equal(at(2), MIN_STEP_MS, 'a 10 ms burst is still visible');
  assert.equal(at(4), 1000, 'the real 1 s gap at 1x');
  assert.equal(at(4, 4), 250, '...and at 4x');
  assert.equal(at(3, 8), MAX_STEP_MS, 'a 28 s gap at 8x is still clamped');
});

test('replay position text', () => {
  const p = seek(createPlayer('aaaaaaaaaaaaaaaa', base(), EVENTS), 2);
  assert.equal(positionText(p), '2 / 7 · 14:00:02 UTC');
  assert.equal(positionText(seek(p, 0)), '0 / 7');
});

test('finished runs from the journal, newest first; the replay events are that run only', async () => {
  let t = T0;
  const j = new Journal(new MemorySink(), () => (t += 1000));
  for (const [id, status] of [['1111111111111111', 'done'], ['2222222222222222', 'error'], ['3333333333333333', '']] as const) {
    j.runId = id;
    await j.append({ t: 'run_started', request: `request ${id.slice(0, 1)}` });
    await j.append({ t: 'file_read', path: 'src/app.py' });
    if (status) await j.append({ t: 'run_finished', status });
  }
  const runs = finishedRuns(j.all());
  assert.deepEqual(runs.map((r) => [r.runId, r.status, r.request]), [['2222222222222222', 'error', 'request 2'], ['1111111111111111', 'done', 'request 1']]);
  const evs = townEventsFromJournal(j.all(), '1111111111111111');
  assert.deepEqual(evs.map((e) => e.type), ['run_started', 'file_read', 'run_finished']);
});

test('protocol: replay_run takes only a valid run ID (or none)', () => {
  assert.deepEqual(parseTownMessage({ type: 'replay_run', runId: '0123456789abcdef' }), { type: 'replay_run', runId: '0123456789abcdef' });
  assert.deepEqual(parseTownMessage({ type: 'replay_run' }), { type: 'replay_run' });
  for (const bad of ['../../etc', '0123456789ABCDEF', '0123', 42, '0123456789abcdef0']) assert.equal(parseTownMessage({ type: 'replay_run', runId: bad }), undefined, String(bad));
});
