// The run's final message is honest in code: if the last run_tests failed, it starts with "Tests are still failing"
// and the failing test names, whatever the model said. Observed live (task2 on 7ed63a3): the agent claimed its
// command was "covered by tests" while test_config_command failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { STILL_FAILING, failingTests, honestSummary } from '../src/trueforge/summary';
import { AGENT_INSTRUCTIONS } from '../src/trueforge/config';
import { MAX_FAILED_TEST_RUNS } from '../src/mcp/tools';

// the real pytest output tail from that run
const REAL = [
  '______________________________ test_config_command _____________________________',
  '>       assert result.exit_code == 0',
  'E       assert 2 == 0',
  'tests\\test_cli.py:714: AssertionError',
  '=========================== short test summary info ===========================',
  'FAILED tests/test_cli.py::test_config_command - assert 2 == 0',
  '1 failed, 490 passed in 1.26s',
].join('\r\n');
const CLAIM = 'I have added the built-in `flask` CLI command `config` ... covered by tests in `tests/test_cli.py`.';

test('failing tests: names from real pytest output (FAILED and collection ERROR), TAP and node:test', () => {
  assert.deepEqual(failingTests(REAL), ['tests/test_cli.py::test_config_command']);
  assert.deepEqual(failingTests('ERROR tests/test_cli.py\nFAILED a.py::t1 - x\nFAILED a.py::t1 - x'), ['tests/test_cli.py', 'a.py::t1'], 'collection error; no duplicates');
  assert.deepEqual(failingTests('not ok 3 - adds numbers\n✖ parses input (1.2ms)\n✖ failing tests:'), ['adds numbers', 'parses input']);
  assert.deepEqual(failingTests('1 passed'), []);
});

test('honest summary: failing last tests put "Tests are still failing: <names>." first, whatever the model said', () => {
  const s = honestSummary(CLAIM, { passed: false, output: REAL });
  assert.equal(s, `${STILL_FAILING}: tests/test_cli.py::test_config_command.\n\n${CLAIM}`);
  assert.ok(s.startsWith('Tests are still failing'));
  assert.equal(honestSummary('', { passed: false, output: REAL }), 'Tests are still failing: tests/test_cli.py::test_config_command.');
  assert.equal(honestSummary(CLAIM, { passed: false, output: 'exit 1, no recognisable summary' }), `${STILL_FAILING}: see the last test output.\n\n${CLAIM}`);
});

test('honest summary: unchanged when the last tests passed or no tests ran', () => {
  assert.equal(honestSummary(CLAIM, { passed: true, output: '491 passed' }), CLAIM);
  assert.equal(honestSummary(CLAIM, undefined), CLAIM);
});

test('wiring: the panel shows the honest final message; the scenario run output records it; the agent\'s LAST run_tests counts', () => {
  const ext = fs.readFileSync('src/extension.ts', 'utf8');
  assert.match(ext, /lastAgentTests = \{ passed, output: output \?\? '' \}/, 'every agent run_tests result replaces the last one');
  assert.match(ext, /lastAgentTests = undefined;/, 'reset at the start of each run');
  assert.match(ext, /const final = honestSummary\(outcome\.text, lastAgentTests\);\s+post\(\{ type: 'final', text: final \}\);/);
  assert.match(fs.readFileSync('src/webview/main.ts', 'utf8'), /if \(m\.type === 'final'\) \{\s+answer\.textContent = m\.text;/);
  const h = fs.readFileSync('test/scenarios/harness.ts', 'utf8');
  assert.match(h, /lastTests = \{ passed: r\.proc\.code === 0,/);
  assert.match(h, /finalMessage = honestSummary\(outcome\.text, lastTests\);\s+log\(`FINAL MESSAGE: /);
});

test('instruction line: copy an existing test\'s pattern and helpers (generic); the failed-test-run limit is the configured one', () => {
  assert.ok(AGENT_INSTRUCTIONS.includes('Before writing a test, read an existing test for the same kind of thing in the same test file and copy its pattern and helpers.'));
  assert.doesNotMatch(AGENT_INSTRUCTIONS, /test_cli_runner/, 'no Flask-specific hint');
  assert.equal(MAX_FAILED_TEST_RUNS, 3);
});
