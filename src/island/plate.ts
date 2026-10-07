// A print of the island, mounted like a plate from an old natural history:
// paper, a ruled border, a plate number and a caption in the margin.

export interface PlateInfo {
  number: number;
  day: number;
  hour: string;
  dodos: number;
  land: string;
  forest: number;
  paper: [number, number, number];
  ink: [number, number, number];
}

const ROMAN: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

export function roman(n: number) {
  let s = '';
  for (const [v, r] of ROMAN) while (n >= v) (s += r), (n -= v);
  return s;
}

const rgb = (c: [number, number, number], a = 1) => `rgba(${c.map((v) => Math.round(v * 255)).join(',')},${a})`;

export async function makePlate(print: HTMLCanvasElement, info: PlateInfo): Promise<Blob | null> {
  await Promise.all([
    document.fonts.load('italic 40px "IM Fell English"'),
    document.fonts.load('40px "IM Fell English SC"'),
    document.fonts.load('20px "IBM Plex Mono"'),
  ]).catch(() => undefined);

  const w = print.width;
  const h = print.height;
  const m = Math.round(Math.min(w, h) * 0.07);
  const foot = Math.round(h * 0.17);
  const c = document.createElement('canvas');
  c.width = w + m * 2;
  c.height = h + m + foot;
  const g = c.getContext('2d')!;

  // paper, with a little tooth to it
  g.fillStyle = rgb(info.paper);
  g.fillRect(0, 0, c.width, c.height);
  const tooth = g.createImageData(c.width, c.height);
  for (let i = 0; i < tooth.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255;
    tooth.data[i] = tooth.data[i + 1] = tooth.data[i + 2] = v;
    tooth.data[i + 3] = Math.random() < 0.08 ? 10 : 0;
  }
  const grain = document.createElement('canvas');
  grain.width = c.width;
  grain.height = c.height;
  grain.getContext('2d')!.putImageData(tooth, 0, 0);
  g.drawImage(grain, 0, 0);

  // the print itself, and the engraver's double rule around it
  g.imageSmoothingEnabled = false;
  g.drawImage(print, m, m);
  const u = Math.max(1, Math.round(w / 1400));
  g.strokeStyle = rgb(info.ink);
  g.lineWidth = u;
  g.strokeRect(m - 6 * u + 0.5, m - 6 * u + 0.5, w + 12 * u - 1, h + 12 * u - 1);
  g.lineWidth = 2 * u;
  g.strokeRect(m - 11 * u, m - 11 * u, w + 22 * u, h + 22 * u);

  // the caption
  const cx = c.width / 2;
  const y0 = m + h + foot * 0.36;
  g.fillStyle = rgb(info.ink);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const sc = Math.round(foot * 0.13);
  g.font = `${sc}px "IM Fell English SC", Georgia, serif`;
  spaced(g, `Plate ${roman(info.number)}.`, cx, y0, sc * 0.18);
  const it = Math.round(foot * 0.2);
  g.font = `italic ${it}px "IM Fell English", Georgia, serif`;
  g.fillText('Raphus cucullatus, on an island of its own.', cx, y0 + it * 1.25);
  const mono = Math.round(foot * 0.085);
  g.font = `${mono}px "IBM Plex Mono", ui-monospace, monospace`;
  g.fillStyle = rgb(info.ink, 0.7);
  const facts = `DAY ${info.day} · ${info.hour} · ${info.dodos} DODO${info.dodos === 1 ? '' : 'S'} · ${info.land} KM² · ${info.forest}% FOREST`;
  spaced(g, facts, cx, y0 + it * 1.25 + mono * 2.4, mono * 0.12);

  return new Promise((res) => c.toBlob(res, 'image/png'));
}

/** centred text with letter-spacing, which canvas can't do everywhere yet */
function spaced(g: CanvasRenderingContext2D, text: string, cx: number, y: number, track: number) {
  const widths = [...text].map((ch) => g.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + track * (text.length - 1);
  let x = cx - total / 2;
  const align = g.textAlign;
  g.textAlign = 'left';
  [...text].forEach((ch, i) => {
    g.fillText(ch, x, y);
    x += widths[i] + track;
  });
  g.textAlign = align;
}
