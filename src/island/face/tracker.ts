// The webcam and the face in it. MediaPipe's FaceLandmarker runs once per new
// camera frame (GPU, falling back to CPU) and gives, besides the landmarks,
// "blendshapes": how much you're smiling, frowning, puffing your cheeks,
// opening your jaw. Those become the island's weather. The head's position in
// the (mirrored) frame turns the view, as if the island sat behind the glass,
// and tilting it turns the sun.
//
// MediaPipe's runtime and model are served from our own origin (public/mediapipe,
// public/models), and imported dynamically: nothing loads until you ask for it.

import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { OneEuroVec } from './oneEuro';

/** what the face is doing, each 0..1 unless noted */
export interface FaceRead {
  smile: number;
  /** brows down, mouth corners down, a scowl: measured from your own resting face (1 = a clear frown) */
  frown: number;
  /** both eyes closed (only used to tell a yawn from a roar) */
  closed: number;
  /** head tilt in radians: positive towards your right shoulder */
  tilt: number;
  /** cheeks puffed or lips pursed, as if blowing */
  blow: number;
  /** jaw wide open */
  roar: number;
  /** where the head is in the mirror: x, y from −1 to 1 (0 in the middle, y up), and how big (eye span in frame heights) */
  head: { x: number; y: number; size: number };
}

type Delegate = 'GPU' | 'CPU';

/** a face lost for longer than this is gone */
const COAST_MS = 250;

export class FaceTracker {
  private video: HTMLVideoElement | null = null;
  private head = new OneEuroVec(4, 1.0, 6);
  private shapes = new Map<string, number>();
  /** each face's own resting level of the frown muscles */
  private rest = new Map<string, number>();
  private lastTs = 0;
  private lastVideoTime = -1;
  private lastSeen = -Infinity;
  private lastFrameAt = 0;
  private last: FaceRead | null = null;
  private disposed = false;
  private failures = 0;

  private constructor(
    private lm: FaceLandmarker,
    readonly backend: Delegate,
  ) {}

  /** loads the model (no camera needed yet, so it can load while the camera opens) */
  static async create(onStatus?: (s: string) => void): Promise<FaceTracker> {
    onStatus?.('Loading face tracking…');
    const { FilesetResolver, FaceLandmarker } = await import('@mediapipe/tasks-vision');
    const base = import.meta.env.BASE_URL;
    const files = await FilesetResolver.forVisionTasks(base + 'mediapipe');
    const make = (delegate: Delegate) =>
      FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: base + 'models/face_landmarker.task', delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    let lm: FaceLandmarker | null = null;
    try {
      lm = await make('GPU');
      warm(lm);
      return new FaceTracker(lm, 'GPU');
    } catch (e) {
      console.warn('[face] GPU delegate failed, using the CPU', e);
      try {
        lm?.close();
      } catch {
        /* already gone */
      }
      onStatus?.('Starting face tracking on the CPU…');
      lm = await make('CPU');
      warm(lm);
      return new FaceTracker(lm, 'CPU');
    }
  }

  /** the camera to watch */
  attach(video: HTMLVideoElement) {
    this.video = video;
    this.lastVideoTime = -1;
  }

  /**
   * The face in the newest camera frame. Returns the last reading while no new
   * frame has arrived, and null once the face has been gone a moment.
   */
  detect(now: number): FaceRead | null {
    const v = this.video;
    if (this.disposed || !v || v.readyState < 2 || !v.videoWidth) return null;
    const coasting = () => (now - this.lastSeen < COAST_MS ? this.last : null);
    if (v.currentTime === this.lastVideoTime) return coasting();
    this.lastVideoTime = v.currentTime;
    const ts = Math.max(this.lastTs + 1, Math.floor(now));
    this.lastTs = ts;
    const dt = Math.max(1e-3, Math.min(0.2, (now - (this.lastFrameAt || now - 33)) / 1000));
    this.lastFrameAt = now;
    let res;
    try {
      res = this.lm.detectForVideo(v, ts);
      this.failures = 0;
    } catch (e) {
      if (++this.failures === 1) console.warn('[face] detection failed', e);
      return coasting();
    }
    const lms = res.faceLandmarks?.[0];
    const cats = res.faceBlendshapes?.[0]?.categories;
    if (!lms || lms.length < 264 || !cats?.length) {
      if (now - this.lastSeen >= COAST_MS) {
        this.last = null;
        this.head.reset();
        this.shapes.clear();
        this.rest.clear();
      }
      return coasting();
    }
    // expressions, eased a little (they flicker frame to frame)
    const k = 1 - Math.exp(-dt * 14);
    for (const c of cats) {
      const prev = this.shapes.get(c.categoryName);
      this.shapes.set(c.categoryName, prev === undefined ? c.score : prev + (c.score - prev) * k);
    }
    const b = (n: string) => this.shapes.get(n) ?? 0;
    const pair = (n: string) => (b(n + 'Left') + b(n + 'Right')) / 2;
    // the head: midway between the outer corners of the eyes, mirrored like a mirror
    const aspect = v.videoWidth / v.videoHeight;
    const l = lms[33], r = lms[263];
    const mx = 1 - (l.x + r.x) / 2;
    const my = (l.y + r.y) / 2;
    const span = Math.hypot((r.x - l.x) * aspect, r.y - l.y);
    if (![mx, my, span].every(Number.isFinite)) return coasting();
    // tilt: the slope of the line between the eyes (33 is your right eye, on the left of the raw frame)
    const roll = -Math.atan2(r.y - l.y, (r.x - l.x) * aspect);
    const [hx, hy, hs, ht] = this.head.filter([mx * 2 - 1, 1 - my * 2, span, roll], dt);
    // a frown is small in MediaPipe's numbers, and everyone's resting face sits at a
    // different level, so it's measured as the rise above your own resting level
    const above = (n: string) => {
      const v = pair(n);
      const r0 = this.rest.get(n);
      // the rest follows you down quickly and up only slowly, so holding a frown
      // isn't learned as your resting face
      const r1 = r0 === undefined ? v : v < r0 ? r0 + (v - r0) * 0.25 : r0 + (v - r0) * 0.0015;
      this.rest.set(n, r1);
      return Math.max(0, v - r1);
    };
    this.last = {
      smile: pair('mouthSmile'),
      frown: Math.max(above('browDown') / 0.26, above('mouthFrown') / 0.14, above('noseSneer') / 0.28),
      closed: pair('eyeBlink'),
      tilt: ht,
      // puffed cheeks read weakly, so they count double; pursed lips count only with a
      // still, closed jaw (speech rounds the lips on every "oo" and moves the jaw)
      blow: Math.max(b('cheekPuff') * 2, Math.max(b('mouthPucker') * 0.85, b('mouthFunnel') * 0.8) * (1 - smoothstep(0.12, 0.3, b('jawOpen')))),
      roar: b('jawOpen'),
      head: { x: hx, y: hy, size: hs },
    };
    this.lastSeen = now;
    return this.last;
  }

  dispose() {
    this.disposed = true;
    try {
      this.lm.close();
    } catch {
      /* already gone */
    }
  }
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** one throwaway frame, so the GPU pipeline is built now rather than mid-smile */
function warm(lm: FaceLandmarker) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  c.getContext('2d')?.fillRect(0, 0, 64, 64);
  lm.detectForVideo(c, 1);
}

/** the front camera, small: face tracking doesn't need more */
export async function openCamera(): Promise<HTMLVideoElement> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  try {
    await v.play();
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
  return v;
}

export function closeCamera(v: HTMLVideoElement | null) {
  const s = v?.srcObject as MediaStream | null;
  s?.getTracks().forEach((t) => t.stop());
  if (v) v.srcObject = null;
}
