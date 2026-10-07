// The inks. Like a risograph run, every plate shares one key (the black drum)
// and one paper; in between, each material — sky, sea, sand, rock, forest,
// dodo — prints through its own spot colour, laid down as a ramp of tints.
//
// A ramp is six inks from key to paper. The four tints in the middle sit at
// *equal steps of lightness* (OKLab L), the same for every material, so:
//   · the world shader decides how light a thing is, the palette only decides its hue;
//   · the dither only ever mixes two neighbouring inks, a sixth of the value range
//     apart, so flat areas print calm and gradients print smooth.
// One accent ink — fluorescent lime — only ever glows.
//
// "Day" is special: it follows the sun, from dawn through noon and dusk to a
// moonlit night (where the key, the paper and every tint go blue).

export type Rgb = [number, number, number];

/** the order the world shader numbers its materials in (world.frag M_*) */
export const MATERIALS = ['ink', 'sky', 'smoke', 'water', 'land', 'rock', 'forest', 'dodo', 'beak', 'hand'] as const;
export type Material = (typeof MATERIALS)[number];
/** inks per ramp slot (key … paper); palettes with fewer inks use the first `steps + 1` */
export const RAMP = 6;

export interface Palette {
  name: string;
  /** key, two middle inks, paper — for swatches and mounted plates */
  inks: [Rgb, Rgb, Rgb, Rgb];
  /** MATERIALS.length × RAMP inks, dark → light */
  ramps: Rgb[];
  /** how many steps each ramp has (5 for spot-colour runs, 3 for four inks, 1 for two) */
  steps: number;
  accent: Rgb;
  /** tone curve: two-ink palettes lift the midtones so land isn't just black */
  lift: number;
}

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

// ---------------------------------------------------------------- OKLab

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055);
const c01 = (x: number) => Math.min(1, Math.max(0, x));

function toLab([r0, g0, b0]: Rgb): Rgb {
  const r = lin(r0), g = lin(g0), b = lin(b0);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromLab([L, A, B]: Rgb): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    c01(gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    c01(gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    c01(gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

const lerp3 = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * A spot-colour ramp: walk the path key → anchors → paper in OKLab and take
 * an ink at each of six evenly spaced lightnesses. Key and paper are exact.
 */
function ramp(key: string, paper: string, anchors: string[]): Rgb[] {
  const pts = [key, ...anchors, paper].map((h) => toLab(hex(h)));
  // keep the path climbing in lightness, whatever the anchors do
  for (let i = 1; i < pts.length; i++) pts[i][0] = Math.max(pts[i][0], pts[i - 1][0] + 1e-4);
  const L0 = pts[0][0], L1 = pts[pts.length - 1][0];
  const out: Rgb[] = [];
  for (let k = 0; k < RAMP; k++) {
    const L = L0 + ((L1 - L0) * k) / (RAMP - 1);
    let i = 0;
    while (i < pts.length - 2 && pts[i + 1][0] < L) i++;
    const a = pts[i], b = pts[i + 1];
    const t = c01((L - a[0]) / (b[0] - a[0]));
    out.push(fromLab(lerp3(a, b, t)));
  }
  out[0] = hex(key);
  out[RAMP - 1] = hex(paper);
  return out;
}

type Anchors = Record<Exclude<Material, 'ink'>, string[]>;

/** a spot-colour run: shared key and paper, a ramp per material */
function run(name: string, key: string, paper: string, a: Anchors, accent = '#c6fe1f'): Palette {
  const ramps = MATERIALS.flatMap((m) => (m === 'ink' ? ramp(key, paper, []) : ramp(key, paper, a[m])));
  const land = ramp(key, paper, a.land);
  return { name, inks: [hex(key), land[2], land[4], hex(paper)], ramps, steps: RAMP - 1, accent: hex(accent), lift: 1 };
}

/** a plate in a few inks, the same for everything it prints */
function plate(name: string, inks: string[], accent: string, lift: number): Palette {
  const cols = inks.map(hex);
  const slots: Rgb[] = Array.from({ length: RAMP }, (_, i) => cols[Math.min(i, cols.length - 1)]);
  const four = [cols[0], cols[Math.min(1, cols.length - 1)], cols[Math.max(cols.length - 2, 0)], cols[cols.length - 1]] as Palette['inks'];
  return { name, inks: four, ramps: MATERIALS.flatMap(() => slots), steps: cols.length - 1, accent: hex(accent), lift };
}

// the sky's moods, for the "Day" palette. Anchors run dark → light; the ramp
// takes its four tints from them at fixed lightnesses.
const NOON = run('noon', '#15171c', '#f4eee0', {
  sky: ['#2f5f88', '#6f9fc0', '#a9cddd', '#d6e9ea'],
  smoke: ['#4f4b48', '#8a847d', '#c3bdb3', '#e6e1d6'],
  water: ['#0c3550', '#17607e', '#2f8f9c', '#7cc6bd'],
  land: ['#4f3626', '#8c6440', '#c69c62', '#e8cf98'],
  rock: ['#34343e', '#5f5b64', '#928b8a', '#c7bfb3'],
  forest: ['#143826', '#285f33', '#55893a', '#a2c25c'],
  dodo: ['#3e3029', '#77604e', '#ae937a', '#ddcbb2'],
  beak: ['#6e4f17', '#b0802a', '#e0b648', '#f5dd8a'],
  hand: ['#4a372c', '#8b6a55', '#c8a68a', '#efdcc6'],
});
const DAWN = run('dawn', '#1d1420', '#f8e5d0', {
  sky: ['#4b3f66', '#9a7a98', '#dba6a4', '#f3cdb6'],
  smoke: ['#4b3c48', '#86717c', '#c0a7a8', '#e8d2c8'],
  water: ['#232a4f', '#3f4c7c', '#7a7ea6', '#c4abb8'],
  land: ['#55333a', '#94615a', '#d29a82', '#f0c9a8'],
  rock: ['#3a2c44', '#665468', '#9c8592', '#cdb8b8'],
  forest: ['#1e3634', '#36584c', '#6f8a66', '#b4bb88'],
  dodo: ['#45343c', '#7c6670', '#b39a9c', '#dcc6c0'],
  beak: ['#74452a', '#b8783c', '#e6ae6e', '#f6d6a2'],
  hand: ['#4c3238', '#8a6066', '#c99a90', '#f0d0bf'],
});
const DUSK = run('dusk', '#170f12', '#f7d9a6', {
  sky: ['#4c2a40', '#a14f50', '#e08752', '#f2b878'],
  smoke: ['#43302f', '#7c5d56', '#b48e7a', '#e2c2a0'],
  water: ['#1f1b3c', '#3e2f5a', '#8a5262', '#d88a68'],
  land: ['#46261f', '#874834', '#c4784a', '#eeb072'],
  rock: ['#33232e', '#634550', '#9a7270', '#cfa88e'],
  forest: ['#202418', '#40452a', '#79743a', '#bba65c'],
  dodo: ['#3d2a29', '#735550', '#ab8a7a', '#dcbc9e'],
  beak: ['#6c3518', '#b0662c', '#e69c52', '#f6cc84'],
  hand: ['#44282a', '#83503e', '#c08362', '#efbe90'],
});
const NIGHT = run('night', '#04060b', '#b6c6dc', {
  sky: ['#0a1222', '#18263f', '#2f4566', '#5f7ca3'],
  smoke: ['#151b29', '#323d55', '#5d6b88', '#909fbb'],
  water: ['#06122a', '#0f2a4e', '#1f4a78', '#4c7cab'],
  land: ['#171b28', '#363c52', '#636a84', '#959db6'],
  rock: ['#13172a', '#2e3550', '#57607e', '#8a93ae'],
  forest: ['#09171f', '#14303f', '#284e60', '#52788c'],
  dodo: ['#1c1e2a', '#42455a', '#727694', '#a5a9c2'],
  beak: ['#2e2e2a', '#5e5a48', '#918a6c', '#c0b894'],
  hand: ['#1b1e2b', '#3f4560', '#6f7896', '#a5adc6'],
});

export const PALETTES: Palette[] = [
  { ...NOON, name: 'Day' },
  plate('Ink', ['#161512', '#ece4d0'], '#c6fe1f', 0.7),
  plate('Dodo', ['#0a0a0a', '#c6fe1f'], '#f5f5f0', 0.7),
  plate('Engraving', ['#1c1a17', '#4a4338', '#b3a68b', '#efe6d2'], '#c6fe1f', 0.9),
  plate('Pocket', ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'], '#e8fcc8', 0.9),
];

const grey = (c: Rgb): Rgb => {
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [y, y, y];
};

/** a storm washes the colour out of everything (0..1) */
export function stormy(p: Palette, rain: number): Palette {
  const k = 0.45 * rain;
  return { ...p, ramps: p.ramps.map((c) => lerp3(c, grey(c), k)) };
}

export const PATTERNS = ['Halftone', 'Grain', 'Bayer', 'Lines'] as const;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** the Day palette at a given sun: elevation (−1..1) and whether it's morning */
export function skyPalette(elev: number, morning: boolean): Palette {
  const edge = morning ? DAWN : DUSK;
  const day = smooth(0.05, 0.45, elev); // edge → noon
  const night = smooth(0.02, -0.22, elev); // edge → night
  const blend = (a: Rgb, b: Rgb, c: Rgb) => lerp3(lerp3(a, b, day), c, night);
  const inks = [0, 1, 2, 3].map((i) => blend(edge.inks[i], NOON.inks[i], NIGHT.inks[i])) as Palette['inks'];
  const ramps = edge.ramps.map((c, i) => blend(c, NOON.ramps[i], NIGHT.ramps[i]));
  return { name: 'Day', inks, ramps, steps: RAMP - 1, accent: NOON.accent, lift: 1 };
}
