// Pure: finds tests that passed before a change and fail after it (P5). Works from the real output of the
// project's test command. Recognised formats: pytest ("FAILED path::name" / "ERROR path::name" in the short
// summary), node:test / TAP ("not ok N - name"), Jest/Vitest ("✕ name" / "× name" / "FAIL path"). When no
// individual test can be recognised, the whole command is treated as one test.

export interface TestRun {
  ran: boolean;
  exitCode: number | null;
  output: string;
}

export const WHOLE_COMMAND = '(the test command)';

/** IDs of failing tests in one run's output. */
export function failingTests(run: TestRun): string[] {
  const out = new Set<string>();
  for (const raw of run.output.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd(); // strip colours
    let m: RegExpExecArray | null;
    if ((m = /^(?:FAILED|ERROR) (\S+::\S+)/.exec(line))) out.add(m[1]!);
    else if ((m = /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(line))) out.add(m[1]!.trim());
    else if ((m = /^\s*(?:✕|×) (.+?)(?: \(\d+(?:\.\d+)? ?m?s\))?$/.exec(line))) out.add(m[1]!.trim());
    else if ((m = /^FAIL (\S+\.(?:[jt]sx?|mjs|cjs))\b/.exec(line))) out.add(m[1]!);
  }
  if (out.size === 0 && run.ran && run.exitCode !== 0) out.add(WHOLE_COMMAND);
  return [...out].sort();
}

export interface RegressionResult {
  /** Tests that passed in the baseline and fail now. */
  regressed: string[];
  /** Tests that were already failing before the change (not caused by it). */
  stillFailing: string[];
  /** Tests that failed before and pass now. */
  fixed: string[];
  /** False when the baseline could not be run, so "passed before" is unknown. */
  baselineKnown: boolean;
}

export function compareRuns(before: TestRun | undefined, after: TestRun): RegressionResult {
  const now = failingTests(after);
  if (!before || !before.ran) return { regressed: [], stillFailing: now, fixed: [], baselineKnown: false };
  const was = new Set(failingTests(before));
  // A whole-command failure before hides which tests passed; only a clean baseline proves "passed before".
  if (was.has(WHOLE_COMMAND)) return { regressed: [], stillFailing: now, fixed: [], baselineKnown: false };
  const nowSet = new Set(now);
  return {
    regressed: now.filter((t) => !was.has(t)),
    stillFailing: now.filter((t) => was.has(t)),
    fixed: [...was].filter((t) => !nowSet.has(t)).sort(),
    baselineKnown: true,
  };
}

/** The part of the output worth showing the model for one fix: the failure sections, bounded. */
export function failureExcerpt(output: string, max = 6000): string {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((l) => /^=+ (FAILURES|ERRORS) =+$/.test(l) || /^\s*not ok \d+/.test(l) || /●|✕|×/.test(l));
  const text = (start >= 0 ? lines.slice(start) : lines).join('\n');
  return text.length <= max ? text : `${text.slice(0, max / 2)}\n...\n${text.slice(-max / 2)}`;
}
