// Paper physics tests. Run: npx --yes tsx@4 scripts/tests/paper.test.ts
// Pure Node, no DOM. Each test simulates at 60 fps unless it says otherwise.

import type { PaperEnv, V3 } from '../../src/contracts';
import { GRAVITY, PAPER, PaperSheet, gridIndices, gridUvs } from '../../src/physics/paper';
import { ASPECT } from '../../src/note/layout';

// a gc() for the allocation test: node only exposes it behind a flag, which can be set at runtime
type NodeV8 = { setFlagsFromString(flags: string): void };
type NodeVm = { runInNewContext(code: string): unknown };
type NodeProcess = { memoryUsage(): { heapUsed: number }; exit(code: number): void };
const proc = (globalThis as unknown as { process: NodeProcess }).process;
let gc: (() => void) | null = null;
try {
  (await import('node:v8' as string) as NodeV8).setFlagsFromString('--expose-gc');
  gc = (await import('node:vm' as string) as NodeVm).runInNewContext('gc') as () => void;
} catch {
  gc = null;
}
const heapUsed = () => proc.memoryUsage().heapUsed;

let failed = 0;
const results: string[] = [];
function test(name: string, fn: () => string | void) {
  try {
    const info = fn();
    results.push(`  ok    ${name}${info ? `  — ${info}` : ''}`);
  } catch (e) {
    failed++;
    results.push(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const DT = 1 / 60;
const air = (over: Partial<PaperEnv> = {}): PaperEnv => ({ gravity: GRAVITY, wind: [0, 0, 0], colliders: [], floorY: -100, ...over });
const len = (a: ArrayLike<number>) => Math.hypot(a[0], a[1], a[2]);
const at = (s: PaperSheet, i: number): V3 => [s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2]];
const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function allFinite(s: PaperSheet) {
  for (const v of s.positions) if (!Number.isFinite(v)) return false;
  for (const v of s.normals) if (!Number.isFinite(v)) return false;
  return true;
}
function bounds(s: PaperSheet) {
  const c = s.centroid();
  let r = 0;
  for (let i = 0; i < s.count; i++) r = Math.max(r, dist(at(s, i), c));
  return r;
}
/** structural (row / column) edge strains: worst stretch, worst compression, share of edges off by > 3% */
function strains(s: PaperSheet, width = ASPECT, height = 1) {
  const dx = width / (s.cols - 1), dy = height / (s.rows - 1);
  let stretch = 0, squash = 0, off = 0, n = 0;
  const add = (e: number) => {
    stretch = Math.max(stretch, e);
    squash = Math.max(squash, -e);
    if (Math.abs(e) > 0.03) off++;
    n++;
  };
  for (let j = 0; j < s.rows; j++) {
    for (let i = 0; i < s.cols; i++) {
      const p = j * s.cols + i;
      if (i < s.cols - 1) add(dist(at(s, p), at(s, p + 1)) / dx - 1);
      if (j < s.rows - 1) add(dist(at(s, p), at(s, p + s.cols)) / dy - 1);
    }
  }
  return { stretch, squash, off: off / n };
}
const strain = (s: PaperSheet) => {
  const e = strains(s);
  return Math.max(e.stretch, e.squash);
};
/** rms distance from the plane through the centroid along the mean normal */
function roughness(s: PaperSheet) {
  const n = meanNormal(s);
  const c = s.centroid();
  let r = 0;
  for (let i = 0; i < s.count; i++) {
    const p = at(s, i);
    r += ((p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2]) ** 2;
  }
  return Math.sqrt(r / s.count);
}
function meanNormal(s: PaperSheet): V3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < s.count; i++) {
    x += s.normals[i * 3];
    y += s.normals[i * 3 + 1];
    z += s.normals[i * 3 + 2];
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
/** fastest particle over the last step, from the positions before and after it */
function stepSpeed(s: PaperSheet, dt: number, env: PaperEnv) {
  const before = Float32Array.from(s.positions);
  s.step(dt, env);
  let m = 0;
  for (let i = 0; i < s.count * 3; i += 3) m = Math.max(m, Math.hypot(s.positions[i] - before[i], s.positions[i + 1] - before[i + 1], s.positions[i + 2] - before[i + 2]));
  return m / dt;
}
const corner = (s: PaperSheet, which: 'tl' | 'tr' | 'bl' | 'br') =>
  ({ tl: 0, tr: s.cols - 1, bl: (s.rows - 1) * s.cols, br: s.count - 1 })[which];

// ------------------------------------------------------------------ mesh & placement

test('grid: indices are CCW from +z, UVs are note space, arrays are shared per resolution', () => {
  const s = new PaperSheet({ cols: 12, rows: 6 });
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  const idx = s.indices;
  assert(idx.length === 11 * 5 * 6, 'triangle count');
  for (let k = 0; k < idx.length; k += 3) {
    const a = at(s, idx[k]), b = at(s, idx[k + 1]), c = at(s, idx[k + 2]);
    const z = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    assert(z > 0, `triangle ${k / 3} is not CCW from +z`);
  }
  const uv = s.uvs;
  const p = 3 * 12 + 7; // (i=7, j=3)
  assert(Math.abs(uv[p * 2] - (7 / 11) * ASPECT) < 1e-6 && Math.abs(uv[p * 2 + 1] - 3 / 5) < 1e-6, 'uv formula');
  // row 0 is the TOP of the note, column 0 its left
  assert(at(s, 0)[1] > at(s, corner(s, 'bl'))[1] && at(s, 0)[0] < at(s, corner(s, 'tr'))[0], 'row 0 is top, col 0 is left');
  assert(gridIndices(12, 6) === idx && gridUvs(12, 6) === uv, 'helpers are memoised');
  assert(new PaperSheet({ cols: 12, rows: 6 }).indices === idx, 'sheets share topology');
});

test('normals: unit, front face, valid right after placeFlat and after step', () => {
  const s = new PaperSheet({ cols: 36, rows: 16 });
  // face up: right = +x, up = −z → normal = right × up = +y
  s.placeFlat([0, 1, 0], [1, 0, 0], [0, 0, -1]);
  for (let i = 0; i < s.count; i++) assert(s.normals[i * 3 + 1] > 0.99, 'placeFlat normals point along right × up');
  s.step(DT, air());
  for (let i = 0; i < s.count; i++) {
    const n = [s.normals[i * 3], s.normals[i * 3 + 1], s.normals[i * 3 + 2]];
    assert(Math.abs(len(n) - 1) < 1e-4, 'unit length');
    assert(n[1] > 0.9, 'still the front face after a step');
  }
});

test('placeFlat + centroid + nearest', () => {
  const s = new PaperSheet({ cols: 18, rows: 8 });
  s.placeFlat([1, 2, 3], [0, 0, -1], [0, 1, 0]);
  const c = s.centroid();
  assert(dist(c, [1, 2, 3]) < 0.02, `centroid ${c}`);
  const tr = corner(s, 'tr');
  const hit = s.nearest(at(s, tr));
  assert(hit.index === tr && hit.dist < 1e-6, 'nearest finds the exact particle');
  // the right edge is along −z, half a note-width away
  assert(Math.abs(at(s, tr)[2] - (3 - ASPECT / 2)) < 0.05, 'right vector honoured');
});

test('setVelocity: linear + spin about the centroid', () => {
  const s = new PaperSheet({ cols: 18, rows: 8 });
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  s.setVelocity([1, 2, 0], [0, 0, 3]);
  s.step(1 / 240, air({ gravity: [0, 0, 0] }));
  const c = s.centroid();
  assert(Math.abs(c[0] - 1 / 240) < 2e-3 && Math.abs(c[1] - 2 / 240) < 2e-3, `centroid moved with v: ${c}`);
  // the right end moves up (ω × r with ω = +z, r = +x → +y), the left end down
  const r = at(s, corner(s, 'tr')), l = at(s, corner(s, 'tl'));
  assert(r[1] - 0.5 > l[1] - 0.5 + 0.01, 'spin turns the note');
});

// ------------------------------------------------------------------ robustness

test('stability: random pin teleports, dt spikes, NaN targets → finite and bounded', () => {
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const [cols, rows] of [[36, 16], [18, 8]] as const) {
    const s = new PaperSheet({ cols, rows, seed: 7 });
    s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const env = air({ floorY: -3, colliders: [{ kind: 'disk', center: [0, -1, 0], normal: [0, 1, 0], radius: 0.6, friction: 0.8 }] });
    let target: V3 = [0, 0, 0];
    let held = 0;
    for (let f = 0; f < 1500; f++) {
      const r = rand();
      if (r < 0.05) target = [(rand() - 0.5) * 12, (rand() - 0.5) * 8, (rand() - 0.5) * 6]; // tracking jump
      else if (r < 0.5) target = [target[0] + (rand() - 0.5) * 0.6, target[1] + (rand() - 0.5) * 0.6, target[2] + (rand() - 0.5) * 0.6]; // fast hand
      if (f % 300 === 0) {
        s.unpinAll();
        held = corner(s, rand() < 0.5 ? 'tl' : 'br');
      }
      if (f % 300 < 200) s.pin(held, target, rand() < 0.8 ? 1 : 0.5);
      else s.unpinAll();
      if (f % 97 === 0) s.pin(3, [NaN, 0, 0]); // garbage in must not poison the sheet
      if (f % 131 === 0) s.crumple(target, rand());
      if (f % 50 === 0) s.attach(target, [1, 0, 0], [0, 1, 0], rand());
      if (f % 50 === 25) s.detach();
      const dt = r < 0.02 ? 0.5 + rand() * 2 : r < 0.04 ? 0 : r < 0.06 ? 1e-4 : DT * (0.5 + rand());
      s.step(dt, env);
      assert(allFinite(s), `non-finite state at frame ${f} (${cols}x${rows})`);
      const b = bounds(s);
      assert(b < 2, `sheet blew up: radius ${b.toFixed(2)} at frame ${f} (${cols}x${rows})`);
    }
    // once things calm down, it is still paper-shaped
    s.unpinAll();
    s.detach();
    s.wrinkle = 0;
    s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    for (let f = 0; f < 120; f++) s.step(DT, air());
    assert(strain(s) < 0.03, `strain after recovery ${strain(s).toFixed(3)}`);
  }
  // two hands pulling one note apart: impossible, but it must stay finite and between the hands
  const s = new PaperSheet({ cols: 34, rows: 15, seed: 8 });
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  for (let f = 0; f < 240; f++) {
    const spread = Math.min(3, f * 0.05);
    s.pin(0, [-1.2 - spread, 0.5, 0], 1);
    s.pin(s.count - 1, [1.2 + spread, -0.5, 0], 1);
    s.step(DT, air());
    assert(allFinite(s), 'two-pin tug went non-finite');
  }
  for (let i = 0; i < s.count; i++) assert(Math.abs(at(s, i)[0]) < 4.3 && Math.abs(at(s, i)[1]) < 2, 'two-pin tug: paper left the space between the hands');
  // ...and taut reports it, so the engine can let a grip slip
  assert(s.taut > 1, `taut ${s.taut.toFixed(2)} for hands ~3x the note apart`);
  s.unpinAll();
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  s.pin(0, at(s, 0), 1);
  s.pin(s.cols - 1, at(s, s.cols - 1), 1);
  assert(s.taut < 0.01, `taut ${s.taut.toFixed(3)} when held at rest length`);
});

test('fast drag: a corner yanked across the screen at 12 u/s drags the note without stretching it', () => {
  const s = new PaperSheet({ cols: 36, rows: 16, seed: 3 });
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  const p0 = at(s, 0);
  for (let f = 0; f < 120; f++) {
    s.pin(0, p0, 1);
    s.step(DT, air());
  }
  let worst = 0;
  let target: V3 = p0;
  for (let f = 0; f < 180; f++) {
    // a quarter-second sweep to the right at 12 u/s, then stop dead and let it swing
    if (f < 15) target = [p0[0] + (f + 1) * 0.2, p0[1] + Math.sin(f * 0.2) * 0.2, p0[2]];
    s.pin(0, target, 1);
    s.step(DT, air());
    assert(dist(at(s, 0), target) < 1e-4, 'hard pin is exact at the end of the frame');
    worst = Math.max(worst, strains(s).stretch);
  }
  assert(worst < 0.03, `stretched ${(worst * 100).toFixed(1)}% while dragged`);
  // the far end trails the hand, then catches up under it
  const c = s.centroid();
  assert(Math.abs(c[0] - target[0]) < 0.35, `settles under the hand (Δx ${(c[0] - target[0]).toFixed(2)})`);
  return `worst stretch ${(worst * 100).toFixed(1)}%`;
});

test('violent shake: ±1.2 units at 1.4 Hz (≈10 u/s) stays finite, attached and not rubbery', () => {
  const s = new PaperSheet({ cols: 36, rows: 16, seed: 3 });
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  const p0 = at(s, 0);
  let sum = 0;
  let worst = 0;
  for (let f = 0; f < 240; f++) {
    const t = f * DT;
    const target: V3 = [p0[0] + Math.sin(t * 9) * 1.2, p0[1] + (1 - Math.cos(t * 7)) * 0.3, p0[2] + Math.sin(t * 5) * 0.4];
    s.pin(0, target, 1);
    s.step(DT, air());
    assert(allFinite(s), 'finite');
    assert(dist(at(s, 0), target) < 1e-4, 'hard pin is exact');
    const e = strains(s).stretch;
    worst = Math.max(worst, e);
    sum += e;
  }
  assert(sum / 240 < 0.05, `mean worst-edge stretch ${((sum / 240) * 100).toFixed(1)}%`);
  return `worst-edge stretch: mean ${((sum / 240) * 100).toFixed(1)}%, peak ${(worst * 100).toFixed(0)}%`;
});

// ------------------------------------------------------------------ paper-ness

test('inextensible: structural edges within 3% while hanging and swinging', () => {
  const out: string[] = [];
  for (const [cols, rows] of [[36, 16], [34, 15], [18, 8]] as const) {
    for (const seed of [1, 2]) {
      const s = new PaperSheet({ cols, rows, seed });
      s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
      const p0 = at(s, 0);
      let stretch = 0, squash = 0, off = 0;
      for (let f = 0; f < 360; f++) {
        const t = f * DT;
        s.pin(0, [p0[0] + Math.sin(t * 3) * 0.5, p0[1], p0[2] + Math.sin(t * 2) * 0.2], 1);
        s.step(DT, air());
        if (f < 30) continue; // the first swing down from flat
        const e = strains(s);
        stretch = Math.max(stretch, e.stretch);
        squash = Math.max(squash, e.squash);
        off = Math.max(off, e.off);
      }
      assert(stretch < 0.03, `${cols}x${rows}: stretch ${(stretch * 100).toFixed(2)}%`);
      assert(squash < 0.03, `${cols}x${rows}: squash ${(squash * 100).toFixed(2)}%`);
      assert(off === 0, `${cols}x${rows}: ${(off * 100).toFixed(1)}% of edges were off by more than 3%`);
      out.push(`${cols}x${rows}#${seed} +${(stretch * 100).toFixed(1)}%/−${(squash * 100).toFixed(1)}%`);
    }
  }
  return out.join('; ');
});

test('hangs from a corner like paper: far corner below the pin, sheet stays open and nearly flat', () => {
  const s = new PaperSheet({ cols: 36, rows: 16, seed: 4 });
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  const pin = at(s, 0);
  const diag = Math.hypot(ASPECT, 1);
  const c: V3 = [0, 0, 0];
  for (let f = 0; f < 360; f++) {
    s.pin(0, pin, 1);
    s.step(DT, air());
    // average the last second: it still sways gently in the gusts
    if (f >= 300) for (let k = 0; k < 3; k++) c[k] += s.centroid()[k] / 60;
  }
  const far = at(s, s.count - 1);
  assert(far[1] < pin[1] - 0.8 * diag, `far corner should hang below the pin: Δy = ${(far[1] - pin[1]).toFixed(2)}`);
  const span = dist(far, pin);
  assert(span > 0.85 * diag, `pin → far corner ${span.toFixed(2)} should stay within 15% of the diagonal ${diag.toFixed(2)}`);
  // centre of mass under the pin
  assert(Math.hypot(c[0] - pin[0], c[2] - pin[2]) < 0.15, 'centre of mass hangs under the pin');
  // mostly straight with a gentle curve: off-plane rms well under a tenth of a note height
  const rms = roughness(s);
  assert(rms < 0.1, `too droopy: rms off-plane ${rms.toFixed(3)}`);
  // the two corners next to the pin don't flop down onto the diagonal (cloth would)
  const tr = at(s, corner(s, 'tr')), bl = at(s, corner(s, 'bl'));
  const w = dist(tr, bl);
  assert(w > 0.85 * diag, `width across the other diagonal ${w.toFixed(2)} collapsed`);
  return `far corner Δy ${(far[1] - pin[1]).toFixed(2)}, span ${(span / diag * 100).toFixed(0)}% of diagonal, rms off-plane ${rms.toFixed(3)}`;
});

test('drop test: a flat note falls 4 units in 1.6–2.4 s and rocks as it goes', () => {
  const times: number[] = [];
  const tilts: number[] = [];
  const rocks: number[] = [];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const s = new PaperSheet({ cols: 36, rows: 16, seed });
    s.placeFlat([0, 2, 0], [1, 0, 0], [0, 0, -1]); // face up
    const y0 = s.centroid()[1];
    let t = 0;
    let maxTilt = 0;
    let swings = 0;
    let refX = 0, refZ = 0;
    while (s.centroid()[1] > y0 - 4 && t < 6) {
      s.step(DT, air());
      t += DT;
      const n = meanNormal(s);
      maxTilt = Math.max(maxTilt, (Math.acos(Math.min(1, Math.abs(n[1]))) * 180) / Math.PI);
      // rocking: the way the note leans (its normal's horizontal part) turns around
      const lean = Math.hypot(n[0], n[2]);
      if (lean > 0.08) {
        if (refX === 0 && refZ === 0) [refX, refZ] = [n[0], n[2]];
        else if (n[0] * refX + n[2] * refZ < 0) {
          swings++;
          [refX, refZ] = [n[0], n[2]];
        }
      }
    }
    times.push(t);
    tilts.push(maxTilt);
    assert(t >= 1.6 && t <= 2.4, `seed ${seed}: fell 4 units in ${t.toFixed(2)} s`);
    assert(maxTilt > 12, `seed ${seed}: barely rocked (max tilt ${maxTilt.toFixed(1)}°)`);
    assert(swings >= 1, `seed ${seed}: no rocking`);
    rocks.push(swings);
  }
  return `times ${times.map((t) => t.toFixed(2)).join('/')} s, max tilt ${tilts.map((a) => a.toFixed(0)).join('/')}°, lean reversals ${rocks.join('/')}`;
});

test('release: a note let go while hanging edge-down tips over and flutters instead of dropping like a slate', () => {
  const out: string[] = [];
  for (const seed of [1, 2, 3, 4]) {
    const s = new PaperSheet({ cols: 34, rows: 15, seed });
    s.placeFlat([0, 1, 0], [1, 0, 0], [0, 1, 0]);
    const pin = at(s, 0);
    for (let f = 0; f < 120; f++) {
      s.pin(0, pin, 1);
      s.step(DT, air());
    }
    s.unpinAll();
    const n0 = meanNormal(s);
    const y0 = s.centroid()[1];
    let t = 0;
    let tipped = NaN;
    while (s.centroid()[1] > y0 - 4 && t < 6) {
      s.step(DT, air());
      t += DT;
      const n = meanNormal(s);
      const ang = (Math.acos(Math.min(1, Math.abs(n[0] * n0[0] + n[1] * n0[1] + n[2] * n0[2]))) * 180) / Math.PI;
      if (Number.isNaN(tipped) && ang > 30) tipped = t;
    }
    // free fall would take sqrt(2·4/g) ≈ 1.07 s
    assert(tipped < 0.6, `seed ${seed}: still edge-down after 0.6 s`);
    assert(t > 1.35, `seed ${seed}: fell 4 units in ${t.toFixed(2)} s (too close to free fall)`);
    out.push(`${t.toFixed(2)}s (tipped ${tipped.toFixed(2)})`);
  }
  return out.join(', ');
});

test('throw: a flicked note travels, then slows and flutters down (drag works)', () => {
  const s = new PaperSheet({ cols: 34, rows: 15, seed: 9 });
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  s.setVelocity([0, 6, 8]); // up and toward the viewer, face-on to the z motion
  let maxZ = 0;
  for (let f = 0; f < 120; f++) {
    s.step(DT, air());
    maxZ = Math.max(maxZ, s.centroid()[2]);
  }
  assert(maxZ > 0.3 && maxZ < 3, `face-on throw carried ${maxZ.toFixed(2)} (air should stop it quickly)`);
  return `face-on throw at 8 u/s travels ${maxZ.toFixed(2)} units`;
});

// ------------------------------------------------------------------ contacts

test('floor: notes land, come to rest above the floor, then sleep (and wake when touched)', () => {
  const floorY = -2;
  const env = air({ floorY });
  const s = new PaperSheet({ cols: 18, rows: 8, seed: 5 });
  s.placeFlat([0, 0, 0], [0.8, 0.6, 0], [0, 0.3, 0.95]);
  s.setVelocity([1.5, 0, 0], [1, 2, 0]);
  let t = 0;
  while (!s.sleeping && t < 15) {
    s.step(DT, env);
    t += DT;
    for (let i = 0; i < s.count; i++) assert(at(s, i)[1] >= floorY - 1e-4, 'particle under the floor');
  }
  assert(s.sleeping, 'never came to rest');
  const c = s.centroid();
  assert(c[1] < floorY + 0.15, `resting at y=${c[1].toFixed(3)}`);
  assert(Math.abs(c[0]) < 3, `slid too far (${c[0].toFixed(2)})`);
  const before = Float32Array.from(s.positions);
  for (let f = 0; f < 60; f++) s.step(DT, env);
  assert(before.every((v, i) => v === s.positions[i]), 'a sleeping sheet does not move');
  // a palm coming close wakes it
  s.step(DT, air({ floorY, colliders: [{ kind: 'sphere', center: c, radius: 0.3, friction: 0.5 }] }));
  assert(!s.sleeping, 'a collider nearby wakes it');
  return `came to rest after ${t.toFixed(2)} s at y=${c[1].toFixed(3)}`;
});

test('palm disk: catches a falling note (even a fast one), holds it, and carries it when the palm moves', () => {
  const s = new PaperSheet({ cols: 18, rows: 8, seed: 6 });
  s.placeFlat([0, 1.5, 0], [1, 0, 0], [0, 0, -1]);
  s.setVelocity([0, -20, 0]); // faster than one substep's worth of disk thickness: tunnelling check
  const disk = { kind: 'disk' as const, center: [0, 0, 0] as V3, normal: [0, 1, 0] as V3, radius: 0.6, friction: 0.9 };
  for (let f = 0; f < 180; f++) s.step(DT, air({ floorY: -5, colliders: [disk] }));
  let c = s.centroid();
  assert(c[1] > -0.3 && c[1] < 0.4, `note should rest on the palm: centroid y = ${c[1].toFixed(2)}`);
  assert(s.colliderContacts > 0, 'contacts reported');
  // inside the disk radius nothing is below the palm
  for (let i = 0; i < s.count; i++) {
    const p = at(s, i);
    if (Math.hypot(p[0], p[2]) < 0.55) assert(p[1] > -0.01, 'particle pushed through the palm');
  }
  // slide the palm sideways: friction drags the note along
  for (let f = 0; f < 60; f++) {
    disk.center = [disk.center[0] + 0.6 * DT, 0, 0];
    s.step(DT, air({ floorY: -5, colliders: [disk] }));
  }
  c = s.centroid();
  assert(c[0] > 0.3, `palm moved 0.6 sideways, note followed only ${c[0].toFixed(2)}`);
  return `rests at y=${s.centroid()[1].toFixed(2)}, followed the palm ${c[0].toFixed(2)}/0.60`;
});

test('attach: a note follows a rigid pose (palm) closely but flexes a little', () => {
  const s = new PaperSheet({ cols: 34, rows: 15, seed: 8 });
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  let center: V3 = [0, 0, 0];
  for (let f = 0; f < 180; f++) {
    const t = f * DT;
    center = [Math.sin(t * 2) * 0.8, Math.cos(t * 1.5) * 0.4, 0.5];
    s.attach(center, [1, 0, 0], [0, 0, -1], 1); // held flat, face up
    s.step(DT, air());
  }
  const c = s.centroid();
  assert(dist(c, center) < 0.12, `centroid ${dist(c, center).toFixed(3)} from the pose`);
  const n = meanNormal(s);
  assert(n[1] > 0.95, 'faces the pose normal');
  // held still, flat and face up: the middle sits on the pose, the far ends droop a little
  for (let f = 0; f < 120; f++) {
    s.attach([0, 0, 0.5], [1, 0, 0], [0, 0, -1], 1);
    s.step(DT, air());
  }
  const mid = s.nearest([0, 0, 0.5]);
  const droop = at(s, mid.index)[1] - (at(s, 0)[1] + at(s, s.cols - 1)[1] + at(s, s.count - 1)[1] + at(s, s.count - s.cols)[1]) / 4;
  assert(mid.dist < 0.05, `middle ${mid.dist.toFixed(3)} off the pose`);
  assert(droop > 0.003 && droop < 0.2, `corner droop ${droop.toFixed(3)}`);
  s.detach();
  for (let f = 0; f < 30; f++) s.step(DT, air());
  assert(s.centroid()[1] < -0.05, 'falls once detached');
  return `corners droop ${droop.toFixed(3)} below the middle`;
});

test('housekeeping: dt ≤ 0 / NaN is a no-op, same seed → same motion, wrinkle = 0 irons a note flat', () => {
  const a = new PaperSheet({ cols: 18, rows: 8, seed: 42 });
  const b = new PaperSheet({ cols: 18, rows: 8, seed: 42 });
  for (const s of [a, b]) {
    s.placeFlat([0, 1, 0], [1, 0, 0], [0, 0.3, -1]);
    s.setVelocity([0.5, 0, 0], [0, 1, 2]);
  }
  const before = Float32Array.from(a.positions);
  a.step(0, air());
  a.step(-1, air());
  a.step(NaN, air());
  assert(before.every((v, i) => v === a.positions[i]), 'stepped on a bad dt');
  for (let f = 0; f < 120; f++) {
    a.step(DT, air());
    b.step(DT, air());
  }
  assert(a.positions.every((v, i) => v === b.positions[i]), 'not deterministic');
  // crumple, then recycle it as a fresh note
  for (let f = 0; f < 60; f++) {
    a.crumple(a.centroid(), 1);
    a.step(DT, air());
  }
  a.wrinkle = 0;
  a.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  for (let f = 0; f < 30; f++) a.step(DT, air({ gravity: [0, 0, 0] }));
  assert(roughness(a) < 0.02 && strain(a) < 0.01, `not flat again: rms ${roughness(a).toFixed(3)}`);
});

// ------------------------------------------------------------------ crumple

test('crumple: a fist balls it up; released, it springs partly open and stays creased', () => {
  const still = air({ gravity: [0, 0, 0] });
  const s = new PaperSheet({ cols: 34, rows: 15, seed: 11 });
  const fresh = new PaperSheet({ cols: 34, rows: 15, seed: 11 });
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  fresh.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  const open = bounds(s);
  let lastW = 0;
  let amount = 0;
  for (let f = 0; f < 90; f++) {
    amount = Math.min(1, amount + DT * 2.2); // how the engine ramps it
    s.crumple([0, 0, 0], amount);
    s.step(DT, still);
    fresh.step(DT, still);
    assert(s.wrinkle >= lastW, 'wrinkle never decreases');
    lastW = s.wrinkle;
  }
  const balled = bounds(s);
  assert(balled < 0.3 * open, `ball radius ${balled.toFixed(2)} vs open ${open.toFixed(2)}`);
  assert(s.wrinkle > 0.5, `wrinkle ${s.wrinkle.toFixed(2)}`);
  assert(allFinite(s), 'finite');
  for (let f = 0; f < 180; f++) {
    s.step(DT, still);
    fresh.step(DT, still);
  }
  const after = bounds(s);
  assert(after > 3 * balled, `didn't spring open: ${after.toFixed(2)} vs balled ${balled.toFixed(2)}`);
  // creases take up a little length, so it ends up a touch smaller — by no more than they can
  // (a bigger shrink would squeeze inextensible edges: see 'creased paper comes to rest')
  assert(after < open, `sprang back to full size (${after.toFixed(3)} vs ${open.toFixed(3)})`);
  assert(strain(s) < 0.03, `released crumple: edges strained ${(strain(s) * 100).toFixed(1)}%`);
  const r = roughness(s), r0 = roughness(fresh);
  assert(r > 2.5 * r0, `not creased: off-plane rms ${r.toFixed(3)} vs a fresh note's ${r0.toFixed(3)}`);
  assert(s.wrinkle >= lastW, 'wrinkle is remembered');
  return `radius ${open.toFixed(2)} → balled ${balled.toFixed(2)} → released ${after.toFixed(2)}; off-plane rms ${r0.toFixed(3)} → ${r.toFixed(3)}; wrinkle ${s.wrinkle.toFixed(2)}`;
});


// ------------------------------------------------------------------ review regressions
// Each of these failed on the first version of the module.

test('contacts never launch paper: a palm opening over a note, rain sliding past a palm, a corner under the floor', () => {
  const out: string[] = [];
  // (a) a palm (normal +y) appears 0.2 above a note lying face-up: the note is BEHIND it, leave it there
  {
    const s = new PaperSheet({ cols: 18, rows: 8, seed: 3 });
    s.placeFlat([0, 0, 0], [1, 0, 0], [0, 0, -1]);
    const still = air({ gravity: [0, 0, 0] });
    for (let f = 0; f < 5; f++) s.step(DT, still);
    const env = air({ gravity: [0, 0, 0], colliders: [{ kind: 'disk', center: [0, 0.2, 0], normal: [0, 1, 0], radius: 0.6, friction: 0.85 }] });
    let worst = 0;
    for (let f = 0; f < 60; f++) worst = Math.max(worst, stepSpeed(s, DT, env));
    assert(worst < 1, `a palm opening over a note flung it at ${worst.toFixed(1)} u/s`);
    assert(s.centroid()[1] < 0.1, 'yanked through to the front of the palm');
    out.push(`palm opening over a note: ${worst.toFixed(2)} u/s`);
  }
  // (b) a note falls edge-down just behind a palm that faces the camera: it should fall as if the palm weren't there
  for (const seed of [3, 4, 5]) {
    const run = (withPalm: boolean) => {
      const s = new PaperSheet({ cols: 18, rows: 8, seed });
      s.placeFlat([0.2, 1.2, -0.15], [1, 0, 0], [0, 1, 0]);
      const env = air({ colliders: withPalm ? [{ kind: 'disk', center: [0, 0, 0], normal: [0, 0, 1], radius: 0.6, friction: 0.85 }] : [] });
      let worst = 0;
      for (let f = 0; f < 60; f++) worst = Math.max(worst, stepSpeed(s, DT, env));
      return worst;
    };
    const a = run(false), b = run(true);
    assert(b < a * 1.1 + 0.3, `seed ${seed}: palm behind-contact sped the note up from ${a.toFixed(1)} to ${b.toFixed(1)} u/s`);
  }
  // (c) a pinch dipping 0.3 under the floor (a hand at the bottom of the frame): the corner stays on the
  // floor and the note lies still — no tug-of-war between the pin and the floor — and let go, it doesn't flick
  {
    const s = new PaperSheet({ cols: 34, rows: 15, seed: 6 });
    s.turbulence = 0;
    s.placeFlat([0, -1.2, 0], [1, 0, 0], [0, 1, 0]);
    const env = air({ floorY: -2 });
    let thrash = 0;
    for (let f = 0; f < 600; f++) {
      s.pin(s.count - 1, [0.5, -2.3, 0], 1);
      s.step(DT, env);
      if (f >= 300) thrash = Math.max(thrash, s.speed);
      for (let i = 0; i < s.count; i++) assert(at(s, i)[1] >= -2 - 1e-4, `frame ${f}: paper under the floor`);
    }
    assert(thrash < 0.05, `pinned under the floor, the note thrashes at ${thrash.toFixed(2)} u/s rms`);
    s.unpinAll();
    let worst = 0;
    for (let f = 0; f < 30; f++) worst = Math.max(worst, stepSpeed(s, DT, env));
    // (the bowed corner by the fingers springs flat for a few frames; the first version flung it at 20+)
    assert(worst < 8, `let go: ${worst.toFixed(1)} u/s`);
    out.push(`pinch under the floor: ${thrash.toFixed(3)} u/s rms, ${worst.toFixed(2)} u/s let go`);
  }
  // (c') one hand holds a note while the other hand's open palm is right there, the pinch just behind
  // it: held paper ignores palms (a pin behind a palm can't be satisfied; in the gusts that fight
  // made the first version's note whip at 2-6 u/s rms)
  for (const behind of [0.02, 0.1, 0.2]) {
    const run = (withPalm: boolean) => {
      const s = new PaperSheet({ cols: 34, rows: 15, seed: 6 });
      s.placeFlat([0, 0, 0.5], [1, 0, 0], [0, 1, 0]);
      const env = air({ colliders: withPalm ? [{ kind: 'disk', center: [0.1, 0.4, 0], normal: [0, 0, 1], radius: 0.6, friction: 0.85 }] : [] });
      let worst = 0;
      for (let f = 0; f < 600; f++) {
        s.pin(0, [0, 0.5, -behind], 1);
        s.step(DT, env);
        if (f >= 120) worst = Math.max(worst, s.speed);
      }
      return worst;
    };
    const a = run(false), b = run(true);
    assert(b < 1.2 * a + 0.1, `pinch ${behind} behind a palm: rms speed up to ${b.toFixed(2)} (${a.toFixed(2)} without the palm)`);
  }
  // (d) a palm scooping up through a resting note at 9 u/s lifts it at about its own speed
  {
    const s = new PaperSheet({ cols: 18, rows: 8, seed: 6 });
    s.placeFlat([0, 0, 0], [1, 0, 0], [0, 0, -1]);
    const disk = { kind: 'disk' as const, center: [0, -0.4, 0] as V3, normal: [0, 1, 0] as V3, radius: 0.6, friction: 0.85 };
    let worst = 0;
    const ys: number[] = [];
    for (let f = 0; f < 30; f++) {
      disk.center = [0, -0.4 + f * 0.15, 0];
      worst = Math.max(worst, stepSpeed(s, DT, air({ colliders: [disk] })));
      ys.push(s.centroid()[1]);
    }
    const v = (ys[29] - ys[19]) / (10 * DT);
    assert(v > 7 && v < 10.5, `scooped note rises at ${v.toFixed(1)} u/s with a 9 u/s palm`);
    assert(worst < 16, `scooping flung paper at ${worst.toFixed(1)} u/s`);
    out.push(`scoop: rises at ${v.toFixed(1)} u/s`);
  }
  return out.join('; ');
});

test('attach: sloppy frames neither collapse nor stretch the note; a one-frame palm flip only nudges it', () => {
  const pose = (s: PaperSheet, right: V3, up: V3, frames: number) => {
    for (let f = 0; f < frames; f++) {
      s.attach([0, 0, 0.5], right, up, 0.85);
      s.step(DT, air());
    }
  };
  for (const [right, up, what] of [
    [[0, 0, 0], [0, 0, 0], 'zero'],
    [[2, 0, 0], [0, 0, -0.5], 'scaled'],
    [[1, 0, 0], [1, 0, 0.001], 'parallel'],
    [[1, 0.3, 0], [0.4, 0.2, -1], 'skewed'],
  ] as [V3, V3, string][]) {
    const s = new PaperSheet({ cols: 34, rows: 15, seed: 8 });
    s.placeFlat([0, 0, 0.5], [1, 0, 0], [0, 0, -1]);
    pose(s, [1, 0, 0], [0, 0, -1], 30);
    const open = bounds(s);
    pose(s, right, up, 60);
    assert(allFinite(s), `${what} frame: non-finite`);
    assert(bounds(s) > 0.95 * open, `${what} frame collapsed the note (radius ${bounds(s).toFixed(2)} vs ${open.toFixed(2)})`);
    assert(strain(s) < 0.03, `${what} frame strained edges ${(strain(s) * 100).toFixed(1)}%`);
  }
  // the palm normal glitches upside-down for one frame
  const s = new PaperSheet({ cols: 34, rows: 15, seed: 8 });
  s.placeFlat([0, 0, 0.5], [1, 0, 0], [0, 0, -1]);
  pose(s, [1, 0, 0], [0, 0, -1], 90);
  const before = Float32Array.from(s.positions);
  let worst = 0;
  for (let f = 0; f < 30; f++) {
    pose(s, f === 0 ? [-1, 0, 0] : [1, 0, 0], [0, 0, -1], 1);
    for (let i = 0; i < s.count; i++) worst = Math.max(worst, dist(at(s, i), [before[i * 3], before[i * 3 + 1], before[i * 3 + 2]]));
  }
  assert(worst < 0.25, `a one-frame flip moved the note ${worst.toFixed(2)}`);
  return `one-frame palm flip moves it at most ${worst.toFixed(2)}`;
});

test('attach: critically damped — no bounce when the palm jumps or stops; handed to a far palm it swoops, not teleports', () => {
  const out: string[] = [];
  for (const w of [0.85, 0.4]) {
    const s = new PaperSheet({ cols: 34, rows: 15, seed: 8 });
    s.turbulence = 0;
    s.placeFlat([0, 0, 0.5], [1, 0, 0], [0, 0, -1]);
    for (let f = 0; f < 90; f++) {
      s.attach([0, 0, 0.5], [1, 0, 0], [0, 0, -1], w);
      s.step(DT, air());
    }
    const x0 = s.centroid()[0];
    let over = 0;
    for (let f = 0; f < 120; f++) {
      s.attach([0.3, 0, 0.5], [1, 0, 0], [0, 0, -1], w);
      s.step(DT, air());
      over = Math.max(over, s.centroid()[0] - x0 - 0.3);
    }
    assert(over < 0.05, `weight ${w}: overshot a 0.3 step by ${over.toFixed(3)} (a spring, not a palm)`);
    out.push(`step overshoot ${((over / 0.3) * 100).toFixed(0)}% @${w}`);
  }
  // the stand hands the note to a palm 3 units away: it flies there at about attachSpeed, and turns to face it
  const s = new PaperSheet({ cols: 34, rows: 15, seed: 8 });
  s.placeFlat([0, 0.5, 2.7], [1, 0, 0], [0, 1, 0]);
  for (let f = 0; f < 60; f++) {
    s.attach([0, 0.5, 2.7], [1, 0, 0], [0, 1, 0], 0.95);
    s.step(DT, air());
  }
  const B: V3 = [2, -0.5, 0.5];
  let last = s.centroid();
  let fastest = 0, turn = 0, reached = NaN, over = 0;
  let n0 = meanNormal(s);
  for (let f = 0; f < 120; f++) {
    s.attach(B, [1, 0, 0], [0, 0, -1], 0.4);
    s.step(DT, air());
    const c = s.centroid();
    fastest = Math.max(fastest, dist(c, last) / DT);
    last = c;
    const n = meanNormal(s);
    turn = Math.max(turn, Math.acos(Math.min(1, n[0] * n0[0] + n[1] * n0[1] + n[2] * n0[2])) / DT);
    n0 = n;
    if (Number.isNaN(reached) && dist(c, B) < 0.15) reached = (f + 1) * DT;
    if (!Number.isNaN(reached)) over = Math.max(over, dist(c, B));
  }
  assert(fastest < PAPER.attachSpeed * 1.5, `swooped at ${fastest.toFixed(1)} u/s (attachSpeed ${PAPER.attachSpeed})`);
  assert(reached > 0.15 && reached < 0.5, `reached the palm in ${reached.toFixed(2)} s`);
  assert(over < 0.2, `overshot the palm by ${over.toFixed(2)}`);
  assert(turn < PAPER.attachTurn * 1.6, `turned at ${turn.toFixed(1)} rad/s`);
  assert(n0[1] > 0.95, 'ends up facing the palm pose');
  out.push(`handoff of 3 units: ${reached.toFixed(2)} s, ≤ ${fastest.toFixed(1)} u/s, ≤ ${turn.toFixed(1)} rad/s`);
  return out.join('; ');
});

test('creased paper comes to rest: no perpetual spin or shimmer in still air, and it sleeps on the floor', () => {
  const ball = (s: PaperSheet, env: PaperEnv) => {
    s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    let amount = 0;
    for (let f = 0; f < 90; f++) {
      amount = Math.min(1, amount + DT * 2.2);
      s.crumple([0, 0, 0], amount);
      s.step(DT, env);
    }
  };
  const still = air({ gravity: [0, 0, 0] });
  const s = new PaperSheet({ cols: 34, rows: 15, seed: 11 });
  s.turbulence = 0;
  ball(s, still);
  for (let f = 0; f < 360; f++) s.step(DT, still);
  assert(s.speed < 0.02, `released crumple in still air still moving at ${s.speed.toFixed(3)} u/s rms after 6 s`);
  const onFloor = new PaperSheet({ cols: 34, rows: 15, seed: 11 });
  const floor = air({ floorY: -2 });
  ball(onFloor, floor);
  let t = 0;
  while (!onFloor.sleeping && t < 8) {
    onFloor.step(DT, floor);
    t += DT;
  }
  assert(onFloor.sleeping, `crumpled note never settled on the floor (rms ${onFloor.speed.toFixed(3)} u/s)`);
  return `still air: ${s.speed.toFixed(4)} u/s after 6 s; asleep on the floor after ${t.toFixed(1)} s`;
});

test('shape match tracks rotation: a rolling note is slowed by the air, not braked by the fit', () => {
  const s = new PaperSheet({ cols: 34, rows: 15, seed: 11 });
  s.turbulence = 0;
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  s.setVelocity([0, 0, 0], [3, 0, 0]); // about its long axis: the hardest one for an iterative fit
  const still = air({ gravity: [0, 0, 0] });
  for (let f = 0; f < 60; f++) s.step(DT, still);
  const n0 = meanNormal(s);
  s.step(DT, still);
  const n1 = meanNormal(s);
  const rate = Math.acos(Math.min(1, n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2])) / DT;
  assert(rate > 0.7, `roll rate ${rate.toFixed(2)} rad/s after 1 s (from 3)`);
  return `3 → ${rate.toFixed(2)} rad/s after 1 s`;
});

test('frame rate: same drop and hang at 30, 60, 120 and 144 Hz, and with ragged frames', () => {
  const drop = (dts: () => number) => {
    const s = new PaperSheet({ cols: 34, rows: 15, seed: 2 });
    s.placeFlat([0, 2, 0], [1, 0, 0], [0, 0, -1]);
    const y0 = s.centroid()[1];
    let t = 0;
    while (s.centroid()[1] > y0 - 4 && t < 6) {
      const dt = dts();
      s.step(dt, air());
      t += dt;
    }
    return t;
  };
  let k = 0;
  const ragged = () => [1 / 60, 0.0005, 1 / 45, 1 / 90, 1 / 60][k++ % 5];
  const times = [30, 60, 120, 144].map((hz) => drop(() => 1 / hz));
  times.push(drop(ragged));
  const lo = Math.min(...times), hi = Math.max(...times);
  assert(hi - lo < 0.15, `drop times ${times.map((t) => t.toFixed(2)).join('/')} s`);
  // a held note doesn't twitch when rAF fires twice in a row (a 0.5 ms frame) while the hand moves
  const twitch = (ragged: boolean) => {
    const s = new PaperSheet({ cols: 34, rows: 15, seed: 3 });
    s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const p: V3 = [-1.14, 0.5, 0];
    let worst = 0;
    for (let f = 0; f < 360; f++) {
      if (f % 2 === 0) p[0] += f % 40 < 20 ? 0.02 : -0.02; // a 30 Hz camera
      s.pin(0, p, 1);
      s.step(ragged && f % 10 === 5 ? 0.0005 : DT, air());
      if (f > 120) worst = Math.max(worst, s.speed);
    }
    return worst;
  };
  const a = twitch(false), b = twitch(true);
  assert(b < 1.3 * a, `0.5 ms frames: rms speed up to ${b.toFixed(2)} u/s vs ${a.toFixed(2)} at a steady 60`);
  return `drop ${times.map((t) => t.toFixed(2)).join('/')} s (30/60/120/144 Hz/ragged); held note rms ${a.toFixed(2)} → ${b.toFixed(2)} u/s with 0.5 ms frames`;
});

test('setVelocity respects the speed limit', () => {
  const s = new PaperSheet({ cols: 18, rows: 8, seed: 3 });
  s.placeFlat([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  s.setVelocity([1e6, 0, 0], [0, 0, 1e6]);
  s.step(DT, air());
  assert(allFinite(s) && dist(s.centroid(), [0, 0, 0]) < PAPER.maxSpeed * DT * 1.5, `one frame carried it ${dist(s.centroid(), [0, 0, 0]).toFixed(1)}`);
});

// Hot paths only: attach() and its once-a-frame pose update run cold for a long while, and V8's
// interpreter boxes their doubles (~2 KB/frame per carried note until they tier up; none in Safari).
test('step() allocates nothing: hero held, one crumpled, 60 falling', () => {
  if (!gc) return 'skipped (no gc hook)';
  const disk = { kind: 'disk' as const, center: [0, -0.5, 1] as V3, normal: [0, 1, 0] as V3, radius: 0.6, friction: 0.85 };
  const env = air({ wind: [0.1, 0, 0], colliders: [disk], floorY: -1e4 }); // nobody lands mid-measurement
  const hero = new PaperSheet({ cols: 34, rows: 15, seed: 1 });
  const fist = new PaperSheet({ cols: 18, rows: 8, seed: 3 });
  const rain = Array.from({ length: 60 }, (_, k) => new PaperSheet({ cols: 18, rows: 8, seed: 10 + k }));
  rain.forEach((s, k) => {
    s.placeFlat([k * 0.1 - 2, 1, 0], [1, 0, 0], [0, 1, 0]);
    s.setVelocity([0, 0, 0], [1, 2, 3]);
  });
  const target: V3 = [0, 0.5, 1];
  const c: V3 = [0, 0, 1];
  const frame = (f: number) => {
    target[0] = Math.sin(f * DT * 2);
    hero.pin(0, target, 1);
    c[0] = Math.sin(f * DT) * 0.5;
    disk.center[0] = c[0];
    fist.crumple(c, 0.5 + 0.5 * Math.sin(f * DT));
    hero.step(DT, env);
    fist.step(DT, env);
    for (const s of rain) s.step(DT, env);
  };
  let f = 0;
  for (; f < 1200; f++) frame(f); // warm up the JIT
  gc();
  gc();
  const before = heapUsed();
  for (let k = 0; k < 1200; k++, f++) frame(f);
  const perFrame = (heapUsed() - before) / 1200;
  // the first version made ~3.8 KB/frame of garbage in a scene like this
  assert(perFrame < 300, `${perFrame.toFixed(0)} bytes/frame`);
  return `${perFrame.toFixed(0)} bytes/frame`;
});

// ------------------------------------------------------------------ performance

test('benchmark: hero 36x16 + 60 rain 18x8, all awake, at 60 fps', () => {
  const env = air({ floorY: -2.2, wind: [0.1, 0, 0], colliders: [{ kind: 'disk', center: [0, -0.5, 1], normal: [0, 1, 0], radius: 0.6, friction: 0.85 }] });
  const hero = new PaperSheet({ cols: 36, rows: 16, seed: 100 });
  hero.placeFlat([0, 0.5, 1], [1, 0, 0], [0, 1, 0]);
  const rain = Array.from({ length: 60 }, (_, k) => new PaperSheet({ cols: 18, rows: 8, seed: 200 + k }));
  const spawn = (s: PaperSheet, k: number) => {
    const a = k * 1.7;
    s.placeFlat([Math.sin(a) * 2, 1.5 + (k % 7) * 0.4, Math.cos(a) * 0.5], [Math.cos(a), 0.3, Math.sin(a)], [0, 0.4, 1]);
    s.setVelocity([Math.sin(k), 1, 0.3], [Math.sin(k * 3) * 3, Math.cos(k * 2) * 3, 1]);
  };
  rain.forEach(spawn);
  const times: number[] = [];
  for (let f = 0; f < 900; f++) {
    const t = f * DT;
    hero.pin(0, [Math.sin(t * 2) * 1.2, 0.8 + Math.sin(t * 3) * 0.3, 1 + Math.sin(t) * 0.3], 1);
    // worst case: nothing ever lands and goes to sleep
    for (let k = 0; k < rain.length; k++) if (rain[k].sleeping || rain[k].floorContacts > 0) spawn(rain[k], k + f);
    const t0 = performance.now();
    hero.step(DT, env);
    for (const s of rain) s.step(DT, env);
    if (f >= 150) times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const med = times[times.length >> 1];
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`\n  benchmark: ${mean.toFixed(2)} ms/frame mean, ${med.toFixed(2)} median, ${p95.toFixed(2)} p95  (36x16 + 60×18x8, ${PAPER.substep === 1 / 120 ? '120 Hz substeps' : 'custom substeps'})`);
  // a loose bound so a slow CI box doesn't flake; the target on a laptop is < 3 ms
  assert(med < 5, `median ${med.toFixed(2)} ms/frame`);
  return `${med.toFixed(2)} ms/frame median`;
});

console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
proc.exit(failed ? 1 : 0);
