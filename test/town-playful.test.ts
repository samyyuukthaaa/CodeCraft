// A more playful night: saturated districts, more string lights and lanterns, confetti on an applied change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DISTRICT_PALETTE } from '../src/town/grammar';
import { initialSceneState, sceneReducer } from '../src/town/reducer';
import type { SceneState, TownFileInput } from '../src/town/types';
import { BULB_SPACING, LANTERNS_PER_BUILDING, TextureFactory, TownGraph, bodyColor } from '../src/webview/town/graph';
import { CONFETTI_LIFE_S, PER_BURST } from '../src/webview/town/confetti';

const FILES: TownFileInput[] = Array.from({ length: 24 }, (_, i) => ({ path: `pkg/d${i % 4}/f${i}.py`, lines: 30 + i * 9, imports: [`pkg/d${(i + 1) % 4}/f${(i + 1) % 24}.py`] }));
const init = (): SceneState => sceneReducer(initialSceneState(), { type: 'init', files: FILES, at: 0 });
const tex: TextureFactory = { caption: () => ({ texture: new THREE.Texture(), aspect: 4 }), windows: () => undefined };
const ID = 'pkg/d1/f5.py';
const apply = (s: SceneState): SceneState => {
  s = sceneReducer(s, { type: 'run_started', runId: 'r', at: 1 });
  return sceneReducer(s, { type: 'file_written', path: ID, at: 3 } as never);
};

test('night districts are more saturated than the base palette', () => {
  const s = init();
  for (const b of Object.values(s.buildings).filter((x) => !x.placeholder).slice(0, 8)) {
    const night = bodyColor(b, 'journey', 'night').getHSL({ h: 0, s: 0, l: 0 });
    const entry = DISTRICT_PALETTE.find((p) => p.wall)!;
    assert.ok(night.s > 0.3, `${b.id} is colourful (s=${night.s.toFixed(2)}, base e.g. ${entry.name})`);
  }
});

test('more string lights (denser along roads, plus a garland per district) and 5 lanterns per success', () => {
  const g = new TownGraph(tex);
  const s = init();
  g.sync(s);
  const bulbs = (g.root.getObjectByName('string-lights') as THREE.Points).geometry.getAttribute('position').count;
  assert.ok(BULB_SPACING < 2.5, 'denser than before');
  assert.ok(bulbs >= Object.keys(s.districts).length * 5, `garlands present (${bulbs} bulbs)`);
  assert.equal(LANTERNS_PER_BUILDING, 5);
  g.dispose();
});

test('confetti: an applied change bursts, falls, and is gone after its life; written in place, deterministic', () => {
  const run = () => {
    const g = new TownGraph(tex);
    let s = init();
    g.sync(s);
    g.tick(10);
    const pts = g.root.getObjectByName('confetti') as THREE.Points;
    const buf = pts.geometry.getAttribute('position').array;
    assert.equal(pts.visible, false, 'hidden until a success');
    s = apply(s);
    g.sync(s);
    assert.equal(s.buildings[ID]!.state, 'applied');
    assert.equal(g.confettiActive, PER_BURST);
    assert.ok(pts.visible);
    const owned = g.stats().owned;
    g.tick(10.4);
    const y = pts.geometry.getAttribute('position').getY(0);
    assert.ok(y > 0 && y < 100, `in flight (y=${y})`);
    assert.equal(pts.geometry.getAttribute('position').array, buf, 'same buffer: written in place');
    const mid = Array.from(buf as Float32Array);
    g.tick(10 + CONFETTI_LIFE_S + 0.1);
    assert.equal(g.confettiActive, 0);
    assert.equal(pts.visible, false);
    assert.equal(g.stats().owned, owned, 'no new resources while animating');
    // the same applied state again (another event) does not burst again
    g.sync(sceneReducer(s, { type: 'file_read', path: 'pkg/d0/f0.py', at: 4 }));
    assert.equal(g.confettiActive, 0);
    g.dispose();
    return mid;
  };
  assert.deepEqual(run(), run(), 'the same burst every time (no randomness)');
});

test('confetti: none with reduced motion, none in Architecture, none when a town is rebuilt from the journal', () => {
  const rm = new TownGraph(tex, true);
  const srm = init();
  rm.sync(srm);
  rm.sync(apply(srm));
  assert.equal(rm.confettiActive, 0, 'reduced motion');
  const arch = new TownGraph(tex);
  const sarch = init();
  arch.sync(sarch);
  arch.setMode('architecture');
  arch.sync(apply(sarch));
  assert.equal(arch.confettiActive, 0, 'architecture');
  const reload = new TownGraph(tex);
  reload.sync(apply(init()));
  assert.equal(reload.confettiActive, 0, 'a reload does not replay celebrations');
  const on = new TownGraph(tex);
  const son = init();
  on.sync(son);
  on.sync(apply(son));
  assert.equal(on.confettiActive, PER_BURST);
  on.setReducedMotion(true);
  assert.equal(on.confettiActive, 0, 'switching reduced motion on ends bursts');
});
