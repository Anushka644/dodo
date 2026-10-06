import { Renderer3D, type SheetDraw, type UniformValue } from './gl/renderer3d';
import { lookAt, multiply, perspective, project, type Mat4 } from './gl/mat4';
import { ASPECT } from './note/layout';
import { Plates, drawMicro, loadFonts } from './note/plates';
import { drawDodo } from './note/dodo';
import { mint, type Issue } from './note/seed';
import { PaperSheet, GRAVITY } from './physics/paper';
import type { HandSensor } from './sense/hands';
import { GestureTracker } from './sense/gestures';
import { paperSound } from './paperSound';
import { sound } from './sound';
import type { Collider, HandGesture, PaperEnv, Pose, V2, V3 } from './contracts';

// ------------------------------------------------------------------ world

const FOV = (32 * Math.PI) / 180;
const EYE: V3 = [0, 0.35, 8];
const TARGET: V3 = [0, 0, 0];
const HALF_H = Math.tan(FOV / 2) * EYE[2]; // half the visible height at z = 0
const NOTE_H = 1; // world height of a banknote
const HERO_GRID: [number, number] = [34, 15];
const RAIN_GRID: [number, number] = [18, 8];
const MAX_RAIN = 44;
const PICK_RADIUS = 0.09; // fraction of screen height

const lin = (rgb: [number, number, number]) => rgb.map((c) => Math.pow(c, 2.2));
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export type Mode = 'intro' | 'mouse' | 'camera';

interface Note {
  id: number;
  sheet: PaperSheet;
  hero: boolean;
  uniforms: Record<string, UniformValue>;
  print: number;
  rest: number; // seconds lying still on the floor
  dying: number; // > 0 while sinking away
  holds: { hand: number; pin: number; since: number }[]; // pinches holding it (two hands can share one)
  carriedBy: number | null; // hand id it rests on (-1 = the stand)
  carry: number; // 0..1 attach weight, ramps up so it flies to the palm
  crumple: number;
  selected: number;
  backlight: number;
}

/** What a hand (or the mouse) is doing, already in world space. */
interface Hand {
  id: number;
  pose: Pose;
  palm: V3;
  normal: V3;
  up: V3;
  pinch: V3;
  pinchScreen: V2;
  tip: V3;
  tipDir: V3;
  rub: V3;
  rubIntensity: number;
  pinching: boolean;
  open: boolean;
  fist: boolean;
  openFor: number;
  printDebt: number;
  torch: number;
}

export interface HudState {
  mode: Mode;
  hands: number;
  poses: Pose[];
  printed: number;
  tracking: 'off' | 'loading' | 'on' | 'error';
  loadingMsg: string;
  holding: boolean;
}

export class Engine {
  private renderer: Renderer3D;
  private plates!: Plates;
  private notes: Note[] = [];
  private nextId = 1;
  private hero!: Note;
  private issueTarget: Issue = mint('');
  private printedCount = 0;

  mode: Mode = 'intro';
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private sensor: HandSensor | null = null;
  private gestures = new GestureTracker();
  private hands = new Map<number, Hand>();
  private tracking: HudState['tracking'] = 'off';
  private loadingMsg = '';
  private injected: HandGesture[] | null = null;

  // the mouse, standing in for a hand
  private mouse = { x: 0.5, y: 0.5, down: false, inside: false, print: false, torch: false, crumple: false, depth: 1.2 };
  private standTilt: V2 = [0, 0];
  private standLift = 0.55;

  private viewProj!: Mat4;
  private aspect = 1;
  private scaleRes = 1;
  private frameTimes: number[] = [];
  private raf = 0;
  private last = performance.now();
  private start = performance.now();
  private room = 1;
  private glow = 0;
  private uvHum = false;
  private videoFade = 0;
  private reprintTimer = 0;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  onHud?: (s: HudState) => void;
  private hudAt = 0;
  overlay: CanvasRenderingContext2D | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new Renderer3D(canvas);
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => location.reload());
  }

  async init() {
    await loadFonts();
    this.plates = new Plates();
    this.plates.issue(this.issueTarget);
    for (const name of ['ink', 'ovi', 'uv', 'water', 'back', 'red'] as const) {
      this.renderer.setPlate(name, this.plates.canvas(name));
    }
    this.renderer.setMicro(drawMicro());
    this.renderer.setPortrait(drawDodo());
    this.layout();
    this.hero = this.spawn(true);
    this.hero.print = this.reducedMotion || new URLSearchParams(location.search).has('still') ? 1 : 0;
    this.placeOnStand(this.hero, true);
    if (import.meta.env.DEV) (window as unknown as { engine: Engine }).engine = this;
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.stopCamera();
  }

  // ------------------------------------------------------------ layout

  layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.aspect = w / h;
    let s = dpr * this.scaleRes;
    const maxPixels = 2560 * 1440;
    if (w * h * s * s > maxPixels) s = Math.sqrt(maxPixels / (w * h));
    this.renderer.resize(Math.round(w * s), Math.round(h * s));
    if (this.overlay) {
      this.overlay.canvas.width = Math.round(w * dpr);
      this.overlay.canvas.height = Math.round(h * dpr);
    }
    const proj = perspective(FOV, this.aspect, 0.5, 40);
    this.viewProj = multiply(proj, lookAt(EYE, TARGET, [0, 1, 0]));
  }

  private get floorY() {
    return -HALF_H + 0.12;
  }

  /** cover-fit scale between the viewport and the camera image */
  private videoScale(): V2 {
    const v = this.video;
    if (!v || !v.videoWidth) return [1, 1];
    const va = v.videoWidth / v.videoHeight;
    return this.aspect > va ? [1, va / this.aspect] : [this.aspect / va, 1];
  }

  /** mirrored video coords → viewport coords (both normalised, y down) */
  private videoToScreen(p: V2): V2 {
    const [sx, sy] = this.videoScale();
    return [(p[0] - 0.5) / sx + 0.5, (p[1] - 0.5) / sy + 0.5];
  }

  /** the world point under a viewport position, at depth z */
  private screenToWorld(s: V2, z: number): V3 {
    const tanH = Math.tan(FOV / 2);
    const cx = (s[0] * 2 - 1) * tanH * this.aspect;
    const cy = (1 - s[1] * 2) * tanH;
    const fwd = norm(sub(TARGET, EYE));
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    const d = norm(add(add(scale(right, cx), scale(up, cy)), fwd));
    const t = (z - EYE[2]) / d[2];
    return add(EYE, scale(d, t));
  }

  private worldToScreen(p: ArrayLike<number>, i = 0): V3 {
    const n = project(this.viewProj, p, i);
    return [(n[0] + 1) / 2, (1 - n[1]) / 2, n[2]];
  }

  // ------------------------------------------------------------ notes

  private spawn(hero: boolean): Note {
    const [cols, rows] = hero ? HERO_GRID : RAIN_GRID;
    const sheet = new PaperSheet({ cols, rows, width: NOTE_H * ASPECT, height: NOTE_H });
    const issue = hero ? this.issueTarget : mint(`${this.issueTarget.name}#${this.printedCount}`);
    const note: Note = {
      id: this.nextId++,
      sheet,
      hero,
      uniforms: {},
      print: 1,
      rest: 0,
      dying: 0,
      holds: [],
      carriedBy: null,
      carry: 0,
      crumple: 0,
      selected: 0,
      backlight: 0,
    };
    this.applyIssue(note, issue);
    this.notes.push(note);
    return note;
  }

  private applyIssue(note: Note, issue: Issue) {
    Object.assign(note.uniforms, {
      uRosA: issue.rosA,
      uRosB: issue.rosB,
      uBand: issue.band,
      uField: issue.field,
      uInk: lin(issue.ink),
      uIris0: lin(issue.iris[0]),
      uIris1: lin(issue.iris[1]),
      uIris2: lin(issue.iris[2]),
    });
  }

  /** with no hand to hold it, the hero waits in mid-air, turning toward the pointer */
  private standPose(): { c: V3; r: V3; u: V3 } {
    const [tx, ty] = this.standTilt;
    const t = (performance.now() - this.start) / 1000;
    // during the invitation the note floats higher, clear of the card
    this.standLift += ((this.mode === 'intro' ? 0.55 : 0) - this.standLift) * 0.05;
    const c: V3 = [0, 0.3 + this.standLift + Math.sin(t * 0.9) * 0.05, 2.7];
    const yaw = tx * 0.6 + Math.sin(t * 0.45) * 0.06;
    const pitch = ty * 0.45 + Math.sin(t * 0.7) * 0.03;
    const r: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const u: V3 = norm([0, Math.cos(pitch), Math.sin(pitch)]);
    return { c, r, u };
  }

  private placeOnStand(note: Note, snap: boolean) {
    const { c, r, u } = this.standPose();
    if (snap) note.sheet.placeFlat(c, r, u);
    note.carriedBy = -1;
    note.carry = snap ? 1 : 0;
  }

  /** let go with one hand (or every hand) */
  private release(note: Note, hand?: number) {
    for (const h of note.holds) if (hand === undefined || h.hand === hand) note.sheet.unpin(h.pin);
    note.holds = hand === undefined ? [] : note.holds.filter((h) => h.hand !== hand);
  }

  private held(note: Note) {
    return note.holds.length > 0;
  }

  private drop(note: Note) {
    note.carriedBy = null;
    note.carry = 0;
    note.sheet.detach();
  }

  /** the note (and particle) nearest a screen point, if it's within reach */
  private pick(s: V2, hand: number): { note: Note; index: number } | null {
    let best: { note: Note; index: number } | null = null;
    let bestD = PICK_RADIUS;
    for (const note of this.notes) {
      if (note.dying > 0 || note.holds.some((h) => h.hand === hand)) continue;
      const pos = note.sheet.positions;
      for (let i = 0; i < note.sheet.count; i += 2) {
        const sp = this.worldToScreen(pos, i * 3);
        const d = Math.hypot((sp[0] - s[0]) * this.aspect, sp[1] - s[1]);
        if (d < bestD) {
          bestD = d;
          best = { note, index: i };
        }
      }
    }
    return best;
  }

  private printOne(at: V3) {
    const rain = this.notes.filter((n) => !n.hero && n.dying === 0);
    if (rain.length >= MAX_RAIN) {
      // the oldest note in circulation is withdrawn
      const old = rain.find((n) => !this.held(n) && n.carriedBy === null) ?? rain[0];
      old.dying = 0.001;
    }
    this.printedCount++;
    const note = this.spawn(false);
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const yaw = rnd(-0.7, 0.7);
    const r = norm([Math.cos(yaw), rnd(-0.5, 0.5), Math.sin(yaw)]);
    const u = norm(cross([rnd(-0.3, 0.3), rnd(-0.3, 0.3), 1], r));
    note.sheet.placeFlat(add(at, [rnd(-0.12, 0.12), rnd(-0.08, 0.08), rnd(-0.1, 0.1)]), r, u);
    note.sheet.setVelocity([rnd(-1.8, 1.8), rnd(0.8, 2.8), rnd(0.2, 1.6)], [rnd(-4, 4), rnd(-4, 4), rnd(-4, 4)]);
  }

  // ------------------------------------------------------------ camera

  async startCamera(): Promise<boolean> {
    if (this.tracking === 'loading' || this.tracking === 'on') return true;
    sound.wake();
    this.tracking = 'loading';
    this.loadingMsg = 'Asking for the camera…';
    this.emitHud(true);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 } },
        audio: false,
      });
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = this.stream;
      await v.play();
      this.video = v;
      this.mode = 'camera';
      this.loadingMsg = 'Warming up the press…';
      this.emitHud(true);
      // MediaPipe is heavy: only load it once you've chosen to use your hands
      const { HandSensor } = await import('./sense/hands');
      this.sensor = await HandSensor.create(v, (msg) => {
        this.loadingMsg = msg;
        this.emitHud(true);
      });
      this.tracking = 'on';
      this.emitHud(true);
      return true;
    } catch (err) {
      console.warn(err);
      const hadCamera = !!this.stream;
      this.tracking = 'error';
      this.loadingMsg = hadCamera ? 'Hand tracking could not start — the mouse will do.' : 'No camera — the mouse will do.';
      this.stopCamera();
      this.mode = 'mouse';
      this.emitHud(true);
      return false;
    }
  }

  stopCamera() {
    this.sensor?.dispose();
    this.sensor = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    for (const [id] of this.hands) if (id >= 0) this.letGo(id);
    if (this.tracking !== 'error') this.tracking = 'off';
  }

  useMouse() {
    this.mode = 'mouse';
    this.emitHud(true);
  }

  // ------------------------------------------------------------ pointer

  pointer(x: number, y: number, down: boolean | null) {
    this.mouse.x = x / window.innerWidth;
    this.mouse.y = y / window.innerHeight;
    this.mouse.inside = true;
    if (down !== null) this.mouse.down = down;
    this.standTilt = [(this.mouse.x - 0.5) * 2, (this.mouse.y - 0.5) * 2];
  }

  pointerLeave() {
    this.mouse.inside = false;
    this.mouse.down = false;
  }

  setPrinting(on: boolean) {
    if (on) sound.wake();
    this.mouse.print = on;
  }

  setTorch(on: boolean) {
    if (on) sound.wake();
    this.mouse.torch = on;
  }

  setCrumple(on: boolean) {
    this.mouse.crumple = on;
  }

  wheel(delta: number) {
    this.mouse.depth = clamp(this.mouse.depth - delta * 0.004, -1.5, 4.5);
  }

  /** bring the hero back to where you can see it */
  summon() {
    const h = this.hero;
    this.release(h);
    h.sheet.unpinAll();
    h.crumple = 0;
    h.rest = 0;
    this.placeOnStand(h, false);
  }

  setName(name: string) {
    const next = mint(name);
    if (next.serial === this.issueTarget.serial && next.name === this.issueTarget.name) return;
    this.issueTarget = next;
    this.applyIssue(this.hero, next);
    window.clearTimeout(this.reprintTimer);
    this.reprintTimer = window.setTimeout(() => {
      for (const p of this.plates.issue(this.issueTarget)) this.renderer.setPlate(p, this.plates.canvas(p));
    }, 90);
  }

  get issue() {
    return this.issueTarget;
  }

  /** dev/test: drive the world with synthetic gestures instead of the camera */
  inject(gestures: HandGesture[] | null) {
    this.injected = gestures;
    if (gestures) this.mode = 'camera';
  }

  // ------------------------------------------------------------ hands

  private handFromGesture(g: HandGesture, dt: number): Hand {
    const prev = this.hands.get(g.id);
    // a bigger palm in the image means a hand closer to the lens
    const z = clamp(((g.palmSize - 0.16) / 0.16) * 3.2 + 0.4, -1.5, 5.2);
    const w = (p: V2) => this.screenToWorld(this.videoToScreen(p), z);
    return {
      id: g.id,
      pose: g.pose,
      palm: w(g.palm),
      normal: norm(g.palmNormal),
      up: norm(g.palmUp),
      pinch: w(g.pinch.point),
      pinchScreen: this.videoToScreen(g.pinch.point),
      tip: w(g.point.tip),
      tipDir: norm([g.point.dir[0], -g.point.dir[1], -0.35]),
      rub: w(g.rub.point),
      rubIntensity: g.rub.active ? Math.max(0.25, g.rub.intensity) : 0,
      pinching: g.pinch.active,
      open: g.open,
      fist: g.fist,
      openFor: g.open ? (prev?.openFor ?? 0) + dt : 0,
      printDebt: prev?.printDebt ?? 0,
      torch: prev?.torch ?? 0,
    };
  }

  private handFromMouse(): Hand | null {
    if (!this.mouse.inside) return null;
    const prev = this.hands.get(-1);
    const s: V2 = [this.mouse.x, this.mouse.y];
    const p = this.screenToWorld(s, this.mouse.depth);
    const pose: Pose = this.mouse.print ? 'rub' : this.mouse.torch ? 'point' : this.mouse.crumple ? 'fist' : this.mouse.down ? 'pinch' : 'none';
    return {
      id: -1,
      pose,
      palm: p,
      normal: [0, 0, 1],
      up: [0, 1, 0],
      pinch: p,
      pinchScreen: s,
      tip: add(p, [0, 0, 0.6]),
      tipDir: [0, 0, -1],
      rub: p,
      rubIntensity: this.mouse.print ? 1 : 0,
      pinching: this.mouse.down,
      open: false,
      fist: this.mouse.crumple,
      openFor: 0,
      printDebt: prev?.printDebt ?? 0,
      torch: prev?.torch ?? 0,
    };
  }

  private letGo(id: number) {
    for (const n of this.notes) {
      this.release(n, id);
      if (n.carriedBy === id) this.drop(n);
    }
  }

  private updateHands(now: number, dt: number) {
    let gestures: HandGesture[] | null = null;
    if (this.injected) gestures = this.injected;
    else if (this.sensor) {
      const frame = this.sensor.detect(now);
      if (frame) gestures = this.gestures.update(frame);
    }
    const next = new Map<number, Hand>();
    if (gestures) for (const g of gestures) next.set(g.id, this.handFromGesture(g, dt));
    else for (const [id, h] of this.hands) if (id >= 0) next.set(id, h); // no new video frame: keep them
    const camHands = [...next.keys()].some((id) => id >= 0);
    const m = this.handFromMouse();
    if (m && !camHands) next.set(-1, m);
    for (const [id] of this.hands) if (!next.has(id)) this.letGo(id);
    this.hands = next;
  }

  private act(dt: number) {
    for (const hand of this.hands.values()) {
      const held = this.notes.find((n) => n.holds.some((h) => h.hand === hand.id));
      const carried = this.notes.find((n) => n.carriedBy === hand.id);

      // pinch: take hold of the nearest paper and let it dangle
      // (a second hand can take the other end and pull it taut)
      if (hand.pinching && !held) {
        const hit = this.pick(hand.pinchScreen, hand.id);
        if (hit) {
          const n = hit.note;
          if (n.carriedBy !== null) this.drop(n);
          n.holds.push({ hand: hand.id, pin: hit.index, since: performance.now() });
          n.rest = 0;
          paperSound.grab();
        }
      } else if (!hand.pinching && held) {
        this.release(held, hand.id);
        paperSound.release();
      }
      const grip = held?.holds.find((h) => h.hand === hand.id);
      if (held && grip) held.sheet.pin(grip.pin, hand.pinch, 1);

      // fist: crumple whatever you have
      const squeezed = held ?? carried;
      if (hand.fist && squeezed) {
        squeezed.crumple = Math.min(1, squeezed.crumple + dt * 2.2);
        if (carried) carried.sheet.detach();
        squeezed.sheet.crumple(hand.palm, squeezed.crumple);
        paperSound.crumple(squeezed.crumple);
      } else if (squeezed && squeezed.crumple > 0) {
        squeezed.crumple = Math.max(0, squeezed.crumple - dt * 3);
      }

      // open palm: money comes to you, and rests there
      if (hand.open && !held && !carried && hand.openFor > 0.35) {
        const free = this.notes
          .filter((n) => !this.held(n) && (n.carriedBy === null || n.carriedBy === -1) && n.dying === 0)
          .sort((a, b) => Number(b.hero) - Number(a.hero) || dist(a.sheet.centroid(), hand.palm) - dist(b.sheet.centroid(), hand.palm))[0];
        if (free) {
          free.carriedBy = hand.id;
          free.carry = 0;
          paperSound.catchNote();
        }
      }
      if (carried && !hand.fist) {
        if (hand.pose === 'point' || hand.pose === 'rub') {
          // busy hands drop what they carry
          this.drop(carried);
        } else {
          carried.carry = Math.min(1, carried.carry + dt * 2.5);
          const n = hand.normal;
          const right = norm(cross(hand.up, n));
          const up = norm(cross(n, right));
          const c = add(add(hand.palm, scale(n, 0.14)), scale(up, 0.2));
          carried.sheet.attach(c, right, up, 0.25 + 0.6 * carried.carry);
        }
      }

      // point: a UV torch on your fingertip
      hand.torch = clamp(hand.torch + (hand.pose === 'point' ? dt * 4 : -dt * 5), 0, 1);

      // rub thumb across fingers: print money
      if (hand.pose === 'rub' && hand.rubIntensity > 0) {
        hand.printDebt += dt * (3 + 9 * hand.rubIntensity);
        while (hand.printDebt >= 1) {
          hand.printDebt -= 1;
          this.printOne(hand.rub);
        }
      } else hand.printDebt = Math.min(hand.printDebt, 0.6);
    }

    // the stand: the hero waits in mid-air until a hand takes it
    const h = this.hero;
    if (h.carriedBy === -1 && !this.held(h)) {
      h.carry = Math.min(1, h.carry + dt * 1.2);
      const { c, r, u } = this.standPose();
      h.sheet.attach(c, r, u, 0.2 + 0.75 * h.carry);
    }
  }

  // ------------------------------------------------------------ frame

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.frame(performance.now());
  };

  private frame(now: number) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const t = (now - this.start) / 1000;

    if (this.hero.print < 1) this.hero.print = Math.min(1, this.hero.print + dt / 2.6);

    this.updateHands(now, dt);
    this.act(dt);

    // every open palm catches falling money
    const colliders: Collider[] = [];
    for (const hand of this.hands.values()) {
      if (hand.id >= 0 && hand.open) {
        colliders.push({ kind: 'disk', center: add(hand.palm, scale(hand.normal, 0.04)), normal: hand.normal, radius: 0.6, friction: 0.85 });
      }
    }
    const env: PaperEnv = { gravity: GRAVITY, wind: [Math.sin(t * 0.3) * 0.15, 0, 0], colliders, floorY: this.floorY };

    let maxSpeed = 0;
    const halfW = HALF_H * this.aspect;
    for (const n of [...this.notes]) {
      if (n.dying > 0) {
        n.dying += dt;
        const pos = n.sheet.positions;
        for (let i = 1; i < pos.length; i += 3) pos[i] -= dt * 1.4;
        if (n.dying > 1.6) this.remove(n);
        continue;
      }
      const before = n.sheet.centroid();
      n.sheet.step(dt, env);
      const after = n.sheet.centroid();
      const speed = dist(before, after) / Math.max(dt, 1e-3);
      const free = !this.held(n) && n.carriedBy === null;
      if (free) maxSpeed = Math.max(maxSpeed, speed);
      if (free && after[1] < this.floorY + 0.4 && speed < 0.2) n.rest += dt;
      else n.rest = 0;
      if (!n.hero && n.rest > 9) n.dying = 0.001;
      const gone = Math.abs(after[0]) > halfW + 2.5 || after[1] < this.floorY - 2 || after[2] > EYE[2] - 0.8 || after[2] < -12;
      if (gone) {
        if (n.hero) {
          this.release(n);
          n.sheet.unpinAll();
          this.placeOnStand(n, true);
        } else this.remove(n);
      }
      // held up high: backlit by the light at the top of the screen
      const sp = this.worldToScreen(after);
      const lifted = this.held(n) || (n.carriedBy !== null && n.carriedBy >= 0);
      // pulled taut between two hands past what paper allows: one grip slips
      if (n.holds.length > 1) {
        const [a, b] = n.holds;
        const ha = this.hands.get(a.hand);
        const hb = this.hands.get(b.hand);
        if (ha && hb && dist(ha.pinch, hb.pinch) > NOTE_H * ASPECT * 1.25) {
          this.release(n, (a.since < b.since ? a : b).hand);
          paperSound.snap();
        }
      }
      n.backlight += ((lifted ? smooth(0.34, 0.12, sp[1]) : 0) - n.backlight) * Math.min(1, dt * 6);
      n.selected *= Math.exp(-dt * 10);
    }
    // in mouse mode, a dropped hero drifts back up after a moment
    if (this.mode !== 'camera' && this.hero.rest > 2.5) this.summon();

    // what a pinch would grab right now
    for (const hand of this.hands.values()) {
      if (hand.pinching || hand.pose === 'rub' || hand.pose === 'point') continue;
      const hit = this.pick(hand.pinchScreen, hand.id);
      if (hit) hit.note.selected = 1;
    }

    // the room: a UV torch kills the lights; a note held high raises the window glow
    const torch = Math.max(0, ...[...this.hands.values()].map((h) => h.torch));
    const flicker = torch > 0 && torch < 1 && !this.reducedMotion && Math.random() < 0.3 ? 0.4 : 1;
    this.room += (1 - 0.92 * torch * flicker - this.room) * Math.min(1, dt * 12);
    if (torch > 0.5 && !this.uvHum) {
      sound.uvOn();
      this.uvHum = true;
    } else if (torch < 0.2 && this.uvHum) {
      sound.uvOff();
      this.uvHum = false;
    }
    this.glow = Math.max(0, ...this.notes.map((n) => n.backlight));
    paperSound.flutter(maxSpeed);
    paperSound.counter(Math.max(0, ...[...this.hands.values()].map((h) => (h.pose === 'rub' ? h.rubIntensity : 0))));

    if (this.video) this.renderer.updateVideo(this.video);
    this.videoFade = clamp(this.videoFade + (this.video && this.renderer.hasVideo ? dt * 1.5 : -dt * 3), 0, 1);

    this.render(t);
    this.drawOverlay();
    this.emitHud(false);
    this.adapt(dt);
  }

  private remove(n: Note) {
    this.notes = this.notes.filter((x) => x !== n);
    this.renderer.releaseSheet(n.id);
  }

  private render(t: number) {
    const torchHand = [...this.hands.values()].sort((a, b) => b.torch - a.torch)[0];
    const torch = torchHand?.torch ?? 0;
    const glowPos: V2 = [0.5, 0.97];
    const backPos = this.screenToWorld([glowPos[0], 1 - glowPos[1]], -2);

    const sheets: SheetDraw[] = this.notes
      .map((n) => ({ n, z: n.sheet.centroid()[2] }))
      .sort((a, b) => b.z - a.z)
      .map(({ n }) => ({
        id: n.id,
        cols: n.sheet.cols,
        rows: n.sheet.rows,
        positions: n.sheet.positions,
        normals: n.sheet.normals,
        uvs: n.sheet.uvs,
        indices: n.sheet.indices,
        uniforms: {
          ...n.uniforms,
          uPrint: n.print,
          uWrinkle: n.sheet.wrinkle,
          uBacklight: n.backlight,
          uTrans: n.backlight,
          uSelected: this.held(n) ? 0 : n.selected * 0.6,
        },
      }));

    this.renderer.frame(
      {
        uRes: [this.canvas.width, this.canvas.height],
        uTime: t,
        uVideoOn: this.videoFade,
        uVideoScale: this.videoScale(),
        uRoom: this.room,
        uGlow: this.glow,
        uGlowPos: glowPos,
        uDpr: this.canvas.width / window.innerWidth,
      },
      {
        uViewProj: this.viewProj,
        uEye: EYE,
        uTime: t,
        uKeyDir: norm([-0.45, 0.75, 0.6]),
        uKeyCol: [1.15, 1.0, 0.85],
        uFillDir: norm([0.6, -0.2, 0.8]),
        uFillCol: [0.12, 0.14, 0.18],
        uAmbient: [0.12, 0.12, 0.13],
        uRoom: this.room,
        uBackPos: backPos,
        uTorch: torchHand ? [...torchHand.tip, torch] : [0, 0, 0, 0],
        uTorchDir: torchHand?.tipDir ?? [0, 0, -1],
        uFibres: torch,
        uCam: 0,
        uCamScale: [1, 1],
      },
      sheets,
    );
  }

  // ------------------------------------------------------------ overlay

  /** a light touch of UI over the hands: the pinch ring, the torch, the press */
  private drawOverlay() {
    const ctx = this.overlay;
    if (!ctx) return;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const k = W / window.innerWidth;
    const s = (p: V3) => {
      const q = this.worldToScreen(p);
      return [q[0] * W, q[1] * H] as const;
    };
    for (const hand of this.hands.values()) {
      ctx.lineWidth = 1.2 * k;
      if (hand.pose === 'point') {
        const [tx, ty] = s(hand.tip);
        const g = ctx.createRadialGradient(tx, ty, 0, tx, ty, 90 * k);
        g.addColorStop(0, 'rgba(170,120,255,0.5)');
        g.addColorStop(1, 'rgba(120,60,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(tx, ty, 90 * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(230,210,255,0.95)';
        ctx.beginPath();
        ctx.arc(tx, ty, 3 * k, 0, Math.PI * 2);
        ctx.fill();
      } else if (hand.pose === 'rub') {
        const [rx, ry] = s(hand.rub);
        ctx.strokeStyle = 'rgba(198,254,31,0.85)';
        for (let i = 0; i < 3; i++) {
          const r = ((performance.now() / 6 + i * 12) % 36) * k;
          ctx.globalAlpha = 1 - r / (36 * k);
          ctx.beginPath();
          ctx.arc(rx, ry, r, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else {
        const [px, py] = s(hand.pinch);
        const holding = this.notes.some((n) => n.holds.some((h) => h.hand === hand.id));
        ctx.strokeStyle = holding || hand.pinching ? 'rgba(198,254,31,0.95)' : 'rgba(236,230,216,0.5)';
        ctx.beginPath();
        ctx.arc(px, py, (hand.pinching ? 6 : 11) * k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // ------------------------------------------------------------ hud

  private emitHud(force: boolean) {
    const now = performance.now();
    if (!force && now - this.hudAt < 120) return;
    this.hudAt = now;
    const hands = [...this.hands.values()];
    this.onHud?.({
      mode: this.mode,
      hands: hands.filter((h) => h.id >= 0).length,
      poses: hands.map((h) => h.pose),
      printed: this.printedCount,
      tracking: this.tracking,
      loadingMsg: this.loadingMsg,
      holding: this.notes.some((n) => this.held(n) || (n.carriedBy !== null && n.carriedBy >= 0)),
    });
  }

  async capture(): Promise<Blob | null> {
    this.render((performance.now() - this.start) / 1000);
    return new Promise((res) => this.canvas.toBlob(res, 'image/png'));
  }

  private adapt(dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 45) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 0.026 && this.scaleRes > 0.5) {
      this.scaleRes = Math.max(0.5, this.scaleRes * 0.85);
      this.layout();
    } else if (avg < 0.0135 && this.scaleRes < 1) {
      this.scaleRes = Math.min(1, this.scaleRes * 1.1);
      this.layout();
    }
  }
}
