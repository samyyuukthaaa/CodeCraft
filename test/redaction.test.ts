// P4: a fake key must never appear in anything CodeCraft shows, logs, journals or sends to the panel.
// Fake keys of every recognised shape are planted in the request, provider errors, tool arguments, file
// contents, test output, plan reasons and model output; every outbound string is captured and checked.
// (read_file deliberately returns exact file content to the agent; that one channel is excluded.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../src/index/build';
import { composePrompt, selectContext } from '../src/index/context';
import { Journal, MemorySink } from '../src/journal/journal';
import { WriteGate } from '../src/mcp/gate';
import { PlanStore, createHandlers } from '../src/mcp/tools';
import { CircuitBreaker, circuitOpenBanner } from '../src/trueforge/breaker';
import type { TurnEvent } from '../src/trueforge/client';
import { failoverBanner, failureMessage } from '../src/trueforge/errors';
import { toDisplay } from '../src/trueforge/events';
import { AgentAttempt, runWithFailover } from '../src/trueforge/failover';
import { healthRows } from '../src/trueforge/health';
import type { TurnDriver } from '../src/trueforge/run';
import { redact } from '../src/util/redact';
import { DiskApplier, ScriptedReviewer, acceptAll, tempWorkspace } from './helpers';

// Built at runtime so this file itself never contains a key-shaped literal.
const FAKES = [
  'AIza' + 'Sy'.padEnd(37, 'Q'),
  'gsk_' + 'A1'.repeat(20),
  'sk-' + 'proj-' + 'Z9'.repeat(16),
  'sk-' + 'ant-' + 'api03-' + 'x'.repeat(30),
  'xai-' + 'Y7'.repeat(12),
  'AKIA' + 'ABCDEFGHIJKLMNOP',
  'ghp_' + 'g'.repeat(36),
  'xox' + 'b-' + '1234567890-abcdefghij',
];
const BEARER = 'Bearer ' + 'tok'.repeat(10);
const ASSIGN = 'api_key=' + 'plainsecretvalue123';
const ALL_SECRETS = [...FAKES, 'tok'.repeat(10), 'plainsecretvalue123'];
const LEAK = `${FAKES.join(' ')} ${BEARER} ${ASSIGN}`;

function assertNoSecret(label: string, text: string): void {
  for (const s of ALL_SECRETS) assert.ok(!text.includes(s), `${label} leaks ${s.slice(0, 8)}...`);
}

test('redact: every recognised key shape is removed', () => {
  assertNoSecret('redact()', redact(LEAK));
  const pem = ['-----BEGIN', 'RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE', 'KEY-----'].join(' ');
  assert.equal(redact(`k=${pem}`).includes('MIIE'), false);
});

const ev = (e: unknown): TurnEvent => e as TurnEvent;
const gen = (events: TurnEvent[]) =>
  (async function* () {
    yield* events;
  })();

test('nothing outbound contains a planted key: panel events, banners, messages, activity, context, journal, health', async () => {
  const outbound: Array<[string, string]> = [];
  const capture = (label: string, v: unknown) => outbound.push([label, typeof v === 'string' ? v : JSON.stringify(v)]);

  const ws = await tempWorkspace({ 'src/app.py': `# config\nKEY = "${FAKES[0]}"\n\ndef run():\n    return "${FAKES[1]}"\n`, 'README.md': `token: ${BEARER}\n` });
  try {
    const sink = new MemorySink();
    const journal = new Journal(sink);
    journal.runId = 'leak-test';
    await journal.append({ t: 'run_started', request: `please use ${LEAK}` });
    const plan = new PlanStore();
    const gate = new WriteGate(ws.fs, new DiskApplier(ws.root), new ScriptedReviewer(acceptAll), journal);
    const h = createHandlers({
      fs: ws.fs,
      gate,
      tests: { run: async () => ({ ran: true, exitCode: 1, output: `FAILED: ${LEAK}` }) },
      plan,
      onActivity: (l) => capture('activity', l),
      onPlan: (p) => {
        capture('plan', p);
        void journal.append({ t: 'plan', summary: p.summary, files: p.files.map((f) => ({ path: f.path, action: f.action })) });
      },
      onTests: (passed, exitCode) => void journal.append({ t: 'tests', passed, exitCode }),
    });
    capture('search_text', (await h.search_text({ query: 'def' })).text);
    capture('search_text (key)', (await h.search_text({ query: 'KEY' })).text);
    capture('submit_plan', (await h.submit_plan({ summary: `uses ${LEAK}`, files: [{ path: 'src/app.py', action: 'edit', why: `rotate ${FAKES[2]}` }] })).text);
    capture('run_tests', (await h.run_tests()).text);
    await h.read_file({ path: 'src/app.py' });
    capture('propose_changes', (await h.propose_changes({ plan: `plan with ${LEAK}`, groups: [{ intent: 'edit', files: [{ path: 'src/app.py', edits: [{ find: 'def run():', replace: 'def run2():' }] }] }] })).text);

    // context sent to the model and shown in the panel
    const { index } = await buildIndex(ws.root);
    const ctx = await selectContext({ index, text: `@file:src/app.py @file:README.md ${LEAK}`, budgetTokens: 4000, read: (p) => ws.fs.read(p) });
    capture('context text', ctx.contextText);
    capture('context report', ctx.report);
    capture('prompt', composePrompt(ctx.contextText, 'fix it'));

    // a run: provider errors with keys, model output with keys, failover, banners, panel events
    const breaker = new CircuitBreaker();
    const errText = `[Model Error] Request failed (401): Invalid API Key ${LEAK}`;
    const mk = (agent: string, model: string, events: TurnEvent[]): AgentAttempt => {
      const driver: TurnDriver = { start: () => gen(events), resumePaused: () => gen([]), newTurnWithApprovals: () => gen([]) };
      return { agent, model, driver: async () => driver };
    };
    const result = await runWithFailover(`request ${LEAK}`, [
      mk('primary', 'p/m', [ev({ type: 'turn.done', id: 'a', threadId: null, state: { status: 'error', message: errText } })]),
      mk('fallback', 'q/m', [
        ev({ type: 'model.message.delta', id: 'm', threadId: 'main', content: `answer ${LEAK}` }),
        ev({ type: 'turn.done', id: 'b', threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'm', content: `final ${LEAK}` }, requiredActions: [] } }),
      ]),
    ], {
      approver: { approve: async (c) => (capture('approval', c), { allow: true }) },
      breaker,
      delay: async () => undefined,
      onEvent: (e) => capture('panel event', toDisplay(e)),
      onProviderError: (e) => capture('provider_error', { model: e.model, cls: e.cls }),
      onSwitch: (s) => {
        capture('banner', failoverBanner(s.fromModel, s.toModel, s.reason));
        void journal.append({ t: 'model_switched', from: s.fromModel, to: s.toModel, reason: s.reason });
      },
    });
    capture('outcome', result.outcome);
    capture('failure message', failureMessage('p/m', errText, ['src/app.py']));
    capture('circuit banner', circuitOpenBanner('p/m', 'q/m', breaker.snapshot()[0]));
    capture('health', healthRows(breaker, [{ role: 'primary', model: 'p/m' }]));
    await journal.append({ t: 'run_finished', status: result.outcome.status });
    capture('journal file', sink.lines.join('\n'));

    assert.ok(outbound.length > 15, 'the capture really ran');
    for (const [label, text] of outbound) assertNoSecret(label, text);
  } finally {
    await ws.cleanup();
  }
});
