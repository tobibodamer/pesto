/**
 * A pose is a flat bag of numbers describing Pesto at one instant.
 * Units are character units: he is about 150 tall, origin between his feet,
 * y grows downward. L and R always mean screen-left and screen-right.
 */
export interface Pose {
  /** Body turn. -1 is full profile left, 0 faces the viewer, 1 is profile right. */
  facing: number;
  /** Whole-body rotation around the feet, radians, positive leans right. */
  lean: number;
  /** Positive squashes him down and wide, negative stretches him tall. */
  squash: number;
  /** Lifts the hips off the ground (jumping, hanging). */
  lift: number;
  /** Whole-figure rotation around the body centre, for tumbling and lying down. */
  spin: number;

  headX: number;
  headY: number;
  /** Head roll, radians. */
  tilt: number;
  /** Head turn, -1..1. Moves the face across the skull. */
  yaw: number;
  /** Head nod, -1 looks up, 1 looks down. */
  pitch: number;

  gazeX: number;
  gazeY: number;
  /** Pupil size multiplier. */
  pupil: number;
  /** Upper lids, 0 open, 1 closed. */
  lidL: number;
  lidR: number;
  /** Lower lids pushing up, as in a smile or a squint. */
  lowL: number;
  lowR: number;
  /** -1 angry (inner ends down), 1 worried (inner ends up). */
  brow: number;
  /** Lifts the whole brow, widening the eyes. */
  browRaise: number;
  /** When the eyes are shut: 1 draws happy arcs, 0 draws sleepy ones. */
  eyeSmile: number;

  /** Ear rotation offsets. Negative pricks forward, positive flattens. */
  earL: number;
  earR: number;

  mouthOpen: number;
  /** -1 frown, 1 grin. */
  smile: number;
  /** Mouth width multiplier; below 1 purses into an "o". */
  mouthW: number;
  /** Hitches one corner of a smile up. 1 lifts the right corner, -1 the left. */
  smirk: number;
  tongue: number;

  /** Hand positions relative to the hips. */
  handLX: number;
  handLY: number;
  handRX: number;
  handRY: number;
  /** 0 is a mitten, 1 extends a pointing finger. */
  pointL: number;
  pointR: number;
  /** 0 keeps the arm in front of the head, 1 tucks it behind the body. */
  armBackL: number;
  armBackR: number;

  footLX: number;
  footLY: number;
  footRX: number;
  footRY: number;

  /** Tail base elevation: 0 trails flat along the ground, 1 points straight up. */
  tailLift: number;
  /** How much each segment bends upward from the last. */
  tailCurl: number;
  tailWag: number;
  tailWagHz: number;
  /** Puffs the fur out. */
  bristle: number;

  /** Sweat drops, 0..1. */
  sweat: number;
  /** Blush on the cheeks, 0..1. */
  blush: number;
}

export const REST: Pose = {
  facing: 0,
  lean: 0,
  squash: 0,
  lift: 0,
  spin: 0,
  headX: 0,
  headY: 0,
  tilt: 0,
  yaw: 0,
  pitch: 0,
  gazeX: 0,
  gazeY: 0,
  pupil: 1,
  lidL: 0.13,
  lidR: 0.09,
  lowL: 0,
  lowR: 0,
  brow: -0.16,
  browRaise: 0,
  eyeSmile: 0,
  earL: 0,
  earR: 0,
  mouthOpen: 0,
  smile: 0.55,
  mouthW: 1,
  smirk: 0.6,
  tongue: 0,
  handLX: -31,
  handLY: -29,
  handRX: 31,
  handRY: -29,
  pointL: 0,
  pointR: 0,
  armBackL: 0,
  armBackR: 0,
  footLX: -17,
  footLY: 0,
  footRX: 17,
  footRY: 0,
  tailLift: 0.3,
  tailCurl: 0.15,
  tailWag: 0.07,
  tailWagHz: 0.4,
  bristle: 0,
  sweat: 0,
  blush: 0,
};

export type PoseKey = keyof Pose;
export const POSE_KEYS = Object.keys(REST) as PoseKey[];
export type PartialPose = Partial<Pose>;

export function clonePose(p: Pose): Pose {
  return { ...p };
}

export function applyPose(target: Pose, patch: PartialPose, weight = 1): Pose {
  for (const k in patch) {
    const key = k as PoseKey;
    const v = patch[key]!;
    target[key] = weight >= 1 ? v : target[key] + (v - target[key]) * weight;
  }
  return target;
}

/** Adds `patch` on top of what is already there. */
export function addPose(target: Pose, patch: PartialPose, weight = 1): Pose {
  for (const k in patch) {
    const key = k as PoseKey;
    target[key] += patch[key]! * weight;
  }
  return target;
}

export const EMOTIONS = {
  neutral: {},
  curious: { pupil: 1.18, brow: 0.1, lidL: 0.04, lidR: 0.04, browRaise: 0.45, earL: -0.16, earR: -0.16, mouthOpen: 0.12, smile: 0.25, tailLift: 0.4, tailWag: 0.12, tailWagHz: 1.1 },
  happy: { smile: 1, smirk: 0, brow: 0, mouthOpen: 0.55, lowL: 0.38, lowR: 0.38, pupil: 1.12, earL: -0.08, earR: -0.08, tailLift: 0.55, tailWag: 0.5, tailWagHz: 2.4 },
  delighted: { smile: 1, smirk: 0, mouthOpen: 0.85, lidL: 1, lidR: 1, eyeSmile: 1, earL: -0.1, earR: -0.1, tailLift: 0.7, tailWag: 0.7, tailWagHz: 3.2, blush: 0.6 },
  smug: { lidL: 0.48, lidR: 0.36, lowL: 0.25, lowR: 0.25, brow: -0.3, smile: 0.9, smirk: 1, mouthW: 0.85, pupil: 0.95, tailLift: 0.5, tailWag: 0.2, tailWagHz: 0.9 },
  proud: { smirk: 0, pitch: -0.35, lidL: 1, lidR: 1, eyeSmile: 1, smile: 0.95, mouthOpen: 0.1, earL: -0.1, earR: -0.1, tailLift: 0.85, tailCurl: 0.05, tailWag: 0.15, tailWagHz: 1.2 },
  grumpy: { lidL: 0.42, lidR: 0.42, brow: -1, smile: -0.75, pupil: 0.82, earL: 0.45, earR: 0.45, tailLift: 0.05, tailWag: 0.3, tailWagHz: 3.5 },
  glare: { lidL: 0.5, lidR: 0.5, lowL: 0.2, lowR: 0.2, brow: -1, smile: -0.5, pupil: 0.7, earL: 0.3, earR: 0.3, tailLift: 0.1, tailWag: 0.25, tailWagHz: 4 },
  surprised: { brow: 0.15, browRaise: 1, pupil: 0.72, mouthOpen: 0.6, mouthW: 0.55, smile: 0, lidL: 0, lidR: 0, earL: -0.3, earR: -0.3, bristle: 0.6, tailLift: 0.8, tailCurl: 0.02 },
  scared: { browRaise: 0.8, brow: 0.9, pupil: 0.6, mouthOpen: 0.45, mouthW: 0.8, smile: -0.5, lidL: 0, lidR: 0, earL: 0.9, earR: 0.9, bristle: 1, tailLift: 0.3, tailCurl: 0.25 },
  sad: { brow: 1, lidL: 0.3, lidR: 0.3, smile: -0.7, pupil: 1.15, pitch: 0.3, earL: 0.75, earR: 0.75, tailLift: -0.05, tailCurl: 0.02, tailWag: 0 },
  sleepy: { lidL: 0.62, lidR: 0.68, smile: 0.05, pupil: 0.95, earL: 0.35, earR: 0.4, pitch: 0.15, tailLift: 0, tailCurl: 0.08, tailWag: 0 },
  asleep: { lidL: 1, lidR: 1, eyeSmile: 0, smile: 0.2, earL: 0.5, earR: 0.5, pitch: 0.4, tailLift: 0, tailCurl: 0.2, tailWag: 0 },
  pleased: { smirk: 0, lidL: 1, lidR: 1, eyeSmile: 1, smile: 0.9, earL: 0.25, earR: 0.25, blush: 0.8, tailLift: 0.45, tailWag: 0.35, tailWagHz: 1.6 },
  focused: { brow: -0.45, lidL: 0.22, lidR: 0.22, smile: 0.1, tongue: 1, pupil: 0.9, earL: -0.12, earR: -0.12, tailLift: 0.35, tailWag: 0.1, tailWagHz: 1.8 },
  thinking: { gazeX: 0.7, gazeY: -0.8, brow: 0.2, browRaise: 0.3, lidL: 0.12, lidR: 0.2, smile: -0.05, mouthW: 0.7, tilt: 0.1, tailLift: 0.4, tailWag: 0.2, tailWagHz: 0.8 },
  unsure: { brow: 0.75, browRaise: 0.25, smile: -0.2, mouthW: 0.8, earL: 0.25, earR: 0.4, tilt: -0.08, tailLift: 0.15, tailWag: 0.1 },
  guilty: { smirk: 0, brow: 0.95, lidL: 0.15, lidR: 0.15, smile: 0.5, mouthOpen: 0.25, mouthW: 1.15, earL: 0.85, earR: 0.85, pitch: 0.2, sweat: 0.7, tailLift: -0.05, tailCurl: 0.3 },
  dizzy: { lidL: 0.3, lidR: 0.5, brow: 0.5, smile: -0.2, mouthOpen: 0.3, mouthW: 0.8, earL: 0.5, earR: 0.3, tailLift: 0, tailWag: 0 },
  strained: { brow: -0.7, lidL: 0.3, lidR: 0.3, lowL: 0.45, lowR: 0.45, smile: -0.4, mouthOpen: 0.35, mouthW: 1.2, earL: 0.5, earR: 0.5, sweat: 1, bristle: 0.25, tailLift: 0.3 },
  annoyed: { lidL: 0.48, lidR: 0.48, brow: -0.55, smile: -0.45, earL: 0.55, earR: 0.55, pupil: 0.9, tailLift: 0.1, tailWag: 0.35, tailWagHz: 3 },
} satisfies Record<string, PartialPose>;

export type Emotion = keyof typeof EMOTIONS;
export const EMOTION_NAMES = Object.keys(EMOTIONS) as Emotion[];
