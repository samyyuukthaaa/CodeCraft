// Thin wrapper over @truefoundry/trueforge-sdk. TrueForge owns the agent loop and all model calls;
// this module only registers agents, creates sessions and streams turn events.
import { TrueForge, TrueForgeApi, TrueForgeError } from '@truefoundry/trueforge-sdk';
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

function manifestFor(model: string): TrueForgeApi.AgentSpec {
  return { model: { name: model }, instructions: AGENT_INSTRUCTIONS };
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
  if (m.model.name === model && m.instructions === AGENT_INSTRUCTIONS) return 'unchanged';
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

/** Streams one turn's events. Provider failures arrive as a `turn.done` event with status "error". */
export async function* streamTurn(
  client: TrueForge,
  sessionId: string,
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<TurnEvent> {
  const stream = await client.sessions.createTurnStream(
    sessionId,
    { input: [{ type: 'user.message', content: text }] },
    { abortSignal: signal },
  );
  for await (const ev of stream) yield ev;
}

/** Human-readable text for an SDK or network error. Never includes request headers. */
export function describeError(e: unknown): string {
  if (e instanceof TrueForgeError) return `TrueForge HTTP ${e.statusCode ?? '?'}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
