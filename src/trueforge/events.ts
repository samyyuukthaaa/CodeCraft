// Pure: turns SDK stream events into short, bounded, redacted display records.
// No source code, prompts or secrets are copied into these records beyond bounded model text.
import { redact } from '../util/redact';
import type { TurnEvent } from './client';

export interface DisplayEvent {
  /** Raw TrueForge event type, e.g. "turn.done". */
  type: string;
  /** Short one-line summary, redacted and length-bounded. */
  summary: string;
  /** Streaming model text to append (assistant answer deltas only). */
  delta?: string;
  /** True only for a turn that ended in an error: a failed turn is never shown as success. */
  failed?: boolean;
}

const MAX = 400;

function clip(s: string): string {
  const r = redact(s).replace(/\s+/g, ' ').trim();
  return r.length > MAX ? `${r.slice(0, MAX)}…` : r;
}

export function toDisplay(ev: TurnEvent): DisplayEvent {
  switch (ev.type) {
    case 'model.message.delta':
      // reasoning deltas are intentionally not displayed
      return { type: ev.type, summary: '', delta: ev.content ? redact(ev.content) : undefined };
    case 'model.message':
      return { type: ev.type, summary: ev.model?.name ? `model ${ev.model.name}` : 'model message' };
    case 'turn.created':
      return { type: ev.type, summary: `turn ${ev.turnId}` };
    case 'turn.done': {
      const s = ev.state;
      if (s.status === 'error') return { type: ev.type, summary: `error: ${clip(s.message)}`, failed: true };
      return { type: ev.type, summary: `status ${s.status}` };
    }
    case 'thread.context_compaction_started': {
      const t = ev.trigger as { type?: string; value?: number } | undefined;
      return { type: ev.type, summary: `compacting the conversation (trigger: ${t?.type === 'input_tokens' ? `input tokens > ${t.value}` : (t?.type ?? 'automatic')})` };
    }
    case 'thread.context_compaction_finished':
      return { type: ev.type, summary: `conversation compacted in ${ev.durationMs} ms` };
    case 'tool.approval_required':
    case 'tool.response_required':
      return { type: ev.type, summary: `${ev.toolCalls.length} tool call(s)` };
    default:
      return { type: ev.type, summary: '' };
  }
}
