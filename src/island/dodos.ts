import { SEA, type Terrain } from './terrain';
import type { WorldHand } from './hand/hand';

// The dodos. They want land, they waddle, they stop to look around, and
// they don't fly. If you drown their ground they float, slightly offended.
// Offer them a hand, palm up and low, and the curious ones climb aboard; tip
// it and they slide off and flutter down (still not flying).

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
  /** standing on your hand: where on the palm (across, along) */
  ride: { u: number; v: number } | null;
  /** tumbling through the air */
  fall: { vx: number; vy: number; vz: number } | null;
  alive: boolean;
}

/** what happened this step, for sounds and the log */
export interface FlockEvents {
  startled: number;
  boarded: number;
  dropped: number;
  landed: number;
  splashed: number;
}

/** how many dodos a hand can hold */
const SEATS = 3;

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
      ride: null,
      fall: null,
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

  /** one step of every dodo's life; the hand, if there is one, can carry them */
  step(dt: number, hand: WorldHand | null = null): FlockEvents {
    const T = this.terrain;
    const ev: FlockEvents = { startled: 0, boarded: 0, dropped: 0, landed: 0, splashed: 0 };
    const riders = this.dodos.filter((d) => d.ride).length;
    for (const d of this.dodos) {
      d.born = Math.min(1, d.born + dt * 1.5);
      d.honk = Math.max(0, d.honk - dt * 1.6);
      d.flee = Math.max(0, d.flee - dt);

      if (d.ride) {
        if (this.ride(d, dt, hand)) ev.dropped++;
        continue;
      }
      if (d.fall) {
        const landed = this.tumble(d, dt);
        if (landed === 'land') ev.landed++;
        if (landed === 'sea') ev.splashed++;
        continue;
      }

      const ground = T.sample(d.x, d.z);
      const swimming = ground < SEA + 0.005;
      // hot feet: flap, honk, and run for it
      if (d.flee <= 0 && d.born >= 1 && T.heatAt(d.x, d.z) > 0.08) {
        d.flee = 2.2;
        d.honk = 1;
        d.rest = 0;
        d.target = this.safeFrom(d.x, d.z);
        ev.startled++;
      }

      // a hand held out low and palm up: the curious walk over, and hop on
      if (hand?.offering && !swimming && d.born >= 1 && d.flee <= 0 && riders + ev.boarded < SEATS) {
        const p = hand.palm;
        const rest = hand.palmPoint(0, 0);
        const low = rest[1] - Math.max(SEA, T.sample(p.c[0], p.c[2])) < 0.32;
        const dx = p.c[0] - d.x, dz = p.c[2] - d.z;
        const dist = Math.hypot(dx, dz);
        if (low && dist < 1.1) {
          d.target = [p.c[0], p.c[2]];
          d.rest = 0;
          // on the palm, or near enough to its edge to hop up
          const u = (d.x - p.c[0]) * p.side[0] + (d.z - p.c[2]) * p.side[2];
          const v = (d.x - p.c[0]) * p.fwd[0] + (d.z - p.c[2]) * p.fwd[2];
          if (Math.abs(u) < p.half + 0.12 && v > -p.len * 0.7 && v < p.len * 0.75) {
            // it settles in the middle of the palm, side by side with any others
            const seat = riders + ev.boarded;
            d.ride = { u: (seat - 1) * p.half * 0.55, v: -p.len * 0.08 };
            d.target = null;
            d.honk = 0.7;
            d.rest = 1;
            ev.boarded++;
            continue;
          }
        }
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
      if (g > SEA) T.trample(d.x, d.z, 0.14, Math.min(1, dt * 1.2));
      const targetY = Math.max(g, SEA - 0.035); // floating, mostly submerged
      d.y += (targetY - d.y) * Math.min(1, dt * 10);
    }
    return ev;
  }

  /** riding the palm; returns true if it just fell off */
  private ride(d: Dodo, dt: number, hand: WorldHand | null): boolean {
    const r = d.ride!;
    const letGo = () => {
      const v = hand?.vel ?? [0, 0, 0];
      d.fall = { vx: v[0] * 0.6, vy: Math.max(0.4, v[1] * 0.6 + 0.6), vz: v[2] * 0.6 };
      d.ride = null;
      d.honk = 1;
      return true;
    };
    if (!hand || hand.present < 0.5) return letGo();
    const p = hand.palm;
    // a palm turned over drops everything at once
    if (p.n[1] < 0.15) return letGo();
    // tipped further than a hand held up naturally leans, it slides them towards the low side
    if (p.n[1] < 0.6) {
      const g = 5 * (0.6 - p.n[1]);
      // "down" in the palm's plane, in palm coordinates
      r.u += -p.side[1] * g * dt;
      r.v += -p.fwd[1] * g * dt;
      d.walk += dt * 14;
    } else if (Math.random() < dt * 0.4) {
      // a look around now and then
      d.heading += (Math.random() - 0.5) * 1.6;
    }
    if (Math.abs(r.u) > p.half + 0.05 || r.v < -p.len * 0.6 || r.v > p.len * 0.85) return letGo();
    const at = hand.palmPoint(r.u, r.v);
    d.x = at[0];
    d.y = at[1];
    d.z = at[2];
    return false;
  }

  /** falling: flapping hard and achieving nothing; returns where it came down, if it did */
  private tumble(d: Dodo, dt: number): 'land' | 'sea' | null {
    const f = d.fall!;
    f.vy -= 3.2 * dt;
    // the wings do slow it, a little
    f.vy = Math.max(f.vy, -2.2);
    d.x += f.vx * dt;
    d.y += f.vy * dt;
    d.z += f.vz * dt;
    f.vx *= 1 - dt * 0.8;
    f.vz *= 1 - dt * 0.8;
    d.honk = Math.max(d.honk, 0.8);
    d.x = Math.max(-5.8, Math.min(5.8, d.x));
    d.z = Math.max(-5.8, Math.min(5.8, d.z));
    const g = this.terrain.sample(d.x, d.z);
    const floor = Math.max(g, SEA - 0.035);
    if (d.y > floor) return null;
    d.y = floor;
    d.fall = null;
    d.target = null;
    d.rest = 1.2;
    return g < SEA + 0.005 ? 'sea' : 'land';
  }

  /** packed for the shader: position + heading, and walk/bob/flap/alive */
  pack(time: number): { pos: Float32Array; anim: Float32Array } {
    const pos = new Float32Array(MAX_DODOS * 4);
    const anim = new Float32Array(MAX_DODOS * 4);
    this.dodos.forEach((d, i) => {
      const swimming = !d.ride && !d.fall && this.terrain.sample(d.x, d.z) < SEA + 0.005;
      pos.set([d.x, d.y, d.z, d.heading], i * 4);
      const hop = Math.sin(d.honk * Math.PI) * 0.02;
      const bob = (swimming ? Math.sin(time * 2.4 + i) * 0.004 : 0) + hop - (1 - d.born) * 0.12;
      const flap = d.honk > 0 ? Math.sin(time * 40) * 0.9 * d.honk : 0;
      anim.set([d.walk, bob, flap, 1], i * 4);
    });
    return { pos, anim };
  }
}
