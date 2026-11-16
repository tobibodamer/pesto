import { approach, chance, noise } from "./math";
import type { Pose } from "./pose";

/** What he can hear of the person right now. */
export interface Hearing {
  /** Loudness of their voice, 0..1. */
  level: number;
  /** Whether they are speaking at this moment. */
  speaking: boolean;
}

/** Small movements he can make without leaving the listening pose. */
export const LISTEN_MOVES = ["nod", "shake", "lean", "recoil", "puzzle"] as const;
export type ListenMove = (typeof LISTEN_MOVES)[number];

export interface ListenPose {
  (p: Pose, dt: number): void;
  /** Plays one of the small movements on top of the pose. */
  react(move: ListenMove): void;
}

/** Seconds of quiet after which a pause in their speech earns a nod. */
const PAUSE = 0.38;
const LENGTH: Record<ListenMove, number> = { nod: 0.5, shake: 0.8, lean: 2.6, recoil: 1.3, puzzle: 0 };

/**
 * The pose of being spoken to: head tilted, ears forward, eyes wide. His ears
 * follow the voice and he nods when the person pauses. With `jolt` it opens
 * on the start of hearing his name: he shoots up tall, ears and fur on end,
 * before settling into the tilt.
 */
export function listening(hearing: () => Hearing, jolt: boolean): ListenPose {
  let side = chance(0.5) ? 1 : -1;
  let tilt = 0;
  let t = 0;
  let level = 0;
  let spokeFor = 0;
  let quiet = 0;
  let move: ListenMove | null = null;
  let moved = 0;

  const pose = (p: Pose, dt: number) => {
    t += dt;
    const h = hearing();
    level = approach(level, h.level, h.level > level ? 30 : 7, dt);
    if (h.speaking) {
      spokeFor += dt;
      quiet = 0;
    } else {
      if (quiet < PAUSE && quiet + dt >= PAUSE && spokeFor > 0.7 && !move) pose.react("nod");
      quiet += dt;
      if (quiet > PAUSE) spokeFor = 0;
    }

    const shock = jolt ? Math.exp(-t * 5.5) : 0;
    const settled = 1 - (jolt ? Math.exp(-t * 3.2) : Math.exp(-t * 8));
    tilt = approach(tilt, side * settled, 7, dt);

    p.squash -= shock * 0.13;
    p.bristle += shock * 0.55;
    p.headY -= shock * 5 + level * 1.6;
    p.tilt += tilt * (0.15 + noise(t * 0.3, 3) * 0.02);

    // Both ears come forward; the one on the high side of the tilt flicks with the voice.
    const forward = 0.2 * settled + shock * 0.45 + level * 0.1;
    const flick = level * 0.14 * Math.max(0, noise(t * 9, 7));
    p.earL -= forward + (side < 0 ? flick : 0);
    p.earR -= forward + (side > 0 ? flick : 0);

    p.browRaise += 0.25 * settled + shock * 0.7 + level * 0.12;
    // Eyes wide, unless the face he is pulling has a lid shape of its own.
    if (p.lidL < 0.2) p.lidL = Math.min(p.lidL, 0.04);
    if (p.lidR < 0.2) p.lidR = Math.min(p.lidR, 0.04);
    p.pupil *= 1 + 0.12 * settled - shock * 0.3 + level * 0.06;

    if (!move) return;
    moved += dt;
    const u = moved / LENGTH[move];
    if (u >= 1) {
      move = null;
      return;
    }
    // Rises and falls once over the length of the move.
    const swell = Math.sin(u * Math.PI);
    switch (move) {
      case "nod":
        p.pitch += swell * 0.3;
        p.lidL += swell * 0.25;
        p.lidR += swell * 0.25;
        break;
      case "shake":
        p.yaw += Math.sin(u * Math.PI * 4) * 0.32 * swell;
        p.lidL += swell * 0.2;
        p.lidR += swell * 0.2;
        break;
      case "lean": {
        const held = Math.min(1, swell * 2.5);
        p.squash += held * 0.05;
        p.headY += held * 3;
        p.earL -= held * 0.15;
        p.earR -= held * 0.15;
        p.pupil *= 1 + held * 0.12;
        p.browRaise += held * 0.2;
        break;
      }
      case "recoil": {
        const held = Math.min(1, swell * 3);
        p.squash -= held * 0.07;
        p.headY -= held * 4;
        p.lean -= side * held * 0.05;
        p.earL += held * 0.5;
        p.earR += held * 0.5;
        break;
      }
    }
  };

  pose.react = (next: ListenMove) => {
    // A puzzled head goes over to the other side and stays there.
    if (next === "puzzle") side = -side;
    else {
      move = next;
      moved = 0;
    }
  };
  return pose;
}
