// The write gate. Pure with respect to VS Code: it talks to the filesystem only through injected
// interfaces, and the ONLY code path that changes a file is applyApproved(), which refuses anything
// without a stored per-hunk decision for that exact path and content, and anything stale.
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

/** Performs the actual write as ONE undo step (host-specific). Never called without a stored decision. */
export interface Applier {
  apply(relPath: string, newText: string): Promise<void>;
  remove(relPath: string): Promise<void>;
}

export interface ReviewRequest {
  path: string;
  reason: string;
  oldText: string;
  newText: string;
  hunks: Hunk[];
}

/** Shows the proposal to the user and returns a decision per hunk id. Missing ids count as reject. */
export interface Reviewer {
  review(req: ReviewRequest): Promise<Record<number, Decision>>;
}

export type ProposeStatus = 'applied' | 'partially_applied' | 'rejected' | 'refused' | 'no_change';

export interface ProposeResult {
  status: ProposeStatus;
  message: string;
  acceptedHunks?: number;
  rejectedHunks?: number;
}

interface StoredDecision {
  baseHash: string | null;
  hunks: Hunk[];
  decisions: Record<number, Decision>;
}

interface UndoEntry {
  path: string;
  before: string | undefined;
  after: string;
}

export const MAX_WRITE_CHARS = 1_000_000;

export const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

export class WriteGate {
  private readonly readHashes = new Map<string, string>();
  private readonly decisions = new Map<string, StoredDecision>();
  private readonly undoStack: UndoEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fs: ReadFs,
    private readonly applier: Applier,
    private readonly reviewer: Reviewer,
  ) {}

  /** Called by read_file so a later write can be checked against what the agent actually saw. */
  recordRead(relPath: string, content: string): void {
    this.readHashes.set(relPath, hash(content));
  }

  /** Proposals are serialized: the user reviews one at a time. */
  propose(rawPath: string, newContent: string, reason: string): Promise<ProposeResult> {
    const run = this.queue.then(() => this.proposeInner(rawPath, newContent, reason));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async proposeInner(rawPath: string, newContent: string, reason: string): Promise<ProposeResult> {
    let path: string;
    try {
      path = normalizeRelPath(rawPath);
    } catch (e) {
      return refuse(e instanceof Error ? e.message : 'invalid path');
    }
    if (typeof newContent !== 'string' || newContent.length > MAX_WRITE_CHARS) return refuse('content is missing or too large');

    const current = await this.fs.read(path);
    if (current !== undefined) {
      const seen = this.readHashes.get(path);
      if (seen === undefined) return refuse('read the file with read_file before proposing a change to it');
      if (seen !== hash(current)) return refuse('the file changed since it was read; read it again and re-propose');
    }
    if (current === newContent) return { status: 'no_change', message: 'content is identical to the current file' };

    const hunks = computeHunks(current ?? '', newContent);
    const chosen = await this.reviewer.review({ path, reason, oldText: current ?? '', newText: newContent, hunks });
    const decisions: Record<number, Decision> = {};
    for (const h of hunks) decisions[h.id] = chosen[h.id] === 'accept' ? 'accept' : 'reject';
    this.decisions.set(key(path, newContent), { baseHash: current === undefined ? null : hash(current), hunks, decisions });
    return this.applyApproved(path, newContent);
  }

  /**
   * The only writer. Refuses unless a decision is stored for this exact path AND content, the file is
   * unchanged since the proposal, and at least one hunk was accepted. Decisions are single-use.
   */
  async applyApproved(rawPath: string, newContent: string): Promise<ProposeResult> {
    let path: string;
    try {
      path = normalizeRelPath(rawPath);
    } catch (e) {
      return refuse(e instanceof Error ? e.message : 'invalid path');
    }
    const k = key(path, newContent);
    const stored = this.decisions.get(k);
    if (!stored) return refuse('no stored decision for this exact path and content');
    this.decisions.delete(k); // single use: an operation is never applied twice

    const current = await this.fs.read(path);
    const nowHash = current === undefined ? null : hash(current);
    if (nowHash !== stored.baseHash) return refuse('the file changed after the proposal; nothing was written');

    const accepted = new Set(stored.hunks.filter((h) => stored.decisions[h.id] === 'accept').map((h) => h.id));
    const rejectedCount = stored.hunks.length - accepted.size;
    if (accepted.size === 0) {
      return { status: 'rejected', message: 'all hunks were rejected; nothing was written', acceptedHunks: 0, rejectedHunks: rejectedCount };
    }
    const finalText = applyHunks(current ?? '', stored.hunks, accepted);
    await this.applier.apply(path, finalText);
    this.undoStack.push({ path, before: current, after: finalText });
    this.readHashes.set(path, hash(finalText));
    return {
      status: rejectedCount === 0 ? 'applied' : 'partially_applied',
      message: `applied ${accepted.size} of ${stored.hunks.length} hunk(s)`,
      acceptedHunks: accepted.size,
      rejectedHunks: rejectedCount,
    };
  }

  /** Reverts the most recent applied change, only if the file is still exactly what we wrote. */
  async undoLast(): Promise<ProposeResult> {
    const last = this.undoStack[this.undoStack.length - 1];
    if (!last) return refuse('nothing to undo');
    const current = await this.fs.read(last.path);
    if (current !== last.after) return refuse(`${last.path} changed since CodeCraft wrote it; not undoing`);
    if (last.before === undefined) await this.applier.remove(last.path);
    else await this.applier.apply(last.path, last.before);
    this.undoStack.pop();
    this.readHashes.delete(last.path);
    return { status: 'applied', message: `reverted ${last.path}` };
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }
}

function key(path: string, content: string): string {
  return `${path}\0${hash(content)}`;
}

function refuse(message: string): ProposeResult {
  return { status: 'refused', message };
}
