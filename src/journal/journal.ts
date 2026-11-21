// Append-only journal: the single source of truth for what happened in CodeCraft runs (P4/P5). Pure over an
// injected sink; every string is redacted before it is stored. Used for operation IDs (no edit is applied
// twice), checkpoint resume after failover, the edit journal view, and later the Code Town event feed.
import { redact } from '../util/redact';

export type JournalEntry =
  | { t: 'run_started'; runId: string; at: number; request: string }
  | { t: 'plan'; runId: string; at: number; summary: string; files: Array<{ path: string; action: string }> }
  | { t: 'op_started'; runId: string; at: number; opId: string; files: Array<{ path: string; intent: string }> }
  | { t: 'op_applied'; runId: string; at: number; opId: string; files: Array<{ path: string; intent: string; before: string | null; after: string; accepted: number; rejected: number }> }
  | { t: 'op_rejected'; runId: string; at: number; files: string[] }
  | { t: 'op_refused'; runId: string; at: number; reason: string }
  | { t: 'op_undone'; runId: string; at: number; opId: string; files: string[] }
  | { t: 'tests'; runId: string; at: number; passed: boolean; exitCode: number | null }
  | { t: 'provider_error'; runId: string; at: number; model: string; cls: string }
  | { t: 'provider_recovered'; runId: string; at: number; model: string }
  | { t: 'model_switched'; runId: string; at: number; from: string; to: string; reason: string }
  | { t: 'run_finished'; runId: string; at: number; status: string }
  | { t: 'tool_call'; runId: string; at: number; opId: string; tool: string; args: string }
  | { t: 'turn_position'; runId: string; at: number; sessionId?: string; turnId: string; lastEventId?: string; reason: string }
  | { t: 'fault_injected'; runId: string; at: number; fault: string };

/** Every stored entry also carries a per-run sequence number. */
export type StoredEntry = JournalEntry & { seq?: number };

/** An entry as callers write it: the journal fills in `at` (and `runId` when omitted). Distributes over the union. */
export type NewJournalEntry = JournalEntry extends infer E ? (E extends JournalEntry ? Omit<E, 'at' | 'runId'> & { runId?: string } : never) : never;

export interface JournalSink {
  append(line: string): Promise<void>;
  readAll(): Promise<string[]>;
}

/** In-memory sink (tests and the scenario harness). */
export class MemorySink implements JournalSink {
  readonly lines: string[] = [];
  async append(line: string): Promise<void> {
    this.lines.push(line);
  }
  async readAll(): Promise<string[]> {
    return [...this.lines];
  }
}

function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as unknown as T;
  if (Array.isArray(v)) return v.map(redactDeep) as unknown as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}

export class Journal {
  private entries: JournalEntry[] = [];
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly seqByRun = new Map<string, number>();
  /** The current run, set by the host at run start ('' outside a run). */
  runId = '';

  constructor(
    private readonly sink: JournalSink,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    for (const line of await this.sink.readAll()) {
      try {
        const parsed = JSON.parse(line) as StoredEntry;
        this.entries.push(parsed);
        if (typeof parsed.seq === 'number') this.seqByRun.set(parsed.runId, Math.max(this.seqByRun.get(parsed.runId) ?? 0, parsed.seq));
      } catch {
        // a torn last line from a crash is ignored; the journal stays append-only
      }
    }
    this.loaded = true;
  }

  /** Appends (redacted) and returns once written. Writes are serialized so the order is preserved. */
  append(e: NewJournalEntry): Promise<void> {
    const runId = e.runId ?? this.runId;
    const seq = (this.seqByRun.get(runId) ?? 0) + 1;
    this.seqByRun.set(runId, seq);
    const full = redactDeep({ ...e, runId, at: this.now(), seq }) as unknown as JournalEntry;
    this.entries.push(full);
    const line = JSON.stringify(full);
    this.writing = this.writing.then(() => this.sink.append(line));
    return this.writing;
  }

  /** The last persisted stream position of a run (for resume after a restart). */
  lastPosition(runId: string = this.runId): Extract<JournalEntry, { t: 'turn_position' }> | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i] as JournalEntry;
      if (e.t === 'turn_position' && e.runId === runId) return e;
    }
    return undefined;
  }

  all(): readonly JournalEntry[] {
    return this.entries;
  }

  /** Operation IDs that are applied and not undone. */
  appliedOps(): Set<string> {
    const s = new Set<string>();
    for (const e of this.entries) {
      if (e.t === 'op_applied') s.add(e.opId);
      if (e.t === 'op_undone') s.delete(e.opId);
    }
    return s;
  }

  /**
   * Checkpoint for resume: what this run already completed, in words for the next model. Empty when nothing
   * was completed yet.
   */
  completedSteps(runId: string = this.runId): string {
    const done: string[] = [];
    for (const e of this.entries) {
      if (e.runId !== runId) continue;
      if (e.t === 'op_applied') done.push(...e.files.map((f) => `${f.path} (${f.intent}: ${f.accepted} hunk(s) applied after review)`));
      if (e.t === 'op_undone') done.push(`undone: ${e.files.join(', ')}`);
      if (e.t === 'tests') done.push(`tests ${e.passed ? 'passed' : `failed (exit ${e.exitCode})`}`);
    }
    return done.length ? `Already done in this run (do not redo; read files again before changing them): ${done.join('; ')}.` : '';
  }
}
