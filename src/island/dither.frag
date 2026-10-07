// The print: takes the world's tone, depth and accent (rendered at low
// resolution, one texel per printed dot) and inks it with a handful of
// colours through an ordered dither, plus outlines where depth jumps —
// so the island reads like an engraving that happens to be alive.

precision highp float;
precision highp sampler2D;

uniform sampler2D tWorld;
uniform vec2 uWorldRes;   // texels
uniform float uPx;        // device pixels per texel
uniform vec3 uPal[4];     // ink → paper, sRGB
uniform vec3 uMids[12];   // the two middle inks for each material: sky, water, land, forest, dodo, smoke
uniform vec3 uAccent;     // the one colour that glows
uniform float uPattern;   // 0 bayer · 1 noise · 2 halftone · 3 engraving lines
uniform float uContrast;
uniform float uOutline;   // 0..1
uniform float uLift;      // < 1 brightens midtones (two-ink palettes need it)

out vec4 outColor;

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float threshold(vec2 cell, vec2 sub) {
  if (uPattern < 0.5) return bayer8(cell);
  if (uPattern < 1.5) return ign(cell);
  if (uPattern < 2.5) {
    // halftone: dots on a 45° grid, 4 texels apart
    vec2 q = mat2(0.7071, 0.7071, -0.7071, 0.7071) * (cell + sub);
    vec2 f = fract(q / 4.0) - 0.5;
    return clamp(length(f) * 1.414, 0.0, 1.0);
  }
  // engraving: horizontal lines that thicken in shadow
  return abs(fract((cell.y + sub.y) / 3.0) - 0.5) * 2.0;
}

vec4 texel(ivec2 c) {
  c = clamp(c, ivec2(0), ivec2(uWorldRes) - 1);
  return texelFetch(tWorld, c, 0);
}

void main() {
  vec2 fc = gl_FragCoord.xy / uPx;
  ivec2 c = ivec2(floor(fc));
  vec2 sub = fract(fc);
  vec4 w = texel(c);

  float tone = clamp(w.r * 1.6, 0.0, 1.0);
  tone = clamp((tone - 0.5) * uContrast + 0.5, 0.0, 1.0);
  tone = pow(tone, 0.85 * uLift);

  float th = threshold(vec2(c), sub);
  float x = tone * 3.0;
  float i = floor(x);
  float f = x - i;
  int idx = int(i) + (f > th ? 1 : 0);
  idx = clamp(idx, 0, 3);
  // key and paper are shared; the middle inks change with what they print,
  // like a risograph run with a different spot colour for sea and land
  int m = w.b < 0.04 ? 0 : w.b < 0.15 ? 5 : w.b < 0.37 ? 1 : w.b < 0.55 ? 2 : w.b < 0.68 ? 3 : 4;
  vec3 col = idx == 1 ? uMids[m * 2] : idx == 2 ? uMids[m * 2 + 1] : uPal[idx];

  // outlines where the depth or the material jumps: the engraver's contour
  vec4 r = texel(c + ivec2(1, 0));
  vec4 u = texel(c + ivec2(0, 1));
  float d = max(w.g, 0.002);
  float dz = max(abs(w.g - r.g), abs(w.g - u.g)) / d;
  float dm = max(abs(w.b - r.b), abs(w.b - u.b));
  float edge = step(0.12, dz) * step(w.b, 0.95) + step(0.2, dm) * 0.0;
  // water is never outlined, so rivers stay rivers rather than ink lines
  if (uOutline > 0.5 && edge > 0.5 && w.b > 0.1 && abs(w.b - 0.25) > 0.05) col = uPal[0];

  // the accent prints on top, dithered by its own strength
  float ta = threshold(vec2(c) + vec2(3.0, 5.0), sub);
  if (w.a > ta * 0.9 + 0.05) col = uAccent;

  outColor = vec4(col, 1.0);
}
