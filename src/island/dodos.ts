import { SEA, type Terrain } from './terrain';

// The dodos. They want land, they waddle, they stop to look around, and
// they don't fly. If you drown their ground they float, slightly offended.

export const MAX_DODOS = 12;

export interface Dodo {
  x: number;
  z: number;
  y: number;
  heading: number;
  target: [number, number] | null;
  speed: number;
  walk: number; // stride phase
  rest: number; // seconds left standing still
  honk: number; // 0..1, decays: a startled hop and flap
  born: number; // 0..1, grows in after hatching
  flee: number; // seconds left running from lava
  alive: boolean;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Flock {
  readonly dodos: Dodo[] = [];

  constructor(private terrain: Terrain) {
    // the last one, on its rock
    this.hatch(0.15, 0.1, true);
  }

  get count() {
    return this.dodos.length;
  }

  hatch(x: number, z: number, grown = false): Dodo | null {
    if (this.dodos.length >= MAX_DODOS) return null;
    const d: Dodo = {
      x,
      z,
      y: this.terrain.surface(x, z),
      heading: rnd(0, Math.PI * 2),
      target: null,
      speed: rnd(0.07, 0.12),
      walk: rnd(0, 6),
      rest: rnd(0.5, 2),
      honk: grown ? 0 : 1,
      born: grown ? 1 : 0,
      flee: 0,
      alive: true,
    };
    this.dodos.push(d);
    return d;
  }

  /** a random point on dry land near (x, z), or null */
  private landNear(x: number, z: number, radius: number): [number, number] | null {
    for (let i = 0; i < 24; i++) {
      const a = rnd(0, Math.PI * 2);
      const r = rnd(0.1, radius);
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      const h = this.terrain.sample(px, pz);
      if (h > SEA + 0.03 && h < 1.3) return [px, pz];
    }
    return null;
  }

  /** somewhere new for a hatchling: dry land, preferably away from the others */
  spot(): [number, number] | null {
    let best: [number, number] | null = null;
    let bestScore = -1;
    for (let i = 0; i < 60; i++) {
      const px = rnd(-5.5, 5.5);
      const pz = rnd(-5.5, 5.5);
      const h = this.terrain.sample(px, pz);
      if (h < SEA + 0.05 || h > 1.1) continue;
      const near = Math.min(9, ...this.dodos.map((d) => Math.hypot(d.x - px, d.z - pz)));
      if (near > bestScore) {
        bestScore = near;
        best = [px, pz];
      }
    }
    return best;
  }

  /** the dodo under a world point, if any */
  at(x: number, z: number, radius = 0.18): Dodo | null {
    let best: Dodo | null = null;
    let bestD = radius;
    for (const d of this.dodos) {
      const dist = Math.hypot(d.x - x, d.z - z);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    return best;
  }

  /** a cool spot on land away from the lava, or null */
  private safeFrom(x: number, z: number): [number, number] | null {
    let best: [number, number] | null = null;
    let bestHeat = Infinity;
    for (let i = 0; i < 16; i++) {
      const p = this.landNear(x, z, 1.4);
      if (!p) continue;
      const h = this.terrain.heatAt(p[0], p[1]) - Math.hypot(p[0] - x, p[1] - z) * 0.05;
      if (h < bestHeat) {
        bestHeat = h;
        best = p;
      }
    }
    return best;
  }

  /** returns how many dodos were startled this step (by lava underfoot) */
  step(dt: number) {
    const T = this.terrain;
    let startled = 0;
    for (const d of this.dodos) {
      d.born = Math.min(1, d.born + dt * 1.5);
      d.honk = Math.max(0, d.honk - dt * 1.6);
      d.flee = Math.max(0, d.flee - dt);
      const ground = T.sample(d.x, d.z);
      const swimming = ground < SEA + 0.005;
      // hot feet: flap, honk, and run for it
      if (d.flee <= 0 && d.born >= 1 && T.heatAt(d.x, d.z) > 0.08) {
        d.flee = 2.2;
        d.honk = 1;
        d.rest = 0;
        d.target = this.safeFrom(d.x, d.z);
        startled++;
      }

      if (d.rest > 0 && !swimming) {
        d.rest -= dt;
      } else {
        if (!d.target || Math.hypot(d.target[0] - d.x, d.target[1] - d.z) < 0.05) {
          d.target = this.landNear(d.x, d.z, swimming ? 2.5 : 1.2);
          if (!swimming) d.rest = Math.random() < 0.5 ? rnd(0.6, 3) : 0;
        }
        if (d.target) {
          const want = Math.atan2(d.target[0] - d.x, d.target[1] - d.z);
          let dh = want - d.heading;
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          d.heading += dh * Math.min(1, dt * 4);
          const sp = d.speed * (swimming ? 0.6 : 1) * d.born * (d.flee > 0 ? 3.2 : 1);
          const nx = d.x + Math.sin(d.heading) * sp * dt;
          const nz = d.z + Math.cos(d.heading) * sp * dt;
          const nh = T.sample(nx, nz);
          // dodos don't climb cliffs or walk into the sea on purpose
          const climb = nh - ground;
          if ((nh > SEA + 0.01 || swimming) && climb < 0.08 * sp * dt * 60 + 0.02 + (d.flee > 0 ? 0.02 : 0)) {
            d.x = nx;
            d.z = nz;
            d.walk += dt * (swimming ? 5 : d.flee > 0 ? 26 : 11);
          } else {
            d.target = null;
          }
        }
      }
      // keep within the world
      d.x = Math.max(-5.8, Math.min(5.8, d.x));
      d.z = Math.max(-5.8, Math.min(5.8, d.z));
      const g = T.sample(d.x, d.z);
      const targetY = Math.max(g, SEA - 0.035); // floating, mostly submerged
      d.y += (targetY - d.y) * Math.min(1, dt * 10);
    }
    return startled;
  }

  /** packed for the shader: position + heading, and walk/bob/flap/alive */
  pack(time: number): { pos: Float32Array; anim: Float32Array } {
    const pos = new Float32Array(MAX_DODOS * 4);
    const anim = new Float32Array(MAX_DODOS * 4);
    this.dodos.forEach((d, i) => {
      const swimming = this.terrain.sample(d.x, d.z) < SEA + 0.005;
      pos.set([d.x, d.y, d.z, d.heading], i * 4);
      const hop = Math.sin(d.honk * Math.PI) * 0.02;
      const bob = (swimming ? Math.sin(time * 2.4 + i) * 0.004 : 0) + hop - (1 - d.born) * 0.12;
      const flap = d.honk > 0 ? Math.sin(time * 40) * 0.9 * d.honk : 0;
      anim.set([d.walk, bob, flap, 1], i * 4);
    });
    return { pos, anim };
  }
}
