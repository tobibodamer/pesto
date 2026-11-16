import { approach, chance, noise } from "./math";
import type { Pose } from "./pose";

/** What he can hear of the person right now. */
export interface Hearing {
  /** Loudness of their voice, 0..1. */
  level: number;
  /** Whether they are speaking at this moment. */
  speaking: boolean;
}

/** Seconds of quiet after which a pause in their speech earns a nod. */
const PAUSE = 0.38;

/**
 * The pose of being spoken to: head tilted, ears forward, eyes wide. His ears
 * follow the voice and he nods when the person pauses. With `jolt` it opens
 * on the start of hearing his name: he shoots up tall, ears and fur on end,
 * before settling into the tilt.
 */
export function listening(hearing: () => Hearing, jolt: boolean): (p: Pose, dt: number) => void {
  const side = chance(0.5) ? 1 : -1;
  let t = 0;
  let level = 0;
  let spokeFor = 0;
  let quiet = 0;
  let nod = Infinity;
  return (p, dt) => {
    t += dt;
    const h = hearing();
    level = approach(level, h.level, h.level > level ? 30 : 7, dt);
    if (h.speaking) {
      spokeFor += dt;
      quiet = 0;
    } else {
      if (quiet < PAUSE && quiet + dt >= PAUSE && spokeFor > 0.7) nod = 0;
      quiet += dt;
      if (quiet > PAUSE) spokeFor = 0;
    }
    nod += dt;

    const shock = jolt ? Math.exp(-t * 5.5) : 0;
    const settled = 1 - (jolt ? Math.exp(-t * 3.2) : Math.exp(-t * 8));

    p.squash -= shock * 0.13;
    p.bristle += shock * 0.55;
    p.headY -= shock * 5 + level * 1.6;
    p.tilt += side * (0.15 + noise(t * 0.3, 3) * 0.02) * settled;

    // Both ears come forward; the one on the high side of the tilt flicks with the voice.
    const forward = 0.2 * settled + shock * 0.45 + level * 0.1;
    const flick = level * 0.14 * Math.max(0, noise(t * 9, 7));
    p.earL -= forward + (side < 0 ? flick : 0);
    p.earR -= forward + (side > 0 ? flick : 0);

    p.browRaise += 0.25 * settled + shock * 0.7 + level * 0.12;
    p.lidL = Math.min(p.lidL, 0.04);
    p.lidR = Math.min(p.lidR, 0.04);
    p.pupil *= 1 + 0.12 * settled - shock * 0.3 + level * 0.06;

    if (nod < 0.5) {
      const dip = Math.sin((nod / 0.5) * Math.PI);
      p.pitch += dip * 0.3;
      p.lidL += dip * 0.25;
      p.lidR += dip * 0.25;
    }
  };
}
