// The print: takes the world's value, depth, material and accent (rendered at
// low resolution, one texel per printed dot) and inks it like a risograph run.
//
// Every material has a ramp of six inks — the shared key, four tints of its own
// spot colour at equal steps of lightness, the shared paper (palettes.ts).
// A spot-colour run prints each ink *flat*: most of every step between two
// neighbouring inks is solid colour, and only the middle of the step is
// screened, so gradients (sky, sea depth, the shade side of a hill) print as
// bands of flat ink joined by a tidy halftone, the way a riso poster does.
// The halftone is drawn at the screen's own resolution, so its dots are round,
// fed by a tone smoothed between dots of the same material.
// The key is kept for contours: silhouettes where the depth jumps, and a
// sticker outline round each dodo. The fluorescent accent prints on top. The
// paper has a tooth, and the ink lies a little unevenly on it.

precision highp float;
precision highp sampler2D;

uniform sampler2D tWorld;
uniform sampler2D tNoise;   // 64×64 blue noise
uniform sampler2D tPaper;   // 256×256, tiling: r tooth, g ink mottle
uniform vec2 uWorldRes;     // texels
uniform float uPx;          // device pixels per texel
uniform vec3 uRamp[54];     // 9 materials × 6 inks, dark → light (see MATERIALS)
uniform float uSteps;       // steps in each ramp: 5 for a spot-colour run, fewer for plates
uniform vec3 uAccent;       // the one colour that glows
uniform float uPattern;     // 0 halftone · 1 grain (blue noise) · 2 bayer · 3 engraving lines
uniform float uOutline;     // 0..1
uniform float uLift;        // < 1 brightens midtones (two-ink plates need it)

out vec4 outColor;

const int M_INK = 0, M_SKY = 1, M_SMOKE = 2, M_WATER = 3, M_LAND = 4, M_DODO = 7, M_BEAK = 8;

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

// a halftone screen: round dots on a rotated grid that grow until they touch
// (a checkerboard at half tone), then shrink to round holes. `p` in texels.
float dotScreen(vec2 p, float angle, float period) {
  float c = cos(angle), s = sin(angle);
  vec2 q = mat2(c, s, -s, c) * p / period;
  vec2 f = fract(q) - 0.5;
  return 0.5 - 0.25 * (cos(6.2831853 * f.x) + cos(6.2831853 * f.y));
}

// each spot colour has its own drum, and each drum its own screen angle,
// as in a real multi-colour run (so neighbouring inks never moiré into mud)
float screenAngle(int m) {
  return m == M_SKY ? 0.2618 : m == M_WATER ? 1.309 : m == M_SMOKE ? 0.0 : 0.7854;
}

float threshold(vec2 cell, vec2 sub, int m) {
  if (uPattern < 0.5) return dotScreen(cell + sub, screenAngle(m), 3.4);
  if (uPattern < 1.5) return texelFetch(tNoise, ivec2(cell) & 63, 0).r;
  if (uPattern < 2.5) return bayer8(cell) + 1.0 / 128.0;
  // engraving: horizontal lines that thicken in shadow
  return abs(fract((cell.y + sub.y) / 3.0) - 0.5) * 2.0;
}

vec4 texel(ivec2 c) {
  c = clamp(c, ivec2(0), ivec2(uWorldRes) - 1);
  return texelFetch(tWorld, c, 0);
}

int material(vec4 w) {
  return int(w.b * 16.0);
}

bool isDodo(int m) {
  return m == M_DODO || m == M_BEAK;
}

// things with an edge an engraver would draw: land, rock, forest, dodos
bool solid(int m) {
  return m >= M_LAND;
}

// the value under this screen pixel, smoothed between the four nearest dots of
// the same material (so halftone dots stay round), never across a material edge
float smoothValue(vec2 fc, int m, float fallback) {
  vec2 g = fc - 0.5;
  ivec2 c0 = ivec2(floor(g));
  vec2 t = g - floor(g);
  vec4 a = texel(c0), b = texel(c0 + ivec2(1, 0)), c = texel(c0 + ivec2(0, 1)), d = texel(c0 + ivec2(1, 1));
  vec4 wt = vec4((1.0 - t.x) * (1.0 - t.y), t.x * (1.0 - t.y), (1.0 - t.x) * t.y, t.x * t.y);
  wt *= vec4(material(a) == m, material(b) == m, material(c) == m, material(d) == m);
  float s = wt.x + wt.y + wt.z + wt.w;
  return s > 1e-3 ? dot(wt, vec4(a.r, b.r, c.r, d.r)) / s : fallback;
}

void main() {
  vec2 fc = gl_FragCoord.xy / uPx;
  ivec2 c = ivec2(floor(fc));
  vec2 sub = fract(fc);
  vec4 w = texel(c);
  int m = material(w);
  vec3 paper = uRamp[5];

  vec3 col;
  bool inked = true;
  if (m == M_INK) {
    // pure key or pure paper: birds, the dodo's eye
    col = w.r < 0.5 ? uRamp[0] : paper;
    inked = w.r < 0.5;
  } else {
    float v = uPattern < 0.5 ? smoothValue(fc, m, w.r) : w.r;
    v = pow(clamp(v, 0.0, 1.0), uLift);
    float th = clamp(threshold(vec2(c), sub, m), 0.002, 0.998);
    // a spot-colour run prints each step flat and screens only its middle;
    // plates with few inks need the whole step screened to show any shading
    float screened = uSteps > 3.5 ? 0.58 : uSteps > 1.5 ? 0.85 : 1.0;
    // a spot-colour run keeps its key for contours: fills bottom out at the
    // darkest tint, so deep shade is a solid colour, never black speckle
    float x = max(v * uSteps, uSteps > 3.5 ? 1.0 : 0.0);
    float i = min(floor(x), uSteps - 1.0);
    float f = clamp((x - i - 0.5) / screened + 0.5, 0.0, 1.0);
    int idx = int(i) + (f > th ? 1 : 0);
    col = uRamp[m * 6 + idx];
    inked = idx < 5;
  }

  if (uOutline > 0.5) {
    vec4 l = texel(c - ivec2(1, 0));
    vec4 r = texel(c + ivec2(1, 0));
    vec4 d = texel(c - ivec2(0, 1));
    vec4 u = texel(c + ivec2(0, 1));
    // silhouettes: this dot sits clearly in front of a neighbour (depth is
    // stored as log distance, so this is a relative jump of about 13%)
    float far = max(max(l.g, r.g), max(d.g, u.g));
    bool edge = solid(m) && far - w.g > 0.022;
    // a dodo gets a sticker outline just outside it, so it reads at any size
    if (!isDodo(m)) {
      bool near = (isDodo(material(l)) && l.g < w.g) || (isDodo(material(r)) && r.g < w.g) ||
                  (isDodo(material(d)) && d.g < w.g) || (isDodo(material(u)) && u.g < w.g);
      edge = edge || near;
    }
    if (edge) {
      col = uRamp[0];
      inked = true;
    }
  }

  // the accent prints on top, crisp, with only a dot or two of grain at its edge
  float ta = texelFetch(tNoise, (c + ivec2(17, 31)) & 63, 0).r;
  if (w.a > 0.4 + 0.2 * ta) {
    col = uAccent;
    inked = true;
  }

  // the sheet: ink lies a little unevenly (a slow mottle, like a riso drum
  // starved here and there), and the paper has a tooth that shows through
  vec2 dp = gl_FragCoord.xy;
  float mottle = texture(tPaper, dp / (uPx * 30.0 * 16.0)).g;
  float tooth = texture(tPaper, dp * vec2(0.55, 0.16) / 256.0).r * 0.5 + texture(tPaper, dp * 0.9 / 256.0 + 0.37).r * 0.5;
  if (inked) col = mix(col, paper, 0.045 * smoothstep(0.4, 0.8, mottle));
  col *= 1.0 - 0.035 * tooth;

  outColor = vec4(col, 1.0);
}
