// Ask Scout speech bubble: pause and resume, truncation and Show more, replace on a new question, close/Esc,
// 2D parity, mute and reduced motion. Renderer state only: never in the reducer, the journal or a replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as THREE from 'three';
import { answerKeywords, askScout } from '../src/town/help';
import { buildTownHtml } from '../src/town/html';
import { layoutScene } from '../src/town/layout';
import { crossesDistrict } from '../src/town/patrol';
import { foldEvents, initialSceneState, sceneReducer } from '../src/town/reducer';
import { SHORT_MAX_CHARS, ScoutTalk, TALK_IDLE_S, highlight, sentences, shortAnswer } from '../src/town/talk';
import type { SceneState, TownEvent, TownFileInput } from '../src/town/types';
import { TextureFactory, TownGraph } from '../src/webview/town/graph';

const FILES: TownFileInput[] = Array.from({ length: 60 }, (_, i) => ({ path: `pkg/d${i % 6}/f${String(i).padStart(3, '0')}.py`, lines: 20 + ((i * 37) % 400) }));
const init = (): SceneState => sceneReducer(initialSceneState(), { type: 'init', files: FILES, at: 0 });
const tex: TextureFactory = { caption: () => ({ texture: new THREE.Texture(), aspect: 4 }), windows: () => undefined };
const scoutOf = (g: TownGraph) => g.root.getObjectByName('scout')!;
const bodyOf = (g: TownGraph) => g.root.getObjectByName('scout-body')!;
const LONG = 'One. Two is here. Three is short. Four goes on. Five ends it.';

/** Ticks the graph from t0 to t1 at 30 fps; returns the last time. */
function run(g: TownGraph, t0: number, t1: number): number {
  let t = t0;
  for (; t <= t1; t += 1 / 30) g.tick(t);
  return t;
}

test('bubble text: the first 2 to 3 sentences, "Show more" only when there is more; one yellow keyword', () => {
  assert.deepEqual(sentences('Hi. How are you? Fine!'), ['Hi.', 'How are you?', 'Fine!']);
  assert.deepEqual(shortAnswer(LONG), { short: 'One. Two is here. Three is short.', truncated: true });
  const longThird = `First. Second. ${'x'.repeat(SHORT_MAX_CHARS)}. Fourth.`;
  assert.deepEqual(shortAnswer(longThird), { short: 'First. Second.', truncated: true }, 'a third sentence only if it fits');
  assert.deepEqual(shortAnswer('Just one.'), { short: 'Just one.', truncated: false });
  const parts = highlight('Each building has a colour; colours repeat.', ['colour', 'building']);
  assert.deepEqual(parts.filter((p) => p.yellow), [{ text: 'colour', yellow: true }], 'one keyword, whole word, first listed match');
  assert.equal(parts.map((p) => p.text).join(''), 'Each building has a colour; colours repeat.');
  const a = askScout('What do the building colours mean?');
  assert.ok(highlight(a.answer, answerKeywords(a.topic)).some((p) => p.yellow), 'real answers get a keyword');
});

test('talk: answers at once when Scout stands still; waits for a target walk to end; replaced by a new question', () => {
  const t = new ScoutTalk();
  assert.equal(t.ask('q1', LONG, [], 10, false), 'talking');
  assert.ok(t.open && t.pausesPatrol);
  t.expand(11);
  assert.equal(t.view!.expanded, true);
  // a new question replaces the bubble (and collapses it again)
  t.ask('q2', 'Short answer.', [], 12, false);
  assert.equal(t.view!.question, 'q2');
  assert.equal(t.view!.expanded, false);
  assert.equal(t.view!.truncated, false);
  // asked while walking to a target: waits, then shows when the walk ends
  const w = new ScoutTalk();
  assert.equal(w.ask('q', LONG, [], 0, true), 'waiting');
  assert.ok(!w.open && w.pausesPatrol);
  assert.equal(w.tick(1, true), undefined);
  assert.equal(w.tick(2, false), 'show');
  assert.ok(w.open);
});

test('talk: closes after about 20 s of quiet (Show more counts as activity), on close/Esc, and resumes', () => {
  const t = new ScoutTalk();
  t.ask('q', LONG, [], 100, false);
  assert.equal(t.tick(100 + TALK_IDLE_S - 1, false), undefined);
  t.expand(100 + TALK_IDLE_S - 1);
  assert.equal(t.tick(100 + TALK_IDLE_S + 5, false), undefined, 'Show more restarted the quiet time');
  assert.equal(t.tick(100 + 2 * TALK_IDLE_S, false), 'close');
  assert.ok(!t.open && !t.pausesPatrol && !t.view);
  t.ask('q', LONG, [], 200, false);
  assert.equal(t.close(), true, 'close button / Esc');
  assert.equal(t.close(), false);
});

test('pause: a question stops the patrol at once; he stays still while talking; release continues on the streets', () => {
  const g = new TownGraph(tex);
  const s = init();
  g.sync(s);
  let t = run(g, 0, 6); // the patrol has started
  assert.ok(g.animating && !g.walkingToTarget, 'patrolling');
  g.holdScout(true);
  g.setTalking(true, 0, 200);
  const at = scoutOf(g).position.clone();
  t = run(g, t, t + 30);
  assert.ok(scoutOf(g).position.distanceTo(at) < 1e-9, 'stood still for 30 s');
  assert.ok(g.scoutTalking);
  g.holdScout(false);
  assert.ok(!g.scoutTalking);
  const L = layoutScene(s);
  let prev = { x: scoutOf(g).position.x, z: scoutOf(g).position.z };
  let moved = false;
  for (const end = t + 20; t < end; t += 1 / 30) {
    g.tick(t);
    const p = { x: scoutOf(g).position.x, z: scoutOf(g).position.z };
    assert.equal(crossesDistrict(L, prev, p), false, `still on the streets ${JSON.stringify(p)}`);
    moved ||= Math.hypot(p.x - at.x, p.z - at.z) > 1;
    prev = p;
  }
  assert.ok(moved, 'the patrol resumed');
});

test('during a run: a question waits for the target walk; agent moves wait while he talks and he says where he goes next', () => {
  const g = new TownGraph(tex);
  let s = init();
  g.sync(s);
  run(g, 0, 1);
  s = sceneReducer(s, { type: 'run_started', runId: 'r', at: 1 });
  s = sceneReducer(s, { type: 'file_read', path: 'pkg/d1/f001.py', at: 2 } as TownEvent);
  g.sync(s);
  let t = run(g, 1, 1.1);
  assert.ok(g.walkingToTarget, 'walking to the agent file');
  const talk = new ScoutTalk();
  g.holdScout(true);
  assert.equal(talk.ask('q', LONG, [], t, g.walkingToTarget), 'waiting');
  assert.ok(g.walkingToTarget, 'the target walk is not cut short');
  while (g.walkingToTarget && t < 60) {
    g.tick(t);
    t += 1 / 30;
  }
  assert.equal(talk.tick(t, g.walkingToTarget), 'show', 'answers once he arrived');
  g.setTalking(true, 0, 100);
  const at = scoutOf(g).position.clone();
  // the agent reads another file while he talks: the town updates, Scout waits and tells the user
  const s2 = sceneReducer(s, { type: 'file_read', path: 'pkg/d4/f010.py', at: 3 } as TownEvent);
  g.sync(s2);
  assert.equal(s2.buildings['pkg/d4/f010.py']!.state, 'read', 'the town still updates');
  assert.equal(g.pendingTarget, 'f010.py');
  t = run(g, t, t + 5);
  assert.ok(scoutOf(g).position.distanceTo(at) < 1e-9, 'stays put while talking');
  g.holdScout(false);
  assert.equal(g.pendingTarget, undefined);
  t = run(g, t, t + 0.2);
  assert.ok(g.walkingToTarget, 'then walks to the waiting target');
});

test('talking animation and facing: a small talk bob with motion, static with reduced motion; turns to the camera', () => {
  const g = new TownGraph(tex);
  g.sync(init());
  g.holdScout(true);
  g.setTalking(true, 0, 500);
  const scales = new Set<number>();
  for (let t = 0; t < 1; t += 0.05) {
    g.tick(t);
    scales.add(Math.round(bodyOf(g).scale.y * 1000));
  }
  assert.ok(scales.size > 3, 'talks');
  const p = scoutOf(g).position;
  assert.ok(Math.abs(bodyOf(g).rotation.y - Math.atan2(0 - p.x, 500 - p.z)) < 1e-9, 'faces the camera');
  const rm = new TownGraph(tex, true);
  rm.sync(init());
  rm.holdScout(true);
  rm.setTalking(true, 0, 500);
  for (let t = 0; t < 1; t += 0.05) {
    rm.tick(t);
    assert.equal(bodyOf(rm).scale.y, 1, 'static with reduced motion');
  }
  rm.holdScout(false);
  assert.equal(bodyOf(rm).scale.y, 1);
});

test('cosmetic and deterministic: pausing and talking never touch the scene state; replays fold the same', () => {
  const events: TownEvent[] = [
    { type: 'run_started', runId: 'r', at: 1 },
    { type: 'file_read', path: 'pkg/d1/f001.py', at: 2 } as TownEvent,
    { type: 'file_read', path: 'pkg/d2/f002.py', at: 3 } as TownEvent,
  ];
  const plain = foldEvents(init(), events);
  const g = new TownGraph(tex);
  let s = init();
  g.sync(s);
  g.holdScout(true);
  g.setTalking(true, 0, 0);
  for (const e of events) {
    const before = JSON.stringify(s);
    const next = sceneReducer(s, e);
    g.sync(next);
    assert.equal(JSON.stringify(s), before, 'the graph never changes the scene');
    s = next;
  }
  g.holdScout(false);
  assert.deepEqual(s, plain, 'same scene as without any question');
  for (const f of ['src/town/talk.ts', 'src/town/reducer.ts', 'src/town/fromJournal.ts']) {
    const src = fs.readFileSync(f, 'utf8');
    if (f.endsWith('talk.ts')) assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\/|Math\.random|Date\.now|from ['"](vscode|three|node:)/, 'talk.ts is pure');
    else assert.doesNotMatch(src, /ScoutTalk|holdScout|talk_/, `${f} knows nothing about the bubble`);
  }
});

test('html: the bubble (close, Show more), 2D placement above the docked Scout, mute hides it; camera setting', () => {
  const html = buildTownHtml({ cspSource: 'x', nonce: 'N', scriptUri: 'a.js' });
  assert.match(html, /<div id="scout-talk" class="hidden" role="group"/);
  assert.match(html, /<button id="talk-close" type="button" aria-label="Close Scout's answer \(Esc\)">/);
  assert.match(html, /<button id="talk-more" type="button" class="hidden">Show more<\/button>/);
  assert.match(html, /#scout-talk\.expanded \.talk-text \{ max-height: min\(38vh, 260px\); overflow-y: auto;/, 'scrollable, never the whole town');
  assert.match(html, /body\.flat #scout-talk \{ left: 12px; top: auto; bottom: 96px; transform: none; \}/, '2D: above the docked Scout');
  assert.match(html, /body\.scout-muted #scout-talk, body\.scout-muted #tip/, 'muted: no bubble');
  assert.match(html, /<div id="ask-answer" role="status" aria-live="polite">/, 'the full answer stays in the panel for screen readers');
  assert.match(html, /data-ask-camera="on"/);
  assert.match(buildTownHtml({ cspSource: 'x', nonce: 'N', scriptUri: 'a.js', askCamera: false }), /data-ask-camera="off"/);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { contributes: { configuration: { properties: Record<string, { default: unknown }> } } };
  assert.equal(pkg.contributes.configuration.properties['codecraft.scoutAskCamera']!.default, true);
});
