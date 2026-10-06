// A name is the only input to the mint. Everything that makes a note
// "yours" — the serial, the inks, the shape of the guilloche — is derived
// from it deterministically, so the same name always prints the same note.

export type Rgb = [number, number, number];

export interface Issue {
  name: string;
  serial: string;
  ink: Rgb; // intaglio ink
  iris: [Rgb, Rgb, Rgb]; // rainbow ("iris") offset print, left → right
  // continuous guilloche parameters — no integers, so they can morph
  // smoothly while you type without tearing the pattern
  rosA: [number, number, number, number]; // amp, lobe6, lobe12, twist
  rosB: [number, number, number, number]; // inner radius, amp, lobe, phase
  band: [number, number, number, number]; // amp, envelope, twist, phase
  field: [number, number, number, number]; // bg wave amp, freq, warp, phase
}

function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (h: string): Rgb => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

// Inks borrowed from the history of paper money. Muted on purpose:
// the only saturated colour in the whole toy is the one that glows under UV.
const INKS: Rgb[] = ['#1f3a2c', '#2a2140', '#3b2418', '#172c45', '#3a1f2b', '#26302a'].map(hex);

const IRISES: [Rgb, Rgb, Rgb][] = [
  ['#6f9a7e', '#c58f5f', '#8a76a8'],
  ['#b07a76', '#7f9c78', '#7290b3'],
  ['#86a894', '#b89d58', '#b47a68'],
  ['#7a8fb0', '#a97f9d', '#ad9f5c'],
  ['#9e8063', '#6f9a95', '#9a80ae'],
].map((t) => t.map(hex) as [Rgb, Rgb, Rgb]);

export const DEFAULT_NAME = 'Raphus Cucullatus';

export function mint(rawName: string): Issue {
  const name = rawName.trim() || DEFAULT_NAME;
  const key = name.toLowerCase();
  const h = cyrb53(key);
  const r = mulberry32(h % 4294967296);
  const lerp = (a: number, b: number) => a + (b - a) * r();

  const digits = String(h).padStart(16, '0');
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const pre = letters[h % 23] + letters[Math.floor(h / 23) % 23];
  const serial = `${pre} ${digits.slice(-8, -4)} ${digits.slice(-4)} ${letters[Math.floor(h / 529) % 23]}`;

  return {
    name,
    serial,
    ink: INKS[Math.floor(r() * INKS.length)],
    iris: IRISES[Math.floor(r() * IRISES.length)],
    rosA: [lerp(0.07, 0.13), lerp(-0.12, 0.14), lerp(-0.06, 0.07), lerp(-2.5, 2.5)],
    rosB: [lerp(0.38, 0.55), lerp(0.05, 0.1), lerp(-0.2, 0.2), lerp(0, 6.283)],
    band: [lerp(0.55, 0.95), lerp(0.0, 0.45), lerp(-1.6, 1.6), lerp(0, 6.283)],
    field: [lerp(0.012, 0.03), lerp(5, 11), lerp(0.4, 1.6), lerp(0, 6.283)],
  };
}
