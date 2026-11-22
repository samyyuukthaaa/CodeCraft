// Cheap live tool probe (npm run probe): ONE short turn on the real primary agent, with the real editor MCP server
// on the fixture, asking it to list files through the editor tools. It passes only if a real editor tool call
// (list_files) reached CodeCraft's handler and succeeded. Capped at MAX_REQUESTS model requests: past that the
// turn is aborted and the session cancelled. Prints the requests used. Nothing is written (every review is
// rejected, tests never run). Keys are never printed.
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { IndexService } from '../../src/index/service';
import { WriteGate } from '../../src/mcp/gate';
import { NodeReadFs } from '../../src/mcp/nodeFs';
import { startMcpServer } from '../../src/mcp/server';
import { PlanStore, createHandlers } from '../../src/mcp/tools';
import { agentsApi, cancelSession, createClient, createSession, describeError, ensureAgents, registerEditorServer, sessionDriver } from '../../src/trueforge/client';
import { PRIMARY_AGENT_NAME, validateConfig } from '../../src/trueforge/config';
import { classifyError } from '../../src/trueforge/errors';
import { runWithApprovals } from '../../src/trueforge/run';
import { redact } from '../../src/util/redact';
import { DiskApplier, rejectAll } from '../helpers';
import { ROOT, changedFiles } from './harness';

export const MAX_REQUESTS = 6;
const PROBE_PORT = 8793;
const PROMPT =
  'Tool probe (no code changes): call the codecraft-editor tool list_files once with no prefix, through call_tool, ' +
  'then reply with one line: the number of files it returned. Do not read, search, plan or change anything else.';

function token(): string {
  const file = path.join(os.tmpdir(), 'codecraft-probe-mcp-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(t)) return t;
  } catch {
    /* create below */
  }
  const t = randomBytes(24).toString('hex');
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

async function main(): Promise<void> {
  const cfg = validateConfig({});
  const client = createClient(cfg);
  const fsRead = new NodeReadFs(ROOT);
  const gate = new WriteGate(fsRead, new DiskApplier(ROOT), { review: async (req) => rejectAll(req) });
  const toolCalls: string[] = [];
  const handlers = createHandlers({
    fs: fsRead,
    gate,
    tests: { run: async () => ({ ran: false, exitCode: -1, output: 'tests are not run by the probe' }) },
    index: new IndexService(ROOT, undefined),
    plan: new PlanStore(),
    onActivity: (l) => toolCalls.push(l),
  });
  const server = await startMcpServer(handlers, token(), PROBE_PORT);
  let requests = 0;
  let rateLimited = 0;
  let sessionId = '';
  const ac = new AbortController();
  let verdict = 'FAIL';
  let detail = '';
  try {
    await registerEditorServer(client, server.url, token());
    await ensureAgents(agentsApi(client), cfg);
    sessionId = await createSession(client, PRIMARY_AGENT_NAME);
    console.log(`probe: agent ${PRIMARY_AGENT_NAME}, model ${cfg.primaryModel}, session ${sessionId}`);
    const outcome = await runWithApprovals(PROMPT, {
      driver: sessionDriver(client, sessionId),
      approver: { approve: async () => ({ allow: false, reason: 'tool probe: no changes' }) },
      signal: ac.signal,
      maxRounds: 3,
      onEvent: (ev) => {
        if (ev.type === 'model.message') {
          requests++;
          if (requests > MAX_REQUESTS && !ac.signal.aborted) {
            ac.abort();
            void cancelSession(client, sessionId).catch(() => undefined);
          }
        }
        if (ev.type === 'turn.done' && ev.state.status === 'error' && classifyError(ev.state.message).cls === 'rate_limit') rateLimited++;
      },
    });
    const listed = toolCalls.filter((l) => l.startsWith('list_files'));
    const ok = listed.length > 0;
    verdict = ok && requests <= MAX_REQUESTS ? 'PASS' : 'FAIL';
    detail =
      `outcome ${outcome.status}${outcome.status === 'error' ? ` (${classifyError(outcome.message).cls}): ${redact(outcome.message).slice(0, 300)}` : ''}` +
      `; editor tool calls that reached CodeCraft: ${toolCalls.length ? toolCalls.join(' | ') : 'none'}` +
      (requests > MAX_REQUESTS ? `; stopped after more than ${MAX_REQUESTS} requests` : '');
  } catch (e) {
    detail = `error: ${redact(describeError(e)).slice(0, 300)}`;
  } finally {
    await server.close();
  }
  const changed = await changedFiles();
  console.log(`probe: requests used ${requests} model call(s)${rateLimited ? ` + ${rateLimited} rate-limited` : ''} (limit ${MAX_REQUESTS})`);
  console.log(`probe: ${detail}`);
  console.log(`probe: fixture ${changed.length ? `CHANGED: ${changed.join(', ')}` : 'clean'}`);
  console.log(`probe: ${verdict}`);
  process.exitCode = verdict === 'PASS' && !changed.length ? 0 : 1;
}

void main();
