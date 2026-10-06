// A country, seen through a window. Dark paper, an engine-turned pattern in
// the country's colours, and a guilloché band around the edge of the window:
// the border itself. Where another window overlaps, the border is open and
// glows; passport stamps and returned payments ripple where they happen.

precision highp float;

uniform vec2 uRes;        // drawing-buffer px
uniform float uDpr;       // drawing-buffer px per CSS px
uniform float uTime;
uniform vec3 uTint;       // the country's offset-print colour (linear)
uniform vec3 uTint2;
uniform float uSeed;
uniform vec4 uNeighbors[4]; // other windows in this window's CSS px: x, y, w, h (w <= 0: none)
uniform vec4 uPulses[4];    // x, y (CSS px), age (s), kind (0 stamp, 1 returned); age < 0: none

out vec4 outColor;

#define PI 3.14159265
#define TAU 6.28318531

const vec3 INK = vec3(0.010, 0.011, 0.010);
const vec3 LIME = vec3(0.565, 0.99, 0.013);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float lineAA(float t, float w) {
  float fw = fwidth(t);
  float d = abs(fract(t + 0.5) - 0.5);
  return smoothstep(w + fw, w - fw, d);
}

bool inRect(vec2 p, vec4 r) {
  return r.z > 0.0 && p.x > r.x && p.x < r.x + r.z && p.y > r.y && p.y < r.y + r.w;
}

void main() {
  vec2 css = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr; // y down, like the desk
  vec2 size = uRes / uDpr;
  vec2 c = css - size * 0.5;
  float r = length(c) / max(size.y, 1.0);
  float vign = smoothstep(1.15, 0.2, length(c / size) * 1.6);

  vec3 color = INK * (0.85 + 0.3 * hash12(floor(gl_FragCoord.xy / 2.0)));

  // a slow engine-turned field, seeded per country
  float th = atan(c.y, c.x);
  float k = 9.0 + floor(uSeed * 7.0);
  float f = r * 90.0 + sin(th * k + uTime * 0.04 + uSeed * 6.0) * 2.2 + sin(r * 11.0 - uTime * 0.07) * 1.2;
  float g = lineAA(f, 0.07) * smoothstep(0.85, 0.12, r);
  float f2 = r * 90.0 - sin(th * k + uTime * 0.04 + uSeed * 6.0) * 2.2;
  g = max(g, lineAA(f2, 0.07) * smoothstep(0.85, 0.12, r) * 0.7);
  color += uTint * g * 0.13;
  color *= mix(0.45, 1.0, vign);

  // the border: a guilloché band hugging the window edge
  float inset = 12.0;
  float band = 9.0;
  float dEdge = min(min(css.x, size.x - css.x), min(css.y, size.y - css.y));
  float inBand = smoothstep(inset - 1.0, inset, dEdge) * (1.0 - smoothstep(inset + band, inset + band + 1.0, dEdge));
  if (inBand > 0.0 || dEdge < inset + band + 2.0) {
    // position along the edge, for the waves
    float along = dEdge == css.x || dEdge == size.x - css.x ? css.y : css.x;
    float across = (dEdge - inset) / band; // 0..1 across the band
    float wave = across - 0.5 - 0.32 * sin(along * 0.11 + uSeed * 9.0);
    float wave2 = across - 0.5 + 0.32 * sin(along * 0.11 + uSeed * 9.0);
    float lines = max(lineAA(wave * 3.0, 0.08), lineAA(wave2 * 3.0, 0.08));
    lines = max(lines, max(lineAA(across * 1.0 - 0.0, 0.03), lineAA(across - 1.0, 0.03)));

    // is the far side of this edge another country? then the border is open
    vec2 outward = dEdge == css.x ? vec2(-1.0, 0.0) : dEdge == size.x - css.x ? vec2(1.0, 0.0) : dEdge == css.y ? vec2(0.0, -1.0) : vec2(0.0, 1.0);
    vec2 probe = css + outward * (dEdge + 30.0);
    float open = 0.0;
    for (int i = 0; i < 4; i++) if (inRect(probe, uNeighbors[i])) open = 1.0;
    float dash = step(0.45, fract(along / 18.0 - uTime * 1.2 * outward.x - uTime * 1.2 * outward.y));
    vec3 closedCol = mix(uTint, uTint2, 0.5 + 0.5 * sin(along * 0.01)) * 0.55;
    vec3 openCol = LIME * (0.55 + 0.45 * dash);
    color = mix(color, mix(closedCol, openCol, open), lines * inBand);
  }

  // stamps and bounced payments ripple out where they happened
  for (int i = 0; i < 4; i++) {
    vec4 pl = uPulses[i];
    if (pl.z < 0.0) continue;
    float d = length(css - pl.xy);
    float rad = 30.0 + pl.z * 300.0;
    float ring = exp(-pow((d - rad) / (4.0 + pl.z * 12.0), 2.0)) * exp(-pl.z * 3.2);
    vec3 col = pl.w > 0.5 ? vec3(0.9, 0.25, 0.2) : LIME;
    color += col * ring * 0.2;
  }

  color = pow(max(color, 0.0), vec3(1.0 / 2.2));
  color += (hash12(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
  outColor = vec4(color, 1.0);
}
