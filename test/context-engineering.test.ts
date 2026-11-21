// P4: the TrueForge context-engineering feature chosen for the agents: history compaction with an
// input-token trigger (contextManagement.compaction), visible in the panel through TrueForge's events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { COMPACTION_TRIGGER_TOKENS, manifestFor, manifestMatches } from '../src/trueforge/client';
import type { TurnEvent } from '../src/trueforge/client';
import { toDisplay } from '../src/trueforge/events';

test('both agents ask TrueForge to compact history above the input-token trigger', () => {
  for (const model of ['google-gemini/gemini-3-5-flash', 'google-gemini/gemini-3-5-flash-lite']) {
    const cm = manifestFor(model).config?.contextManagement;
    assert.deepEqual(cm, { compaction: { enabled: true, trigger: { type: 'input_tokens', value: COMPACTION_TRIGGER_TOKENS } }, largeToolResponse: { enabled: true } });
  }
  assert.equal(COMPACTION_TRIGGER_TOKENS, 48_000);
});

test('ensureAgents sees a changed or missing compaction trigger as a manifest change', () => {
  const wanted = manifestFor('p/m');
  assert.equal(manifestMatches(wanted, wanted), true);
  const other = { ...wanted, config: { ...wanted.config, contextManagement: { compaction: { enabled: true, trigger: { type: 'input_tokens', value: 999 } } } } } as TrueForgeApi.AgentSpec;
  assert.equal(manifestMatches(other, wanted), false);
  const none = { ...wanted, config: { ...wanted.config, contextManagement: undefined } } as TrueForgeApi.AgentSpec;
  assert.equal(manifestMatches(none, wanted), false);
});

test('compaction is visible in the panel event stream', () => {
  const started = toDisplay({ type: 'thread.context_compaction_started', id: 'a', threadId: 'main', createdAt: 't', trigger: { type: 'input_tokens', value: 48000 } } as unknown as TurnEvent);
  assert.deepEqual(started, { type: 'thread.context_compaction_started', summary: 'compacting the conversation (trigger: input tokens > 48000)' });
  const finished = toDisplay({ type: 'thread.context_compaction_finished', id: 'b', threadId: 'main', createdAt: 't', durationMs: 1234, trigger: { type: 'input_tokens', value: 48000 }, usage: {} } as unknown as TurnEvent);
  assert.deepEqual(finished, { type: 'thread.context_compaction_finished', summary: 'conversation compacted in 1234 ms' });
});
