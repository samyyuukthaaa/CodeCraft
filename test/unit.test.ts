import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { DEFAULT_CONFIG, FALLBACK_AGENT_NAME, PRIMARY_AGENT_NAME, validateBaseUrl, validateConfig } from '../src/trueforge/config';
import { AgentsApi, ensureAgents } from '../src/trueforge/client';
import { toDisplay } from '../src/trueforge/events';
import { parseWebviewMessage } from '../src/panel/protocol';
import { buildHtml } from '../src/panel/html';
import { redact } from '../src/util/redact';

test('config: loopback only, model name validated', () => {
  assert.equal(validateBaseUrl('http://localhost:8790'), 'http://localhost:8790');
  assert.throws(() => validateBaseUrl('http://example.com'));
  assert.throws(() => validateBaseUrl('file:///x'));
  assert.throws(() => validateConfig({ primaryModel: 'bad model; rm -rf' }));
  assert.deepEqual(validateConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(validateConfig({ baseUrl: undefined, primaryModel: undefined }), DEFAULT_CONFIG);
});

test('redact removes key-shaped strings', () => {
  const fake = 'AIza' + 'x'.repeat(30);
  assert.ok(!redact(`key ${fake}`).includes(fake));
  assert.ok(!redact('Authorization: Bearer abcdefghijklmnop12345').includes('abcdefghijklmnop12345')); // secret-scan:allow
  assert.ok(!redact('{"api_key":"supersecretvalue"}').includes('supersecretvalue')); // secret-scan:allow
});

function fakeAgents(initial: TrueForgeApi.Agent[]) {
  const calls: string[] = [];
  const api: AgentsApi = {
    async list(req) {
      const rows = initial.filter((a) => a.name === req.agentName);
      return (async function* () {
        yield* rows;
      })();
    },
    async create(req) {
      calls.push(`create:${req.name}:${req.manifest.model.name}:${req.manifest.instructions ?? ''}`);
      return {};
    },
    async update(id, req) {
      calls.push(`update:${id}:${req.manifest.model.name}`);
      return {};
    },
  };
  return { api, calls };
}

test('ensureAgents: registers two agents with identical instructions and different models', async () => {
  const { api, calls } = fakeAgents([]);
  const out = await ensureAgents(api, DEFAULT_CONFIG);
  assert.deepEqual(out, { [PRIMARY_AGENT_NAME]: 'created', [FALLBACK_AGENT_NAME]: 'created' });
  const [p, f] = calls.map((c) => c.split(':'));
  assert.notEqual(p?.[2], f?.[2]);
  assert.equal(p?.slice(3).join(':'), f?.slice(3).join(':'));
});

test('ensureAgents: idempotent when unchanged, updates when the model changed', async () => {
  const first = fakeAgents([]);
  await ensureAgents(first.api, DEFAULT_CONFIG);
  const instructions = first.calls[0]!.split(':').slice(3).join(':');
  const mk = (name: string, id: string, model: string) =>
    ({ id, name, description: '', manifest: { model: { name: model }, instructions } }) as unknown as TrueForgeApi.Agent;
  const same = fakeAgents([
    mk(PRIMARY_AGENT_NAME, 'a1', DEFAULT_CONFIG.primaryModel),
    mk(FALLBACK_AGENT_NAME, 'a2', DEFAULT_CONFIG.fallbackModel),
  ]);
  assert.deepEqual(Object.values(await ensureAgents(same.api, DEFAULT_CONFIG)), ['unchanged', 'unchanged']);
  const changed = fakeAgents([mk(PRIMARY_AGENT_NAME, 'a1', 'old/model'), mk(FALLBACK_AGENT_NAME, 'a2', DEFAULT_CONFIG.fallbackModel)]);
  await ensureAgents(changed.api, DEFAULT_CONFIG);
  assert.deepEqual(changed.calls, [`update:a1:${DEFAULT_CONFIG.primaryModel}`]);
});

test('events: a failed turn is flagged failed and redacted; success is not', () => {
  const err = toDisplay({
    type: 'turn.done',
    id: 'e',
    createdAt: 't',
    threadId: null,
    state: { status: 'error', completedAt: 't', message: '[Model Error] Request failed (503): high demand' },
  } as unknown as TrueForgeApi.TurnStreamingEvent);
  assert.equal(err.failed, true);
  assert.match(err.summary, /503/);
  const ok = toDisplay({
    type: 'turn.done',
    id: 'e',
    createdAt: 't',
    threadId: null,
    state: { status: 'done', completedAt: 't', output: null, requiredActions: [] },
  } as unknown as TrueForgeApi.TurnStreamingEvent);
  assert.equal(ok.failed, undefined);
});

test('webview messages: validated as untrusted input', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'prompt', text: ' hi ' }), { type: 'prompt', text: 'hi' });
  assert.equal(parseWebviewMessage({ type: 'prompt', text: '' }), undefined);
  assert.equal(parseWebviewMessage({ type: 'prompt', text: 'x'.repeat(9000) }), undefined);
  assert.equal(parseWebviewMessage({ type: 'writeFile', path: '/etc/passwd' }), undefined);
  assert.equal(parseWebviewMessage('prompt'), undefined);
  assert.equal(parseWebviewMessage(null), undefined);
});

test('webview html: strict CSP with nonce, no inline handlers, no remote sources', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', nonce: 'N0NCE', scriptUri: 'vscode-resource:/webview.js' });
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-N0NCE'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /\son[a-z]+=/);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
});
