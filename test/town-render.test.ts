// Code Town step 3: stable layout, scene diff, and the Three.js scene graph (real Three.js objects in Node, no GPU):
// incremental updates only, instanced buildings, every resource disposed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { diffScenes } from '../src/town/diff';
import { layoutScene } from '../src/town/layout';
import { initialSceneState, sceneReducer } from '../src/town/reducer';
import type { SceneState, TownEvent, TownFileInput } from '../src/town/types';
import { TextureFactory, TownGraph, bodyColor } from '../src/webview/town/graph';

const files = (n: number, dirs = 5): TownFileInput[] =>
  Array.from({ length: n }, (_, i) => ({ path: `pkg/d${i % dirs}/f${String(i).padStart(4, '0')}.py`, lines: 10 + (i % 300), imports: [`pkg/d${(i + 1) % dirs}/f${String((i + 1) % n).padStart(4, '0')}.py`] }));
const init = (fs: TownFileInput[]): SceneState => sceneReducer(initialSceneState(), { type: 'init', files: fs, at: 0 });
const textures = (): TextureFactory => ({ caption: () => ({ texture: new THREE.Texture(), aspect: 4 }), windows: () => new THREE.Texture() });

test('layout: deterministic, and stable: a new file or district never moves existing buildings', () => {
  const s = init(files(60));
  const a = layoutScene(s);
  assert.deepEqual(layoutScene(s), a, 'same scene, same layout');
  const s2 = sceneReducer(sceneReducer(s, { type: 'file_written', path: 'pkg/d1/new.py', opId: 'o', accepted: 1, rejected: 0, created: true, at: 1 }, ), { type: 'file_written', path: 'brand/new/dir.py', opId: 'o', accepted: 1, rejected: 0, created: true, at: 2 });
  const b = layoutScene(s2, a);
  for (const [id, lot] of Object.entries(a.buildings)) assert.deepEqual(b.buildings[id], lot, id);
  assert.ok(b.buildings['pkg/d1/new.py'], 'the new file got a spare slot in its district');
  const nd = b.districts['brand/new']!;
  assert.ok(nd.z - nd.d / 2 > a.bounds.maxZ, 'a new district goes to the outskirts row');
  assert.deepEqual(b.power, a.power);
  // no two buildings share a slot
  const keys = Object.values(b.buildings).map((l) => `${l.x.toFixed(2)},${l.z.toFixed(2)}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('layout: a district that overflows its spare slots grows at the back; earlier slots stay put', () => {
  let s = init(files(8, 1));
  const a = layoutScene(s);
  for (let i = 0; i < 12; i++) s = sceneReducer(s, { type: 'file_written', path: `pkg/d0/extra${i}.py`, opId: 'o', accepted: 1, rejected: 0, created: true, at: i + 1 });
  const b = layoutScene(s, a);
  for (const [id, lot] of Object.entries(a.buildings)) assert.deepEqual(b.buildings[id], lot, id);
  assert.equal(Object.keys(b.buildings).length, 20);
  assert.ok(a.districts['pkg/d0']!.rows < b.districts['pkg/d0']!.rows);
});

test('diff: an event reports exactly the buildings it changed; init means rebuild', () => {
  const s = init(files(30));
  assert.equal(diffScenes(undefined, s).rebuild, true);
  const r = sceneReducer(s, { type: 'file_read', path: 'pkg/d2/f0002.py', at: 1 });
  assert.deepEqual(diffScenes(s, r), { rebuild: false, added: [], removed: [], changed: ['pkg/d2/f0002.py'], activeChanged: true, powerChanged: false, addedDistricts: [] });
  const p = sceneReducer(r, { type: 'provider', status: 'retrying', at: 2 });
  assert.deepEqual(diffScenes(r, p), { rebuild: false, added: [], removed: [], changed: [], activeChanged: false, powerChanged: true, addedDistricts: [] });
  const again = sceneReducer(p, { type: 'init', files: files(30), at: 3 });
  assert.equal(diffScenes(p, again).rebuild, true);
});

test('graph: one full build, then every event is incremental; no geometry or material is created per event', () => {
  const g = new TownGraph(textures());
  let s = init(files(500));
  g.sync(s);
  const after = g.stats();
  assert.equal(after.rebuilds, 1);
  assert.equal(after.instances, 500);
  assert.ok(after.capacity >= 625, 'room for ~25% new files without a rebuild');
  const evs: TownEvent[] = [];
  for (let i = 0; i < 200; i++) evs.push({ type: i % 3 === 0 ? 'file_read' : 'file_planned', path: `pkg/d${i % 5}/f${String(i).padStart(4, '0')}.py`, action: 'edit', at: i + 1 } as TownEvent);
  let ownedAfterFirst = 0;
  for (const e of evs) {
    s = sceneReducer(s, e);
    g.sync(s);
    ownedAfterFirst ||= g.stats().owned; // the first event adds the active caption (texture + material)
  }
  const st = g.stats();
  assert.equal(st.rebuilds, 1, 'never rebuilt on an event');
  assert.equal(st.incremental, 200);
  assert.equal(st.buildingRebuilds, 0);
  // reused: the active caption and the journey line are swapped (old ones disposed); the only growth is the
  // numbered journey stop labels (texture + material each), capped at 40 stops
  assert.equal(st.owned, ownedAfterFirst + 2 * 40 - 2 + 2, `owned ${st.owned}`);
});

test('graph: one InstancedMesh for all buildings; the touched instance changes colour, the others keep theirs', () => {
  const g = new TownGraph(textures());
  const s = init(files(40));
  g.sync(s);
  const meshes: THREE.InstancedMesh[] = [];
  g.root.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh && o.name === 'buildings') meshes.push(o as THREE.InstancedMesh);
  });
  assert.equal(meshes.length, 1);
  const m = meshes[0]!;
  const colorOf = (i: number) => {
    const c = new THREE.Color();
    m.getColorAt(i, c);
    return c.getHexString();
  };
  const before = Array.from({ length: 40 }, (_, i) => colorOf(i));
  const id = 'pkg/d3/f0003.py';
  const next = sceneReducer(s, { type: 'hunk_proposed', path: id, intent: 'i', hunks: 1, at: 1 });
  g.sync(next);
  const sorted = Object.keys(s.buildings).sort();
  const idx = sorted.indexOf(id);
  const after = Array.from({ length: 40 }, (_, i) => colorOf(i));
  assert.equal(after[idx], bodyColor(next.buildings[id]!).getHexString());
  assert.notEqual(after[idx], before[idx]);
  assert.deepEqual(after.filter((_, i) => i !== idx), before.filter((_, i) => i !== idx));
});

test('graph: new files join without a rebuild until capacity runs out, then only the buildings are rebuilt', () => {
  const g = new TownGraph(textures());
  let s = init(files(48));
  g.sync(s);
  const cap = g.stats().capacity;
  for (let i = 0; g.stats().instances < cap; i++) {
    s = sceneReducer(s, { type: 'file_written', path: `pkg/d0/new${i}.py`, opId: 'o', accepted: 1, rejected: 0, created: true, at: i + 1 });
    g.sync(s);
  }
  assert.equal(g.stats().buildingRebuilds, 0);
  s = sceneReducer(s, { type: 'file_written', path: 'pkg/d0/one-more.py', opId: 'o', accepted: 1, rejected: 0, created: true, at: 999 });
  g.sync(s);
  assert.equal(g.stats().buildingRebuilds, 1);
  assert.equal(g.stats().rebuilds, 1);
  assert.equal(g.stats().instances, Object.keys(s.buildings).length);
});

test('graph: picking a building returns its id', () => {
  const g = new TownGraph(textures());
  const s = init([{ path: 'a/x.py', lines: 100 }]);
  g.sync(s);
  g.root.updateMatrixWorld(true);
  const p = g.positionOf('a/x.py')!;
  const ray = new THREE.Raycaster(new THREE.Vector3(p.x, 50, p.z), new THREE.Vector3(0, -1, 0));
  assert.equal(g.pick(ray), 'a/x.py');
});

test('graph: dispose releases every geometry, material, texture and instance buffer it created', () => {
  const created: Array<{ addEventListener(t: string, f: () => void): void }> = [];
  let disposed = 0;
  const track = <T extends { addEventListener(t: 'dispose', f: () => void): void }>(x: T): T => {
    created.push(x as never);
    x.addEventListener('dispose', () => disposed++);
    return x;
  };
  const tex: TextureFactory = { caption: () => ({ texture: track(new THREE.Texture()), aspect: 3 }), windows: () => track(new THREE.Texture()) };
  const g = new TownGraph(tex);
  let s = init(files(30));
  g.sync(s);
  for (let i = 0; i < 20; i++) {
    s = sceneReducer(s, { type: 'file_read', path: `pkg/d${i % 5}/f${String(i).padStart(4, '0')}.py`, at: i + 1 });
    g.sync(s);
  }
  const live: THREE.EventDispatcher[] = [];
  g.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !(o as THREE.Sprite).isSprite) live.push(m.geometry as never); // sprites share one module-wide geometry
    if (m.material) live.push(...([] as THREE.Material[]).concat(m.material as THREE.Material));
  });
  let liveDisposed = 0;
  for (const x of new Set(live)) (x as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => liveDisposed++);
  // live textures: 5 district captions + active caption + power caption + window texture + 20 journey stop
  // labels; every replaced active caption (20 events) was disposed when it was replaced
  // + 1: Scout's current speech bubble (each replaced bubble is disposed)
  // + 1 for Scout's name tag (created once per build)
  assert.equal(created.length - disposed, 8 + 20 + 1 + 1);
  g.dispose();
  assert.equal(disposed, created.length, 'all textures disposed');
  assert.equal(liveDisposed, new Set(live).size, 'all live geometries and materials disposed');
  assert.equal(g.root.children.length, 0);
});
