// A banknote as a position-based particle grid (Müller et al. 2007, run as
// many small substeps — the XPBD "small steps" trick). Distance constraints
// keep the paper from stretching; a soft global shape-match is what makes it
// PAPER rather than cloth: it gives the whole sheet bending stiffness that
// doesn't depend on resolution or iteration count, so a note held by a corner
// hangs mostly straight instead of draping. Air acts per triangle, with the
// centre of pressure shifted toward the leading edge — that offset is what
// makes a dropped note rock and tumble like a leaf instead of falling flat.
// Nothing in step() allocates.

import type { Collider, PaperEnv, PaperSheetApi, SheetOptions, V3 } from '../contracts';
import { ASPECT } from '../note/layout';

/** Theatrical gravity: a note is 1 unit tall, so real g would be ~75 u/s². */
export const GRAVITY: V3 = [0, -7, 0];

/** Tuning. Mutable on purpose so it can be live-tweaked from the console. Rates are per second. */
export const PAPER = {
  substep: 1 / 120, // nominal substep; a frame runs n = ceil(dt / (substep·1.15)) equal substeps
  maxSubsteps: 4, // longer frames (tab switches) run in slow motion instead of exploding
  iterations: 2, // constraint sweeps per substep (a sheet may override)
  maxSpeed: 24, // world units/s per particle; tracking jumps can't fling paper further than this
  teleport: 1.2, // a pin/attach target moving further than this in one frame drags the sheet along rigidly

  stretch: 1, // structural stiffness per sweep (1 = inextensible)
  shear: 0.7,
  bend: 0.5, // local smoothness (linear three-particle bending)
  camber: 0.06, // natural bow of a note, world units of sag at the ends (also seeds tumbling)
  shapeMatch: 3.5, // global flatness: how fast bends relax back to flat, 1/s
  deformDamping: 5, // damps flexing relative to the rigid motion (not the fall itself), 1/s
  damping: 0.08, // plain velocity damping, 1/s

  dragNormal: 1.1, // quadratic face drag (sets terminal speed ≈ sqrt(g / dragNormal))
  dragLinear: 0.3, // linear face drag
  dragTangent: 0.25, // edge-on drag
  lift: 1.5, // thin-plate lift: face force ∝ edgewise speed × (u·n); makes notes glide and tip
  leadingEdge: 3, // centre of pressure shift toward the leading edge (3 ≈ quarter chord) — the flutter
  turbulence: 0.35, // gusts on top of env.wind, world units/s
  gustShear: 2, // how much the gust varies across the sheet, per unit of distance (relative to turbulence)

  attachRate: 34, // how hard attach() pulls at weight 1, 1/s
  attachFalloff: 0.85, // edges are held less firmly than the middle, so they flex

  crumpleRate: 14, // how fast a fist pulls the paper into a ball, 1/s
  crumpleRadius: 0.2, // ball radius at amount 1, in note heights
  wrinkleRate: 1.6, // how fast squeezing accumulates permanent wrinkle, 1/s
  relaxTime: 0.7, // seconds for stiffness to come back after a squeeze
  creaseYield: 6, // how fast creases set while squeezed, 1/s
  creaseMax: 0.22, // max crease sag per joint, fraction of the grid spacing
  wrinkleSoften: 0.65, // a fully wrinkled note keeps this much less shape memory

  floorFriction: 0.7,
  contactMargin: 0.008, // paper thickness kept off colliders
  diskDepth: 0.25, // particles up to this far behind a disk still get pushed to its front

  sleepSpeed: 0.03, // a resting sheet below this mean speed for sleepAfter seconds stops simulating
  sleepAfter: 0.6,
};

// ------------------------------------------------------------------ grid helpers

const indexCache = new Map<string, Uint16Array>();
const uvCache = new Map<string, Float32Array>();

/**
 * Triangle indices for a cols×rows grid, CCW seen from the front (+z when laid flat).
 * Diagonals alternate in a checkerboard so the mesh bends the same way in every
 * direction. Memoised: sheets of the same resolution share one (read-only) array.
 */
export function gridIndices(cols: number, rows: number): Uint16Array {
  const key = `${cols}x${rows}`;
  let out = indexCache.get(key);
  if (out) return out;
  out = new Uint16Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      if (((i + j) & 1) === 0) {
        out[k++] = a; out[k++] = c; out[k++] = b;
        out[k++] = b; out[k++] = c; out[k++] = d;
      } else {
        out[k++] = a; out[k++] = c; out[k++] = d;
        out[k++] = a; out[k++] = d; out[k++] = b;
      }
    }
  }
  indexCache.set(key, out);
  return out;
}

/** Note-space UVs: (i/(cols−1)·ASPECT, j/(rows−1)). Memoised and shared like gridIndices. */
export function gridUvs(cols: number, rows: number): Float32Array {
  const key = `${cols}x${rows}`;
  let out = uvCache.get(key);
  if (out) return out;
  out = new Float32Array(cols * rows * 2);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p = (j * cols + i) * 2;
      out[p] = (i / (cols - 1)) * ASPECT;
      out[p + 1] = j / (rows - 1);
    }
  }
  uvCache.set(key, out);
  return out;
}

// Everything that depends only on the resolution and size is shared between sheets,
// which also keeps the constraint arrays hot in cache across 60 rain notes.
interface Topology {
  cols: number;
  rows: number;
  count: number;
  width: number;
  height: number;
  /** rest position in the sheet's own frame: x along right, y along up, centred */
  qx: Float32Array;
  qy: Float32Array;
  /** squared rest distance from the centre, normalised to 1 at the corners */
  qr2: Float32Array;
  /** distance constraints: structural pairs first, then shear */
  pairs: Uint16Array;
  rest: Float32Array;
  nStruct: number;
  /** bending triplets (a, b, c) along rows and columns */
  trip: Uint16Array;
  spacing: number;
  /** characteristic half-size for the leading-edge model */
  radius: number;
  indices: Uint16Array;
  uvs: Float32Array;
}

const topoCache = new Map<string, Topology>();

function topology(cols: number, rows: number, width: number, height: number): Topology {
  const key = `${cols}x${rows}:${width}x${height}`;
  const hit = topoCache.get(key);
  if (hit) return hit;
  const count = cols * rows;
  const qx = new Float32Array(count);
  const qy = new Float32Array(count);
  const qr2 = new Float32Array(count);
  const corner2 = (width * width + height * height) / 4;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p = j * cols + i;
      qx[p] = (i / (cols - 1) - 0.5) * width;
      qy[p] = (0.5 - j / (rows - 1)) * height;
      qr2[p] = (qx[p] * qx[p] + qy[p] * qy[p]) / corner2;
    }
  }
  const pairs: number[] = [];
  const at = (i: number, j: number) => j * cols + i;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols - 1; i++) pairs.push(at(i, j), at(i + 1, j));
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols; i++) pairs.push(at(i, j), at(i, j + 1));
  const nStruct = pairs.length / 2;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      pairs.push(at(i, j), at(i + 1, j + 1));
      pairs.push(at(i + 1, j), at(i, j + 1));
    }
  }
  const rest = new Float32Array(pairs.length / 2);
  for (let k = 0; k < rest.length; k++) {
    const a = pairs[k * 2];
    const b = pairs[k * 2 + 1];
    rest[k] = Math.hypot(qx[a] - qx[b], qy[a] - qy[b]);
  }
  const trip: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 1; i < cols - 1; i++) trip.push(at(i - 1, j), at(i, j), at(i + 1, j));
  for (let j = 1; j < rows - 1; j++) for (let i = 0; i < cols; i++) trip.push(at(i, j - 1), at(i, j), at(i, j + 1));
  const t: Topology = {
    cols,
    rows,
    count,
    width,
    height,
    qx,
    qy,
    qr2,
    pairs: Uint16Array.from(pairs),
    rest,
    nStruct,
    trip: Uint16Array.from(trip),
    spacing: Math.min(width / (cols - 1), height / (rows - 1)),
    radius: (width + height) / 4,
    indices: gridIndices(cols, rows),
    uvs: gridUvs(cols, rows),
  };
  topoCache.set(key, t);
  return t;
}

// small seeded PRNG (mulberry32): every note crumples and gusts its own way, reproducibly
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextSeed = 1;

const MAX_COLLIDERS = 8;
const HARD = 0.999;

export interface PaperSheetOptions extends SheetOptions {
  /** reproducible gusts / crumple pattern; defaults to a running counter */
  seed?: number;
  /** constraint sweeps per substep; defaults to PAPER.iterations */
  iterations?: number;
}

// ------------------------------------------------------------------ the sheet

export class PaperSheet implements PaperSheetApi {
  readonly cols: number;
  readonly rows: number;
  readonly count: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint16Array;
  wrinkle = 0;

  readonly seed: number;
  iterations: number;
  /** gust strength on top of env.wind for this sheet (world units/s) */
  turbulence = PAPER.turbulence;
  /** rests this far above env.floorY, so a pile of notes doesn't z-fight */
  floorLift: number;
  /** mean particle speed after the last step, world units/s (drives the flutter sound) */
  speed = 0;
  /** particles touching a collider / the floor after the last step (catch & landing cues) */
  colliderContacts = 0;
  floorContacts = 0;
  /** at rest on the floor and not being simulated; any interaction wakes it */
  sleeping = false;

  private topo: Topology;
  private vel: Float32Array;
  private prev: Float32Array;
  private invMass: Float32Array;
  private aeroF: Float32Array;
  private aeroW: Float32Array;
  private kappa: Float32Array;
  /** this note's natural bow, out of plane, at camber = 1 (no real note is perfectly flat) */
  private bow: Float32Array;
  private crumpleOff: Float32Array | null = null;

  private pinStrength: Float32Array;
  private pinFrom: Float32Array;
  private pinTo: Float32Array;
  private pinList: Int32Array;
  private pinCount = 0;

  private attachOn = false;
  private attachWeight = 0;
  private attachFrom = new Float64Array(9); // centre, right, up
  private attachTo = new Float64Array(9);

  private crumpleAt = new Float64Array(3);
  private crumpleAmount = 0;
  private crumpleFresh = false;
  private relax = 0;

  // rigid motion of the sheet: centroid, mean velocity, angular velocity
  private rb = new Float64Array(9);
  // last shape-match rotation (right, up) — reused if the fit degenerates
  private frame = new Float64Array([1, 0, 0, 0, 1, 0]);
  private gustPhase: Float64Array;
  private time = 0;

  private colPrev = new Float64Array(MAX_COLLIDERS * 3);
  private colVel = new Float64Array(MAX_COLLIDERS * 3);
  private colKinds: string[] = [];
  private stillFor = 0;
  private sleepKey = new Float64Array(5); // floorY, wind xyz, |g|
  private bound = new Float64Array(4); // bounding sphere while asleep

  constructor(opts: PaperSheetOptions) {
    const cols = Math.max(2, Math.floor(opts.cols));
    const rows = Math.max(2, Math.floor(opts.rows));
    if (cols * rows > 65536) throw new Error('PaperSheet: grid too large for 16-bit indices');
    this.cols = cols;
    this.rows = rows;
    this.count = cols * rows;
    const width = opts.width ?? ASPECT;
    const height = opts.height ?? 1;
    this.topo = topology(cols, rows, width, height);
    this.uvs = this.topo.uvs;
    this.indices = this.topo.indices;
    this.seed = opts.seed ?? nextSeed++;
    this.iterations = opts.iterations ?? PAPER.iterations;
    const n = this.count;
    this.positions = new Float32Array(n * 3);
    this.normals = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.invMass = new Float32Array(n).fill(1);
    this.aeroF = new Float32Array(n * 3);
    this.aeroW = new Float32Array(n);
    this.kappa = new Float32Array(this.topo.trip.length / 3);
    this.pinStrength = new Float32Array(n);
    this.pinFrom = new Float32Array(n * 3);
    this.pinTo = new Float32Array(n * 3);
    this.pinList = new Int32Array(n);
    const r = rng(this.seed * 2654435761);
    this.gustPhase = Float64Array.from({ length: 8 }, () => r() * Math.PI * 2);
    this.floorLift = 0.002 + r() * 0.03;
    // a gentle cylindrical bow about a random axis: realistic, and it means air
    // meeting the note edge-on still finds something to push on, so it tips
    this.bow = new Float32Array(this.count);
    const ba = r() * Math.PI, bc = Math.cos(ba), bs = Math.sin(ba);
    const bm = (r() < 0.5 ? -1 : 1) * (0.5 + 0.5 * r());
    const { qx, qy } = this.topo;
    let bmax = 0;
    let bmean = 0;
    for (let i = 0; i < this.count; i++) bmax = Math.max(bmax, Math.abs(qx[i] * bc + qy[i] * bs));
    for (let i = 0; i < this.count; i++) {
      const u = (qx[i] * bc + qy[i] * bs) / bmax;
      this.bow[i] = bm * u * u;
      bmean += this.bow[i] / this.count;
    }
    for (let i = 0; i < this.count; i++) this.bow[i] -= bmean;
    this.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  }

  // ---------------------------------------------------------------- placement

  placeFlat(center: V3, right: V3, up: V3) {
    // orthonormalise defensively: a skewed frame would start the sheet stretched
    let rx = right[0], ry = right[1], rz = right[2];
    let l = Math.hypot(rx, ry, rz) || 1;
    rx /= l; ry /= l; rz /= l;
    let ux = up[0], uy = up[1], uz = up[2];
    const d = ux * rx + uy * ry + uz * rz;
    ux -= d * rx; uy -= d * ry; uz -= d * rz;
    l = Math.hypot(ux, uy, uz);
    if (l < 1e-6) {
      // up parallel to right: pick any perpendicular
      ux = -ry; uy = rx; uz = 0;
      l = Math.hypot(ux, uy, uz) || 1;
      if (l < 1e-6) { ux = 0; uy = 0; uz = 1; l = 1; }
    }
    ux /= l; uy /= l; uz /= l;
    const nx = ry * uz - rz * uy, ny = rz * ux - rx * uz, nz = rx * uy - ry * ux;
    const { qx, qy } = this.topo;
    const x = this.positions;
    const bow = this.bow;
    const cb = PAPER.camber;
    for (let i = 0; i < this.count; i++) {
      const p = i * 3;
      const b = bow[i] * cb;
      x[p] = center[0] + rx * qx[i] + ux * qy[i] + nx * b;
      x[p + 1] = center[1] + ry * qx[i] + uy * qy[i] + ny * b;
      x[p + 2] = center[2] + rz * qx[i] + uz * qy[i] + nz * b;
      this.normals[p] = nx;
      this.normals[p + 1] = ny;
      this.normals[p + 2] = nz;
    }
    this.prev.set(x);
    this.vel.fill(0);
    this.frame[0] = rx; this.frame[1] = ry; this.frame[2] = rz;
    this.frame[3] = ux; this.frame[4] = uy; this.frame[5] = uz;
    this.crumpleFresh = false;
    this.crumpleAmount = 0;
    this.relax = 0;
    this.kappa.fill(0);
    // hard pins keep their particle where the pin is, not where the sheet was
    for (let k = 0; k < this.pinCount; k++) {
      const i = this.pinList[k];
      for (let c = 0; c < 3; c++) this.pinFrom[i * 3 + c] = this.pinTo[i * 3 + c];
    }
    this.wake();
  }

  setVelocity(v: V3, spin?: V3) {
    if (!finite3(v) || (spin && !finite3(spin))) return;
    const x = this.positions;
    const vel = this.vel;
    let cx = 0, cy = 0, cz = 0;
    for (let p = 0; p < x.length; p += 3) { cx += x[p]; cy += x[p + 1]; cz += x[p + 2]; }
    cx /= this.count; cy /= this.count; cz /= this.count;
    const wx = spin ? spin[0] : 0, wy = spin ? spin[1] : 0, wz = spin ? spin[2] : 0;
    for (let p = 0; p < x.length; p += 3) {
      const dx = x[p] - cx, dy = x[p + 1] - cy, dz = x[p + 2] - cz;
      vel[p] = v[0] + wy * dz - wz * dy;
      vel[p + 1] = v[1] + wz * dx - wx * dz;
      vel[p + 2] = v[2] + wx * dy - wy * dx;
    }
    this.wake();
  }

  // ---------------------------------------------------------------- interaction

  pin(index: number, target: V3, strength = 1) {
    if (!(index >= 0 && index < this.count) || !finite3(target)) return;
    if (!(strength > 0)) return this.unpin(index);
    const s = Math.min(1, strength);
    const p = index * 3;
    if (this.pinStrength[index] === 0) {
      this.pinList[this.pinCount++] = index;
      // start the pin where the particle is, so a grab eases in over the frame
      this.pinFrom[p] = this.positions[p];
      this.pinFrom[p + 1] = this.positions[p + 1];
      this.pinFrom[p + 2] = this.positions[p + 2];
    }
    this.pinStrength[index] = s;
    this.invMass[index] = s >= HARD ? 0 : 1;
    this.pinTo[p] = target[0];
    this.pinTo[p + 1] = target[1];
    this.pinTo[p + 2] = target[2];
    this.wake();
  }

  unpin(index: number) {
    if (!(index >= 0 && index < this.count) || this.pinStrength[index] === 0) return;
    this.pinStrength[index] = 0;
    this.invMass[index] = 1;
    for (let k = 0; k < this.pinCount; k++) {
      if (this.pinList[k] === index) {
        this.pinList[k] = this.pinList[--this.pinCount];
        break;
      }
    }
  }

  unpinAll() {
    for (let k = 0; k < this.pinCount; k++) {
      const i = this.pinList[k];
      this.pinStrength[i] = 0;
      this.invMass[i] = 1;
    }
    this.pinCount = 0;
  }

  attach(center: V3, right: V3, up: V3, weight: number) {
    if (!finite3(center) || !finite3(right) || !finite3(up) || !(weight > 0)) return this.detach();
    const t = this.attachTo;
    t[0] = center[0]; t[1] = center[1]; t[2] = center[2];
    t[3] = right[0]; t[4] = right[1]; t[5] = right[2];
    t[6] = up[0]; t[7] = up[1]; t[8] = up[2];
    if (!this.attachOn) this.attachFrom.set(t);
    this.attachOn = true;
    this.attachWeight = Math.min(1, weight);
    this.wake();
  }

  detach() {
    this.attachOn = false;
  }

  crumple(center: V3, amount: number) {
    if (!finite3(center) || !(amount > 0)) return;
    if (!this.crumpleOff) this.crumpleOff = this.makeCrumpleTargets();
    this.crumpleAt[0] = center[0];
    this.crumpleAt[1] = center[1];
    this.crumpleAt[2] = center[2];
    this.crumpleAmount = Math.min(1, amount);
    this.crumpleFresh = true;
    this.wake();
  }

  nearest(p: V3): { index: number; dist: number } {
    const x = this.positions;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const dx = x[i * 3] - p[0], dy = x[i * 3 + 1] - p[1], dz = x[i * 3 + 2] - p[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return { index: best, dist: Math.sqrt(bestD) };
  }

  centroid(): V3 {
    const x = this.positions;
    let cx = 0, cy = 0, cz = 0;
    for (let p = 0; p < x.length; p += 3) { cx += x[p]; cy += x[p + 1]; cz += x[p + 2]; }
    return [cx / this.count, cy / this.count, cz / this.count];
  }

  private wake() {
    this.sleeping = false;
    this.stillFor = 0;
  }

  // A smooth random map from the sheet into a ball, plus jitter: neighbours get
  // nearby targets, so the paper folds into a ball instead of fighting itself.
  private makeCrumpleTargets() {
    const { qx, qy, radius } = this.topo;
    const r = rng(this.seed * 7919 + 17);
    const waves: number[] = [];
    for (let k = 0; k < 12; k++) {
      const a = r() * Math.PI * 2;
      const f = (1.2 + r() * 2.2) / radius;
      waves.push(Math.cos(a) * f, Math.sin(a) * f, r() * Math.PI * 2);
    }
    const out = new Float32Array(this.count * 3);
    let max = 0;
    for (let i = 0; i < this.count; i++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) {
          const w = (c * 4 + k) * 3;
          s += Math.sin(qx[i] * waves[w] + qy[i] * waves[w + 1] + waves[w + 2]);
        }
        out[i * 3 + c] = s * 0.5 + (r() - 0.5) * 0.35;
      }
      max = Math.max(max, Math.hypot(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]));
    }
    // push towards a thick shell: a paper ball is mostly surface
    for (let i = 0; i < this.count; i++) {
      const p = i * 3;
      const l = Math.hypot(out[p], out[p + 1], out[p + 2]) || 1;
      const s = (0.45 + 0.55 * (l / max)) / l;
      out[p] *= s; out[p + 1] *= s; out[p + 2] *= s;
    }
    return out;
  }

  // ---------------------------------------------------------------- simulation

  step(dt: number, env: PaperEnv) {
    if (!(dt > 0)) return;
    const P = PAPER;
    const frameDt = Math.min(dt, P.substep * P.maxSubsteps);
    const n = Math.min(P.maxSubsteps, Math.max(1, Math.ceil(frameDt / (P.substep * 1.15))));
    const h = frameDt / n;

    this.trackColliders(env.colliders, dt);

    // a squeeze lasts only as long as crumple() keeps being called
    const squeeze = this.crumpleFresh ? this.crumpleAmount : 0;
    this.crumpleFresh = false;
    if (squeeze > 0) {
      this.relax = Math.max(this.relax, squeeze);
      this.wrinkle += (1 - this.wrinkle) * (1 - Math.exp(-P.wrinkleRate * squeeze * frameDt));
      this.setCreases(squeeze, frameDt);
    } else this.relax = Math.max(0, this.relax - frameDt / P.relaxTime);

    if (this.sleeping) {
      if (!this.shouldWake(env)) return;
      this.wake();
    }

    this.followTeleports();
    for (let s = 0; s < n; s++) {
      this.time += h;
      this.substep(h, (s + 1) / n, env, squeeze);
    }
    for (let k = 0; k < this.pinCount; k++) {
      const p = this.pinList[k] * 3;
      this.pinFrom[p] = this.pinTo[p];
      this.pinFrom[p + 1] = this.pinTo[p + 1];
      this.pinFrom[p + 2] = this.pinTo[p + 2];
    }
    if (this.attachOn) this.attachFrom.set(this.attachTo);
    this.computeNormals();
    this.updateSleep(env, frameDt, squeeze);
  }

  private substep(h: number, f: number, env: PaperEnv, squeeze: number) {
    const P = PAPER;
    const t = this.topo;
    const n = this.count;
    const x = this.positions;
    const v = this.vel;
    const prev = this.prev;
    const w = this.invMass;
    const pinS = this.pinStrength;
    const pinFrom = this.pinFrom;
    const pinTo = this.pinTo;

    this.rigidMotion();
    const rb = this.rb;
    const cx = rb[0], cy = rb[1], cz = rb[2];
    this.computeAero(h, env);

    // ---- integrate
    const gx = env.gravity[0], gy = env.gravity[1], gz = env.gravity[2];
    const kd = 1 - Math.exp(-P.deformDamping * h);
    const damp = Math.exp(-P.damping * h);
    const vcx = rb[3], vcy = rb[4], vcz = rb[5], wx = rb[6], wy = rb[7], wz = rb[8];
    const aF = this.aeroF;
    const aW = this.aeroW;
    const qx = t.qx;
    const qy = t.qy;
    // first moments for the shape match: A = Σ x qᵀ (rest centroid is 0)
    let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < n; i++) {
      const p = i * 3;
      prev[p] = x[p];
      prev[p + 1] = x[p + 1];
      prev[p + 2] = x[p + 2];
      if (w[i] === 0) {
        // hard pin: glide along the frame's path so fast hands drag smoothly
        x[p] = pinFrom[p] + (pinTo[p] - pinFrom[p]) * f;
        x[p + 1] = pinFrom[p + 1] + (pinTo[p + 1] - pinFrom[p + 1]) * f;
        x[p + 2] = pinFrom[p + 2] + (pinTo[p + 2] - pinFrom[p + 2]) * f;
      } else {
        let vx = v[p], vy = v[p + 1], vz = v[p + 2];
        const aw = aW[i] > 0 ? 1 / aW[i] : 0;
        vx += (gx + aF[p] * aw) * h;
        vy += (gy + aF[p + 1] * aw) * h;
        vz += (gz + aF[p + 2] * aw) * h;
        // pull towards the rigid motion: kills wobble, keeps the fall and the spin
        const rx = x[p] - cx, ry = x[p + 1] - cy, rz = x[p + 2] - cz;
        vx += kd * (vcx + wy * rz - wz * ry - vx);
        vy += kd * (vcy + wz * rx - wx * rz - vy);
        vz += kd * (vcz + wx * ry - wy * rx - vz);
        vx *= damp;
        vy *= damp;
        vz *= damp;
        x[p] += vx * h;
        x[p + 1] += vy * h;
        x[p + 2] += vz * h;
      }
      sx += x[p]; sy += x[p + 1]; sz += x[p + 2];
      ax += x[p] * qx[i]; ay += x[p + 1] * qx[i]; az += x[p + 2] * qx[i];
      bx += x[p] * qy[i]; by += x[p + 1] * qy[i]; bz += x[p + 2] * qy[i];
    }

    // ---- constraints
    const soft = 1 - this.relax;
    const bend = P.bend * soft * (1 - 0.5 * this.wrinkle);
    const crease = Math.min(1, this.wrinkle * 2) * t.spacing;
    const iters = Math.max(1, this.iterations | 0);
    for (let it = 0; it < iters; it++) {
      const rev = (it & 1) === 1;
      solveDistances(x, w, t.pairs, t.rest, 0, t.nStruct, P.stretch, rev);
      solveDistances(x, w, t.pairs, t.rest, t.nStruct, t.rest.length, P.shear, rev);
      if (bend > 0) solveBending(x, w, t.trip, this.kappa, this.normals, bend, crease);
    }
    if (this.pinCount > 0) this.tether();

    // ---- global shape match: pull towards the best rigid fit of the flat sheet
    const shape = (1 - Math.exp(-P.shapeMatch * h)) * soft * (1 - P.wrinkleSoften * this.wrinkle);
    if (shape > 0) {
      const ic = 1 / n;
      sx *= ic; sy *= ic; sz *= ic;
      if (this.fitRotation(ax, ay, az, bx, by, bz)) {
        const fr = this.frame;
        const cb = P.camber;
        const bow = this.bow;
        const nx = (fr[1] * fr[5] - fr[2] * fr[4]) * cb, ny = (fr[2] * fr[3] - fr[0] * fr[5]) * cb, nz = (fr[0] * fr[4] - fr[1] * fr[3]) * cb;
        for (let i = 0; i < n; i++) {
          if (w[i] === 0) continue;
          const p = i * 3;
          const b = bow[i];
          x[p] += shape * (sx + fr[0] * qx[i] + fr[3] * qy[i] + nx * b - x[p]);
          x[p + 1] += shape * (sy + fr[1] * qx[i] + fr[4] * qy[i] + ny * b - x[p + 1]);
          x[p + 2] += shape * (sz + fr[2] * qx[i] + fr[5] * qy[i] + nz * b - x[p + 2]);
        }
      }
    }

    // ---- attach to a rigid pose (palm, stand)
    if (this.attachOn) {
      const a0 = this.attachFrom;
      const a1 = this.attachTo;
      const ocx = a0[0] + (a1[0] - a0[0]) * f, ocy = a0[1] + (a1[1] - a0[1]) * f, ocz = a0[2] + (a1[2] - a0[2]) * f;
      const orx = a0[3] + (a1[3] - a0[3]) * f, ory = a0[4] + (a1[4] - a0[4]) * f, orz = a0[5] + (a1[5] - a0[5]) * f;
      const oux = a0[6] + (a1[6] - a0[6]) * f, ouy = a0[7] + (a1[7] - a0[7]) * f, ouz = a0[8] + (a1[8] - a0[8]) * f;
      const k = 1 - Math.exp(-P.attachRate * this.attachWeight * h);
      const fall = P.attachFalloff;
      const qr2 = t.qr2;
      for (let i = 0; i < n; i++) {
        if (w[i] === 0) continue;
        const p = i * 3;
        const s = k * (1 - fall * qr2[i]);
        x[p] += s * (ocx + orx * qx[i] + oux * qy[i] - x[p]);
        x[p + 1] += s * (ocy + ory * qx[i] + ouy * qy[i] - x[p + 1]);
        x[p + 2] += s * (ocz + orz * qx[i] + ouz * qy[i] - x[p + 2]);
      }
    }

    // ---- fist
    if (squeeze > 0 && this.crumpleOff) {
      const o = this.crumpleOff;
      const k = 1 - Math.exp(-P.crumpleRate * squeeze * h);
      // the ball shrinks as the squeeze tightens
      const R = P.crumpleRadius + (1 - squeeze) * (1 - squeeze) * t.radius;
      const ccx = this.crumpleAt[0], ccy = this.crumpleAt[1], ccz = this.crumpleAt[2];
      for (let i = 0; i < n; i++) {
        if (w[i] === 0) continue;
        const p = i * 3;
        x[p] += k * (ccx + o[p] * R - x[p]);
        x[p + 1] += k * (ccy + o[p + 1] * R - x[p + 1]);
        x[p + 2] += k * (ccz + o[p + 2] * R - x[p + 2]);
      }
    }

    // ---- soft pins
    for (let k = 0; k < this.pinCount; k++) {
      const i = this.pinList[k];
      const s = pinS[i];
      if (s >= HARD) continue;
      const p = i * 3;
      const a = 1 - Math.pow(1 - s, h * 120);
      x[p] += a * (pinFrom[p] + (pinTo[p] - pinFrom[p]) * f - x[p]);
      x[p + 1] += a * (pinFrom[p + 1] + (pinTo[p + 1] - pinFrom[p + 1]) * f - x[p + 1]);
      x[p + 2] += a * (pinFrom[p + 2] + (pinTo[p + 2] - pinFrom[p + 2]) * f - x[p + 2]);
    }

    // ---- collisions
    this.collide(env, h);

    // ---- velocities from positions, with a hard speed limit and a NaN guard
    const ih = 1 / h;
    const vmax2 = P.maxSpeed * P.maxSpeed;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const p = i * 3;
      let vx = (x[p] - prev[p]) * ih;
      let vy = (x[p + 1] - prev[p + 1]) * ih;
      let vz = (x[p + 2] - prev[p + 2]) * ih;
      const s2 = vx * vx + vy * vy + vz * vz;
      if (!(s2 <= vmax2)) {
        if (s2 > vmax2) {
          const s = P.maxSpeed / Math.sqrt(s2);
          vx *= s; vy *= s; vz *= s;
          if (w[i] !== 0) {
            x[p] = prev[p] + vx * h;
            x[p + 1] = prev[p + 1] + vy * h;
            x[p + 2] = prev[p + 2] + vz * h;
          }
        } else {
          // NaN crept in: put the particle back where it was, at rest
          vx = vy = vz = 0;
          x[p] = prev[p];
          x[p + 1] = prev[p + 1];
          x[p + 2] = prev[p + 2];
        }
      }
      v[p] = vx;
      v[p + 1] = vy;
      v[p + 2] = vz;
      sum += Math.sqrt(vx * vx + vy * vy + vz * vz);
    }
    this.speed = sum / n;
  }

  /** centroid, mean velocity and angular velocity (ω = I⁻¹L) of the particles */
  private rigidMotion() {
    const x = this.positions;
    const v = this.vel;
    const n = this.count;
    let sx = 0, sy = 0, sz = 0, svx = 0, svy = 0, svz = 0;
    let lx = 0, ly = 0, lz = 0;
    let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
    for (let p = 0; p < n * 3; p += 3) {
      const px = x[p], py = x[p + 1], pz = x[p + 2];
      const vx = v[p], vy = v[p + 1], vz = v[p + 2];
      sx += px; sy += py; sz += pz;
      svx += vx; svy += vy; svz += vz;
      lx += py * vz - pz * vy;
      ly += pz * vx - px * vz;
      lz += px * vy - py * vx;
      xx += px * px; yy += py * py; zz += pz * pz;
      xy += px * py; xz += px * pz; yz += py * pz;
    }
    const ic = 1 / n;
    const cx = sx * ic, cy = sy * ic, cz = sz * ic;
    const vx = svx * ic, vy = svy * ic, vz = svz * ic;
    // about the centroid
    lx = (lx - n * (cy * vz - cz * vy)) * ic;
    ly = (ly - n * (cz * vx - cx * vz)) * ic;
    lz = (lz - n * (cx * vy - cy * vx)) * ic;
    xx = xx * ic - cx * cx; yy = yy * ic - cy * cy; zz = zz * ic - cz * cz;
    xy = xy * ic - cx * cy; xz = xz * ic - cx * cz; yz = yz * ic - cy * cz;
    // inertia tensor I = tr(C)·E − C
    const a = yy + zz, b = xx + zz, c = xx + yy, d = -xy, e = -xz, g = -yz;
    const c00 = b * c - g * g, c01 = e * g - d * c, c02 = d * g - e * b;
    const det = a * c00 + d * c01 + e * c02;
    const rb = this.rb;
    rb[0] = cx; rb[1] = cy; rb[2] = cz;
    rb[3] = vx; rb[4] = vy; rb[5] = vz;
    if (Math.abs(det) > 1e-12 * (a + b + c) ** 3 && det !== 0) {
      const c11 = a * c - e * e, c12 = d * e - a * g, c22 = a * b - d * d;
      const id = 1 / det;
      rb[6] = (c00 * lx + c01 * ly + c02 * lz) * id;
      rb[7] = (c01 * lx + c11 * ly + c12 * lz) * id;
      rb[8] = (c02 * lx + c12 * ly + c22 * lz) * id;
    } else rb[6] = rb[7] = rb[8] = 0;
  }

  /**
   * Polar decomposition of the 3×2 moment matrix [a b] = R·S: R's columns are the
   * sheet's best-fit right and up. Closed form via the 2×2 square root of AᵀA.
   */
  private fitRotation(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    // remove the centroid term: A = Σ x qᵀ − c Σ qᵀ, and Σ q = 0, so A is already central
    const m00 = ax * ax + ay * ay + az * az;
    const m11 = bx * bx + by * by + bz * bz;
    const m01 = ax * bx + ay * by + az * bz;
    const det = m00 * m11 - m01 * m01;
    if (!(det > 1e-10 * (m00 + m11) * (m00 + m11))) return true; // degenerate: keep last frame
    const s = Math.sqrt(det);
    const tr = Math.sqrt(m00 + m11 + 2 * s);
    // S = (M + sE)/tr, S⁻¹ = adj(S)/det(S), det(S) = s
    const s00 = (m00 + s) / tr, s11 = (m11 + s) / tr, s01 = m01 / tr;
    const i00 = s11 / s, i11 = s00 / s, i01 = -s01 / s;
    const fr = this.frame;
    fr[0] = ax * i00 + bx * i01; fr[1] = ay * i00 + by * i01; fr[2] = az * i00 + bz * i01;
    fr[3] = ax * i01 + bx * i11; fr[4] = ay * i01 + by * i11; fr[5] = az * i01 + bz * i11;
    return true;
  }

  /** long-range attachments (Kim et al. 2012): nothing can be further from a pin than it is on the flat sheet */
  private tether() {
    const x = this.positions;
    const w = this.invMass;
    const { qx, qy } = this.topo;
    for (let k = 0; k < this.pinCount; k++) {
      const pi = this.pinList[k];
      const s = this.pinStrength[pi];
      const pp = pi * 3;
      const px = x[pp], py = x[pp + 1], pz = x[pp + 2];
      const pqx = qx[pi], pqy = qy[pi];
      for (let i = 0; i < this.count; i++) {
        if (w[i] === 0) continue;
        const p = i * 3;
        const dx = x[p] - px, dy = x[p + 1] - py, dz = x[p + 2] - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        const ex = qx[i] - pqx, ey = qy[i] - pqy;
        const r2 = ex * ex + ey * ey;
        if (d2 <= r2) continue;
        const k2 = s * (1 - Math.sqrt(r2 / d2));
        x[p] -= dx * k2;
        x[p + 1] -= dy * k2;
        x[p + 2] -= dz * k2;
      }
    }
  }

  // ------------------------------------------------------------- air

  private computeAero(h: number, env: PaperEnv) {
    const P = PAPER;
    const x = this.positions;
    const v = this.vel;
    const F = this.aeroF;
    const W = this.aeroW;
    F.fill(0);
    W.fill(0);
    const idx = this.topo.indices;
    const rb = this.rb;
    const cx = rb[0], cy = rb[1], cz = rb[2];
    const c1 = P.dragLinear, c2 = P.dragNormal, ct = P.dragTangent, cl = P.lift;
    const lead = P.leadingEdge;
    // chord of the sheet along a direction, from its best-fit frame: |t·right|·W + |t·up|·H
    const fr = this.frame;
    const SW = this.topo.width, SH = this.topo.height;
    const kmax = 1 / h; // never more than stops the face-on motion in one substep

    // gusts: a slowly wandering breeze plus a shear across the sheet (wind along d,
    // varying along e) — the shear is what nudges a sheet into rocking whatever its pose
    const T = this.time, ph = this.gustPhase, A = this.turbulence;
    const gwx = env.wind[0] + A * (Math.sin(T * 1.3 + ph[0]) + 0.5 * Math.sin(T * 2.9 + ph[1]));
    const gwy = env.wind[1] + A * 0.6 * Math.sin(T * 1.7 + ph[2]);
    const gwz = env.wind[2] + A * (Math.sin(T * 1.1 + ph[3]) + 0.5 * Math.sin(T * 2.3 + ph[4]));
    const shear = A * P.gustShear * Math.sin(T * 2.1 + ph[5]);
    let ex = Math.sin(T * 0.37 + ph[6]), ey = Math.sin(T * 0.29 + ph[7]), ez = Math.cos(T * 0.41 + ph[6]);
    let dx = Math.cos(T * 0.31 + ph[7]), dy = Math.sin(T * 0.43 + ph[5]), dz = Math.sin(T * 0.23 + ph[4]);
    const el = 1 / Math.sqrt(ex * ex + ey * ey + ez * ez), dl = shear / Math.sqrt(dx * dx + dy * dy + dz * dz);
    ex *= el; ey *= el; ez *= el;
    dx *= dl; dy *= dl; dz *= dl;

    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
      const e1x = x[b] - x[a], e1y = x[b + 1] - x[a + 1], e1z = x[b + 2] - x[a + 2];
      const e2x = x[c] - x[a], e2y = x[c + 1] - x[a + 1], e2z = x[c + 2] - x[a + 2];
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-12) continue;
      const area = 0.5 * len;
      nx /= len; ny /= len; nz /= len;
      // triangle centre relative to the sheet's centroid
      const tx = (x[a] + x[b] + x[c]) / 3 - cx;
      const ty = (x[a + 1] + x[b + 1] + x[c + 1]) / 3 - cy;
      const tz = (x[a + 2] + x[b + 2] + x[c + 2]) / 3 - cz;
      const se = tx * ex + ty * ey + tz * ez;
      const ux = (v[a] + v[b] + v[c]) / 3 - gwx - se * dx;
      const uy = (v[a + 1] + v[b + 1] + v[c + 1]) / 3 - gwy - se * dy;
      const uz = (v[a + 2] + v[b + 2] + v[c + 2]) / 3 - gwz - se * dz;
      const vn = ux * nx + uy * ny + uz * nz;
      const vtx = ux - vn * nx, vty = uy - vn * ny, vtz = uz - vn * nz;
      const vt2 = vtx * vtx + vty * vty + vtz * vtz;
      // centre of pressure sits ahead of the middle when the air slides across the face
      let lw = 1;
      let vt = 0;
      if (vt2 > 1e-10) {
        vt = Math.sqrt(vt2);
        const chord = (Math.abs(vtx * fr[0] + vty * fr[1] + vtz * fr[2]) * SW + Math.abs(vtx * fr[3] + vty * fr[4] + vtz * fr[5]) * SH) / vt;
        lw = 1 + (lead * (tx * vtx + ty * vty + tz * vtz)) / ((chord + 1e-6) * Math.sqrt(vt2 + vn * vn));
        lw = lw < 0 ? 0 : lw > 2.5 ? 2.5 : lw;
      }
      let kn = (c1 + c2 * Math.abs(vn) + cl * vt) * lw;
      if (kn > kmax) kn = kmax;
      const fx = (-kn * vn * nx - ct * vtx) * area;
      const fy = (-kn * vn * ny - ct * vty) * area;
      const fz = (-kn * vn * nz - ct * vtz) * area;
      F[a] += fx; F[a + 1] += fy; F[a + 2] += fz;
      F[b] += fx; F[b + 1] += fy; F[b + 2] += fz;
      F[c] += fx; F[c + 1] += fy; F[c + 2] += fz;
      W[a / 3] += area;
      W[b / 3] += area;
      W[c / 3] += area;
    }
  }

  // ------------------------------------------------------------- contacts

  private trackColliders(cols: Collider[], dt: number) {
    const m = Math.min(cols.length, MAX_COLLIDERS);
    for (let k = 0; k < m; k++) {
      const c = cols[k];
      const p = k * 3;
      const given = (c as { velocity?: V3 }).velocity;
      if (given && finite3(given)) {
        this.colVel[p] = given[0];
        this.colVel[p + 1] = given[1];
        this.colVel[p + 2] = given[2];
      } else if (this.colKinds[k] === c.kind && dt > 0) {
        // the contract has no collider velocity; infer it, so a moving palm carries what it holds
        let vx = (c.center[0] - this.colPrev[p]) / dt;
        let vy = (c.center[1] - this.colPrev[p + 1]) / dt;
        let vz = (c.center[2] - this.colPrev[p + 2]) / dt;
        if (!(vx * vx + vy * vy + vz * vz < PAPER.maxSpeed * PAPER.maxSpeed)) vx = vy = vz = 0;
        this.colVel[p] = vx;
        this.colVel[p + 1] = vy;
        this.colVel[p + 2] = vz;
      } else {
        this.colVel[p] = this.colVel[p + 1] = this.colVel[p + 2] = 0;
      }
      this.colPrev[p] = c.center[0];
      this.colPrev[p + 1] = c.center[1];
      this.colPrev[p + 2] = c.center[2];
      this.colKinds[k] = c.kind;
    }
    this.colKinds.length = m;
  }

  private collide(env: PaperEnv, h: number) {
    const P = PAPER;
    const x = this.positions;
    const prev = this.prev;
    const w = this.invMass;
    const n = this.count;
    const floor = env.floorY + this.floorLift;
    const mu = P.floorFriction;
    let floorHits = 0;
    for (let i = 0; i < n; i++) {
      const p = i * 3;
      if (w[i] === 0 || x[p + 1] >= floor) continue;
      const pen = floor - x[p + 1];
      x[p + 1] = floor;
      floorHits++;
      // Coulomb friction: the push-out depth bounds how much sliding it can stop
      const dx = x[p] - prev[p], dz = x[p + 2] - prev[p + 2];
      const slide = Math.sqrt(dx * dx + dz * dz);
      if (slide <= mu * pen) {
        x[p] = prev[p];
        x[p + 2] = prev[p + 2];
      } else {
        const s = (mu * pen) / slide;
        x[p] -= dx * s;
        x[p + 2] -= dz * s;
      }
    }
    this.floorContacts = floorHits;

    let hits = 0;
    const cols = env.colliders;
    const m = Math.min(cols.length, MAX_COLLIDERS);
    const margin = P.contactMargin;
    for (let k = 0; k < m; k++) {
      const c = cols[k];
      const ccx = c.center[0], ccy = c.center[1], ccz = c.center[2];
      // collider motion during this substep, for friction that carries paper along
      const mvx = this.colVel[k * 3] * h, mvy = this.colVel[k * 3 + 1] * h, mvz = this.colVel[k * 3 + 2] * h;
      const cmu = c.friction;
      if (c.kind === 'disk') {
        let nx = c.normal[0], ny = c.normal[1], nz = c.normal[2];
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!(nl > 1e-9)) continue;
        nx /= nl; ny /= nl; nz /= nl;
        const r2 = c.radius * c.radius;
        const depth = P.diskDepth;
        for (let i = 0; i < n; i++) {
          if (w[i] === 0) continue;
          const p = i * 3;
          const dx = x[p] - ccx, dy = x[p + 1] - ccy, dz = x[p + 2] - ccz;
          const d = dx * nx + dy * ny + dz * nz;
          if (!(d < margin)) continue;
          // accept particles in a slab behind the disk, or fast ones that crossed it this substep
          if (d < -depth && (prev[p] - ccx) * nx + (prev[p + 1] - ccy) * ny + (prev[p + 2] - ccz) * nz < 0) continue;
          const t2 = dx * dx + dy * dy + dz * dz - d * d;
          if (t2 > r2) continue;
          const pen = margin - d;
          x[p] += nx * pen;
          x[p + 1] += ny * pen;
          x[p + 2] += nz * pen;
          friction(x, prev, p, nx, ny, nz, mvx, mvy, mvz, cmu * pen);
          hits++;
        }
      } else {
        const R = c.radius + margin;
        const R2 = R * R;
        for (let i = 0; i < n; i++) {
          if (w[i] === 0) continue;
          const p = i * 3;
          const dx = x[p] - ccx, dy = x[p + 1] - ccy, dz = x[p + 2] - ccz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (!(d2 < R2)) continue;
          const d = Math.sqrt(d2);
          // dead centre: any direction will do, up is the kindest
          const nx = d > 1e-9 ? dx / d : 0, ny = d > 1e-9 ? dy / d : 1, nz = d > 1e-9 ? dz / d : 0;
          const pen = R - d;
          x[p] += nx * pen;
          x[p + 1] += ny * pen;
          x[p + 2] += nz * pen;
          friction(x, prev, p, nx, ny, nz, mvx, mvy, mvz, cmu * pen);
          hits++;
        }
      }
    }
    this.colliderContacts = hits;
  }

  // ------------------------------------------------------------- memory & rest

  /** while squeezed, the paper takes a set: joints remember part of their bend */
  private setCreases(squeeze: number, dt: number) {
    const P = PAPER;
    const t = this.topo;
    const x = this.positions;
    const nrm = this.normals;
    const kap = this.kappa;
    const trip = t.trip;
    const rate = 1 - Math.exp(-P.creaseYield * squeeze * dt);
    const lim = P.creaseMax;
    for (let k = 0, m = 0; k < trip.length; k += 3, m++) {
      const a = trip[k] * 3, b = trip[k + 1] * 3, c = trip[k + 2] * 3;
      const sag =
        (x[a] + x[c] - 2 * x[b]) * nrm[b] + (x[a + 1] + x[c + 1] - 2 * x[b + 1]) * nrm[b + 1] + (x[a + 2] + x[c + 2] - 2 * x[b + 2]) * nrm[b + 2];
      // stored in units of the grid spacing so it scales with the sheet
      let kk = kap[m] + (sag / t.spacing - kap[m]) * rate;
      kk = kk > lim ? lim : kk < -lim ? -lim : kk;
      kap[m] = kk;
    }
  }

  private computeNormals() {
    const x = this.positions;
    const nrm = this.normals;
    const idx = this.indices;
    nrm.fill(0);
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
      const e1x = x[b] - x[a], e1y = x[b + 1] - x[a + 1], e1z = x[b + 2] - x[a + 2];
      const e2x = x[c] - x[a], e2y = x[c + 1] - x[a + 1], e2z = x[c + 2] - x[a + 2];
      // unnormalised cross product = area-weighted
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
      nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
      nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
    }
    const fr = this.frame;
    for (let p = 0; p < nrm.length; p += 3) {
      const l = Math.sqrt(nrm[p] * nrm[p] + nrm[p + 1] * nrm[p + 1] + nrm[p + 2] * nrm[p + 2]);
      if (l > 1e-20) {
        nrm[p] /= l;
        nrm[p + 1] /= l;
        nrm[p + 2] /= l;
      } else {
        // folded flat onto itself: fall back to the sheet's overall facing
        nrm[p] = fr[1] * fr[5] - fr[2] * fr[4];
        nrm[p + 1] = fr[2] * fr[3] - fr[0] * fr[5];
        nrm[p + 2] = fr[0] * fr[4] - fr[1] * fr[3];
      }
    }
  }

  /** a jump bigger than any hand can make is a tracking glitch: carry the whole sheet with it */
  private followTeleports() {
    const lim2 = PAPER.teleport * PAPER.teleport;
    let jx = 0, jy = 0, jz = 0, jump = 0;
    for (let k = 0; k < this.pinCount; k++) {
      const p = this.pinList[k] * 3;
      const dx = this.pinTo[p] - this.pinFrom[p], dy = this.pinTo[p + 1] - this.pinFrom[p + 1], dz = this.pinTo[p + 2] - this.pinFrom[p + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > lim2 && d2 > jump) { jump = d2; jx = dx; jy = dy; jz = dz; }
    }
    if (this.attachOn) {
      const a0 = this.attachFrom, a1 = this.attachTo;
      const dx = a1[0] - a0[0], dy = a1[1] - a0[1], dz = a1[2] - a0[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > lim2 && d2 > jump) { jump = d2; jx = dx; jy = dy; jz = dz; }
    }
    if (jump === 0) return;
    const x = this.positions;
    for (let p = 0; p < x.length; p += 3) {
      x[p] += jx;
      x[p + 1] += jy;
      x[p + 2] += jz;
    }
    for (let k = 0; k < this.pinCount; k++) {
      const p = this.pinList[k] * 3;
      this.pinFrom[p] += jx;
      this.pinFrom[p + 1] += jy;
      this.pinFrom[p + 2] += jz;
    }
    if (this.attachOn) {
      this.attachFrom[0] += jx;
      this.attachFrom[1] += jy;
      this.attachFrom[2] += jz;
    }
  }

  private updateSleep(env: PaperEnv, dt: number, squeeze: number) {
    const P = PAPER;
    const busy = this.pinCount > 0 || this.attachOn || squeeze > 0 || this.relax > 0 || this.colliderContacts > 0;
    if (busy || this.floorContacts === 0 || this.speed > P.sleepSpeed) {
      this.stillFor = 0;
      return;
    }
    this.stillFor += dt;
    if (this.stillFor < P.sleepAfter) return;
    this.sleeping = true;
    this.vel.fill(0);
    const k = this.sleepKey;
    k[0] = env.floorY;
    k[1] = env.wind[0];
    k[2] = env.wind[1];
    k[3] = env.wind[2];
    k[4] = Math.hypot(env.gravity[0], env.gravity[1], env.gravity[2]);
    const c = this.centroid();
    const x = this.positions;
    let r2 = 0;
    for (let p = 0; p < x.length; p += 3) {
      r2 = Math.max(r2, (x[p] - c[0]) ** 2 + (x[p + 1] - c[1]) ** 2 + (x[p + 2] - c[2]) ** 2);
    }
    this.bound[0] = c[0];
    this.bound[1] = c[1];
    this.bound[2] = c[2];
    this.bound[3] = Math.sqrt(r2);
  }

  private shouldWake(env: PaperEnv) {
    const k = this.sleepKey;
    if (Math.abs(env.floorY - k[0]) > 1e-4) return true;
    if (Math.abs(env.wind[0] - k[1]) + Math.abs(env.wind[1] - k[2]) + Math.abs(env.wind[2] - k[3]) > 0.4) return true;
    if (Math.abs(Math.hypot(env.gravity[0], env.gravity[1], env.gravity[2]) - k[4]) > 1e-3) return true;
    const b = this.bound;
    for (const c of env.colliders) {
      const d = Math.hypot(c.center[0] - b[0], c.center[1] - b[1], c.center[2] - b[2]);
      if (d < b[3] + c.radius + 0.1) return true;
    }
    return false;
  }
}

// ------------------------------------------------------------------ solvers

function finite3(v: ArrayLike<number>) {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

function solveDistances(x: Float32Array, w: Float32Array, pairs: Uint16Array, rest: Float32Array, from: number, to: number, k: number, rev: boolean) {
  const step = rev ? -1 : 1;
  for (let c = rev ? to - 1 : from; rev ? c >= from : c < to; c += step) {
    const ia = pairs[c * 2], ib = pairs[c * 2 + 1];
    const wa = w[ia], wb = w[ib];
    const ws = wa + wb;
    if (ws === 0) continue;
    const a = ia * 3, b = ib * 3;
    const dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-9) continue;
    const s = (k * (d - rest[c])) / (d * ws);
    const sa = s * wa, sb = s * wb;
    x[a] += dx * sa; x[a + 1] += dy * sa; x[a + 2] += dz * sa;
    x[b] -= dx * sb; x[b + 1] -= dy * sb; x[b + 2] -= dz * sb;
  }
}

// Linear bending on three particles along a row/column: C = xa − 2xb + xc − crease·n.
// Zero for any straight, evenly spaced triple, so it's rotation-invariant and needs no sqrt.
function solveBending(x: Float32Array, w: Float32Array, trip: Uint16Array, kappa: Float32Array, nrm: Float32Array, k: number, crease: number) {
  for (let t = 0, m = 0; t < trip.length; t += 3, m++) {
    const ia = trip[t], ib = trip[t + 1], ic = trip[t + 2];
    const wa = w[ia], wb = w[ib], wc = w[ic];
    const den = wa + 4 * wb + wc;
    if (den === 0) continue;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const kc = kappa[m] * crease;
    const cx = x[a] + x[c] - 2 * x[b] - kc * nrm[b];
    const cy = x[a + 1] + x[c + 1] - 2 * x[b + 1] - kc * nrm[b + 1];
    const cz = x[a + 2] + x[c + 2] - 2 * x[b + 2] - kc * nrm[b + 2];
    const l = k / den;
    const la = l * wa, lb = 2 * l * wb, lc = l * wc;
    x[a] -= cx * la; x[a + 1] -= cy * la; x[a + 2] -= cz * la;
    x[b] += cx * lb; x[b + 1] += cy * lb; x[b + 2] += cz * lb;
    x[c] -= cx * lc; x[c + 1] -= cy * lc; x[c + 2] -= cz * lc;
  }
}

/** PBD Coulomb friction against a surface moving by (mx,my,mz) this substep; `limit` = μ·penetration */
function friction(x: Float32Array, prev: Float32Array, p: number, nx: number, ny: number, nz: number, mx: number, my: number, mz: number, limit: number) {
  const rx = x[p] - prev[p] - mx, ry = x[p + 1] - prev[p + 1] - my, rz = x[p + 2] - prev[p + 2] - mz;
  const rn = rx * nx + ry * ny + rz * nz;
  const tx = rx - rn * nx, ty = ry - rn * ny, tz = rz - rn * nz;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (tl < 1e-12) return;
  const s = tl <= limit ? 1 : limit / tl;
  x[p] -= tx * s;
  x[p + 1] -= ty * s;
  x[p + 2] -= tz * s;
}
