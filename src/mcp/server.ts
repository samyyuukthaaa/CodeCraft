// Local MCP server (streamable HTTP, stateless). Bound to 127.0.0.1, bearer-token protected,
// Host-header checked. TrueForge connects to it; the extension host is the editor-tool host.
import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { EDITOR_SERVER_NAME } from './constants';
import { Handlers, ToolOutput, schemas } from './tools';


export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function buildServer(h: Handlers): McpServer {
  const server = new McpServer({ name: EDITOR_SERVER_NAME, version: '0.0.1' });
  const wrap = (o: ToolOutput) => ({ content: [{ type: 'text' as const, text: o.text }], isError: o.isError });
  server.registerTool(
    'read_file',
    { description: 'Read a workspace file. Required before propose_write on an existing file.', inputSchema: schemas.read_file, annotations: { readOnlyHint: true } },
    async (a) => wrap(await h.read_file(a)),
  );
  server.registerTool(
    'list_files',
    { description: 'List workspace files (excludes .git, node_modules, secrets).', inputSchema: schemas.list_files, annotations: { readOnlyHint: true } },
    async (a) => wrap(await h.list_files(a)),
  );
  server.registerTool(
    'search_text',
    { description: 'Case-insensitive plain-text search across workspace files.', inputSchema: schemas.search_text, annotations: { readOnlyHint: true } },
    async (a) => wrap(await h.search_text(a)),
  );
  server.registerTool(
    'search_symbols',
    {
      description: 'Find classes, functions and methods by name in the repository index (Python, TypeScript, JavaScript). Returns path and line.',
      inputSchema: schemas.search_symbols,
      annotations: { readOnlyHint: true },
    },
    async (a) => wrap(await h.search_symbols(a)),
  );
  server.registerTool(
    'list_related',
    {
      description: 'For a file: the workspace files it imports, the files that import it, and matching test files.',
      inputSchema: schemas.list_related,
      annotations: { readOnlyHint: true },
    },
    async (a) => wrap(await h.list_related(a)),
  );
  server.registerTool(
    'propose_write',
    {
      description:
        'Propose a full new content for a file. This does NOT write: the user reviews each change hunk and only accepted hunks are applied. The result states what was actually applied.',
      inputSchema: schemas.propose_write,
      annotations: { destructiveHint: true },
    },
    async (a) => wrap(await h.propose_write(a)),
  );
  server.registerTool(
    'run_tests',
    {
      description: 'Run the project test command in the workspace after user confirmation. Reports the real exit code.',
      inputSchema: schemas.run_tests,
      annotations: { destructiveHint: true },
    },
    async () => wrap(await h.run_tests()),
  );
  return server;
}

function tokenOk(header: string | undefined, token: string): boolean {
  const want = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? '');
  return got.length === want.length && timingSafeEqual(got, want);
}

const MAX_BODY = 4_000_000;

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

export async function startMcpServer(handlers: Handlers, token: string, port = 0): Promise<RunningServer> {
  let boundPort = 0;
  const httpServer = http.createServer(async (req, res) => {
    const send = (status: number, msg: string): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    };
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) return send(403, 'bad host');
      if (req.headers.origin) return send(403, 'browser origins are not allowed');
      if (!tokenOk(req.headers.authorization, token)) return send(401, 'unauthorized');
      if (req.url !== '/mcp') return send(404, 'not found');
      if (req.method !== 'POST') return send(405, 'method not allowed');
      const body = await readBody(req);
      const server = buildServer(handlers);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) send(400, e instanceof Error ? e.message : 'bad request');
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });
  boundPort = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${boundPort}/mcp`,
    port: boundPort,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}
