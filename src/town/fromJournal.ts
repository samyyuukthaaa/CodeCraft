// Pure projection of journal entries to Code Town events. The journal is the ONE source of truth for what happened;
// the town never records its own copy, so a reload (or a replay) rebuilds exactly the same scene.
import type { JournalEntry } from '../journal/journal';
import type { TownEvent } from './types';

export function townEventsFor(e: JournalEntry): TownEvent[] {
  const at = e.at;
  switch (e.t) {
    case 'run_started':
      return [{ type: 'run_started', runId: e.runId, request: e.request, at }];
    case 'run_finished':
      return [{ type: 'run_finished', status: e.status, at }];
    case 'plan':
      return e.files.filter((f) => f.action === 'edit' || f.action === 'create').map((f) => ({ type: 'file_planned' as const, path: f.path, action: f.action as 'edit' | 'create', ...(f.why ? { why: f.why } : {}), at }));
    case 'change_group':
      return e.files.map((path) => ({ type: 'file_note' as const, path, reason: e.reason, plain: e.plain, confidence: e.confidence, at }));
    case 'file_read':
      return [{ type: 'file_read', path: e.path, at }];
    case 'op_proposed':
      return e.files.map((f) => ({ type: 'hunk_proposed' as const, path: f.path, intent: f.intent, hunks: f.hunks, ...(e.reason ? { reason: e.reason } : {}), at }));
    case 'review':
      return e.files.map((f) => ({ type: 'hunk_decided' as const, path: f.path, accepted: f.accepted, rejected: f.rejected, at }));
    case 'op_applied':
      return e.files.map((f) => ({ type: 'file_written' as const, path: f.path, opId: e.opId, accepted: f.accepted, rejected: f.rejected, created: f.before === null, at }));
    case 'op_undone':
    case 'files_undone':
      return e.files.map((path) => ({ type: 'file_reverted' as const, path, opId: e.opId, at }));
    case 'tests':
      return [{ type: 'test_run', passed: e.passed, failing: e.failing ?? [], phase: e.phase ?? 'agent', at }];
    case 'regression':
      return e.tests.filter((t) => t.includes('::')).map((t) => ({ type: 'file_failed' as const, path: t.split('::')[0]!, reason: `a test that passed before now fails: ${t}`, at }));
    case 'provider_error':
      return [{ type: 'provider', status: 'retrying', model: e.model, detail: e.cls.replace(/_/g, ' '), at }];
    case 'model_switched':
      return [{ type: 'provider', status: 'failed_over', model: e.to, detail: `from ${e.from} (${e.reason.replace(/_/g, ' ')})`, at }];
    case 'provider_recovered':
      return [{ type: 'provider', status: 'recovered', model: e.model, detail: `${e.model} works again`, at }];
    default:
      return [];
  }
}

/**
 * The entries of the run to show: everything from the most recent run_started on (including entries written
 * outside a run after it, such as Undo Last Change). `runId` picks a specific run instead (replay).
 */
export function entriesOfRun(entries: readonly JournalEntry[], runId?: string): JournalEntry[] {
  if (runId) return entries.filter((e) => e.runId === runId);
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.t === 'run_started') return entries.slice(i);
  return [];
}

/** Finished runs (run_started ... run_finished) for replay, newest first. */
export function finishedRuns(entries: readonly JournalEntry[], max = 30): Array<{ runId: string; request: string; at: number; status: string }> {
  const started = new Map<string, { request: string; at: number }>();
  const out: Array<{ runId: string; request: string; at: number; status: string }> = [];
  for (const e of entries) {
    if (e.t === 'run_started' && e.runId) started.set(e.runId, { request: e.request.replace(/\s+/g, ' ').slice(0, 120), at: e.at });
    if (e.t === 'run_finished' && started.has(e.runId)) {
      const s = started.get(e.runId)!;
      const i = out.findIndex((r) => r.runId === e.runId);
      if (i >= 0) out.splice(i, 1);
      out.push({ runId: e.runId, request: s.request, at: s.at, status: e.status });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max);
}

export function townEventsFromJournal(entries: readonly JournalEntry[], runId?: string): TownEvent[] {
  return entriesOfRun(entries, runId).flatMap(townEventsFor);
}
