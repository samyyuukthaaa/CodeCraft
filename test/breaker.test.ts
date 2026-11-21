import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COOLDOWN_MS, CircuitBreaker, OTHER_FAILURES_TO_OPEN, circuitOpenBanner, providerOf } from '../src/trueforge/breaker';
import type { TurnEvent } from '../src/trueforge/client';
import { AgentAttempt, runWithFailover } from '../src/trueforge/failover';
import type { TurnDriver } from '../src/trueforge/run';

const KEY = '[Model Error] Request failed (401): Invalid API Key';
const DEMAND = '[Model Error] Request failed (503): This model is currently experiencing high demand.';
const DAILY = '[Model Error] Request failed (429): ... description: Generate content requests per day limit exceeded on Free Tier.';
const TLS = '[Model Error] Cannot connect to API: certificate has expired';
const BAD = '[Model Error] Failed to parse tool call arguments: invalid JSON';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('breaker: invalid key opens for 10 min, half-opens after, success closes and reports recovered', () => {
  const c = clock();
  const b = new CircuitBreaker(c.now);
  assert.equal(b.state('p'), 'closed');
  assert.equal(b.recordFailure('p/m', KEY), 'open');
  assert.equal(b.allow('p/other-model'), false, 'the breaker is per provider');
  c.advance(COOLDOWN_MS.invalid_or_revoked_key - 1);
  assert.equal(b.state('p'), 'open');
  c.advance(1);
  assert.equal(b.state('p'), 'half_open');
  assert.equal(b.allow('p/m'), true, 'probe allowed');
  assert.equal(b.recordSuccess('p/m'), true, 'recovered');
  assert.equal(b.state('p'), 'closed');
  assert.equal(b.recordSuccess('p/m'), false, 'not recovered twice');
});

test('breaker: cooldowns per class; daily quota is long; TLS never opens; other errors open after 3 in a row', () => {
  const c = clock();
  const b = new CircuitBreaker(c.now);
  b.recordFailure('a/m', DEMAND);
  assert.equal(b.snapshot()[0]?.retryAt, c.now() + COOLDOWN_MS.unavailable_or_timeout);
  b.recordFailure('d/m', DAILY);
  assert.equal(b.snapshot().find((h) => h.provider === 'd')?.retryAt, c.now() + COOLDOWN_MS.daily_quota);
  for (let i = 0; i < 5; i++) b.recordFailure('t/m', TLS);
  assert.equal(b.state('t'), 'closed');
  for (let i = 1; i < OTHER_FAILURES_TO_OPEN; i++) assert.equal(b.recordFailure('o/m', BAD), 'closed');
  assert.equal(b.recordFailure('o/m', BAD), 'open');
  const snap = b.snapshot().find((h) => h.provider === 'o');
  assert.equal(snap?.lastErrorClass, 'bad_output');
  assert.equal(snap?.consecutiveFailures, OTHER_FAILURES_TO_OPEN);
  assert.equal(providerOf('google-gemini/gemini-3-5-flash'), 'google-gemini');
});

test('breaker: snapshot has provider, model, state, last error class and time, never anything key-like', () => {
  const c = clock();
  const b = new CircuitBreaker(c.now);
  b.recordFailure('codecraft-test-badkey/gpt-oss-120b', `${KEY} DUMMY-INVALID-KEY-FOR-CODECRAFT-TESTS`);
  const s = b.snapshot();
  assert.deepEqual(Object.keys(s[0]!).sort(), ['consecutiveFailures', 'lastErrorAt', 'lastErrorClass', 'model', 'provider', 'retryAt', 'state']);
  assert.ok(!JSON.stringify(s).includes('DUMMY-INVALID-KEY'));
  assert.match(circuitOpenBanner('p/m1', 'q/m2', s[0], c.now()), /^The primary model p\/m1 is paused after invalid or revoked key\. CodeCraft will try it again in about 10 min\. This request uses the fallback model q\/m2\.$/);
});

// ---------- integration with failover ----------
const ev = (e: unknown): TurnEvent => e as TurnEvent;
const gen = (events: TurnEvent[]) =>
  (async function* () {
    yield* events;
  })();
const errorTurn = (msg: string): TurnEvent[] => [ev({ type: 'turn.done', id: 'b', threadId: null, state: { status: 'error', message: msg } })];
const okTurn = (text: string): TurnEvent[] => [ev({ type: 'turn.done', id: 'b', threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'm', content: text }, requiredActions: [] } })];

function attempt(agent: string, model: string, turns: TurnEvent[][], created: string[]): AgentAttempt {
  let n = 0;
  const driver: TurnDriver = { start: () => gen(turns[n++] ?? []), resumePaused: () => gen([]), newTurnWithApprovals: () => gen([]) };
  return {
    agent,
    model,
    driver: async () => {
      created.push(agent);
      return driver;
    },
  };
}
const approver = { approve: async () => ({ allow: true }) };

test('failover+breaker: after an invalid key the next run skips the primary at once (no request), then probes after the cooldown and reports recovery', async () => {
  const c = clock();
  const b = new CircuitBreaker(c.now);
  const errors: string[] = [];
  const recovered: string[] = [];
  const created1: string[] = [];
  const r1 = await runWithFailover('x', [attempt('primary', 'p/m', [errorTurn(KEY)], created1), attempt('fallback', 'q/m', [okTurn('ok')], created1)], {
    approver,
    breaker: b,
    onProviderError: (e) => errors.push(`${e.agent}:${e.cls}`),
  });
  assert.equal(r1.agent, 'fallback');
  assert.deepEqual(errors, ['primary:invalid_or_revoked_key']);
  assert.equal(b.state('p'), 'open');

  const created2: string[] = [];
  const r2 = await runWithFailover('x', [attempt('primary', 'p/m', [okTurn('unused')], created2), attempt('fallback', 'q/m', [okTurn('ok')], created2)], { approver, breaker: b });
  assert.deepEqual(created2, ['fallback'], 'the open primary was not even asked');
  assert.equal(r2.switches[0]?.circuitOpen, true);

  c.advance(COOLDOWN_MS.invalid_or_revoked_key);
  const created3: string[] = [];
  const r3 = await runWithFailover('x', [attempt('primary', 'p/m', [okTurn('back')], created3), attempt('fallback', 'q/m', [okTurn('unused')], created3)], {
    approver,
    breaker: b,
    onProviderRecovered: (a, m) => recovered.push(`${a}:${m}`),
  });
  assert.equal(r3.agent, 'primary');
  assert.deepEqual(recovered, ['primary:p/m']);
  assert.equal(b.state('p'), 'closed');
});

test('failover+breaker: if every provider is open, the last one is still tried (as a probe)', async () => {
  const b = new CircuitBreaker(clock().now);
  b.recordFailure('p/m', KEY);
  b.recordFailure('q/m', KEY);
  const created: string[] = [];
  const r = await runWithFailover('x', [attempt('primary', 'p/m', [okTurn('no')], created), attempt('fallback', 'q/m', [okTurn('probe ok')], created)], { approver, breaker: b });
  assert.deepEqual(created, ['fallback']);
  assert.equal(r.outcome.status, 'done');
});
