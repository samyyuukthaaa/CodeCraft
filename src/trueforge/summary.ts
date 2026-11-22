// The run's final message, made honest in code. Observed live (task2 on 7ed63a3): the agent's last run_tests failed
// (test_config_command), yet its final message said the command was "covered by tests". If the last run_tests in a
// run failed, the final message now starts with a plain "Tests are still failing" line naming the failing tests,
// whatever the model said. Pure: no VS Code, no I/O.

export interface TestOutcome {
  passed: boolean;
  /** The (tail of the) real test output. */
  output: string;
}

export const STILL_FAILING = 'Tests are still failing';
const MAX_NAMES = 20;

/** Failing test names from real test output: pytest FAILED / ERROR lines, then TAP "not ok" and "✖" lines. */
export function failingTests(output: string): string[] {
  const names: string[] = [];
  const add = (n: string): void => {
    const t = n.trim();
    if (t && !names.includes(t) && names.length < MAX_NAMES) names.push(t);
  };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^FAILED\s+(\S+)/.exec(line); // pytest short summary: FAILED tests/test_cli.py::test_x - assert 2 == 0
    if (m) add(m[1]!);
    m = /^ERROR\s+(\S+)/.exec(line); // pytest collection error: ERROR tests/test_cli.py
    if (m) add(m[1]!);
    m = /^not ok \d+ - (.+)$/.exec(line); // TAP
    if (m) add(m[1]!);
    m = /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(line); // node:test
    if (m && !/^failing tests:?$/.test(m[1]!)) add(m[1]!);
  }
  return names;
}

/** The final message: unchanged when the last tests passed (or none ran); otherwise prefixed with the plain truth. */
export function honestSummary(text: string, last: TestOutcome | undefined): string {
  if (!last || last.passed) return text;
  const names = failingTests(last.output);
  const head = `${STILL_FAILING}: ${names.length ? names.join(', ') : 'see the last test output'}.`;
  return text.trim() ? `${head}\n\n${text}` : head;
}
