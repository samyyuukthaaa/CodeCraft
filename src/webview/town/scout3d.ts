// Scout's 3D figure: an ORIGINAL little guide (not based on any existing character or game asset): a round cream
// block with big friendly eyes, a warm red cap and scarf, little feet and a lantern. ONE low-poly mesh (all parts
// merged, colours per vertex), plus a warm rim halo so he reads against the night sky and a lantern glow. Where he
// goes is decided elsewhere (scene state for agent moves and clicks, the renderer's seeded patrol otherwise); this
// class only walks a given path of street waypoints, or with reduced motion fades to the end of it. Nothing here
// allocates per frame.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ScoutMood } from '../../town/scout';

const MOOD_LANTERN: Record<ScoutMood, string> = { idle: '#ffd27a', busy: '#ffb347', happy: '#7ee081', worried: '#ff8a65' };
export const FADE_S = 0.3;
/** Scout's scale: about as tall as a small house (≈3.6 units). */
export const SCOUT_SCALE = 2.7;

function part(g: THREE.BufferGeometry, color: string, m?: THREE.Matrix4): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  if (m) ng.applyMatrix4(m);
  const c = new THREE.Color(color);
  const n = ng.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  ng.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  for (const k of Object.keys(ng.attributes)) if (!['position', 'normal', 'color'].includes(k)) ng.deleteAttribute(k);
  return ng;
}
const at = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.Matrix4 => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));

/** All of Scout in one geometry (local height ≈1.33; feet at y = 0, facing +z). */
export function buildScoutGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    part(new RoundedBoxGeometry(1.1, 1.0, 0.95, 2, 0.32), '#fff1d6', at(0, 0.62, 0)), // body
    part(new RoundedBoxGeometry(0.3, 0.16, 0.36, 1, 0.07), '#e8c9a0', at(-0.25, 0.08, 0.06)), // feet
    part(new RoundedBoxGeometry(0.3, 0.16, 0.36, 1, 0.07), '#e8c9a0', at(0.25, 0.08, 0.06)),
    part(new THREE.CylinderGeometry(0.36, 0.44, 0.22, 12), '#e4572e', at(0, 1.2, 0)), // cap
    part(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 12), '#c2410c', at(0, 1.11, 0.28)), // brim
    part(new THREE.TorusGeometry(0.5, 0.09, 6, 14).rotateX(Math.PI / 2), '#f59e0b', at(0, 0.27, 0)), // scarf
    part(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), '#7c5a3a', at(0.72, 0.65, 0.15)), // lantern stick
    part(new RoundedBoxGeometry(0.26, 0.32, 0.26, 1, 0.06), '#5b3a29', at(0.72, 0.24, 0.15)), // lantern
    part(new THREE.SphereGeometry(0.11, 8, 6), '#fff3b0', at(0.72, 0.24, 0.15)), // flame
  ];
  for (const x of [-0.24, 0.24]) {
    parts.push(part(new THREE.SphereGeometry(0.19, 9, 6), '#ffffff', at(x, 0.78, 0.43))); // big eyes
    parts.push(part(new THREE.SphereGeometry(0.1, 7, 5), '#1e1b2e', at(x, 0.76, 0.58))); // pupils
    parts.push(part(new THREE.SphereGeometry(0.035, 5, 3), '#ffffff', at(x + 0.04, 0.81, 0.66))); // shine
  }
  for (const x of [-0.4, 0.4]) parts.push(part(new THREE.SphereGeometry(0.07, 6, 4), '#ff9eb5', at(x, 0.6, 0.44, 1, 0.6, 0.4))); // cheeks
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!g) throw new Error('could not merge Scout geometry');
  g.computeBoundingSphere();
  return g;
}

export interface ScoutFigureOptions {
  /** Builds the figure geometry (tests can make it fail to check the fallback marker). */
  build?: () => THREE.BufferGeometry;
  glow?: THREE.Texture;
  log?: (msg: string, err: unknown) => void;
}

export class ScoutFigure {
  readonly root = new THREE.Group();
  /** 'figure' normally; 'fallback' if the figure failed to build (a simple marker is shown instead). */
  readonly mode: 'figure' | 'fallback';
  private readonly body: THREE.Mesh;
  private readonly glow: THREE.Sprite;
  private readonly fading: THREE.Material[] = [];
  // walking (preallocated; no per-frame allocation)
  private pts: THREE.Vector3[] = [];
  private lens: number[] = [];
  private total = 0;
  private start: number | undefined;
  private speed = 9;
  private reduced = false;
  private fadeTo = new THREE.Vector3();
  private lastT = 0;
  private arrivedFlag = false;

  constructor(own: <T extends { dispose(): void }>(x: T) => T, opts: ScoutFigureOptions = {}) {
    this.root.name = 'scout';
    this.root.scale.setScalar(SCOUT_SCALE);
    let geo: THREE.BufferGeometry;
    let mode: 'figure' | 'fallback' = 'figure';
    try {
      geo = own((opts.build ?? buildScoutGeometry)());
    } catch (err) {
      (opts.log ?? ((m, e) => console.error(m, e)))('[Code Town] Scout figure failed to build; showing a simple marker instead.', err);
      mode = 'fallback';
      geo = own(part(new THREE.BoxGeometry(0.9, 1.3, 0.9), '#f59e0b', at(0, 0.65, 0)));
    }
    this.mode = mode;
    const mat = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, emissive: '#5a4022', emissiveIntensity: 0.4, transparent: true }));
    this.body = new THREE.Mesh(geo, mat);
    this.body.name = 'scout-body';
    // a warm rim halo (back faces of a slightly larger copy) so Scout reads against the night sky
    const rimMat = own(new THREE.MeshBasicMaterial({ color: '#ffd58a', side: THREE.BackSide, transparent: true, opacity: 0.55, depthWrite: false }));
    const rim = new THREE.Mesh(geo, rimMat);
    rim.name = 'scout-rim';
    rim.scale.set(1.09, 1.05, 1.09);
    rim.position.y = -0.03;
    this.glow = new THREE.Sprite(own(new THREE.SpriteMaterial({ color: MOOD_LANTERN.idle, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, ...(opts.glow ? { map: opts.glow } : {}) })));
    this.glow.name = 'scout-glow';
    this.glow.position.set(0.72, 0.24, 0.15);
    this.glow.scale.setScalar(0.9);
    // a beacon of constant screen size above the lantern, so Scout can be spotted from the whole-town view
    const beacon = new THREE.Sprite(own(new THREE.SpriteMaterial({ color: '#ffcf6b', transparent: true, opacity: 0.85, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, sizeAttenuation: false, ...(opts.glow ? { map: opts.glow } : {}) })));
    beacon.name = 'scout-beacon';
    beacon.position.set(0, 0.7, 0);
    beacon.scale.setScalar(0.05 / SCOUT_SCALE);
    beacon.renderOrder = 9;
    this.fading.push(mat, rimMat, this.glow.material);
    this.body.add(rim, this.glow, beacon);
    this.root.add(this.body);
  }

  get animating(): boolean {
    return this.start !== undefined;
  }

  /** True once after a walk or fade finished (read by the renderer to start the next patrol step). */
  takeArrived(): boolean {
    const a = this.arrivedFlag;
    this.arrivedFlag = false;
    return a;
  }

  setMood(mood: ScoutMood): void {
    (this.glow.material as THREE.SpriteMaterial).color.set(MOOD_LANTERN[mood]);
  }

  /** Puts Scout at a point at once (first placement, or a jump). */
  place(p: THREE.Vector3): void {
    this.root.position.copy(p);
    this.start = undefined;
    this.setOpacity(1);
  }

  /**
   * Walks through `points` (world coordinates) at `speed` units/s; with reduced motion fades to the last point
   * instead. Allocates only here (once per move), never per frame.
   */
  walk(points: THREE.Vector3[], speed: number, reducedMotion: boolean): void {
    this.reduced = reducedMotion;
    const end = points[points.length - 1];
    if (!end) return;
    if (reducedMotion) {
      this.fadeTo.copy(end);
      this.start = -1;
      return;
    }
    this.pts = [this.root.position.clone(), ...points.map((p) => p.clone())];
    this.lens = [];
    this.total = 0;
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1]!;
      const b = this.pts[i]!;
      const l = Math.hypot(b.x - a.x, b.z - a.z) + Math.abs(b.y - a.y);
      this.lens.push(l);
      this.total += l;
    }
    this.speed = speed;
    this.start = this.total > 1e-6 ? -1 : undefined;
    if (this.start === undefined) this.root.position.copy(end);
  }

  private setOpacity(o: number): void {
    for (const m of this.fading) m.opacity = m === this.fading[1] ? 0.55 * o : m === this.fading[2] ? 0.9 * o : o;
  }

  /** Advances the current walk or fade, and the idle motion. Returns true while a walk or fade is in progress. */
  tick(t: number, idleMotion: boolean): boolean {
    this.lastT = t;
    if (this.start === undefined) {
      // idle: a gentle bob, or (reduced motion) only a soft lantern pulse
      if (idleMotion) this.body.position.y = Math.sin(t * 2.2) * 0.04;
      else (this.glow.material as THREE.SpriteMaterial).opacity = 0.75 + 0.15 * Math.sin(t * 1.2);
      return false;
    }
    if (this.start < 0) this.start = t;
    if (this.reduced) {
      const p = Math.min(1, (t - this.start) / (FADE_S * 2));
      if (p < 0.5) this.setOpacity(1 - p * 2);
      else {
        this.root.position.copy(this.fadeTo);
        this.setOpacity((p - 0.5) * 2);
      }
      if (p >= 1) this.finish();
      return this.start !== undefined;
    }
    let d = (t - this.start) * this.speed;
    if (d >= this.total) {
      this.root.position.copy(this.pts[this.pts.length - 1]!);
      this.body.rotation.y = 0; // face the viewer when arrived
      this.finish();
      return false;
    }
    let i = 0;
    while (i < this.lens.length - 1 && d > this.lens[i]!) d -= this.lens[i++]!;
    const a = this.pts[i]!;
    const b = this.pts[i + 1]!;
    const f = this.lens[i]! > 0 ? d / this.lens[i]! : 1;
    const dy = b.y - a.y;
    // a roof hop arcs over the gap; walking on the street has small steps
    const arc = Math.abs(dy) > 0.01 ? Math.sin(f * Math.PI) * Math.min(4, 1 + Math.abs(dy) * 0.6) : Math.abs(Math.sin(d * 2.4)) * 0.12;
    this.root.position.set(a.x + (b.x - a.x) * f, a.y + dy * f + arc, a.z + (b.z - a.z) * f);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    if (Math.abs(dx) + Math.abs(dz) > 1e-6) this.body.rotation.y = Math.atan2(dx, dz);
    return true;
  }

  private finish(): void {
    this.start = undefined;
    this.setOpacity(1);
    this.arrivedFlag = true;
  }

  /** Finishes the current walk or fade at once (an interruption, or a replay jump). */
  settle(): void {
    if (this.start === undefined) return;
    this.root.position.copy(this.reduced ? this.fadeTo : this.pts[this.pts.length - 1]!);
    this.body.rotation.y = 0;
    this.start = undefined;
    this.setOpacity(1);
  }

  get lastTick(): number {
    return this.lastT;
  }
}
