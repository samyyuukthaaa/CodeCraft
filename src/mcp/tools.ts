// Editor tool handlers. Pure with respect to VS Code. propose_write never writes by itself: it hands
// the proposal to the WriteGate, which needs a stored per-hunk decision before anything changes.
import { z } from 'zod';
import { redact } from '../util/redact';
import { ReadFs, WriteGate } from './gate';
import { isDenied, normalizeRelPath } from './paths';
import { Edit, applyEdits, matchEol, pageOf } from './text';
import { listRelated, searchSymbols } from '../index/query';
import type { RepoIndex } from '../index/types';

export interface TestResult {
  ran: boolean;
  exitCode?: number;
  output: string;
  message?: string;
}

/** Runs the project's test command in the workspace after explicit user confirmation. */
export interface TestRunner {
  run(): Promise<TestResult>;
}

export type PlanAction = 'edit' | 'create' | 'context';

export interface PlanFile {
  path: string;
  action: PlanAction;
  why: string;
}

export interface Plan {
  summary: string;
  files: PlanFile[];
}

/**
 * The agent's current plan for this run. When a PlanStore is supplied, proposals are refused until a plan
 * exists, and only files the plan lists as "edit" or "create" may be proposed. Reset at the start of a run.
 */
export const MAX_REJECTED_IN_A_ROW = 2;
/** After this many failed run_tests in one run, no more proposals: the agent must stop and report. */
export const MAX_FAILED_TEST_RUNS = 2;

export class PlanStore {
  private plan: Plan | undefined;
  private rejectedInARow = 0;
  private failedTestRuns = 0;
  reset(): void {
    this.plan = undefined;
    this.rejectedInARow = 0;
    this.failedTestRuns = 0;
  }
  /** Records a run_tests result. Observed live: a lite model looped through 15 fix cycles on one failing test. */
  noteTests(passed: boolean): void {
    if (!passed) this.failedTestRuns++;
  }
  /** Observed live: after the user rejected a change, an agent re-proposed it for 25 rounds. */
  noteOutcome(status: string): void {
    this.rejectedInARow = status === 'rejected' ? this.rejectedInARow + 1 : status === 'applied' || status === 'partially_applied' ? 0 : this.rejectedInARow;
  }
  /** An error once the user has rejected MAX_REJECTED_IN_A_ROW whole proposals in a row in this run. */
  rejectionStop(): string | undefined {
    if (this.failedTestRuns >= MAX_FAILED_TEST_RUNS) {
      return `the tests failed ${this.failedTestRuns} times in this run; do not propose more changes. Stop and reply with which tests fail, the error, and what you tried.`;
    }
    return this.rejectedInARow >= MAX_REJECTED_IN_A_ROW
      ? `the user rejected your last ${this.rejectedInARow} proposals; do not propose again. Stop and reply with a short summary of what you proposed and why.`
      : undefined;
  }
  get(): Plan | undefined {
    return this.plan;
  }
  set(p: Plan): void {
    this.plan = p;
  }
  /** An error message when `paths` may not be proposed, or undefined when they may. */
  check(paths: string[]): string | undefined {
    const stop = this.rejectionStop();
    if (stop) return stop;
    if (!this.plan) return 'call submit_plan first: list the files you chose (edit, create or context) and why, before proposing changes';
    const allowed = new Set(this.plan.files.filter((f) => f.action !== 'context').map((f) => f.path));
    const missing = paths.filter((p) => !allowed.has(p));
    return missing.length ? `not in your plan as edit/create: ${missing.join(', ')}; call submit_plan again including them` : undefined;
  }
}

export interface ToolDeps {
  fs: ReadFs;
  gate: WriteGate;
  tests: TestRunner;
  /** Plan-before-propose enforcement (extension and scenarios); omitted in low-level tests. */
  plan?: PlanStore;
  onPlan?: (plan: Plan) => void;
  onActivity?: (line: string) => void;
  /** Repository index (incrementally rebuilt on each call). Optional so the editor tools work without it. */
  index?: { get(): Promise<RepoIndex> };
  /** Called with every path the agent actually reads via read_file. */
  onRead?: (path: string) => void;
}

export const MAX_READ_CHARS = 200_000;
const MAX_LIST = 500;
const MAX_MATCHES = 100;

export interface ToolOutput {
  text: string;
  isError: boolean;
}

const ok = (value: unknown): ToolOutput => ({ text: JSON.stringify(value), isError: false });
const err = (message: string): ToolOutput => ({ text: JSON.stringify({ error: message }), isError: true });

export const schemas = {
  read_file: {
    path: z.string().min(1).max(400).describe('Workspace-relative file path'),
    startLine: z.number().int().min(1).optional().describe('First line to return (1-based). Large files are returned in pages; use nextStartLine from the previous page.'),
    endLine: z.number().int().min(1).optional().describe('Last line to return (inclusive)'),
  },
  list_files: { prefix: z.string().max(400).optional().describe('Optional directory prefix filter') },
  search_text: {
    query: z.string().min(1).max(200).describe('Plain text to search for (case-insensitive)'),
    prefix: z.string().max(400).optional(),
  },
  propose_write: {
    path: z.string().min(1).max(400).describe('Workspace-relative file path'),
    newContent: z.string().describe('The complete new file content (line endings are matched to the existing file)'),
    reason: z.string().min(1).max(500).describe('Why this change is needed'),
  },
  propose_changes: {
    plan: z.string().min(1).max(4000).describe('Short numbered plan: which files change and why, in the order of the groups'),
    groups: z
      .array(
        z.object({
          intent: z.string().min(1).max(80).describe('What this group does, e.g. "rename", "update callers", "fix tests", "add test", "docs"'),
          files: z
            .array(
              z.object({
                path: z.string().min(1).max(400).describe('Workspace-relative file path'),
                newContent: z.string().optional().describe('The complete new file content. Use for new files or full rewrites.'),
                edits: z
                  .array(
                    z.object({
                      find: z.string().min(1).describe('Exact existing text to replace (must occur exactly once; include enough lines to be unique)'),
                      replace: z.string().describe('Replacement text'),
                    }),
                  )
                  .max(50)
                  .optional()
                  .describe('Targeted edits to an existing file, applied in order. Prefer this for large files. Give either edits or newContent.'),
              }),
            )
            .min(1)
            .max(20),
        }),
      )
      .min(1)
      .max(10),
  },
  submit_plan: {
    summary: z.string().min(1).max(1000).describe('One or two sentences: what you will change and how'),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(400).describe('Workspace-relative file path'),
          action: z.enum(['edit', 'create', 'context']).describe('edit = existing file you will change, create = new file, context = read only'),
          why: z.string().min(3).max(300).describe('Why this file is needed'),
        }),
      )
      .min(1)
      .max(20),
  },
  run_tests: {},
  search_symbols: {
    query: z.string().min(1).max(200).describe("Symbol name or prefix; Class.method narrows to methods of a class"),
    kind: z.enum(["class", "function", "method"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  list_related: { path: z.string().min(1).max(400).describe("Workspace-relative file path") },
} as const;

export function createHandlers(deps: ToolDeps) {
  const note = (s: string): void => deps.onActivity?.(redact(s));

  return {
    async read_file(a: { path: string; startLine?: number; endLine?: number }): Promise<ToolOutput> {
      let p: string;
      try {
        p = normalizeRelPath(a.path);
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid path');
      }
      const content = await deps.fs.read(p);
      if (content === undefined) return err('file not found');
      if (content.length > MAX_READ_CHARS) return err('file is too large to read (limit 200000 characters)');
      deps.gate.recordRead(p, content);
      deps.onRead?.(p);
      const page = pageOf(content, a.startLine ?? 1, a.endLine);
      note(`read_file ${p} lines ${page.startLine}-${page.endLine} of ${page.totalLines}`);
      return ok({ path: p, ...page });
    },

    async list_files(a: { prefix?: string }): Promise<ToolOutput> {
      let prefix = '';
      if (a.prefix) {
        try {
          prefix = normalizeRelPath(a.prefix);
        } catch (e) {
          return err(e instanceof Error ? e.message : 'invalid prefix');
        }
      }
      const all = (await deps.fs.list()).filter((f) => !isDenied(f) && (!prefix || f === prefix || f.startsWith(`${prefix}/`)));
      note(`list_files ${prefix || '.'} (${all.length})`);
      return ok({ files: all.slice(0, MAX_LIST), truncated: all.length > MAX_LIST });
    },

    async search_text(a: { query: string; prefix?: string }): Promise<ToolOutput> {
      const files = JSON.parse((await this.list_files({ prefix: a.prefix })).text) as { files?: string[] };
      const needle = a.query.toLowerCase();
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const f of files.files ?? []) {
        if (matches.length >= MAX_MATCHES) break;
        const content = await deps.fs.read(f);
        if (content === undefined || content.length > MAX_READ_CHARS || content.includes('\0')) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
          const line = lines[i] as string;
          if (line.toLowerCase().includes(needle)) matches.push({ path: f, line: i + 1, text: redact(line.slice(0, 200)) });
        }
      }
      note(`search_text "${a.query}" (${matches.length} match(es))`);
      return ok({ matches, truncated: matches.length >= MAX_MATCHES });
    },

    async propose_write(a: { path: string; newContent: string; reason: string }): Promise<ToolOutput> {
      if (deps.plan) {
        let p = a.path;
        try {
          p = normalizeRelPath(a.path);
        } catch {
          /* the gate reports path errors */
        }
        const planError = deps.plan.check([p]);
        if (planError) return err(planError);
      }
      note(`propose_write ${a.path}`);
      let current: string | undefined;
      try {
        current = await deps.fs.read(normalizeRelPath(a.path));
      } catch {
        current = undefined; // the gate reports the path error
      }
      const r = await deps.gate.propose(a.path, matchEol(current, a.newContent), a.reason);
      note(`propose_write ${a.path} -> ${r.status}`);
      deps.plan?.noteOutcome(r.status);
      // Honest wording: a proposal is not a write. Only "applied"/"partially_applied" mean the file changed.
      return r.status === 'refused' ? err(r.message) : ok(r);
    },

    async search_symbols(a: { query: string; kind?: 'class' | 'function' | 'method'; limit?: number }): Promise<ToolOutput> {
      if (!deps.index) return err('the repository index is not available');
      const hits = searchSymbols(await deps.index.get(), a.query, { kind: a.kind, limit: a.limit ?? 30 });
      note(`search_symbols "${a.query}" (${hits.length})`);
      return ok({ symbols: hits });
    },

    async list_related(a: { path: string }): Promise<ToolOutput> {
      if (!deps.index) return err('the repository index is not available');
      let p: string;
      try {
        p = normalizeRelPath(a.path);
      } catch (e) {
        return err(e instanceof Error ? e.message : 'invalid path');
      }
      const rel = listRelated(await deps.index.get(), p);
      if (!rel) return err('file is not in the index');
      note(`list_related ${p}`);
      return ok(rel);
    },

    async propose_changes(a: { plan: string; groups: Array<{ intent: string; files: Array<{ path: string; newContent?: string; edits?: Edit[] }> }> }): Promise<ToolOutput> {
      if (deps.plan) {
        const paths: string[] = [];
        for (const g of a.groups) {
          for (const f of g.files) {
            try {
              paths.push(normalizeRelPath(f.path));
            } catch {
              paths.push(f.path); // reported below with the real path error
            }
          }
        }
        const planError = deps.plan.check(paths);
        if (planError) return err(planError);
      }
      const summary = a.groups.map((g) => `${g.intent} (${g.files.map((f) => f.path).join(', ')})`).join('; ');
      note(`propose_changes ${summary}`);
      // Resolve edits / line endings into full new contents; the gate still decides everything.
      const groups: Array<{ intent: string; files: Array<{ path: string; newContent: string }> }> = [];
      for (const g of a.groups) {
        const files: Array<{ path: string; newContent: string }> = [];
        for (const f of g.files) {
          if ((f.newContent === undefined) === (f.edits === undefined)) return err(`${f.path}: give either newContent or edits`);
          let current: string | undefined;
          try {
            current = await deps.fs.read(normalizeRelPath(f.path));
          } catch (e) {
            return err(`${f.path}: ${e instanceof Error ? e.message : 'invalid path'}`);
          }
          if (f.edits) {
            if (current === undefined) return err(`${f.path}: file does not exist; use newContent to create it`);
            const r = applyEdits(current, f.edits);
            if (!r.ok) return err(`${f.path}: ${r.error}`);
            files.push({ path: f.path, newContent: r.text });
          } else {
            files.push({ path: f.path, newContent: matchEol(current, f.newContent as string) });
          }
        }
        groups.push({ intent: g.intent, files });
      }
      const r = await deps.gate.proposeSet(a.plan, groups);
      note(`propose_changes -> ${r.status}: ${r.message}`);
      deps.plan?.noteOutcome(r.status);
      // Honest wording: a proposal is not a write. Only "applied"/"partially_applied" mean files changed.
      return r.status === 'refused' ? err(r.message) : ok(r);
    },

    async submit_plan(a: { summary: string; files: Array<{ path: string; action: PlanAction; why: string }> }): Promise<ToolOutput> {
      const files: PlanFile[] = [];
      for (const f of a.files) {
        let p: string;
        try {
          p = normalizeRelPath(f.path);
        } catch (e) {
          return err(`${f.path}: ${e instanceof Error ? e.message : 'invalid path'}`);
        }
        const exists = (await deps.fs.read(p)) !== undefined;
        if (f.action === 'create' && exists) return err(`${p} already exists; use action "edit"`);
        if (f.action !== 'create' && !exists) return err(`${p} does not exist; use action "create" for new files`);
        files.push({ path: p, action: f.action, why: redact(f.why) });
      }
      const plan: Plan = { summary: redact(a.summary), files };
      deps.plan?.set(plan);
      deps.onPlan?.(plan);
      note(`submit_plan ${files.map((f) => `${f.action}:${f.path}`).join(', ')}`);
      return ok({ accepted: true, files: files.map((f) => `${f.action} ${f.path}`) });
    },

    async run_tests(): Promise<ToolOutput> {
      note('run_tests requested');
      const r = await deps.tests.run();
      if (!r.ran) return err(r.message ?? 'tests were not run');
      deps.plan?.noteTests(r.exitCode === 0);
      return ok({ exitCode: r.exitCode, passed: r.exitCode === 0, output: redact(r.output) });
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;
