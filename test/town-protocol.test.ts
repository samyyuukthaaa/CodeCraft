import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTownMessage } from '../src/town/protocol';
import { buildTownHtml } from '../src/town/html';

test('parseTownMessage: validates untrusted webview messages', () => {
  // Valid open_file
  assert.deepEqual(parseTownMessage({ type: 'open_file', path: 'src/mcp/gate.ts' }), {
    type: 'open_file',
    path: 'src/mcp/gate.ts',
  });

  // Windows slashes normalized
  assert.deepEqual(parseTownMessage({ type: 'open_file', path: 'src\\index\\types.ts' }), {
    type: 'open_file',
    path: 'src/index/types.ts',
  });

  // Replay run
  assert.deepEqual(parseTownMessage({ type: 'replay_run' }), {
    type: 'replay_run',
  });

  // Security checks: traversal and absolute paths denied
  assert.equal(parseTownMessage({ type: 'open_file', path: '../secret.env' }), undefined);
  assert.equal(parseTownMessage({ type: 'open_file', path: '/etc/passwd' }), undefined);
  assert.equal(parseTownMessage({ type: 'open_file', path: '\\windows\\system32' }), undefined);
  assert.equal(parseTownMessage({ type: 'open_file', path: '' }), undefined);
  assert.equal(parseTownMessage({ type: 'unknown_cmd' }), undefined);
  assert.equal(parseTownMessage(null), undefined);
  assert.equal(parseTownMessage('string'), undefined);
});

test('buildTownHtml: strict CSP, nonce, and containers', () => {
  const nonce = 'test-nonce-1234';
  const html = buildTownHtml({
    cspSource: 'vscode-webview:',
    nonce,
    scriptUri: 'vscode-webview://out/codetown.js',
  });

  assert.ok(html.includes(`default-src 'none'`));
  assert.ok(html.includes(`script-src 'nonce-${nonce}' vscode-webview:`));
  assert.ok(html.includes(`style-src 'nonce-${nonce}'`));
  assert.ok(!html.includes('unsafe-inline'));
  assert.ok(html.includes('id="canvas-container"'));
  assert.ok(html.includes('id="fallback-view"'));
  assert.ok(html.includes('id="tooltip"'));
  assert.ok(html.includes('id="btn-replay"'));
  assert.ok(html.includes(`nonce="${nonce}" src="vscode-webview://out/codetown.js"`));
});
