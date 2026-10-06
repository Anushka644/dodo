// Synthetic-hand tests for src/sense/gestures.ts and the slot/smoothing logic in
// src/sense/hands.ts. Run: npx --yes tsx@4 scripts/tests/gestures.test.ts
//
// A small kinematic hand (real-ish bone lengths, flexion at each joint) is posed,
// rotated, jittered, and turned into exactly what MediaPipe would report for an
// unmirrored webcam frame. Most cases then go through the real pipeline:
// HandSlots (mirror + slots + One Euro) → GestureTracker.
//
// Beyond classification, it pins down behaviour the engine relies on: palmSize
// doesn't change as the hand turns (it's the depth cue), a pinch survives being
// squeezed into a fist (that's how a held note gets crumpled), pinch is off while
// printing, the rub neither false-triggers nor lingers at 15–60 fps or with noisy
// fingertips, and a failing tracker never freezes a hand. Jitter is synthetic
// (independent Gaussian per landmark); real MediaPipe noise still needs a check.

import type { HandGesture, Pose, TrackedHand, V3 } from '../../src/contracts';
import { GESTURE, GestureTracker, extension } from '../../src/sense/gestures';
import { HandSensor, HandSlots, SENSE, type RawHand } from '../../src/sense/hands';

type Side = 'Left' | 'Right';
type M3 = [V3, V3, V3];
type Flex = [number, number, number];

// ------------------------------------------------------------------ math

const deg = Math.PI / 180;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(...a);
const unit = (a: V3) => mul(a, 1 / len(a));
const lerp = (a: V3, b: V3, k: number) => add(a, mul(sub(b, a), k));
const mid = (a: V3, b: V3) => lerp(a, b, 0.5);
const rotate = (v: V3, k: V3, a: number): V3 =>
  add(add(mul(v, Math.cos(a)), mul(cross(k, v), Math.sin(a))), mul(k, dot(k, v) * (1 - Math.cos(a))));
const apply = (m: M3, v: V3): V3 => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
const mm = (a: M3, b: M3): M3 => {
  const bt: M3 = [
    [b[0][0], b[1][0], b[2][0]],
    [b[0][1], b[1][1], b[2][1]],
    [b[0][2], b[1][2], b[2][2]],
  ];
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => dot(a[i], bt[j]))) as M3;
};
const I3: M3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const rotX = (a: number): M3 => [
  [1, 0, 0],
  [0, Math.cos(a * deg), -Math.sin(a * deg)],
  [0, Math.sin(a * deg), Math.cos(a * deg)],
];
const rotY = (a: number): M3 => [
  [Math.cos(a * deg), 0, Math.sin(a * deg)],
  [0, 1, 0],
  [-Math.sin(a * deg), 0, Math.cos(a * deg)],
];
const rotZ = (a: number): M3 => [
  [Math.cos(a * deg), -Math.sin(a * deg), 0],
  [Math.sin(a * deg), Math.cos(a * deg), 0],
  [0, 0, 1],
];

// deterministic noise
let seed = 12345;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

// ------------------------------------------------------------------ the hand
// Template: the user's RIGHT hand as seen on the (mirrored) screen, in the camera
// frame (x right, y up, z toward the viewer), metres, wrist at the origin, palm
// facing the viewer, fingers up. In a mirror a right hand has a left hand's
// geometry, so the thumb is on the −x side. Flexion curls fingers toward +z —
// out of the palm, the direction palmNormal must report.

const MCP: V3[] = [
  [-0.026, 0.082, 0],
  [-0.004, 0.086, 0],
  [0.016, 0.08, 0],
  [0.033, 0.068, 0],
];
const SEG: V3[] = [
  [0.042, 0.025, 0.02],
  [0.046, 0.029, 0.022],
  [0.043, 0.027, 0.021],
  [0.034, 0.02, 0.018],
];
const SPLAY = [-7, -2, 4, 10];
const PALM = len(MCP[1]); // wrist → middle MCP, the gesture module's unit

/** finger k: [mcp, pip, dip, tip] and the pad normal of its last phalanx */
function finger(k: number, f: Flex) {
  const a = SPLAY[k] * deg;
  let dir: V3 = [Math.sin(a), Math.cos(a), 0];
  const axis: V3 = [Math.cos(a), -Math.sin(a), 0];
  const pts: V3[] = [MCP[k]];
  for (let j = 0; j < 3; j++) {
    dir = rotate(dir, axis, f[j] * deg);
    pts.push(add(pts[j], mul(dir, SEG[k][j])));
  }
  return { pts, pad: cross(axis, dir), dir };
}

interface Spec {
  f: [Flex, Flex, Flex, Flex];
  /** thumb tip target given the finger landmarks; omit for a relaxed open thumb */
  thumb?: (P: V3[], pads: V3[], dirs: V3[]) => V3;
}

function template(spec: Spec): V3[] {
  const P: V3[] = new Array(21);
  P[0] = [0, 0, 0];
  const pads: V3[] = [];
  const dirs: V3[] = [];
  spec.f.forEach((fl, k) => {
    const { pts, pad, dir } = finger(k, fl);
    pts.forEach((p, j) => (P[5 + 4 * k + j] = p));
    pads.push(pad);
    dirs.push(dir);
  });
  P[1] = [-0.02, 0.024, 0.008];
  if (!spec.thumb) {
    P[2] = add(P[1], mul(unit([-0.75, 0.55, 0.3]), 0.035));
    P[3] = add(P[2], mul(unit([-0.55, 0.8, 0.2]), 0.03));
    P[4] = add(P[3], mul(unit([-0.45, 0.88, 0.15]), 0.025));
  } else {
    P[2] = add(P[1], mul(unit([-0.45, 0.55, 0.7]), 0.035));
    P[4] = spec.thumb(P, pads, dirs);
    P[3] = add(lerp(P[2], P[4], 0.5), [-0.006, 0, 0.004]);
  }
  return P;
}

/** the hand in the camera frame: template, mirrored for a left hand, then rotated about the wrist */
function handPoints(spec: Spec, side: Side, R: M3): V3[] {
  return template(spec).map((p) => apply(R, side === 'Left' ? [-p[0], p[1], p[2]] : p));
}

const ASPECT = 16 / 9;
const SCALE = 2.0; // metres → normalised video height (palm ≈ 0.17 of the frame)

/** what HandSlots outputs (mirrored), straight from camera-frame points; `aspect` = video width ÷ height */
function tracked(P: V3[], side: Side, at: [number, number], id = 1, aspect = ASPECT): TrackedHand {
  const c = P.reduce((a, p) => add(a, mul(p, 1 / 21)), [0, 0, 0] as V3);
  return {
    id,
    handedness: side,
    score: 0.97,
    landmarks: P.map((p) => ({
      x: at[0] + ((p[0] - c[0]) * SCALE) / aspect,
      y: at[1] - (p[1] - c[1]) * SCALE,
      z: (-(p[2] - P[0][2]) * SCALE) / aspect,
    })),
    world: P.map((p): V3 => [p[0] - c[0], -(p[1] - c[1]), -(p[2] - c[2])]),
  };
}

/** what MediaPipe reports for the raw (unmirrored) camera frame — labels assume a mirrored image */
function raw(P: V3[], side: Side, at: [number, number], noise = 0): RawHand {
  const Q = noise ? P.map((p) => add(p, [gauss() * noise, gauss() * noise, gauss() * noise])) : P;
  const h = tracked(Q, side, at);
  return {
    landmarks: h.landmarks.map((l) => ({ x: 1 - l.x, y: l.y, z: l.z })),
    world: h.world.map(([x, y, z]) => ({ x: -x, y, z })),
    label: side === 'Right' ? 'Left' : 'Right',
    score: 0.97,
  };
}

// ------------------------------------------------------------------ poses

const CURLED: Flex = [80, 100, 65];
const OPEN: Spec = { f: [[5, 5, 3], [4, 5, 3], [5, 5, 3], [6, 5, 3]] };
const FIST: Spec = { f: [CURLED, CURLED, CURLED, CURLED], thumb: (P) => add(mid(P[6], P[11]), [0, 0, 0.014]) };
const POINT: Spec = {
  f: [[5, 8, 5], CURLED, CURLED, CURLED],
  thumb: (P) => add(mid(P[10], P[11]), [0, 0, 0.012]),
};
/** OK-sign pinch: index meets thumb, the rest relaxed */
const pinchAt = (gap: number): Spec => ({
  f: [[30, 45, 30], [15, 15, 10], [15, 20, 10], [15, 20, 10]],
  thumb: (P, pads) => add(P[8], mul(pads[0], gap)),
});
const PINCH = pinchAt(0.009);
/** a pinch with the other fingers curled — how you'd hold a banknote */
const PINCH_CURLED: Spec = { f: [[30, 45, 30], CURLED, CURLED, CURLED], thumb: (P, pads) => add(P[8], mul(pads[0], 0.009)) };
/** the money gesture: thumb pad on the index + middle pads, offset (m) along an axis */
const MONEY_F: Spec['f'] = [[40, 55, 25], [40, 55, 25], [65, 85, 50], [65, 85, 50]];
type Axis = 'along' | 'across' | 'circle' | 'tap';
const money = (u: number, v: number, axis: Axis): Spec => ({
  f: MONEY_F,
  thumb: (P, pads, dirs) => {
    const pad = unit(add(pads[0], pads[1]));
    const along = unit(add(dirs[0], dirs[1]));
    const acr = unit(sub(P[12], P[8]));
    const base = add(mid(P[8], P[12]), mul(pad, 0.008));
    if (axis === 'along') return add(base, mul(along, u));
    if (axis === 'across') return add(base, mul(acr, u));
    if (axis === 'circle') return add(base, add(mul(along, u), mul(acr, v)));
    return add(base, mul(pad, Math.max(0, u))); // tap: thumb lifts off the pads
  },
});

const ROTATIONS: [string, M3][] = [
  ['upright', I3],
  ['roll 45', rotZ(45)],
  ['roll 90', rotZ(90)],
  ['roll -60', rotZ(-60)],
  ['roll 150', rotZ(150)],
  ['tilt to cam 40', rotX(40)],
  ['tilt away 40', rotX(-40)],
  ['yaw 45', rotY(45)],
  ['yaw -50', rotY(-50)],
  ['combo', mm(rotZ(30), mm(rotX(30), rotY(-30)))],
  ['palm up', rotX(-90)],
  ['palm up, sideways', mm(rotZ(90), rotX(-90))],
  ['back to cam', rotY(180)],
];

// ------------------------------------------------------------------ harness

const results: { name: string; cases: number; pass: number; note: string }[] = [];
const failures: string[] = [];
function section(name: string, fn: (check: (ok: boolean, what: string) => void) => string | void) {
  let cases = 0;
  let pass = 0;
  const note = fn((ok, what) => {
    cases++;
    if (ok) pass++;
    else failures.push(`${name}: ${what}`);
  });
  results.push({ name, cases, pass, note: note ?? '' });
}

const FPS = 30;
const DT = 1000 / FPS;

class Pipe {
  slots = new HandSlots();
  tracker = new GestureTracker();
  /** what the slots handed the tracker last */
  hands: TrackedHand[] = [];
  step(hands: RawHand[], t: number): HandGesture[] {
    this.hands = this.slots.update(hands, t);
    return this.tracker.update({ t, hands: this.hands });
  }
}

/** run a generator through the full pipeline; returns per-frame gestures of the first hand */
function play(ms: number, gen: (t: number) => RawHand[], pipe = new Pipe(), t0 = 1000, dt = DT) {
  const out: { t: number; g: HandGesture | undefined }[] = [];
  for (let t = t0; t <= t0 + ms; t += dt) out.push({ t: t - t0, g: pipe.step(gen(t - t0), t)[0] });
  return out;
}

const SPECS: [string, Spec, Pose, Partial<Record<'open' | 'fist' | 'point' | 'pinch', boolean>>][] = [
  ['open', OPEN, 'open', { open: true, fist: false, point: false, pinch: false }],
  ['fist', FIST, 'fist', { open: false, fist: true, point: false, pinch: false }],
  ['point', POINT, 'point', { open: false, fist: false, point: true, pinch: false }],
  ['pinch (OK)', PINCH, 'pinch', { fist: false, point: false, pinch: true }],
  ['pinch (curled)', PINCH_CURLED, 'pinch', { fist: false, point: false, pinch: true }],
];

// ------------------------------------------------------------------ tests

section('extension score calibration', (check) => {
  const P = (s: Spec) => template(s);
  const e = (s: Spec, k: number) => extension(P(s), k);
  const open = [0, 1, 2, 3].map((k) => e(OPEN, k));
  const fist = [0, 1, 2, 3].map((k) => e(FIST, k));
  const pinchIdx = e(PINCH, 0);
  const moneyIdx = e(money(0, 0, 'along'), 0);
  for (const v of open) check(v > GESTURE.extOn, `open finger ${v.toFixed(2)} > extOn`);
  for (const v of fist) check(v < GESTURE.curlOn, `fist finger ${v.toFixed(2)} < curlOn`);
  check(pinchIdx > GESTURE.curlOff, `pinch index ${pinchIdx.toFixed(2)} is not curled`);
  check(moneyIdx > GESTURE.curlOff, `money index ${moneyIdx.toFixed(2)} is not curled`);
  const f = (xs: number[]) => xs.map((x) => x.toFixed(2)).join('/');
  return `open ${f(open)}  fist ${f(fist)}  pinch-index ${pinchIdx.toFixed(2)}  money-index ${moneyIdx.toFixed(2)}`;
});

section('pose classification (clean, direct)', (check) => {
  for (const side of ['Right', 'Left'] as Side[])
    for (const [rn, R] of ROTATIONS)
      for (const [sn, spec, want, flags] of SPECS) {
        const tr = new GestureTracker();
        const P = handPoints(spec, side, R);
        let g: HandGesture | undefined;
        for (let i = 0; i < 6; i++) g = tr.update({ t: i * DT, hands: [tracked(P, side, [0.5, 0.5])] })[0];
        const ok =
          g!.pose === want &&
          (flags.open === undefined || g!.open === flags.open) &&
          (flags.fist === undefined || g!.fist === flags.fist) &&
          (flags.point === undefined || g!.point.active === flags.point) &&
          (flags.pinch === undefined || g!.pinch.active === flags.pinch);
        check(ok, `${side} ${sn} @ ${rn}: got ${g!.pose} (open ${g!.open} fist ${g!.fist} point ${g!.point.active} pinch ${g!.pinch.active})`);
      }
  return `${SPECS.length} poses × ${ROTATIONS.length} orientations × 2 hands`;
});

section('pose classification (jitter 1.5 mm, full pipeline)', (check) => {
  let flicker = 0;
  for (const side of ['Right', 'Left'] as Side[])
    for (const [rn, R] of ROTATIONS)
      for (const [sn, spec, want] of SPECS) {
        const P = handPoints(spec, side, R);
        const frames = play(1000, () => [raw(P, side, [0.4, 0.55], 0.0015)]);
        const settled = frames.filter((f) => f.t >= 200);
        const wrong = settled.filter((f) => f.g?.pose !== want);
        flicker += wrong.length;
        check(wrong.length === 0, `${side} ${sn} @ ${rn}: ${wrong.length}/${settled.length} frames wrong (${wrong[0]?.g?.pose})`);
      }
  return `every frame after 200 ms must be right; wrong frames: ${flicker}`;
});

section('palmNormal / palmUp', (check) => {
  let worst = 1;
  for (const side of ['Right', 'Left'] as Side[])
    for (const [rn, R] of ROTATIONS)
      for (const [sn, spec] of [['open', OPEN] as const, ['fist', FIST] as const, ['pinch', PINCH] as const]) {
        const g = new GestureTracker().update({ t: 0, hands: [tracked(handPoints(spec, side, R), side, [0.5, 0.5])] })[0];
        const n = apply(R, [0, 0, 1]);
        const up = apply(R, [0, 1, 0]);
        const dn = dot(g.palmNormal, n);
        worst = Math.min(worst, dn);
        check(dn > 0.97, `${side} ${sn} @ ${rn}: normal·expected = ${dn.toFixed(3)}`);
        check(dot(g.palmUp, up) > 0.97, `${side} ${sn} @ ${rn}: up·expected = ${dot(g.palmUp, up).toFixed(3)}`);
        check(Math.abs(len(g.palmNormal) - 1) < 1e-6 && Math.abs(dot(g.palmNormal, g.palmUp)) < 1e-6, `${side} ${sn} @ ${rn}: orthonormal`);
      }
  // the headline cases, spelled out
  for (const side of ['Right', 'Left'] as Side[]) {
    const g = new GestureTracker().update({ t: 0, hands: [tracked(handPoints(OPEN, side, I3), side, [0.5, 0.5])] })[0];
    check(g.palmNormal[2] > 0.97, `${side} palm facing camera → +z (got ${g.palmNormal.map((x) => x.toFixed(2))})`);
    const b = new GestureTracker().update({ t: 0, hands: [tracked(handPoints(OPEN, side, rotY(180)), side, [0.5, 0.5])] })[0];
    check(b.palmNormal[2] < -0.97, `${side} back of hand to camera → −z`);
    const u = new GestureTracker().update({ t: 0, hands: [tracked(handPoints(OPEN, side, rotX(-90)), side, [0.5, 0.5])] })[0];
    check(u.palmNormal[1] > 0.97, `${side} palm up → +y`);
  }
  return `worst normal·expected ${worst.toFixed(3)}`;
});

// ---- rub
const RUB_NOISE = 0.002; // 2 mm per landmark, per axis, every frame
const lead = 600; // ms of a still money pose before rubbing starts

function rubRun(side: Side, R: M3, hz: number, amp: number, axis: Axis, ms = 2200, noise = RUB_NOISE, dt = DT) {
  return play(
    lead + ms,
    (t) => {
      const ph = t < lead ? 0 : 2 * Math.PI * hz * ((t - lead) / 1000);
      const u = amp * Math.sin(ph);
      const v = amp * (1 - Math.cos(ph));
      const spec = axis === 'tap' ? money(amp * (0.5 - 0.5 * Math.cos(ph)), 0, 'tap') : money(u, axis === 'circle' ? v - amp : 0, axis);
      return [raw(handPoints(spec, side, R), side, [0.55, 0.5], noise)];
    },
    new Pipe(),
    1000,
    dt,
  );
}

section('rub: detected (±8 mm, jitter 2 mm, 3–5 Hz ≤ 1 s)', (check) => {
  const lat: number[] = [];
  let intensity = 0;
  let runs = 0;
  const fast: Record<number, [number, number]> = { 3: [0, 0], 4: [0, 0], 5: [0, 0] };
  for (const side of ['Right', 'Left'] as Side[])
    for (const [rn, R] of [ROTATIONS[0], ROTATIONS[1], ROTATIONS[5], ROTATIONS[9]])
      for (const hz of [3, 4, 5])
        for (const axis of ['along', 'across', 'circle'] as Axis[]) {
          const f = rubRun(side, R, hz, 0.008, axis);
          const early = f.filter((x) => x.t < lead && x.g?.rub.active);
          const hit = f.find((x) => x.t >= lead && x.g?.pose === 'rub');
          const tail = f.filter((x) => hit && x.t > Math.max(lead + 1200, hit.t + 200));
          const held = tail.every((x) => x.g?.pose === 'rub');
          fast[hz][1]++;
          if (hit && hit.t - lead <= 1000) fast[hz][0]++;
          intensity += tail.reduce((a, x) => a + (x.g?.rub.intensity ?? 0), 0) / tail.length;
          runs++;
          if (hit) lat.push(hit.t - lead);
          check(early.length === 0, `${side} ${rn} ${hz} Hz ${axis}: rub while still`);
          check(!!hit && hit.t - lead <= 1000, `${side} ${rn} ${hz} Hz ${axis}: ${hit ? (hit.t - lead).toFixed(0) + ' ms' : 'never'}`);
          check(held, `${side} ${rn} ${hz} Hz ${axis}: dropped out while rubbing`);
        }
  lat.sort((a, b) => a - b);
  const within = [3, 4, 5].map((hz) => `${hz}Hz ${fast[hz][0]}/${fast[hz][1]}`).join(' ');
  return `≤1 s: ${within}; latency median ${lat[lat.length >> 1]?.toFixed(0)} ms, max ${lat[lat.length - 1]?.toFixed(0)} ms; mean intensity ${(intensity / runs).toFixed(2)}`;
});

section('rub: stops promptly, and stays stopped', (check) => {
  const worst: Record<number, number> = {};
  let restarts = 0;
  for (const fps of [30, 60, 24])
    for (const hz of [3, 5]) {
      // a rub ends at the end of a stroke, where the thumb is already at rest
      const stopAt = lead + 1500 + 250 / hz;
      const f = play(
        stopAt + 1500,
        (t) => {
          const ph = t < lead ? 0 : 2 * Math.PI * hz * ((Math.min(t, stopAt) - lead) / 1000);
          return [raw(handPoints(money(0.008 * Math.sin(ph), 0, 'along'), 'Right', I3), 'Right', [0.5, 0.5], RUB_NOISE)];
        },
        new Pipe(),
        1000,
        1000 / fps,
      );
      const off = f.find((x) => x.t > stopAt && x.g?.pose !== 'rub');
      const d = off ? off.t - stopAt : Infinity;
      worst[fps] = Math.max(worst[fps] ?? 0, d);
      // once it's off it stays off: the strokes that ran the rub mustn't restart it
      // (they used to, every other frame — the pose stuck on 'rub' and kept printing)
      let back = 0;
      for (let i = 1; i < f.length; i++) if (off && f[i].t > off.t && f[i].g?.rub.active && !f[i - 1].g?.rub.active) back++;
      restarts += back;
      check(back === 0, `${fps} fps ${hz} Hz: rub came back on ${back}× after stopping`);
      check(d < 700, `${fps} fps ${hz} Hz: pose left rub ${d.toFixed(0)} ms after the thumb stopped`);
    }
  return `pose leaves rub ≤ ${Object.entries(worst).map(([k, v]) => `${v.toFixed(0)} ms @${k}fps`).join(', ')}; restarts ${restarts}`;
});

section('rub: sensitivity (detected within 1.5 s, 3 Hz/4 Hz)', (check) => {
  // informational below ±8 mm: that's the deliberate-rub operating point (see GESTURE.rub.stroke)
  const row: string[] = [];
  for (const mm of [3, 4, 5, 6, 8, 10, 12]) {
    let hits = 0;
    let n = 0;
    for (const side of ['Right', 'Left'] as Side[])
      for (const hz of [3, 4])
        for (const axis of ['along', 'across'] as Axis[]) {
          const f = rubRun(side, rotZ(20), hz, mm / 1000, axis, 1500);
          n++;
          if (f.some((x) => x.t >= lead && x.g?.pose === 'rub')) hits++;
        }
    row.push(`±${mm}mm ${hits}/${n}`);
    if (mm >= 8) check(hits === n, `±${mm} mm: ${hits}/${n} detected`);
  }
  return row.join('  ');
});

section('rub: must NOT trigger', (check) => {
  let seconds = 0;
  const never = (name: string, ms: number, gen: (t: number) => RawHand[], noiseNote = '') => {
    seconds += ms / 1000;
    const f = play(ms, gen);
    const bad = f.filter((x) => x.g?.rub.active || x.g?.pose === 'rub');
    check(bad.length === 0, `${name}${noiseNote}: rub on ${bad.length} frames (first at ${bad[0]?.t.toFixed(0)} ms)`);
  };
  for (const side of ['Right', 'Left'] as Side[]) {
    for (const sigma of [0.002, 0.003]) {
      never(`${side} static pinch`, 6000, () => [raw(handPoints(PINCH, side, I3), side, [0.5, 0.5], sigma)], ` σ=${sigma * 1000}mm`);
      never(`${side} static money pose`, 6000, () => [raw(handPoints(money(0, 0, 'along'), side, rotZ(30)), side, [0.5, 0.5], sigma)], ` σ=${sigma * 1000}mm`);
      never(`${side} static fist`, 4000, () => [raw(handPoints(FIST, side, I3), side, [0.5, 0.5], sigma)], ` σ=${sigma * 1000}mm`);
    }
    // the hand moving through space: translation + rotation, nothing moving inside it
    never(`${side} open hand swept side to side (2 Hz, ±0.2)`, 4000, (t) => {
      const ph = 2 * Math.PI * 2 * (t / 1000);
      return [raw(handPoints(OPEN, side, rotZ(25 * Math.sin(ph))), side, [0.5 + 0.2 * Math.sin(ph), 0.5], 0.002)];
    });
    never(`${side} pinched note shaken (4 Hz, ±0.1, ±20°)`, 4000, (t) => {
      const ph = 2 * Math.PI * 4 * (t / 1000);
      return [raw(handPoints(PINCH, side, mm(rotZ(20 * Math.sin(ph)), rotX(15 * Math.cos(ph)))), side, [0.5 + 0.1 * Math.sin(ph), 0.5 + 0.05 * Math.cos(ph)], 0.002)];
    });
    never(`${side} money pose waved (3 Hz, ±0.15, ±25°)`, 4000, (t) => {
      const ph = 2 * Math.PI * 3 * (t / 1000);
      return [raw(handPoints(money(0, 0, 'along'), side, mm(rotZ(25 * Math.sin(ph)), rotY(20 * Math.cos(ph)))), side, [0.5 + 0.15 * Math.sin(ph), 0.5], 0.002)];
    });
    // tapping thumb and fingers together isn't rubbing (and must keep working as pinch)
    const tap = rubRun(side, I3, 3, 0.03, 'tap', 3000);
    const bad = tap.filter((x) => x.g?.rub.active);
    let toggles = 0;
    for (let i = 1; i < tap.length; i++) if (tap[i].g?.pinch.active !== tap[i - 1].g?.pinch.active) toggles++;
    check(bad.length === 0, `${side} pinch-tapping 3 Hz: rub on ${bad.length} frames`);
    check(toggles >= 12, `${side} pinch-tapping 3 Hz: pinch toggled ${toggles}×`);
  }
  return `${seconds.toFixed(0)} s of still pinch/money/fist (2–3 mm jitter), swept, shaken, waved hands; + pinch-tapping`;
});

section('rub: camera frame rate and noise level', (check) => {
  // the stroke a rub needs follows the jitter measured on the palm, so a slow or
  // grainy camera doesn't print on its own (a fixed threshold did at 24 fps / 3 mm)
  const row: string[] = [];
  for (const fps of [15, 24, 60]) {
    const dt = 1000 / fps;
    let falseFrames = 0;
    for (const side of ['Right', 'Left'] as Side[])
      for (const sigma of [0.002, 0.003])
        for (const spec of [PINCH, PINCH_CURLED, money(0, 0, 'along')]) {
          const f = play(8000, () => [raw(handPoints(spec, side, rotZ(30)), side, [0.5, 0.5], sigma)], new Pipe(), 1000, dt);
          falseFrames += f.filter((x) => x.g?.rub.active || x.g?.pose === 'rub').length;
        }
    check(falseFrames === 0, `${fps} fps: rub on ${falseFrames} frames of a still pinch/money pose (2–3 mm jitter)`);
    let fast = 0;
    let any = 0;
    let n = 0;
    let held = 0;
    let gaps = 0;
    for (const side of ['Right', 'Left'] as Side[])
      for (const hz of [3, 4, 5])
        for (const axis of ['along', 'across'] as Axis[]) {
          const f = rubRun(side, rotZ(20), hz, 0.008, axis, 2000, RUB_NOISE, dt);
          const hit = f.find((x) => x.t >= lead && x.g?.pose === 'rub');
          n++;
          if (hit) any++;
          if (hit && hit.t - lead <= 1000) fast++;
          const tail = hit ? f.filter((x) => x.t > hit.t + 300) : [];
          held += tail.length;
          gaps += tail.filter((x) => x.g?.pose !== 'rub').length;
        }
    // 15 fps is informational: three frames per 5 Hz stroke is barely a signal
    if (fps >= 24) {
      check(fast >= n - 1, `${fps} fps: ±8 mm rubs found within 1 s ${fast}/${n}`);
      check(gaps / held < 0.05, `${fps} fps: rub dropped out on ${((100 * gaps) / held).toFixed(1)}% of frames once going`);
    }
    row.push(`${fps} fps ≤1 s ${fast}/${n} (≤2 s ${any}/${n}, gaps ${((100 * gaps) / Math.max(1, held)).toFixed(1)}%)`);
  }
  return row.join('; ') + '; no false rubs at 15/24/60 fps';
});

section('rub: fingertips noisier than the palm', (check) => {
  // MediaPipe's fingertips (and an occluded thumb tip) jitter more than its palm. The
  // palm's wobble alone would under-read that, so the thumb signal's own noise counts too.
  const TIPS = new Set([4, 8, 12, 16, 20]);
  const JOINTS = new Set([3, 7, 11, 15, 19]);
  const noisy = (P: V3[], palm: number, tip: number) =>
    P.map((q, i) => {
      const s = TIPS.has(i) ? tip : JOINTS.has(i) ? (palm + tip) / 2 : palm;
      return add(q, [gauss() * s, gauss() * s, gauss() * s]);
    });
  const row: string[] = [];
  for (const fps of [24, 30, 60]) {
    let bad = 0;
    for (const side of ['Right', 'Left'] as Side[])
      for (const spec of [PINCH, PINCH_CURLED, money(0, 0, 'along')]) {
        const P = handPoints(spec, side, rotZ(30));
        const f = play(10000, () => [raw(noisy(P, 0.001, 0.0025), side, [0.5, 0.5])], new Pipe(), 1000, 1000 / fps);
        bad += f.filter((x) => x.g?.rub.active).length;
      }
    check(bad === 0, `${fps} fps, palm 1 mm / tips 2.5 mm: rub on ${bad} frames of a still pose`);
    row.push(`${fps} fps ${bad}`);
  }
  // and a real rub still gets through that noise
  let hits = 0;
  for (const side of ['Right', 'Left'] as Side[])
    for (const hz of [3, 4, 5]) {
      const f = play(lead + 2000, (t) => {
        const ph = t < lead ? 0 : 2 * Math.PI * hz * ((t - lead) / 1000);
        return [raw(noisy(handPoints(money(0.008 * Math.sin(ph), 0, 'along'), side, rotZ(20)), 0.001, 0.0025), side, [0.55, 0.5])];
      });
      if (f.some((x) => x.t >= lead && x.t <= lead + 1000 && x.g?.pose === 'rub')) hits++;
    }
  check(hits >= 5, `±8 mm rubs through tip noise found within 1 s: ${hits}/6`);
  return `false rub frames over 60 s per rate: ${row.join(', ')}; ±8 mm rubs ≤1 s ${hits}/6`;
});

section('rub: jitter estimate (palm wobble → thumb noise)', (check) => {
  const row: string[] = [];
  for (const fps of [15, 30, 60])
    for (const sigma of [0.001, 0.002, 0.003, 0.005]) {
      const pipe = new Pipe();
      const xs: number[] = [];
      for (let t = 0; t < 6000; t += 1000 / fps) {
        pipe.step([raw(handPoints(money(0, 0, 'along'), 'Right', rotZ(20)), 'Right', [0.5, 0.5], sigma)], 1000 + t);
        if (t < 2000) continue;
        // the true noise of what the rub detector watches: thumb tip − mean of index/middle tips, one axis
        const W = pipe.hands[0]?.world;
        if (W) xs.push((W[4][0] - (W[8][0] + W[12][0]) / 2) / PALM);
      }
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      const truth = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
      const est = Math.sqrt(1.5 * (pipe.tracker as unknown as { cam: { jitter: number } }).cam.jitter) / PALM;
      const r = est / truth;
      check(r > 0.6 && r < 1.6, `${fps} fps σ=${sigma * 1000} mm: estimate ${est.toFixed(4)} vs true ${truth.toFixed(4)} palm (×${r.toFixed(2)})`);
      if (fps === 30) row.push(`${sigma * 1000}mm ×${r.toFixed(2)}`);
    }
  return `estimate ÷ truth at 30 fps: ${row.join(', ')}`;
});

section('palmSize: the distance cue ignores how the hand is turned', (check) => {
  // the engine maps palmSize to depth; turning the palm up to catch money must not throw the hand backwards
  const want = SCALE * PALM; // the palm upright, facing the camera, in video heights
  let worst = 0;
  let oldLo = Infinity;
  let oldHi = 0;
  for (const side of ['Right', 'Left'] as Side[])
    for (const [rn, R] of ROTATIONS)
      for (const [sn, spec] of [['open', OPEN] as const, ['fist', FIST] as const, ['pinch', PINCH] as const]) {
        const h = tracked(handPoints(spec, side, R), side, [0.5, 0.5]);
        const g = new GestureTracker().update({ t: 0, hands: [h] })[0];
        const err = Math.abs(g.palmSize / want - 1);
        worst = Math.max(worst, err);
        const old = Math.hypot(h.landmarks[0].x - h.landmarks[9].x, h.landmarks[0].y - h.landmarks[9].y) / want;
        oldLo = Math.min(oldLo, old);
        oldHi = Math.max(oldHi, old);
        check(err < 0.05, `${side} ${sn} @ ${rn}: palmSize ${g.palmSize.toFixed(3)} vs ${want.toFixed(3)}`);
      }
  // a 4:3 camera: the aspect ratio is learned from the first second or so of a moving hand
  const tr = new GestureTracker();
  let t = 0;
  for (let i = 0; i < 45; i++) tr.update({ t: (t += DT), hands: [tracked(handPoints(OPEN, 'Right', ROTATIONS[i % ROTATIONS.length][1]), 'Right', [0.5, 0.5], 1, 4 / 3)] });
  let worst43 = 0;
  for (const [, R] of ROTATIONS) {
    const g = tr.update({ t: (t += DT), hands: [tracked(handPoints(OPEN, 'Right', R), 'Right', [0.5, 0.5], 1, 4 / 3)] })[0];
    worst43 = Math.max(worst43, Math.abs(g.palmSize / want - 1));
  }
  check(worst43 < 0.05, `4:3 video: palmSize within ${(worst43 * 100).toFixed(1)}% after learning the aspect`);
  return `worst error ${(worst * 100).toFixed(1)}% (4:3: ${(worst43 * 100).toFixed(1)}%); raw |lm0−lm9| spanned ${oldLo.toFixed(2)}–${oldHi.toFixed(2)}× for the same hand`;
});

/** a pinch (other fingers curled, as when holding a note) squeezing into a fist: k = 0 → 1 */
const pinchToFist = (k: number): Spec => ({
  f: PINCH_CURLED.f.map((fl, i) => fl.map((a, j) => a + k * (FIST.f[i][j] - a))) as Spec['f'],
  thumb: (P, pads) => lerp(add(P[8], mul(pads[0], 0.009)), add(mid(P[6], P[11]), [0, 0, 0.014]), k),
});
const fistToOpen = (k: number): Spec => ({
  f: FIST.f.map((fl, i) => fl.map((a, j) => a + k * (OPEN.f[i][j] - a))) as Spec['f'],
  thumb: (P) => lerp(add(mid(P[6], P[11]), [0, 0, 0.014]), add(P[2], [-0.03, 0.04, 0.01]), k),
});

section('grip: a pinch squeezed into a fist keeps hold; opening lets go', (check) => {
  // the engine lets go of a note the moment pinch.active drops, and crumples what
  // the hand holds while fist is true — so the grip must survive the squeeze
  for (const side of ['Right', 'Left'] as Side[])
    for (const [rn, R] of [ROTATIONS[0], ROTATIONS[1], ROTATIONS[5], ROTATIONS[9]]) {
      const frames = play(1600, (t) => {
        const k = t < 300 ? 0 : Math.min(1, (t - 300) / 300);
        const o = t < 1000 ? 0 : Math.min(1, (t - 1000) / 250);
        return [raw(handPoints(o > 0 ? fistToOpen(o) : pinchToFist(k), side, R), side, [0.5, 0.5], 0.0015)];
      });
      const held = frames.filter((x) => x.t >= 150 && x.t < 1000);
      const dropped = held.filter((x) => !x.g?.pinch.active).length;
      const crumpling = frames.filter((x) => x.t >= 650 && x.t < 1000).every((x) => x.g?.fist && x.g.pinch.active);
      const opened = frames.filter((x) => x.t >= 1350);
      check(dropped === 0, `${side} @ ${rn}: grip lost on ${dropped}/${held.length} frames while squeezing`);
      check(crumpling, `${side} @ ${rn}: fist + pinch together once squeezed`);
      check(opened.every((x) => !x.g?.pinch.active && !x.g?.fist), `${side} @ ${rn}: opening the hand lets go`);
    }
  // and a plain fist never reads as a pinch
  const f = play(800, () => [raw(handPoints(FIST, 'Right', I3), 'Right', [0.5, 0.5], 0.0015)]);
  check(f.every((x) => !x.g?.pinch.active), 'a fist made from nothing is not a pinch');
});

section('pinch is not reported while printing', (check) => {
  // the money pose is a thumb on two fingertips — a grip, until it starts rubbing.
  // While it rubs, pinch.active is off, or the engine would grab the notes it prints.
  let toggles = 0;
  for (const side of ['Right', 'Left'] as Side[])
    for (const hz of [3, 5]) {
      const stopAt = lead + 2000;
      const f = play(stopAt + 1200, (t) => {
        const ph = t < lead || t > stopAt ? 0 : 2 * Math.PI * hz * ((t - lead) / 1000);
        return [raw(handPoints(money(0.008 * Math.sin(ph), 0, 'along'), side, rotZ(20)), side, [0.55, 0.5], RUB_NOISE)];
      });
      check(f.filter((x) => x.t > 200 && x.t < lead).every((x) => x.g?.pinch.active), `${side} ${hz} Hz: still money pose holds like a pinch`);
      const clash = f.filter((x) => (x.g?.rub.active || x.g?.pose === 'rub') && x.g?.pinch.active).length;
      check(clash === 0, `${side} ${hz} Hz: pinch and rub both on for ${clash} frames`);
      let n = 0;
      for (let i = 1; i < f.length; i++) if (f[i].t > lead && f[i].g?.pinch.active !== f[i - 1].g?.pinch.active) n++;
      toggles += n;
      check(n === 2, `${side} ${hz} Hz: pinch toggled ${n}× (once off as printing starts, once on after)`);
      check(f.filter((x) => x.t > stopAt + 900).every((x) => x.g?.pinch.active), `${side} ${hz} Hz: grip is back once the rub stops`);
    }
  return `pinch toggles per run: ${toggles / 4}`;
});

section('pinch hysteresis', (check) => {
  const tr = new GestureTracker();
  const seq: [number, boolean][] = [
    [0.5, false],
    [0.3, false],
    [0.25, false],
    [0.2, true],
    [0.25, true],
    [0.3, true],
    [0.34, true],
    [0.37, false],
    [0.3, false],
    [0.23, false],
    [0.21, true],
  ];
  let t = 0;
  const strengths: string[] = [];
  for (const [gapPalm, want] of seq) {
    // gap measured tip to tip: place the thumb tip that far from the index tip along the pad normal
    const P = handPoints(pinchAt(gapPalm * PALM), 'Right', rotZ(40));
    const g = tr.update({ t: (t += DT), hands: [tracked(P, 'Right', [0.5, 0.5])] })[0];
    strengths.push(g.pinch.strength.toFixed(2));
    check(g.pinch.active === want, `gap ${gapPalm} → active ${g.pinch.active}, want ${want}`);
  }
  return `strength along the sweep: ${strengths.join(' ')}`;
});

section('pose debounce', (check) => {
  const tr = new GestureTracker();
  const at = (spec: Spec, t: number) => tr.update({ t, hands: [tracked(handPoints(spec, 'Right', I3), 'Right', [0.5, 0.5])] })[0];
  let t = 0;
  for (; t < 300; t += DT) at(OPEN, t);
  check(at(OPEN, t).pose === 'open', 'settles on open');
  const t0 = (t += DT);
  let switched = -1;
  for (; t < t0 + 300; t += DT) if (at(FIST, t).pose === 'fist' && switched < 0) switched = t - t0;
  check(switched >= GESTURE.poseHoldMs && switched <= GESTURE.poseHoldMs + DT, `open → fist after ${switched.toFixed(0)} ms`);
  // a single odd frame doesn't change the pose
  at(OPEN, (t += DT));
  check(at(FIST, (t += DT)).pose === 'fist', 'one-frame blip ignored');
  for (let i = 0; i < 8; i++) at(PINCH, (t += DT));
  check(at(PINCH, (t += DT)).pose === 'pinch', 'settles on pinch');
  check(at(OPEN, (t += DT)).pose === 'open', 'pinch → open is immediate');
});

section('palm velocity', (check) => {
  const tr = new GestureTracker();
  const P = handPoints(OPEN, 'Right', I3);
  let g: HandGesture | undefined;
  for (let i = 0; i <= 15; i++) g = tr.update({ t: i * DT, hands: [tracked(P, 'Right', [0.3 + 0.9 * (i * DT / 1000), 0.5 - 0.4 * (i * DT / 1000)])] })[0];
  check(Math.abs(g!.velocity[0] - 0.9) < 0.02 && Math.abs(g!.velocity[1] + 0.4) < 0.02, `velocity ${g!.velocity.map((v) => v.toFixed(3))} ≈ [0.9, -0.4]`);
  return `steady 0.9,-0.4 u/s → ${g!.velocity.map((v) => v.toFixed(3)).join(', ')}`;
});

// ---- sensor slots
section('HandSlots: mirroring, handedness, ids', (check) => {
  const slots = new HandSlots();
  const R = raw(handPoints(OPEN, 'Right', I3), 'Right', [0.7, 0.5]);
  const L = raw(handPoints(OPEN, 'Left', I3), 'Left', [0.3, 0.5]);
  const a = slots.update([R, L], 0);
  const right = a.find((h) => h.handedness === 'Right')!;
  check(!!right && Math.abs(right.landmarks[0].x - (1 - R.landmarks[0].x)) < 1e-9, 'x mirrored (x′ = 1 − x)');
  check(!!right && Math.abs(right.world[0][0] + R.world[0].x) < 1e-9, 'world x mirrored');
  check(R.label === 'Left' && !!right && right.landmarks[0].x > 0.5, "MediaPipe 'Left' → user's Right hand, on the right of the mirrored view");
  const ids = new Map(a.map((h) => [h.handedness, h.id]));
  let stable = true;
  for (let i = 1; i < 20; i++) {
    const out = slots.update(i % 2 ? [L, R] : [R, L], i * DT);
    for (const h of out) if (ids.get(h.handedness) !== h.id) stable = false;
  }
  check(stable, 'ids stable when MediaPipe reorders hands');
  // the two hands cross: positions swap over a few frames while labels stay put
  const s2 = new HandSlots();
  let ok = true;
  let idR = -1;
  for (let i = 0; i <= 20; i++) {
    const k = i / 20;
    const out = s2.update(
      [raw(handPoints(OPEN, 'Right', I3), 'Right', [0.65 - 0.3 * k, 0.5]), raw(handPoints(OPEN, 'Left', I3), 'Left', [0.35 + 0.3 * k, 0.52])],
      i * DT,
    );
    const r = out.find((h) => h.handedness === 'Right');
    if (i === 0) idR = r!.id;
    else if (!r || r.id !== idR) ok = false;
  }
  check(ok, 'ids follow the hands as they cross');
  // a duplicate report of one hand collapses to one
  const d = new HandSlots().update([R, { ...R, score: 0.6 }], 0);
  check(d.length === 1, 'duplicate detection deduped');
  // a mislabelled frame or two doesn't flip handedness
  const s3 = new HandSlots();
  s3.update([R], 0);
  let flips = 0;
  for (let i = 1; i < 30; i++) {
    const bad = i % 7 === 0 || i % 7 === 1;
    const h = s3.update([{ ...R, label: bad ? 'Right' : 'Left' }], i * DT)[0];
    if (h.handedness !== 'Right') flips++;
  }
  check(flips === 0, `handedness held through 2-frame mislabels (flips ${flips})`);
});

section('HandSlots: dropouts', (check) => {
  const slots = new HandSlots();
  const gen = (t: number) => raw(handPoints(PINCH, 'Right', I3), 'Right', [0.3 + 1.5 * (t / 1000), 0.5]);
  let t = 0;
  let id = -1;
  for (; t < 400; t += DT) id = slots.update([gen(t)], t)[0].id;
  // two missed frames mid-flick
  const c1 = slots.update([], (t += DT));
  const c2 = slots.update([], (t += DT));
  check(c1.length === 1 && c1[0].id === id && c2[0]?.id === id, 'coasts through 2 missed frames, same id');
  check(c1[0]?.score < 0.6, 'coasting hand reports a lowered score');
  const glide = c2[0] ? c2[0].landmarks[0].x - c1[0].landmarks[0].x : 0;
  check(glide > 0.03, `keeps gliding with the flick (${glide.toFixed(3)} per frame)`);
  const back = slots.update([gen((t += DT))], t);
  check(back[0]?.id === id, 'reacquired into the same slot');
  for (let i = 0; i < 5; i++) slots.update([], (t += DT));
  check(slots.update([], (t += DT)).length === 0, `dropped after > ${SENSE.coastMs} ms`);
  const again = slots.update([gen((t += DT))], t);
  check(again[0]?.id !== id, 'a hand that comes back later gets a fresh id');
});

section('HandSlots: a NaN from the tracker', (check) => {
  // one bad number would sit in a slot's filters for good (pinch.point = NaN → a note pinned at NaN)
  const pipe = new Pipe();
  const good = () => raw(handPoints(OPEN, 'Right', I3), 'Right', [0.5, 0.5], 0.001);
  let t = 1000;
  for (let i = 0; i < 10; i++) pipe.step([good()], (t += DT));
  const bad = good();
  bad.landmarks[8] = { x: NaN, y: 0.5, z: 0 };
  const during = pipe.step([bad], (t += DT));
  check(during.length === 1, 'a NaN frame is a missed frame: the hand coasts');
  const half = good();
  half.world[4] = { x: NaN, y: 0, z: 0 };
  pipe.step([half], (t += DT));
  let g: HandGesture | undefined;
  for (let i = 0; i < 10; i++) g = pipe.step([good()], (t += DT))[0];
  const nums = [...g!.palm, ...g!.pinch.point, ...g!.rub.point, ...g!.point.tip, g!.palmSize, ...g!.palmNormal];
  check(nums.every(Number.isFinite), 'everything finite afterwards');
  check(pipe.hands[0].landmarks.every((l) => Number.isFinite(l.x + l.y + l.z)) && pipe.hands[0].world.every((w) => w.every(Number.isFinite)), 'slot filters unpoisoned');
  // fed straight to the tracker, a NaN hand is skipped and can't spoil the other hand's camera estimates
  const tr = new GestureTracker();
  const a = tracked(handPoints(OPEN, 'Right', I3), 'Right', [0.3, 0.5], 1);
  const b = tracked(handPoints(OPEN, 'Left', I3), 'Left', [0.7, 0.5], 2);
  const nan: TrackedHand = { ...a, landmarks: a.landmarks.map((l, i) => (i === 9 ? { ...l, x: NaN } : l)) };
  let out: HandGesture[] = [];
  for (let i = 0; i < 20; i++) out = tr.update({ t: i * DT, hands: [i === 5 ? nan : a, b] });
  check(out.every((o) => Number.isFinite(o.palmSize) && Math.abs(o.palmSize / (SCALE * PALM) - 1) < 0.05), 'other hands unaffected');
});

section('HandSlots: One Euro smoothing', (check) => {
  // at rest: jitter in, steadier out
  const slots = new HandSlots();
  const P = handPoints(OPEN, 'Right', I3);
  const ins: number[] = [];
  const outs: number[] = [];
  for (let i = 0; i < 150; i++) {
    const r = raw(P, 'Right', [0.5, 0.5], 0.0015);
    const h = slots.update([r], i * DT)[0];
    if (i > 30) {
      ins.push(1 - r.landmarks[8].x);
      outs.push(h.landmarks[8].x);
    }
  }
  const sd = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const ratio = sd(ins) / sd(outs);
  check(ratio > 2, `jitter reduced ${ratio.toFixed(1)}×`);
  // a fast flick: once moving, how far the smoothed wrist trails the true one
  const s3 = new HandSlots();
  let worst = 0;
  for (let i = 0; i < 30; i++) {
    const t = i * DT;
    const x = i < 10 ? 0.3 : 0.3 + 2.5 * ((t - 10 * DT) / 1000);
    const r = raw(P, 'Right', [x, 0.5]);
    const h = s3.update([r], t)[0];
    if (i >= 16) worst = Math.max(worst, Math.abs(h.landmarks[0].x - (1 - r.landmarks[0].x)));
  }
  check(worst < 0.02, `flick at 2.5 u/s lags ≤ ${worst.toFixed(4)} units`);
  return `rest jitter ÷${ratio.toFixed(1)}; 2.5 u/s flick lag ${(worst * 1000).toFixed(1)}‰ of frame width (~${(worst / 2.5 * 1000).toFixed(0)} ms)`;
});

// ---- the sensor shell, with a fake <video> and a fake MediaPipe landmarker
type FakeVideo = { readyState: number; videoWidth: number; currentTime: number; [k: string]: unknown };
function fakeLandmarker(log: number[], opts: { throws?: () => boolean } = {}) {
  const r = raw(handPoints(OPEN, 'Right', I3), 'Right', [0.6, 0.5]);
  return {
    detectForVideo(_v: unknown, ts: number) {
      if (opts.throws?.()) throw new Error('GL lost');
      log.push(ts);
      return {
        landmarks: [r.landmarks],
        worldLandmarks: [r.world],
        handedness: [[{ categoryName: r.label, score: r.score, index: 0, displayName: '' }]],
      };
    },
    close() {},
  };
}
// the constructor is private (create() needs MediaPipe and a DOM); reach it directly
const Sensor = HandSensor as unknown as new (v: unknown, lm: unknown, d: 'GPU' | 'CPU', ts: number, make: (d: string) => Promise<unknown>) => HandSensor;

section('HandSensor: frame gating + timestamps (currentTime path)', (check) => {
  const ts: number[] = [];
  const v: FakeVideo = { readyState: 4, videoWidth: 640, currentTime: 0 };
  const s = new Sensor(v, fakeLandmarker(ts), 'GPU', 500, async () => fakeLandmarker(ts));
  const f1 = s.detect(1000);
  check(!!f1 && f1.hands.length === 1 && f1.hands[0].handedness === 'Right', 'first frame detected, handedness unswapped');
  check(s.detect(1016) === null && ts.length === 1, 'same video frame → null, MediaPipe not called');
  v.currentTime = 0.033;
  const f2 = s.detect(1033);
  v.currentTime = 0.066;
  const f3 = s.detect(1020); // caller's clock went backwards
  v.currentTime = 0.1;
  const f4 = s.detect(1033.4); // and rounds onto the previous ms
  check(!!f2 && !!f3 && !!f4 && f2.t < f3.t && f3.t < f4.t, `frame times strictly increase (${[f1, f2, f3, f4].map((f) => f?.t).join(', ')})`);
  check(ts.every((x, i) => Number.isInteger(x) && (i === 0 ? x > 500 : x > ts[i - 1])), `MediaPipe timestamps strictly increasing ints (${ts.join(', ')})`);
  v.readyState = 1;
  v.currentTime = 0.2;
  check(s.detect(1100) === null, 'no frame while the video has no data');
  s.dispose();
  v.readyState = 4;
  v.currentTime = 0.3;
  check(s.detect(1200) === null, 'nothing after dispose');
});

section('HandSensor: requestVideoFrameCallback path', (check) => {
  const ts: number[] = [];
  let cb: ((now: number, meta: { captureTime?: number }) => void) | null = null;
  let cancelled = -1;
  const v: FakeVideo = {
    readyState: 4,
    videoWidth: 640,
    currentTime: 0,
    requestVideoFrameCallback: (f: typeof cb) => ((cb = f), 7),
    cancelVideoFrameCallback: (h: number) => (cancelled = h),
  };
  const s = new Sensor(v, fakeLandmarker(ts), 'GPU', 0, async () => fakeLandmarker(ts));
  const now = performance.now();
  v.currentTime = 0.5;
  check(s.detect(now) === null, 'waits for rVFC to report before falling back to currentTime');
  cb!(now, { captureTime: now - 40 });
  const f = s.detect(now + 2);
  check(!!f && Math.abs(f.t - (now - 40)) < 1e-6, 'frame time = the camera capture time');
  v.currentTime = 0.6; // currentTime moved but rVFC hasn't announced a frame
  check(s.detect(now + 5) === null, 'no new rVFC frame → null');
  cb!(now + 33, { captureTime: now - 7 });
  const g = s.detect(now + 34);
  check(!!g && g.t > f!.t && ts.length === 2, 'next rVFC frame detected');
  s.dispose();
  check(cancelled === 7, 'dispose cancels the frame callback');
});

{
  // GPU that dies mid-session: detect() must never throw, and should rebuild on the CPU
  const ts: number[] = [];
  let broken = false;
  let made = '';
  const v: FakeVideo = { readyState: 4, videoWidth: 640, currentTime: 0 };
  const s = new Sensor(v, fakeLandmarker(ts, { throws: () => broken }), 'GPU', 0, async (d) => ((made = d), fakeLandmarker(ts)));
  v.currentTime = 0.01;
  const id = s.detect(1000)?.hands[0]?.id;
  broken = true;
  let threw = false;
  const got: (number | null)[] = []; // hands per call, null = no frame
  const ids = new Set<number>();
  const warn = console.warn;
  console.warn = () => {}; // the sensor logs the (expected) failure
  for (let i = 1; i <= 4; i++) {
    v.currentTime = 0.01 + i / 30;
    try {
      const f = s.detect(1000 + i * 33);
      got.push(f ? f.hands.length : null);
      f?.hands.forEach((h) => ids.add(h.id));
    } catch {
      threw = true;
    }
  }
  await new Promise((r) => setTimeout(r, 0));
  broken = false;
  v.currentTime = 1;
  const after = s.detect(2000);

  // a CPU landmarker that fails on every frame: hands must go away, not freeze
  const dead = new Sensor(v, fakeLandmarker([], { throws: () => true }), 'CPU', 0, async () => fakeLandmarker([]));
  const deadOut: (number | null)[] = [];
  for (let i = 0; i < 12; i++) {
    v.currentTime = 2 + i / 30;
    const f = dead.detect(3000 + i * 33);
    deadOut.push(f ? f.hands.length : null);
  }
  // the CPU rebuild itself fails: same — no hands, rather than the last ones forever
  const doomed = new Sensor(v, fakeLandmarker([], { throws: () => true }), 'GPU', 0, async () => {
    throw new Error('no wasm');
  });
  const doomedOut: (number | null)[] = [];
  for (let i = 0; i < 4; i++) {
    v.currentTime = 3 + i / 30;
    const f = doomed.detect(4000 + i * 33);
    doomedOut.push(f ? f.hands.length : null);
  }
  await new Promise((r) => setTimeout(r, 0));
  v.currentTime = 4;
  const doomedLater = doomed.detect(5000);
  console.warn = warn;

  section('HandSensor: failures', (check) => {
    check(!threw, 'detect never throws');
    // failed frames are frames with no detections: the hand coasts (same id) while the GPU is retried…
    check(got[0] === 1 && got[1] === 1 && got[2] === 1 && ids.size === 1 && ids.has(id!), `a failed frame coasts the hand (hands per call ${got.join(',')})`);
    // …then null — "hold the last hands" — for the second the CPU rebuild takes
    check(got[3] === null, 'null while rebuilding on the CPU');
    check(made === 'CPU' && s.backend === 'CPU', `rebuilt on the ${made || '—'} after repeated GPU failures`);
    check(!!after && after.hands.length === 1, 'detects again after the fallback');
    check(deadOut.every((n) => n !== null) && deadOut[deadOut.length - 1] === 0, `a tracker that keeps failing reports no hands, not the last ones (${deadOut.join(',')})`);
    check(doomedLater !== null && doomedLater.hands.length === 0, `a failed CPU rebuild reports no hands (${doomedOut.join(',')} then ${doomedLater?.hands.length})`);
  });
}

// ------------------------------------------------------------------ report

const w = Math.max(...results.map((r) => r.name.length));
console.log('\n' + 'test'.padEnd(w) + '  pass/cases  notes');
console.log('-'.repeat(w + 60));
for (const r of results) console.log(`${r.name.padEnd(w)}  ${`${r.pass}/${r.cases}`.padStart(10)}  ${r.note}`);
console.log('-'.repeat(w + 60));
const total = results.reduce((a, r) => a + r.cases, 0);
const passed = results.reduce((a, r) => a + r.pass, 0);
console.log(`${passed}/${total} checks passed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 60)) console.log('  ✗ ' + f);
  if (failures.length > 60) console.log(`  … and ${failures.length - 60} more`);
  // no @types/node in this repo, so reach process through globalThis
  const proc = (globalThis as { process?: { exitCode?: number } }).process;
  if (proc) proc.exitCode = 1;
}
