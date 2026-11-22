import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WriteGate } from '../src/mcp/gate';
import { startMcpServer, unwrapCallArgs } from '../src/mcp/server';
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

test('mcp: lists the nine editor tools', async () => {
  const t = await boot();
  try {
    // callTool wrapper hides listTools, so list through a second client
    const c = new Client({ name: 'x', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(t.server.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const names = (await c.listTools()).tools.map((x) => x.name).sort();
    assert.deepEqual(names, ['list_files', 'list_related', 'propose_changes', 'propose_write', 'read_file', 'run_tests', 'search_symbols', 'search_text', 'submit_plan']);
    await c.close();
  } finally {
    await t.close();
  }
});

test('mcp: read_file, list_files, search_text work and hide protected files', async () => {
  const t = await boot();
  try {
    const page = (await t.call('read_file', { path: 'README.md' })).body;
    assert.deepEqual(
      { content: page.content, startLine: page.startLine, endLine: page.endLine, totalLines: page.totalLines, lineEndings: page.lineEndings },
      { content: 'hello world', startLine: 1, endLine: 1, totalLines: 1, lineEndings: 'lf' },
    );
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

test('mcp: a call envelope nested inside input (observed from gemini-3-5-flash-lite) is unwrapped; other shapes are not', async () => {
  const nested = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_symbols', arguments: { tool_name: 'search_symbols', mcp_server: 'codecraft-editor', input: { query: 'cli' } } } };
  assert.deepEqual((unwrapCallArgs(nested) as typeof nested).params.arguments, { query: 'cli' });
  const twice = { method: 'tools/call', params: { arguments: { input: { mcp_server: 'x', input: { path: 'a.py' } }, tool_name: 'read_file' } } };
  assert.deepEqual((unwrapCallArgs(twice) as typeof twice).params.arguments, { path: 'a.py' });
  const normal = { method: 'tools/call', params: { arguments: { path: 'a.py', input: { x: 1 } } } };
  assert.deepEqual((unwrapCallArgs(normal) as typeof normal).params.arguments, { path: 'a.py', input: { x: 1 } }, 'extra keys: left alone');
  const t = await boot();
  try {
    // end to end over HTTP: the nested form reaches read_file with a valid path
    const c = new Client({ name: 'x', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(t.server.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const r = (await c.callTool({ name: 'read_file', arguments: { tool_name: 'read_file', mcp_server: 'codecraft-editor', input: { path: 'README.md' } } })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(r.isError ?? false, false);
    assert.equal(JSON.parse(r.content[0]!.text).content, 'hello world');
    await c.close();
  } finally {
    await t.close();
  }
});

test('mcp: propose_write refuses whole-file replacement that deletes >30% of lines in large files', async () => {
  const t = await boot();
  try {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const ws = await tempWorkspace({ 'test.txt': lines });
    const applier = new DiskApplier(ws.root);
    const reviewer = new ScriptedReviewer();
    const gate = new WriteGate(ws.fs, applier, reviewer);
    const server2 = await startMcpServer(createHandlers({ fs: ws.fs, gate, tests: { async run() { return { ran: true, exitCode: 0, output: '' }; } } }), TOKEN);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server2.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: Boolean(r.isError), body: JSON.parse(r.content[0]!.text) };
    };
    await call('read_file', { path: 'test.txt' });
    const shortened = Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const r = await call('propose_write', { path: 'test.txt', newContent: shortened, reason: 'truncate' });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /deletes \d+% of the file/);
    await client.close();
    await server2.close();
    await ws.cleanup();
  } finally {
    await t.close();
  }
});

test('mcp: propose_write allows small files to be replaced even with large % deletion', async () => {
  const t = await boot();
  try {
    const original = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n';
    const ws = await tempWorkspace({ 'test.txt': original });
    const applier = new DiskApplier(ws.root);
    const reviewer = new ScriptedReviewer(acceptAll);
    const gate = new WriteGate(ws.fs, applier, reviewer);
    const server2 = await startMcpServer(createHandlers({ fs: ws.fs, gate, tests: { async run() { return { ran: true, exitCode: 0, output: '' }; } } }), TOKEN);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server2.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: Boolean(r.isError), body: JSON.parse(r.content[0]!.text) };
    };
    await call('read_file', { path: 'test.txt' });
    const r = await call('propose_write', { path: 'test.txt', newContent: 'replaced\n', reason: 'replace small file' });
    assert.equal(r.isError, false);
    assert.equal(r.body.status, 'applied');
    await client.close();
    await server2.close();
    await ws.cleanup();
  } finally {
    await t.close();
  }
});

test('mcp: list_files excludes .venv and .claude directories', async () => {
  const t = await boot();
  try {
    const ws = await tempWorkspace({ 'src/app.py': 'x\n', '.venv/bin/python': '#!/bin/sh\n', '.claude/settings.json': '{}', 'README.md': 'hi\n' });
    const applier = new DiskApplier(ws.root);
    const reviewer = new ScriptedReviewer();
    const gate = new WriteGate(ws.fs, applier, reviewer);
    const server2 = await startMcpServer(createHandlers({ fs: ws.fs, gate, tests: { async run() { return { ran: true, exitCode: 0, output: '' }; } } }), TOKEN);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server2.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: Boolean(r.isError), body: JSON.parse(r.content[0]!.text) };
    };
    const files = (await call('list_files')).body.files;
    assert.equal(files.includes('.venv/bin/python'), false);
    assert.equal(files.includes('.claude/settings.json'), false);
    assert.equal(files.includes('README.md'), true);
    assert.equal(files.includes('src/app.py'), true);
    await client.close();
    await server2.close();
    await ws.cleanup();
  } finally {
    await t.close();
  }
});
