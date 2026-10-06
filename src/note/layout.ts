// Single source of truth for where things live on the note.
// Units: "note space". The note is 1 unit tall and ASPECT units wide,
// origin top-left, y pointing down — same as the canvases the plates are drawn on.
// The same numbers are injected into the shader as #defines, so the
// Canvas2D plates and the GLSL procedural layers always line up.

export const ASPECT = 16 / 7; // ≈ 2.2857, close to a real banknote

export const PLATE_W = 3200;
export const PLATE_H = 1400; // PLATE_W / ASPECT
export const PX = PLATE_H; // plate pixels per note unit

export const layout = {
  corner: 0.022, // corner radius of the paper

  // guilloche border band, measured as inset from the paper edge
  band: { inset: 0.072, halfWidth: 0.034, radius: 0.06 },
  microInset: 0.118, // microtext ring just inside the band
  microHeight: 0.0065,
  frameInset: 0.128, // hairline inner frame

  // unprinted window where the watermark lives
  watermark: { cx: 0.425, cy: 0.48, rx: 0.18, ry: 0.25 },

  // hologram foil stripe, full height
  foil: { x0: 0.665, x1: 0.748 },

  // central rosette behind the denomination
  rosette: { cx: 1.16, cy: 0.505, r: 0.18 },

  // windowed security thread
  thread: { x: 1.56, w: 0.011 },

  // engraved portrait
  portrait: { cx: 1.88, cy: 0.462, rx: 0.228, ry: 0.286 },

  // corner medallions carrying the small numerals
  medallions: [
    { cx: 0.148, cy: 0.158, r: 0.072 },
    { cx: ASPECT - 0.148, cy: 0.158, r: 0.072 },
    { cx: ASPECT - 0.148, cy: 1 - 0.158, r: 0.072 },
  ],

  // colour-shifting numeral (bottom-left)
  ovi: { x: 0.205, y: 0.862, size: 0.25 },

  // see-through register mark (front half / back half)
  register: { cx: 0.425, cy: 0.815, r: 0.036 },
} as const;

// Portrait canvas matches the oval's aspect so the engraving isn't stretched.
export const PORTRAIT_W = 1024;
export const PORTRAIT_H = Math.round((PORTRAIT_W * layout.portrait.ry) / layout.portrait.rx);

// Microtext strip: tiled along lines in the shader.
export const MICRO_W = 4096;
export const MICRO_H = 64;

const f = (n: number) => n.toFixed(5);
const v2 = (a: number, b: number) => `vec2(${f(a)}, ${f(b)})`;

export function glslDefines(): string {
  const L = layout;
  return [
    `#define ASPECT ${f(ASPECT)}`,
    `#define CORNER ${f(L.corner)}`,
    `#define BAND_INSET ${f(L.band.inset)}`,
    `#define BAND_HALF ${f(L.band.halfWidth)}`,
    `#define BAND_RADIUS ${f(L.band.radius)}`,
    `#define MICRO_INSET ${f(L.microInset)}`,
    `#define MICRO_H ${f(L.microHeight)}`,
    `#define FRAME_INSET ${f(L.frameInset)}`,
    `#define WM_C ${v2(L.watermark.cx, L.watermark.cy)}`,
    `#define WM_R ${v2(L.watermark.rx, L.watermark.ry)}`,
    `#define FOIL_X0 ${f(L.foil.x0)}`,
    `#define FOIL_X1 ${f(L.foil.x1)}`,
    `#define ROS_C ${v2(L.rosette.cx, L.rosette.cy)}`,
    `#define ROS_R ${f(L.rosette.r)}`,
    `#define THREAD_X ${f(L.thread.x)}`,
    `#define THREAD_W ${f(L.thread.w)}`,
    `#define PORT_C ${v2(L.portrait.cx, L.portrait.cy)}`,
    `#define PORT_R ${v2(L.portrait.rx, L.portrait.ry)}`,
    `#define MED0 vec3(${f(L.medallions[0].cx)}, ${f(L.medallions[0].cy)}, ${f(L.medallions[0].r)})`,
    `#define MED1 vec3(${f(L.medallions[1].cx)}, ${f(L.medallions[1].cy)}, ${f(L.medallions[1].r)})`,
    `#define MED2 vec3(${f(L.medallions[2].cx)}, ${f(L.medallions[2].cy)}, ${f(L.medallions[2].r)})`,
    `#define REG_C ${v2(L.register.cx, L.register.cy)}`,
    `#define REG_R ${f(L.register.r)}`,
    `#define MICRO_ASPECT ${f(MICRO_W / MICRO_H)}`,
  ].join('\n');
}
