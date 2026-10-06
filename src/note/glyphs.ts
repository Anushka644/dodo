// Currency symbols, set in the note's own typefaces.
//
// None of the faces on the note carry ₹ ₦ ₩ or ₺, and whatever the system
// falls back to (DejaVu, Kohinoor, Arial…) looks pasted in next to a Didone
// numeral. So those four are built the way a punchcutter would: from the
// face's own letters and its own stroke weights. ₦ and ₩ are N and W with
// two hairline bars, ₹ is an R without its stem plus two bars, and ₺ is a
// stem, two oblique bars and a contrasted bowl. Everything else is set as
// type, with a fallback stack behind it.

export const SYMBOL_FALLBACK = '"Noto Serif Display", "Noto Serif", "Times New Roman", "DejaVu Serif", Georgia, serif';

export interface Glyph {
  /** white ink on transparent, 1 canvas px = 1 plate px */
  c: HTMLCanvasElement;
  /** baseline origin of the first character, canvas px */
  ox: number;
  oy: number;
  /** ink bounds, canvas px: x0, y0, x1, y1 */
  ink: [number, number, number, number];
  /** advance width, px */
  adv: number;
}

const BUILT = new Set(['₹', '₦', '₩', '₺']);

type Ctx = CanvasRenderingContext2D;

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return { c, ctx };
}

/** A single letter rendered alone so its strokes can be measured and cut up. */
class Letter {
  c: HTMLCanvasElement;
  a: Uint8ClampedArray;
  ox: number;
  oy: number;
  adv: number;
  constructor(readonly ch: string, font: string, readonly em: number) {
    const { c, ctx } = canvas(em * 1.6, em * 1.6);
    this.c = c;
    this.ox = Math.round(em * 0.3);
    this.oy = Math.round(em * 1.2);
    ctx.font = font;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(ch, this.ox, this.oy);
    this.adv = ctx.measureText(ch).width;
    this.a = ctx.getImageData(0, 0, c.width, c.height).data;
  }
  at(x: number, y: number) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.c.width || y >= this.c.height) return 0;
    return this.a[(y * this.c.width + x) * 4 + 3];
  }
  /** runs of ink along a row: [start, end) pairs */
  row(y: number): [number, number][] {
    const out: [number, number][] = [];
    let s = -1;
    for (let x = 0; x <= this.c.width; x++) {
      const on = x < this.c.width && this.at(x, y) > 127;
      if (on && s < 0) s = x;
      if (!on && s >= 0) {
        out.push([s, x]);
        s = -1;
      }
    }
    return out;
  }
  col(x: number): [number, number][] {
    const out: [number, number][] = [];
    let s = -1;
    for (let y = 0; y <= this.c.height; y++) {
      const on = y < this.c.height && this.at(x, y) > 127;
      if (on && s < 0) s = y;
      if (!on && s >= 0) {
        out.push([s, y]);
        s = -1;
      }
    }
    return out;
  }
}

/** stroke weights of a face, measured off its own H */
interface Metrics {
  cap: number;
  stem: number;
  hair: number;
}

const metricsCache = new Map<string, Metrics>();
function metrics(font: string, em: number): Metrics {
  const key = `${font}|${em}`;
  const hit = metricsCache.get(key);
  if (hit) return hit;
  const H = new Letter('H', font, em);
  const rows = H.row(H.oy - em * 0.18);
  const stem = rows.length ? rows[0][1] - rows[0][0] : em * 0.12;
  let cap = em * 0.7;
  for (let y = 0; y < H.oy; y++) {
    if (H.row(y).length) {
      cap = H.oy - y;
      break;
    }
  }
  // the crossbar, measured through the middle of the counter
  const mid = rows.length > 1 ? (rows[0][1] + rows[rows.length - 1][0]) / 2 : H.ox + em * 0.35;
  const cols = H.col(mid);
  const hair = cols.length ? cols[0][1] - cols[0][0] : em * 0.03;
  const m = { cap, stem, hair };
  metricsCache.set(key, m);
  return m;
}

// a bar with sheared ends, like the strokes on a struck currency sign
function bar(ctx: Ctx, x0: number, x1: number, yc: number, t: number, shear: number) {
  const s = t * shear;
  ctx.beginPath();
  ctx.moveTo(x0 + s, yc - t / 2);
  ctx.lineTo(x1 + s, yc - t / 2);
  ctx.lineTo(x1 - s, yc + t / 2);
  ctx.lineTo(x0 - s, yc + t / 2);
  ctx.closePath();
  ctx.fill();
}

/** Draws one of the built symbols with its baseline-left at (x, y). Returns the advance. */
function drawBuilt(ctx: Ctx, ch: string, x: number, y: number, font: string, em: number): number {
  const M = metrics(font, em);
  const t = Math.max(M.hair * 1.45, em * 0.034); // bar weight
  ctx.fillStyle = '#fff';

  if (ch === '₦' || ch === '₩') {
    const L = new Letter(ch === '₦' ? 'N' : 'W', font, em);
    const ext = em * (ch === '₦' ? 0.07 : 0.045);
    const dx = x + ext - L.ox;
    ctx.drawImage(L.c, dx, y - L.oy);
    // ink extent of the letter
    let l = Infinity;
    let r = -Infinity;
    for (const yy of [L.oy - M.cap * 0.42, L.oy - M.cap * 0.62, L.oy - M.cap * 0.95, L.oy - 2]) {
      const runs = L.row(yy);
      if (runs.length) {
        l = Math.min(l, runs[0][0]);
        r = Math.max(r, runs[runs.length - 1][1]);
      }
    }
    if (!isFinite(l)) {
      l = L.ox;
      r = L.ox + L.adv;
    }
    const levels = ch === '₦' ? [0.4, 0.6] : [0.42, 0.6];
    for (const k of levels) bar(ctx, l + dx - ext, r + dx + ext, y - M.cap * k, t, 0);
    return L.adv + ext * 2;
  }

  if (ch === '₹') {
    // Drawn as a Didone would cut it: hairline-ish bars, a bowl hanging from
    // the top bar that swells on its right, and a thick diagonal leg.
    const C = M.cap;
    const s = M.stem;
    const h = M.hair;
    const W = em * 0.6;
    const x0 = x + em * 0.06;
    const t1 = Math.max(h * 2.1, em * 0.05);
    const t2 = Math.max(h * 1.8, em * 0.044);
    const yBot = y - C * 0.44; // bottom of the bowl, where the leg starts
    const yTop = y - C;
    const cy = (yTop + yBot) / 2;
    const ry = (yBot - yTop) / 2;
    const xl = x0 + W * 0.3;
    const rx = W * 0.56;
    const hb = Math.max(h * 1.6, em * 0.034); // the bowl's lower stroke
    ctx.beginPath();
    ctx.ellipse(xl, cy, rx, ry, 0, -Math.PI / 2, Math.PI / 2, false);
    ctx.lineTo(x0, yBot);
    ctx.lineTo(x0, yBot - hb);
    ctx.lineTo(xl, yBot - hb);
    ctx.ellipse(xl, cy, rx - s * 0.92, ry - hb, 0, Math.PI / 2, -Math.PI / 2, true);
    ctx.closePath();
    ctx.fill();
    // the leg
    const lw = s * 1.06;
    const lx0 = x0 + W * 0.2;
    const lx1 = x0 + W * 0.66;
    ctx.beginPath();
    ctx.moveTo(lx0, yBot - hb * 0.5);
    ctx.lineTo(lx0 + lw, yBot - hb * 0.5);
    ctx.lineTo(lx1 + lw, y);
    ctx.lineTo(lx1, y);
    ctx.closePath();
    ctx.fill();
    // bars, full width, ends sheared
    bar(ctx, x0, x0 + W + em * 0.05, yTop + t1 / 2, t1, 0.6);
    bar(ctx, x0, x0 + W + em * 0.05, y - C * 0.735, t2, 0.6);
    return W + em * 0.17;
  }

  // ₺: stem, two oblique bars, and a bowl that swells on its right like a Didone
  const s = M.stem;
  const h = M.hair;
  const x0 = x + em * 0.1; // stem left
  const xb = x0 + s; // stem right
  const top = y - M.cap;
  ctx.fillRect(x0, top, s, M.cap);
  // bracketed top serif, both sides
  ctx.fillRect(x0 - s * 0.45, top, s * 1.9, h * 1.15);
  // the bowl
  const W = em * 0.5;
  const xr = xb + W;
  const T = s * 0.9; // thick right side
  const ry = M.cap * 0.34;
  const cx = xb + em * 0.1;
  const yT = y - M.cap * 0.6;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(cx, y);
  ctx.ellipse(cx, y - ry, xr - cx, ry, 0, Math.PI / 2, 0, true);
  ctx.lineTo(xr, yT);
  ctx.lineTo(xr - T, yT);
  ctx.lineTo(xr - T, y - ry);
  ctx.ellipse(cx, y - ry, xr - T - cx, ry - h * 1.1, 0, 0, Math.PI / 2, false);
  ctx.lineTo(x0, y - h * 1.1);
  ctx.closePath();
  ctx.fill();
  // a hairline serif on the terminal, and the foot serif on the left
  ctx.fillRect(xr - T - s * 0.45, yT, T + s * 0.45, h * 1.15);
  ctx.fillRect(x0 - s * 0.45, y - h * 1.15, s * 0.5, h * 1.15);
  // oblique bars
  const ang = -0.42;
  for (const k of [0.66, 0.44]) {
    ctx.save();
    ctx.translate(x0 + s / 2, y - M.cap * k);
    ctx.rotate(ang);
    ctx.fillRect(-s / 2 - em * 0.13, -t / 2, s + em * 0.26, t);
    ctx.restore();
  }
  return xr - x + em * 0.06;
}

/**
 * Sets `text` (which may contain built symbols) at `em` px. The result is a
 * white-on-transparent canvas plus the ink box, ready to be placed optically.
 */
export function setSymbol(text: string, weight: string, family: string, em: number, tracking = 0): Glyph {
  const font = `${weight} ${em}px ${family}, ${SYMBOL_FALLBACK}`;
  const chars = [...text];
  const { c, ctx } = canvas(em * (chars.length * 1.25 + 0.8), em * 1.9);
  const ox = Math.round(em * 0.4);
  const oy = Math.round(em * 1.35);
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  let x = ox;
  // runs of ordinary type keep their kerning; built symbols are drawn in between
  let run = '';
  const flush = () => {
    if (!run) return;
    ctx.font = font;
    ctx.fillText(run, x, oy);
    x += ctx.measureText(run).width + tracking * em;
    run = '';
  };
  for (const ch of chars) {
    if (BUILT.has(ch)) {
      flush();
      x += drawBuilt(ctx, ch, x, oy, font, em) + tracking * em;
    } else run += ch;
  }
  flush();
  const ink = inkBox(ctx, c.width, c.height);
  return { c, ox, oy, ink, adv: x - ox };
}

function inkBox(ctx: Ctx, w: number, h: number): [number, number, number, number] {
  const a = ctx.getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0) return [0, 0, 1, 1];
  return [x0, y0, x1 + 1, y1 + 1];
}
