// TEST-ONLY TrueForge fixtures for Task C. Never a default: nothing in src/, config.example.json or the
// README refers to these names. The key is an obvious dummy, so the provider rejects it for real.
// Groq's OpenAI-compatible endpoint is used because it answers a bad key with HTTP 401; Google's
// OpenAI-compatible endpoint surfaced only "400 Bad Request" through TrueForge, which cannot honestly be
// told apart from other bad requests (observed 2026-11-20). This module only ever creates/updates/deletes the provider and agent
// named below; it never lists, reads or prints any other provider (and so never touches real keys).
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { manifestFor } from '../../src/trueforge/client';

export const TEST_PROVIDER_NAME = 'codecraft-test-badkey';
export const TEST_MODEL_REF = `${TEST_PROVIDER_NAME}/gpt-oss-120b`;
export const TEST_AGENT_NAME = 'codecraft-test-primary-badkey';
/** Deliberately invalid, human-readable dummy (not key-shaped, so secret scanners do not flag it). */
export const DUMMY_KEY = 'DUMMY-INVALID-KEY-FOR-CODECRAFT-TESTS';

async function deleteTestAgent(client: TrueForge): Promise<void> {
  for await (const a of await client.agents.list({ agentName: TEST_AGENT_NAME, limit: 5 })) {
    if (a.name === TEST_AGENT_NAME) await client.agents.delete(a.id);
  }
}

/** TrueForge refuses to change a provider's models while an agent uses them, so the test agent goes first. */
export async function ensureTestProvider(client: TrueForge): Promise<void> {
  await deleteTestAgent(client);
  await client.settings.modelProviders.createOrUpdate({
    manifest: {
      type: 'custom',
      name: TEST_PROVIDER_NAME,
      baseUrl: 'https://api.groq.com/openai/v1',
      auth: { apiKey: DUMMY_KEY },
      models: [{ modelId: 'openai/gpt-oss-120b', name: 'gpt-oss-120b', properties: { contextLength: 131072, maxOutputTokens: 32768 } }],
    },
  });
}

/** A test-only primary agent, identical to the real ones except that its model uses the dummy key. */
export async function ensureTestAgent(client: TrueForge): Promise<void> {
  const manifest = manifestFor(TEST_MODEL_REF);
  for await (const a of await client.agents.list({ agentName: TEST_AGENT_NAME, limit: 5 })) {
    if (a.name === TEST_AGENT_NAME) {
      await client.agents.update(a.id, { description: 'TEST ONLY: CodeCraft Task C (invalid key)', manifest });
      return;
    }
  }
  await client.agents.create({ name: TEST_AGENT_NAME, description: 'TEST ONLY: CodeCraft Task C (invalid key)', manifest });
}
