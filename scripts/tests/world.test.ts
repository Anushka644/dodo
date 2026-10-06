// Desk physics without a browser: windows as boxes, money crossing borders.
// run: npx --yes tsx@4 scripts/tests/world.test.ts
import { DeskWorld } from '../../src/borders/world';
import type { PeerInfo, Rect } from '../../src/borders/types';

const win = (id: string, country: number, rect: Rect): PeerInfo => ({ id, born: 0, country, rect, visible: true, seen: 0 });
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const run = (w: DeskWorld, wins: PeerInfo[], seconds: number, leader = 'A') => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    w.syncWindows(wins, 1 / 60);
    w.step(1 / 60, leader);
  }
};

// 1. money settles on the floor of its window
{
  const w = new DeskWorld();
  const A = win('A', 0, { x: 0, y: 0, w: 900, h: 700 });
  w.syncWindows([A], 0);
  w.print('A', 3);
  run(w, [A], 4);
  const s = w.snapshot();
  const allIn = s.every((n) => n.x > 0 && n.x < 900 && n.y > 0 && n.y < 700);
  const resting = s.every((n) => Math.hypot(n.vx, n.vy) < 40);
  check('notes stay inside a lone window and come to rest', allIn && resting, JSON.stringify(s.map((n) => [Math.round(n.x), Math.round(n.y)])));
  check('freshly printed notes have clean passports', s.every((n) => n.stamps.length === 0));
}

// 2. a hard throw at the right edge clears customs and lands in the next window
{
  const w = new DeskWorld();
  const A = win('A', 0, { x: 0, y: 100, w: 800, h: 600 });
  const B = win('B', 1, { x: 860, y: 140, w: 700, h: 560 });
  w.syncWindows([A, B], 0);
  const id = w.spawn(500, 500, 2600, -400, 0, 0, 0, 'A');
  run(w, [A, B], 3);
  const n = w.snapshot().find((x) => x.id === id)!;
  check('hard throw crosses into the neighbouring window', n.x > 860 && n.x < 1560 && n.y > 140 && n.y < 700, `at ${Math.round(n.x)},${Math.round(n.y)}`);
  check('entering India stamps the note', n.home === 1 && n.stamps.some((s) => s.c === 1), JSON.stringify(n.stamps.map((s) => s.c)));
}

// 3. a soft throw bounces off a closed border
{
  const w = new DeskWorld();
  const A = win('A', 0, { x: 0, y: 100, w: 800, h: 600 });
  const B = win('B', 1, { x: 860, y: 140, w: 700, h: 560 });
  w.syncWindows([A, B], 0);
  const id = w.spawn(500, 500, 700, -100, 0, 0, 0, 'A');
  run(w, [A, B], 3);
  const n = w.snapshot().find((x) => x.id === id)!;
  check('a weak throw stays home', n.x < 800, `at ${Math.round(n.x)}`);
}

// 4. overlapping windows: money falls from one into the other
{
  const w = new DeskWorld();
  const A = win('A', 0, { x: 100, y: 0, w: 700, h: 500 });
  const B = win('B', 2, { x: 0, y: 380, w: 900, h: 600 });
  w.syncWindows([A, B], 0);
  const id = w.spawn(450, 150, 0, 0, 0.1, 0, 0, 'A');
  run(w, [A, B], 3);
  const n = w.snapshot().find((x) => x.id === id)!;
  check('an overlap is an open border: it falls through', n.y > 500 && n.home === 2, `y=${Math.round(n.y)} home=${n.home}`);
}

// 5. thrown into nowhere: returned to sender
{
  const w = new DeskWorld();
  const A = win('A', 0, { x: 0, y: 0, w: 800, h: 600 });
  const B = win('B', 1, { x: 1400, y: 0, w: 600, h: 600 });
  w.syncWindows([A, B], 0);
  const id = w.spawn(400, 300, 3000, 0, 0, 0, 0, 'A');
  // B vanishes mid-flight
  for (let t = 0; t < 0.15; t += 1 / 60) { w.syncWindows([A, B], 1 / 60); w.step(1 / 60, 'A'); }
  run(w, [A], 4);
  const n = w.snapshot().find((x) => x.id === id)!;
  const returned = n.stamps.some((s) => s.c === -1);
  check('a payment with nowhere to land is returned to sender', returned && n.x > 0 && n.x < 800, `x=${Math.round(n.x)} stamps=${JSON.stringify(n.stamps.map((s) => s.c))}`);
}

// 6. dragging a window shoves its money (kinematic walls)
{
  const w = new DeskWorld();
  let A = win('A', 0, { x: 0, y: 0, w: 800, h: 600 });
  w.syncWindows([A], 0);
  w.print('A', 4);
  run(w, [A], 3);
  for (let i = 0; i < 40; i++) {
    A = win('A', 0, { x: i * 12, y: 0, w: 800, h: 600 });
    w.syncWindows([A], 1 / 60);
    w.step(1 / 60, 'A');
  }
  run(w, [A], 2);
  const s = w.snapshot();
  check('moving a window carries its money along', s.every((n) => n.x > A.rect.x && n.x < A.rect.x + 800), JSON.stringify(s.map((n) => Math.round(n.x))));
}

// 7. snapshot → load keeps ids, stamps and positions (leader handover)
{
  const w = new DeskWorld();
  const A = win('A', 0, { x: 0, y: 0, w: 800, h: 600 });
  w.syncWindows([A], 0);
  w.print('A', 3);
  run(w, [A], 1);
  const before = w.snapshot();
  const w2 = new DeskWorld();
  w2.syncWindows([A], 0);
  w2.load(before, [A]);
  const after = w2.snapshot();
  const same = before.every((b) => after.some((a) => a.id === b.id && Math.abs(a.x - b.x) < 1 && a.stamps.length === b.stamps.length));
  check('a new leader picks up exactly where the old one left off', same);
}

// 8. performance: 36 notes across 3 windows
{
  const w = new DeskWorld();
  const wins = [win('A', 0, { x: 0, y: 0, w: 800, h: 600 }), win('B', 1, { x: 840, y: 0, w: 800, h: 600 }), win('C', 2, { x: 0, y: 640, w: 1640, h: 500 })];
  w.syncWindows(wins, 0);
  for (const id of ['A', 'B', 'C']) w.print(id, 12);
  const t0 = performance.now();
  run(w, wins, 5);
  const ms = (performance.now() - t0) / (5 * 60);
  check('36 notes settling in piles step in under 5 ms per frame', ms < 5, `${ms.toFixed(2)} ms/frame`);
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
