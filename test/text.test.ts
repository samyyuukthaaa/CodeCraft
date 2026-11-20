import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WriteGate } from '../src/mcp/gate';
import { RESPONSE_BUDGET, applyEdits, eolOf, matchEol, pageOf, toEol } from '../src/mcp/text';
import { createHandlers } from '../src/mcp/tools';
import { DiskApplier, ScriptedReviewer, acceptAll, readDisk, tempWorkspace } from './helpers';

// Same size class as src/flask/helpers.py at 3.1.3 (634 lines, ~24.9k chars with CRLF), which TrueForge
// truncated when read_file returned it whole.
const BIG_CRLF = Array.from({ length: 634 }, (_, i) => `    value_${i} = "some \\"quoted\\" text for line ${i}"  # comment`).join('\r\n') + '\r\n';

test('eol: detection, conversion and matching to an existing file', () => {
  assert.equal(eolOf('a\r\nb\r\n'), '\r\n');
  assert.equal(eolOf('a\nb\n'), '\n');
  assert.equal(toEol('a\nb\r\nc', '\r\n'), 'a\r\nb\r\nc');
  assert.equal(matchEol('x\r\ny\r\n', 'x\nz\n'), 'x\r\nz\r\n');
  assert.equal(matchEol(undefined, 'new\n'), 'new\n');
});

test('pageOf: every page of a large CRLF file fits the TrueForge response limit; pages cover the file exactly', () => {
  let start = 1;
  const seen: string[] = [];
  for (let guard = 0; guard < 20; guard++) {
    const p = pageOf(BIG_CRLF, start);
    assert.ok(JSON.stringify(p).length <= RESPONSE_BUDGET, `page at ${start} is ${JSON.stringify(p).length} chars`);
    assert.equal(p.totalLines, 634);
    assert.equal(p.lineEndings, 'crlf');
    seen.push(...p.content.split('\n'));
    if (!p.nextStartLine) break;
    start = p.nextStartLine;
  }
  assert.equal(seen.length, 634);
  assert.deepEqual(seen, BIG_CRLF.replace(/\r\n$/, '').split('\r\n'));
  const mid = pageOf(BIG_CRLF, 100, 102);
  assert.deepEqual([mid.startLine, mid.endLine, mid.nextStartLine], [100, 102, 103]);
  assert.equal(pageOf('', 1).totalLines, 1);
});

test('applyEdits: exact-once matching, line endings preserved, clear errors', () => {
  const crlf = 'def f():\r\n    return 1\r\n\r\ndef g():\r\n    return 1\r\n';
  const ok = applyEdits(crlf, [{ find: 'def f():\n    return 1', replace: 'def f():\n    return 2' }]);
  assert.deepEqual(ok, { ok: true, text: 'def f():\r\n    return 2\r\n\r\ndef g():\r\n    return 1\r\n' });
  const amb = applyEdits(crlf, [{ find: '    return 1', replace: 'x' }]);
  assert.equal(amb.ok, false);
  assert.match((amb as { error: string }).error, /more than once/);
  const missing = applyEdits(crlf, [{ find: 'def h():', replace: 'x' }]);
  assert.match((missing as { error: string }).error, /not found/);
  const seq = applyEdits('a\nb\n', [{ find: 'a', replace: 'A' }, { find: 'A\nb', replace: 'AB' }]);
  assert.deepEqual(seq, { ok: true, text: 'AB\n' });
});

test('applyEdits: over-escaped find/replace (observed live) is decoded once, only when the exact text is absent', () => {
  const crlf = '    if add_default_commands:\r\n        self.add_command(run_command)\r\n        self.add_command(shell_command)\r\n';
  // exactly what gemini-3-1-flash-lite sent: literal backslash-n instead of newlines, in find AND replace
  const find = '    if add_default_commands:\\n        self.add_command(run_command)\\n';
  const replace = '    if add_default_commands:\\n        self.add_command(run_command)\\n        self.add_command(config_command)\\n';
  assert.deepEqual(applyEdits(crlf, [{ find, replace }]), {
    ok: true,
    text: '    if add_default_commands:\r\n        self.add_command(run_command)\r\n        self.add_command(config_command)\r\n        self.add_command(shell_command)\r\n',
  });
  // a replacement that already has real newlines is NOT decoded (keeps a deliberate "\n" inside a string)
  const r2 = applyEdits('x = 1\ny = 2\n', [{ find: 'x = 1\\ny = 2', replace: 'x = 1\ny = "a\\nb"' }]);
  assert.deepEqual(r2, { ok: true, text: 'x = 1\ny = "a\\nb"\n' });
  // literal backslash-n text that really exists in the file is matched as written, not decoded
  const code = 'print("a\\nb")\nprint("a")\n';
  assert.deepEqual(applyEdits(code, [{ find: 'print("a\\nb")', replace: 'print("c\\nd")' }]), { ok: true, text: 'print("c\\nd")\nprint("a")\n' });
  // decoded text must still match exactly once
  const twice = 'a\nb\na\nb\n';
  assert.match((applyEdits(twice, [{ find: 'a\\nb', replace: 'x' }]) as { error: string }).error, /not found/);
});

test('tools: read_file pages a large file; propose_changes with edits keeps CRLF and only changes the edited lines', async () => {
  const ws = await tempWorkspace({ 'big.py': BIG_CRLF, 'crlf.py': 'def f():\r\n    return 1\r\n' });
  try {
    const applier = new DiskApplier(ws.root);
    const gate = new WriteGate(ws.fs, applier, new ScriptedReviewer(acceptAll));
    const h = createHandlers({ fs: ws.fs, gate, tests: { run: async () => ({ ran: false, output: '' }) } });
    const first = await h.read_file({ path: 'big.py' });
    assert.ok(first.text.length <= RESPONSE_BUDGET);
    assert.ok(JSON.parse(first.text).nextStartLine > 1);

    await h.read_file({ path: 'crlf.py' });
    const r = await h.propose_changes({ plan: 'p', groups: [{ intent: 'implement', files: [{ path: 'crlf.py', edits: [{ find: 'return 1', replace: 'return 2' }] }] }] });
    assert.equal(JSON.parse(r.text).status, 'applied');
    assert.equal(await readDisk(ws.root, 'crlf.py'), 'def f():\r\n    return 2\r\n');

    // full newContent sent with \n is written with the file's CRLF endings
    await h.read_file({ path: 'crlf.py' });
    await h.propose_write({ path: 'crlf.py', newContent: 'def f():\n    return 3\n', reason: 'r' });
    assert.equal(await readDisk(ws.root, 'crlf.py'), 'def f():\r\n    return 3\r\n');

    const both = await h.propose_changes({ plan: 'p', groups: [{ intent: 'x', files: [{ path: 'crlf.py', newContent: 'a', edits: [{ find: 'a', replace: 'b' }] }] }] });
    assert.match(both.text, /either newContent or edits/);
    const bad = await h.propose_changes({ plan: 'p', groups: [{ intent: 'x', files: [{ path: 'crlf.py', edits: [{ find: 'nope', replace: 'b' }] }] }] });
    assert.equal(bad.isError, true);
    const newWithEdits = await h.propose_changes({ plan: 'p', groups: [{ intent: 'x', files: [{ path: 'new.py', edits: [{ find: 'a', replace: 'b' }] }] }] });
    assert.match(newWithEdits.text, /does not exist; use newContent/);
  } finally {
    await ws.cleanup();
  }
});
