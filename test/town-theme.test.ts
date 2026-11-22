// Day / Night: Night is the default; Day is brighter and more colourful; states keep colour + icon + text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildTownHtml } from '../src/town/html';
import { districtColors } from '../src/town/grammar';
import { initialSceneState, sceneReducer } from '../src/town/reducer';
import { DEFAULT_THEME, THEMES, isTheme, otherTheme } from '../src/town/theme';
import { STATE_VISUALS } from '../src/town/types';
import type { Building, BuildingState, SceneState, TownFileInput } from '../src/town/types';
import { TextureFactory, TownGraph, bodyColor, roofColor } from '../src/webview/town/graph';

const FILES: TownFileInput[] = Array.from({ length: 24 }, (_, i) => ({ path: `pkg/d${i % 4}/f${i}.py`, lines: 30 + i * 9, imports: [`pkg/d${(i + 1) % 4}/f${(i + 1) % 24}.py`] }));
const init = (): SceneState => sceneReducer(initialSceneState(), { type: 'init', files: FILES, at: 0 });
const tex: TextureFactory = { caption: () => ({ texture: new THREE.Texture(), aspect: 4 }), windows: () => undefined };
const hsl = (c: THREE.Color) => c.getHSL({ h: 0, s: 0, l: 0 });

test('Night is the default; the switch shows icon + text and the two themes toggle', () => {
  assert.equal(DEFAULT_THEME, 'night');
  assert.equal(otherTheme('night'), 'day');
  assert.equal(otherTheme('day'), 'night');
  assert.ok(isTheme('day') && !isTheme('noon'));
  for (const t of ['night', 'day'] as const) assert.ok(THEMES[t].icon && THEMES[t].label);
  const html = buildTownHtml({ cspSource: 'x', nonce: 'N', scriptUri: 'a.js' });
  assert.match(html, /<button id="btn-theme" type="button"[^>]*aria-label="Night view\. Switch to Day">🌙 Night<\/button>/);
  assert.equal(new TownGraph(tex).townTheme, 'night');
});

test('Day is brighter and more colourful: sunny sky to a sunset horizon, saturated rooftops, no stars', () => {
  const day = THEMES.day;
  const night = THEMES.night;
  assert.ok(hsl(new THREE.Color(day.skyTop)).l > hsl(new THREE.Color(night.skyTop)).l + 0.3, 'a bright sky');
  assert.ok(hsl(new THREE.Color(day.skyHorizon)).h < 0.15, 'warm (sunset) horizon');
  assert.equal(day.stars, false);
  assert.equal(night.stars, true);
  const b = Object.values(init().buildings).find((x) => !x.placeholder)!;
  const dayRoof = hsl(roofColor(b, 'journey', 'day'));
  const nightRoof = hsl(roofColor(b, 'journey', 'night'));
  assert.ok(dayRoof.s >= nightRoof.s && dayRoof.l > nightRoof.l, 'saturated, brighter rooftops');
  assert.ok(hsl(bodyColor(b, 'journey', 'day')).l > hsl(bodyColor(b, 'journey', 'night')).l, 'brighter idle walls');
  assert.equal(districtColors(b.district).roof.length, 7);
});

test('every state keeps the same colour (plus icon and text) in both themes', () => {
  const b = Object.values(init().buildings)[0]!;
  for (const state of Object.keys(STATE_VISUALS) as BuildingState[]) {
    if (state === 'idle') continue;
    const v = STATE_VISUALS[state];
    assert.ok(v.icon && v.label, `${state} has icon and text`);
    const touched: Building = { ...b, state, color: v.color };
    assert.equal(bodyColor(touched, 'journey', 'day').getHexString(), bodyColor(touched, 'journey', 'night').getHexString(), state);
  }
});

test('graph.setTheme recolours once: idle walls, slabs and roads change; string lights stay on; Night restores', () => {
  const g = new TownGraph(tex);
  g.sync(init());
  const mesh = g.root.getObjectByName('buildings') as THREE.InstancedMesh;
  const slabs = g.root.getObjectByName('district-slabs') as THREE.InstancedMesh;
  const roads = g.root.getObjectByName('roads') as THREE.LineSegments;
  const c = new THREE.Color();
  mesh.getColorAt(0, c);
  const nightWall = c.getHex();
  const nightSlab = (slabs.material as THREE.MeshStandardMaterial).color.getHex();
  const nightRoad = (roads.material as THREE.LineBasicMaterial).color.getHex();
  const owned = g.stats().owned;
  g.setTheme('day');
  assert.equal(g.townTheme, 'day');
  mesh.getColorAt(0, c);
  assert.notEqual(c.getHex(), nightWall);
  assert.notEqual((slabs.material as THREE.MeshStandardMaterial).color.getHex(), nightSlab);
  assert.notEqual((roads.material as THREE.LineBasicMaterial).color.getHex(), nightRoad);
  const lights = g.root.getObjectByName('string-lights')!;
  assert.ok(lights.visible && (lights as THREE.Points).geometry.getAttribute('position').count > 0, 'string lights still on');
  assert.equal(g.stats().owned, owned, 'no new resources');
  g.setTheme('night');
  mesh.getColorAt(0, c);
  assert.equal(c.getHex(), nightWall);
  g.dispose();
});
