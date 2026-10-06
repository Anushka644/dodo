// Webcam hand tracking: MediaPipe HandLandmarker once per new video frame,
// mirrored to match the selfie view, with stable slot ids and One Euro
// smoothing per slot.
//
// HANDEDNESS — `TrackedHand.handedness` is the user's REAL hand: 'Right' is
// their right hand, which shows on the right of the mirrored video (like a
// mirror). MediaPipe's labels assume a mirrored input image; we hand it the raw
// camera frame, so its labels come out swapped and are swapped back here.
//
// FRAME TIME — `HandsFrame.t` is when the camera captured the frame (rVFC
// captureTime) when the browser reports it, otherwise when we first saw the
// frame. Same clock as performance.now(), strictly increasing, may trail `now`
// by the camera's latency (~30–80 ms).
//
// DROPOUTS — a hand MediaPipe loses for ≤ SENSE.coastMs keeps its id and glides
// on its last velocity, reported with half its score; after that it's gone.
// detect() returns null (not a frame) while there's no new video frame, and for
// the second or so it takes to rebuild on the CPU if the GPU path dies. A frame
// MediaPipe fails on counts as a frame with no hands (they coast, then go), so
// a tracker that dies for good never leaves a hand frozen mid-pinch; a detection
// with a non-finite number in it is a miss too (it would poison the filters).
//
// MediaPipe is imported dynamically: its ~1 MB bundle only loads when the
// camera starts, and this module stays importable from Node for tests.

import type { HandLandmarker, HandLandmarkerResult } from '@mediapipe/tasks-vision';
import type { HandSensorApi, HandsFrame, Landmark, TrackedHand, V3 } from '../contracts';
import { OneEuroVec } from './oneEuro';

/** Tuning. Positions are normalised video units unless noted. */
export const SENSE = {
  /**
   * One Euro per landmark. minCutoff (Hz) sets the stillness at rest; beta lets
   * the cutoff rise with speed, so flicks and a 3–5 Hz finger rub come through
   * with little lag or loss. Video landmarks are in normalised units, world in metres.
   */
  image: { minCutoff: 1.4, beta: 20 },
  // World landmarks feed the gesture shapes and the rub. A higher beta (≈ 90)
  // finds fast 5 Hz rubs sooner, but passes jitter in bursts the rub's noise
  // estimate can't keep up with: still poses started printing on a noisy camera.
  world: { minCutoff: 1.4, beta: 50 },
  /** a lost hand keeps gliding on its last velocity this long before it's dropped */
  coastMs: 120,
  /** the furthest a palm can jump between frames and still be the same hand */
  matchDist: 0.3,
  /** extra matching cost when the handedness label disagrees with the slot */
  sidePenalty: 0.08,
  /** two detections whose palms are this close are one hand reported twice */
  dupDist: 0.05,
  /** handedness belief: EMA rate per frame, and how far past 50/50 it must go to flip */
  sideRate: 0.2,
  sideFlip: 0.25,
  detector: { minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 },
};

type Delegate = 'GPU' | 'CPU';
type P3 = { x: number; y: number; z: number };

/** One hand exactly as MediaPipe reports it: raw (unmirrored) camera frame. */
export interface RawHand {
  landmarks: P3[];
  world: P3[];
  /** MediaPipe's label, which assumes a mirrored image */
  label: string;
  score: number;
}

export class HandSensor implements HandSensorApi {
  private slots = new HandSlots();
  private lm: HandLandmarker | null;
  private delegate: Delegate;
  private lastTs = 0; // last timestamp given to MediaPipe (integer ms, strictly increasing)
  private lastT = -Infinity;
  private lastVideoTime = -1;
  private born = performance.now();
  // requestVideoFrameCallback bookkeeping: exact "new frame" signal + capture time
  private rvfc = 0;
  private rvfcAt = -Infinity;
  private fresh = false;
  private frameT = 0;
  private useCapture = true;
  private failures = 0;
  private rebuilding = false;
  private disposed = false;

  private constructor(
    private video: HTMLVideoElement,
    lm: HandLandmarker,
    delegate: Delegate,
    lastTs: number,
    private make: (d: Delegate) => Promise<HandLandmarker>,
  ) {
    this.lm = lm;
    this.delegate = delegate;
    this.lastTs = lastTs;
    if ('requestVideoFrameCallback' in video) this.rvfc = video.requestVideoFrameCallback(this.onFrame);
  }

  static async create(video: HTMLVideoElement, onProgress?: (msg: string) => void): Promise<HandSensor> {
    onProgress?.('Loading hand tracking…');
    const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
    const base = import.meta.env.BASE_URL;
    const files = await FilesetResolver.forVisionTasks(base + 'mediapipe');
    const make = (delegate: Delegate) =>
      HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: base + 'models/hand_landmarker.task', delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        ...SENSE.detector,
      });
    let ts = Math.floor(performance.now());
    let lm: HandLandmarker | null = null;
    let delegate: Delegate = 'GPU';
    try {
      onProgress?.('Waking the GPU…');
      lm = await make('GPU');
      // one throwaway frame: builds the GL pipeline now rather than mid-gesture,
      // and catches a GPU path that "works" until first use (looking at you, Safari)
      warm(lm, ++ts);
    } catch (e) {
      console.warn('[hands] GPU delegate failed, using CPU', e);
      try {
        lm?.close();
      } catch {
        /* already gone */
      }
      onProgress?.('Starting on the CPU…');
      delegate = 'CPU';
      lm = await make('CPU');
      try {
        warm(lm, ++ts);
      } catch (err) {
        lm.close();
        throw err;
      }
    }
    onProgress?.('Ready');
    return new HandSensor(video, lm, delegate, ts, make);
  }

  /** which MediaPipe delegate is running */
  get backend(): Delegate {
    return this.delegate;
  }

  detect(nowMs: number): HandsFrame | null {
    const v = this.video;
    if (this.disposed || v.readyState < 2 || !v.videoWidth) return null;
    let t = nowMs;
    if (nowMs - this.rvfcAt < 500) {
      // requestVideoFrameCallback is alive: it says exactly when a frame arrived
      if (!this.fresh) return null;
      t = this.frameT;
    } else {
      // give rVFC a moment to speak up so the clock doesn't switch under us
      if (this.rvfc && this.rvfcAt < 0 && nowMs - this.born < 300) return null;
      if (v.currentTime === this.lastVideoTime) return null;
    }
    this.fresh = false;
    this.lastVideoTime = v.currentTime;
    t = Math.max(t, this.lastT + 1);
    this.lastT = t;
    const ts = Math.max(this.lastTs + 1, Math.round(t));
    this.lastTs = ts;

    // rebuilding on the CPU: hold the last hands (it takes a second). Failed for good: no hands.
    if (!this.lm) return this.rebuilding ? null : { t, hands: this.slots.update([], t) };
    let res: HandLandmarkerResult;
    try {
      res = this.lm.detectForVideo(v, ts);
      this.failures = 0;
    } catch (e) {
      this.fail(e);
      return { t, hands: this.slots.update([], t) };
    }
    try {
      const raw: RawHand[] = res.landmarks.map((lms, i) => ({
        landmarks: lms,
        world: res.worldLandmarks[i] ?? [],
        label: res.handedness[i]?.[0]?.categoryName ?? '',
        score: res.handedness[i]?.[0]?.score ?? 0,
      }));
      return { t, hands: this.slots.update(raw, t) };
    } catch (e) {
      console.warn('[hands]', e);
      return null;
    }
  }

  dispose() {
    this.disposed = true;
    if (this.rvfc) this.video.cancelVideoFrameCallback(this.rvfc);
    this.rvfc = 0;
    try {
      this.lm?.close();
    } catch {
      /* already gone */
    }
    this.lm = null;
    this.slots.reset();
  }

  private onFrame = (now: number, meta: VideoFrameCallbackMetadata) => {
    if (this.disposed) return;
    const at = performance.now();
    // captureTime gives evenly spaced frames (better velocities). Use it only if
    // it's on our clock; once it isn't, never mix the two.
    const ct = meta.captureTime;
    if (this.useCapture && (ct === undefined || Math.abs(ct - at) > 1000)) this.useCapture = false;
    this.frameT = this.useCapture && ct !== undefined ? ct : now;
    this.rvfcAt = at;
    this.fresh = true;
    this.rvfc = this.video.requestVideoFrameCallback(this.onFrame);
  };

  /** a few failures in a row on the GPU → rebuild on the CPU in the background */
  private fail(e: unknown) {
    if (++this.failures === 1) console.warn('[hands] detect failed', e);
    if (this.failures < 3 || this.delegate === 'CPU' || this.rebuilding) return;
    this.rebuilding = true;
    try {
      this.lm?.close();
    } catch {
      /* already gone */
    }
    this.lm = null;
    this.make('CPU')
      .then((lm) => {
        if (this.disposed) return lm.close();
        this.lm = lm;
        this.delegate = 'CPU';
        this.failures = 0;
      })
      .catch((err) => console.warn('[hands] CPU fallback failed', err))
      .finally(() => (this.rebuilding = false));
  }
}

function warm(lm: HandLandmarker, ts: number) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  c.getContext('2d')?.fillRect(0, 0, 64, 64);
  lm.detectForVideo(c, ts);
}

// ------------------------------------------------------------------ slots

interface Slot {
  id: number;
  side: 'Left' | 'Right';
  /** running belief that this is the user's right hand */
  pRight: number;
  score: number;
  img: OneEuroVec;
  wld: OneEuroVec;
  landmarks: Landmark[];
  world: V3[];
  /** raw palm centre at the last detection, and the smoothed palm velocity (units/s) */
  cx: number;
  cy: number;
  vx: number;
  vy: number;
  /** last output time, last filter time, last real detection */
  t: number;
  ft: number;
  seen: number;
}

interface Det {
  lm: number[]; // 63, mirrored
  world: number[]; // 63, mirrored (or empty)
  cx: number;
  cy: number;
  right: number; // belief this is the user's right hand
  score: number;
}

/**
 * Turns raw MediaPipe hands into TrackedHands: mirrors x, keeps each hand in a
 * stable slot (matched by predicted palm position and handedness), smooths each
 * slot with One Euro filters, and coasts a briefly lost hand so a fast flick
 * doesn't drop what it holds. Pure — exported for tests.
 */
export class HandSlots {
  private slots: Slot[] = [];
  private nextId = 1;

  reset() {
    this.slots = [];
  }

  update(raw: RawHand[], t: number): TrackedHand[] {
    // a non-finite number would poison a slot's filters for good: such a frame is a miss
    const dets = dedupe(raw.filter((h) => h.landmarks.length === 21 && h.landmarks.every(finite)).map(detection));

    // cheapest consistent assignment of detections to slots (n ≤ 2, so brute force)
    const S = this.slots;
    const cost = dets.map((d) =>
      S.map((s) => {
        const k = (t - s.t) / 1000;
        const dd = Math.hypot(d.cx - (s.cx + s.vx * k), d.cy - (s.cy + s.vy * k));
        return dd + ((d.right >= 0.5) !== (s.side === 'Right') ? SENSE.sidePenalty : 0);
      }),
    );
    const match = assign(cost, S.length, SENSE.matchDist);

    const out: TrackedHand[] = [];
    const used = new Set<Slot>();
    dets.forEach((d, i) => {
      const s = match[i] >= 0 ? S[match[i]] : this.open(d, t);
      used.add(s);
      this.feed(s, d, t);
      out.push(emit(s, s.score));
    });
    this.slots = S.filter((s) => used.has(s) || this.coast(s, t)).concat(
      [...used].filter((s) => !S.includes(s)),
    );
    for (const s of this.slots) if (!used.has(s)) out.push(emit(s, s.score * 0.5));
    return out.sort((a, b) => a.id - b.id);
  }

  private open(d: Det, t: number): Slot {
    return {
      id: this.nextId++,
      side: d.right >= 0.5 ? 'Right' : 'Left',
      pRight: d.right,
      score: d.score,
      img: new OneEuroVec(63, SENSE.image.minCutoff, SENSE.image.beta),
      wld: new OneEuroVec(63, SENSE.world.minCutoff, SENSE.world.beta),
      landmarks: [],
      world: [],
      cx: d.cx,
      cy: d.cy,
      vx: 0,
      vy: 0,
      t,
      ft: t,
      seen: t,
    };
  }

  private feed(s: Slot, d: Det, t: number) {
    const dt = (t - s.ft) / 1000;
    const lm = s.img.filter(d.lm, dt);
    const prev = s.landmarks.length ? palmOf(s.landmarks) : null;
    s.landmarks = [];
    for (let i = 0; i < 63; i += 3) s.landmarks.push({ x: lm[i], y: lm[i + 1], z: lm[i + 2] });
    if (d.world.length === 63) {
      const w = s.wld.filter(d.world, dt);
      s.world = [];
      for (let i = 0; i < 63; i += 3) s.world.push([w[i], w[i + 1], w[i + 2]]);
    } else s.world = [];
    // palm velocity, for predicting where to look next frame and for coasting
    const dto = (t - s.t) / 1000;
    if (prev && dto > 0) {
      const c = palmOf(s.landmarks);
      s.vx += 0.5 * ((c[0] - prev[0]) / dto - s.vx);
      s.vy += 0.5 * ((c[1] - prev[1]) / dto - s.vy);
    }
    s.pRight += SENSE.sideRate * (d.right - s.pRight);
    if (s.side === 'Right' && s.pRight < 0.5 - SENSE.sideFlip) s.side = 'Left';
    else if (s.side === 'Left' && s.pRight > 0.5 + SENSE.sideFlip) s.side = 'Right';
    s.score = d.score;
    s.cx = d.cx;
    s.cy = d.cy;
    s.t = s.ft = s.seen = t;
  }

  /** glide a lost hand along its velocity; false once it's been gone too long */
  private coast(s: Slot, t: number): boolean {
    if (t - s.seen > SENSE.coastMs || !s.landmarks.length) return false;
    const k = (t - s.t) / 1000;
    const dx = s.vx * k;
    const dy = s.vy * k;
    s.landmarks = s.landmarks.map((l) => ({ x: l.x + dx, y: l.y + dy, z: l.z }));
    s.cx += dx;
    s.cy += dy;
    s.vx *= 0.8;
    s.vy *= 0.8;
    s.t = t;
    return true;
  }
}

function detection(h: RawHand): Det {
  const lm: number[] = [];
  for (const p of h.landmarks) lm.push(1 - p.x, p.y, p.z);
  const world: number[] = [];
  if (h.world.length === 21 && h.world.every(finite)) for (const p of h.world) world.push(-p.x, p.y, p.z);
  let cx = 0;
  let cy = 0;
  for (const i of [0, 5, 9, 13, 17]) {
    cx += lm[i * 3] / 5;
    cy += lm[i * 3 + 1] / 5;
  }
  // MediaPipe's 'Left' on an unmirrored frame is the user's right hand
  const label = h.label.toLowerCase();
  const right = label === 'left' ? h.score : label === 'right' ? 1 - h.score : 0.5;
  return { lm, world, cx, cy, right, score: h.score };
}

/** MediaPipe occasionally reports one hand twice; keep the more confident */
function dedupe(ds: Det[]): Det[] {
  const out: Det[] = [];
  for (const d of [...ds].sort((a, b) => b.score - a.score)) {
    if (!out.some((o) => Math.hypot(o.cx - d.cx, o.cy - d.cy) < SENSE.dupDist)) out.push(d);
  }
  return out;
}

/** best detection → slot assignment (−1 = new slot); any match within `max` beats none */
function assign(cost: number[][], nSlots: number, max: number): number[] {
  let best = Infinity;
  let out: number[] = cost.map(() => -1);
  const cur: number[] = [];
  const rec = (d: number, acc: number) => {
    if (acc >= best) return;
    if (d === cost.length) {
      best = acc;
      out = cur.slice();
      return;
    }
    for (let s = -1; s < nSlots; s++) {
      if (s >= 0 && (cost[d][s] > max || cur.slice(0, d).includes(s))) continue;
      cur[d] = s;
      rec(d + 1, acc + (s < 0 ? max : cost[d][s]));
    }
  };
  rec(0, 0);
  return out;
}

const finite = (p: P3) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

function palmOf(l: Landmark[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const i of [0, 5, 9, 13, 17]) {
    x += l[i].x / 5;
    y += l[i].y / 5;
  }
  return [x, y];
}

function emit(s: Slot, score: number): TrackedHand {
  return { id: s.id, handedness: s.side, score, landmarks: s.landmarks, world: s.world };
}
