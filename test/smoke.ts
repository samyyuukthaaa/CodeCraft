// Real-TrueForge smoke: registers both agents, then runs a hello turn through each.
// Run with `npm run smoke`. Not part of `npm test` because it needs a live TrueForge and a provider.
import { agentsApi, createClient, createSession, describeError, ensureAgents, streamTurn } from '../src/trueforge/client';
import { FALLBACK_AGENT_NAME, PRIMARY_AGENT_NAME, validateConfig } from '../src/trueforge/config';
import { toDisplay } from '../src/trueforge/events';

async function hello(agent: string): Promise<boolean> {
  const cfg = validateConfig({ baseUrl: process.env.CODECRAFT_BASE_URL });
  const client = createClient(cfg);
  const sid = await createSession(client, agent);
  let answer = '';
  let failed: string | undefined;
  const seen: string[] = [];
  for await (const ev of streamTurn(client, sid, 'Reply with exactly: CODECRAFT HELLO')) {
    if (!seen.includes(ev.type)) seen.push(ev.type);
    const d = toDisplay(ev);
    if (d.delta) answer += d.delta;
    if (d.failed) failed = d.summary;
  }
  console.log(`${agent}: events=[${seen.join(', ')}] answer=${JSON.stringify(answer)} ${failed ? `FAILED ${failed}` : 'ok'}`);
  return !failed && answer.includes('CODECRAFT HELLO');
}

async function main(): Promise<void> {
  const cfg = validateConfig({ baseUrl: process.env.CODECRAFT_BASE_URL });
  const client = createClient(cfg);
  console.log('ensureAgents:', JSON.stringify(await ensureAgents(agentsApi(client), cfg)));
  const a = await hello(PRIMARY_AGENT_NAME);
  const b = await hello(FALLBACK_AGENT_NAME);
  process.exitCode = a && b ? 0 : 1;
}
main().catch((e) => {
  console.error(describeError(e));
  process.exitCode = 2;
});
