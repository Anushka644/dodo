// The room behind the money. With the camera on, it is you — re-engraved
// live in the same line language as the note's portrait, light lines on dark
// ink, so your hand reads as part of the print. Without a camera, it is a
// dark desk with an engine-turned pattern breathing in it.

precision highp float;
precision highp sampler2D;

uniform vec2 uRes;
uniform float uTime;
uniform sampler2D tVideo;
uniform float uVideoOn;   // 0..1 (fades in)
uniform vec2 uVideoScale; // cover-fit: viewport uv → video uv scale
uniform float uRoom;      // 1 lights on, → 0 under the UV torch
uniform float uGlow;      // 0..1 someone is holding a note up to the light
uniform vec2 uGlowPos;    // that light, in viewport uv
uniform float uDpr;

out vec4 outColor;

const vec3 INK = vec3(0.012, 0.014, 0.012);
const vec3 LINE = vec3(0.36, 0.33, 0.27);
const vec3 VIOLET = vec3(0.035, 0.012, 0.07);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// one family of engraved lines: thickness carries tone (0 = none, 1 = solid)
float engraveLines(float t, float tone) {
  float fw = fwidth(t);
  float d = abs(fract(t + 0.5) - 0.5);
  float w = tone * 0.5;
  return smoothstep(w + fw, w - fw, d) * step(0.02, tone);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 c = uv - 0.5;
  float vign = smoothstep(1.05, 0.25, length(c * vec2(uRes.x / uRes.y, 1.0)));

  vec3 color = INK * (0.8 + 0.4 * hash12(floor(gl_FragCoord.xy / 2.0)));

  if (uVideoOn > 0.001) {
    // mirrored, cover-fitted selfie
    vec2 vuv = (uv - 0.5) * uVideoScale + 0.5;
    vuv = vec2(1.0 - vuv.x, 1.0 - vuv.y);
    float l = lum(textureLod(tVideo, vuv, 0.0).rgb);
    float lb = lum(textureLod(tVideo, vuv, 4.0).rgb);
    // local contrast so dim rooms still engrave nicely
    float tone = clamp((l - lb) * 1.6 + smoothstep(0.05, 0.85, lb), 0.0, 1.0);
    tone = pow(tone, 1.3);
    float spacing = 4.2 * uDpr;
    // lines bend with the light, the way an engraver follows form
    float t = (gl_FragCoord.y + lb * 26.0 * uDpr) / spacing;
    float a = engraveLines(t, tone * 0.95);
    float t2 = (gl_FragCoord.x * 0.7 + gl_FragCoord.y * 0.7) / (spacing * 1.15);
    float b = engraveLines(t2, smoothstep(0.62, 1.0, tone) * 0.8);
    float ink = max(a, b * 0.8);
    color = mix(color, LINE * (0.7 + 0.5 * tone), ink * uVideoOn);
  } else {
    // a slow engine-turned field on the desk, barely there
    vec2 q = c * vec2(uRes.x / uRes.y, 1.0);
    float r = length(q);
    float th = atan(q.y, q.x);
    float f = r * 60.0 + sin(th * 12.0 + uTime * 0.05) * 1.6 + sin(r * 9.0 - uTime * 0.1) * 0.8;
    float g = engraveLines(f, 0.12) * smoothstep(0.75, 0.1, r);
    color += LINE * g * 0.22;
  }

  color *= mix(0.35, 1.0, vign);

  // the light you hold notes up to
  vec2 gp = (uv - uGlowPos) * vec2(uRes.x / uRes.y, 1.0);
  float glow = exp(-dot(gp, gp) * 7.0);
  color += vec3(1.0, 0.88, 0.7) * glow * (0.05 + 0.6 * uGlow);

  // UV torch: the room lights go off
  color = mix(VIOLET * (0.4 + 0.6 * vign) + color * 0.12, color, uRoom);

  color += (hash12(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
  outColor = vec4(color, 1.0);
}
