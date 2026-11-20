// Messages between the webview (untrusted) and the extension host. The host validates every
// incoming message; the webview only ever receives sanitized DisplayEvent records.
import type { DisplayEvent } from '../trueforge/events';

export const MAX_PROMPT_CHARS = 8000;

export type WebviewToHost = { type: 'prompt'; text: string };

export type HostToWebview =
  | { type: 'event'; event: DisplayEvent }
  | { type: 'status'; state: 'idle' | 'running'; note?: string };

/** Validates untrusted input from the webview. Returns undefined for anything unexpected. */
export function parseWebviewMessage(raw: unknown): WebviewToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as { type?: unknown; text?: unknown };
  if (m.type === 'prompt' && typeof m.text === 'string') {
    const text = m.text.trim();
    if (text.length > 0 && text.length <= MAX_PROMPT_CHARS) return { type: 'prompt', text };
  }
  return undefined;
}
