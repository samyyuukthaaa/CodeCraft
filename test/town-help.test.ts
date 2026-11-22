// Ask Scout (codetown-scout step 2): built-in help with keyword/intent matching, live state, honest "I don't know",
// context tips, the mute setting, and the guarantee that no network or model call is ever made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MIN_SCORE, SUGGESTED, TOPICS, UNKNOWN_ANSWER, answerKeywords, askScout, tipFor } from '../src/town/help';
import { ScoutTalk } from '../src/town/talk';
import { buildTownHtml } from '../src/town/html';
import { foldEvents, initialSceneState, sceneReducer } from '../src/town/reducer';
import type { SceneState } from '../src/town/types';

const scene = (): SceneState => sceneReducer(initialSceneState(), { type: 'init', files: [{ path: 'src/flask/cli.py', lines: 100 }, { path: 'tests/test_cli.py', lines: 50, isTest: true }], at: 0 });

test('help: every required subject is answered from the right topic', () => {
  const cases: Array<[string, string]> = [
    ['what does a green building mean?', 'colours'],
    ['what do the colours mean', 'colours'],
    ['how do I accept or reject a hunk?', 'review'],
    ['how to review the diff', 'review'],
    ['how can I undo that', 'undo'],
    ['roll back to a checkpoint please', 'undo'],
    ['how do I stop a run', 'stop'],
    ['cancel the agent', 'stop'],
    ['what happens on failover?', 'failover'],
    ['the provider hit a rate limit, what now', 'failover'],
    ['how do I switch models', 'models'],
    ['change the primary model', 'models'],
    ['how do I run the three tasks', 'tasks'],
    ['run task2', 'tasks'],
    ['what does journey mode do', 'modes'],
    ['what is architecture and replay', 'modes'],
    ['what does the cost panel show', 'cost'],
    ['how many tokens did it use', 'cost'],
    ['can I mute scout', 'scout'],
    ['what is happening now', 'now'],
    ['what does risky confidence mean', 'tests'],
  ];
  for (const [q, want] of cases) assert.equal(askScout(q, scene()).topic, want, q);
  for (const t of TOPICS) assert.equal(askScout(t.question).topic, t.id, `suggested question "${t.question}"`);
});

test('help: says plainly when it does not know, and points to the README', () => {
  for (const q of ['', '   ', 'what is the weather in Chennai', 'banana', 'tell me a joke']) {
    const r = askScout(q, scene());
    assert.equal(r.topic, undefined, q);
    assert.equal(r.answer, UNKNOWN_ANSWER);
    assert.match(r.answer, /don't know.*README/);
    assert.deepEqual(r.suggestions, SUGGESTED);
  }
  assert.ok(MIN_SCORE >= 2, 'a single stray word is not enough');
});

test('help: answers use the live town state', () => {
  let s = scene();
  s = sceneReducer(s, { type: 'file_read', path: 'src/flask/cli.py', at: 1 });
  s = sceneReducer(s, { type: 'provider', status: 'failed_over', model: 'g/backup', detail: 'from g/a (rate limit)', at: 2 });
  assert.match(askScout('what do the colours mean', s).answer, /Right now: 1 read\./);
  assert.match(askScout('how does failover work', s).answer, /Right now it is failed over \(g\/backup\)\./);
  assert.match(askScout('what is happening now', s).answer, /^The main model stopped because it hit its rate limit/);
  assert.ok(askScout('how do I undo', s).suggestions.length > 0);
});

test('help: no network, no model, no editor: nothing is fetched or called while answering (bubble included)', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest, WebSocket: g.WebSocket };
  const calls: string[] = [];
  g.fetch = () => {
    calls.push('fetch');
    throw new Error('network');
  };
  g.XMLHttpRequest = function () {
    calls.push('xhr');
  };
  g.WebSocket = function () {
    calls.push('ws');
  };
  try {
    const s = foldEvents(scene(), [{ type: 'run_started', runId: 'r', at: 1 }, { type: 'file_read', path: 'src/flask/cli.py', at: 2 }]);
    const talk = new ScoutTalk();
    let now = 0;
    for (const q of [...TOPICS.map((t) => t.question), 'random question', 'how do I undo']) {
      const r = askScout(q, s);
      // the speech bubble too: ask, Show more, wait, close
      talk.ask(q, r.answer, answerKeywords(r.topic), (now += 1), false);
      talk.expand(now);
      talk.tick((now += 30), false);
      talk.close();
    }
    assert.deepEqual(calls, []);
  } finally {
    Object.assign(g, saved);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'town', 'help.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\/|from ['"](vscode|three|node:|.*trueforge)/, 'the help module cannot reach a network, VS Code or a model');
  const talkSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'town', 'talk.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(talkSrc, /\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\/|from ['"]/, 'the bubble module imports nothing and cannot reach a network or a model');
  // and the webview page itself may not connect anywhere (CSP default-src 'none', no connect-src)
  const html = buildTownHtml({ cspSource: 'x', nonce: 'N', scriptUri: 'a.js' });
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /connect-src/);
});

test('tips: failover, recovery, the first review and a failing test; nothing otherwise', () => {
  const s0 = scene();
  const fo = sceneReducer(s0, { type: 'provider', status: 'failed_over', at: 1 });
  assert.equal(tipFor(s0, fo)?.id, 'failover');
  assert.equal(tipFor(fo, sceneReducer(fo, { type: 'provider', status: 'failed_over', at: 2 })), undefined, 'not repeated while still failed over');
  assert.equal(tipFor(fo, sceneReducer(fo, { type: 'provider', status: 'recovered', at: 3 }))?.id, 'recovered');
  assert.equal(tipFor(s0, sceneReducer(s0, { type: 'hunk_proposed', path: 'src/flask/cli.py', intent: 'i', hunks: 1, at: 4 }))?.id, 'first-review');
  assert.equal(tipFor(s0, sceneReducer(s0, { type: 'file_failed', path: 'tests/test_cli.py', reason: 'x', at: 5 }))?.id, 'failing');
  assert.equal(tipFor(s0, sceneReducer(s0, { type: 'file_read', path: 'src/flask/cli.py', at: 6 })), undefined);
  assert.equal(tipFor(undefined, s0), undefined);
});

test('mute setting: contributed, defaults to on, and reaches the page', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { configuration: { properties: Record<string, { enum?: string[]; default?: string }> } } };
  const s = pkg.contributes.configuration.properties['codecraft.scout']!;
  assert.deepEqual([s.enum, s.default], [['on', 'muted'], 'on']);
  const base = { cspSource: 'x', nonce: 'N', scriptUri: 'a.js' };
  assert.match(buildTownHtml(base), /data-scout="on"/);
  assert.match(buildTownHtml({ ...base, scout: 'muted' }), /data-scout="muted"/);
  assert.match(buildTownHtml(base), /body\.scout-muted #tip, body\.scout-muted #scout-dock, body\.scout-muted \.scout-ctl[^{]*\{ display: none !important; \}/);
  assert.match(buildTownHtml(base), /id="ask"[^>]*aria-label="Ask Scout"/);
});

test('2D companion: Scout is docked on screen in the 2D view and the no-WebGL fallback, above every panel; muting hides it', () => {
  const html = buildTownHtml({ cspSource: 'x', nonce: 'N', scriptUri: 'a.js' });
  assert.match(html, /<div id="scout-dock" role="status" aria-live="polite" aria-label="Scout">/);
  assert.match(html, /id="scout-dock-text"/);
  assert.match(html, /body\.flat #scout-dock \{ display: flex; \}/);
  assert.match(html, /#scout-dock \{ position: absolute; left: 12px; bottom: 12px; z-index: 30;/, 'above the panels (z-index 30 > 13)');
  assert.match(html, /body\.reduced-motion \.scout-sprite \{ animation: none; \}/);
  assert.match(html, /body\.scout-muted #tip, body\.scout-muted #scout-dock, body\.scout-muted \.scout-ctl[^{]*\{ display: none !important; \}/);
  assert.doesNotMatch(html, /\sstyle="/);
});
