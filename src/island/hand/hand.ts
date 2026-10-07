// Your hand, in the world. The webcam gives 21 landmarks; this turns them into
// a giant hand reaching into the island, the way a reflection does:
//
//   · where it is: the hand sits under the spot where you see it in the mirror,
//     and reaching towards the screen lowers it towards the island (a bigger
//     hand in the frame is a hand closer to the camera);
//   · its shape: MediaPipe's metric 3D landmarks, turned so that a palm shown
//     to the camera lies palm-up in the world (offering it to the island),
//     fingers pointing into the scene, left and right as in the mirror.
//
// It also reads a few things off the hand for the rest of the world: the palm
// (a little floor dodos can stand on), whether the fingers are wiggling (rain),
// and where the fingertips are (ripples in the sea).

import type { HandPose, P3 } from './tracker';

export type V3 = [number, number, number];

export interface ViewCam {
  pos: V3;
  fwd: V3;
  right: V3;
  up: V3;
  tanFov: number;
  /** canvas width / height */
  aspect: number;
  /** distance from the camera to what it orbits */
  dist: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** along the forearm from the wrist: away from the knuckles, a little towards the viewer and down (as the shader has it) */
export function cuffDir(knuckle: V3, wrist: V3, camPos: V3): V3 {
  const arm = norm(sub(wrist, knuckle));
  const view = norm(sub(camPos, wrist));
  return norm(add(add(arm, mul(view, 0.1)), [0, -0.1, 0]));
}

/** how far a hand shown upright to the camera leans back into the scene (radians from flat) */
const TILT = 0.7;

/** the joints a palm is made of: wrist and the four knuckles */
const PALM = [0, 5, 9, 13, 17];
export const TIPS = [4, 8, 12, 16, 20];
/** the parts of a hand that touch water first: fingertips, the wrist, the middle knuckle */
export const TOUCH = [4, 8, 12, 16, 20, 0, 9];

/** each joint's radius, in metres (fingers taper; the thumb is thick) */
const RADII = [
  0.024, 0.0135, 0.0115, 0.0102, 0.009, // wrist, thumb
  0.0105, 0.0095, 0.0085, 0.0078, // index
  0.0108, 0.0098, 0.0088, 0.008, // middle
  0.0102, 0.0092, 0.0082, 0.0075, // ring
  0.0095, 0.0082, 0.0074, 0.0068, // pinky
];

export class WorldHand {
  /** joint positions in world units */
  readonly joints: V3[] = Array.from({ length: 21 }, () => [0, 0, 0] as V3);
  /** 0 → 1 as the hand materialises; back to 0 when it's gone */
  present = 0;
  /** world units per metre of real hand */
  scale = 7;
  /** the palm as a little floor: centre, normal (up = palm up), and its axes */
  palm = { c: [0, 0, 0] as V3, n: [0, 1, 0] as V3, fwd: [0, 0, 1] as V3, side: [1, 0, 0] as V3, half: 0.3, len: 0.6 };
  /** how hard the fingers are wiggling, 0..1 */
  wiggle = 0;
  /** the palm's velocity, world units / s (for things it lets go of) */
  vel: V3 = [0, 0, 0];
  private anchor: V3 | null = null;
  private tipsLocal: number[] | null = null;
  private lastPose: HandPose | null = null;
  /** time since the fingers were last read (camera frames are slower than ours) */
  private fingerDt = 0;
  /** how big the hand looked when it arrived: that distance from the camera is mid-height */
  private neutral = 0.18;
  private sizes: number[] = [];
  private calibrated = false;
  private absent = 0;

  get visible() {
    return this.present > 0.01;
  }

  tips(): V3[] {
    return TIPS.map((i) => this.joints[i]);
  }

  /** the points that can touch the sea, each with how far its skin reaches below it */
  touches(): { p: V3; r: number }[] {
    return TOUCH.map((i) => ({ p: this.joints[i], r: RADII[i] * this.scale * (i === 0 || i === 9 ? 1.4 : 1) }));
  }

  /** is the palm up and steady enough to stand on? (a hand held up to the camera leans back about 40°) */
  get offering() {
    return this.present > 0.8 && this.palm.n[1] > 0.6;
  }

  /** a point on the palm's surface, from palm coordinates (u across, v along) */
  palmPoint(u: number, v: number): V3 {
    const p = this.palm;
    return add(add(add(p.c, mul(p.side, u)), mul(p.fwd, v)), mul(p.n, RADII[0] * this.scale * 0.75));
  }

  update(dt: number, pose: HandPose | null, cam: ViewCam, ground: (x: number, z: number) => number) {
    if (!pose) {
      // a hand that's gone withdraws upwards as it fades; gone a while, it's a new arrival
      this.absent += dt;
      if (this.absent > 4) {
        this.calibrated = false;
        this.sizes = [];
      }
      this.tipsLocal = null;
      this.present = Math.max(0, this.present - dt * 1.8);
      if (this.anchor) this.anchor[1] += dt * 0.8;
      if (this.present > 0) this.place(this.lastPose, cam);
      else this.anchor = null;
      this.wiggle = Math.max(0, this.wiggle - dt * 3);
      this.vel = [0, 0, 0];
      return;
    }
    const fresh = pose !== this.lastPose;
    this.lastPose = pose;
    this.absent = 0;
    this.present = Math.min(1, this.present + dt * 2.5);
    // a hand the size of a small hill, a little bigger as you pull the camera back
    this.scale = 7 * clamp(Math.sqrt(cam.dist / 5.2), 0.6, 1.6);

    // where: under the palm as you see it in the mirror, a little beyond the frame so the
    // whole island is in reach without leaving the camera's view
    const img = pose.image;
    const pc = PALM.reduce((s, i) => ({ x: s.x + img[i].x / 5, y: s.y + img[i].y / 5 }), { x: 0, y: 0 });
    const nx = clamp((pc.x * 2 - 1) * 1.3, -1, 1);
    const ny = clamp((1 - pc.y * 2) * 1.3, -1, 1);
    const rd = norm(add(cam.fwd, add(mul(cam.right, nx * cam.tanFov * cam.aspect), mul(cam.up, ny * cam.tanFov))));
    // how far it reaches in: how big the hand looks. Read off whichever palm segment is
    // least foreshortened (so turning the palm up doesn't look like moving away), in
    // frame heights per metre, times the hand's real wrist-to-knuckle length
    const w = pose.world;
    const metric = (a: number, b: number) => Math.hypot(w[b].x - w[a].x, w[b].y - w[a].y, w[b].z - w[a].z) || 1e-3;
    const seg = (a: number, b: number) => Math.hypot((img[b].x - img[a].x) * pose.aspect, img[b].y - img[a].y) / metric(a, b);
    const size = Math.max(seg(0, 9), seg(0, 5), seg(0, 17), seg(5, 17)) * metric(0, 9);
    // wherever you first hold your hand is mid-height; closer reaches in, further lifts it
    if (!this.calibrated && fresh && Number.isFinite(size)) {
      this.sizes.push(size);
      if (this.sizes.length >= 20) {
        const sorted = [...this.sizes].sort((a, b) => a - b);
        this.neutral = clamp(sorted[sorted.length >> 1], 0.12, 0.3);
        this.calibrated = true;
      }
    }
    const rel = Math.log(Math.max(size, 1e-3) / this.neutral);
    const reach = smooth(-0.4, 0.25, rel);
    const S = this.scale / 7;
    // reaching right in dips it into the sea
    const dip = smooth(0.25, 0.4, rel) * 0.2 * S;
    // follow that ray in until it comes within `lift` of the ground (or the sea) — and never
    // let the band reach the camera, or the hand would land in front of the lens
    const camAbove = cam.pos[1] - Math.max(0, ground(cam.pos[0], cam.pos[2]));
    const lift = Math.min(0.08 + (1 - reach) * 1.6 * S, 0.5 * Math.max(camAbove, 0.1));
    const above = (t: number) => {
      const q = add(cam.pos, mul(rd, t));
      const g = ground(q[0], q[2]);
      return q[1] - (Math.max(0, g) + lift - (g <= 0 ? dip : 0));
    };
    const far = cam.dist * 2;
    let t = 0.2 * cam.dist;
    let prevT = t;
    let found = false;
    for (let i = 0; i < 240 && t < far; i++) {
      const h = above(t);
      if (h <= 0) {
        let a = prevT, b = t;
        for (let k = 0; k < 12; k++) {
          const m = (a + b) / 2;
          if (above(m) > 0) a = m;
          else b = m;
        }
        t = (a + b) / 2;
        found = true;
        break;
      }
      prevT = t;
      t += Math.max(0.02, h * 0.5);
    }
    // pointing above the horizon (or past the world): hold it up at the same far limit,
    // so it never jumps between the two
    const target = add(cam.pos, mul(rd, found ? Math.min(t, far) : far));
    const prev = this.anchor;
    if (!this.anchor) this.anchor = target;
    else {
      const k = 1 - Math.exp(-dt * 14);
      this.anchor = add(this.anchor, mul(sub(target, this.anchor), k));
    }
    this.vel = prev ? mul(sub(this.anchor, prev), 1 / Math.max(dt, 1e-3)) : [0, 0, 0];
    const vs = len(this.vel);
    if (vs > 6) this.vel = mul(this.vel, 6 / vs);
    this.place(pose, cam);
    // the fingers only move when the camera sees them move: read them per camera frame
    this.fingerDt += dt;
    if (fresh) {
      this.readFingers(this.fingerDt);
      this.fingerDt = 0;
    }
  }

  /** shape: the metric landmarks, turned into the world about the anchor */
  private place(pose: HandPose | null, cam: ViewCam) {
    if (!pose || !this.anchor) return;
    // the camera's own right and "into the scene", kept level — then tipped back by
    // TILT about the right axis, so a hand held up to the camera rises into the
    // scene with its palm turned to you (flat, from up here, it would be all thumb)
    const right = norm([cam.right[0], 0, cam.right[2]]);
    const level = norm([cam.fwd[0], 0, cam.fwd[2]]);
    const away = add(mul(level, Math.cos(TILT)), [0, Math.sin(TILT), 0]);
    const up = add([0, Math.cos(TILT), 0], mul(level, -Math.sin(TILT)));
    const w = pose.world;
    const c = PALM.reduce((s, i) => ({ x: s.x + w[i].x / 5, y: s.y + w[i].y / 5, z: s.z + w[i].z / 5 }), { x: 0, y: 0, z: 0 });
    // mirrored x → right; up in the frame → into the scene; towards the camera → up
    const toWorld = (p: P3): V3 => {
      const x = (p.x - c.x) * this.scale, y = (p.y - c.y) * this.scale, z = (p.z - c.z) * this.scale;
      return add(this.anchor!, add(add(mul(right, x), mul(away, -y)), mul(up, -z)));
    };
    for (let i = 0; i < 21; i++) this.joints[i] = toWorld(w[i]);
    const J = this.joints;
    const fwd = norm(sub(J[9], J[0]));
    const sideRaw = sub(J[5], J[17]);
    // the mapping mirrors the hand (as the mirror does), so the palm side of a real
    // right hand is fwd × side, and of a left hand side × fwd
    let n = norm(cross(fwd, sideRaw));
    if (!pose.right) n = mul(n, -1);
    const side = norm(cross(n, fwd));
    const c3 = PALM.reduce((s, i) => add(s, mul(J[i], 0.2)), [0, 0, 0] as V3);
    this.palm = { c: c3, n, fwd, side, half: len(sideRaw) * 0.5 + 0.02, len: len(sub(J[9], J[0])) };
  }

  /** fingertips in the palm's own frame, so moving the whole hand doesn't count as a wiggle */
  private readFingers(dt: number) {
    const p = this.palm;
    const local = [8, 12, 16, 20].flatMap((i) => {
      const d = sub(this.joints[i], p.c);
      return [dot(d, p.side), dot(d, p.fwd), dot(d, p.n)].map((v) => v / this.scale);
    });
    if (this.tipsLocal && dt > 0) {
      let speed = 0;
      for (let i = 0; i < local.length; i += 3) speed += Math.hypot(local[i] - this.tipsLocal[i], local[i + 1] - this.tipsLocal[i + 1], local[i + 2] - this.tipsLocal[i + 2]) / dt;
      speed /= 4; // metres per second, per finger
      const want = smooth(0.08, 0.26, speed);
      this.wiggle += (want - this.wiggle) * Math.min(1, dt * (want > this.wiggle ? 6 : 1.5));
    }
    this.tipsLocal = local;
  }

  /** for the shader: 21 × (x, y, z, radius), and a sphere round the hand and its cloud cuff */
  uniforms(out: { joints: Float32Array; bound: Float32Array }, camPos: V3) {
    const S = this.scale / 7;
    // the cuff sits where the shader puts it: up the forearm from the wrist
    const w = this.joints[0];
    const cuff = add(w, mul(cuffDir(this.joints[9], w, camPos), 0.42 * S));
    const pts = [...this.joints, cuff];
    let cx = 0, cy = 0, cz = 0;
    for (const j of pts) {
      cx += j[0] / pts.length;
      cy += j[1] / pts.length;
      cz += j[2] / pts.length;
    }
    let r = Math.hypot(cuff[0] - cx, cuff[1] - cy, cuff[2] - cz) + 0.42 * S;
    this.joints.forEach((j, i) => {
      const rad = RADII[i] * this.scale;
      out.joints.set([j[0], j[1], j[2], rad], i * 4);
      r = Math.max(r, Math.hypot(j[0] - cx, j[1] - cy, j[2] - cz) + rad * 1.8);
    });
    out.bound.set([cx, cy, cz, this.visible ? r : 0]);
  }
}

/**
 * A plausible hand, for testing without a camera: an open hand shown to the
 * camera (palm towards it, fingers up), optionally turned to show its back,
 * curled, or wiggling. Coordinates as the tracker reports them (mirrored).
 */
export function syntheticPose(opts: { x?: number; y?: number; size?: number; back?: boolean; curl?: number; phase?: number; right?: boolean; tilt?: number } = {}): HandPose {
  const { x = 0.5, y = 0.55, size = 0.18, back = false, curl = 0.1, phase = 0, right = true, tilt = 0 } = opts;
  // a right hand, palm to the camera, in camera coords (x right, y down, z away), metres
  const knuckles: [number, number][] = [[0.03, -0.01], [0.009, -0.016], [-0.012, -0.013], [-0.031, -0.004]];
  const lengths = [[0.04, 0.025, 0.022], [0.045, 0.028, 0.024], [0.042, 0.026, 0.023], [0.033, 0.02, 0.019]];
  const pts: P3[] = [{ x: 0, y: 0.075, z: 0 }];
  // thumb, out to the side
  let tp = { x: 0.022, y: 0.055, z: -0.01 };
  pts.push(tp);
  for (const [dx, dy] of [[0.024, -0.02], [0.018, -0.022], [0.014, -0.02]]) {
    tp = { x: tp.x + dx, y: tp.y + dy, z: tp.z - 0.008 };
    pts.push(tp);
  }
  knuckles.forEach(([kx, ky], f) => {
    let p = { x: kx, y: ky, z: 0 };
    pts.push(p);
    let a = -Math.PI / 2 + (kx * 2.2); // fan slightly
    lengths[f].forEach((l, s) => {
      const c = curl * (s + 1) * 0.5 + Math.sin(phase * 9 + f * 1.7) * (phase ? 0.35 : 0);
      p = { x: p.x + Math.cos(a) * l * Math.cos(c), y: p.y + Math.sin(a) * l * Math.cos(c), z: p.z - l * Math.sin(c) };
      a += 0.02;
      pts.push(p);
    });
  });
  // a left hand is the mirror image; showing the back turns it about the vertical
  let world = pts.map((p) => ({ x: right ? p.x : -p.x, y: p.y, z: p.z }));
  if (back) world = world.map((p) => ({ x: -p.x, y: p.y, z: -p.z }));
  if (tilt) world = world.map((p) => ({ x: p.x, y: p.y * Math.cos(tilt) - p.z * Math.sin(tilt), z: p.y * Math.sin(tilt) + p.z * Math.cos(tilt) }));
  // the tracker mirrors x
  world = world.map((p) => ({ x: -p.x, y: p.y, z: p.z }));
  const k = size / 0.09;
  const image = world.map((p) => ({ x: x + p.x * k / (4 / 3), y: y + p.y * k, z: p.z * k }));
  return { image, world, right, score: 1, aspect: 4 / 3 };
}
