import type { RunSummary } from './replay';
import { SceneState, TownEvent } from './types';

export type TownToHost =
  | { type: 'open_file'; path: string }
  /** Scout walks to this building and the file opens (the host checks it is a building in the town). */
  | { type: 'navigate'; path: string }
  /** Replay a finished run from the journal (the latest one when runId is omitted). */
  | { type: 'replay_run'; runId?: string }
  /** Scout's figure failed to build in the webview; a simple marker is shown (the host logs it). No free text. */
  | { type: 'scout_fallback' };

export type HostToTown =
  | { type: 'scene'; state: SceneState }
  | { type: 'event'; event: TownEvent }
  /** Finished runs available for replay, newest first. */
  | { type: 'runs'; runs: RunSummary[] }
  /** A run to replay: the town before the run (index only) and the run's events from the journal. */
  | { type: 'replay'; runId: string; base: SceneState; events: TownEvent[] }
  | { type: 'focus'; path: string }
  /** codecraft.townReducedMotion changed while the panel is open ('on' | 'off' | 'auto'). */
  | { type: 'settings'; reducedMotion: 'on' | 'off' | 'auto'; scout: 'on' | 'muted' };

/** A workspace-relative path: no traversal, not absolute (no drive letter, no leading slash), no control characters. */
export function relativePath(raw: string): string | undefined {
  const p = raw.trim().replace(/\\/g, '/');
  if (p.length === 0 || p.length >= 500) return undefined;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || /[\u0000-\u001f]/.test(p)) return undefined;
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return undefined;
  return p;
}

/** Run IDs are 16 hex characters (src/extension.ts). */
const RUN_ID = /^[0-9a-f]{16}$/;

export function parseTownMessage(raw: unknown): TownToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as { type?: unknown; path?: unknown; runId?: unknown };
  const keys = Object.keys(m).length;
  // The webview is read-only: it may only ask to open a file or replay; nothing else, no extra fields.
  if (m.type === 'scout_fallback' && keys === 1) return { type: 'scout_fallback' };
  if (m.type === 'replay_run' && keys === 1) {
    return { type: 'replay_run' };
  }
  if (m.type === 'replay_run' && keys === 2 && typeof m.runId === 'string' && RUN_ID.test(m.runId)) {
    return { type: 'replay_run', runId: m.runId };
  }
  if ((m.type === 'open_file' || m.type === 'navigate') && typeof m.path === 'string' && keys === 2) {
    const p = relativePath(m.path);
    if (p) return { type: m.type, path: p };
  }
  return undefined;
}
