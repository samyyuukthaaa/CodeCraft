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
  if (m.type === 'replay_run') {
    return { type: 'replay_run' };
  }
  if (m.type === 'open_file' && typeof m.path === 'string') {
    const p = m.path.trim();
    if (p.length > 0 && p.length < 500 && !p.includes('..') && !p.startsWith('/') && !p.startsWith('\\')) {
      return { type: 'open_file', path: p.replace(/\\/g, '/') };
    }
  }
  return undefined;
}
