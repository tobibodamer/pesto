export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => clamp01((v - a) / (b - a));
export const remap = (v: number, a: number, b: number, c: number, d: number) => lerp(c, d, invLerp(a, b, v));
export const smooth = (t: number) => t * t * (3 - 2 * t);
export const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
export const easeIn = (t: number) => t * t;
export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));
/** Overshoots past 1 and settles, for snappy cartoon arrivals. */
export const easeOutBack = (t: number, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
export const sign = (v: number) => (v < 0 ? -1 : 1);
let rngState = (Date.now() ^ 0x9e3779b9) >>> 0;
/** Reseeds every random choice Pesto makes, so a run can be replayed exactly. */
export function seed(value: number) {
  rngState = value >>> 0;
}
/** Uniform 0..1 from the seedable generator. Use this, never Math.random. */
export function random(): number {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export const rand = (lo: number, hi: number) => lo + random() * (hi - lo);
export const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
export const chance = (p: number) => random() < p;

export interface Vec {
  x: number;
  y: number;
}

export const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);

/** Frame-rate independent exponential approach. `rate` is roughly 1/seconds-to-settle. */
export const approach = (current: number, target: number, rate: number, dt: number) =>
  target + (current - target) * Math.exp(-rate * dt);

/** A damped spring on a single value. */
export class Spring {
  v = 0;
  constructor(
    public x: number,
    /** Angular frequency: higher is faster. */
    public freq = 14,
    /** 1 is critically damped, below 1 overshoots. */
    public damping = 0.8,
  ) {}

  step(target: number, dt: number): number {
    // Semi-implicit Euler is stable for the step sizes a frame can produce
    // only if the step is bounded, so long frames are subdivided.
    let remaining = Math.min(dt, 0.1);
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 120);
      const a = this.freq * this.freq * (target - this.x) - 2 * this.damping * this.freq * this.v;
      this.v += a * h;
      this.x += this.v * h;
      remaining -= h;
    }
    return this.x;
  }

  snap(value: number) {
    this.x = value;
    this.v = 0;
  }
}

/** Cheap smooth 1D noise in -1..1, for organic drift. */
export function noise(t: number, seed = 0): number {
  const s = seed * 17.13;
  return (
    Math.sin(t * 1.0 + s) * 0.5 +
    Math.sin(t * 2.31 + s * 1.7 + 1.3) * 0.3 +
    Math.sin(t * 4.17 + s * 0.6 + 4.1) * 0.2
  );
}

/**
 * Two-bone IK. Returns the elbow position for a limb from `a` to `b` with
 * segment lengths `l1`, `l2`, bending toward `bend` (+1 or -1).
 */
export function elbow(ax: number, ay: number, bx: number, by: number, l1: number, l2: number, bend: number): Vec {
  let dx = bx - ax;
  let dy = by - ay;
  let d = Math.hypot(dx, dy) || 0.0001;
  const max = l1 + l2 - 0.01;
  if (d > max) {
    dx *= max / d;
    dy *= max / d;
    d = max;
  }
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const mx = ax + (dx * a) / d;
  const my = ay + (dy * a) / d;
  return { x: mx - (dy / d) * h * bend, y: my + (dx / d) * h * bend };
}
