// Code Town step 4: Agent Journey and Architecture modes over the same scene state, the legend, and the
// click-to-inspect panel (last agent action, status, reason).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { townEventsFor } from '../src/town/fromJournal';
import { KIND_VISUALS, POWER_VISUALS } from '../src/town/grammar';
import { MAX_JOURNEY, foldEvents, initialSceneState, sceneReducer } from '../src/town/reducer';
import type { SceneState, TownEvent, TownFileInput } from '../src/town/types';
import { inspect, journeyStops, legendFor } from '../src/town/view';
import { TextureFactory, TownGraph, bodyColor } from '../src/webview/town/graph';

const FILES: TownFileInput[] = [
  { path: 'src/flask/cli.py', lines: 1100 },
  { path: 'src/flask/app.py', lines: 900 },
  { path: 'tests/test_cli.py', lines: 300, isTest: true },
  { path: 'docs/cli.rst', lines: 200 },
];
const scene = (events: TownEvent[]): SceneState => foldEvents(sceneReducer(initialSceneState(), { type: 'init', files: FILES, at: 0 }), events);
const RUN: TownEvent[] = [
  { type: 'run_started', runId: 'r', at: 1 },
  { type: 'file_planned', path: 'src/flask/cli.py', action: 'edit', why: 'the run command lives here', at: 2 },
  { type: 'file_read', path: 'src/flask/cli.py', at: 3 },
  { type: 'file_read', path: 'src/flask/app.py', at: 4 },
  { type: 'file_read', path: 'tests/test_cli.py', at: 5 },
  { type: 'hunk_proposed', path: 'src/flask/cli.py', intent: 'implement', hunks: 2, reason: 'add --env-file', at: 6 },
  { type: 'hunk_decided', path: 'src/flask/cli.py', accepted: 2, rejected: 0, at: 7 },
  { type: 'file_written', path: 'src/flask/cli.py', opId: 'o1', accepted: 2, rejected: 0, created: false, at: 8 },
  { type: 'file_note', path: 'src/flask/cli.py', reason: 'flask run must load a chosen .env file', plain: 'This lets you pick the settings file.', confidence: 'check this', at: 9 },
];

test('journey: ordered stops, consecutive actions on one building are one stop, planning is not a visit', () => {
  const s = scene(RUN);
  assert.deepEqual(s.journey.map((j) => [j.path, j.type]), [
    ['src/flask/cli.py', 'file_read'],
    ['src/flask/app.py', 'file_read'],
    ['tests/test_cli.py', 'file_read'],
    ['src/flask/cli.py', 'file_written'],
  ]);
  assert.deepEqual(journeyStops(s), [
    { path: 'src/flask/cli.py', n: 1 },
    { path: 'src/flask/app.py', n: 2 },
    { path: 'tests/test_cli.py', n: 3 },
  ]);
  assert.deepEqual(sceneReducer(s, { type: 'run_started', runId: 'next', at: 10 }).journey, [], 'a new run starts a new journey');
  let long = scene([]);
  for (let i = 0; i < MAX_JOURNEY + 50; i++) long = sceneReducer(long, { type: 'file_read', path: i % 2 ? 'src/flask/app.py' : 'docs/cli.rst', at: i });
  assert.equal(long.journey.length, MAX_JOURNEY, 'bounded');
});

test('file notes annotate a building without counting as an agent action', () => {
  const s = scene(RUN);
  const b = s.buildings['src/flask/cli.py']!;
  assert.equal(b.reason, 'flask run must load a chosen .env file');
  assert.equal(b.plain, 'This lets you pick the settings file.');
  assert.equal(b.confidence, 'check this');
  assert.equal(b.lastAction?.type, 'file_written', 'the last agent action is still the write');
  assert.equal(s.journey.at(-1)?.type, 'file_written');
  assert.deepEqual(scene([{ type: 'file_note', path: 'nowhere.py', reason: 'r', plain: 'p', confidence: 'sure', at: 1 }]).buildings['nowhere.py'], undefined);
});

test('journal projection: change groups become notes; plan reasons reach the buildings', () => {
  const base = { runId: 'r', at: 5 };
  assert.deepEqual(townEventsFor({ ...base, t: 'change_group', opId: 'o', intent: 'i', files: ['a.py', 'b.py'], reason: 'r', plain: 'p', confidence: 'risky', why: [], tests: 'passed' }), [
    { type: 'file_note', path: 'a.py', reason: 'r', plain: 'p', confidence: 'risky', at: 5 },
    { type: 'file_note', path: 'b.py', reason: 'r', plain: 'p', confidence: 'risky', at: 5 },
  ]);
  assert.deepEqual(townEventsFor({ ...base, t: 'plan', summary: 's', files: [{ path: 'a.py', action: 'edit', why: 'w' }] }), [{ type: 'file_planned', path: 'a.py', action: 'edit', why: 'w', at: 5 }]);
  assert.equal(scene([{ type: 'file_planned', path: 'docs/cli.rst', action: 'edit', why: 'document it', at: 1 }]).buildings['docs/cli.rst']!.reason, 'document it');
});

test('inspector: last agent action, status and reason, plus plain words, confidence, tests, kind, journey stop', () => {
  const s = scene(RUN);
  const info = inspect(s, 'src/flask/cli.py')!;
  assert.equal(info.title, 'cli.py');
  const row = (l: string) => info.rows.find((r) => r.label === l);
  assert.equal(row('Status')!.value, '✔ Applied');
  assert.equal(row('Status')!.color, '#16a34a');
  assert.equal(row('Last agent action')!.value, 'change applied at 00:00:00 UTC: changed: 2 hunk(s) applied (operation o1)');
  assert.equal(row('Reason')!.value, 'flask run must load a chosen .env file');
  assert.equal(row('In plain words')!.value, 'This lets you pick the settings file.');
  assert.deepEqual([row('Confidence')!.value, row('Confidence')!.color], ['check this', '#f59e0b']);
  assert.equal(row('Kind')!.value, `${KIND_VISUALS.control.icon} ${KIND_VISUALS.control.label}`);
  assert.equal(row('Journey')!.value, 'stop 1 of 3');
  const idle = inspect(s, 'docs/cli.rst')!;
  assert.equal(idle.rows.find((r) => r.label === 'Last agent action')!.value, 'none in this run');
  assert.equal(inspect(s, 'missing.py'), undefined);
});

test('legend: per mode, every item has colour, icon and text', () => {
  const journey = legendFor('journey');
  assert.deepEqual(journey.map((s) => s.title), ['Building state', 'Tests', 'Path', 'Power plant (model provider)']);
  assert.equal(journey[0]!.items.length, 8);
  const arch = legendFor('architecture');
  assert.deepEqual(arch.map((s) => s.title), ['Buildings', 'Streets', 'Power plant (model provider)']);
  assert.deepEqual(arch[2]!.items, Object.values(POWER_VISUALS));
  for (const sec of [...journey, ...arch]) for (const it of sec.items) assert.ok(it.color && it.icon && it.label);
});

const textures = (): TextureFactory => ({ caption: () => ({ texture: new THREE.Texture(), aspect: 3 }), windows: () => undefined });
const byName = (g: TownGraph, name: string) => g.root.getObjectByName(name);

test('graph modes: Journey shows the path, beacons and state colours; Architecture shows kinds and bright roads', () => {
  const g = new TownGraph(textures());
  let s = scene([]);
  g.sync(s);
  for (const e of RUN) {
    s = sceneReducer(s, e);
    g.sync(s);
  }
  const line = byName(g, 'journey') as THREE.Line;
  assert.ok(line?.visible);
  assert.equal((line.geometry.getAttribute('position') as THREE.BufferAttribute).count, 4, 'one point per journey stop');
  assert.ok(byName(g, 'stop:1') && byName(g, 'stop:3'));
  const mesh = byName(g, 'buildings') as THREE.InstancedMesh;
  const idx = Object.keys(s.buildings).sort().indexOf('src/flask/cli.py');
  const c = new THREE.Color();
  mesh.getColorAt(idx, c);
  assert.equal(c.getHexString(), bodyColor(s.buildings['src/flask/cli.py']!, 'journey').getHexString());

  g.setMode('architecture');
  assert.equal(g.viewMode, 'architecture');
  mesh.getColorAt(idx, c);
  assert.equal(c.getHexString(), bodyColor(s.buildings['src/flask/cli.py']!, 'architecture').getHexString(), 'coloured by kind');
  assert.equal(line.visible, false);
  assert.equal((byName(g, 'beacons') as THREE.Object3D).visible, false);
  assert.equal(((byName(g, 'roads') as THREE.LineSegments).material as THREE.LineBasicMaterial).opacity, 1);
  assert.equal(g.stats().rebuilds, 1, 'a mode switch never rebuilds the scene');

  g.select('docs/cli.rst');
  const ring = byName(g, 'selection') as THREE.Mesh;
  assert.ok(ring.visible);
  assert.deepEqual([ring.position.x, ring.position.z], [g.positionOf('docs/cli.rst')!.x, g.positionOf('docs/cli.rst')!.z]);
  g.select(undefined);
  assert.equal(ring.visible, false);
});

test('graph: journey updates replace only the small path line (old one disposed); resources stay bounded', () => {
  const g = new TownGraph(textures());
  let s = scene([]);
  g.sync(s);
  s = sceneReducer(s, { type: 'run_started', runId: 'r', at: 1 });
  g.sync(s);
  const owned: number[] = [];
  for (let i = 0; i < 60; i++) {
    s = sceneReducer(s, { type: 'file_read', path: FILES[i % FILES.length]!.path, at: i + 2 });
    g.sync(s);
    owned.push(g.stats().owned);
  }
  // after all 4 stop labels exist, the count no longer grows: each new path line replaces the old one
  assert.equal(owned[59], owned[10]);
  assert.equal(g.stats().rebuilds, 1);
});
