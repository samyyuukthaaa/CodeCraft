// Pure: what the user sees about each change group (P5) and the warn-before-edit list. Facts come from the
// proposal itself (hunks), the submitted plan and the repository index (importers and related tests).
import type { GroupNote, GroupProposal } from '../mcp/gate';
import type { Plan } from '../mcp/tools';
import { listRelated } from '../index/query';
import type { RepoIndex } from '../index/types';
import { FileFacts, TestStatus, confidenceFor, defaultPlainSentence } from './confidence';

export const TEST_STATUS_TEXT: Record<TestStatus, string> = {
  'not run yet': 'not run yet',
  passed: 'passed (real run)',
  failed: 'failed (real run)',
  regressed: 'a test that passed before now fails (real run)',
  'could not run': 'could not be run',
};

export function factsFor(group: GroupProposal, plan: Plan | undefined, index: RepoIndex | undefined): FileFacts[] {
  const planned = new Set((plan?.files ?? []).filter((f) => f.action !== 'context').map((f) => f.path));
  return group.files.map((f) => {
    const rel = index ? listRelated(index, f.path) : undefined;
    return {
      path: f.path,
      linesChanged: f.hunks.reduce((n, h) => n + h.oldLines.length + h.newLines.length, 0),
      created: f.isNew,
      deleted: false, // the write gate never deletes a file in a proposal
      inPlan: plan ? planned.has(f.path) : true, // without plan enforcement nothing is "outside the plan"
      isTest: index?.files[f.path]?.isTest ?? /(^|\/)(tests?\/|test_)|[._](test|spec)\./.test(f.path),
      dependents: rel?.importedBy.length ?? 0,
      relatedTests: rel?.tests.length ?? 0,
    };
  });
}

export function noteFor(group: GroupProposal, plan: Plan | undefined, index: RepoIndex | undefined, tests: TestStatus, planSummary = ''): GroupNote {
  const facts = factsFor(group, plan, index);
  const c = confidenceFor(facts, tests);
  return {
    reason: group.reason || planSummary || group.intent,
    plain: group.plain || defaultPlainSentence(group.intent, facts),
    confidence: c.tag,
    why: c.reasons,
    tests: TEST_STATUS_TEXT[tests],
  };
}

/** Files the plan will change, and the tests that might break (related tests of those files). */
export function warnList(plan: Plan, index: RepoIndex | undefined): { files: string[]; tests: string[] } {
  const files = plan.files.filter((f) => f.action !== 'context').map((f) => f.path);
  const tests = new Set<string>();
  for (const p of files) {
    if (index?.files[p]?.isTest) tests.add(p);
    for (const t of (index ? listRelated(index, p)?.tests : undefined) ?? []) tests.add(t);
  }
  return { files, tests: [...tests].sort() };
}

export function warningText(w: { files: string[]; tests: string[] }): string {
  return `Before any edit: this run plans to change ${w.files.join(', ') || 'no files'}. Tests that might break: ${w.tests.join(', ') || 'none found by the index'}.`;
}
