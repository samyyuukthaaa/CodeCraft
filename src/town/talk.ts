// Scout's speech bubble for Ask Scout answers. Pure and cosmetic: renderer state only (never in the reducer, the
// journal or a replay), no DOM, no Three.js, no network, no model. The caller passes the time in seconds.
//
// Rules:
// - A question pauses Scout's ambient patrol at once. If he is walking to a target (the agent's file or a clicked
//   building), he finishes that walk first and then answers ('waiting'); if he stands still, he answers at once.
// - The bubble shows the first 2 to 3 sentences; "Show more" expands it to the full answer.
// - He resumes when the bubble is closed (button or Esc), after TALK_IDLE_S seconds without a new question or
//   interaction, or when a new run starts. A new question replaces the bubble.

/** Seconds of quiet after the answer before Scout closes the bubble and walks on. */
export const TALK_IDLE_S = 20;
/** The short bubble: two sentences, a third one if it still fits in this many characters. */
export const SHORT_MAX_CHARS = 240;

/** Splits an answer into sentences (keeps the punctuation). */
export function sentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The first 2 to 3 sentences, and whether there is more. */
export function shortAnswer(answer: string): { short: string; truncated: boolean } {
  const all = sentences(answer);
  let n = Math.min(2, all.length);
  if (all.length >= 3 && all.slice(0, 3).join(' ').length <= SHORT_MAX_CHARS) n = 3;
  return { short: all.slice(0, n).join(' '), truncated: n < all.length };
}

export interface BubblePart {
  text: string;
  /** The one highlighted keyword (yellow), like the town's captions. */
  yellow?: boolean;
}

/** Splits `text` around the first of `words` found as a whole word (case-insensitive): one yellow keyword. */
export function highlight(text: string, words: readonly string[]): BubblePart[] {
  for (const w of words) {
    if (!w.trim()) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
    const m = re.exec(text);
    if (!m) continue;
    const at = m.index + m[1]!.length;
    const kw = m[2]!;
    return [{ text: text.slice(0, at) }, { text: kw, yellow: true }, { text: text.slice(at + kw.length) }].filter((p) => p.text);
  }
  return [{ text }];
}

export type TalkPhase = 'idle' | 'waiting' | 'talking';

export interface TalkView {
  question: string;
  answer: string;
  short: BubblePart[];
  full: BubblePart[];
  truncated: boolean;
  expanded: boolean;
}

/** The bubble's state machine. One instance per page; `now` is in seconds. */
export class ScoutTalk {
  phase: TalkPhase = 'idle';
  view: TalkView | undefined;
  private lastActivity = 0;

  /** Scout should not patrol (a question is waiting or being answered). */
  get pausesPatrol(): boolean {
    return this.phase !== 'idle';
  }

  /** The bubble is open (Scout stands still and talks). */
  get open(): boolean {
    return this.phase === 'talking';
  }

  /**
   * A new question (replaces any open bubble). Returns 'talking' when the bubble shows now, or 'waiting' when
   * Scout first finishes the walk to his current target.
   */
  ask(question: string, answer: string, keywords: readonly string[], now: number, walkingToTarget: boolean): TalkPhase {
    const { short, truncated } = shortAnswer(answer);
    this.view = { question, answer, short: highlight(short, keywords), full: highlight(answer, keywords), truncated, expanded: false };
    this.lastActivity = now;
    this.phase = walkingToTarget ? 'waiting' : 'talking';
    return this.phase;
  }

  /** "Show more": the full answer (scrollable). Counts as activity. */
  expand(now: number): void {
    if (!this.view || this.phase !== 'talking') return;
    this.view.expanded = true;
    this.lastActivity = now;
  }

  /**
   * Called regularly. Returns 'show' when a waiting answer can now be shown (the target walk ended), 'close'
   * when the bubble timed out, otherwise undefined.
   */
  tick(now: number, walkingToTarget: boolean): 'show' | 'close' | undefined {
    if (this.phase === 'waiting' && !walkingToTarget) {
      this.phase = 'talking';
      this.lastActivity = now;
      return 'show';
    }
    if (this.phase === 'talking' && now - this.lastActivity >= TALK_IDLE_S) {
      this.close();
      return 'close';
    }
    return undefined;
  }

  /** Close button, Esc, a new run, or mute. Returns true if something was open or waiting. */
  close(): boolean {
    const was = this.phase !== 'idle';
    this.phase = 'idle';
    this.view = undefined;
    return was;
  }
}
