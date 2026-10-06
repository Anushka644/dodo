// Shared contracts between the modules of the hand-tracked version.
// Everything here is types only — implementations live in sense/, physics/, gl/.
//
// WORLD SPACE
//   Right-handed, y up, z toward the viewer. 1 unit = the height of one
//   banknote (a note is ASPECT ≈ 2.2857 units wide). The camera looks down -z
//   at the plane z = 0, which spans roughly 4.2 units vertically.
//
// SCREEN SPACE (for hands)
//   Normalised [0,1]², origin top-left, y down, ALREADY MIRRORED so it matches
//   the selfie-mirrored video that is drawn full-screen (cover-fitted).
//   The engine converts screen space → world rays.

export type V2 = [number, number];
export type V3 = [number, number, number];

// ------------------------------------------------------------------ sense

export interface Landmark {
  /** normalised video x, mirrored (0 = left of the mirrored image) */
  x: number;
  /** normalised video y, 0 = top */
  y: number;
  /** MediaPipe relative depth (wrist-relative, roughly same scale as x) */
  z: number;
}

export interface TrackedHand {
  /** stable-ish slot id while the hand stays in view */
  id: number;
  handedness: 'Left' | 'Right';
  score: number;
  /** 21 landmarks in normalised VIDEO space (mirrored), One-Euro smoothed */
  landmarks: Landmark[];
  /** 21 landmarks in metres, hand-centred (MediaPipe worldLandmarks), mirrored on x */
  world: V3[];
}

export interface HandsFrame {
  /** performance.now() of the video frame */
  t: number;
  hands: TrackedHand[];
}

export type Pose = 'none' | 'open' | 'pinch' | 'point' | 'fist' | 'rub';

export interface HandGesture {
  id: number;
  handedness: 'Left' | 'Right';
  /** debounced dominant pose */
  pose: Pose;
  /** palm centre (avg of landmarks 0,5,9,13,17) in normalised video space */
  palm: V2;
  /** palm length |lm0 - lm9| in normalised video units (≈ distance cue: bigger = closer) */
  palmSize: number;
  /** unit palm normal in a camera frame (x right, y up, z toward the viewer), from world landmarks */
  palmNormal: V3;
  /** unit vector along the hand (wrist → middle-finger MCP) in the same frame */
  palmUp: V3;
  /** palm velocity in normalised video units per second (smoothed) */
  velocity: V2;
  pinch: {
    /** hysteresis-latched pinch state */
    active: boolean;
    /** 0..1, 1 = fingertips touching */
    strength: number;
    /** midpoint of thumb tip (4) and index tip (8), normalised video space */
    point: V2;
  };
  point: {
    /** index extended, middle/ring/pinky curled */
    active: boolean;
    /** index fingertip (8) */
    tip: V2;
    /** unit direction index PIP(6) → tip(8) in normalised video space */
    dir: V2;
  };
  /** all four fingers curled */
  fist: boolean;
  /** all four fingers extended */
  open: boolean;
  rub: {
    /** the "money" gesture: thumb rubbing back and forth across index/middle fingertips */
    active: boolean;
    /** 0..1 how vigorous */
    intensity: number;
    /** where the money comes out: between thumb tip and index/middle tips */
    point: V2;
  };
}

/** Wraps MediaPipe HandLandmarker. One detect() per new video frame. */
export interface HandSensorApi {
  /** returns a frame only when the video has a new frame; null otherwise */
  detect(nowMs: number): HandsFrame | null;
  dispose(): void;
}

export interface GestureTrackerApi {
  /** feed every new frame; returns one HandGesture per tracked hand */
  update(frame: HandsFrame): HandGesture[];
  reset(): void;
}

// ------------------------------------------------------------------ physics

export type Collider =
  /** a flat disk, e.g. the palm: particles are pushed to its front side (along normal) */
  | { kind: 'disk'; center: V3; normal: V3; radius: number; friction: number }
  | { kind: 'sphere'; center: V3; radius: number; friction: number };

export interface PaperEnv {
  gravity: V3;
  /** ambient air velocity (breeze) */
  wind: V3;
  colliders: Collider[];
  /** sheets come to rest on this plane */
  floorY: number;
}

export interface SheetOptions {
  cols: number;
  rows: number;
  /** world size of the flat sheet; defaults ASPECT × 1 */
  width?: number;
  height?: number;
}

/**
 * A banknote as a Verlet particle grid.
 * Particle (i, j): i = column 0..cols-1 (left → right of the note's face),
 * j = row 0..rows-1 (TOP → BOTTOM of the note's face). Index = j * cols + i.
 * UV for particle (i, j) = (i/(cols-1) * ASPECT, j/(rows-1)) — note space,
 * so the existing banknote shader can be evaluated on the mesh directly.
 * The front face is the side the normals point out of when the sheet is laid
 * flat facing +z (counter-clockwise winding seen from +z).
 */
export interface PaperSheetApi {
  readonly cols: number;
  readonly rows: number;
  readonly count: number;
  /** xyz per particle, world space */
  readonly positions: Float32Array;
  /** xyz per particle, unit vertex normals (front face) — valid after step() */
  readonly normals: Float32Array;
  /** uv per particle (note space), constant */
  readonly uvs: Float32Array;
  /** triangle indices, constant */
  readonly indices: Uint16Array;
  /** 0..1 how crumpled it has ever been (paper remembers creases); drives wrinkle normals in the shader */
  wrinkle: number;

  /** lay it flat: centre, unit right (+u) and unit up (−v) vectors; zero velocity */
  placeFlat(center: V3, right: V3, up: V3): void;
  /** set every particle's velocity (via prev positions) */
  setVelocity(v: V3, spin?: V3): void;
  /** kinematically pin a particle to a target each step (strength 0..1, 1 = hard) */
  pin(index: number, target: V3, strength?: number): void;
  unpin(index: number): void;
  unpinAll(): void;
  /**
   * Soft-attach the whole sheet to a rigid pose (e.g. resting on a palm or held flat):
   * each particle is pulled toward where it would be in that pose. weight 0..1.
   */
  attach(center: V3, right: V3, up: V3, weight: number): void;
  detach(): void;
  /** squeeze the sheet toward a point (a fist). amount 0..1; raises `wrinkle` */
  crumple(center: V3, amount: number): void;
  /** nearest particle to a world point */
  nearest(p: V3): { index: number; dist: number };
  centroid(): V3;
  step(dt: number, env: PaperEnv): void;
}

// ------------------------------------------------------------------ sound

export interface PaperSoundsApi {
  /** paper flutter loop; call every frame with the fastest sheet's speed (world units/s); 0 silences */
  flutter(speed: number): void;
  /** banknote counter "brrrrt" while printing; intensity 0..1, 0 stops */
  counter(intensity: number): void;
  grab(): void;
  release(): void;
  /** a note lands in the palm */
  catchNote(): void;
  /** crumpling crackle; amount 0..1 per call (call while squeezing) */
  crumple(amount: number): void;
  /** a taut note slipping out of a grip */
  snap(): void;
}
