// Scout, the town's guide: an original little round block creature with big friendly eyes, a warm scarf and cap,
// and a lantern. Pure (no VS Code, no Three.js, no clock): where Scout is, where it came from and what its speech
// bubble says derive ONLY from town events (the journal projection, including the user's journaled navigate
// clicks). Replaying the same events reproduces Scout exactly. Bubbles use plain words and never hold key values.
import type { SceneState, TownEvent } from './types';

export type ScoutPlace = { kind: 'home' } | { kind: 'building'; id: string } | { kind: 'plant' };
export type ScoutMood = 'idle' | 'busy' | 'happy' | 'worried';

export interface Scout {
  at: ScoutPlace;
  /** Where Scout came from for the latest move (the renderer walks from here to `at`). */
  from: ScoutPlace;
  bubble: string;
  mood: ScoutMood;
  /** Incremented on every move or new bubble: the renderer animates per move, never per frame of wall time. */
  move: number;
  /** Who sent Scout: the agent's journaled action, or the user's click. */
  by: 'agent' | 'user';
}

export const SCOUT_HOME: Scout = { at: { kind: 'home' }, from: { kind: 'home' }, bubble: "Hi! I'm Scout. I'll show you what the agent does.", mood: 'idle', move: 0, by: 'agent' };

const name = (s: SceneState, path: string): string => s.buildings[path]?.name ?? path.split('/').pop() ?? path;
const samePlace = (a: ScoutPlace, b: ScoutPlace): boolean => a.kind === b.kind && (a.kind !== 'building' || (b.kind === 'building' && a.id === b.id));

/** Words for a provider problem class as journaled ("rate limit", "unavailable or timeout", ...). */
function plain(detail: string | undefined): string {
  const d = (detail ?? '').toLowerCase();
  if (d.includes('rate limit')) return 'it hit its rate limit';
  if (d.includes('unavailable') || d.includes('timeout')) return 'it was unavailable';
  if (d.includes('invalid') || d.includes('key')) return 'its key was rejected';
  if (d.includes('context')) return 'the request was too large for it';
  if (d.includes('bad output')) return 'it gave output I could not use';
  return 'it stopped working';
}

function go(prev: Scout, at: ScoutPlace, bubble: string, mood: ScoutMood, by: Scout['by'] = 'agent'): Scout {
  return { at, from: samePlace(prev.at, at) ? prev.from : prev.at, bubble, mood, move: prev.move + 1, by };
}

/** Scout after an event (applied to the scene AFTER the reducer handled the event). */
export function scoutAfter(prev: Scout, s: SceneState, e: TownEvent): Scout {
  const b = (p: string): ScoutPlace => ({ kind: 'building', id: p });
  switch (e.type) {
    case 'init':
      return { ...SCOUT_HOME, move: prev.move + 1 };
    case 'reset':
      return { ...SCOUT_HOME, move: prev.move + 1 };
    case 'run_started':
      return go(prev, { kind: 'home' }, 'A new task! Let me follow the agent.', 'busy');
    case 'run_finished':
      return { ...prev, bubble: e.status === 'done' ? 'All done for this task.' : e.status === 'cancelled' ? 'The task was stopped.' : 'This task ended with a problem.', mood: e.status === 'done' ? 'happy' : 'worried', move: prev.move + 1 };
    case 'file_planned':
      return go(prev, b(e.path), `Planning to ${e.action} ${name(s, e.path)}`, 'busy');
    case 'file_read':
      return go(prev, b(e.path), `Reading ${name(s, e.path)}`, 'busy');
    case 'hunk_proposed':
      return go(prev, b(e.path), `Proposing a change to ${name(s, e.path)}`, 'busy');
    case 'hunk_decided':
      return e.accepted === 0
        ? go(prev, b(e.path), `You rejected the change to ${name(s, e.path)}`, 'idle')
        : go(prev, b(e.path), `You accepted ${e.accepted} change${e.accepted === 1 ? '' : 's'} in ${name(s, e.path)}`, 'happy');
    case 'file_written':
      return go(prev, b(e.path), `${e.created ? 'Created' : 'Changed'} ${name(s, e.path)}`, 'happy');
    case 'file_reverted':
      return go(prev, b(e.path), `Put ${name(s, e.path)} back the way it was`, 'idle');
    case 'file_failed':
      return go(prev, b(e.path), `A test in ${name(s, e.path)} fails`, 'worried');
    case 'test_run':
      return { ...prev, bubble: e.passed ? 'All tests pass!' : `Tests fail${e.failing.length && e.failing[0]!.includes('::') ? `: ${e.failing.length} failing` : ''}`, mood: e.passed ? 'happy' : 'worried', move: prev.move + 1 };
    case 'provider':
      if (e.status === 'failed_over') return go(prev, { kind: 'plant' }, `The main model stopped because ${plain(e.detail)}. I switched to the backup model${e.model ? ` (${e.model})` : ''}.`, 'worried');
      if (e.status === 'recovered') return go(prev, { kind: 'plant' }, `The main model${e.model ? ` (${e.model})` : ''} works again.`, 'happy');
      if (e.status === 'retrying') return { ...prev, bubble: `The model had a hiccup (${plain(e.detail).replace(/^it /, '')}). Trying again…`, mood: 'worried', move: prev.move + 1 };
      return prev;
    case 'scout_navigate':
      return go(prev, b(e.path), `Here is ${name(s, e.path)}. Opening it for you.`, 'idle', 'user');
    default:
      return prev;
  }
}
