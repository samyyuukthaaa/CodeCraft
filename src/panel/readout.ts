// Context readout for the agent panel, computed only from data the panel already receives (the context report, the
// agent's plan and the files it read). Pure: no DOM, no VS Code. Context selection itself is unchanged.
import type { ContextReport } from '../index/context';
import type { Plan } from '../mcp/tools';

export interface BudgetMeter {
  used: number;
  limit: number;
  /** 0..100 (capped; `over` says if the estimate went past the limit). */
  percent: number;
  over: boolean;
  text: string;
}

/** Context budget: tokens used of the limit (estimated), as a meter with plain text. */
export function budgetMeter(r: Pick<ContextReport, 'usedTokens' | 'budgetTokens' | 'items'>): BudgetMeter {
  const limit = Math.max(0, r.budgetTokens);
  const used = Math.max(0, r.usedTokens);
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const left = r.items.filter((i) => !i.included).length;
  return {
    used,
    limit,
    percent,
    over: used > limit,
    text: `Context budget: about ${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} tokens (${percent}%)` + (left ? `; ${left} file(s) left out to stay within it` : ''),
  };
}

export interface ChosenFile {
  path: string;
  /** edit / create / context come from the agent's plan; "read" = read by the agent but not in its plan. */
  how: 'edit' | 'create' | 'context' | 'read';
  why: string;
  read: boolean;
}

/** The files the agent chose and why: its plan first (in plan order), then other files it read. */
export function chosenFiles(plan: Pick<Plan, 'files'> | undefined, readPaths: readonly string[]): ChosenFile[] {
  const read = new Set(readPaths);
  const out: ChosenFile[] = (plan?.files ?? []).map((f) => ({ path: f.path, how: f.action, why: f.why, read: read.has(f.path) }));
  const inPlan = new Set(out.map((f) => f.path));
  for (const p of readPaths) if (!inPlan.has(p)) out.push({ path: p, how: 'read', why: 'read by the agent (not in its plan)', read: true });
  return out;
}
