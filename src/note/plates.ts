import { ASPECT, MICRO_H, MICRO_W, PLATE_H, PLATE_W, PX, layout } from './layout';
import { fillDodo } from './dodo';
import type { Issue } from './seed';
import { COUNTRIES, formatMoney, type Country } from '../borders/countries';
import { setSymbol, type Glyph } from './glyphs';

// A real banknote goes through the press several times, one plate per
// process. We do the same: each plate is a grayscale canvas that becomes a
// single-channel texture, and the shader decides how each one behaves
// under each kind of light.
//
//   ink    intaglio — raised, glossy, the dark linework and type
//   ovi    colour-shifting ink mask (the big numeral)
//   uv     invisible ink — only fluoresces
//   water  electrotype watermark — thinner paper, glows when backlit
//   back   the reverse side, seen through the paper when backlit
//   red    letterpress — serial numbers
//
// Every window is a country, and a window prints its notes in its own
// money: the note is always ONE DODO, but the medallions, the colour-shifting
// glyph, the watermark and the reverse carry the local currency sign, and the
// denomination is spelled out in local terms.

export type PlateName = 'ink' | 'ovi' | 'uv' | 'water' | 'back' | 'red';
export const PLATE_NAMES: PlateName[] = ['ink', 'ovi', 'uv', 'water', 'back', 'red'];

// Each face is followed by serifs that carry the accented letters and
// currency signs it lacks (ş, ₹, ₦…), so nothing ever falls through to a sans.
const SERIF_FALLBACK = '"Noto Serif", "Times New Roman", "DejaVu Serif", Georgia, serif';

export const FONTS = {
  sc: `"IM Fell English SC", ${SERIF_FALLBACK}`,
  fell: `"IM Fell English", ${SERIF_FALLBACK}`,
  num: `"Bodoni Moda", "Didot", ${SERIF_FALLBACK}`,
  sig: '"Pinyon Script", cursive',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
};

// enough text to pull in every subset the plates and stamps use
const SAMPLE = 'AZaz0189$£¥€₹₦₩₺·éçüşÍÓ→';

export async function loadFonts() {
  const want = [
    `400 40px ${FONTS.sc}`,
    `400 40px ${FONTS.fell}`,
    `italic 400 40px ${FONTS.fell}`,
    `900 40px ${FONTS.num}`,
    `400 40px ${FONTS.sig}`,
    `500 40px ${FONTS.mono}`,
  ];
  await Promise.all(want.map((f) => document.fonts.load(f, SAMPLE).catch(() => undefined)));
}

// ---------------------------------------------------------------- money in words

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: [number, string][] = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];

/** 83 → "eighty-three", 15600 → "fifteen thousand six hundred". Integers only (fractions are dropped). */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n < 0) return `minus ${numberToWords(-n)}`;
  n = Math.floor(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  for (const [v, name] of SCALES) {
    if (n >= v) {
      const rest = n % v;
      return `${numberToWords(Math.floor(n / v))} ${name}${rest ? ` ${numberToWords(rest)}` : ''}`;
    }
  }
  return String(n);
}

// the small change, by ISO code (zero-decimal currencies need none)
const MINOR: Record<string, [string, string]> = {
  USD: ['cent', 'cents'],
  AUD: ['cent', 'cents'],
  EUR: ['cent', 'cents'],
  GBP: ['penny', 'pence'],
  INR: ['paisa', 'paise'],
  BRL: ['centavo', 'centavos'],
  MXN: ['centavo', 'centavos'],
  TRY: ['kuruş', 'kuruş'],
  NGN: ['kobo', 'kobo'],
  IDR: ['sen', 'sen'],
};

function fractionDigits(c: Country) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: c.currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "eighty-three rupees twenty paise", "one hundred forty-nine yen", "seventy-nine pence" */
export function amountInWords(c: Country, dodo = 1): string {
  const digits = fractionDigits(c);
  const scale = 10 ** digits;
  const total = Math.round(dodo * c.rate * scale);
  const major = Math.floor(total / scale);
  const minor = total - major * scale;
  const parts: string[] = [];
  if (major > 0 || minor === 0) parts.push(`${numberToWords(major)} ${c.unit[major === 1 ? 0 : 1]}`);
  if (minor > 0 && digits > 0) {
    const m = MINOR[c.currency] ?? ['cent', 'cents'];
    parts.push(`${numberToWords(minor)} ${m[minor === 1 ? 0 : 1]}`);
  }
  return parts.join(' ');
}

type Ctx = CanvasRenderingContext2D;

function plate(w = PLATE_W, h = PLATE_H) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  // work in note units from here on
  ctx.scale(PX, PX);
  return { c, ctx };
}

// Fonts are set in real plate pixels: sub-pixel font sizes under a big
// scale transform get their advances rounded and the text collapses.
function fillT(ctx: Ctx, text: string, x: number, y: number) {
  ctx.save();
  ctx.scale(1 / PX, 1 / PX);
  ctx.fillText(text, x * PX, y * PX);
  ctx.restore();
}

function measure(ctx: Ctx, text: string) {
  return ctx.measureText(text).width / PX;
}

// Canvas letterSpacing isn't everywhere yet, so space glyphs by hand.
function spaced(ctx: Ctx, text: string, x: number, y: number, tracking: number, align: 'left' | 'center' | 'right' = 'center') {
  const chars = [...text];
  const widths = chars.map((ch) => measure(ctx, ch));
  const total = widths.reduce((a, b) => a + b, 0) + tracking * (chars.length - 1);
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => {
    fillT(ctx, ch, cx, y);
    cx += widths[i] + tracking;
  });
  ctx.textAlign = prev;
  return total;
}

function font(ctx: Ctx, spec: string, size: number, family: string) {
  ctx.font = `${spec} ${size * PX}px ${family}`;
}

function rule(ctx: Ctx, x0: number, x1: number, y: number, w: number) {
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}

function diamond(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x, y - r * 0.6);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r * 0.6);
  ctx.closePath();
  ctx.fill();
}

const L = layout;
const CX = L.rosette.cx;

// ---------------------------------------------------------------- set glyphs

/**
 * The currency sign set so its ink fits a box (note units), never larger
 * than `em`. Multi-letter signs (R$, Rp, A$) shrink until they sit as
 * comfortably as a single figure would; `diag` caps the half-diagonal so a
 * sign stays inside a round medallion.
 */
function fitSymbol(sym: string, em: number, maxW: number, maxH: number, diag = Infinity, weight = '900', family = FONTS.num): Glyph {
  let g = setSymbol(sym, weight, family, em * PX, -0.03);
  const w = (g.ink[2] - g.ink[0]) / PX;
  const h = (g.ink[3] - g.ink[1]) / PX;
  const k = Math.min(1, maxW / w, maxH / h, diag / Math.hypot(w / 2, h / 2));
  if (k < 0.999) g = setSymbol(sym, weight, family, em * k * PX, -0.03);
  return g;
}

/**
 * Prints a set glyph so that the point (ax, ay) of its ink box — 0..1 across,
 * 0..1 down; ay may also be 'base' for the baseline — lands on (x, y).
 * `bold` thickens it by that much (note units), the way a thin outline
 * keeps Bodoni's hairlines from vanishing at small sizes.
 */
function printGlyph(ctx: Ctx, g: Glyph, x: number, y: number, ax: number, ay: number | 'base', bold = 0) {
  const [x0, y0, x1, y1] = g.ink;
  const px = Math.round(x * PX - (x0 + ax * (x1 - x0)));
  const py = Math.round(y * PX - (ay === 'base' ? g.oy : y0 + ay * (y1 - y0)));
  ctx.save();
  ctx.scale(1 / PX, 1 / PX);
  ctx.globalCompositeOperation = 'lighten';
  ctx.drawImage(g.c, px, py);
  const r = bold * PX * 0.5;
  if (r > 0.25) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.drawImage(g.c, px + Math.cos(a) * r, py + Math.sin(a) * r);
    }
  }
  ctx.restore();
}

/** ink box of a placed glyph, note units, relative to its anchor */
function glyphSize(g: Glyph) {
  return { w: (g.ink[2] - g.ink[0]) / PX, h: (g.ink[3] - g.ink[1]) / PX, below: (g.ink[3] - g.oy) / PX };
}

// One line of mixed type, fitted to a width and centred. Each piece is
// either plain text in a face, or a pre-set glyph (for figures with a sign).
type Piece = { text: string; spec: string; size: number; family: string; tracking?: number } | { glyph: Glyph } | { gap: number } | { dot: number };

function line(ctx: Ctx, pieces: Piece[], cx: number, y: number, maxW: number) {
  const widths = pieces.map((p) => {
    if ('gap' in p) return p.gap;
    if ('dot' in p) return p.dot * 2;
    if ('glyph' in p) return p.glyph.adv / PX;
    font(ctx, p.spec, p.size, p.family);
    const chars = [...p.text];
    return chars.reduce((a, ch) => a + measure(ctx, ch), 0) + (p.tracking ?? 0) * (chars.length - 1);
  });
  const total = widths.reduce((a, b) => a + b, 0);
  const k = Math.min(1, maxW / total);
  ctx.save();
  ctx.translate(cx, y);
  ctx.scale(k, k);
  let x = -total / 2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  pieces.forEach((p, i) => {
    if ('dot' in p) {
      diamond(ctx, x + p.dot, -p.dot * 1.2, p.dot * 0.55);
    } else if ('glyph' in p) {
      // glyphs are set at full plate resolution; undo our own scale for them
      ctx.save();
      ctx.scale(1 / k, 1 / k);
      printGlyph(ctx, p.glyph, x * k, 0, 0, 'base');
      ctx.restore();
    } else if ('text' in p) {
      font(ctx, p.spec, p.size, p.family);
      spaced(ctx, p.text, x, 0, p.tracking ?? 0, 'left');
    }
    x += widths[i];
  });
  ctx.restore();
}

function drawInkStatic(ctx: Ctx, country: Country) {
  ctx.textBaseline = 'alphabetic';

  // The issuing country rides above the bank, the way UNITED STATES OF
  // AMERICA sits over a dollar: small capitals, wide tracking, hemmed by
  // the same rule-and-diamond as the denomination.
  const name = country.formal.toUpperCase();
  let size = 0.0215;
  const track = (sz: number) => sz * 0.3;
  font(ctx, '400', size, FONTS.sc);
  const natural = [...name].reduce((a, ch) => a + measure(ctx, ch), 0) + track(size) * ([...name].length - 1);
  const maxName = 0.5;
  if (natural > maxName) size *= maxName / natural;
  font(ctx, '400', size, FONTS.sc);
  const nw = spaced(ctx, name, CX, 0.166, track(size));
  const ry = 0.166 - size * 0.34;
  for (const s of [-1, 1]) {
    const x0 = CX + s * (nw / 2 + 0.014);
    diamond(ctx, x0 + s * 0.004, ry, 0.0055);
    rule(ctx, x0 + s * 0.014, x0 + s * 0.06, ry, 0.0012);
  }

  // title
  font(ctx, '400', 0.064, FONTS.sc);
  spaced(ctx, 'THE DODO RESERVE', CX, 0.222, 0.008);
  font(ctx, 'italic 400', 0.03, FONTS.fell);
  ctx.textAlign = 'center';
  fillT(ctx, 'promises to pay the bearer on demand', CX, 0.268);

  // denomination, set into the rosette
  font(ctx, '400', 0.062, FONTS.sc);
  const w = spaced(ctx, 'ONE DODO', CX, 0.527, 0.01);
  rule(ctx, CX - w / 2 - 0.105, CX - w / 2 - 0.03, 0.507, 0.0018);
  rule(ctx, CX + w / 2 + 0.03, CX + w / 2 + 0.105, 0.507, 0.0018);
  diamond(ctx, CX - w / 2 - 0.018, 0.507, 0.008);
  diamond(ctx, CX + w / 2 + 0.018, 0.507, 0.008);
  // …and what that is worth here, in words and in figures
  const figure = setSymbol(formatMoney(country, 1), '400', FONTS.fell, 0.027 * PX);
  line(
    ctx,
    [
      { text: amountInWords(country), spec: 'italic 400', size: 0.025, family: FONTS.fell },
      { gap: 0.012 },
      { dot: 0.0052 },
      { gap: 0.012 },
      { glyph: figure },
    ],
    CX,
    0.575,
    0.5,
  );

  // signature block (the signature itself is dynamic)
  rule(ctx, CX - 0.2, CX + 0.2, 0.81, 0.0012);
  font(ctx, '400', 0.021, FONTS.sc);
  spaced(ctx, 'KEEPER OF THE RESERVE', CX, 0.845, 0.004);

  const P = L.portrait;

  // corner signs, sitting in their guilloche medallions
  const sign = fitSymbol(country.symbol, 0.098, 0.088, 0.08, 0.056);
  for (const m of L.medallions) printGlyph(ctx, sign, m.cx, m.cy, 0.5, 0.5, 0.0035);

  // see-through register, front half: three of six petals
  petals(ctx, [0, 2, 4]);

  // hairline that frames the portrait
  ctx.lineWidth = 0.0016;
  ctx.beginPath();
  ctx.ellipse(P.cx, P.cy, P.rx * 1.005, P.ry * 1.005, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function petals(ctx: Ctx, which: number[]) {
  const { cx, cy, r } = L.register;
  for (const i of which) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(r * 0.35, -r * 0.2, r * 0.75, -r * 0.18, r, 0);
    ctx.bezierCurveTo(r * 0.75, r * 0.18, r * 0.35, r * 0.2, 0, 0);
    ctx.fill();
    ctx.restore();
  }
  ctx.lineWidth = 0.0014;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.12, 0, Math.PI * 2);
  ctx.stroke();
}

function drawSignature(ctx: Ctx, name: string) {
  // fit the signature to the line, however long the name is
  let size = 0.072;
  font(ctx, '400', size, FONTS.sig);
  const max = 0.42;
  const w = measure(ctx, name);
  if (w > max) {
    size *= max / w;
    font(ctx, '400', size, FONTS.sig);
  }
  ctx.save();
  ctx.translate(CX, 0.796);
  ctx.rotate(-0.04);
  ctx.textAlign = 'center';
  fillT(ctx, name, 0, 0);
  ctx.restore();
}

// The caption names whoever is sitting for the portrait.
function drawCaption(ctx: Ctx, issue: Issue, selfie: boolean) {
  const P = L.portrait;
  const title = selfie ? issue.name.toUpperCase() : 'RAPHUS CUCULLATUS';
  const sub = selfie ? `sat for this portrait · ${new Date().getFullYear()}` : 'Mauritius · last seen 1662';
  let size = 0.03;
  font(ctx, '400', size, FONTS.sc);
  // kept clear of the bottom-right medallion, whatever sign it carries
  const w = measure(ctx, title) + title.length * 0.006;
  if (w > 0.41) {
    size *= 0.41 / w;
    font(ctx, '400', size, FONTS.sc);
  }
  spaced(ctx, title, P.cx, P.cy + P.ry + 0.058, 0.006 * (size / 0.03));
  font(ctx, 'italic 400', 0.021, FONTS.fell);
  ctx.textAlign = 'center';
  fillT(ctx, sub, P.cx, P.cy + P.ry + 0.09);
}

function drawOvi(ctx: Ctx, country: Country) {
  // the big colour-shifting sign: left-aligned to the frame, sitting on the
  // OVI baseline; anything that hangs below (Rp) is lifted clear of the border
  const g = fitSymbol(country.symbol, L.ovi.size, 0.17, 0.2);
  const { below } = glyphSize(g);
  const lift = Math.max(0, L.ovi.y + below - 0.876);
  printGlyph(ctx, g, L.ovi.x - 0.03, L.ovi.y - lift, 0, 'base');
}

function drawUv(ctx: Ctx) {
  // The blank watermark window is where the UV ink hides a second dodo,
  // printed as fine hatching so it glows like ink, not like a sticker.
  const W = L.watermark;
  const birdH = 0.4;
  const bx = W.cx + 0.01;
  const by = W.cy + 0.03;
  const layer = () => {
    const c = document.createElement('canvas');
    c.width = PLATE_W;
    c.height = PLATE_H;
    const x = c.getContext('2d')!;
    x.scale(PX, PX);
    x.fillStyle = '#fff';
    x.strokeStyle = '#fff';
    return { c, x };
  };
  // silhouette, fading out at the bottom like a vignetted bust
  const sil = layer();
  fillDodo(sil.x, bx, by, birdH, false);
  const fade = sil.x.createLinearGradient(0, by + birdH * 0.2, 0, by + birdH * 0.5);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  sil.x.globalCompositeOperation = 'destination-out';
  sil.x.fillStyle = fade;
  sil.x.fillRect(bx - 0.4, by, 0.8, 0.5);
  // hatching, kept only where the bird is
  const hatch = layer();
  hatch.x.lineWidth = 0.0034;
  for (let i = -40; i < 40; i++) {
    const x = bx + i * 0.0085;
    hatch.x.beginPath();
    hatch.x.moveTo(x - 0.3, by - 0.3);
    hatch.x.lineTo(x + 0.3, by + 0.3);
    hatch.x.stroke();
  }
  hatch.x.setTransform(1, 0, 0, 1, 0, 0);
  hatch.x.globalCompositeOperation = 'destination-in';
  hatch.x.drawImage(sil.c, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighten';
  ctx.drawImage(hatch.c, 0, 0);
  ctx.restore();

  // the message is the point of the whole note
  font(ctx, 'italic 400', 0.042, FONTS.fell);
  ctx.textAlign = 'center';
  fillT(ctx, 'Some things only show up', CX, 0.665);
  fillT(ctx, 'in the right light.', CX, 0.72);

  // a little constellation over the title
  const stars: [number, number, number][] = [
    [0.84, 0.17, 0.005], [0.9, 0.152, 0.0035], [0.95, 0.19, 0.0045], [1.4, 0.16, 0.0035], [1.46, 0.2, 0.005], [1.5, 0.15, 0.003],
  ];
  for (const [x, y, r] of stars) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWater(ctx: Ctx, country: Country) {
  // electrotype: a crisp bright currency sign, like the "1" on real ones
  const g = fitSymbol(country.symbol, 0.13, 0.1, 0.1);
  printGlyph(ctx, g, L.watermark.cx + 0.13, L.watermark.cy + 0.21, 0.5, 1);
}

function drawBack(ctx: Ctx, country: Country) {
  // The reverse, as seen through the paper (so: mirrored).
  ctx.save();
  ctx.translate(ASPECT, 0);
  ctx.scale(-1, 1);
  ctx.lineWidth = 0.004;
  ctx.strokeRect(0.09, 0.09, ASPECT - 0.18, 0.82);
  ctx.lineWidth = 0.0015;
  ctx.strokeRect(0.11, 0.11, ASPECT - 0.22, 0.78);
  const g = fitSymbol(country.symbol, 0.62, 0.56, 0.54);
  printGlyph(ctx, g, 0.5, 0.5, 0.5, 0.5);
  font(ctx, '400', 0.08, FONTS.sc);
  spaced(ctx, 'IN DODO WE TRUST', 1.42, 0.5, 0.01);
  font(ctx, 'italic 400', 0.034, FONTS.fell);
  ctx.textAlign = 'center';
  fillT(ctx, 'one of none remaining', 1.42, 0.57);
  ctx.restore();
  // back half of the register (drawn in front coordinates so it lands on its partner)
  petals(ctx, [1, 3, 5]);
}

function drawRed(ctx: Ctx, serial: string) {
  font(ctx, '500', 0.036, FONTS.mono);
  ctx.textBaseline = 'alphabetic';
  spaced(ctx, serial, 0.255, 0.2, 0.004, 'left');
  ctx.save();
  ctx.translate(ASPECT - 0.135, 0.5);
  ctx.rotate(Math.PI / 2);
  spaced(ctx, serial, 0, 0.012, 0.004, 'center');
  ctx.restore();
  // a specimen stamp, as printers used to send to central banks
  ctx.save();
  ctx.translate(1.43, 0.385);
  ctx.rotate(-0.18);
  ctx.lineWidth = 0.003;
  ctx.strokeRect(-0.085, -0.026, 0.17, 0.052);
  ctx.lineWidth = 0.0012;
  ctx.strokeRect(-0.079, -0.02, 0.158, 0.04);
  font(ctx, '500', 0.024, FONTS.mono);
  ctx.textBaseline = 'middle';
  spaced(ctx, 'SPECIMEN', 0, 0.001, 0.004);
  ctx.restore();
}

export function drawMicro(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = MICRO_W;
  c.height = MICRO_H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, MICRO_W, MICRO_H);
  ctx.fillStyle = '#fff';
  const phrase = 'MAKE SOMETHING YOU’D WANT TO KEEP PLAYING WITH ✦ THE DODO RESERVE ✦ ';
  ctx.font = `500 ${MICRO_H * 0.78}px ${FONTS.mono}`;
  const w = ctx.measureText(phrase).width;
  const reps = Math.max(1, Math.round(MICRO_W / w));
  // stretch slightly so the phrase tiles seamlessly along the strip
  ctx.save();
  ctx.scale(MICRO_W / (reps * w), 1);
  ctx.textBaseline = 'middle';
  for (let i = 0; i < reps; i++) ctx.fillText(phrase, i * w, MICRO_H * 0.54);
  ctx.restore();
  return c;
}

function clear(p: { c: HTMLCanvasElement; ctx: Ctx }) {
  const ctx = p.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, p.c.width, p.c.height);
  ctx.restore();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
}

/**
 * The plates for one country. Call `loadFonts()` first.
 *
 *   const plates = new Plates(COUNTRIES[i]);
 *   plates.issue(mint(name));             // ink + red
 *   for (const n of PLATE_NAMES) renderer.setPlate(n, plates.canvas(n));
 */
export class Plates {
  ink = plate();
  ovi = plate();
  uv = plate();
  water = plate();
  back = plate();
  red = plate();
  private inkStatic = plate();
  private last: { issue: Issue; selfie: boolean } | null = null;
  country: Country;

  constructor(country: Country = COUNTRIES[0]) {
    this.country = country;
    drawUv(this.uv.ctx);
    this.print(country);
  }

  private print(country: Country) {
    for (const p of [this.inkStatic, this.ovi, this.water, this.back]) clear(p);
    drawInkStatic(this.inkStatic.ctx, country);
    drawOvi(this.ovi.ctx, country);
    drawWater(this.water.ctx, country);
    drawBack(this.back.ctx, country);
  }

  /** Re-prints everything that depends on the country. Returns the plates that changed. */
  setCountry(country: Country): PlateName[] {
    if (country === this.country) return [];
    this.country = country;
    this.print(country);
    if (this.last) this.issue(this.last.issue, this.last.selfie);
    return ['ink', 'ovi', 'water', 'back'];
  }

  /** Re-prints only what depends on the bearer's name. Returns the plates that changed. */
  issue(issue: Issue, selfie = false): PlateName[] {
    this.last = { issue, selfie };
    const ink = this.ink.ctx;
    ink.save();
    ink.setTransform(1, 0, 0, 1, 0, 0);
    ink.drawImage(this.inkStatic.c, 0, 0);
    ink.restore();
    drawSignature(ink, issue.name);
    drawCaption(ink, issue, selfie);

    const red = this.red.ctx;
    red.save();
    red.setTransform(1, 0, 0, 1, 0, 0);
    red.fillStyle = '#000';
    red.fillRect(0, 0, PLATE_W, PLATE_H);
    red.restore();
    red.fillStyle = '#fff';
    red.strokeStyle = '#fff';
    drawRed(red, issue.serial);
    return ['ink', 'red'];
  }

  canvas(name: PlateName): HTMLCanvasElement {
    return this[name].c;
  }
}
