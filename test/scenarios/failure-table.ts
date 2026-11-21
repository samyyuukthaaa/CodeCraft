// Generates docs/FAILURE_TABLE.md from REAL runs (P4). Every row runs end to end through the real TrueForge
// (localhost:8790), CodeCraft's real runWithFailover / runWithApprovals and the real session driver:
//  - "provider" rows: a TEST-ONLY local provider (mock-provider.ts) fails on purpose behind TrueForge, or a
//    test-only provider has a dummy key at a real endpoint, or an endpoint with nothing listening.
//  - "injected" rows: the extension's own FaultInjector (setting / "Inject fault..." button) on a healthy model.
// The fallback is always mock-ok under a SEPARATE test-only provider, so the per-provider breaker is meaningful.
// Fallback = another configured provider/model; no extra accounts are involved.
// Usage: node esbuild.mjs --scenarios && node out/scenarios/failure-table.js [runs=3] [--only id,id]
import * as fs from 'node:fs';
import { createClient, describeError, sessionDriver } from '../../src/trueforge/client';
import type { TurnEvent } from '../../src/trueforge/client';
import { validateConfig } from '../../src/trueforge/config';
import { CircuitBreaker, providerOf } from '../../src/trueforge/breaker';
import { classifyError, failoverBanner } from '../../src/trueforge/errors';
import { AgentAttempt, FailoverResult, runWithFailover } from '../../src/trueforge/failover';
import { FaultInjector, FaultMode } from '../../src/trueforge/faults';
import type { StreamPosition, TurnDriver } from '../../src/trueforge/run';
import { redact } from '../../src/util/redact';
import { MockMode, mockModelName, startMockProvider, MOCK_MODES } from './mock-provider';
import { TEST_MODEL_REF, ensureTestProvider } from './testProvider';

const PRIMARY_PROVIDER = 'codecraft-test-mock';
const FALLBACK_PROVIDER = 'codecraft-test-mock-fallback';
const UNREACHABLE_PROVIDER = 'codecraft-test-unreachable';
const FALLBACK_MODEL = `${FALLBACK_PROVIDER}/${mockModelName('ok')}`;
const PROMPT = 'Reply with exactly: OK';

interface RunRecord {
  ok: boolean;
  observed: string;
  ms: number;
}
interface Row {
  id: string;
  fault: string;
  trigger: string;
  expected: string;
  primary: string;
  inject?: FaultMode;
  trim?: boolean;
  check: (r: Observation) => string | undefined; // undefined = as expected, else what differed
}
interface Observation {
  result: FailoverResult;
  firstError?: string;
  primaryDrivers: number;
  trims: number;
  positions: StreamPosition[];
  injected: FaultMode[];
  breakerState: string;
  ms: number;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const between = (v: number, lo: number, hi: number) => v >= lo && v < hi;

/** Common expectation: N retries with delays in the given windows, then failover; the fallback answers. */
function retriedThenFailedOver(cls: string, windows: Array<[number, number]>) {
  return (o: Observation): string | undefined => {
    const r = o.result;
    if (o.firstError === undefined || classifyError(o.firstError).cls !== cls) return `first error class ${o.firstError ? classifyError(o.firstError).cls : '(none)'}`;
    if (r.retries.length !== windows.length) return `${r.retries.length} retries`;
    const bad = r.retries.findIndex((x, i) => !between(x.delayMs, windows[i]![0], windows[i]![1]));
    if (bad >= 0) return `retry ${bad + 1} waited ${r.retries[bad]!.delayMs} ms`;
    if (r.switches.length !== 1 || r.agent !== 'fallback') return `switches=${r.switches.length} final agent=${r.agent}`;
    if (r.outcome.status !== 'done') return `fallback outcome ${r.outcome.status}`;
    return undefined;
  };
}

const ROWS: Row[] = [
  {
    id: 'invalid_key',
    fault: 'Invalid or revoked key',
    trigger: 'test-only provider with a dummy key at the real Groq endpoint (HTTP 401)',
    expected: 'no retry; immediate failover; banner "Provider key rejected: update it in TrueForge Settings"; fallback answers',
    primary: TEST_MODEL_REF,
    check: (o) => {
      const r = o.result;
      if (classifyError(o.firstError ?? '').cls !== 'invalid_or_revoked_key') return `first error ${o.firstError}`;
      if (r.retries.length) return `${r.retries.length} retries`;
      const s = r.switches[0];
      if (!s || !failoverBanner(s.fromModel, s.toModel, s.reason).startsWith('Provider key rejected: update it in TrueForge Settings')) return 'no key banner';
      return r.outcome.status === 'done' && r.agent === 'fallback' ? undefined : `outcome ${r.outcome.status} on ${r.agent}`;
    },
  },
  {
    id: 'rate_limit',
    fault: 'Rate limit (HTTP 429, "try again in 7s")',
    trigger: 'mock provider returns 429 with Retry-After 7',
    expected: '3 waits honouring the 7 s hint plus jitter (7-8 s each), then failover; fallback answers',
    primary: `${PRIMARY_PROVIDER}/${mockModelName('rate_limit')}`,
    check: retriedThenFailedOver('rate_limit', [[7000, 8000], [7000, 8000], [7000, 8000]]),
  },
  {
    id: 'outage_503',
    fault: 'Outage (HTTP 503 overloaded)',
    trigger: 'mock provider returns 503',
    expected: '2 retries with backoff (5-6 s, 15-16 s), then failover; fallback answers',
    primary: `${PRIMARY_PROVIDER}/${mockModelName('unavailable')}`,
    check: retriedThenFailedOver('unavailable_or_timeout', [[5000, 6000], [15000, 16000]]),
  },
  {
    id: 'server_error_500',
    fault: 'Provider error (HTTP 500)',
    trigger: 'mock provider returns 500',
    expected: '2 retries with backoff, then failover; fallback answers',
    primary: `${PRIMARY_PROVIDER}/${mockModelName('server_error')}`,
    check: retriedThenFailedOver('unavailable_or_timeout', [[5000, 6000], [15000, 16000]]),
  },
  {
    id: 'unreachable',
    fault: 'Unreachable endpoint',
    trigger: 'provider URL with nothing listening (ECONNREFUSED)',
    expected: '2 retries with backoff, then failover; fallback answers',
    primary: `${UNREACHABLE_PROVIDER}/any`,
    check: retriedThenFailedOver('unavailable_or_timeout', [[5000, 6000], [15000, 16000]]),
  },
  {
    id: 'timeout',
    fault: 'Timeout (provider never answers)',
    trigger: 'mock provider accepts the request and never responds; TrueForge times out after ~65 s',
    expected: '2 retries with backoff, then failover; fallback answers',
    primary: `${PRIMARY_PROVIDER}/${mockModelName('hang')}`,
    check: retriedThenFailedOver('unavailable_or_timeout', [[5000, 6000], [15000, 16000]]),
  },
  {
    id: 'provider_cut_stream',
    fault: 'Provider cuts its stream',
    trigger: 'mock provider closes the connection mid-stream; TrueForge reports "terminated: other side closed"',
    expected: '2 retries with backoff, then failover; fallback answers',
    primary: `${PRIMARY_PROVIDER}/${mockModelName('cut_stream')}`,
    check: retriedThenFailedOver('unavailable_or_timeout', [[5000, 6000], [15000, 16000]]),
  },
  {
    id: 'malformed_tool_call',
    fault: 'Malformed tool call',
    trigger: 'mock provider streams a tool call with truncated JSON arguments (TrueForge loops to its iteration limit)',
    expected: '1 retry (2-3 s), then failover; fallback answers',
    primary: `${PRIMARY_PROVIDER}/${mockModelName('malformed_tool_call')}`,
    check: retriedThenFailedOver('bad_output', [[2000, 3000]]),
  },
  {
    id: 'bad_json',
    fault: 'Unparseable output',
    trigger: 'mock provider streams broken JSON',
    expected: '1 retry (2-3 s), then failover; fallback answers',
    primary: `${PRIMARY_PROVIDER}/${mockModelName('bad_json')}`,
    check: retriedThenFailedOver('bad_output', [[2000, 3000]]),
  },
  {
    id: 'context_too_large',
    fault: 'Context too large',
    trigger: 'mock provider returns 400 "maximum context length is 8192 tokens"',
    expected: 'prompt trimmed with the context budget and retried once in a fresh session, then failover; fallback answers',
    primary: `${PRIMARY_PROVIDER}/${mockModelName('context_too_large')}`,
    trim: true,
    check: (o) => {
      const base = retriedThenFailedOver('context_too_large', [[0, 1]])(o);
      if (base) return base;
      if (o.trims !== 1) return `${o.trims} trims`;
      return o.primaryDrivers === 2 ? undefined : `${o.primaryDrivers} primary sessions (expected a fresh one for the retry)`;
    },
  },
  {
    id: 'client_cut_stream',
    fault: 'Stream to CodeCraft cut',
    trigger: 'FaultInjector cut_stream: the real TrueForge stream is dropped after the first model message',
    expected: 'the SAME turn is resumed after the last event (live subscribe or persisted events); no retry, no failover',
    primary: `${PRIMARY_PROVIDER}/${mockModelName('ok')}`,
    inject: 'cut_stream',
    check: (o) => {
      const r = o.result;
      if (!o.positions.some((p) => p.at === 'cut')) return 'no cut position recorded';
      if (r.retries.length || r.switches.length) return `retries=${r.retries.length} switches=${r.switches.length}`;
      const cut = o.positions.find((p) => p.at === 'cut');
      const fin = o.positions.find((p) => p.at === 'done');
      if (!fin || fin.turnId !== cut?.turnId) return 'not resumed in the same turn';
      return r.outcome.status === 'done' && r.agent === 'primary' ? undefined : `outcome ${r.outcome.status} on ${r.agent}`;
    },
  },
  ...(['outage', 'timeout', 'malformed_tool_call', 'rate_limit'] as const).map(
    (m): Row => ({
      id: `injected_${m}`,
      fault: `Injected ${m.replace(/_/g, ' ')} (button/setting)`,
      trigger: `FaultInjector ${m}: the primary's first turn fails with the real TrueForge text, on a healthy model`,
      expected: 'one retry on the same model after the class delay, which then answers; no failover',
      primary: `${PRIMARY_PROVIDER}/${mockModelName('ok')}`,
      inject: m,
      check: (o) => {
        const r = o.result;
        if (r.retries.length !== 1 || r.switches.length) return `retries=${r.retries.length} switches=${r.switches.length}`;
        return r.outcome.status === 'done' && r.agent === 'primary' ? undefined : `outcome ${r.outcome.status} on ${r.agent}`;
      },
    }),
  ),
  {
    id: 'injected_invalid_key',
    fault: 'Injected invalid key (button/setting)',
    trigger: 'FaultInjector invalid_key on a healthy model',
    expected: 'no retry; immediate failover with the key banner; fallback answers',
    primary: `${PRIMARY_PROVIDER}/${mockModelName('ok')}`,
    inject: 'invalid_key',
    check: (o) => {
      const r = o.result;
      const s = r.switches[0];
      if (r.retries.length || !s) return `retries=${r.retries.length} switches=${r.switches.length}`;
      if (!failoverBanner(s.fromModel, s.toModel, s.reason).startsWith('Provider key rejected: update it in TrueForge Settings')) return 'no key banner';
      return r.outcome.status === 'done' && r.agent === 'fallback' ? undefined : `outcome ${r.outcome.status} on ${r.agent}`;
    },
  },
];

function summarize(o: Observation): string {
  const r = o.result;
  const parts: string[] = [];
  if (o.injected.length) parts.push(`injected ${o.injected.join(',')}`);
  if (o.firstError) {
    const c = classifyError(o.firstError);
    parts.push(`${c.cls}${c.status ? ` (HTTP ${c.status})` : ''}`);
  }
  if (r.retries.length) parts.push(`${r.retries.length} retr${r.retries.length === 1 ? 'y' : 'ies'} (${r.retries.map((x) => secs(x.delayMs)).join(', ')})`);
  else parts.push('no retry');
  if (o.trims) parts.push(`trimmed ${o.trims}x, ${o.primaryDrivers} primary sessions`);
  if (o.positions.some((p) => p.at === 'cut')) parts.push(`stream cut and resumed in the same turn`);
  parts.push(r.switches.length ? `failover to ${r.switches.map((s) => s.toModel.split('/')[1]).join(', ')}` : 'no failover');
  parts.push(`${r.outcome.status} on ${r.agent}`);
  parts.push(`breaker ${o.breakerState}`);
  parts.push(secs(o.ms));
  return parts.join('; ');
}

async function runRow(row: Row, client: ReturnType<typeof createClient>): Promise<Observation> {
  const breaker = new CircuitBreaker();
  const positions: StreamPosition[] = [];
  const injected: FaultMode[] = [];
  let firstError: string | undefined;
  let primaryDrivers = 0;
  let trims = 0;
  const inj = new FaultInjector();
  if (row.inject) inj.arm(row.inject);
  const mode = inj.take();
  const session = async (model: string): Promise<TurnDriver> => {
    const s = await client.sessions.create({ agent: { spec: { model: { name: model } } } });
    return sessionDriver(client, s.data.id);
  };
  const attempts: AgentAttempt[] = [
    {
      agent: 'primary',
      model: row.primary,
      driver: async () => {
        primaryDrivers++;
        const d = await session(row.primary);
        return primaryDrivers === 1 ? inj.wrap(d, mode, (m) => injected.push(m)) : d;
      },
    },
    { agent: 'fallback', model: FALLBACK_MODEL, driver: () => session(FALLBACK_MODEL) },
  ];
  const t0 = Date.now();
  const result = await runWithFailover(PROMPT, attempts, {
    approver: { approve: async () => ({ allow: false, reason: 'failure-table run' }) },
    breaker,
    onPosition: (p) => positions.push(p),
    onProviderError: (e) => {
      if (e.agent === 'primary') firstError ??= e.message;
    },
    onEvent: (_ev: TurnEvent) => undefined,
    trimPrompt: row.trim
      ? () => {
          trims++;
          return 'Reply with exactly: OK (trimmed context)';
        }
      : undefined,
  });
  const h = breaker.snapshot().find((p) => p.provider === providerOf(row.primary));
  return { result, firstError, primaryDrivers, trims, positions, injected, breakerState: h ? `${h.state}${h.lastErrorClass ? ` (last error ${h.lastErrorClass})` : ''}` : 'closed', ms: Date.now() - t0 };
}

/** Breaker row: run 1 opens it, run 2 skips the primary without calling it, run 3 (after the cooldown) recovers. */
async function breakerRow(client: ReturnType<typeof createClient>, mock: { hits: string[] }): Promise<RunRecord> {
  let clock = Date.now();
  const breaker = new CircuitBreaker(() => clock);
  const recovered: string[] = [];
  const session = async (model: string): Promise<TurnDriver> => sessionDriver(client, (await client.sessions.create({ agent: { spec: { model: { name: model } } } })).data.id);
  const run = (primary: string) =>
    runWithFailover(
      PROMPT,
      [
        { agent: 'primary', model: primary, driver: () => session(primary) },
        { agent: 'fallback', model: FALLBACK_MODEL, driver: () => session(FALLBACK_MODEL) },
      ],
      { approver: { approve: async () => ({ allow: false }) }, breaker, onProviderRecovered: (_a, m) => recovered.push(m) },
    );
  const t0 = Date.now();
  const failing = `${PRIMARY_PROVIDER}/${mockModelName('unavailable')}`;
  const r1 = await run(failing);
  const s1 = breaker.state(PRIMARY_PROVIDER);
  const hitsBefore = mock.hits.filter((h) => h === 'unavailable').length;
  const r2 = await run(failing);
  const hitsAfter = mock.hits.filter((h) => h === 'unavailable').length;
  clock += 61_000; // virtual clock: the 60 s cooldown has passed
  const s3 = breaker.state(PRIMARY_PROVIDER);
  const r3 = await run(`${PRIMARY_PROVIDER}/${mockModelName('ok')}`);
  const observed = `run 1: ${r1.outcome.status} on ${r1.agent}, breaker ${s1}; run 2: primary skipped=${r2.switches[0]?.circuitOpen === true}, primary calls during run 2=${hitsAfter - hitsBefore}, ${r2.outcome.status} on ${r2.agent}; after cooldown: ${s3}; run 3: ${r3.outcome.status} on ${r3.agent}, provider_recovered=${recovered.length}; ${secs(Date.now() - t0)}`;
  const ok = s1 === 'open' && r2.switches[0]?.circuitOpen === true && hitsAfter === hitsBefore && r2.outcome.status === 'done' && s3 === 'half_open' && r3.agent === 'primary' && r3.outcome.status === 'done' && recovered.length === 1 && breaker.state(PRIMARY_PROVIDER) === 'closed';
  return { ok, observed, ms: Date.now() - t0 };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 3);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set((args[onlyIdx + 1] ?? '').split(',')) : undefined;
  const client = createClient(validateConfig({}));
  const mock = await startMockProvider(8799);
  const results: Array<{ row: Row | { id: string; fault: string; trigger: string; expected: string }; runs: RunRecord[] }> = [];
  try {
    const models = MOCK_MODES.map((m: MockMode) => ({ modelId: mockModelName(m), name: mockModelName(m), properties: { contextLength: 8192, maxOutputTokens: 1024 } }));
    for (const name of [PRIMARY_PROVIDER, FALLBACK_PROVIDER]) {
      await client.settings.modelProviders.createOrUpdate({ manifest: { type: 'custom', name, baseUrl: mock.url, models } });
    }
    await client.settings.modelProviders.createOrUpdate({
      manifest: { type: 'custom', name: UNREACHABLE_PROVIDER, baseUrl: 'http://127.0.0.1:8798/v1', models: [{ modelId: 'any', name: 'any', properties: { contextLength: 8192, maxOutputTokens: 1024 } }] },
    });
    await ensureTestProvider(client);

    for (const row of ROWS) {
      if (only && !only.has(row.id)) continue;
      const recs: RunRecord[] = [];
      for (let i = 0; i < runs; i++) {
        try {
          const o = await runRow(row, client);
          const diff = row.check(o);
          recs.push({ ok: diff === undefined, observed: summarize(o) + (diff ? ` [UNEXPECTED: ${diff}]` : ''), ms: o.ms });
        } catch (e) {
          recs.push({ ok: false, observed: `threw: ${redact(describeError(e)).slice(0, 200)}`, ms: 0 });
        }
        console.log(`${row.id} run ${i + 1}: ${recs.at(-1)!.ok ? 'ok' : 'FAIL'} | ${recs.at(-1)!.observed}`);
      }
      results.push({ row, runs: recs });
    }
    if (!only || only.has('circuit_breaker')) {
      const recs: RunRecord[] = [];
      for (let i = 0; i < runs; i++) {
        try {
          recs.push(await breakerRow(client, mock));
        } catch (e) {
          recs.push({ ok: false, observed: `threw: ${redact(describeError(e)).slice(0, 200)}`, ms: 0 });
        }
        console.log(`circuit_breaker run ${i + 1}: ${recs.at(-1)!.ok ? 'ok' : 'FAIL'} | ${recs.at(-1)!.observed}`);
      }
      results.push({
        row: {
          id: 'circuit_breaker',
          fault: 'Circuit breaker and recovery',
          trigger: 'three runs: 503 provider, same provider again, healthy model of that provider after the cooldown (virtual clock)',
          expected: 'run 1 opens the breaker; run 2 skips the primary without calling it; run 3 probes it (half-open), succeeds and emits provider_recovered',
        },
        runs: recs,
      });
    }
  } finally {
    await mock.close();
  }

  const at = new Date().toISOString();
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const lines = [
    '# Failure table',
    '',
    `Generated ${at.slice(0, 16).replace('T', ' ')} UTC by \`node out/scenarios/failure-table.js ${runs}\` against TrueForge 0.185.1 on localhost. Do not edit by hand.`,
    '',
    'Every row is a real end-to-end run: real TrueForge sessions and turns, CodeCraft\'s real failover, retry, breaker and stream-resume code, and real waits. Faults come from test-only providers (a local mock provider that fails on purpose, a dummy key at a real endpoint, a port with nothing listening) or from CodeCraft\'s own fault injector (the *Inject fault…* button and the `codecraft.faultInjection` setting). The fallback is a separate test-only provider; fallback never means extra accounts. Error shapes: `test/fixtures/trueforge-errors.json`; notes: `docs/TRUEFORGE_NOTES.md`.',
    '',
    '| Fault | How it was triggered | Expected | Observed | Runs |',
    '|---|---|---|---|---|',
    ...results.map(({ row, runs: rs }) => {
      const observed = [...new Set(rs.map((r) => r.observed.replace(/; [\d.]+ s$/, '')))].join('<br>') + `<br>(${rs.map((r) => secs(r.ms)).join(', ')})`;
      return `| ${esc(row.fault)} | ${esc(row.trigger)} | ${esc(row.expected)} | ${esc(observed)} | ${rs.filter((r) => r.ok).length}/${rs.length} as expected |`;
    }),
    '',
  ];
  if (!only) {
    fs.writeFileSync('docs/FAILURE_TABLE.md', lines.join('\n'));
    fs.mkdirSync('docs/results', { recursive: true });
    fs.writeFileSync('docs/results/failure-table.json', `${JSON.stringify({ at, runs, results: results.map(({ row, runs: rs }) => ({ id: row.id, runs: rs })) }, null, 2)}\n`);
    console.log('wrote docs/FAILURE_TABLE.md');
  } else console.log(lines.join('\n'));
  const failed = results.filter((r) => r.runs.some((x) => !x.ok)).map((r) => r.row.id);
  if (failed.length) {
    console.log(`NOT as expected: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}
main().catch((e) => {
  console.error('FAILED', describeError(e));
  process.exitCode = 1;
});
