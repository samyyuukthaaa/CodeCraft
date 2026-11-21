// P5: the documented confidence rule (src/trust/confidence.ts) and regression detection from real test output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_DEPENDENTS, CHECK_LINES, FileFacts, RISKY_DEPENDENTS, RISKY_FILES, RISKY_LINES, confidenceFor, defaultPlainSentence } from '../src/trust/confidence';
import { WHOLE_COMMAND, compareRuns, failingTests, failureExcerpt } from '../src/trust/regression';

const f = (over: Partial<FileFacts> = {}): FileFacts => ({ path: 'src/flask/cli.py', linesChanged: 6, created: false, deleted: false, inPlan: true, isTest: false, dependents: 0, relatedTests: 2, ...over });

test('confidence: a small planned change to a file with related tests is "sure", and says why', () => {
  const r = confidenceFor([f()], 'not run yet');
  assert.equal(r.tag, 'sure');
  assert.deepEqual(r.reasons, ['small planned change (6 lines) to files covered by tests']);
  assert.equal(confidenceFor([f()], 'passed').tag, 'sure');
  assert.equal(confidenceFor([f({ isTest: true, relatedTests: 0, path: 'tests/test_cli.py' })], 'passed').reasons[0], 'small planned change (6 lines) to test files');
});

test('confidence: each "risky" rule on its own', () => {
  const cases: Array<[string, FileFacts[], Parameters<typeof confidenceFor>[1], RegExp]> = [
    ['regressed', [f()], 'regressed', /a test that passed before now fails/],
    ['tests fail', [f()], 'failed', /the tests fail after this change/],
    ['outside the plan', [f({ inPlan: false })], 'passed', /not in the plan: src\/flask\/cli\.py/],
    ['deletes', [f({ deleted: true })], 'passed', /deletes src\/flask\/cli\.py/],
    ['too many lines', [f({ linesChanged: RISKY_LINES + 1 })], 'passed', /large change \(151 lines; limit 150\)/],
    ['too many files', Array.from({ length: RISKY_FILES + 1 }, (_, i) => f({ path: `m${i}.py`, linesChanged: 1 })), 'passed', /touches 5 files \(limit 4\)/],
    ['widely used', [f({ dependents: RISKY_DEPENDENTS })], 'passed', /widely used: src\/flask\/cli\.py \(imported by 10 files\)/],
  ];
  for (const [name, files, tests, re] of cases) {
    const r = confidenceFor(files, tests);
    assert.equal(r.tag, 'risky', name);
    assert.match(r.reasons.join('; '), re, name);
  }
});

test('confidence: each "check this" rule on its own, and boundaries', () => {
  assert.equal(confidenceFor([f({ linesChanged: CHECK_LINES })], 'passed').tag, 'sure', 'exactly the limit is still sure');
  assert.deepEqual(confidenceFor([f({ linesChanged: CHECK_LINES + 1 })], 'passed'), { tag: 'check this', reasons: ['medium-sized change (41 lines)'] });
  assert.deepEqual(confidenceFor([f({ relatedTests: 0 })], 'passed'), { tag: 'check this', reasons: ['no related tests for src/flask/cli.py'] });
  assert.equal(confidenceFor([f({ relatedTests: 0, created: true })], 'passed').tag, 'sure', 'a new file has no tests yet by definition');
  assert.deepEqual(confidenceFor([f({ dependents: CHECK_DEPENDENTS })], 'passed'), { tag: 'check this', reasons: ['used by other files: src/flask/cli.py (3)'] });
  assert.equal(confidenceFor([f({ dependents: CHECK_DEPENDENTS - 1 })], 'passed').tag, 'sure');
  assert.deepEqual(confidenceFor([f()], 'could not run'), { tag: 'check this', reasons: ['the tests could not be run'] });
  assert.equal(confidenceFor([f({ linesChanged: RISKY_LINES })], 'passed').tag, 'check this', '150 lines is not yet risky');
});

test('confidence: risky wins over check-this, and lists every deciding rule; test status only lowers the tag', () => {
  const r = confidenceFor([f({ inPlan: false, relatedTests: 0, linesChanged: 60 })], 'passed');
  assert.equal(r.tag, 'risky');
  assert.deepEqual(r.reasons, ['not in the plan: src/flask/cli.py']);
  for (const s of ['not run yet', 'passed'] as const) assert.equal(confidenceFor([f({ relatedTests: 0 })], s).tag, 'check this', s);
});

test('plain sentence fallback: short and concrete', () => {
  assert.equal(defaultPlainSentence('add the --env-file option', [f()]), 'This changes cli.py to add the --env-file option.');
  assert.equal(defaultPlainSentence('add tests.', [f({ path: 'tests/test_a.py', created: true })]), 'This creates test_a.py to add tests.');
  assert.equal(defaultPlainSentence('rename x', [f({ path: 'a.py' }), f({ path: 'b.py' }), f({ path: 'c.py' }), f({ path: 'd.py' })]), 'This changes a.py, b.py and 2 more files to rename x.');
});

const PYTEST_BEFORE = `============================= test session starts =============================
collected 3 items
tests/test_cli.py ..F
=========================== short test summary info ===========================
FAILED tests/test_cli.py::test_already_broken - AssertionError
========================= 1 failed, 2 passed in 0.31s =========================`;
const PYTEST_AFTER = `=================================== FAILURES ===================================
______________________________ test_load_dotenv _______________________________
    def test_load_dotenv():
>       assert load_dotenv()
E       AssertionError
=========================== short test summary info ===========================
FAILED tests/test_cli.py::test_load_dotenv - AssertionError
FAILED tests/test_cli.py::test_already_broken - AssertionError
ERROR tests/test_app.py::test_setup - ImportError
========================= 2 failed, 1 passed, 1 error in 0.40s ================`;

test('regression: pytest output; only tests that passed before count as regressions', () => {
  assert.deepEqual(failingTests({ ran: true, exitCode: 1, output: PYTEST_AFTER }), ['tests/test_app.py::test_setup', 'tests/test_cli.py::test_already_broken', 'tests/test_cli.py::test_load_dotenv']);
  const r = compareRuns({ ran: true, exitCode: 1, output: PYTEST_BEFORE }, { ran: true, exitCode: 1, output: PYTEST_AFTER });
  assert.deepEqual(r, { regressed: ['tests/test_app.py::test_setup', 'tests/test_cli.py::test_load_dotenv'], stillFailing: ['tests/test_cli.py::test_already_broken'], fixed: [], baselineKnown: true });
  assert.deepEqual(compareRuns({ ran: true, exitCode: 1, output: PYTEST_AFTER }, { ran: true, exitCode: 0, output: '3 passed' }).fixed.length, 3);
});

test('regression: node:test / TAP and Jest formats; colour codes stripped', () => {
  const tap = 'ok 1 - parses\n\x1b[31mnot ok 2 - rename keeps imports # time=3ms\x1b[0m\n';
  assert.deepEqual(failingTests({ ran: true, exitCode: 1, output: tap }), ['rename keeps imports']);
  const jest = 'FAIL src/a.test.ts\n  ✕ adds numbers (5 ms)\n  ✓ subtracts';
  assert.deepEqual(failingTests({ ran: true, exitCode: 1, output: jest }), ['adds numbers', 'src/a.test.ts']);
});

test('regression: unknown output falls back to the whole command; an unknown baseline never claims a regression', () => {
  assert.deepEqual(failingTests({ ran: true, exitCode: 2, output: 'something broke' }), [WHOLE_COMMAND]);
  assert.deepEqual(failingTests({ ran: true, exitCode: 0, output: 'something' }), []);
  const after = { ran: true, exitCode: 1, output: PYTEST_AFTER };
  assert.equal(compareRuns(undefined, after).baselineKnown, false);
  assert.equal(compareRuns({ ran: false, exitCode: null, output: '' }, after).regressed.length, 0);
  assert.equal(compareRuns({ ran: true, exitCode: 3, output: 'crash' }, after).baselineKnown, false, 'a baseline that failed as a whole hides which tests passed');
  assert.deepEqual(compareRuns({ ran: true, exitCode: 0, output: 'ok' }, { ran: true, exitCode: 1, output: 'boom' }).regressed, [WHOLE_COMMAND]);
});

test('regression: the failure excerpt starts at the failures and is bounded', () => {
  assert.match(failureExcerpt(PYTEST_AFTER), /^=+ FAILURES =+/);
  const long = `${'x'.repeat(10_000)}\n${PYTEST_AFTER}`;
  assert.ok(failureExcerpt(`noise\n${long}`, 1000).length <= 1010);
});
