// LIVE end-to-end check (not part of `npm test`): real TrueForge + real model + real MCP server on a
// temp workspace. The reviewer and approver are scripted here; in the extension they are the user.
// Usage: npm run live-mcp [-- primary|fallback] [-- reject]
import { randomBytes } from 'node:crypto';
import { WriteGate } from '../src/mcp/gate';
import { startMcpServer } from '../src/mcp/server';
import { createHandlers } from '../src/mcp/tools';
import { agentsApi, createClient, createSession, ensureAgents, manifestFor, registerEditorServer, sessionDriver, describeError } from '../src/trueforge/client';
import { FALLBACK_AGENT_NAME, PRIMARY_AGENT_NAME, validateConfig } from '../src/trueforge/config';
import { runWithApprovals } from '../src/trueforge/run';
import { DiskApplier, ScriptedReviewer, acceptAll, readDisk, rejectAll, tempWorkspace } from './helpers';

async function main(): Promise<void> {
  const which = process.argv.includes('fallback') ? FALLBACK_AGENT_NAME : PRIMARY_AGENT_NAME;
  const reject = process.argv.includes('reject');
  const cfg = validateConfig({});
  const client = createClient(cfg);
  const ws = await tempWorkspace({ 'hello.txt': 'hello world\n' });
  const applier = new DiskApplier(ws.root);
  const reviewer = new ScriptedReviewer(reject ? rejectAll : acceptAll);
  const gate = new WriteGate(ws.fs, applier, reviewer);
  const activity: string[] = [];
  const handlers = createHandlers({
    fs: ws.fs,
    gate,
    tests: { run: async () => ({ ran: true, exitCode: 0, output: 'fake test output' }) },
    onActivity: (l) => activity.push(l),
  });
  const token = randomBytes(24).toString('hex');
  const server = await startMcpServer(handlers, token);
  try {
    await registerEditorServer(client, server.url, token);
    console.log('registered MCP server at', server.url);
    console.log('ensureAgents:', JSON.stringify(await ensureAgents(agentsApi(client), cfg)));
    // LIVE_PARAMS='{"k":v}' runs an inline copy of the agent manifest with extra model params (experiments only).
    const extra = process.env.LIVE_PARAMS ? (JSON.parse(process.env.LIVE_PARAMS) as Record<string, unknown>) : undefined;
    const sid = extra
      ? (await client.sessions.create({ agent: { spec: { ...manifestFor(which === FALLBACK_AGENT_NAME ? cfg.fallbackModel : cfg.primaryModel), model: { name: which === FALLBACK_AGENT_NAME ? cfg.fallbackModel : cfg.primaryModel, params: extra } } } })).data.id
      : await createSession(client, which);
    if (extra) console.log('inline agent with params', JSON.stringify(extra));
    const seen: string[] = [];
    const out = await runWithApprovals(
      'Read hello.txt with read_file, then use propose_write to change the word world to CodeCraft (keep the trailing newline). Then tell me exactly what the propose_write result said.',
      {
        driver: sessionDriver(client, sid),
        approver: {
          async approve(call) {
            const allow = !process.argv.includes('deny');
            console.log(`APPROVAL REQUESTED: ${call.name} ${call.summary} -> ${allow ? 'allow' : 'deny'}`);
            return allow ? { allow: true } : { allow: false, reason: 'denied in live test' };
          },
        },
        onEvent: (ev) => {
          if (ev.type !== 'model.message.delta') seen.push(ev.type);
          if (process.env.LIVE_DEBUG) {
            const e = ev as unknown as Record<string, unknown>;
            if (ev.type === 'model.message.delta' && !e.toolCalls) return;
            const shown = JSON.stringify(e, (k, v) => (k === 'newContent' || k === 'content' ? (typeof v === 'string' ? `<${v.length} chars>` : v) : v));
            console.log(`[${new Date().toISOString().slice(11, 19)}] ${shown.slice(0, 700)}`);
          }
        },
      },
    );
    console.log('events:', seen.join(' '));
    console.log('outcome:', JSON.stringify(out));
    console.log('activity:', activity.join(' | '));
    console.log('reviews:', reviewer.requests.length, 'writes:', applier.writes.length);
    console.log('hello.txt on disk:', JSON.stringify(await readDisk(ws.root, 'hello.txt')));
  } catch (e) {
    console.error('FAILED:', describeError(e));
    process.exitCode = 2;
  } finally {
    await server.close();
    await ws.cleanup();
  }
}
void main();
