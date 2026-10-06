import { PORTRAIT_H, PORTRAIT_W } from './layout';

// The sitter. A bust of Raphus cucullatus, three-quarter profile, facing
// into the note the way monarchs do. It is never shown as-is: the shader
// reads it as three channels and engraves it.
//   R — tone (what the engraver sees)
//   G — form (a smooth height field the engraved lines bend around)
//   B — silhouette

type Ctx = CanvasRenderingContext2D;

function canvas(w = PORTRAIT_W, h = PORTRAIT_H) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return { c, ctx };
}

const g = (v: number) => {
  const n = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${n},${n},${n})`;
};

// --- silhouette paths (portrait canvas space, 1024 × ~1289) ---------------

function head(p: Path2D) {
  // skull + hooded crown, back of head sweeping down into the neck
  p.moveTo(430, 300);
  p.bezierCurveTo(450, 225, 540, 186, 630, 196);
  p.bezierCurveTo(720, 206, 790, 262, 806, 344);
  p.bezierCurveTo(822, 426, 800, 500, 770, 560);
  p.lineTo(470, 560);
  p.bezierCurveTo(440, 500, 418, 380, 430, 300);
  p.closePath();
}

function neck(p: Path2D) {
  p.moveTo(456, 440);
  p.bezierCurveTo(560, 430, 720, 440, 796, 480);
  p.bezierCurveTo(826, 590, 842, 700, 866, 790);
  p.lineTo(360, 860);
  p.bezierCurveTo(410, 720, 430, 560, 456, 440);
  p.closePath();
}

function body(p: Path2D) {
  p.moveTo(390, 770);
  p.bezierCurveTo(290, 820, 196, 930, 168, 1080);
  p.bezierCurveTo(150, 1200, 150, 1260, 160, 1300);
  p.lineTo(1010, 1300);
  p.bezierCurveTo(1010, 1100, 960, 900, 870, 790);
  p.bezierCurveTo(760, 720, 520, 720, 390, 770);
  p.closePath();
}

function upperBeak(p: Path2D) {
  p.moveTo(470, 316);
  p.bezierCurveTo(390, 306, 296, 314, 226, 342);
  p.bezierCurveTo(160, 368, 118, 424, 110, 486);
  // the hook
  p.bezierCurveTo(104, 528, 112, 562, 134, 578);
  p.bezierCurveTo(146, 586, 158, 578, 156, 562);
  p.bezierCurveTo(152, 540, 160, 522, 182, 512);
  // cutting edge back toward the gape
  p.bezierCurveTo(260, 484, 360, 478, 476, 472);
  p.closePath();
}

function lowerBeak(p: Path2D) {
  p.moveTo(176, 520);
  p.bezierCurveTo(250, 500, 360, 488, 486, 480);
  p.bezierCurveTo(500, 500, 498, 530, 476, 540);
  p.bezierCurveTo(380, 556, 270, 560, 200, 552);
  p.bezierCurveTo(180, 548, 168, 532, 176, 520);
  p.closePath();
}

function face(p: Path2D) {
  // bare skin around the eye and beak base
  p.moveTo(452, 300);
  p.bezierCurveTo(500, 268, 572, 286, 590, 340);
  p.bezierCurveTo(604, 392, 580, 450, 540, 488);
  p.bezierCurveTo(500, 510, 466, 500, 456, 470);
  p.bezierCurveTo(440, 410, 436, 340, 452, 300);
  p.closePath();
}

function wing(p: Path2D) {
  p.moveTo(640, 930);
  p.bezierCurveTo(720, 880, 840, 900, 880, 990);
  p.bezierCurveTo(910, 1060, 900, 1150, 850, 1200);
  p.bezierCurveTo(790, 1170, 720, 1100, 670, 1040);
  p.bezierCurveTo(630, 1000, 620, 960, 640, 930);
  p.closePath();
}

function path(fn: (p: Path2D) => void) {
  const p = new Path2D();
  fn(p);
  return p;
}

// deterministic jitter so the feathers are the same every load
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function feathers(ctx: Ctx, clip: Path2D, region: [number, number, number, number], opts: {
  count: number;
  len: [number, number];
  angle: number; // dominant direction (radians)
  spread: number;
  tone: [number, number];
  width: number;
  seed: number;
}) {
  const r = rng(opts.seed);
  const [x0, y0, x1, y1] = region;
  ctx.save();
  ctx.clip(clip);
  ctx.lineCap = 'round';
  for (let i = 0; i < opts.count; i++) {
    const x = x0 + r() * (x1 - x0);
    const y = y0 + r() * (y1 - y0);
    const L = opts.len[0] + r() * (opts.len[1] - opts.len[0]);
    const a = opts.angle + (r() - 0.5) * opts.spread;
    const bend = (r() - 0.5) * L * 0.5;
    const ex = x + Math.cos(a) * L;
    const ey = y + Math.sin(a) * L;
    const mx = (x + ex) / 2 - Math.sin(a) * bend;
    const my = (y + ey) / 2 + Math.cos(a) * bend;
    ctx.strokeStyle = g(opts.tone[0] + r() * (opts.tone[1] - opts.tone[0]));
    ctx.lineWidth = opts.width * (0.6 + r() * 0.8);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();
  }
  ctx.restore();
}

function shade(ctx: Ctx, clip: Path2D, cx: number, cy: number, r0: number, r1: number, stops: [number, number][]) {
  const grad = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
  for (const [o, v] of stops) grad.addColorStop(o, g(v));
  ctx.fillStyle = grad;
  ctx.fill(clip);
}

// Draw a part on its own layer and let its lower edge dissolve, so head,
// neck and body melt into each other instead of meeting at a seam.
function softLayer(ctx: Ctx, fadeFrom: number, fadeTo: number, draw: (c: Ctx) => void) {
  const l = canvas();
  draw(l.ctx);
  if (fadeTo > fadeFrom) {
    const fade = l.ctx.createLinearGradient(0, fadeFrom, 0, fadeTo);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(1, 'rgba(0,0,0,1)');
    l.ctx.globalCompositeOperation = 'destination-out';
    l.ctx.fillStyle = fade;
    l.ctx.fillRect(0, fadeFrom, PORTRAIT_W, PORTRAIT_H - fadeFrom);
  }
  ctx.drawImage(l.c, 0, 0);
}

function drawTone(ctx: Ctx, P: Record<string, Path2D>) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, PORTRAIT_W, PORTRAIT_H);

  // Light comes from the upper left, like every engraved portrait ever.
  shade(ctx, P.body, 360, 860, 40, 760, [[0, 0.66], [0.45, 0.46], [1, 0.2]]);
  feathers(ctx, P.body, [150, 760, 1010, 1300], {
    count: 1100, len: [24, 60], angle: Math.PI * 0.44, spread: 0.8, tone: [0.3, 0.62], width: 6, seed: 3,
  });

  // wing: rows of overlapping coverts, dark bases and pale edges
  shade(ctx, P.wing, 700, 940, 10, 260, [[0, 0.62], [0.6, 0.44], [1, 0.26]]);
  ctx.save();
  ctx.clip(P.wing);
  for (let row = 0; row < 7; row++) {
    for (let i = 0; i < 6; i++) {
      const x = 650 + i * 46 + row * 14;
      const y = 930 + row * 40 + (i % 2) * 8;
      const grad = ctx.createLinearGradient(x, y - 30, x + 10, y + 34);
      grad.addColorStop(0, g(0.34));
      grad.addColorStop(0.8, g(0.62 + row * 0.03));
      grad.addColorStop(1, g(0.82));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(x, y, 30, 38, -0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  softLayer(ctx, 740, 830, (c) => {
    shade(c, P.neck, 520, 520, 20, 420, [[0, 0.8], [0.5, 0.62], [1, 0.34]]);
    feathers(c, P.neck, [360, 430, 900, 860], {
      count: 800, len: [18, 44], angle: Math.PI * 0.5, spread: 0.7, tone: [0.45, 0.82], width: 5, seed: 7,
    });
  });

  softLayer(ctx, 470, 560, (c) => {
    shade(c, P.head, 560, 270, 20, 420, [[0, 0.56], [0.5, 0.36], [1, 0.16]]);
    feathers(c, P.head, [440, 190, 820, 560], {
      count: 600, len: [16, 40], angle: Math.PI * 0.62, spread: 1.1, tone: [0.14, 0.5], width: 5, seed: 11,
    });
    // hood edge: dark feathered rim where crown meets bare face
    c.save();
    c.clip(P.head);
    c.strokeStyle = g(0.12);
    c.lineWidth = 30;
    c.filter = 'blur(12px)';
    c.beginPath();
    c.moveTo(470, 262);
    c.bezierCurveTo(566, 244, 628, 320, 616, 402);
    c.bezierCurveTo(606, 462, 574, 502, 524, 524);
    c.stroke();
    c.restore();
  });

  // bare face
  softLayer(ctx, 0, 0, (c) => {
    c.filter = 'blur(6px)';
    shade(c, P.face, 500, 340, 10, 200, [[0, 0.92], [0.7, 0.8], [1, 0.6]]);
  });

  // beak: pale, glossy, hook darkens
  const bg = ctx.createLinearGradient(110, 0, 480, 0);
  bg.addColorStop(0, g(0.3));
  bg.addColorStop(0.1, g(0.5));
  bg.addColorStop(0.3, g(0.86));
  bg.addColorStop(1, g(0.84));
  ctx.fillStyle = bg;
  ctx.fill(P.upper);
  ctx.save();
  ctx.clip(P.upper);
  // underside shadow of the upper mandible
  const us = ctx.createLinearGradient(0, 380, 0, 500);
  us.addColorStop(0, 'rgba(0,0,0,0)');
  us.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = us;
  ctx.fillRect(0, 300, 520, 300);
  // horny sheath ridge and culmen highlight
  ctx.strokeStyle = g(1);
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.filter = 'blur(4px)';
  ctx.beginPath();
  ctx.moveTo(440, 332);
  ctx.bezierCurveTo(360, 328, 280, 338, 214, 370);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(250, 352);
  ctx.bezierCurveTo(230, 400, 226, 450, 240, 494);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = g(0.62);
  ctx.fill(P.lower);
  ctx.save();
  ctx.clip(P.lower);
  const ls = ctx.createLinearGradient(0, 490, 0, 560);
  ls.addColorStop(0, g(0.74));
  ls.addColorStop(1, g(0.28));
  ctx.fillStyle = ls;
  ctx.fillRect(150, 470, 360, 100);
  ctx.restore();

  // gape line
  ctx.strokeStyle = g(0.08);
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(176, 520);
  ctx.bezierCurveTo(260, 496, 380, 482, 500, 482);
  ctx.stroke();

  // nostril
  ctx.lineWidth = 9;
  ctx.strokeStyle = g(0.22);
  ctx.beginPath();
  ctx.moveTo(340, 384);
  ctx.quadraticCurveTo(308, 390, 288, 406);
  ctx.stroke();

  // eye: dark rim, pale iris, pupil, catchlight
  ctx.fillStyle = g(0.1);
  ctx.beginPath();
  ctx.ellipse(512, 372, 30, 28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = g(0.9);
  ctx.beginPath();
  ctx.ellipse(512, 372, 20, 19, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = g(0.02);
  ctx.beginPath();
  ctx.ellipse(508, 373, 10, 11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = g(1);
  ctx.beginPath();
  ctx.arc(503, 366, 4, 0, Math.PI * 2);
  ctx.fill();

  // folds of bare skin under the eye
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 5;
  ctx.filter = 'blur(2px)';
  for (let i = 0; i < 2; i++) {
    ctx.beginPath();
    ctx.arc(512, 372, 50 + i * 18, Math.PI * 0.25, Math.PI * 0.7);
    ctx.stroke();
  }
  ctx.filter = 'none';
}

function drawForm(ctx: Ctx, P: Record<string, Path2D>) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, PORTRAIT_W, PORTRAIT_H);
  ctx.globalCompositeOperation = 'lighten';
  const dome = (p: Path2D, cx: number, cy: number, r: number, peak = 1) => {
    shade(ctx, p, cx, cy, 0, r, [[0, peak], [0.7, peak * 0.55], [1, 0]]);
  };
  dome(P.body, 520, 1080, 520);
  dome(P.wing, 760, 1040, 200, 1);
  dome(P.neck, 620, 680, 260, 0.9);
  dome(P.head, 620, 380, 240);
  dome(P.face, 520, 380, 150, 1);
  dome(P.upper, 330, 420, 230, 0.9);
  dome(P.lower, 330, 520, 180, 0.6);
  ctx.globalCompositeOperation = 'source-over';
}

function drawMask(ctx: Ctx, P: Record<string, Path2D>) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, PORTRAIT_W, PORTRAIT_H);
  ctx.fillStyle = '#fff';
  for (const k of ['body', 'wing', 'neck', 'head', 'face', 'upper', 'lower']) ctx.fill(P[k]);
}

/** Returns an opaque RGB canvas: R tone, G form, B silhouette. */
export function drawDodo(): HTMLCanvasElement {
  const P = {
    body: path(body),
    wing: path(wing),
    neck: path(neck),
    head: path(head),
    face: path(face),
    upper: path(upperBeak),
    lower: path(lowerBeak),
  };

  const tone = canvas();
  drawTone(tone.ctx, P);
  const form = canvas();
  drawForm(form.ctx, P);
  form.ctx.filter = 'blur(18px)';
  form.ctx.drawImage(form.c, 0, 0);
  form.ctx.filter = 'none';
  const mask = canvas();
  drawMask(mask.ctx, P);

  const out = canvas();
  const T = tone.ctx.getImageData(0, 0, PORTRAIT_W, PORTRAIT_H).data;
  const F = form.ctx.getImageData(0, 0, PORTRAIT_W, PORTRAIT_H).data;
  const M = mask.ctx.getImageData(0, 0, PORTRAIT_W, PORTRAIT_H).data;
  const img = out.ctx.createImageData(PORTRAIT_W, PORTRAIT_H);
  const D = img.data;
  for (let i = 0; i < D.length; i += 4) {
    D[i] = T[i];
    D[i + 1] = F[i];
    D[i + 2] = M[i];
    D[i + 3] = 255;
  }
  out.ctx.putImageData(img, 0, 0);
  return out.c;
}

/** Fills the dodo's silhouette into any context — used for the UV ink and the foil. */
export function fillDodo(ctx: Ctx, x: number, y: number, height: number, flip = false) {
  const s = height / PORTRAIT_H;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(flip ? -s : s, s);
  ctx.translate(-PORTRAIT_W / 2, -PORTRAIT_H / 2);
  for (const fn of [body, wing, neck, head, face, upperBeak, lowerBeak]) ctx.fill(path(fn));
  ctx.restore();
}
