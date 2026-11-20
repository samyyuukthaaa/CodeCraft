// One-off probe (test only): create the dummy-key provider and agent, run one plain turn, print the
// real error TrueForge reports. Usage: node esbuild.mjs --scenarios && node out/scenarios/probe-badkey.js
import { createClient, createSession, describeError, streamTurn } from '../../src/trueforge/client';
import { validateConfig } from '../../src/trueforge/config';
import { DUMMY_KEY, TEST_AGENT_NAME, ensureTestAgent, ensureTestProvider } from './testProvider';

async function main(): Promise<void> {
  const client = createClient(validateConfig({}));
  await ensureTestProvider(client);
  await ensureTestAgent(client);
  console.log('test provider and agent ready');
  const sid = await createSession(client, TEST_AGENT_NAME);
  const t0 = Date.now();
  for await (const ev of streamTurn(client, sid, 'Reply with: hello')) {
    if (ev.type === 'turn.done') {
      const msg = ev.state.status === 'error' ? ev.state.message : `(status ${ev.state.status})`;
      console.log(`turn.done after ${Date.now() - t0} ms: status=${ev.state.status}`);
      console.log(`message: ${msg}`);
      console.log(`dummy key echoed in message: ${msg.includes(DUMMY_KEY)}`);
    }
  }
}
main().catch((e) => {
  console.error('FAILED:', describeError(e));
  process.exitCode = 2;
});
