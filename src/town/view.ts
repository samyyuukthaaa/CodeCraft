// Pure view helpers for Code Town (no VS Code, no Three.js): the two modes over the SAME scene state, their
// legends, and what the click-to-inspect panel shows for a building.
import { KIND_VISUALS, POWER_VISUALS, TEST_VISUALS, Visual } from './grammar';
import { BUILDING_STATES, STATE_VISUALS, SceneState } from './types';

/** Agent Journey: the path the agent took in this run, buildings coloured by state. Architecture: districts,
 * roads (imports) and building kinds. */
export type ViewMode = 'journey' | 'architecture';
export const VIEW_MODES: Record<ViewMode, string> = { journey: 'Agent Journey', architecture: 'Architecture' };

export interface LegendSection {
  title: string;
  items: Visual[];
}

export const JOURNEY_VISUAL: Visual = { color: '#facc15', icon: '➜', label: "The agent's path (numbered stops)" };
export const ROAD_VISUAL: Visual = { color: '#7aa2e3', icon: '═', label: 'Road: imports between districts' };

export function legendFor(mode: ViewMode): LegendSection[] {
  const kinds: LegendSection = { title: 'Buildings', items: Object.values(KIND_VISUALS) };
  const power: LegendSection = { title: 'Power plant (model provider)', items: Object.values(POWER_VISUALS) };
  if (mode === 'architecture') return [kinds, { title: 'Streets', items: [ROAD_VISUAL] }, power];
  return [
    { title: 'Building state', items: BUILDING_STATES.map((s) => STATE_VISUALS[s]) },
    { title: 'Tests', items: Object.values(TEST_VISUALS) },
    { title: 'Path', items: [JOURNEY_VISUAL] },
    power,
  ];
}

/** The numbered stops of the journey: each building once, at its first visit, in order. */
export function journeyStops(scene: SceneState): Array<{ path: string; n: number }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; n: number }> = [];
  for (const s of scene.journey) {
    if (seen.has(s.path) || !scene.buildings[s.path]) continue;
    seen.add(s.path);
    out.push({ path: s.path, n: out.length + 1 });
  }
  return out;
}

export interface InspectorRow {
  label: string;
  value: string;
  /** A colour for the value (state, tests, confidence), shown together with the text. */
  color?: string;
}

export interface Inspection {
  title: string;
  path: string;
  rows: InspectorRow[];
}

const CONFIDENCE_COLOR: Record<string, string> = { sure: '#22c55e', 'check this': '#f59e0b', risky: '#ef4444' };
const ACTION_TEXT: Record<string, string> = {
  file_planned: 'planned',
  file_read: 'read',
  hunk_proposed: 'proposed a change',
  hunk_decided: 'change reviewed',
  file_written: 'change applied',
  file_reverted: 'reverted',
  file_failed: 'failed',
  test_run: 'tests ran',
};

const clock = (at: number): string => new Date(at).toISOString().slice(11, 19);

/** What the inspector shows: last agent action, status and reason (plus kind, tests, confidence, journey stop). */
export function inspect(scene: SceneState, id: string): Inspection | undefined {
  const b = scene.buildings[id];
  if (!b) return undefined;
  const k = KIND_VISUALS[b.kind];
  const t = TEST_VISUALS[b.testStatus];
  const rows: InspectorRow[] = [
    { label: 'Status', value: `${b.icon} ${b.label}`, color: b.color },
    { label: 'Last agent action', value: b.lastAction ? `${ACTION_TEXT[b.lastAction.type] ?? b.lastAction.type} at ${clock(b.lastAction.at)} UTC: ${b.lastAction.detail}` : 'none in this run' },
    { label: 'Reason', value: b.reason ?? (b.lastAction ? 'not given' : '-') },
  ];
  if (b.plain) rows.push({ label: 'In plain words', value: b.plain });
  if (b.confidence) rows.push({ label: 'Confidence', value: b.confidence, color: CONFIDENCE_COLOR[b.confidence] ?? '#94a3b8' });
  rows.push({ label: 'Tests', value: `${t.icon} ${t.label}`, color: t.color });
  rows.push({ label: 'Kind', value: `${k.icon} ${k.label}` });
  rows.push({ label: 'Size', value: b.placeholder ? 'not in the index (new or unindexed file)' : `${b.lines} lines` });
  const stop = journeyStops(scene).find((s) => s.path === id);
  if (stop) rows.push({ label: 'Journey', value: `stop ${stop.n} of ${journeyStops(scene).length}` });
  return { title: b.name, path: b.path, rows };
}
