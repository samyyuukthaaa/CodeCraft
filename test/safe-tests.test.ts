import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTestCommand, scrubEnv } from '../src/mcp/safeTests';

test('parseTestCommand: plain commands and quoted arguments are accepted as program + args', () => {
  assert.deepEqual(parseTestCommand('npm test'), { ok: true, command: { file: 'npm', args: ['test'], display: 'npm test' } });
  assert.deepEqual(parseTestCommand('.venv\\Scripts\\python -m pytest -q'), { ok: true, command: { file: '.venv\\Scripts\\python', args: ['-m', 'pytest', '-q'], display: '.venv\\Scripts\\python -m pytest -q' } });
  const q = parseTestCommand('"C:/Program Files/py/python.exe" -m pytest tests/test_cli.py');
  assert.ok(q.ok);
  assert.deepEqual(q.ok && q.command.file, 'C:/Program Files/py/python.exe');
  assert.equal(q.ok && q.command.display, '"C:/Program Files/py/python.exe" -m pytest tests/test_cli.py');
});

test('parseTestCommand: chaining, redirection, substitution, newlines, empty and overlong commands are refused', () => {
  for (const bad of ['npm test && rm -rf /', 'npm test; curl x', 'npm test | tee out', 'npm test > out.txt', 'echo $(whoami)', 'echo `id`', 'npm test\nrm x', 'pytest ${HOME}', '', '   ', 'a'.repeat(301), 'pytest "unbalanced']) {
    assert.equal(parseTestCommand(bad).ok, false, JSON.stringify(bad));
  }
});

test('scrubEnv: provider keys, tokens, passwords and cloud credentials are removed; ordinary variables kept', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    GEMINI_API_KEY: 'x',
    GOOGLE_API_KEY: 'x',
    GROQ_API_KEY: 'x',
    OPENAI_API_KEY: 'x',
    ANTHROPIC_API_KEY: 'x',
    GITHUB_TOKEN: 'x',
    NPM_TOKEN: 'x',
    DB_PASSWORD: 'x',
    AWS_SECRET_ACCESS_KEY: 'x',
    AWS_ACCESS_KEY_ID: 'x',
    GOOGLE_APPLICATION_CREDENTIALS: 'x',
    MY_SECRET: 'x',
    FLASK_DEBUG: '1',
    KEYBOARD_LAYOUT: 'us',
    PYTHONPATH: 'src',
  };
  const r = scrubEnv(env);
  assert.deepEqual(Object.keys(r.env).sort(), ['FLASK_DEBUG', 'HOME', 'KEYBOARD_LAYOUT', 'PATH', 'PYTHONPATH']);
  assert.equal(r.removed.length, 12);
});
