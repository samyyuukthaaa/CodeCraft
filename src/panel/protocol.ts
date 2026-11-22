// Messages between the webview (untrusted) and the extension host. The host validates every
// incoming message; the webview only ever receives sanitized DisplayEvent records.
import type { ContextReport } from '../index/context';
import type { BudgetView } from '../mcp/budget';
import type { Plan } from '../mcp/tools';
import type { DisplayEvent } from '../trueforge/events';
import type { HealthRow } from '../trueforge/health';

export const MAX_PROMPT_CHARS = 8000;
export const MAX_ANSWER_CHARS = 2000;

export type WebviewToHost =
  | { type: 'prompt'; text: string }
  | { type: 'testProviders' }
  | { type: 'injectFault' }
  /** The user's answer to the agent's question (accepted while a run is in progress). */
  | { type: 'answer'; text: string }
  /** Opens the checkpoint picker (host side). */
  | { type: 'rollback' }
  /** Exports the last run's report (host side). */
  | { type: 'exportReport' };

/** A change group as shown in the panel (P5). */
export interface GroupView {
  intent: string;
  files: string[];
  reason: string;
  plain: string;
  confidence: string;
  why: string[];
  tests: string;
  status: 'proposed' | 'applied' | 'not applied' | 'rolled back';
}

export interface MetricsView {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  read: number;
  total: number;
  /** Epoch ms when the run started (the webview ticks the elapsed time while running). */
  startedAt: number;
  /** Final elapsed time, once the run ended. */
  elapsedMs?: number;
}

export type HostToWebview =
  | { type: 'event'; event: DisplayEvent }
  | { type: 'status'; state: 'idle' | 'running'; note?: string }
  | { type: 'context'; report: ContextReport }
  | { type: 'reads'; read: number; total: number; paths: string[] }
  /** The per-run read budget of the editor tools (calls used of the limit, identical repeats answered from cache). */
  | { type: 'budget'; budget: BudgetView }
  | { type: 'plan'; plan: Plan }
  | { type: 'health'; rows: HealthRow[]; note?: string }
  | { type: 'warn'; files: string[]; tests: string[] }
  | { type: 'groups'; groups: GroupView[] }
  | { type: 'question'; question: string; options: string[] }
  | { type: 'questionDone' }
  | { type: 'metrics'; metrics: MetricsView };

/** Validates untrusted input from the webview. Returns undefined for anything unexpected. */
export function parseWebviewMessage(raw: unknown): WebviewToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as { type?: unknown; text?: unknown };
  const keys = Object.keys(m).length;
  if (m.type === 'prompt' && typeof m.text === 'string') {
    const text = m.text.trim();
    if (text.length > 0 && text.length <= MAX_PROMPT_CHARS) return { type: 'prompt', text };
  }
  if (m.type === 'answer' && typeof m.text === 'string' && keys === 2) {
    const text = m.text.trim();
    if (text.length > 0 && text.length <= MAX_ANSWER_CHARS) return { type: 'answer', text };
  }
  // No parameters: the host decides which agents to probe.
  if (m.type === 'testProviders' && keys === 1) return { type: 'testProviders' };
  // No parameters: the fault is chosen in a host-side quick pick, never taken from the webview.
  if (m.type === 'injectFault' && keys === 1) return { type: 'injectFault' };
  // No parameters: the checkpoint is chosen in a host-side quick pick from the journal.
  if (m.type === 'rollback' && keys === 1) return { type: 'rollback' };
  if (m.type === 'exportReport' && keys === 1) return { type: 'exportReport' };
  return undefined;
}
