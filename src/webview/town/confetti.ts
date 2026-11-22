// Small confetti bursts over a building whose change was applied (renderer only; never in the reducer or journal).
// One Points object with a fixed pool, created once: a burst takes the next PER_BURST slots (ring buffer), every
// particle's direction comes from its slot index (no Math.random), and tick() writes positions in place, so nothing
// is allocated per frame. With reduced motion there are no bursts.
import * as THREE from 'three';
import { LANTERN_COLORS } from '../../town/grammar';

export const PER_BURST = 48;
export const POOL = PER_BURST * 4;
export const CONFETTI_LIFE_S = 1.8;
const GRAVITY = -9;
const HIDDEN_Y = -1000;

export class Confetti {
  readonly points: THREE.Points;
  private readonly pos: THREE.BufferAttribute;
  private readonly origin = new Float32Array(POOL * 3);
  private readonly vel = new Float32Array(POOL * 3);
  private readonly born = new Float32Array(POOL).fill(-1);
  private next = 0;
  private live = 0;

  constructor(own: <T extends { dispose(): void }>(x: T) => T) {
    const g = own(new THREE.BufferGeometry());
    const p = new Float32Array(POOL * 3);
    const c = new Float32Array(POOL * 3);
    const col = new THREE.Color();
    for (let i = 0; i < POOL; i++) {
      p[i * 3 + 1] = HIDDEN_Y;
      col.set(LANTERN_COLORS[i % LANTERN_COLORS.length]!);
      c.set([col.r, col.g, col.b], i * 3);
      // a fixed fan of directions per slot: golden-angle around the vertical, varied speed
      const k = i % PER_BURST;
      const a = k * 2.399963;
      const spread = 2.4 + (k % 5) * 0.8;
      this.vel.set([Math.cos(a) * spread, 8 + (k % 7) * 0.9, Math.sin(a) * spread], i * 3);
    }
    this.pos = new THREE.BufferAttribute(p, 3);
    g.setAttribute('position', this.pos);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    this.points = new THREE.Points(g, own(new THREE.PointsMaterial({ vertexColors: true, size: 0.9, transparent: true, opacity: 0.95, depthWrite: false })));
    this.points.name = 'confetti';
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  /** Particles in flight (for tests and stats). */
  get active(): number {
    return this.live;
  }

  /** A burst at (x, y, z), starting at time `t`. */
  burst(x: number, y: number, z: number, t: number): void {
    for (let k = 0; k < PER_BURST; k++) {
      const i = this.next;
      this.next = (this.next + 1) % POOL;
      if (this.born[i]! < 0) this.live++;
      this.born[i] = t;
      this.origin[i * 3] = x;
      this.origin[i * 3 + 1] = y;
      this.origin[i * 3 + 2] = z;
    }
    this.points.visible = true;
  }

  /** Moves particles in flight; hides finished ones. No allocation. */
  tick(t: number): void {
    if (this.live === 0) return;
    const p = this.pos.array as Float32Array;
    for (let i = 0; i < POOL; i++) {
      const b = this.born[i]!;
      if (b < 0) continue;
      const dt = t - b;
      if (dt > CONFETTI_LIFE_S || dt < 0) {
        this.born[i] = -1;
        this.live--;
        p[i * 3 + 1] = HIDDEN_Y;
        continue;
      }
      p[i * 3] = this.origin[i * 3]! + this.vel[i * 3]! * dt;
      p[i * 3 + 1] = this.origin[i * 3 + 1]! + this.vel[i * 3 + 1]! * dt + 0.5 * GRAVITY * dt * dt;
      p[i * 3 + 2] = this.origin[i * 3 + 2]! + this.vel[i * 3 + 2]! * dt;
    }
    this.pos.needsUpdate = true;
    if (this.live === 0) this.points.visible = false;
  }

  /** Ends every burst at once (reduced motion switched on, or a rebuild). */
  clear(): void {
    const p = this.pos.array as Float32Array;
    for (let i = 0; i < POOL; i++) {
      this.born[i] = -1;
      p[i * 3 + 1] = HIDDEN_Y;
    }
    this.live = 0;
    this.pos.needsUpdate = true;
    this.points.visible = false;
  }
}
