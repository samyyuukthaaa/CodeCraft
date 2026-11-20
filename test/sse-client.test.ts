import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { createSseParser } from '../src/forge/sse';
import { assertLoopback, createSession, listModels, runTurn } from '../src/forge/client';
import { redact } from '../src/util/redact';

test('SSE parser handles split chunks and CRLF', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('data: {"a":1}\n'), []);
  assert.deepEqual(p.push('\ndata: {"b":2}\r\n\r\n'), ['{"a":1}', '{"b":2}']);
});

test('assertLoopback rejects remote hosts and non-http schemes', () => {
  assert.doesNotThrow(() => assertLoopback('http://localhost:8790'));
  assert.doesNotThrow(() => assertLoopback('http://127.0.0.1:8790'));
  assert.throws(() => assertLoopback('http://example.com'));
  assert.throws(() => assertLoopback('file:///etc/passwd'));
});

test('redact removes key-shaped strings', () => {
  const fake = 'AIza' + 'x'.repeat(30);
  assert.ok(!redact(`key ${fake}`).includes(fake));
  assert.ok(!redact('Authorization: Bearer abcdefghijklmnop12345').includes('abcdefghijklmnop12345')); // secret-scan:allow
  assert.ok(!redact('{"api_key":"supersecretvalue"}').includes('supersecretvalue')); // secret-scan:allow
});

function mock(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() });
    });
  });
}

test('client: success turn, then error turn shaped like a real TrueForge 503', async () => {
  let turns = 0;
  const srv = await mock((req, res) => {
    if (req.url === '/api/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ name: 'm/one' }] }));
    } else if (req.url === '/api/v1/sessions' && req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { id: 'sess1' } }));
    } else if (req.url === '/api/v1/sessions/sess1/turns') {
      turns++;
      res.setHeader('content-type', 'text/event-stream');
      const ok = turns === 1;
      const done = ok
        ? { type: 'turn.done', state: { status: 'done', output: { content: 'HI', model: { name: 'm/one' } } } }
        : { type: 'turn.done', state: { status: 'error', message: '[Model Error] Request failed (503): high demand' } };
      res.write('data: {"type":"turn.created"}\n\n');
      res.end(`data: ${JSON.stringify(done)}\n\n`);
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  try {
    assert.deepEqual(await listModels(srv.url), ['m/one']);
    const sid = await createSession(srv.url, 'm/one');
    const ok = await runTurn(srv.url, sid, 'x');
    assert.equal(ok.status, 'done');
    assert.equal(ok.content, 'HI');
    const bad = await runTurn(srv.url, sid, 'x');
    assert.equal(bad.status, 'error');
    assert.match(bad.errorMessage ?? '', /503/);
  } finally {
    srv.close();
  }
});
