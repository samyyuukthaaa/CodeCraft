// The scripted streams below replay the event shapes observed live from TrueForge 0.185.1
// (docs/TRUEFORGE_NOTES.md): tool calls only in model.message.delta fragments, MCP tools wrapped in the
// `call_tool` system tool, and an approval pause that is `tool.approval_required` + `turn.update paused`
// on a stream that stays open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalInput, TurnEvent } from '../src/trueforge/client';
import { manifestFor, manifestMatches } from '../src/trueforge/client';
import { APPROVAL_TOOLS, EDITOR_SERVER_NAME } from '../src/mcp/constants';
import { PendingToolCall, TurnDriver, resolveCall, runWithApprovals, summarizeCall } from '../src/trueforge/run';

const ev = (e: unknown): TurnEvent => e as TurnEvent;

/** Two delta fragments for one call_tool call, exactly as TrueForge streams them. */
function callToolDeltas(msgId: string, callId: string, tool: string, input: object): TurnEvent[] {
  const args = JSON.stringify({ tool_name: tool, input, mcp_server: EDITOR_SERVER_NAME });
  return [
    ev({ type: 'model.message', id: msgId, threadId: 'main' }),
    ev({ type: 'model.message.delta', id: msgId, threadId: 'main', toolCalls: [{ index: 0, id: callId, type: 'function', toolInfo: { type: 'truefoundry-system', name: 'call_tool' }, function: { name: 'call_tool', arguments: '' } }] }),
    ev({ type: 'model.message.delta', id: msgId, threadId: 'main', toolCalls: [{ index: 0, function: { arguments: args.slice(0, 20) } }] }),
    ev({ type: 'model.message.delta', id: msgId, threadId: 'main', toolCalls: [{ index: 0, function: { arguments: args.slice(20) } }] }),
  ];
}

const pausedStart = (callId: string, tool: string, input: object): TurnEvent[] => [
  ev({ type: 'turn.created', id: 'e1', turnId: 'TURN1', state: { status: 'running' } }),
  ...callToolDeltas('m1', callId, tool, input),
  ev({ type: 'tool.approval_required', id: 'e9', threadId: 'main', toolCalls: [{ id: callId, sourceEventId: 'm1' }] }),
  ev({ type: 'turn.update', id: 'e10', threadId: null, state: { status: 'paused' } }),
  // the live stream stays open here; anything after the pause must not be consumed
  ev({ type: 'turn.done', id: 'NEVER', threadId: null, state: { status: 'error', message: 'must not be read' } }),
];

const finish = (text: string): TurnEvent[] => [
  ev({ type: 'tool.response', id: 'e11', threadId: 'main', toolCallId: 'c1', content: '{}' }),
  ev({ type: 'turn.done', id: 'e12', threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'm2', content: text }, requiredActions: [] } }),
];

interface Recorder {
  driver: TurnDriver;
  calls: Array<{ kind: string; turnId?: string; approvals?: ApprovalInput[]; afterEventId?: string }>;
}

function fakeDriver(start: TurnEvent[], resumes: TurnEvent[][]): Recorder {
  const calls: Recorder['calls'] = [];
  let r = 0;
  const gen = (events: TurnEvent[]) =>
    (async function* () {
      yield* events;
    })();
  return {
    calls,
    driver: {
      start(text) {
        calls.push({ kind: `start:${text}` });
        return gen(start);
      },
      resumePaused(turnId, approvals, afterEventId) {
        calls.push({ kind: 'resumePaused', turnId, approvals, afterEventId });
        return gen(resumes[r++] ?? []);
      },
      newTurnWithApprovals(approvals) {
        calls.push({ kind: 'newTurn', approvals });
        return gen(resumes[r++] ?? []);
      },
    },
  };
}

test('run: live-shaped pause -> approve -> resume the SAME turn after the last seen event', async () => {
  const f = fakeDriver(pausedStart('c1', 'propose_write', { path: 'hello.txt', newContent: 'TOPSECRET BODY', reason: 'rename' }), [finish('applied 1 of 1 hunk(s)')]);
  const asked: PendingToolCall[] = [];
  const out = await runWithApprovals('go', {
    driver: f.driver,
    approver: {
      async approve(c) {
        asked.push(c);
        return { allow: true };
      },
    },
  });
  assert.deepEqual(out, { status: 'done', text: 'applied 1 of 1 hunk(s)', rounds: 2 });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], {
    kind: 'resumePaused',
    turnId: 'TURN1',
    afterEventId: 'e10',
    approvals: [{ type: 'user.tool_approval', threadId: 'main', toolCallId: 'c1', approval: { status: 'allow' } }],
  });
  assert.equal(asked[0]!.name, `${EDITOR_SERVER_NAME}/propose_write`);
  assert.match(asked[0]!.summary, /path=hello\.txt reason=rename/);
  assert.doesNotMatch(asked[0]!.summary, /TOPSECRET/);
});

test('run: deny is sent to the paused turn with a reason and the run continues', async () => {
  const f = fakeDriver(pausedStart('c1', 'run_tests', {}), [finish('ok, not running tests')]);
  const out = await runWithApprovals('go', { driver: f.driver, approver: { approve: async () => ({ allow: false, reason: 'no' }) } });
  assert.equal(out.status, 'done');
  assert.deepEqual(f.calls[1]!.approvals, [{ type: 'user.tool_approval', threadId: 'main', toolCallId: 'c1', approval: { status: 'deny', reason: 'no' } }]);
});

test('run: two pauses in one turn are each resumed', async () => {
  const second: TurnEvent[] = [
    ...callToolDeltas('m3', 'c2', 'run_tests', {}),
    ev({ type: 'tool.approval_required', id: 'e20', threadId: 'main', toolCalls: [{ id: 'c2', sourceEventId: 'm3' }] }),
    ev({ type: 'turn.update', id: 'e21', threadId: null, state: { status: 'paused' } }),
  ];
  const f = fakeDriver(pausedStart('c1', 'propose_write', { path: 'a', newContent: 'x', reason: 'r' }), [second, finish('done')]);
  const names: string[] = [];
  const out = await runWithApprovals('go', {
    driver: f.driver,
    approver: {
      async approve(c) {
        names.push(c.name);
        return { allow: true };
      },
    },
  });
  assert.equal(out.status, 'done');
  assert.deepEqual(names, [`${EDITOR_SERVER_NAME}/propose_write`, `${EDITOR_SERVER_NAME}/run_tests`]);
  assert.deepEqual(f.calls.map((c) => `${c.kind}:${c.afterEventId ?? ''}`), ['start:go:', 'resumePaused:e10', 'resumePaused:e21']);
});

test('run: turn.done with required actions resumes with a NEW turn carrying the approvals', async () => {
  const doneWithAction: TurnEvent[] = [
    ev({ type: 'turn.created', id: 'e1', turnId: 'T' }),
    ...callToolDeltas('m1', 'c1', 'run_tests', {}),
    ev({ type: 'turn.done', id: 'e5', threadId: null, state: { status: 'done', output: null, requiredActions: [{ type: 'tool.approval_required', id: 'a', threadId: 'main', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] }] } }),
  ];
  const f = fakeDriver(doneWithAction, [finish('fine')]);
  const out = await runWithApprovals('go', { driver: f.driver, approver: { approve: async () => ({ allow: true }) } });
  assert.equal(out.status, 'done');
  assert.equal(f.calls[1]!.kind, 'newTurn');
});

test('run: provider error, cancel, abort, truncated stream and client tools are never successes', async () => {
  const approve = { approve: async () => ({ allow: true }) };
  const err = fakeDriver([ev({ type: 'turn.done', id: 'd', threadId: null, state: { status: 'error', message: '[Model Error] Request failed (503): high demand' } })], []);
  const e = await runWithApprovals('go', { driver: err.driver, approver: approve });
  assert.equal(e.status, 'error');
  assert.match((e as { message: string }).message, /503/);

  const cancelled = fakeDriver([ev({ type: 'turn.done', id: 'd', threadId: null, state: { status: 'cancelled', reason: 'user' } })], []);
  assert.equal((await runWithApprovals('go', { driver: cancelled.driver, approver: approve })).status, 'cancelled');

  const ac = new AbortController();
  ac.abort();
  const aborted = fakeDriver([], []);
  assert.equal((await runWithApprovals('go', { driver: aborted.driver, signal: ac.signal, approver: approve })).status, 'cancelled');
  assert.equal(aborted.calls.length, 0);

  const truncated = fakeDriver([ev({ type: 'turn.created', id: 't', turnId: 'T' })], []);
  assert.equal((await runWithApprovals('go', { driver: truncated.driver, approver: approve })).status, 'error');

  const pausedNoAction = fakeDriver([ev({ type: 'turn.created', id: 't', turnId: 'T' }), ev({ type: 'turn.update', id: 'u', threadId: null, state: { status: 'paused' } })], []);
  assert.equal((await runWithApprovals('go', { driver: pausedNoAction.driver, approver: approve })).status, 'error');

  const clientTool = fakeDriver([ev({ type: 'tool.response_required', id: 'r', threadId: 'main', toolCalls: [{ id: 'c', sourceEventId: 'm' }] }), ev({ type: 'turn.done', id: 'd', threadId: null, state: { status: 'done', output: null, requiredActions: [] } })], []);
  assert.equal((await runWithApprovals('go', { driver: clientTool.driver, approver: approve })).status, 'unsupported');
});

test('run: gives up after maxRounds so an approval loop cannot run forever', async () => {
  const again = pausedStart('c1', 'run_tests', {});
  const f = fakeDriver(again, [again, again, again]);
  const out = await runWithApprovals('go', { driver: f.driver, maxRounds: 3, approver: { approve: async () => ({ allow: true }) } });
  assert.equal(out.status, 'error');
  assert.equal(out.rounds, 3);
});

test('resolveCall/summarizeCall: unwraps call_tool; never shows file content; tolerates bad JSON', () => {
  const args = JSON.stringify({ tool_name: 'propose_write', mcp_server: 'codecraft-editor', input: { path: 'x', newContent: 'TOPSECRETBODY', reason: 'r' } });
  assert.deepEqual(resolveCall('call_tool', args).tool, 'propose_write');
  const s = summarizeCall('call_tool', args);
  assert.equal(s.name, 'codecraft-editor/propose_write');
  assert.doesNotMatch(s.summary, /TOPSECRETBODY/);
  assert.equal(summarizeCall('call_tool', '{bad').summary, '(arguments not parseable)');
  assert.equal(summarizeCall('list_tools', '{"mcp_server":"codecraft-editor"}').name, 'list_tools');
});

test('manifestMatches: a stored manifest with server-filled defaults (observed live) counts as unchanged', () => {
  const wanted = manifestFor('groq/gpt-oss-120b');
  const stored = {
    ...wanted,
    mcpServers: [{ name: EDITOR_SERVER_NAME, enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: ['propose_write', 'propose_changes', 'run_tests'], preload: false }],
    config: {
      iterationLimit: 60,
      dynamicSubAgents: { enabled: false },
      askUserQuestions: { enabled: true },
      contextManagement: { compaction: { enabled: true, trigger: { type: 'input_tokens', value: 48000 } }, largeToolResponse: { enabled: true } },
      sandbox: { enabled: false, fileDownloads: true },
      memory: { enabled: false },
    },
  };
  assert.equal(manifestMatches(stored as typeof wanted, wanted), true);
  // P5 enables ask_user_question: an agent stored with it disabled (before P5) is updated
  assert.equal(manifestMatches({ ...stored, config: { ...stored.config, askUserQuestions: { enabled: false } } } as typeof wanted, wanted), false);
  // the server's own defaults (512 iterations, sub-agents on) are NOT what CodeCraft wants
  assert.equal(manifestMatches({ ...stored, config: { iterationLimit: 512, dynamicSubAgents: { enabled: true } } } as typeof wanted, wanted), false);
  assert.equal(manifestMatches({ ...stored, config: undefined } as typeof wanted, wanted), false);
  assert.equal(manifestMatches({ ...stored, mcpServers: [{ name: EDITOR_SERVER_NAME, requireApprovalForTools: ['propose_write'] }] } as typeof wanted, wanted), false);
  assert.equal(manifestMatches({ ...stored, model: { name: 'other/model' } } as typeof wanted, wanted), false);
  assert.equal(manifestMatches({ ...stored, instructions: 'old' } as typeof wanted, wanted), false);
});

test('manifest: both agents mount the editor server with approval required for propose_write, propose_changes and run_tests', () => {
  for (const model of ['a/b', 'c/d']) {
    assert.deepEqual(manifestFor(model).mcpServers, [{ name: EDITOR_SERVER_NAME, requireApprovalForTools: ['propose_write', 'propose_changes', 'run_tests'] }]);
  }
  assert.deepEqual([...APPROVAL_TOOLS], ['propose_write', 'propose_changes', 'run_tests']);
});
