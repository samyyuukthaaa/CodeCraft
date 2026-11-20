// Runs a prompt to completion, treating TrueForge's approval pause as normal.
//
// Observed live (TrueForge 0.185.1, see docs/TRUEFORGE_NOTES.md):
//  - MCP tools are reached through TrueForge system tools: the model calls `call_tool` with arguments
//    {mcp_server, tool_name, input}; `list_tools` / `get_tool_info` are discovery calls.
//  - Tool calls arrive only in streamed `model.message.delta` events: the first fragment has id/name/
//    toolInfo, later fragments append `function.arguments`, matched by message id + index.
//  - An approval pause is `tool.approval_required` followed by `turn.update {state.status:"paused"}`;
//    the stream stays open and no `turn.done` arrives until the turn is resumed.
//
// Pure with respect to VS Code and the SDK client: the driver and the approver are injected.
import { redact } from '../util/redact';
import type { ApprovalInput, TurnEvent } from './client';

export interface PendingToolCall {
  toolCallId: string;
  threadId: string;
  /** Effective tool, e.g. "codecraft-editor/propose_write" (or a bare name for non-MCP tools). */
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

export interface TurnDriver {
  /** Starts a new turn with a user message. */
  start(text: string, signal: AbortSignal): AsyncIterable<TurnEvent>;
  /** Submits approval decisions to a PAUSED turn and streams the rest of that same turn. */
  resumePaused(turnId: string, approvals: ApprovalInput[], afterEventId: string | undefined, signal: AbortSignal): AsyncIterable<TurnEvent>;
  /** Starts a NEW turn carrying approval decisions (for a turn that ended with required actions). */
  newTurnWithApprovals(approvals: ApprovalInput[], signal: AbortSignal): AsyncIterable<TurnEvent>;
}

export type RunOutcome =
  | { status: 'done'; text: string; rounds: number }
  | { status: 'error'; message: string; rounds: number }
  | { status: 'cancelled'; rounds: number }
  | { status: 'unsupported'; message: string; rounds: number };

export interface RunOptions {
  driver: TurnDriver;
  approver: Approver;
  onEvent?: (ev: TurnEvent) => void;
  signal?: AbortSignal;
  maxRounds?: number;
}

interface CallInfo {
  name: string;
  args: string;
}

/** Resolves the effective tool and its input, unwrapping TrueForge's `call_tool` system tool. */
export function resolveCall(name: string, rawArgs: string): { tool: string; server?: string; input: Record<string, unknown> | undefined } {
  let args: Record<string, unknown> | undefined;
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    args = undefined;
  }
  if (name === 'call_tool' && args && typeof args.tool_name === 'string') {
    const input = typeof args.input === 'object' && args.input !== null ? (args.input as Record<string, unknown>) : {};
    return { tool: args.tool_name, server: typeof args.mcp_server === 'string' ? args.mcp_server : undefined, input };
  }
  return { tool: name, input: args };
}

/** Short description of a call. For propose_write only the path and reason are shown. */
export function summarizeCall(name: string, rawArgs: string): { name: string; summary: string } {
  const r = resolveCall(name, rawArgs);
  const display = r.server ? `${r.server}/${r.tool}` : r.tool;
  if (!r.input) return { name: display, summary: '(arguments not parseable)' };
  const str = (k: string): string => (typeof r.input?.[k] === 'string' ? (r.input[k] as string) : '');
  if (r.tool === 'propose_write') return { name: display, summary: redact(`path=${str('path')} reason=${str('reason').slice(0, 160)}`) };
  if (r.tool === 'run_tests') return { name: display, summary: 'run the project test command' };
  return { name: display, summary: redact(JSON.stringify(r.input).slice(0, 200)) };
}

export async function runWithApprovals(text: string, opts: RunOptions): Promise<RunOutcome> {
  const max = opts.maxRounds ?? 25;
  const calls = new Map<string, CallInfo>(); // tool call id -> name + accumulated arguments
  const fragments = new Map<string, string>(); // `${messageId}:${index}` -> tool call id
  let turnId: string | undefined;
  let lastEventId: string | undefined;

  const makeStream = (() => {
    let next: (signal: AbortSignal) => AsyncIterable<TurnEvent> = (s) => opts.driver.start(text, s);
    return {
      get: () => next,
      set: (f: (signal: AbortSignal) => AsyncIterable<TurnEvent>) => {
        next = f;
      },
    };
  })();

  for (let round = 1; round <= max; round++) {
    if (opts.signal?.aborted) return { status: 'cancelled', rounds: round };
    const local = new AbortController();
    const onAbort = (): void => local.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const pending = new Map<string, { threadId: string }>();
    let paused = false;
    let unsupported = false;
    let done: Extract<TurnEvent, { type: 'turn.done' }>['state'] | undefined;

    try {
      for await (const ev of makeStream.get()(local.signal)) {
        opts.onEvent?.(ev);
        const anyEv = ev as { id?: string };
        if (typeof anyEv.id === 'string') lastEventId = anyEv.id;
        if (ev.type === 'turn.created') {
          turnId = ev.turnId;
        } else if (ev.type === 'model.message.delta' && ev.toolCalls) {
          for (const tc of ev.toolCalls) {
            const key = `${ev.id}:${tc.index}`;
            if (tc.id) {
              fragments.set(key, tc.id);
              calls.set(tc.id, { name: tc.function?.name ?? '', args: tc.function?.arguments ?? '' });
            } else {
              const id = fragments.get(key);
              const c = id ? calls.get(id) : undefined;
              if (c) c.args += tc.function?.arguments ?? '';
            }
          }
        } else if (ev.type === 'model.message' && ev.toolCalls) {
          for (const tc of ev.toolCalls) calls.set(tc.id, { name: tc.function.name, args: tc.function.arguments });
        } else if (ev.type === 'tool.approval_required') {
          for (const tc of ev.toolCalls) pending.set(tc.id, { threadId: ev.threadId });
        } else if (ev.type === 'tool.response_required') {
          unsupported = true; // CodeCraft registers no client-side tools
        } else if (ev.type === 'turn.update' && ev.state.status === 'paused') {
          paused = true;
          break; // the server keeps the stream open while paused
        } else if (ev.type === 'turn.done') {
          done = ev.state;
          break;
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) return { status: 'cancelled', rounds: round };
      throw e;
    } finally {
      local.abort(); // close the HTTP stream
      opts.signal?.removeEventListener('abort', onAbort);
    }
    if (opts.signal?.aborted) return { status: 'cancelled', rounds: round };

    if (done?.status === 'error') return { status: 'error', message: redact(done.message), rounds: round };
    if (done?.status === 'cancelled') return { status: 'cancelled', rounds: round };
    if (done?.status === 'done') {
      for (const action of done.requiredActions) {
        if (action.type === 'tool.approval_required') for (const tc of action.toolCalls) pending.set(tc.id, { threadId: action.threadId });
        if (action.type === 'tool.response_required') unsupported = true;
      }
    }
    if (unsupported) return { status: 'unsupported', message: 'the agent asked for a client-side tool response, which CodeCraft does not provide', rounds: round };
    if (!paused && !done) return { status: 'error', message: 'the stream ended without a turn.done or pause event', rounds: round };
    if (pending.size === 0) {
      if (paused) return { status: 'error', message: 'the turn paused without a pending approval', rounds: round };
      const c = done?.status === 'done' ? done.output?.content : undefined;
      return { status: 'done', text: typeof c === 'string' ? redact(c) : '', rounds: round };
    }

    // Normal pause: ask the user about each pending call, then resume.
    const approvals: ApprovalInput[] = [];
    for (const [toolCallId, { threadId }] of pending) {
      const c = calls.get(toolCallId);
      const shown = summarizeCall(c?.name ?? 'unknown_tool', c?.args ?? '');
      const decision = await opts.approver.approve({ toolCallId, threadId, name: shown.name, summary: shown.summary });
      if (opts.signal?.aborted) return { status: 'cancelled', rounds: round };
      approvals.push({
        type: 'user.tool_approval',
        threadId,
        toolCallId,
        approval: decision.allow ? { status: 'allow' } : { status: 'deny', reason: decision.reason ?? 'denied by the user' },
      });
    }
    if (paused) {
      if (!turnId) return { status: 'error', message: 'paused turn has no turn id', rounds: round };
      const t = turnId;
      const after = lastEventId;
      makeStream.set((s) => opts.driver.resumePaused(t, approvals, after, s));
    } else {
      makeStream.set((s) => opts.driver.newTurnWithApprovals(approvals, s));
    }
  }
  return { status: 'error', message: `stopped after ${max} approval rounds`, rounds: max };
}
