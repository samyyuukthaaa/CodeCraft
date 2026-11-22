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

/** A client-side tool call TrueForge wants CodeCraft to answer (tool.response_required). */
export interface ClientToolCall {
  toolCallId: string;
  threadId: string;
  /** Tool name, e.g. "ask_user_question". */
  name: string;
  /** For ask_user_question: the question and its options (redacted). */
  question?: string;
  options?: string[];
}

/** Answers client-side tool calls; for ask_user_question, the user's answer. */
export interface Responder {
  answer(call: ClientToolCall): Promise<string>;
}

export const ASK_USER_TOOL = 'ask_user_question';

export interface TurnDriver {
  /** Starts a new turn with a user message. */
  start(text: string, signal: AbortSignal): AsyncIterable<TurnEvent>;
  /** Submits approval decisions to a PAUSED turn and streams the rest of that same turn. */
  resumePaused(turnId: string, approvals: ApprovalInput[], afterEventId: string | undefined, signal: AbortSignal): AsyncIterable<TurnEvent>;
  /** Starts a NEW turn carrying approval decisions (for a turn that ended with required actions). */
  newTurnWithApprovals(approvals: ApprovalInput[], signal: AbortSignal): AsyncIterable<TurnEvent>;
  /** Continues a turn whose stream was cut, after the last event seen (live subscribe or persisted events). */
  resumeStream?(turnId: string, afterEventId: string | undefined, signal: AbortSignal): AsyncIterable<TurnEvent>;
  /** TrueForge session ID (persisted in the journal for resume). */
  sessionId?: string;
  /** Cancels the session server-side (so an abandoned turn stops spending quota). */
  cancel?(): Promise<void>;
}

/** Where a run is in TrueForge: persisted so a cut stream can be resumed. */
export interface StreamPosition {
  sessionId?: string;
  turnId: string;
  lastEventId?: string;
  /** Why the position was recorded. */
  at: 'paused' | 'done' | 'cut' | 'resumed';
}

/**
 * TrueForge's reply when a model calls an MCP tool by name instead of through call_tool. This many in one run end
 * the run as a provider failure (class tool_not_mapped), which fails over to the fallback model.
 */
export const TOOL_NOT_MAPPED = /Tool (\S+) not found in tool mapping/;
export const TOOL_MAPPING_LIMIT = 2;

/** A cut stream is resumed at most this many times per run. */
export const MAX_STREAM_RESUMES = 2;

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
  /** Persist session/turn/last event (journal) so a cut stream can be resumed. */
  onPosition?: (p: StreamPosition) => void;
  /** Answers tool.response_required (ask_user_question). Without it such a turn ends as "unsupported". */
  responder?: Responder;
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
  if (r.tool === 'propose_changes') {
    const groups = Array.isArray(r.input.groups) ? (r.input.groups as Array<{ intent?: unknown; files?: Array<{ path?: unknown }> }>) : [];
    const shown = groups
      .map((g) => `${typeof g.intent === 'string' ? g.intent : 'edit'}: ${(g.files ?? []).map((f) => (typeof f.path === 'string' ? f.path : '?')).join(', ')}`)
      .join(' | ');
    return { name: display, summary: redact(`plan=${str('plan').replace(/\s+/g, ' ').slice(0, 300)} groups=[${shown.slice(0, 400)}]`) };
  }
  if (r.tool === 'run_tests') return { name: display, summary: 'run the project test command' };
  return { name: display, summary: redact(JSON.stringify(r.input).slice(0, 200)) };
}

export async function runWithApprovals(text: string, opts: RunOptions): Promise<RunOutcome> {
  const max = opts.maxRounds ?? 25;
  const calls = new Map<string, CallInfo>(); // tool call id -> name + accumulated arguments
  const fragments = new Map<string, string>(); // `${messageId}:${index}` -> tool call id
  let turnId: string | undefined;
  let lastEventId: string | undefined;
  let resumes = 0;
  let notMapped = 0;
  let notMappedTool = '';

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
    const toAnswer = new Map<string, { threadId: string }>();
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
          if (opts.responder) for (const tc of ev.toolCalls) toAnswer.set(tc.id, { threadId: ev.threadId });
          else unsupported = true;
        } else if (ev.type === 'tool.response') {
          const content = (ev as { content?: unknown }).content;
          const m = typeof content === 'string' ? TOOL_NOT_MAPPED.exec(content) : null;
          if (m) {
            notMapped++;
            notMappedTool = m[1] ?? '';
            if (notMapped >= TOOL_MAPPING_LIMIT) break;
          }
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
      // A stream that breaks mid-turn is treated like a cut stream (resumed below) when it can be resumed.
      if (!(turnId && opts.driver.resumeStream && resumes < MAX_STREAM_RESUMES)) throw e;
    } finally {
      local.abort(); // close the HTTP stream
      opts.signal?.removeEventListener('abort', onAbort);
    }
    if (opts.signal?.aborted) return { status: 'cancelled', rounds: round };
    if (notMapped >= TOOL_MAPPING_LIMIT) {
      // Nothing was executed (unmapped calls never reach the editor tools), so the workspace is untouched.
      await opts.driver.cancel?.().catch(() => undefined);
      return { status: 'error', message: `Tool ${notMappedTool} not found in tool mapping (${notMapped} times in this run): the model called the editor tools by name instead of through call_tool`, rounds: round };
    }
    const position = (at: StreamPosition['at']): void => {
      if (turnId) opts.onPosition?.({ ...(opts.driver.sessionId ? { sessionId: opts.driver.sessionId } : {}), turnId, ...(lastEventId ? { lastEventId } : {}), at });
    };
    if (paused) position('paused');
    if (done) position('done');

    // Cut stream (no turn.done and no pause): resume the SAME turn after the last event seen.
    if (!paused && !done && turnId && opts.driver.resumeStream && resumes < MAX_STREAM_RESUMES) {
      resumes++;
      position('cut');
      const t = turnId;
      const after = lastEventId;
      const resume = opts.driver.resumeStream.bind(opts.driver);
      makeStream.set((s) => resume(t, after, s));
      continue;
    }

    if (done?.status === 'error') return { status: 'error', message: redact(done.message), rounds: round };
    if (done?.status === 'cancelled') return { status: 'cancelled', rounds: round };
    if (done?.status === 'done') {
      for (const action of done.requiredActions) {
        if (action.type === 'tool.approval_required') for (const tc of action.toolCalls) pending.set(tc.id, { threadId: action.threadId });
        if (action.type === 'tool.response_required') {
          if (opts.responder) for (const tc of action.toolCalls) toAnswer.set(tc.id, { threadId: action.threadId });
          else unsupported = true;
        }
      }
    }
    if (unsupported) return { status: 'unsupported', message: 'the agent asked for a client-side tool response, which CodeCraft does not provide', rounds: round };
    if (!paused && !done) return { status: 'error', message: 'the stream ended without a turn.done or pause event', rounds: round };
    if (pending.size === 0 && toAnswer.size === 0) {
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
    // Client-side tool calls: ask_user_question is answered by the user; anything else gets an error result so
    // the agent can continue (CodeCraft provides no other client-side tools).
    for (const [toolCallId, { threadId }] of toAnswer) {
      const c = calls.get(toolCallId);
      const name = resolveCall(c?.name ?? '', c?.args ?? '').tool || 'unknown_tool';
      let content: string;
      if (name === ASK_USER_TOOL && opts.responder) {
        const input = resolveCall(c?.name ?? '', c?.args ?? '').input ?? {};
        const question = typeof input.question === 'string' ? redact(input.question).slice(0, 500) : '(the agent asked a question without text)';
        const options = Array.isArray(input.options) ? input.options.filter((o): o is string => typeof o === 'string').slice(0, 5).map((o) => redact(o).slice(0, 200)) : [];
        content = await opts.responder.answer({ toolCallId, threadId, name, question, options });
      } else {
        content = JSON.stringify({ error: `CodeCraft does not provide the client-side tool ${name}` });
      }
      if (opts.signal?.aborted) return { status: 'cancelled', rounds: round };
      approvals.push({ type: 'user.tool_response', threadId, toolCallId, content });
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
