// Per-run read budget for the editor tools. Observed live (task2 on d3e2cf3, gemini-3-1-flash-lite): 104 read_file,
// 10 list_files and 44 malformed calls in one run, without ever submitting a plan, until the free-tier quota stopped
// it. The budget caps reading per run; an identical repeated call (same tool, same arguments) gets a short cached
// answer instead of a re-read (and does not count); past a cap the tool tells the agent plainly to stop reading and
// submit its plan and edits. Pure: no VS Code, no I/O.

export const READ_LIMITS = { read_file: 25, list_files: 6, search_text: 10 } as const;
export type BudgetedTool = keyof typeof READ_LIMITS;
export const isBudgeted = (tool: string): tool is BudgetedTool => tool in READ_LIMITS;

export interface BudgetView {
  used: Record<BudgetedTool, number>;
  limits: Record<BudgetedTool, number>;
  /** Identical repeats answered from the cache. */
  cached: number;
}

export type BudgetDecision = { kind: 'run' } | { kind: 'cached'; text: string } | { kind: 'capped'; text: string };

/** Stable key for "the same arguments" (key order does not matter; empty/undefined values are dropped). */
export function callKey(tool: string, args: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined && x !== '') o[k] = norm(x);
      }
      return o;
    }
    return v;
  };
  return `${tool} ${JSON.stringify(norm(args ?? {}))}`;
}

export const cappedMessage = (tool: BudgetedTool, used: number): string =>
  `Read budget reached: ${tool} ${used} of ${READ_LIMITS[tool]} calls in this run. Stop reading now. ` +
  'Call submit_plan with every file you will change, then propose_changes with your edits, using what you have already read.';

export const cachedMessage = (tool: BudgetedTool, summary: string): string =>
  `You already called ${tool} with exactly these arguments in this run (${summary}). It was not repeated. ` +
  'Use what you already have; if you know which files to change, call submit_plan and then propose_changes now.';

export class ReadBudget {
  private used: Record<BudgetedTool, number> = { read_file: 0, list_files: 0, search_text: 0 };
  private readonly seen = new Map<string, string>();
  private cachedCount = 0;

  constructor(private readonly onChange?: (v: BudgetView) => void) {}

  /** A new run: every count and the cache start again. */
  reset(): void {
    this.used = { read_file: 0, list_files: 0, search_text: 0 };
    this.seen.clear();
    this.cachedCount = 0;
    this.onChange?.(this.view());
  }

  view(): BudgetView {
    return { used: { ...this.used }, limits: { ...READ_LIMITS }, cached: this.cachedCount };
  }

  /** Before a call: run it, answer from the cache (identical repeat), or refuse (cap reached). */
  check(tool: BudgetedTool, args: unknown): BudgetDecision {
    const summary = this.seen.get(callKey(tool, args));
    if (summary !== undefined) {
      this.cachedCount++;
      this.onChange?.(this.view());
      return { kind: 'cached', text: JSON.stringify({ cached: true, note: cachedMessage(tool, summary) }) };
    }
    if (this.used[tool] >= READ_LIMITS[tool]) return { kind: 'capped', text: JSON.stringify({ error: cappedMessage(tool, this.used[tool]) }) };
    return { kind: 'run' };
  }

  /** After a successful call: counts it and remembers a short summary for identical repeats. */
  record(tool: BudgetedTool, args: unknown, summary: string): void {
    this.used[tool]++;
    this.seen.set(callKey(tool, args), summary);
    this.onChange?.(this.view());
  }
}

/** Short summary of a tool result for the cache (never file content). */
export function resultSummary(tool: BudgetedTool, text: string): string {
  try {
    const r = JSON.parse(text) as { path?: string; startLine?: number; endLine?: number; totalLines?: number; files?: unknown[]; matches?: unknown[] };
    if (tool === 'read_file') return `${r.path ?? 'file'} lines ${r.startLine ?? '?'}-${r.endLine ?? '?'} of ${r.totalLines ?? '?'}`;
    if (tool === 'list_files') return `${r.files?.length ?? 0} files listed`;
    return `${r.matches?.length ?? 0} match(es)`;
  } catch {
    return 'done';
  }
}
