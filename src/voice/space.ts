import type { Hrirs } from "./hrir";

const FADE = 0.06;

/** Early bounces, as offsets in degrees from where he is: the desk under him and the screen to either side. */
const BOUNCES = [
  { az: 0, el: -25, ms: 1.7, hz: 5000, gain: 0.16 },
  { az: -13, el: 0, ms: 2.9, hz: 6000, gain: 0.13 },
  { az: 11, el: -12, ms: 4.3, hz: 4200, gain: 0.11 },
];

/** One arrival of the sound from a direction that can change: two convolvers taking turns through a crossfade. */
class Arrival {
  private slots: { conv: ConvolverNode; gain: GainNode }[] = [];
  private active = 0;
  private index = -1;
  private fadingUntil = 0;

  constructor(
    private ctx: BaseAudioContext,
    private hrirs: Hrirs,
    input: AudioNode,
    output: AudioNode,
  ) {
    for (let i = 0; i < 2; i++) {
      const conv = ctx.createConvolver();
      conv.normalize = false;
      const gain = ctx.createGain();
      gain.gain.value = i === 0 ? 1 : 0;
      input.connect(conv).connect(gain).connect(output);
      this.slots.push({ conv, gain });
    }
  }

  aim(azimuth: number, elevation: number) {
    const t = this.ctx.currentTime;
    const index = this.hrirs.nearest(azimuth, elevation);
    if (index === this.index || t < this.fadingUntil) return;
    if (this.index < 0) {
      this.slots[this.active].conv.buffer = this.hrirs.buffer(index);
    } else {
      const from = this.slots[this.active];
      this.active = 1 - this.active;
      const to = this.slots[this.active];
      to.conv.buffer = this.hrirs.buffer(index);
      from.gain.gain.setValueAtTime(1, t);
      from.gain.gain.linearRampToValueAtTime(0, t + FADE);
      to.gain.gain.setValueAtTime(0, t);
      to.gain.gain.linearRampToValueAtTime(1, t + FADE);
      this.fadingUntil = t + FADE + 0.01;
    }
    this.index = index;
  }
}

/**
 * Places a mono sound in front of the listener as heard over headphones.
 *
 * The direct sound is convolved with the measured dummy-head response for
 * its direction. A few faint, very early bounces follow it from right
 * around him (the desk below, the screen surface beside him) and a barely
 * audible tail: enough for the ear to believe a real thing is there, all of
 * it arriving from where he is, so he sits on the screen instead of
 * somewhere in the listener's room. A second colour, for when he is inside
 * the can, dulls it and adds the ring of a small metal bin.
 */
export class Spatializer {
  readonly input: GainNode;

  private direct: Arrival;
  private bounces: { arrival: Arrival; az: number; el: number }[] = [];
  private lowpass: BiquadFilterNode;
  private boom: BiquadFilterNode;
  private ring: GainNode;
  private distance: GainNode;
  private muffled = false;

  constructor(
    private ctx: BaseAudioContext,
    hrirs: Hrirs,
    output: AudioNode,
  ) {
    this.input = ctx.createGain();

    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = "lowpass";
    this.lowpass.frequency.value = 20000;
    this.lowpass.Q.value = 0.5;
    this.boom = ctx.createBiquadFilter();
    this.boom.type = "peaking";
    this.boom.frequency.value = 410;
    this.boom.Q.value = 2.2;
    this.boom.gain.value = 0;
    this.distance = ctx.createGain();
    this.input.connect(this.lowpass).connect(this.boom).connect(this.distance);

    this.ring = ctx.createGain();
    this.ring.gain.value = 0;
    const can = ctx.createConvolver();
    can.normalize = false;
    can.buffer = canRing(ctx);
    this.boom.connect(can).connect(this.ring).connect(this.distance);

    this.direct = new Arrival(ctx, hrirs, this.distance, output);

    for (const b of BOUNCES) {
      const delay = ctx.createDelay(0.02);
      delay.delayTime.value = b.ms / 1000;
      const dull = ctx.createBiquadFilter();
      dull.type = "lowpass";
      dull.frequency.value = b.hz;
      const gain = ctx.createGain();
      gain.gain.value = b.gain;
      this.distance.connect(delay).connect(dull).connect(gain);
      this.bounces.push({ arrival: new Arrival(ctx, hrirs, gain, output), az: b.az, el: b.el });
    }

    const tail = ctx.createConvolver();
    tail.normalize = false;
    tail.buffer = roomTail(ctx);
    const tailGain = ctx.createGain();
    tailGain.gain.value = 0.1;
    this.distance.connect(tail).connect(tailGain).connect(output);

    this.aim(0, 0, 0.7, false);
  }

  /** Azimuth and elevation in degrees (right and up positive), distance in metres. */
  aim(azimuth: number, elevation: number, metres: number, muffled: boolean) {
    const t = this.ctx.currentTime;
    this.direct.aim(azimuth, elevation);
    for (const b of this.bounces) b.arrival.aim(azimuth + b.az, elevation + b.el);

    // Level falls off gently: he is small and near, and should stay intelligible on the far monitor.
    this.distance.gain.setTargetAtTime(Math.min(1.15, Math.pow(0.7 / Math.max(0.35, metres), 0.6)), t, 0.08);

    if (muffled !== this.muffled) {
      this.muffled = muffled;
      this.lowpass.frequency.setTargetAtTime(muffled ? 950 : 20000, t, 0.05);
      this.boom.gain.setTargetAtTime(muffled ? 8 : 0, t, 0.05);
      this.ring.gain.setTargetAtTime(muffled ? 0.55 : 0, t, 0.05);
    }
  }
}

/** A very short, dull, decorrelated tail: the air around a desk, not a room. */
function roomTail(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.12);
  const start = Math.floor(sr * 0.012);
  const buf = ctx.createBuffer(2, length, sr);
  for (let ch = 0; ch < 2; ch++) {
    const out = buf.getChannelData(ch);
    let seed = ch ? 0x9e3779b9 : 0x85ebca6b;
    let low = 0;
    for (let i = start; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      low += ((seed / 2147483648) - low) * 0.35;
      const t = (i - start) / sr;
      out[i] = low * Math.exp(-t * 60) * 0.045;
    }
  }
  return buf;
}

/** The ring of a small metal bin: two tight families of echoes that die in a tenth of a second. */
function canRing(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.12);
  const buf = ctx.createBuffer(1, length, sr);
  const out = buf.getChannelData(0);
  for (const [period, gain] of [
    [0.0029, 0.5],
    [0.0043, 0.38],
  ]) {
    let sign = 1;
    for (let t = period; t < 0.115; t += period) {
      out[Math.floor(t * sr)] += sign * gain * Math.exp(-t * 42);
      sign = -sign;
    }
  }
  return buf;
}

/** Where a point on the screens is, as seen from the chair. Pixels in, degrees and metres out. */
export function seenFromChair(point: { x: number; y: number }, primary: { x: number; y: number; w: number; h: number } | null) {
  const screen = primary ?? { x: 0, y: 0, w: 1920, h: 1080 };
  // A 24-inch monitor at arm's length; other sizes scale with it closely enough.
  const metresPerPixel = 0.53 / screen.w;
  const away = 0.65;
  const dx = (point.x - (screen.x + screen.w / 2)) * metresPerPixel;
  const dy = (screen.y + screen.h * 0.4 - point.y) * metresPerPixel;
  // Heard angles are pulled in from the seen ones: over headphones the true angle sounds wider than the screen looks.
  const narrow = 0.62;
  return {
    azimuth: ((Math.atan2(dx, away) * 180) / Math.PI) * narrow,
    elevation: ((Math.atan2(dy, Math.hypot(dx, away)) * 180) / Math.PI) * narrow,
    metres: Math.hypot(dx, dy, away),
  };
}
