// Pure: what changed between two scenes, so the renderer updates only that (never rebuilds the whole town on
// an event). No VS Code, no Three.js.
import type { SceneState } from './types';

export interface SceneDiff {
  /** The town was (re)initialised from the index: the renderer rebuilds once. */
  rebuild: boolean;
  added: string[];
  removed: string[];
  /** Buildings whose state, test status, height or kind changed. */
  changed: string[];
  activeChanged: boolean;
  powerChanged: boolean;
  /** Districts that appeared (new folders during the run). */
  addedDistricts: string[];
}

export function diffScenes(prev: SceneState | undefined, next: SceneState): SceneDiff {
  if (!prev || next.lastEvent?.type === 'init' || prev.roads !== next.roads) {
    return { rebuild: true, added: Object.keys(next.buildings), removed: [], changed: [], activeChanged: true, powerChanged: true, addedDistricts: Object.keys(next.districts) };
  }
  const added: string[] = [];
  const changed: string[] = [];
  for (const [id, b] of Object.entries(next.buildings)) {
    const old = prev.buildings[id];
    if (!old) added.push(id);
    else if (old !== b && (old.state !== b.state || old.testStatus !== b.testStatus || old.height !== b.height || old.kind !== b.kind)) changed.push(id);
  }
  const removed = Object.keys(prev.buildings).filter((id) => !next.buildings[id]);
  const addedDistricts = Object.keys(next.districts).filter((id) => !prev.districts[id]);
  const p = prev.power;
  const n = next.power;
  return {
    rebuild: false,
    added,
    removed,
    changed,
    activeChanged: prev.activeBuildingId !== next.activeBuildingId,
    powerChanged: p.status !== n.status || p.model !== n.model,
    addedDistricts,
  };
}
