// P4: fault injection through the real failover code, cut-stream resume, journal positions and the
// beforeTool hook (an operation ID is journaled before every tool call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, MemorySink } from '../src/journal/journal';
import { createHandlers } from '../src/mcp/tools';
import { WriteGate } from '../src/mcp/gate';
import type { TurnEvent } from '../src/trueforge/client';
import { CircuitBreaker } from '../src/trueforge/breaker';
import { classifyError, failoverBanner, failureMessage } from '../src/trueforge/errors';
import { FAULT_MODES, FaultInjector, FaultMode, REAL_FAULT_TEXT } from '../src/trueforge/faults';
import { AgentAttempt, runWithFailover } from '../src/trueforge/failover';
import { MAX_STREAM_RESUMES, StreamPosition, TurnDriver, runWithApprovals } from '../src/trueforge/run';
import { DiskApplier, ScriptedReviewer, acceptAll, tempWorkspace } from './helpers';

const ev = (e: unknown): TurnEvent => e as TurnEvent;
const gen = (events: TurnEvent[]) =>
  (async function* () {
    yield* events;
  })();
const created = (turnId: string) => ev({ type: 'turn.created', id: `${turnId}-c`, turnId, previousTurnId: null, state: { status: 'running' }, threadId: null });
const message = (id: string, content: string) => ev({ type: 'model.message', id, threadId: null, content });
const done = (id: string, text: string) => ev({ type: 'turn.done', id, threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'm', content: text }, requiredActions: [] } });
const approver = { approve: async () => ({ allow: true }) };

/** A healthy agent: every turn answers `text` (with a model message before turn.done, so cut_stream can cut). */
function healthy(agent: string, text: string, calls: string[], resumes: Array<[string, string | undefined]> = []): TurnDriver {
  let n = 0;
  return {
    sessionId: `${agent}-session`,
    start: (t) => {
      calls.push(`${agent}:${t.slice(0, 20)}`);
      const id = `${agent}-t${++n}`;
      return gen([created(id), message(`${id}-m`, 'partial'), done(`${id}-d`, text)]);
    },
    resumePaused: () => gen([]),
    newTurnWithApprovals: () => gen([]),
    resumeStream: (turnId, after) => {
      resumes.push([turnId, after]);
      return gen([done(`${turnId}-d`, text)]);
    },
  };
}

async function runFault(mode: FaultMode) {
  const calls: string[] = [];
  const resumes: Array<[string, string | undefined]> = [];
  const positions: StreamPosition[] = [];
  const injected: FaultMode[] = [];
  const delays: number[] = [];
  const inj = new FaultInjector();
  inj.arm(mode);
  const m = inj.take();
  const attempts: AgentAttempt[] = [
    { agent: 'primary', model: 'prov-a/model-a', driver: async () => inj.wrap(healthy('primary', 'from primary', calls, resumes), m, (x) => injected.push(x)) },
    { agent: 'fallback', model: 'prov-b/model-b', driver: async () => healthy('fallback', 'from fallback', calls) },
  ];
  const r = await runWithFailover('task', attempts, { approver, delay: async (ms) => void delays.push(ms), rand: () => 0.5, onPosition: (p) => positions.push(p) });
  return { r, calls, resumes, positions, injected, delays, inj };
}

test('fault injection: every mode uses a real TrueForge text that classifies as intended', () => {
  const want: Record<Exclude<FaultMode, 'cut_stream'>, string> = {
    outage: 'unavailable_or_timeout',
    timeout: 'unavailable_or_timeout',
    malformed_tool_call: 'bad_output',
    invalid_key: 'invalid_or_revoked_key',
    rate_limit: 'rate_limit',
  };
  for (const [mode, cls] of Object.entries(want)) assert.equal(classifyError(REAL_FAULT_TEXT[mode as keyof typeof want]).cls, cls, mode);
  assert.deepEqual([...FAULT_MODES].sort(), ['cut_stream', 'invalid_key', 'malformed_tool_call', 'outage', 'rate_limit', 'timeout']);
});

test('fault injection: invalid key fails over at once (no retry) with the key banner', async () => {
  const { r, injected, delays } = await runFault('invalid_key');
  assert.deepEqual(injected, ['invalid_key']);
  assert.equal(r.outcome.status, 'done');
  assert.equal(r.agent, 'fallback');
  assert.equal(r.retries.length, 0);
  assert.equal(delays.length, 0);
  assert.equal(r.switches.length, 1);
  const s = r.switches[0]!;
  assert.ok(failoverBanner(s.fromModel, s.toModel, s.reason).startsWith('Provider key rejected: update it in TrueForge Settings.'));
});

test('fault injection: rate limit waits for the retry hint (7 s + jitter) and continues on the same agent', async () => {
  const { r, delays, calls } = await runFault('rate_limit');
  assert.equal(r.outcome.status, 'done');
  assert.equal(r.agent, 'primary');
  assert.equal(r.switches.length, 0);
  assert.deepEqual(delays, [7_500]);
  assert.deepEqual(calls, ['primary:The previous step wa'], 'the injected turn never reached the provider; the retry continued');
});

test('fault injection: outage and timeout retry with backoff on the same agent', async () => {
  for (const mode of ['outage', 'timeout'] as const) {
    const { r, delays } = await runFault(mode);
    assert.equal(r.outcome.status, 'done', mode);
    assert.equal(r.agent, 'primary', mode);
    assert.deepEqual(delays, [5_500], mode);
  }
});

test('fault injection: a malformed tool call (bad output) is retried once', async () => {
  const { r, delays } = await runFault('malformed_tool_call');
  assert.equal(r.outcome.status, 'done');
  assert.equal(r.agent, 'primary');
  assert.deepEqual(delays, [2_500]);
});

test('fault injection: a cut stream resumes the SAME turn after the last event; no retry, no failover', async () => {
  const { r, resumes, positions, delays, calls } = await runFault('cut_stream');
  assert.equal(r.outcome.status, 'done');
  assert.equal(r.outcome.status === 'done' && r.outcome.text, 'from primary');
  assert.equal(r.agent, 'primary');
  assert.equal(delays.length, 0);
  assert.equal(calls.length, 1, 'no new turn was started');
  assert.deepEqual(resumes, [['primary-t1', 'primary-t1-m']]);
  assert.deepEqual(
    positions.map((p) => [p.at, p.turnId, p.lastEventId, p.sessionId]),
    [
      ['cut', 'primary-t1', 'primary-t1-m', 'primary-session'],
      ['done', 'primary-t1', 'primary-t1-d', 'primary-session'],
    ],
  );
});

test('editor tools unreachable (real [MCP Error] text): no retry, no failover, the provider breaker is untouched', async () => {
  const MCP = "[MCP Error] Failed to connect to remote MCP server 'codecraft-editor': failed to connect (tried streamable-http, sse)";
  const breaker = new CircuitBreaker();
  const calls: string[] = [];
  const failing: TurnDriver = { start: () => gen([ev({ type: 'turn.done', id: 'd', threadId: null, state: { status: 'error', message: MCP } })]), resumePaused: () => gen([]), newTurnWithApprovals: () => gen([]) };
  const r = await runWithFailover('task', [
    { agent: 'primary', model: 'prov-a/model-a', driver: async () => failing },
    { agent: 'fallback', model: 'prov-b/model-b', driver: async () => healthy('fallback', 'x', calls) },
  ], { approver, breaker, delay: async () => undefined });
  assert.equal(r.outcome.status, 'error');
  assert.equal(r.agent, 'primary');
  assert.equal(r.switches.length + r.retries.length + calls.length, 0);
  assert.equal(breaker.allow('prov-a/model-a'), true);
  assert.match(failureMessage('prov-a/model-a', MCP), /editor tools .* Reload Window/);
});

test('fault injection: a one-shot arm is consumed; the setting applies to every run', () => {
  let setting: FaultMode | 'none' = 'none';
  const inj = new FaultInjector(() => setting);
  assert.equal(inj.take(), undefined);
  inj.arm('outage');
  assert.equal(inj.take(), 'outage');
  assert.equal(inj.take(), undefined);
  setting = 'timeout';
  assert.equal(inj.take(), 'timeout');
  assert.equal(inj.take(), 'timeout');
});

test('cut stream: resumed at most MAX_STREAM_RESUMES times, then reported as an error', async () => {
  let resumed = 0;
  const driver: TurnDriver = {
    start: () => gen([created('t1'), message('m1', 'x')]),
    resumePaused: () => gen([]),
    newTurnWithApprovals: () => gen([]),
    resumeStream: () => {
      resumed++;
      return gen([]);
    },
  };
  const out = await runWithApprovals('x', { driver, approver });
  assert.equal(resumed, MAX_STREAM_RESUMES);
  assert.equal(out.status, 'error');
});

test('cut stream: a stream that throws mid-turn is resumed too', async () => {
  const driver: TurnDriver = {
    start: () =>
      (async function* () {
        yield created('t1');
        throw new Error('terminated: other side closed');
      })(),
    resumePaused: () => gen([]),
    newTurnWithApprovals: () => gen([]),
    resumeStream: (_t, after) => gen([done('d', `resumed after ${after}`)]),
  };
  const out = await runWithApprovals('x', { driver, approver });
  assert.deepEqual(out, { status: 'done', text: 'resumed after t1-c', rounds: 2 });
});

test('journal: per-run sequence numbers survive a reload; lastPosition returns the latest stream position', async () => {
  const sink = new MemorySink();
  const j = new Journal(sink, () => 1);
  j.runId = 'r1';
  await j.append({ t: 'run_started', request: 'x' });
  await j.append({ t: 'turn_position', sessionId: 's1', turnId: 't1', lastEventId: 'e5', reason: 'paused' });
  await j.append({ t: 'run_started', runId: 'r2', request: 'y' });
  await j.append({ t: 'turn_position', sessionId: 's1', turnId: 't1', lastEventId: 'e9', reason: 'cut' });
  const again = new Journal(sink, () => 2);
  await again.load();
  again.runId = 'r1';
  await again.append({ t: 'run_finished', status: 'done' });
  const seqs = sink.lines.map((l) => JSON.parse(l) as { runId: string; seq: number }).map((e) => `${e.runId}:${e.seq}`);
  assert.deepEqual(seqs, ['r1:1', 'r1:2', 'r2:1', 'r1:3', 'r1:4']);
  assert.equal(again.lastPosition('r1')?.lastEventId, 'e9');
  assert.equal(again.lastPosition('r2'), undefined);
});

test('beforeTool: awaited before EVERY tool handler runs (the operation ID is journaled first)', async () => {
  const ws = await tempWorkspace({ 'a.py': 'x = 1\n' });
  try {
    const journal = new Journal(new MemorySink());
    const order: string[] = [];
    let n = 0;
    const h = createHandlers({
      fs: ws.fs,
      gate: new WriteGate(ws.fs, new DiskApplier(ws.root), new ScriptedReviewer(acceptAll), journal),
      tests: {
        run: async () => {
          order.push('handler:run_tests');
          return { ran: true, exitCode: 0, output: 'ok' };
        },
      },
      beforeTool: async (tool, args) => {
        await new Promise((r) => setTimeout(r, 5)); // a slow journal write must still finish first
        await journal.append({ t: 'tool_call', opId: `op-${++n}`, tool, args: JSON.stringify(args) });
        order.push(`journal:${tool}`);
      },
    });
    const read = await h.read_file({ path: 'a.py' });
    order.push('handler:read_file');
    assert.match(read.text, /x = 1/);
    await h.run_tests();
    assert.deepEqual(order, ['journal:read_file', 'handler:read_file', 'journal:run_tests', 'handler:run_tests']);
    assert.deepEqual(journal.all().map((e) => (e.t === 'tool_call' ? `${e.tool}:${e.opId}` : e.t)), ['read_file:op-1', 'run_tests:op-2']);
  } finally {
    await ws.cleanup();
  }
});
