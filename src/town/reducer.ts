import {
  Building,
  BuildingState,
  District,
  STATE_VISUALS,
  SceneState,
  SceneStats,
  TownEvent,
  TownFileInput,
} from './types';

export const MIN_BUILDING_HEIGHT = 1;
export const MAX_BUILDING_HEIGHT = 20;

export function computeBuildingHeight(
  lines: number,
  min: number = MIN_BUILDING_HEIGHT,
  max: number = MAX_BUILDING_HEIGHT,
): number {
  if (!Number.isFinite(lines) || lines <= 0) return min;
  const raw = Math.round(lines / 20);
  return Math.max(min, Math.min(max, Math.max(min, raw)));
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

export function getDistrictAndName(filePath: string): { district: string; name: string } {
  const norm = normalizePath(filePath);
  const lastSlash = norm.lastIndexOf('/');
  if (lastSlash === -1) {
    return { district: '.', name: norm };
  }
  return {
    district: norm.slice(0, lastSlash),
    name: norm.slice(lastSlash + 1),
  };
}

export function createEmptyStats(): SceneStats {
  return {
    idle: 0,
    read: 0,
    proposed: 0,
    applied: 0,
    rejected: 0,
    failed: 0,
  };
}

export function initialSceneState(): SceneState {
  return {
    districts: {},
    buildings: {},
    activeBuildingId: undefined,
    totalBuildings: 0,
    stats: createEmptyStats(),
    lastEvent: undefined,
    version: 0,
  };
}

function calculateStats(buildings: Record<string, Building>): SceneStats {
  const stats = createEmptyStats();
  for (const b of Object.values(buildings)) {
    if (b.state in stats) {
      stats[b.state]++;
    }
  }
  return stats;
}

export function createBuilding(input: TownFileInput, state: BuildingState = 'idle'): Building {
  const normPath = normalizePath(input.path);
  const { district, name } = getDistrictAndName(normPath);
  const lines = Math.max(0, input.lines ?? 0);
  const height = computeBuildingHeight(lines);
  const visual = STATE_VISUALS[state];

  return {
    id: normPath,
    path: normPath,
    name,
    district,
    lines,
    height,
    language: input.language ?? 'other',
    isTest: Boolean(input.isTest),
    state,
    color: visual.color,
    icon: visual.icon,
    label: visual.label,
  };
}

export function initSceneFromFiles(files: TownFileInput[]): SceneState {
  const districts: Record<string, District> = {};
  const buildings: Record<string, Building> = {};

  for (const file of files) {
    const building = createBuilding(file, 'idle');
    buildings[building.id] = building;

    const distId = building.district;
    if (!districts[distId]) {
      districts[distId] = {
        id: distId,
        name: distId === '.' ? 'root' : distId,
        path: distId,
        buildingIds: [],
      };
    }
    districts[distId].buildingIds.push(building.id);
  }

  return {
    districts,
    buildings,
    activeBuildingId: undefined,
    totalBuildings: Object.keys(buildings).length,
    stats: calculateStats(buildings),
    version: 1,
  };
}

function updateBuildingState(
  state: SceneState,
  targetPath: string,
  newState: BuildingState,
  timestamp?: number,
): { updatedBuildings: Record<string, Building>; updatedDistricts: Record<string, District>; targetId?: string } {
  const norm = normalizePath(targetPath);
  let targetId: string | undefined;

  // Exact match or suffix match
  if (state.buildings[norm]) {
    targetId = norm;
  } else {
    const found = Object.keys(state.buildings).find(
      (k) => k === norm || k.endsWith('/' + norm) || norm.endsWith('/' + k),
    );
    if (found) targetId = found;
  }

  if (!targetId) {
    // If not in index yet, dynamically add it
    const newB = createBuilding({ path: norm, lines: 50 }, newState);
    newB.lastUpdated = timestamp ?? Date.now();

    const updatedDistricts = { ...state.districts };
    const distId = newB.district;
    if (!updatedDistricts[distId]) {
      updatedDistricts[distId] = {
        id: distId,
        name: distId === '.' ? 'root' : distId,
        path: distId,
        buildingIds: [],
      };
    } else {
      updatedDistricts[distId] = {
        ...updatedDistricts[distId],
        buildingIds: [...updatedDistricts[distId].buildingIds],
      };
    }
    if (!updatedDistricts[distId].buildingIds.includes(newB.id)) {
      updatedDistricts[distId].buildingIds.push(newB.id);
    }

    return {
      updatedBuildings: {
        ...state.buildings,
        [newB.id]: newB,
      },
      updatedDistricts,
      targetId: newB.id,
    };
  }

  const existing = state.buildings[targetId];
  if (!existing) {
    return {
      updatedBuildings: state.buildings,
      updatedDistricts: state.districts,
      targetId: undefined,
    };
  }
  const visual = STATE_VISUALS[newState];
  const updated: Building = {
    ...existing,
    state: newState,
    color: visual.color,
    icon: visual.icon,
    label: visual.label,
    lastUpdated: timestamp ?? Date.now(),
  };

  return {
    updatedBuildings: {
      ...state.buildings,
      [targetId]: updated,
    },
    updatedDistricts: state.districts,
    targetId,
  };
}

export function sceneReducer(state: SceneState, event: TownEvent): SceneState {
  switch (event.type) {
    case 'init': {
      const s = initSceneFromFiles(event.files);
      return {
        ...s,
        lastEvent: event,
        version: state.version + 1,
      };
    }

    case 'file_read': {
      const { updatedBuildings, updatedDistricts, targetId } = updateBuildingState(
        state,
        event.path,
        'read',
        event.timestamp,
      );
      return {
        ...state,
        buildings: updatedBuildings,
        districts: updatedDistricts,
        totalBuildings: Object.keys(updatedBuildings).length,
        activeBuildingId: targetId,
        stats: calculateStats(updatedBuildings),
        lastEvent: event,
        version: state.version + 1,
      };
    }

    case 'hunk_proposed': {
      const { updatedBuildings, updatedDistricts, targetId } = updateBuildingState(
        state,
        event.path,
        'proposed',
        event.timestamp,
      );
      return {
        ...state,
        buildings: updatedBuildings,
        districts: updatedDistricts,
        totalBuildings: Object.keys(updatedBuildings).length,
        activeBuildingId: targetId,
        stats: calculateStats(updatedBuildings),
        lastEvent: event,
        version: state.version + 1,
      };
    }

    case 'hunk_decided': {
      const newState: BuildingState = event.decision === 'accepted' ? 'applied' : 'rejected';
      const { updatedBuildings, updatedDistricts, targetId } = updateBuildingState(
        state,
        event.path,
        newState,
        event.timestamp,
      );
      return {
        ...state,
        buildings: updatedBuildings,
        districts: updatedDistricts,
        totalBuildings: Object.keys(updatedBuildings).length,
        activeBuildingId: targetId,
        stats: calculateStats(updatedBuildings),
        lastEvent: event,
        version: state.version + 1,
      };
    }

    case 'file_written': {
      const { updatedBuildings, updatedDistricts, targetId } = updateBuildingState(
        state,
        event.path,
        'applied',
        event.timestamp,
      );
      return {
        ...state,
        buildings: updatedBuildings,
        districts: updatedDistricts,
        totalBuildings: Object.keys(updatedBuildings).length,
        activeBuildingId: targetId,
        stats: calculateStats(updatedBuildings),
        lastEvent: event,
        version: state.version + 1,
      };
    }

    case 'model_failed': {
      const target = event.path || state.activeBuildingId;
      if (!target) {
        return {
          ...state,
          lastEvent: event,
          version: state.version + 1,
        };
      }
      const { updatedBuildings, updatedDistricts, targetId } = updateBuildingState(
        state,
        target,
        'failed',
        event.timestamp,
      );
      return {
        ...state,
        buildings: updatedBuildings,
        districts: updatedDistricts,
        totalBuildings: Object.keys(updatedBuildings).length,
        activeBuildingId: targetId,
        stats: calculateStats(updatedBuildings),
        lastEvent: event,
        version: state.version + 1,
      };
    }

    case 'reset': {
      const resetBuildings: Record<string, Building> = {};
      const idleVisual = STATE_VISUALS.idle;
      for (const [id, b] of Object.entries(state.buildings)) {
        resetBuildings[id] = {
          ...b,
          state: 'idle',
          color: idleVisual.color,
          icon: idleVisual.icon,
          label: idleVisual.label,
        };
      }
      return {
        ...state,
        buildings: resetBuildings,
        activeBuildingId: undefined,
        stats: calculateStats(resetBuildings),
        lastEvent: event,
        version: state.version + 1,
      };
    }

    default:
      return {
        ...state,
        lastEvent: event,
        version: state.version + 1,
      };
  }
}
