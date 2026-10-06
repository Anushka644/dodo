// SPECIMEN — one fragment shader, one banknote, four kinds of light.
//
// The note is described as physical materials (paper, offset ink, raised
// intaglio ink, colour-shifting ink, foil, an embedded thread, fluorescent
// fibres, a watermark) and then lit. Changing the light doesn't swap
// images; it changes which of those materials can answer.
//
// Space: "note space", 1 unit tall, ASPECT wide, origin top-left, y down.

precision highp float;
precision highp sampler2D;

uniform vec2 uRes;
uniform vec4 uNote;       // centre.xy (px, gl coords), half height (px), rotated (0|1)
uniform vec3 uLight;      // lamp position in note space (z = height above the paper)
uniform vec2 uCursor;     // pointer, px, gl coords
uniform vec4 uMode;       // weights: lamp, loupe, uv, backlight
uniform float uLampOn;    // lamp brightness (flickers on)
uniform float uUvOn;      // UV tube brightness (flickers on)
uniform float uLoupeR;    // lens radius in px (0 when put away)
uniform float uLoupeMag;
uniform float uTime;
uniform float uPrint;     // 0 → 1: the note going through the press
uniform vec4 uRosA;       // rosette: amp, lobe6, lobe12, twist
uniform vec4 uRosB;       // inner rosette: radius, amp, lobe, phase
uniform vec4 uBand;       // border: amp, envelope, twist, phase
uniform vec4 uField;      // background field: amp, freq, warp, phase
uniform vec3 uInk;
uniform vec3 uIris0;
uniform vec3 uIris1;
uniform vec3 uIris2;
uniform float uCam;       // 1 when the portrait is the live camera
uniform vec2 uCamScale;

uniform sampler2D tInk;
uniform sampler2D tOvi;
uniform sampler2D tUv;
uniform sampler2D tWater;
uniform sampler2D tBack;
uniform sampler2D tRed;
uniform sampler2D tPortrait;
uniform sampler2D tMicro;

out vec4 outColor;

#define PI 3.14159265
#define TAU 6.28318531

const vec3 LIME = vec3(0.565, 0.99, 0.013);   // #C6FE1F, linear
const vec3 PAPER = vec3(0.80, 0.745, 0.62);
const vec3 RED_INK = vec3(0.42, 0.035, 0.03);
const vec3 LAMP = vec3(1.0, 0.86, 0.70);
const vec3 ROOM = vec3(0.020, 0.022, 0.028);
const vec3 VIOLET = vec3(0.20, 0.05, 0.55);

// ---------------------------------------------------------------- utils

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, s, -s, c);
}

float sdRoundRect(vec2 p, vec2 h, float r) {
  vec2 q = abs(p) - h + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Coverage of a periodic family of lines. Lines sit at integer t.
// fw: how much t changes per pixel. wpx: physical line width in pixels.
// Box-filtered, and once the lines get denser than the pixels it fades to
// their average tone instead of shimmering.
float lines(float t, float fw, float wpx) {
  fw = max(fw, 1e-5);
  float d = abs(fract(t + 0.5) - 0.5) / fw;
  float c = max(0.0, min(0.5 * wpx, d + 0.5) - max(-0.5 * wpx, d - 0.5));
  float avg = min(1.0, wpx * fw);
  return mix(c, avg, smoothstep(0.22, 0.55, fw));
}

// ---------------------------------------------------------------- guilloche
//
// A guilloché rosette is a family of curves r = R(θ) + A·sin(kθ + φⱼ),
// with φⱼ spaced evenly. Instead of drawing curves we solve for φ at every
// pixel — two solutions, asin(s) and π − asin(s) — which gives two smooth
// fields whose integer level sets ARE the curves, crossing each other.
// All the shape parameters are continuous, so the pattern can morph live.

float rosette(vec2 p, vec2 c, float R, float A, float k, float N,
              float l6, float l12, float twist, float phase, float wNote, float px) {
  vec2 d = p - c;
  float r = max(length(d), 1e-4);
  float th = atan(d.y, d.x);
  vec2 gr = d / r;
  vec2 gth = vec2(-d.y, d.x) / (r * r);

  float Rt = R * (1.0 + l6 * cos(6.0 * th) + l12 * cos(12.0 * th));
  float dRt = R * (-6.0 * l6 * sin(6.0 * th) - 12.0 * l12 * sin(12.0 * th));
  float s = (r - Rt) / A;
  vec2 gs = (gr - dRt * gth) / A;
  if (abs(s) > 1.02) return 0.0;

  float edge = clamp((1.0 - abs(s)) / max(length(gs) * px, 1e-5), 0.0, 1.0);
  s = clamp(s, -1.0, 1.0);
  float as = asin(s);
  float ia = 1.0 / max(sqrt(1.0 - s * s), 0.08);

  float K = N / TAU;
  float base = (-k * th + phase + twist * s) * K;
  vec2 gbase = (-k * gth + twist * gs) * K;
  float t1 = base + as * K;
  float t2 = base + (PI - as) * K;
  float fw1 = length(gbase + gs * ia * K) * px;
  float fw2 = length(gbase - gs * ia * K) * px;
  float wpx = wNote / px;
  return max(lines(t1, fw1, wpx), lines(t2, fw2, wpx)) * edge;
}

// Arc length around a rounded rectangle (clockwise from top centre) and
// signed distance to it. Lets the border waves run continuously round the
// corners instead of being four separate strips.
vec3 perimeter(vec2 p, vec2 C, vec2 H, float rr) {
  vec2 q = p - C;
  vec2 a = abs(q);
  vec2 b = H - rr;
  vec2 e = a - b;
  float Q = b.x + b.y + 0.5 * PI * rr;
  float sq, dist;
  if (e.x > 0.0 && e.y > 0.0) {
    float ang = atan(e.y, e.x);
    sq = b.x + rr * (0.5 * PI - ang);
    dist = length(e) - rr;
  } else if (e.x > e.y) {
    sq = b.x + 0.5 * PI * rr + (b.y - a.y);
    dist = e.x - rr;
  } else {
    sq = a.x;
    dist = e.y - rr;
  }
  float s;
  if (q.y < 0.0) s = q.x >= 0.0 ? sq : 4.0 * Q - sq;
  else s = q.x >= 0.0 ? 2.0 * Q - sq : 2.0 * Q + sq;
  return vec3(s, dist, 4.0 * Q);
}

float borderBand(vec2 p, float px) {
  vec2 C = vec2(ASPECT * 0.5, 0.5);
  vec2 H = vec2(ASPECT * 0.5, 0.5) - BAND_INSET;
  vec3 pr = perimeter(p, C, H, BAND_RADIUS);
  float Lp = pr.z;
  float M = floor(Lp / 0.06 + 0.5);            // whole waves round the loop
  float M2 = floor(Lp / 0.37 + 0.5);            // slow breathing of the band
  float Ah = BAND_HALF * (1.0 - uBand.y * 0.5 * (1.0 + cos(TAU * M2 * pr.x / Lp)));
  float u = pr.y / Ah;
  if (abs(u) > 1.02) return 0.0;
  float edge = clamp((1.0 - abs(u)) * Ah / px, 0.0, 1.0);
  u = clamp(u, -1.0, 1.0);
  float as = asin(u * uBand.x) / max(uBand.x, 0.05);
  float N = 5.0;
  float K = N / TAU;
  float ks = TAU * M / Lp;
  float base = (-ks * pr.x + uBand.w + uBand.z * u) * K;
  float ia = 1.0 / max(sqrt(1.0 - u * u * uBand.x * uBand.x), 0.1);
  float gx = ks * K;
  float gy = (ia + uBand.z) * K / Ah;
  float gy2 = (-ia + uBand.z) * K / Ah;
  float wpx = 0.00115 / px;
  float a = lines(base + as * K, length(vec2(gx, gy)) * px, wpx);
  float b = lines(base + (PI - as) * K, length(vec2(gx, gy2)) * px, wpx);
  // two hairlines that hem the band
  float hem = lines(pr.y / (Ah * 2.0) + 0.5, px / (Ah * 2.0), 0.0016 / px) * step(abs(u), 1.01);
  return max(max(a, b), hem * 0.9) * edge;
}

// microtext running round the inside of the border
float borderMicro(vec2 p, float px) {
  vec2 C = vec2(ASPECT * 0.5, 0.5);
  vec2 H = vec2(ASPECT * 0.5, 0.5) - MICRO_INSET;
  vec3 pr = perimeter(p, C, H, BAND_RADIUS * 0.6);
  float v = -pr.y / MICRO_H; // 0 at the line, 1 inward
  if (v < 0.0 || v > 1.0) return 0.0;
  vec2 uv = vec2(pr.x / (MICRO_H * MICRO_ASPECT), v);
  return texture(tMicro, uv).r;
}

// ---------------------------------------------------------------- portrait

// tone, form, silhouette — from the drawn dodo or the live camera
vec3 sitter(vec2 uv, float lod) {
  if (uCam > 0.5) {
    vec2 c = (uv - 0.5) * uCamScale + 0.5;
    c.x = 1.0 - c.x;
    vec3 v = textureLod(tPortrait, c, lod).rgb;
    float lum = dot(v, vec3(0.299, 0.587, 0.114));
    lum = smoothstep(0.06, 0.92, lum);
    float form = textureLod(tPortrait, c, lod + 3.0).g;
    return vec3(lum, form, 1.0);
  }
  return textureLod(tPortrait, uv, lod).rgb;
}

// Engraving: line thickness carries tone; lines bend around the form.
float engrave(vec2 p, float px) {
  vec2 q = (p - PORT_C) / PORT_R;
  float rr = length(q);
  if (rr > 1.0) return 0.0;
  vec2 uv = q * 0.5 + 0.5;
  vec3 s = sitter(uv, 0.0);
  vec3 sb = sitter(uv, 4.0);
  float bg = mix(0.6, 0.86, smoothstep(-0.9, 0.9, q.x + q.y * 0.4));
  float tone = mix(bg, s.r, s.b);
  float soft = mix(bg, sb.r, sb.b);
  float form = sb.g;

  float vign = smoothstep(1.0, 0.86, rr);
  float density = 74.0;                 // lines per unit of q
  float fwBase = density / min(PORT_R.x, PORT_R.y) * px * 0.5;

  vec2 q1 = rot(-0.32) * q;
  float t1 = q1.y * density + form * 7.0 + soft * 2.5;
  float w1 = pow(clamp(1.0 - tone, 0.0, 1.0), 1.15) * 0.95 * vign;
  float c1 = lines(t1, fwBase * 1.15, w1 / (fwBase * 1.15));

  vec2 q2 = rot(0.62) * q;
  float t2 = q2.y * density * 0.86 + form * 4.0;
  float w2 = smoothstep(0.52, 0.08, tone) * 0.8 * vign;
  float c2 = lines(t2, fwBase, w2 / fwBase);

  // a few dots in the deep shadows, the way engravers fill flat blacks
  vec2 cell = q * density * 0.5;
  float dotv = smoothstep(0.32, 0.05, tone) * vign;
  float dots = smoothstep(0.32, 0.18, length(fract(cell) - 0.5) - dotv * 0.25) * step(0.01, dotv);

  return clamp(max(max(c1, c2), dots * 0.8), 0.0, 1.0);
}

float portraitFrame(vec2 p, float px) {
  vec2 q = (p - PORT_C) / PORT_R;
  float sc = min(PORT_R.x, PORT_R.y);
  // a guilloche collar hugging the oval
  return rosette(q, vec2(0.0), 1.075, 0.055, 26.0, 4.0, 0.0, 0.0, uRosA.w * 0.4, uRosB.w, 0.0011 / sc, px / sc);
}

// ---------------------------------------------------------------- fibres

// security fibres scattered in the paper: faint by day, vivid under UV
vec4 fibres(vec2 p, float px) {
  const float CELL = 0.05;
  vec2 g = p / CELL;
  vec2 id = floor(g);
  vec3 col = vec3(0.0);
  float cov = 0.0;
  float glow = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cid = id + vec2(i, j);
      float h = hash12(cid * 1.37 + 3.1);
      if (h > 0.3) continue;
      vec2 c = (cid + hash22(cid)) * CELL;
      float ang = hash12(cid + 7.7) * TAU;
      float len = mix(0.004, 0.011, hash12(cid + 1.3));
      float bend = (hash12(cid + 9.1) - 0.5) * 140.0;
      vec2 l = rot(-ang) * (p - c);
      float x = clamp(l.x, -len, len);
      float dist = length(vec2(l.x - x, l.y - bend * x * x));
      float cv = clamp(0.5 + (0.0003 - dist) / px, 0.0, 1.0) * 0.85;
      float gl = exp(-dist / 0.0014);
      float k = h / 0.3;
      vec3 fc = k < 0.3 ? LIME : k < 0.55 ? vec3(0.9, 0.05, 0.5) : k < 0.8 ? vec3(0.05, 0.55, 1.0) : vec3(1.0, 0.6, 0.05);
      col = max(col, fc * max(cv, gl * 0.25));
      cov = max(cov, cv);
      glow = max(glow, gl);
    }
  }
  return vec4(col, cov);
}

// ---------------------------------------------------------------- foil

float foilMask(vec2 p, float px) {
  float wob = 0.0045 * sin(p.y * 46.0) + 0.0018 * sin(p.y * 131.0 + 1.0);
  float a = smoothstep(-px, px, p.x - (FOIL_X0 + wob));
  float b = smoothstep(-px, px, (FOIL_X1 - wob * 0.7) - p.x);
  return a * b;
}

// A kinegram: different patches of the foil carry gratings at different
// angles, so each one lights up for a different lamp position. Colour comes
// from the angle, not from position, so it sweeps as the lamp moves.
vec3 foilDiffraction(vec2 p, vec3 Ld, out float bright) {
  float fx = (FOIL_X0 + FOIL_X1) * 0.5;
  vec2 c1 = vec2(fx, 0.25), c2 = vec2(fx, 0.76);
  vec2 n1 = p - c1, n2 = p - c2;
  vec2 nearest = dot(n1, n1) < dot(n2, n2) ? n1 : n2;
  vec2 du = (p - vec2(fx, 0.5)) / vec2(0.045, 0.056) * 0.5 + 0.5;
  float bird = 0.0;
  if (all(greaterThan(du, vec2(0.0))) && all(lessThan(du, vec2(1.0)))) bird = textureLod(tPortrait, du, 1.0).b * (1.0 - uCam);
  // concentric gratings around two medallions, a straight one in the bird
  float g = mix(atan(nearest.y, nearest.x) + PI * 0.5, 0.35, bird);
  vec2 gd = vec2(cos(g), sin(g));
  float s = dot(Ld.xy, gd) / max(Ld.z, 0.12);
  float as = abs(s);
  float hue = fract(as * 0.75 + bird * 0.4);
  vec3 rainbow = 0.5 + 0.5 * cos(TAU * (hue + vec3(0.0, 0.33, 0.67)));
  bright = exp(-pow((as - 0.85) / 0.3, 2.0)) * (0.75 + 0.25 * sin(length(nearest) * 900.0));
  return rainbow;
}

// ---------------------------------------------------------------- the note

struct Surface {
  vec3 albedo;
  float height;
  float gloss;
  float metal;      // foil / thread
  float foil;
  vec3 metalTint;
  float ovi;
  vec3 fluor;       // what glows under UV
  float trans;      // how much light gets through from behind
};

Surface note(vec2 p, float px) {
  Surface S;
  float xn = p.x / ASPECT;

  // the press: offset, then intaglio, then foil, then numbering
  float pr = uPrint;
  float offV = smoothstep(xn - 0.1, xn, clamp((pr - 0.08) / 0.32, 0.0, 1.0) * 1.1);
  float inkV = smoothstep(xn - 0.06, xn, clamp((pr - 0.36) / 0.3, 0.0, 1.0) * 1.06);
  float foilV = smoothstep(0.66, 0.74, pr);
  float redV = smoothstep(xn - 0.04, xn, clamp((pr - 0.76) / 0.18, 0.0, 1.0) * 1.04);

  // paper: a little mottled, a little fibrous
  float mott = fbm(p * 9.0);
  float fib = fbm(vec2(p.x * 220.0, p.y * 60.0) + mott * 3.0);
  vec3 col = PAPER * (0.94 + 0.08 * mott + 0.04 * fib);
  float h = (fib - 0.5) * 0.05;

  // keep-out zones: the watermark window and the portrait oval
  float wmE = length((p - WM_C) / WM_R);
  float wmClear = smoothstep(0.86, 1.0, wmE);
  float pE = length((p - PORT_C) / PORT_R);
  float inPortrait = 1.0 - smoothstep(0.995, 1.0, pE);

  // --- offset (iris printing) -------------------------------------------
  vec3 iris = xn < 0.5 ? mix(uIris0, uIris1, smoothstep(0.0, 0.5, xn)) : mix(uIris1, uIris2, smoothstep(0.5, 1.0, xn));

  // background field: fine wavy lines across the whole note
  float wv = p.y + uField.x * sin(p.x * uField.y + uField.z * sin(p.y * 7.0 + uField.w));
  float spacing = 0.0062;
  float field = lines(wv / spacing, px / spacing * 1.1, 0.0009 / px);
  vec2 C = vec2(ASPECT * 0.5, 0.5);
  float inner = smoothstep(0.0, 0.01, -sdRoundRect(p - C, C - FRAME_INSET, 0.04));
  field *= inner * wmClear * (1.0 - inPortrait) * 0.75;

  float ros = rosette(p, ROS_C, ROS_R, ROS_R * uRosA.x * 1.6, 9.0, 8.0, uRosA.y, uRosA.z, uRosA.w, uRosB.w, 0.0016, px);
  float rosIn = rosette(p, ROS_C, ROS_R * uRosB.x, ROS_R * uRosB.y * 1.4, 7.0, 6.0, uRosB.z, 0.0, -uRosA.w * 0.7, uRosB.w * 1.3, 0.0014, px);
  float med = 0.0;
  med = max(med, rosette(p, MED0.xy, MED0.z * 0.68, MED0.z * 0.27, 6.0, 4.0, uRosA.y * 0.5, 0.0, uRosA.w * 0.5, uRosB.w, 0.0015, px));
  med = max(med, rosette(p, MED1.xy, MED1.z * 0.68, MED1.z * 0.27, 6.0, 4.0, uRosA.y * 0.5, 0.0, uRosA.w * 0.5, uRosB.w, 0.0015, px));
  med = max(med, rosette(p, MED2.xy, MED2.z * 0.68, MED2.z * 0.27, 6.0, 4.0, uRosA.y * 0.5, 0.0, uRosA.w * 0.5, uRosB.w, 0.0015, px));
  float band = borderBand(p, px);
  float collar = portraitFrame(p, px);

  // the rosette pushes the background field away so it can breathe
  float rosClear = smoothstep(ROS_R * 0.55, ROS_R * 0.95, length(p - ROS_C));
  field *= mix(0.25, 1.0, rosClear);

  float off = max(max(field, ros * 0.95), max(rosIn * 0.8, band));
  off = max(off, max(med, collar * 0.9));
  off *= offV;
  col *= mix(vec3(1.0), iris, off);

  // --- fibres -------------------------------------------------------------
  vec4 fb = fibres(p, px);
  col = mix(col, col * (0.55 + 0.45 * normalize(fb.rgb + 0.4)), fb.a * 0.5);

  // --- intaglio -----------------------------------------------------------
  float plateInk = texture(tInk, p / vec2(ASPECT, 1.0)).r;
  float eng = engrave(p, px);
  float micro = borderMicro(p, px);
  float frame = lines(-sdRoundRect(p - C, C - FRAME_INSET, 0.04) / 0.5, px / 0.5, 0.0013 / px) * step(-0.002, -sdRoundRect(p - C, C - FRAME_INSET + 0.002, 0.04));
  float ink = max(max(plateInk, eng), max(micro, frame)) * inkV;
  col = mix(col, uInk, ink * 0.94);
  h += ink;

  // --- colour-shifting numeral -------------------------------------------
  vec2 uv = p / vec2(ASPECT, 1.0);
  S.ovi = texture(tOvi, uv).r * inkV;
  h += S.ovi * 0.9;

  // --- letterpress (serials) ---------------------------------------------
  float red = texture(tRed, uv).r * redV;
  col = mix(col, RED_INK, red * 0.9);
  h -= red * 0.35;

  // --- thread -------------------------------------------------------------
  float tm = smoothstep(px, -px, abs(p.x - THREAD_X) - THREAD_W * 0.5) * smoothstep(0.02, 0.04, p.y) * smoothstep(0.98, 0.96, p.y);
  float win = smoothstep(-0.12, 0.12, sin(p.y / 0.062 * TAU));
  float threadText = texture(tMicro, vec2(p.y / (THREAD_W * 0.8 * MICRO_ASPECT), (p.x - THREAD_X) / (THREAD_W * 0.8) + 0.5)).r;

  // --- foil ---------------------------------------------------------------
  float fm = foilMask(p, px) * foilV;

  S.albedo = col;
  S.height = h;
  S.gloss = 0.08 + ink * 0.35 + S.ovi * 0.6;
  S.metal = max(fm, tm * win * inkV);
  S.foil = fm;
  S.metalTint = fm > 0.0 ? vec3(0.78, 0.79, 0.8) : vec3(0.62, 0.6, 0.55) * (1.0 - threadText * 0.7);

  // --- what glows ----------------------------------------------------------
  float uvInk = texture(tUv, uv).r;
  float uvHalo = textureLod(tUv, uv, 5.0).r;
  vec3 fl = LIME * (uvInk * 0.62 + uvHalo * 0.3);
  fl += fb.rgb * 0.8;
  fl += vec3(0.25, 0.95, 0.15) * red * 0.9;                       // serials
  fl += vec3(0.05, 0.4, 1.0) * rosIn * 0.18 * offV;                  // UV-reactive offset
  fl += vec3(1.0, 0.1, 0.55) * tm * (0.6 + 0.4 * win);               // thread glows full length
  fl *= 1.0 - fm;
  S.fluor = fl * uPrint;

  // --- what lets light through -------------------------------------------
  float formation = 0.75 + 0.5 * fbm(p * 26.0) * fbm(p * 7.0 + 3.0);
  float trans = 0.42 * formation;
  vec2 wq = (p - WM_C) / WM_R;
  vec2 wuv = vec2(wq.x * 0.62 * (WM_R.x / WM_R.y) * (PORT_R.y / PORT_R.x) + 0.47, wq.y * 0.62 + 0.52);
  vec3 wsit = sitter(clamp(wuv, 0.0, 1.0), 3.5);
  float wmFade = smoothstep(1.0, 0.75, length(wq));
  float wmTone = mix(0.62, wsit.r, wsit.b) * wmFade;
  trans *= mix(1.0, mix(0.35, 2.1, wmTone), wmFade);
  trans *= 1.0 + 1.6 * textureLod(tWater, uv, 1.5).r;
  float back = texture(tBack, uv).r;
  trans *= (1.0 - 0.88 * ink) * (1.0 - 0.45 * off) * (1.0 - 0.8 * red) * (1.0 - 0.9 * S.ovi);
  trans *= 1.0 - 0.45 * back;
  trans *= 1.0 - 0.97 * fm;
  trans *= 1.0 - tm * (0.96 - threadText * 0.55);
  S.trans = trans;
  S.albedo *= 1.0 + (wmTone - 0.62) * 0.06 * wmFade;
  return S;
}

// ---------------------------------------------------------------- main

void main() {
  vec2 frag = gl_FragCoord.xy;

  // the loupe bends screen space before anything else happens
  vec2 dc = frag - uCursor;
  float dl = length(dc);
  float lensR = uLoupeR;
  float inLens = lensR > 1.0 ? 1.0 - step(lensR, dl) : 0.0;
  float rimT = lensR > 1.0 ? dl / lensR : 2.0;
  vec2 f = frag;
  if (inLens > 0.5) {
    float barrel = 1.0 + 0.18 * pow(rimT, 4.0);
    f = uCursor + dc / uLoupeMag * barrel;
  }

  // screen → note space
  vec2 d = f - uNote.xy;
  if (uNote.w > 0.5) d = vec2(-d.y, d.x);
  vec2 p = vec2(d.x, -d.y) / (2.0 * uNote.z) + vec2(ASPECT * 0.5, 0.5);
  float px = length(dFdx(p)) + 1e-6;

  vec2 C = vec2(ASPECT * 0.5, 0.5);
  float sdN = sdRoundRect(p - C, C, CORNER);
  float onNote = clamp(0.5 - sdN / px, 0.0, 1.0) * smoothstep(0.0, 0.08, uPrint);

  Surface S;
  if (sdN < px * 2.0) {
    S = note(p, px);
  } else {
    S.albedo = vec3(0.0);
    S.height = 0.0;
    S.gloss = 0.0;
    S.metal = 0.0;
    S.foil = 0.0;
    S.metalTint = vec3(0.0);
    S.ovi = 0.0;
    S.fluor = vec3(0.0);
    S.trans = 0.0;
  }

  // relief → normal. Screen-space derivatives of the height, mapped back
  // into note space so the bump strength doesn't depend on zoom.
  float hh = S.height * onNote;
  vec2 pdx = dFdx(p), pdy = dFdy(p);
  vec2 hd = vec2(dFdx(hh), dFdy(hh));
  mat2 J = mat2(pdx.x, pdy.x, pdx.y, pdy.y);
  float det = J[0][0] * J[1][1] - J[1][0] * J[0][1];
  vec2 gh = abs(det) > 1e-14 ? inverse(J) * hd : vec2(0.0);
  gh = clamp(gh, -4000.0, 4000.0);

  // a centre fold and a little wear make it a note someone has carried
  float fold = clamp((p.x - ASPECT * 0.5) / 0.012, -1.0, 1.0);
  vec2 wear = vec2(fbm(p * 3.1) - 0.5, fbm(p * 3.1 + 9.0) - 0.5) * 0.09;
  vec3 N = normalize(vec3(-gh * 0.00042 + vec2(-0.075 * fold, 0.0) + wear, 1.0));
  N = normalize(mix(vec3(0, 0, 1), N, onNote));

  // ------------------------------------------------ desk
  float deskGrain = fbm(p * 40.0) * 0.5 + 0.5 * hash12(floor(frag));
  vec3 desk = vec3(0.034, 0.031, 0.029) * (0.85 + 0.3 * deskGrain);
  // the note floats a hair above the desk; its shadow slides with the lamp
  float lift = 0.028;
  vec2 sp = uLight.xy + (p - uLight.xy) * (uLight.z / (uLight.z + lift));
  float soft = 0.006 + 0.04 * lift / max(uLight.z, 0.05);
  float shadow = 1.0 - 0.8 * smoothstep(soft, -soft, sdRoundRect(sp - C, C, CORNER));
  float contact = 1.0 - 0.6 * smoothstep(0.05, 0.0, sdN);

  vec3 P = vec3(p, hh * 0.002);
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 color = vec3(0.0);

  // ------------------------------------------------ lamp & loupe
  float wLamp = uMode.x + uMode.y;
  if (wLamp > 0.001) {
    vec3 Lv = uLight - P;
    float d2 = dot(Lv, Lv);
    vec3 Ld = Lv * inversesqrt(d2);
    float power = uLampOn * 0.34;
    float atten = power / (d2 + 0.03);
    atten *= mix(0.3, 1.0, smoothstep(0.15, 0.7, Ld.z)); // a shaded bulb, not a bare one
    // the loupe has its own LED ring: even, bright light inside the lens
    float loupeLed = uMode.y * inLens * 0.55;
    atten = atten * (1.0 - uMode.y * 0.55) + loupeLed;
    float diff = max(dot(N, Ld), 0.0);
    vec3 Hh = normalize(Ld + V);
    float nh = max(dot(N, Hh), 0.0);

    // paper and ink
    float spec = pow(nh, 36.0) * S.gloss;
    vec3 lit = S.albedo * (ROOM * 1.4 + LAMP * atten * diff) + LAMP * atten * spec;

    // colour-shifting ink: green face-on, gold at a grazing angle
    float graze = 1.0 - Ld.z;
    vec3 ovi = mix(vec3(0.015, 0.13, 0.06), vec3(0.52, 0.42, 0.07), smoothstep(0.25, 0.75, graze));
    vec3 oviLit = ovi * (ROOM + LAMP * atten * (0.35 + 0.65 * diff)) + ovi * LAMP * atten * pow(nh, 12.0) * 1.4;
    lit = mix(lit, oviLit, S.ovi);

    // foil and thread: mirror-ish metal plus diffraction colour
    float fbright;
    vec3 rainbow = foilDiffraction(p, Ld, fbright);
    // seen from straight above, a flat foil mirrors the lamp away from you:
    // it reads dark and silvery until its gratings throw colour back
    float glitter = step(0.985, hash12(floor(p * 2400.0))) * pow(nh, 4.0);
    vec3 metal = S.metalTint * (ROOM * 3.0 + LAMP * atten * (0.1 + 0.12 * diff + 1.2 * pow(nh, 80.0) + glitter * S.foil * 2.0))
               + rainbow * LAMP * atten * fbright * 0.9 * S.foil;
    lit = mix(lit, metal, S.metal);

    vec3 deskLit = desk * (ROOM * 4.0 + LAMP * atten * max(Ld.z, 0.0) * shadow) * contact;
    color += mix(deskLit, lit, onNote) * wLamp;
  }

  // ------------------------------------------------ ultraviolet
  if (uMode.z > 0.001) {
    vec2 lp = p - uLight.xy;
    float reach = 0.35 + uLight.z * 0.9;
    float uvI = uUvOn * (0.25 + 1.6 * exp(-dot(lp, lp) / (reach * reach)));
    vec3 refl = S.albedo * VIOLET * 0.09 * uvI;
    vec3 glow = S.fluor * uvI * 0.75;
    // lint on the desk glows too — it always does
    vec2 lc = floor(p / 0.017);
    float lint = step(0.985, hash12(lc + 0.5)) * smoothstep(0.0025, 0.0, length(fract(p / 0.017) - hash22(lc) * 0.8 - 0.1) * 0.017);
    vec3 deskUv = desk * VIOLET * 0.6 * uvI * shadow + vec3(0.5, 0.65, 1.0) * lint * uvI * 0.35;
    vec3 c = mix(deskUv, refl + glow, onNote) + ROOM * 0.25;
    color += c * uMode.z;
  }

  // ------------------------------------------------ backlight
  if (uMode.w > 0.001) {
    vec2 lp = p - uLight.xy;
    float B = 0.14 + 3.4 * exp(-dot(lp, lp) / 0.2);
    vec3 through = vec3(1.0, 0.9, 0.74) * B * S.trans;
    vec3 front = S.albedo * ROOM * 1.5;
    vec3 window = vec3(1.0, 0.92, 0.8) * (0.02 + 1.3 * exp(-dot(lp, lp) / 0.05)) ;
    vec3 c = mix(window, front + through, onNote);
    color += c * uMode.w;
  }

  // ------------------------------------------------ loupe body
  if (lensR > 1.0) {
    float rimW = 7.0;
    float ring = smoothstep(lensR - rimW - 1.0, lensR - rimW, dl) * (1.0 - smoothstep(lensR + 5.0, lensR + 6.0, dl));
    float hiA = dot(normalize(dc + 1e-4), normalize(vec2(-0.6, 0.8)));
    vec3 rimCol = vec3(0.07) + vec3(0.5) * pow(max(hiA, 0.0), 6.0) * smoothstep(lensR - rimW, lensR, dl);
    // glass: a faint sheen and a cool tint at the very edge
    color = mix(color, color * vec3(0.96, 0.98, 1.0) + 0.02 * pow(rimT, 6.0), inLens);
    color = mix(color, rimCol, ring);
    // soft shadow the lens casts outside itself
    color *= 1.0 - 0.35 * smoothstep(lensR + 30.0, lensR + 4.0, dl) * (1.0 - inLens) * (1.0 - ring);
  }

  // ------------------------------------------------ out
  color = color / (1.0 + color * 0.6);                 // gentle shoulder
  color = pow(max(color, 0.0), vec3(1.0 / 2.2));
  color += (hash12(frag + fract(uTime) * 61.0) - 0.5) / 255.0;  // dither away banding
  outColor = vec4(color, 1.0);
}
