// Pure route planning for Scout's walks (no VS Code, no Three.js, no clock, no Math.random). Scout only walks on
// streets: the band in front of each row of districts, and the corridors along the town's left and right edges, so
// he never walks through a building. The ambient patrol is COSMETIC: its stops come from a seed derived from the
// building list, it is used only by the renderer, and it never enters the scene reducer or the journal.
import type { Layout } from './layout';
import { STREET } from './layout';
import type { SceneState } from './types';

export interface Pt {
  x: number;
  z: number;
}

interface Row {
  top: number;
  bottom: number;
}

/** District rows: districts sharing a top edge (the layout's shelf packing), sorted from back to front. */
export function rowsOf(layout: Layout): Row[] {
  const rows = new Map<number, Row>();
  for (const l of Object.values(layout.districts)) {
    const top = Math.round((l.z - l.d / 2) * 1000) / 1000;
    const r = rows.get(top);
    const bottom = l.z + l.d / 2;
    if (r) r.bottom = Math.max(r.bottom, bottom);
    else rows.set(top, { top, bottom });
  }
  return [...rows.values()].sort((a, b) => a.top - b.top);
}

/** The street in front of (towards the viewer of) the row containing z. */
function streetZ(layout: Layout, z: number): number {
  const rows = rowsOf(layout);
  const row = rows.find((r) => z >= r.top - 0.01 && z <= r.bottom + 0.01) ?? rows[rows.length - 1];
  return row ? row.bottom + STREET / 2 : z;
}

/** Where Scout stands to look at a building: on the street in front of its row, at the building's x. */
export function frontOf(layout: Layout, buildingId: string): Pt | undefined {
  const b = layout.buildings[buildingId];
  return b ? { x: b.x, z: streetZ(layout, b.z) } : undefined;
}

/** The plaza: on the street in front of the district nearest the middle of the town (near the default view). */
export function plaza(layout: Layout): Pt {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  let best: { x: number; z: number; d: number } | undefined;
  for (const l of Object.values(layout.districts)) {
    const d = Math.hypot(l.x - cx, l.z - cz);
    if (!best || d < best.d) best = { x: l.x, z: l.z, d };
  }
  return best ? { x: best.x, z: streetZ(layout, best.z) } : { x: cx, z: maxZ + STREET / 2 };
}

/** Beside the power plant (east of the town). */
export function plantStop(layout: Layout): Pt {
  return { x: layout.power.x - 6, z: layout.power.z + 3 };
}

/**
 * Street route between two street points: along the same street if they share one, otherwise out to the nearer
 * side corridor (outside every district), along it, and back in. Returns the waypoints after `from`.
 */
export function route(layout: Layout, from: Pt, to: Pt): Pt[] {
  if (Math.abs(from.z - to.z) < 1e-6) return [to];
  const { minX, maxX } = layout.bounds;
  const left = minX - STREET / 2;
  const right = maxX + STREET / 2;
  const x = Math.abs(from.x - left) + Math.abs(to.x - left) <= Math.abs(from.x - right) + Math.abs(to.x - right) ? left : right;
  return [{ x, z: from.z }, { x, z: to.z }, to];
}

/** A small seeded generator (Park-Miller), so the same town always gives the same patrol. */
function seeded(seed: number): () => number {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Stable seed from the building list. */
export function seedOf(ids: readonly string[]): number {
  let h = 2166136261;
  for (const id of ids) for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return h || 1;
}

/** Patrol stops: `n` distinct indexed buildings in a seeded order (placeholders are skipped). */
export function patrolStops(scene: SceneState, n = 12): string[] {
  const ids = Object.keys(scene.buildings)
    .filter((id) => !scene.buildings[id]!.placeholder)
    .sort();
  const rnd = seeded(seedOf(ids));
  const pool = [...ids];
  const out: string[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]!);
  return out;
}

/** True if an axis-aligned segment crosses the inside of any district (used by tests and as a safety check). */
export function crossesDistrict(layout: Layout, a: Pt, b: Pt): boolean {
  for (const l of Object.values(layout.districts)) {
    const x0 = l.x - l.w / 2 + 0.01;
    const x1 = l.x + l.w / 2 - 0.01;
    const z0 = l.z - l.d / 2 + 0.01;
    const z1 = l.z + l.d / 2 - 0.01;
    const sx0 = Math.min(a.x, b.x);
    const sx1 = Math.max(a.x, b.x);
    const sz0 = Math.min(a.z, b.z);
    const sz1 = Math.max(a.z, b.z);
    if (sx1 > x0 && sx0 < x1 && sz1 > z0 && sz0 < z1) return true;
  }
  return false;
}
