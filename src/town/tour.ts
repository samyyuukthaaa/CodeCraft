// "Show me around": a short guided tour by Scout. Pure and cosmetic: renderer state only (never in the reducer, the
// journal or a replay), no DOM, no Three.js, no network, no model. Each stop's text comes from the built-in guide
// (src/town/help.ts) plus the live town state.
import { TOPICS } from './help';
import type { ScoutPlace } from './scout';
import { shortAnswer } from './talk';
import type { Building, BuildingState, SceneState } from './types';

export type TourStopId = 'plant' | 'lab' | 'changed' | 'inspector';

export interface TourStop {
  id: TourStopId;
  title: string;
  /** Where Scout walks (the inspector stop stays at the changed building). */
  place: ScoutPlace;
  /** The building the stop is about (highlighted; the inspector opens on it at the last stop). */
  building?: string;
  text: string;
  /** The one yellow keyword in the bubble. */
  keyword: string;
}

const guide = (id: string, s: SceneState): string => shortAnswer(TOPICS.find((t) => t.id === id)!.answer(s)).short;

/** Touched states, most interesting first (a success, then a pending proposal, then the rest). */
const CHANGED_ORDER: BuildingState[] = ['applied', 'recovered', 'proposed', 'failed', 'rejected'];

function pick(list: Building[]): Building | undefined {
  return [...list].sort((a, b) => a.id.localeCompare(b.id))[0];
}

/** The tour for this town: power plant, a test lab, a changed (or proposed) building, then the inspector. */
export function tourStops(s: SceneState): TourStop[] {
  const all = Object.values(s.buildings).filter((b) => !b.placeholder);
  const stops: TourStop[] = [
    {
      id: 'plant',
      title: 'The power plant',
      place: { kind: 'plant' },
      text: `This is the power plant: the AI model provider. ${guide('failover', s)}`,
      keyword: 'power plant',
    },
  ];
  const labs = all.filter((b) => b.kind === 'lab');
  const lab = pick(labs.filter((b) => b.testStatus !== 'unknown')) ?? pick(labs);
  if (lab)
    stops.push({
      id: 'lab',
      title: 'A test lab',
      place: { kind: 'building', id: lab.id },
      building: lab.id,
      text: `${lab.name} is a test lab: a test file. ${guide('tests', s)}`,
      keyword: lab.name,
    });
  let changed: Building | undefined;
  for (const st of CHANGED_ORDER) changed ??= pick(all.filter((b) => b.state === st));
  const target = changed ?? pick(all.filter((b) => b.kind === 'code')) ?? pick(all);
  if (target) {
    stops.push({
      id: 'changed',
      title: changed ? 'A changed building' : 'Where changes show up',
      place: { kind: 'building', id: target.id },
      building: target.id,
      text: changed
        ? `The agent touched ${target.name}: it is ${changed.state} now. ${guide('review', s)}`
        : `Nothing has changed yet in this run. When the agent proposes a change to a file like ${target.name}, its building turns orange. ${guide('review', s)}`,
      keyword: target.name,
    });
    stops.push({
      id: 'inspector',
      title: 'The inspector',
      place: { kind: 'building', id: target.id },
      building: target.id,
      text:
        `Click any building to open the inspector: it shows the last thing the agent did there, its state, the reason, tests and confidence. ` +
        `I opened it for ${target.name}. Open file takes you to the code.`,
      keyword: 'inspector',
    });
  }
  return stops;
}

export type TourPhase = 'walking' | 'showing' | 'done';

/** The tour's controller. Scout walks to a stop, then the bubble shows its text with Next and Skip. */
export class ScoutTour {
  index = 0;
  phase: TourPhase = 'walking';

  constructor(readonly stops: TourStop[]) {
    if (!stops.length) this.phase = 'done';
  }

  get current(): TourStop | undefined {
    return this.phase === 'done' ? undefined : this.stops[this.index];
  }

  get isLast(): boolean {
    return this.index >= this.stops.length - 1;
  }

  /** Called regularly: 'show' once Scout has arrived at the current stop. */
  tick(walking: boolean): 'show' | undefined {
    if (this.phase === 'walking' && !walking) {
      this.phase = 'showing';
      return 'show';
    }
    return undefined;
  }

  /** Next stop ('walk'), or the end of the tour ('done'). */
  next(): 'walk' | 'done' {
    if (this.phase === 'done') return 'done';
    if (this.isLast) {
      this.phase = 'done';
      return 'done';
    }
    this.index++;
    this.phase = 'walking';
    return 'walk';
  }

  /** Skip (or Esc, mute, a new run, a question): ends the tour at once. */
  skip(): void {
    this.phase = 'done';
  }
}
