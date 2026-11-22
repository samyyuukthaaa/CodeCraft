// Scout is always there (codetown-scout fix round): he starts on the plaza, walks only on streets (never through a
// building), patrols on a seeded, renderer-only route when no run is active, follows the agent during a run, fades
// with reduced motion, and has a visible fallback marker if his mesh fails to build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { layoutScene } from '../src/town/layout';
import { crossesDistrict, frontOf, patrolStops, plaza, route, rowsOf } from '../src/town/patrol';
import { foldEvents, initialSceneState, sceneReducer } from '../src/town/reducer';
import type { SceneState, TownFileInput } from '../src/town/types';
import { TextureFactory, TownGraph } from '../src/webview/town/graph';
import { SCOUT_SCALE } from '../src/webview/town/scout3d';

const FILES: TownFileInput[] = Array.from({ length: 60 }, (_, i) => ({ path: `pkg/d${i % 6}/f${String(i).padStart(3, '0')}.py`, lines: 20 + ((i * 37) % 400) }));
const init = (): SceneState => sceneReducer(initialSceneState(), { type: 'init', files: FILES, at: 0 });
const tex: TextureFactory = { caption: () => ({ texture: new THREE.Texture(), aspect: 4 }), windows: () => undefined };
const scoutOf = (g: TownGraph) => g.root.getObjectByName('scout')!;

test('Scout is in the scene state from the very start, at home, and after init and reset', () => {
  assert.deepEqual(initialSceneState().scout.at, { kind: 'home' });
  assert.ok(initialSceneState().scout.bubble.length > 0);
  const s = init();
  assert.deepEqual(s.scout.at, { kind: 'home' });
  assert.deepEqual(sceneReducer(s, { type: 'reset' }).scout.at, { kind: 'home' });
  assert.equal(s.running, false);
  const r = sceneReducer(s, { type: 'run_started', runId: 'r', at: 1 });
  assert.equal(r.running, true);
  assert.equal(sceneReducer(r, { type: 'run_finished', status: 'done', at: 2 }).running, false);
});

test('streets: every patrol route between any two stops (and the plaza) stays on streets, never through a district', () => {
  const s = init();
  const L = layoutScene(s);
  assert.ok(rowsOf(L).length >= 2, 'a town with several rows');
  const points = [plaza(L), ...patrolStops(s, 12).map((id) => frontOf(L, id)!)];
  for (const p of points) assert.equal(crossesDistrict(L, p, p), false, `stop ${JSON.stringify(p)} is on a street`);
  for (const a of points)
    for (const b of points) {
      let from = a;
      for (const p of route(L, a, b)) {
        assert.equal(crossesDistrict(L, from, p), false, `segment ${JSON.stringify(from)} -> ${JSON.stringify(p)}`);
        from = p;
      }
      assert.deepEqual(from, b);
    }
});

test('patrol stops are seeded from the building list: same town, same patrol; no Math.random or clock', () => {
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = () => {
    throw new Error('Math.random used');
  };
  Date.now = () => {
    throw new Error('clock used');
  };
  try {
    const a = patrolStops(init(), 12);
    assert.deepEqual(patrolStops(init(), 12), a);
    assert.equal(new Set(a).size, 12, 'distinct stops');
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
});

test('the patrol never enters the scene state or the replay: the reducer output is the same with or without a renderer', () => {
  const g = new TownGraph(tex, false);
  const events = [{ type: 'file_read' as const, path: 'pkg/d1/f001.py', at: 1 }];
  const s = foldEvents(init(), events);
  const before = JSON.stringify(s);
  g.sync(s);
  for (let t = 0; t < 60; t += 0.25) g.tick(t); // a minute of patrol
  assert.equal(JSON.stringify(s), before, 'the renderer did not change the scene');
  assert.deepEqual(foldEvents(init(), events).scout, s.scout);
});

test('3D: Scout spawns on the plaza, is house-sized with a name tag, rim light and lantern glow', () => {
  const g = new TownGraph(tex, false);
  g.sync(init());
  const sc = scoutOf(g);
  const p = g.scoutPosition({ kind: 'home' });
  assert.deepEqual(sc.position.toArray(), p.toArray());
  assert.equal(sc.scale.x, SCOUT_SCALE);
  assert.ok(SCOUT_SCALE * 1.33 >= 3, 'about as tall as a small house');
  assert.ok(sc.getObjectByName('scout-name') && sc.getObjectByName('scout-rim') && sc.getObjectByName('scout-glow') && sc.getObjectByName('scout-bubble'));
  assert.equal(g.scoutMode, 'figure');
  const meshes: THREE.Mesh[] = [];
  sc.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  assert.equal(new Set(meshes.map((m) => m.geometry)).size, 1, 'one low-poly mesh (the rim reuses its geometry)');
});

test('3D: with no run, Scout patrols along the streets; during a run he walks to the agent\'s file and stands on its roof', () => {
  const g = new TownGraph(tex, false);
  let s = init();
  g.sync(s);
  const L = layoutScene(s);
  const home = scoutOf(g).position.clone();
  let moved = false;
  for (let t = 0; t < 40; t += 0.1) {
    g.tick(t);
    const p = scoutOf(g).position;
    if (!p.equals(home)) moved = true;
    if (p.y < 0.5) assert.equal(crossesDistrict(L, { x: p.x, z: p.z }, { x: p.x, z: p.z }), false, `on a street at t=${t.toFixed(1)}`);
  }
  assert.ok(moved, 'he patrols when no run is active');
  s = sceneReducer(s, { type: 'run_started', runId: 'r', at: 1 });
  s = sceneReducer(s, { type: 'file_read', path: 'pkg/d2/f002.py', at: 2 });
  g.sync(s);
  for (let t = 40; t < 80 && g.animating; t += 0.1) g.tick(t);
  g.tick(80);
  const roof = g.scoutPosition({ kind: 'building', id: 'pkg/d2/f002.py' }, s);
  assert.deepEqual(scoutOf(g).position.toArray(), roof.toArray(), 'on the roof of the file the agent reads');
  for (let t = 80; t < 100; t += 0.5) g.tick(t);
  assert.deepEqual(scoutOf(g).position.toArray(), roof.toArray(), 'no patrol during a run');
});

test('reduced motion: no walking or patrol, a fade when the target changes; he waits on the plaza', () => {
  const g = new TownGraph(tex, true);
  let s = init();
  g.sync(s);
  const home = scoutOf(g).position.clone();
  for (let t = 0; t < 30; t += 0.25) g.tick(t);
  assert.ok(scoutOf(g).position.equals(home), 'no patrol with reduced motion');
  s = sceneReducer(s, { type: 'provider', status: 'failed_over', model: 'm', at: 1 });
  g.sync(s);
  const plant = g.scoutPosition({ kind: 'plant' });
  const seen: THREE.Vector3[] = [];
  for (let t = 30; t <= 31; t += 0.05) {
    g.tick(t);
    seen.push(scoutOf(g).position.clone());
  }
  assert.ok(seen.every((p) => p.equals(home) || p.equals(plant)), 'never in between');
  assert.ok(seen.at(-1)!.equals(plant));
  g.setScoutVisible(false);
  assert.equal(scoutOf(g).visible, false);
});

test('mesh failure: an error is logged and a visible fallback marker with the name tag is shown', () => {
  const logged: string[] = [];
  const g = new TownGraph(tex, false, {
    scoutBuild: () => {
      throw new Error('broken geometry');
    },
    log: (m) => logged.push(m),
  });
  g.sync(init());
  assert.equal(g.scoutMode, 'fallback');
  assert.match(logged[0]!, /Scout figure failed to build; showing a simple marker instead/);
  const sc = scoutOf(g);
  assert.ok(sc.visible && sc.getObjectByName('scout-body') && sc.getObjectByName('scout-name'));
});
