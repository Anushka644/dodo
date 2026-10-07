// RAPHUS — the island, raymarched.
//
// One fragment shader draws the whole world at low resolution: a sculpted
// heightfield (land you raised), a lagoon with a reef and surf, forests,
// clouds, a sky with a sun you hold, stars, and the dodos. It doesn't output
// a picture — it outputs tone, depth and an accent mask, and a second pass
// prints that through a dither, like a living engraving.
//
// World: y up, sea level at y = 0, the heightmap spans x, z ∈ [-WORLD/2, WORLD/2].

precision highp float;
precision highp sampler2D;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanFov;
uniform vec3 uSun;          // unit vector towards the sun (may be below the horizon)
uniform vec4 uBrush;        // x, z, radius, strength (−1 carve … 1 raise; 0 = idle)
uniform float uBrushOn;     // 0..1 hover/press visibility
uniform vec4 uDodo[12];     // x, y, z, heading
uniform vec4 uDodoAnim[12]; // walk phase, bob, wing flap, alive (0 = unused)
uniform sampler2D tHeight;  // r: height, g: vegetation
uniform float uRain;        // 0..1
uniform float uFlash;       // lightning, 0..1
uniform float uCloud;       // cloud cover 0..1
uniform float uIntro;       // 0 → 1 opening shot

out vec4 outData;

#define PI 3.14159265
#define TAU 6.28318531

// ---------------------------------------------------------------- noise

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3;
    a *= 0.5;
  }
  return s;
}

float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3;
    a *= 0.5;
  }
  return s;
}

// ---------------------------------------------------------------- the land

float seabed(vec2 xz) {
  float r = length(xz);
  return -0.32 - 0.5 * clamp((r - 2.2) / 3.4, 0.0, 1.0) - 0.05 * fbm3(xz * 0.9);
}

vec2 land(vec2 xz) {
  vec2 uv = (xz + WORLD * 0.5) / WORLD;
  if (any(lessThan(uv, vec2(0.002))) || any(greaterThan(uv, vec2(0.998)))) return vec2(seabed(xz), 0.0);
  return textureLod(tHeight, uv, 0.0).rg;
}

float baseHeight(vec2 xz) {
  return land(xz).r;
}

// the forest the rain has grown, broken into clumps so it reads as trees
float forestDensity(vec2 xz, float veg) {
  float clumps = smoothstep(0.25, 0.75, vnoise(xz * 7.0) * 0.6 + vnoise(xz * 2.3) * 0.4 + veg * 0.6 - 0.3);
  return clamp(veg * 1.3, 0.0, 1.0) * clumps;
}

// full height including rocky detail and tree canopies
float height(vec2 xz, out float forest) {
  vec2 hv = land(xz);
  float h = hv.r;
  float land = smoothstep(-0.05, 0.25, h);
  h += (fbm3(xz * 2.6) - 0.5) * 0.09 * land;
  // rock grows craggier with altitude
  h += (vnoise(xz * 9.0) - 0.5) * 0.04 * smoothstep(0.6, 1.6, h);
  forest = forestDensity(xz, hv.g);
  // canopies: bumpy crowns that read as trees once dithered
  float crowns = vnoise(xz * 34.0) * 0.6 + vnoise(xz * 71.0) * 0.4;
  h += forest * (0.035 + 0.05 * crowns);
  return h;
}

float heightLite(vec2 xz) {
  float f;
  return height(xz, f);
}

vec3 terrainNormal(vec2 xz, float t) {
  float e = 0.004 + t * 0.0015;
  float f;
  float hx = height(xz + vec2(e, 0.0), f) - height(xz - vec2(e, 0.0), f);
  float hz = height(xz + vec2(0.0, e), f) - height(xz - vec2(0.0, e), f);
  return normalize(vec3(-hx, 2.0 * e, -hz));
}

// ---------------------------------------------------------------- dodos

float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / k1;
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

const float DODO = 1.9; // dodos are drawn larger than life, so you can find them

// a dodo in its own space: feet at the origin, facing +z. m = part id.
float dodoSDF(vec3 p, vec4 anim, out float m) {
  p /= DODO;
  float walk = anim.x;
  float bob = anim.y;
  p.y -= abs(sin(walk)) * 0.006 + bob;
  // body: a big soft egg, tipped forward
  vec3 q = p - vec3(0.0, 0.058, -0.004);
  q.yz = mat2(0.97, 0.24, -0.24, 0.97) * q.yz;
  float body = sdEllipsoid(q, vec3(0.042, 0.04, 0.05));
  // tail tuft
  float tail = sdEllipsoid(p - vec3(0.0, 0.082, -0.05), vec3(0.016, 0.02, 0.014));
  body = smin(body, tail, 0.012);
  // neck and hooded head
  float neck = sdCapsule(p, vec3(0.0, 0.075, 0.03), vec3(0.0, 0.105, 0.045), 0.02);
  float head = sdEllipsoid(p - vec3(0.0, 0.112, 0.052), vec3(0.024, 0.024, 0.026));
  float d = smin(body, smin(neck, head, 0.012), 0.016);
  // the beak: long, heavy, hooked
  vec3 b = p - vec3(0.0, 0.108, 0.07);
  float beak = sdCapsule(b, vec3(0.0), vec3(0.0, -0.006, 0.036), 0.0105 - b.z * 0.08);
  float hook = sdEllipsoid(b - vec3(0.0, -0.01, 0.036), vec3(0.008, 0.011, 0.008));
  beak = smin(beak, hook, 0.006);
  // stubby wings, flapping when excited
  float flap = anim.z;
  vec3 w = vec3(abs(p.x), p.y, p.z) - vec3(0.04, 0.065, -0.004);
  w.xy = mat2(cos(flap), sin(flap), -sin(flap), cos(flap)) * w.xy;
  float wing = sdEllipsoid(w, vec3(0.008, 0.02, 0.026));
  // legs, swinging as it waddles
  float s = sin(walk) * 0.012;
  float legL = sdCapsule(p, vec3(0.016, 0.032, 0.0), vec3(0.018, 0.0, s), 0.0055);
  float legR = sdCapsule(p, vec3(-0.016, 0.032, 0.0), vec3(-0.018, 0.0, -s), 0.0055);
  float legs = min(legL, legR);

  m = 1.0; // plumage
  float res = smin(d, wing, 0.006);
  if (beak < res) m = 2.0;
  res = min(res, beak);
  if (legs < res) m = 3.0;
  res = min(res, legs);
  // the eye, a dark bead
  float eye = length(vec3(abs(p.x), p.y, p.z) - vec3(0.019, 0.118, 0.064)) - 0.0045;
  if (eye < res + 0.001) m = 4.0;
  return res * DODO;
}

// nearest dodo hit along a ray, within [0, tmax]
float traceDodos(vec3 ro, vec3 rd, float tmax, out int hitId, out float hitM) {
  float best = tmax;
  hitId = -1;
  hitM = 0.0;
  for (int i = 0; i < 12; i++) {
    vec4 an = uDodoAnim[i];
    if (an.w < 0.5) continue;
    vec4 dd = uDodo[i];
    vec3 c = dd.xyz + vec3(0.0, 0.07 * DODO, 0.0);
    float R = 0.11 * DODO;
    vec3 oc = ro - c;
    float b = dot(oc, rd);
    float cc = dot(oc, oc) - R * R;
    float disc = b * b - cc;
    if (disc < 0.0) continue;
    float s = sqrt(disc);
    float t0 = max(-b - s, 0.0);
    float t1 = -b + s;
    if (t0 > best) continue;
    float ch = cos(dd.w), sh = sin(dd.w);
    float t = t0;
    for (int k = 0; k < 40; k++) {
      vec3 p = ro + rd * t - dd.xyz;
      p.xz = vec2(ch * p.x - sh * p.z, sh * p.x + ch * p.z);
      float m;
      float d = dodoSDF(p, an, m);
      if (d < 0.0006) {
        if (t < best) {
          best = t;
          hitId = i;
          hitM = m;
        }
        break;
      }
      t += d;
      if (t > t1 || t > best) break;
    }
  }
  return best;
}

vec3 dodoNormal(vec3 p, int id) {
  vec4 dd = uDodo[0];
  vec4 an = uDodoAnim[0];
  for (int i = 0; i < 12; i++) if (i == id) { dd = uDodo[i]; an = uDodoAnim[i]; }
  float ch = cos(dd.w), sh = sin(dd.w);
  vec3 q = p - dd.xyz;
  q.xz = vec2(ch * q.x - sh * q.z, sh * q.x + ch * q.z);
  vec2 e = vec2(0.0008, 0.0);
  float m;
  vec3 n = vec3(
    dodoSDF(q + e.xyy, an, m) - dodoSDF(q - e.xyy, an, m),
    dodoSDF(q + e.yxy, an, m) - dodoSDF(q - e.yxy, an, m),
    dodoSDF(q + e.yyx, an, m) - dodoSDF(q - e.yyx, an, m));
  // back into world orientation
  n.xz = vec2(ch * n.x + sh * n.z, -sh * n.x + ch * n.z);
  return normalize(n);
}

// ---------------------------------------------------------------- sky

float sunUp() {
  return smoothstep(-0.18, 0.25, uSun.y);
}

float clouds(vec2 xz) {
  vec2 p = xz * 0.16 + vec2(uTime * 0.012, uTime * 0.004) * (1.0 + uRain * 3.0);
  float c = fbm(p);
  return smoothstep(0.56 - 0.36 * uCloud, 0.8 - 0.25 * uCloud, c);
}

// sky brightness (the dither pass turns tone into ink)
float skyTone(vec3 rd) {
  float day = sunUp();
  float up = clamp(rd.y, 0.0, 1.0);
  float tone = mix(0.08, mix(0.62, 0.42, sqrt(up)), day);
  // the glow around the sun, and the band of light on the horizon at dusk
  float sd = max(dot(rd, uSun), 0.0);
  float dusk = 1.0 - abs(clamp(uSun.y * 3.0, -1.0, 1.0));
  tone += pow(sd, 6.0) * (0.25 + 0.35 * dusk) * smoothstep(-0.25, 0.0, uSun.y);
  tone += exp(-max(rd.y, 0.0) * 10.0) * 0.18 * (day + dusk * 0.6);
  // the sun itself, crisp
  tone += smoothstep(0.9993, 0.9997, sd) * 2.0 * smoothstep(-0.05, 0.02, uSun.y);
  // clouds on a high plane
  if (rd.y > 0.02) {
    vec3 cp = rd * (7.0 / rd.y);
    float c = clouds(cp.xz + uCamPos.xz);
    float lit = mix(0.18, 0.95, day) + pow(sd, 3.0) * dusk * 0.6;
    tone = mix(tone, lit, c * 0.85 * smoothstep(0.02, 0.18, rd.y));
  }
  return tone;
}

float stars(vec3 rd) {
  if (rd.y < 0.0) return 0.0;
  vec2 g = rd.xz / (rd.y + 0.6) * 120.0;
  vec2 id = floor(g);
  float h = hash12(id);
  float star = step(0.985, h) * smoothstep(0.42, 0.1, length(fract(g) - 0.5));
  float tw = 0.6 + 0.4 * sin(uTime * (2.0 + h * 5.0) + h * 40.0);
  return star * tw * (1.0 - sunUp());
}

// ---------------------------------------------------------------- light

float softShadow(vec3 p, vec3 l) {
  if (l.y < 0.0) return 0.0;
  float res = 1.0;
  float t = 0.02;
  for (int i = 0; i < 24; i++) {
    vec3 q = p + l * t;
    if (q.y > 2.2) break;
    float h = q.y - heightLite(q.xz);
    res = min(res, 10.0 * h / t);
    if (res < 0.0) break;
    t += clamp(h * 0.6, 0.03, 0.4);
  }
  return clamp(res, 0.0, 1.0);
}

float cloudShadow(vec3 p) {
  if (uSun.y <= 0.02) return 1.0;
  vec3 c = p + uSun * ((7.0 - p.y) / uSun.y);
  return 1.0 - 0.55 * clouds(c.xz);
}

float lightAmount() {
  // the sun, then the moon: a dim silver light from the opposite sky; storms dim both
  return mix(0.16, 1.0, sunUp()) * (1.0 - 0.5 * uRain);
}

vec3 lightDir() {
  return uSun.y > -0.05 ? uSun : normalize(vec3(-uSun.x, max(0.35, -uSun.y), -uSun.z));
}

// ---------------------------------------------------------------- main

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 ndc = (frag / uRes) * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * ndc.x * uTanFov * (uRes.x / uRes.y) + uCamUp * ndc.y * uTanFov);
  vec3 ro = uCamPos;

  float tone = 0.0;
  float accent = 0.0;
  float depth = 1.0;
  float mat = 0.0; // 0 sky, 0.25 water, 0.5 land, 0.75 dodo (for outlines)

  // --- march the land (only while the ray is below the tallest mountain)
  float tLand = 1e9;
  float tMax = 60.0;
  float top = 2.2;
  float t = 0.0;
  if (ro.y > top) {
    if (rd.y >= 0.0) t = tMax;
    else t = (ro.y - top) / -rd.y;
  }
  float forestHere = 0.0;
  for (int i = 0; i < 160; i++) {
    if (t >= tMax) break;
    vec3 p = ro + rd * t;
    if (p.y > top && rd.y > 0.0) {
      t = tMax;
      break;
    }
    float f;
    float h = height(p.xz, f);
    float d = p.y - h;
    if (d < 0.0015 * t) {
      tLand = t;
      forestHere = f;
      break;
    }
    t += max(0.006, d * 0.42);
  }

  // --- the sea surface
  float tSea = rd.y < 0.0 ? -ro.y / rd.y : 1e9;

  // --- dodos
  int dodoId;
  float dodoM;
  float tDodo = traceDodos(ro, rd, min(min(tLand, tSea), tMax), dodoId, dodoM);

  vec3 L = lightDir();
  float Li = lightAmount();

  if (dodoId >= 0) {
    vec3 p = ro + rd * tDodo;
    vec3 n = dodoNormal(p, dodoId);
    float sh = softShadow(p + n * 0.01, L) * cloudShadow(p);
    float diff = max(dot(n, L), 0.0);
    float alb = dodoM == 2.0 ? 0.85 : dodoM == 3.0 ? 0.62 : dodoM == 4.0 ? 0.02 : 0.42;
    // rim light so a dodo always reads against the ground
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0) * 0.35;
    tone = alb * (0.22 + 0.9 * diff * sh * Li) + rim * Li;
    depth = tDodo / tMax;
    mat = 0.75;
  } else if (tLand < tSea && tLand < tMax) {
    vec3 p = ro + rd * tLand;
    vec3 n = terrainNormal(p.xz, tLand);
    float sh = softShadow(p + n * 0.004, L) * cloudShadow(p);
    float diff = max(dot(n, L), 0.0);
    float slope = 1.0 - n.y;
    // sand, grass, forest, rock: each a different tone, so the island reads as a map
    float alb = 0.62;
    float sand = 1.0 - smoothstep(0.03, 0.09, p.y);
    float rock = smoothstep(0.25, 0.5, slope) + smoothstep(1.2, 1.7, p.y) * 0.6;
    alb = mix(0.55, 0.88, sand);
    // canopies catch light on their tops and keep shadow beneath
    alb = mix(alb, 0.3 + 0.12 * vnoise(p.xz * 60.0), forestHere * (1.0 - sand));
    alb = mix(alb, 0.5, clamp(rock, 0.0, 1.0) * (1.0 - sand));
    // wet sand just above the waterline
    alb *= 1.0 - 0.35 * smoothstep(0.035, 0.0, p.y);
    float ao = mix(0.55, 1.0, smoothstep(-0.3, 0.6, n.y));
    tone = alb * (0.16 * ao + 0.95 * diff * sh * Li);
    // atmospheric haze
    tone = mix(tone, skyTone(normalize(vec3(rd.x, 0.02, rd.z))), smoothstep(14.0, 40.0, tLand));
    depth = tLand / tMax;
    mat = 0.5;
  } else if (tSea < tMax) {
    vec3 p = ro + rd * tSea;
    float floorH = baseHeight(p.xz);
    float wdepth = max(0.0, -floorH);
    // waves: long swells you can read from far away, small chop only up close
    float near = exp(-tSea * 0.22);
    vec2 sw = p.xz;
    float s1 = sin(dot(sw, vec2(0.8, 0.6)) * 3.1 - uTime * 0.9);
    float s2 = sin(dot(sw, vec2(-0.5, 0.86)) * 4.7 - uTime * 1.25);
    vec2 slope = vec2(0.8, 0.6) * s1 * 0.05 + vec2(-0.5, 0.86) * s2 * 0.035;
    vec2 w1 = p.xz * 6.0 + vec2(uTime * 0.35, uTime * 0.21);
    float e = 0.15;
    float wa = vnoise(w1);
    vec2 chop = vec2(vnoise(w1 + vec2(e, 0.0)) - wa, vnoise(w1 + vec2(0.0, e)) - wa) / e;
    slope += chop * 0.05 * near;
    float calm = mix(0.3, 1.0, smoothstep(0.02, 0.4, wdepth));
    vec3 n = normalize(vec3(-slope.x * calm, 1.0, -slope.y * calm));
    vec3 r = reflect(rd, n);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
    float refl = skyTone(normalize(vec3(r.x, max(r.y, 0.02), r.z)));
    // the lagoon: shallow water is bright over sand, deep water is dark
    float shallow = exp(-wdepth * 7.0);
    float body = mix(0.08, 0.52, shallow) * (0.25 + 0.75 * Li) * cloudShadow(p);
    tone = mix(body, refl, fres * 0.9);
    // glitter where the sun catches wave tops
    float spec = pow(max(dot(r, L), 0.0), 90.0) * Li;
    tone += spec * 1.4 * smoothstep(-0.02, 0.05, uSun.y + 0.3);
    // surf: where the sea meets the shore, and the reef break further out
    float shore = smoothstep(0.045, 0.0, wdepth) * step(-0.0001, floorH + 0.3);
    float reefLine = smoothstep(0.03, 0.0, abs(wdepth - 0.16)) * smoothstep(0.0, 0.25, heightLite(p.xz) + 0.25);
    float foamNoise = vnoise(p.xz * 22.0 + vec2(uTime * 0.9, 0.0)) * 0.6 + vnoise(p.xz * 47.0 - uTime * 1.3) * 0.4;
    float pulse = 0.5 + 0.5 * sin(uTime * 1.6 - wdepth * 60.0);
    float foam = clamp(shore * (0.55 + 0.6 * foamNoise * pulse) + reefLine * smoothstep(0.45, 0.75, foamNoise) * 0.9, 0.0, 1.0);
    tone = mix(tone, 0.92 * (0.3 + 0.7 * Li), foam);
    // at night the surf glows: bioluminescence, in the only colour we have
    accent = foam * (1.0 - sunUp()) * 0.95;
    tone = mix(tone, skyTone(normalize(vec3(rd.x, 0.02, rd.z))), smoothstep(16.0, 45.0, tSea));
    depth = tSea / tMax;
    mat = 0.25;
  } else {
    tone = skyTone(rd);
    float st = stars(rd);
    tone += st * 0.9;
    depth = 1.0;
    mat = 0.0;
  }

  // the brush: a ring where your hand will push or pull the land
  if (uBrushOn > 0.001 && mat > 0.1 && mat < 0.7) {
    vec3 p = ro + rd * (depth * tMax);
    float dr = abs(length(p.xz - uBrush.xy) - uBrush.z);
    float ring = smoothstep(0.035, 0.0, dr) * uBrushOn;
    float press = abs(uBrush.w);
    tone = mix(tone, 1.0, ring * (0.55 - 0.3 * press));
    accent = max(accent, ring * press);
  }

  // rain: slanted streaks, a few print-dots long, falling at different speeds
  if (uRain > 0.01) {
    vec2 q = frag + vec2(frag.y * 0.22, 0.0);
    float col = floor(q.x / 2.0);
    float r = hash12(vec2(col, 3.7));
    float y = fract(frag.y / uRes.y * (1.6 + r) + uTime * (1.1 + r * 0.8) + r * 7.0);
    float streak = step(1.0 - uRain * 0.62, hash12(vec2(col, floor(frag.y / uRes.y * (1.6 + r) + uTime * (1.1 + r * 0.8) + r * 7.0))));
    streak *= smoothstep(0.0, 0.02, y) * (1.0 - smoothstep(0.02, 0.13, y));
    tone = mix(tone, tone * 0.45 + 0.5, streak * 0.9);
    tone *= 1.0 - 0.18 * uRain;
  }
  // the opening: a veil of cloud the camera falls through
  if (uIntro < 1.0) {
    float veil = smoothstep(0.75, 0.15, uIntro);
    float c = fbm(frag / uRes.y * 3.0 + vec2(uTime * 0.05, uIntro * 6.0));
    float cl = smoothstep(0.35 - veil * 0.4, 0.75 - veil * 0.3, c);
    tone = mix(tone, 0.95, cl * veil * 1.2);
  }
  // lightning lights everything at once
  tone = mix(tone, 1.1, uFlash * (mat < 0.1 ? 0.9 : 0.55));

  outData = vec4(clamp(tone, 0.0, 1.6) / 1.6, depth, mat, clamp(accent, 0.0, 1.0));
}
