// A model that calls the editor tools by name (not through TrueForge's call_tool) gets "Tool X not found in tool
// mapping" back for every call. Observed live with gemini-3-1-flash-lite on 2026-11-22 (task2 on 1b101e0): 89 such
// replies, then the turn ended "done" and the fallback never ran. Two in one run now count as a provider failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TurnEvent } from '../src/trueforge/client';
import { AgentAttempt, SwitchInfo, runWithFailover } from '../src/trueforge/failover';
import { RETRY_BUDGET, classifyError, failoverBanner, failureMessage, isLocalError } from '../src/trueforge/errors';
import { AGENT_INSTRUCTIONS } from '../src/trueforge/config';
import { TOOL_MAPPING_LIMIT, TurnDriver, runWithApprovals } from '../src/trueforge/run';

const ev = (e: unknown): TurnEvent => e as TurnEvent;
const gen = (events: TurnEvent[]) =>
  (async function* () {
    yield* events;
  })();
const notMapped = (n: number, tool = 'list_files'): TurnEvent[] =>
  Array.from({ length: n }, (_, i) => [
    ev({ type: 'model.message', id: `m${i}`, toolCalls: [{ id: `c${i}`, type: 'function', function: { name: tool, arguments: '{}' } }] }),
    ev({ type: 'tool.response', id: `r${i}`, toolCallId: `c${i}`, content: `Tool ${tool} not found in tool mapping`, threadId: 'main' }),
  ]).flat();
const apology = ev({ type: 'turn.done', id: 'd', threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'x', content: 'tools unavailable, sorry' }, requiredActions: [] } });
const okTurn = (text: string): TurnEvent[] => [ev({ type: 'turn.created', id: 'a', turnId: 'T' }), ev({ type: 'turn.done', id: 'b', threadId: null, state: { status: 'done', output: { type: 'model.message', id: 'm', content: text }, requiredActions: [] } })];
const approver = { approve: async () => ({ allow: true }) };

function driverOf(events: TurnEvent[], log: string[]): TurnDriver {
  return {
    start: () => gen(events),
    resumePaused: () => gen([]),
    newTurnWithApprovals: () => gen([]),
    cancel: async () => {
      log.push('cancel');
    },
  };
}

test('tool mapping: 2 "not found in tool mapping" replies end the run as an error and cancel the session', async () => {
  assert.equal(TOOL_MAPPING_LIMIT, 2);
  const log: string[] = [];
  const r = await runWithApprovals('go', { driver: driverOf([ev({ type: 'turn.created', id: 't', turnId: 'T' }), ...notMapped(5), apology], log), approver });
  assert.equal(r.status, 'error');
  assert.match((r as { message: string }).message, /Tool list_files not found in tool mapping \(2 times in this run\)/);
  assert.deepEqual(log, ['cancel'], 'the abandoned TrueForge session is cancelled so it stops spending quota');
});

test('tool mapping: a single slip is tolerated; the run continues normally', async () => {
  const r = await runWithApprovals('go', { driver: driverOf([ev({ type: 'turn.created', id: 't', turnId: 'T' }), ...notMapped(1), apology], []), approver });
  assert.equal(r.status, 'done');
});

test('tool mapping: classified as a provider failure (no retry, not local), so it fails over with a plain banner', async () => {
  const msg = 'Tool list_files not found in tool mapping (2 times in this run): the model called the editor tools by name instead of through call_tool';
  assert.equal(classifyError(msg).cls, 'tool_not_mapped');
  assert.equal(RETRY_BUDGET.tool_not_mapped, 0);
  assert.equal(isLocalError('tool_not_mapped'), false);
  assert.equal(
    failoverBanner('google-gemini/gemini-3-1-flash-lite', 'google-gemini/gemini-3-5-flash-lite', msg),
    'The primary model google-gemini/gemini-3-1-flash-lite stopped because it called the editor tools in a way TrueForge cannot route (tool not found in tool mapping). CodeCraft switched to the fallback model google-gemini/gemini-3-5-flash-lite automatically and is continuing your request.',
  );
  assert.match(failureMessage('m', msg), /Nothing was changed in your files\.$/);
});

test('tool mapping: the primary fails over to the fallback, which answers; nothing ran on the primary', async () => {
  const switched: SwitchInfo[] = [];
  const log: string[] = [];
  const attempts: AgentAttempt[] = [
    { agent: 'primary', model: 'google-gemini/gemini-3-1-flash-lite', driver: async () => driverOf([ev({ type: 'turn.created', id: 't', turnId: 'T' }), ...notMapped(3, 'read_file'), apology], log) },
    { agent: 'fallback', model: 'google-gemini/gemini-3-5-flash-lite', driver: async () => driverOf(okTurn('done by fallback'), log) },
  ];
  const approvals: string[] = [];
  const r = await runWithFailover('do it', attempts, { approver: { approve: async (c) => (approvals.push(c.name), { allow: true }) }, onSwitch: (s) => switched.push(s) });
  assert.equal(r.agent, 'fallback');
  assert.equal(r.outcome.status, 'done');
  assert.equal(switched.length, 1);
  assert.match(switched[0]!.reason, /not found in tool mapping/);
  assert.deepEqual(approvals, [], 'no approval (so no write) happened on the primary');
  assert.deepEqual(log, ['cancel'], 'only the primary session was cancelled');
});

test('agent instructions: editor tools only through call_tool, never by name (task wording untouched)', () => {
  assert.match(AGENT_INSTRUCTIONS, /ONLY through the call_tool tool with \{"mcp_server": "codecraft-editor", "tool_name": "<tool>", "input": \{\.\.\.\}\}; never call them by name directly/);
});
