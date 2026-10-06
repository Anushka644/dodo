// Turns tracked hands into the poses the toy reacts to. Pure TypeScript — no
// DOM, no MediaPipe — so every rule is unit-tested with synthetic hands
// (scripts/tests/gestures.test.ts).
//
// Shape tests (fingers, pinch, rub) use the WORLD landmarks: metric, isotropic
// and hand-centred, so they don't care where the hand is, how big it looks or
// how it's turned — including toward the camera. Screen positions use the
// video landmarks.
//
// Learned as it runs: how much the tracking jitters (on the palm, which is
// rigid, and on the thumb signal itself), so a rub stroke must clear the noise
// whatever the frame rate, lighting or camera; and the video's aspect ratio, so
// palmSize reads the same whichever way the hand is turned.

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
  extOn: 0.7,
  extOff: 0.6,
  /** curled below On, uncurls above Off (≈ 140° of total flexion; a loose fist counts) */
  curlOn: 0.25,
  curlOff: 0.35,
  /** pointing: the middle finger must be at least this bent (a relaxed half-curl is fine) */
  pointMiddleMax: 0.5,
  /** a new pose must persist this long before it's reported (pinch release is immediate) */
  poseHoldMs: 80,
  /** palm velocity smoothing time constant */
  velTauMs: 45,
  rub: {
    /** thumb tip ↔ midpoint of the index/middle tips: the gate opens below On, closes above Off */
    nearOn: 0.4,
    nearOff: 0.55,
    /** …and the index and middle tips must be together (it's a two-finger gesture) */
    together: 0.55,
    /** how much thumb motion is kept for the stroke analysis */
    historyMs: 1000,
    /** the principal stroke axis favours the last this-many ms (so it turns quickly) */
    axisMs: 250,

    /**
     * THE sensitivity knob. The smallest back-and-forth slide that counts as a
     * reversal is `noise` × the measured jitter of the thumb signal (sd along one
     * axis), held within [strokeMin, strokeMax] palm lengths (≈ 4–13 mm). Lower
     * `noise` = timid rubs work, but jitter starts printing on its own.
     */
    noise: 3.8,
    strokeMin: 0.045,
    strokeMax: 0.15,
    /**
     * The jitter is the worse of two measures: the palm's (see `jitter` below) and
     * the thumb signal's own — its spread along the direction it moves least (a rub
     * is a line or a small circle, jitter goes every way), averaged over `floorMs`,
     * × `floorGain` for the small-sample bias. The second catches fingertips that
     * jitter more than the palm.
     */
    floorMs: 1000,
    floorGain: 1.5,

    /** starting: reversals are counted over this window… */
    windowMs: 900,
    /** …and this many switch the rub on… */
    onCount: 3,
    /**
     * …once they also add up to this much evidence: Σ (amplitude / stroke − 1).
     * Jitter strokes barely clear the threshold, real ones clear it by a lot — so
     * a vigorous rub fires on 3 reversals, a timid one after a few more, noise ~never.
     */
    evidence: 1.5,

    /** staying on: a reversal came this recently (and ≥ 2 are in the window)… */
    holdMs: 450,
    /**
     * …and the thumb is still swinging: the spread (sd) of its recent motion along
     * the stroke axis (weighted over ~`liveMs`) is ≥ `lively` × the jitter. Starting
     * needs that too; once on, `quietMs` of stillness stops it. Jitter can fake a
     * reversal now and then, not a sustained swing — so a thumb that stops, stops
     * the press.
     */
    liveMs: 160,
    lively: 1.4,
    quietMs: 120,
    /**
     * once on, strokes this fraction of the threshold keep it going (hysteresis)…
     * as long as they're also this fraction of the rub's own strokes
     */
    keep: 0.8,
    follow: 0.4,

    /** a bigger swing is the hand reshaping, not a rub */
    maxStroke: 0.9,
    /** motion this aligned with the finger pads' normal (|cos|) is tapping, not sliding */
    lift: 0.75,
    /** reversals/s × stroke (palm lengths) that reads as intensity 1 */
    full: 0.9,
    /** intensity smoothing */
    tauMs: 140,
    /** after printing, the thumb-on-fingers grip counts as a pinch again only this much later */
    regripMs: 200,
  },
  jitter: {
    /** assumed until measured: per-coordinate sd (m) of a smoothed world landmark at rest */
    prior: 0.001,
    /** each rigid palm distance is compared with its own mean over this long… */
    meanMs: 600,
    /** …and the wobble is averaged over this long */
    avgMs: 1500,
  },
};

/** palm distances that don't change as the hand moves: their wobble is pure tracking noise */
const RIGID: [number, number][] = [
  [0, 5],
  [0, 9],
  [0, 13],
  [5, 9],
  [9, 13],
];

/** what's learned about the camera as it runs, shared by every hand */
interface Cam {
  /** per-coordinate variance (m²) of a smoothed world landmark held still */
  jitter: number;
  /** video width ÷ height */
  aspect: number;
}
const freshCam = (): Cam => ({ jitter: GESTURE.jitter.prior ** 2, aspect: 16 / 9 });

const FINGERS = 4; // index, middle, ring, pinky — the thumb is judged by pinch/rub

interface Rub {
  near: boolean;
  /** recent thumb tip positions relative to the index/middle tips (hand frame, palm lengths) */
  hist: { t: number; r: V3 }[];
  /** principal axis of that motion; seeds the next frame's power iteration */
  axis: V3;
  active: boolean;
  /** mean stroke of the rub in progress (palm lengths) */
  amp: number;
  /** when it last switched off: starting again takes a reversal after this */
  since: number;
  /** since when the swing has been below `lively` (Infinity while it's swinging) */
  quiet: number;
  /** averaged least spread of the thumb signal (variance, palm lengths²; 0 = not yet) */
  floor: number;
  intensity: number;
}

const SEED: V3 = [0.577, 0.577, 0.577];

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
  /** world palm length (m), slowly averaged: the ruler for palmSize */
  palmM: number;
  /** slow means of the RIGID distances, and when they started */
  rig: number[] | null;
  rigAt: number;
  /** the world array last seen (a coasting hand repeats it: no new information) */
  seen: V3[] | null;
  /** last time it was printing */
  rubAt: number;
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
  palmM: 0,
  rig: null,
  rigAt: 0,
  seen: null,
  rubAt: -Infinity,
  rub: { near: false, hist: [], axis: SEED, active: false, amp: 0, since: -Infinity, quiet: Infinity, floor: 0, intensity: 0 },
});

export class GestureTracker implements GestureTrackerApi {
  private states = new Map<number, State>();
  private cam = freshCam();

  update(frame: HandsFrame): HandGesture[] {
    const out: HandGesture[] = [];
    const seen = new Set<number>();
    for (const h of frame.hands) {
      // (HandSlots never sends NaN; anyone else's NaN mustn't reach the shared camera estimates)
      if (h.landmarks.length < 21 || !h.landmarks.every((l) => Number.isFinite(l.x + l.y + l.z))) continue;
      seen.add(h.id);
      let s = this.states.get(h.id);
      if (!s) this.states.set(h.id, (s = fresh()));
      out.push(track(h, s, frame.t, this.cam));
    }
    // a hand that left takes its history with it; if it comes back it starts clean
    for (const id of this.states.keys()) if (!seen.has(id)) this.states.delete(id);
    return out;
  }

  reset() {
    this.states.clear();
    this.cam = freshCam();
  }
}

function track(h: TrackedHand, s: State, t: number, cam: Cam): HandGesture {
  const G = GESTURE;
  const L = h.landmarks;
  const xy = (i: number): V2 => [L[i].x, L[i].y];

  // ---- where it is (video space)
  const palm: V2 = [0, 0];
  for (const i of [0, 5, 9, 13, 17]) {
    palm[0] += L[i].x / 5;
    palm[1] += L[i].y / 5;
  }
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
  const metric =
    h.world.length === 21 && dist(h.world[0], h.world[9]) > 1e-4 && h.world.every((w) => Number.isFinite(w[0] + w[1] + w[2]));
  const P = shape(h, metric);
  const size = dist(P[0], P[9]) || 1;
  if (metric) {
    s.palmM = s.palmM ? s.palmM + 0.1 * (size - s.palmM) : size;
    if (h.world !== s.seen) listen(h.world, s, t, dt, cam);
  }
  s.seen = h.world;
  const palmSize = metric ? apparentPalm(h, s.palmM, cam) : Math.hypot(L[0].x - L[9].x, L[0].y - L[9].y);
  const up = norm(sub(P[9], P[0]), [0, 1, 0]);
  // pinky knuckle → index knuckle. The data is mirrored (the screen is a mirror),
  // so a real right hand has a left hand's geometry: its palm side is up × across.
  const across = sub(P[5], P[17]);
  const n = norm(h.handedness === 'Right' ? cross(up, across) : cross(across, up), [0, 0, 1]);
  const side = cross(up, n);

  // ---- fingers
  const e: number[] = [];
  for (let f = 0; f < FINGERS; f++) {
    e[f] = extension(P, f);
    s.ext[f] = s.ext[f] ? e[f] > G.extOff : e[f] > G.extOn;
    s.curl[f] = s.curl[f] ? e[f] < G.curlOff : e[f] < G.curlOn;
  }
  const open = s.ext.every(Boolean);
  const fist = s.curl.every(Boolean);

  // ---- pinch. Needs a live index finger to engage (a fist tucks the thumb near
  // the index tip too). Once held, squeezing into a fist keeps hold — the engine
  // crumples a note while the hand still has it — and opening the fist lets go.
  const pd = dist(P[4], P[8]) / size;
  s.pinch = s.pinch ? pd < G.pinchOff || fist : pd < G.pinchOn && !s.curl[0];
  const point = s.ext[0] && !s.ext[1] && !s.ext[2] && !s.ext[3] && e[1] < G.pointMiddleMax && !s.pinch;

  // ---- rub
  const R = G.rub;
  const rub = s.rub;
  const near = dist(P[4], mid(P[8], P[12])) / size;
  rub.near =
    (rub.near ? near < R.nearOff : near < R.nearOn) &&
    dist(P[8], P[12]) / size < R.together &&
    !(s.curl[0] && s.curl[1]);
  let pad: V3 | null = null;
  if (!rub.near) {
    rub.hist.length = 0;
    rub.axis = SEED;
    rub.quiet = Infinity;
  } else {
    // thumb tip relative to the index/middle tips, in palm lengths, in the hand's
    // own frame — so moving or turning the whole hand changes nothing
    const local = (v: V3): V3 => [dot(v, side), dot(v, up), dot(v, n)];
    rub.hist.push({ t, r: local(scale(sub(P[4], mid(P[8], P[12])), 1 / size)) });
    // the finger pads face along this; strokes along it are the thumb lifting off (a tap)
    const along = add(sub(P[8], P[7]), sub(P[12], P[11]));
    const c = cross(along, across);
    const cl = len(c);
    if (cl > 0.3 * len(along) * len(across)) pad = local(scale(c, 1 / cl));
  }
  while (rub.hist.length && t - rub.hist[0].t > R.historyMs) rub.hist.shift();
  // (held while rubbing: a moving thumb lets more jitter through the smoothing, and
  // that mustn't raise the bar for the rub in progress)
  if (rub.hist.length >= 10 && dt > 0 && !rub.active) {
    const l = leastSpread(rub.hist);
    rub.floor = rub.floor ? rub.floor + (1 - Math.exp(-dt / R.floorMs)) * (l - rub.floor) : l;
  }
  // a stroke must clear the jitter of the thumb-vs-fingertips signal (sd along one
  // axis, palm lengths): from the palm — the thumb's own plus the mean of two tips',
  // 1.5 × one landmark's variance — or from the thumb signal itself, whichever's worse
  const sd = metric
    ? Math.max(Math.sqrt(1.5 * cam.jitter) / size, R.floorGain * Math.sqrt(rub.floor))
    : R.strokeMax / R.noise;
  const stroke = clamp(R.noise * sd, R.strokeMin, R.strokeMax);
  const th = rub.active ? Math.max(stroke * R.keep, rub.amp * R.follow) : stroke;
  const m = strokes(rub, pad, t, th).filter((x) => t - x.t <= R.windowMs);
  const last = m.length ? m[m.length - 1].t : -Infinity;
  const evidence = m.reduce((a, b) => a + b.amp / stroke - 1, 0);
  const live = swing(rub, t) >= R.lively * sd;
  rub.quiet = live ? Infinity : Math.min(rub.quiet, t);
  const was = rub.active;
  // starting (again) takes a fresh reversal: the strokes that ran a rub mustn't
  // restart it the frame after it ends, but a rub that missed a beat picks up again
  rub.active =
    rub.near &&
    (rub.active
      ? m.length >= 2 && t - last <= R.holdMs && t - rub.quiet < R.quietMs
      : m.length >= R.onCount && evidence >= R.evidence && last > rub.since && live);
  if (was && !rub.active) rub.since = t;
  let vigour = 0;
  if (rub.active && m.length >= 2) {
    const rate = (m.length - 1) / Math.max(0.1, (last - m[0].t) / 1000);
    rub.amp = m.reduce((a, b) => a + b.amp, 0) / m.length;
    vigour = clamp01((rate * rub.amp) / R.full);
  } else if (!rub.active) rub.amp = 0;
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

  // a frame or two of lost rub doesn't stop the press: the outputs follow the debounced pose
  const rubbing = rub.active || s.pose === 'rub';
  if (rubbing) s.rubAt = t;

  const t4 = xy(4);
  const t8 = xy(8);
  const t12 = xy(12);
  const dx = t8[0] - L[6].x;
  const dy = t8[1] - L[6].y;
  const dl = Math.hypot(dx, dy);
  const dir: V2 = dl > 1e-9 ? [dx / dl, dy / dl] : [0, -1]; // degenerate: call it pointing up
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
      // the money gesture is a thumb on the fingertips too: printing isn't grabbing
      // (nor is a beat missed mid-rub, hence the wait)
      active: s.pinch && t - s.rubAt >= G.rub.regripMs,
      strength: clamp01((G.pinchFar - pd) / (G.pinchFar - G.pinchTouch)),
      point: [(t4[0] + t8[0]) / 2, (t4[1] + t8[1]) / 2],
    },
    point: { active: point, tip: t8, dir },
    fist,
    open,
    rub: {
      active: rubbing,
      intensity: rub.intensity,
      point: [0.5 * t4[0] + 0.25 * (t8[0] + t12[0]), 0.5 * t4[1] + 0.25 * (t8[1] + t12[1])],
    },
  };
}

/**
 * The thumb's reversals. First the principal axis of its recent motion (a rub
 * is a line or a small circle — either way, all of it shows on one axis, while
 * webcam jitter is spread over three), then a zig-zag along that axis: a turning
 * point counts once the thumb has come back `stroke` from it, which jitter
 * projected on one axis rarely manages.
 */
function strokes(rub: Rub, pad: V3 | null, now: number, stroke: number): { t: number; amp: number }[] {
  const R = GESTURE.rub;
  const H = rub.hist;
  if (H.length < 4) return [];
  // recency-weighted mean and covariance
  let W = 0;
  const mu: V3 = [0, 0, 0];
  const w = H.map((h) => Math.exp(-(now - h.t) / R.axisMs));
  H.forEach((h, i) => {
    W += w[i];
    for (let k = 0; k < 3; k++) mu[k] += w[i] * h.r[k];
  });
  for (let k = 0; k < 3; k++) mu[k] /= W;
  const C = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  H.forEach((h, i) => {
    const [x, y, z] = sub(h.r, mu);
    C[0] += w[i] * x * x;
    C[1] += w[i] * x * y;
    C[2] += w[i] * x * z;
    C[3] += w[i] * y * y;
    C[4] += w[i] * y * z;
    C[5] += w[i] * z * z;
  });
  let a = rub.axis;
  for (let it = 0; it < 6; it++) {
    const b: V3 = [
      C[0] * a[0] + C[1] * a[1] + C[2] * a[2],
      C[1] * a[0] + C[3] * a[1] + C[4] * a[2],
      C[2] * a[0] + C[4] * a[1] + C[5] * a[2],
    ];
    const l = len(b);
    if (l < 1e-12) break;
    a = scale(b, 1 / l);
  }
  rub.axis = a;
  // tapping can't start a rub (once rubbing, a noisy axis estimate mustn't stop it)
  if (pad && !rub.active && Math.abs(dot(a, pad)) > R.lift) return [];

  const out: { t: number; amp: number }[] = [];
  let dir = 0; // +1 rising, −1 falling, 0 not yet known
  const x0 = dot(H[0].r, a);
  let lo = x0;
  let hi = x0;
  let ext = x0;
  let prev = x0; // the last turning point
  for (let i = 1; i < H.length; i++) {
    const x = dot(H[i].r, a);
    if (dir === 0) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
      if (x - lo >= stroke) [dir, ext, prev] = [1, x, lo];
      else if (hi - x >= stroke) [dir, ext, prev] = [-1, x, hi];
    } else if (dir * (x - ext) > 0) ext = x;
    else if (dir * (ext - x) >= stroke) {
      const amp = Math.abs(ext - prev);
      // a huge swing is the hand reshaping: forget everything before it
      if (amp > R.maxStroke) out.length = 0;
      else out.push({ t: H[i].t, amp });
      [dir, prev, ext] = [-dir, ext, x];
    }
  }
  return out;
}

/** variance along the direction the thumb has moved least (smallest eigenvalue of its covariance) */
function leastSpread(H: { r: V3 }[]): number {
  const n = H.length;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const { r } of H) {
    mx += r[0] / n;
    my += r[1] / n;
    mz += r[2] / n;
  }
  let a = 0; // xx xy xz yy yz zz
  let b = 0;
  let c = 0;
  let d = 0;
  let e = 0;
  let f = 0;
  for (const { r } of H) {
    const x = r[0] - mx;
    const y = r[1] - my;
    const z = r[2] - mz;
    a += (x * x) / n;
    b += (x * y) / n;
    c += (x * z) / n;
    d += (y * y) / n;
    e += (y * z) / n;
    f += (z * z) / n;
  }
  // closed form for a symmetric 3×3 (Smith 1961)
  const q = (a + d + f) / 3;
  const p = Math.sqrt(((a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * (b * b + c * c + e * e)) / 6);
  if (p < 1e-12) return Math.max(0, q);
  const [A, D, F] = [(a - q) / p, (d - q) / p, (f - q) / p];
  const [B, C, E] = [b / p, c / p, e / p];
  const det = A * (D * F - E * E) - B * (B * F - E * C) + C * (B * E - D * C);
  const phi = Math.acos(clamp(det / 2, -1, 1)) / 3;
  return Math.max(0, q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3));
}

/** recency-weighted spread (sd) of the thumb along the stroke axis, palm lengths */
function swing(rub: Rub, now: number): number {
  const H = rub.hist;
  if (H.length < 3) return 0;
  let W = 0;
  let sum = 0;
  let sq = 0;
  for (const h of H) {
    const w = Math.exp(-(now - h.t) / GESTURE.rub.liveMs);
    const x = dot(h.r, rub.axis);
    W += w;
    sum += w * x;
    sq += w * x * x;
  }
  return Math.sqrt(Math.max(0, sq / W - (sum / W) ** 2));
}

/** hand shape in the camera frame, from world landmarks (video landmarks if those are missing) */
function shape(h: TrackedHand, metric: boolean): V3[] {
  if (metric) return h.world.map(([x, y, z]): V3 => [x, -y, -z]);
  return h.landmarks.map((l): V3 => [l.x, -l.y, -l.z]);
}

/**
 * Tracking jitter, from the palm: its bones don't bend, so any wobble in the
 * distances between its landmarks is noise. Shared by every hand (it's mostly
 * the camera: frame rate, light, resolution).
 */
function listen(W: V3[], s: State, t: number, dt: number, cam: Cam) {
  const J = GESTURE.jitter;
  if (!s.rig || dt <= 0 || dt > 250) {
    // first sight, or back after a gap: start the means again
    s.rig = RIGID.map(([a, b]) => dist(W[a], W[b]));
    s.rigAt = t;
    return;
  }
  const k = 1 - Math.exp(-dt / J.meanMs);
  let dev = 0;
  RIGID.forEach(([a, b], j) => {
    const d = dist(W[a], W[b]) - s.rig![j];
    dev += (d * d) / RIGID.length;
    s.rig![j] += k * d;
  });
  if (t - s.rigAt < J.meanMs) return; // the means are still settling
  // a distance carries two landmarks' wobble, so one coordinate's variance is half;
  // a glitch frame can't drag the estimate far
  const v = Math.min(dev / 2, 9 * cam.jitter);
  cam.jitter += (1 - Math.exp(-dt / J.avgMs)) * (v - cam.jitter);
}

/**
 * palmSize as the engine's distance cue: how long the palm would look (in video
 * heights) held upright facing the camera — whichever way it's actually turned.
 * |lm0 − lm9| on screen shrinks as the hand rolls (video x and y units differ)
 * and collapses when the palm turns up, though the hand hasn't moved; instead,
 * fit the scale between the world landmarks (metres) and the video ones. The
 * fit also tells the video's aspect ratio, which is learned along the way.
 */
function apparentPalm(h: TrackedHand, palmM: number, cam: Cam): number {
  const L = h.landmarks;
  const W = h.world;
  let lx = 0;
  let ly = 0;
  let wx = 0;
  let wy = 0;
  for (let i = 0; i < 21; i++) {
    lx += L[i].x / 21;
    ly += L[i].y / 21;
    wx += W[i][0] / 21;
    wy += W[i][1] / 21;
  }
  let xx = 0;
  let ww = 0;
  let yy = 0;
  let vv = 0;
  for (let i = 0; i < 21; i++) {
    const u = W[i][0] - wx;
    const v = W[i][1] - wy;
    xx += (L[i].x - lx) * u;
    ww += u * u;
    yy += (L[i].y - ly) * v;
    vv += v * v;
  }
  // both axes well spread: the ratio of their scales is the aspect ratio
  if (xx > 0 && yy > 0 && ww > 0.2 * vv && vv > 0.2 * ww) {
    const a = yy / vv / (xx / ww);
    cam.aspect = clamp(cam.aspect * Math.pow(a / cam.aspect, 0.05), 0.4, 3);
  }
  // video heights per metre, from both axes (x scaled up by the aspect ratio)
  const k = (yy + cam.aspect * xx) / (vv + ww);
  return k > 0 ? k * palmM : Math.hypot(L[0].x - L[9].x, L[0].y - L[9].y);
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
  return 0.5 * ramp(reach, 0.9, 1.32) + 0.5 * ramp(straight, 0.7, 0.97);
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
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const clamp01 = (x: number) => clamp(x, 0, 1);
const ramp = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));

function norm(a: V3, fallback: V3): V3 {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
}
