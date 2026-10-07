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

// the eight neighbours, and how much a drop counts for over each distance
const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];
const DW = [1, 1, 1, 1, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2];

/** a binary min-heap of cell indices, for the flood */
class Heap {
  private k: Int32Array;
  private p: Float32Array;
  size = 0;
  constructor(cap: number) {
    this.k = new Int32Array(cap);
    this.p = new Float32Array(cap);
  }
  clear() {
    this.size = 0;
  }
  top() {
    return this.k[0];
  }
  topPriority() {
    return this.p[0];
  }
  push(key: number, pr: number) {
    const K = this.k, P = this.p;
    let i = this.size++;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (P[up] <= pr) break;
      K[i] = K[up];
      P[i] = P[up];
      i = up;
    }
    K[i] = key;
    P[i] = pr;
  }
  pop() {
    const K = this.k, P = this.p;
    const n = --this.size;
    if (n <= 0) return;
    const key = K[n], pr = P[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && P[c + 1] < P[c]) c++;
      if (P[c] >= pr) break;
      K[i] = K[c];
      P[i] = P[c];
      i = c;
    }
    K[i] = key;
    P[i] = pr;
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Terrain {
  readonly h = new Float32Array(N * N);
  /** vegetation 0..1: bare rock and sand until rain lets the forest creep in */
  readonly veg = new Float32Array(N * N);
  /** fresh lava 0..1: where land has just been pushed up out of the earth */
  readonly heat = new Float32Array(N * N);
  /** running water 0..1: rivers the rain has found */
  readonly river = new Float32Array(N * N);
  private vegNext = new Float32Array(N * N);
  private acc = new Float32Array(N * N);
  private recv = new Int32Array(N * N).fill(-1);
  private filled = new Float32Array(N * N);
  private seen = new Uint8Array(N * N);
  private order = new Int32Array(N * N);
  private landOrder = 0;
  private heap = new Heap(N * N);
  /** the shape of the land changed since the drainage was last worked out */
  reshaped = true;
  private hot: [number, number, number, number] | null = null;
  private forestSum = 0;
  /** cells changed since the last upload: [x0, y0, x1, y1] or null */
  dirty: [number, number, number, number] | null = [0, 0, N - 1, N - 1];
  private landCells = 0;

  /** a fixed, gentle unevenness that only steers water, so rivers wander */
  private wander = new Float32Array(N * N);

  constructor() {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const [x, z] = this.toWorld(i, j);
        this.h[j * N + i] = seabed(x, z);
        // broad bends, and smaller wiggles within them
        this.wander[j * N + i] = (fbm(x * 1.6 + 11.3, z * 1.6 - 4.1) - 0.5) * 0.05 + (fbm(x * 5.2 - 2.7, z * 5.2 + 8.9) - 0.5) * 0.025;
      }
    }
    // where the story starts: one rock, one dodo
    this.raise(0.15, 0.1, 0.55, 0.42, 1, false);
    this.countLand();
    this.route();
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

  /** dodos trample the undergrowth where they stand, so they stay in sight above it */
  trample(x: number, z: number, radius: number, amount: number) {
    const ci = Math.round((x + WORLD / 2) / CELL - 0.5);
    const cj = Math.round((z + WORLD / 2) / CELL - 0.5);
    const rc = Math.ceil(radius / CELL);
    for (let j = Math.max(0, cj - rc); j <= Math.min(N - 1, cj + rc); j++) {
      for (let i = Math.max(0, ci - rc); i <= Math.min(N - 1, ci + rc); i++) {
        const [wx, wz] = this.toWorld(i, j);
        const d = Math.hypot(wx - x, wz - z) / radius;
        // down to grass, never to bare earth: a dodo's clearing, not a scar
        const k = j * N + i;
        if (d < 1 && this.veg[k] > 0.25) this.veg[k] = Math.max(0.25, this.veg[k] * (1 - amount * (1 - d * d)));
      }
    }
  }

  /** lava heat at the nearest cell */
  heatAt(x: number, z: number) {
    const i = Math.round((x + WORLD / 2) / CELL - 0.5);
    const j = Math.round((z + WORLD / 2) / CELL - 0.5);
    if (i < 0 || j < 0 || i >= N || j >= N) return 0;
    return this.heat[j * N + i];
  }

  /** the ground under a point, or the water if it's flooded */
  surface(x: number, z: number) {
    return Math.max(SEA, this.sample(x, z));
  }

  /**
   * Push land up (amount > 0) or down (amount < 0) around a point. The brush
   * is a soft dome broken up by noise, so pressing twice never makes the same hill.
   */
  raise(x: number, z: number, radius: number, amount: number, dt: number, molten = true) {
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
          // new land comes up molten at the heart of the push
          if (molten) this.heat[k] = Math.min(1, this.heat[k] + dt * 5 * g * g * g * n);
        } else {
          h += amount * dt * g * n;
          h = Math.max(h, seabed(wx, wz) - 0.2);
        }
        this.h[k] = Math.min(MAX_H, h);
      }
    }
    this.markDirty(i0, j0, i1, j1);
    this.reshaped = true;
    if (molten && amount > 0) {
      const o = this.hot;
      this.hot = o ? [Math.min(o[0], i0), Math.min(o[1], j0), Math.max(o[2], i1), Math.max(o[3], j1)] : [i0, j0, i1, j1];
    }
  }

  /**
   * Lava runs down the drainage, a cell at a time, cooling as it goes; where
   * it reaches the sea it boils it. Returns how much is still glowing.
   */
  cool(dt: number) {
    const r = this.hot;
    if (!r) return 0;
    const H = this.h, R = this.recv, heat = this.heat, prev = this.heatPrev;
    // grow the hot patch by a cell each way so the flow can leave it
    const x0 = Math.max(0, r[0] - 1), y0 = Math.max(0, r[1] - 1), x1 = Math.min(N - 1, r[2] + 1), y1 = Math.min(N - 1, r[3] + 1);
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) prev[j * N + i] = heat[j * N + i];
    const k0 = Math.exp(-dt * 0.42);
    let max = 0;
    let steam = 0, sx = 0, sz = 0;
    let bx0 = N, by0 = N, bx1 = -1, by1 = -1;
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const k = j * N + i;
        const v0 = prev[k];
        if (v0 <= 0) continue;
        // a molten cell spills into the one below it
        const to = R[k];
        if (v0 > 0.18 && to >= 0) {
          const spill = v0 * 0.96;
          if (H[to] <= SEA) {
            if (spill > steam) {
              steam = spill;
              [sx, sz] = this.toWorld(to % N, (to - (to % N)) / N);
            }
            heat[to] = Math.max(heat[to], spill * 0.6);
          } else if (heat[to] < spill) heat[to] = spill;
          const ti = to % N, tj = (to - ti) / N;
          if (ti < bx0) bx0 = ti;
          if (ti > bx1) bx1 = ti;
          if (tj < by0) by0 = tj;
          if (tj > by1) by1 = tj;
        }
      }
    }
    for (let j = Math.min(y0, by0); j <= Math.max(y1, by1); j++) {
      for (let i = Math.min(x0, bx0); i <= Math.max(x1, bx1); i++) {
        const k = j * N + i;
        let v = heat[k] * k0;
        if (v < 0.003) v = 0;
        heat[k] = v;
        if (v > max) max = v;
        if (v > 0) {
          if (i < bx0) bx0 = i;
          if (i > bx1) bx1 = i;
          if (j < by0) by0 = j;
          if (j > by1) by1 = j;
        }
      }
    }
    this.markDirty(Math.min(x0, bx0), Math.min(y0, by0), Math.max(x1, bx1), Math.max(y1, by1));
    this.hot = max > 0 ? [bx0, by0, bx1, by1] : null;
    this.steam = steam > 0.2 ? [sx, sz, steam] : null;
    return max;
  }

  riverCells = 0;
  lakeCells = 0;
  /** rain from a hand: falls only under it (x, z, radius, amount 0..1), or null */
  shower: { x: number; z: number; r: number; a: number } | null = null;

  /** how much of the shower falls on cell (i, j) */
  private showerAt(i: number, j: number) {
    const sh = this.shower;
    if (!sh) return 0;
    const [x, z] = this.toWorld(i, j);
    const d2 = ((x - sh.x) ** 2 + (z - sh.z) ** 2) / (sh.r * sh.r);
    return d2 < 1 ? sh.a * (1 - d2) : 0;
  }

  /** where lava is pouring into the sea this moment: x, z, strength */
  steam: [number, number, number] | null = null;
  private heatPrev = new Float32Array(N * N);

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

  /**
   * Forests spread from forest. Rain makes them grow; a few seeds blow in on
   * their own. Drowned land loses its trees, and nothing grows on the peaks.
   */
  grow(dt: number, rain: number) {
    const H = this.h, V = this.veg, out = this.vegNext;
    const wet = 0.035 + rain * 1.4;
    let sum = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const h = H[k];
        let v = V[k];
        if (h <= SEA + 0.02 || h > 1.55) {
          out[k] = v * Math.max(0, 1 - dt * 3);
          continue;
        }
        const l = i > 0 ? k - 1 : k, r = i < N - 1 ? k + 1 : k, u = j > 0 ? k - N : k, d = j < N - 1 ? k + N : k;
        const slope = Math.hypot(H[r] - H[l], H[d] - H[u]) / (2 * CELL);
        const suit = smooth(0.03, 0.12, h) * (1 - smooth(1.05, 1.5, h)) * (1 - smooth(0.9, 1.8, slope));
        const near = Math.max(V[l], V[r], V[u], V[d]);
        const seed = 0.0025 + 0.9 * near;
        // river banks stay green between storms, and a hand's shower waters what's under it
        const w = wet + this.river[k] * 0.6 + (this.shower ? this.showerAt(i, j) * 1.6 : 0);
        v += dt * w * suit * seed * (1 - v) * 1.6;
        out[k] = v;
        sum += v;
      }
    }
    this.veg.set(out);
    this.forestSum = sum;
    this.vegDirty = true;
  }

  vegDirty = true;

  /**
   * Drainage, by priority-flood: flood the land up from the coast, lowest
   * first, so every cell learns which way leads to the sea — even out of a
   * hollow, which fills up to its rim and becomes a lake.
   */
  route() {
    const H = this.h, R = this.recv, F = this.filled, seen = this.seen, order = this.order;
    const heap = this.heap;
    heap.clear();
    seen.fill(0);
    R.fill(-1);
    // the sea is the outlet: every sea cell touching land starts the flood
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        if (H[k] > SEA) continue;
        seen[k] = 1;
        F[k] = SEA;
        if ((i > 0 && H[k - 1] > SEA) || (i < N - 1 && H[k + 1] > SEA) || (j > 0 && H[k - N] > SEA) || (j < N - 1 && H[k + N] > SEA)) heap.push(k, SEA);
      }
    }
    let n = 0;
    while (heap.size) {
      const k = heap.top();
      const p = heap.topPriority();
      heap.pop();
      if (H[k] > SEA) order[n++] = k;
      const i = k % N, j = (k - i) / N;
      for (let o = 0; o < 8; o++) {
        const ni = i + DI[o], nj = j + DJ[o];
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const q = nj * N + ni;
        if (seen[q]) continue;
        seen[q] = 1;
        // a hollow fills to its rim, then spills; flats lean very slightly downstream
        const fq = Math.max(H[q], p + 1e-5);
        F[q] = fq;
        R[q] = k;
        heap.push(q, fq);
      }
    }
    this.landOrder = n;
    this.reshaped = false;
    // where the land falls away, follow the steepest way down rather than the
    // flood's. Only strictly lower cells count (so water can never loop), but the
    // choice among them is nudged by a fixed wander field, so rivers meander
    // instead of running down a smooth slope like a ruler.
    const J = this.wander;
    for (let c = 0; c < n; c++) {
      const k = order[c];
      const i = k % N, j = (k - i) / N;
      const f = F[k];
      const fj = f + J[k];
      let best = -Infinity;
      let to = -1;
      for (let o = 0; o < 8; o++) {
        const ni = i + DI[o], nj = j + DJ[o];
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const q = nj * N + ni;
        if (f - F[q] <= 2e-5) continue;
        const d = (fj - F[q] - J[q]) * DW[o];
        if (d > best) {
          best = d;
          to = q;
        }
      }
      if (to >= 0) R[k] = to;
    }
  }

  /**
   * Water runs downhill, gathering as it goes. Where enough of it gathers it
   * shows as a river (and a filled hollow as a lake), and while it rains,
   * rivers cut their valleys a little deeper.
   */
  flow(dt: number, rain: number) {
    const H = this.h, R = this.recv, F = this.filled, A = this.acc, order = this.order, W = this.river;
    // springs keep the big rivers running between storms
    const inflow = 0.35 + rain * 1.2;
    A.fill(0);
    for (let c = 0; c < this.landOrder; c++) A[order[c]] = inflow;
    if (this.shower) {
      for (let c = 0; c < this.landOrder; c++) {
        const k = order[c];
        A[k] += this.showerAt(k % N, (k - (k % N)) / N) * 1.4;
      }
    }
    // highest first: each cell hands its water on to the one it drains into
    for (let c = this.landOrder - 1; c >= 0; c--) {
      const k = order[c];
      const r = R[k];
      if (r >= 0) A[r] += A[k];
    }
    // rivers swell quickly in a storm and fall back slowly after it
    const rise = 1 - Math.exp(-dt * 1.5);
    const fall = 1 - Math.exp(-dt * 0.25);
    const cut = 0.006 * rain * dt;
    let rivers = 0, lakes = 0;
    for (let c = 0; c < this.landOrder; c++) {
      const k = order[c];
      const h = H[k];
      const lake = F[k] - h > 0.03 ? 1 : 0;
      const want = h > SEA ? Math.max(lake, smooth(60, 260, A[k])) : 0;
      W[k] += (want - W[k]) * (want > W[k] ? rise : fall);
      if (W[k] > 0.5) {
        if (lake) lakes++;
        else rivers++;
      }
      // erosion: fast water on a slope wears the land down towards its outlet
      const r = R[k];
      if (cut > 0 && r >= 0 && A[k] > 30 && !lake) {
        const drop = h - H[r];
        if (drop <= 0) continue;
        const e = Math.min(cut * Math.sqrt(A[k]) * drop * 0.6, drop * 0.4, 0.002);
        H[k] = Math.max(h - e, SEA + 0.004);
        this.reshaped = true;
      }
    }
    this.riverCells = rivers;
    this.lakeCells = lakes;
    // the sea takes back whatever river water was left on drowned cells
    for (let k = 0; k < N * N; k++) if (H[k] <= SEA && W[k] > 0) W[k] = Math.max(0, W[k] - dt * 2);
    this.markDirty(0, 0, N - 1, N - 1);
  }

  /** forest cover, in square world units */
  get forestArea() {
    return this.forestSum * CELL * CELL;
  }

  /** the middle of the land, for things that circle it */
  centre: [number, number] = [0.15, 0.1];

  countLand() {
    let n = 0, sx = 0, sz = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (this.h[j * N + i] > SEA + 0.01) {
          n++;
          sx += i;
          sz += j;
        }
      }
    }
    this.landCells = n;
    if (n > 0) this.centre = this.toWorld(sx / n, sz / n);
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
