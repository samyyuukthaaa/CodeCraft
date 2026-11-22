// Find Scout, Follow Scout and Reset View (camera only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SCOUT_VIEW_OFFSET, flightStep, flightTo, followStep, framing } from '../src/webview/town/camera';
import { buildTownHtml } from '../src/town/html';

test('Find Scout: the flight ends exactly at a close view of Scout; with reduced motion it is a jump', () => {
  const pos = new THREE.Vector3(0, 100, 120);
  const target = new THREE.Vector3(0, 0, 0);
  const scout = new THREE.Vector3(-31, 0, 5);
  const f = flightTo(pos, target, scout, 10);
  assert.equal(flightStep(f, 10.4, pos, target), true, 'mid-flight');
  assert.ok(pos.y < 100 && pos.y > 20);
  assert.equal(flightStep(f, 11, pos, target), false, 'done');
  assert.deepEqual(target.toArray(), [-31, 2, 5]);
  assert.deepEqual(pos.toArray(), new THREE.Vector3(-31, 2, 5).add(SCOUT_VIEW_OFFSET).toArray());
  const p2 = new THREE.Vector3(0, 100, 120);
  const t2 = new THREE.Vector3();
  assert.equal(flightStep(flightTo(p2, t2, scout, 0, 0), 0, p2, t2), false, 'duration 0 = jump');
  assert.deepEqual(t2.toArray(), [-31, 2, 5]);
});

test('Follow Scout: the target eases towards him and the viewing offset is kept; alpha 1 snaps', () => {
  const pos = new THREE.Vector3(10, 30, 40);
  const target = new THREE.Vector3(0, 2, 0);
  const offset = pos.clone().sub(target);
  const scout = new THREE.Vector3(20, 0, -10);
  for (let i = 0; i < 200; i++) followStep(pos, target, scout, 0.08);
  assert.ok(target.distanceTo(new THREE.Vector3(20, 2, -10)) < 1e-3, 'converges on Scout');
  assert.ok(pos.clone().sub(target).distanceTo(offset) < 1e-9, 'same viewing offset');
  followStep(pos, target, new THREE.Vector3(-5, 0, 7), 1);
  assert.deepEqual(target.toArray(), [-5, 2, 7]);
});

test('Reset View keeps Scout in frame, even on a side street outside the town bounds', () => {
  const b = { minX: -50, maxX: 50, minZ: -40, maxZ: 40 };
  const inside = framing(b, new THREE.Vector3(0, 0, 0));
  const outside = framing(b, new THREE.Vector3(-70, 0, 60));
  assert.ok(outside.target.x < inside.target.x && outside.target.z > inside.target.z, 'the frame widens towards Scout');
  assert.ok(outside.pos.y > inside.pos.y, 'and pulls back to fit');
});

test('controls: Find Scout and Follow Scout (off by default); hidden in 2D and when Scout is muted', () => {
  const html = buildTownHtml({ cspSource: 'x', nonce: 'N', scriptUri: 'a.js' });
  assert.match(html, /<button id="btn-find-scout" class="scout-ctl" type="button"[^>]*>🏮 Find Scout<\/button>/);
  assert.match(html, /<button id="btn-follow-scout" class="scout-ctl" type="button" aria-pressed="false"/);
  assert.match(html, /body\.scout-muted \.scout-ctl, body\.flat \.scout-ctl \{ display: none !important; \}/);
});
