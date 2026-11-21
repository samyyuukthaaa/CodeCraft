import { SceneState, TownEvent } from './types';

export type TownToHost =
  | { type: 'open_file'; path: string }
  | { type: 'replay_run' };

export type HostToTown =
  | { type: 'scene'; state: SceneState }
  | { type: 'event'; event: TownEvent }
  | { type: 'journal'; events: TownEvent[] }
  | { type: 'focus'; path: string };

export function parseTownMessage(raw: unknown): TownToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as { type?: unknown; path?: unknown };
  const keys = Object.keys(m).length;
  // The webview is read-only: it may only ask to open a file or replay; nothing else, no extra fields.
  if (m.type === 'replay_run' && keys === 1) {
    return { type: 'replay_run' };
  }
  if (m.type === 'open_file' && typeof m.path === 'string' && keys === 2) {
    const p = m.path.trim();
    if (p.length > 0 && p.length < 500 && !p.includes('..') && !p.startsWith('/') && !p.startsWith('\\')) {
      return { type: 'open_file', path: p.replace(/\\/g, '/') };
    }
  }
  return undefined;
}
