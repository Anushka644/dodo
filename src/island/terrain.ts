// The island lives in a heightmap you sculpt with your hands. It is kept on
// the CPU (so dodos can walk on it and the pointer can touch it) and mirrored
// into a half-float texture the shader marches through.

export const WORLD = 12; // world units across the heightmap (x and z in [-6, 6])
export const N = 256; // heightmap resolution
export const SEA = 0; // sea level
export const MAX_H = 1.75;

const CELL = WORLD / N;

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function vnoise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number) {
  let s = 0, a = 0.5;
  for (let i = 0; i < 4; i++) {
    s += a * vnoise(x, y);
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 9.2;
    a *= 0.5;
  }
  return s;
}

/** the ocean floor: shallow shelf in the middle, falling away to the deep */
function seabed(x: number, z: number) {
  const r = Math.hypot(x, z);
  return -0.32 - 0.5 * Math.min(1, Math.max(0, (r - 2.2) / 3.4)) - 0.05 * fbm(x * 0.9, z * 0.9);
}

export class Terrain {
  readonly h = new Float32Array(N * N);
  /** cells changed since the last upload: [x0, y0, x1, y1] or null */
  dirty: [number, number, number, number] | null = [0, 0, N - 1, N - 1];
  private landCells = 0;

  constructor() {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const [x, z] = this.toWorld(i, j);
        this.h[j * N + i] = seabed(x, z);
      }
    }
    // where the story starts: one rock, one dodo
    this.raise(0.15, 0.1, 0.55, 0.42, 1);
    this.countLand();
  }

  toWorld(i: number, j: number): [number, number] {
    return [(i + 0.5) * CELL - WORLD / 2, (j + 0.5) * CELL - WORLD / 2];
  }

  /** bilinear height at a world position (outside the map: open ocean) */
  sample(x: number, z: number): number {
    const fx = (x + WORLD / 2) / CELL - 0.5;
    const fz = (z + WORLD / 2) / CELL - 0.5;
    if (fx < 0 || fz < 0 || fx > N - 1 || fz > N - 1) return seabed(x, z);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const i1 = Math.min(N - 1, i + 1), j1 = Math.min(N - 1, j + 1);
    const a = this.h[j * N + i], b = this.h[j * N + i1], c = this.h[j1 * N + i], d = this.h[j1 * N + i1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /** the ground under a point, or the water if it's flooded */
  surface(x: number, z: number) {
    return Math.max(SEA, this.sample(x, z));
  }

  /**
   * Push land up (amount > 0) or down (amount < 0) around a point. The brush
   * is a soft dome broken up by noise, so pressing twice never makes the same hill.
   */
  raise(x: number, z: number, radius: number, amount: number, dt: number) {
    const ci = (x + WORLD / 2) / CELL - 0.5;
    const cj = (z + WORLD / 2) / CELL - 0.5;
    const rc = Math.ceil((radius * 2.2) / CELL);
    const i0 = Math.max(0, Math.floor(ci - rc)), i1 = Math.min(N - 1, Math.ceil(ci + rc));
    const j0 = Math.max(0, Math.floor(cj - rc)), j1 = Math.min(N - 1, Math.ceil(cj + rc));
    if (i0 > i1 || j0 > j1) return;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const [wx, wz] = this.toWorld(i, j);
        const d2 = ((wx - x) ** 2 + (wz - z) ** 2) / (radius * radius);
        if (d2 > 4.8) continue;
        const k = j * N + i;
        // a broad, flat-topped push: land spreads out before it climbs
        const g = Math.exp(-d2 * 0.9) * (1 - 0.35 * Math.exp(-d2 * 3));
        const n = 0.55 + 0.9 * fbm(wx * 2.4 + 3.1, wz * 2.4 - 1.7);
        let h = this.h[k];
        if (amount > 0) {
          // peaks grow slower than shoulders, so land spreads instead of spiking
          const room = 1 - Math.max(0, h) / MAX_H;
          // below the sea it rises fast (you're making land), above it slowly (you're making hills)
          const under = h < 0.04 ? 1.6 : 1;
          h += amount * dt * g * n * under * (0.15 + 0.85 * room * room * room);
        } else {
          h += amount * dt * g * n;
          h = Math.max(h, seabed(wx, wz) - 0.2);
        }
        this.h[k] = Math.min(MAX_H, h);
      }
    }
    this.markDirty(i0, j0, i1, j1);
  }

  /** soften a patch (used after heavy sculpting so ridges stay walkable) */
  relax(x: number, z: number, radius: number, strength: number) {
    const ci = (x + WORLD / 2) / CELL - 0.5;
    const cj = (z + WORLD / 2) / CELL - 0.5;
    const rc = Math.ceil(radius / CELL);
    const i0 = Math.max(1, Math.floor(ci - rc)), i1 = Math.min(N - 2, Math.ceil(ci + rc));
    const j0 = Math.max(1, Math.floor(cj - rc)), j1 = Math.min(N - 2, Math.ceil(cj + rc));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        const avg = (this.h[k - 1] + this.h[k + 1] + this.h[k - N] + this.h[k + N]) * 0.25;
        this.h[k] += (avg - this.h[k]) * strength;
      }
    }
    this.markDirty(i0, j0, i1, j1);
  }

  private markDirty(i0: number, j0: number, i1: number, j1: number) {
    const d = this.dirty;
    this.dirty = d ? [Math.min(d[0], i0), Math.min(d[1], j0), Math.max(d[2], i1), Math.max(d[3], j1)] : [i0, j0, i1, j1];
  }

  countLand() {
    let n = 0;
    for (let k = 0; k < this.h.length; k++) if (this.h[k] > SEA + 0.01) n++;
    this.landCells = n;
    return n;
  }

  /** land above water, in square world units */
  get landArea() {
    return this.landCells * CELL * CELL;
  }

  /** where a view ray first meets land or sea */
  raycast(o: [number, number, number], d: [number, number, number]): [number, number, number] | null {
    let t = 0;
    let prevAbove = true;
    let prevT = 0;
    for (let s = 0; s < 400 && t < 80; s++) {
      const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
      const g = this.surface(x, z);
      const above = y > g;
      if (!above && prevAbove && s > 0) {
        // refine between the last two samples
        let a = prevT, b = t;
        for (let r = 0; r < 12; r++) {
          const m = (a + b) / 2;
          const my = o[1] + d[1] * m;
          if (my > this.surface(o[0] + d[0] * m, o[2] + d[2] * m)) a = m;
          else b = m;
        }
        const m = (a + b) / 2;
        return [o[0] + d[0] * m, o[1] + d[1] * m, o[2] + d[2] * m];
      }
      prevAbove = above;
      prevT = t;
      t += Math.max(0.01, Math.min(0.3, (y - g) * 0.5));
    }
    return null;
  }
}
