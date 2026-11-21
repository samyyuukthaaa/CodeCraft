import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderScan, scanText, scanWorkspace } from '../src/util/secretScan';
import { tempWorkspace } from './helpers';

// Built at runtime so this file never contains a key-shaped literal.
const GOOGLE = 'AIza' + 'Sy'.padEnd(37, 'B');
const GROQ = 'gsk_' + 'c'.repeat(40);
const AWS = 'AKIA' + 'QWERTYUIOPASDFGH';

test('scanText: finds each key shape with file, line and rule; never stores the value; honours the allow marker', () => {
  const text = [`GOOGLE = "${GOOGLE}"`, 'nothing here', `groq: ${GROQ}  # secret-scan:allow`, `aws = ${AWS}`, `password = "hunter2hunter2"`].join('\n');
  const f = scanText('cfg.py', text);
  assert.deepEqual(f.map((x) => `${x.line}:${x.rule}`), ['1:Google API key', '4:AWS access key id', '5:key/token/password assignment']);
  assert.ok(!JSON.stringify(f).includes(GOOGLE));
  assert.ok(!JSON.stringify(f).includes('hunter2'));
  const pem = ['-----BEGIN', 'PRIVATE KEY-----', '\nMIIB\n-----END', 'PRIVATE KEY-----'].join(' ');
  assert.deepEqual(scanText('id.pem', `x\n${pem}`).map((x) => x.rule), ['private key']);
});

test('scanWorkspace + renderScan: over real files, binary/huge skipped, env files listed, report has no values', async () => {
  const ws = await tempWorkspace({ 'src/a.py': `KEY = "${GOOGLE}"\n`, 'src/b.py': 'print(1)\n', 'blob.bin': 'ab\0cd' });
  try {
    const files = await ws.fs.list();
    const r = await scanWorkspace(files, (p) => ws.fs.read(p), ['.env', 'config/.env.local']);
    assert.equal(r.scannedFiles, 2);
    assert.equal(r.skippedFiles, 1);
    assert.deepEqual(r.findings.map((f) => `${f.path}:${f.line}`), ['src/a.py:1']);
    const md = renderScan(r);
    assert.match(md, /1 possible secret\(s\)/);
    assert.match(md, /- src\/a\.py:1 - Google API key/);
    assert.match(md, /## Environment files[\s\S]*- \.env\n- config\/\.env\.local/);
    assert.ok(!md.includes(GOOGLE));
    assert.match(renderScan({ scannedFiles: 1, skippedFiles: 0, findings: [], envFiles: [] }), /No key-shaped values found/);
  } finally {
    await ws.cleanup();
  }
});
