// A banknote as a position-based particle grid (Müller et al. 2007), run as small
// fixed-size substeps (the XPBD "small steps" lesson: more substeps beat more iterations).
//
// What makes it PAPER rather than cloth:
//  - distance constraints (rows, columns, one diagonal per quad) keep it from stretching;
//  - a soft global shape match pulls it toward the best-fit rigid pose of its rest shape,
//    which gives the whole sheet bending stiffness that doesn't depend on resolution or
//    iteration count — held by a corner it hangs nearly straight instead of draping;
//  - while held, constraints are solved outward from the fingers and a follow-the-leader
//    strain limiter caps every edge, so a yanked note never stretches like rubber.
// Air acts per triangle with the centre of pressure shifted toward the leading edge: that
// offset is what makes a dropped note rock and tumble like a leaf instead of falling flat.
// Nothing in step() allocates.

import type { Collider, PaperEnv, PaperSheetApi, SheetOptions, V3 } from '../contracts';
import { ASPECT } from '../note/layout';

/** Theatrical gravity: a note is 1 unit tall, so real g would be ~75 u/s². */
export const GRAVITY: V3 = [0, -7, 0];

/** Tuning. Mutable on purpose, so it can be live-tweaked from the console. Rates are per second. */
export const PAPER = {
  // solver
  substep: 1 / 120, // a frame runs n = ceil(dt / (substep·1.15)) equal substeps of ≤ ~substep
  maxSubsteps: 4, // frames longer than maxSubsteps·substep (tab switches) run in slow motion instead of exploding
  minStep: 0.004, // shorter frames (rAF firing twice) wait for the next: a hand's jump over 0.5 ms reads as 40 u/s
  freeSubstep: 1 / 60, // the substep for small sheets nothing is touching (falling rain looks the same, costs half)
  smallSheet: 300, // "small" = fewer particles than this; small sheets also do one fewer sweep
  iterations: 2, // stretch/shear sweeps per substep (big sheets)
  maxSpeed: 24, // world units/s per particle; tracking glitches can't fling paper faster than this
  teleport: 1.2, // a pin target jumping further than this in one frame carries the sheet rigidly

  // paper
  stretch: 1, // row/column stiffness per sweep (1 = inextensible)
  shear: 0.7, // diagonal stiffness per sweep
  bend: 0.5, // local smoothness (linear three-particle bending), every other substep
  shapeMatch: 3.5, // global stiffness: how fast bends relax back to the rest shape
  camber: 0.06, // a note's natural bow (sag at the ends); also gives edge-on air something to push
  deformDamping: 5, // damps flexing relative to the rigid motion (not the fall or the spin)
  damping: 0.08, // plain velocity damping

  // held (pinned)
  heldIterations: 3, // extra sweeps while pinned: the whole weight hangs off the fingers
  maxStretch: 0.01, // and no row/column edge ends a substep longer than this...
  limiterPasses: 4, // ...enforced this many times (a particle with two inner neighbours needs a few)
  pivotFriction: 1.5, // damps the note turning between the fingers, so it settles instead of swinging on
  releaseSpin: 3.5, // rad/s of twist a note gets when the last pin lets go, so it tips into a flutter

  // air
  dragNormal: 1.1, // quadratic face drag; terminal speed ≈ sqrt(|g| / dragNormal)
  dragLinear: 0.3, // linear face drag
  dragTangent: 0.25, // edgewise drag
  lift: 1.5, // thin-plate lift: face force ∝ edgewise speed × (u·n); notes glide and tip
  leadingEdge: 4, // centre-of-pressure shift toward the leading edge (3 ≈ quarter chord): the flutter
  turbulence: 0.6, // gusts on top of env.wind, world units/s (per-sheet copy: sheet.turbulence)
  gustShear: 3, // how much a gust varies across the sheet, per unit of distance, × turbulence

  // attach (palm, stand)
  attachRate: 34, // pull at weight 1
  attachFalloff: 0.85, // the edges are held this much less firmly than the middle, so they flex
  attachSpeed: 14, // fastest a note swoops toward a far-away pose, world units/s
  attachIterations: 1, // extra sweeps while attached: a palm swung fast flaps the loosely held edges
  attachTurn: 10, // fastest the pose it's pulled toward turns, rad/s: a palm normal that glitches
  // for a frame nudges the note instead of flipping it, and a newly caught note turns smoothly

  // fist
  crumpleRate: 14, // how fast a fist pulls the paper into a ball
  crumpleRadius: 0.2, // ball radius at amount 1
  wrinkleRate: 1.6, // how fast squeezing raises wrinkle toward 1
  relaxTime: 0.7, // seconds for stiffness to come back after a squeeze
  creaseDepth: 0.12, // how far the remembered creases stand out of plane at wrinkle 1
  wrinkleSoften: 0.65, // a fully wrinkled note keeps this much less shape memory

  // contacts
  floorFriction: 0.7,
  frictionDepth: 0.003, // push-out depth beyond which contacts grip no harder
  contactMargin: 0.008, // paper thickness kept off colliders
  separation: 0.5, // a push-out never sends paper away from a collider faster than this (u/s, relative):
  // deep overlaps are resolved in position, so a palm opening inside a note doesn't launch it

  // rest
  sleepSpeed: 0.03, // a sheet on the floor with rms speed below this for sleepAfter seconds stops simulating
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
  /** characteristic half-size (crumple ball, crease waves) */
  radius: number;
  /** half the flat sheet's diagonal: nothing is further than this from the centroid */
  halfDiagonal: number;
  indices: Uint16Array;
  uvs: Float32Array;
  /** 1 / (2 · rest triangle area): scales a cross product to ≈ a unit normal */
  normalScale: number;
  /** 1 / number of triangles touching each particle */
  invTris: Float32Array;
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
  // Constraints are listed in colour classes (every other edge, every third triple), so
  // neighbours in the list never share a particle: the CPU can overlap them instead of
  // waiting on each store, and Gauss-Seidel still sees fresh positions class to class.
  const pairs: number[] = [];
  const at = (i: number, j: number) => j * cols + i;
  for (let m = 0; m < 2; m++) for (let j = 0; j < rows; j++) for (let i = m; i < cols - 1; i += 2) pairs.push(at(i, j), at(i + 1, j));
  for (let m = 0; m < 2; m++) for (let j = m; j < rows - 1; j += 2) for (let i = 0; i < cols; i++) pairs.push(at(i, j), at(i, j + 1));
  const nStruct = pairs.length / 2;
  // shear: the diagonal each quad is split along (they alternate, so the sheet is rigid in-plane
  // without favouring a direction); the other diagonal would only add cost
  for (let m = 0; m < 2; m++) {
    for (let j = 0; j < rows - 1; j++) {
      for (let i = m; i < cols - 1; i += 2) {
        if (((i + j) & 1) === 0) pairs.push(at(i + 1, j), at(i, j + 1));
        else pairs.push(at(i, j), at(i + 1, j + 1));
      }
    }
  }
  const rest = new Float32Array(pairs.length / 2);
  for (let k = 0; k < rest.length; k++) {
    const a = pairs[k * 2];
    const b = pairs[k * 2 + 1];
    rest[k] = Math.hypot(qx[a] - qx[b], qy[a] - qy[b]);
  }
  const trip: number[] = [];
  for (let m = 0; m < 3; m++) for (let j = 0; j < rows; j++) for (let i = 1 + m; i < cols - 1; i += 3) trip.push(at(i - 1, j), at(i, j), at(i + 1, j));
  for (let m = 0; m < 3; m++) for (let j = 1 + m; j < rows - 1; j += 3) for (let i = 0; i < cols; i++) trip.push(at(i, j - 1), at(i, j), at(i, j + 1));
  const indices = gridIndices(cols, rows);
  const invTris = new Float32Array(count);
  for (let k = 0; k < indices.length; k++) invTris[indices[k]]++;
  for (let i = 0; i < count; i++) invTris[i] = 1 / invTris[i];
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
    halfDiagonal: Math.hypot(width, height) / 2,
    indices,
    uvs: gridUvs(cols, rows),
    normalScale: ((cols - 1) * (rows - 1)) / (width * height),
    invTris,
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
const CD = 15; // numbers per flattened collider (see trackColliders)
const HARD = 0.999;

export interface PaperSheetOptions extends SheetOptions {
  /** reproducible gusts / crumple pattern; defaults to a running counter */
  seed?: number;
  /** stretch/shear sweeps per substep; defaults to PAPER.iterations (one fewer for small sheets) */
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
  // Numeric fields that will hold fractions start at -0, not 0: 0 is a small integer to V8, and
  // the first fraction stored (a first landing, a first squeeze) would change the field's
  // representation, which throws away the optimised code of every sheet at once — a hitch.
  wrinkle = -0;

  readonly seed: number;
  iterations: number;
  /** gust strength on top of env.wind for this sheet (world units/s) */
  turbulence = PAPER.turbulence;
  /** rests this far above env.floorY, so a pile of notes doesn't z-fight */
  floorLift: number;
  /** rms particle speed after the last step, world units/s (drives the flutter sound) */
  speed = -0;
  /** particles touching a collider / the floor after the last step (catch & landing cues) */
  colliderContacts = 0;
  floorContacts = 0;
  /** at rest on the floor and not being simulated; any interaction wakes it */
  sleeping = false;

  private topo: Topology;
  // distance constraints in solve order: the shared colour order, or (while pinned) this
  // sheet's own copy sorted outward from the pins, so one sweep carries a yank across the sheet
  private pairs: Uint16Array;
  private rest: Float32Array;
  private pinOrder: { pairs: Uint16Array; rest: Float32Array; keys: Float32Array; idx: Uint32Array; dist: Float32Array; slip: Float32Array } | null = null;
  private vel: Float32Array;
  private prev: Float32Array;
  private invMass: Float32Array;
  private aeroA: Float64Array;
  /** remembered creases: a ridged out-of-plane pattern, scaled by wrinkle (null until first crumpled) */
  private creases: Float32Array | null = null;
  /** the rest shape's height off its plane: bow × camber + creases × depth × wrinkle */
  private restZ: Float32Array;
  private restZFor = [NaN, NaN, NaN]; // camber, wrinkle, crease depth it was built for
  /** the rest shape's in-plane scale: < 1 once creased (see updateRestZ) */
  private fp = -0; // set by updateRestZ before use
  /** this note's natural bow, out of plane, at camber = 1 (no real note is perfectly flat) */
  private bow: Float32Array;
  private crumpleOff: Float32Array | null = null;

  private pinStrength: Float32Array;
  private pinFrom: Float32Array;
  private pinTo: Float32Array;
  private pinList: Int32Array;
  private pinCount = 0;

  private attachOn = false;
  private attachWeight = -0;
  // poses as centre xyz + rotation quaternion wxyz: what the caller asked for, and the pose the
  // pull follows at the start and end of this frame (turned toward the request at ≤ attachTurn)
  private attachReq = new Float64Array(7);
  private attachFrom = new Float64Array(7);
  private attachTo = new Float64Array(7);
  private attachVel = new Float64Array(6); // the pose's linear & angular velocity this frame

  private crumpleAt = new Float64Array(3);
  private crumpleAmount = -0;
  private crumpleFresh = false;
  private relax = -0;

  // rigid motion of the sheet: centroid, mean velocity, angular velocity
  private rb = new Float64Array(9);
  // centroid, first moments Σ x·(qx, qy, restZ) and mean velocity at the end of the last substep
  private moments = new Float64Array(15);
  // the shape match's best-fit rotation (a quaternion, warm-started substep to substep)...
  private quat = new Float64Array([1, 0, 0, 0]);
  // ...and its first two columns: the sheet's right and up
  private frame = new Float64Array([1, 0, 0, 0, 1, 0]);
  private gustPhase: Float64Array;
  private rand: () => number;
  private time = -0;
  // this frame's numbers ride in a typed array: passed as arguments, a call that isn't inlined would
  // box every double (an allocation per call): substep h, fraction of the frame at the substep's end,
  // squeeze, fraction at its start, frame dt, floor height
  private sub = new Float64Array(6);
  private substeps = 0;
  private airValid = false;
  private owed = -0; // time from frames too short to step on their own

  private colData = new Float64Array(MAX_COLLIDERS * CD);
  private colSub = new Float64Array(MAX_COLLIDERS * 12); // active colliders posed at this substep's start & end
  private colActive = new Int32Array(MAX_COLLIDERS);
  private colKinds: string[] = [];
  private stillFor = -0;
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
    this.pairs = this.topo.pairs;
    this.rest = this.topo.rest;
    this.seed = opts.seed ?? nextSeed++;
    // small sheets converge in fewer sweeps (and there are many of them)
    this.iterations = opts.iterations ?? (this.count >= PAPER.smallSheet ? PAPER.iterations : Math.max(1, PAPER.iterations - 1));
    const n = this.count;
    this.positions = new Float32Array(n * 3);
    this.normals = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.invMass = new Float32Array(n).fill(1);
    this.aeroA = new Float64Array(n * 3);
    this.pinStrength = new Float32Array(n);
    this.pinFrom = new Float32Array(n * 3);
    this.pinTo = new Float32Array(n * 3);
    this.pinList = new Int32Array(n);
    const r = rng(this.seed * 2654435761);
    this.rand = r;
    this.gustPhase = Float64Array.from({ length: 8 }, () => r() * Math.PI * 2);
    this.floorLift = 0.002 + r() * 0.03;
    // a gentle cylindrical bow about a random axis: realistic, and it means air
    // meeting the note edge-on still finds something to push on, so it tips
    this.bow = new Float32Array(this.count);
    this.restZ = new Float32Array(this.count);
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
    const z = this.updateRestZ();
    const fp = this.footprint();
    for (let i = 0; i < this.count; i++) {
      const p = i * 3;
      const b = z[i], u = qx[i] * fp, s = qy[i] * fp;
      x[p] = center[0] + rx * u + ux * s + nx * b;
      x[p + 1] = center[1] + ry * u + uy * s + ny * b;
      x[p + 2] = center[2] + rz * u + uz * s + nz * b;
      this.normals[p] = nx;
      this.normals[p + 1] = ny;
      this.normals[p + 2] = nz;
    }
    this.prev.set(x);
    this.vel.fill(0);
    quatFromFrame(rx, ry, rz, ux, uy, uz, nx, ny, nz, this.quat, 0);
    this.frame[0] = rx; this.frame[1] = ry; this.frame[2] = rz;
    this.frame[3] = ux; this.frame[4] = uy; this.frame[5] = uz;
    this.crumpleFresh = false;
    this.crumpleAmount = 0;
    this.relax = 0;
    // hard pins keep their particle where the pin is, not where the sheet was
    for (let k = 0; k < this.pinCount; k++) {
      const i = this.pinList[k];
      for (let c = 0; c < 3; c++) this.pinFrom[i * 3 + c] = this.pinTo[i * 3 + c];
    }
    this.wake();
    this.airValid = false;
  }

  setVelocity(v: V3, spin?: V3) {
    if (!finite3(v) || (spin && !finite3(spin))) return;
    const x = this.positions;
    const vel = this.vel;
    let cx = 0, cy = 0, cz = 0;
    for (let p = 0; p < x.length; p += 3) { cx += x[p]; cy += x[p + 1]; cz += x[p + 2]; }
    cx /= this.count; cy /= this.count; cz /= this.count;
    const wx = spin ? spin[0] : 0, wy = spin ? spin[1] : 0, wz = spin ? spin[2] : 0;
    const vmax = PAPER.maxSpeed;
    for (let p = 0; p < x.length; p += 3) {
      const dx = x[p] - cx, dy = x[p + 1] - cy, dz = x[p + 2] - cz;
      let ex = v[0] + wy * dz - wz * dy;
      let ey = v[1] + wz * dx - wx * dz;
      let ez = v[2] + wx * dy - wy * dx;
      // the same speed limit as the solver: a wild throw can't carry a note off the map in one frame
      const s = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (s > vmax) { const k = vmax / s; ex *= k; ey *= k; ez *= k; }
      vel[p] = ex;
      vel[p + 1] = ey;
      vel[p + 2] = ez;
    }
    this.wake();
    this.airValid = false;
  }

  // ---------------------------------------------------------------- interaction

  pin(index: number, target: V3, strength = 1) {
    if (!(index >= 0 && index < this.count) || !finite3(target)) return;
    if (!(strength > 0)) return this.unpin(index);
    const s = Math.min(1, strength);
    const p = index * 3;
    const fresh = this.pinStrength[index] === 0;
    if (fresh) {
      this.pinList[this.pinCount++] = index;
      // start the pin where the particle is, so a grab eases in over the frame
      this.pinFrom[p] = this.positions[p];
      this.pinFrom[p + 1] = this.positions[p + 1];
      this.pinFrom[p + 2] = this.positions[p + 2];
    }
    const wasHard = this.invMass[index] === 0;
    this.pinStrength[index] = s;
    this.invMass[index] = s >= HARD ? 0 : 1;
    if (fresh || wasHard !== s >= HARD) this.sortFromPins();
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
    this.sortFromPins();
    if (this.pinCount === 0) this.releaseTwist();
  }

  unpinAll() {
    if (this.pinCount === 0) return;
    for (let k = 0; k < this.pinCount; k++) {
      const i = this.pinList[k];
      this.pinStrength[i] = 0;
      this.invMass[i] = 1;
    }
    this.pinCount = 0;
    this.sortFromPins();
    this.releaseTwist();
  }

  /** order the distance constraints by rest distance from the nearest pin (or back to the shared order) */
  private sortFromPins() {
    const t = this.topo;
    if (this.pinCount === 0) {
      this.pairs = t.pairs;
      this.rest = t.rest;
      return;
    }
    const m = t.rest.length;
    const o = (this.pinOrder ??= {
      pairs: new Uint16Array(m * 2),
      rest: new Float32Array(m),
      keys: new Float32Array(m),
      idx: new Uint32Array(m),
      dist: new Float32Array(this.count),
      slip: new Float32Array(this.count * 3),
    });
    const { qx, qy } = t;
    // rest distance of every particle from its nearest pin
    for (let i = 0; i < this.count; i++) {
      let best = Infinity;
      for (let k = 0; k < this.pinCount; k++) {
        const j = this.pinList[k];
        best = Math.min(best, (qx[i] - qx[j]) ** 2 + (qy[i] - qy[j]) ** 2);
      }
      o.dist[i] = Math.sqrt(best);
    }
    for (let c = 0; c < m; c++) {
      const a = t.pairs[c * 2], b = t.pairs[c * 2 + 1];
      const mx = (qx[a] + qx[b]) / 2, my = (qy[a] + qy[b]) / 2;
      let best = Infinity;
      for (let k = 0; k < this.pinCount; k++) {
        const i = this.pinList[k];
        best = Math.min(best, (mx - qx[i]) ** 2 + (my - qy[i]) ** 2);
      }
      o.keys[c] = best;
      o.idx[c] = c;
    }
    // structural and shear stay separate ranges (different stiffness)
    const keys = o.keys;
    o.idx.subarray(0, t.nStruct).sort((a, b) => keys[a] - keys[b]);
    o.idx.subarray(t.nStruct).sort((a, b) => keys[a] - keys[b]);
    for (let c = 0; c < m; c++) {
      const src = o.idx[c];
      // inner end (nearer the pin) first: the strain limiter below relies on it
      let a = t.pairs[src * 2], b = t.pairs[src * 2 + 1];
      if (o.dist[a] > o.dist[b]) [a, b] = [b, a];
      o.pairs[c * 2] = a;
      o.pairs[c * 2 + 1] = b;
      o.rest[c] = t.rest[src];
    }
    this.pairs = o.pairs;
    this.rest = o.rest;
  }

  // Fingers never let go perfectly straight. A small twist about the sheet's horizontal
  // axis means a note released hanging edge-down starts to tip (and flutter) at once,
  // instead of dropping like a slate until the air catches it.
  private releaseTwist(scale = 1) {
    // ...in the air, that is: a note let go while it lies on the floor or a palm just stays put
    const resting = (this.floorContacts + this.colliderContacts) / this.count;
    const air = Math.max(0, 1 - 4 * resting);
    const k = scale * air * PAPER.releaseSpin * (0.6 + 0.4 * this.rand()) * (this.rand() < 0.5 ? -1 : 1);
    if (k === 0) return;
    const fr = this.frame;
    const nx = fr[1] * fr[5] - fr[2] * fr[4], nz = fr[0] * fr[4] - fr[1] * fr[3];
    // axis = n × ŷ, or the sheet's own right if it is lying flat
    let ax = -nz, ay = 0, az = nx;
    let l = Math.hypot(ax, az);
    if (l < 0.3) { ax = fr[0]; ay = fr[1]; az = fr[2]; l = Math.hypot(ax, ay, az) || 1; }
    const s = k / l;
    const c = this.centroid();
    const x = this.positions;
    const v = this.vel;
    for (let p = 0; p < x.length; p += 3) {
      const dx = x[p] - c[0], dy = x[p + 1] - c[1], dz = x[p + 2] - c[2];
      v[p] += s * (ay * dz - az * dy);
      v[p + 1] += s * (az * dx - ax * dz);
      v[p + 2] += s * (ax * dy - ay * dx);
    }
  }

  attach(center: V3, right: V3, up: V3, weight: number) {
    if (!finite3(center) || !finite3(right) || !finite3(up) || !(weight > 0)) return this.detach();
    const q = this.attachReq;
    q[0] = center[0]; q[1] = center[1]; q[2] = center[2];
    // Orthonormalised, so a sloppy frame can't stretch or shrink the note. A degenerate one (zero,
    // or right ∥ up — a hand seen edge-on) keeps the last good orientation instead of pulling every
    // particle to the centre.
    const ok = quatFromRightUp(right, up, q, 3);
    if (!this.attachOn) {
      if (!ok) q.set(this.quat, 3);
      // the pull starts from the note's own orientation and turns toward the pose (see step)
      const t = this.attachTo;
      t[0] = q[0]; t[1] = q[1]; t[2] = q[2];
      t.set(this.quat, 3);
      this.attachFrom.set(t);
    }
    this.attachOn = true;
    this.attachWeight = Math.min(1, weight);
    this.wake();
  }

  detach() {
    if (!this.attachOn) return;
    this.attachOn = false;
    // sliding off a palm, it rocks a little as it goes
    this.releaseTwist(0.5);
  }

  crumple(center: V3, amount: number) {
    if (!finite3(center) || !(amount > 0)) return;
    if (!this.crumpleOff) this.crumpleOff = this.makeCrumpleTargets();
    if (!this.creases) this.creases = this.makeCreases();
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

  /**
   * How far past taut the pins are pulling: max over pairs of pins of (distance between their
   * targets ÷ their distance on the flat note) − 1, or 0. Two hands pulling a note apart past
   * ~0.05 should let one grip slip — paper can't stretch, so the solver otherwise has to.
   */
  get taut(): number {
    const { qx, qy } = this.topo;
    const t = this.pinTo;
    let worst = 0;
    for (let k = 0; k < this.pinCount; k++) {
      for (let l = k + 1; l < this.pinCount; l++) {
        const a = this.pinList[k], b = this.pinList[l];
        const ex = qx[a] - qx[b], ey = qy[a] - qy[b];
        const dx = t[a * 3] - t[b * 3], dy = t[a * 3 + 1] - t[b * 3 + 1], dz = t[a * 3 + 2] - t[b * 3 + 2];
        const rest = Math.sqrt(ex * ex + ey * ey);
        if (rest > 1e-6) worst = Math.max(worst, Math.sqrt(dx * dx + dy * dy + dz * dz) / rest - 1);
      }
    }
    return worst;
  }

  centroid(): V3 {
    const x = this.positions;
    let cx = 0, cy = 0, cz = 0;
    for (let p = 0; p < x.length; p += 3) { cx += x[p]; cy += x[p + 1]; cz += x[p + 2]; }
    return [cx / this.count, cy / this.count, cz / this.count];
  }

  // pin/attach/crumple wake the sheet every frame they're called; only a sheet that was really
  // asleep (whose air pass is stale) or one that was moved needs the air & rigid pass redone
  private wake() {
    if (this.sleeping) this.airValid = false;
    this.sleeping = false;
    this.stillFor = 0;
  }

  private footprint() {
    return this.fp;
  }

  /** rest height off the plane, rebuilt only when camber, wrinkle or crease depth change */
  private updateRestZ() {
    const z = this.restZ;
    const k = this.restZFor;
    const cb = PAPER.camber, w = this.creases ? this.wrinkle : 0, d = PAPER.creaseDepth;
    if (k[0] === cb && k[1] === w && k[2] === d) return z;
    k[0] = cb; k[1] = w; k[2] = d;
    const bow = this.bow, cr = this.creases;
    for (let i = 0; i < this.count; i++) z[i] = bow[i] * cb + (cr ? cr[i] * d * w : 0);
    // Creases take up length, so creased paper covers less ground — by exactly as much as its
    // edges, tilted out of plane, need to keep their rest length. Any more and the shape match
    // would squeeze inextensible edges: a fight the sheet loses as a permanent shimmer.
    const { pairs, rest, nStruct } = this.topo;
    let acc = 0;
    for (let c = 0; c < nStruct; c++) {
      const e = (z[pairs[c * 2]] - z[pairs[c * 2 + 1]]) / rest[c];
      acc += Math.sqrt(Math.max(0, 1 - e * e));
    }
    this.fp = acc / nStruct;
    return z;
  }

  // Crumpled-and-smoothed paper: straight fold lines at random angles, each a sharp
  // ridge or valley (|sin| is a V at its zeros), summed. Zero mean, peak ≈ 1.
  private makeCreases() {
    const { qx, qy, radius } = this.topo;
    const r = rng(this.seed * 4513 + 29);
    const folds: number[] = [];
    for (let k = 0; k < 7; k++) {
      const a = r() * Math.PI;
      const f = (0.6 + r() * 1.6) / radius;
      folds.push(Math.cos(a) * f, Math.sin(a) * f, r() * Math.PI, (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.5));
    }
    const out = new Float32Array(this.count);
    let mean = 0;
    for (let i = 0; i < this.count; i++) {
      let s = 0;
      for (let k = 0; k < folds.length; k += 4) s += folds[k + 3] * Math.abs(Math.sin(qx[i] * folds[k] + qy[i] * folds[k + 1] + folds[k + 2]));
      out[i] = s;
      mean += s / this.count;
    }
    let max = 0;
    for (let i = 0; i < this.count; i++) max = Math.max(max, Math.abs((out[i] -= mean)));
    for (let i = 0; i < this.count; i++) out[i] /= max || 1;
    return out;
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
    // velocities come from position changes over the step: over a sliver of a frame, tracking
    // noise on a pinned corner becomes a flick. Bank it and take it with the next frame.
    this.owed += dt;
    if (this.owed < P.minStep) return;
    dt = this.owed;
    this.owed = 0;
    const frameDt = Math.min(dt, P.substep * P.maxSubsteps);
    // a squeeze lasts only as long as crumple() keeps being called
    const squeeze = this.crumpleFresh ? this.crumpleAmount : 0;
    // A small note that nobody is touching flutters just the same at half the rate; the
    // hero, and anything held, squeezed or carried, always gets the fine step.
    const free = this.count < P.smallSheet && this.pinCount === 0 && !this.attachOn && squeeze === 0 && this.relax === 0;
    const size = free ? P.freeSubstep : P.substep;
    const n = Math.min(P.maxSubsteps, Math.max(1, Math.ceil(frameDt / (size * 1.15))));
    const h = frameDt / n;
    const sub = this.sub;
    sub[0] = h;
    sub[2] = squeeze;
    sub[4] = frameDt;
    sub[5] = env.floorY + this.floorLift;

    this.trackColliders(env.colliders);

    this.crumpleFresh = false;
    if (squeeze > 0) {
      this.relax = Math.max(this.relax, squeeze);
      this.wrinkle += (1 - this.wrinkle) * (1 - Math.exp(-P.wrinkleRate * squeeze * frameDt));
    } else this.relax = Math.max(0, this.relax - frameDt / P.relaxTime);

    if (this.sleeping) {
      if (!this.shouldWake(env)) return;
      this.wake();
    }

    this.followTeleports();
    if (this.attachOn) this.turnAttach();
    // Air and the rigid motion change slowly: once a frame is plenty. They're computed at
    // the END of each step, sharing the triangle pass with the normals; this is only for a
    // sheet that was just placed or pushed.
    if (!this.airValid) {
      this.rigidMotion();
      this.airAndNormals(env);
    }
    for (let s = 0; s < n; s++) {
      // the attach damps the note's rigid motion, so that has to be current, not a frame old
      if (s > 0 && this.attachOn) this.rigidMotion();
      this.time += h;
      sub[3] = s / n; // how far through the frame: pins, poses and colliders glide along their path
      sub[1] = (s + 1) / n;
      this.integrate(env);
      this.constrain();
      this.finish(env);
    }
    for (let k = 0; k < this.pinCount; k++) {
      const p = this.pinList[k] * 3;
      this.pinFrom[p] = this.pinTo[p];
      this.pinFrom[p + 1] = this.pinTo[p + 1];
      this.pinFrom[p + 2] = this.pinTo[p + 2];
    }
    if (this.attachOn) this.attachFrom.set(this.attachTo);
    this.rigidMotion();
    this.airAndNormals(env);
    this.airValid = true;
    this.updateSleep(env);
  }

  /**
   * Gravity, air and damping predict where each particle goes; then the soft pulls — shape
   * match, attach pose, fist — nudge it toward its target. They run before the constraint
   * solve so stretch & shear get the last word: a pull can bend the paper, never stretch it.
   */
  private integrate(env: PaperEnv) {
    const h = this.sub[0], f = this.sub[1], squeeze = this.sub[2];
    const P = PAPER;
    const t = this.topo;
    const n = this.count;
    const x = this.positions;
    const v = this.vel;
    const prev = this.prev;
    const w = this.invMass;
    const pinFrom = this.pinFrom;
    const pinTo = this.pinTo;
    const qx = t.qx;
    const qy = t.qy;
    const floor = this.sub[5];

    // ---- forces
    const rb = this.rb;
    const vcx = rb[3], vcy = rb[4], vcz = rb[5], wx = rb[6], wy = rb[7], wz = rb[8];
    // the centroid drifts with the rigid motion between the once-a-frame updates
    const cx = (rb[0] += vcx * h), cy = (rb[1] += vcy * h), cz = (rb[2] += vcz * h);
    const gx = env.gravity[0], gy = env.gravity[1], gz = env.gravity[2];
    const kd = 1 - Math.exp(-P.deformDamping * h);
    // a pinch isn't a frictionless pivot: turning the paper between the fingers costs energy,
    // so a held note settles instead of swinging like a pendulum for ever
    const kp = this.pinCount > 0 ? 1 - Math.exp(-P.pivotFriction * h) : 0;
    const pp = this.pinCount > 0 ? this.pinList[0] * 3 : 0;
    const pvx = x[pp], pvy = x[pp + 1], pvz = x[pp + 2];
    const damp = Math.exp(-P.damping * h);
    const acc = this.aeroA;

    // ---- pulls. Their targets use the sheet's centroid and best-fit rotation from the end of
    // the last substep, carried forward by its mean velocity (one substep stale, soft anyway).
    const m = this.moments;
    const sx = m[0] + m[9] * h, sy = m[1] + m[10] * h, sz = m[2] + m[11] * h;
    const restZ = this.updateRestZ();
    // creased paper covers less ground: its footprint shrinks as the creases stand up
    const fp = this.footprint();
    // global shape match: toward the best rigid fit of the rest sheet (gently bowed, maybe creased).
    // The fit runs even while a fist has the match switched off: air and the release twist use it too.
    let shape = (1 - Math.exp(-P.shapeMatch * h)) * (1 - this.relax) * (1 - P.wrinkleSoften * this.wrinkle);
    if (!(shape > 0)) shape = 0;
    this.fitRotation();
    // ...turned on by this substep's spin (or the match would brake every tumble)
    const fr = this.frame;
    const a0x = fr[0], a0y = fr[1], a0z = fr[2], a1x = fr[3], a1y = fr[4], a1z = fr[5];
    const r0x = a0x + (wy * a0z - wz * a0y) * h, r0y = a0y + (wz * a0x - wx * a0z) * h, r0z = a0z + (wx * a0y - wy * a0x) * h;
    const r1x = a1x + (wy * a1z - wz * a1y) * h, r1y = a1y + (wz * a1x - wx * a1z) * h, r1z = a1z + (wx * a1y - wy * a1x) * h;
    const r2x = r0y * r1z - r0z * r1y, r2y = r0z * r1x - r0x * r1z, r2z = r0x * r1y - r0y * r1x;

    // attach to a rigid pose (palm, stand), interpolated across the frame's substeps
    let att = 0, crit = 0;
    let ocx = 0, ocy = 0, ocz = 0, orx = 0, ory = 0, orz = 0, oux = 0, ouy = 0, ouz = 0;
    let avx = 0, avy = 0, avz = 0, awx = 0, awy = 0, awz = 0;
    if (this.attachOn) {
      const a0 = this.attachFrom;
      const a1 = this.attachTo;
      ocx = a0[0] + (a1[0] - a0[0]) * f; ocy = a0[1] + (a1[1] - a0[1]) * f; ocz = a0[2] + (a1[2] - a0[2]) * f;
      // nlerp is plenty: turnAttach keeps a frame's turn small and in the same hemisphere
      let ew = a0[3] + (a1[3] - a0[3]) * f, ex = a0[4] + (a1[4] - a0[4]) * f;
      let ey = a0[5] + (a1[5] - a0[5]) * f, ez = a0[6] + (a1[6] - a0[6]) * f;
      const el = 1 / Math.sqrt(ew * ew + ex * ex + ey * ey + ez * ez);
      ew *= el; ex *= el; ey *= el; ez *= el;
      orx = 1 - 2 * (ey * ey + ez * ez); ory = 2 * (ex * ey + ew * ez); orz = 2 * (ex * ez - ew * ey);
      oux = 2 * (ex * ey - ew * ez); ouy = 1 - 2 * (ex * ex + ez * ez); ouz = 2 * (ey * ez + ew * ex);
      att = 1 - Math.exp(-P.attachRate * this.attachWeight * h);
      // A position pull alone is a spring: the note would overshoot a palm that moves and bounce
      // around it. Damping the rigid motion toward the pose's by this much per substep makes it
      // critically damped (for the discrete pull x += k·(t − x), c = 2√k / (1 + √k)).
      const sk = Math.sqrt(att);
      crit = (2 * sk) / (1 + sk);
      const av = this.attachVel;
      avx = av[0]; avy = av[1]; avz = av[2]; awx = av[3]; awy = av[4]; awz = av[5];
    }
    // the rigid part of the attach pull (t), capped so a note called from afar swoops in (m) at
    // attachSpeed (the damping above settles the swoop at cap / crit)
    const tx = ocx - sx, ty = ocy - sy, tz = ocz - sz;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) * att;
    const cap = P.attachSpeed * h * crit;
    const mk = tl > cap ? (cap / tl) * att : att;
    const mx = tx * mk, my = ty * mk, mz = tz * mk;
    const fall = P.attachFalloff;
    const qr2 = t.qr2;

    // fist: everything heads for its spot in a ball that shrinks as the squeeze tightens
    let fist = 0;
    const o = this.crumpleOff;
    let R = 0;
    const ccx = this.crumpleAt[0], ccy = this.crumpleAt[1], ccz = this.crumpleAt[2];
    if (squeeze > 0 && o) {
      fist = 1 - Math.exp(-P.crumpleRate * squeeze * h);
      R = P.crumpleRadius + (1 - squeeze) * (1 - squeeze) * t.radius;
    }

    for (let i = 0; i < n; i++) {
      const p = i * 3;
      let px = x[p], py = x[p + 1], pz = x[p + 2];
      prev[p] = px;
      prev[p + 1] = py;
      prev[p + 2] = pz;
      if (w[i] === 0) {
        // hard pin: glide along the frame's path so fast hands drag smoothly — but never under
        // the floor: the paper next to it can't follow, and the fight would thrash the note
        x[p] = pinFrom[p] + (pinTo[p] - pinFrom[p]) * f;
        x[p + 1] = Math.max(floor, pinFrom[p + 1] + (pinTo[p + 1] - pinFrom[p + 1]) * f);
        x[p + 2] = pinFrom[p + 2] + (pinTo[p + 2] - pinFrom[p + 2]) * f;
        continue;
      }
      let vx = v[p] + (gx + acc[p]) * h;
      let vy = v[p + 1] + (gy + acc[p + 1]) * h;
      let vz = v[p + 2] + (gz + acc[p + 2]) * h;
      // toward the rigid motion (ω × r about the centroid): kills wobble, keeps the fall and
      // the spin; and against turning about the fingers (ω × r about the pin)
      const rx = px - cx, ry = py - cy, rz = pz - cz;
      const ux = px - pvx, uy = py - pvy, uz = pz - pvz;
      vx = (vx + kd * (vcx + wy * rz - wz * ry - vx) - kp * (wy * uz - wz * uy)) * damp;
      vy = (vy + kd * (vcy + wz * rx - wx * rz - vy) - kp * (wz * ux - wx * uz)) * damp;
      vz = (vz + kd * (vcz + wx * ry - wy * rx - vz) - kp * (wx * uy - wy * ux)) * damp;
      if (crit > 0) {
        // the sheet's rigid motion toward the pose's (uniform: it leaves the flex alone)
        vx += crit * (avx + awy * rz - awz * ry - vcx - wy * rz + wz * ry);
        vy += crit * (avy + awz * rx - awx * rz - vcy - wz * rx + wx * rz);
        vz += crit * (avz + awx * ry - awy * rx - vcz - wx * ry + wy * rx);
      }
      px += vx * h;
      py += vy * h;
      pz += vz * h;

      const u = qx[i], s = qy[i];
      if (shape > 0) {
        const b = restZ[i], gu = u * fp, gs = s * fp;
        px += shape * (sx + r0x * gu + r1x * gs + r2x * b - px);
        py += shape * (sy + r0y * gu + r1y * gs + r2y * b - py);
        pz += shape * (sz + r0z * gu + r1z * gs + r2z * b - pz);
      }
      if (att > 0) {
        // the sheet as a whole moves toward the pose rigidly; only the shape part of the pull
        // eases off toward the edges, so a note flying to a palm doesn't stretch on the way
        const k = att * (1 - fall * qr2[i]);
        px += mx + k * (ocx + orx * u + oux * s - px - tx);
        py += my + k * (ocy + ory * u + ouy * s - py - ty);
        pz += mz + k * (ocz + orz * u + ouz * s - pz - tz);
      }
      if (fist > 0) {
        px += fist * (ccx + o![p] * R - px);
        py += fist * (ccy + o![p + 1] * R - py);
        pz += fist * (ccz + o![p + 2] * R - pz);
      }
      x[p] = px;
      x[p + 1] = py;
      x[p + 2] = pz;
    }
  }

  /** pins and tethers, bending, then stretch & shear */
  private constrain() {
    const h = this.sub[0], f = this.sub[1];
    const P = PAPER;
    const t = this.topo;
    const x = this.positions;
    const w = this.invMass;
    if (this.pinCount > 0) {
      const pinFrom = this.pinFrom;
      const pinTo = this.pinTo;
      // soft pins
      for (let k = 0; k < this.pinCount; k++) {
        const i = this.pinList[k];
        const s = this.pinStrength[i];
        if (s >= HARD) continue;
        const p = i * 3;
        const a = 1 - Math.pow(1 - s, h * 120);
        x[p] += a * (pinFrom[p] + (pinTo[p] - pinFrom[p]) * f - x[p]);
        x[p + 1] += a * (Math.max(this.sub[5], pinFrom[p + 1] + (pinTo[p + 1] - pinFrom[p + 1]) * f) - x[p + 1]);
        x[p + 2] += a * (pinFrom[p + 2] + (pinTo[p + 2] - pinFrom[p + 2]) * f - x[p + 2]);
      }
      this.tether();
    }
    // Bending is soft anyway: every other substep, at the squared stiffness, looks the same for
    // half the cost. Creased paper is floppier, and its creases (in the shape match) stay put.
    let bend = P.bend * (1 - this.relax) * (1 - 0.7 * this.wrinkle);
    if (bend > 0 && (this.substeps++ & 1) === 0) {
      bend = 1 - (1 - bend) * (1 - bend);
      knob[0] = bend;
      solveBending(x, w, t.trip);
    }
    // stretch & shear last, so whatever the pulls above did, the paper ends the solve unstretched;
    // a held sheet carries its weight through the fingers and gets extra sweeps
    const iters = Math.max(1, this.iterations | 0) + (this.pinCount > 0 ? P.heldIterations : this.attachOn ? P.attachIterations : 0);
    for (let it = 0; it < iters; it++) {
      // alternate the sweep direction so neither end of the sheet is favoured
      const back = it & 1;
      knob[0] = P.shear;
      solveDistances(x, w, this.pairs, this.rest, t.nStruct, t.rest.length, back);
      knob[0] = P.stretch;
      solveDistances(x, w, this.pairs, this.rest, 0, t.nStruct, back);
    }
    // Held by a corner, the whole note's weight goes through the few edges by the fingers,
    // and a couple of sweeps leave them stretched like taffy. One last pass outward from the
    // pin (follow-the-leader) caps every row/column edge's stretch, moving only its outer end.
    // A particle with two inner neighbours can only fully satisfy the one handled last, so
    // the pass runs a few times (alternating projections; it settles fast).
    if (this.pinCount > 0) {
      knob[0] = 1 + P.maxStretch;
      const slip = this.pinOrder!.slip;
      slip.fill(0);
      for (let k = 0; k < P.limiterPasses; k++) limitStretch(x, this.prev, slip, this.invMass, this.pairs, this.rest, t.nStruct);
    }
  }

  /** one last pass: contacts, then velocities from the position change */
  private finish(env: PaperEnv) {
    const h = this.sub[0], f1 = this.sub[1], f0 = this.sub[3];
    const P = PAPER;
    const n = this.count;
    const x = this.positions;
    const v = this.vel;
    const prev = this.prev;
    const w = this.invMass;
    const floor = this.sub[5];
    const mu = P.floorFriction;
    const cd = this.colData;
    const cs = this.colSub;
    const margin = P.contactMargin;
    const held = this.pinCount > 0;
    const slip = held ? this.pinOrder!.slip : null;
    // a push-out may hand the paper the collider's own motion, plus at most this
    const sepH = P.separation * h;
    // Only colliders that can reach the sheet this substep (most rain is nowhere near a palm), each
    // posed where it is at the start and end of the substep: it glides from last frame's pose like a
    // pin. None for paper held by a pinch: a pin just behind a palm can't be satisfied, and that
    // fight, fed by the gusts and the strain limiter, thrashes the note (nothing in the game needs
    // a palm to push a note someone is holding).
    const act = this.colActive;
    let nCol = 0;
    if (!held) {
      const m = this.moments;
      const reach = this.topo.halfDiagonal * 1.1 + P.maxSpeed * h + margin;
      for (let c = 0, all = Math.min(env.colliders.length, MAX_COLLIDERS); c < all; c++) {
        const q = c * CD;
        const ex = cd[q + 1] - cd[q + 9], ey = cd[q + 2] - cd[q + 10], ez = cd[q + 3] - cd[q + 11];
        const r = (cd[q] === 0 ? Math.sqrt(cd[q + 7]) : cd[q + 4]) + Math.sqrt(ex * ex + ey * ey + ez * ez);
        const dx = cd[q + 1] - m[0], dy = cd[q + 2] - m[1], dz = cd[q + 3] - m[2];
        if (!(dx * dx + dy * dy + dz * dz < (reach + r) * (reach + r))) continue;
        const o = nCol * 12;
        for (let k = 0; k < 3; k++) {
          cs[o + k] = cd[q + 9 + k] + (cd[q + 1 + k] - cd[q + 9 + k]) * f0;
          cs[o + 3 + k] = cd[q + 9 + k] + (cd[q + 1 + k] - cd[q + 9 + k]) * f1;
        }
        if (cd[q] === 0) {
          // normals nlerp'd the same way (a flip between frames is ill-posed anyway: take the new one)
          for (let e = 0; e < 2; e++) {
            const fe = e === 0 ? f0 : f1;
            let nx = cd[q + 12] + (cd[q + 4] - cd[q + 12]) * fe;
            let ny = cd[q + 13] + (cd[q + 5] - cd[q + 13]) * fe;
            let nz = cd[q + 14] + (cd[q + 6] - cd[q + 14]) * fe;
            let l = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (!(l > 0.1)) { nx = cd[q + 4]; ny = cd[q + 5]; nz = cd[q + 6]; l = 1; }
            cs[o + 6 + e * 3] = nx / l;
            cs[o + 7 + e * 3] = ny / l;
            cs[o + 8 + e * 3] = nz / l;
          }
        }
        act[nCol++] = c;
      }
    }
    // Coulomb friction scales with how hard the contact pushes (the push-out depth); capped,
    // so a note shoved into the floor by an attach pose can still slide instead of locking up
    const fd = P.frictionDepth;
    const ih = 1 / h;
    const vmax = P.maxSpeed;
    const vmax2 = vmax * vmax;
    const qx = this.topo.qx;
    const qy = this.topo.qy;
    const rz = this.restZ;
    let floorHits = 0;
    let hits = 0;
    let speed = 0;
    // centroid, first moments Σ x·(qx, qy, restZ) and mean velocity, for the next substep's pulls
    let sx = 0, sy = 0, sz = 0, ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, zx = 0, zy = 0, zz = 0, svx = 0, svy = 0, svz = 0;

    for (let i = 0; i < n; i++) {
      const p = i * 3;
      let px = x[p], py = x[p + 1], pz = x[p + 2];
      // where the particle started the substep...
      const s0x = prev[p], s0y = prev[p + 1], s0z = prev[p + 2];
      // ...and what its velocity is measured from: that, plus moves hidden from the velocity
      // (the strain limiter's, and below, contact pushes beyond the collider's own speed)
      let ox = s0x, oy = s0y, oz = s0z;
      if (slip !== null) { ox += slip[p]; oy += slip[p + 1]; oz += slip[p + 2]; }
      if (w[i] !== 0) {
        // floor, with Coulomb friction: the push-out depth bounds how much sliding it can stop
        if (py < floor) {
          const pen = floor - py;
          py = floor;
          floorHits++;
          const dx = px - ox, dz = pz - oz;
          const slide = Math.sqrt(dx * dx + dz * dz);
          const lim = mu * (pen < fd ? pen : fd);
          if (slide <= lim) {
            px = ox;
            pz = oz;
          } else {
            const k = lim / slide;
            px -= dx * k;
            pz -= dz * k;
          }
          // a corner held under the floor and let go settles onto it instead of flicking up
          if (py - oy > sepH) oy = py - sepH;
        }

        // palms and fingertips
        for (let c = 0; c < nCol; c++) {
          const q = act[c] * CD;
          const o = c * 12;
          const dx = px - cs[o + 3], dy = py - cs[o + 4], dz = pz - cs[o + 5];
          let nx = 0, ny = 0, nz = 0, pen = 0;
          if (cd[q] === 0) {
            // Disk: a palm is a solid plate. Paper that met it from the front is pushed to the front;
            // paper behind it (a palm that opened over it, or slid past it edge-on) stays behind,
            // against the back of the hand, instead of being yanked through. The side is where the
            // particle was when the substep began, against the palm's pose then, so nothing tunnels
            // however fast either moves — and a sheet can't end up threaded through a palm.
            nx = cs[o + 9]; ny = cs[o + 10]; nz = cs[o + 11];
            let d = dx * nx + dy * ny + dz * nz;
            if ((s0x - cs[o]) * cs[o + 6] + (s0y - cs[o + 1]) * cs[o + 7] + (s0z - cs[o + 2]) * cs[o + 8] < 0) {
              nx = -nx; ny = -ny; nz = -nz; d = -d;
            }
            if (!(d < margin)) continue;
            if (dx * dx + dy * dy + dz * dz - d * d > cd[q + 7]) continue;
            pen = margin - d;
          } else {
            const d2 = dx * dx + dy * dy + dz * dz;
            if (!(d2 < cd[q + 7])) continue;
            const d = Math.sqrt(d2);
            // dead centre: any direction will do, up is the kindest
            if (d > 1e-9) { nx = dx / d; ny = dy / d; nz = dz / d; } else ny = 1;
            pen = cd[q + 4] - d;
          }
          px += nx * pen;
          py += ny * pen;
          pz += nz * pen;
          hits++;
          // motion relative to the collider this substep: friction against it, so a moving palm
          // carries the paper, and no faster than it (+ separation) away from it
          const rx = px - ox - (cs[o + 3] - cs[o]), ry = py - oy - (cs[o + 4] - cs[o + 1]), rzz = pz - oz - (cs[o + 5] - cs[o + 2]);
          const rn = rx * nx + ry * ny + rzz * nz;
          const tx = rx - rn * nx, ty = ry - rn * ny, tz = rzz - rn * nz;
          const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (tl > 1e-12) {
            const lim = cd[q + 8] * (pen < fd ? pen : fd);
            const k = tl <= lim ? 1 : lim / tl;
            px -= tx * k;
            py -= ty * k;
            pz -= tz * k;
          }
          if (rn > sepH) {
            const e = rn - sepH;
            ox += nx * e;
            oy += ny * e;
            oz += nz * e;
          }
        }
      }

      // velocity from the position change, with a hard speed limit and a NaN guard
      let vx = (px - ox) * ih, vy = (py - oy) * ih, vz = (pz - oz) * ih;
      const s2 = vx * vx + vy * vy + vz * vz;
      if (!(s2 <= vmax2)) {
        if (s2 > vmax2) {
          // cap the velocity only: the positions just satisfied the constraints, keep them
          const k = vmax / Math.sqrt(s2);
          vx *= k; vy *= k; vz *= k;
        } else {
          // NaN crept in (a bad pin target?): put the particle back, at rest
          vx = vy = vz = 0;
          px = prev[p]; py = prev[p + 1]; pz = prev[p + 2];
        }
      }
      x[p] = px;
      x[p + 1] = py;
      x[p + 2] = pz;
      v[p] = vx;
      v[p + 1] = vy;
      v[p + 2] = vz;
      speed += vx * vx + vy * vy + vz * vz;
      const u = qx[i], s = qy[i], b = rz[i];
      sx += px; sy += py; sz += pz;
      ax += px * u; ay += py * u; az += pz * u;
      bx += px * s; by += py * s; bz += pz * s;
      zx += px * b; zy += py * b; zz += pz * b;
      svx += vx; svy += vy; svz += vz;
    }
    this.speed = Math.sqrt(speed / n);
    const m = this.moments;
    m[0] = sx / n; m[1] = sy / n; m[2] = sz / n;
    m[3] = ax; m[4] = ay; m[5] = az;
    m[6] = bx; m[7] = by; m[8] = bz;
    m[9] = svx / n; m[10] = svy / n; m[11] = svz / n;
    m[12] = zx; m[13] = zy; m[14] = zz;
    this.floorContacts = floorHits;
    this.colliderContacts = hits;
  }

  /**
   * Centroid, mean velocity and angular velocity (ω = I⁻¹L) of the particles, once a frame;
   * also the shape-match moments (finish() keeps those fresh between substeps).
   */
  private rigidMotion() {
    const x = this.positions;
    const v = this.vel;
    const n = this.count;
    const { qx, qy } = this.topo;
    const rz = this.updateRestZ();
    let sx = 0, sy = 0, sz = 0, svx = 0, svy = 0, svz = 0;
    let lx = 0, ly = 0, lz = 0;
    let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
    let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, ex = 0, ey = 0, ez = 0;
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      const px = x[p], py = x[p + 1], pz = x[p + 2];
      const vx = v[p], vy = v[p + 1], vz = v[p + 2];
      sx += px; sy += py; sz += pz;
      svx += vx; svy += vy; svz += vz;
      lx += py * vz - pz * vy;
      ly += pz * vx - px * vz;
      lz += px * vy - py * vx;
      xx += px * px; yy += py * py; zz += pz * pz;
      xy += px * py; xz += px * pz; yz += py * pz;
      const u = qx[i], s = qy[i], b = rz[i];
      ax += px * u; ay += py * u; az += pz * u;
      bx += px * s; by += py * s; bz += pz * s;
      ex += px * b; ey += py * b; ez += pz * b;
    }
    const ic = 1 / n;
    const cx = sx * ic, cy = sy * ic, cz = sz * ic;
    const vx = svx * ic, vy = svy * ic, vz = svz * ic;
    const m = this.moments;
    m[0] = cx; m[1] = cy; m[2] = cz;
    m[3] = ax; m[4] = ay; m[5] = az;
    m[6] = bx; m[7] = by; m[8] = bz;
    m[9] = vx; m[10] = vy; m[11] = vz;
    m[12] = ex; m[13] = ey; m[14] = ez;
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
    const tr = a + b + c;
    if (det > 1e-9 * tr * tr * tr) {
      const c11 = a * c - e * e, c12 = d * e - a * g, c22 = a * b - d * d;
      const id = 1 / det;
      rb[6] = (c00 * lx + c01 * ly + c02 * lz) * id;
      rb[7] = (c01 * lx + c11 * ly + c12 * lz) * id;
      rb[8] = (c02 * lx + c12 * ly + c22 * lz) * id;
    } else rb[6] = rb[7] = rb[8] = 0;
  }

  /**
   * The rotation that best maps the rest shape (qx·fp, qy·fp, restZ) onto the particles: the polar
   * part of A = Σ x rᵀ. Newton steps on tr(Rᵀ A) over rotations, warm-started from the last substep
   * (one step is usually exact to float precision). Plain gradient steps (Müller et al. 2016) crawl
   * about the note's long axis — its rest shape is long and thin — and the lagging fit then brakes
   * any roll. The rest shape's height (bow, creases) has to be in the fit too: leave it out and the
   * match pulls a creased note toward a pose it can never reach, a steady torque that spins it forever.
   */
  private fitRotation() {
    const m = this.moments;
    const fp = this.footprint();
    // Σ r = 0, so the plain sums are already central
    const a0x = m[3] * fp, a0y = m[4] * fp, a0z = m[5] * fp;
    const a1x = m[6] * fp, a1y = m[7] * fp, a1z = m[8] * fp;
    const a2x = m[12], a2y = m[13], a2z = m[14];
    const q = this.quat;
    let qw = q[0], qx = q[1], qy = q[2], qz = q[3];
    for (let it = 0; it < 3; it++) {
      const r0x = 1 - 2 * (qy * qy + qz * qz), r0y = 2 * (qx * qy + qw * qz), r0z = 2 * (qx * qz - qw * qy);
      const r1x = 2 * (qx * qy - qw * qz), r1y = 1 - 2 * (qx * qx + qz * qz), r1z = 2 * (qy * qz + qw * qx);
      const r2x = 2 * (qx * qz + qw * qy), r2y = 2 * (qy * qz - qw * qx), r2z = 1 - 2 * (qx * qx + qy * qy);
      // gradient of tr(RᵀA) for R ← exp(ω)R: g = Σ rᵢ × aᵢ
      const gx = r0y * a0z - r0z * a0y + r1y * a1z - r1z * a1y + r2y * a2z - r2z * a2y;
      const gy = r0z * a0x - r0x * a0z + r1z * a1x - r1x * a1z + r2z * a2x - r2x * a2z;
      const gz = r0x * a0y - r0y * a0x + r1x * a1y - r1y * a1x + r2x * a2y - r2y * a2x;
      // (negated) Hessian: tr(B)·I − sym(B), B = Σ aᵢ rᵢᵀ
      const b00 = a0x * r0x + a1x * r1x + a2x * r2x, b11 = a0y * r0y + a1y * r1y + a2y * r2y, b22 = a0z * r0z + a1z * r1z + a2z * r2z;
      const b01 = (a0x * r0y + a1x * r1y + a2x * r2y + a0y * r0x + a1y * r1x + a2y * r2x) / 2;
      const b02 = (a0x * r0z + a1x * r1z + a2x * r2z + a0z * r0x + a1z * r1x + a2z * r2x) / 2;
      const b12 = (a0y * r0z + a1y * r1z + a2y * r2z + a0z * r0y + a1z * r1y + a2z * r2y) / 2;
      const tr = b00 + b11 + b22;
      const h00 = tr - b00, h11 = tr - b11, h22 = tr - b22;
      const c00 = h11 * h22 - b12 * b12, c01 = b12 * b02 + b01 * h22, c02 = b01 * b12 + h11 * b02;
      const det = h00 * c00 - b01 * c01 - b02 * c02;
      let ox: number, oy: number, oz: number;
      if (det > 1e-6 * tr * tr * tr) {
        // Newton: ω = H⁻¹ g (H symmetric, off-diagonals −b; cofactors below)
        const c11 = h00 * h22 - b02 * b02, c12 = h00 * b12 + b01 * b02, c22 = h00 * h11 - b01 * b01;
        const id = 1 / det;
        ox = (c00 * gx + c01 * gy + c02 * gz) * id;
        oy = (c01 * gx + c11 * gy + c12 * gz) * id;
        oz = (c02 * gx + c12 * gy + c22 * gz) * id;
      } else ox = oy = oz = -1;
      if (!(ox * gx + oy * gy + oz * gz > 0)) {
        // far from the fit (or a degenerate ball): fall back to a gradient step
        const k = 1 / (Math.abs(tr) + 1e-9);
        ox = gx * k; oy = gy * k; oz = gz * k;
      }
      let ang = Math.sqrt(ox * ox + oy * oy + oz * oz);
      if (!(ang > 1e-7)) break; // converged (or NaN: keep the last good rotation)
      if (ang > 1) { ox /= ang; oy /= ang; oz /= ang; ang = 1; }
      const c = Math.cos(ang / 2), k = Math.sin(ang / 2) / ang;
      const dx = ox * k, dy = oy * k, dz = oz * k;
      // q ← dq · q
      const nw = c * qw - dx * qx - dy * qy - dz * qz;
      const nx = c * qx + dx * qw + dy * qz - dz * qy;
      const ny = c * qy + dy * qw + dz * qx - dx * qz;
      const nz = c * qz + dz * qw + dx * qy - dy * qx;
      const l = 1 / Math.sqrt(nw * nw + nx * nx + ny * ny + nz * nz);
      qw = nw * l; qx = nx * l; qy = ny * l; qz = nz * l;
      if (ang < 1e-5) break;
    }
    if (!(Number.isFinite(qw) && Number.isFinite(qx) && Number.isFinite(qy) && Number.isFinite(qz))) return;
    q[0] = qw; q[1] = qx; q[2] = qy; q[3] = qz;
    const fr = this.frame;
    fr[0] = 1 - 2 * (qy * qy + qz * qz); fr[1] = 2 * (qx * qy + qw * qz); fr[2] = 2 * (qx * qz - qw * qy);
    fr[3] = 2 * (qx * qy - qw * qz); fr[4] = 1 - 2 * (qx * qx + qz * qz); fr[5] = 2 * (qy * qz + qw * qx);
  }

  /** this frame's attach pose: the requested one, turned toward at no more than attachTurn */
  private turnAttach() {
    const a0 = this.attachFrom, a1 = this.attachTo, req = this.attachReq;
    a1[0] = req[0]; a1[1] = req[1]; a1[2] = req[2];
    let dot = a0[3] * req[3] + a0[4] * req[4] + a0[5] * req[5] + a0[6] * req[6];
    const sg = dot < 0 ? -1 : 1; // q and −q are the same turn: take the short way
    dot *= sg;
    const ang = 2 * Math.acos(Math.min(1, dot));
    const dt = this.sub[4];
    const max = PAPER.attachTurn * dt;
    if (!(ang > max)) {
      for (let k = 3; k < 7; k++) a1[k] = req[k] * sg;
    } else {
      // slerp a fraction of the way
      const half = ang / 2, t = max / ang, sn = Math.sin(half);
      const k0 = Math.sin((1 - t) * half) / sn, k1 = (sg * Math.sin(t * half)) / sn;
      let l = 0;
      for (let k = 3; k < 7; k++) {
        a1[k] = a0[k] * k0 + req[k] * k1;
        l += a1[k] * a1[k];
      }
      l = 1 / Math.sqrt(l);
      for (let k = 3; k < 7; k++) a1[k] *= l;
    }
    // The pose's own velocity, which the note's rigid motion is damped toward. A jump no hand can
    // make (the note handed to another palm, called back to the stand) has none: it's a new place
    // to swoop to, not a speed to match.
    const v = this.attachVel;
    const jx = a1[0] - a0[0], jy = a1[1] - a0[1], jz = a1[2] - a0[2];
    const vmax = PAPER.maxSpeed * dt;
    if (jx * jx + jy * jy + jz * jz <= vmax * vmax) {
      v[0] = jx / dt; v[1] = jy / dt; v[2] = jz / dt;
    } else v[0] = v[1] = v[2] = 0;
    // ω from q1·q0⁻¹ (same hemisphere, so its scalar part is ≥ 0)
    const w0 = a0[3], x0 = -a0[4], y0 = -a0[5], z0 = -a0[6];
    const w1 = a1[3], x1 = a1[4], y1 = a1[5], z1 = a1[6];
    const rw = w1 * w0 - x1 * x0 - y1 * y0 - z1 * z0;
    const rx = w1 * x0 + x1 * w0 + y1 * z0 - z1 * y0;
    const ry = w1 * y0 + y1 * w0 + z1 * x0 - x1 * z0;
    const rz = w1 * z0 + z1 * w0 + x1 * y0 - y1 * x0;
    const sl = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const k = sl > 1e-9 ? (2 * Math.atan2(sl, Math.abs(rw)) * (rw < 0 ? -1 : 1)) / (sl * dt) : 2 / dt;
    v[3] = rx * k; v[4] = ry * k; v[5] = rz * k;
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

  /**
   * Per triangle: face drag ∝ (u·n)·area (linear + quadratic), thin-plate lift ∝ the
   * sheet's edgewise speed, a little edgewise drag — weighted toward the leading edge,
   * which puts the centre of pressure ahead of the middle: the torque that makes paper
   * rock and tumble. Result: an acceleration per particle (mean of its triangles), applied
   * through the next frame. The same pass writes the area-weighted vertex normals.
   * No sqrt or division per triangle: the paper barely stretches, so a triangle's area
   * is its rest area and N/(2·restArea) serves as an area-weighted unit normal.
   */
  private airAndNormals(env: PaperEnv) {
    const P = PAPER;
    const t = this.topo;
    const x = this.positions;
    const v = this.vel;
    const F = this.aeroA;
    const N = this.normals;
    F.fill(0);
    N.fill(0);
    const idx = t.indices;
    const rb = this.rb;
    const cx = rb[0], cy = rb[1], cz = rb[2];
    const c1 = P.dragLinear, c2 = P.dragNormal, ct = P.dragTangent;
    const kmax = 1 / (P.substep * P.maxSubsteps); // never more than stops face-on motion within the longest frame

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

    // the flow over the sheet as a whole decides lift and where the centre of pressure sits
    const fr = this.frame;
    const nx = fr[1] * fr[5] - fr[2] * fr[4], ny = fr[2] * fr[3] - fr[0] * fr[5], nz = fr[0] * fr[4] - fr[1] * fr[3];
    const Ux = rb[3] - gwx, Uy = rb[4] - gwy, Uz = rb[5] - gwz;
    const Un = Ux * nx + Uy * ny + Uz * nz;
    const Tx = Ux - Un * nx, Ty = Uy - Un * ny, Tz = Uz - Un * nz;
    const VT = Math.sqrt(Tx * Tx + Ty * Ty + Tz * Tz);
    const U = Math.sqrt(VT * VT + Un * Un);
    let lx = 0, ly = 0, lz = 0;
    if (VT > 1e-5) {
      // CoP shift = lead · cos α · (offset along the flow) / chord; ≈ quarter chord at lead 3
      const chord = (Math.abs(Tx * fr[0] + Ty * fr[1] + Tz * fr[2]) * t.width + Math.abs(Tx * fr[3] + Ty * fr[4] + Tz * fr[5]) * t.height) / VT;
      const g = P.leadingEdge / (U * (chord + 1e-6));
      lx = Tx * g; ly = Ty * g; lz = Tz * g;
    }
    const base = c1 + P.lift * VT;
    const s = t.normalScale;
    const third = 1 / 3;

    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
      const ax = x[a], ay = x[a + 1], az = x[a + 2];
      const e1x = x[b] - ax, e1y = x[b + 1] - ay, e1z = x[b + 2] - az;
      const e2x = x[c] - ax, e2y = x[c + 1] - ay, e2z = x[c + 2] - az;
      // cross product: area-weighted face normal, for the vertex normals...
      const cnx = e1y * e2z - e1z * e2y;
      const cny = e1z * e2x - e1x * e2z;
      const cnz = e1x * e2y - e1y * e2x;
      N[a] += cnx; N[a + 1] += cny; N[a + 2] += cnz;
      N[b] += cnx; N[b + 1] += cny; N[b + 2] += cnz;
      N[c] += cnx; N[c + 1] += cny; N[c + 2] += cnz;
      // ...and ≈ unit normal × (area / rest area) for the air
      const mx = cnx * s, my = cny * s, mz = cnz * s;
      // triangle centre relative to the sheet's centroid
      const tx = ax + (e1x + e2x) * third - cx;
      const ty = ay + (e1y + e2y) * third - cy;
      const tz = az + (e1z + e2z) * third - cz;
      const se = tx * ex + ty * ey + tz * ez;
      const ux = (v[a] + v[b] + v[c]) * third - gwx - se * dx;
      const uy = (v[a + 1] + v[b + 1] + v[c + 1]) * third - gwy - se * dy;
      const uz = (v[a + 2] + v[b + 2] + v[c + 2]) * third - gwz - se * dz;
      const vn = ux * mx + uy * my + uz * mz;
      let lw = 1 + tx * lx + ty * ly + tz * lz;
      lw = lw < 0 ? 0 : lw > 2.5 ? 2.5 : lw;
      let kn = (base + c2 * (vn < 0 ? -vn : vn)) * lw;
      if (kn > kmax) kn = kmax;
      const fn = ct - kn; // tangential drag on everything, minus the normal part, plus the face force
      const fx = fn * vn * mx - ct * ux;
      const fy = fn * vn * my - ct * uy;
      const fz = fn * vn * mz - ct * uz;
      F[a] += fx; F[a + 1] += fy; F[a + 2] += fz;
      F[b] += fx; F[b + 1] += fy; F[b + 2] += fz;
      F[c] += fx; F[c + 1] += fy; F[c + 2] += fz;
    }
    // sum over triangles → mean per particle; area-weighted normals → unit
    const inv = t.invTris;
    for (let i = 0, p = 0; i < this.count; i++, p += 3) {
      const k = inv[i];
      F[p] *= k;
      F[p + 1] *= k;
      F[p + 2] *= k;
      const l2 = N[p] * N[p] + N[p + 1] * N[p + 1] + N[p + 2] * N[p + 2];
      if (l2 > 1e-30) {
        const q = 1 / Math.sqrt(l2);
        N[p] *= q;
        N[p + 1] *= q;
        N[p + 2] *= q;
      } else {
        // folded flat onto itself: fall back to the sheet's overall facing
        N[p] = nx;
        N[p + 1] = ny;
        N[p + 2] = nz;
      }
    }
  }

  // ------------------------------------------------------------- contacts

  // Colliders are flattened into numbers once a frame: [kind, centre xyz, normal xyz | radius,
  // r² (disk) or (r+margin)² (sphere), friction, last frame's centre xyz, last frame's normal xyz].
  // The contract gives no collider identity or velocity, so a slot that keeps its kind is taken to
  // be the same collider (keep the order stable); a new one — or one that jumped further than any
  // hand moves in a frame — starts with no history, so it can't drag or shove paper on arrival.
  private trackColliders(cols: Collider[]) {
    const dt = this.sub[4];
    const m = Math.min(cols.length, MAX_COLLIDERS);
    const cd = this.colData;
    const margin = PAPER.contactMargin;
    const lim = PAPER.maxSpeed * dt;
    for (let k = 0; k < m; k++) {
      const c = cols[k];
      const q = k * CD;
      const known = this.colKinds[k] === c.kind;
      // last frame's pose, before it is overwritten
      cd[q + 9] = cd[q + 1]; cd[q + 10] = cd[q + 2]; cd[q + 11] = cd[q + 3];
      cd[q + 12] = cd[q + 4]; cd[q + 13] = cd[q + 5]; cd[q + 14] = cd[q + 6];
      cd[q + 1] = c.center[0];
      cd[q + 2] = c.center[1];
      cd[q + 3] = c.center[2];
      if (c.kind === 'disk') {
        const l = Math.sqrt(c.normal[0] * c.normal[0] + c.normal[1] * c.normal[1] + c.normal[2] * c.normal[2]);
        cd[q] = 0;
        cd[q + 4] = l > 1e-9 ? c.normal[0] / l : 0;
        cd[q + 5] = l > 1e-9 ? c.normal[1] / l : 1;
        cd[q + 6] = l > 1e-9 ? c.normal[2] / l : 0;
        cd[q + 7] = c.radius * c.radius;
      } else {
        cd[q] = 1;
        cd[q + 4] = c.radius + margin;
        cd[q + 7] = (c.radius + margin) * (c.radius + margin);
      }
      cd[q + 8] = Math.max(0, c.friction);
      // an explicit velocity (not in the contract, but welcome) beats the guess from last frame
      const given = (c as { velocity?: V3 }).velocity;
      if (given && finite3(given)) {
        for (let e = 0; e < 3; e++) cd[q + 9 + e] = cd[q + 1 + e] - given[e] * dt;
      }
      const jx = cd[q + 1] - cd[q + 9], jy = cd[q + 2] - cd[q + 10], jz = cd[q + 3] - cd[q + 11];
      if (!known || !(jx * jx + jy * jy + jz * jz <= lim * lim)) {
        for (let e = 0; e < 3; e++) cd[q + 9 + e] = cd[q + 1 + e];
      }
      if (!known || c.kind !== 'disk') {
        for (let e = 0; e < 3; e++) cd[q + 12 + e] = cd[q + 4 + e];
      }
      this.colKinds[k] = c.kind;
    }
    this.colKinds.length = m;
  }

  // ------------------------------------------------------------- memory & rest

  /** a pin jumping further than any hand can move is a tracking glitch: carry the whole sheet with it */
  private followTeleports() {
    const lim2 = PAPER.teleport * PAPER.teleport;
    let jx = 0, jy = 0, jz = 0, jump = 0;
    for (let k = 0; k < this.pinCount; k++) {
      const p = this.pinList[k] * 3;
      const dx = this.pinTo[p] - this.pinFrom[p], dy = this.pinTo[p + 1] - this.pinFrom[p + 1], dz = this.pinTo[p + 2] - this.pinFrom[p + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > lim2 && d2 > jump) { jump = d2; jx = dx; jy = dy; jz = dz; }
    }
    // (an attach pose that jumps is not a glitch to follow: it's a note being handed to another
    // palm, or called back to the stand — the capped swoop in integrate() flies it there)
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
    this.airValid = false; // centroid & co. moved with it
  }

  private updateSleep(env: PaperEnv) {
    const P = PAPER;
    const squeeze = this.sub[2], dt = this.sub[4];
    const busy = this.pinCount > 0 || this.attachOn || squeeze > 0 || this.relax > 0 || this.colliderContacts > 0;
    if (busy || this.floorContacts === 0 || this.speed > P.sleepSpeed) {
      this.stillFor = 0;
      return;
    }
    this.stillFor += dt;
    if (this.stillFor < P.sleepAfter) return;
    this.sleeping = true;
    this.vel.fill(0);
    this.speed = 0;
    const k = this.sleepKey;
    k[0] = env.floorY;
    k[1] = env.wind[0];
    k[2] = env.wind[1];
    k[3] = env.wind[2];
    k[4] = gravityLength(env);
    const c = this.moments; // the centroid, fresh from the last substep
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
    if (Math.abs(gravityLength(env) - k[4]) > 1e-3) return true;
    const b = this.bound;
    for (let i = 0; i < env.colliders.length; i++) {
      const c = env.colliders[i];
      const dx = c.center[0] - b[0], dy = c.center[1] - b[1], dz = c.center[2] - b[2];
      const r = b[3] + c.radius + 0.1;
      if (dx * dx + dy * dy + dz * dz < r * r) return true;
    }
    return false;
  }
}

// ------------------------------------------------------------------ solvers

function finite3(v: ArrayLike<number>) {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

// (Math.hypot boxes its arguments: fine once, not every frame)
function gravityLength(env: PaperEnv) {
  const g = env.gravity;
  return Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
}

/** quaternion (wxyz, written at out[o]) of the rotation whose columns are right, up, normal (Shepperd) */
function quatFromFrame(rx: number, ry: number, rz: number, ux: number, uy: number, uz: number, nx: number, ny: number, nz: number, out: Float64Array, o: number) {
  let w, x, y, z;
  const tr = rx + uy + nz;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (uz - ny) / s; y = (nx - rz) / s; z = (ry - ux) / s;
  } else if (rx > uy && rx > nz) {
    const s = Math.sqrt(1 + rx - uy - nz) * 2;
    w = (uz - ny) / s; x = s / 4; y = (ux + ry) / s; z = (nx + rz) / s;
  } else if (uy > nz) {
    const s = Math.sqrt(1 + uy - rx - nz) * 2;
    w = (nx - rz) / s; x = (ux + ry) / s; y = s / 4; z = (ny + uz) / s;
  } else {
    const s = Math.sqrt(1 + nz - rx - uy) * 2;
    w = (ry - ux) / s; x = (nx + rz) / s; y = (ny + uz) / s; z = s / 4;
  }
  const l = Math.sqrt(w * w + x * x + y * y + z * z) || 1;
  out[o] = w / l; out[o + 1] = x / l; out[o + 2] = y / l; out[o + 3] = z / l;
}

/** orthonormalise (right, up) and write its quaternion; false (and nothing written) if degenerate */
function quatFromRightUp(right: V3, up: V3, out: Float64Array, o: number) {
  let rx = right[0], ry = right[1], rz = right[2];
  let l = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (!(l > 1e-6)) return false;
  rx /= l; ry /= l; rz /= l;
  let ux = up[0], uy = up[1], uz = up[2];
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const d = ux * rx + uy * ry + uz * rz;
  ux -= d * rx; uy -= d * ry; uz -= d * rz;
  l = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (!(l > 0.01 * ul)) return false; // within half a degree of parallel: the normal would be noise
  ux /= l; uy /= l; uz /= l;
  quatFromFrame(rx, ry, rz, ux, uy, uz, ry * uz - rz * uy, rz * ux - rx * uz, rx * uy - ry * ux, out, o);
  return true;
}

// Doubles for the solver functions ride in here, for the same reason as PaperSheet.sub
const knob = new Float64Array(1);

/** stiffness knob[0]; sweeps the constraint range forward, or backward when back = 1 */
function solveDistances(x: Float32Array, w: Float32Array, pairs: Uint16Array, rest: Float32Array, from: number, to: number, back: number) {
  const k = knob[0];
  for (let j = from; j < to; j++) {
    const c = back ? to - 1 - (j - from) : j;
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

/**
 * Strain limiting, pin outward (follow-the-leader): pairs are (inner, outer) in order of
 * distance from the pin, and only the outer end moves. The move is also recorded in `slip`,
 * which finish() adds to the substep's start position when it measures velocity, so it adds
 * none (follow-the-leader that feeds velocities pumps energy into the sheet). It must not edit
 * the start position itself: contacts read that to tell which side of a palm the paper was on.
 */
function limitStretch(x: Float32Array, prev: Float32Array, slip: Float32Array, w: Float32Array, pairs: Uint16Array, rest: Float32Array, to: number) {
  const max = knob[0];
  for (let c = 0; c < to; c++) {
    const ib = pairs[c * 2 + 1];
    if (w[ib] === 0) continue;
    const a = pairs[c * 2] * 3, b = ib * 3;
    const dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    const r = rest[c] * max;
    if (d2 <= r * r) continue;
    const d = Math.sqrt(d2);
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const k = r - d;
    x[b] += nx * k; x[b + 1] += ny * k; x[b + 2] += nz * k;
    // relative motion along the edge this substep, before the move; negative = recoiling
    const rel =
      (x[b] - prev[b] - slip[b] - x[a] + prev[a] + slip[a]) * nx +
      (x[b + 1] - prev[b + 1] - slip[b + 1] - x[a + 1] + prev[a + 1] + slip[a + 1]) * ny +
      (x[b + 2] - prev[b + 2] - slip[b + 2] - x[a + 2] + prev[a + 2] + slip[a + 2]) * nz -
      k;
    // hide the move from the velocity, and drop any recoil: an overstretched edge that snaps
    // back would otherwise bounce
    const hide = k + (rel < 0 ? rel : 0);
    slip[b] += nx * hide; slip[b + 1] += ny * hide; slip[b + 2] += nz * hide;
  }
}

// Linear bending on three particles along a row/column: C = xa − 2xb + xc.
// Zero for any straight, evenly spaced triple, so it's rotation-invariant and needs no sqrt.
function solveBending(x: Float32Array, w: Float32Array, trip: Uint16Array) {
  const k = knob[0];
  for (let t = 0; t < trip.length; t += 3) {
    const ia = trip[t], ib = trip[t + 1], ic = trip[t + 2];
    const wa = w[ia], wb = w[ib], wc = w[ic];
    const den = wa + 4 * wb + wc;
    if (den === 0) continue;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const cx = x[a] + x[c] - 2 * x[b];
    const cy = x[a + 1] + x[c + 1] - 2 * x[b + 1];
    const cz = x[a + 2] + x[c + 2] - 2 * x[b + 2];
    const l = k / den;
    const la = l * wa, lb = 2 * l * wb, lc = l * wc;
    x[a] -= cx * la; x[a + 1] -= cy * la; x[a + 2] -= cz * la;
    x[b] += cx * lb; x[b + 1] += cy * lb; x[b + 2] += cz * lb;
    x[c] -= cx * lc; x[c + 1] -= cy * lc; x[c + 2] -= cz * lc;
  }
}

