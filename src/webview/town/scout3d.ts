// Scout's 3D figure: an ORIGINAL little guide (not based on any existing character or game asset): a small round
// cream block with big friendly eyes, a warm red cap and scarf, and a glowing lantern. Where it goes comes from the
// scene state (src/town/scout.ts); this class only animates the move it is given: a short hop-walk along the
// rooftops (an arc from roof to roof), or with reduced motion a quick fade at the new place. Animation never changes where Scout ends up.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { ScoutMood } from '../../town/scout';

const MOOD_LANTERN: Record<ScoutMood, string> = { idle: '#ffd27a', busy: '#ffb347', happy: '#7ee081', worried: '#ff8a65' };
export const WALK_SPEED = 14; // units per second
export const FADE_S = 0.3;

export class ScoutFigure {
  readonly root = new THREE.Group();
  private readonly body: THREE.Group;
  private readonly lanternGlow: THREE.MeshBasicMaterial;
  private readonly fading: THREE.Material[] = [];
  private from = new THREE.Vector3();
  private to = new THREE.Vector3();
  private start: number | undefined;
  private duration = 0;
  private reduced = false;
  private lastT = 0;

  constructor(own: <T extends { dispose(): void }>(x: T) => T) {
    this.root.name = 'scout';
    this.body = new THREE.Group();
    const mat = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) => {
      const m = own(new THREE.MeshStandardMaterial({ color, roughness: 0.6, transparent: true, ...extra }));
      this.fading.push(m);
      return m;
    };
    const basic = (color: string) => {
      const m = own(new THREE.MeshBasicMaterial({ color, transparent: true }));
      this.fading.push(m);
      return m;
    };
    // body: a soft cream block
    const torso = new THREE.Mesh(own(new RoundedBoxGeometry(1.1, 1.0, 0.95, 3, 0.32).translate(0, 0.62, 0)), mat('#fff1d6', { emissive: '#8a6a3c', emissiveIntensity: 0.45 }));
    // big friendly eyes (white, dark pupils, tiny highlight)
    const eyeWhite = own(new THREE.SphereGeometry(0.19, 14, 10));
    const pupil = own(new THREE.SphereGeometry(0.1, 10, 8));
    const shine = own(new THREE.SphereGeometry(0.035, 6, 4));
    const white = basic('#ffffff');
    const dark = basic('#1e1b2e');
    for (const x of [-0.24, 0.24]) {
      const e = new THREE.Mesh(eyeWhite, white);
      e.position.set(x, 0.78, 0.43);
      const p = new THREE.Mesh(pupil, dark);
      p.position.set(x, 0.76, 0.58);
      const s = new THREE.Mesh(shine, white);
      s.position.set(x + 0.04, 0.81, 0.66);
      this.body.add(e, p, s);
    }
    // rosy cheeks
    const cheek = own(new THREE.SphereGeometry(0.07, 8, 6));
    const rose = basic('#ff9eb5');
    for (const x of [-0.4, 0.4]) {
      const c = new THREE.Mesh(cheek, rose);
      c.position.set(x, 0.6, 0.44);
      c.scale.set(1, 0.6, 0.4);
      this.body.add(c);
    }
    // tiny cap and scarf in the town's warm colours
    const cap = new THREE.Mesh(own(new THREE.CylinderGeometry(0.36, 0.44, 0.22, 16).translate(0, 1.2, 0)), mat('#e4572e'));
    const brim = new THREE.Mesh(own(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 16).translate(0, 1.11, 0.28)), mat('#c2410c'));
    const scarf = new THREE.Mesh(own(new THREE.TorusGeometry(0.5, 0.09, 8, 20).rotateX(Math.PI / 2).translate(0, 0.27, 0)), mat('#f59e0b'));
    // little lantern on a stick
    const stick = new THREE.Mesh(own(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6).translate(0.72, 0.65, 0.15)), mat('#7c5a3a'));
    const lantern = new THREE.Mesh(own(new RoundedBoxGeometry(0.26, 0.32, 0.26, 2, 0.06).translate(0.72, 0.24, 0.15)), mat('#5b3a29'));
    this.lanternGlow = basic(MOOD_LANTERN.idle);
    const flame = new THREE.Mesh(own(new THREE.SphereGeometry(0.11, 10, 8).translate(0.72, 0.24, 0.15)), this.lanternGlow);
    this.body.add(torso, cap, brim, scarf, stick, lantern, flame);
    this.root.add(this.body);
  }

  get animating(): boolean {
    return this.start !== undefined;
  }

  /** A new move (from the scene state). Starts at the current displayed position. */
  moveTo(target: THREE.Vector3, mood: ScoutMood, reducedMotion: boolean, first: boolean): void {
    this.lanternGlow.color.set(MOOD_LANTERN[mood]);
    this.reduced = reducedMotion;
    this.from.copy(this.root.position);
    this.to.copy(target);
    if (first) {
      this.root.position.copy(target);
      this.start = undefined;
      return;
    }
    const dist = Math.abs(this.to.x - this.from.x) + Math.abs(this.to.z - this.from.z);
    this.duration = reducedMotion ? FADE_S * 2 : Math.min(2.4, Math.max(0.4, dist / WALK_SPEED));
    this.start = dist === 0 && !reducedMotion ? undefined : -1; // -1: begins on the next tick
    if (dist === 0) this.root.position.copy(target);
  }

  private setOpacity(o: number): void {
    for (const m of this.fading) m.opacity = o;
  }

  /** Advances the current move; returns true while it is still animating. */
  tick(t: number): boolean {
    this.lastT = t;
    if (this.start === undefined) return false;
    if (this.start < 0) this.start = t;
    const p = Math.min(1, (t - this.start) / this.duration);
    if (this.reduced) {
      // no walking: fade out at the old place, appear at the new one
      if (p < 0.5) this.setOpacity(1 - p * 2);
      else {
        this.root.position.copy(this.to);
        this.setOpacity((p - 0.5) * 2);
      }
    } else {
      // walk along the streets: first along x, then along z, with a small hop
      const dx = Math.abs(this.to.x - this.from.x);
      const dz = Math.abs(this.to.z - this.from.z);
      const total = dx + dz || 1;
      const d = p * total;
      const x = d <= dx ? this.from.x + Math.sign(this.to.x - this.from.x) * d : this.to.x;
      const z = d <= dx ? this.from.z : this.from.z + Math.sign(this.to.z - this.from.z) * (d - dx);
      // height: from roof to roof in one arc (so Scout clears the buildings in between), plus small hops
      const arc = Math.sin(p * Math.PI) * Math.min(6, 1.5 + total * 0.15);
      const hop = Math.abs(Math.sin(p * Math.PI * Math.max(2, Math.round(total / 2.5)))) * 0.28;
      this.root.position.set(x, this.from.y + (this.to.y - this.from.y) * p + arc + hop, z);
      const dir = d <= dx ? new THREE.Vector3(Math.sign(this.to.x - this.from.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(this.to.z - this.from.z));
      if (dir.lengthSq() > 0) this.body.rotation.y = Math.atan2(dir.x, dir.z);
    }
    if (p >= 1) {
      this.root.position.copy(this.to);
      this.body.rotation.y = 0; // face the viewer when arrived
      this.setOpacity(1);
      this.start = undefined;
      return false;
    }
    return true;
  }

  /** Finishes any move at once (e.g. a jump in replay). */
  settle(): void {
    if (this.start === undefined) return;
    this.start = this.lastT - this.duration - 1;
    this.tick(this.lastT);
  }
}
