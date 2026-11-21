// Scout (codetown-scout step 1): pure, deterministic guide state; navigate-request validation; the 3D figure walks
// (or, with reduced motion, fades) to exactly the place the state says, and can be muted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Journal, MemorySink } from '../src/journal/journal';
import { townEventsFromJournal } from '../src/town/fromJournal';
import { parseTownMessage } from '../src/town/protocol';
import { foldEvents, initialSceneState, sceneReducer } from '../src/town/reducer';
import { SCOUT_HOME } from '../src/town/scout';
import type { SceneState, TownEvent, TownFileInput } from '../src/town/types';
import { TextureFactory, TownGraph } from '../src/webview/town/graph';

const FILES: TownFileInput[] = [{ path: 'src/flask/cli.py', lines: 1100 }, { path: 'src/flask/app.py', lines: 900 }, { path: 'tests/test_cli.py', lines: 300, isTest: true }];
const init = (): SceneState => sceneReducer(initialSceneState(), { type: 'init', files: FILES, at: 0 });
const RUN: TownEvent[] = [
  { type: 'run_started', runId: 'r', at: 1 },
  { type: 'file_planned', path: 'src/flask/cli.py', action: 'edit', at: 2 },
  { type: 'file_read', path: 'src/flask/cli.py', at: 3 },
  { type: 'provider', status: 'retrying', model: 'g/primary', detail: 'rate limit', at: 4 },
  { type: 'provider', status: 'failed_over', model: 'g/backup', detail: 'from g/primary (rate limit)', at: 5 },
  { type: 'hunk_proposed', path: 'src/flask/cli.py', intent: 'i', hunks: 2, at: 6 },
  { type: 'hunk_decided', path: 'src/flask/cli.py', accepted: 2, rejected: 0, at: 7 },
  { type: 'file_written', path: 'src/flask/cli.py', opId: 'o', accepted: 2, rejected: 0, created: false, at: 8 },
  { type: 'hunk_proposed', path: 'tests/test_cli.py', intent: 'i', hunks: 1, at: 9 },
  { type: 'hunk_decided', path: 'tests/test_cli.py', accepted: 0, rejected: 1, at: 10 },
  { type: 'file_failed', path: 'tests/test_cli.py', reason: 'x', at: 11 },
  { type: 'provider', status: 'recovered', model: 'g/primary', at: 12 },
  { type: 'run_finished', status: 'done', at: 13 },
];

test('Scout follows the agent: place, bubble and mood after every kind of event', () => {
  const trail: Array<[string, string, string]> = [];
  let s = init();
  assert.deepEqual(s.scout.at, { kind: 'home' });
  for (const e of RUN) {
    s = sceneReducer(s, e);
    trail.push([s.scout.at.kind === 'building' ? s.scout.at.id : s.scout.at.kind, s.scout.bubble, s.scout.mood]);
  }
  assert.deepEqual(trail, [
    ['home', 'A new task! Let me follow the agent.', 'busy'],
    ['src/flask/cli.py', 'Planning to edit cli.py', 'busy'],
    ['src/flask/cli.py', 'Reading cli.py', 'busy'],
    ['src/flask/cli.py', 'The model had a hiccup (hit its rate limit). Trying again…', 'worried'],
    ['plant', 'The main model stopped because it hit its rate limit. I switched to the backup model (g/backup).', 'worried'],
    ['src/flask/cli.py', 'Proposing a change to cli.py', 'busy'],
    ['src/flask/cli.py', 'You accepted 2 changes in cli.py', 'happy'],
    ['src/flask/cli.py', 'Changed cli.py', 'happy'],
    ['tests/test_cli.py', 'Proposing a change to test_cli.py', 'busy'],
    ['tests/test_cli.py', 'You rejected the change to test_cli.py', 'idle'],
    ['tests/test_cli.py', 'A test in test_cli.py fails', 'worried'],
    ['plant', 'The main model (g/primary) works again.', 'happy'],
    ['plant', 'All done for this task.', 'happy'],
  ]);
  assert.equal(s.scout.move, RUN.length + 1, 'every event is one move or bubble (plus init)');
});

test('Scout: the walk starts where Scout was; a bubble on the same spot is not a new walk', () => {
  let s = sceneReducer(init(), RUN[0]!);
  s = sceneReducer(s, RUN[2]!);
  assert.deepEqual([s.scout.from, s.scout.at], [{ kind: 'home' }, { kind: 'building', id: 'src/flask/cli.py' }]);
  const again = sceneReducer(s, { type: 'file_read', path: 'src/flask/cli.py', at: 99 });
  assert.deepEqual(again.scout.from, { kind: 'home' }, 'staying put keeps the last walk');
});

test('Scout is deterministic: no clock, same events -> same Scout; replay from the journal reproduces it, clicks included', async () => {
  const realNow = Date.now;
  Date.now = () => {
    throw new Error('Scout read the clock');
  };
  try {
    assert.deepEqual(foldEvents(init(), RUN).scout, foldEvents(init(), RUN).scout);
  } finally {
    Date.now = realNow;
  }
  const j = new Journal(new MemorySink(), (() => {
    let t = 100;
    return () => ++t;
  })());
  j.runId = 'r';
  await j.append({ t: 'run_started', request: 'x' });
  await j.append({ t: 'file_read', path: 'src/flask/cli.py' });
  await j.append({ t: 'scout_navigate', path: 'src/flask/app.py' }); // the user's click
  await j.append({ t: 'run_finished', status: 'done' });
  const live = foldEvents(init(), townEventsFromJournal(j.all()));
  const replayed = foldEvents(init(), townEventsFromJournal(j.all(), 'r'));
  assert.deepEqual(replayed.scout, live.scout);
  assert.deepEqual(live.scout.at, { kind: 'building', id: 'src/flask/app.py' });
  assert.equal(live.scout.by, 'user', 'run_finished only changes the bubble: Scout is still where the user sent it');
  assert.equal(live.scout.bubble, 'All done for this task.');
  const afterClick = foldEvents(init(), townEventsFromJournal(j.all()).slice(0, 3));
  assert.deepEqual([afterClick.scout.by, afterClick.scout.bubble], ['user', 'Here is app.py. Opening it for you.']);
  assert.equal(afterClick.buildings['src/flask/app.py']!.state, 'idle', 'a click is not an agent action');
  assert.equal(afterClick.journey.length, 1);
});

test('Scout bubbles never echo provider error text (plain words only)', () => {
  const s = sceneReducer(init(), { type: 'provider', status: 'failed_over', model: 'g/backup', detail: `from g/a (invalid or revoked key) AIza${'X'.repeat(35)}`, at: 1 });
  assert.equal(s.scout.bubble, 'The main model stopped because its key was rejected. I switched to the backup model (g/backup).');
  assert.ok(!s.scout.bubble.includes('AIza'));
  assert.deepEqual(sceneReducer(s, { type: 'reset' }).scout.at, SCOUT_HOME.at);
});

test('navigate request: a relative workspace path and nothing else', () => {
  assert.deepEqual(parseTownMessage({ type: 'navigate', path: 'src/flask/cli.py' }), { type: 'navigate', path: 'src/flask/cli.py' });
  assert.deepEqual(parseTownMessage({ type: 'navigate', path: 'src\\flask\\cli.py' }), { type: 'navigate', path: 'src/flask/cli.py' });
  for (const bad of ['../x.py', 'a/../../x.py', '/etc/passwd', 'C:/Windows/x', 'c:x', '', 'a//b.py', 'a/\u0000.py', 'x'.repeat(500)]) assert.equal(parseTownMessage({ type: 'navigate', path: bad }), undefined, JSON.stringify(bad));
  assert.equal(parseTownMessage({ type: 'navigate', path: 'a.py', open: false }), undefined, 'no extra fields');
  assert.equal(parseTownMessage({ type: 'navigate', path: 42 }), undefined);
});

const tex: TextureFactory = { caption: () => ({ texture: new THREE.Texture(), aspect: 4 }), windows: () => undefined };
const scoutOf = (g: TownGraph) => g.root.getObjectByName('scout')!;

test('3D Scout walks to exactly the place the state says, along the streets', () => {
  const g = new TownGraph(tex, false);
  let s = init();
  g.sync(s);
  g.tick(0);
  const home = g.scoutPosition({ kind: 'home' });
  assert.deepEqual(scoutOf(g).position.toArray(), home.toArray(), 'starts at home');
  s = sceneReducer(s, { type: 'file_read', path: 'src/flask/app.py', at: 1 });
  g.sync(s);
  const target = g.scoutPosition({ kind: 'building', id: 'src/flask/app.py' });
  g.tick(10);
  assert.ok(g.animating);
  g.tick(10.15);
  const mid = scoutOf(g).position.clone();
  assert.ok(!mid.equals(home) && !mid.equals(target), 'on the way');
  assert.ok(Math.abs(mid.z - home.z) < 1e-6 || Math.abs(mid.x - target.x) < 1e-6, 'x first, then z');
  assert.ok(mid.y > Math.min(home.y, target.y), 'arcs above the roofs on the way');
  assert.equal(target.y, 0.9 + s.buildings['src/flask/app.py']!.height * 0.32, 'stands on the roof');
  g.tick(13);
  assert.equal(g.animating, false);
  assert.deepEqual(scoutOf(g).position.toArray(), target.toArray());
  assert.equal(scoutOf(g).getObjectByName('scout-bubble')!.type, 'Sprite');
});

test('reduced motion: no walking, a short fade; muting hides Scout', () => {
  const g = new TownGraph(tex, true);
  let s = init();
  g.sync(s);
  g.tick(0);
  const home = scoutOf(g).position.clone();
  s = sceneReducer(s, { type: 'provider', status: 'failed_over', model: 'm', at: 1 });
  g.sync(s);
  const plant = g.scoutPosition({ kind: 'plant' });
  const seen: THREE.Vector3[] = [];
  for (let t = 20; t <= 21; t += 0.05) {
    g.tick(t);
    seen.push(scoutOf(g).position.clone());
  }
  assert.ok(seen.every((p) => p.equals(home) || p.equals(plant)), 'never in between: no walking');
  assert.ok(seen.at(-1)!.equals(plant));
  assert.equal(g.animating, false);
  g.setScoutVisible(false);
  assert.equal(scoutOf(g).visible, false);
  s = sceneReducer(s, { type: 'file_read', path: 'src/flask/cli.py', at: 2 });
  g.sync(s);
  assert.equal(scoutOf(g).visible, false, 'stays muted on later moves');
});
