import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TurnEvent, TurnInput } from '../src/trueforge/client';
import { manifestFor } from '../src/trueforge/client';
import { APPROVAL_TOOLS, EDITOR_SERVER_NAME } from '../src/mcp/constants';
import { PendingToolCall, StreamFn, runWithApprovals, summarizeArgs } from '../src/trueforge/run';

const ev = (e: unknown): TurnEvent => e as TurnEvent;

const toolCall = (id: string, name: string, args: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** A scripted stream: each call to stream() returns the next scripted turn and records its input. */
function script(turns: TurnEvent[][]): { stream: StreamFn; inputs: TurnInput[][] } {
  const inputs: TurnInput[][] = [];
  let i = 0;
  const stream: StreamFn = (input) => {
    inputs.push(input);
    const events = turns[i++] ?? [];
    return (async function* () {
      yield* events;
    })();
  };
  return { stream, inputs };
}

const pausedTurn = (callId: string, name: string, args: object): TurnEvent[] => [
  ev({ type: 'turn.created', id: 't1', turnId: 'T1' }),
  ev({ type: 'model.message', id: 'm1', threadId: 'th', toolCalls: [toolCall(callId, name, args)] }),
  ev({ type: 'tool.approval_required', id: 'a1', threadId: 'th', toolCalls: [{ id: callId, sourceEventId: 'm1' }] }),
  ev({
    type: 'turn.done',
    id: 'd1',
    threadId: null,
    state: {
      status: 'done',
      output: { type: 'model.message', id: 'm1', content: null, toolCalls: [toolCall(callId, name, args)] },
      requiredActions: [{ type: 'tool.approval_required', id: 'a1', threadId: 'th', toolCalls: [{ id: callId, sourceEventId: 'm1' }] }],
    },
  }),
];

const finalTurn = (text: string): TurnEvent[] => [
  ev({ type: 'turn.created', id: 't2', turnId: 'T2' }),
  ev({ type: 'turn.done', id: 'd2', threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'm2', content: text }, requiredActions: [] } }),
];

test('run: approval pause resumes with a NEW turn carrying user.tool_approval(allow)', async () => {
  const { stream, inputs } = script([pausedTurn('c1', 'codecraft-editor__propose_write', { path: 'a.txt', newContent: 'SECRET BODY', reason: 'fix' }), finalTurn('applied 1 of 1 hunk(s)')]);
  const asked: PendingToolCall[] = [];
  const out = await runWithApprovals('go', {
    stream,
    approver: {
      async approve(c) {
        asked.push(c);
        return { allow: true };
      },
    },
  });
  assert.deepEqual(out, { status: 'done', text: 'applied 1 of 1 hunk(s)', rounds: 2 });
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], [{ type: 'user.message', content: 'go' }]);
  assert.deepEqual(inputs[1], [{ type: 'user.tool_approval', threadId: 'th', toolCallId: 'c1', approval: { status: 'allow' } }]);
  // the approval prompt shows path and reason, never the file content
  assert.match(asked[0]!.summary, /path=a\.txt/);
  assert.doesNotMatch(asked[0]!.summary, /SECRET BODY/);
});

test('run: a denied call is sent back as deny with a reason, and the run continues', async () => {
  const { stream, inputs } = script([pausedTurn('c1', 'run_tests', {}), finalTurn('the user declined')]);
  const out = await runWithApprovals('go', { stream, approver: { approve: async () => ({ allow: false, reason: 'no thanks' }) } });
  assert.equal(out.status, 'done');
  assert.deepEqual(inputs[1], [{ type: 'user.tool_approval', threadId: 'th', toolCallId: 'c1', approval: { status: 'deny', reason: 'no thanks' } }]);
});

test('run: a provider error is reported as an error, never as success', async () => {
  const { stream } = script([[ev({ type: 'turn.done', id: 'd', threadId: null, state: { status: 'error', message: '[Model Error] Request failed (503): high demand' } })]]);
  const out = await runWithApprovals('go', { stream, approver: { approve: async () => ({ allow: true }) } });
  assert.equal(out.status, 'error');
  assert.match((out as { message: string }).message, /503/);
});

test('run: cancelled turn, aborted signal, missing turn.done and client-tool requests are not successes', async () => {
  const cancelled = script([[ev({ type: 'turn.done', id: 'd', threadId: null, state: { status: 'cancelled', reason: 'user' } })]]);
  assert.equal((await runWithApprovals('go', { stream: cancelled.stream, approver: { approve: async () => ({ allow: true }) } })).status, 'cancelled');

  const ac = new AbortController();
  ac.abort();
  const aborted = script([[]]);
  assert.equal((await runWithApprovals('go', { stream: aborted.stream, signal: ac.signal, approver: { approve: async () => ({ allow: true }) } })).status, 'cancelled');
  assert.equal(aborted.inputs.length, 0);

  const truncated = script([[ev({ type: 'turn.created', id: 't', turnId: 'T' })]]);
  assert.equal((await runWithApprovals('go', { stream: truncated.stream, approver: { approve: async () => ({ allow: true }) } })).status, 'error');

  const clientTool = script([
    [ev({ type: 'tool.response_required', id: 'r', threadId: 'th', toolCalls: [{ id: 'c', sourceEventId: 'm' }] }), ev({ type: 'turn.done', id: 'd', threadId: null, state: { status: 'done', output: null, requiredActions: [] } })],
  ]);
  assert.equal((await runWithApprovals('go', { stream: clientTool.stream, approver: { approve: async () => ({ allow: true }) } })).status, 'unsupported');
});

test('run: gives up after maxRounds so an approval loop cannot run forever', async () => {
  const turns = Array.from({ length: 5 }, () => pausedTurn('c1', 'run_tests', {}));
  const { stream } = script(turns);
  const out = await runWithApprovals('go', { stream, maxRounds: 3, approver: { approve: async () => ({ allow: true }) } });
  assert.equal(out.status, 'error');
  assert.equal(out.rounds, 3);
});

test('summarizeArgs: never includes file content; tolerates bad JSON', () => {
  assert.doesNotMatch(summarizeArgs('propose_write', JSON.stringify({ path: 'x', newContent: 'TOPSECRETBODY', reason: 'r' })), /TOPSECRETBODY/);
  assert.equal(summarizeArgs('propose_write', '{not json'), '(arguments not parseable)');
});

test('manifest: both agents mount the editor server with approval required for propose_write and run_tests', () => {
  for (const model of ['a/b', 'c/d']) {
    const m = manifestFor(model);
    assert.deepEqual(m.mcpServers, [{ name: EDITOR_SERVER_NAME, requireApprovalForTools: ['propose_write', 'run_tests'] }]);
  }
  assert.deepEqual([...APPROVAL_TOOLS], ['propose_write', 'run_tests']);
});
