// The webcam and the hand in it. MediaPipe's HandLandmarker runs once per new
// camera frame (GPU, falling back to CPU), on one hand. Positions come back
// mirrored, like a mirror, and smoothed with a One Euro filter so a still hand
// is still and a quick one isn't laggy.
//
// MediaPipe's runtime and model are served from our own origin (public/mediapipe,
// public/models), and imported dynamically: nothing loads until you ask for it.
//
// HANDEDNESS — MediaPipe's labels assume a mirrored image; we give it the raw
// camera frame, so its "Left" is the user's real right hand.

import type { HandLandmarker } from '@mediapipe/tasks-vision';
import { OneEuroVec } from './oneEuro';

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface HandPose {
  /** 21 landmarks in the mirrored video frame: x, y in 0..1 (y down), z relative depth */
  image: P3[];
  /** 21 landmarks in metres about the hand's centre: x right (mirrored), y down, z away from the camera */
  world: P3[];
  /** the user's real right hand */
  right: boolean;
  score: number;
  /** video width / height */
  aspect: number;
}

type Delegate = 'GPU' | 'CPU';

/** a hand lost for longer than this is gone */
const COAST_MS = 160;

export class HandTracker {
  private image = new OneEuroVec(63, 1.2, 18);
  private world = new OneEuroVec(63, 1.2, 40);
  private lastTs = 0;
  private lastVideoTime = -1;
  private lastSeen = -Infinity;
  private lastFrameAt = 0;
  private last: HandPose | null = null;
  private side = 0.5; // belief this is the right hand
  private disposed = false;
  private failures = 0;

  private video: HTMLVideoElement | null = null;

  private constructor(
    private lm: HandLandmarker,
    readonly backend: Delegate,
  ) {}

  /** loads the model (no camera needed yet, so it can load while the camera opens) */
  static async create(onStatus?: (s: string) => void): Promise<HandTracker> {
    onStatus?.('Loading hand tracking…');
    const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
    const base = import.meta.env.BASE_URL;
    const files = await FilesetResolver.forVisionTasks(base + 'mediapipe');
    const make = (delegate: Delegate) =>
      HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: base + 'models/hand_landmarker.task', delegate },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    let lm: HandLandmarker | null = null;
    try {
      lm = await make('GPU');
      warm(lm);
      return new HandTracker(lm, 'GPU');
    } catch (e) {
      console.warn('[hand] GPU delegate failed, using the CPU', e);
      try {
        lm?.close();
      } catch {
        /* already gone */
      }
      onStatus?.('Starting hand tracking on the CPU…');
      lm = await make('CPU');
      warm(lm);
      return new HandTracker(lm, 'CPU');
    }
  }

  /**
   * The hand in the newest camera frame. Returns the last pose while no new
   * frame has arrived, and null once the hand has been gone a moment.
   */
  /** the camera to watch */
  attach(video: HTMLVideoElement) {
    this.video = video;
    this.lastVideoTime = -1;
  }

  detect(now: number): HandPose | null {
    const v = this.video;
    if (this.disposed || !v || v.readyState < 2 || !v.videoWidth) return null;
    if (v.currentTime === this.lastVideoTime) return now - this.lastSeen < COAST_MS ? this.last : null;
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
      if (++this.failures === 1) console.warn('[hand] detection failed', e);
      return now - this.lastSeen < COAST_MS ? this.last : null;
    }
    const lms = res.landmarks?.[0];
    const wl = res.worldLandmarks?.[0];
    if (!lms || !wl || lms.length < 21 || wl.length < 21 || ![...lms, ...wl].every((p) => Number.isFinite(p.x + p.y + p.z))) {
      if (now - this.lastSeen >= COAST_MS) {
        this.last = null;
        this.image.reset();
        this.world.reset();
      }
      return now - this.lastSeen < COAST_MS ? this.last : null;
    }
    const cat = res.handedness?.[0]?.[0];
    // mirrored input is what MediaPipe expects, so on the raw frame its "Left" is the real right hand
    const saysRight = cat?.categoryName === 'Left';
    this.side += ((saysRight ? 1 : 0) - this.side) * 0.25;
    const img = this.image.filter(lms.flatMap((p) => [1 - p.x, p.y, p.z]), dt);
    const wld = this.world.filter(wl.flatMap((p) => [-p.x, p.y, p.z]), dt);
    const unpack = (a: number[]): P3[] => Array.from({ length: 21 }, (_, i) => ({ x: a[i * 3], y: a[i * 3 + 1], z: a[i * 3 + 2] }));
    this.last = { image: unpack(img), world: unpack(wld), right: this.side > 0.5, score: cat?.score ?? 1, aspect: v.videoWidth / v.videoHeight };
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

/** one throwaway frame, so the GPU pipeline is built now rather than mid-gesture */
function warm(lm: HandLandmarker) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  c.getContext('2d')?.fillRect(0, 0, 64, 64);
  lm.detectForVideo(c, 1);
}

/** the front camera, small: hand tracking doesn't need more */
export async function openCamera(): Promise<HTMLVideoElement> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  await v.play();
  return v;
}

export function closeCamera(v: HTMLVideoElement | null) {
  const s = v?.srcObject as MediaStream | null;
  s?.getTracks().forEach((t) => t.stop());
  if (v) v.srcObject = null;
}
