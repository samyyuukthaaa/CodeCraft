// Camera helpers for Code Town (pure vector math on Three.js types; no DOM): Find Scout (a short flight), Follow
// Scout (the camera target eases after him, keeping the viewing offset), and a Reset View framing that keeps him in
// frame. Nothing here allocates per frame except where noted.
import * as THREE from 'three';

export interface Flight {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
}

/** The camera offset used when looking at Scout up close. */
export const SCOUT_VIEW_OFFSET = new THREE.Vector3(9, 18, 26);
export const FLIGHT_S = 0.8;

/** A flight from the current camera to a close view of `focus` (allocates once per flight). */
export function flightTo(camPos: THREE.Vector3, camTarget: THREE.Vector3, focus: THREE.Vector3, start: number, duration = FLIGHT_S): Flight {
  const toTarget = focus.clone().setY(2);
  return { fromPos: camPos.clone(), toPos: toTarget.clone().add(SCOUT_VIEW_OFFSET), fromTarget: camTarget.clone(), toTarget, start, duration };
}

/** Moves the camera along a flight (ease in-out); returns true while still flying. Duration 0 = jump. */
export function flightStep(f: Flight, t: number, camPos: THREE.Vector3, camTarget: THREE.Vector3): boolean {
  const p = f.duration <= 0 ? 1 : Math.min(1, Math.max(0, (t - f.start) / f.duration));
  const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
  camPos.lerpVectors(f.fromPos, f.toPos, e);
  camTarget.lerpVectors(f.fromTarget, f.toTarget, e);
  return p < 1;
}

const tmp = new THREE.Vector3();
/** Follow: moves target and camera together towards Scout (keeps the viewing offset). `alpha` 1 = snap. */
export function followStep(camPos: THREE.Vector3, camTarget: THREE.Vector3, scout: THREE.Vector3, alpha: number): void {
  tmp.set(scout.x, 2, scout.z).sub(camTarget).multiplyScalar(alpha);
  camTarget.add(tmp);
  camPos.add(tmp);
}

/** Reset View framing: the town bounds, the power plant (east) and Scout (and the side streets he walks on). */
export function framing(bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | undefined, scout: THREE.Vector3 | undefined): { target: THREE.Vector3; pos: THREE.Vector3 } {
  let minX = bounds ? bounds.minX - 4 : -20;
  let maxX = bounds ? bounds.maxX + 18 : 20;
  let minZ = bounds ? bounds.minZ : -20;
  let maxZ = bounds ? bounds.maxZ : 20;
  if (scout) {
    minX = Math.min(minX, scout.x - 4);
    maxX = Math.max(maxX, scout.x + 4);
    minZ = Math.min(minZ, scout.z - 4);
    maxZ = Math.max(maxZ, scout.z + 4);
  }
  const span = Math.max(maxX - minX, maxZ - minZ);
  const target = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  return { target, pos: new THREE.Vector3(target.x, span * 0.58 + 8, target.z + span * 0.72 + 10) };
}
