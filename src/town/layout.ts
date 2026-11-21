// Pure, deterministic town layout (no VS Code, no Three.js). Stable on purpose: given the previous layout, every
// existing building and district keeps its place; a new file takes a spare slot in its district (each district
// reserves some), and a new district goes to an outskirts row. So an event never moves the rest of the town.
import type { SceneState } from './types';

export const CELL = 3.2; // distance between building centres
export const FOOTPRINT = 2.2; // building width and depth
export const PAD = 1.4; // district border
export const STREET = 4; // gap between districts

export interface DistrictLot {
  x: number; // centre
  z: number;
  w: number;
  d: number;
  cols: number;
  rows: number;
}

export interface BuildingLot {
  x: number;
  z: number;
  slot: number;
}

export interface RoadPath {
  id: string;
  weight: number;
  /** Manhattan path between district centres: [x, z] corners. */
  points: Array<[number, number]>;
}

export interface Layout {
  districts: Record<string, DistrictLot>;
  buildings: Record<string, BuildingLot>;
  power: { x: number; z: number };
  roads: RoadPath[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Next outskirts position for districts that appear after the first layout. */
  outskirts: { x: number; z: number };
}

/** Slots a district reserves: room for about 25% more files before its grid would have to grow. */
export function capacityFor(n: number): number {
  return Math.max(4, Math.ceil(n * 1.25) + 2);
}

function districtSize(n: number): { cols: number; rows: number; w: number; d: number } {
  const cap = capacityFor(n);
  const cols = Math.ceil(Math.sqrt(cap));
  const rows = Math.ceil(cap / cols);
  return { cols, rows, w: cols * CELL + 2 * PAD, d: rows * CELL + 2 * PAD };
}

function slotPosition(lot: DistrictLot, slot: number): { x: number; z: number } {
  const col = slot % lot.cols;
  const row = Math.floor(slot / lot.cols);
  return { x: lot.x - lot.w / 2 + PAD + CELL / 2 + col * CELL, z: lot.z - lot.d / 2 + PAD + CELL / 2 + row * CELL };
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function layoutScene(scene: SceneState, prev?: Layout): Layout {
  const districts: Record<string, DistrictLot> = Object.fromEntries(Object.entries(prev?.districts ?? {}).map(([k, l]) => [k, { ...l }]));
  const buildings: Record<string, BuildingLot> = {};
  const ids = Object.keys(scene.districts).sort(byId);
  let outskirts = prev?.outskirts;

  if (!prev) {
    // Shelf packing in id order, rows about as wide as the town is deep.
    const sizes = ids.map((id) => ({ id, ...districtSize(scene.districts[id]!.buildingIds.length) }));
    const area = sizes.reduce((s, x) => s + (x.w + STREET) * (x.d + STREET), 0);
    const rowWidth = Math.max(40, Math.sqrt(area) * 1.2);
    let x = 0;
    let z = 0;
    let rowDepth = 0;
    for (const s of sizes) {
      if (x > 0 && x + s.w > rowWidth) {
        x = 0;
        z += rowDepth + STREET;
        rowDepth = 0;
      }
      districts[s.id] = { x: x + s.w / 2, z: z + s.d / 2, w: s.w, d: s.d, cols: s.cols, rows: s.rows };
      x += s.w + STREET;
      rowDepth = Math.max(rowDepth, s.d);
    }
    // centre the town on the origin
    const xs = Object.values(districts);
    const cx = xs.length ? (Math.min(...xs.map((l) => l.x - l.w / 2)) + Math.max(...xs.map((l) => l.x + l.w / 2))) / 2 : 0;
    const cz = xs.length ? (Math.min(...xs.map((l) => l.z - l.d / 2)) + Math.max(...xs.map((l) => l.z + l.d / 2))) / 2 : 0;
    for (const l of xs) {
      l.x -= cx;
      l.z -= cz;
    }
    const maxZ = xs.length ? Math.max(...xs.map((l) => l.z + l.d / 2)) : 0;
    const minX = xs.length ? Math.min(...xs.map((l) => l.x - l.w / 2)) : 0;
    outskirts = { x: minX, z: maxZ + STREET * 2 };
  }

  // Districts that appeared later: in the outskirts row, left to right.
  for (const id of ids) {
    if (districts[id]) continue;
    const s = districtSize(scene.districts[id]!.buildingIds.length);
    const o = outskirts ?? { x: 0, z: 0 };
    districts[id] = { x: o.x + s.w / 2, z: o.z + s.d / 2, w: s.w, d: s.d, cols: s.cols, rows: s.rows };
    outskirts = { x: o.x + s.w + STREET, z: o.z };
  }
  for (const id of Object.keys(districts)) if (!scene.districts[id]) delete districts[id];

  // Buildings: keep previous slots; new ones take the first free slot of their district (grow the grid if full).
  for (const id of ids) {
    const lot = districts[id]!;
    const members = [...scene.districts[id]!.buildingIds].sort(byId);
    const used = new Set<number>();
    const pending: string[] = [];
    for (const b of members) {
      const old = prev?.buildings[b];
      if (old && old.slot < lot.cols * lot.rows) {
        buildings[b] = old;
        used.add(old.slot);
      } else pending.push(b);
    }
    let next = 0;
    for (const b of pending) {
      while (used.has(next)) next++;
      if (next >= lot.cols * lot.rows) {
        // full (rare: more than ~25% new files in one district): add a row at the back, nothing else moves
        lot.rows += 1;
        lot.d += CELL;
        lot.z += CELL / 2;
      }
      used.add(next);
      buildings[b] = { ...slotPosition(lot, next), slot: next };
    }
  }

  const all = Object.values(districts);
  const bounds = all.length
    ? { minX: Math.min(...all.map((l) => l.x - l.w / 2)), maxX: Math.max(...all.map((l) => l.x + l.w / 2)), minZ: Math.min(...all.map((l) => l.z - l.d / 2)), maxZ: Math.max(...all.map((l) => l.z + l.d / 2)) }
    : { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
  const power = prev?.power ?? { x: bounds.maxX + 10, z: (bounds.minZ + bounds.maxZ) / 2 };
  const roads: RoadPath[] = scene.roads
    .filter((r) => districts[r.from] && districts[r.to])
    .map((r) => {
      const a = districts[r.from]!;
      const b = districts[r.to]!;
      return { id: r.id, weight: r.weight, points: [[a.x, a.z], [b.x, a.z], [b.x, b.z]] as Array<[number, number]> };
    });
  return { districts, buildings, power, roads, bounds, outskirts: outskirts ?? { x: 0, z: 0 } };
}
