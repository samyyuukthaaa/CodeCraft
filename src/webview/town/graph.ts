// The Code Town scene graph (Three.js), separate from the WebGL renderer so it can be unit-tested in Node.
// - Incremental: sync() diffs the previous and next scene; only an `init` (new index) rebuilds. An event touches
//   only the instances it changes.
// - Instanced: all buildings are ONE InstancedMesh (plus one for roof beacons, one for district slabs).
// - Owned resources: every geometry, material and texture created here is tracked and disposed on removal or
//   dispose(); nothing leaks across rebuilds.
// Look: original low-poly night town: rounded blocks with warm windows, porch lights, light shafts, string
// lights along the roads, bold white captions with one yellow keyword. No third-party game names or assets.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { diffScenes } from '../../town/diff';
import { KIND_VISUALS, LANTERN_COLORS, POWER_VISUALS, REPLAY_RAINBOW, districtColors } from '../../town/grammar';
import { FOOTPRINT, Layout, layoutScene } from '../../town/layout';
import type { Building, SceneState } from '../../town/types';
import { ViewMode, journeyStops } from '../../town/view';
import type { ScoutPlace } from '../../town/scout';
import { ScoutFigure } from './scout3d';

export interface CaptionPart {
  text: string;
  /** The one highlighted keyword (yellow). */
  yellow?: boolean;
}

/** Texture sources (canvas in the webview; plain textures in tests). */
export interface TextureFactory {
  caption(parts: CaptionPart[]): { texture: THREE.Texture; aspect: number };
  windows(): THREE.Texture | undefined;
}

const NAVY = new THREE.Color('#0b1430');
const WARM = new THREE.Color('#ffc46b');
const SHAFT = new THREE.Color('#fde68a');
const MIN_CAPACITY = 64;

const VERB: Partial<Record<string, string>> = {
  file_planned: 'Planning',
  file_read: 'Reading',
  hunk_proposed: 'Proposing',
  hunk_decided: 'Reviewed',
  file_written: 'Changed',
  file_reverted: 'Reverted',
  file_failed: 'Failing',
  test_run: 'Tested',
};

/** Chunky low-poly blocks: 1 to about 7 units tall for 1 to 20 height steps (footprint 2.2). */
export const buildingHeight = (b: Building): number => 0.9 + b.height * 0.32;

/** Body colour: idle buildings are a dark tint of their kind; any other state shows its state colour. */
export function bodyColor(b: Building, mode: ViewMode = 'journey'): THREE.Color {
  if (mode === 'architecture') return new THREE.Color(KIND_VISUALS[b.kind].color).lerp(NAVY, 0.3);
  // idle: the district's warm wall colour, a little dimmed so touched buildings (state colours) stand out
  return b.state === 'idle' ? new THREE.Color(districtColors(b.district).wall).lerp(NAVY, 0.38) : new THREE.Color(b.color);
}

/** Roof colour: the district's rooftop colour (kind colour in Architecture mode). */
export function roofColor(b: Building, mode: ViewMode = 'journey'): THREE.Color {
  return mode === 'architecture' ? new THREE.Color(KIND_VISUALS[b.kind].color).lerp(NAVY, 0.55) : new THREE.Color(districtColors(b.district).roof);
}

/** Buildings that earn festival lanterns: an applied change, or a test that passes again. */
export const celebrates = (b: Building): boolean => b.state === 'applied' || b.state === 'recovered';
const LANTERNS_PER_BUILDING = 3;

export interface GraphStats {
  rebuilds: number;
  buildingRebuilds: number;
  incremental: number;
  instances: number;
  capacity: number;
  owned: number;
}

export class TownGraph {
  readonly root = new THREE.Group();
  private scene: SceneState | undefined;
  private layout: Layout | undefined;
  private readonly owned = new Set<{ dispose(): void }>();
  private readonly perBuild = new Set<{ dispose(): void }>();

  // shared, created once
  private readonly boxGeo = this.own(new RoundedBoxGeometry(FOOTPRINT, 1, FOOTPRINT, 2, 0.22).translate(0, 0.5, 0));
  private readonly beaconGeo = this.own(new THREE.OctahedronGeometry(0.42, 0));
  private readonly roofGeo = this.own(new RoundedBoxGeometry(FOOTPRINT + 0.25, 0.3, FOOTPRINT + 0.25, 2, 0.1));
  private readonly lanternGeo = this.own(new THREE.SphereGeometry(0.34, 10, 8));
  private readonly roofMat = this.own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }));
  private readonly lanternMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  private readonly slabGeo = this.own(new RoundedBoxGeometry(1, 0.3, 1, 2, 0.12).translate(0, -0.15, 0));
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly beaconMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  private readonly slabMat = this.own(new THREE.MeshStandardMaterial({ color: '#141e3a', roughness: 0.95 }));

  // per build
  private buildings: THREE.InstancedMesh | undefined;
  private beacons: THREE.InstancedMesh | undefined;
  private roofs: THREE.InstancedMesh | undefined;
  private lanterns: THREE.InstancedMesh | undefined;
  private replay = false;
  private porch: THREE.Points | undefined;
  private stringLights: THREE.Points | undefined;
  private readonly idByIndex: string[] = [];
  private readonly indexById = new Map<string, number>();
  private readonly captions = new Map<string, THREE.Sprite>();
  private shaft: THREE.Mesh | undefined;
  private activeCaption: THREE.Sprite | undefined;
  private powerGlow: THREE.Mesh | undefined;
  private powerCaption: THREE.Sprite | undefined;
  private roads: THREE.LineSegments | undefined;
  private journeyLine: THREE.Line | undefined;
  private readonly stopLabels = new Map<string, THREE.Sprite>();
  private selectRing: THREE.Mesh | undefined;
  private selected: string | undefined;
  private mode: ViewMode = 'journey';
  // Scout: created once, survives rebuilds
  private readonly scout: ScoutFigure;
  private scoutBubble: THREE.Sprite | undefined;
  private scoutMove = -1;
  private scoutVisible = true;

  private readonly counters = { rebuilds: 0, buildingRebuilds: 0, incremental: 0 };
  private readonly tmp = new THREE.Matrix4();

  constructor(
    private readonly textures: TextureFactory,
    private reducedMotion = false,
  ) {
    const windows = textures.windows();
    this.scout = new ScoutFigure((x) => this.own(x));
    this.scout.root.scale.setScalar(2.2); // about as tall as a small building
    this.bodyMat = this.own(
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, ...(windows ? { emissiveMap: this.own(windows), emissive: WARM, emissiveIntensity: 0.9 } : {}) }),
    );
  }

  private own<T extends { dispose(): void }>(x: T): T {
    this.owned.add(x);
    return x;
  }

  /** Created for the current build: disposed when the town is rebuilt or the graph disposed. */
  private build<T extends { dispose(): void }>(x: T): T {
    this.perBuild.add(x);
    this.owned.add(x);
    return x;
  }

  private release(x: { dispose(): void } | undefined): void {
    if (!x) return;
    x.dispose();
    this.perBuild.delete(x);
    this.owned.delete(x);
  }

  get viewMode(): ViewMode {
    return this.mode;
  }

  /** Switches between Agent Journey and Architecture over the same scene (recolours once: a user action). */
  setMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    const s = this.scene;
    if (!s) return;
    for (const [id, i] of this.indexById) this.placeBuilding(s.buildings[id]!, i);
    this.flush();
    this.applyModeVisibility();
  }

  /** Replay accent on or off (the path turns rainbow while a finished run is replayed). */
  setReplay(on: boolean): void {
    if (on === this.replay) return;
    this.replay = on;
    if (this.scene) this.updateJourney(this.scene);
  }

  get replaying(): boolean {
    return this.replay;
  }

  /** Highlights the inspected building (or none). */
  select(id: string | undefined): void {
    this.selected = id;
    const lot = id ? this.layout?.buildings[id] : undefined;
    if (!this.selectRing) return;
    this.selectRing.visible = Boolean(lot);
    if (lot) this.selectRing.position.set(lot.x, 0.06, lot.z);
  }

  private applyModeVisibility(): void {
    const journey = this.mode === 'journey';
    if (this.roads) {
      const m = this.roads.material as THREE.LineBasicMaterial;
      m.opacity = journey ? 0.35 : 1;
      m.color.set(journey ? '#2b4a7a' : '#7aa2e3');
    }
    if (this.journeyLine) this.journeyLine.visible = journey;
    for (const sp of this.stopLabels.values()) sp.visible = journey;
    if (this.beacons) this.beacons.visible = journey;
    if (this.shaft) this.shaft.visible = journey && Boolean(this.scene?.activeBuildingId && this.layout?.buildings[this.scene.activeBuildingId]);
    // Scout's bubble says the same thing next to it; the caption comes back when Scout is muted
    if (this.activeCaption) this.activeCaption.visible = journey && !this.scoutVisible;
  }

  /** The agent's path through the town: a yellow line over the building tops, with numbered stops (first 40). */
  private updateJourney(s: SceneState): void {
    if (this.journeyLine) {
      this.root.remove(this.journeyLine);
      this.release(this.journeyLine.geometry);
      this.release(this.journeyLine.material as THREE.Material);
      this.journeyLine = undefined;
    }
    const stops = journeyStops(s);
    if (stops.length < this.stopLabels.size || [...this.stopLabels.keys()].some((p, i) => stops[i]?.path !== p)) {
      for (const sp of this.stopLabels.values()) this.dropSprite(sp);
      this.stopLabels.clear();
    }
    const pts: number[] = [];
    for (const step of s.journey) {
      const lot = this.layout?.buildings[step.path];
      const b = s.buildings[step.path];
      if (lot && b) pts.push(lot.x, buildingHeight(b) + 1.2, lot.z);
    }
    if (pts.length >= 6) {
      const g = this.build(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      if (this.replay) {
        // rainbow accent while replaying a finished run
        const cols: number[] = [];
        const n = pts.length / 3;
        for (let k = 0; k < n; k++) {
          const c = new THREE.Color(REPLAY_RAINBOW[Math.floor((k / Math.max(1, n - 1)) * (REPLAY_RAINBOW.length - 1))]!);
          cols.push(c.r, c.g, c.b);
        }
        g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      }
      this.journeyLine = new THREE.Line(g, this.build(new THREE.LineBasicMaterial(this.replay ? { vertexColors: true, transparent: true, opacity: 0.95 } : { color: '#facc15', transparent: true, opacity: 0.95 })));
      this.journeyLine.name = 'journey';
      this.root.add(this.journeyLine);
    }
    for (const st of stops.slice(0, 40)) {
      if (this.stopLabels.has(st.path)) continue;
      const lot = this.layout?.buildings[st.path];
      const b = s.buildings[st.path];
      if (!lot || !b) continue;
      const sp = this.sprite([{ text: String(st.n), yellow: true }], 1.7);
      sp.position.set(lot.x + 1.3, buildingHeight(b) + 1.6, lot.z);
      sp.name = `stop:${st.n}`;
      this.stopLabels.set(st.path, sp);
      this.root.add(sp);
    }
    this.applyModeVisibility();
  }

  stats(): GraphStats {
    return { ...this.counters, instances: this.indexById.size, capacity: this.buildings?.count ?? 0, owned: this.owned.size };
  }

  /** Building id under the ray, if any. */
  pick(raycaster: THREE.Raycaster): string | undefined {
    if (!this.buildings) return undefined;
    const hit = raycaster.intersectObject(this.buildings, false)[0];
    return hit?.instanceId !== undefined ? this.idByIndex[hit.instanceId] : undefined;
  }

  /** World position of a building (camera focus). */
  positionOf(id: string): THREE.Vector3 | undefined {
    const lot = this.layout?.buildings[id];
    return lot ? new THREE.Vector3(lot.x, 0, lot.z) : undefined;
  }

  get bounds(): Layout['bounds'] | undefined {
    return this.layout?.bounds;
  }

  /** A whole new scene from the host (panel opened or reloaded): build once from it. */
  rebuild(next: SceneState): void {
    this.rebuildAll(next);
    this.scene = next;
  }

  sync(next: SceneState): void {
    const d = diffScenes(this.scene, next);
    if (d.rebuild) {
      this.rebuildAll(next);
      this.scene = next;
      return;
    }
    this.counters.incremental++;
    this.layout = layoutScene(next, this.layout);
    for (const id of d.addedDistricts) this.addDistrict(next, id);
    if (d.added.length && this.indexById.size + d.added.length > (this.buildings?.count ?? 0)) {
      this.rebuildBuildings(next); // capacity exceeded (rare): buildings only
    } else {
      for (const id of d.added) this.placeBuilding(next.buildings[id]!, this.allocate(id));
      for (const id of d.changed) {
        const i = this.indexById.get(id);
        if (i !== undefined) this.placeBuilding(next.buildings[id]!, i);
      }
      this.flush();
    }
    if (d.activeChanged || d.changed.includes(next.activeBuildingId ?? '') || d.added.includes(next.activeBuildingId ?? '')) this.updateActive(next);
    if (d.powerChanged) this.updatePower(next);
    // the path line is small (at most MAX_JOURNEY points): replaced (old one disposed) when the journey changes
    if (this.scene?.journey !== next.journey) this.updateJourney(next);
    this.updateScout(next);
    this.scene = next;
  }

  // ---------- full build (init only) ----------
  private rebuildAll(s: SceneState): void {
    this.counters.rebuilds++;
    for (const x of [...this.perBuild]) this.release(x);
    this.root.clear();
    this.captions.clear();
    this.stopLabels.clear();
    this.journeyLine = undefined;
    this.layout = layoutScene(s);
    const L = this.layout;

    // district slabs: one instanced mesh; captions: bold white with the folder name in yellow
    const ids = Object.keys(L.districts);
    const slabs = this.build(new THREE.InstancedMesh(this.slabGeo, this.slabMat, Math.max(8, ids.length + 16)));
    slabs.count = 0;
    slabs.name = 'district-slabs';
    this.root.add(slabs);
    for (const id of ids) this.addDistrict(s, id, slabs);

    // roads (one line set) with string lights along them
    const roadPts: number[] = [];
    const bulbs: number[] = [];
    for (const r of L.roads) {
      for (let k = 0; k + 1 < r.points.length; k++) {
        const [ax, az] = r.points[k]!;
        const [bx, bz] = r.points[k + 1]!;
        roadPts.push(ax, 0.04, az, bx, 0.04, bz);
        const len = Math.hypot(bx - ax, bz - az);
        for (let t = 1.5; t < len; t += 2.5) bulbs.push(ax + ((bx - ax) * t) / len, 1.1, az + ((bz - az) * t) / len);
      }
    }
    const roadGeo = this.build(new THREE.BufferGeometry());
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPts, 3));
    const roads = new THREE.LineSegments(roadGeo, this.build(new THREE.LineBasicMaterial({ color: '#2b4a7a', transparent: true, opacity: 0.85 })));
    roads.name = 'roads';
    this.roads = roads;
    this.root.add(roads);
    const bulbGeo = this.build(new THREE.BufferGeometry());
    bulbGeo.setAttribute('position', new THREE.Float32BufferAttribute(bulbs, 3));
    const bulbColors: number[] = [];
    for (let k = 0; k < bulbs.length / 3; k++) {
      const c = new THREE.Color(LANTERN_COLORS[k % LANTERN_COLORS.length]!).lerp(new THREE.Color('#fff3c4'), 0.25);
      bulbColors.push(c.r, c.g, c.b);
    }
    bulbGeo.setAttribute('color', new THREE.Float32BufferAttribute(bulbColors, 3));
    this.stringLights = new THREE.Points(bulbGeo, this.build(new THREE.PointsMaterial({ vertexColors: true, size: 0.38, transparent: true, opacity: 0.85, depthWrite: false })));
    this.stringLights.name = 'string-lights';
    this.root.add(this.stringLights);

    this.rebuildBuildings(s, false);

    // power plant at the edge of town
    const plant = new THREE.Group();
    plant.name = 'power-plant';
    plant.position.set(L.power.x, 0, L.power.z);
    plant.scale.setScalar(1.6);
    const base = new THREE.Mesh(this.build(new RoundedBoxGeometry(5, 3, 5, 2, 0.4).translate(0, 1.5, 0)), this.build(new THREE.MeshStandardMaterial({ color: '#334155', roughness: 0.8 })));
    const chimney = new THREE.Mesh(this.build(new THREE.CylinderGeometry(0.5, 0.75, 5, 8).translate(1.2, 5, 1.2)), this.build(new THREE.MeshStandardMaterial({ color: '#475569', roughness: 0.9 })));
    this.powerGlow = new THREE.Mesh(this.build(new THREE.IcosahedronGeometry(1, 0)), this.build(new THREE.MeshBasicMaterial({ color: 0xffffff })));
    this.powerGlow.position.set(-0.8, 4, -0.8);
    plant.add(base, chimney, this.powerGlow);
    this.root.add(plant);
    this.updatePower(s);

    // light shaft over the building the agent is working on
    this.shaft = new THREE.Mesh(
      this.build(new THREE.ConeGeometry(1.7, 16, 16, 1, true).translate(0, -8, 0)),
      this.build(new THREE.MeshBasicMaterial({ color: SHAFT, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })),
    );
    this.shaft.name = 'light-shaft';
    this.root.add(this.shaft);
    this.updateActive(s);

    // selection ring for the inspector
    this.selectRing = new THREE.Mesh(
      this.build(new THREE.RingGeometry(1.9, 2.3, 24).rotateX(-Math.PI / 2)),
      this.build(new THREE.MeshBasicMaterial({ color: '#facc15', transparent: true, opacity: 0.9, side: THREE.DoubleSide })),
    );
    this.selectRing.name = 'selection';
    this.root.add(this.selectRing);
    this.select(this.selected && s.buildings[this.selected] ? this.selected : undefined);
    this.updateJourney(s);
    this.root.add(this.scout.root);
    this.scoutMove = -1;
    this.updateScout(s, true);
  }

  /** Where Scout stands for a place: on the building's roof (visible from any angle), beside the power plant, or at
   * the town gate. */
  scoutPosition(place: ScoutPlace, s: SceneState | undefined = this.scene): THREE.Vector3 {
    const L = this.layout;
    if (place.kind === 'building') {
      const lot = L?.buildings[place.id];
      const b = s?.buildings[place.id];
      if (lot) return new THREE.Vector3(lot.x, b ? buildingHeight(b) : 0, lot.z);
    }
    if (place.kind === 'plant' && L) return new THREE.Vector3(L.power.x - 6, 0, L.power.z + 3);
    const b = L?.bounds ?? { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    return new THREE.Vector3((b.minX + b.maxX) / 2, 0, b.maxZ + 3);
  }

  /** Follows the scene's Scout: a new move starts a walk (or a fade with reduced motion) and a new bubble. */
  private updateScout(s: SceneState, first = false): void {
    const sc = s.scout;
    if (sc.move === this.scoutMove) return;
    this.scoutMove = sc.move;
    this.scout.moveTo(this.scoutPosition(sc.at, s), sc.mood, this.reducedMotion, first);
    if (this.scoutBubble) {
      this.scout.root.remove(this.scoutBubble);
      this.dropSprite(this.scoutBubble);
    }
    // the building name (if any) is the one yellow keyword
    const key = sc.at.kind === 'building' ? (s.buildings[sc.at.id]?.name ?? '') : '';
    const i = key ? sc.bubble.indexOf(key) : -1;
    const parts: CaptionPart[] = i >= 0 ? [{ text: sc.bubble.slice(0, i) }, { text: key, yellow: true }, { text: sc.bubble.slice(i + key.length) }].filter((p) => p.text) : [{ text: sc.bubble }];
    this.scoutBubble = this.sprite(parts, 0.55, 9);
    this.root.remove(this.scoutBubble);
    this.scoutBubble.name = 'scout-bubble';
    this.scoutBubble.position.set(0, 1.85, 0);
    this.scout.root.add(this.scoutBubble);
    this.scout.root.visible = this.scoutVisible;
  }

  /** Mute: hides Scout and its bubble (the scene state still tracks it). */
  setScoutVisible(v: boolean): void {
    this.scoutVisible = v;
    this.scout.root.visible = v;
    this.applyModeVisibility();
  }

  /** True while something is moving (Scout walking or fading): reduced-motion rendering still draws these frames. */
  get animating(): boolean {
    return this.scout.animating;
  }

  /** Finishes Scout's current move at once (replay jumps). */
  settleScout(): void {
    this.scout.settle();
  }

  private addDistrict(s: SceneState, id: string, slabsIn?: THREE.InstancedMesh): void {
    const lot = this.layout!.districts[id];
    if (!lot) return;
    const slabs = slabsIn ?? (this.root.getObjectByName('district-slabs') as THREE.InstancedMesh | undefined);
    if (slabs && slabs.count < slabs.instanceMatrix.count) {
      this.tmp.compose(new THREE.Vector3(lot.x, 0, lot.z), new THREE.Quaternion(), new THREE.Vector3(lot.w, 1, lot.d));
      slabs.setMatrixAt(slabs.count, this.tmp);
      slabs.count += 1;
      slabs.instanceMatrix.needsUpdate = true;
    }
    // short caption: parent folder in white, the district's own folder name as the one yellow keyword
    const segs = id === '.' ? ['(root)'] : id.split('/');
    const last = segs.pop()!;
    const parent = segs.pop();
    const parts: CaptionPart[] = [...(parent ? [{ text: `${parent.length > 14 ? `${parent.slice(0, 13)}…` : parent}/` }] : []), { text: last.length > 18 ? `${last.slice(0, 17)}…` : last, yellow: true }];
    if (s.districts[id]?.aggregated) parts.push({ text: ' +' });
    const cap = this.sprite(parts, 1.2, lot.w * 0.95);
    cap.position.set(lot.x, 0.9, lot.z - lot.d / 2 - 0.6);
    cap.name = `caption:${id}`;
    this.captions.set(id, cap);
    this.root.add(cap);
  }

  /** A caption sprite, scaled down if needed so it is never wider than `maxWidth` (no overlapping captions). */
  private sprite(parts: CaptionPart[], height: number, maxWidth = Infinity): THREE.Sprite {
    const { texture, aspect } = this.textures.caption(parts);
    this.build(texture);
    const sp = new THREE.Sprite(this.build(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })));
    const h = Math.min(height, maxWidth / aspect);
    sp.scale.set(h * aspect, h, 1);
    return sp;
  }

  private dropSprite(sp: THREE.Sprite | undefined): void {
    if (!sp) return;
    this.root.remove(sp);
    this.release(sp.material.map ?? undefined);
    this.release(sp.material);
  }

  // ---------- buildings (instanced) ----------
  private rebuildBuildings(s: SceneState, counted = true): void {
    if (counted) this.counters.buildingRebuilds++;
    for (const obj of [this.buildings, this.beacons, this.roofs, this.lanterns]) {
      if (!obj) continue;
      this.root.remove(obj);
      this.release(obj);
    }
    if (this.porch) {
      this.root.remove(this.porch);
      this.release(this.porch.geometry);
      this.release(this.porch.material as THREE.Material);
    }
    this.idByIndex.length = 0;
    this.indexById.clear();
    const ids = Object.keys(s.buildings).sort();
    const capacity = Math.max(MIN_CAPACITY, Math.ceil(ids.length * 1.25) + 16);
    this.buildings = this.build(new THREE.InstancedMesh(this.boxGeo, this.bodyMat, capacity));
    this.buildings.name = 'buildings';
    this.beacons = this.build(new THREE.InstancedMesh(this.beaconGeo, this.beaconMat, capacity));
    this.beacons.name = 'beacons';
    this.roofs = this.build(new THREE.InstancedMesh(this.roofGeo, this.roofMat, capacity));
    this.roofs.name = 'roofs';
    this.lanterns = this.build(new THREE.InstancedMesh(this.lanternGeo, this.lanternMat, capacity * LANTERNS_PER_BUILDING));
    this.lanterns.name = 'lanterns';
    const porchGeo = this.build(new THREE.BufferGeometry());
    porchGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(capacity * 3), 3));
    porchGeo.setDrawRange(0, 0);
    this.porch = new THREE.Points(porchGeo, this.build(new THREE.PointsMaterial({ color: WARM, size: 0.45, transparent: true, opacity: 0.85, depthWrite: false })));
    this.porch.name = 'porch-lights';
    // hide unused instances
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) {
      this.buildings.setMatrixAt(i, zero);
      this.beacons.setMatrixAt(i, zero);
      this.buildings.setColorAt(i, NAVY);
      this.beacons.setColorAt(i, NAVY);
      this.roofs.setMatrixAt(i, zero);
      this.roofs.setColorAt(i, NAVY);
      for (let k = 0; k < LANTERNS_PER_BUILDING; k++) {
        this.lanterns.setMatrixAt(i * LANTERNS_PER_BUILDING + k, zero);
        this.lanterns.setColorAt(i * LANTERNS_PER_BUILDING + k, new THREE.Color(LANTERN_COLORS[k % LANTERN_COLORS.length]!));
      }
    }
    for (const id of ids) this.placeBuilding(s.buildings[id]!, this.allocate(id));
    this.flush();
    this.root.add(this.buildings, this.beacons, this.roofs, this.lanterns, this.porch);
  }

  private allocate(id: string): number {
    const i = this.idByIndex.length;
    this.idByIndex.push(id);
    this.indexById.set(id, i);
    return i;
  }

  private placeBuilding(b: Building, i: number): void {
    const lot = this.layout?.buildings[b.id];
    if (!lot || !this.buildings || !this.beacons || !this.porch) return;
    const h = buildingHeight(b);
    const footprint = b.placeholder ? 0.6 : 1;
    this.tmp.compose(new THREE.Vector3(lot.x, 0, lot.z), new THREE.Quaternion(), new THREE.Vector3(footprint, h, footprint));
    this.buildings.setMatrixAt(i, this.tmp);
    this.buildings.setColorAt(i, bodyColor(b, this.mode));
    const showBeacon = b.state !== 'idle';
    this.tmp.compose(new THREE.Vector3(lot.x, h + 0.7, lot.z), new THREE.Quaternion(), new THREE.Vector3().setScalar(showBeacon ? 1 : 0));
    this.beacons.setMatrixAt(i, this.tmp);
    this.beacons.setColorAt(i, new THREE.Color(b.color));
    if (this.roofs) {
      this.tmp.compose(new THREE.Vector3(lot.x, h + 0.05, lot.z), new THREE.Quaternion(), new THREE.Vector3(footprint, 1, footprint));
      this.roofs.setMatrixAt(i, this.tmp);
      this.roofs.setColorAt(i, roofColor(b, this.mode));
    }
    if (this.lanterns) {
      // festival lanterns over a success: fixed spots around the roof (no randomness)
      const on = celebrates(b) && this.mode === 'journey';
      for (let k = 0; k < LANTERNS_PER_BUILDING; k++) {
        const a = (k / LANTERNS_PER_BUILDING) * Math.PI * 2 + 0.6;
        this.tmp.compose(new THREE.Vector3(lot.x + Math.cos(a) * 1.6, h + 1.6 + (k % 2) * 0.45, lot.z + Math.sin(a) * 1.6), new THREE.Quaternion(), new THREE.Vector3().setScalar(on ? 1 : 0));
        this.lanterns.setMatrixAt(i * LANTERNS_PER_BUILDING + k, this.tmp);
      }
    }
    const pos = this.porch.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(i, lot.x, 0.35, lot.z + FOOTPRINT / 2 + 0.25);
    pos.needsUpdate = true;
    this.porch.geometry.setDrawRange(0, Math.max(this.idByIndex.length, i + 1));
  }

  private flush(): void {
    if (!this.buildings || !this.beacons) return;
    this.buildings.instanceMatrix.needsUpdate = true;
    if (this.buildings.instanceColor) this.buildings.instanceColor.needsUpdate = true;
    this.beacons.instanceMatrix.needsUpdate = true;
    if (this.beacons.instanceColor) this.beacons.instanceColor.needsUpdate = true;
    for (const m of [this.roofs, this.lanterns]) {
      if (!m) continue;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  // ---------- active building and power plant ----------
  private updateActive(s: SceneState): void {
    this.dropSprite(this.activeCaption);
    this.activeCaption = undefined;
    const b = s.activeBuildingId ? s.buildings[s.activeBuildingId] : undefined;
    const lot = b ? this.layout?.buildings[b.id] : undefined;
    if (!this.shaft) return;
    this.shaft.visible = Boolean(b && lot);
    if (!b || !lot) return;
    const h = buildingHeight(b);
    this.shaft.position.set(lot.x, h + 16, lot.z);
    this.activeCaption = this.sprite([{ text: `${VERB[b.lastAction?.type ?? ''] ?? b.label} ` }, { text: b.name, yellow: true }], 1.8);
    this.activeCaption.position.set(lot.x, h + 2.2, lot.z);
    this.activeCaption.name = 'active-caption';
    this.root.add(this.activeCaption);
    this.applyModeVisibility();
  }

  private updatePower(s: SceneState): void {
    const v = POWER_VISUALS[s.power.status];
    if (this.powerGlow) (this.powerGlow.material as THREE.MeshBasicMaterial).color.set(v.color);
    this.dropSprite(this.powerCaption);
    const L = this.layout;
    if (!L) return;
    this.powerCaption = this.sprite([{ text: `${v.icon} Power ` }, { text: v.label, yellow: true }], 2);
    this.powerCaption.position.set(L.power.x, 11.5, L.power.z);
    this.powerCaption.name = 'power-caption';
    this.root.add(this.powerCaption);
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    if (!on) return;
    // settle every animated value at its resting state
    if (this.stringLights) (this.stringLights.material as THREE.PointsMaterial).opacity = 0.75;
    if (this.shaft) (this.shaft.material as THREE.MeshBasicMaterial).opacity = 0.13;
    if (this.powerGlow) this.powerGlow.rotation.y = 0;
  }

  /** Per-frame animation (skipped entirely with reduced motion). Never allocates. */
  tick(t: number): void {
    this.scout.tick(t); // a move animates even with reduced motion (as a short fade)
    if (this.reducedMotion) return;
    if (this.stringLights) (this.stringLights.material as THREE.PointsMaterial).opacity = 0.6 + 0.2 * Math.sin(t * 1.7);
    if (this.powerGlow) this.powerGlow.rotation.y = t * 0.6;
    if (this.shaft?.visible) (this.shaft.material as THREE.MeshBasicMaterial).opacity = 0.11 + 0.04 * Math.sin(t * 2.4);
    if (this.lanterns) this.lanterns.position.y = Math.sin(t * 1.3) * 0.12; // the lanterns bob gently together
  }

  dispose(): void {
    for (const x of this.owned) x.dispose();
    this.owned.clear();
    this.perBuild.clear();
    this.root.clear();
    this.captions.clear();
    this.stopLabels.clear();
    this.journeyLine = this.selectRing = this.shaft = this.powerGlow = this.roads = undefined;
    this.activeCaption = this.powerCaption = undefined;
    this.buildings = this.beacons = undefined;
    this.porch = this.stringLights = undefined;
    this.scene = undefined;
    this.layout = undefined;
  }
}
