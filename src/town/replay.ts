// Pure replay player for Code Town (no VS Code, no Three.js, no clock): a finished run's journal events played
// through the SAME reducer as the live view. Stepping and seeking are deterministic: seeking to event i gives
// exactly the scene that stepping i times gives. Pacing follows the real gaps between journal timestamps, scaled
// by the speed and clamped so long pauses do not stall a replay and bursts stay visible.
import { foldEvents, sceneReducer } from './reducer';
import type { SceneState, TownEvent } from './types';

export const SPEEDS = [0.5, 1, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number];
export const MIN_STEP_MS = 60;
export const MAX_STEP_MS = 1500;

export interface RunSummary {
  runId: string;
  request: string;
  at: number;
  status: string;
}

export interface Player {
  runId: string;
  /** The town before the run (index only). */
  base: SceneState;
  events: readonly TownEvent[];
  /** Number of events applied so far (0..events.length). */
  index: number;
  playing: boolean;
  speed: Speed;
  scene: SceneState;
}

export function createPlayer(runId: string, base: SceneState, events: readonly TownEvent[]): Player {
  return { runId, base, events, index: 0, playing: false, speed: 1, scene: base };
}

export const isFinished = (p: Player): boolean => p.index >= p.events.length;

/** Applies the next event (no-op at the end; stops playing there). */
export function step(p: Player): Player {
  const ev = p.events[p.index];
  if (!ev) return { ...p, playing: false };
  const next = { ...p, index: p.index + 1, scene: sceneReducer(p.scene, ev) };
  return isFinished(next) ? { ...next, playing: false } : next;
}

/** Jumps to a position (0..events.length) by refolding from the base: identical to stepping there. */
export function seek(p: Player, index: number): Player {
  const i = Math.max(0, Math.min(p.events.length, Math.floor(index)));
  return { ...p, index: i, scene: foldEvents(p.base, p.events.slice(0, i)), playing: i < p.events.length && p.playing };
}

export function play(p: Player): Player {
  return isFinished(p) ? { ...seek(p, 0), playing: true } : { ...p, playing: true };
}

export function pause(p: Player): Player {
  return { ...p, playing: false };
}

export function setSpeed(p: Player, speed: number): Player {
  return (SPEEDS as readonly number[]).includes(speed) ? { ...p, speed: speed as Speed } : p;
}

const atOf = (e: TownEvent | undefined): number | undefined => (e && e.type !== 'reset' ? e.at : undefined);

/** Milliseconds to wait before applying the next event: the real gap / speed, clamped. */
export function delayToNext(p: Player): number {
  const prev = atOf(p.events[p.index - 1]);
  const next = atOf(p.events[p.index]);
  const gap = prev !== undefined && next !== undefined ? Math.max(0, next - prev) : 0;
  return Math.round(Math.max(MIN_STEP_MS, Math.min(MAX_STEP_MS, gap / p.speed)));
}

/** Position text, e.g. "12 / 87 · 14:02:11 UTC". */
export function positionText(p: Player): string {
  const at = atOf(p.events[Math.max(0, p.index - 1)]);
  return `${p.index} / ${p.events.length}${at !== undefined && p.index > 0 ? ` · ${new Date(at).toISOString().slice(11, 19)} UTC` : ''}`;
}
