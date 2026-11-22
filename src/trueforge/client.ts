// Thin wrapper over @truefoundry/trueforge-sdk. TrueForge owns the agent loop and all model calls;
// this module only registers agents, creates sessions and streams turn events.
import { TrueForge, TrueForgeApi, TrueForgeError } from '@truefoundry/trueforge-sdk';
import { APPROVAL_TOOLS, EDITOR_SERVER_NAME } from '../mcp/constants';
import {
  AGENT_DESCRIPTION,
  AGENT_INSTRUCTIONS,
  CodeCraftConfig,
  FALLBACK_AGENT_NAME,
  PRIMARY_AGENT_NAME,
  validateConfig,
} from './config';

export type TurnEvent = TrueForgeApi.TurnStreamingEvent;

/** The subset of the SDK the wrapper needs; lets tests inject a fake. */
export interface AgentsApi {
  list(req: { agentName?: string; limit?: number }): Promise<AsyncIterable<TrueForgeApi.Agent>>;
  create(req: TrueForgeApi.CreateAgentRequest): Promise<unknown>;
  update(agentId: string, req: TrueForgeApi.UpdateAgentRequest): Promise<unknown>;
}

export function createClient(cfg: CodeCraftConfig): TrueForge {
  const v = validateConfig(cfg);
  return new TrueForge({ baseUrl: v.baseUrl });
}

export function manifestFor(model: string): TrueForgeApi.AgentSpec {
  return {
    model: { name: model },
    instructions: AGENT_INSTRUCTIONS,
    // propose_write, propose_changes and run_tests make TrueForge pause the turn for approval before they run.
    mcpServers: [{ name: EDITOR_SERVER_NAME, requireApprovalForTools: [...APPROVAL_TOOLS] }],
    config: AGENT_RUNTIME_CONFIG,
  };
}

/**
 * Runtime limits CodeCraft sets on both agents. Observed live (P3): with TrueForge's defaults
 * (dynamic sub-agents on, 512 iterations) one single-function task ran 34 tool calls plus a sub-agent,
 * ~299k input tokens, and hit the provider quota (HTTP 429). These bound the cost of a runaway turn.
 */
/** Input tokens per request above which TrueForge compacts the conversation (about 5 requests/min fit in 250k TPM). */
export const COMPACTION_TRIGGER_TOKENS = 48_000;

export const AGENT_RUNTIME_CONFIG: TrueForgeApi.RuntimeConfig = {
  dynamicSubAgents: { enabled: false },
  iterationLimit: 60,
  // P5: an unclear request gets ONE short question (TrueForge's ask_user_question tool, answered in the panel)
  // instead of edits. The tool pauses the turn with tool.response_required; CodeCraft answers with user.tool_response.
  askUserQuestions: { enabled: true },
  // Context engineering (TrueForge contextManagement): compact the conversation once a request's input passes
  // COMPACTION_TRIGGER_TOKENS, and let TrueForge handle oversized tool responses. Observed live: every step
  // resends the growing history (7k -> 13k+ input tokens per request within one run; Task B runs used 1-4M
  // tokens) against Gemini's free-tier 250k input tokens per minute. See docs/TRUEFORGE_NOTES.md.
  contextManagement: {
    compaction: { enabled: true, trigger: { type: 'input_tokens', value: COMPACTION_TRIGGER_TOKENS } },
    largeToolResponse: { enabled: true },
  },
};

/** Registers (or updates) the local editor MCP server in TrueForge. The bearer token is never logged. */
export async function registerEditorServer(client: TrueForge, url: string, token: string): Promise<void> {
  await client.settings.mcpServers.createOrUpdate({
    manifest: {
      type: 'remote',
      name: EDITOR_SERVER_NAME,
      description: 'CodeCraft editor tools (read, search, gated write, tests). Managed by the CodeCraft extension.',
      url,
      auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } },
    },
  });
}

export type EnsureOutcome = 'created' | 'updated' | 'unchanged';

/**
 * Compares only the fields CodeCraft sets. The server fills defaults into stored manifests
 * (observed: enableTools ["@all"], disableTools [], preloadTools [], preload false, a full config block),
 * so a whole-object comparison would report a change on every run.
 */
export function manifestMatches(stored: TrueForgeApi.AgentSpec, wanted: TrueForgeApi.AgentSpec): boolean {
  if (stored.model.name !== wanted.model.name || stored.instructions !== wanted.instructions) return false;
  if ((stored.config?.dynamicSubAgents?.enabled ?? true) !== (wanted.config?.dynamicSubAgents?.enabled ?? true)) return false;
  if ((stored.config?.iterationLimit ?? 512) !== (wanted.config?.iterationLimit ?? 512)) return false;
  if ((stored.config?.askUserQuestions?.enabled ?? true) !== (wanted.config?.askUserQuestions?.enabled ?? true)) return false;
  const trig = (s: TrueForgeApi.AgentSpec) => JSON.stringify(s.config?.contextManagement?.compaction?.trigger ?? null);
  if ((stored.config?.contextManagement?.compaction?.enabled ?? true) !== (wanted.config?.contextManagement?.compaction?.enabled ?? true) || trig(stored) !== trig(wanted)) return false;
  const pick = (s: TrueForgeApi.AgentSpec) =>
    (s.mcpServers ?? []).map((x) => ({ name: x.name, approvals: [...(x.requireApprovalForTools ?? [])].sort() })).sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(pick(stored)) === JSON.stringify(pick(wanted));
}

/** Registers (or reconciles) one agent by name. Idempotent. */
export async function ensureAgent(api: AgentsApi, name: string, model: string): Promise<EnsureOutcome> {
  const manifest = manifestFor(model);
  let existing: TrueForgeApi.Agent | undefined;
  for await (const a of await api.list({ agentName: name, limit: 50 })) {
    if (a.name === name) {
      existing = a;
      break;
    }
  }
  if (!existing) {
    await api.create({ name, description: AGENT_DESCRIPTION, manifest });
    return 'created';
  }
  if (manifestMatches(existing.manifest, manifest)) return 'unchanged';
  await api.update(existing.id, { description: AGENT_DESCRIPTION, manifest });
  return 'updated';
}

export async function ensureAgents(
  api: AgentsApi,
  cfg: CodeCraftConfig,
): Promise<Record<string, EnsureOutcome>> {
  return {
    [PRIMARY_AGENT_NAME]: await ensureAgent(api, PRIMARY_AGENT_NAME, cfg.primaryModel),
    [FALLBACK_AGENT_NAME]: await ensureAgent(api, FALLBACK_AGENT_NAME, cfg.fallbackModel),
  };
}

export function agentsApi(client: TrueForge): AgentsApi {
  return {
    list: (req) => client.agents.list(req) as unknown as Promise<AsyncIterable<TrueForgeApi.Agent>>,
    create: (req) => client.agents.create(req),
    update: (id, req) => client.agents.update(id, req),
  };
}

export async function createSession(client: TrueForge, agentName: string): Promise<string> {
  const res = await client.sessions.create({ agent: { name: agentName } });
  return res.data.id;
}

/** What resumes a paused turn: approval decisions and/or client-side tool responses (ask_user_question answers). */
export type ApprovalInput = TrueForgeApi.UserToolApprovalInputEvent | TrueForgeApi.UserToolResponseInputEvent;
// The SDK types stream input as user messages only; approval items on a NEW turn are used only for a turn
// that ended (turn.done) with required actions. A PAUSED turn is resumed with createTurnEvents instead.
export type TurnInput = TrueForgeApi.UserMessage | ApprovalInput;

/** Streams one turn's events. Provider failures arrive as a `turn.done` event with status "error". */
export async function* streamTurnInput(
  client: TrueForge,
  sessionId: string,
  input: TurnInput[],
  signal?: AbortSignal,
): AsyncGenerator<TurnEvent> {
  const stream = await client.sessions.createTurnStream(
    sessionId,
    { input: input as unknown as TrueForgeApi.CreateTurnSessionsStreamRequestInputItem[] },
    { abortSignal: signal },
  );
  for await (const ev of stream) yield ev;
}

export function streamTurn(client: TrueForge, sessionId: string, text: string, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  return streamTurnInput(client, sessionId, [{ type: 'user.message', content: text }], signal);
}

/** Submits approvals to a paused turn, then streams the rest of that turn (after the last seen event). */
export async function* resumePausedTurn(
  client: TrueForge,
  sessionId: string,
  turnId: string,
  approvals: ApprovalInput[],
  afterEventId: string | undefined,
  signal?: AbortSignal,
): AsyncGenerator<TurnEvent> {
  await client.sessions.createTurnEvents(sessionId, turnId, { events: approvals }, { abortSignal: signal });
  const stream = await client.sessions.subscribeToTurn(sessionId, turnId, afterEventId ? { afterEventId } : {}, { abortSignal: signal });
  for await (const ev of stream) yield ev;
}

/**
 * Resumes a turn whose stream was cut: subscribes after the last event seen. Observed live: TrueForge refuses
 * after_sequence_number on this stream ("Use from_event_id or after_event_id"), so the event ID is used. If
 * subscribing fails, falls back to the turn's persisted events (GET .../turns/{id}/events, ascending).
 */
export async function* resumeTurnStream(client: TrueForge, sessionId: string, turnId: string, afterEventId: string | undefined, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  let live: AsyncIterable<TurnEvent> | undefined;
  try {
    live = await client.sessions.subscribeToTurn(sessionId, turnId, afterEventId ? { afterEventId } : {}, { abortSignal: signal });
  } catch {
    live = undefined;
  }
  if (live) {
    for await (const ev of live) yield ev;
    return;
  }
  const page = await client.sessions.listTurnEvents(sessionId, turnId, { order: 'asc', limit: 500 }, { abortSignal: signal });
  let after = afterEventId === undefined;
  for await (const ev of page as unknown as AsyncIterable<TurnEvent>) {
    if (after) yield ev;
    else if ((ev as { id?: string }).id === afterEventId) after = true;
  }
}

/** The TurnDriver used by runWithApprovals, bound to one session. */
export function sessionDriver(client: TrueForge, sessionId: string) {
  return {
    start: (text: string, signal: AbortSignal) => streamTurn(client, sessionId, text, signal),
    resumePaused: (turnId: string, approvals: ApprovalInput[], afterEventId: string | undefined, signal: AbortSignal) =>
      resumePausedTurn(client, sessionId, turnId, approvals, afterEventId, signal),
    newTurnWithApprovals: (approvals: ApprovalInput[], signal: AbortSignal) => streamTurnInput(client, sessionId, approvals, signal),
    resumeStream: (turnId: string, afterEventId: string | undefined, signal: AbortSignal) => resumeTurnStream(client, sessionId, turnId, afterEventId, signal),
    cancel: () => cancelSession(client, sessionId),
    sessionId,
  };
}

export async function cancelSession(client: TrueForge, sessionId: string): Promise<void> {
  await client.sessions.cancel(sessionId, {});
}

/** Human-readable text for an SDK or network error. Never includes request headers. */
export function describeError(e: unknown): string {
  if (e instanceof TrueForgeError) return `TrueForge HTTP ${e.statusCode ?? '?'}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
