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
type FileChange = Applied['files'][number];

/** One applied change group: the unit a checkpoint is placed after. */
interface Unit {
  /** Stable within the journal: operation ID and the group's position in it. */
  key: string;
  opId: string;
  intent: string;
  at: number;
  files: FileChange[];
}

export interface Checkpoint {
  /** 0 = before the first apply; k = after the k-th applied change group of the run. */
  index: number;
  label: string;
  at: number;
  /** Change groups (still applied) that a rollback to this checkpoint reverts, as "opId#group", newest first. */
  revert: string[];
}

/**
 * The run's applied change groups that are not undone, in apply order. A change set's files are split into its
 * groups using the journal's change_group entries; older entries without them fall back to runs of the same intent.
 */
function liveUnits(entries: readonly JournalEntry[], runId: string): Unit[] {
  const undoneOps = new Set<string>();
  const undoneFiles = new Set<string>(); // `${opId}\0${path}`
  for (const e of entries) {
    if (e.t === 'op_undone') undoneOps.add(e.opId);
    if (e.t === 'files_undone') for (const p of e.files) undoneFiles.add(`${e.opId}\0${p}`);
  }
  const units: Unit[] = [];
  for (const op of entries) {
    if (op.t !== 'op_applied' || op.runId !== runId || undoneOps.has(op.opId)) continue;
    const groups = entries.filter((e): e is Extract<JournalEntry, { t: 'change_group' }> => e.t === 'change_group' && e.opId === op.opId);
    const opUnits: Unit[] = [];
    const placed = new Set<string>();
    for (const g of groups) {
      const files = op.files.filter((f) => g.files.includes(f.path) && !placed.has(f.path));
      files.forEach((f) => placed.add(f.path));
      if (files.length) opUnits.push({ key: '', opId: op.opId, intent: g.intent, at: op.at, files });
    }
    for (const f of op.files) {
      if (placed.has(f.path)) continue;
      const last = opUnits.at(-1);
      if (last && last.intent === f.intent && !groups.length) last.files.push(f);
      else opUnits.push({ key: '', opId: op.opId, intent: f.intent, at: op.at, files: [f] });
    }
    opUnits.forEach((u, i) => (u.key = `${op.opId}#${i + 1}`));
    for (const u of opUnits) {
      u.files = u.files.filter((f) => !undoneFiles.has(`${op.opId}\0${f.path}`));
      if (u.files.length) units.push(u);
    }
  }
  return units;
}

const unitKey = (u: Unit): string => u.key;

/** The most recent run that still has applied changes. */
export function latestRunWithChanges(entries: readonly JournalEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.t === 'op_applied' && liveUnits(entries, e.runId).length) return e.runId;
  }
  return undefined;
}

export function checkpoints(entries: readonly JournalEntry[], runId: string): Checkpoint[] {
  const units = liveUnits(entries, runId);
  if (!units.length) return [];
  const desc = (u: Unit) => `[${u.intent}] ${u.files.map((f) => f.path).join(', ')}`;
  const out: Checkpoint[] = [{ index: 0, label: 'Before the first change of this run', at: units[0]!.at, revert: units.map(unitKey).reverse() }];
  units.forEach((u, i) => {
    out.push({ index: i + 1, label: `After group ${i + 1}: ${desc(u)}`, at: u.at, revert: units.slice(i + 1).map(unitKey).reverse() });
  });
  return out;
}

export interface RollbackPlan extends RollbackRequest {
  checkpoint: Checkpoint;
}

export function planRollback(entries: readonly JournalEntry[], runId: string, index: number): RollbackPlan | undefined {
  const cp = checkpoints(entries, runId).find((c) => c.index === index);
  if (!cp || cp.revert.length === 0) return undefined;
  const all = liveUnits(entries, runId);
  const revert = all.filter((u) => cp.revert.includes(unitKey(u))); // apply order
  const byPath = new Map<string, RollbackRequest['files'][number]>();
  for (const u of revert) {
    for (const f of u.files) {
      const cur = byPath.get(f.path);
      // earliest reverted group gives the content to restore; the latest gives what must be on disk now
      if (!cur) byPath.set(f.path, { path: f.path, expectHash: f.after, restoreHash: f.before });
      else cur.expectHash = f.after;
    }
  }
  // An operation is fully undone when none of its groups stays applied; otherwise only its reverted files are.
  const opIds = [...new Set(revert.map((u) => u.opId))].reverse();
  const full = opIds.filter((id) => !all.some((u) => u.opId === id && !revert.includes(u)));
  const partial = opIds.filter((id) => !full.includes(id)).map((id) => ({ opId: id, files: revert.filter((u) => u.opId === id).flatMap((u) => u.files.map((f) => f.path)) }));
  return { checkpoint: cp, label: cp.label, opIds: full, ...(partial.length ? { partial } : {}), files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
