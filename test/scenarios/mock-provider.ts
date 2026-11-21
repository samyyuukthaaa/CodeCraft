// TEST-ONLY local OpenAI-compatible provider used to make TrueForge surface real error shapes on demand.
// The model id selects the behaviour; TrueForge itself is real, so the turn/error events it emits are real.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockMode = 'ok' | 'ask_user' | 'rate_limit' | 'server_error' | 'unavailable' | 'context_too_large' | 'malformed_tool_call' | 'bad_json' | 'cut_stream' | 'hang';
/** TrueForge model names allow lowercase letters, digits and hyphens only. */
export const mockModelName = (m: MockMode): string => `mock-${m.replace(/_/g, '-')}`;
/** Error/ok modes (the capture and failure-table scripts register these). 'ask_user' is separate (ask-user.ts). */
export const MOCK_MODES: MockMode[] = ['ok', 'rate_limit', 'server_error', 'unavailable', 'context_too_large', 'malformed_tool_call', 'bad_json', 'cut_stream', 'hang'];

function sse(res: http.ServerResponse, chunks: unknown[], end = true): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  if (end) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] });

export async function startMockProvider(port = 8799): Promise<{ url: string; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += String(c);
    let model = '';
    let messages: Array<{ role?: string; content?: unknown }> = [];
    try {
      const parsed = JSON.parse(body) as { model?: string; messages?: Array<{ role?: string; content?: unknown }> };
      model = parsed.model ?? '';
      messages = parsed.messages ?? [];
    } catch {
      /* ignore */
    }
    const mode = (model.endsWith(mockModelName('ask_user')) ? 'ask_user' : (MOCK_MODES.find((m) => model.endsWith(mockModelName(m))) ?? 'ok')) as MockMode;
    hits.push(mode);
    const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    switch (mode) {
      case 'ask_user': {
        // Asks once with TrueForge's ask_user_question tool; after the tool result arrives, answers with it.
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg) return sse(res, [chunk({ role: 'assistant', content: `You answered: ${typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content)}` }), chunk({}, 'stop')]);
        const args = JSON.stringify({ question: 'Which function should I rename?', options: ['add', 'subtract'] });
        return sse(res, [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_ask', type: 'function', function: { name: 'ask_user_question', arguments: args } }] }), chunk({}, 'tool_calls')]);
      }
      case 'rate_limit':
        return json(429, { error: { message: 'Rate limit reached for requests. Please try again in 7s.', type: 'requests', code: 'rate_limit_exceeded' } }, { 'retry-after': '7' });
      case 'server_error':
        return json(500, { error: { message: 'The server had an error while processing your request.', type: 'server_error' } });
      case 'unavailable':
        return json(503, { error: { message: 'The engine is currently overloaded, please try again later.', type: 'server_error' } });
      case 'context_too_large':
        return json(400, { error: { message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 20000 tokens. Please reduce the length of the messages.", type: 'invalid_request_error', code: 'context_length_exceeded' } });
      case 'malformed_tool_call':
        return sse(res, [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_bad', type: 'function', function: { name: 'list_tools', arguments: '{"mcp_server": "codecraft-ed' } }] }), chunk({}, 'tool_calls')]);
      case 'bad_json':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id": "c1", "choices": [ {"delta": {"content": "hel\n\n');
        res.write('data: [DONE]\n\n');
        return void res.end();
      case 'cut_stream':
        sse(res, [chunk({ role: 'assistant', content: 'partial ' })], false);
        return void setTimeout(() => res.destroy(), 200);
      case 'hang':
        return; // never answers
      default:
        return sse(res, [chunk({ role: 'assistant', content: 'OK' }), chunk({}, 'stop')]);
    }
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    hits,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
