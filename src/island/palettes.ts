// Four inks from dark to light, and one accent that only ever glows.
// "Day" is special: it follows the sun, from dawn through dusk to night.

export type Rgb = [number, number, number];

export interface Palette {
  name: string;
  inks: [Rgb, Rgb, Rgb, Rgb];
  accent: Rgb;
  /** tone curve: two-ink palettes lift the midtones so land isn't just black */
  lift: number;
}

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const pal = (name: string, a: string, b: string, c: string, d: string, accent = '#c6fe1f', lift = 1): Palette => ({
  name,
  inks: [hex(a), hex(b), hex(c), hex(d)],
  accent: hex(accent),
  lift,
});

// the sky's moods, for the "Day" palette
const DAWN = pal('dawn', '#1d1420', '#6b4a5e', '#d9978c', '#f6e2c8');
const NOON = pal('noon', '#151613', '#4f5a4c', '#a9ad97', '#f1ead6');
const DUSK = pal('dusk', '#170f12', '#5e2f2c', '#c8723f', '#f3c98b');
const NIGHT = pal('night', '#05070c', '#121c2e', '#334a6b', '#8ea3c2');

export const PALETTES: Palette[] = [
  { name: 'Day', inks: NOON.inks, accent: NOON.accent, lift: 1 },
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
  const inks = [0, 1, 2, 3].map((i) => mix(mix(edge.inks[i], NOON.inks[i], day), NIGHT.inks[i], night)) as Palette['inks'];
  return { name: 'Day', inks, accent: NOON.accent, lift: 1 };
}
