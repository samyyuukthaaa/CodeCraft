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
    // propose_write and run_tests make TrueForge pause the turn for approval before they run.
    mcpServers: [{ name: EDITOR_SERVER_NAME, requireApprovalForTools: [...APPROVAL_TOOLS] }],
  };
}

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

export type ApprovalInput = TrueForgeApi.UserToolApprovalInputEvent;
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

/** The TurnDriver used by runWithApprovals, bound to one session. */
export function sessionDriver(client: TrueForge, sessionId: string) {
  return {
    start: (text: string, signal: AbortSignal) => streamTurn(client, sessionId, text, signal),
    resumePaused: (turnId: string, approvals: ApprovalInput[], afterEventId: string | undefined, signal: AbortSignal) =>
      resumePausedTurn(client, sessionId, turnId, approvals, afterEventId, signal),
    newTurnWithApprovals: (approvals: ApprovalInput[], signal: AbortSignal) => streamTurnInput(client, sessionId, approvals, signal),
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
