// Pure: the confidence tag shown for every change group (P5). Deterministic and documented: the same facts always
// give the same tag, and the tag lists the rule(s) that decided it. The rules (first matching level wins):
//
//  risky       - a test that passed before fails after this change (or the tests fail after it)
//              - it touches a file that is not in the submitted plan
//              - it deletes a file
//              - it changes more than RISKY_LINES lines, or more than RISKY_FILES files
//              - it changes a source file that RISKY_DEPENDENTS or more other files import
//  check this  - it changes more than CHECK_LINES lines
//              - it changes a source file that no test file is related to (nothing would catch a mistake)
//              - it changes a source file that other files import (CHECK_DEPENDENTS or more)
//              - the tests could not be run
//  sure        - none of the above: a small, planned change to files covered by tests
//
// Test status never makes a change "sure" on its own; it is shown next to the tag (not run yet / passed /
// failed / a test that passed before now fails) and can only lower the tag.

export type Confidence = 'sure' | 'check this' | 'risky';
export type TestStatus = 'not run yet' | 'passed' | 'failed' | 'regressed' | 'could not run';

export const RISKY_LINES = 150;
export const RISKY_FILES = 4;
export const RISKY_DEPENDENTS = 10;
export const CHECK_LINES = 40;
export const CHECK_DEPENDENTS = 3;

export interface FileFacts {
  path: string;
  /** Added plus removed lines in the accepted (or proposed) hunks. */
  linesChanged: number;
  created: boolean;
  deleted: boolean;
  inPlan: boolean;
  isTest: boolean;
  /** Files that import this file (from the repository index). */
  dependents: number;
  /** Test files related to this file (from the repository index). */
  relatedTests: number;
}

export interface ConfidenceResult {
  tag: Confidence;
  /** The deciding rules, in plain words. Empty reasons never happen: "sure" also says why. */
  reasons: string[];
}

export function confidenceFor(files: readonly FileFacts[], tests: TestStatus): ConfidenceResult {
  const risky: string[] = [];
  const check: string[] = [];
  const lines = files.reduce((n, f) => n + f.linesChanged, 0);
  const src = files.filter((f) => !f.isTest);

  if (tests === 'regressed') risky.push('a test that passed before now fails');
  else if (tests === 'failed') risky.push('the tests fail after this change');
  const unplanned = files.filter((f) => !f.inPlan).map((f) => f.path);
  if (unplanned.length) risky.push(`not in the plan: ${unplanned.join(', ')}`);
  const deleted = files.filter((f) => f.deleted).map((f) => f.path);
  if (deleted.length) risky.push(`deletes ${deleted.join(', ')}`);
  if (lines > RISKY_LINES) risky.push(`large change (${lines} lines; limit ${RISKY_LINES})`);
  if (files.length > RISKY_FILES) risky.push(`touches ${files.length} files (limit ${RISKY_FILES})`);
  const wide = src.filter((f) => f.dependents >= RISKY_DEPENDENTS);
  if (wide.length) risky.push(`widely used: ${wide.map((f) => `${f.path} (imported by ${f.dependents} files)`).join(', ')}`);
  if (risky.length) return { tag: 'risky', reasons: risky };

  if (lines > CHECK_LINES) check.push(`medium-sized change (${lines} lines)`);
  const untested = src.filter((f) => f.relatedTests === 0 && !f.created).map((f) => f.path);
  if (untested.length) check.push(`no related tests for ${untested.join(', ')}`);
  const used = src.filter((f) => f.dependents >= CHECK_DEPENDENTS);
  if (used.length) check.push(`used by other files: ${used.map((f) => `${f.path} (${f.dependents})`).join(', ')}`);
  if (tests === 'could not run') check.push('the tests could not be run');
  if (check.length) return { tag: 'check this', reasons: check };

  return { tag: 'sure', reasons: [`small planned change (${lines} line${lines === 1 ? '' : 's'})${src.length ? ' to files covered by tests' : ' to test files'}`] };
}

/** One plain-English sentence a beginner can follow, used when the agent did not give one. */
export function defaultPlainSentence(intent: string, files: readonly FileFacts[]): string {
  const names = files.map((f) => f.path.split('/').pop() ?? f.path);
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more file${names.length - 2 === 1 ? '' : 's'}`;
  const created = files.filter((f) => f.created).length;
  const verb = created === files.length ? 'creates' : 'changes';
  return `This ${verb} ${list} to ${intent.replace(/^(to )/i, '').replace(/\.$/, '')}.`;
}
