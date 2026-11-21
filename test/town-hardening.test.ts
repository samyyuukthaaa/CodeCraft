// Code Town step 6: reduced motion, clean shutdown, and the task2 record used for the frame-rate/memory check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { Journal, MemorySink } from '../src/journal/journal';
import { buildTownHtml } from '../src/town/html';
import { foldEvents, initialSceneState, sceneReducer } from '../src/town/reducer';
import { TextureFactory, TownGraph } from '../src/webview/town/graph';
import { eventsFromRecord } from './scenarios/town-perf';

test('reduced motion: the setting reaches the page (auto by default)', () => {
  const base = { cspSource: 'x', nonce: 'N', scriptUri: 'a.js' };
  assert.match(buildTownHtml(base), /<body data-reduced-motion="auto">/);
  assert.match(buildTownHtml({ ...base, reducedMotion: 'on' }), /<body data-reduced-motion="on">/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { configuration: { properties: Record<string, { enum?: string[]; default?: string }> } } };
  const s = pkg.contributes.configuration.properties['codecraft.townReducedMotion']!;
  assert.deepEqual([s.enum, s.default], [['auto', 'on', 'off'], 'auto']);
});

test('reduced motion: nothing animates, animated values rest; switching it on at runtime settles them', () => {
  const tex: TextureFactory = { caption: () => ({ texture: new THREE.Texture(), aspect: 3 }), windows: () => undefined };
  const g = new TownGraph(tex, false);
  let s = sceneReducer(initialSceneState(), { type: 'init', files: [{ path: 'a/x.py', lines: 50 }, { path: 'b/y.py', lines: 50, imports: ['a/x.py'] }], at: 0 });
  s = sceneReducer(s, { type: 'file_read', path: 'a/x.py', at: 1 });
  g.sync(s);
  const lights = g.root.getObjectByName('string-lights') as THREE.Points;
  const shaft = g.root.getObjectByName('light-shaft') as THREE.Mesh;
  g.tick(1.3);
  const moving = (lights.material as THREE.PointsMaterial).opacity;
  g.tick(2.9);
  assert.notEqual((lights.material as THREE.PointsMaterial).opacity, moving, 'animates normally');
  g.setReducedMotion(true);
  assert.equal((lights.material as THREE.PointsMaterial).opacity, 0.75);
  assert.equal((shaft.material as THREE.MeshBasicMaterial).opacity, 0.13);
  g.tick(5.5);
  g.tick(9.1);
  assert.equal((lights.material as THREE.PointsMaterial).opacity, 0.75, 'no animation with reduced motion');
});

test('clean shutdown: journal listeners are counted and removed', () => {
  const j = new Journal(new MemorySink());
  const off1 = j.onAppend(() => undefined);
  const off2 = j.onAppend(() => undefined);
  assert.equal(j.listenerCount, 2);
  off1();
  off2();
  off2();
  assert.equal(j.listenerCount, 0);
});

test('performance check input: the recorded task2 run becomes the same kinds of town events a live run produces', () => {
  const rec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'results', 'task2-2026-11-21T12-28-18-245Z.json'), 'utf8'))[0];
  const evs = eventsFromRecord(rec, 0);
  const count = (t: string) => evs.filter((e) => e.type === t).length;
  assert.equal(count('file_read'), 28, 'one per read_file line of the record');
  assert.equal(count('file_planned'), 3);
  assert.equal(count('hunk_proposed'), 4);
  assert.equal(count('file_written'), 4);
  assert.equal(count('test_run'), 3);
  assert.equal(evs.filter((e) => e.type === 'provider' && e.status === 'retrying').length, 5);
  assert.equal(evs.filter((e) => e.type === 'provider' && e.status === 'failed_over').length, 1);
  const files = ['src/flask/cli.py', 'docs/cli.rst', 'tests/test_cli.py'].map((p) => ({ path: p, lines: 100 }));
  const end = foldEvents(sceneReducer(initialSceneState(), { type: 'init', files, at: 0 }), evs);
  assert.deepEqual([end.buildings['src/flask/cli.py']!.state, end.buildings['src/flask/cli.py']!.testStatus], ['applied', 'failed'], 'the recorded run ended with a failing test');
  assert.equal(end.power.status, 'failed_over');
});
