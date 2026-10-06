import { ASPECT, MICRO_H, MICRO_W, PLATE_H, PLATE_W, PX, layout } from './layout';
import { fillDodo } from './dodo';
import type { Issue } from './seed';

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

export type PlateName = 'ink' | 'ovi' | 'uv' | 'water' | 'back' | 'red';

export const FONTS = {
  sc: '"IM Fell English SC", Georgia, serif',
  fell: '"IM Fell English", Georgia, serif',
  num: '"Bodoni Moda", "Didot", Georgia, serif',
  sig: '"Pinyon Script", cursive',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
};

export async function loadFonts() {
  const want = [
    `400 40px ${FONTS.sc}`,
    `400 40px ${FONTS.fell}`,
    `italic 400 40px ${FONTS.fell}`,
    `900 40px ${FONTS.num}`,
    `400 40px ${FONTS.sig}`,
    `500 40px ${FONTS.mono}`,
  ];
  await Promise.all(want.map((f) => document.fonts.load(f).catch(() => undefined)));
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

function drawInkStatic(ctx: Ctx) {
  ctx.textBaseline = 'alphabetic';

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
  font(ctx, 'italic 400', 0.024, FONTS.fell);
  ctx.textAlign = 'center';
  fillT(ctx, 'payable in any currency, in any country', CX, 0.575);

  // signature block (the signature itself is dynamic)
  rule(ctx, CX - 0.2, CX + 0.2, 0.81, 0.0012);
  font(ctx, '400', 0.021, FONTS.sc);
  spaced(ctx, 'KEEPER OF THE RESERVE', CX, 0.845, 0.004);

  // portrait caption
  const P = L.portrait;
  font(ctx, '400', 0.03, FONTS.sc);
  spaced(ctx, 'RAPHUS CUCULLATUS', P.cx, P.cy + P.ry + 0.058, 0.006);
  font(ctx, 'italic 400', 0.021, FONTS.fell);
  ctx.textAlign = 'center';
  fillT(ctx, 'Mauritius · last seen 1662', P.cx, P.cy + P.ry + 0.09);

  // corner numerals, sitting in their guilloche medallions
  font(ctx, '900', 0.098, FONTS.num);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Bodoni's hairlines vanish at this size; a thin stroke keeps the flag and foot
  ctx.lineWidth = 0.0035;
  for (const m of L.medallions) {
    fillT(ctx, '1', m.cx, m.cy + 0.004);
    ctx.save();
    ctx.scale(1 / PX, 1 / PX);
    ctx.lineWidth = 0.0035 * PX;
    ctx.strokeText('1', m.cx * PX, (m.cy + 0.004) * PX);
    ctx.restore();
  }
  ctx.textBaseline = 'alphabetic';

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

function drawOvi(ctx: Ctx) {
  font(ctx, '900', L.ovi.size, FONTS.num);
  ctx.textAlign = 'center';
  fillT(ctx, '1', L.ovi.x, L.ovi.y);
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

function drawWater(ctx: Ctx) {
  // electrotype: a crisp bright "1" and a pair of bars, just like the real ones
  font(ctx, '900', 0.13, FONTS.num);
  ctx.textAlign = 'center';
  fillT(ctx, '1', L.watermark.cx + 0.13, L.watermark.cy + 0.21);
}

function drawBack(ctx: Ctx) {
  // The reverse, as seen through the paper (so: mirrored).
  ctx.save();
  ctx.translate(ASPECT, 0);
  ctx.scale(-1, 1);
  ctx.lineWidth = 0.004;
  ctx.strokeRect(0.09, 0.09, ASPECT - 0.18, 0.82);
  ctx.lineWidth = 0.0015;
  ctx.strokeRect(0.11, 0.11, ASPECT - 0.22, 0.78);
  font(ctx, '900', 0.62, FONTS.num);
  ctx.textAlign = 'center';
  fillT(ctx, '1', 0.48, 0.74);
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

export class Plates {
  ink = plate();
  ovi = plate();
  uv = plate();
  water = plate();
  back = plate();
  red = plate();
  private inkStatic = plate();

  constructor() {
    drawInkStatic(this.inkStatic.ctx);
    drawOvi(this.ovi.ctx);
    drawUv(this.uv.ctx);
    drawWater(this.water.ctx);
    drawBack(this.back.ctx);
  }

  /** Re-prints only what depends on the bearer's name. Returns the plates that changed. */
  issue(issue: Issue): PlateName[] {
    const ink = this.ink.ctx;
    ink.save();
    ink.setTransform(1, 0, 0, 1, 0, 0);
    ink.drawImage(this.inkStatic.c, 0, 0);
    ink.restore();
    drawSignature(ink, issue.name);

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
