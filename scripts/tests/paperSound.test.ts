// Paper sound tests. Run: npx --yes tsx@4 scripts/tests/paperSound.test.ts
// Pure Node: a recording mock of WebAudio stands in for the browser, so these check
// behaviour (what gets scheduled, when, and that everything is released) — not how it
// sounds. scripts/tests/paperSound.render.test.ts renders the real thing offline.

import type { PaperSoundsApi } from '../../src/contracts';

// ------------------------------------------------------------ mock WebAudio

type Ev = { kind: 'target' | 'value' | 'ramp'; v: number; t: number; tau: number };
let ctx: MCtx;

function finite(...xs: number[]) {
  for (const x of xs) if (!Number.isFinite(x)) throw new Error(`non-finite automation value ${x}`);
}

class MParam {
  events: Ev[] = [];
  writes = 0;
  maxEvents = 0;
  constructor(
    public value: number,
    readonly owner: MNode,
  ) {}
  private push(e: Ev) {
    this.events.push(e);
    this.events.sort((a, b) => a.t - b.t);
    this.writes++;
    this.maxEvents = Math.max(this.maxEvents, this.events.length);
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    finite(v, t, tau);
    if (!(tau > 0)) throw new Error('timeConstant must be > 0');
    return this.push({ kind: 'target', v, t, tau });
  }
  setValueAtTime(v: number, t: number) {
    finite(v, t);
    return this.push({ kind: 'value', v, t, tau: 0 });
  }
  linearRampToValueAtTime(v: number, t: number) {
    finite(v, t);
    return this.push({ kind: 'ramp', v, t, tau: 0 });
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    finite(v, t);
    if (!(v > 0)) throw new Error('exponential ramp to 0');
    return this.push({ kind: 'ramp', v, t, tau: 0 });
  }
  /** browsers drop events that are wholly in the past: keep the one in force and those to come */
  prune(now: number) {
    let k = 0;
    while (k + 1 < this.events.length && this.events[k + 1].t <= now) k++;
    if (k) {
      // fold the dropped history into the starting value, as the browser's running value would
      const v = this.valueAt(this.events[k].t);
      this.events = this.events.slice(k);
      if (this.events[0].kind === 'target') this.value = v;
      else this.value = this.events[0].v;
      this.origin = this.events[0].t;
    }
  }
  origin = 0;
  cancels = 0;
  cancelScheduledValues(t: number) {
    finite(t);
    this.cancels++;
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }
  /** the value the timeline gives at time T (setTarget / setValue only) */
  valueAt(T: number) {
    let v = this.value;
    let cur = this.origin;
    let target: number | null = null;
    let tau = 1;
    for (const e of this.events) {
      if (e.t > T) break;
      if (target !== null) v = target + (v - target) * Math.exp(-(e.t - cur) / tau);
      cur = e.t;
      if (e.kind === 'target') {
        target = e.v;
        tau = e.tau;
      } else {
        v = e.v;
        target = null;
      }
    }
    if (target !== null) v = target + (v - target) * Math.exp(-(T - cur) / tau);
    return v;
  }
  /** the last target written at or before T (ignores a dead-man fade further ahead) */
  targetAt(T: number) {
    let v = this.value;
    for (const e of this.events) if (e.t <= T) v = e.v;
    return v;
  }
}

class MNode {
  out = new Set<MNode | MParam>();
  links: (MNode | MParam)[] = [];
  disconnects = 0;
  createdAt: number;
  constructor(readonly kind: string) {
    this.createdAt = ctx.currentTime;
    ctx.nodes.push(this);
  }
  connect<T extends MNode | MParam>(x: T): T {
    this.out.add(x);
    this.links.push(x);
    return x;
  }
  disconnect() {
    this.out.clear();
    this.disconnects++;
  }
}

class MGain extends MNode {
  gain = new MParam(1, this);
  constructor() {
    super('gain');
  }
}
class MFilter extends MNode {
  type = 'lowpass';
  frequency = new MParam(350, this);
  Q = new MParam(1, this);
  constructor() {
    super('filter');
  }
}
class MPanner extends MNode {
  pan = new MParam(0, this);
  constructor() {
    super('panner');
  }
}
class MConvolver extends MNode {
  buffer: MBuffer | null = null;
  normalize = true;
  constructor() {
    super('convolver');
  }
}
class MSource extends MNode {
  startT?: number;
  stopT?: number;
  ended = false;
  onended: (() => void) | null = null;
  activeAtStart = 0;
  start(when = 0, offset = 0) {
    finite(when, offset);
    if (this.startT !== undefined) throw new Error('started twice');
    this.startT = when;
    this.activeAtStart = ctx.oneShots().filter((s) => (s as MSource) !== this && s.startT !== undefined && s.endTime() > ctx.currentTime).length;
  }
  stop(when?: number) {
    if (this.startT === undefined) throw new Error('stop before start');
    this.stopT = when ?? ctx.currentTime;
  }
  endTime() {
    return this.stopT ?? Infinity;
  }
}
class MBufferSource extends MSource {
  buffer: MBuffer | null = null;
  loop = false;
  playbackRate = new MParam(1, this);
  constructor() {
    super('bufferSource');
  }
  endTime() {
    if (this.stopT !== undefined) return this.stopT;
    if (this.loop || !this.buffer || this.startT === undefined) return Infinity;
    return this.startT + this.buffer.duration / this.playbackRate.value;
  }
}
class MOsc extends MSource {
  type = 'sine';
  frequency = new MParam(440, this);
  constructor() {
    super('oscillator');
  }
}
class MBuffer {
  data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    if (!(length > 0) || !(sampleRate >= 3000)) throw new Error('bad buffer');
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    ctx.buffers.push(this);
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(i: number) {
    return this.data[i];
  }
}
class MCtx {
  currentTime = 0;
  state = 'running';
  sampleRate = 48000;
  nodes: MNode[] = [];
  buffers: MBuffer[] = [];
  destination: MNode;
  constructor() {
    ctx = this; // eslint-disable-line @typescript-eslint/no-this-alias
    this.destination = new MNode('destination');
  }
  createGain() {
    return new MGain();
  }
  createBiquadFilter() {
    return new MFilter();
  }
  createStereoPanner() {
    return new MPanner();
  }
  createConvolver() {
    return new MConvolver();
  }
  createBufferSource() {
    return new MBufferSource();
  }
  createOscillator() {
    return new MOsc();
  }
  createBuffer(ch: number, len: number, sr: number) {
    return new MBuffer(ch, len, sr);
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  oneShots() {
    return this.nodes.filter((n): n is MBufferSource => n instanceof MBufferSource && !n.loop);
  }
  advance(dt: number) {
    this.currentTime += dt;
    for (const n of this.nodes) for (const v of Object.values(n)) if (v instanceof MParam) v.prune(this.currentTime);
    for (const n of this.nodes) {
      if (n instanceof MSource && !n.ended && n.startT !== undefined && n.endTime() <= this.currentTime) {
        n.ended = true;
        n.onended?.();
      }
    }
  }
}

(globalThis as unknown as { window: unknown }).window = { AudioContext: MCtx };
// the page's visibility, which the module listens to
const visibility: (() => void)[] = [];
const doc = { visibilityState: 'visible', addEventListener: (type: string, fn: () => void) => type === 'visibilitychange' && visibility.push(fn) };
(globalThis as unknown as { document: unknown }).document = doc;

const { sound } = await import('../../src/sound');
const { paperSound, PAPER_SOUND } = await import('../../src/paperSound');
const api: PaperSoundsApi = paperSound; // it is the contract

// ------------------------------------------------------------ harness

let failed = 0;
const results: string[] = [];
async function test(name: string, fn: () => string | void | Promise<string | void>) {
  try {
    const info = await fn();
    results.push(`  ok    ${name}${info ? `  — ${info}` : ''}`);
  } catch (e) {
    failed++;
    results.push(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const FRAME = 1 / 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** a new AudioContext, as if the page had just been opened and clicked */
function fresh() {
  (sound as unknown as { ctx: unknown }).ctx = null;
  sound.wake();
  sound.setEnabled(true);
  return ctx;
}

function frames(seconds: number, each: (t: number, k: number) => void, dt: number | (() => number) = FRAME) {
  const end = ctx.currentTime + seconds;
  for (let k = 0; ctx.currentTime < end - 1e-9; k++) {
    each(ctx.currentTime, k);
    ctx.advance(typeof dt === 'number' ? dt : dt());
  }
}

const SR = 48000;
const KINDS: Record<number, string> = {
  [Math.round(SR * 0.035)]: 'tick',
  [Math.round(SR * 0.04)]: 'crackle',
  [Math.round(SR * 0.08)]: 'crunch',
  [Math.round(SR * 0.16)]: 'grab',
  [Math.round(SR * 0.34)]: 'release',
  [Math.round(SR * 0.2)]: 'catch',
  [Math.round(SR * 0.42)]: 'snap',
  [Math.round(SR * 2.3)]: 'noise',
  [Math.round(SR * 0.6)]: 'room',
};
function kindOf(b: MBuffer | null) {
  if (!b) return 'none';
  if (b.sampleRate === 22050) return b.duration < 5 ? 'flap' : 'tumble';
  return KINDS[b.length] ?? 'other';
}
const shots = (kind: string, from = -1, to = Infinity) =>
  ctx.oneShots().filter((s) => (kind === 'crackle' ? ['crackle', 'crunch'].includes(kindOf(s.buffer)) : kindOf(s.buffer) === kind) && s.startT! >= from && s.startT! < to);
const loops = () => ctx.nodes.filter((n): n is MSource => n instanceof MSource && (n instanceof MOsc || (n as MBufferSource).loop));
const gainOf = (s: MNode) => (s.links.find((n) => n instanceof MGain) as MGain).gain.value;

/** every node downstream of `from` (following params to their owners), up to the shared bus */
function reach(from: MNode[]) {
  const master = ctx.nodes[1]; // sound.ts's master, the first node after the destination
  const shared = (n: MNode) => n === master || n instanceof MConvolver || n.links.includes(master);
  const seen = new Set<MNode>();
  const todo = [...from];
  while (todo.length) {
    const n = todo.pop()!;
    if (seen.has(n) || shared(n)) continue;
    seen.add(n);
    for (const l of n.links) todo.push(l instanceof MParam ? l.owner : l);
  }
  const nodes = [...seen];
  const params = nodes.flatMap((n) => Object.values(n).filter((v): v is MParam => v instanceof MParam));
  return { nodes, params };
}

/** the live flutter graph, found from its flap envelope */
function flutterGraph() {
  const flap = ctx.nodes.find((n): n is MBufferSource => n instanceof MBufferSource && kindOf(n.buffer) === 'flap' && n.stopT === undefined);
  assert(flap, 'no live flutter loop');
  const srcs = ctx.nodes.filter((n) => n instanceof MBufferSource && n.loop && n.createdAt === flap.createdAt && ['noise', 'flap', 'tumble'].includes(kindOf(n.buffer)));
  const flapAmt = flap.links[0] as MGain;
  const vca = (flapAmt.links[0] as MParam).owner as MGain;
  const out = (vca.links[0] as MGain).links[0] as MGain;
  const body = ctx.nodes.find((n): n is MFilter => n instanceof MFilter && n.type === 'bandpass' && n.links.includes(vca));
  assert(body, 'no flutter body filter');
  return { flap, out, body, ...reach(srcs) };
}

/** the live counter graph, found from its motor */
function counterGraph() {
  const motor = ctx.nodes.find((n): n is MOsc => n instanceof MOsc && n.type === 'sawtooth' && n.stopT === undefined);
  assert(motor, 'no live counter loop');
  const srcs = ctx.nodes.filter((n) => n instanceof MSource && n.createdAt === motor.createdAt && (n instanceof MOsc || (n as MBufferSource).loop));
  const level = ((motor.links[0] as MFilter).links[0] as MGain).gain;
  const g = reach(srcs);
  return { motor, level, nodes: g.nodes.filter((n) => !(n instanceof MBufferSource && !n.loop)), params: g.params };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))];

// ------------------------------------------------------------ tests

await test('before audio wakes: every call is a silent no-op', () => {
  for (let k = 0; k < 120; k++) {
    api.flutter(5);
    api.counter(1);
    api.crumple(k / 120);
    api.grab();
    api.release();
    api.catchNote();
    api.snap();
  }
  assert(sound.audio === null, 'audio woke by itself');
});

await test('muted or suspended: no nodes at all', () => {
  fresh();
  sound.setEnabled(false);
  const before = ctx.nodes.length;
  const all = (t: number) => {
    api.flutter(5);
    api.counter(1);
    api.crumple(Math.min(1, t));
    api.grab();
    api.release();
    api.catchNote();
    api.snap();
  };
  frames(1, all);
  assert(ctx.nodes.length === before, `muted made ${ctx.nodes.length - before} nodes`);
  sound.setEnabled(true);
  ctx.state = 'suspended';
  frames(1, all);
  assert(ctx.nodes.length === before, `suspended made ${ctx.nodes.length - before} nodes`);
  ctx.state = 'running';
});

await test('the first sound after waking plays at full level (nothing fades in)', () => {
  fresh();
  const master = ctx.nodes[1] as MGain;
  api.snap();
  const bus = ctx.nodes.find((n): n is MGain => n instanceof MGain && n !== master && n.links.includes(master) && n.links.some((l) => l instanceof MConvolver));
  assert(bus, 'no paper bus');
  assert(bus.gain.valueAt(0) === PAPER_SOUND.level && bus.gain.events.every((e) => e.v === PAPER_SOUND.level), `bus starts at ${bus.gain.valueAt(0)}, heading to ${bus.gain.targetAt(1)}`);
  const snap = shots('snap')[0];
  assert(snap && snap.startT === 0, 'snap not started at once');
});

await test('flutter: silent at 0, then one loop built lazily and reused', () => {
  fresh();
  frames(1, () => api.flutter(0));
  frames(1, () => api.flutter(0.25)); // resting jitter
  assert(loops().length === 0, `${loops().length} loop sources running at rest`);
  frames(2, () => api.flutter(3 + Math.random()));
  const ls = loops();
  assert(ls.length === 3, `${ls.length} looping sources, expected 3 (noise, flaps, tumble)`);
  assert(ls.every((s) => s.startT !== undefined && s.stopT === undefined), 'loop not running');
  return `${ctx.nodes.length} nodes in total`;
});

await test('flutter: louder, brighter, flapping faster with speed', () => {
  fresh();
  const rows: number[][] = [];
  for (const s of [0.6, 1.5, 3, 5, 8]) {
    frames(0.5, () => api.flutter(s));
    const g = flutterGraph();
    const t = ctx.currentTime;
    rows.push([s, g.out.gain.targetAt(t), g.body.frequency.targetAt(t), g.flap.playbackRate.targetAt(t) * 10]);
  }
  for (let i = 1; i < rows.length; i++) {
    for (const [c, name] of [[1, 'level'], [2, 'brightness'], [3, 'flap rate']] as const) {
      assert(rows[i][c] > rows[i - 1][c], `${name} fell from ${rows[i - 1][c].toFixed(3)} to ${rows[i][c].toFixed(3)} at speed ${rows[i][0]}`);
    }
  }
  const [lo, hi] = [rows[0][3], rows[rows.length - 1][3]];
  assert(lo >= 8 && lo < 11 && Math.abs(hi - 25) < 0.01, `flap rate ${lo.toFixed(1)}–${hi.toFixed(1)} Hz, expected 8–25`);
  return rows.map((r) => `${r[0]}u/s: ${r[1].toFixed(3)} @ ${Math.round(r[2])}Hz, ${r[3].toFixed(1)} flaps/s`).join('; ');
});

await test('flutter: glides only (setTarget), bounded automation at 60 calls/s', () => {
  fresh();
  frames(0.1, () => api.flutter(2));
  const g = flutterGraph();
  frames(3, () => api.flutter(Math.random() < 0.1 ? 0 : Math.random() * 9));
  let maxEvents = 0;
  let writes = 0;
  for (const p of g.params) {
    assert(p.events.every((e) => e.kind === 'target' && e.tau >= 0.02), 'a step or a too-fast glide on a flutter param');
    maxEvents = Math.max(maxEvents, p.maxEvents);
    writes = Math.max(writes, p.writes);
  }
  assert(maxEvents <= 2, `a param held ${maxEvents} pending automation events`);
  assert(writes <= 3.1 * 60 + 1, `a param was written ${writes} times in 3.1 s (more than once a frame)`);
  return `≤ ${maxEvents} pending events per param; busiest param written ${writes}× in 3.1 s of random speeds`;
});

await test('flutter: back to 0 fades out, then the loop is released (no click)', () => {
  fresh();
  frames(1, () => api.flutter(4));
  const g = flutterGraph();
  const on = g.out.gain.valueAt(ctx.currentTime);
  const stopAt = ctx.currentTime;
  let left = NaN;
  frames(2.5, (t) => {
    const level = g.out.gain.valueAt(t);
    api.flutter(0);
    if (g.flap.stopT !== undefined && Number.isNaN(left)) left = level; // the level as it was released
  });
  assert(g.flap.stopT !== undefined, 'loop still running 2.5 s after going quiet');
  const at = g.flap.stopT!;
  assert(left < on * 1e-4, `level at release was ${(left / on).toExponential(1)} of full (a click)`);
  assert(g.nodes.every((n) => n.disconnects > 0), 'flutter nodes left connected');
  frames(0.2, () => api.flutter(4));
  assert(loops().filter((s) => s.stopT === undefined).length === 3, 'did not come back');
  return `released ${(at - stopAt).toFixed(2)} s after the last motion, at ${(20 * Math.log10(left / on)).toFixed(0)} dB`;
});

await test('flutter / counter: hushed when nobody steers them (engine stalled), then released', async () => {
  fresh();
  frames(1, () => {
    api.flutter(4);
    api.counter(0.7);
  });
  const f = flutterGraph();
  const c = counterGraph();
  const t = ctx.currentTime; // the frame loop stops here
  const full = [f.out.gain.valueAt(t), c.level.valueAt(t)];
  await sleep(150); // the sweeper runs, but it's too soon to tell a stall from a slow frame
  assert(f.out.gain.targetAt(ctx.currentTime) > 0, 'hushed after a single missed frame');
  ctx.advance(0.3);
  await sleep(150);
  const h = ctx.currentTime;
  assert(f.out.gain.valueAt(h + 0.3) < 0.01 * full[0], 'flutter kept going with nobody steering it');
  assert(c.level.valueAt(h + 0.3) < 0.01 * full[1], 'counter motor kept going with nobody steering it');
  ctx.advance(2);
  await sleep(250);
  assert(f.flap.stopT !== undefined && c.motor.stopT !== undefined, 'loops not released by the sweeper');
  assert([...f.nodes, ...c.nodes].every((n) => n.disconnects > 0), 'loop nodes left connected');
  return `hushed ${((h - t) * 1000).toFixed(0)} ms after the last call, released after ${(ctx.currentTime - t).toFixed(1)} s`;
});

await test('a hidden tab hushes the loops at once; they come back when it shows', () => {
  fresh();
  frames(1, () => {
    api.flutter(4);
    api.counter(1);
  });
  const f = flutterGraph();
  const c = counterGraph();
  const t = ctx.currentTime;
  const full = f.out.gain.valueAt(t);
  doc.visibilityState = 'hidden';
  visibility.forEach((fn) => fn());
  assert(f.out.gain.valueAt(t + 0.25) < 0.01 * full, 'flutter still audible in a hidden tab');
  assert(c.level.valueAt(t + 0.25) < 0.01 * c.level.valueAt(t), 'counter still audible in a hidden tab');
  ctx.advance(0.5);
  doc.visibilityState = 'visible';
  visibility.forEach((fn) => fn());
  frames(0.5, () => {
    api.flutter(4);
    api.counter(1);
  });
  assert(f.out.gain.valueAt(ctx.currentTime) > 0.9 * full, 'flutter did not come back');
});

await test('counter: 25–35 notes a second, slightly irregular', () => {
  const out: string[] = [];
  for (const [i, lo, hi] of [[1, 32, 38], [0.3, 25.5, 31], [0.02, 22.5, 28]] as const) {
    fresh();
    frames(3, () => api.counter(i));
    const ticks = shots('tick', 1, 3).map((s) => s.startT!);
    const rate = ticks.length / 2;
    assert(rate >= lo && rate <= hi, `intensity ${i}: ${rate.toFixed(1)} ticks/s, expected ${lo}–${hi}`);
    const gaps = ticks.slice(1).map((t, k) => t - ticks[k]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const cv = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) / mean;
    assert(cv > 0.03 && cv < 0.12, `intensity ${i}: interval variation ${(cv * 100).toFixed(0)}%`);
    out.push(`${i}: ${rate.toFixed(1)}/s ±${(cv * 100).toFixed(0)}%`);
  }
  return out.join(', ');
});

await test('counter: spins up, coasts down in a fraction of a second, then is released', () => {
  fresh();
  frames(1.5, () => api.counter(0.8));
  const t0 = ctx.currentTime;
  const first = shots('tick', 0, 0.1).length;
  const steady = shots('tick', 1, 1.1).length;
  assert(first < steady, `no spin-up (${first} ticks in the first 100 ms vs ${steady})`);
  const c = counterGraph();
  const motor: number[] = []; // sampled as it runs: the mock, like a browser, forgets past automation
  frames(2.5, (t) => {
    motor.push(c.level.valueAt(t));
    api.counter(0);
  });
  const motorAt = (s: number) => motor[Math.round(s / FRAME)];
  const tail = shots('tick', t0).map((s) => s.startT!);
  assert(tail.length >= 2 && tail.length <= 10, `${tail.length} ticks after stopping`);
  assert(tail[tail.length - 1] - t0 < 0.4, `ticks went on for ${(tail[tail.length - 1] - t0).toFixed(2)} s`);
  const gaps = tail.slice(1).map((t, k) => t - tail[k]);
  assert(gaps[gaps.length - 1] > gaps[0], 'the tail does not slow down');
  assert(motorAt(0.6) < 0.01 * motorAt(0), `motor at ${(motorAt(0.6) / motorAt(0)).toFixed(3)}× 0.6 s after stopping`);
  assert(c.motor.stopT !== undefined && c.nodes.every((n) => n.disconnects > 0), 'counter not released');
  return `${first} → ${steady} ticks per 100 ms; coasts ${tail.length} ticks over ${(tail[tail.length - 1] - t0).toFixed(2)} s; motor −${(20 * Math.log10(motorAt(0) / motorAt(0.3))).toFixed(0)} dB at 0.3 s`;
});

await test('counter: spins up without a stutter (the second note follows the first closely)', () => {
  const firsts: number[] = [];
  const steadies: number[] = [];
  for (let r = 0; r < 6; r++) {
    fresh();
    frames(0.8, () => api.counter(0.8));
    const ts = shots('tick').map((s) => s.startT!).sort((a, b) => a - b);
    const gaps = ts.slice(1).map((t, k) => t - ts[k]);
    firsts.push(gaps[0]);
    steadies.push(median(gaps.slice(-10)));
  }
  const [first, steady] = [median(firsts), median(steadies)];
  // a real machine's rollers take a moment, but a 150 ms hole after the first note reads as "t… brrrt"
  assert(first < 2.5 * steady, `first gap ${(first * 1000).toFixed(0)} ms vs ${(steady * 1000).toFixed(0)} ms steady`);
  assert(first > 1.2 * steady, `no spin-up at all (first gap ${(first * 1000).toFixed(0)} ms)`);
  return `first gap ${(first * 1000).toFixed(0)} ms → ${(steady * 1000).toFixed(0)} ms steady`;
});

await test('counter: back from a hidden tab or a stall, an idle machine stays off (no ghost brrt)', async () => {
  const ghosts: string[] = [];
  for (const how of ['hidden tab', 'stall', 'stall, and the next frame beats the sweeper to it']) {
    fresh();
    frames(1, () => api.counter(1));
    if (how === 'hidden tab') {
      doc.visibilityState = 'hidden';
      visibility.forEach((fn) => fn());
    }
    ctx.advance(0.6); // no frames: rAF stopped, or the main thread was busy
    if (how !== 'stall, and the next frame beats the sweeper to it') await sleep(150); // the sweeper sees it
    doc.visibilityState = 'visible';
    visibility.forEach((fn) => fn());
    const back = ctx.currentTime;
    const c = counterGraph();
    let motor = 0;
    frames(1, (t) => {
      api.counter(0); // you stopped rubbing while away
      motor = Math.max(motor, c.level.targetAt(t + 1e-6));
    });
    const n = shots('tick', back).length;
    if (n || motor > 1e-4) ghosts.push(`${how}: ${n} ticks and the motor back up to ${motor.toFixed(4)} on return`);
  }
  assert(!ghosts.length, ghosts.join('; '));
});

await test('counter: ragged frames never put ticks in the past or bunch them', () => {
  fresh();
  let k = 0;
  frames(4, () => api.counter(0.4 + 0.6 * Math.random()), () => (++k % 50 === 0 ? 0.2 : 0.005 + Math.random() * 0.045));
  const ticks = shots('tick');
  assert(ticks.every((s) => s.startT! >= s.createdAt), 'a tick scheduled in the past');
  const ts = ticks.map((s) => s.startT!).sort((a, b) => a - b);
  const minGap = Math.min(...ts.slice(1).map((t, i) => t - ts[i]));
  assert(minGap > 0.6 / 35, `two ticks ${(minGap * 1000).toFixed(1)} ms apart`);
  return `${ticks.length} ticks, closest ${(minGap * 1000).toFixed(1)} ms apart`;
});

await test('crumple: dense while squeezing, sparse creaks when held, independent of call rate', () => {
  // pooled over several squeezes: a 0.45 s window of a Poisson process is too noisy alone
  const run = (callsPerFrame: number) => {
    let squeeze = 0, held = 0, total = 0;
    for (let r = 0; r < 6; r++) {
      fresh();
      let amt = 0;
      frames(3.5, () => {
        amt = Math.min(1, amt + FRAME * 2.2); // as the engine does
        for (let c = 0; c < callsPerFrame; c++) api.crumple(amt);
      });
      squeeze += shots('crackle', 0, 0.45).length / 0.45 / 6;
      held += shots('crackle', 2.5, 3.5).length / 6;
      total += shots('crackle').length;
    }
    return [squeeze, held, total];
  };
  const [squeeze, held, total] = run(1);
  const [, , total4] = run(4);
  assert(squeeze > 35, `only ${squeeze.toFixed(0)} crackles/s while squeezing`);
  assert(held > 3 && held < 0.5 * squeeze, `${held.toFixed(0)} crackles/s when held still`);
  // ~700 crackles a side: Poisson noise alone is ±5% (1σ) on the ratio; a call-rate leak would be ×4
  assert(Math.abs(total4 / total - 1) < 0.2, `4 calls a frame gave ${total4} crackles vs ${total}`);
  return `${squeeze.toFixed(0)}/s squeezing → ${held.toFixed(0)}/s held still; ${total} vs ${total4} at 4× the call rate`;
});

/** the opening crunch is the only crackle played at exactly crumpleGain */
const crunches = (from = -1, to = Infinity) => shots('crackle', from, to).filter((s) => gainOf(s) > 0.999 * PAPER_SOUND.crumpleGain);

await test('crumple: a flicker of a fist is a whisper; a real squeeze opens with a crunch', () => {
  const ramp = (k: number) => Math.min(1, k * FRAME * 2.2); // the engine's crumple amount after k frames of fist
  const flickers: string[] = [];
  for (let r = 0; r < 20; r++) {
    fresh();
    // one video frame at 30 fps = two engine frames of a false fist
    for (const k of [1, 2]) {
      api.crumple(ramp(k));
      ctx.advance(FRAME);
    }
    frames(0.3, () => {});
    if (crunches().length) flickers.push('the full-level opening crunch');
  }
  assert(!flickers.length, `${flickers.length}/20 two-frame flickers played ${flickers[0]}`);
  // a real squeeze: the crunch comes within a few frames
  fresh();
  let k = 0;
  frames(0.5, () => api.crumple(ramp(++k)));
  const open = crunches();
  assert(open.length === 1 && open[0].startT! < 0.07, `${open.length} crunches, first at ${open[0]?.startT}`);
  return `a real squeeze crunches at ${(open[0].startT! * 1000).toFixed(0)} ms; two-frame flickers never do`;
});

await test('crumple: a fist held through a tab switch or a stall carries on quietly (no ghost crunch)', async () => {
  const rows: string[] = [];
  for (const how of ['hidden tab', 'stall']) {
    fresh();
    let amt = 0;
    frames(2, () => api.crumple((amt = Math.min(1, amt + FRAME * 2.2)))); // squeezed, now held still
    const away = ctx.currentTime;
    const before = shots('crackle', away - 0.8, away).length / 0.8;
    if (how === 'hidden tab') {
      doc.visibilityState = 'hidden';
      visibility.forEach((fn) => fn());
    }
    ctx.advance(0.8);
    await sleep(120);
    doc.visibilityState = 'visible';
    visibility.forEach((fn) => fn());
    const back = ctx.currentTime;
    frames(1, () => api.crumple(1)); // still a fist, as the engine keeps it
    const after = shots('crackle', back);
    assert(crunches(back).length === 0, `${how}: a ghost crunch on coming back with the fist still closed`);
    assert(after.length < before + 8, `${how}: ${after.length} crackles in the second after coming back, vs ${before.toFixed(0)}/s just before (a burst)`);
    rows.push(`${how}: ${before.toFixed(0)}/s before → ${after.length}/s after`);
  }
  // and a new squeeze after a real let-go still opens with its crunch
  let amt = 1;
  frames(0.4, () => (amt = Math.max(0, amt - FRAME * 3))); // the engine relaxes it while the fist is open
  const again = ctx.currentTime;
  frames(0.3, () => api.crumple((amt = Math.min(1, amt + FRAME * 2.2))));
  assert(crunches(again).length === 1, `${crunches(again).length} crunches on squeezing again after letting go`);
  return rows.join('; ');
});

await test('crumple: two fists on two notes thin out when held, whichever calls first', () => {
  const out: string[] = [];
  for (const order of [[1, 0.6], [0.6, 1]]) {
    let squeeze = 0, held = 0;
    for (let r = 0; r < 6; r++) {
      fresh();
      let a = 0;
      frames(3.5, () => {
        a = Math.min(1, a + FRAME * 2.2);
        for (const k of order) api.crumple(a * k);
      });
      squeeze += shots('crackle', 0, 0.45).length / 0.45 / 6;
      held += shots('crackle', 2.5, 3.5).length / 6;
    }
    assert(held < 0.5 * squeeze, `order ${order}: ${held.toFixed(0)}/s held vs ${squeeze.toFixed(0)}/s squeezing (never thins)`);
    out.push(`${order}: ${squeeze.toFixed(0)} → ${held.toFixed(0)}/s`);
  }
  return out.join('; ');
});

await test('crumple: an audio clock too coarse to tell frames apart (120 Hz) changes nothing', () => {
  // 120 Hz frames, but currentTime only moves in 10.7 ms device buffers: some frames see no time pass
  const run = (coarse: boolean) => {
    let squeeze = 0, held = 0;
    for (let r = 0; r < 12; r++) {
      fresh();
      let a = 0, clock = 0, real = 0;
      while (real < 3.5) {
        a = Math.min(1, a + (1 / 120) * 2.2);
        api.crumple(a);
        real += 1 / 120;
        const next = coarse ? Math.floor(real / (512 / 48000)) * (512 / 48000) : real;
        ctx.advance(next - clock);
        clock = next;
      }
      squeeze += shots('crackle', 0, 0.45).length / 0.45 / 12;
      held += shots('crackle', 2.5, 3.5).length / 12;
    }
    return [squeeze, held];
  };
  const [s0, h0] = run(false);
  const [s1, h1] = run(true);
  // pooled over 12 runs: these bounds are > 3σ of the Poisson noise
  assert(Math.abs(s1 / s0 - 1) < 0.3 && Math.abs(h1 / h0 - 1) < 0.4, `fine clock ${s0.toFixed(0)} → ${h0.toFixed(0)}/s; coarse ${s1.toFixed(0)} → ${h1.toFixed(0)}/s`);
  return `fine clock ${s0.toFixed(0)} → ${h0.toFixed(0)}/s; coarse ${s1.toFixed(0)} → ${h1.toFixed(0)}/s`;
});

await test('crumple: density scales with amount, stops within the lookahead', () => {
  const count = (amt: number) => {
    let n = 0;
    for (let r = 0; r < 5; r++) {
      fresh();
      frames(1, () => api.crumple(amt));
      n += shots('crackle').length / 5;
    }
    return Math.round(n);
  };
  const [lo, hi] = [count(0.2), count(1)];
  assert(hi > 1.5 * lo && lo > 0, `amount 0.2 → ${lo}, amount 1 → ${hi}`);
  const stopped = ctx.currentTime;
  frames(1, () => {});
  const late = shots('crackle', stopped + 0.061);
  assert(late.length === 0, `${late.length} crackles after the calls stopped`);
  return `${lo} vs ${hi} crackles in the first second`;
});

await test('crumple: crackle energies follow a power law (many quiet, a few loud)', () => {
  fresh();
  frames(4, () => api.crumple(1));
  const gains = shots('crackle', 0.01).map(gainOf);
  const ratio = quantile(gains, 0.9) / median(gains);
  assert(gains.length > 50, `only ${gains.length} crackles`);
  assert(ratio > 2, `90th percentile only ${ratio.toFixed(1)}× the median`);
  assert(Math.max(...gains) <= PAPER_SOUND.crumpleGain + 1e-9, 'a crackle louder than crumpleGain');
  return `${gains.length} crackles, p90/median ${ratio.toFixed(1)}`;
});

await test('one-shots: each plays, and every node is released when it ends', () => {
  fresh();
  const calls: [string, () => void][] = [['grab', () => api.grab()], ['release', () => api.release()], ['catch', () => api.catchNote()], ['snap', () => api.snap()]];
  for (const [, f] of calls) {
    f();
    ctx.advance(0.2);
  }
  for (const [k] of calls) assert(shots(k).length === 1, `${k}: ${shots(k).length} voices`);
  ctx.advance(1);
  const all = ctx.oneShots();
  assert(all.every((s) => s.ended && s.disconnects > 0 && s.links.every((n) => !(n instanceof MNode) || n.disconnects > 0)), 'a one-shot left connected');
  return `${all.length} voices (incl. grab's crinkle), all released`;
});

await test('one-shots: spammed every frame they are rate-limited; a rain of catches gets quieter', () => {
  fresh();
  frames(1, () => {
    api.grab();
    api.release();
    api.catchNote();
    api.snap();
  });
  const n = (k: string) => shots(k).length;
  assert(n('grab') <= 25 && n('release') <= 17 && n('catch') <= 40 && n('snap') <= 13, `grab ${n('grab')}, release ${n('release')}, catch ${n('catch')}, snap ${n('snap')} per second`);
  const catches = shots('catch').map(gainOf);
  assert(catches[catches.length - 1] < 0.25 * PAPER_SOUND.catchGain, 'catches do not get quieter in a rain');
  return `per second: grab ${n('grab')}, release ${n('release')}, catch ${n('catch')}, snap ${n('snap')}; last catch at ${(catches[catches.length - 1] / PAPER_SOUND.catchGain).toFixed(2)}×`;
});

await test(`voice budget: never more than 48 one-shots in flight`, () => {
  fresh();
  frames(
    2,
    () => {
      api.crumple(1);
      api.counter(1);
      api.grab();
      api.catchNote();
      api.snap();
      api.release();
    },
    1 / 240,
  );
  const peak = Math.max(...ctx.oneShots().map((s) => s.activeAtStart + 1));
  assert(peak <= 48, `${peak} voices at once`);
  return `peak ${peak}`;
});

await test('garbage in (NaN, ±Infinity, negative, huge, pan out of range): no throw, nothing non-finite', () => {
  fresh();
  for (const v of [NaN, Infinity, -Infinity, -5, 1e9, 0.5]) {
    frames(0.1, () => {
      api.flutter(v);
      paperSound.flutter(3, v);
      api.counter(v);
      paperSound.counter(0.5, v);
      api.crumple(v);
      paperSound.crumple(0.5, v);
      paperSound.grab(v);
      paperSound.release(v);
      paperSound.catchNote(v);
      paperSound.snap(v);
    });
  }
  const pans = ctx.nodes.filter((n): n is MPanner => n instanceof MPanner);
  assert(pans.every((p) => Math.abs(p.pan.value) <= 1 && p.pan.events.every((e) => Math.abs(e.v) <= 1)), 'pan out of range');
  return `${pans.length} panners, all within ±1`;
});

await test('a sound needed before the warm-up got to it renders one variant in the frame, not all of them', () => {
  const rows: string[] = [];
  const firsts: [string, () => void, string][] = [
    ['snap', () => api.snap(), 'snap'],
    ['release', () => api.release(), 'release'],
    ['catchNote', () => api.catchNote(), 'catch'],
    ['grab', () => api.grab(), 'grab'],
    ['crumple', () => api.crumple(0.5), 'crackle'], // the opening crunch: a crackle or crunch variant
    ['counter', () => (api.counter(1), ctx.advance(FRAME), api.counter(1)), 'tick'],
    ['flutter', () => api.flutter(3), 'flap'],
  ];
  for (const [name, call, kind] of firsts) {
    fresh(); // just woken: no idle time yet, nothing rendered
    const before = ctx.buffers.length;
    const t0 = performance.now();
    call();
    const ms = performance.now() - t0;
    const made = ctx.buffers.slice(before).map(kindOf);
    const most = Math.max(...[...new Set(made)].map((k) => made.filter((m) => m === k).length));
    assert(most === 1, `the first ${name}() rendered ${made.join(', ')} in ${ms.toFixed(1)} ms, inside the frame`);
    assert(made.some((k) => k === kind || (kind === 'crackle' && k === 'crunch')), `the first ${name}() made no ${kind}: ${made.join(', ')}`);
    rows.push(`${name} ${ms.toFixed(1)} ms`);
  }
  return `first calls (mock, one variant each): ${rows.join(', ')}`;
});

await test('hostile tuning (typed into the console): never hangs, never throws into the frame loop', () => {
  // a throw from a sound call lands in the engine's frame, before render(): the picture would freeze
  const saved = structuredClone(PAPER_SOUND);
  const bad: Record<string, unknown>[] = [
    { crackleRate: -50 }, // the crackle loop used to walk backwards forever
    { tickJitter: 1.5 },
    { tickJitter: -3 },
    { level: NaN },
    { room: Infinity },
    { crumpleGain: Infinity },
    { flutterTo: 0.3 },
    { flutterGain: NaN },
    { width: NaN },
    { tickHz: [NaN, NaN] },
    { flapHz: [Infinity, 1] },
    { flapDepth: NaN, tumbleDepth: Infinity },
    { motorGain: Infinity, counterGain: 1e9 },
    { snapGain: -1, catchGain: 1e9, grabGain: NaN },
  ];
  for (const b of bad) {
    Object.assign(PAPER_SOUND, b);
    try {
      fresh();
      let amt = 0;
      const t0 = performance.now();
      frames(0.5, () => {
        api.flutter(4);
        api.counter(1);
        api.crumple((amt = Math.min(1, amt + FRAME * 2.2)));
        api.grab();
        api.release();
        api.catchNote();
        api.snap();
      });
      assert(performance.now() - t0 < 2000, `${JSON.stringify(b)}: 30 frames took ${(performance.now() - t0).toFixed(0)} ms`);
      const params = ctx.nodes.flatMap((n) => Object.values(n).filter((v): v is MParam => v instanceof MParam));
      assert(params.every((p) => Number.isFinite(p.value)), `${JSON.stringify(b)}: a non-finite AudioParam value (a browser throws)`);
    } catch (e) {
      throw new Error(`${JSON.stringify(b)}: ${(e as Error).message}`);
    } finally {
      Object.assign(PAPER_SOUND, structuredClone(saved));
    }
  }
  return `${bad.length} bad configurations, all survived`;
});

await test('rendered buffers: clean edges, normalised, envelopes loop seamlessly', async () => {
  fresh();
  api.flutter(0);
  await sleep(800); // the bank warms up a buffer at a time in the background
  // make every recipe
  api.grab();
  api.release();
  api.catchNote();
  api.snap();
  frames(0.5, () => {
    api.flutter(3);
    api.counter(1);
    api.crumple(1);
  });
  const mine = ctx.buffers.filter((b) => kindOf(b) !== 'other');
  const kinds = new Set(mine.map(kindOf));
  for (const k of ['tick', 'crackle', 'crunch', 'grab', 'release', 'catch', 'snap', 'noise', 'room', 'flap', 'tumble']) assert(kinds.has(k), `no ${k} buffer`);
  // every variant got made in the background: repeats don't sound alike
  const want: Record<string, number> = { crackle: 28, crunch: 12, tick: 12, grab: 6, release: 6, catch: 6, snap: 4, noise: 1, room: 1, flap: 1, tumble: 1 };
  for (const [k, n] of Object.entries(want)) assert(mine.filter((b) => kindOf(b) === k).length === n, `${mine.filter((b) => kindOf(b) === k).length} ${k} variants, expected ${n}`);
  for (const b of mine) {
    const k = kindOf(b);
    for (const x of b.data) {
      assert(x.every(Number.isFinite), `${k}: non-finite samples`);
      if (['tick', 'crackle', 'crunch', 'grab', 'release', 'catch', 'snap'].includes(k)) {
        const peak = Math.max(...x.map(Math.abs));
        assert(peak > 0.99 && peak <= 1 + 1e-6, `${k}: peak ${peak}`);
        assert(Math.abs(x[0]) < 0.05 && x[x.length - 1] === 0, `${k}: starts at ${x[0].toFixed(3)}, ends at ${x[x.length - 1]}`);
      }
      if (k === 'flap' || k === 'tumble') {
        assert(x.every((v) => v >= 0 && v <= 1), `${k}: outside 0..1`);
        assert(Math.abs(x[x.length - 1] - x[0]) < (k === 'flap' ? 0.05 : 0.01), `${k}: loop seam jumps ${Math.abs(x[x.length - 1] - x[0]).toFixed(3)}`);
      }
      if (k === 'room') {
        const e = x.reduce((a, v) => a + v * v, 0);
        assert(Math.abs(e - 1) < 1e-3, `room energy ${e}`);
      }
    }
  }
  const flap = mine.find((b) => kindOf(b) === 'flap')!.data[0];
  let onsets = 0;
  const w = Math.round(0.008 * 22050);
  for (let i = 0; i < flap.length; i++) {
    if (flap[i] < 0.2) continue;
    let top = flap[i] > flap[(i - 1 + flap.length) % flap.length]; // the first sample of a (clipped) plateau
    for (let j = -w; j <= w && top; j++) if (j && flap[(i + j + flap.length) % flap.length] > flap[i]) top = false;
    if (top) onsets++;
  }
  const rate = onsets / (flap.length / 22050);
  assert(rate > 8 && rate < 14, `flap envelope has ${rate.toFixed(1)} flaps/s at rate 1`);
  return `${mine.length} buffers, ${(mine.reduce((a, b) => a + b.length * b.numberOfChannels, 0) * 4) / 1e6} MB; flap envelope ${rate.toFixed(1)}/s`;
});

await test('a long session leaks nothing', () => {
  fresh();
  const persistent = new Set<MNode>(ctx.nodes); // master
  let amt = 0;
  frames(20, (t) => {
    const phase = Math.floor(t / 2) % 5;
    api.flutter(phase === 0 ? 6 * Math.random() : phase === 3 ? 2.5 : 0);
    api.counter(phase === 1 ? 0.5 + 0.5 * Math.random() : 0);
    if (phase === 2) api.crumple((amt = Math.min(1, amt + FRAME * 2.2)));
    else amt = 0;
    if (Math.random() < 0.03) api.grab();
    if (Math.random() < 0.03) api.release();
    if (Math.random() < 0.05) api.catchNote();
    if (Math.random() < 0.01) api.snap();
  });
  frames(3, () => {
    api.flutter(0);
    api.counter(0);
  });
  // what the module keeps for good: its bus, the room and its level
  for (const n of ctx.nodes) if (n instanceof MConvolver || (n instanceof MGain && n.out.has(ctx.nodes[1]))) persistent.add(n);
  for (const n of [...persistent]) for (const l of n.links) if (l instanceof MNode) persistent.add(l);
  const alive = ctx.nodes.filter((n) => !persistent.has(n) && n.kind !== 'destination' && n.disconnects === 0);
  assert(alive.length === 0, `${alive.length} nodes still connected: ${[...new Set(alive.map((n) => n.kind))].join(', ')}`);
  return `${ctx.nodes.length} nodes made in 23 s, ${persistent.size} kept (bus, room)`;
});

console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
(globalThis as unknown as { process: { exit(code: number): void } }).process.exit(failed ? 1 : 0);
