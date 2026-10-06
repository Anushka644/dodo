import { Renderer } from './gl/renderer';
import { ASPECT, PORTRAIT_H, PORTRAIT_W } from './note/layout';
import { Plates, drawMicro, loadFonts } from './note/plates';
import { drawDodo } from './note/dodo';
import { mint, type Issue } from './note/seed';
import { sound } from './sound';

export type Tool = 'lamp' | 'loupe' | 'uv' | 'back';
export const TOOLS: Tool[] = ['lamp', 'loupe', 'uv', 'back'];

type Vec4 = [number, number, number, number];

const toSrgbLinear = (c: number) => Math.pow(c, 2.2);
const lin = (rgb: [number, number, number]) => rgb.map(toSrgbLinear);

// critically damped spring step — the lamp has a little weight to it
function damp(current: number, target: number, vel: { v: number }, omega: number, dt: number) {
  const x = current - target;
  const exp = Math.exp(-omega * dt);
  const v = vel.v;
  const next = target + (x + (v + omega * x) * dt) * exp;
  vel.v = (v - omega * (v + omega * x) * dt) * exp;
  return next;
}

interface NoteRect {
  cx: number; // css px
  cy: number;
  halfH: number; // css px, along the note's short side
  rotated: boolean;
}

export class Engine {
  private renderer: Renderer;
  private plates!: Plates;
  private dodo!: HTMLCanvasElement;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;

  tool: Tool = 'lamp';
  private weights: Vec4 = [1, 0, 0, 0];

  // pointer & lamp
  private pointer = { x: 0, y: 0, active: false, touch: false };
  private light = { x: ASPECT * 0.5, y: 0.5, z: 1.0 };
  private lightVel = { x: { v: 0 }, y: { v: 0 } };
  private lampHeight = 0.42;
  private loupeMag = 5;
  private idle = true;
  private idleT = 0;

  // flicker & ceremony
  private lampOn = 0;
  private lampBase = 0;
  private lampWait = 0;
  private uvOn = 0;
  private uvSwitchAt = -1;
  private print = 0;
  private printing = false;
  private loupeR = 0;
  private loupeVel = { v: 0 };

  // the mint
  private issueTarget: Issue = mint('');
  private params = {
    rosA: [...this.issueTarget.rosA] as Vec4,
    rosB: [...this.issueTarget.rosB] as Vec4,
    band: [...this.issueTarget.band] as Vec4,
    field: [...this.issueTarget.field] as Vec4,
    ink: lin(this.issueTarget.ink),
    iris0: lin(this.issueTarget.iris[0]),
    iris1: lin(this.issueTarget.iris[1]),
    iris2: lin(this.issueTarget.iris[2]),
  };
  private reprintTimer = 0;

  private rect: NoteRect = { cx: 0, cy: 0, halfH: 100, rotated: false };
  private dpr = 1;
  private scale = 1; // adaptive resolution
  private frameTimes: number[] = [];
  private last = performance.now();
  private start = performance.now();
  private raf = 0;
  private dirty = true;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  onInteract?: () => void;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    // GPUs reset; when the context comes back, the simplest correct thing is a fresh start
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
    this.dodo = drawDodo();
    this.renderer.setPortrait(this.dodo);
    this.layout();
    this.printing = true;
    if (this.reducedMotion || new URLSearchParams(location.search).has('still')) {
      this.print = 1;
      this.lampOn = 1;
      this.lampBase = 1;
    }
    if (import.meta.env.DEV) (window as unknown as { engine: Engine }).engine = this;
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.stopCamera();
  }

  // ------------------------------------------------------------ layout

  /** Fits the note into the space the UI leaves, turning it upright on tall screens. */
  layout() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const rotated = h > w * 1.15;
    const top = rotated ? 64 : 76;
    const bottom = rotated ? 176 : 108;
    const side = rotated ? 16 : 40;
    const availW = w - side * 2;
    const availH = h - top - bottom;
    // long side, short side of the available box in note orientation
    const along = rotated ? availH : availW;
    const across = rotated ? availW : availH;
    const halfH = Math.max(40, Math.min(across / 2, along / (2 * ASPECT)) * 0.96);
    this.rect = { cx: w / 2, cy: top + availH / 2, halfH, rotated };
    this.resize();
  }

  private resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    let s = this.dpr * this.scale;
    const maxPixels = 2560 * 1440; // past this, the eye can't tell and the fan can
    if (w * h * s * s > maxPixels) s = Math.sqrt(maxPixels / (w * h));
    this.renderer.resize(Math.round(w * s), Math.round(h * s));
    this.dirty = true;
  }

  /** css px → note space, the same mapping the shader uses. */
  private toNote(x: number, y: number) {
    let dx = x - this.rect.cx;
    let dy = -(y - this.rect.cy); // gl y-up
    if (this.rect.rotated) [dx, dy] = [-dy, dx];
    return { x: dx / (2 * this.rect.halfH) + ASPECT / 2, y: -dy / (2 * this.rect.halfH) + 0.5 };
  }

  /** note space → css px (for placing UI against the note). */
  noteToScreen(nx: number, ny: number) {
    let dx = (nx - ASPECT / 2) * 2 * this.rect.halfH;
    let dy = -(ny - 0.5) * 2 * this.rect.halfH;
    if (this.rect.rotated) [dx, dy] = [dy, -dx];
    return { x: this.rect.cx + dx, y: this.rect.cy - dy };
  }

  get noteRect() {
    return this.rect;
  }

  // ------------------------------------------------------------ input

  pointerMove(x: number, y: number, touch: boolean) {
    // on touch, hold the lamp and lens a little above the finger so it doesn't hide what you're looking at
    const lift = touch ? (this.tool === 'loupe' ? 110 : 60) : 0;
    this.pointer = { x, y: y - lift, active: true, touch };
    if (this.idle) {
      this.idle = false;
      this.onInteract?.();
    }
    this.dirty = true;
  }

  nudge(dx: number, dy: number) {
    if (this.idle) {
      const s = this.noteToScreen(this.light.x, this.light.y);
      this.pointer = { x: s.x, y: s.y, active: true, touch: false };
      this.idle = false;
      this.onInteract?.();
    }
    this.pointer.x += dx;
    this.pointer.y += dy;
    this.dirty = true;
  }

  wheel(delta: number) {
    if (this.tool === 'loupe') {
      this.loupeMag = Math.min(12, Math.max(2.5, this.loupeMag * Math.exp(-delta * 0.0015)));
    } else {
      this.lampHeight = Math.min(1.1, Math.max(0.1, this.lampHeight * Math.exp(delta * 0.0012)));
    }
    this.dirty = true;
  }

  setTool(tool: Tool) {
    if (tool === this.tool) return;
    this.tool = tool;
    sound.click();
    if (tool === 'uv') {
      this.uvSwitchAt = performance.now();
      this.uvOn = 0;
      sound.uvOn();
    } else {
      sound.uvOff();
    }
    if (tool === 'back') sound.rustle();
    if (tool === 'loupe') sound.glass();
    this.dirty = true;
  }

  setName(name: string) {
    const next = mint(name);
    const changed = next.serial !== this.issueTarget.serial || next.name !== this.issueTarget.name;
    this.issueTarget = next;
    if (!changed) return;
    sound.tick();
    // the guilloche morphs every frame; the type is re-set once you pause
    window.clearTimeout(this.reprintTimer);
    this.reprintTimer = window.setTimeout(() => this.reprint(), 90);
    this.dirty = true;
  }

  private reprint() {
    for (const p of this.plates.issue(this.issueTarget, this.cameraOn)) this.renderer.setPlate(p, this.plates.canvas(p));
    this.dirty = true;
  }

  get issue() {
    return this.issueTarget;
  }

  async startCamera(): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = this.stream;
      await v.play();
      this.video = v;
      this.renderer.setPortrait(v);
      this.reprint();
      return true;
    } catch {
      this.stopCamera();
      return false;
    }
  }

  stopCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video = null;
      this.renderer.setPortrait(this.dodo);
      this.reprint();
    }
    this.dirty = true;
  }

  get cameraOn() {
    return !!this.video;
  }

  /** Renders a fresh frame and crops the note out of it. */
  async capture(): Promise<Blob | null> {
    this.frame(performance.now(), true);
    const src = this.canvas;
    const k = src.width / window.innerWidth;
    const { cx, cy, halfH, rotated } = this.rect;
    const pad = 24;
    const w = (rotated ? 2 * halfH : 2 * halfH * ASPECT) + pad * 2;
    const h = (rotated ? 2 * halfH * ASPECT : 2 * halfH) + pad * 2;
    const out = document.createElement('canvas');
    out.width = Math.round(w * k);
    out.height = Math.round(h * k);
    out.getContext('2d')!.drawImage(src, (cx - w / 2) * k, (cy - h / 2) * k, w * k, h * k, 0, 0, out.width, out.height);
    return new Promise((res) => out.toBlob(res, 'image/png'));
  }

  /** Dev/test helper: jump every transition to its end state. */
  settle() {
    const goal: Vec4 = [this.tool === 'lamp' ? 1 : 0, this.tool === 'loupe' ? 1 : 0, this.tool === 'uv' ? 1 : 0, this.tool === 'back' ? 1 : 0];
    this.weights = goal;
    this.uvSwitchAt = -1e6;
    this.loupeR = this.tool === 'loupe' ? 128 : 0;
    const t = this.toNote(this.pointer.x, this.pointer.y);
    this.light.x = t.x;
    this.light.y = t.y;
    this.light.z = this.tool === 'loupe' ? 0.5 : this.lampHeight;
    this.dirty = true;
  }

  // ------------------------------------------------------------ frame

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    this.frame(now, false);
  };

  private frame(now: number, force: boolean) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const t = (now - this.start) / 1000;
    let animating = false;

    // the press runs once, then the lamp flickers on
    if (this.printing && this.print < 1) {
      this.print = Math.min(1, this.print + dt / 2.6);
      animating = true;
      if (this.print >= 1) {
        this.printing = false;
        this.lampWait = 0.35; // work light off, a beat of dark…
        sound.press();
      }
    }
    if (this.print < 1) {
      // a dim work light while the note is printed
      this.lampOn = 0.55 * Math.min(1, this.print * 3);
    } else if (this.lampBase < 1) {
      // …then the lamp stutters on, like they do
      if (this.lampWait > 0) {
        this.lampWait -= dt;
        this.lampOn = 0;
      } else {
        this.lampBase = Math.min(1, this.lampBase + dt * 1.8);
        const stutter = this.reducedMotion || this.lampBase > 0.75 ? 1 : Math.random() < 0.4 ? 0.12 : 1;
        this.lampOn = this.lampBase * stutter;
      }
      animating = true;
    }

    // where the lamp wants to be
    let target: { x: number; y: number };
    if (this.print < 1) {
      // while the press runs, a high work light over the middle
      target = { x: ASPECT * 0.5, y: 0.5 };
    } else if (this.idle) {
      // until you take it, the lamp wanders over the note by itself
      this.idleT += dt;
      const k = this.idleT * 0.32;
      target = {
        x: ASPECT * 0.5 + Math.sin(k) * ASPECT * 0.36 + Math.sin(k * 2.3) * 0.08,
        y: 0.5 + Math.sin(k * 1.7 + 1.0) * 0.3,
      };
      animating = true;
    } else {
      target = this.toNote(this.pointer.x, this.pointer.y);
    }
    const omega = this.tool === 'loupe' ? 26 : 13;
    const nx = damp(this.light.x, target.x, this.lightVel.x, omega, dt);
    const ny = damp(this.light.y, target.y, this.lightVel.y, omega, dt);
    if (Math.abs(nx - this.light.x) + Math.abs(ny - this.light.y) > 1e-5) animating = true;
    this.light.x = nx;
    this.light.y = ny;
    const zTarget = this.print < 1 ? 1.0 : this.tool === 'loupe' ? 0.5 : this.lampHeight;
    this.light.z += (zTarget - this.light.z) * Math.min(1, dt * 10);
    if (Math.abs(zTarget - this.light.z) > 1e-4) animating = true;

    // tool crossfade
    const goal: Vec4 = [this.tool === 'lamp' ? 1 : 0, this.tool === 'loupe' ? 1 : 0, this.tool === 'uv' ? 1 : 0, this.tool === 'back' ? 1 : 0];
    const rate = Math.min(1, dt * 7);
    for (let i = 0; i < 4; i++) {
      const d = goal[i] - this.weights[i];
      this.weights[i] = Math.abs(d) < 0.002 ? goal[i] : this.weights[i] + d * rate;
      if (this.weights[i] !== goal[i]) animating = true;
    }

    // a UV tube never just turns on
    if (this.tool === 'uv') {
      const e = (now - this.uvSwitchAt) / 1000;
      if (this.reducedMotion) this.uvOn = 1;
      else if (e > 0.62) this.uvOn = 0.97 + 0.03 * Math.sin(now * 0.63);
      else {
        const seq = [[0.05, 0.7], [0.11, 0.05], [0.16, 0.9], [0.24, 0.15], [0.3, 0.55], [0.38, 0.1], [0.46, 1]];
        let v = 0;
        for (const [at, val] of seq) if (e >= at) v = val;
        this.uvOn = v;
        if (Math.random() < 0.15) sound.crackle();
      }
      if (!this.reducedMotion) animating = true;
    }

    // loupe: springs open, folds away
    const rTarget = this.tool === 'loupe' ? (this.pointer.touch ? 90 : 128) : 0;
    this.loupeR = damp(this.loupeR, rTarget, this.loupeVel, 18, dt);
    if (Math.abs(this.loupeR - rTarget) > 0.2) animating = true;

    // the mint: guilloche params glide toward the new name
    const P = this.params;
    const T = this.issueTarget;
    const g = Math.min(1, dt * 5);
    const glide = (a: number[], b: readonly number[]) => {
      let moved = false;
      for (let i = 0; i < a.length; i++) {
        const d = b[i] - a[i];
        if (Math.abs(d) > 1e-4) moved = true;
        a[i] += d * g;
      }
      return moved;
    };
    if (glide(P.rosA, T.rosA)) animating = true;
    if (glide(P.rosB, T.rosB)) animating = true;
    if (glide(P.band, T.band)) animating = true;
    if (glide(P.field, T.field)) animating = true;
    if (glide(P.ink, lin(T.ink))) animating = true;
    if (glide(P.iris0, lin(T.iris[0]))) animating = true;
    if (glide(P.iris1, lin(T.iris[1]))) animating = true;
    if (glide(P.iris2, lin(T.iris[2]))) animating = true;

    if (this.video) {
      this.renderer.refreshVideo(this.video);
      animating = true;
    }

    if (!animating && !this.dirty && !force) return;
    this.dirty = false;

    const k = this.canvas.width / window.innerWidth;
    const H = this.canvas.height;
    const pointerScreen = this.noteToScreen(this.light.x, this.light.y);
    const camAspect = this.video ? this.video.videoWidth / Math.max(1, this.video.videoHeight) : 1;
    const portraitAspect = PORTRAIT_W / PORTRAIT_H;
    const camScale = camAspect > portraitAspect ? [portraitAspect / camAspect, 1] : [1, camAspect / portraitAspect];

    const t0 = performance.now();
    this.renderer.draw({
      uRes: [this.canvas.width, H],
      uNote: [this.rect.cx * k, H - this.rect.cy * k, this.rect.halfH * k, this.rect.rotated ? 1 : 0],
      uLight: [this.light.x, this.light.y, this.light.z],
      uCursor: [pointerScreen.x * k, H - pointerScreen.y * k],
      uMode: this.weights,
      uLampOn: this.lampOn,
      uUvOn: this.uvOn,
      uLoupeR: Math.max(0, this.loupeR * k),
      uLoupeMag: this.loupeMag,
      uTime: t,
      uPrint: this.print,
      uRosA: P.rosA,
      uRosB: P.rosB,
      uBand: P.band,
      uField: P.field,
      uInk: P.ink,
      uIris0: P.iris0,
      uIris1: P.iris1,
      uIris2: P.iris2,
      uCam: this.video ? 1 : 0,
      uCamScale: camScale,
    });
    this.adapt(performance.now() - t0, dt);
  }

  // Keep it smooth on modest hardware: if frames run long, render fewer pixels.
  private adapt(_cpu: number, dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 40) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 0.026 && this.scale > 0.5) {
      this.scale = Math.max(0.5, this.scale * 0.85);
      this.resize();
    } else if (avg < 0.0135 && this.scale < 1) {
      this.scale = Math.min(1, this.scale * 1.1);
      this.resize();
    }
  }
}
