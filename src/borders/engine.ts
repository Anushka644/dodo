import { Renderer3D, type SheetDraw, type UniformValue } from '../gl/renderer3d';
import { ASPECT } from '../note/layout';
import { Plates, drawMicro, loadFonts } from '../note/plates';
import { drawDodo } from '../note/dodo';
import { drawStampAtlas, stampCell } from '../note/stamps';
import { mint } from '../note/seed';
import { sound } from '../sound';
import { paperSound } from '../paperSound';
import { COUNTRIES, type Country } from './countries';
import { Net } from './net';
import { DeskWorld, type WorldEvent } from './world';
import { NOTE_W, type Msg, type NoteState, type PeerInfo, type Rect } from './types';

// One window = one country. Every window draws every note that overlaps it,
// in its own currency and colours. The oldest window runs the physics for
// the whole desktop and tells the others where everything is.

const NOTE_H = NOTE_W / ASPECT;
const COLS = 18;
const ROWS = 8;
const lin = (rgb: [number, number, number]) => rgb.map((c) => Math.pow(c, 2.2));

function gridIndices(cols: number, rows: number) {
  const out: number[] = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      out.push(a, c, b, b, c, d);
    }
  }
  return new Uint16Array(out);
}

function gridUvs(cols: number, rows: number) {
  const out = new Float32Array(cols * rows * 2);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) out.set([(i / (cols - 1)) * ASPECT, j / (rows - 1)], (j * cols + i) * 2);
  return out;
}

const INDICES = gridIndices(COLS, ROWS);
const UVS = gridUvs(COLS, ROWS);

export interface BordersHud {
  country: Country;
  countryIndex: number;
  leader: boolean;
  open: { country: number; self: boolean }[];
  notesHere: number;
  totalNotes: number;
  connected: boolean;
}

interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
}

export class BordersEngine {
  readonly net: Net;
  readonly country: Country;
  private renderer: Renderer3D;
  private plates!: Plates;
  private world: DeskWorld | null = null;
  private notes: NoteState[] = [];
  private lastState: NoteState[] = [];
  private meshes = new Map<number, Mesh>();
  private uniforms: Record<string, UniformValue> = {};
  private pulses: { x: number; y: number; t: number; kind: number }[] = [];
  private pendingInputs: { key: string; kind: 'down' | 'move' | 'up'; x: number; y: number }[] = [];
  private stateSeq = 0;
  private wasLeader = false;
  private seeded = false;
  private raf = 0;
  private last = performance.now();
  private start = performance.now();
  private scaleRes = 1;
  private frameTimes: number[] = [];
  private tiltGravity: { x: number; y: number } | null = null;
  onHud?: (h: BordersHud) => void;
  private hudAt = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    readonly countryIndex: number,
  ) {
    this.country = COUNTRIES[countryIndex];
    this.net = new Net(countryIndex);
    this.renderer = new Renderer3D(canvas);
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => location.reload());
    this.net.on((m) => this.receive(m));
  }

  async init() {
    await loadFonts();
    this.plates = new Plates(this.country);
    const issue = mint(this.country.code);
    this.plates.issue(issue);
    for (const name of ['ink', 'ovi', 'uv', 'water', 'back', 'red'] as const) this.renderer.setPlate(name, this.plates.canvas(name));
    this.renderer.setMicro(drawMicro());
    this.renderer.setPortrait(drawDodo());
    this.renderer.setStamps(drawStampAtlas(new Date()));
    // every note in this window is printed in this country's colours
    this.uniforms = {
      uRosA: issue.rosA,
      uRosB: issue.rosB,
      uBand: issue.band,
      uField: issue.field,
      uInk: lin(issue.ink),
      uIris0: lin(issue.iris[0]),
      uIris1: lin(issue.iris[1]),
      uIris2: lin(issue.iris[2]),
      uPrint: 1,
      uWrinkle: 0,
      uBacklight: 0,
      uTrans: 0,
      uSelected: 0,
    };
    this.layout();
    if (import.meta.env.DEV) (window as unknown as { borders: BordersEngine }).borders = this;
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.net.dispose();
  }

  layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let s = dpr * this.scaleRes;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const maxPixels = 2560 * 1440;
    if (w * h * s * s > maxPixels) s = Math.sqrt(maxPixels / (w * h));
    this.renderer.resize(Math.round(w * s), Math.round(h * s));
  }

  // ------------------------------------------------------------ messages

  private receive(m: Msg) {
    if (m.t === 'state') {
      if (this.net.isLeader) return;
      this.notes = m.notes;
      this.lastState = m.notes;
    } else if (m.t === 'input') {
      if (this.net.isLeader) this.pendingInputs.push({ key: `${m.from}:${m.pid}`, kind: m.kind, x: m.x, y: m.y });
    } else if (m.t === 'cmd') {
      if (this.net.isLeader && this.world && m.kind === 'print') this.world.print(m.from, m.count);
    } else if (m.t === 'event') {
      this.react(m);
    } else if (m.t === 'hello' && this.net.isLeader) {
      // bring the newcomer up to date straight away
      this.broadcastState();
    }
  }

  /** sounds and ripples for things that happen inside this window */
  private react(e: { kind: WorldEvent['kind']; x: number; y: number; strength: number }) {
    const r = this.net.rect;
    if (e.x < r.x || e.x > r.x + r.w || e.y < r.y || e.y > r.y + r.h) return;
    if (e.kind === 'stamp') {
      sound.press();
      this.pulses.push({ x: e.x - r.x, y: e.y - r.y, t: 0, kind: 0 });
    } else if (e.kind === 'returned') {
      paperSound.snap();
      this.pulses.push({ x: e.x - r.x, y: e.y - r.y, t: 0, kind: 1 });
    } else if (e.kind === 'thud') {
      paperSound.catchNote();
    }
    if (this.pulses.length > 4) this.pulses.shift();
  }

  private broadcastState() {
    this.net.send({ t: 'state', from: this.net.id, seq: this.stateSeq++, notes: this.notes });
  }

  // ------------------------------------------------------------ input

  pointer(kind: 'down' | 'move' | 'up', pid: number, clientX: number, clientY: number) {
    const r = this.net.rect;
    const x = r.x + clientX;
    const y = r.y + clientY;
    if (kind === 'down') sound.wake();
    if (this.net.isLeader) this.pendingInputs.push({ key: `${this.net.id}:${pid}`, kind, x, y });
    else this.net.send({ t: 'input', from: this.net.id, kind, pid, x, y });
  }

  print(count = 3) {
    sound.wake();
    paperSound.counter(1);
    window.setTimeout(() => paperSound.counter(0), 380);
    if (this.net.isLeader && this.world) this.world.print(this.net.id, count);
    else this.net.send({ t: 'cmd', from: this.net.id, kind: 'print', count });
  }

  /** on a phone, tilting the screen tilts the country */
  setTilt(g: { x: number; y: number } | null) {
    this.tiltGravity = g;
  }

  /** open the next country next to this one */
  openBorder(): Window | null {
    sound.wake();
    sound.click();
    const used = new Set(this.net.windows().map((p) => p.country));
    let next = (this.countryIndex + 1) % COUNTRIES.length;
    for (let i = 0; i < COUNTRIES.length && used.has(next); i++) next = (next + 1) % COUNTRIES.length;
    const url = new URL(location.href);
    url.searchParams.set('c', COUNTRIES[next].code);
    url.searchParams.delete('wx');
    url.searchParams.delete('wy');
    const r = this.net.rect;
    const sw = window.screen.availWidth || 1440;
    const sh = window.screen.availHeight || 900;
    const w = Math.round(Math.min(Math.max(520, r.w * 0.8), sw * 0.45));
    const h = Math.round(Math.min(Math.max(420, r.h * 0.8), sh * 0.8));
    const gap = 36;
    // to the right if there's room, otherwise to the left, a little lower so the gap reads as a gap
    let left = window.screenX + window.outerWidth + gap;
    if (left + w > sw) left = Math.max(0, window.screenX - w - gap);
    const top = Math.min(Math.max(0, window.screenY + 60), sh - h);
    return window.open(url.toString(), `dodo-${COUNTRIES[next].code}-${Date.now()}`, `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  }

  // ------------------------------------------------------------ frame

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.frame(performance.now());
  };

  private frame(now: number) {
    const dt = Math.min(1 / 30, (now - this.last) / 1000);
    this.last = now;
    const t = (now - this.start) / 1000;
    this.net.tick(now);

    if (this.net.isLeader) {
      if (!this.world) {
        this.world = new DeskWorld();
        this.world.syncWindows(this.net.windows(), 0);
        if (this.lastState.length) this.world.load(this.lastState, this.net.windows());
      }
      const world = this.world;
      world.syncWindows(this.net.windows(), dt);
      if (this.tiltGravity) world.setGravity(this.tiltGravity);
      // first light: a little money falls into the first country
      if (!this.seeded) {
        this.seeded = true;
        if (world.count === 0 && this.lastState.length === 0) window.setTimeout(() => this.world?.print(this.net.id, 3), 700);
      }
      for (const i of this.pendingInputs.splice(0)) {
        const grabbed = world.input(i.key, i.kind, i.x, i.y);
        if (grabbed && i.kind === 'down') paperSound.grab();
        if (grabbed && i.kind === 'up') paperSound.release();
      }
      world.step(dt, this.net.id);
      this.notes = world.snapshot();
      this.lastState = this.notes;
      this.broadcastState();
      for (const e of world.events.splice(0)) {
        this.react(e);
        this.net.send({ t: 'event', from: this.net.id, kind: e.kind, note: e.note, country: e.country, x: e.x, y: e.y, strength: e.strength });
      }
      this.wasLeader = true;
    } else if (this.wasLeader) {
      // someone older appeared: hand over
      this.world = null;
      this.wasLeader = false;
    }

    // flutter sound from whatever is flying through this window
    const r = this.net.rect;
    let maxSpeed = 0;
    for (const n of this.notes) {
      if (n.x > r.x - NOTE_W && n.x < r.x + r.w + NOTE_W && n.y > r.y - NOTE_W && n.y < r.y + r.h + NOTE_W) maxSpeed = Math.max(maxSpeed, Math.hypot(n.vx, n.vy) / 400);
    }
    paperSound.flutter(maxSpeed);

    for (const p of this.pulses) p.t += dt;
    this.pulses = this.pulses.filter((p) => p.t < 1.4);

    this.render(t);
    this.emitHud(now);
    this.adapt(dt);
  }

  // ------------------------------------------------------------ render

  private meshFor(n: NoteState, depth: number): Mesh {
    let m = this.meshes.get(n.id);
    if (!m) {
      m = { positions: new Float32Array(COLS * ROWS * 3), normals: new Float32Array(COLS * ROWS * 3) };
      this.meshes.set(n.id, m);
    }
    const W = NOTE_W;
    const H = NOTE_H;
    const cf = Math.cos(n.flip);
    const sf = Math.sin(n.flip);
    const ca = Math.cos(-n.a);
    const sa = Math.sin(-n.a);
    const bow = n.bend * W * 0.09;
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const k = (j * COLS + i) * 3;
        const u = i / (COLS - 1);
        const v = j / (ROWS - 1);
        const s = 2 * u - 1;
        const lx = (u - 0.5) * W;
        const ly = (0.5 - v) * H;
        // a sheet in moving air bows along its length
        const lz = bow * (1 - s * s);
        const dz = (bow * -2 * s * 2) / W;
        let nx = -dz;
        let ny = 0;
        let nz = 1;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl;
        ny /= nl;
        nz /= nl;
        // tumble about the long axis
        const y1 = ly * cf - lz * sf;
        const z1 = ly * sf + lz * cf;
        const ny1 = ny * cf - nz * sf;
        const nz1 = ny * sf + nz * cf;
        // spin in the plane of the screen
        const x2 = lx * ca - y1 * sa;
        const y2 = lx * sa + y1 * ca;
        m.positions[k] = n.x + x2;
        m.positions[k + 1] = -n.y + y2;
        m.positions[k + 2] = depth + z1;
        m.normals[k] = nx * ca - ny1 * sa;
        m.normals[k + 1] = nx * sa + ny1 * ca;
        m.normals[k + 2] = nz1;
      }
    }
    return m;
  }

  private render(t: number) {
    const r = this.net.rect;
    // orthographic: desk pixels straight onto this window, so a note straddling
    // two windows lines up exactly across the gap between them
    const vp = new Float32Array(16);
    vp[0] = 2 / r.w;
    vp[5] = 2 / r.h;
    vp[10] = -1 / 40000;
    vp[12] = -1 - (2 * r.x) / r.w;
    vp[13] = 1 + (2 * r.y) / r.h;
    vp[15] = 1;

    const visible = (n: NoteState) => n.x > r.x - NOTE_W && n.x < r.x + r.w + NOTE_W && n.y > r.y - NOTE_W && n.y < r.y + r.h + NOTE_W;
    const ordered = [...this.notes].sort((a, b) => a.z - b.z);
    const sheets: SheetDraw[] = [];
    ordered.forEach((n, rank) => {
      if (!visible(n)) return;
      const m = this.meshFor(n, rank * 160);
      const stamps = new Float32Array(24).fill(-1);
      const inks = new Float32Array(18);
      n.stamps.slice(-6).forEach((s, i) => {
        stamps.set([s.u, s.v, s.r, stampCell(s.c)], i * 4);
        const ink = s.c >= 0 ? COUNTRIES[s.c].stampInk : ([0.62, 0.08, 0.06] as [number, number, number]);
        inks.set(lin(ink), i * 3);
      });
      sheets.push({
        id: n.id,
        cols: COLS,
        rows: ROWS,
        positions: m.positions,
        normals: m.normals,
        uvs: UVS,
        indices: INDICES,
        uniforms: { ...this.uniforms, uStamps: stamps, uStampInk: inks },
      });
    });
    // forget meshes of notes that are gone
    if (this.meshes.size > this.notes.length + 8) {
      const live = new Set(this.notes.map((n) => n.id));
      for (const id of this.meshes.keys()) if (!live.has(id)) {
        this.meshes.delete(id);
        this.renderer.releaseSheet(id);
      }
    }

    const neighbors = new Float32Array(16);
    this.net
      .windows()
      .filter((p) => p.id !== this.net.id)
      .slice(0, 4)
      .forEach((p, i) => neighbors.set([p.rect.x - r.x, p.rect.y - r.y, p.rect.w, p.rect.h], i * 4));
    const pulses = new Float32Array(16).fill(-1);
    this.pulses.slice(-4).forEach((p, i) => pulses.set([p.x, p.y, p.t, p.kind], i * 4));
    const u = this.uniforms;

    this.renderer.frame(
      {
        uRes: [this.canvas.width, this.canvas.height],
        uDpr: this.canvas.width / window.innerWidth,
        uTime: t,
        uTint: u.uIris1 as number[],
        uTint2: u.uIris2 as number[],
        uSeed: (this.countryIndex * 0.37) % 1,
        uNeighbors: neighbors,
        uPulses: pulses,
      },
      {
        uViewProj: vp,
        uEye: [r.x + r.w / 2, -(r.y + r.h / 2), 100000],
        uTime: t,
        uKeyDir: norm3([-0.45, 0.75, 0.6]),
        uKeyCol: [1.1, 0.98, 0.86],
        uFillDir: norm3([0.6, -0.2, 0.8]),
        uFillCol: [0.14, 0.15, 0.18],
        uAmbient: [0.13, 0.13, 0.14],
        uRoom: 1,
        uBackPos: [0, 0, 0],
        uTorch: [0, 0, 0, 0],
        uTorchDir: [0, 0, -1],
        uFibres: 0,
        uCam: 0,
        uCamScale: [1, 1],
      },
      sheets,
    );
  }

  // ------------------------------------------------------------ hud

  private emitHud(now: number) {
    if (now - this.hudAt < 150) return;
    this.hudAt = now;
    const r: Rect = this.net.rect;
    const here = this.notes.filter((n) => n.x > r.x && n.x < r.x + r.w && n.y > r.y && n.y < r.y + r.h).length;
    const wins: PeerInfo[] = this.net.windows();
    this.onHud?.({
      country: this.country,
      countryIndex: this.countryIndex,
      leader: this.net.isLeader,
      open: wins.map((p) => ({ country: p.country, self: p.id === this.net.id })).sort((a, b) => a.country - b.country),
      notesHere: here,
      totalNotes: this.notes.length,
      connected: this.net.connected,
    });
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

function norm3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}
