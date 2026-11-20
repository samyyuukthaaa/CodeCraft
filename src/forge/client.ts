// Thin TrueForge HTTP client. TrueForge owns the agent loop and all model calls;
// this module only creates sessions and streams turn events. No provider calls here.
import { createSseParser } from './sse';

export interface ForgeEvent {
  type: string;
  [key: string]: unknown;
}

export interface TurnResult {
  status: 'done' | 'error' | 'unknown';
  content?: string;
  errorMessage?: string;
  model?: string;
  events: ForgeEvent[];
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function assertLoopback(baseUrl: string): URL {
  const u = new URL(baseUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('forge.baseUrl must be http or https');
  }
  if (!LOOPBACK.has(u.hostname)) {
    throw new Error('forge.baseUrl must be a loopback address (TrueForge standalone is localhost-only)');
  }
  return u;
}

function api(baseUrl: string, path: string): string {
  const u = assertLoopback(baseUrl);
  return `${u.origin}/api/v1${path}`;
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
  if (!res.ok) throw new Error(`TrueForge ${res.status}: ${body.error?.message ?? res.statusText}`);
  return body.data as T;
}

export async function listModels(baseUrl: string): Promise<string[]> {
  const data = await json<Array<{ name: string }>>(await fetch(api(baseUrl, '/models')));
  return data.map((m) => m.name);
}

/** Creates a session with an inline agent that uses the given TrueForge model name. */
export async function createSession(baseUrl: string, model: string): Promise<string> {
  const res = await fetch(api(baseUrl, '/sessions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: { spec: { model: { name: model } } } }),
  });
  return (await json<{ id: string }>(res)).id;
}

/** Streams the events of a new turn (POST /sessions/{id}/turns answers with SSE). */
export async function* streamTurn(
  baseUrl: string,
  sessionId: string,
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<ForgeEvent> {
  const res = await fetch(api(baseUrl, `/sessions/${encodeURIComponent(sessionId)}/turns`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: [{ type: 'user.message', content: text }] }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`TrueForge ${res.status}: ${body.error?.message ?? res.statusText}`);
  }
  const parser = createSseParser();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const data of parser.push(decoder.decode(value, { stream: true }))) {
      try {
        yield JSON.parse(data) as ForgeEvent;
      } catch {
        // ignore non-JSON keep-alives
      }
    }
  }
}

/** Runs one turn to completion. A model claim is reported as content; errors are reported as errors. */
export async function runTurn(baseUrl: string, sessionId: string, text: string, signal?: AbortSignal): Promise<TurnResult> {
  const result: TurnResult = { status: 'unknown', events: [] };
  for await (const ev of streamTurn(baseUrl, sessionId, text, signal)) {
    result.events.push(ev);
    if (ev.type === 'turn.done') {
      const state = ev.state as
        | { status?: string; message?: string; output?: { content?: string; model?: { name?: string } } }
        | undefined;
      if (state?.status === 'done') {
        result.status = 'done';
        result.content = state.output?.content;
        result.model = state.output?.model?.name;
      } else if (state?.status === 'error') {
        result.status = 'error';
        result.errorMessage = state.message;
      }
    }
  }
  return result;
}
