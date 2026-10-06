import type { Msg, PeerInfo, Rect } from './types';

// Windows of the same site find each other over a BroadcastChannel. Each one
// reports where its viewport sits on the desktop; the oldest visible window
// runs the physics for everybody and broadcasts the state of every note.
// If it closes, the next oldest picks up from the last state it heard.

const CHANNEL = 'dodo-reserve-borders';
const HEARTBEAT_MS = 250;
const STALE_MS = 1600;

const params = new URLSearchParams(location.search);
// for testing several "windows" in one headless browser: fake where we are
const fakeX = params.has('wx') ? Number(params.get('wx')) : null;
const fakeY = params.has('wy') ? Number(params.get('wy')) : null;

/** this window's viewport, in desktop pixels */
export function viewportRect(): Rect {
  const chromeX = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const chromeY = Math.max(0, window.outerHeight - window.innerHeight - chromeX);
  return {
    x: fakeX ?? window.screenX + chromeX,
    y: fakeY ?? window.screenY + chromeY,
    w: window.innerWidth,
    h: window.innerHeight,
  };
}

function sameRect(a: Rect, b: Rect) {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}

export class Net {
  readonly id = Math.random().toString(36).slice(2, 10);
  readonly born: number;
  readonly country: number;
  rect: Rect = viewportRect();
  visible = document.visibilityState !== 'hidden';
  readonly peers = new Map<string, PeerInfo>();
  leaderId = this.id;

  private channel: BroadcastChannel | null;
  private lastBeat = 0;
  private handlers: ((m: Msg) => void)[] = [];

  constructor(country: number) {
    this.country = country;
    // birth order decides who simulates; a reloaded window simply becomes the newest
    this.born = Date.now() + Math.random();
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
    if (this.channel) this.channel.onmessage = (e) => this.receive(e.data as Msg);
    document.addEventListener('visibilitychange', () => {
      this.visible = document.visibilityState !== 'hidden';
      this.announce('rect');
    });
    window.addEventListener('pagehide', () => this.send({ t: 'bye', from: this.id }));
    this.announce('hello');
  }

  get isLeader() {
    return this.leaderId === this.id;
  }

  get connected() {
    return !!this.channel;
  }

  on(handler: (m: Msg) => void) {
    this.handlers.push(handler);
  }

  send(m: Msg) {
    this.channel?.postMessage(m);
  }

  private announce(t: 'hello' | 'rect') {
    this.send({ t, from: this.id, born: this.born, country: this.country, rect: this.rect, visible: this.visible });
  }

  private receive(m: Msg) {
    if (m.from === this.id) return;
    if (m.t === 'hello' || m.t === 'rect') {
      const known = this.peers.has(m.from);
      this.peers.set(m.from, { id: m.from, born: m.born, country: m.country, rect: m.rect, visible: m.visible, seen: performance.now() });
      // a newcomer needs to know about us right away
      if (m.t === 'hello' || !known) this.announce('rect');
      this.elect();
    } else if (m.t === 'bye') {
      this.peers.delete(m.from);
      this.elect();
    } else {
      const p = this.peers.get(m.from);
      if (p) p.seen = performance.now();
    }
    for (const h of this.handlers) h(m);
  }

  /** the oldest visible window leads; ties broken by id */
  private elect() {
    const all: { id: string; born: number; visible: boolean }[] = [
      { id: this.id, born: this.born, visible: this.visible },
      ...[...this.peers.values()],
    ];
    const live = all.filter((p) => p.visible);
    const pool = live.length ? live : all;
    pool.sort((a, b) => a.born - b.born || (a.id < b.id ? -1 : 1));
    this.leaderId = pool[0].id;
  }

  /** call every frame: tracks our position, keeps peers fresh */
  tick(now: number) {
    const r = viewportRect();
    const moved = !sameRect(r, this.rect);
    this.rect = r;
    if (moved || now - this.lastBeat > HEARTBEAT_MS) {
      this.lastBeat = now;
      this.announce('rect');
    }
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.seen > STALE_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed || moved) this.elect();
  }

  /** every window that currently forms part of the world, including this one */
  windows(): PeerInfo[] {
    const me: PeerInfo = { id: this.id, born: this.born, country: this.country, rect: this.rect, visible: this.visible, seen: performance.now() };
    return [me, ...this.peers.values()].filter((p) => p.visible);
  }

  dispose() {
    this.send({ t: 'bye', from: this.id });
    this.channel?.close();
    this.channel = null;
  }
}
