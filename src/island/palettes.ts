// Four inks from dark to light, and one accent that only ever glows.
// "Day" is special: it follows the sun, from dawn through dusk to night.

export type Rgb = [number, number, number];

export interface Palette {
  name: string;
  inks: [Rgb, Rgb, Rgb, Rgb];
  /** middle inks per material — sky, water, land, forest, dodo, smoke — dark then light */
  mids: Rgb[];
  accent: Rgb;
  /** tone curve: two-ink palettes lift the midtones so land isn't just black */
  lift: number;
}

export const MATERIALS = ['sky', 'water', 'land', 'forest', 'dodo', 'smoke'] as const;
type Tints = Partial<Record<(typeof MATERIALS)[number], [string, string]>>;

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const pal = (name: string, a: string, b: string, c: string, d: string, accent = '#c6fe1f', lift = 1, tints: Tints = {}): Palette => ({
  name,
  inks: [hex(a), hex(b), hex(c), hex(d)],
  mids: MATERIALS.flatMap((m) => (tints[m] ?? [b, c]).map(hex)),
  accent: hex(accent),
  lift,
});

// the sky's moods, for the "Day" palette: each prints sea, land and forest in their own inks
const DAWN = pal('dawn', '#1d1420', '#6b4a5e', '#d9978c', '#f6e2c8', '#c6fe1f', 1, {
  water: ['#3e3f63', '#a593ad'],
  land: ['#74504c', '#d9a387'],
  forest: ['#34433d', '#8d9677'],
  dodo: ['#5b4048', '#bf9384'],
});
const NOON = pal('noon', '#14161a', '#506070', '#a9b7b4', '#f2ecdc', '#c6fe1f', 1, {
  sky: ['#4f7391', '#a9c4cf'],
  water: ['#1c4f6e', '#5ea7b0'],
  land: ['#6e5c45', '#c9b38a'],
  forest: ['#2c5434', '#86a35c'],
  dodo: ['#5c5049', '#ae9d89'],
});
const DUSK = pal('dusk', '#170f12', '#5e2f2c', '#c8723f', '#f3c98b', '#c6fe1f', 1, {
  water: ['#352a45', '#a8624d'],
  land: ['#5e2f2c', '#c27a4a'],
  forest: ['#332f22', '#857640'],
});
const NIGHT = pal('night', '#05070c', '#121c2e', '#334a6b', '#8ea3c2', '#c6fe1f', 1, {
  forest: ['#0f1f22', '#2c4a52'],
});

export const PALETTES: Palette[] = [
  { name: 'Day', inks: NOON.inks, mids: NOON.mids, accent: NOON.accent, lift: 1 },
  pal('Ink', '#161512', '#161512', '#ece4d0', '#ece4d0', '#c6fe1f', 0.55),
  pal('Dodo', '#0a0a0a', '#0a0a0a', '#c6fe1f', '#c6fe1f', '#f5f5f0', 0.55),
  pal('Engraving', '#1c1a17', '#4a4338', '#b3a68b', '#efe6d2', '#c6fe1f', 0.8),
  pal('Pocket', '#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#e8fcc8', 0.8),
];

export const PATTERNS = ['Bayer', 'Noise', 'Halftone', 'Lines'] as const;

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** the Day palette at a given sun: elevation (−1..1) and whether it's morning */
export function skyPalette(elev: number, morning: boolean): Palette {
  const edge = morning ? DAWN : DUSK;
  const day = smooth(0.05, 0.45, elev); // edge → noon
  const night = smooth(0.02, -0.22, elev); // edge → night
  const blend = (a: Rgb, b: Rgb, c: Rgb) => mix(mix(a, b, day), c, night);
  const inks = [0, 1, 2, 3].map((i) => blend(edge.inks[i], NOON.inks[i], NIGHT.inks[i])) as Palette['inks'];
  const mids = edge.mids.map((c, i) => blend(c, NOON.mids[i], NIGHT.mids[i]));
  return { name: 'Day', inks, mids, accent: NOON.accent, lift: 1 };
}
