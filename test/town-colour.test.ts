// Colourful town (codetown-scout step 3): district palette, rooftops, festival lanterns on success, rainbow replay
// accent; every state keeps colour + icon + text with good contrast; reduced motion keeps everything still.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DISTRICT_PALETTE, LANTERN_COLORS, REPLAY_RAINBOW, districtColors } from '../src/town/grammar';
import { initialSceneState, sceneReducer } from '../src/town/reducer';
import { BUILDING_STATES, STATE_VISUALS, SceneState } from '../src/town/types';
import { TextureFactory, TownGraph, bodyColor, roofColor } from '../src/webview/town/graph';

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

test('state colours: every state has colour + icon + text, colours are distinct, and contrast is at least 3:1 on the night panels', () => {
  for (const s of BUILDING_STATES) {
    const v = STATE_VISUALS[s];
    assert.ok(v.icon && v.label, s);
    for (const bg of ['#0c1530', '#0b1638']) assert.ok(contrast(v.color, bg) >= 3, `${s} ${v.color} on ${bg}: ${contrast(v.color, bg).toFixed(2)}`);
  }
  assert.equal(new Set(BUILDING_STATES.map((s) => STATE_VISUALS[s].color)).size, BUILDING_STATES.length);
});

test('district palette: original warm colours, deterministic per district, rooftops darker than walls', () => {
  assert.equal(new Set(DISTRICT_PALETTE.map((p) => p.wall)).size, DISTRICT_PALETTE.length);
  assert.deepEqual(districtColors('src/flask'), districtColors('src/flask'));
  const used = new Set(['src/flask', 'tests', 'docs', 'examples/tutorial', 'src/flask/json', '.github', 'tests/test_apps'].map((d) => districtColors(d).name));
  assert.ok(used.size >= 4, `districts get varied colours (${[...used].join(', ')})`);
  for (const p of DISTRICT_PALETTE) assert.ok(lum(p.roof) < lum(p.wall), p.name);
  assert.equal(LANTERN_COLORS.length, 6);
  assert.equal(REPLAY_RAINBOW.length, 6);
});

const tex: TextureFactory = { caption: () => ({ texture: new THREE.Texture(), aspect: 3 }), windows: () => undefined };
const scene = (): SceneState => sceneReducer(initialSceneState(), { type: 'init', files: [{ path: 'src/flask/cli.py', lines: 300 }, { path: 'src/flask/app.py', lines: 300 }, { path: 'docs/cli.rst', lines: 100 }], at: 0 });
const mesh = (g: TownGraph, name: string) => g.root.getObjectByName(name) as THREE.InstancedMesh;
const colorAt = (m: THREE.InstancedMesh, i: number) => {
  const c = new THREE.Color();
  m.getColorAt(i, c);
  return c.getHexString();
};
const scaleAt = (m: THREE.InstancedMesh, i: number) => {
  const mat = new THREE.Matrix4();
  m.getMatrixAt(i, mat);
  // (Matrix4.decompose reports scale 1 for a zero-scale matrix, so measure the column length instead)
  return Math.round(new THREE.Vector3().setFromMatrixColumn(mat, 0).length() * 1000) / 1000;
};

test('idle buildings wear their district colours with coloured roofs; touched buildings show their state colour', () => {
  const g = new TownGraph(tex, false);
  let s = scene();
  g.sync(s);
  const ids = Object.keys(s.buildings).sort();
  const i = ids.indexOf('docs/cli.rst');
  assert.equal(colorAt(mesh(g, 'buildings'), i), bodyColor(s.buildings['docs/cli.rst']!).getHexString());
  assert.equal(colorAt(mesh(g, 'roofs'), i), new THREE.Color(districtColors('docs').roof).getHexString());
  assert.equal(roofColor(s.buildings['docs/cli.rst']!).getHexString(), new THREE.Color(districtColors('docs').roof).getHexString());
  s = sceneReducer(s, { type: 'hunk_proposed', path: 'docs/cli.rst', intent: 'i', hunks: 1, at: 1 });
  g.sync(s);
  assert.equal(colorAt(mesh(g, 'buildings'), i), new THREE.Color(STATE_VISUALS.proposed.color).getHexString());
});

test('festival lanterns appear only over successes (applied, recovered), and not in Architecture mode', () => {
  const g = new TownGraph(tex, false);
  let s = scene();
  g.sync(s);
  const ids = Object.keys(s.buildings).sort();
  const lit = (id: string) => [0, 1, 2].map((k) => scaleAt(mesh(g, 'lanterns'), ids.indexOf(id) * 3 + k));
  assert.deepEqual(lit('src/flask/cli.py'), [0, 0, 0]);
  s = sceneReducer(s, { type: 'file_written', path: 'src/flask/cli.py', opId: 'o', accepted: 1, rejected: 0, created: false, at: 1 });
  s = sceneReducer(s, { type: 'file_read', path: 'src/flask/app.py', at: 2 });
  g.sync(s);
  assert.deepEqual(lit('src/flask/cli.py'), [1, 1, 1]);
  assert.deepEqual(lit('src/flask/app.py'), [0, 0, 0]);
  g.setMode('architecture');
  assert.deepEqual(lit('src/flask/cli.py'), [0, 0, 0], 'Architecture shows kinds, not celebrations');
  g.setMode('journey');
  assert.deepEqual(lit('src/flask/cli.py'), [1, 1, 1]);
  assert.equal(g.stats().rebuilds, 1);
});

test('replay accent: the journey path turns rainbow while replaying, yellow otherwise', () => {
  const g = new TownGraph(tex, false);
  let s = scene();
  g.sync(s);
  for (const [i, p] of ['src/flask/cli.py', 'src/flask/app.py', 'docs/cli.rst'].entries()) {
    s = sceneReducer(s, { type: 'file_read', path: p, at: i + 1 });
    g.sync(s);
  }
  const line = () => g.root.getObjectByName('journey') as THREE.Line;
  assert.equal(line().geometry.getAttribute('color'), undefined);
  g.setReplay(true);
  const cols = line().geometry.getAttribute('color') as THREE.BufferAttribute;
  assert.equal(cols.count, 3);
  assert.notEqual(new THREE.Color(cols.getX(0), cols.getY(0), cols.getZ(0)).getHexString(), new THREE.Color(cols.getX(2), cols.getY(2), cols.getZ(2)).getHexString());
  g.setReplay(false);
  assert.equal(line().geometry.getAttribute('color'), undefined);
});

test('reduced motion: lanterns and string lights stay still', () => {
  const g = new TownGraph(tex, true);
  let s = scene();
  s = sceneReducer(s, { type: 'file_written', path: 'src/flask/cli.py', opId: 'o', accepted: 1, rejected: 0, created: false, at: 1 });
  g.sync(s);
  const l = mesh(g, 'lanterns');
  for (const t of [0.4, 1.7, 3.3]) {
    g.tick(t);
    assert.equal(l.position.y, 0);
  }
  const moving = new TownGraph(tex, false);
  moving.sync(s);
  moving.tick(1.2);
  assert.notEqual(mesh(moving, 'lanterns').position.y, 0, 'they bob when motion is allowed');
});
