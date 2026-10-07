// RAPHUS — the island, raymarched.
//
// One fragment shader draws the whole world at print resolution: a sculpted
// heightfield (land you raised), a lagoon with a reef and surf, forests,
// clouds, a sky with a sun you hold, stars, and the dodos. It doesn't output
// a picture — it outputs, for every printed dot, how light it is, how far, what
// it's made of (which ramp of spot inks prints it) and how much it glows; a
// second pass inks that like a risograph run.
//
// Values are composed like a print, not a photograph: the island is the
// lightest, most contrasted thing; the sea sits calm in the middle; the sky
// is pale; the key black is kept for contours. The palette decides the colour.
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
uniform sampler2D tHeight;  // r: height, g: vegetation, b: lava heat, a: rivers
uniform float uRain;        // 0..1
uniform float uFlash;       // lightning, 0..1
uniform float uCloud;       // cloud cover 0..1
uniform float uIntro;       // 0 → 1 opening shot
uniform vec4 uVent[4];      // smoke over new land: x, base y, z, strength
uniform vec4 uBird[16];     // seabirds: x, y, z, wing (> 5: away at sea, not drawn)
uniform vec4 uWind;         // wind over the world: direction (x, z), strength 0..1
uniform vec2 uWindOff;      // how far it has carried the clouds, integrated (so they never jump)
uniform vec4 uWindHead;     // where on the print the wind head blows from (texel x, y) and its direction on the print

out vec4 outData;

#define PI 3.14159265
#define TAU 6.28318531

// what each dot prints in — the ramps of palettes.ts (MATERIALS), in this order
const float M_INK = 0.0;    // pure key or paper: birds, the dodo's eye
const float M_SKY = 1.0;
const float M_SMOKE = 2.0;
const float M_WATER = 3.0;
const float M_LAND = 4.0;   // sand and bare earth
const float M_ROCK = 5.0;
const float M_FOREST = 6.0;
const float M_DODO = 7.0;
const float M_BEAK = 8.0;   // beak and legs

// ---------------------------------------------------------------- noise

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
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

vec4 land(vec2 xz) {
  vec2 uv = (xz + WORLD * 0.5) / WORLD;
  if (any(lessThan(uv, vec2(0.002))) || any(greaterThan(uv, vec2(0.998)))) return vec4(seabed(xz), 0.0, 0.0, 0.0);
  return textureLod(tHeight, uv, 0.0);
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
  vec4 hv = land(xz);
  float h = hv.r;
  float land = smoothstep(-0.05, 0.25, h);
  h += (fbm3(xz * 2.6) - 0.5) * 0.09 * land;
  // rock grows craggier with altitude
  h += (vnoise(xz * 9.0) - 0.5) * 0.04 * smoothstep(0.6, 1.6, h);
  // rivers sit in their beds, and no trees grow in them
  float river = smoothstep(0.2, 0.7, hv.a);
  h -= river * 0.015 * land;
  forest = forestDensity(xz, hv.g) * (1.0 - river);
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

// trees, as an illustrator draws a forest from above: a round crown in each
// cell of a jittered grid, overlapping its neighbours. Returns the crown's
// slope (xy, in crown radii from its centre) and its height (z: 1 centre → 0
// rim, < 0 in the gaps between crowns). Shading only — the march uses height().
vec3 crown(vec2 xz) {
  const float S = 0.06;
  vec2 g = xz / S;
  vec2 i = floor(g), f = fract(g);
  float best = 1e9;
  vec2 bu = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(x, y);
      vec2 h = hash22(i + o);
      vec2 u = (f - o - 0.15 - 0.7 * h) / (0.5 + 0.28 * h.y);
      float d = dot(u, u);
      if (d < best) {
        best = d;
        bu = u;
      }
    }
  }
  return vec3(bu, 1.0 - best);
}

// how far a point stands proud of the land around it: ridges > 0, valleys < 0.
// Shading by it (as relief maps do) makes the folds of the island legible.
float cavity(vec2 xz) {
  const float r = 0.16;
  float a = land(xz + vec2(r, 0.0)).r + land(xz - vec2(r, 0.0)).r + land(xz + vec2(0.0, r)).r + land(xz - vec2(0.0, r)).r;
  return land(xz).r - a * 0.25;
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

const float DODO = 1.6; // dodos are drawn a little larger than life, so you can find them

// a dodo in its own space: feet at the origin, facing +z.
// m = part: 1 plumage, 2 beak, 3 legs, 4 eye, 5 the pale tail tuft
float dodoSDF(vec3 p, vec4 anim, out float m) {
  p /= DODO;
  float walk = anim.x;
  float bob = anim.y;
  p.y -= abs(sin(walk)) * 0.006 + bob;
  // body: a big soft egg, tipped forward
  vec3 q = p - vec3(0.0, 0.058, -0.004);
  q.yz = mat2(0.97, 0.24, -0.24, 0.97) * q.yz;
  float body = sdEllipsoid(q, vec3(0.042, 0.04, 0.05));
  // tail tuft: a curl of pale feathers
  float tail = sdEllipsoid(p - vec3(0.0, 0.086, -0.052), vec3(0.018, 0.022, 0.016));
  float torso = smin(body, tail, 0.012);
  // neck and hooded head
  float neck = sdCapsule(p, vec3(0.0, 0.075, 0.03), vec3(0.0, 0.105, 0.045), 0.02);
  float head = sdEllipsoid(p - vec3(0.0, 0.113, 0.052), vec3(0.026, 0.026, 0.028));
  float d = smin(torso, smin(neck, head, 0.012), 0.016);
  // the beak: long, heavy, hooked — the thing you know a dodo by
  vec3 b = p - vec3(0.0, 0.109, 0.071);
  float beak = sdCapsule(b, vec3(0.0), vec3(0.0, -0.007, 0.04), 0.0125 - b.z * 0.09);
  float hook = sdEllipsoid(b - vec3(0.0, -0.011, 0.04), vec3(0.009, 0.012, 0.009));
  beak = smin(beak, hook, 0.006);
  // stubby wings, flapping when excited
  float flap = anim.z;
  vec3 w = vec3(abs(p.x), p.y, p.z) - vec3(0.04, 0.065, -0.004);
  w.xy = mat2(cos(flap), sin(flap), -sin(flap), cos(flap)) * w.xy;
  float wing = sdEllipsoid(w, vec3(0.008, 0.02, 0.026));
  // legs, swinging as it waddles
  float s = sin(walk) * 0.012;
  float legL = sdCapsule(p, vec3(0.016, 0.032, 0.0), vec3(0.018, 0.0, s), 0.006);
  float legR = sdCapsule(p, vec3(-0.016, 0.032, 0.0), vec3(-0.018, 0.0, -s), 0.006);
  float legs = min(legL, legR);

  m = tail < body - 0.004 ? 5.0 : 1.0;
  float res = smin(d, wing, 0.006);
  if (beak < res) m = 2.0;
  res = min(res, beak);
  if (legs < res) m = 3.0;
  res = min(res, legs);
  // the eye, a dark bead
  float eye = length(vec3(abs(p.x), p.y, p.z) - vec3(0.02, 0.119, 0.064)) - 0.0055;
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

// the moon rises opposite the sun
vec3 moonDir() {
  return normalize(vec3(-uSun.x, max(0.35, -uSun.y), -uSun.z));
}

float clouds(vec2 xz) {
  vec2 p = xz * 0.16 + vec2(uTime * 0.012, uTime * 0.004) * (1.0 + uRain * 3.0) - uWindOff * 0.16;
  float c = fbm(p);
  return smoothstep(0.56 - 0.36 * uCloud, 0.8 - 0.25 * uCloud, c);
}

// how light the sky prints (the palette turns value into ink): pale by day,
// palest at the horizon; at night a deep vault with a lighter rim and a moon
float skyTone(vec3 rd) {
  float day = sunUp();
  float up = sqrt(clamp(rd.y, 0.0, 1.0));
  float dusk = 1.0 - abs(clamp(uSun.y * 3.0, -1.0, 1.0));
  // by day the sky prints in its palest inks; at sunrise and sunset it sinks a
  // step or two so its own colours show, and lifts again around the sun
  float dayTone = mix(mix(0.9, 0.64, up), mix(0.72, 0.4, up), dusk * 0.85);
  float tone = mix(mix(0.42, 0.17, up), dayTone, day);
  float sd = max(dot(rd, uSun), 0.0);
  tone += (pow(sd, 5.0) * (0.06 + 0.3 * dusk) + pow(sd, 40.0) * 0.25 * dusk) * smoothstep(-0.25, 0.0, uSun.y);
  // the sun itself, crisp
  tone += smoothstep(0.9993, 0.9997, sd) * 2.0 * smoothstep(-0.05, 0.02, uSun.y);
  // the moon, with a faint halo
  float md = dot(rd, moonDir());
  tone += (smoothstep(0.9991, 0.9994, md) + pow(max(md, 0.0), 60.0) * 0.16) * (1.0 - day);
  // clouds on a high plane
  if (rd.y > 0.02) {
    vec3 cp = rd * (7.0 / rd.y);
    float c = clouds(cp.xz + uCamPos.xz);
    float lit = mix(0.5, mix(0.98, 0.8, dusk), day) + pow(sd, 3.0) * dusk * 0.3 - uRain * 0.35;
    tone = mix(tone, lit, c * 0.85 * smoothstep(0.02, 0.18, rd.y));
  }
  // a storm darkens the whole sky
  return tone * (1.0 - 0.3 * uRain);
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
  return 1.0 - 0.4 * clouds(c.xz);
}

float lightAmount() {
  // the sun, then the moon. The night palette does the darkening, so the moon
  // is generous: the island should still read, blue, by its light. Storms dim both.
  return mix(0.74, 1.0, sunUp()) * (1.0 - 0.22 * uRain);
}

// where the light really is (for glitter on the water)
vec3 lightDir() {
  return uSun.y > -0.05 ? uSun : moonDir();
}

// the light that models the land: from the sun's (or moon's) side of the sky,
// but never so low the island sinks into its own shadow, nor so high it goes flat
vec3 modelLight() {
  vec3 L = lightDir();
  vec2 h = L.xz;
  float hl = length(h);
  h = hl > 1e-3 ? h / hl : vec2(0.6, -0.8);
  float el = clamp(L.y, 0.4, 0.7);
  float c = sqrt(1.0 - el * el);
  return vec3(h.x * c, el, h.y * c);
}

// ---------------------------------------------------------------- smoke

// a plume rises from new land, leaning downwind and billowing as it climbs
float plumeTop(vec4 v) {
  return 0.45 + 2.0 * v.w;
}

vec2 plumeLean(float hgt) {
  return vec2(0.6, 0.22) * hgt * hgt * 0.24 + uWind.xy * uWind.z * hgt * 0.6;
}

float plumeDensity(vec3 p, vec4 v) {
  float hgt = p.y - v.y;
  float top = plumeTop(v);
  if (hgt < 0.0 || hgt > top * 1.2) return 0.0;
  float k = hgt / top;
  // steam off the sea is thin and soon gone; ash off the land is a dense column
  float ash = smoothstep(0.02, 0.2, v.y);
  vec2 q = p.xz - v.xz - plumeLean(hgt);
  float ql = length(q);
  vec2 dir = q / max(ql, 1e-4);
  float rise = hgt - uTime * 0.3;
  float seed = v.x * 9.0 + v.z * 3.0;
  // the outline is a stack of round puffs rolling up the column. It depends
  // only on height and on the direction around the column, so a puff keeps its
  // shape right through the plume and the silhouette billows (noise that varied
  // through the plume would average out into a smooth, straight-sided cone)
  float az = vnoise(dir * 1.7 + vec2(rise * 1.3, seed));
  float ph = rise * 2.3 + az * 1.1 + seed;
  float puff = sqrt(max(0.0, 1.0 - pow(2.0 * fract(ph) - 1.0, 2.0)));
  float base = (0.06 + 0.38 * sqrt(hgt) + 0.12 * (1.0 - ash) * hgt) * mix(1.15, 1.0, ash);
  float r = base * (0.6 + 0.52 * puff + 0.3 * (az - 0.5));
  // inside, softer lumps to shade the billows
  float lumps = fbm3(q / base * 1.4 + vec2(rise * 1.5, -rise) + seed);
  float d = ql / r + (lumps - 0.5) * 0.35;
  float dens = smoothstep(1.0, 0.35, d);
  // it thins as it climbs (steam soonest) and frays away at the top
  float fade = 1.0 - smoothstep(mix(0.3, 0.6, ash), 1.15, k + (az - 0.5) * 0.4);
  return dens * fade * smoothstep(0.0, 0.05, hgt) * v.w * mix(0.55, 1.0, ash);
}

// march every plume this ray passes through; returns (transmittance, light, glow).
// Outside a plume's hull the ray strides; inside it takes short, even steps.
vec3 traceSmoke(vec3 ro, vec3 rd, float tEnd, vec3 L) {
  float T = 1.0, lit = 0.0, glow = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 v = uVent[i];
    if (v.w < 0.01) continue;
    float hmax = plumeTop(v) * 1.2;
    vec2 lt = plumeLean(hmax);
    vec3 e = v.xyz + vec3(lt.x, hmax, lt.y);
    vec3 c = 0.5 * (v.xyz + e);
    float R = 0.5 * length(e - v.xyz) + 0.25 * length(lt) + 0.1 + 0.9 * sqrt(hmax) + 0.25 * hmax;
    vec3 oc = ro - c;
    float b = dot(oc, rd);
    float disc = b * b - dot(oc, oc) + R * R;
    if (disc < 0.0) continue;
    float s = sqrt(disc);
    float t = max(-b - s, 0.0);
    float t1 = min(-b + s, tEnd);
    if (t1 <= t) continue;
    // steam over the sea is white; ash over land is grey
    float alb = mix(1.0, 0.74, smoothstep(0.05, 0.5, v.y));
    float hot = mix(0.2, 1.0, smoothstep(0.02, 0.2, v.y));
    const float dt = 0.07;
    for (int k = 0; k < 40; k++) {
      if (t > t1 || T < 0.03) break;
      vec3 p = ro + rd * t;
      float hgt = p.y - v.y;
      // how far outside the plume's widest possible billows this point is
      vec2 q = p.xz - v.xz - plumeLean(clamp(hgt, 0.0, hmax));
      float hc = clamp(hgt, 0.0, hmax);
      float hull = (0.06 + 0.38 * sqrt(hc) + 0.12 * hc) * 1.9 + 0.03;
      float away = max(length(q) - hull, max(-hgt, hgt - hmax));
      if (away > 0.0) {
        t += max(away * 0.6, 0.04);
        continue;
      }
      float d = plumeDensity(p, v);
      if (d > 0.002) {
        float a = 1.0 - exp(-d * dt * 9.0);
        // billows lit on the light's side, shadowed on the other
        float self = plumeDensity(p + L * 0.22, v);
        // (by moonlight the shadows stay shallow, or the billows turn into faces)
        float shade = 1.0 - (1.0 - exp(-self * 3.0)) * mix(0.3, 0.5, sunUp());
        lit += T * a * alb * shade;
        // lava lights its smoke from below; steam off the sea barely glows
        glow += T * a * exp(-hgt * 2.2) * v.w * hot;
        T *= 1.0 - a;
      }
      t += dt;
    }
  }
  return vec3(T, lit, glow);
}

// ---------------------------------------------------------------- birds

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// seabirds, as an engraver draws them: a little "M" of ink, wings beating
float birds(vec2 frag, vec3 ro, float sceneT) {
  float ink = 0.0;
  float aspect = uRes.x / uRes.y;
  for (int i = 0; i < 16; i++) {
    vec4 b = uBird[i];
    if (b.w > 5.0 || (b.x == 0.0 && b.y == 0.0 && b.z == 0.0)) continue;
    vec3 d = b.xyz - ro;
    float z = dot(d, uCamFwd);
    if (z < 0.3 || length(d) > sceneT) continue;
    vec2 ndc = vec2(dot(d, uCamRight) / (z * uTanFov * aspect), dot(d, uCamUp) / (z * uTanFov));
    vec2 c = (ndc * 0.5 + 0.5) * uRes;
    // wingspan in print dots, never smaller than a few
    float span = clamp(0.085 / (z * uTanFov * 2.0) * uRes.y, 3.2, 14.0);
    vec2 o = frag - c;
    if (abs(o.x) > span * 1.2 || abs(o.y) > span) continue;
    vec2 u = vec2(abs(o.x), o.y) / span;
    float w = b.w; // −1 down … 1 up
    vec2 elbow = vec2(0.42, 0.18 + 0.35 * w);
    vec2 tip = vec2(1.0, -0.05 + 0.75 * w);
    float dist = min(sdSegment(u, vec2(0.0), elbow), sdSegment(u, elbow, tip)) * span;
    ink = max(ink, smoothstep(0.8, 0.3, dist));
  }
  return ink;
}


// ---------------------------------------------------------------- main

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 ndc = (frag / uRes) * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * ndc.x * uTanFov * (uRes.x / uRes.y) + uCamUp * ndc.y * uTanFov);
  vec3 ro = uCamPos;

  float tone = 0.0;
  float accent = 0.0;
  float mat = M_SKY;

  // --- march the land (only while the ray is below the tallest mountain)
  float tLand = 1e9;
  float tMax = 60.0;
  float tHit = tMax;
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
  vec3 Lm = modelLight();
  float Li = lightAmount();
  float day = sunUp();

  if (dodoId >= 0) {
    vec3 p = ro + rd * tDodo;
    vec3 n = dodoNormal(p, dodoId);
    float sh = softShadow(p + n * 0.01, Lm) * cloudShadow(p);
    float diff = max(dot(n, Lm), 0.0);
    // a pale bird in good light, with a rim so it lifts off the ground behind
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    float lit = (0.58 + 0.12 * n.y + 0.5 * diff * sh) * Li;
    if (dodoM == 4.0) {
      mat = M_INK;
      tone = 0.0;
    } else if (dodoM == 2.0 || dodoM == 3.0) {
      mat = M_BEAK;
      // never so light it prints as paper: the beak should always read yellow
      tone = min((dodoM == 2.0 ? 0.98 : 0.8) * lit + rim * 0.1, 0.84);
    } else {
      mat = M_DODO;
      tone = (dodoM == 5.0 ? 1.0 : 0.74) * lit + rim * 0.16;
    }
    tHit = tDodo;
  } else if (tLand < tSea && tLand < tMax) {
    vec3 p = ro + rd * tLand;
    vec4 here = land(p.xz);
    vec3 n = terrainNormal(p.xz, tLand);
    float sh = softShadow(p + n * 0.004, Lm) * cloudShadow(p);
    float diff = max(dot(n, Lm), 0.0);
    float slope = 1.0 - n.y;
    float heat = here.b;
    float grain = vnoise(p.xz * 23.0) - 0.5;
    // sand, earth, rock, scrub, forest: each prints in its own ink, so the island reads as a map
    float sand = 1.0 - smoothstep(0.035, 0.085, p.y + grain * 0.025);
    float rockA = clamp(smoothstep(0.3, 0.52, slope) + smoothstep(1.15, 1.6, p.y) * 0.7, 0.0, 1.0);
    float alb;
    float fillK = 1.0;
    if (heat > 0.03) {
      mat = M_ROCK;
      alb = 0.6;
    } else if (sand > 0.5) {
      mat = M_LAND;
      // sand is the lightest thing on the island, even in shade; wet just above the waterline
      alb = 0.98 - 0.26 * smoothstep(0.03, 0.0, p.y);
      fillK = 1.75;
    } else if (forestHere + grain * 0.2 > 0.42) {
      mat = M_FOREST;
      // tree crowns: each a little dome with a lit side and a shadow side, dark gaps between.
      // They fade to a plain canopy where a crown would be smaller than a few dots.
      float dotSize = tLand * 2.0 * uTanFov / uRes.y;
      float sharp = smoothstep(0.06 / 2.5, 0.06 / 5.0, dotSize);
      vec3 cr = crown(p.xz);
      float gap = smoothstep(0.08, -0.12, cr.z);
      n = normalize(n + vec3(cr.x, 0.0, cr.y) * 0.85 * sharp * (1.0 - gap));
      diff = max(dot(n, Lm), 0.0);
      alb = mix(0.6 + 0.1 * hash12(floor(p.xz / 0.06)), 0.4, gap * sharp);
    } else if (here.g + grain * 0.25 > 0.22) {
      mat = M_FOREST;
      alb = 0.86; // scrub and grass, before it's forest
    } else if (rockA + grain * 0.3 > 0.5) {
      mat = M_ROCK;
      // crags: dark seams through pale stone
      float seam = abs(vnoise(p.xz * 13.0 + p.y * 4.0) - 0.5);
      alb = 0.7 * mix(0.55, 1.0, smoothstep(0.0, 0.07, seam));
    } else {
      mat = M_LAND;
      alb = 0.68; // bare earth
    }
    // new rock is charcoal while it's still warm
    alb *= 1.0 - 0.62 * smoothstep(0.02, 0.35, heat);
    // light: from the whole sky (so the shaded side still has form), then the sun;
    // valleys sink and ridges lift, like a relief map
    float cav = cavity(p.xz);
    float ao = mix(0.62, 1.0, smoothstep(-0.2, 0.7, n.y)) * clamp(1.0 + cav * 6.0, 0.62, 1.15);
    float fill = (0.4 + 0.12 * n.y) * ao * fillK;
    tone = alb * (fill + 0.62 * diff * sh) * Li;

    // rivers and lakes: water laid across the land, with a dark lip where it cuts in
    const float CELL = WORLD / 256.0;
    float wet = max(here.a, max(max(land(p.xz + vec2(CELL * 0.6, 0.0)).a, land(p.xz - vec2(CELL * 0.6, 0.0)).a), max(land(p.xz + vec2(0.0, CELL * 0.6)).a, land(p.xz - vec2(0.0, CELL * 0.6)).a)));
    float riv = smoothstep(0.3, 0.55, wet);
    float bank = smoothstep(0.1, 0.32, wet) * (1.0 - riv);
    tone *= 1.0 - 0.4 * bank;
    if (riv > 0.5) {
      // ripples run downhill (the normal leans that way), drawn out along the current
      vec2 down = length(n.xz) > 1e-3 ? normalize(n.xz) : vec2(0.0, 1.0);
      vec2 q = vec2(dot(p.xz, down), dot(p.xz, vec2(-down.y, down.x)));
      float ripple = vnoise(vec2(q.x * 9.0 - uTime * 2.2, q.y * 42.0));
      vec3 rr = reflect(rd, vec3(0.0, 1.0, 0.0));
      float sky = skyTone(normalize(vec3(rr.x, max(rr.y, 0.05), rr.z)));
      tone = (0.5 + 0.14 * sky + 0.28 * smoothstep(0.6, 0.9, ripple)) * Li;
      mat = M_WATER;
    }
    // lava: cracks in the new rock glow while it's hot, and the hottest of it pools
    if (heat > 0.02) {
      vec2 q = p.xz * 6.0;
      float c1 = abs(vnoise(q + uTime * 0.1) - 0.5);
      float c2 = abs(vnoise(q * 2.3 - 11.0 - uTime * 0.05) - 0.5);
      float crack = smoothstep(0.018 + 0.06 * heat, 0.0, min(c1, c2 * 1.3));
      float pool = smoothstep(0.8, 1.0, heat) * smoothstep(0.45, 0.75, vnoise(q * 0.6 + 4.0));
      float g = smoothstep(0.14, 0.42, heat) * crack + pool;
      accent = max(accent, g);
      // the rock beside a glowing crack catches its light
      tone += smoothstep(0.1, 0.6, heat) * crack * 0.25;
    }
    // atmospheric haze
    tone = mix(tone, skyTone(normalize(vec3(rd.x, 0.02, rd.z))), smoothstep(14.0, 40.0, tLand));
    tHit = tLand;
  } else if (tSea < tMax) {
    vec3 p = ro + rd * tSea;
    float floorH = baseHeight(p.xz);
    float wdepth = max(0.0, -floorH);
    // long, low swells you read from far away; only a little chop up close
    float near = exp(-tSea * 0.3);
    float s1 = sin(dot(p.xz, vec2(0.8, 0.6)) * 2.4 - uTime * 0.8);
    float s2 = sin(dot(p.xz, vec2(-0.5, 0.86)) * 3.4 - uTime * 1.05);
    vec2 slope = vec2(0.8, 0.6) * s1 * 0.035 + vec2(-0.5, 0.86) * s2 * 0.025;
    vec2 w1 = p.xz * 5.0 + vec2(uTime * 0.3, uTime * 0.18);
    float wa = vnoise(w1);
    vec2 chop = vec2(vnoise(w1 + vec2(0.15, 0.0)) - wa, vnoise(w1 + vec2(0.0, 0.15)) - wa) / 0.15;
    slope += chop * 0.025 * near;
    // a wind roughens the sea: more chop, and it runs with the wind
    slope += chop * 0.05 * uWind.z * near;
    float calm = mix(0.3, 1.0, smoothstep(0.02, 0.4, wdepth));
    vec3 n = normalize(vec3(-slope.x * calm, 1.0, -slope.y * calm));
    vec3 r = reflect(rd, n);
    float fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
    float refl = skyTone(normalize(vec3(r.x, max(r.y, 0.02), r.z)));
    // the lagoon: shallow water is light over the sand, deep water sits in the middle
    float shallow = exp(-wdepth * 6.5);
    float body = mix(0.36, 0.72, shallow) * Li * mix(0.8, 1.0, day) * cloudShadow(p);
    // the sea stays a step darker than the sky it reflects, so the horizon holds
    tone = mix(body, refl * 0.8, fres * 0.85);
    // the swells' crests, a shade lighter: long, slow lines across the water
    float crest = smoothstep(0.55, 0.95, s1 * 0.6 + s2 * 0.4 + (wa - 0.5) * 0.5);
    tone += crest * 0.045 * smoothstep(30.0, 8.0, tSea) * Li;
    // glitter where the sun (or the moon) catches the swells: a path of sparks,
    // not a blot; clouds put it out
    float rl = max(dot(r, L), 0.0);
    float spark = smoothstep(0.6, 0.85, vnoise(p.xz * 26.0 + vec2(uTime * 0.7, -uTime * 0.5)));
    float spec = pow(rl, 900.0) + pow(rl, 60.0) * spark;
    tone += spec * mix(0.7, 1.2, day) * (1.0 - 0.75 * uCloud) * (1.0 - 0.85 * uRain);
    // surf: where the sea meets the shore, and the reef break further out
    float shore = smoothstep(0.045, 0.0, wdepth) * step(-0.0001, floorH + 0.3);
    float reefLine = smoothstep(0.03, 0.0, abs(wdepth - 0.16)) * smoothstep(0.0, 0.25, heightLite(p.xz) + 0.25);
    float foamNoise = vnoise(p.xz * 22.0 + vec2(uTime * 0.9, 0.0)) * 0.6 + vnoise(p.xz * 47.0 - uTime * 1.3) * 0.4;
    float pulse = 0.5 + 0.5 * sin(uTime * 1.6 - wdepth * 60.0);
    float foam = clamp(shore * (0.55 + 0.6 * foamNoise * pulse) + reefLine * smoothstep(0.45, 0.75, foamNoise) * 0.9, 0.0, 1.0);
    // the sea boils over new land coming up beneath it
    float boil = land(p.xz).b * smoothstep(0.3, 0.0, wdepth);
    foam = max(foam, boil * smoothstep(0.35, 0.7, vnoise(p.xz * 30.0 + vec2(0.0, uTime * 3.0))));
    // in a wind, whitecaps break on the swells
    float caps = uWind.z * smoothstep(0.74, 0.92, vnoise(p.xz * 15.0 - uWindOff * 8.0 + uTime * 0.5)) * smoothstep(0.5, 0.95, s1 * 0.6 + s2 * 0.4 + 0.3);
    foam = max(foam, caps * 0.65 * smoothstep(0.1, 0.4, wdepth));
    tone = mix(tone, 1.0, foam);
    // at night the surf glows: bioluminescence, in the only colour we have
    accent = smoothstep(0.35, 0.7, foam) * (1.0 - day);
    tone = mix(tone, skyTone(normalize(vec3(rd.x, 0.02, rd.z))), smoothstep(16.0, 45.0, tSea));
    tHit = tSea;
    mat = M_WATER;
  } else {
    tone = skyTone(rd) + stars(rd);
    mat = M_SKY;
  }

  // smoke and steam over new land, lit from below by the lava at night
  if (uVent[0].w + uVent[1].w + uVent[2].w + uVent[3].w > 0.01) {
    vec3 sm = traceSmoke(ro, rd, tHit, Lm);
    if (sm.x < 0.999) {
      float lightOn = mix(0.72, 1.0, day) * (1.0 - 0.2 * uRain);
      float glow = sm.z * (1.0 - 0.7 * day);
      tone = tone * sm.x + sm.y * lightOn + glow * 0.8;
      // only the dense, low heart of a plume glows in the accent
      accent = max(accent * step(0.5, sm.x), smoothstep(0.3, 0.5, glow));
      if (sm.x < 0.55) mat = M_SMOKE;
    }
  }

  // birds over everything but the smoke they fly behind: dark against a pale
  // sky, pale against the sea or the night, the way you actually see gulls.
  // Chosen by what's behind, not by its exact value, so a bird is never half and half.
  float bird = birds(frag, ro, mat == M_SKY ? 1e9 : tHit);
  if (bird > 0.5) {
    tone = (mat == M_SKY || mat == M_SMOKE) && day > 0.35 ? 0.0 : 1.0;
    mat = M_INK;
  }

  // the brush: a ring where your hand will push or pull the land
  if (uBrushOn > 0.001 && mat >= M_WATER && mat <= M_FOREST) {
    vec3 p = ro + rd * tHit;
    float dr = abs(length(p.xz - uBrush.xy) - uBrush.z);
    float ring = smoothstep(0.035, 0.0, dr) * uBrushOn;
    float press = abs(uBrush.w);
    tone = mix(tone, 1.0, ring * (0.6 - 0.3 * press));
    accent = max(accent, ring * press);
  }

  // rain: slanted streaks, a few print-dots long, falling at different speeds;
  // a wind leans them over
  if (uRain > 0.01) {
    float lean = 0.22 + uWindHead.z * uWind.z * 0.6;
    vec2 q = frag + vec2(frag.y * lean, 0.0);
    float col = floor(q.x / 2.0);
    float r = hash12(vec2(col, 3.7));
    float y = fract(frag.y / uRes.y * (1.6 + r) + uTime * (1.1 + r * 0.8) + r * 7.0);
    float streak = step(1.0 - uRain * 0.5, hash12(vec2(col, floor(frag.y / uRes.y * (1.6 + r) + uTime * (1.1 + r * 0.8) + r * 7.0))));
    streak *= smoothstep(0.0, 0.02, y) * (1.0 - smoothstep(0.02, 0.12, y));
    tone = mix(tone, tone * 0.5 + 0.48, streak * 0.85);
    tone *= 1.0 - 0.08 * uRain;
  }

  // the wind, drawn as the old charts draw it: fine lines of breath streaming
  // from the face that blows it, across sky and sea
  if (uWind.z > 0.02) {
    vec2 dir = uWindHead.zw;
    vec2 rel = frag - uWindHead.xy;
    float along = dot(rel, dir);
    float across = dot(rel, vec2(-dir.y, dir.x));
    // the breath fans out as it goes
    float spread = 10.0 + along * 0.35;
    if (along > 4.0 && abs(across) < spread) {
      float lane = across / spread * 7.0;
      float row = floor(lane);
      float h = hash12(vec2(row, 9.1));
      float inLane = smoothstep(0.9, 0.3, abs(fract(lane) - 0.5) * (spread / 7.0));
      float dash = smoothstep(0.55, 0.62, fract(along / (40.0 + 30.0 * h) - uTime * (1.1 + h) + h * 5.0));
      float fade = (1.0 - smoothstep(uRes.x * 0.25, uRes.x * 0.85, along)) * smoothstep(4.0, 14.0, along);
      float line = inLane * dash * fade * step(0.25, h) * uWind.z;
      if (line > 0.5) {
        tone = (mat == M_SKY || mat == M_SMOKE) && day > 0.35 ? 0.0 : 1.0;
        mat = M_INK;
      }
    }
  }

  // the opening: a veil of cloud the camera falls through
  if (uIntro < 1.0) {
    float veil = smoothstep(0.75, 0.15, uIntro);
    float c = fbm(frag / uRes.y * 3.0 + vec2(uTime * 0.05, uIntro * 6.0));
    float cl = smoothstep(0.35 - veil * 0.4, 0.75 - veil * 0.3, c);
    tone = mix(tone, 0.95, cl * veil * 1.2);
    if (cl * veil > 0.5) mat = M_SKY;
  }
  // lightning lights everything at once
  tone = mix(tone, 1.05, uFlash * (mat == M_SKY ? 0.9 : 0.5));

  // depth as log distance, so the print pass can find silhouettes by a relative jump
  float depth = clamp(log2(max(tHit, 0.2) / 0.2) / log2(tMax / 0.2), 0.0, 1.0);
  outData = vec4(clamp(tone, 0.0, 1.0), depth, (mat + 0.5) / 16.0, clamp(accent, 0.0, 1.0));
}
