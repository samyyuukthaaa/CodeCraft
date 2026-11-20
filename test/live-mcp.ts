// LIVE end-to-end check (not part of `npm test`): real TrueForge + real models + real MCP server on a
// temp workspace. The hunk reviewer and the tool approver are scripted here; in the extension they are the user.
//
// Usage: npm run live-mcp -- [primary|fallback|failover] [reject] [deny]
//   primary   run on codecraft-primary only (default)
//   auto      real primary, then real fallback on error (same as the extension)
//   fallback  run directly on codecraft-fallback
//   failover  start on a FORCED-FAILING copy of the primary agent, then fail over to codecraft-fallback.
//             The fault is real: the primary model is sent temperature=99, which the provider rejects
//             with HTTP 400 at turn time. Test-only; the extension never does this.
//   reject    the reviewer rejects every hunk;  deny  the approver denies the tool call
// LIVE_DEBUG=1 prints every non-delta event.
import { randomBytes } from 'node:crypto';
import { WriteGate } from '../src/mcp/gate';
import { startMcpServer } from '../src/mcp/server';
import { createHandlers } from '../src/mcp/tools';
import { agentsApi, createClient, createSession, describeError, ensureAgents, manifestFor, registerEditorServer, sessionDriver } from '../src/trueforge/client';
import { FALLBACK_AGENT_NAME, PRIMARY_AGENT_NAME, validateConfig } from '../src/trueforge/config';
import { AgentAttempt, runWithFailover } from '../src/trueforge/failover';
import type { TurnEvent } from '../src/trueforge/client';
import { DiskApplier, ScriptedReviewer, acceptAll, readDisk, rejectAll, tempWorkspace } from './helpers';

const FORCED_FAULT_PARAMS = { temperature: 99 };

async function main(): Promise<void> {
  const mode = process.argv.includes('auto') ? 'auto' : process.argv.includes('failover') ? 'failover' : process.argv.includes('fallback') ? 'fallback' : 'primary';
  const reject = process.argv.includes('reject');
  const deny = process.argv.includes('deny');
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
    console.log(`mode=${mode}${reject ? ' reject' : ''}${deny ? ' deny' : ''} primary=${cfg.primaryModel} fallback=${cfg.fallbackModel}`);
    console.log('ensureAgents:', JSON.stringify(await ensureAgents(agentsApi(client), cfg)));

    const real = (agent: string, model: string): AgentAttempt => ({
      agent,
      model,
      driver: async () => sessionDriver(client, await createSession(client, agent)),
    });
    const forcedPrimary: AgentAttempt = {
      agent: `${PRIMARY_AGENT_NAME} (forced fault)`,
      model: cfg.primaryModel,
      driver: async () => {
        const spec = { ...manifestFor(cfg.primaryModel), model: { name: cfg.primaryModel, params: FORCED_FAULT_PARAMS } };
        const sid = (await client.sessions.create({ agent: { spec } })).data.id;
        return sessionDriver(client, sid);
      },
    };
    const attempts =
      mode === 'auto'
        ? [real(PRIMARY_AGENT_NAME, cfg.primaryModel), real(FALLBACK_AGENT_NAME, cfg.fallbackModel)]
        : mode === 'failover'
        ? [forcedPrimary, real(FALLBACK_AGENT_NAME, cfg.fallbackModel)]
        : mode === 'fallback'
          ? [real(FALLBACK_AGENT_NAME, cfg.fallbackModel)]
          : [real(PRIMARY_AGENT_NAME, cfg.primaryModel)];

    const seen: string[] = [];
    const models = new Set<string>();
    const result = await runWithFailover(
      'Read hello.txt with read_file, then use propose_write to change the word world to CodeCraft (keep the trailing newline). Then tell me exactly what the propose_write result said.',
      attempts,
      {
        approver: {
          async approve(call) {
            console.log(`APPROVAL REQUESTED: ${call.name} ${call.summary} -> ${deny ? 'deny' : 'allow'}`);
            return deny ? { allow: false, reason: 'denied in live test' } : { allow: true };
          },
        },
        onSwitch: (s) => console.log(`FAILOVER: ${s.from} -> ${s.to} because: ${s.reason}`),
        onEvent: (ev: TurnEvent) => {
          if (ev.type !== 'model.message.delta') seen.push(ev.type);
          if (ev.type === 'model.message' && ev.model?.name) models.add(ev.model.name);
          if (process.env.LIVE_DEBUG && ev.type !== 'model.message.delta') console.log(JSON.stringify(ev).slice(0, 500));
        },
      },
    );
    console.log('models that produced messages:', [...models].join(', ') || '(none)');
    console.log('events:', seen.join(' '));
    console.log('final agent:', result.agent, '| switches:', result.switches.length);
    console.log('outcome:', JSON.stringify(result.outcome));
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
