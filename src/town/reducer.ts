// Pure, deterministic scene reducer: (state, event) -> new state. No VS Code, no Three.js, no clock, no
// randomness; every timestamp comes from the event. Replaying the same events always gives the same scene.
import {
  Building,
  BuildingState,
  District,
  STATE_VISUALS,
  SceneState,
  SceneStats,
  TestStatus,
  TownEvent,
  TownFileInput,
} from './types';
import { AGGREGATE_THRESHOLD, computeRoads, districtOf, kindOf } from './grammar';

export const MIN_BUILDING_HEIGHT = 1;
export const MAX_BUILDING_HEIGHT = 20;

export function computeBuildingHeight(lines: number, min: number = MIN_BUILDING_HEIGHT, max: number = MAX_BUILDING_HEIGHT): number {
  if (!Number.isFinite(lines) || lines <= 0) return min;
  return Math.max(min, Math.min(max, Math.round(lines / 20)));
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

export function getDistrictAndName(filePath: string): { district: string; name: string } {
  const norm = normalizePath(filePath);
  const lastSlash = norm.lastIndexOf('/');
  if (lastSlash === -1) return { district: '.', name: norm };
  return { district: norm.slice(0, lastSlash), name: norm.slice(lastSlash + 1) };
}

export function createEmptyStats(): SceneStats {
  return { idle: 0, planned: 0, read: 0, proposed: 0, applied: 0, rejected: 0, failed: 0, recovered: 0 };
}

export function initialSceneState(): SceneState {
  return { districts: {}, buildings: {}, activeBuildingId: undefined, totalBuildings: 0, stats: createEmptyStats(), power: { status: 'healthy' }, roads: [], aggregated: false, version: 0 };
}

function calculateStats(buildings: Record<string, Building>): SceneStats {
  const stats = createEmptyStats();
  for (const b of Object.values(buildings)) stats[b.state]++;
  return stats;
}

const LANGUAGE_BY_EXT: Record<string, string> = { py: 'python', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', md: 'markdown', rst: 'markdown', json: 'json', toml: 'config', cfg: 'config', ini: 'config', yaml: 'config', yml: 'config' };
const languageOf = (p: string): string => LANGUAGE_BY_EXT[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'other';
const looksLikeTest = (p: string): boolean => /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]*\.py$|_test\.py$|\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

export function createBuilding(input: TownFileInput, state: BuildingState = 'idle', placeholder = false, aggregated = false): Building {
  const normPath = normalizePath(input.path);
  const { district: folder, name } = getDistrictAndName(normPath);
  const district = aggregated ? districtOf(normPath, true) : folder;
  const isTest = input.isTest ?? looksLikeTest(normPath);
  const lines = Math.max(0, input.lines ?? 0);
  const visual = STATE_VISUALS[state];
  return {
    id: normPath,
    path: normPath,
    name,
    district,
    folder,
    kind: kindOf(normPath, isTest),
    lines,
    height: computeBuildingHeight(lines),
    language: input.language ?? languageOf(normPath),
    isTest,
    state,
    testStatus: 'unknown',
    color: visual.color,
    icon: visual.icon,
    label: visual.label,
    placeholder,
  };
}

function addToDistrict(districts: Record<string, District>, b: Building): Record<string, District> {
  const existing = districts[b.district];
  if (existing?.buildingIds.includes(b.id)) return districts;
  return {
    ...districts,
    [b.district]: existing
      ? { ...existing, buildingIds: [...existing.buildingIds, b.id] }
      : { id: b.district, name: b.district === '.' ? 'root' : b.district, path: b.district, buildingIds: [b.id], ...(b.district !== b.folder ? { aggregated: true } : {}) },
  };
}

export function initSceneFromFiles(files: TownFileInput[]): SceneState {
  let districts: Record<string, District> = {};
  const buildings: Record<string, Building> = {};
  const aggregated = files.length > AGGREGATE_THRESHOLD;
  for (const file of files) {
    const b = createBuilding(file, 'idle', false, aggregated);
    if (buildings[b.id]) continue;
    buildings[b.id] = b;
    districts = addToDistrict(districts, b);
  }
  const roads = computeRoads(files.map((f) => ({ path: normalizePath(f.path), imports: f.imports?.map(normalizePath) })), (p) => buildings[p]?.district);
  return { ...initialSceneState(), districts, buildings, roads, aggregated, totalBuildings: Object.keys(buildings).length, stats: calculateStats(buildings), version: 1 };
}

/** Which test file a failing test ID belongs to ("tests/test_cli.py::test_x" -> "tests/test_cli.py"). */
export function testFileOf(id: string): string {
  return normalizePath(id.split('::')[0] ?? id);
}

type Patch = Partial<Pick<Building, 'state' | 'testStatus'>> & { detail: string };

/** Updates one building (added as a placeholder lot when it is not in the index). Exact path match only. */
function touch(state: SceneState, path: string, ev: Exclude<TownEvent, { type: 'reset' } | { type: 'init' }>, patch: Patch): SceneState {
  const id = normalizePath(path);
  let districts = state.districts;
  let existing = state.buildings[id];
  if (!existing) {
    existing = createBuilding({ path: id, lines: 0 }, 'idle', true, state.aggregated);
    districts = addToDistrict(districts, existing);
  }
  const next = patch.state ?? existing.state;
  const visual = STATE_VISUALS[next];
  const updated: Building = {
    ...existing,
    state: next,
    testStatus: patch.testStatus ?? existing.testStatus,
    color: visual.color,
    icon: visual.icon,
    label: visual.label,
    lastAction: { type: ev.type, at: ev.at, detail: patch.detail },
    lastUpdated: ev.at,
  };
  const buildings = { ...state.buildings, [id]: updated };
  return { ...state, buildings, districts, totalBuildings: Object.keys(buildings).length, stats: calculateStats(buildings), activeBuildingId: id };
}

const EARLY: BuildingState[] = ['idle', 'planned'];

function step(state: SceneState, event: TownEvent): SceneState {
  switch (event.type) {
    case 'init':
      return { ...initSceneFromFiles(event.files), power: state.power };
    case 'reset':
    case 'run_started': {
      const idle = STATE_VISUALS.idle;
      const buildings: Record<string, Building> = {};
      for (const [id, b] of Object.entries(state.buildings)) {
        const { lastAction: _a, lastUpdated: _u, ...rest } = b;
        buildings[id] = { ...rest, state: 'idle', testStatus: 'unknown', color: idle.color, icon: idle.icon, label: idle.label };
      }
      const base = { ...state, buildings, activeBuildingId: undefined, stats: calculateStats(buildings), tests: undefined };
      if (event.type === 'reset') return { ...base, power: { status: 'healthy', ...(state.power.model ? { model: state.power.model } : {}) } };
      return { ...base, runId: event.runId, power: { status: 'healthy', ...(state.power.model ? { model: state.power.model } : {}), at: event.at } };
    }
    case 'run_finished':
      return state;
    case 'file_planned': {
      const b = state.buildings[normalizePath(event.path)];
      const detail = `planned to ${event.action}${event.why ? `: ${event.why}` : ''}`;
      return touch(state, event.path, event, { detail, ...(!b || EARLY.includes(b.state) ? { state: 'planned' as const } : {}) });
    }
    case 'file_read': {
      const b = state.buildings[normalizePath(event.path)];
      return touch(state, event.path, event, { detail: 'read by the agent', ...(!b || EARLY.includes(b.state) ? { state: 'read' as const } : {}) });
    }
    case 'hunk_proposed':
      return touch(state, event.path, event, { state: 'proposed', detail: `proposed ${event.hunks} hunk(s) [${event.intent}]${event.reason ? `: ${event.reason}` : ''}` });
    case 'hunk_decided':
      return event.accepted === 0
        ? touch(state, event.path, event, { state: 'rejected', detail: `all ${event.rejected} hunk(s) rejected by the user` })
        : touch(state, event.path, event, { detail: `${event.accepted} hunk(s) accepted, ${event.rejected} rejected` });
    case 'file_written':
      return touch(state, event.path, event, {
        state: 'applied',
        testStatus: 'unknown',
        detail: `${event.created ? 'created' : 'changed'}: ${event.accepted} hunk(s) applied${event.rejected ? `, ${event.rejected} rejected` : ''} (operation ${event.opId})`,
      });
    case 'file_reverted':
      return touch(state, event.path, event, { state: 'idle', testStatus: 'unknown', detail: `reverted (undo or rollback of ${event.opId})` });
    case 'file_failed':
      return touch(state, event.path, event, { state: 'failed', testStatus: 'failed', detail: event.reason });
    case 'test_run': {
      const failingFiles = new Set(event.failing.map(testFileOf));
      const perTest = event.failing.length > 0 && event.failing.every((f) => f.includes('::'));
      const buildings: Record<string, Building> = { ...state.buildings };
      for (const [id, b] of Object.entries(state.buildings)) {
        let next: BuildingState = b.state;
        let ts: TestStatus = b.testStatus;
        let detail: string | undefined;
        if (failingFiles.has(id)) {
          next = 'failed';
          ts = 'failed';
          detail = `failing: ${event.failing.filter((f) => testFileOf(f) === id).join(', ')}`;
        } else if (b.state === 'failed' && (event.passed || perTest)) {
          next = 'recovered';
          ts = 'passed';
          detail = `passes again (${event.phase.replace('_', ' ')} tests)`;
        } else if (b.state === 'applied' || b.state === 'recovered') {
          ts = event.passed ? 'passed' : 'failed';
          detail = `tests ${event.passed ? 'passed' : 'failed'} after the change (${event.phase.replace('_', ' ')})`;
        } else if (b.isTest && perTest) {
          ts = 'passed'; // per-test results were listed and this test file was not among the failures
        } else if (b.isTest && event.passed) {
          ts = 'passed';
        }
        if (next !== b.state || ts !== b.testStatus || detail) {
          const v = STATE_VISUALS[next];
          buildings[id] = { ...b, state: next, testStatus: ts, color: v.color, icon: v.icon, label: v.label, ...(detail ? { lastAction: { type: 'test_run', at: event.at, detail }, lastUpdated: event.at } : {}) };
        }
      }
      return { ...state, buildings, stats: calculateStats(buildings), tests: { passed: event.passed, failing: event.failing, phase: event.phase, at: event.at } };
    }
    case 'provider':
      // Provider health belongs to the power plant; it never marks a building failed.
      return { ...state, power: { status: event.status, ...(event.model ?? state.power.model ? { model: event.model ?? state.power.model } : {}), ...(event.detail ? { detail: event.detail } : {}), at: event.at } };
  }
}

export function sceneReducer(state: SceneState, event: TownEvent): SceneState {
  return { ...step(state, event), lastEvent: event, version: state.version + 1 };
}

/** Folds events into a scene (used for reloads and replay). */
export function foldEvents(start: SceneState, events: readonly TownEvent[]): SceneState {
  return events.reduce(sceneReducer, start);
}
