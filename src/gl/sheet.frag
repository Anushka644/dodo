// A banknote as a sheet of paper in 3D. The material comes from
// material.glsl (evaluated at the mesh's note-space UV); this file lights it:
// a key light, the room, your webcam as the environment the foil reflects,
// a light behind it when you hold it up, and a UV torch on your fingertip.

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;

out vec4 outColor;

uniform vec3 uEye;
uniform vec3 uKeyDir;      // towards the key light
uniform vec3 uKeyCol;
uniform vec3 uFillDir;
uniform vec3 uFillCol;
uniform vec3 uAmbient;
uniform float uRoom;       // 1 = lights on, → 0 when the UV torch takes over
uniform float uWrinkle;    // how crumpled this note has ever been
uniform float uBacklight;  // 0..1: held up to the light
uniform vec3 uBackPos;     // the light it is held up to
uniform vec4 uTorch;       // UV torch: fingertip position (xyz), intensity (w)
uniform vec3 uTorchDir;
uniform sampler2D tVideo;  // your room, for reflections
uniform float uVideoOn;
uniform float uSelected;   // 0..1: a hand is about to grab this one

// what the foil and gloss see: the room behind the screen (the webcam), or a softbox
vec3 environment(vec3 R) {
  vec3 studio = mix(vec3(0.05, 0.05, 0.06), vec3(0.9, 0.85, 0.78), smoothstep(-0.2, 0.9, R.y)) * 0.8;
  if (uVideoOn < 0.5) return studio;
  // the camera sits where the viewer sits, so reflections point back at it
  vec2 uv = vec2(0.5 + R.x * 0.45, 0.5 - R.y * 0.45);
  uv.x = 1.0 - uv.x;
  vec3 cam = textureLod(tVideo, clamp(uv, 0.0, 1.0), 3.0).rgb;
  // desaturate: the room should tint the foil, not paint it
  cam = mix(vec3(dot(cam, vec3(0.3, 0.59, 0.11))), cam, 0.55);
  return mix(studio, cam * cam * 1.6, 0.7);
}

void main() {
  vec2 p = vUv;
  vec2 duv1 = dFdx(vUv), duv2 = dFdy(vUv);
  float px = max(length(duv1), length(duv2)) + 1e-6;

  Surface S;
  if (gl_FrontFacing) S = note(p, px);
  else S = noteBack(p, px);

  // paper keeps its creases: add them to the relief
  float crease = uWrinkle > 0.001 ? creases(p) * uWrinkle : 0.0;
  float h = S.height * 0.0011 + crease * 0.02;

  // cotangent frame from screen derivatives (no tangents in the mesh)
  vec3 Ng = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 dp1 = dFdx(vWorld), dp2 = dFdy(vWorld);
  vec3 dp2perp = cross(dp2, Ng), dp1perp = cross(Ng, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
  T *= invmax;
  B *= invmax;

  // bump from the height field (Mikkelsen's surface-gradient method)
  float dh1 = dFdx(h), dh2 = dFdy(h);
  float det = dot(dp1, dp2perp);
  vec3 grad = sign(det) * (dh1 * dp2perp + dh2 * dp1perp);
  vec3 N = normalize(abs(det) * Ng - grad);
  if (!(dot(N, N) > 0.5)) N = Ng;

  vec3 V = normalize(uEye - vWorld);
  vec3 L = uKeyDir;
  vec3 Hh = normalize(L + V);
  float nl = max(dot(N, L), 0.0);
  float nh = max(dot(N, Hh), 0.0);
  float nv = max(dot(N, V), 0.0);
  // paper is thin: some key light wraps round and some leaks through
  float wrap = max(dot(N, L) * 0.6 + 0.4, 0.0);
  float through = max(-dot(Ng, L), 0.0) * 0.35;

  vec3 light = uAmbient + uKeyCol * mix(nl, wrap, 0.3) + uFillCol * max(dot(N, uFillDir), 0.0) + uKeyCol * through;
  float spec = pow(nh, 40.0) * S.gloss;
  vec3 color = S.albedo * light + uKeyCol * spec;

  // colour-shifting ink: green face-on, gold as the note tilts away from you
  vec3 ovi = mix(vec3(0.015, 0.16, 0.07), vec3(0.62, 0.48, 0.06), smoothstep(0.88, 0.45, nv));
  vec3 oviLit = ovi * (light + uKeyCol * pow(nh, 10.0) * 1.6);
  color = mix(color, oviLit, S.ovi);

  // foil and thread: mirror the room, throw diffraction colour as the wrist turns
  vec3 R = reflect(-V, N);
  vec3 env = environment(R);
  vec3 Ht = vec3(dot(Hh, T), dot(Hh, B), dot(Hh, N));
  float fbright;
  vec3 rainbow = foilDiffraction(p, normalize(vec3(Ht.xy * 2.2, max(Ht.z, 0.05))), fbright);
  float glitter = step(0.985, hash12(floor(p * 2400.0))) * pow(nh, 3.0);
  vec3 metal = S.metalTint * (env * 0.6 + uKeyCol * (0.14 * nl + 1.4 * pow(nh, 70.0) + glitter * S.foil * 3.0))
             + rainbow * (uKeyCol * 0.9 + env * 0.3) * fbright * S.foil;
  color = mix(color, metal, S.metal);

  // a hint of the room in the glossy intaglio too
  color += env * S.gloss * 0.08 * pow(1.0 - nv, 3.0);

  color *= uRoom;

  // held up to the light: the paper glows and gives away its watermark
  if (uBacklight > 0.001) {
    float d = length(vWorld - uBackPos);
    vec3 glow = vec3(1.0, 0.88, 0.7) * (0.7 + 1.5 * exp(-d * d * 0.3)) * S.trans;
    color = mix(color, color * 0.25 + glow, uBacklight);
  }

  // UV torch on the fingertip: everything meant to glow, glows
  if (uTorch.w > 0.001) {
    vec3 d = vWorld - uTorch.xyz;
    float dist = length(d);
    float cone = smoothstep(0.55, 0.9, dot(d / max(dist, 1e-4), uTorchDir));
    float I = uTorch.w * (0.25 + cone) / (1.0 + dist * dist * 0.5);
    color += S.fluor * I * 1.1 + S.albedo * VIOLET * 0.05 * I;
  }

  // a faint lime edge when a hand is about to take it
  float edge = min(min(p.x, ASPECT - p.x), min(p.y, 1.0 - p.y));
  color += LIME * uSelected * 0.35 * smoothstep(0.03, 0.0, edge);
  // the paper has a thickness: edges read slightly darker
  color *= mix(0.82, 1.0, smoothstep(0.0, 0.006, edge));

  color = color / (1.0 + color * 0.55);
  color = pow(max(color, 0.0), vec3(1.0 / 2.2));
  color += (hash12(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
  outColor = vec4(color, 1.0);
}
