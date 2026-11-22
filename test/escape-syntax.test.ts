// Over-escaped edit text and the in-memory Python syntax check. Observed live (task2 on c7c390b, session
// 01m81hgcjfkf6e3y2ad6r6zn9z, gemini-3-5-flash-lite): every replacement came as one line with literal backslash-n;
// tests/test_cli.py got a SyntaxError at collection and the run failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as path from 'node:path';
import { WriteGate } from '../src/mcp/gate';
import { isPython, pythonSyntaxCheck } from '../src/mcp/pySyntax';
import { applyEdits, decodeOverEscaped } from '../src/mcp/text';
import { MAX_FAILED_TEST_RUNS, PlanStore, createHandlers } from '../src/mcp/tools';
import { AGENT_INSTRUCTIONS } from '../src/trueforge/config';
import { DiskApplier, ScriptedReviewer, acceptAll, readDisk, tempWorkspace } from './helpers';

// The real replacement text from that session (start of the cli.py edit), exactly as the model sent it.
const REAL = String.raw`    rows.insert(0, headers)\n    widths = [max(len(row[i]) for row in rows) for i in range(len(headers))]\n    rows.insert(1, ["-" * w for w in widths])\n    template = "  ".join(f"{{{i}:<{w}}}" for i, w in enumerate(widths))\n\n    for row in rows:\n        click.echo(template.format(*row))\n\n\n@click.command("config", short_help="Show the config for the app.")\n@with_appcontext\ndef config_command() -> None:\n    """Show the app's configuration as JSON."""\n    pass`;
const CURRENT = 'def routes_command():\n    rows = []\n    rows.insert(0, headers)\n    return rows\n';

test('decode: the real failing replacement (one line, literal \\n, exact one-line find) becomes real lines for a .py file', () => {
  const r = applyEdits(CURRENT, [{ find: '    rows.insert(0, headers)', replace: REAL }], 'src/flask/cli.py');
  assert.equal(r.ok, true);
  const text = (r as { text: string }).text;
  assert.ok(!text.includes('\\n'), 'no literal backslash-n left');
  assert.ok(text.includes('\n@click.command("config", short_help="Show the config for the app.")\n@with_appcontext\ndef config_command() -> None:\n'));
  assert.ok(text.includes('template = "  ".join(f"{{{i}:<{w}}}" for i, w in enumerate(widths))'), 'other characters unchanged');
  // without a path (low-level use) the old behaviour stays
  assert.ok((applyEdits(CURRENT, [{ find: '    rows.insert(0, headers)', replace: REAL }]) as { text: string }).text.includes('\\n'));
});

test('decode: only code/docs/config files, only without real newlines, only with 2+ literal \\n (intentional escapes stay)', () => {
  assert.equal(decodeOverEscaped('tests/test_cli.py', 'a\\nb\\nc'), 'a\nb\nc');
  assert.equal(decodeOverEscaped('docs/cli.rst', 'Title\\n=====\\n'), 'Title\n=====\n');
  assert.equal(decodeOverEscaped('setup.cfg', 'x\\ny\\n'), 'x\ny\n');
  assert.equal(decodeOverEscaped('src/app.py', 'print("a\\nb")'), 'print("a\\nb")', 'one escape inside a string is kept');
  assert.equal(decodeOverEscaped('src/app.py', 'x = 1\nprint("a\\nb\\nc")'), 'x = 1\nprint("a\\nb\\nc")', 'text with real newlines is never touched');
  assert.equal(decodeOverEscaped('web/app.js', 'a\\nb\\nc'), 'a\\nb\\nc', 'other file types are not touched');
  // an intentional single escape in a one-line Python edit stays exactly as written (existing behaviour)
  assert.deepEqual(applyEdits('print("a\\nb")\nprint("a")\n', [{ find: 'print("a\\nb")', replace: 'print("c\\nd")' }], 'x.py'), { ok: true, text: 'print("c\\nd")\nprint("a")\n' });
});

function findPython(): string | undefined {
  const venv = path.resolve('fixtures/flask/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  for (const p of [venv, 'python', 'python3']) {
    try {
      if (cp.spawnSync(p, ['-c', 'print(1)'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() === '1') return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

test('syntax check (real Python, in memory): valid code passes; the literal-\\n file fails with the exact error and line', async (t) => {
  const py = findPython();
  if (!py) return t.skip('no Python on this machine');
  const check = pythonSyntaxCheck(py);
  assert.equal(await check('src/a.py', 'def f():\n    return 1\n'), undefined);
  const broken = `def f():\n    return 1\n${REAL}\n`; // what was written into the file live
  const e = await check('tests/test_cli.py', broken);
  assert.ok(e, 'a syntax error is reported');
  assert.match(e!, /unexpected character after line continuation character \(line 3, column \d+\)/);
  assert.equal(await check('docs/cli.rst', 'not python \\n at all'), undefined, 'only .py files are checked');
  assert.ok(isPython('a/b.py') && isPython('a/b.pyi') && !isPython('a/b.rst'));
});

test('syntax check unavailable: skipped (undefined) and reported once', async () => {
  const why: string[] = [];
  const check = pythonSyntaxCheck('no-such-python-binary-xyz', (w) => why.push(w));
  assert.equal(await check('a.py', 'def ('), undefined);
  assert.equal(await check('b.py', 'def ('), undefined);
  assert.equal(why.length, 1);
});

async function boot(files: Record<string, string>, check: (p: string, c: string) => Promise<string | undefined>) {
  const ws = await tempWorkspace(files);
  let reviews = 0;
  const reviewer = new ScriptedReviewer((req) => (reviews++, acceptAll(req)));
  const gate = new WriteGate(ws.fs, new DiskApplier(ws.root), reviewer);
  const plan = new PlanStore();
  const checked: string[] = [];
  const h = createHandlers({ fs: ws.fs, gate, tests: { run: async () => ({ ran: true, exitCode: 0, output: '' }) }, plan, syntaxCheck: async (p, c) => (checked.push(p), check(p, c)) });
  return { h, ws, reviews: () => reviews, checked, plan };
}

test('tools: a proposal whose Python does not compile is refused with the exact error; nothing is reviewed or written', async () => {
  const { h, ws, reviews, checked } = await boot({ 'src/app.py': 'x = 1\n', 'docs/a.rst': 'A\n' }, async (p) => (p === 'src/app.py' ? 'invalid syntax (line 2, column 5): def (' : undefined));
  try {
    await h.read_file({ path: 'src/app.py' });
    await h.read_file({ path: 'docs/a.rst' });
    await h.submit_plan({ summary: 's', files: [{ path: 'src/app.py', action: 'edit', why: 'w' }, { path: 'docs/a.rst', action: 'edit', why: 'w' }] });
    const r = await h.propose_changes({ plan: '1', groups: [{ intent: 'docs', files: [{ path: 'docs/a.rst', newContent: 'B\n' }] }, { intent: 'implement', files: [{ path: 'src/app.py', edits: [{ find: 'x = 1', replace: 'x = 1\ndef (' }] }] }] });
    assert.equal(r.isError, true);
    assert.match(r.text, /src\/app\.py: the proposed file has a Python syntax error: invalid syntax \(line 2, column 5\): def \(\. Nothing was written\./);
    assert.equal(reviews(), 0, 'never reached the review');
    assert.equal(await readDisk(ws.root, 'src/app.py'), 'x = 1\n');
    assert.equal(await readDisk(ws.root, 'docs/a.rst'), 'A\n', 'the whole proposal is refused');
    assert.deepEqual(checked, ['src/app.py'], 'only Python files are checked');
    const w = await h.propose_write({ path: 'src/app.py', newContent: 'def (\n', reason: 'r' });
    assert.equal(w.isError, true);
    assert.equal(await readDisk(ws.root, 'src/app.py'), 'x = 1\n');
  } finally {
    await ws.cleanup();
  }
});

test('tools: over-escaped newContent and edits are decoded before the check and the review (the agent can then succeed)', async () => {
  const { h, ws, reviews } = await boot({ 'tests/test_x.py': 'import os\n' }, async () => undefined);
  try {
    await h.read_file({ path: 'tests/test_x.py' });
    await h.submit_plan({ summary: 's', files: [{ path: 'tests/test_x.py', action: 'edit', why: 'w' }, { path: 'tests/test_y.py', action: 'create', why: 'w' }] });
    const r = await h.propose_changes({ plan: '1', groups: [{ intent: 'add test', files: [
      { path: 'tests/test_x.py', edits: [{ find: 'import os', replace: 'import os\\n\\n\\ndef test_config():\\n    assert True' }] },
      { path: 'tests/test_y.py', newContent: 'def test_y():\\n    assert True\\n' },
    ] }] });
    assert.equal(r.isError, false, r.text);
    assert.equal(reviews(), 1);
    assert.equal(await readDisk(ws.root, 'tests/test_x.py'), 'import os\n\n\ndef test_config():\n    assert True\n');
    assert.equal(await readDisk(ws.root, 'tests/test_y.py'), 'def test_y():\n    assert True\n');
  } finally {
    await ws.cleanup();
  }
});

test('agent instruction: register a new flask CLI command with the group and verify it in flask --help; 2-failed-runs limit unchanged', () => {
  assert.ok(AGENT_INSTRUCTIONS.includes('A new flask CLI command must be registered with the command group'));
  assert.ok(AGENT_INSTRUCTIONS.includes('verify that it appears in flask --help'));
  assert.ok(AGENT_INSTRUCTIONS.includes('If run_tests still fails after 2 fix attempts, stop'));
  assert.equal(MAX_FAILED_TEST_RUNS, 2, 'the 2-failed-test-runs limit is unchanged');
});
