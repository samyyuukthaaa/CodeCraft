// "Show me around": Scout's guided tour. Stops from the live town and the built-in guide (no model, no network),
// Next / Skip, a walk that stays on the streets, reduced motion, 2D parity and mute in the page, and nothing in the
// reducer or the journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as THREE from 'three';
import { buildTownHtml } from '../src/town/html';
import { layoutScene } from '../src/town/layout';
import { crossesDistrict } from '../src/town/patrol';
import { initialSceneState, sceneReducer } from '../src/town/reducer';
import { ScoutTour, tourStops } from '../src/town/tour';
import type { SceneState, TownEvent, TownFileInput } from '../src/town/types';
import { TextureFactory, TownGraph } from '../src/webview/town/graph';

const FILES: TownFileInput[] = [
  ...Array.from({ length: 30 }, (_, i) => ({ path: `src/pkg/m${String(i).padStart(2, '0')}.py`, lines: 40 + i * 7 })),
  ...Array.from({ length: 6 }, (_, i) => ({ path: `tests/test_m${i}.py`, lines: 30 + i * 5, isTest: true })),
  { path: 'docs/index.rst', lines: 50 },
];
const init = (): SceneState => sceneReducer(initialSceneState(), { type: 'init', files: FILES, at: 0 });
const tex: TextureFactory = { caption: () => ({ texture: new THREE.Texture(), aspect: 4 }), windows: () => undefined };
const scoutOf = (g: TownGraph) => g.root.getObjectByName('scout')!;

test('stops: power plant, a test lab, a changed building, then the inspector on it; texts from the built-in guide', () => {
  let s = init();
  s = sceneReducer(s, { type: 'run_started', runId: 'r', at: 1 });
  s = sceneReducer(s, { type: 'hunk_proposed', path: 'src/pkg/m05.py', intent: 'i', hunks: 1, at: 2 } as TownEvent);
  s = sceneReducer(s, { type: 'file_written', path: 'src/pkg/m07.py', opId: 'o', accepted: 1, rejected: 0, created: false, at: 3 } as TownEvent);
  const stops = tourStops(s);
  assert.deepEqual(stops.map((x) => x.id), ['plant', 'lab', 'changed', 'inspector']);
  assert.deepEqual(stops[0]!.place, { kind: 'plant' });
  assert.equal(stops[1]!.building?.startsWith('tests/'), true, 'a test lab');
  assert.equal(stops[2]!.building, 'src/pkg/m07.py', 'an applied change comes before a proposal');
  assert.match(stops[2]!.text, /The agent touched m07\.py: it is applied now\./);
  assert.equal(stops[3]!.building, stops[2]!.building, 'the inspector opens on the changed building');
  assert.match(stops[0]!.text, /power plant/);
  for (const st of stops) assert.ok(st.text.includes(st.keyword), `${st.id}: the yellow keyword is in the text`);
  // nothing changed yet: still a stop, honestly worded
  const quiet = tourStops(init());
  assert.equal(quiet[2]!.title, 'Where changes show up');
  assert.match(quiet[2]!.text, /^Nothing has changed yet in this run\./);
  // deterministic
  assert.deepEqual(tourStops(s), stops);
});

test('controller: walk, show on arrival, Next to the end (Finish), Skip at any time', () => {
  const t = new ScoutTour(tourStops(init()));
  assert.equal(t.phase, 'walking');
  assert.equal(t.tick(true), undefined, 'still walking');
  assert.equal(t.tick(false), 'show');
  assert.equal(t.phase, 'showing');
  assert.equal(t.next(), 'walk');
  assert.equal(t.index, 1);
  t.tick(false);
  t.next();
  t.tick(false);
  t.next();
  t.tick(false);
  assert.ok(t.isLast);
  assert.equal(t.next(), 'done', 'Finish');
  assert.equal(t.current, undefined);
  const s = new ScoutTour(tourStops(init()));
  s.skip();
  assert.equal(s.phase, 'done');
  assert.equal(new ScoutTour([]).phase, 'done', 'an empty town has no tour');
});

test('3D: Scout walks to each stop on the streets (never through a district), and the patrol waits; ending resumes it', () => {
  const g = new TownGraph(tex);
  const s = init();
  g.sync(s);
  let t = 0;
  for (; t < 4; t += 1 / 30) g.tick(t); // patrol under way
  const L = layoutScene(s);
  for (const stop of tourStops(s).slice(0, 3)) {
    g.guideTo(stop.place);
    assert.ok(g.scoutGuiding);
    let prev = scoutOf(g).position.clone();
    for (let k = 0; k < 30 * 40 && g.walkingToTarget; k++, t += 1 / 30) {
      g.tick(t);
      const p = scoutOf(g).position;
      if (prev.y < 0.2 && p.y < 0.2) assert.equal(crossesDistrict(L, { x: prev.x, z: prev.z }, { x: p.x, z: p.z }), false, `${stop.id}: on the streets`);
      prev = p.clone();
    }
    assert.equal(g.walkingToTarget, false, `${stop.id}: arrived`);
    const at = scoutOf(g).position.clone();
    for (let k = 0; k < 60; k++, t += 1 / 30) g.tick(t);
    assert.ok(scoutOf(g).position.distanceTo(at) < 1e-9, `${stop.id}: waits there (no patrol during the tour)`);
  }
  g.guideTo(undefined);
  assert.equal(g.scoutGuiding, false);
  const end = scoutOf(g).position.clone();
  for (let k = 0; k < 30 * 12; k++, t += 1 / 30) g.tick(t);
  assert.ok(scoutOf(g).position.distanceTo(end) > 1, 'the patrol resumed');
});

test('reduced motion: the guided move is a fade (no walk through intermediate points); an agent move ends the tour', () => {
  const g = new TownGraph(tex, true);
  let s = init();
  g.sync(s);
  g.tick(0);
  g.guideTo({ kind: 'plant' });
  const xs = new Set<number>();
  for (let t = 0; t < 2; t += 1 / 30) {
    g.tick(t);
    xs.add(Math.round(scoutOf(g).position.x * 100));
  }
  assert.ok(xs.size <= 2, `a jump, not a walk (${xs.size} positions)`);
  s = sceneReducer(s, { type: 'run_started', runId: 'r', at: 1 });
  s = sceneReducer(s, { type: 'file_read', path: 'src/pkg/m01.py', at: 2 } as TownEvent);
  g.sync(s);
  assert.equal(g.scoutGuiding, false, 'the agent takes Scout back');
});

test('renderer only: the tour never touches the scene state; no model, no network', () => {
  const g = new TownGraph(tex);
  const s = init();
  const before = JSON.stringify(s);
  g.sync(s);
  for (const st of tourStops(s)) g.guideTo(st.place);
  g.guideTo(undefined);
  assert.equal(JSON.stringify(s), before);
  const src = fs.readFileSync('src/town/tour.ts', 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\/|Math\.random|Date\.now|from ['"](vscode|three|node:)/);
  for (const f of ['src/town/reducer.ts', 'src/town/fromJournal.ts', 'src/journal/journal.ts']) if (fs.existsSync(f)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /tourStops|ScoutTour|guideTo/, f);
});

test('page: "Show me around" (visible in 2D, hidden when muted), Next and Skip in the bubble, stop highlight style', () => {
  const html = buildTownHtml({ cspSource: 'x', nonce: 'N', scriptUri: 'a.js' });
  assert.match(html, /<button id="btn-tour" class="scout-tour" type="button"[^>]*>🏮 Show me around<\/button>/);
  assert.match(html, /body\.scout-muted \.scout-tour \{ display: none !important; \}/);
  assert.doesNotMatch(html, /body\.flat \.scout-tour/, 'not hidden in 2D');
  assert.match(html, /<div id="tour-ctl" class="tour-ctl hidden"><button id="tour-next" type="button">Next ▸<\/button><button id="tour-skip" type="button">Skip tour<\/button><\/div>/);
  assert.match(html, /\.tour-target \{ outline: 3px solid #facc15 !important;/);
});
