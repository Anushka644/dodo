// Turns tracked hands into the poses the toy reacts to. Pure TypeScript — no
// DOM, no MediaPipe — so every rule is unit-tested with synthetic hands
// (scripts/tests/gestures.test.ts).
//
// Shape tests (fingers, pinch, rub) use the WORLD landmarks: metric, isotropic
// and hand-centred, so they don't care where the hand is, how big it looks or
// how it's turned — including toward the camera. Screen positions use the
// video landmarks.

import type { GestureTrackerApi, HandGesture, HandsFrame, Pose, TrackedHand, V2, V3 } from '../contracts';

/** Tuning. Shape distances are in palm lengths (wrist → middle knuckle, ≈ 8.5 cm). */
export const GESTURE = {
  /** thumb tip ↔ index tip: engage below, release above (hysteresis) */
  pinchOn: 0.22,
  pinchOff: 0.35,
  /** pinch.strength is 0 at pinchFar and 1 at pinchTouch */
  pinchFar: 0.6,
  pinchTouch: 0.15,
  /** per-finger extension score (0 curled … 1 straight): extended above On, drops below Off */
  extOn: 0.62,
  extOff: 0.5,
  /** curled below On, uncurls above Off */
  curlOn: 0.3,
  curlOff: 0.4,
  /** a new pose must persist this long before it's reported (pinch release is immediate) */
  poseHoldMs: 80,
  /** palm velocity smoothing time constant */
  velTauMs: 45,
  rub: {
    /** thumb tip ↔ the index–middle tip segment: the gate opens below On, closes above Off */
    nearOn: 0.4,
    nearOff: 0.55,
    /** the smallest back-and-forth slide that counts as a reversal; sits above jitter */
    stroke: 0.06,
    /** a bigger swing is the hand reshaping, not a rub */
    maxStroke: 0.9,
    /** reversals are counted over this window… */
    windowMs: 900,
    /** …and this many switch the rub on */
    onCount: 3,
    /** it stays on while a reversal came this recently (and ≥ 2 are in the window) */
    holdMs: 380,
    /** reversals/s × stroke (palm lengths) that reads as intensity 1 */
    full: 0.9,
    /** intensity smoothing */
    tauMs: 140,
  },
};

const FINGERS = 4; // index, middle, ring, pinky — the thumb is judged by pinch/rub

interface Rub {
  near: boolean;
  /** zig-zag: last turning point and the farthest point reached since */
  anchor: V3 | null;
  far: V3;
  /** confirmed reversals: when, and the stroke that led to them */
  marks: { t: number; amp: number }[];
  active: boolean;
  intensity: number;
}

interface State {
  t: number;
  pose: Pose;
  pending: Pose;
  pendingAt: number;
  palm: V2 | null;
  vel: V2;
  pinch: boolean;
  ext: boolean[];
  curl: boolean[];
  rub: Rub;
}

const fresh = (): State => ({
  t: -1,
  pose: 'none',
  pending: 'none',
  pendingAt: 0,
  palm: null,
  vel: [0, 0],
  pinch: false,
  ext: [false, false, false, false],
  curl: [false, false, false, false],
  rub: { near: false, anchor: null, far: [0, 0, 0], marks: [], active: false, intensity: 0 },
});

export class GestureTracker implements GestureTrackerApi {
  private states = new Map<number, State>();

  update(frame: HandsFrame): HandGesture[] {
    const out: HandGesture[] = [];
    const seen = new Set<number>();
    for (const h of frame.hands) {
      if (h.landmarks.length < 21) continue;
      seen.add(h.id);
      let s = this.states.get(h.id);
      if (!s) this.states.set(h.id, (s = fresh()));
      out.push(track(h, s, frame.t));
    }
    // a hand that left takes its history with it; if it comes back it starts clean
    for (const id of this.states.keys()) if (!seen.has(id)) this.states.delete(id);
    return out;
  }

  reset() {
    this.states.clear();
  }
}

function track(h: TrackedHand, s: State, t: number): HandGesture {
  const G = GESTURE;
  const L = h.landmarks;
  const xy = (i: number): V2 => [L[i].x, L[i].y];

  // ---- where it is (video space)
  const palm: V2 = [0, 0];
  for (const i of [0, 5, 9, 13, 17]) {
    palm[0] += L[i].x / 5;
    palm[1] += L[i].y / 5;
  }
  const palmSize = Math.hypot(L[0].x - L[9].x, L[0].y - L[9].y);
  const dt = s.t < 0 ? 0 : t - s.t;
  if (dt > 0 && s.palm) {
    // dt-aware EMA: a squeezed frame interval can't spike the velocity
    const k = 1 - Math.exp(-dt / G.velTauMs);
    s.vel[0] += k * (((palm[0] - s.palm[0]) * 1000) / dt - s.vel[0]);
    s.vel[1] += k * (((palm[1] - s.palm[1]) * 1000) / dt - s.vel[1]);
  }
  s.palm = palm;
  s.t = t;

  // ---- how it's turned (camera frame: x right, y up, z toward the viewer)
  const P = shape(h);
  const size = dist(P[0], P[9]) || 1;
  const up = norm(sub(P[9], P[0]), [0, 1, 0]);
  // knuckles run index → pinky. The data is mirrored (the screen is a mirror),
  // so a real right hand has a left hand's geometry: its palm side is up × across.
  const across = sub(P[5], P[17]);
  const n = norm(h.handedness === 'Right' ? cross(up, across) : cross(across, up), [0, 0, 1]);
  const side = cross(up, n);

  // ---- fingers
  for (let f = 0; f < FINGERS; f++) {
    const e = extension(P, f);
    s.ext[f] = s.ext[f] ? e > G.extOff : e > G.extOn;
    s.curl[f] = s.curl[f] ? e < G.curlOff : e < G.curlOn;
  }
  const open = s.ext.every(Boolean);
  const fist = s.curl.every(Boolean);
  const point = s.ext[0] && s.curl[1] && !s.ext[2] && !s.ext[3];

  // ---- pinch. Needs a live index finger to engage (a fist tucks the thumb near
  // the index tip too), and closing into a fist lets go — so you can crumple what you hold.
  const pd = dist(P[4], P[8]) / size;
  s.pinch = s.pinch ? pd < G.pinchOff && !fist : pd < G.pinchOn && !s.curl[0];

  // ---- rub
  const R = G.rub;
  const rub = s.rub;
  const near = segDist(P[4], P[8], P[12]) / size;
  rub.near = (rub.near ? near < R.nearOff : near < R.nearOn) && !(s.curl[0] && s.curl[1]);
  if (!rub.near) {
    rub.anchor = null;
    rub.marks.length = 0;
  } else {
    // thumb tip relative to the index/middle tips, in palm lengths, in the hand's
    // own frame (so moving or turning the hand changes nothing), with the
    // component off the finger pads removed (so tapping isn't rubbing)
    let r = scale(sub(P[4], mid(P[8], P[12])), 1 / size);
    const along = add(sub(P[8], P[7]), sub(P[12], P[11]));
    const pad = cross(along, across);
    const pl = len(pad);
    if (pl > 1e-9) r = sub(r, scale(pad, dot(r, pad) / (pl * pl)));
    zigzag(rub, [dot(r, side), dot(r, up), dot(r, n)], t);
  }
  while (rub.marks.length && t - rub.marks[0].t > R.windowMs) rub.marks.shift();
  const m = rub.marks;
  const last = m.length ? m[m.length - 1].t : -Infinity;
  rub.active = rub.near && (rub.active ? m.length >= 2 && t - last <= R.holdMs : m.length >= R.onCount);
  let vigour = 0;
  if (rub.active && m.length >= 2) {
    const rate = (m.length - 1) / Math.max(0.1, (last - m[0].t) / 1000);
    const amp = m.reduce((a, b) => a + b.amp, 0) / m.length;
    vigour = clamp01((rate * amp) / R.full);
  }
  if (dt > 0) rub.intensity += (1 - Math.exp(-dt / R.tauMs)) * (vigour - rub.intensity);
  else rub.intensity = vigour;

  // ---- pose, debounced
  const want: Pose = rub.active ? 'rub' : s.pinch ? 'pinch' : point ? 'point' : fist ? 'fist' : open ? 'open' : 'none';
  if (want === s.pose) s.pending = want;
  else if (s.pose === 'pinch' && !s.pinch) {
    // letting go has to feel instant
    s.pose = s.pending = want;
  } else if (want !== s.pending) {
    s.pending = want;
    s.pendingAt = t;
  } else if (t - s.pendingAt >= G.poseHoldMs) s.pose = want;

  const t4 = xy(4);
  const t8 = xy(8);
  const t12 = xy(12);
  const d6 = [t8[0] - L[6].x, t8[1] - L[6].y];
  const dl = Math.hypot(d6[0], d6[1]) || 1;
  return {
    id: h.id,
    handedness: h.handedness,
    pose: s.pose,
    palm,
    palmSize,
    palmNormal: n,
    palmUp: up,
    velocity: [s.vel[0], s.vel[1]],
    pinch: {
      active: s.pinch,
      strength: clamp01((G.pinchFar - pd) / (G.pinchFar - G.pinchTouch)),
      point: [(t4[0] + t8[0]) / 2, (t4[1] + t8[1]) / 2],
    },
    point: { active: point, tip: t8, dir: [d6[0] / dl, d6[1] / dl] },
    fist,
    open,
    rub: {
      active: rub.active,
      intensity: rub.intensity,
      point: [0.5 * t4[0] + 0.25 * (t8[0] + t12[0]), 0.5 * t4[1] + 0.25 * (t8[1] + t12[1])],
    },
  };
}

/**
 * Direction-free zig-zag: from the last turning point, track the farthest point
 * reached; once the thumb has come back `stroke` from it, that was a reversal.
 * Works for back-and-forth along or across the fingers and for small circles
 * (two reversals a lap). Jitter never travels `stroke`, so it never counts.
 */
function zigzag(r: Rub, q: V3, t: number) {
  const R = GESTURE.rub;
  if (!r.anchor) {
    r.anchor = q;
    r.far = q;
    return;
  }
  if (dist(q, r.anchor) >= dist(r.far, r.anchor)) r.far = q;
  else if (dist(q, r.far) >= R.stroke) {
    const amp = dist(r.far, r.anchor);
    if (amp > R.maxStroke) r.marks.length = 0;
    else r.marks.push({ t, amp });
    r.anchor = r.far;
    r.far = q;
  }
}

/** hand shape in the camera frame, from world landmarks (video landmarks if those are missing) */
function shape(h: TrackedHand): V3[] {
  if (h.world.length === 21) {
    const P = h.world.map(([x, y, z]): V3 => [x, -y, -z]);
    if (dist(P[0], P[9]) > 1e-4) return P;
  }
  return h.landmarks.map((l): V3 => [l.x, -l.y, -l.z]);
}

/**
 * 0 = curled into the palm, 1 = straight. Distances only, so it's rotation-invariant:
 * how far the tip reaches from the wrist compared with the middle joint (catches
 * bending at the knuckle), and how straight the finger itself is.
 */
export function extension(P: V3[], finger: number): number {
  const b = 5 + 4 * finger;
  const [mcp, pip, dip, tip] = [P[b], P[b + 1], P[b + 2], P[b + 3]];
  const reach = dist(P[0], tip) / Math.max(1e-9, dist(P[0], pip));
  const straight = dist(mcp, tip) / Math.max(1e-9, dist(mcp, pip) + dist(pip, dip) + dist(dip, tip));
  return 0.5 * ramp(reach, 0.95, 1.3) + 0.5 * ramp(straight, 0.55, 0.92);
}

// ------------------------------------------------------------------ vec

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ramp = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));

function norm(a: V3, fallback: V3): V3 {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
}

/** distance from p to the segment ab */
function segDist(p: V3, a: V3, b: V3) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const k = l2 > 1e-12 ? clamp01(dot(sub(p, a), ab) / l2) : 0;
  return dist(p, add(a, scale(ab, k)));
}
