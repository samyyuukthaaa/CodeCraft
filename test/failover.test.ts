import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TurnEvent } from '../src/trueforge/client';
import { AgentAttempt, FAILOVER_NOTE, SwitchInfo, runWithFailover } from '../src/trueforge/failover';
import type { TurnDriver } from '../src/trueforge/run';

const ev = (e: unknown): TurnEvent => e as TurnEvent;
const gen = (events: TurnEvent[]) =>
  (async function* () {
    yield* events;
  })();

const errorTurn = (msg: string): TurnEvent[] => [ev({ type: 'turn.created', id: 'a', turnId: 'T' }), ev({ type: 'turn.done', id: 'b', threadId: null, state: { status: 'error', message: msg } })];
const okTurn = (text: string): TurnEvent[] => [ev({ type: 'turn.created', id: 'a', turnId: 'T' }), ev({ type: 'turn.done', id: 'b', threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'm', content: text }, requiredActions: [] } })];

function attempt(agent: string, events: TurnEvent[], prompts: string[], created: string[]): AgentAttempt {
  const driver: TurnDriver = {
    start(text) {
      prompts.push(`${agent}:${text}`);
      return gen(events);
    },
    resumePaused: () => gen([]),
    newTurnWithApprovals: () => gen([]),
  };
  return {
    agent,
    model: `${agent}-model`,
    driver: async () => {
      created.push(agent);
      return driver;
    },
  };
}

const approver = { approve: async () => ({ allow: true }) };

test('failover: a provider error on the primary switches to the fallback, which answers', async () => {
  const prompts: string[] = [];
  const created: string[] = [];
  const switched: SwitchInfo[] = [];
  const r = await runWithFailover('do it', [attempt('primary', errorTurn('[Model Error] Request failed (400): temperature'), prompts, created), attempt('fallback', okTurn('done by fallback'), prompts, created)], {
    approver,
    onSwitch: (s) => switched.push(s),
  });
  assert.equal(r.agent, 'fallback');
  assert.deepEqual(r.outcome, { status: 'done', text: 'done by fallback', rounds: 1 });
  assert.equal(switched.length, 1);
  assert.equal(switched[0]!.from, 'primary');
  assert.match(switched[0]!.reason, /400/);
  assert.equal(prompts[0], 'primary:do it');
  assert.equal(prompts[1], `fallback:do it\n\n${FAILOVER_NOTE}`);
});

test('failover: the fallback session is created only when needed', async () => {
  const created: string[] = [];
  const r = await runWithFailover('x', [attempt('primary', okTurn('fine'), [], created), attempt('fallback', okTurn('unused'), [], created)], { approver });
  assert.equal(r.agent, 'primary');
  assert.deepEqual(created, ['primary']);
  assert.equal(r.switches.length, 0);
});

test('failover: if every agent fails, the last error is reported (never success)', async () => {
  const r = await runWithFailover('x', [attempt('primary', errorTurn('[Model Error] Request failed (503)'), [], []), attempt('fallback', errorTurn('[Model Error] Request failed (500)'), [], [])], { approver });
  assert.equal(r.outcome.status, 'error');
  assert.equal(r.agent, 'fallback');
  assert.match((r.outcome as { message: string }).message, /500/);
});

test('failover: a thrown session/network error also fails over', async () => {
  const boom: AgentAttempt = {
    agent: 'primary',
    model: 'm',
    driver: async () => {
      throw new Error('TrueForge HTTP 503: unavailable');
    },
  };
  const r = await runWithFailover('x', [boom, attempt('fallback', okTurn('ok'), [], [])], { approver });
  assert.equal(r.agent, 'fallback');
  assert.equal(r.outcome.status, 'done');
});

test('failover: cancelled (Stop Run) does not fail over', async () => {
  const created: string[] = [];
  const ac = new AbortController();
  ac.abort();
  const r = await runWithFailover('x', [attempt('primary', okTurn('a'), [], created), attempt('fallback', okTurn('b'), [], created)], { approver, signal: ac.signal });
  assert.equal(r.outcome.status, 'cancelled');
  assert.deepEqual(created, ['primary']);
});
