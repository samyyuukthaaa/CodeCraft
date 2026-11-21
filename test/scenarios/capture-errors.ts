// Captures REAL TrueForge error shapes (P4) and saves them as test fixtures:
//  - "mock": a test-only local provider (mock-provider.ts) makes the provider side fail on purpose; TrueForge
//    and its events are real.
//  - "unreachable": a provider whose endpoint has nothing listening.
//  - "invalid key": the test-only provider with a dummy key at a real endpoint.
//  - "history": natural errors TrueForge recorded in earlier sessions on this machine.
// Usage: node esbuild.mjs --scenarios && node out/scenarios/capture-errors.js
import * as fs from 'node:fs';
import { createClient, describeError, streamTurn } from '../../src/trueforge/client';
import type { TurnEvent } from '../../src/trueforge/client';
import { validateConfig } from '../../src/trueforge/config';
import { redact } from '../../src/util/redact';
import { MOCK_MODES, mockModelName, startMockProvider } from './mock-provider';
import { DUMMY_KEY, TEST_MODEL_REF, ensureTestAgent, ensureTestProvider } from './testProvider';

const MOCK_PROVIDER = 'codecraft-test-mock';
const UNREACHABLE_PROVIDER = 'codecraft-test-unreachable';
const OUT = 'test/fixtures/trueforge-errors.json';

interface Sample {
  id: string;
  source: 'mock' | 'unreachable' | 'invalid_key' | 'history';
  observedAt: string;
  eventTypes: string[];
  status: string;
  message: string;
  durationMs?: number;
}

const clean = (s: string) => redact(s).split(DUMMY_KEY).join('<dummy>');

async function runInline(model: string, timeoutMs: number): Promise<Omit<Sample, 'id' | 'source' | 'observedAt'>> {
  const client = createClient(validateConfig({}));
  const s = await client.sessions.create({ agent: { spec: { model: { name: model } } } });
  const started = Date.now();
  const types: string[] = [];
  let status = 'no turn.done';
  let message = '';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for await (const ev of streamTurn(client, s.data.id, 'Reply with exactly: OK', ac.signal) as AsyncIterable<TurnEvent>) {
      types.push(ev.type);
      if (ev.type === 'turn.done') {
        status = ev.state.status;
        message = ev.state.status === 'error' ? ev.state.message : JSON.stringify((ev.state as { output?: { content?: unknown } }).output?.content ?? '');
      }
    }
  } catch (e) {
    status = ac.signal.aborted ? `client timeout after ${timeoutMs} ms` : 'stream threw';
    message = describeError(e);
  } finally {
    clearTimeout(timer);
  }
  return { eventTypes: types, status, message: clean(message), durationMs: Date.now() - started };
}

async function main(): Promise<void> {
  const client = createClient(validateConfig({}));
  const samples: Sample[] = [];
  const now = () => new Date().toISOString();

  // 1. mock provider modes
  const mock = await startMockProvider(8799);
  try {
    await client.settings.modelProviders.createOrUpdate({
      manifest: { type: 'custom', name: MOCK_PROVIDER, baseUrl: mock.url, models: MOCK_MODES.map((m) => ({ modelId: mockModelName(m), name: mockModelName(m), properties: { contextLength: 8192, maxOutputTokens: 1024 } })) },
    });
    for (const m of MOCK_MODES) {
      const r = await runInline(`${MOCK_PROVIDER}/${mockModelName(m)}`,m === 'hang' ? 330_000 : 120_000);
      samples.push({ id: `mock_${m}`, source: 'mock', observedAt: now(), ...r });
      console.log(`mock ${m}: ${r.status} ${r.durationMs} ms | ${r.message.slice(0, 160)}`);
    }
    console.log('mock provider hits:', mock.hits.join(','));
  } finally {
    await mock.close();
  }

  // 2. unreachable endpoint (nothing listening on that port)
  await client.settings.modelProviders.createOrUpdate({
    manifest: { type: 'custom', name: UNREACHABLE_PROVIDER, baseUrl: 'http://127.0.0.1:8798/v1', models: [{ modelId: 'any', name: 'any', properties: { contextLength: 8192, maxOutputTokens: 1024 } }] },
  });
  const un = await runInline(`${UNREACHABLE_PROVIDER}/any`, 180_000);
  samples.push({ id: 'unreachable_endpoint', source: 'unreachable', observedAt: now(), ...un });
  console.log(`unreachable: ${un.status} ${un.durationMs} ms | ${un.message.slice(0, 160)}`);

  // 3. invalid key at a real endpoint
  await ensureTestProvider(client);
  await ensureTestAgent(client);
  const bad = await runInline(TEST_MODEL_REF, 120_000);
  samples.push({ id: 'invalid_key', source: 'invalid_key', observedAt: now(), ...bad });
  console.log(`invalid key: ${bad.status} | ${bad.message.slice(0, 160)}`);

  // 4. natural errors from TrueForge's own session history (unique messages)
  const seen = new Set<string>();
  let token: string | undefined;
  let pages = 0;
  do {
    const r = (await (await fetch(`http://localhost:8790/api/v1/sessions?limit=25${token ? `&page_token=${token}` : ''}`)).json()) as { data?: Array<{ id: string }>; pagination?: { next_page_token?: string }; error?: { message?: string } };
    if (!r.data) throw new Error(`session history request refused: ${r.error?.message ?? 'no data'}`);
    for (const s of r.data) {
      const t = (await (await fetch(`http://localhost:8790/api/v1/sessions/${s.id}/turns`)).json()) as { data?: Array<{ created_at: string; state: { status: string; message?: string } }> };
      for (const turn of t.data ?? []) {
        if (turn.state.status !== 'error' || !turn.state.message) continue;
        const key = turn.state.message.replace(/\d+(\.\d+)?s\b/g, 'Ns').replace(/(limit: \d+).*/, '$1').slice(0, 140);
        if (seen.has(key) || /mock-|codecraft-test-unreachable/.test(turn.state.message)) continue;
        seen.add(key);
        samples.push({ id: `history_${samples.filter((x) => x.source === 'history').length + 1}`, source: 'history', observedAt: turn.created_at, eventTypes: ['turn.done'], status: 'error', message: clean(turn.state.message) });
      }
    }
    token = r.pagination?.next_page_token;
  } while (token && ++pages < 10);

  fs.mkdirSync('test/fixtures', { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({ trueforge: '0.185.1', capturedAt: now(), note: 'Real TrueForge turn.done error shapes. mock = local test-only provider failing on purpose; history = natural errors from earlier sessions.', samples }, null, 2)}\n`);
  console.log(`saved ${samples.length} samples to ${OUT}`);
}
main().catch((e) => {
  console.error('FAILED', describeError(e));
  process.exitCode = 1;
});
