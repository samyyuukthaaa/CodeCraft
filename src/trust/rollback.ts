// Pure: rollback to a checkpoint, planned from the journal (P5). Checkpoints of a run: "before the first apply"
// and "after each applied change set" (an operation, which may hold several intent groups applied together).
// Rolling back to a checkpoint reverts every operation of that run applied after it and not yet undone, as ONE
// step, and only if every affected file is still exactly what CodeCraft wrote (content hash check).
import type { JournalEntry } from '../journal/journal';
import type { ContentStore, RollbackRequest } from '../mcp/gate';

/** In-memory content store (tests). The extension keeps contents in VS Code workspace storage, never in the repo. */
export class MemorySnapshots implements ContentStore {
  readonly blobs = new Map<string, string>();
  async put(hash: string, content: string): Promise<void> {
    this.blobs.set(hash, content);
  }
  async get(hash: string): Promise<string | undefined> {
    return this.blobs.get(hash);
  }
}

type Applied = Extract<JournalEntry, { t: 'op_applied' }>;

export interface Checkpoint {
  /** 0 = before the first apply; k = after the k-th applied operation of the run. */
  index: number;
  label: string;
  at: number;
  /** Operations (still applied) that a rollback to this checkpoint reverts, newest first. */
  revert: string[];
}

/** The run's operations that are applied and not undone, in apply order. */
function liveOps(entries: readonly JournalEntry[], runId: string): Applied[] {
  const undone = new Set(entries.filter((e) => e.t === 'op_undone').map((e) => (e as { opId: string }).opId));
  return entries.filter((e): e is Applied => e.t === 'op_applied' && e.runId === runId && !undone.has(e.opId));
}

/** The most recent run that still has applied operations. */
export function latestRunWithChanges(entries: readonly JournalEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.t === 'op_applied' && liveOps(entries, e.runId).length) return e.runId;
  }
  return undefined;
}

export function checkpoints(entries: readonly JournalEntry[], runId: string): Checkpoint[] {
  const ops = liveOps(entries, runId);
  if (!ops.length) return [];
  const desc = (op: Applied) => op.files.map((f) => `${f.path} [${f.intent}]`).join(', ');
  const out: Checkpoint[] = [{ index: 0, label: 'Before the first change of this run', at: ops[0]!.at, revert: ops.map((o) => o.opId).reverse() }];
  ops.forEach((op, i) => {
    out.push({ index: i + 1, label: `After change ${i + 1}: ${desc(op)}`, at: op.at, revert: ops.slice(i + 1).map((o) => o.opId).reverse() });
  });
  return out;
}

export interface RollbackPlan extends RollbackRequest {
  checkpoint: Checkpoint;
}

export function planRollback(entries: readonly JournalEntry[], runId: string, index: number): RollbackPlan | undefined {
  const cp = checkpoints(entries, runId).find((c) => c.index === index);
  if (!cp || cp.revert.length === 0) return undefined;
  const ops = liveOps(entries, runId).filter((o) => cp.revert.includes(o.opId)); // apply order
  const byPath = new Map<string, RollbackRequest['files'][number]>();
  for (const op of ops) {
    for (const f of op.files) {
      const cur = byPath.get(f.path);
      // earliest reverted op gives the content to restore; the latest gives what must be on disk now
      if (!cur) byPath.set(f.path, { path: f.path, expectHash: f.after, restoreHash: f.before });
      else cur.expectHash = f.after;
    }
  }
  return { checkpoint: cp, label: cp.label, opIds: cp.revert, files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
