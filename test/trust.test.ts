// P5: per-run trust features (src/trust/session.ts) with real files, a real repository index, the real write gate
// and scripted test results; the ask_user_question round trip in the run loop; the run report; panel messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexService } from '../src/index/service';
import { Journal, MemorySink } from '../src/journal/journal';
import { latestRunId, renderRunReport } from '../src/journal/report';
import { WriteGate } from '../src/mcp/gate';
import { Plan, PlanStore, TestResult } from '../src/mcp/tools';
import { HostToWebview, parseWebviewMessage } from '../src/panel/protocol';
import type { TurnEvent } from '../src/trueforge/client';
import { ApprovalInput } from '../src/trueforge/client';
import { TurnDriver, runWithApprovals } from '../src/trueforge/run';
import { MemorySnapshots } from '../src/trust/rollback';
import { NO_ANSWER, TrustSession, fixPrompt } from '../src/trust/session';
import { DiskApplier, ScriptedReviewer, acceptAll, tempWorkspace } from './helpers';

const PASS: TestResult = { ran: true, exitCode: 0, output: '3 passed in 0.1s' };
const failing = (...ids: string[]): TestResult => ({ ran: true, exitCode: 1, output: `=================================== FAILURES ===================================\nE   AssertionError\n=========================== short test summary info ===========================\n${ids.map((i) => `FAILED ${i} - AssertionError`).join('\n')}\n` });

async function setup(testResults: TestResult[]) {
  const ws = await tempWorkspace({
    'src/app.py': 'def add(a, b):\n    return a + b\n',
    'src/cli.py': 'from src.app import add\n',
    'tests/test_app.py': 'from src.app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n',
  });
  const journal = new Journal(new MemorySink());
  journal.runId = 'r1';
  const posts: HostToWebview[] = [];
  const planStore = new PlanStore();
  const index = new IndexService(ws.root, undefined);
  const whys: string[] = [];
  const results = [...testResults];
  const trust = new TrustSession(
    { journal, post: (m) => posts.push(m), runTests: async (why) => (whys.push(why), results.shift() ?? { ran: false, output: '', message: 'no more scripted results' }), index: () => index.get(), plan: () => planStore.get() },
    'prov/model-a',
  );
  const reviewer = new ScriptedReviewer(acceptAll);
  const applier = new DiskApplier(ws.root);
  const gate = new WriteGate(ws.fs, applier, reviewer, journal, new MemorySnapshots());
  gate.setHooks({ annotate: (g) => trust.annotate(g), warning: () => trust.warning(), beforeApply: () => trust.beforeApply(), onApplied: (i) => void trust.onApplied(i) });
  const plan: Plan = { summary: 'make add safer', files: [{ path: 'src/app.py', action: 'edit', why: 'the function' }] };
  planStore.set(plan);
  return { ws, journal, posts, trust, gate, reviewer, applier, plan, whys };
}
const ofType = <T extends HostToWebview['type']>(posts: HostToWebview[], t: T) => posts.filter((p): p is Extract<HostToWebview, { type: T }> => p.type === t);

test('warn before edit: planned files and the tests that might break, shown and journaled; baseline started', async () => {
  const s = await setup([PASS]);
  try {
    await s.trust.onPlan(s.plan);
    assert.deepEqual(ofType(s.posts, 'warn')[0], { type: 'warn', files: ['src/app.py'], tests: ['tests/test_app.py'] });
    assert.deepEqual(s.journal.all().find((e) => e.t === 'warn_list'), { t: 'warn_list', files: ['src/app.py'], tests: ['tests/test_app.py'], runId: 'r1', at: s.journal.all()[0]!.at, seq: 1 } as never);
    assert.match(s.trust.warning()!, /plans to change src\/app\.py\. Tests that might break: tests\/test_app\.py/);
    await s.trust.beforeApply();
    assert.equal(s.whys.length, 1);
    assert.match(s.whys[0]!, /BEFORE any change/);
  } finally {
    await s.ws.cleanup();
  }
});

test('change groups: the review shows reason, a beginner sentence, the confidence tag with its rule, and the test status', async () => {
  const s = await setup([PASS]);
  try {
    await s.trust.onPlan(s.plan);
    s.gate.recordRead('src/app.py', 'def add(a, b):\n    return a + b\n');
    const r = await s.gate.proposeSet('plan', [{ intent: 'guard', reason: 'add() crashed on None', plain: 'This makes add() treat a missing number as zero.', files: [{ path: 'src/app.py', newContent: 'def add(a, b):\n    return (a or 0) + (b or 0)\n' }] }]);
    assert.equal(r.status, 'applied');
    const req = s.reviewer.requests[0]!;
    assert.match(req.warning!, /^Before any edit/);
    assert.deepEqual(req.notes, [{ reason: 'add() crashed on None', plain: 'This makes add() treat a missing number as zero.', confidence: 'sure', why: ['small planned change (2 lines) to files covered by tests'], tests: 'not run yet' }]);
    const groups = ofType(s.posts, 'groups').at(-1)!.groups;
    assert.equal(groups[0]!.status, 'applied');
    const cg = s.journal.all().find((e) => e.t === 'change_group');
    assert.ok(cg && cg.t === 'change_group' && cg.opId && cg.confidence === 'sure' && cg.plain.startsWith('This makes'));
    assert.equal(s.trust.warning(), undefined, 'the warn list is shown only before the first write');
  } finally {
    await s.ws.cleanup();
  }
});

test('baseline: the first write waits until the test baseline on the unchanged files has finished', async () => {
  const s = await setup([]);
  try {
    let release!: (r: TestResult) => void;
    const order: string[] = [];
    const trust = new TrustSession(
      { journal: s.journal, post: () => undefined, runTests: () => new Promise((res) => (release = (r) => (order.push('baseline done'), res(r)))), index: async () => undefined, plan: () => s.plan },
      'm',
    );
    s.gate.setHooks({ beforeApply: () => trust.beforeApply() });
    await trust.onPlan(s.plan);
    const orig = s.applier.applyAll.bind(s.applier);
    s.applier.applyAll = async (c) => {
      order.push('write');
      await orig(c);
    };
    s.gate.recordRead('src/app.py', 'def add(a, b):\n    return a + b\n');
    const p = s.gate.propose('src/app.py', 'def add(a, b):\n    return b + a\n', 'r');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, [], 'nothing written while the baseline runs');
    release(PASS);
    await p;
    assert.deepEqual(order, ['baseline done', 'write']);
  } finally {
    await s.ws.cleanup();
  }
});

async function applyOne(s: Awaited<ReturnType<typeof setup>>) {
  await s.trust.onPlan(s.plan);
  s.gate.recordRead('src/app.py', 'def add(a, b):\n    return a + b\n');
  assert.equal((await s.gate.propose('src/app.py', 'def add(a, b):\n    return a - b\n', 'r')).status, 'applied');
}

test('after the run: a test that passed before now fails -> exactly ONE automatic fix, then the tests again (fixed)', async () => {
  const s = await setup([failing('tests/test_old.py::test_known'), failing('tests/test_old.py::test_known', 'tests/test_app.py::test_add'), failing('tests/test_old.py::test_known')]);
  try {
    await applyOne(s);
    const prompts: string[] = [];
    await s.trust.afterRun(async (p) => {
      prompts.push(p);
      return { applied: true };
    });
    assert.equal(prompts.length, 1);
    const first = prompts[0]!.split('\n')[0]!;
    assert.equal(first, 'Your changes made tests fail that passed before: tests/test_app.py::test_add.', 'an already failing test is not blamed on the change');
    assert.match(prompts[0]!, /FAILED tests\/test_app\.py::test_add/, 'the real error output is included');
    assert.match(prompts[0]!, /exactly ONE minimal fix/);
    const tests = s.journal.all().filter((e) => e.t === 'tests').map((e) => (e.t === 'tests' ? `${e.phase}:${e.passed}` : ''));
    assert.deepEqual(tests, ['baseline:false', 'after:false', 'after_fix:false']);
    assert.deepEqual(s.journal.all().filter((e) => e.t === 'regression').map((e) => (e.t === 'regression' ? e.tests : [])), [['tests/test_app.py::test_add']]);
    assert.deepEqual(s.journal.all().filter((e) => e.t === 'autofix').map((e) => (e.t === 'autofix' ? e.status : '')), ['started', 'fixed']);
    assert.match(ofType(s.posts, 'event').map((e) => e.event.summary).join('\n'), /Automatic fix worked: tests\/test_app\.py::test_add pass again/);
    // never a second automatic fix in the same run
    await s.trust.afterRun(async () => assert.fail('a second fix must not be attempted'));
  } finally {
    await s.ws.cleanup();
  }
});

test('after the run: fix applied but still failing, and fix not applied, are both reported', async () => {
  const s1 = await setup([PASS, failing('t::a'), failing('t::a')]);
  try {
    await applyOne(s1);
    await s1.trust.afterRun(async () => ({ applied: true }));
    assert.deepEqual(s1.journal.all().filter((e) => e.t === 'autofix').map((e) => (e.t === 'autofix' ? e.status : '')), ['started', 'still_failing']);
    assert.match(ofType(s1.posts, 'event').at(-1)!.event.summary, /still fail: t::a\. No further automatic fix/);
    const g = ofType(s1.posts, 'groups').at(-1)!.groups[0]!;
    await new Promise((r) => setTimeout(r, 20));
    const g2 = ofType(s1.posts, 'groups').at(-1)!.groups[0]!;
    assert.equal(g2.confidence, 'risky', `re-rated with the real result (was ${g.confidence})`);
    assert.equal(g2.tests, 'a test that passed before now fails (real run)');
  } finally {
    await s1.ws.cleanup();
  }
  const s2 = await setup([PASS, failing('t::a')]);
  try {
    await applyOne(s2);
    await s2.trust.afterRun(async () => ({ applied: false }));
    assert.deepEqual(s2.journal.all().filter((e) => e.t === 'autofix').map((e) => (e.t === 'autofix' ? e.status : '')), ['started', 'not_applied']);
    assert.equal(s2.journal.all().filter((e) => e.t === 'tests').length, 2, 'no test run after a fix that was not applied');
  } finally {
    await s2.ws.cleanup();
  }
});

test('after the run: no regression -> no fix; nothing written -> no tests; unknown baseline -> never claims a regression', async () => {
  const s = await setup([PASS, PASS]);
  try {
    await applyOne(s);
    await s.trust.afterRun(async () => assert.fail('no fix needed'));
    assert.match(ofType(s.posts, 'event').at(-1)!.event.summary, /Tests after the changes: all tests pass/);
  } finally {
    await s.ws.cleanup();
  }
  const quiet = await setup([]);
  try {
    await quiet.trust.afterRun(async () => assert.fail('nothing was written'));
    assert.equal(quiet.whys.length, 0);
  } finally {
    await quiet.ws.cleanup();
  }
  const unknown = await setup([{ ran: false, output: '', message: 'the user declined to run the tests' }, failing('t::a')]);
  try {
    await applyOne(unknown);
    await unknown.trust.afterRun(async () => assert.fail('the baseline is unknown, so nothing counts as newly broken'));
    assert.match(ofType(unknown.posts, 'event').at(-1)!.event.summary, /no test counts as newly broken/);
  } finally {
    await unknown.ws.cleanup();
  }
});

test('fix prompt: real output excerpt, redacted, exactly one fix, tests not weakened', () => {
  const p = fixPrompt(['t::a'], `===== FAILURES =====\nE  key AIza${'Q'.repeat(35)}\n`);
  assert.ok(!p.includes(`AIza${'Q'.repeat(35)}`));
  assert.match(p, /exactly ONE minimal fix/);
  assert.match(p, /do not weaken or delete the tests/);
});

test('question: shown in the panel, answered, journaled; Stop Run answers for the user', async () => {
  const s = await setup([]);
  try {
    const pending = s.trust.ask({ toolCallId: 'c1', threadId: 'main', name: 'ask_user_question', question: 'Which function?', options: ['add', 'sub'] });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(ofType(s.posts, 'question')[0], { type: 'question', question: 'Which function?', options: ['add', 'sub'] });
    assert.equal(s.trust.answer('add'), true);
    assert.equal(await pending, 'add');
    assert.equal(ofType(s.posts, 'questionDone').length, 1);
    assert.deepEqual(s.journal.all().filter((e) => e.t === 'question').map((e) => (e.t === 'question' ? [e.question, e.answer] : [])), [['Which function?', 'add']]);
    assert.equal(s.trust.answer('late'), false, 'no open question');
    const p2 = s.trust.ask({ toolCallId: 'c2', threadId: 'main', name: 'ask_user_question', question: 'Sure?' });
    s.trust.cancelQuestion();
    assert.equal(await p2, NO_ANSWER);
  } finally {
    await s.ws.cleanup();
  }
});

test('cost and speed: tokens summed over turns (latest total per turn), model switches, files read, elapsed', async () => {
  let now = 1_000;
  const journal = new Journal(new MemorySink());
  const posts: HostToWebview[] = [];
  const t = new TrustSession({ journal, post: (m) => posts.push(m), runTests: async () => PASS, index: async () => undefined, plan: () => undefined, now: () => now }, 'p/a');
  const ev = (e: unknown) => e as TurnEvent;
  t.onEvent(ev({ type: 'turn.created', id: 'e1', turnId: 't1' }));
  t.onEvent(ev({ type: 'turn.update', id: 'e2', state: { status: 'paused', metrics: { totalInputTokens: 100, totalOutputTokens: 10 } } }));
  t.onEvent(ev({ type: 'turn.done', id: 'e3', state: { status: 'done', metrics: { totalInputTokens: 250, totalOutputTokens: 30, totalCostInUsd: 0.001 } } }));
  t.onEvent(ev({ type: 'turn.created', id: 'e4', turnId: 't2' }));
  t.onEvent(ev({ type: 'turn.done', id: 'e5', state: { status: 'error', message: 'x', metrics: { totalInputTokens: 50, totalOutputTokens: 5 } } }));
  t.setModel('q/b');
  t.setReads(3, 120);
  now = 13_500;
  await t.finish();
  const m = ofType(posts, 'metrics').at(-1)!.metrics;
  assert.deepEqual(m, { model: 'q/b', inputTokens: 300, outputTokens: 35, costUsd: 0.001, read: 3, total: 120, startedAt: 1_000, elapsedMs: 12_500 });
  const j = journal.all().at(-1);
  assert.ok(j && j.t === 'metrics' && j.inputTokens === 300 && j.elapsedMs === 12_500 && j.filesRead === 3 && j.filesTotal === 120);
});

test('needsTestValidation: true when changes applied but tests not run after, false otherwise', async () => {
  const journal = new Journal(new MemorySink());
  const posts: HostToWebview[] = [];
  const t = new TrustSession({ journal, post: (m) => posts.push(m), runTests: async () => PASS, index: async () => undefined, plan: () => undefined }, 'p/a');
  assert.equal(t.needsTestValidation(), false, 'initially false');
  await t.onApplied({ opId: 'op1', groups: [{ intent: 'edit', files: ['a.py'] }] });
  assert.equal(t.needsTestValidation(), true, 'true after changes applied');
  await t.onAgentTests(true, 0);
  assert.equal(t.needsTestValidation(), false, 'false after tests run');
});

// ---------- ask_user_question through the real run loop ----------
const gen = (events: unknown[]) =>
  (async function* () {
    yield* events as TurnEvent[];
  })();
const askTurn = [
  { type: 'turn.created', id: 'e1', turnId: 't1', previousTurnId: null, state: { status: 'running' }, threadId: null },
  { type: 'model.message.delta', id: 'm1', threadId: 'main', toolCalls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'ask_user_question', arguments: '' } }] },
  { type: 'model.message.delta', id: 'm1', threadId: 'main', toolCalls: [{ index: 0, function: { arguments: '{"question":"Rename which function?","options":["add","sub"]}' } }] },
  { type: 'tool.response_required', id: 'e2', threadId: 'main', toolCalls: [{ id: 'call-1', sourceEventId: 'm1' }] },
  { type: 'turn.update', id: 'e3', threadId: null, state: { status: 'paused' } },
];

test('run loop: tool.response_required for ask_user_question is answered with user.tool_response and the SAME turn resumes', async () => {
  const sent: ApprovalInput[][] = [];
  const driver: TurnDriver = {
    start: () => gen(askTurn),
    resumePaused: (turnId, inputs, after) => {
      sent.push(inputs);
      assert.equal(turnId, 't1');
      assert.equal(after, 'e3');
      return gen([{ type: 'turn.done', id: 'e9', threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'm2', content: 'Renamed add.' }, requiredActions: [] } }]);
    },
    newTurnWithApprovals: () => gen([]),
  };
  const asked: unknown[] = [];
  const out = await runWithApprovals('rename it', { driver, approver: { approve: async () => ({ allow: true }) }, responder: { answer: async (q) => (asked.push(q), 'add') } });
  assert.deepEqual(out, { status: 'done', text: 'Renamed add.', rounds: 2, changesProposed: false, planSubmittedButNotProposed: false });
  assert.deepEqual(asked, [{ toolCallId: 'call-1', threadId: 'main', name: 'ask_user_question', question: 'Rename which function?', options: ['add', 'sub'] }]);
  assert.deepEqual(sent, [[{ type: 'user.tool_response', threadId: 'main', toolCallId: 'call-1', content: 'add' }]]);
});

test('run loop: without a responder the turn is "unsupported"; an unknown client tool gets an error result', async () => {
  const base = { start: () => gen(askTurn), newTurnWithApprovals: () => gen([]) };
  const unsupported = await runWithApprovals('x', { driver: { ...base, resumePaused: () => gen([]) }, approver: { approve: async () => ({ allow: true }) } });
  assert.equal(unsupported.status, 'unsupported');
  const other: unknown[] = [...askTurn];
  other[1] = { type: 'model.message.delta', id: 'm1', threadId: 'main', toolCalls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'open_browser', arguments: '' } }] };
  let content = '';
  const r = await runWithApprovals('x', {
    driver: { start: () => gen(other), newTurnWithApprovals: () => gen([]), resumePaused: (_t, inputs) => ((content = (inputs[0] as { content: string }).content), gen([{ type: 'turn.done', id: 'd', threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'm', content: 'ok' }, requiredActions: [] } }])) },
    approver: { approve: async () => ({ allow: true }) },
    responder: { answer: async () => assert.fail('only ask_user_question reaches the user') },
  });
  assert.equal(r.status, 'done');
  assert.match(content, /does not provide the client-side tool open_browser/);
});

// ---------- report, panel messages, fix mode ----------
test('report: what changed, why, what failed, how it recovered, models used, from the journal', async () => {
  const j = new Journal(new MemorySink(), () => Date.UTC(2026, 10, 21, 12, 0, 0));
  j.runId = 'run-9';
  await j.append({ t: 'run_started', request: 'add --env-file' });
  await j.append({ t: 'run_models', primary: 'google-gemini/a', fallback: 'google-gemini/b' });
  await j.append({ t: 'plan', summary: 'add the option', files: [{ path: 'src/flask/cli.py', action: 'edit' }] });
  await j.append({ t: 'provider_error', model: 'google-gemini/a', cls: 'rate_limit' });
  await j.append({ t: 'model_switched', from: 'google-gemini/a', to: 'google-gemini/b', reason: 'rate_limit' });
  await j.append({ t: 'op_applied', opId: 'op1', files: [{ path: 'src/flask/cli.py', intent: 'implement', before: 'h0', after: 'h1', accepted: 2, rejected: 1 }] });
  await j.append({ t: 'change_group', opId: 'op1', intent: 'implement', files: ['src/flask/cli.py'], reason: 'needed for the option', plain: 'This adds a new flag.', confidence: 'check this', why: ['medium-sized change (60 lines)'], tests: 'passed (real run)' });
  await j.append({ t: 'regression', tests: ['tests/test_cli.py::test_x'] });
  await j.append({ t: 'autofix', status: 'fixed', detail: 'tests/test_cli.py::test_x pass again' });
  await j.append({ t: 'metrics', model: 'google-gemini/b', inputTokens: 1200, outputTokens: 80, elapsedMs: 42_000, filesRead: 4, filesTotal: 90 });
  await j.append({ t: 'run_finished', status: 'done' });
  assert.equal(latestRunId(j.all()), 'run-9');
  const md = renderRunReport(j.all(), 'run-9');
  for (const re of [
    /## What changed[\s\S]*src\/flask\/cli\.py \[implement\] 2 hunk\(s\) accepted, 1 rejected[\s\S]*\*\*check this\*\*: This adds a new flag\. Tests: passed \(real run\)\. Deciding rule: medium-sized change/,
    /## Why\n\nPlan: add the option[\s\S]*\[implement\] src\/flask\/cli\.py: needed for the option/,
    /## What failed[\s\S]*provider error on google-gemini\/a: rate limit[\s\S]*tests that passed before now fail: tests\/test_cli\.py::test_x/,
    /## How it recovered[\s\S]*switched from google-gemini\/a to google-gemini\/b \(rate limit\)[\s\S]*automatic fix: fixed/,
    /## Models used\n\n- Configured: primary google-gemini\/a, fallback google-gemini\/b\n- Answered by: google-gemini\/b/,
    /Tokens: 1200 input, 80 output[\s\S]*Elapsed: 42\.0 s[\s\S]*Files read: 4 of 90/,
  ])
    assert.match(md, re);
});

test('panel messages: answer is length-checked; rollback and export take no parameters', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'answer', text: ' add ' }), { type: 'answer', text: 'add' });
  assert.equal(parseWebviewMessage({ type: 'answer', text: '' }), undefined);
  assert.equal(parseWebviewMessage({ type: 'answer', text: 'x'.repeat(2001) }), undefined);
  assert.equal(parseWebviewMessage({ type: 'answer', text: 'a', extra: 1 }), undefined);
  assert.deepEqual(parseWebviewMessage({ type: 'rollback' }), { type: 'rollback' });
  assert.equal(parseWebviewMessage({ type: 'rollback', to: 0 }), undefined, 'the checkpoint is never taken from the webview');
  assert.deepEqual(parseWebviewMessage({ type: 'exportReport' }), { type: 'exportReport' });
});

test('fix mode: the plan is kept, stop counters cleared, exactly one reviewed proposal allowed', () => {
  const p = new PlanStore();
  p.set({ summary: 's', files: [{ path: 'a.py', action: 'edit', why: 'w' }] });
  p.noteTests(false);
  p.noteTests(false);
  p.noteTests(false);
  assert.match(p.check(['a.py'])!, /tests failed 3 times/);
  p.startFix(1);
  assert.equal(p.check(['a.py']), undefined);
  p.noteOutcome('refused');
  assert.equal(p.check(['a.py']), undefined, 'a refused proposal does not use up the fix');
  p.noteOutcome('rejected');
  assert.match(p.check(['a.py'])!, /exactly one proposal/);
  p.reset();
  p.set({ summary: 's', files: [{ path: 'a.py', action: 'edit', why: 'w' }] });
  assert.equal(p.check(['a.py']), undefined);
});
