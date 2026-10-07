import { Renderer } from './renderer';
import { Terrain, SEA } from './terrain';
import { Flock, MAX_DODOS } from './dodos';
import { PALETTES, skyPalette, type Palette } from './palettes';
import { islandSound } from './sound';
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

export interface IslandHud {
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
  // weather
  private rainHeld = false;
  rain = 0;
  private cloud = 0.25;
  private flash = 0;
  private nextFlash = 2;

  palette = 0;
  pattern = 0;
  px = 3;
  private raf = 0;
  private last = performance.now();
  private start = performance.now();
  private hudAt = 0;
  onHud?: (h: IslandHud) => void;
  onHatch?: (n: number) => void;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.flock = new Flock(this.terrain);
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => location.reload());
    const q = new URLSearchParams(location.search);
    if (q.has('px')) this.px = clamp(Number(q.get('px')), 1, 8);
    if (q.has('still') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) this.intro = 1;
  }

  run() {
    this.layout();
    if (import.meta.env.DEV) (window as unknown as { island: IslandEngine }).island = this;
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }

  layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.resize(Math.round(window.innerWidth * dpr), Math.round(window.innerHeight * dpr), this.px * dpr);
  }

  setPx(px: number) {
    this.px = clamp(Math.round(px), 1, 8);
    this.layout();
  }

  // ------------------------------------------------------------ camera

  private updateCamera(dt: number) {
    const k = 1 - Math.exp(-dt * 6);
    this.yaw += (this.goal.yaw - this.yaw) * k;
    this.pitch += (this.goal.pitch - this.pitch) * k;
    this.dist += (this.goal.dist - this.dist) * k;
    for (let i = 0; i < 3; i++) this.target[i] += (this.goal.target[i] - this.target[i]) * k * 0.7;
    const cp = Math.cos(this.pitch);
    const off: V3 = [Math.sin(this.yaw) * cp * this.dist, Math.sin(this.pitch) * this.dist, Math.cos(this.yaw) * cp * this.dist];
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
    if (sculpting && hit && this.drag?.kind === 'sculpt') {
      const rate = this.drag.carve ? -0.9 : 0.75;
      this.terrain.raise(this.brush.x, this.brush.z, this.brush.r, rate, dt);
      this.terrain.relax(this.brush.x, this.brush.z, this.brush.r * 1.2, 0.04);
      this.idle = 0;
    }
    islandSound.rumble(sculpting && hit ? (this.drag?.kind === 'sculpt' && this.drag.carve ? -1 : 1) : 0);

    // weather: rain gathers quickly and clears slowly; storms throw lightning
    this.rain += ((this.rainHeld ? 1 : 0) - this.rain) * Math.min(1, dt * (this.rainHeld ? 2.2 : 0.5));
    this.cloud += (0.25 + 0.75 * Math.max(this.rain, this.rainHeld ? 1 : 0) - this.cloud) * Math.min(1, dt * 1.2);
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

    // the forest grows where it rains
    this.growTimer -= dt;
    if (this.growTimer <= 0) {
      this.growTimer = 0.25;
      this.terrain.grow(0.25, this.rain);
    }
    if (this.terrain.vegDirty) {
      this.renderer.uploadLand(this.terrain.h, this.terrain.veg, [0, 0, 255, 255]);
      this.terrain.vegDirty = false;
      this.terrain.dirty = null;
    } else if (this.terrain.dirty) {
      this.renderer.uploadLand(this.terrain.h, this.terrain.veg, this.terrain.dirty);
      this.terrain.dirty = null;
    }

    // more land, more dodos
    this.landTimer -= dt;
    if (this.landTimer <= 0) {
      this.landTimer = 0.4;
      this.terrain.countLand();
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
    this.flock.step(dt);

    islandSound.ambience(this.dist, this.sun[1]);

    this.render(t);
    this.emitHud(now);
  }

  private currentPalette(): Palette {
    if (this.palette === 0) return skyPalette(this.sun[1], this.sun[0] > 0);
    return PALETTES[this.palette];
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
      },
      {
        uPx: this.canvas.width / this.renderer.worldSize[0],
        uPal: pal.inks.flat(),
        uAccent: pal.accent,
        uPattern: this.pattern,
        uContrast: 1.15,
        uOutline: 1,
        uLift: pal.lift,
      },
    );
  }

  /** "06:40" from where the sun is */
  hour(): string {
    const a = Math.atan2(this.sun[1], this.sun[0]); // 0 east horizon, π/2 overhead, π west
    let h = 6 + (a / Math.PI) * 12;
    h = ((h % 24) + 24) % 24;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  private emitHud(now: number) {
    if (now - this.hudAt < 150) return;
    this.hudAt = now;
    const d = this.drag;
    this.onHud?.({
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

  capture(): Promise<Blob | null> {
    this.render((performance.now() - this.start) / 1000);
    return new Promise((res) => this.canvas.toBlob(res, 'image/png'));
  }
}
