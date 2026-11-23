// Per-run trust features (P5), independent of VS Code: change-group notes with confidence and real test status,
// the warn-before-edit list, a test baseline before the first write, tests after the changes, exactly one
// automatic fix when a test that passed before now fails, the agent's question, and cost/speed metrics.
// Everything is written to the journal; the panel gets plain view records.
import type { Journal } from '../journal/journal';
import type { GroupNote, GroupProposal } from '../mcp/gate';
import type { Plan, TestResult } from '../mcp/tools';
import type { RepoIndex } from '../index/types';
import type { GroupView, HostToWebview, MetricsView } from '../panel/protocol';
import type { TurnEvent } from '../trueforge/client';
import type { ClientToolCall } from '../trueforge/run';
import { redact } from '../util/redact';
import { noteFor, warnList, warningText } from './annotate';
import type { TestStatus } from './confidence';
import { TestRun, compareRuns, failingTests, failureExcerpt } from './regression';

export interface TrustDeps {
  journal: Journal;
  post: (m: HostToWebview) => void;
  /** Runs the project's test command (asks the user as usual). `why` explains who asks. */
  runTests: (why: string) => Promise<TestResult>;
  index: () => Promise<RepoIndex | undefined>;
  plan: () => Plan | undefined;
  log?: (line: string) => void;
  now?: () => number;
}

/** What the fix run reported back: whether it applied any change. */
export interface FixRun {
  applied: boolean;
}

export const NO_ANSWER = '(no answer: the user stopped the run)';

const toRun = (r: TestResult): TestRun => ({ ran: r.ran, exitCode: r.ran ? (r.exitCode ?? null) : null, output: r.output });

export function fixPrompt(regressed: string[], output: string): string {
  return [
    `Your changes made tests fail that passed before: ${regressed.join(', ')}.`,
    'Here is the real test output:',
    '```',
    failureExcerpt(redact(output)),
    '```',
    'Read the error, then make exactly ONE minimal fix with propose_changes (call submit_plan first only if the file is not in your plan as edit or create).',
    'Fix the code you changed; do not weaken or delete the tests unless the test itself is wrong, and say so if it is.',
    'Do not run the tests yourself: CodeCraft runs them after your fix and shows the result. Then reply with one sentence on what you changed.',
  ].join('\n');
}

export class TrustSession {
  readonly startedAt: number;
  model: string;
  private readonly now: () => number;
  private readonly groups: Array<{ view: GroupView; group: GroupProposal; planSummary: string }> = [];
  private warn: { files: string[]; tests: string[] } | undefined;
  private wroteAny = false;
  private baseline: Promise<TestRun | undefined> | undefined;
  private testStatus: TestStatus = 'not run yet';
  private readonly tokens = new Map<string, { input?: number; output?: number; cost?: number }>();
  private turnId = '';
  private reads = 0;
  private total = 0;
  private pendingAnswer: ((text: string) => void) | undefined;
  fixAttempted = false;
  private changesAppliedAfterLastTestRun = false;

  constructor(
    private readonly deps: TrustDeps,
    model: string,
  ) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.model = model;
  }

  // ---------- plan and warn-before-edit ----------
  async onPlan(plan: Plan): Promise<void> {
    const w = warnList(plan, await this.deps.index());
    this.warn = w;
    if (!this.wroteAny) {
      this.deps.post({ type: 'warn', files: w.files, tests: w.tests });
      await this.deps.journal.append({ t: 'warn_list', files: w.files, tests: w.tests });
    }
    // Baseline on the unchanged files, so "a test that passed before" is known. Writes wait for it.
    this.baseline ??= this.testRun('baseline', 'CodeCraft runs the tests once BEFORE any change, to know which tests already pass.');
  }

  warning(): string | undefined {
    return this.warn && !this.wroteAny ? warningText(this.warn) : undefined;
  }

  async beforeApply(): Promise<void> {
    await this.baseline;
  }

  // ---------- change groups ----------
  async annotate(groups: GroupProposal[]): Promise<GroupNote[]> {
    const index = await this.deps.index();
    const plan = this.deps.plan();
    const notes = groups.map((g) => noteFor(g, plan, index, this.testStatus, plan?.summary ?? ''));
    groups.forEach((g, i) => {
      const n = notes[i]!;
      this.groups.push({ group: g, planSummary: plan?.summary ?? '', view: { intent: g.intent, files: g.files.map((f) => f.path), reason: n.reason, plain: n.plain, confidence: n.confidence, why: n.why, tests: n.tests, status: 'proposed' } });
    });
    this.postGroups();
    return notes;
  }

  async onApplied(info: { opId: string; groups: Array<{ intent: string; files: string[]; note?: GroupNote }> }): Promise<void> {
    this.wroteAny = true;
    this.changesAppliedAfterLastTestRun = true;
    for (const g of info.groups) {
      const v = [...this.groups].reverse().find((x) => x.view.status === 'proposed' && x.view.intent === g.intent && g.files.every((p) => x.view.files.includes(p)));
      if (v) v.view.status = 'applied';
    }
    this.postGroups();
    for (const g of info.groups) {
      const n = g.note;
      await this.deps.journal.append({ t: 'change_group', opId: info.opId, intent: g.intent, files: g.files, reason: n?.reason ?? g.intent, plain: n?.plain ?? '', confidence: n?.confidence ?? 'not rated', why: n?.why ?? [], tests: n?.tests ?? 'not run yet' });
    }
  }

  /** The outcome of a proposal (applied groups were already marked by onApplied). */
  onProposalOutcome(status: string): void {
    if (status === 'applied' || status === 'partially_applied') return;
    for (const g of this.groups) if (g.view.status === 'proposed') g.view.status = 'not applied';
    this.postGroups();
  }

  markRolledBack(files: string[]): void {
    for (const g of this.groups) if (g.view.status === 'applied' && g.view.files.some((f) => files.includes(f))) g.view.status = 'rolled back';
    this.postGroups();
  }

  /** Records the real test status and re-rates the applied groups with it (the status can only lower a tag). */
  private async setTestStatus(s: TestStatus): Promise<void> {
    this.testStatus = s;
    const plan = this.deps.plan();
    const index = await this.deps.index();
    for (const g of this.groups) {
      if (g.view.status !== 'applied') continue;
      const n = noteFor(g.group, plan, index, s, g.planSummary);
      Object.assign(g.view, { confidence: n.confidence, why: n.why, tests: n.tests });
    }
    this.postGroups();
  }

  private postGroups(): void {
    this.deps.post({ type: 'groups', groups: this.groups.map((g) => ({ ...g.view })) });
  }

  // ---------- tests ----------
  private async testRun(phase: 'baseline' | 'after' | 'after_fix', why: string): Promise<TestRun | undefined> {
    const r = await this.deps.runTests(why);
    if (!r.ran) {
      this.deps.log?.(`[tests ${phase}] not run: ${r.message ?? ''}`);
      this.deps.post({ type: 'event', event: { type: 'tests.not_run', summary: `Tests (${phase.replace('_', ' ')}) were not run: ${redact(r.message ?? 'unknown reason')}`, failed: phase !== 'baseline' } });
      return undefined;
    }
    const run = toRun(r);
    const failing = failingTests(run);
    await this.deps.journal.append({ t: 'tests', phase, passed: run.exitCode === 0, exitCode: run.exitCode, failing });
    return run;
  }

  /** The agent's own run_tests result. */
  async onAgentTests(passed: boolean, exitCode: number | null, output = ''): Promise<void> {
    this.changesAppliedAfterLastTestRun = false;
    const run: TestRun = { ran: true, exitCode, output };
    await this.deps.journal.append({ t: 'tests', phase: 'agent', passed, exitCode, failing: failingTests(run) });
    const base = await this.baseline;
    const cmp = compareRuns(base, run);
    await this.setTestStatus(cmp.regressed.length ? 'regressed' : passed ? 'passed' : 'failed');
  }

  /**
   * After the agent finished: if anything was written in this run, run the tests; if a test that passed before
   * now fails, ask the agent for exactly ONE fix (through the same review gate), run the tests again and show
   * the outcome either way.
   */
  async afterRun(runFix: (prompt: string) => Promise<FixRun>): Promise<void> {
    if (!this.wroteAny) return;
    const base = await this.baseline;
    const after = await this.testRun('after', 'CodeCraft runs the tests AFTER the changes were applied.');
    if (!after) {
      await this.setTestStatus('could not run');
      return;
    }
    const cmp = compareRuns(base, after);
    const allFailing = failingTests(after);
    // Check for failures in output even if exit code is 0 (broken test command)
    const hasFailuresInOutput = allFailing.length > 0;
    const summary = after.exitCode === 0 && !hasFailuresInOutput ? 'all tests pass' : `${allFailing.length} failing${cmp.stillFailing.length && cmp.baselineKnown ? ` (${cmp.stillFailing.length} already failed before the change)` : ''}`;
    this.deps.post({ type: 'event', event: { type: 'tests.after', summary: `Tests after the changes: ${summary}${cmp.baselineKnown ? '' : '; the run before the change is unknown, so no test counts as newly broken'}`, failed: after.exitCode !== 0 || hasFailuresInOutput } });

    // Detect new tests that fail (weren't in baseline, now fail)
    const baselineFailing = base && base.ran ? new Set(failingTests(base)) : new Set<string>();
    const newlyFailing = allFailing.filter(t => !baselineFailing.has(t));
    const anyNewFailures = cmp.baselineKnown && newlyFailing.length > 0;

    // Fix if regressions exist OR (new tests fail when baseline is known) OR (failures detected with broken test command)
    const isBrokenCommand = after.ran && after.exitCode === 0 && hasFailuresInOutput;
    if (!cmp.regressed.length && !anyNewFailures && !isBrokenCommand) {
      await this.setTestStatus(after.exitCode === 0 ? 'passed' : 'failed');
      return;
    }
    await this.setTestStatus('regressed');
    // Report all failures to agent for fixing: regressions take priority, then new failures, or failures from broken command
    const failingToReport = cmp.regressed.length > 0 ? cmp.regressed : (newlyFailing.length > 0 ? newlyFailing : (isBrokenCommand ? allFailing : []));
    await this.deps.journal.append({ t: 'regression', tests: failingToReport });
    const failureMsg = `Tests failed: ${failingToReport.join(', ')}. Trying ONE automatic fix.`;
    this.deps.post({ type: 'event', event: { type: 'tests.regressed', summary: failureMsg, failed: true } });
    if (this.fixAttempted) return; // exactly one automatic fix per run
    this.fixAttempted = true;
    await this.deps.journal.append({ t: 'autofix', status: 'started', detail: failingToReport.join(', ') });
    const fix = await runFix(fixPrompt(failingToReport, after.output));
    if (!fix.applied) {
      await this.deps.journal.append({ t: 'autofix', status: 'not_applied', detail: 'no fix was applied (rejected, refused or none proposed)' });
      this.deps.post({ type: 'event', event: { type: 'autofix', summary: `Automatic fix: no change was applied. Still failing: ${failingToReport.join(', ')}`, failed: true } });
      return;
    }
    const again = await this.testRun('after_fix', 'CodeCraft runs the tests again after the automatic fix.');
    if (!again) {
      await this.deps.journal.append({ t: 'autofix', status: 'still_failing', detail: 'the tests could not be run after the fix' });
      await this.setTestStatus('could not run');
      return;
    }
    const cmp2 = compareRuns(base, again);
    const allFailing2 = failingTests(again);
    // Check if the tests we asked the agent to fix are now passing
    const fixedTestsNowFailing = failingToReport.filter(t => allFailing2.includes(t));
    if (fixedTestsNowFailing.length) {
      await this.deps.journal.append({ t: 'autofix', status: 'still_failing', detail: fixedTestsNowFailing.join(', ') });
      this.deps.post({ type: 'event', event: { type: 'autofix', summary: `Automatic fix applied, but these still fail: ${fixedTestsNowFailing.join(', ')}. No further automatic fix.`, failed: true } });
      await this.setTestStatus('regressed');
    } else {
      await this.deps.journal.append({ t: 'autofix', status: 'fixed', detail: `${failingToReport.join(', ')} pass again` });
      this.deps.post({ type: 'event', event: { type: 'autofix', summary: `Automatic fix worked: ${failingToReport.join(', ')} pass again${again.exitCode === 0 ? '; all tests pass' : ''}.` } });
      await this.setTestStatus(again.exitCode === 0 ? 'passed' : 'failed');
    }
  }

  // ---------- the agent's question ----------
  async ask(q: ClientToolCall): Promise<string> {
    const question = q.question ?? '(no question text)';
    this.deps.post({ type: 'question', question, options: q.options ?? [] });
    const answer = await new Promise<string>((resolve) => {
      this.pendingAnswer = resolve;
    });
    this.pendingAnswer = undefined;
    this.deps.post({ type: 'questionDone' });
    await this.deps.journal.append({ t: 'question', question, answer });
    return answer;
  }

  answer(text: string): boolean {
    if (!this.pendingAnswer) return false;
    this.pendingAnswer(text);
    return true;
  }

  /** Stop Run while a question is open. */
  cancelQuestion(): void {
    this.pendingAnswer?.(NO_ANSWER);
  }

  /** Check if changes were applied but tests haven't been run yet. */
  needsTestValidation(): boolean {
    return this.wroteAny && this.changesAppliedAfterLastTestRun;
  }

  // ---------- cost and speed ----------
  setModel(m: string): void {
    this.model = m;
    this.postMetrics();
  }

  setReads(read: number, total: number): void {
    this.reads = read;
    this.total = total;
    this.postMetrics();
  }

  onEvent(ev: TurnEvent): void {
    if (ev.type === 'turn.created') this.turnId = ev.turnId;
    const state = (ev as { state?: { metrics?: { totalInputTokens?: number; totalOutputTokens?: number; totalCostInUsd?: number } } }).state;
    const m = state?.metrics;
    if ((ev.type === 'turn.done' || ev.type === 'turn.update') && m) {
      // TrueForge reports per-turn totals; keep the latest per turn and add the turns up.
      this.tokens.set(this.turnId || ev.id, { input: m.totalInputTokens, output: m.totalOutputTokens, cost: m.totalCostInUsd });
      this.postMetrics();
    }
  }

  metrics(final = false): MetricsView {
    const sum = (k: 'input' | 'output' | 'cost'): number | undefined => {
      const vals = [...this.tokens.values()].map((t) => t[k]).filter((v): v is number => typeof v === 'number');
      return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
    };
    const input = sum('input');
    const output = sum('output');
    const cost = sum('cost');
    return {
      model: this.model,
      ...(input !== undefined ? { inputTokens: input } : {}),
      ...(output !== undefined ? { outputTokens: output } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
      read: this.reads,
      total: this.total,
      startedAt: this.startedAt,
      ...(final ? { elapsedMs: this.now() - this.startedAt } : {}),
    };
  }

  postMetrics(final = false): void {
    this.deps.post({ type: 'metrics', metrics: this.metrics(final) });
  }

  async finish(): Promise<void> {
    const m = this.metrics(true);
    this.deps.post({ type: 'metrics', metrics: m });
    await this.deps.journal.append({ t: 'metrics', model: m.model, ...(m.inputTokens !== undefined ? { inputTokens: m.inputTokens } : {}), ...(m.outputTokens !== undefined ? { outputTokens: m.outputTokens } : {}), ...(m.costUsd !== undefined ? { costUsd: m.costUsd } : {}), elapsedMs: m.elapsedMs ?? 0, filesRead: m.read, filesTotal: m.total });
  }
}
