// One Euro filter (Casiez et al. 2012): smooths jittery tracking without
// adding lag when you move fast. Low speed → heavy smoothing; high speed →
// light smoothing. The right default for anything driven by a webcam.

function alpha(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  private x: number | null = null;
  private dx = 0;

  constructor(
    private minCutoff = 1.2,
    private beta = 0.02,
    private dCutoff = 1.0,
  ) {}

  reset() {
    this.x = null;
    this.dx = 0;
  }

  filter(value: number, dt: number): number {
    if (this.x === null || dt <= 0) {
      this.x = value;
      return value;
    }
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** Filters a fixed-length vector component-wise. */
export class OneEuroVec {
  private fs: OneEuro[];
  constructor(n: number, minCutoff?: number, beta?: number) {
    this.fs = Array.from({ length: n }, () => new OneEuro(minCutoff, beta));
  }
  reset() {
    this.fs.forEach((f) => f.reset());
  }
  filter(v: ArrayLike<number>, dt: number): number[] {
    return this.fs.map((f, i) => f.filter(v[i], dt));
  }
}
