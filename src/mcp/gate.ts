// The write gate. Pure with respect to VS Code: it talks to the filesystem only through injected
// interfaces, and the ONLY code path that changes files is applyApproved(), which refuses anything
// without a stored per-hunk decision for that exact set of paths and contents, and anything stale.
// A change set may span several files, grouped by intent (e.g. "rename", "update callers", "fix tests").
import { createHash } from 'node:crypto';
import { Hunk, applyHunks, computeHunks } from './diff';
import { normalizeRelPath } from './paths';

export type Decision = 'accept' | 'reject';

/** Read-only view of the workspace. */
export interface ReadFs {
  /** Current content, or undefined if the file does not exist. */
  read(relPath: string): Promise<string | undefined>;
  list(): Promise<string[]>;
}

/** Performs the actual writes as ONE undo step (host-specific). Never called without a stored decision. */
export interface Applier {
  /** Applies every change together. `text: undefined` deletes a file (used only by undo of a creation). */
  applyAll(changes: Array<{ path: string; text: string | undefined }>): Promise<void>;
}

export interface FileProposal {
  path: string;
  reason: string;
  oldText: string;
  newText: string;
  /** True when the file does not exist yet. */
  isNew: boolean;
  hunks: Hunk[];
}

export interface GroupProposal {
  intent: string;
  files: FileProposal[];
}

export interface ReviewRequest {
  plan: string;
  groups: GroupProposal[];
}

/** Key of one hunk's decision: `${path}#${hunkId}`. */
export const hunkKey = (path: string, id: number): string => `${path}#${id}`;

/** Shows the change set to the user and returns a decision per hunk key. Missing keys count as reject. */
export interface Reviewer {
  review(req: ReviewRequest): Promise<Record<string, Decision>>;
  /** Closes any open review (Stop Run); the open review then counts as reject. */
  cancel?(): void;
}

export type ProposeStatus = 'applied' | 'partially_applied' | 'rejected' | 'refused' | 'no_change';

export interface FileResult {
  path: string;
  intent: string;
  acceptedHunks: number;
  rejectedHunks: number;
}

export interface ProposeResult {
  status: ProposeStatus;
  message: string;
  acceptedHunks?: number;
  rejectedHunks?: number;
  files?: FileResult[];
}

export interface ChangeInput {
  intent: string;
  files: Array<{ path: string; newContent: string }>;
}

interface StoredFile {
  path: string;
  intent: string;
  baseHash: string | null;
  hunks: Hunk[];
}

interface StoredDecision {
  files: StoredFile[];
  decisions: Record<string, Decision>;
}

interface UndoEntry {
  files: Array<{ path: string; before: string | undefined; after: string }>;
}

export const MAX_WRITE_CHARS = 1_000_000;
export const MAX_SET_FILES = 20;

export const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

export class WriteGate {
  private readonly readHashes = new Map<string, string>();
  private readonly decisions = new Map<string, StoredDecision>();
  private readonly undoStack: UndoEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  /** Incremented by stop(); a proposal that started in an earlier generation never writes. */
  private generation = 0;

  constructor(
    private readonly fs: ReadFs,
    private readonly applier: Applier,
    private readonly reviewer: Reviewer,
  ) {}

  /** Called by read_file so a later write can be checked against what the agent actually saw. */
  recordRead(relPath: string, content: string): void {
    this.readHashes.set(relPath, hash(content));
  }

  /** Single-file proposal: a change set with one group. */
  propose(rawPath: string, newContent: string, reason: string): Promise<ProposeResult> {
    return this.proposeSet(reason, [{ intent: 'edit', files: [{ path: rawPath, newContent }] }]);
  }

  /**
   * Stop Run: closes any open review and refuses every proposal that is open or queued, so nothing is
   * written after the user pressed Stop. Writes already applied stay applied (one atomic step each).
   */
  stop(): void {
    this.generation++;
    this.reviewer.cancel?.();
  }

  /** Proposals are serialized: the user reviews one change set at a time. */
  proposeSet(plan: string, groups: ChangeInput[]): Promise<ProposeResult> {
    const gen = this.generation;
    const run = this.queue.then(() => (gen === this.generation ? this.proposeInner(plan, groups, gen) : STOPPED));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async proposeInner(plan: string, groups: ChangeInput[], gen: number): Promise<ProposeResult> {
    const seen = new Set<string>();
    const normalized: ChangeInput[] = [];
    let count = 0;
    for (const g of groups) {
      const intent = (g.intent ?? '').trim().slice(0, 80) || 'edit';
      const files: ChangeInput['files'] = [];
      for (const f of g.files ?? []) {
        let path: string;
        try {
          path = normalizeRelPath(f.path);
        } catch (e) {
          return refuse(`${f.path}: ${e instanceof Error ? e.message : 'invalid path'}`);
        }
        if (seen.has(path)) return refuse(`${path} appears more than once; put each file in exactly one group`);
        if (typeof f.newContent !== 'string' || f.newContent.length > MAX_WRITE_CHARS) return refuse(`${path}: content is missing or too large`);
        seen.add(path);
        files.push({ path, newContent: f.newContent });
        count++;
      }
      if (files.length) normalized.push({ intent, files });
    }
    if (count === 0) return refuse('the change set is empty');
    if (count > MAX_SET_FILES) return refuse(`too many files in one change set (limit ${MAX_SET_FILES})`);

    // Every existing file must have been read and be unchanged since; otherwise nothing is shown or written.
    const review: GroupProposal[] = [];
    const stored: StoredFile[] = [];
    for (const g of normalized) {
      const files: FileProposal[] = [];
      for (const f of g.files) {
        const current = await this.fs.read(f.path);
        if (current !== undefined) {
          const seenHash = this.readHashes.get(f.path);
          if (seenHash === undefined) return refuse(`read ${f.path} with read_file before proposing a change to it`);
          if (seenHash !== hash(current)) return refuse(`${f.path} changed since it was read; read it again and re-propose`);
        }
        if (current === f.newContent) continue;
        const hunks = computeHunks(current ?? '', f.newContent);
        files.push({ path: f.path, reason: plan, oldText: current ?? '', newText: f.newContent, isNew: current === undefined, hunks });
        stored.push({ path: f.path, intent: g.intent, baseHash: current === undefined ? null : hash(current), hunks });
      }
      if (files.length) review.push({ intent: g.intent, files });
    }
    if (stored.length === 0) return { status: 'no_change', message: 'every proposed file is identical to the current file' };

    const chosen = await this.reviewer.review({ plan, groups: review });
    if (gen !== this.generation) return STOPPED; // Stop Run during the review: nothing is written
    const decisions: Record<string, Decision> = {};
    for (const f of stored) for (const h of f.hunks) decisions[hunkKey(f.path, h.id)] = chosen[hunkKey(f.path, h.id)] === 'accept' ? 'accept' : 'reject';
    this.decisions.set(setKey(normalized), { files: stored, decisions });
    return this.applyApprovedSet(normalized);
  }

  /** Single-file form of applyApprovedSet, kept for callers and tests that write one file. */
  applyApproved(rawPath: string, newContent: string): Promise<ProposeResult> {
    return this.applyApprovedSet([{ intent: 'edit', files: [{ path: rawPath, newContent }] }]);
  }

  /**
   * The only writer. Refuses unless a decision is stored for this exact set of paths AND contents, no file
   * changed after the proposal, and at least one hunk was accepted. Decisions are single-use. All accepted
   * hunks across all files are applied together as one undo step.
   */
  async applyApprovedSet(groups: ChangeInput[]): Promise<ProposeResult> {
    let normalized: ChangeInput[];
    try {
      normalized = groups.map((g) => ({ intent: (g.intent ?? '').trim().slice(0, 80) || 'edit', files: g.files.map((f) => ({ path: normalizeRelPath(f.path), newContent: f.newContent })) }));
    } catch (e) {
      return refuse(e instanceof Error ? e.message : 'invalid path');
    }
    const k = setKey(normalized);
    const stored = this.decisions.get(k);
    if (!stored) return refuse('no stored decision for this exact set of paths and contents');
    this.decisions.delete(k); // single use: an operation is never applied twice

    const currents = new Map<string, string | undefined>();
    for (const f of stored.files) {
      const current = await this.fs.read(f.path);
      const nowHash = current === undefined ? null : hash(current);
      if (nowHash !== f.baseHash) return refuse(`${f.path} changed after the proposal; nothing was written`);
      currents.set(f.path, current);
    }

    const changes: Array<{ path: string; text: string }> = [];
    const files: FileResult[] = [];
    let acc = 0;
    let rej = 0;
    for (const f of stored.files) {
      const accepted = new Set(f.hunks.filter((h) => stored.decisions[hunkKey(f.path, h.id)] === 'accept').map((h) => h.id));
      const fr: FileResult = { path: f.path, intent: f.intent, acceptedHunks: accepted.size, rejectedHunks: f.hunks.length - accepted.size };
      files.push(fr);
      acc += fr.acceptedHunks;
      rej += fr.rejectedHunks;
      if (accepted.size) changes.push({ path: f.path, text: applyHunks(currents.get(f.path) ?? '', f.hunks, accepted) });
    }
    if (changes.length === 0) {
      return { status: 'rejected', message: 'all hunks were rejected; nothing was written', acceptedHunks: 0, rejectedHunks: rej, files };
    }
    await this.applier.applyAll(changes);
    this.undoStack.push({ files: changes.map((c) => ({ path: c.path, before: currents.get(c.path), after: c.text })) });
    for (const c of changes) this.readHashes.set(c.path, hash(c.text));
    return {
      status: rej === 0 ? 'applied' : 'partially_applied',
      message: `applied ${acc} of ${acc + rej} hunk(s) in ${changes.length} file(s)`,
      acceptedHunks: acc,
      rejectedHunks: rej,
      files,
    };
  }

  /** Reverts the most recent applied change set, only if every file is still exactly what we wrote. */
  async undoLast(): Promise<ProposeResult> {
    const last = this.undoStack[this.undoStack.length - 1];
    if (!last) return refuse('nothing to undo');
    for (const f of last.files) {
      if ((await this.fs.read(f.path)) !== f.after) return refuse(`${f.path} changed since CodeCraft wrote it; not undoing`);
    }
    await this.applier.applyAll(last.files.map((f) => ({ path: f.path, text: f.before })));
    this.undoStack.pop();
    for (const f of last.files) this.readHashes.delete(f.path);
    return { status: 'applied', message: `reverted ${last.files.map((f) => f.path).join(', ')}` };
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  /** Files written by change sets applied since the undo stack had `depth` entries (for honest failure messages). */
  filesAppliedSince(depth: number): string[] {
    return [...new Set(this.undoStack.slice(depth).flatMap((e) => e.files.map((f) => f.path)))].sort();
  }
}

function setKey(groups: ChangeInput[]): string {
  const parts = groups.flatMap((g) => g.files.map((f) => `${f.path}\0${hash(f.newContent)}`)).sort();
  return hash(parts.join('\n'));
}

const STOPPED: ProposeResult = { status: 'refused', message: 'stopped by the user (Stop Run); nothing was written' };

function refuse(message: string): ProposeResult {
  return { status: 'refused', message };
}
