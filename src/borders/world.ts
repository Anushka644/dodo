import { World, Box, MouseJoint, type Body, type Contact } from 'planck';
import { ASPECT } from '../note/layout';
import { NOTE_W, type NoteState, type PeerInfo, type Rect, type Stamp } from './types';

// One physics world for the whole desktop. Every visible window is a box
// with four walls that move when you drag the window around, so the money
// inside sloshes. Borders open where windows overlap, and a hard enough
// throw clears customs and flies across the gap to the next window.

const S = 100; // desk pixels per physics metre
const NOTE_H = NOTE_W / ASPECT;
const WALL = 400; // wall thickness (px): thick, so fast windows can't tunnel
const GRAVITY = 1700; // px/s², theatrical rather than real
const CROSS_SPEED = 1150; // px/s: how hard you must throw to clear customs
const TRANSIT_MAX = 1.6; // s outside every window before it's returned to sender
const MAX_NOTES = 36;
const MAX_STAMPS = 6;

type WallSide = 'l' | 'r' | 't' | 'b';

interface Win {
  id: string;
  country: number;
  rect: Rect;
  walls: Record<WallSide, Body>;
  w: number;
  h: number;
}

interface NoteBody {
  id: number;
  body: Body;
  home: number; // country index
  homeWin: string | null;
  inWin: string | null;
  stamps: Stamp[];
  z: number;
  transit: number; // seconds outside every window
  crossing: string | null; // "winId:side" it's allowed through
  flip: number;
  flipVel: number;
  touching: boolean;
  bend: number;
  phase: number;
}

export interface WorldEvent {
  kind: 'stamp' | 'returned' | 'thud';
  note: number;
  country: number;
  x: number;
  y: number;
  strength: number;
}

const inside = (r: Rect, x: number, y: number, pad = 0) => x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad;

export class DeskWorld {
  private world = new World({ gravity: { x: 0, y: GRAVITY / S } });
  private ground: Body;
  private wins = new Map<string, Win>();
  private notes = new Map<number, NoteBody>();
  private grabs = new Map<string, { joint: MouseJoint; note: number }>();
  private nextId = 1;
  private zTop = 1;
  private time = 0;
  events: WorldEvent[] = [];

  constructor() {
    this.ground = this.world.createBody();
    this.world.on('pre-solve', (c: Contact) => this.filter(c));
  }

  /** gravity as a direction (unit-ish vector, y down); phones tilt it */
  setGravity(g: { x: number; y: number }) {
    this.world.setGravity({ x: (g.x * GRAVITY) / S, y: (g.y * GRAVITY) / S });
  }

  // ------------------------------------------------------------ windows

  /** keep one box per visible window, moving its walls to where the window is now */
  syncWindows(list: PeerInfo[], dt: number) {
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.id);
      let w = this.wins.get(p.id);
      if (!w || Math.abs(w.w - p.rect.w) > 1 || Math.abs(w.h - p.rect.h) > 1) {
        if (w) this.destroyWin(w);
        w = this.createWin(p);
        this.wins.set(p.id, w);
      } else {
        // kinematic walls move by velocity, so a dragged window shoves its contents
        const dx = p.rect.x - w.rect.x;
        const dy = p.rect.y - w.rect.y;
        const jump = Math.hypot(dx, dy) > 900; // moved to another screen: don't fling everything
        for (const side of ['l', 'r', 't', 'b'] as WallSide[]) {
          const b = w.walls[side];
          if (jump || dt <= 0) {
            const pos = b.getPosition();
            b.setPosition({ x: pos.x + dx / S, y: pos.y + dy / S });
            b.setLinearVelocity({ x: 0, y: 0 });
          } else b.setLinearVelocity({ x: dx / S / dt, y: dy / S / dt });
        }
        if (jump) for (const n of this.notes.values()) if (n.inWin === w.id) n.body.setPosition({ x: n.body.getPosition().x + dx / S, y: n.body.getPosition().y + dy / S });
        w.rect = { ...p.rect };
        w.country = p.country;
      }
    }
    for (const [id, w] of this.wins) if (!seen.has(id)) this.destroyWin(w);
  }

  private createWin(p: PeerInfo): Win {
    const r = p.rect;
    const mk = (cx: number, cy: number, hw: number, hh: number, side: WallSide) => {
      const b = this.world.createBody({ type: 'kinematic', position: { x: cx / S, y: cy / S } });
      b.createFixture({ shape: new Box(hw / S, hh / S), friction: 0.7, restitution: 0.12, userData: { wall: p.id, side } });
      return b;
    };
    const walls = {
      l: mk(r.x - WALL / 2, r.y + r.h / 2, WALL / 2, r.h / 2 + WALL, 'l'),
      r: mk(r.x + r.w + WALL / 2, r.y + r.h / 2, WALL / 2, r.h / 2 + WALL, 'r'),
      t: mk(r.x + r.w / 2, r.y - WALL / 2, r.w / 2 + WALL, WALL / 2, 't'),
      b: mk(r.x + r.w / 2, r.y + r.h + WALL / 2, r.w / 2 + WALL, WALL / 2, 'b'),
    };
    return { id: p.id, country: p.country, rect: { ...r }, walls, w: r.w, h: r.h };
  }

  private destroyWin(w: Win) {
    for (const b of Object.values(w.walls)) this.world.destroyBody(b);
    this.wins.delete(w.id);
  }

  private winAt(x: number, y: number, except?: string): Win | null {
    for (const w of this.wins.values()) if (w.id !== except && inside(w.rect, x, y)) return w;
    return null;
  }

  // ------------------------------------------------------------ customs

  /** decide, contact by contact, whether a wall is a wall right now */
  private filter(c: Contact) {
    const a = c.getFixtureA().getUserData() as { wall?: string; side?: WallSide; note?: number } | null;
    const b = c.getFixtureB().getUserData() as { wall?: string; side?: WallSide; note?: number } | null;
    const wallData = a?.wall ? a : b?.wall ? b : null;
    const noteData = a?.note ? a : b?.note ? b : null;
    if (!wallData || !noteData) return;
    const w = this.wins.get(wallData.wall!);
    const n = this.notes.get(noteData.note!);
    if (!w || !n) return;
    const p = n.body.getPosition();
    const x = p.x * S;
    const y = p.y * S;
    // walls only keep money in; from outside, a window is just an opening
    if (!inside(w.rect, x, y)) return c.setEnabled(false);
    // open border: the space beyond this wall belongs to another window
    const r = w.rect;
    const probe =
      wallData.side === 'l' ? [r.x - 24, y] : wallData.side === 'r' ? [r.x + r.w + 24, y] : wallData.side === 't' ? [x, r.y - 24] : [x, r.y + r.h + 24];
    if (this.winAt(probe[0], probe[1], w.id)) return c.setEnabled(false);
    // cleared customs: thrown hard enough, toward another country
    if (n.crossing === `${w.id}:${wallData.side}`) return c.setEnabled(false);
  }

  /** a throw toward a side with a country beyond it is allowed through */
  private customs(n: NoteBody) {
    const v = n.body.getLinearVelocity();
    const speed = Math.hypot(v.x, v.y) * S;
    const w = n.inWin ? this.wins.get(n.inWin) : null;
    if (!w || speed < CROSS_SPEED) {
      if (speed < CROSS_SPEED * 0.6) n.crossing = null;
      return;
    }
    const vx = v.x / Math.hypot(v.x, v.y);
    const vy = v.y / Math.hypot(v.x, v.y);
    const side: WallSide = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'r' : 'l') : vy > 0 ? 'b' : 't';
    if (this.targetFrom(w, side, n)) n.crossing = `${w.id}:${side}`;
  }

  /** the window a throw through this side should land in, if any */
  private targetFrom(from: Win, side: WallSide, n: NoteBody): Win | null {
    const p = n.body.getPosition();
    const x = p.x * S;
    const y = p.y * S;
    let best: Win | null = null;
    let bestD = Infinity;
    for (const w of this.wins.values()) {
      if (w.id === from.id) continue;
      const r = w.rect;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const ok =
        side === 'r' ? r.x >= from.rect.x + from.rect.w * 0.5 : side === 'l' ? r.x + r.w <= from.rect.x + from.rect.w * 0.5 : side === 'b' ? r.y >= from.rect.y + from.rect.h * 0.5 : r.y + r.h <= from.rect.y + from.rect.h * 0.5;
      if (!ok) continue;
      const d = Math.hypot(cx - x, cy - y);
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  /** once it's out, steer the arc so it actually lands in the country it was thrown at */
  private assist(n: NoteBody) {
    if (!n.crossing) return;
    const [winId, side] = n.crossing.split(':') as [string, WallSide];
    const from = this.wins.get(winId);
    if (!from) return;
    const to = this.targetFrom(from, side, n);
    if (!to) return;
    const p = n.body.getPosition();
    const x = p.x * S;
    const y = p.y * S;
    const r = to.rect;
    const inset = Math.min(NOTE_W * 0.7, r.w * 0.3);
    const tx = Math.min(r.x + r.w - inset, Math.max(r.x + inset, side === 'r' ? r.x + inset : side === 'l' ? r.x + r.w - inset : x));
    const ty = Math.min(r.y + r.h - NOTE_H, Math.max(r.y + NOTE_H, side === 'b' ? r.y + NOTE_H * 1.2 : side === 't' ? r.y + r.h * 0.4 : y - 40));
    const v = n.body.getLinearVelocity();
    const speed = Math.max(900, Math.hypot(v.x, v.y) * S);
    const dist = Math.hypot(tx - x, ty - y);
    const t = Math.min(0.85, Math.max(0.22, dist / speed));
    const vx = (tx - x) / t;
    const vy = (ty - y - 0.5 * GRAVITY * t * t) / t;
    n.body.setLinearVelocity({ x: vx / S, y: vy / S });
    n.crossing = null;
  }

  // ------------------------------------------------------------ notes

  spawn(x: number, y: number, vx: number, vy: number, angle: number, spin: number, home: number, winId: string | null): number {
    if (this.notes.size >= MAX_NOTES) {
      // the oldest note on the desk is withdrawn from circulation
      const oldest = [...this.notes.values()].filter((n) => ![...this.grabs.values()].some((g) => g.note === n.id)).sort((a, b) => a.z - b.z)[0];
      if (oldest) this.removeNote(oldest.id);
    }
    const id = this.nextId++;
    const body = this.world.createBody({
      type: 'dynamic',
      position: { x: x / S, y: y / S },
      angle,
      linearDamping: 0.9,
      angularDamping: 2.2,
      bullet: false,
    });
    body.createFixture({ shape: new Box(NOTE_W / 2 / S, NOTE_H / 2 / S), density: 0.12, friction: 0.55, restitution: 0.18, userData: { note: id } });
    body.setLinearVelocity({ x: vx / S, y: vy / S });
    body.setAngularVelocity(spin);
    this.notes.set(id, {
      id,
      body,
      home,
      homeWin: winId,
      inWin: winId,
      stamps: [],
      z: this.zTop++,
      transit: 0,
      crossing: null,
      flip: 0,
      flipVel: 0,
      touching: false,
      bend: 0,
      phase: Math.random() * 10,
    });
    return id;
  }

  private removeNote(id: number) {
    const n = this.notes.get(id);
    if (!n) return;
    for (const [k, g] of this.grabs) if (g.note === id) {
      this.world.destroyJoint(g.joint);
      this.grabs.delete(k);
    }
    this.world.destroyBody(n.body);
    this.notes.delete(id);
  }

  /** print money into a window: it falls in from the top */
  print(winId: string, count: number) {
    const w = this.wins.get(winId);
    if (!w) return;
    for (let i = 0; i < count; i++) {
      const r = w.rect;
      const x = r.x + r.w * (0.25 + Math.random() * 0.5);
      const y = r.y + NOTE_H * 0.8;
      this.spawn(x, y, (Math.random() - 0.5) * 500, 200 + Math.random() * 300, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 6, w.country, w.id);
    }
  }

  get count() {
    return this.notes.size;
  }

  // ------------------------------------------------------------ hands (pointers)

  input(key: string, kind: 'down' | 'move' | 'up', x: number, y: number) {
    const g = this.grabs.get(key);
    if (kind === 'down') {
      if (g) {
        this.world.destroyJoint(g.joint);
        this.grabs.delete(key);
      }
      const hit = [...this.notes.values()]
        .sort((a, b) => b.z - a.z)
        .find((n) => n.body.getFixtureList()?.testPoint({ x: x / S, y: y / S }));
      if (!hit) return false;
      hit.z = this.zTop++;
      hit.body.setAwake(true);
      const joint = this.world.createJoint(
        new MouseJoint({ maxForce: 900 * hit.body.getMass(), frequencyHz: 7, dampingRatio: 0.85 }, this.ground, hit.body, { x: x / S, y: y / S }),
      );
      if (joint) this.grabs.set(key, { joint, note: hit.id });
      return true;
    }
    if (!g) return false;
    if (kind === 'move') g.joint.setTarget({ x: x / S, y: y / S });
    else {
      this.world.destroyJoint(g.joint);
      this.grabs.delete(key);
    }
    return true;
  }

  // ------------------------------------------------------------ step

  step(dt: number, leaderWin: string) {
    this.time += dt;
    for (const n of this.notes.values()) this.customs(n);
    // fixed substeps keep stacks of money stable
    const sub = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / sub;
    for (let i = 0; i < sub; i++) this.world.step(h, 6, 2);

    for (const n of [...this.notes.values()]) {
      const p = n.body.getPosition();
      const x = p.x * S;
      const y = p.y * S;
      const v = n.body.getLinearVelocity();
      const speed = Math.hypot(v.x, v.y) * S;
      const was = n.inWin;
      const stillIn = was && this.wins.get(was) && inside(this.wins.get(was)!.rect, x, y) ? this.wins.get(was)! : null;
      const w = stillIn ?? this.winAt(x, y);
      n.inWin = w?.id ?? null;

      if (!w) {
        // in transit: between countries, belonging to none
        if (n.transit === 0) this.assist(n);
        n.transit += dt;
        const lost = n.transit > TRANSIT_MAX || !this.wins.has(n.homeWin ?? '') || Math.abs(x) > 40000 || Math.abs(y) > 40000;
        if (lost && n.transit > 0.2) this.returnToSender(n, leaderWin);
      } else {
        n.transit = 0;
        n.homeWin = w.id;
        if (w.country !== n.home) {
          // passport control
          n.home = w.country;
          this.stamp(n, w.country);
          this.events.push({ kind: 'stamp', note: n.id, country: w.country, x, y, strength: 1 });
        }
      }

      // visual life: notes tumble in the air and settle flat on landing
      const touching = this.touching(n.body);
      if (!touching && speed > 250) {
        n.flipVel += (Math.sign(n.body.getAngularVelocity() || 1) * Math.min(speed, 2400) * 0.006 - n.flipVel) * Math.min(1, dt * 3);
      } else {
        // settle to the nearest face, front or back
        const target = Math.round(n.flip / Math.PI) * Math.PI;
        n.flipVel += ((target - n.flip) * 30 - n.flipVel * 7) * dt;
      }
      n.flip += n.flipVel * dt;
      const bendTarget = touching ? 0 : Math.min(1, speed / 1600) * Math.sin(this.time * 11 + n.phase) * 0.8;
      n.bend += (bendTarget - n.bend) * Math.min(1, dt * 8);

      // the moment it lands, not every frame it lies there
      if (touching && !n.touching && speed > 380) this.events.push({ kind: 'thud', note: n.id, country: n.home, x, y, strength: Math.min(1, speed / 2000) });
      n.touching = touching;
    }
  }

  private touching(b: Body) {
    for (let ce = b.getContactList(); ce; ce = ce.next ?? null) {
      if (ce.contact.isTouching() && ce.contact.isEnabled()) return true;
    }
    return false;
  }

  private stamp(n: NoteBody, country: number) {
    const s: Stamp = {
      c: country,
      u: 0.35 + Math.random() * (ASPECT - 0.7),
      v: 0.28 + Math.random() * 0.44,
      r: (Math.random() - 0.5) * 0.9,
    };
    n.stamps.push(s);
    if (n.stamps.length > MAX_STAMPS) n.stamps.shift();
  }

  /** lost between countries: the payment bounces back where it came from */
  private returnToSender(n: NoteBody, leaderWin: string) {
    const w = this.wins.get(n.homeWin ?? '') ?? this.wins.get(leaderWin) ?? [...this.wins.values()][0];
    if (!w) return;
    const r = w.rect;
    n.body.setTransform({ x: (r.x + r.w / 2 + (Math.random() - 0.5) * r.w * 0.3) / S, y: (r.y + NOTE_H) / S }, (Math.random() - 0.5) * 0.6);
    n.body.setLinearVelocity({ x: 0, y: 3 });
    n.body.setAngularVelocity((Math.random() - 0.5) * 3);
    n.transit = 0;
    n.crossing = null;
    n.inWin = w.id;
    n.homeWin = w.id;
    n.home = w.country;
    n.stamps.push({ c: -1, u: 0.5 + Math.random() * (ASPECT - 1), v: 0.35 + Math.random() * 0.3, r: (Math.random() - 0.5) * 0.5 });
    if (n.stamps.length > MAX_STAMPS) n.stamps.shift();
    this.events.push({ kind: 'returned', note: n.id, country: w.country, x: r.x + r.w / 2, y: r.y + NOTE_H, strength: 1 });
  }

  // ------------------------------------------------------------ state

  snapshot(): NoteState[] {
    const out: NoteState[] = [];
    for (const n of this.notes.values()) {
      const p = n.body.getPosition();
      const v = n.body.getLinearVelocity();
      out.push({
        id: n.id,
        x: p.x * S,
        y: p.y * S,
        a: n.body.getAngle(),
        flip: n.flip,
        bend: n.bend,
        vx: v.x * S,
        vy: v.y * S,
        home: n.home,
        stamps: n.stamps,
        z: n.z,
        transit: n.inWin === null,
      });
    }
    return out;
  }

  /** pick up where the previous leader left off */
  load(notes: NoteState[], wins: PeerInfo[]) {
    for (const id of [...this.notes.keys()]) this.removeNote(id);
    for (const s of notes) {
      const w = wins.find((p) => inside(p.rect, s.x, s.y)) ?? null;
      const id = this.spawn(s.x, s.y, s.vx, s.vy, s.a, 0, s.home, w?.id ?? null);
      const n = this.notes.get(id)!;
      // keep the original id so every window agrees on which note is which
      this.notes.delete(id);
      n.id = s.id;
      n.body.getFixtureList()?.setUserData({ note: s.id });
      n.stamps = s.stamps.map((x) => ({ ...x }));
      n.flip = s.flip;
      n.bend = s.bend;
      n.z = s.z;
      this.notes.set(s.id, n);
      this.nextId = Math.max(this.nextId, s.id + 1);
      this.zTop = Math.max(this.zTop, s.z + 1);
    }
  }
}
