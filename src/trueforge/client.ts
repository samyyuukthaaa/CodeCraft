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
  const m = existing.manifest;
  if (
    m.model.name === model &&
    m.instructions === AGENT_INSTRUCTIONS &&
    JSON.stringify(m.mcpServers ?? []) === JSON.stringify(manifest.mcpServers)
  ) {
    return 'unchanged';
  }
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

// The SDK types stream input as user messages only, but a resumed turn carries user.tool_approval items
// (LegacyTurnInputItem). Verified against the live server in docs/TRUEFORGE_NOTES.md.
export type TurnInput = TrueForgeApi.UserMessage | TrueForgeApi.UserToolApprovalInputEvent;

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

export async function cancelSession(client: TrueForge, sessionId: string): Promise<void> {
  await client.sessions.cancel(sessionId, {});
}

/** Human-readable text for an SDK or network error. Never includes request headers. */
export function describeError(e: unknown): string {
  if (e instanceof TrueForgeError) return `TrueForge HTTP ${e.statusCode ?? '?'}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
