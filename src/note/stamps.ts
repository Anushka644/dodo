// Passport stamps.
//
// When a note crosses into a new window it is stamped by that country's
// border post, so a well-travelled note collects them. Every design lives in
// one grayscale atlas (white ink on black, 4 × 4 cells of 256 px) that the
// banknote shader samples as an overprinted rubber-stamp ink; the colour of
// each stamp comes from a uniform, so one mask serves every ink.
//
// Real immigration stamps are a small, strict vernacular — a border, the
// country, a date, an arrow for which way you were going — and their
// charm is in the rubber: uneven pressure, a starved corner, a stray fleck.

import { COUNTRIES } from '../borders/countries';
import { fillDodo } from './dodo';
import { FONTS } from './plates';

export const STAMP_CELLS = 4;
export const STAMP_ATLAS = 1024;
const CELL = STAMP_ATLAS / STAMP_CELLS;

/** atlas cells that don't belong to a country */
export const STAMP_RETURNED = COUNTRIES.length; // "RETURNED TO SENDER"
export const STAMP_CUSTOMS = COUNTRIES.length + 1; // "THE DODO RESERVE · CUSTOMS"
export const STAMP_TRANSIT = COUNTRIES.length + 2; // "IN TRANSIT"

/** country index → atlas cell; −1 → the "RETURNED TO SENDER" cell */
export function stampCell(c: number): number {
  if (c < 0) return STAMP_RETURNED;
  return c < COUNTRIES.length ? c : STAMP_CUSTOMS;
}

type Ctx = CanvasRenderingContext2D;

const MONO = '"IBM Plex Mono", ui-monospace, "DejaVu Sans Mono", monospace';
const SANS = '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "06 OCT 2026" */
export function stampDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// ---------------------------------------------------------------- type

interface TextOpts {
  size: number;
  family?: string;
  weight?: string;
  track?: number; // px between letters
  align?: 'left' | 'center' | 'right';
  maxW?: number; // squeeze horizontally to fit, like a condensed stamp face
}

function text(ctx: Ctx, s: string, x: number, y: number, o: TextOpts) {
  const chars = [...s];
  ctx.font = `${o.weight ?? '500'} ${o.size}px ${o.family ?? MONO}`;
  const track = o.track ?? 0;
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + track * (chars.length - 1);
  const k = o.maxW && total > o.maxW ? o.maxW / total : 1;
  const align = o.align ?? 'center';
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, 1);
  let cx = align === 'center' ? -total / 2 : align === 'right' ? -total : 0;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  chars.forEach((ch, i) => {
    ctx.fillText(ch, cx, 0);
    cx += widths[i] + track;
  });
  ctx.restore();
  return total * k;
}

/**
 * Text on a circle. `top` text reads clockwise over the top with its feet
 * on radius r; bottom text reads anticlockwise under the bottom with its
 * feet on radius r and its head towards the centre.
 */
function arcText(ctx: Ctx, s: string, r: number, centre: number, top: boolean, o: TextOpts) {
  const chars = [...s];
  ctx.font = `${o.weight ?? '500'} ${o.size}px ${o.family ?? MONO}`;
  const track = o.track ?? 0;
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + track * (chars.length - 1);
  let acc = 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  chars.forEach((ch, i) => {
    const mid = (acc + widths[i] / 2 - total / 2) / r;
    const a = top ? centre + mid : centre - mid;
    ctx.save();
    ctx.translate(Math.cos(a) * r, Math.sin(a) * r);
    ctx.rotate(top ? a + Math.PI / 2 : a - Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    acc += widths[i] + track;
  });
}

// ---------------------------------------------------------------- shapes

function ring(ctx: Ctx, r: number, w: number) {
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
}

function roundRect(ctx: Ctx, w: number, h: number, r: number, lw: number) {
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, r);
  ctx.stroke();
}

function polygon(ctx: Ctx, n: number, r: number, rot: number, lw: number, sx = 1) {
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    ctx.lineTo(Math.cos(a) * r * sx, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.stroke();
}

// rectangle with its corners clipped off, like a customs chop
function chamfer(ctx: Ctx, w: number, h: number, c: number, lw: number) {
  const x = w / 2;
  const y = h / 2;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(-x + c, -y);
  ctx.lineTo(x - c, -y);
  ctx.lineTo(x, -y + c);
  ctx.lineTo(x, y - c);
  ctx.lineTo(x - c, y);
  ctx.lineTo(-x + c, y);
  ctx.lineTo(-x, y - c);
  ctx.lineTo(-x, -y + c);
  ctx.closePath();
  ctx.stroke();
}

// corners notched inwards (quarter circles), like a ticket
function ticket(ctx: Ctx, w: number, h: number, n: number, lw: number) {
  const x = w / 2;
  const y = h / 2;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(-x + n, -y);
  ctx.lineTo(x - n, -y);
  ctx.arc(x, -y, n, Math.PI, Math.PI / 2, true);
  ctx.lineTo(x, y - n);
  ctx.arc(x, y, n, -Math.PI / 2, Math.PI, true);
  ctx.lineTo(-x + n, y);
  ctx.arc(-x, y, n, 0, -Math.PI / 2, true);
  ctx.lineTo(-x, -y + n);
  ctx.arc(-x, -y, n, Math.PI / 2, 0, true);
  ctx.closePath();
  ctx.stroke();
}

function hline(ctx: Ctx, x0: number, x1: number, y: number, w: number) {
  ctx.fillRect(x0, y - w / 2, x1 - x0, w);
}

/** a solid arrow pointing along +x (rotate the context for other directions) */
function arrow(ctx: Ctx, x: number, y: number, len: number, w: number, dir = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir, 1);
  const head = w * 2.3;
  ctx.beginPath();
  ctx.moveTo(-len / 2, -w / 2);
  ctx.lineTo(len / 2 - head, -w / 2);
  ctx.lineTo(len / 2 - head, -w * 1.5);
  ctx.lineTo(len / 2, 0);
  ctx.lineTo(len / 2 - head, w * 1.5);
  ctx.lineTo(len / 2 - head, w / 2);
  ctx.lineTo(-len / 2, w / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function star(ctx: Ctx, x: number, y: number, r: number, points = 5) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
    const rr = i % 2 ? r * 0.42 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

/** a small aeroplane, seen from above, nose along +x */
function plane(ctx: Ctx, x: number, y: number, s: number, rot = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(s / 24, s / 24);
  ctx.beginPath();
  ctx.moveTo(12, 0);
  ctx.quadraticCurveTo(11, -1.6, 7, -1.6);
  ctx.lineTo(2, -1.6);
  ctx.lineTo(-4, -11);
  ctx.lineTo(-7, -11);
  ctx.lineTo(-3, -1.6);
  ctx.lineTo(-8, -1.6);
  ctx.lineTo(-10.5, -5);
  ctx.lineTo(-12.5, -5);
  ctx.lineTo(-11, 0);
  ctx.lineTo(-12.5, 5);
  ctx.lineTo(-10.5, 5);
  ctx.lineTo(-8, 1.6);
  ctx.lineTo(-3, 1.6);
  ctx.lineTo(-7, 11);
  ctx.lineTo(-4, 11);
  ctx.lineTo(2, 1.6);
  ctx.lineTo(7, 1.6);
  ctx.quadraticCurveTo(11, 1.6, 12, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------- the designs
//
// Each is drawn centred on (0, 0) in a 256 px cell and stays inside a
// 236 px circle (rectangles inside a 232 px square), so the shader can
// treat every stamp as a disc of the same size.

type Design = (ctx: Ctx, date: string) => void;

const BIG = (size: number): TextOpts => ({ size, family: SANS, weight: '700', track: size * 0.02 });

const designs: Record<string, Design> = {
  // U.S. Customs and Border Protection: a squarish double box, ADMITTED.
  US(ctx, date) {
    roundRect(ctx, 214, 156, 14, 7);
    roundRect(ctx, 194, 136, 7, 2.5);
    text(ctx, 'UNITED STATES', 0, -44, { size: 17, track: 3.2, maxW: 170 });
    hline(ctx, -86, 86, -36, 2.5);
    text(ctx, 'US', -46, 23, BIG(62));
    text(ctx, 'ADMITTED', 44, -2, { size: 15, track: 1, maxW: 80 });
    arrow(ctx, 44, 17, 64, 5.5);
    hline(ctx, -86, 86, 36, 2.5);
    text(ctx, date, 0, 58, { size: 17, track: 2, maxW: 170 });
  },

  // Bureau of Immigration: double ring, the name on the arc.
  IN(ctx, date) {
    ring(ctx, 112, 7);
    ring(ctx, 100, 2.5);
    ring(ctx, 70, 2.5);
    arcText(ctx, 'IMMIGRATION · INDIA', 81, -Math.PI / 2, true, { size: 17, track: 2 });
    arcText(ctx, 'ARRIVAL', 92, Math.PI / 2, false, { size: 18, track: 5 });
    star(ctx, -94, 6, 6);
    star(ctx, 94, 6, 6);
    text(ctx, 'IN', 0, 10, BIG(54));
    hline(ctx, -58, 58, 21, 2.5);
    text(ctx, date, 0, 40, { size: 14, track: 1, maxW: 106 });
    arrow(ctx, 0, -46, 40, 4.5);
  },

  // Landing permission: a ticket with notched corners.
  JP(ctx, date) {
    ticket(ctx, 200, 200, 22, 6.5);
    ticket(ctx, 182, 182, 18, 2);
    text(ctx, 'JAPAN', 0, -58, { size: 22, track: 9 });
    text(ctx, 'JP', 0, 20, BIG(70));
    text(ctx, 'LANDING PERMIT', 0, 46, { size: 13, track: 1.6, maxW: 150 });
    hline(ctx, -70, 70, 54, 2);
    text(ctx, date, 0, 72, { size: 17, track: 1.5, maxW: 150 });
  },

  // An oval with a crown of text: leave to enter.
  GB(ctx, date) {
    ctx.save();
    ctx.scale(1, 0.72);
    ring(ctx, 114, 7);
    ring(ctx, 103, 2.5);
    ctx.restore();
    text(ctx, 'UNITED KINGDOM', 0, -42, { size: 14, track: 2, maxW: 124 });
    text(ctx, 'GB', 0, 18, { size: 56, family: FONTS.num, weight: '900', track: 2 });
    text(ctx, 'LEAVE TO ENTER', 0, 40, { size: 12, track: 1.6 });
    text(ctx, date, 0, 61, { size: 13, track: 1.2, maxW: 120 });
    hline(ctx, -92, -46, 4, 2.5);
    hline(ctx, 46, 92, 4, 2.5);
  },

  // Schengen: a rounded box, a ring of stars round the country, arrow in.
  FR(ctx, date) {
    roundRect(ctx, 220, 166, 18, 6.5);
    const cx = -50;
    const cy = -20;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      star(ctx, cx + Math.cos(a) * 40, cy + Math.sin(a) * 40, 6);
    }
    text(ctx, 'FR', cx, cy + 12, BIG(32));
    arrow(ctx, 48, -42, 60, 6);
    plane(ctx, 48, -10, 34);
    hline(ctx, -96, 96, 30, 2.5);
    text(ctx, date, 0, 54, { size: 19, track: 1.5, maxW: 186 });
    text(ctx, 'ROISSY-CDG  042', 0, 71, { size: 11, track: 1.4, maxW: 170 });
  },

  // Polícia Federal: a hexagon.
  BR(ctx, date) {
    polygon(ctx, 6, 116, 0, 7, 1);
    polygon(ctx, 6, 104, 0, 2.5, 1);
    text(ctx, 'BRASIL', 0, -46, { size: 20, track: 7 });
    text(ctx, 'BR', 0, 16, BIG(64));
    text(ctx, 'ENTRADA', -12, 40, { size: 14, track: 2 });
    arrow(ctx, 50, 35, 26, 4);
    text(ctx, date, 0, 64, { size: 15, track: 1.2, maxW: 140 });
    text(ctx, 'POLÍCIA FEDERAL', 0, -72, { size: 10, track: 1.2, maxW: 92 });
  },

  // Nigeria Immigration Service: an octagon, the eagle reduced to a star.
  NG(ctx, date) {
    polygon(ctx, 8, 116, Math.PI / 8, 7);
    polygon(ctx, 8, 103, Math.PI / 8, 2.5);
    text(ctx, 'NIGERIA', 0, -54, { size: 21, track: 6 });
    text(ctx, 'IMMIGRATION', 0, -35, { size: 13, track: 2.6 });
    text(ctx, 'NG', 0, 26, BIG(60));
    arrow(ctx, -66, 4, 28, 4.5);
    arrow(ctx, 66, 4, 28, 4.5, -1);
    text(ctx, date, 0, 54, { size: 15, track: 1, maxW: 124 });
    text(ctx, 'LAGOS', 0, 72, { size: 11, track: 3 });
  },

  // Korea Immigration Service: a pill with the code in a roundel.
  KR(ctx, date) {
    roundRect(ctx, 226, 128, 64, 7);
    ctx.save();
    ctx.translate(-64, 0);
    ring(ctx, 42, 3);
    text(ctx, 'KR', 0, 17, BIG(46));
    ctx.restore();
    text(ctx, 'KOREA', 34, -22, { size: 22, track: 6 });
    hline(ctx, -14, 84, -12, 2.5);
    text(ctx, 'ARRIVAL', 22, 10, { size: 14, track: 2 });
    arrow(ctx, 74, 5, 22, 3.5);
    text(ctx, date, 34, 34, { size: 15, track: 1, maxW: 110 });
  },

  // Instituto Nacional de Migración: a scalloped seal.
  MX(ctx, date) {
    ctx.lineWidth = 6.5;
    ctx.beginPath();
    const n = 30;
    for (let i = 0; i <= n * 8; i++) {
      const a = (i / (n * 8)) * Math.PI * 2;
      const r = 110 + 4.5 * Math.cos(a * n);
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.stroke();
    ring(ctx, 92, 2.5);
    arcText(ctx, 'MIGRACIÓN · MÉXICO', 73, -Math.PI / 2, true, { size: 15, track: 2 });
    arcText(ctx, 'ENTRADA', 82, Math.PI / 2, false, { size: 15, track: 4 });
    text(ctx, 'MX', 0, 14, BIG(54));
    hline(ctx, -52, 52, 26, 2.5);
    text(ctx, date, 0, 44, { size: 13, track: 0.8, maxW: 100 });
  },

  // A round chop with the crescent and star.
  TR(ctx, date) {
    ring(ctx, 113, 4);
    ring(ctx, 104, 7);
    ring(ctx, 66, 2.5);
    arcText(ctx, 'TÜRKİYE', 80, -Math.PI / 2, true, { size: 21, track: 8 });
    arcText(ctx, 'GİRİŞ', 88, Math.PI / 2, false, { size: 17, track: 7 });
    ctx.save();
    ctx.translate(-82, 26);
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.arc(3.5, 0, 8, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.restore();
    star(ctx, 82, 26, 7);
    text(ctx, 'TR', 0, 6, BIG(52));
    text(ctx, date, 0, 32, { size: 13, track: 0.8, maxW: 104 });
    arrow(ctx, 0, -44, 36, 4);
  },

  // Imigrasi: a chamfered box, arrival in Bahasa.
  ID(ctx, date) {
    chamfer(ctx, 216, 168, 26, 7);
    chamfer(ctx, 198, 150, 20, 2.5);
    text(ctx, 'IMIGRASI', 0, -48, { size: 21, track: 5.5 });
    text(ctx, 'INDONESIA', 0, -28, { size: 13, track: 4 });
    text(ctx, 'ID', -40, 30, BIG(62));
    text(ctx, 'KEDATANGAN', 44, 6, { size: 12.5, track: 0.4, maxW: 80 });
    arrow(ctx, 44, 22, 60, 5);
    text(ctx, date, 0, 62, { size: 16, track: 1.2, maxW: 160 });
  },

  // A single heavy ring with a perforated inner ring.
  AU(ctx, date) {
    ring(ctx, 110, 8);
    ctx.save();
    ctx.setLineDash([3, 5.2]);
    ring(ctx, 96, 3);
    ctx.restore();
    arcText(ctx, 'AUSTRALIA', 72, -Math.PI / 2, true, { size: 22, track: 6 });
    arcText(ctx, 'ARRIVED', 82, Math.PI / 2, false, { size: 16, track: 4 });
    text(ctx, 'AU', 0, 16, BIG(58));
    star(ctx, 0, -38, 8, 7);
    hline(ctx, -52, 52, 27, 2.5);
    text(ctx, date, 0, 45, { size: 13, track: 0.8, maxW: 96 });
    plane(ctx, 0, 59, 18, -Math.PI / 2);
  },
};

function returned(ctx: Ctx, date: string) {
  // the post office's rubber hand, pointing back where it came from
  roundRect(ctx, 228, 140, 6, 7);
  roundRect(ctx, 212, 124, 3, 2.5);
  ctx.save();
  ctx.translate(-72, -10);
  ctx.lineWidth = 9;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.arc(0, 0, 26, -Math.PI * 0.5, Math.PI * 0.62);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-16, -26);
  ctx.lineTo(4, -42);
  ctx.lineTo(4, -10);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  text(ctx, 'RETURNED', 34, -24, { size: 26, family: SANS, weight: '700', track: 1.5, maxW: 132 });
  text(ctx, 'TO SENDER', 34, 4, { size: 26, family: SANS, weight: '700', track: 1.5, maxW: 132 });
  hline(ctx, -100, 100, 18, 2.5);
  text(ctx, 'NO SUCH COUNTRY', 0, 37, { size: 14, track: 2.2, maxW: 190 });
  text(ctx, date, 0, 54, { size: 11, track: 1.6 });
}

function customs(ctx: Ctx, date: string) {
  // the house seal: the sitter's bust in a roundel, the date round the foot
  ring(ctx, 113, 7);
  ring(ctx, 101, 2.5);
  ring(ctx, 66, 2.5);
  arcText(ctx, 'THE DODO RESERVE', 78, -Math.PI / 2, true, { size: 18, family: FONTS.sc, weight: '400', track: 2 });
  arcText(ctx, `CUSTOMS · ${date}`, 87, Math.PI / 2, false, { size: 13, track: 1.4 });
  star(ctx, -86, -6, 5.5);
  star(ctx, 86, -6, 5.5);
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, 60, 0, Math.PI * 2);
  ctx.clip();
  fillDodo(ctx, 2, 18, 132, true);
  ctx.restore();
}

function transit(ctx: Ctx, date: string) {
  ctx.save();
  ctx.setLineDash([14, 7]);
  roundRect(ctx, 224, 112, 56, 6);
  ctx.restore();
  text(ctx, 'IN TRANSIT', 0, 2, { size: 30, family: SANS, weight: '700', track: 3, maxW: 180 });
  arrow(ctx, 0, 24, 120, 4.5);
  text(ctx, date, 0, 46, { size: 12, track: 1.4 });
}

// ---------------------------------------------------------------- rubber

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, s: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s);
  const b = hash(ix + 1, iy, s);
  const c = hash(ix, iy + 1, s);
  const d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Turns crisp artwork into a rubber impression: ink spreads a little and its
 * edge goes ragged, pressure falls off towards one side, the rubber misses
 * in a patch or two, and the odd fleck lands where it shouldn't.
 */
function rubber(src: HTMLCanvasElement): HTMLCanvasElement {
  const N = src.width;
  const out = document.createElement('canvas');
  out.width = N;
  out.height = N;
  const o = out.getContext('2d', { willReadFrequently: true })!;
  o.fillStyle = '#000';
  o.fillRect(0, 0, N, N);
  o.filter = 'blur(0.8px)';
  o.drawImage(src, 0, 0);
  o.filter = 'none';
  const img = o.getImageData(0, 0, N, N);
  const d = img.data;
  const crisp = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, N, N).data;
  for (let cy = 0; cy < STAMP_CELLS; cy++) {
    for (let cx = 0; cx < STAMP_CELLS; cx++) {
      const seed = cy * STAMP_CELLS + cx + 1;
      // which way the stamp was rocked as it came down
      const ang = hash(seed, 7, 3) * Math.PI * 2;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const press = 0.58 + hash(seed, 9, 4) * 0.22;
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          const X = cx * CELL + x;
          const Y = cy * CELL + y;
          const i = (Y * N + X) * 4;
          let v = d[i] / 255;
          const qx = (x - CELL / 2) / (CELL / 2);
          const qy = (y - CELL / 2) / (CELL / 2);
          // ragged edge: threshold the spread ink against fine noise
          const grain = vnoise(X / 2.2, Y / 2.2, seed) * 0.6 + vnoise(X / 5.5, Y / 5.5, seed + 40) * 0.4;
          v = smooth(0.3, 0.62, v + (grain - 0.5) * 0.42);
          if (v <= 0) {
            // a stray fleck now and then, close to the impression
            const f = hash(X, Y, seed + 99);
            if (f > 0.99935 && qx * qx + qy * qy < 0.85) {
              d[i] = d[i + 1] = d[i + 2] = Math.round(140 + 100 * hash(X, Y, 5));
            } else d[i] = d[i + 1] = d[i + 2] = 0;
            continue;
          }
          // pressure: heavy on one side, starved on the other
          const side = smooth(-1.1, 0.9, qx * dx + qy * dy);
          let dens = press + (1 - press) * side;
          // where the rubber held more or less ink
          dens *= 0.88 + 0.26 * vnoise(X / 13, Y / 13, seed + 7);
          // a patch or two where it barely touched (they nibble, they don't erase)
          const miss = vnoise(X / 17, Y / 17, seed + 17);
          dens *= 1 - 0.4 * smooth(0.7, 0.84, miss) * (1 - side * 0.5);
          // Thin ink doesn't go lighter, it breaks up: the paper's tooth
          // decides which specks catch it.
          const tooth = vnoise(X / 1.5, Y / 1.5, seed + 3) * 0.7 + hash(X, Y, seed + 5) * 0.3;
          const cover = smooth(tooth - 0.1, tooth + 0.1, dens * 1.22 - 0.1);
          const tone = 0.84 + 0.16 * vnoise(X / 5, Y / 5, seed + 21);
          // pinholes in the solid areas
          const pin = hash(X, Y, seed + 31) > 0.988 && crisp[i] > 250 ? 0.3 : 1;
          const g = Math.round(255 * Math.min(1, v * cover * tone * pin));
          d[i] = d[i + 1] = d[i + 2] = g;
        }
      }
    }
  }
  o.putImageData(img, 0, 0);
  return out;
}

/**
 * The atlas: 1024 × 1024, white ink on black, 4 × 4 cells of 256 px. Cells
 * 0–11 follow COUNTRIES, then RETURNED TO SENDER, DODO RESERVE · CUSTOMS and
 * IN TRANSIT; the last cell is blank. Every impression is dated `date`.
 * Call loadFonts() first.
 */
export function drawStampAtlas(date: Date): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = STAMP_ATLAS;
  c.height = STAMP_ATLAS;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, STAMP_ATLAS, STAMP_ATLAS);
  const when = stampDate(date);
  const cells: Design[] = COUNTRIES.map((k) => designs[k.code] ?? generic(k.code, k.name));
  cells.push(returned, customs, transit);
  cells.forEach((draw, i) => {
    ctx.save();
    ctx.translate((i % STAMP_CELLS) * CELL + CELL / 2, Math.floor(i / STAMP_CELLS) * CELL + CELL / 2);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    draw(ctx, when);
    ctx.restore();
  });
  return rubber(c);
}

// for a country added later without a design of its own
function generic(code: string, name: string): Design {
  return (ctx, date) => {
    ring(ctx, 112, 7);
    ring(ctx, 100, 2.5);
    arcText(ctx, name.toUpperCase(), 80, -Math.PI / 2, true, { size: 18, track: 2 });
    arcText(ctx, 'ARRIVAL', 88, Math.PI / 2, false, { size: 16, track: 4 });
    text(ctx, code, 0, 14, BIG(56));
    text(ctx, date, 0, 40, { size: 13, maxW: 110 });
  };
}
