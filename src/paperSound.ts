import { sound } from './sound';

export interface PaperSoundsApi {
  /** paper flutter loop; call every frame with the fastest note's speed; 0 silences */
  flutter(speed: number): void;
  /** banknote counter "brrrrt" while printing; intensity 0..1, 0 stops */
  counter(intensity: number): void;
  grab(): void;
  release(): void;
  /** a note lands */
  catchNote(): void;
  /** crumpling crackle */
  crumple(amount: number): void;
  /** a sharp paper snap */
  snap(): void;
}

// Paper and money, synthesised — no files. Two loops are steered every frame
// (a note in the air; the counting machine while you print). The one-shots are
// rendered once, in JS, into a handful of variants each, then replayed at a
// random speed and level so no two sound alike. Quiet, like sound.ts: the
// room, not an app.
//
// Rhythms (counter ticks, crumple crackle) are scheduled on the audio clock a
// little ahead of time, so frame hitches don't smear them. Loops only ever
// glide (setTargetAtTime, never cancelled or scheduled ahead: the pattern every
// engine gets right). One the frame loop stops steering — tab hidden, engine
// paused — is hushed, and its nodes are released after a moment of silence.

/** Tuning. Mutable on purpose, so it can be live-tweaked from the console. Gains are linear, into sound.ts's master (0.55). */
export const PAPER_SOUND = {
  level: 1, // all paper sounds
  room: 0.1, // send into a small synthetic room; 0 = dry (the room is built when audio first wakes)
  width: 0.6, // a pan of ±1 (screen edge) pans this far

  flutterGain: 0.34,
  flutterFrom: 0.3, // world units/s: slower than this is a sheet at rest (centroid jitter)
  flutterTo: 7, // a hard flick: loudest and brightest from here on
  flapHz: [8, 25] as [number, number], // flaps per second, slow → fast
  flapDepth: 0.85, // how much the flaps gate the noise (read when the loop starts)
  tumbleDepth: 0.5, // slow swells as the sheet turns face-on and edge-on (read when the loop starts)

  counterGain: 0.075, // each note through the machine
  motorGain: 0.02,
  tickHz: [25, 35] as [number, number], // notes per second at intensity 0+ → 1
  tickJitter: 0.12, // ± share of each interval (capped at 0.9)

  crumpleGain: 0.2,
  crackleRate: 85, // crackle bursts per second while squeezing hard
  crackleExponent: 1.35, // P(E) ∝ E^-x: crumpling paper clicks with power-law energies
  crackleRange: 100, // loudest / quietest crackle energy

  // one-shots, set against sound.ts: grab ≈ rustle(), snap just above click(), release well under grab
  grabGain: 0.09,
  releaseGain: 0.02,
  catchGain: 0.07,
  snapGain: 0.28,
};

const LOOKAHEAD = 0.06; // s of ticks / crackles scheduled ahead: covers a late frame
const DEADMAN = 0.25; // a loop nobody steers for this long is hushed
const IDLE = 1.5; // s of silence before a loop's nodes are released
const MAX_VOICES = 48; // one-shots alive at once; crackle may only use all but 8
const SAME_FRAME = 0.004; // s: crumple calls closer than this on the audio clock are one frame (< a 120 Hz frame)
const CRUNCH_AT = 0.1; // crumple amount at which a squeeze crunches: three frames of the engine's fist, not a flicker
const ENV_SR = 22050; // control envelopes don't need more (and old Safari wants ≥ 22050)
const FLAP_HZ = 10; // flap envelope rate at playbackRate 1
const TUMBLE_HZ = 1.2; // tumble envelope rate at playbackRate 1

type Audio = { ctx: AudioContext; master: GainNode };
type OneShot = 'grab' | 'release' | 'catch' | 'snap';

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0); // NaN → 0
const lerp = (r: [number, number], k: number) => r[0] + (r[1] - r[0]) * k;
const times = <T>(n: number, f: () => T) => Array.from({ length: n }, f);

// ------------------------------------------------------------ rendering (offline, once per context)

type Kind = 'lowpass' | 'highpass' | 'bandpass';

function white(n: number) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.random() * 2 - 1;
  return x;
}

/** one RBJ biquad pass over x, in place (bandpass: 0 dB at the centre) */
function biquad(x: Float32Array, kind: Kind, f: number, q: number, sr: number) {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  const a0 = 1 + al;
  let b0 = al;
  let b1 = 0;
  let b2 = -al;
  if (kind === 'lowpass') {
    b1 = 1 - cs;
    b0 = b2 = b1 / 2;
  } else if (kind === 'highpass') {
    b1 = -(1 + cs);
    b0 = b2 = (1 + cs) / 2;
  }
  const a1 = (-2 * cs) / a0;
  const a2 = (1 - al) / a0;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
  return x;
}

function toRms(x: Float32Array, level: number) {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  const k = level / Math.sqrt(e / x.length || 1);
  for (let i = 0; i < x.length; i++) x[i] *= k;
  return x;
}

/** filtered noise at `amp` RMS, linear attack then exponential decay, mixed into out from `at` s */
function burst(out: Float32Array, sr: number, at: number, kind: Kind, f: number, q: number, attack: number, tau: number, amp: number) {
  const s = Math.round(at * sr);
  const n = Math.min(out.length - s, Math.ceil((attack + 7 * tau) * sr));
  if (n <= 0) return;
  const x = toRms(biquad(white(n), kind, f, q, sr), amp);
  const na = Math.max(1, attack * sr);
  const k = Math.exp(-1 / (tau * sr));
  let e = Math.exp(-(Math.ceil(na) - na) / (tau * sr));
  for (let i = 0; i < n; i++) {
    if (i < na) out[s + i] += (x[i] * i) / na;
    else {
      out[s + i] += x[i] * e;
      e *= k;
    }
  }
}

/** a damped sine whose pitch sags: something soft being struck */
function thump(out: Float32Array, sr: number, at: number, f: number, tau: number, amp: number) {
  const s = Math.round(at * sr);
  const n = Math.min(out.length - s, Math.ceil(7 * tau * sr));
  const kSag = Math.exp(-1 / (0.02 * sr));
  const kDecay = Math.exp(-1 / (tau * sr));
  let ph = 0, sag = 1, e = amp;
  for (let i = 0; i < n; i++) {
    ph += (2 * Math.PI * f * (0.8 + 0.2 * sag)) / sr;
    out[s + i] += Math.sin(ph) * Math.min(1, i / (0.001 * sr)) * e;
    sag *= kSag;
    e *= kDecay;
  }
}

/** peak 1, and a 2 ms fade at the end so no variant stops on a step */
function finish(x: Float32Array, sr: number) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  const k = p > 0 ? 1 / p : 0;
  const fade = Math.max(1, Math.round(0.002 * sr));
  for (let i = 0; i < x.length; i++) x[i] *= k * Math.min(1, (x.length - 1 - i) / fade);
  return x;
}

/** an energy in [1, range] with P(E) ∝ E^-x: crumpling paper crackles with power-law energies (Houle & Sethna 1996) */
function powerLaw(x: number, range: number, u = Math.random()) {
  if (Math.abs(x - 1) < 1e-6) return Math.pow(range, u);
  const k = 1 - x;
  return Math.pow(1 + u * (Math.pow(range, k) - 1), 1 / k);
}

/** one fracture in the paper: a tick with a short ring, or (crunchy) a duller give */
function click(out: Float32Array, sr: number, at: number, amp: number, crunchy: boolean) {
  if (crunchy) {
    burst(out, sr, at, 'bandpass', rnd(500, 1800), rnd(0.8, 1.5), 0.0008, rnd(0.004, 0.012), amp);
  } else {
    burst(out, sr, at, 'highpass', rnd(1500, 3000), 0.7, 0.0001, rnd(0.0003, 0.001), amp);
    burst(out, sr, at, 'bandpass', rnd(2500, 9000), rnd(2, 7), 0.0002, rnd(0.001, 0.004), amp * 0.5);
  }
}

/** an avalanche: one fracture sets off a few more within milliseconds */
function crackle(sr: number, crunchy: boolean) {
  const out = new Float32Array(Math.round(sr * (crunchy ? 0.08 : 0.04)));
  let t = 0;
  do {
    click(out, sr, t, Math.sqrt(powerLaw(1.35, 30) / 30), crunchy);
    t += 0.0006 + 0.005 * Math.random() ** 2;
  } while (Math.random() < 0.55 && t < out.length / sr / 2);
  return finish(out, sr);
}

/** a note flicking past the counting machine's rollers */
function tick(sr: number) {
  const out = new Float32Array(Math.round(sr * 0.035));
  burst(out, sr, 0, 'highpass', rnd(2000, 3500), 0.7, 0.0002, rnd(0.0006, 0.0014), 1);
  burst(out, sr, 0, 'bandpass', rnd(2600, 5200), rnd(3, 6), 0.0004, rnd(0.003, 0.008), 0.6);
  burst(out, sr, 0.0005, 'bandpass', rnd(900, 1600), 1, 0.0006, rnd(0.004, 0.007), 0.45);
  thump(out, sr, 0.001, rnd(150, 230), 0.007, 0.9);
  return finish(out, sr);
}

/** fingertips closing on paper: a contact, a few crinkles, a short rustle */
function grabSound(sr: number) {
  const out = new Float32Array(Math.round(sr * 0.16));
  burst(out, sr, 0, 'bandpass', rnd(280, 420), 1.2, 0.001, 0.006, 0.6);
  let t = rnd(0, 0.006);
  for (let k = 2 + Math.floor(Math.random() * 3); k > 0; k--) {
    click(out, sr, t, 0.35 + 0.65 * Math.sqrt(powerLaw(1.35, 20) / 20), false);
    t += rnd(0.004, 0.022);
  }
  burst(out, sr, 0.004, 'bandpass', rnd(2500, 4200), 0.8, 0.004, rnd(0.018, 0.03), 0.3);
  return finish(out, sr);
}

/** paper leaving the fingers: a breath of air that falls away */
function releaseSound(sr: number) {
  const n = Math.round(sr * 0.34);
  const x = white(n);
  const f0 = rnd(2400, 3200);
  const f1 = rnd(700, 1000);
  // a bandpass swept downward, coefficients updated every 32 samples
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let b0 = 0, a1 = 0, a2 = 0;
  for (let i = 0; i < n; i++) {
    if (i % 32 === 0) {
      const w = (2 * Math.PI * f0 * Math.pow(f1 / f0, i / n)) / sr;
      const al = Math.sin(w) / (2 * 0.7);
      b0 = al / (1 + al);
      a1 = (-2 * Math.cos(w)) / (1 + al);
      a2 = (1 - al) / (1 + al);
    }
    const y = b0 * (x[i] - x2) - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
  const na = 0.03 * sr;
  for (let i = 0; i < n; i++) {
    const e = i < na ? Math.sin((0.5 * Math.PI * i) / na) ** 2 : (1 - (i - na) / (n - na)) ** 2;
    x[i] *= e;
  }
  toRms(x, 1);
  click(x, sr, 0.002, 0.2, false);
  return finish(x, sr);
}

/** a note landing in a palm: a muffled slap, then a second touch as the far edge settles */
function catchSound(sr: number) {
  const out = new Float32Array(Math.round(sr * 0.2));
  burst(out, sr, 0, 'lowpass', rnd(900, 1400), 0.7, 0.0015, rnd(0.018, 0.028), 1);
  burst(out, sr, rnd(0.025, 0.05), 'lowpass', 1200, 0.7, 0.002, 0.012, 0.35);
  biquad(out, 'lowpass', 1800, 0.6, sr); // again: muffled, not hissy
  // the palm: kept above ~150 Hz, where laptop speakers still play
  thump(out, sr, 0, rnd(150, 210), 0.025, 0.9);
  burst(out, sr, 0.002, 'highpass', 3000, 0.7, 0.0005, 0.006, 0.1);
  return finish(out, sr);
}

/** a taut note slipping its grip: crack, ring, the sheet whipping, then its freed edge buzzing out */
function snapSound(sr: number) {
  const out = new Float32Array(Math.round(sr * 0.42));
  burst(out, sr, 0, 'highpass', 2500, 0.7, 0.0002, 0.0015, 2.4);
  burst(out, sr, 0, 'bandpass', rnd(3200, 4600), 5, 0.0004, 0.012, 0.7);
  burst(out, sr, 0.001, 'bandpass', rnd(300, 450), 1.4, 0.002, 0.035, 0.5);
  const s = Math.round(0.008 * sr);
  const x = toRms(biquad(white(out.length - s), 'bandpass', rnd(1500, 2200), 1.2, sr), 1);
  const f = rnd(24, 32);
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * f * (0.7 + 0.3 * Math.exp(-t / 0.08))) / sr;
    out[s + i] += 0.28 * x[i] * (0.5 + 0.5 * Math.cos(ph)) ** 2 * Math.min(1, t / 0.004) * Math.exp(-t / 0.09);
  }
  return finish(out, sr);
}

/** fast irregular flaps as a looping 0..1 control signal (FLAP_HZ at playbackRate 1) */
function flapEnvelope(seconds: number) {
  const n = Math.round(ENV_SR * seconds);
  const env = new Float32Array(n);
  // irregular gaps, scaled so the loop closes on a flap
  const gaps: number[] = [];
  let sum = 0;
  while (sum < seconds * FLAP_HZ) sum += gaps[gaps.push(rnd(0.55, 1.45)) - 1];
  const flap = (t: number, amp: number) => {
    const s = Math.round(t * ENV_SR);
    const a = rnd(0.0015, 0.0045) * ENV_SR;
    const tau = rnd(0.008, 0.03) * ENV_SR;
    const k = Math.exp(-1 / tau);
    let e = amp * Math.exp(-(Math.ceil(a) - a) / tau);
    for (let i = 0, len = Math.ceil(a + 7 * tau); i < len; i++) {
      if (i < a) env[(s + i) % n] += (amp * i) / a;
      else {
        env[(s + i) % n] += e;
        e *= k;
      }
    }
  };
  let t = 0;
  for (const g of gaps) {
    const amp = 0.3 + 0.7 * Math.random() ** 0.6;
    flap(t, amp);
    if (Math.random() < 0.15) flap(t + rnd(0.012, 0.03), amp * 0.6); // the edge slaps twice
    t += (g * seconds) / sum;
  }
  for (let i = 0; i < n; i++) env[i] = Math.min(1, env[i]);
  return env;
}

/** slow random swells, 0..1, looping (TUMBLE_HZ at playbackRate 1) */
function tumbleEnvelope(seconds: number) {
  const n = Math.round(ENV_SR * seconds);
  const env = new Float32Array(n);
  const keys: number[] = [];
  let sum = 0;
  while (sum < seconds * TUMBLE_HZ) sum += keys[keys.push(rnd(0.5, 1.5)) - 1];
  const vals = keys.map(() => Math.random() ** 0.7);
  let s0 = 0;
  keys.forEach((g, k) => {
    const s1 = k === keys.length - 1 ? n : Math.round(s0 + (g * n) / sum);
    const v0 = vals[k];
    const v1 = vals[(k + 1) % vals.length]; // wraps: the loop is seamless
    for (let i = s0; i < s1; i++) env[i] = v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos((Math.PI * (i - s0)) / (s1 - s0)));
    s0 = s1;
  });
  return env;
}

/** a small furnished room: a few early reflections, then a tail that darkens as it dies (RT60 ≈ 0.4 s) */
function roomImpulse(sr: number) {
  const n = Math.round(sr * 0.6);
  const pre = Math.round(0.004 * sr);
  return times(2, () => {
    const x = new Float32Array(n);
    const kDark = Math.exp(-1 / (0.15 * sr));
    const kDecay = Math.exp(-1 / (0.06 * sr));
    let lp = 0, bright = 0.55, e = 1;
    for (let i = pre; i < n; i++) {
      lp += (0.08 + bright) * (Math.random() * 2 - 1 - lp);
      x[i] = lp * e;
      bright *= kDark;
      e *= kDecay;
    }
    for (let k = 0; k < 6; k++) x[pre + Math.round(rnd(0.002, 0.022) * sr)] += rnd(-0.5, 0.5);
    return toRms(x, 1 / Math.sqrt(n)); // unit energy: wet RMS ≈ dry RMS × room
  });
}

function buffer(ctx: BaseAudioContext, chans: Float32Array[], sr = ctx.sampleRate) {
  const b = ctx.createBuffer(chans.length, chans[0].length, sr);
  chans.forEach((c, i) => b.getChannelData(i).set(c));
  return b;
}

type Recipe = 'noise' | 'flap' | 'tumble' | 'room' | 'crackle' | 'crunch' | 'tick' | 'grab' | 'release' | 'catch' | 'snap';

/** how many variants of each, and how to make one */
const RECIPES: Record<Recipe, [number, (c: BaseAudioContext) => AudioBuffer]> = {
  // stereo, partly correlated: the air has some width
  noise: [
    1,
    (c) => {
      const a = white(Math.round(c.sampleRate * 2.3));
      const b = white(a.length);
      for (let i = 0; i < a.length; i++) b[i] = 0.55 * a[i] + 0.835 * b[i];
      return buffer(c, [a, b]);
    },
  ],
  // the two envelopes have unrelated lengths, so together they never audibly repeat
  flap: [1, (c) => buffer(c, [flapEnvelope(4.7)], ENV_SR)],
  tumble: [1, (c) => buffer(c, [tumbleEnvelope(5.3)], ENV_SR)],
  room: [1, (c) => buffer(c, roomImpulse(c.sampleRate))],
  crackle: [28, (c) => buffer(c, [crackle(c.sampleRate, false)])],
  crunch: [12, (c) => buffer(c, [crackle(c.sampleRate, true)])],
  tick: [12, (c) => buffer(c, [tick(c.sampleRate)])],
  grab: [6, (c) => buffer(c, [grabSound(c.sampleRate)])],
  release: [6, (c) => buffer(c, [releaseSound(c.sampleRate)])],
  catch: [6, (c) => buffer(c, [catchSound(c.sampleRate)])],
  snap: [4, (c) => buffer(c, [snapSound(c.sampleRate)])],
};

const RECIPE_NAMES = Object.keys(RECIPES) as Recipe[];

/**
 * Rendered buffers, a variant at a time while the page is idle (one of each first, then the rest).
 * A sound needed before then gets one variant made on the spot: all of a snap's would cost a frame.
 */
class Bank {
  private made = new Map<Recipe, AudioBuffer[]>(RECIPE_NAMES.map((r) => [r, []]));
  constructor(private ctx: BaseAudioContext) {}
  /** the variants made so far (at least one) */
  get(r: Recipe) {
    const b = this.made.get(r)!;
    if (!b.length) b.push(RECIPES[r][1](this.ctx));
    return b;
  }
  /** render one more buffer (a few ms at most); false once all are made */
  warm() {
    for (let pass = 0; pass < 2; pass++) {
      for (const r of RECIPE_NAMES) {
        const b = this.made.get(r)!;
        if (b.length < (pass ? RECIPES[r][0] : 1)) {
          b.push(RECIPES[r][1](this.ctx));
          return true;
        }
      }
    }
    return false;
  }
}

// ------------------------------------------------------------ live graph

/**
 * Steers an AudioParam with setTargetAtTime, so it glides and never clicks. Each glide
 * starts from wherever the last one had got to; past events are dropped by the browser.
 * Writes only when the target really moves, so 60 calls a second stay cheap. Ignores
 * non-finite targets (a bad value typed into PAPER_SOUND), which an AudioParam would throw
 * on — inside the engine's frame, where it would stop the render.
 */
class Knob {
  constructor(
    private p: AudioParam,
    public v = NaN,
  ) {}
  to(v: number, t: number, tau: number, eps = 0) {
    // close enough is fine, except for silence: 0 is always written exactly
    if (v === this.v || (v !== 0 && Math.abs(v - this.v) <= eps) || !Number.isFinite(v)) return;
    this.p.setTargetAtTime(v, t, tau);
    this.v = v;
  }
}

interface Loop {
  level: Knob;
  /** every gain that makes it audible: hushing sets them all to 0 */
  faders: Knob[];
  pan: Knob | null;
  srcs: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  /** audio time of the last call that reached it, and of the last that asked for sound */
  call: number;
  loud: number;
}

interface Flutter extends Loop {
  body: Knob;
  crisp: Knob;
  air: Knob;
  airTone: Knob;
  flap: Knob;
  tumble: Knob;
}

interface Counter extends Loop {
  out: GainNode;
  motor: Knob;
  whine: Knob;
  tone: Knob;
  rumble: Knob;
  /** 0..1 how fast the rollers turn */
  spin: number;
  /** smoothed intensity, held while the rollers coast down */
  drive: number;
  /** audio time of the last note scheduled through the machine */
  last: number;
  /** the next gap, as a share of one period at the current speed (1 ± jitter) */
  gap: number;
}

function filt(ctx: BaseAudioContext, type: BiquadFilterType, f: number, q: number) {
  const n = ctx.createBiquadFilter();
  n.type = type;
  n.frequency.value = f;
  n.Q.value = q;
  return n;
}

function gain(ctx: BaseAudioContext, v: number) {
  const g = ctx.createGain();
  g.gain.value = Number.isFinite(v) ? v : 0;
  return g;
}

function looped(ctx: BaseAudioContext, buf: AudioBuffer) {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  return s;
}

class PaperSounds implements PaperSoundsApi {
  private ctx: AudioContext | null = null;
  private bank: Bank | null = null;
  private bus: GainNode | null = null;
  private busLevel: Knob | null = null;
  private wetLevel: Knob | null = null;
  private fl: Flutter | null = null;
  private ct: Counter | null = null;
  private sweeper: ReturnType<typeof setTimeout> | null = null;
  /** end times of the one-shots in flight (the voice budget) */
  private ends: number[] = [];
  private last: Record<OneShot, number> = { grab: -1e9, release: -1e9, catch: -1e9, snap: -1e9 };
  private streak = 0;
  // crumple: time and amount of this frame's first call, how freshly it's being squeezed,
  // crackle scheduled until, its crunch still to come
  private crT = -1e9;
  private crAmt = 0;
  private crFresh = 0;
  private crUntil = 0;
  private crOpen = false;

  constructor() {
    // a hidden tab stops the frame loop at once: don't leave a note fluttering or the machine running
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') return;
        this.hush(this.fl);
        this.hush(this.ct);
      });
    }
  }

  /**
   * Paper rushing through the air. Every frame, with the fastest free sheet's speed
   * (world units/s); 0 silences. Optional pan −1..1 (screen left → right).
   */
  flutter(speed: number, pan = 0) {
    const a = this.live();
    if (!a) return;
    const P = PAPER_SOUND;
    const t = a.ctx.currentTime;
    const L = clamp01(((Number.isFinite(speed) ? speed : 0) - P.flutterFrom) / (P.flutterTo - P.flutterFrom)) ** 0.7;
    let f = this.fl;
    if (!f) {
      if (L < 0.01) return;
      f = this.fl = this.makeFlutter(a);
      this.sweep();
    }
    f.call = t;
    const g = P.flutterGain * L;
    // a flick is heard at once; the hiss hangs on a little after (NaN: the first write)
    f.level.to(g, t, !(g <= f.level.v) ? 0.03 : 0.12, 0.0005);
    if (L > 0) {
      f.loud = t;
      // faster: louder, brighter, flapping faster, more rushing air
      const fc = 700 * 2 ** (2.3 * L);
      f.body.to(fc, t, 0.08, fc * 0.02);
      f.crisp.to(0.35 * L ** 1.5, t, 0.08, 0.004);
      f.air.to(0.25 * L * L, t, 0.1, 0.004);
      f.airTone.to(350 + 900 * L, t, 0.1, 20);
      f.flap.to(lerp(P.flapHz, L) / FLAP_HZ, t, 0.1, 0.02);
      f.tumble.to((0.6 + 2 * L) / TUMBLE_HZ, t, 0.2, 0.03);
      f.pan?.to(this.pan(pan), t, 0.1, 0.02);
    } else if (t - f.loud > IDLE) this.fl = this.drop(f);
  }

  /**
   * The banknote counting machine, while money is printed. Every frame, intensity 0..1;
   * 0 lets the rollers coast to a stop in a fraction of a second. Optional pan.
   */
  counter(intensity: number, pan = 0) {
    const a = this.live();
    if (!a) return;
    const P = PAPER_SOUND;
    const t = a.ctx.currentTime;
    const i = clamp01(intensity);
    const on = i > 0.01;
    let c = this.ct;
    if (!c) {
      if (!on) return;
      c = this.ct = this.makeCounter(a, i);
      this.sweep();
    }
    // nobody steered it for a while (the frame loop stalled; this frame may have beaten the
    // sweeper to it): it stopped, as hushed, whichever got here first — and starts from rest
    const stalled = t - c.call > DEADMAN;
    if (stalled) this.hush(c);
    const dt = stalled ? 0 : Math.min(0.1, Math.max(0, t - c.call));
    c.call = t;
    // the rollers spin up fast and coast down slower: brrrrrrt-t-t
    c.spin += ((on ? 1 : 0) - c.spin) * (1 - Math.exp(-dt / (on ? 0.07 : 0.12)));
    if (!on && c.spin < 0.03) c.spin = 0; // the whir (∝ spin²) is down 60 dB by here
    if (on) c.drive += (i - c.drive) * (1 - Math.exp(-dt / 0.15));
    const hz = lerp(P.tickHz, c.drive);
    // the motor's sound falls away faster than the rollers slow (∝ spin²): it whirs down, doesn't hang on
    const whir = c.spin * c.spin;
    c.level.to(P.motorGain * whir * (0.6 + 0.4 * c.drive), t, 0.04, 0.0002);
    c.rumble.to(P.motorGain * 0.8 * whir * c.drive, t, 0.05, 0.0002);
    if (c.spin === 0) {
      if (t - c.loud > IDLE) this.ct = this.drop(c);
      return;
    }
    c.loud = t;
    // the motor buzzes at a multiple of the feed rate, so it locks with the ticks
    const motor = 4 * hz * (0.3 + 0.7 * c.spin);
    c.motor.to(motor, t, 0.04, motor * 0.01);
    c.whine.to(motor * 7.3, t, 0.04, motor * 0.07);
    c.tone.to(motor * 3, t, 0.05, motor * 0.03);
    c.pan?.to(this.pan(pan), t, 0.1, 0.02);
    // the notes, on the audio clock a little ahead. The next one is due a gap after the last at
    // the speed the rollers turn *now*, so spinning up and coasting down track at once (fixing
    // it a note ahead left a 150 ms hole after the first); after a long frame it carries on from
    // now rather than bunching up the backlog.
    const rate = hz * c.spin;
    if (!(rate >= 5)) return;
    const ticks = this.bank!.get('tick');
    const jitter = Math.min(0.9, Math.max(0, P.tickJitter)); // ≥ 1 could make a gap ≤ 0
    for (let at = Math.max(c.last + c.gap / rate, t + 0.003); at < t + LOOKAHEAD; at = c.last + c.gap / rate) {
      const level = P.counterGain * (0.55 + 0.45 * c.drive) * Math.sqrt(c.spin) * rnd(0.8, 1);
      this.play(a, pick(ticks), at, level, rnd(0.93, 1.07) * (0.96 + 0.08 * c.drive), 0, c.out);
      c.last = at;
      c.gap = 1 + jitter * (Math.random() * 2 - 1);
    }
  }

  /** fingers closing on a note: a small crinkle */
  grab(pan = 0) {
    const a = this.once('grab', 0.04);
    if (!a) return;
    const t = a.ctx.currentTime;
    this.play(a, pick(this.bank!.get('grab')), t, PAPER_SOUND.grabGain * rnd(0.8, 1), rnd(0.9, 1.12), pan);
    this.crackle(a, t + rnd(0.01, 0.04), 0.4, pan, false);
  }

  /** letting go: softer, airy */
  release(pan = 0) {
    const a = this.once('release', 0.06);
    if (!a) return;
    this.play(a, pick(this.bank!.get('release')), a.ctx.currentTime, PAPER_SOUND.releaseGain * rnd(0.8, 1), rnd(0.9, 1.1), pan);
  }

  /** a note lands in the palm: a muted "thp". Quieter when they land in quick succession (a rain of notes). */
  catchNote(pan = 0) {
    const a = this.once('catch', 0.025);
    if (!a) return;
    this.play(a, pick(this.bank!.get('catch')), a.ctx.currentTime, PAPER_SOUND.catchGain * 0.75 ** this.streak * rnd(0.8, 1.05), rnd(0.9, 1.1), pan);
  }

  /** a taut note slipping out of a grip */
  snap(pan = 0) {
    const a = this.once('snap', 0.08);
    if (!a) return;
    this.play(a, pick(this.bank!.get('snap')), a.ctx.currentTime, PAPER_SOUND.snapGain * rnd(0.85, 1), rnd(0.94, 1.06), pan);
  }

  /**
   * Crackle while a fist squeezes, amount 0..1 (how crumpled). Safe to call every frame,
   * or several times a frame: the crackle is a Poisson process on the audio clock, so its
   * density depends only on the amount and how freshly it's rising — not on the call rate.
   * Held still, a crumpled ball only creaks now and then.
   *
   * Calls closer together than SAME_FRAME are one frame (a second fist, or a frame the audio
   * clock hadn't moved for): how fast it's rising is read from each frame's first call only,
   * so two fists on two notes don't read as one squeeze leaping up and down every frame.
   * A new squeeze opens with a crunch once it reaches CRUNCH_AT, so a fist flickering on for
   * a frame or two doesn't crunch. After a pause in the calls (tab hidden, frame loop stalled)
   * an amount that hasn't dropped is the same fist still closed: it carries on, quietly,
   * instead of crunching again. (So `amount` should be how crumpled the sheet is, as the
   * engine passes it, rather than a constant "squeezing" flag.)
   */
  crumple(amount: number, pan = 0) {
    const a = this.live();
    if (!a) return;
    const P = PAPER_SOUND;
    const t = a.ctx.currentTime;
    const amt = clamp01(amount);
    const gap = t - this.crT;
    if (gap >= SAME_FRAME) {
      // a frame's first call: frame to frame, that's the same fist
      if (gap > 0.25 && !(this.crAmt > 0.01 && amt >= this.crAmt)) {
        // a new squeeze
        this.crFresh = 1;
        this.crUntil = t;
        this.crOpen = true;
      } else {
        const rising = Math.max(0, amt - this.crAmt) / gap;
        this.crFresh = Math.max(this.crFresh * Math.exp(-gap / 0.9), Math.min(1, rising / 2));
      }
      this.crT = t;
      this.crAmt = amt;
    }
    if (this.crOpen && amt >= CRUNCH_AT) {
      // the sheet first gives way
      this.crOpen = false;
      this.crackle(a, t, 1, pan, true);
    }
    if (amt <= 0.01) return;
    const activity = amt ** 0.6 * (0.06 + 0.94 * this.crFresh);
    const rate = Math.max(2, 2 + P.crackleRate * activity); // a negative rate would never reach `end`
    const end = t + LOOKAHEAD;
    let at = Math.max(this.crUntil, t);
    while ((at += -Math.log(1 - Math.random()) / rate) < end) this.crackle(a, at, activity, pan, false);
    this.crUntil = Math.max(this.crUntil, end);
  }

  // ------------------------------------------------------------ internals

  /** the shared graph, or null while sounds should be silent: not woken yet, muted, or suspended */
  private live(): Audio | null {
    const a = sound.audio;
    if (!a || !sound.enabled || a.ctx.state !== 'running') return null;
    if (a.ctx !== this.ctx) this.boot(a);
    const t = a.ctx.currentTime;
    this.busLevel!.to(PAPER_SOUND.level, t, 0.05);
    this.wetLevel?.to(PAPER_SOUND.room, t, 0.05);
    this.sweep();
    return a;
  }

  /** live(), and not again within `gap` seconds */
  private once(name: OneShot, gap: number) {
    const a = this.live();
    if (!a) return null;
    const t = a.ctx.currentTime;
    if (t - this.last[name] < gap) return null;
    if (name === 'catch') this.streak = t - this.last.catch < 0.15 ? Math.min(this.streak + 1, 6) : 0;
    this.last[name] = t;
    return a;
  }

  private boot({ ctx, master }: Audio) {
    this.fl = this.drop(this.fl);
    this.ct = this.drop(this.ct);
    this.bus?.disconnect();
    this.ctx = ctx;
    this.bank = new Bank(ctx);
    // times below are on the old context's clock
    this.ends = [];
    this.last = { grab: -1e9, release: -1e9, catch: -1e9, snap: -1e9 };
    this.streak = 0;
    this.crT = -1e9;
    this.crAmt = 0;
    this.crUntil = 0;
    this.bus = gain(ctx, PAPER_SOUND.level); // at full level at once: the first sound must not fade in
    this.busLevel = new Knob(this.bus.gain, this.bus.gain.value);
    this.bus.connect(master);
    this.wetLevel = null;
    let room: ConvolverNode | null = null;
    if (PAPER_SOUND.room > 0) {
      room = ctx.createConvolver(); // silent until its impulse is rendered, just below
      room.normalize = false;
      const wet = gain(ctx, PAPER_SOUND.room);
      this.wetLevel = new Knob(wet.gain, wet.gain.value);
      this.bus.connect(room).connect(wet).connect(master);
    }
    // render everything a buffer at a time while the page is idle, so no frame pays for it
    const bank = this.bank;
    const later = (f: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(f, { timeout: 100 }) : setTimeout(f, 4));
    const warm = () => {
      if (bank !== this.bank) return;
      if (room && !room.buffer) room.buffer = bank.get('room')[0];
      else if (!bank.warm()) return;
      later(warm);
    };
    later(warm);
  }

  private pan(p: number) {
    const v = p * PAPER_SOUND.width;
    return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  }

  /** node → (panner) → bus */
  private output(ctx: AudioContext, node: AudioNode): { pan: Knob | null; nodes: AudioNode[] } {
    if (typeof ctx.createStereoPanner !== 'function') {
      node.connect(this.bus!);
      return { pan: null, nodes: [] };
    }
    const p = ctx.createStereoPanner();
    node.connect(p).connect(this.bus!);
    return { pan: new Knob(p.pan), nodes: [p] };
  }

  /** one buffer, once; its nodes are released when it ends. False when over the voice budget. */
  private play(a: Audio, buf: AudioBuffer, at: number, level: number, rate: number, pan = 0, dest: AudioNode = this.bus!, reserve = 0) {
    const { ctx } = a;
    const t = ctx.currentTime;
    if (this.ends.length >= MAX_VOICES - reserve) this.ends = this.ends.filter((e) => e > t);
    if (this.ends.length >= MAX_VOICES - reserve || !(level > 1e-5 && level < 10)) return false; // NaN, silence, or a bad tuning value
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = gain(ctx, level);
    src.connect(g);
    const p = pan && typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    if (p) {
      p.pan.value = this.pan(pan);
      g.connect(p).connect(dest);
    } else g.connect(dest);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      p?.disconnect();
    };
    const when = Math.max(at, t);
    src.start(when);
    this.ends.push(when + buf.duration / rate);
    return true;
  }

  /** one crackle burst; big ones are where the sheet gives way, so they're duller and longer */
  private crackle(a: Audio, at: number, scale: number, pan: number, big: boolean) {
    const P = PAPER_SOUND;
    const k = Math.sqrt((big ? P.crackleRange : powerLaw(P.crackleExponent, P.crackleRange)) / P.crackleRange);
    const buf = pick(this.bank!.get(k > 0.5 && Math.random() < 0.6 ? 'crunch' : 'crackle'));
    // a crumpled ball has size: each crackle comes from a slightly different place
    this.play(a, buf, at, P.crumpleGain * k * (0.4 + 0.6 * scale), rnd(0.85, 1.2), pan + rnd(-0.25, 0.25), this.bus!, 8);
  }

  private makeFlutter(a: Audio): Flutter {
    const { ctx } = a;
    const b = this.bank!;
    const P = PAPER_SOUND;
    const t = ctx.currentTime;
    const noise = looped(ctx, b.get('noise')[0]);
    const body = filt(ctx, 'bandpass', 900, 0.9);
    const crisp = filt(ctx, 'bandpass', 5500, 0.8);
    const crispAmt = gain(ctx, 0);
    const air = filt(ctx, 'bandpass', 500, 0.7); // a whoosh, not a rumble laptop speakers can't play
    const airAmt = gain(ctx, 0);
    // fast irregular flaps inside slow tumbling swells, as audio-rate gain modulation
    const flapEnv = looped(ctx, b.get('flap')[0]);
    const flapAmt = gain(ctx, P.flapDepth);
    const flapVca = gain(ctx, 1 - P.flapDepth);
    const tumbleEnv = looped(ctx, b.get('tumble')[0]);
    const tumbleAmt = gain(ctx, P.tumbleDepth);
    const tumbleVca = gain(ctx, 1 - P.tumbleDepth);
    const out = gain(ctx, 0);
    noise.connect(body).connect(flapVca);
    noise.connect(crisp).connect(crispAmt).connect(flapVca);
    flapVca.connect(tumbleVca).connect(out);
    noise.connect(air).connect(airAmt).connect(out); // the rush of air isn't flapped
    flapEnv.connect(flapAmt).connect(flapVca.gain);
    tumbleEnv.connect(tumbleAmt).connect(tumbleVca.gain);
    const srcs = [noise, flapEnv, tumbleEnv];
    for (const s of srcs) s.start(t, Math.random() * s.buffer!.duration);
    const { pan, nodes } = this.output(ctx, out);
    const level = new Knob(out.gain);
    return {
      level,
      faders: [level],
      pan,
      srcs,
      nodes: [...srcs, body, crisp, crispAmt, air, airAmt, flapAmt, flapVca, tumbleAmt, tumbleVca, out, ...nodes],
      call: t,
      loud: t,
      body: new Knob(body.frequency),
      crisp: new Knob(crispAmt.gain),
      air: new Knob(airAmt.gain),
      airTone: new Knob(air.frequency),
      flap: new Knob(flapEnv.playbackRate),
      tumble: new Knob(tumbleEnv.playbackRate),
    };
  }

  private makeCounter(a: Audio, drive: number): Counter {
    const { ctx } = a;
    const t = ctx.currentTime;
    // the motor: a soft buzz, and a thin gear whine above it
    const motor = ctx.createOscillator();
    motor.type = 'sawtooth';
    motor.frequency.value = 30;
    const tone = filt(ctx, 'lowpass', 300, 1.6);
    const whine = ctx.createOscillator();
    whine.frequency.value = 220;
    const whineAmt = gain(ctx, 0.08);
    const motorAmt = gain(ctx, 0);
    motor.connect(tone).connect(motorAmt);
    whine.connect(whineAmt).connect(motorAmt);
    // the machine body: a low rumble
    const noise = looped(ctx, this.bank!.get('noise')[0]);
    const rumbleTone = filt(ctx, 'bandpass', 160, 0.8);
    const rumbleAmt = gain(ctx, 0);
    noise.connect(rumbleTone).connect(rumbleAmt);
    const out = gain(ctx, 1);
    motorAmt.connect(out);
    rumbleAmt.connect(out);
    const srcs = [motor, whine, noise];
    motor.start(t);
    whine.start(t);
    noise.start(t, Math.random() * 2);
    const { pan, nodes } = this.output(ctx, out);
    const level = new Knob(motorAmt.gain);
    const rumble = new Knob(rumbleAmt.gain);
    return {
      level,
      faders: [level, rumble],
      pan,
      srcs,
      nodes: [...srcs, tone, whineAmt, motorAmt, rumbleTone, rumbleAmt, out, ...nodes],
      call: t,
      loud: t,
      out,
      motor: new Knob(motor.frequency),
      whine: new Knob(whine.frequency),
      tone: new Knob(tone.frequency),
      rumble,
      spin: 0,
      drive,
      last: -1e9, // the first note as soon as the rollers turn
      gap: 1,
    };
  }

  private drop(l: Loop | null): null {
    if (l) {
      for (const s of l.srcs) {
        try {
          s.stop();
        } catch {
          // already stopped
        }
      }
      for (const n of l.nodes) n.disconnect();
    }
    return null;
  }

  /** silence a loop nobody is steering (tab hidden, frame loop stalled, muted) */
  private hush(l: Loop | null) {
    const t = this.ctx?.currentTime ?? 0;
    for (const k of l?.faders ?? []) k.to(0, t, 0.05);
    // the machine has stopped: coming back to it idle mustn't coast it down (a ghost brrt-t-t)
    if (l && l === this.ct) this.ct.spin = 0;
  }

  /** hush loops nobody steers any more (the frame loop stopped), release those silent a while */
  private sweep() {
    if (this.sweeper !== null || (!this.fl && !this.ct)) return;
    this.sweeper = setTimeout(() => {
      this.sweeper = null;
      const t = this.ctx?.currentTime ?? 0;
      for (const l of [this.fl, this.ct]) if (l && t - l.call > DEADMAN) this.hush(l);
      if (this.fl && t - this.fl.loud > IDLE) this.fl = this.drop(this.fl);
      if (this.ct && t - this.ct.loud > IDLE) this.ct = this.drop(this.ct);
      this.sweep();
    }, 100);
  }
}

export const paperSound = new PaperSounds();
