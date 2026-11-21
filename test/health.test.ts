import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/trueforge/breaker';
import { healthRows, probeProviders } from '../src/trueforge/health';
import { parseWebviewMessage } from '../src/panel/protocol';
import { buildHtml } from '../src/panel/html';

const KEY = '[Model Error] Request failed (401): Invalid API Key';
const CONFIGURED = [
  { role: 'primary', model: 'p/m1', agent: 'codecraft-primary' },
  { role: 'fallback', model: 'q/m2', agent: 'codecraft-fallback' },
];

test('health rows: unknown before use; paused after an invalid key, with class, times and no key material', () => {
  let now = Date.UTC(2026, 10, 21, 12, 0, 0);
  const b = new CircuitBreaker(() => now);
  assert.deepEqual(healthRows(b, CONFIGURED).map((r) => `${r.role}:${r.status}`), ['primary:unknown', 'fallback:unknown']);
  b.recordFailure('p/m1', `${KEY} DUMMY-INVALID-KEY-FOR-CODECRAFT-TESTS`);
  b.recordSuccess('q/m2');
  const rows = healthRows(b, CONFIGURED);
  assert.deepEqual(rows[0], { role: 'primary', model: 'p/m1', provider: 'p', status: 'paused', lastErrorClass: 'invalid_or_revoked_key', lastErrorAt: '2026-11-21T12:00:00.000Z', retryAt: '2026-11-21T12:10:00.000Z' });
  assert.equal(rows[1]?.status, 'healthy');
  assert.ok(!JSON.stringify(rows).includes('DUMMY-INVALID-KEY'));
  now += 10 * 60_000;
  assert.equal(healthRows(b, CONFIGURED)[0]?.status, 'probe-pending');
});

test('probeProviders: updates the breaker, reports recovery, returns error class only', async () => {
  let now = 0;
  const b = new CircuitBreaker(() => now);
  b.recordFailure('p/m1', KEY);
  now += 10 * 60_000;
  const calls: string[] = [];
  const r = await probeProviders(b, CONFIGURED, async (agent) => {
    calls.push(agent);
    return agent === 'codecraft-fallback' ? '[Model Error] Request failed (503): high demand at https://x?key=SECRET' : undefined;
  });
  assert.deepEqual(calls, ['codecraft-primary', 'codecraft-fallback']);
  assert.deepEqual(r, [
    { role: 'primary', model: 'p/m1', ok: true, recovered: true },
    { role: 'fallback', model: 'q/m2', ok: false, errorClass: 'unavailable_or_timeout' },
  ]);
  assert.equal(b.state('p'), 'closed');
  assert.equal(b.state('q'), 'open');
  const thrown = await probeProviders(new CircuitBreaker(), [CONFIGURED[0]!], async () => {
    throw new Error('TrueForge HTTP 401: Invalid API Key');
  });
  assert.equal(thrown[0]?.errorClass, 'invalid_or_revoked_key');
});

test('panel: health section and Test providers button exist; only {type:"testProviders"} is accepted', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', nonce: 'N', scriptUri: 'vscode-resource:/w.js' });
  assert.match(html, /id="health"/);
  assert.match(html, /id="test-providers"[^>]*>Test providers</);
  assert.deepEqual(parseWebviewMessage({ type: 'testProviders' }), { type: 'testProviders' });
  assert.equal(parseWebviewMessage({ type: 'testProviders', agent: 'x' }), undefined, 'no extra fields');
});
