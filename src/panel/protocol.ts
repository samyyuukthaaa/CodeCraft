// Messages between the webview (untrusted) and the extension host. The host validates every
// incoming message; the webview only ever receives sanitized DisplayEvent records.
import type { ContextReport } from '../index/context';
import type { Plan } from '../mcp/tools';
import type { DisplayEvent } from '../trueforge/events';
import type { HealthRow } from '../trueforge/health';

export const MAX_PROMPT_CHARS = 8000;

export type WebviewToHost = { type: 'prompt'; text: string } | { type: 'testProviders' } | { type: 'injectFault' };

export type HostToWebview =
  | { type: 'event'; event: DisplayEvent }
  | { type: 'status'; state: 'idle' | 'running'; note?: string }
  | { type: 'context'; report: ContextReport }
  | { type: 'reads'; read: number; total: number; paths: string[] }
  | { type: 'plan'; plan: Plan }
  | { type: 'health'; rows: HealthRow[]; note?: string };

/** Validates untrusted input from the webview. Returns undefined for anything unexpected. */
export function parseWebviewMessage(raw: unknown): WebviewToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as { type?: unknown; text?: unknown };
  if (m.type === 'prompt' && typeof m.text === 'string') {
    const text = m.text.trim();
    if (text.length > 0 && text.length <= MAX_PROMPT_CHARS) return { type: 'prompt', text };
  }
  // No parameters: the host decides which agents to probe.
  if (m.type === 'testProviders' && Object.keys(m).length === 1) return { type: 'testProviders' };
  // No parameters: the fault is chosen in a host-side quick pick, never taken from the webview.
  if (m.type === 'injectFault' && Object.keys(m).length === 1) return { type: 'injectFault' };
  return undefined;
}
