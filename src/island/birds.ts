// Seabirds. They come once there's forest to nest in, wheel over the island
// on the wind — a few wingbeats, a long glide — and go out to sea at night.
// The shader draws each one as a little inked "M", the way engravers did.

export const MAX_BIRDS = 16;

interface Bird {
  cx: number; // the point it circles
  cz: number;
  r: number; // circle radius
  a: number; // angle on the circle
  speed: number; // world units per second
  y: number;
  phase: number;
  flap: number; // wingbeat phase
  beating: number; // seconds of flapping left; then it glides
  out: number; // 0 = home over the island, 1 = far out at sea
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Birds {
  private birds: Bird[] = [];
  private packed = new Float32Array(MAX_BIRDS * 4);

  get count() {
    return this.birds.length;
  }

  /** wanted: how many the island can hold now; home: where the land is; day: 0..1 */
  step(dt: number, t: number, wanted: number, home: [number, number], day: number) {
    while (this.birds.length < Math.min(MAX_BIRDS, wanted)) {
      this.birds.push({
        cx: home[0] + rnd(-0.8, 0.8),
        cz: home[1] + rnd(-0.8, 0.8),
        r: rnd(1.2, 3.4),
        a: rnd(0, Math.PI * 2),
        speed: rnd(0.55, 0.85) * (Math.random() < 0.5 ? -1 : 1),
        y: rnd(0.9, 2.1),
        phase: rnd(0, 10),
        flap: rnd(0, 6),
        beating: rnd(0, 1),
        out: 1, // they arrive from the sea
      });
    }
    for (const b of this.birds) {
      // drift the circle towards the island as it changes
      b.cx += (home[0] - b.cx) * dt * 0.05;
      b.cz += (home[1] - b.cz) * dt * 0.05;
      b.a += (b.speed / b.r) * dt;
      // home by day, out to sea by night
      const want = day > 0.3 ? 0 : 1;
      b.out += (want - b.out) * dt * 0.12;
      b.beating -= dt;
      if (b.beating > 0) b.flap += dt * 13;
      else if (b.beating < -rnd(1.5, 4)) b.beating = rnd(0.4, 1.2);
    }
    this.packed.fill(0);
    this.birds.forEach((b, i) => {
      const r = b.r * (1 + b.out * 5);
      const x = b.cx + Math.cos(b.a) * r;
      const z = b.cz + Math.sin(b.a) * r;
      const y = b.y + Math.sin(t * 0.4 + b.phase) * 0.25 + b.out * 0.6;
      // wings: beating, or held in a shallow glide
      const w = b.beating > 0 ? Math.sin(b.flap) : 0.35 + Math.sin(t * 0.9 + b.phase) * 0.08;
      this.packed.set([x, y, z, w + (b.out > 0.97 ? 10 : 0)], i * 4);
    });
    return this.packed;
  }
}
