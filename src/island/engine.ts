import { Renderer } from './renderer';
import { Terrain, SEA } from './terrain';
import { Flock, MAX_DODOS } from './dodos';
import { Birds } from './birds';
import { PALETTES, skyPalette, stormy, type Palette } from './palettes';
import { islandSound } from './sound';
import { FaceTracker, openCamera, closeCamera, type FaceRead } from './face/tracker';
import { sound } from '../sound';

type V3 = [number, number, number];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
/** Rodrigues: rotate v about a unit axis k by angle a */
const rotate = (v: V3, k: V3, a: number): V3 => {
  const c = Math.cos(a), s = Math.sin(a);
  const kv = cross(k, v);
  const kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
};

// forest that has to grow before the next dodo hatches (square world units)
const HATCH_AT = [0.25, 0.7, 1.3, 2.1, 3.1, 4.3, 5.7, 7.3, 9.1, 11.1, 13.3];

export interface Expressions {
  smile: boolean;
  frown: boolean;
  closed: boolean;
  blow: boolean;
  roar: boolean;
}

/** where the wind head sits on the screen, as a fraction of its width and height (the App puts it there too) */
export const WIND_HEAD = { x: 0.11, y: 0.22 };

/** things worth writing down in the log, once each */
export type Milestone =
  | 'land'
  | 'fire'
  | 'rain'
  | 'green'
  | 'river'
  | 'egg'
  | 'birds'
  | 'night'
  | 'lavaSea'
  | 'lake'
  | 'half'
  | 'safe'
  | 'face'
  | 'sunshine'
  | 'storm'
  | 'sleep'
  | 'wind'
  | 'roar';

export interface IslandHud {
  /** the face: off, starting up, waiting to see one, or watching it */
  face: 'off' | 'starting' | 'looking' | 'here';
  /** which expressions are showing right now */
  expr: Expressions;
  /** which corner of the sky the wind head blows from */
  windSide: 'left' | 'right';
  day: number;
  dodos: number;
  land: number;
  forest: number;
  raining: boolean;
  intro: number;
  hour: string;
  palette: number;
  pattern: number;
  px: number;
  mode: 'idle' | 'raise' | 'carve' | 'sun' | 'orbit';
}

type Drag =
  | { kind: 'sculpt'; carve: boolean; moved: number; startX: number; startY: number }
  | { kind: 'sun' }
  | { kind: 'orbit'; x: number; y: number }
  | null;

export class IslandEngine {
  private renderer: Renderer;
  readonly terrain = new Terrain();
  readonly flock: Flock;
  readonly birds = new Birds();
  private birdData = new Float32Array(64);
  private nest: [number, number] = [0.15, 0.1];
  private cryAt = 8;

  // camera, orbiting a point on the island
  private yaw = 0.75;
  private pitch = 0.3;
  private dist = 5.2;
  private target: V3 = [0.15, 0.1, 0.1];
  private goal = { yaw: 0.75, pitch: 0.3, dist: 5.2, target: [0.15, 0.1, 0.1] as V3 };
  private cam = { pos: [0, 0, 0] as V3, fwd: [0, 0, -1] as V3, right: [1, 0, 0] as V3, up: [0, 1, 0] as V3 };
  private tanFov = Math.tan((38 * Math.PI) / 180 / 2);

  // the sun you hold: starts low, golden, behind your shoulder
  sun: V3 = norm([0.62, 0.2, -0.55]);
  private sunGoal: V3 = this.sun;

  private pointer = { x: 0, y: 0, inside: false, shift: false };
  private drag: Drag = null;
  private brush = { x: 0, z: 0, r: 0.6, on: 0, strength: 0 };
  private idle = 0;
  /** the opening shot: down through the clouds to the last dodo (0 → 1) */
  intro = 0;
  private hatched = 0;
  private landTimer = 0;
  private growTimer = 0;
  private waterTimer = 0;
  private routeTimer = 0;
  /** smoke and steam over new land: x, base y, z, strength (four at most) */
  private vents: { x: number; y: number; z: number; s: number; live: boolean }[] = [];
  private glow = 0;
  // the face: yours, through the webcam, as the island's weather
  private tracker: FaceTracker | null = null;
  private video: HTMLVideoElement | null = null;
  private faceState: IslandHud['face'] = 'off';
  private faceGen = 0;
  /** the camera went away by itself */
  onFaceLost?: () => void;
  /** a reading to use instead of the camera (tests, and the dev console) */
  debugFace: FaceRead | null = null;
  private expr: Expressions = { smile: false, frown: false, closed: false, blow: false, roar: false };
  private closedFor = 0;
  private roarFor = 0;
  private roarAt: [number, number] | null = null;
  private faceRain = false;
  /** 0..1 while you smile: the clouds part */
  private sunny = 0;
  /** the wind over the island: direction (x, z), strength, how far it has blown */
  private wind = { x: 1, z: 0, s: 0, phase: 0 };
  private windSide: 'left' | 'right' = 'left';
  /** the view, turned by your head as if the island sat behind the glass */
  private look = { yaw: 0, pitch: 0, zoom: 1 };
  private faceSizes: number[] = [];
  private faceNeutral = 0;

  // weather
  private rainHeld = false;
  rain = 0;
  private cloud = 0.25;
  private flash = 0;
  private nextFlash = 2;

  palette = 0;
  pattern = 0;
  /** CSS pixels per printed dot: 2 is fine print (4 device px a dot on a Retina screen) */
  px = 2;
  /** frame-time watch: a slow GPU gets coarser dots rather than a stutter */
  private perf = { n: 0, slow: 0, auto: true };
  private raf = 0;
  private last = performance.now();
  private start = performance.now();
  private hudAt = 0;
  onHud?: (h: IslandHud) => void;
  onHatch?: (n: number) => void;
  /** a first: the first land, the first rain, the first river… */
  onMilestone?: (m: Milestone, day: number, hour: string) => void;
  private reached = new Set<Milestone>();
  private startLand = 0;
  /** days since the story began (the sun's trips through midnight) */
  day = 1;
  private lastHour = 6;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.flock = new Flock(this.terrain);
    this.startLand = this.terrain.landArea;
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => location.reload());
    const q = new URLSearchParams(location.search);
    if (q.has('px')) this.px = clamp(Number(q.get('px')), 1, 8);
    if (q.has('px') || q.has('still')) this.perf.auto = false;
    if (q.has('still') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) this.intro = 1;
  }

  run() {
    this.layout();
    if (import.meta.env.DEV) Object.assign(window, { island: this });
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.disableFace();
  }

  layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.resize(Math.round(window.innerWidth * dpr), Math.round(window.innerHeight * dpr), this.px * dpr);
  }

  setPx(px: number) {
    this.px = clamp(Math.round(px), 1, 8);
    this.perf.auto = false; // the reader chose; leave it be
    this.layout();
  }

  /**
   * Fine dots cost 2.25× the texels of px 3. If frames run long for a few
   * seconds (not just a hitch), step the dots up once, quietly.
   */
  private watchFrames(dt: number) {
    const p = this.perf;
    if (!p.auto || this.intro < 1 || document.hidden) return;
    p.n++;
    if (dt > 1 / 32) p.slow++;
    if (p.n < 150) return;
    if (p.slow > 110 && this.px < 3) {
      this.px++;
      this.layout();
      p.auto = false;
    }
    p.n = p.slow = 0;
  }

  // ------------------------------------------------------------ camera

  private updateCamera(dt: number) {
    const k = 1 - Math.exp(-dt * 6);
    this.yaw += (this.goal.yaw - this.yaw) * k;
    this.pitch += (this.goal.pitch - this.pitch) * k;
    this.dist += (this.goal.dist - this.dist) * k;
    for (let i = 0; i < 3; i++) this.target[i] += (this.goal.target[i] - this.target[i]) * k * 0.7;
    // your head turns the view a little, as if the island sat behind the glass
    const yaw = this.yaw + this.look.yaw;
    const pitch = clamp(this.pitch + this.look.pitch, 0.04, 1.4);
    const dist = this.dist * this.look.zoom;
    const cp = Math.cos(pitch);
    const off: V3 = [Math.sin(yaw) * cp * dist, Math.sin(pitch) * dist, Math.cos(yaw) * cp * dist];
    const pos: V3 = [this.target[0] + off[0], this.target[1] + off[1], this.target[2] + off[2]];
    // never below the waves
    pos[1] = Math.max(pos[1], this.terrain.surface(pos[0], pos[2]) + 0.12);
    const fwd = norm([this.target[0] - pos[0], this.target[1] - pos[1], this.target[2] - pos[2]]);
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    this.cam = { pos, fwd, right, up };
  }

  /** the view ray under a CSS pixel */
  private ray(x: number, y: number): V3 {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const nx = (x / w) * 2 - 1;
    const ny = 1 - (y / h) * 2;
    const { fwd, right, up } = this.cam;
    const a = this.tanFov * (w / h);
    return norm([
      fwd[0] + right[0] * nx * a + up[0] * ny * this.tanFov,
      fwd[1] + right[1] * nx * a + up[1] * ny * this.tanFov,
      fwd[2] + right[2] * nx * a + up[2] * ny * this.tanFov,
    ]);
  }

  private pick(x: number, y: number) {
    return this.terrain.raycast(this.cam.pos, this.ray(x, y));
  }

  // ------------------------------------------------------------ input

  pointerDown(x: number, y: number, button: number, shift: boolean) {
    if (this.intro < 1) this.intro = Math.max(this.intro, 0.9);
    sound.wake();
    islandSound.wake();
    this.idle = 0;
    this.pointer = { x, y, inside: true, shift };
    if (button === 2 || button === 1) {
      this.drag = { kind: 'orbit', x, y };
      return;
    }
    const hit = this.pick(x, y);
    const far = !hit || Math.hypot(hit[0] - this.cam.pos[0], hit[2] - this.cam.pos[2]) > 38;
    if (far) {
      this.drag = { kind: 'sun' };
      this.sunGoal = this.sunFrom(x, y);
      return;
    }
    // a dodo under the finger: say hello instead of sculpting
    const dodo = this.flock.at(hit[0], hit[2], 0.16 + this.dist * 0.012);
    if (dodo) {
      dodo.honk = 1;
      dodo.rest = 1.2;
      islandSound.honk(dodo === this.flock.dodos[0] ? 0.9 : 1 + Math.random() * 0.3);
      this.drag = null;
      return;
    }
    this.drag = { kind: 'sculpt', carve: shift, moved: 0, startX: x, startY: y };
  }

  pointerMove(x: number, y: number, shift: boolean) {
    const dx = x - this.pointer.x;
    const dy = y - this.pointer.y;
    this.pointer = { x, y, inside: true, shift };
    if (this.drag?.kind === 'orbit') {
      this.goal.yaw -= dx * 0.006;
      this.goal.pitch = clamp(this.goal.pitch + dy * 0.004, 0.06, 1.35);
    } else if (this.drag?.kind === 'sun') {
      this.sunGoal = this.sunFrom(x, y);
    } else if (this.drag?.kind === 'sculpt') {
      this.drag.moved += Math.hypot(dx, dy);
      this.drag.carve = shift;
    }
  }

  pointerUp() {
    this.drag = null;
  }

  pointerLeave() {
    this.pointer.inside = false;
    this.drag = null;
  }

  wheel(dy: number) {
    this.idle = 0;
    this.goal.dist = clamp(this.goal.dist * Math.exp(dy * 0.0012), 1.0, 16);
  }

  /** swing round the island (keys, buttons) */
  orbit(dyaw: number, dpitch: number) {
    this.idle = 0;
    this.goal.yaw += dyaw;
    this.goal.pitch = clamp(this.goal.pitch + dpitch, 0.06, 1.35);
  }

  /** fly to a point (double-click) */
  focus(x: number, y: number) {
    const hit = this.pick(x, y);
    if (!hit) return;
    this.goal.target = [hit[0], Math.max(SEA, hit[1]) + 0.05, hit[2]];
    this.goal.dist = Math.max(1.2, this.goal.dist * 0.45);
  }

  home() {
    this.goal = { yaw: this.goal.yaw, pitch: 0.36, dist: 7.5, target: [0, 0.15, 0] };
  }

  /** put the sun where the pointer is in the sky (below the horizon is night) */
  private sunFrom(x: number, y: number): V3 {
    const r = this.ray(x, y);
    return norm([r[0], clamp(r[1], -0.45, 0.98), r[2]]);
  }

  /** hold to make it rain */
  setRain(on: boolean) {
    if (on) {
      sound.wake();
      islandSound.wake();
      this.idle = 0;
    }
    this.rainHeld = on;
  }

  /** lend your face: open the camera and load face tracking, side by side. Returns the video (for the mirror). */
  async enableFace(onStatus?: (s: string) => void): Promise<HTMLVideoElement> {
    if (this.video) return this.video;
    const gen = ++this.faceGen;
    this.faceState = 'starting';
    onStatus?.('Opening the camera…');
    const [cam, trk] = await Promise.allSettled([openCamera(), FaceTracker.create(onStatus)]);
    const cancelled = gen !== this.faceGen;
    if (cancelled || cam.status === 'rejected' || trk.status === 'rejected') {
      if (cam.status === 'fulfilled') closeCamera(cam.value);
      if (trk.status === 'fulfilled') trk.value.dispose();
      if (!cancelled) this.faceState = 'off';
      throw cancelled ? new DOMException('Cancelled', 'AbortError') : cam.status === 'rejected' ? cam.reason : (trk as PromiseRejectedResult).reason;
    }
    const video = cam.value;
    trk.value.attach(video);
    this.video = video;
    this.tracker = trk.value;
    this.faceState = 'looking';
    this.faceSizes = [];
    this.faceNeutral = 0;
    // a camera that goes away (unplugged, revoked, taken by another app) takes the face with it
    const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    track?.addEventListener(
      'ended',
      () => {
        if (this.video !== video) return;
        this.disableFace();
        this.onFaceLost?.();
      },
      { once: true },
    );
    sound.wake();
    islandSound.wake();
    return video;
  }

  /** give the face back (also cancels one that's still starting) */
  disableFace() {
    this.faceGen++;
    this.tracker?.dispose();
    this.tracker = null;
    closeCamera(this.video);
    this.video = null;
    this.faceState = 'off';
  }

  get faceActive() {
    return this.faceState !== 'off' || !!this.debugFace;
  }

  setSunHour(hour: number) {
    // a simple daily arc: rises in the east (+x), sets in the west
    const a = ((hour - 6) / 12) * Math.PI;
    this.sunGoal = norm([Math.cos(a), Math.sin(a) * 0.9, -0.35]);
  }

  // ------------------------------------------------------------ frame

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.frame(performance.now());
  };

  private frame(now: number) {
    const dt = Math.min(1 / 20, (now - this.last) / 1000);
    this.last = now;
    const t = (now - this.start) / 1000;
    this.idle += dt;

    // the opening: start high in the clouds, settle down on the rock
    if (this.intro < 1) {
      this.intro = Math.min(1, this.intro + dt / 6.5);
      const e = 1 - Math.pow(1 - this.intro, 3);
      this.yaw = this.goal.yaw = 0.75 + (1 - e) * 1.4;
      this.pitch = this.goal.pitch = 0.3 + (1 - e) * 1.05;
      this.dist = this.goal.dist = 5.2 + (1 - e) * 14;
      if (this.intro >= 1) islandSound.honk(0.9);
    }
    // the island turns slowly when you leave it alone
    if (!this.drag && this.idle > 6 && this.intro >= 1) this.goal.yaw += dt * 0.035;
    this.updateCamera(dt);

    // left alone, the day goes on: the sun travels its arc (a day is about four minutes)
    if (this.drag?.kind !== 'sun' && this.idle > 3) {
      const axis = norm([0, -0.32, 0.95]);
      const a = dt * ((Math.PI * 2) / 240) * (this.sunGoal[1] < -0.1 ? 2.5 : 1); // nights pass quicker
      this.sunGoal = rotate(this.sunGoal, axis, a);
    }

    // the sun follows the hand, with a little weight
    const sk = 1 - Math.exp(-dt * 8);
    this.sun = norm([this.sun[0] + (this.sunGoal[0] - this.sun[0]) * sk, this.sun[1] + (this.sunGoal[1] - this.sun[1]) * sk, this.sun[2] + (this.sunGoal[2] - this.sun[2]) * sk]);

    // a new day each time the sun passes midnight going forwards
    const hr = this.hours();
    if (this.lastHour > 20 && hr < 4) this.day++;
    this.lastHour = hr;

    // the brush follows the pointer over land and sea
    let hit: V3 | null = null;
    if (this.pointer.inside && this.drag?.kind !== 'orbit' && this.drag?.kind !== 'sun') hit = this.pick(this.pointer.x, this.pointer.y);
    const sculpting = this.drag?.kind === 'sculpt';
    if (hit) {
      this.brush.x = hit[0];
      this.brush.z = hit[2];
    }
    this.brush.r = clamp(0.32 + this.dist * 0.05, 0.3, 1.1);
    this.brush.on += ((hit ? 1 : 0) - this.brush.on) * Math.min(1, dt * 10);
    const want = sculpting ? (this.drag && this.drag.kind === 'sculpt' && this.drag.carve ? -1 : 1) : 0;
    this.brush.strength += (want - this.brush.strength) * Math.min(1, dt * 12);
    this.stepFace(dt, now);
    const roaring = !!this.roarAt;
    const raising = (sculpting && !!hit && this.drag?.kind === 'sculpt' && !this.drag.carve) || roaring;
    // a roar: the mountain answers, pushing up new rock where it stands
    if (this.roarAt) {
      const [rx, rz] = this.roarAt;
      const j = 0.25;
      this.terrain.raise(rx + (Math.random() - 0.5) * j, rz + (Math.random() - 0.5) * j, 0.5, 0.75, dt);
      this.terrain.relax(rx, rz, 0.6, 0.04);
    }
    if (sculpting && hit && this.drag?.kind === 'sculpt') {
      const rate = this.drag.carve ? -0.9 : 0.75;
      this.terrain.raise(this.brush.x, this.brush.z, this.brush.r, rate, dt);
      this.terrain.relax(this.brush.x, this.brush.z, this.brush.r * 1.2, 0.04);
      this.idle = 0;
    }
    islandSound.rumble(roaring ? 1 : sculpting && hit ? (this.drag?.kind === 'sculpt' && this.drag.carve ? -1 : 1) : 0);
    this.stepVents(dt, raising, this.roarAt);
    this.milestones(raising);

    // weather: rain gathers quickly and clears slowly; storms throw lightning
    const wet = this.rainHeld || this.faceRain;
    this.rain += ((wet ? 1 : 0) - this.rain) * Math.min(1, dt * (wet ? 2.2 : 0.5));
    // a smile parts the clouds
    this.sunny += ((this.expr.smile ? 1 : 0) - this.sunny) * Math.min(1, dt * 1.5);
    this.cloud += (0.25 * (1 - 0.85 * this.sunny) + 0.75 * Math.max(this.rain, wet ? 1 : 0) - this.cloud) * Math.min(1, dt * 1.2);
    this.flash = Math.max(0, this.flash - dt * 5);
    if (this.rain > 0.6) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flash = 1;
        this.nextFlash = 1.5 + Math.random() * 5;
        islandSound.thunder(0.3 + Math.random() * 1.1);
      }
    }
    islandSound.rain(this.rain);
    islandSound.wind(this.wind.s);

    // the forest grows where it rains
    this.growTimer -= dt;
    if (this.growTimer <= 0) {
      this.growTimer = 0.25;
      this.terrain.grow(0.25, this.rain);
    }
    // water finds its way down to the sea, and lava cools (ten times a second)
    this.waterTimer -= dt;
    this.routeTimer -= dt;
    if (this.waterTimer <= 0) {
      this.waterTimer = 0.1;
      if (this.terrain.reshaped && this.routeTimer <= 0) {
        this.terrain.route();
        this.routeTimer = 0.4;
      }
      this.terrain.flow(0.1, this.rain);
      this.glow = this.terrain.cool(0.1);
    }
    islandSound.lava(raising ? 1 : 0, this.glow);
    if (this.terrain.vegDirty) {
      this.renderer.uploadLand(this.terrain, [0, 0, 255, 255]);
      this.terrain.vegDirty = false;
      this.terrain.dirty = null;
    } else if (this.terrain.dirty) {
      this.renderer.uploadLand(this.terrain, this.terrain.dirty);
      this.terrain.dirty = null;
    }

    // more land, more dodos
    this.landTimer -= dt;
    if (this.landTimer <= 0) {
      this.landTimer = 0.4;
      this.terrain.countLand();
      this.nest = this.terrain.centre;
      const area = this.terrain.forestArea;
      while (this.hatched < HATCH_AT.length && area > HATCH_AT[this.hatched] && this.flock.count < MAX_DODOS) {
        const spot = this.flock.spot();
        if (!spot) break;
        this.flock.hatch(spot[0], spot[1]);
        this.hatched++;
        islandSound.hatch();
        this.onHatch?.(this.flock.count);
      }
    }
    if (this.flock.step(dt) > 0) islandSound.honk(1.15 + Math.random() * 0.2);

    // seabirds come to nest once there's forest, one for every patch of it
    const day = Math.min(1, Math.max(0, (this.sun[1] + 0.1) / 0.3));
    this.birdData = this.birds.step(dt, t, Math.floor(this.terrain.forestArea * 1.4), this.nest, day);
    this.cryAt -= dt;
    if (this.cryAt <= 0) {
      this.cryAt = 5 + Math.random() * 12;
      if (this.birds.count > 0 && day > 0.5) islandSound.cry(this.dist);
    }

    islandSound.ambience(this.dist, this.sun[1]);

    this.render(t);
    this.watchFrames(dt);
    this.emitHud(now);
  }

  private mark(m: Milestone, when = true) {
    if (!when || this.reached.has(m) || this.intro < 1) return;
    this.reached.add(m);
    this.onMilestone?.(m, this.day, this.hour());
  }

  private milestones(raising: boolean) {
    const T = this.terrain;
    this.mark('fire', raising);
    this.mark('land', T.landArea > this.startLand + 0.5);
    this.mark('rain', this.rain > 0.5);
    this.mark('green', T.forestArea > 0.3);
    this.mark('river', T.riverCells > 25);
    this.mark('egg', this.flock.count > 1);
    this.mark('birds', this.birds.count > 0 && this.reached.has('egg'));
    this.mark('night', this.sun[1] < -0.12);
    this.mark('lavaSea', !!T.steam);
    this.mark('lake', T.lakeCells > 8);
    this.mark('half', T.landArea > 2 && T.forestArea > T.landArea * 0.5);
    this.mark('safe', this.flock.count >= MAX_DODOS);
  }

  /** a plume rises where you push land up; it drifts and thins after you let go */
  private stepVents(dt: number, raising: boolean, at: [number, number] | null = null) {
    let live = this.vents.find((v) => v.live);
    if (raising) {
      const [bx, bz] = at ?? [this.brush.x, this.brush.z];
      if (!live || Math.hypot(live.x - bx, live.z - bz) > this.brush.r * 1.6) {
        if (live) live.live = false;
        live = { x: bx, y: 0, z: bz, s: 0, live: true };
        this.addVent(live);
      }
      const k = 1 - Math.exp(-dt * 5);
      live.x += (bx - live.x) * k;
      live.z += (bz - live.z) * k;
      live.s = Math.min(1, live.s + dt * 0.9);
    } else if (live) {
      live.live = false;
    }
    // where lava pours into the sea, steam boils up
    const st = this.terrain.steam;
    if (st) {
      let v = this.vents.find((v) => !v.live && Math.hypot(v.x - st[0], v.z - st[1]) < 0.7);
      if (!v) this.addVent((v = { x: st[0], y: 0, z: st[1], s: 0, live: false }));
      v.s = Math.min(0.75, Math.max(v.s, v.s + dt * 1.5 * st[2]));
    }
    for (const v of this.vents) {
      v.y = this.terrain.surface(v.x, v.z);
      if (!v.live) v.s -= dt * 0.16;
    }
    this.vents = this.vents.filter((v) => v.s > 0);
  }

  private addVent(v: IslandEngine['vents'][number]) {
    this.vents.push(v);
    if (this.vents.length > 4) {
      // drop the faintest plume that isn't under your hand
      let weakest = -1;
      this.vents.forEach((o, i) => {
        if (o !== v && !o.live && (weakest < 0 || o.s < this.vents[weakest].s)) weakest = i;
      });
      this.vents.splice(weakest < 0 ? 0 : weakest, 1);
    }
  }

  private ventUniform() {
    const out = new Float32Array(16);
    this.vents.forEach((v, i) => out.set([v.x, v.y, v.z, v.s], i * 4));
    return out;
  }

  /** your face, read as weather: smile, frown, close your eyes, blow, roar; and your head turns the view */
  private stepFace(dt: number, now: number) {
    const f = this.debugFace ?? this.tracker?.detect(now) ?? null;
    if (this.tracker) this.faceState = f ? 'here' : 'looking';
    const e = this.expr;
    const k = 1 - Math.exp(-dt * 3);
    if (!f) {
      e.smile = e.frown = e.closed = e.blow = e.roar = false;
      this.closedFor = this.roarFor = 0;
      this.faceRain = false;
      this.roarAt = null;
      this.look.yaw += -this.look.yaw * k;
      this.look.pitch += -this.look.pitch * k;
      this.look.zoom += (1 - this.look.zoom) * k;
    } else {
      if (this.intro >= 1) this.mark('face');
      const was = { ...e };
      // the wind head appears on the side of the sky your face is on (and stays while you blow)
      if (!e.blow) this.windSide = f.head.x < 0 ? 'left' : 'right';
      // a little hysteresis, so an expression doesn't flicker on and off at the threshold
      e.smile = e.smile ? f.smile > 0.32 : f.smile > 0.5;
      e.frown = !e.smile && (e.frown ? f.frown > 0.25 : f.frown > 0.42);
      e.blow = e.blow ? f.blow > 0.28 : f.blow > 0.42;
      // a blink is not a sleep
      this.closedFor = f.closed > 0.55 ? this.closedFor + dt : 0;
      e.closed = this.closedFor > 0.35;
      this.roarFor = f.roar > 0.55 && !e.smile ? this.roarFor + dt : 0;
      e.roar = this.roarFor > 0.45;

      // a smile: the clouds part, and at night the sun comes up for you
      if (e.smile && !was.smile) {
        if (this.sun[1] < 0.08) this.setSunHour(7.6);
        this.flock.startle(0.5);
        islandSound.honk(1.25);
        if (this.birds.count > 0) islandSound.cry(this.dist);
        this.mark('sunshine');
      }
      // a frown: the sky darkens and it pours
      if (e.frown && !was.frown) {
        this.flock.startle(0.8);
        this.mark('storm');
      }
      this.faceRain = e.frown;
      // eyes closed a moment: night falls (you open them to the stars)
      if (e.closed && !was.closed) {
        this.setSunHour(23.3);
        this.mark('sleep');
      }
      if (e.blow && !was.blow) {
        islandSound.whoosh();
        this.mark('wind');
      }
      if (e.roar && !was.roar) {
        this.roarAt = this.roarSpot();
        this.flock.startle(1);
        this.mark('roar');
      }
      if (!e.roar) this.roarAt = null;

      // your head: the island sits behind the glass. Where your face first settles is
      // the middle; lean in to look closer
      if (this.faceNeutral === 0 && Number.isFinite(f.head.size)) {
        this.faceSizes.push(f.head.size);
        if (this.faceSizes.length >= 30) this.faceNeutral = [...this.faceSizes].sort((a, b) => a - b)[15];
      }
      const lean = this.faceNeutral ? clamp(Math.log(f.head.size / this.faceNeutral), -0.5, 0.5) : 0;
      this.look.yaw += (clamp(f.head.x, -1, 1) * 0.42 - this.look.yaw) * k;
      this.look.pitch += (clamp(f.head.y, -1, 1) * 0.16 - this.look.pitch) * k;
      this.look.zoom += (Math.exp(-lean * 0.9) - this.look.zoom) * k;
    }
    // the wind blows while you blow, then dies away
    const want = e.blow && f ? clamp(f.blow * 1.5, 0.45, 1) : 0;
    this.wind.s += (want - this.wind.s) * Math.min(1, dt * (want > this.wind.s ? 3 : 0.7));
    // from the wind head's corner, across the island
    const right = norm([this.cam.right[0], 0, this.cam.right[2]]);
    const away = norm([this.cam.fwd[0], 0, this.cam.fwd[2]]);
    const side = this.windSide === 'left' ? 1 : -1;
    const dir = norm([right[0] * side * 0.85 + away[0] * 0.5, 0, right[2] * side * 0.85 + away[2] * 0.5]);
    this.wind.x = dir[0];
    this.wind.z = dir[2];
    this.wind.phase += this.wind.s * dt * 0.8;
  }

  /** where a roar breaks out: the island's highest ground near its middle, or the middle of the sea */
  private roarSpot(): [number, number] {
    const [cx, cz] = this.nest;
    let best: [number, number] = [cx, cz];
    let top = -Infinity;
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.2;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const h = this.terrain.sample(x, z) - r * 0.15;
      if (h > top) {
        top = h;
        best = [x, z];
      }
    }
    return best;
  }

  /** the wind for the shader: over the world, and where on the print its head blows from */
  private windUniforms() {
    const [w, h] = this.renderer.worldSize;
    const hx = (this.windSide === 'left' ? WIND_HEAD.x : 1 - WIND_HEAD.x) * w;
    const hy = (1 - WIND_HEAD.y) * h;
    // it blows towards the island, as it appears on the print
    const n = this.nest;
    const d: V3 = [n[0] - this.cam.pos[0], 0.3 - this.cam.pos[1], n[1] - this.cam.pos[2]];
    const z = Math.max(0.2, d[0] * this.cam.fwd[0] + d[1] * this.cam.fwd[1] + d[2] * this.cam.fwd[2]);
    const aspect = w / h;
    const ix = ((d[0] * this.cam.right[0] + d[1] * this.cam.right[1] + d[2] * this.cam.right[2]) / (z * this.tanFov * aspect) * 0.5 + 0.5) * w;
    const iy = ((d[0] * this.cam.up[0] + d[1] * this.cam.up[1] + d[2] * this.cam.up[2]) / (z * this.tanFov) * 0.5 + 0.5) * h;
    let dx = ix - hx, dy = iy - hy;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    return { uWind: [this.wind.x, this.wind.z, this.wind.s, this.wind.phase], uWindHead: [hx, hy, dx, dy] };
  }

  private currentPalette(): Palette {
    if (this.palette !== 0) return PALETTES[this.palette];
    const p = skyPalette(this.sun[1], this.sun[0] > 0);
    return this.rain > 0.01 ? stormy(p, this.rain) : p;
  }

  private render(t: number) {
    const dodos = this.flock.pack(t);
    const pal = this.currentPalette();
    this.renderer.draw(
      {
        uTime: t,
        uCamPos: this.cam.pos,
        uCamRight: this.cam.right,
        uCamUp: this.cam.up,
        uCamFwd: this.cam.fwd,
        uTanFov: this.tanFov,
        uSun: this.sun,
        uBrush: [this.brush.x, this.brush.z, this.brush.r, this.brush.strength],
        uBrushOn: this.brush.on * (this.drag?.kind === 'sun' ? 0 : 1),
        uDodo: dodos.pos,
        uDodoAnim: dodos.anim,
        uRain: this.rain,
        uFlash: this.flash,
        uCloud: Math.max(this.cloud, (1 - this.intro) * 1.2),
        uIntro: this.intro,
        uVent: this.ventUniform(),
        uBird: this.birdData,
        ...this.windUniforms(),
      },
      {
        uPx: this.canvas.width / this.renderer.worldSize[0],
        uRamp: pal.ramps.flat(),
        uSteps: pal.steps,
        uAccent: pal.accent,
        uPattern: this.pattern,
        uOutline: 1,
        uLift: pal.lift,
      },
    );
  }

  /** the hour of day (0–24) from where the sun is */
  private hours() {
    const a = Math.atan2(this.sun[1], this.sun[0]); // 0 east horizon, π/2 overhead, π west
    const h = 6 + (a / Math.PI) * 12;
    return ((h % 24) + 24) % 24;
  }

  /** "06:40" from where the sun is */
  hour(): string {
    const h = this.hours();
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  private emitHud(now: number) {
    if (now - this.hudAt < 150) return;
    this.hudAt = now;
    const d = this.drag;
    this.onHud?.({
      face: this.debugFace ? 'here' : this.faceState,
      expr: { ...this.expr },
      windSide: this.windSide,
      day: this.day,
      dodos: this.flock.count,
      land: this.terrain.landArea,
      forest: this.terrain.forestArea,
      raining: this.rainHeld,
      intro: this.intro,
      hour: this.hour(),
      palette: this.palette,
      pattern: this.pattern,
      px: this.px,
      mode: !d ? 'idle' : d.kind === 'sculpt' ? (d.carve ? 'carve' : 'raise') : d.kind,
    });
  }

  /** key and paper of the inks on the island right now (for the camera mirror) */
  mirrorInks(): { ink: [number, number, number]; paper: [number, number, number] } {
    const p = this.currentPalette();
    return { ink: p.inks[0], paper: p.inks[3] };
  }

  /** paper and ink for a mounted plate: the Day palette always prints on cream */
  plateInks(): { paper: [number, number, number]; ink: [number, number, number] } {
    if (this.palette === 0) return { paper: [0.949, 0.925, 0.863], ink: [0.078, 0.086, 0.102] };
    const p = PALETTES[this.palette];
    return { paper: p.inks[3], ink: p.inks[0] };
  }

  /** the print as it is this moment, copied out of the GL canvas */
  snapshot(): HTMLCanvasElement {
    this.render((performance.now() - this.start) / 1000);
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    c.getContext('2d')!.drawImage(this.canvas, 0, 0);
    return c;
  }
}
