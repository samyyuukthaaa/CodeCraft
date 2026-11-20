// Runs a prompt to completion, treating TrueForge's approval pauses as normal: when a turn ends with
// tool.approval_required, ask the user, then resume with a NEW turn carrying user.tool_approval items.
// Pure with respect to VS Code and the SDK client: the stream function and the approver are injected.
import { redact } from '../util/redact';
import type { TurnEvent, TurnInput } from './client';

export interface PendingToolCall {
  toolCallId: string;
  threadId: string;
  /** Tool name as the model called it (e.g. propose_write). */
  name: string;
  /** Short, redacted summary of the arguments. Never the full file content. */
  summary: string;
}

export interface ApprovalDecision {
  allow: boolean;
  reason?: string;
}

export interface Approver {
  approve(call: PendingToolCall): Promise<ApprovalDecision>;
}

export type StreamFn = (input: TurnInput[], signal?: AbortSignal) => AsyncIterable<TurnEvent>;

export type RunOutcome =
  | { status: 'done'; text: string; rounds: number }
  | { status: 'error'; message: string; rounds: number }
  | { status: 'cancelled'; rounds: number }
  | { status: 'unsupported'; message: string; rounds: number };

export interface RunOptions {
  stream: StreamFn;
  approver: Approver;
  onEvent?: (ev: TurnEvent) => void;
  signal?: AbortSignal;
  maxRounds?: number;
}

interface ToolCallLike {
  id: string;
  function?: { name?: string; arguments?: string };
}

/** Builds a short description of a call. For propose_write only the path and reason are shown. */
export function summarizeArgs(name: string, rawArgs: string | undefined): string {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return '(arguments not parseable)';
  }
  const str = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');
  if (name.endsWith('propose_write')) return redact(`path=${str('path')} reason=${str('reason').slice(0, 160)}`);
  if (name.endsWith('run_tests')) return 'run the project test command';
  return redact(JSON.stringify(args).slice(0, 200));
}

export async function runWithApprovals(text: string, opts: RunOptions): Promise<RunOutcome> {
  const max = opts.maxRounds ?? 25;
  let input: TurnInput[] = [{ type: 'user.message', content: text }];
  for (let round = 1; round <= max; round++) {
    if (opts.signal?.aborted) return { status: 'cancelled', rounds: round };
    const calls = new Map<string, ToolCallLike>(); // tool call id -> call
    const pending = new Map<string, { threadId: string }>();
    let unsupported = false;
    let done: Extract<TurnEvent, { type: 'turn.done' }>['state'] | undefined;

    for await (const ev of opts.stream(input, opts.signal)) {
      opts.onEvent?.(ev);
      if (ev.type === 'model.message' && ev.toolCalls) {
        for (const tc of ev.toolCalls) calls.set(tc.id, tc as ToolCallLike);
      } else if (ev.type === 'tool.approval_required') {
        for (const tc of ev.toolCalls) pending.set(tc.id, { threadId: ev.threadId });
      } else if (ev.type === 'tool.response_required') {
        unsupported = true; // CodeCraft registers no client-side tools
      } else if (ev.type === 'turn.done') {
        done = ev.state;
      }
    }
    if (done?.status === 'error') return { status: 'error', message: redact(done.message), rounds: round };
    if (done?.status === 'cancelled') return { status: 'cancelled', rounds: round };
    if (done?.status === 'done') {
      const out = done.output;
      if (out?.toolCalls) for (const tc of out.toolCalls) calls.set(tc.id, tc as ToolCallLike);
      for (const action of done.requiredActions) {
        if (action.type === 'tool.approval_required') for (const tc of action.toolCalls) pending.set(tc.id, { threadId: action.threadId });
        if (action.type === 'tool.response_required') unsupported = true;
      }
      if (unsupported) return { status: 'unsupported', message: 'the agent asked for a client-side tool response, which CodeCraft does not provide', rounds: round };
      if (pending.size === 0) {
        const c = out?.content;
        return { status: 'done', text: typeof c === 'string' ? redact(c) : '', rounds: round };
      }
    } else {
      return { status: 'error', message: 'the stream ended without a turn.done event', rounds: round };
    }

    // Normal pause: ask the user about each pending call, then resume with a new turn.
    input = [];
    for (const [toolCallId, { threadId }] of pending) {
      const tc = calls.get(toolCallId);
      const name = tc?.function?.name ?? 'unknown_tool';
      const decision = await opts.approver.approve({ toolCallId, threadId, name, summary: summarizeArgs(name, tc?.function?.arguments) });
      input.push({
        type: 'user.tool_approval',
        threadId,
        toolCallId,
        approval: decision.allow ? { status: 'allow' } : { status: 'deny', reason: decision.reason ?? 'denied by the user' },
      });
    }
  }
  return { status: 'error', message: `stopped after ${max} approval rounds`, rounds: max };
}
