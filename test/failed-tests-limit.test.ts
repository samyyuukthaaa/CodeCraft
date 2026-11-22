// The failed-test-run limit: generic, defined in the configuration (3), documented in the agent instructions, and
// enforced by the plan store: after 3 failed run_tests in one run no more proposals; up to 2 still allow a fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_INSTRUCTIONS, MAX_FAILED_TEST_RUNS } from '../src/trueforge/config';
import { MAX_FAILED_TEST_RUNS as TOOLS_LIMIT, PlanStore } from '../src/mcp/tools';

test('limit: 3, from the configuration, the same value the editor tools enforce', () => {
  assert.equal(MAX_FAILED_TEST_RUNS, 3);
  assert.equal(TOOLS_LIMIT, MAX_FAILED_TEST_RUNS);
});

test('documented for the agent: the instruction names the configured number', () => {
  assert.ok(AGENT_INSTRUCTIONS.includes('7. If run_tests has failed 3 times in this run, stop'));
  assert.ok(AGENT_INSTRUCTIONS.includes('CodeCraft refuses further proposals in that run after 3 failed test runs.'));
  assert.doesNotMatch(AGENT_INSTRUCTIONS, /after 2 fix attempts|after 2 failed test runs/);
});

test('enforced: 2 failed runs still allow a proposal; the 3rd stops further proposals; a passing run does not count', () => {
  const p = new PlanStore();
  p.set({ summary: 's', files: [{ path: 'a.py', action: 'edit', why: 'w' }] });
  p.noteTests(false);
  p.noteTests(true);
  p.noteTests(false);
  assert.equal(p.check(['a.py']), undefined, 'two failed runs: still allowed');
  p.noteTests(false);
  assert.match(p.check(['a.py'])!, /^the tests failed 3 times in this run; do not propose more changes\./);
  p.reset();
  p.set({ summary: 's', files: [{ path: 'a.py', action: 'edit', why: 'w' }] });
  assert.equal(p.check(['a.py']), undefined, 'a new run starts from zero');
});
