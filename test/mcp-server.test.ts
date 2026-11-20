import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WriteGate } from '../src/mcp/gate';
import { startMcpServer } from '../src/mcp/server';
import { TestRunner, createHandlers } from '../src/mcp/tools';
import { DiskApplier, ScriptedReviewer, acceptAll, readDisk, rejectAll, tempWorkspace } from './helpers';

const TOKEN = 'test-token-not-a-real-secret'; // secret-scan:allow

async function boot(answer = acceptAll) {
  const ws = await tempWorkspace({ 'src/app.py': 'print("a")\nprint("b")\n', 'README.md': 'hello world\n', '.env': 'SECRET=1\n' });
  const applier = new DiskApplier(ws.root);
  const reviewer = new ScriptedReviewer(answer);
  const gate = new WriteGate(ws.fs, applier, reviewer);
  let testRuns = 0;
  const tests: TestRunner = {
    async run() {
      testRuns++;
      return { ran: true, exitCode: 0, output: 'ok' };
    },
  };
  const server = await startMcpServer(createHandlers({ fs: ws.fs, gate, tests }), TOKEN);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: Boolean(r.isError), body: JSON.parse(r.content[0]!.text) as Record<string, any> };
  };
  return { ws, applier, reviewer, call, testRuns: () => testRuns, close: async () => { await client.close(); await server.close(); await ws.cleanup(); }, server };
}

test('mcp: lists the eight editor tools', async () => {
  const t = await boot();
  try {
    // callTool wrapper hides listTools, so list through a second client
    const c = new Client({ name: 'x', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(t.server.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const names = (await c.listTools()).tools.map((x) => x.name).sort();
    assert.deepEqual(names, ['list_files', 'list_related', 'propose_changes', 'propose_write', 'read_file', 'run_tests', 'search_symbols', 'search_text']);
    await c.close();
  } finally {
    await t.close();
  }
});

test('mcp: read_file, list_files, search_text work and hide protected files', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('read_file', { path: 'README.md' })).body.content, 'hello world\n');
    assert.deepEqual((await t.call('list_files')).body.files, ['README.md', 'src/app.py']);
    const s = await t.call('search_text', { query: 'PRINT("B")' });
    assert.deepEqual(s.body.matches.map((m: any) => `${m.path}:${m.line}`), ['src/app.py:2']);
    assert.equal((await t.call('read_file', { path: '.env' })).isError, true);
    assert.equal((await t.call('read_file', { path: '../x' })).isError, true);
  } finally {
    await t.close();
  }
});

test('mcp: propose_write without a prior read_file is refused, nothing written', async () => {
  const t = await boot();
  try {
    const r = await t.call('propose_write', { path: 'src/app.py', newContent: 'x\n', reason: 'r' });
    assert.equal(r.isError, true);
    assert.equal(t.applier.writes.length, 0);
    assert.equal(t.reviewer.requests.length, 0);
  } finally {
    await t.close();
  }
});

test('mcp: propose_write applies accepted hunks only after review', async () => {
  const t = await boot();
  try {
    await t.call('read_file', { path: 'src/app.py' });
    const r = await t.call('propose_write', { path: 'src/app.py', newContent: 'print("a")\nprint("B")\n', reason: 'shout' });
    assert.equal(r.isError, false);
    assert.equal(r.body.status, 'applied');
    assert.equal(t.reviewer.requests.length, 1);
    assert.equal(await readDisk(t.ws.root, 'src/app.py'), 'print("a")\nprint("B")\n');
  } finally {
    await t.close();
  }
});

test('mcp: rejected hunk is never written', async () => {
  const t = await boot(rejectAll);
  try {
    await t.call('read_file', { path: 'src/app.py' });
    const r = await t.call('propose_write', { path: 'src/app.py', newContent: 'changed\n', reason: 'r' });
    assert.equal(r.body.status, 'rejected');
    assert.equal(t.applier.writes.length, 0);
    assert.equal(await readDisk(t.ws.root, 'src/app.py'), 'print("a")\nprint("b")\n');
  } finally {
    await t.close();
  }
});

test('mcp: stale file is refused', async () => {
  const t = await boot();
  try {
    await t.call('read_file', { path: 'src/app.py' });
    await fs.writeFile(path.join(t.ws.root, 'src/app.py'), 'user changed it\n');
    const r = await t.call('propose_write', { path: 'src/app.py', newContent: 'agent version\n', reason: 'r' });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /changed since it was read/);
    assert.equal(await readDisk(t.ws.root, 'src/app.py'), 'user changed it\n');
  } finally {
    await t.close();
  }
});

test('mcp: run_tests reports the runner result', async () => {
  const t = await boot();
  try {
    const r = await t.call('run_tests');
    assert.deepEqual({ exit: r.body.exitCode, passed: r.body.passed, runs: t.testRuns() }, { exit: 0, passed: true, runs: 1 });
  } finally {
    await t.close();
  }
});

test('mcp: server rejects missing/wrong token, bad host and browser origins', async () => {
  const t = await boot();
  try {
    const post = (headers: Record<string, string>) =>
      fetch(t.server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{}' });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post({ Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(t.server.url.replace('/mcp', '/other'), { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })).status, 404);
    assert.equal((await fetch(t.server.url, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } })).status, 405);
  } finally {
    await t.close();
  }
});
