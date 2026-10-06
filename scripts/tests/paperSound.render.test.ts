// Paper sounds rendered for real, and measured. Run: npx --yes tsx@4 scripts/tests/paperSound.render.test.ts [--wav]
// Drives src/paperSound.ts through an actual WebAudio engine (node-web-audio-api, an
// OfflineAudioContext suspended every 1/60 s to call the API like the frame loop does),
// then measures the output: levels, brightness, flap and tick rates, tails, silence, clipping.
// node-web-audio-api is not a project dependency: on first run it's installed into a temp
// folder (SKIP_AUDIO_RENDER=1 skips this test). --wav writes every scene to debug/renders/.
//
// Each scene renders in its own child process: node-web-audio-api's offline suspend() can
// panic once a process has used several contexts, which would drop frames at random.

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Proc = { env: Record<string, string | undefined>; argv: string[]; execArgv: string[]; execPath: string; exit(c: number): never };
const proc = (globalThis as unknown as { process: Proc }).process;
const arg = (flag: string) => (proc.argv.includes(flag) ? proc.argv[proc.argv.indexOf(flag) + 1] : undefined);
const WORKER = arg('--scene');
const WAV = proc.argv.includes('--wav');
const SR = 48000;
const FRAME = 1 / 60;

if (proc.env.SKIP_AUDIO_RENDER) {
  console.log('  skip  SKIP_AUDIO_RENDER is set');
  proc.exit(0);
}

// ------------------------------------------------------------ the engine

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;
const DEPS = join(tmpdir(), 'dodo-test-deps');
const ENTRY = join(DEPS, 'node_modules', 'node-web-audio-api', 'index.js');

async function loadWebAudio(install: boolean): Promise<OfflineCtor | null> {
  try {
    return ((await import('node-web-audio-api' as string)) as { OfflineAudioContext: OfflineCtor }).OfflineAudioContext;
  } catch {
    // not installed in the project: use (or make) a private copy
  }
  if (!existsSync(ENTRY) && install) {
    console.log(`  (installing node-web-audio-api into ${DEPS} for this test — once)`);
    try {
      mkdirSync(DEPS, { recursive: true });
      execSync('npm i --no-save --no-package-lock --no-audit --no-fund node-web-audio-api@2', { cwd: DEPS, stdio: 'ignore' });
    } catch {
      return null;
    }
  }
  try {
    return ((await import(pathToFileURL(ENTRY).href)) as { OfflineAudioContext: OfflineCtor }).OfflineAudioContext;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ scenes (rendered in a worker)

type Api = typeof import('../../src/paperSound');
type Snd = typeof import('../../src/sound')['sound'];
interface Scene {
  seconds: number;
  frame: (t: number, k: number) => void;
  /** call frame only at t = 0 (one-shots): no suspends needed */
  once?: boolean;
  /** the room's early reflections read as extra transients: measure rhythms dry */
  dry?: boolean;
}

function scenes(m: Api, sound: Snd): Record<string, (p: string) => Scene> {
  const api = m.paperSound;
  const shot = (p: string) => ({ grab: () => api.grab(), release: () => api.release(), catch: () => api.catchNote(), snap: () => api.snap() })[p.split(':')[0] as 'grab'];
  let amt = 0;
  let next = 0.3;
  return {
    silence: () => ({ seconds: 1.5, frame: () => (api.flutter(0), api.counter(0)) }),
    'flutter-speeds': () => ({ seconds: SPEEDS.length * 1.5 + 2.5, frame: (t) => api.flutter(SPEEDS[Math.floor(t / 1.5)] ?? 0) }),
    'flutter-flaps': (p) => ({ seconds: 3, dry: true, frame: () => api.flutter(+p) }),
    counter: (p) => ({ seconds: 4, dry: true, frame: (t) => api.counter(t < 2.5 ? +p : 0) }),
    crumple: () => ({ seconds: 5, frame: (t) => t < 3.5 && api.crumple((amt = Math.min(1, amt + FRAME * 2.2))) }),
    oneshot: (p) => ({ seconds: 0.8, once: true, frame: shot(p) }),
    'money-rain': () => ({
      seconds: 6,
      frame: (t) => {
        api.counter(t < 4 ? 0.8 : 0);
        api.flutter(t > 0.4 ? 2 + 2 * Math.sin(t * 3) + Math.random() : 0);
        if (t > next) {
          api.catchNote();
          next = t + 0.08 + Math.random() * 0.3;
        }
        if (Math.abs(t - 2) < FRAME / 2) api.grab();
        if (Math.abs(t - 2.6) < FRAME / 2) api.snap();
      },
    }),
    mute: () => ({
      seconds: 3,
      frame: (t) => {
        if (t >= 1 && sound.enabled) sound.setEnabled(false);
        api.flutter(5);
        api.counter(0.6);
      },
    }),
    'ref-rustle': () => ({ seconds: 0.6, once: true, frame: () => sound.rustle() }),
    'ref-flutter': () => ({ seconds: 2, frame: () => api.flutter(4) }),
  };
}
const SPEEDS = [0.8, 2.5, 5, 9];

async function worker(name: string, out: string) {
  const Offline = await loadWebAudio(false);
  if (!Offline) proc.exit(2);
  const win = { AudioContext: null as unknown };
  (globalThis as unknown as { window: unknown }).window = win;
  const { sound } = await import('../../src/sound');
  const m = await import('../../src/paperSound');
  const [key, ...rest] = name.split(':');
  const sc = scenes(m, sound)[key](rest.join(':'));
  if (sc.dry) m.PAPER_SOUND.room = 0;
  const off = new Offline!(2, Math.ceil(sc.seconds * SR), SR);
  // at a suspend point an offline context says 'suspended'; to the module it's running
  const ctx = new Proxy(off, {
    get(target, prop) {
      if (prop === 'state') return 'running';
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  win.AudioContext = function () {
    return ctx;
  };
  sound.wake();
  sc.frame(0, 0);
  const n = sc.once ? 0 : Math.floor(sc.seconds / FRAME);
  let lost = 0;
  for (let k = 1; k < n; k++) {
    off.suspend(k * FRAME).then(
      () => {
        sc.frame(off.currentTime, k);
        void off.resume();
      },
      () => lost++,
    );
  }
  const buf = await off.startRendering();
  if (lost > 0.01 * n) proc.exit(3); // the engine dropped frames: the parent retries
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const both = new Float32Array(L.length * 2);
  both.set(L);
  both.set(R, L.length);
  writeFileSync(out, new Uint8Array(both.buffer));
  proc.exit(0);
}

if (WORKER) await worker(WORKER, arg('--out')!);

// ------------------------------------------------------------ parent: run scenes in workers

if (!(await loadWebAudio(true))) {
  console.log('  skip  node-web-audio-api unavailable (no network?) — nothing rendered');
  proc.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'dodo-renders-'));
type Out = { mono: Float32Array; L: Float32Array; R: Float32Array };
const made = new Map<string, Promise<Out>>();
let running = 0;
const queue: (() => void)[] = [];
const slots = Math.max(2, Math.min(6, cpus().length));

function runWorker(name: string, file: string) {
  return new Promise<number>((done) => {
    const p = spawn(proc.execPath, [...proc.execArgv, proc.argv[1], '--scene', name, '--out', file], { stdio: 'ignore' });
    p.on('exit', (code) => done(code ?? 1));
  });
}

/** a scene's audio, rendered in a child process (memoised; a few run at once) */
function scene(name: string): Promise<Out> {
  let m = made.get(name);
  if (m) return m;
  m = new Promise<Out>((resolve, reject) => {
    const go = async () => {
      running++;
      const file = join(tmp, `${name.replace(/[^\w.-]/g, '_')}.f32`);
      let code = 1;
      for (let attempt = 0; attempt < 4 && code !== 0; attempt++) code = await runWorker(name, file);
      running--;
      queue.shift()?.();
      if (code !== 0) return reject(new Error(`${name}: render failed (exit ${code})`));
      const both = new Float32Array(new Uint8Array(readFileSync(file)).buffer);
      const n = both.length / 2;
      const L = both.subarray(0, n);
      const R = both.subarray(n);
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) mono[i] = 0.5 * (L[i] + R[i]);
      if (WAV) writeWav(name, L, R);
      resolve({ mono, L, R });
    };
    if (running < slots) void go();
    else queue.push(() => void go());
  });
  made.set(name, m);
  return m;
}

function writeWav(name: string, L: Float32Array, R: Float32Array) {
  const dir = join('debug', 'renders');
  mkdirSync(dir, { recursive: true });
  const n = L.length;
  const b = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  b.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVEfmt ');
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 2, true);
  b.setUint32(24, SR, true);
  b.setUint32(28, SR * 4, true);
  b.setUint16(32, 4, true);
  b.setUint16(34, 16, true);
  str(36, 'data');
  b.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    b.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    b.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  writeFileSync(join(dir, `${name.replace(/[^\w.-]/g, '_')}.wav`), new Uint8Array(b.buffer));
}

// ------------------------------------------------------------ measuring

const seg = (x: Float32Array, from: number, to: number) => x.subarray(Math.round(from * SR), Math.min(x.length, Math.round(to * SR)));
const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));
const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(a * k), s = Math.sin(a * k);
        const h = i + k + len / 2;
        const xr = re[h] * c - im[h] * s;
        const xi = re[h] * s + im[h] * c;
        re[h] = re[i + k] - xr;
        im[h] = im[i + k] - xi;
        re[i + k] += xr;
        im[i + k] += xi;
      }
    }
  }
}

/** power-weighted mean frequency (Hz): how bright */
function centroid(x: Float32Array) {
  const N = 4096;
  let num = 0, den = 0;
  for (let s = 0; s + N <= x.length; s += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      num += p * ((k * SR) / N);
      den += p;
    }
  }
  return den > 0 ? num / den : 0;
}

/** transients: peaks of a high-passed envelope, at least `gap` s apart */
function onsets(x: Float32Array, gap = 0.012, rel = 0.2) {
  const e = new Float32Array(x.length);
  let prev = 0, env = 0;
  const att = 1 - Math.exp(-1 / (0.0003 * SR)), dec = 1 - Math.exp(-1 / (0.004 * SR));
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i] - prev); // crude high-pass: the motor and rumble sit below it
    prev = x[i];
    env += (a - env) * (a > env ? att : dec);
    e[i] = env;
  }
  const top = [...e].sort((a, b) => a - b)[Math.floor(e.length * 0.995)];
  const times: number[] = [];
  const w = Math.round(gap * SR);
  for (let i = 1; i < e.length - 1; i++) {
    if (e[i] < rel * top || e[i] < e[i - 1] || e[i] < e[i + 1]) continue;
    if (times.length && i - times[times.length - 1] * SR < w) continue;
    times.push(i / SR);
  }
  return times;
}

/** loudness of a short event: RMS over its loudest 50 ms */
function loud50(x: Float32Array) {
  const w = Math.round(0.05 * SR);
  let best = 0;
  for (let s = 0; s + w <= x.length; s += w / 5) best = Math.max(best, rms(x.subarray(s, s + w)));
  return best;
}

/** seconds after `from` until the level stays below `floor` dB (20 ms windows) */
function decayTime(x: Float32Array, from: number, floor: number) {
  const w = Math.round(0.02 * SR);
  let last = from;
  for (let s = Math.round(from * SR); s + w <= x.length; s += w) if (db(rms(x.subarray(s, s + w))) > floor) last = (s + w) / SR;
  return last - from;
}

// ------------------------------------------------------------ harness

let failed = 0;
const results: string[] = [];
const ONLY = proc.env.ONLY;
async function test(name: string, fn: () => Promise<string | void>) {
  if (ONLY && !name.includes(ONLY)) return;
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
const f1 = (v: number) => v.toFixed(1);
const SHOTS = ['grab', 'release', 'catch', 'snap'];
const VARIANTS = 4;

// start everything at once; the tests below wait for what they need
if (!ONLY) {
  for (const n of ['silence', 'flutter-speeds', 'flutter-flaps:1.2', 'flutter-flaps:9', 'counter:0.3', 'counter:1', 'crumple', 'money-rain', 'mute', 'ref-rustle', 'ref-flutter']) void scene(n).catch(() => {});
  for (const s of SHOTS) for (let v = 0; v < VARIANTS; v++) void scene(`oneshot:${s}:${v}`).catch(() => {});
}

// ------------------------------------------------------------ tests

await test('nothing asked, nothing heard', async () => {
  const { mono } = await scene('silence');
  assert(peak(mono) === 0, `peak ${peak(mono)}`);
});

await test('flutter: louder and brighter as the note moves faster; silent at rest', async () => {
  const { mono } = await scene('flutter-speeds');
  const rows = SPEEDS.map((s, k) => {
    const x = seg(mono, k * 1.5 + 0.5, k * 1.5 + 1.5);
    return { s, level: db(rms(x)), bright: centroid(x) };
  });
  for (let k = 1; k < rows.length; k++) {
    assert(rows[k].level > rows[k - 1].level + 1, `level ${f1(rows[k - 1].level)} → ${f1(rows[k].level)} dB at ${rows[k].s} u/s`);
    assert(rows[k].bright > rows[k - 1].bright, `brightness ${Math.round(rows[k - 1].bright)} → ${Math.round(rows[k].bright)} Hz at ${rows[k].s} u/s`);
  }
  const end = SPEEDS.length * 1.5;
  const tail = decayTime(mono, end, -90);
  assert(tail < 0.9, `still audible ${f1(tail)} s after coming to rest`);
  const after = seg(mono, end + 1.6, end + 2.5);
  assert(peak(after) < 1e-5, `after release: peak ${peak(after).toExponential(1)} (a click when the loop was torn down?)`);
  return rows.map((r) => `${r.s} u/s: ${f1(r.level)} dB, ${Math.round(r.bright)} Hz`).join('; ') + `; −90 dB ${f1(tail)} s after rest`;
});

await test('flutter: the flaps are fast and irregular (8–25 a second)', async () => {
  const out: string[] = [];
  for (const [s, lo, hi] of [[1.2, 8, 20], [9, 17, 32]] as const) {
    const { mono } = await scene(`flutter-flaps:${s}`);
    // the noise's envelope every 2 ms, lightly smoothed, then its peaks
    const x = seg(mono, 0.5, 3);
    const hop = Math.round(0.002 * SR);
    const env: number[] = [];
    for (let i = 0; i + hop <= x.length; i += hop) env.push(rms(x.subarray(i, i + hop)));
    const sm = env.map((_, i) => (env[i - 1] ?? env[i]) * 0.25 + env[i] * 0.5 + (env[i + 1] ?? env[i]) * 0.25);
    const mean = sm.reduce((a, b) => a + b, 0) / sm.length;
    let peaks = 0;
    for (let i = 3; i < sm.length - 3; i++) if (sm[i] > 1.25 * mean && sm[i] === Math.max(...sm.slice(i - 3, i + 4))) peaks++;
    const rate = peaks / 2.5;
    assert(rate > lo && rate < hi, `${s} u/s: ${f1(rate)} flaps/s, expected ${lo}–${hi}`);
    out.push(`${s} u/s: ~${f1(rate)} flaps/s`);
  }
  return out.join(', ');
});

await test('counter: brrrrt at 25–35 notes/s over a motor; quiet within half a second of stopping', async () => {
  const out: string[] = [];
  for (const [i, lo, hi] of [[0.3, 24, 32], [1, 31, 39]] as const) {
    const { mono } = await scene(`counter:${i}`);
    const rate = onsets(seg(mono, 0.5, 2.5), 0.018).length / 2;
    assert(rate >= lo && rate <= hi, `intensity ${i}: ${f1(rate)} ticks/s, expected ${lo}–${hi}`);
    const lvl = db(rms(seg(mono, 1, 2.5)));
    const tail = decayTime(mono, 2.5, lvl - 60);
    assert(tail < 0.6, `intensity ${i}: −60 dB only ${f1(tail)} s after stopping`);
    // spin-up: the second note follows the first closely (it used to leave a ~150 ms hole: "t… brrrt")
    const [n0, n1] = onsets(seg(mono, 0, 0.4), 0.02, 0.05); // ≥ 20 ms apart: one tick rings for ~15 ms
    assert(n1 - n0 < 0.1, `intensity ${i}: ${Math.round((n1 - n0) * 1000)} ms between the first two notes`);
    out.push(`${i}: ${f1(rate)} ticks/s at ${f1(lvl)} dB, first gap ${Math.round((n1 - n0) * 1000)} ms, −60 dB ${tail.toFixed(2)} s after stopping`);
  }
  return out.join('; ');
});

await test('crumple: crackle while squeezing, thinning when held, silent after', async () => {
  const { mono } = await scene('crumple');
  const squeeze = onsets(seg(mono, 0, 0.6), 0.004, 0.08).length / 0.6;
  const held = onsets(seg(mono, 2.5, 3.5), 0.004, 0.08).length;
  const lvl = [db(rms(seg(mono, 0, 0.6))), db(rms(seg(mono, 2.5, 3.5)))];
  assert(squeeze > 1.5 * held, `${f1(squeeze)}/s squeezing vs ${held}/s held`);
  assert(lvl[0] > lvl[1] + 6, `level ${f1(lvl[0])} dB squeezing vs ${f1(lvl[1])} dB held`);
  const tail = decayTime(mono, 3.5, -80);
  assert(tail < 0.5, `crackle went on ${f1(tail)} s after the fist let go`);
  return `${Math.round(squeeze)} transients/s at ${f1(lvl[0])} dB squeezing → ${held}/s at ${f1(lvl[1])} dB held; peak ${f1(db(peak(mono)))} dBFS`;
});

await test('one-shots: grab crinkles, release breathes, catch is muted, snap is the loudest', async () => {
  const rows: Record<string, { pk: number; lvl: number; bright: number; len: number }> = {};
  for (const name of SHOTS) {
    // averaged over a few renders: each call picks a variant, speed and level at random
    const r = { pk: -Infinity, lvl: 0, bright: 0, len: 0 };
    for (let v = 0; v < VARIANTS; v++) {
      const { mono } = await scene(`oneshot:${name}:${v}`);
      const pk = peak(mono);
      r.pk = Math.max(r.pk, db(pk));
      r.lvl += db(loud50(mono)) / VARIANTS;
      r.bright += centroid(seg(mono, 0, 0.3)) / VARIANTS;
      r.len += decayTime(mono, 0, db(pk) - 50) / VARIANTS;
    }
    rows[name] = r;
  }
  const table = Object.entries(rows)
    .map(([k, r]) => `${k} ${f1(r.lvl)} dB (pk ${f1(r.pk)}), ${Math.round(r.bright)} Hz, ${Math.round(r.len * 1000)} ms`)
    .join('; ');
  const { grab, release, catch: c, snap } = rows;
  assert(snap.lvl >= Math.max(grab.lvl, release.lvl, c.lvl) - 1, `snap is not the loudest: ${table}`);
  assert(release.lvl < grab.lvl, `release not softer than grab: ${table}`);
  assert(c.bright > 250 && c.bright < 1200, `catch not a muted slap (or all sub-bass a laptop can't play): ${table}`);
  // snap's centroid is ~1.6 kHz ± 60 Hz from render to render (a 300 Hz body under its crack): 1500 was on the edge
  assert(grab.bright > 2000 && release.bright > 1000 && snap.bright > 1200, `grab / release / snap not crisp or airy: ${table}`);
  assert(Object.values(rows).every((r) => r.pk < -12), `a one-shot within 12 dB of full scale: ${table}`);
  return table;
});

await test('money rain: printing, fluttering, catching and grabbing at once stays clean', async () => {
  const { mono } = await scene('money-rain');
  const pk = peak(mono);
  assert(pk < 0.25, `peak ${pk.toFixed(2)}: too hot`);
  assert(mono.every(Number.isFinite), 'non-finite samples');
  return `peak ${f1(db(pk))} dBFS, ${f1(db(rms(seg(mono, 0.5, 4))))} dB RMS`;
});

await test('mute mid-flutter: gone within a fraction of a second, and stays gone', async () => {
  const { mono } = await scene('mute');
  const tail = decayTime(mono, 1, -90);
  assert(tail < 0.5, `audible ${f1(tail)} s after muting`);
  return `−90 dB ${tail.toFixed(2)} s after muting`;
});

await test('next to sound.ts: same room, same loudness ballpark', async () => {
  const ref = (await scene('ref-rustle')).mono;
  const fl = (await scene('ref-flutter')).mono;
  const grabs = await Promise.all([0, 1, 2, 3].map((v) => scene(`oneshot:grab:${v}`)));
  const grab = grabs.reduce((a, g) => a + db(loud50(g.mono)), 0) / grabs.length;
  const d = grab - db(loud50(ref));
  assert(Math.abs(d) < 10, `grab is ${f1(d)} dB from sound.rustle()`);
  return `sound.rustle() ${f1(db(loud50(ref)))} dB; grab ${f1(grab)} dB; flutter at 4 u/s ${f1(db(rms(seg(fl, 0.5, 2))))} dB RMS`;
});

console.log(results.join('\n'));
console.log(failed ? `\n${failed} failed` : '\nall passed');
if (WAV) console.log('  wav files in debug/renders/');
proc.exit(failed ? 1 : 0);
