// Ask-user questions in non-interactive runs (scenario runner, probe): answered automatically with a fixed reply,
// the same turn resumes, each answer is reported, and the third question stops the run. The interactive panel's
// responder is unchanged (it gets the question and options and its answer is sent back, with no limit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { TurnEvent } from '../src/trueforge/client';
import { ASK_LIMIT_MESSAGE, AUTO_ANSWER, AUTO_ASK_LIMIT, autoResponder } from '../src/trueforge/autoAnswer';
import { AGENT_INSTRUCTIONS } from '../src/trueforge/config';
import { AgentAttempt, runWithFailover } from '../src/trueforge/failover';
import { ApprovalInput, ClientToolCall, Responder, TurnDriver, runWithApprovals } from '../src/trueforge/run';

const ev = (e: unknown): TurnEvent => e as TurnEvent;
const gen = (events: TurnEvent[]) =>
  (async function* () {
    yield* events;
  })();
/** One paused turn segment in which the agent calls ask_user_question. */
const askSegment = (i: number): TurnEvent[] => [
  ev({ type: 'turn.created', id: `t${i}`, turnId: 'T' }),
  ev({ type: 'model.message', id: `m${i}`, toolCalls: [{ id: `q${i}`, type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ question: `Which file ${i}?`, options: ['a', 'b'] }) } }] }),
  ev({ type: 'tool.response_required', id: `r${i}`, threadId: 'main', toolCalls: [{ id: `q${i}` }] }),
  ev({ type: 'turn.update', id: `u${i}`, state: { status: 'paused' } }),
];
const doneSegment: TurnEvent[] = [ev({ type: 'turn.done', id: 'd', threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'x', content: 'finished' }, requiredActions: [] } })];

/** A driver whose turn asks `asks` questions, one per paused segment, then finishes. Records the resumes. */
function asker(asks: number, log: { resumed: ApprovalInput[][]; cancelled: number }): TurnDriver {
  let seg = 0;
  const next = () => gen(seg < asks ? askSegment(++seg) : doneSegment);
  return {
    start: () => next(),
    resumePaused: (turnId, approvals) => {
      assert.equal(turnId, 'T', 'the SAME turn is resumed');
      log.resumed.push(approvals);
      return next();
    },
    newTurnWithApprovals: () => gen([]),
    cancel: async () => {
      log.cancelled++;
    },
  };
}
const approver = { approve: async () => ({ allow: true }) };

test('auto-answer: each question gets the fixed reply, the same turn resumes, and every answer is reported', async () => {
  const log = { resumed: [] as ApprovalInput[][], cancelled: 0 };
  const seen: Array<{ q: string; reply: string; n: number }> = [];
  const r = await runWithApprovals('go', { driver: asker(2, log), approver, responder: autoResponder((c, reply, n) => seen.push({ q: c.question ?? '', reply, n })) });
  assert.equal(r.status, 'done');
  assert.equal(AUTO_ANSWER, 'Proceed with your best judgment, make reasonable assumptions and do not ask again.');
  assert.deepEqual(seen, [
    { q: 'Which file 1?', reply: AUTO_ANSWER, n: 1 },
    { q: 'Which file 2?', reply: AUTO_ANSWER, n: 2 },
  ]);
  assert.equal(log.resumed.length, 2);
  for (const approvals of log.resumed) assert.deepEqual(approvals.map((a) => (a as { type: string; content?: string }).content), [AUTO_ANSWER]);
  assert.equal(log.cancelled, 0);
});

test('auto-answer cap: the third question in one run stops it with a clear message (no failover), session cancelled', async () => {
  assert.equal(AUTO_ASK_LIMIT, 3);
  const log = { resumed: [] as ApprovalInput[][], cancelled: 0 };
  const r = await runWithApprovals('go', { driver: asker(5, log), approver, responder: autoResponder() });
  assert.equal(r.status, 'unsupported');
  assert.equal((r as { message: string }).message, ASK_LIMIT_MESSAGE);
  assert.match(ASK_LIMIT_MESSAGE, /asked the user 3 questions in one non-interactive run/);
  assert.equal(log.resumed.length, 2, 'two answered, the third stops');
  assert.equal(log.cancelled, 1);
  // unsupported never fails over: the fallback is not tried
  const created: string[] = [];
  const attempt = (agent: string, d: TurnDriver): AgentAttempt => ({ agent, model: `${agent}-m`, driver: async () => (created.push(agent), d) });
  const f = await runWithFailover('go', [attempt('primary', asker(5, { resumed: [], cancelled: 0 })), attempt('fallback', asker(0, { resumed: [], cancelled: 0 }))], { approver, responder: autoResponder() });
  assert.equal(f.outcome.status, 'unsupported');
  assert.deepEqual(created, ['primary']);
});

test('auto-answer cap counts across the whole run (one responder per run), not per turn or retry', () => {
  const r = autoResponder();
  assert.equal(r.stopBeforeAnswer?.(), undefined);
  assert.equal(r.stopBeforeAnswer?.(), undefined);
  assert.equal(r.stopBeforeAnswer?.(), ASK_LIMIT_MESSAGE);
});

test('interactive path unchanged: the panel responder gets the question and options, its answer is sent, no limit', async () => {
  const log = { resumed: [] as ApprovalInput[][], cancelled: 0 };
  const asked: ClientToolCall[] = [];
  const panel: Responder = { answer: async (c) => (asked.push(c), `user answer ${asked.length}`) };
  const r = await runWithApprovals('go', { driver: asker(5, log), approver, responder: panel });
  assert.equal(r.status, 'done', 'five questions, all answered by the user, no cap');
  assert.equal(asked.length, 5);
  assert.deepEqual({ q: asked[0]!.question, o: asked[0]!.options }, { q: 'Which file 1?', o: ['a', 'b'] });
  assert.equal((log.resumed[4]![0] as { content?: string }).content, 'user answer 5');
  // the extension still passes its own panel responder (trust.ask), not the auto-responder
  const ext = fs.readFileSync('src/extension.ts', 'utf8');
  assert.match(ext, /responder: \{ answer: async \(q\) => \(trust \? trust\.ask\(q\) : NO_ANSWER\) \}/);
  assert.doesNotMatch(ext, /autoResponder/);
  // non-interactive runs use it
  assert.match(fs.readFileSync('test/scenarios/harness.ts', 'utf8'), /responder: autoResponder\(/);
  assert.match(fs.readFileSync('test/scenarios/probe.ts', 'utf8'), /responder: autoResponder\(/);
});

test('agent instructions: no questions for a clear goal; assumptions go in the plan', () => {
  assert.ok(AGENT_INSTRUCTIONS.includes('Do not ask the user questions when the request names a clear goal: make reasonable assumptions and state them in your plan (submit_plan). Ask only if the request is impossible to carry out without the answer.'));
});
