// LIVE check (P5) of the ask-user round trip through the real TrueForge: a test-only mock model calls TrueForge's
// ask_user_question tool; CodeCraft's real run loop answers with user.tool_response (as the panel does) and the
// same turn resumes. Prints the observed event sequence. Usage: node out/scenarios/ask-user.js
import { createClient, describeError, sessionDriver } from '../../src/trueforge/client';
import type { TurnEvent } from '../../src/trueforge/client';
import { validateConfig } from '../../src/trueforge/config';
import { ClientToolCall, runWithApprovals } from '../../src/trueforge/run';
import { mockModelName, startMockProvider } from './mock-provider';

const PROVIDER = 'codecraft-test-mock-ask';

async function main(): Promise<void> {
  const client = createClient(validateConfig({}));
  const mock = await startMockProvider(8797);
  try {
    const model = mockModelName('ask_user');
    await client.settings.modelProviders.createOrUpdate({ manifest: { type: 'custom', name: PROVIDER, baseUrl: mock.url, models: [{ modelId: model, name: model, properties: { contextLength: 8192, maxOutputTokens: 1024 } }] } });
    const s = await client.sessions.create({ agent: { spec: { model: { name: `${PROVIDER}/${model}` }, config: { askUserQuestions: { enabled: true } } } } });
    const events: string[] = [];
    const asked: ClientToolCall[] = [];
    const out = await runWithApprovals('Rename the function.', {
      driver: sessionDriver(client, s.data.id),
      approver: { approve: async () => ({ allow: false, reason: 'not expected in this check' }) },
      responder: {
        answer: async (q) => {
          asked.push(q);
          return 'add';
        },
      },
      onEvent: (ev: TurnEvent) => events.push(ev.type === 'turn.update' ? `turn.update(${(ev as { state: { status: string } }).state.status})` : ev.type),
    });
    console.log('events:', events.join(' > '));
    console.log('question:', JSON.stringify(asked));
    console.log('outcome:', JSON.stringify(out));
    console.log('mock calls:', mock.hits.length);
    const ok = out.status === 'done' && out.text === 'You answered: add' && asked.length === 1 && asked[0]!.question === 'Which function should I rename?' && JSON.stringify(asked[0]!.options) === '["add","subtract"]';
    console.log(ok ? 'ASK-USER ROUND TRIP: OK' : 'ASK-USER ROUND TRIP: NOT AS EXPECTED');
    if (!ok) process.exitCode = 1;
  } finally {
    await mock.close();
  }
}
main().catch((e) => {
  console.error('FAILED', describeError(e));
  process.exitCode = 1;
});
