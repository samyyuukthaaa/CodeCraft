import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TurnEvent } from '../src/trueforge/client';
import { AgentAttempt, CONTINUE_PROMPT, FAILOVER_NOTE, SwitchInfo, runWithFailover } from '../src/trueforge/failover';
import { MAX_RATE_LIMIT_WAITS, MAX_RETRIES, RETRY_BUDGET, retryAfterMs, retryDelayMs } from '../src/trueforge/errors';
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
  const r = await runWithFailover('x', [attempt('primary', errorTurn('[Model Error] Request failed (503)'), [], []), attempt('fallback', errorTurn('[Model Error] Request failed (500)'), [], [])], { approver, delay: async () => undefined });
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
  const r = await runWithFailover('x', [boom, attempt('fallback', okTurn('ok'), [], [])], { approver, delay: async () => undefined });
  assert.equal(r.agent, 'fallback');
  assert.equal(r.outcome.status, 'done');
});

// ---------- retries (texts observed live) ----------
const RATE = '[Model Error] Request failed (429): You exceeded your current quota ... Please retry in 59.382723513s.';
const DEMAND = '[Model Error] Request failed (503): This model is currently experiencing high demand.';
const KEY = '[Model Error] Request failed (401): Invalid API Key';

/** A driver that plays one scripted turn per start() call, recording prompts, on ONE session. */
function seqAttempt(agent: string, turns: TurnEvent[][], prompts: string[], created: string[]): AgentAttempt {
  let n = 0;
  const driver: TurnDriver = {
    start(text) {
      prompts.push(`${agent}:${text}`);
      return gen(turns[n++] ?? []);
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

test('retry: a rate limit waits for the server hint and CONTINUES in the same session, no failover', async () => {
  const prompts: string[] = [];
  const created: string[] = [];
  const waits: number[] = [];
  const r = await runWithFailover('do it', [seqAttempt('primary', [errorTurn(RATE), okTurn('done after retry')], prompts, created), seqAttempt('fallback', [okTurn('unused')], prompts, created)], {
    approver,
    delay: async (ms) => {
      waits.push(ms);
    },
    rand: () => 0,
  });
  assert.equal(r.agent, 'primary');
  assert.equal(r.outcome.status, 'done');
  assert.deepEqual(waits, [59383]);
  assert.equal(r.retries.length, 1);
  assert.deepEqual(created, ['primary'], 'the session is reused, not recreated');
  assert.deepEqual(prompts, ['primary:do it', `primary:${CONTINUE_PROMPT}`]);
  assert.equal(r.switches.length, 0);
});

test('retry: an outage (503) is retried 2 times with backoff, then fails over', async () => {
  const prompts: string[] = [];
  const waits: number[] = [];
  const r = await runWithFailover('x', [seqAttempt('primary', [errorTurn(DEMAND), errorTurn(DEMAND), errorTurn(DEMAND), errorTurn(DEMAND)], prompts, []), seqAttempt('fallback', [okTurn('ok')], prompts, [])], {
    approver,
    delay: async (ms) => {
      waits.push(ms);
    },
    rand: () => 0,
  });
  assert.deepEqual(waits, [5000, 15000]);
  assert.equal(r.agent, 'fallback');
  assert.equal(r.switches.length, 1);
  assert.equal(prompts.filter((p) => p.startsWith('primary:')).length, 3);
});

/** A turn that made progress (a tool ran) and then hit the per-minute quota, as observed live. */
const progressThenRate = (): TurnEvent[] => [
  ev({ type: 'turn.created', id: 'a', turnId: 'T' }),
  ev({ type: 'tool.response', id: 'r', threadId: 'main', toolCallId: 'c', content: '{}' }),
  ev({ type: 'turn.done', id: 'b', threadId: null, state: { status: 'error', message: RATE } }),
];

test('retry: per-minute 429s with progress in between keep going beyond 3 (a long task that advances is not dropped)', async () => {
  const waits: number[] = [];
  const turns = [...Array.from({ length: 5 }, progressThenRate), okTurn('finished')];
  const r = await runWithFailover('x', [seqAttempt('primary', turns, [], []), seqAttempt('fallback', [okTurn('unused')], [], [])], {
    approver,
    delay: async (ms) => {
      waits.push(ms);
    },
    rand: () => 0,
  });
  assert.equal(r.agent, 'primary');
  assert.equal(r.outcome.status, 'done');
  assert.equal(waits.length, 5);
  assert.equal(r.switches.length, 0);
});

test('retry: consecutive 429s WITHOUT progress stop after 3, then fail over', async () => {
  const waits: number[] = [];
  const r = await runWithFailover('x', [seqAttempt('primary', Array.from({ length: 6 }, () => errorTurn(RATE)), [], []), seqAttempt('fallback', [okTurn('ok')], [], [])], {
    approver,
    delay: async (ms) => {
      waits.push(ms);
    },
    rand: () => 0,
  });
  assert.equal(waits.length, 3);
  assert.equal(r.agent, 'fallback');
});

test('retry: rate-limit waits are hard-capped at 10 per agent per run even with progress', async () => {
  const waits: number[] = [];
  const r = await runWithFailover('x', [seqAttempt('primary', Array.from({ length: 20 }, progressThenRate), [], []), seqAttempt('fallback', [okTurn('ok')], [], [])], {
    approver,
    delay: async (ms) => {
      waits.push(ms);
    },
    rand: () => 0,
  });
  assert.equal(waits.length, MAX_RATE_LIMIT_WAITS);
  assert.equal(r.agent, 'fallback');
});

test('retry: outages stay limited to 2 per run even with progress in between', async () => {
  const waits: number[] = [];
  const progressThen503 = (): TurnEvent[] => [ev({ type: 'tool.response', id: 'r', threadId: 'main', toolCallId: 'c', content: '{}' }), ev({ type: 'turn.done', id: 'b', threadId: null, state: { status: 'error', message: DEMAND } })];
  const r = await runWithFailover('x', [seqAttempt('primary', Array.from({ length: 6 }, progressThen503), [], []), seqAttempt('fallback', [okTurn('ok')], [], [])], {
    approver,
    delay: async (ms) => {
      waits.push(ms);
    },
    rand: () => 0,
  });
  assert.deepEqual(waits, [5000, 15000]);
  assert.equal(r.agent, 'fallback');
});

test('retry: an invalid key is never retried; it fails over at once', async () => {
  const waits: number[] = [];
  const r = await runWithFailover('x', [seqAttempt('primary', [errorTurn(KEY)], [], []), seqAttempt('fallback', [okTurn('ok')], [], [])], {
    approver,
    delay: async (ms) => {
      waits.push(ms);
    },
  });
  assert.deepEqual(waits, []);
  assert.equal(r.retries.length, 0);
  assert.equal(r.agent, 'fallback');
});

test('retryDelayMs: caps the hint, jitters, stops after MAX_RETRIES, ignores non-transient errors', () => {
  assert.equal(retryDelayMs('(429): quota. Please retry in 300s.', 0, () => 0), 65000);
  assert.equal(retryDelayMs(RATE, 0, () => 0.5), 59383 + 500);
  assert.equal(retryDelayMs(RATE, MAX_RETRIES), undefined);
  assert.equal(retryDelayMs(KEY, 0), undefined);
  assert.equal(retryDelayMs('[Model Error] Request failed (400): Bad Request', 0), undefined);
  assert.equal(retryDelayMs('[Model Error] Cannot connect to API: Headers Timeout Error', 1, () => 0), 15000);
});

test('TLS: "certificate has expired" is never retried and never fails over (it is a local network problem)', async () => {
  const TLS = '[Model Error] Cannot connect to API: certificate has expired';
  const waits: number[] = [];
  const created: string[] = [];
  const r = await runWithFailover('x', [seqAttempt('primary', [errorTurn(TLS)], [], created), seqAttempt('fallback', [okTurn('unused')], [], created)], {
    approver,
    delay: async (ms) => {
      waits.push(ms);
    },
  });
  assert.deepEqual(waits, []);
  assert.equal(r.switches.length, 0);
  assert.deepEqual(created, ['primary']);
  assert.equal(r.outcome.status, 'error');
});

test('failover: cancelled (Stop Run) does not fail over', async () => {
  const created: string[] = [];
  const ac = new AbortController();
  ac.abort();
  const r = await runWithFailover('x', [attempt('primary', okTurn('a'), [], created), attempt('fallback', okTurn('b'), [], created)], { approver, signal: ac.signal });
  assert.equal(r.outcome.status, 'cancelled');
  assert.deepEqual(created, ['primary']);
});

test('retry: bad output is retried once, then fails over', async () => {
  const BAD = '[Model Error] Failed to parse tool call arguments: invalid JSON';
  const waits: number[] = [];
  const r = await runWithFailover('x', [seqAttempt('primary', [errorTurn(BAD), errorTurn(BAD), okTurn('unused')], [], []), seqAttempt('fallback', [okTurn('ok')], [], [])], {
    approver,
    delay: async (ms) => {
      waits.push(ms);
    },
    rand: () => 0,
  });
  assert.deepEqual(waits, [2000]);
  assert.equal(r.agent, 'fallback');
});

test('retry: context too large retries ONCE with a trimmed prompt in a fresh session; without trimPrompt it fails over', async () => {
  const BIG = '[Model Error] Request failed (400): The input is too long: maximum context length exceeded';
  const prompts: string[] = [];
  const created: string[] = [];
  const r = await runWithFailover('long prompt', [seqAttempt('primary', [errorTurn(BIG), okTurn('done small')], prompts, created), seqAttempt('fallback', [okTurn('unused')], prompts, created)], {
    approver,
    delay: async () => undefined,
    trimPrompt: (p) => `TRIMMED(${p})`,
  });
  assert.equal(r.outcome.status, 'done');
  assert.equal(r.agent, 'primary');
  assert.deepEqual(prompts, ['primary:long prompt', 'primary:TRIMMED(long prompt)']);
  assert.deepEqual(created, ['primary', 'primary'], 'a fresh session for the trimmed retry');

  const twice = await runWithFailover('p', [seqAttempt('primary', [errorTurn(BIG), errorTurn(BIG)], [], []), seqAttempt('fallback', [okTurn('ok')], [], [])], { approver, delay: async () => undefined, trimPrompt: (p) => p.slice(0, 1) });
  assert.equal(twice.agent, 'fallback', 'only one trimmed retry');
  const none = await runWithFailover('p', [seqAttempt('primary', [errorTurn(BIG)], [], []), seqAttempt('fallback', [okTurn('ok')], [], [])], { approver, delay: async () => undefined });
  assert.equal(none.agent, 'fallback');
  assert.equal(none.retries.length, 0);
});

test('retryAfterMs and RETRY_BUDGET: Retry-After header text and the observed hint; policy table', () => {
  assert.equal(retryAfterMs('429 Too Many Requests. Retry-After: 12'), 12000);
  assert.equal(retryAfterMs('{"retry_after": 7.5}'), 7500);
  assert.equal(retryAfterMs('Please retry in 59.382723513s.'), 59383);
  assert.equal(retryAfterMs('no hint'), undefined);
  assert.deepEqual(RETRY_BUDGET, { tls_error: 0, editor_tools_unreachable: 0, invalid_or_revoked_key: 0, bad_request: 0, unknown: 0, rate_limit: 3, unavailable_or_timeout: 2, bad_output: 1, context_too_large: 1, tool_not_mapped: 0 });
  assert.equal(retryDelayMs('[Model Error] Request failed (429): Too Many Requests. Retry-After: 3', 0, () => 0), 3000);
});
