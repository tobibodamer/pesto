import { CAN, LID_OPEN, LID_PEEK } from "../can/can";
import type { Ledge } from "../world/world";
import { GRAVITY, type Actor } from "./actor";
import { chance, clamp, easeInOut, easeOut, easeOutBack, lerp, pick, rand, sign, smooth, type Vec } from "./math";
import type { Pose } from "./pose";
import { Interrupted, tween, until, wait, type Routine } from "./routine";

/**
 * Everything Pesto can physically do, as routines over the actor. Each one
 * assumes nothing about why it was called and leaves him in a stable mode.
 */

const EDGE = 18;
const JUMP_REACH_X = 430;
const JUMP_REACH_UP = 250;

function arc(a: Actor, tx: number, ty: number, clearance = 46) {
  const g = GRAVITY * a.scale;
  const apex = Math.min(a.y, ty) - clearance * a.scale;
  const vy = -Math.sqrt(2 * g * (a.y - apex));
  const t = -vy / g + Math.sqrt((2 * (ty - apex)) / g);
  return { vx: (tx - a.x) / t, vy };
}

export function* walkTo(a: Actor, x: number, run?: boolean): Routine {
  a.need("ground");
  a.sitting = false;
  a.running = run ?? Math.abs(x - a.x) > 260 * a.scale;
  a.walkTarget = x;
  yield* until(() => a.walkTarget == null || a.mode !== "ground");
  a.need("ground");
}

/** Crouch, wiggle, leap. Sometimes he comes up short and has to haul himself over the edge. */
export function* jumpTo(a: Actor, tx: number, ledge: Ledge, opts: { sure?: boolean } = {}): Routine {
  a.need("ground");
  const dir = sign(tx - a.x);
  a.dir = dir;
  a.lookAt(tx, ledge.y - 50 * a.scale, 1.2);
  let t = 0;
  a.gesture = (p, dt) => {
    t += dt;
    p.squash += 0.27;
    p.facing = dir * 0.55;
    p.lean += Math.sin(t * 34) * 0.07;
    p.tailWag = 0.7;
    p.tailWagHz = 5.5;
    p.tailLift = 0.5;
    p.handLY += 8;
    p.handRY += 8;
  };
  yield* wait(0.36);
  a.gesture = null;
  a.need("ground");

  const up = a.y - ledge.y;
  if (!opts.sure && up > 60 * a.scale && chance(0.14)) {
    // Misjudged: he reaches the edge with his hands, not his feet.
    const hangY = ledge.y + 84 * a.scale;
    const v = arc(a, tx, hangY, 8);
    a.launch(v.vx, v.vy);
    yield* until(() => a.vy >= 0 || a.mode !== "air");
    a.need("air");
    a.x = tx;
    a.y = hangY;
    a.stick(9);
    a.gripLocked = true;
    a.feel("scared", 0.7);
    let k = 0;
    a.gesture = (p, dt) => {
      k += dt;
      p.handLX = -17;
      p.handLY = -88;
      p.handRX = 17;
      p.handRY = -88;
      p.footLX = -10 + Math.sin(k * 15) * 6;
      p.footRX = 10 - Math.sin(k * 15) * 6;
      p.footLY = 5;
      p.footRY = 5;
      p.squash = -0.1;
    };
    yield* wait(0.55);
    a.feel("strained", 0.7);
    yield* tween(0.42, (u) => (a.y = lerp(hangY, ledge.y, easeInOut(u))));
    a.gesture = null;
    a.place(ledge, tx);
    yield* wait(0.25);
    return;
  }

  const v = arc(a, tx, ledge.y, up > 0 ? 34 : 46);
  a.launch(v.vx, v.vy, ledge.id);
  yield* until(() => a.mode !== "air");
  a.need("ground");
}

/** Climbs across the glass to a point. Starts from a ledge or from the glass. */
export function* climbTo(a: Actor, x: number, y: number): Routine {
  a.need("ground", "glass");
  if (a.mode === "ground") {
    // A little hop to get all four paws onto the glass.
    const from = a.y;
    a.stick(99);
    a.gripLocked = true;
    yield* tween(0.16, (u) => (a.y = from - 14 * a.scale * easeOut(u)));
  }
  a.sliding = false;
  a.grip = 99;
  a.gripLocked = true;
  a.climbTarget = { x, y };
  yield* until(() => a.climbTarget == null || a.mode !== "glass");
  a.need("glass");
}

/** From the glass just under a ledge, pulls himself up onto it. */
export function* mount(a: Actor, ledge: Ledge): Routine {
  a.need("glass");
  const from = a.y;
  const x = clamp(a.x, ledge.x1 + EDGE, ledge.x2 - EDGE);
  a.gesture = (p) => {
    p.handLX = -22;
    p.handLY = -30;
    p.handRX = 22;
    p.handRY = -30;
    p.squash += 0.1;
  };
  yield* tween(0.4, (u) => {
    a.y = lerp(from, ledge.y, easeInOut(u));
    a.x = lerp(a.x, x, u);
  });
  a.gesture = null;
  a.place(ledge, x);
}

/**
 * Gets him to a spot on a ledge by whatever it takes: walking, jumping
 * between ledges, or climbing the glass when it is too far to jump.
 */
export function* travel(a: Actor, ledgeId: string, x: number): Routine {
  const s = a.scale;
  for (let hop = 0; hop < 8; hop++) {
    if (a.mode === "can" || a.mode === "emerge") yield* exitCan(a);
    if (a.mode === "air") yield* until(() => a.mode !== "air", 6);
    if (a.mode === "glass") {
      a.gripLocked = false;
      a.grip = 0;
      yield* until(() => a.mode === "ground", 10);
    }
    a.need("ground");
    const from = a.ledge;
    const to = a.world.ledge(ledgeId);
    if (!from || !to) throw new Interrupted("ledge is gone");
    if (from.id === to.id) {
      yield* walkTo(a, x);
      return;
    }

    const lo = Math.max(from.x1, to.x1) + EDGE;
    const hi = Math.min(from.x2, to.x2) - EDGE;
    let take: number;
    let land: number;
    if (lo < hi) {
      // One is above the other: cross where they overlap, as near the goal as possible.
      take = clamp(x, lo, hi);
      land = take;
    } else if (to.x1 >= from.x2 - EDGE) {
      take = from.x2 - EDGE;
      land = to.x1 + EDGE;
    } else {
      take = from.x1 + EDGE;
      land = to.x2 - EDGE;
    }
    const dy = to.y - from.y;
    const dx = Math.abs(land - take);

    if (dx <= JUMP_REACH_X * s && dy >= -JUMP_REACH_UP * s) {
      yield* walkTo(a, take);
      // Jumping straight up or down still needs a little sideways travel to read as a jump.
      if (dx < 30 * s) land = clamp(take + sign(x - take) * 46 * s, to.x1 + EDGE, to.x2 - EDGE);
      yield* jumpTo(a, land, to);
    } else if (Math.hypot(dx, dy) <= 1100 * s || from.hwnd == null) {
      yield* walkTo(a, take);
      if (dy < 0) {
        // The window may move while he climbs, so aim again until he is under its edge.
        for (let tries = 0; ; tries++) {
          const aim = a.world.ledge(ledgeId);
          if (!aim || tries > 4) throw new Interrupted("ledge moved away");
          const lx = clamp(land, aim.x1 + EDGE, aim.x2 - EDGE);
          yield* climbTo(a, lx, aim.y + 62 * s);
          const now = a.world.ledge(ledgeId);
          if (now && Math.abs(now.y - aim.y) < 6 && lx >= now.x1 && lx <= now.x2) {
            yield* mount(a, now);
            break;
          }
        }
      } else {
        yield* climbTo(a, land, to.y - 30 * s);
        a.place(to, land);
      }
    } else {
      // Too far across open glass: go down to the floor under the goal first.
      const floor = a.world.ledgeBelow(land, to.y + 10);
      if (!floor || floor.id === from.id) throw new Interrupted("no route");
      yield* travel(a, floor.id, land);
    }
  }
  throw new Interrupted("route too long");
}

/** Lid up, eyes, lid back, up and out. Ends standing beside the can. */
export function* exitCan(a: Actor, opts: { quick?: boolean } = {}): Routine {
  const can = a.can;
  const s = a.scale;
  if (a.mode === "can") {
    if (!opts.quick) {
      can.eyes = true;
      can.lid = LID_PEEK;
      yield* wait(rand(0.5, 1.0));
    }
    can.lid = LID_OPEN;
    can.shake(0.7);
    a.cue("lid");
    yield* wait(0.24);
    can.eyes = false;
    a.mode = "emerge";
    a.x = can.x;
    const rim = a.rimY;
    a.clipY = rim;
    const hidden = rim + 150 * s;
    const up = rim + 58 * s;
    a.y = hidden;
    a.puppet.snap();
    yield* tween(opts.quick ? 0.2 : 0.34, (u) => (a.y = lerp(hidden, up, easeOutBack(u))));
    if (!opts.quick) {
      a.look({ kind: "user" }, 0.6);
      yield* wait(0.4);
    }
  }
  a.need("emerge");
  const ledge = a.world.ledgeBelow(can.x, can.y - 4);
  if (!ledge) throw new Interrupted("can has no floor");
  // Hop out toward whichever side has more floor.
  const side = can.x - ledge.x1 > ledge.x2 - can.x ? -1 : 1;
  const tx = can.x + side * (CAN.topHalf * can.scale + 58 * s);
  const rim = a.rimY;
  const v = arc(a, tx, ledge.y, 70);
  a.launch(v.vx, v.vy, ledge.id);
  a.clipY = rim;
  while (a.mode === "air") {
    if (a.clipY != null && a.y < rim - 4) a.clipY = null;
    yield;
  }
  a.clipY = null;
  a.need("ground");
  can.lid = 0;
}

/** Goes home: travels to the can, jumps in, and the lid slams. */
export function* enterCan(a: Actor): Routine {
  if (a.mode === "can") return;
  const can = a.can;
  const s = a.scale;
  const ledge = a.world.ledgeBelow(can.x, can.y - 4);
  if (!ledge) throw new Interrupted("can has no floor");
  const side = a.x < can.x ? -1 : 1;
  const beside = clamp(can.x + side * (CAN.topHalf * can.scale + 62 * s), ledge.x1 + EDGE, ledge.x2 - EDGE);
  yield* travel(a, ledge.id, beside);
  a.need("ground");
  can.lid = LID_OPEN;
  a.cue("lid");
  a.lookAt(can.x, a.rimY, 1);
  yield* wait(0.3);

  const rim = a.rimY;
  const v = arc(a, can.x, rim + 30 * s, 60);
  a.launch(v.vx, v.vy, "~inside the can~");
  while (a.mode === "air") {
    if (a.vy > 0 && Math.abs(a.x - can.x) < CAN.topHalf * can.scale) a.clipY = rim;
    if (a.vy > 0 && a.y > rim + 110 * s) break;
    yield;
  }
  a.vanish();
  can.slam();
  can.shake(1);
  a.cue("clank");
}

// ───────────────────────── gestures ─────────────────────────

/** Points at a spot on screen, glancing between it and the person. */
/**
 * A gesture that points the arm on `side` at wherever `at` says, in world
 * pixels. The arm draws back, flings out, then jabs at the spot every so
 * often and wavers a little, the way a held-out arm does.
 */
export function pointing(a: Actor, side: number, at: () => Vec): (p: Pose, dt: number) => void {
  let t = 0;
  return (p, dt) => {
    t += dt;
    const target = at();
    const sx = side * 21;
    const sy = -56;
    const dx = (target.x - a.x) / a.scale - sx;
    const dy = (target.y - a.y) / a.scale - sy;
    const d = Math.hypot(dx, dy) || 1;
    const out = t < 0.14 ? lerp(0.4, 0.22, t / 0.14) : 1;
    const jab = t > 0.6 ? Math.sin(clamp(((t - 0.6) % 0.85) / 0.22, 0, 1) * Math.PI) * 5 : 0;
    const waver = Math.sin(t * 5.3) * 1.6;
    const reach = 44 * out + jab;
    const hx = sx + (dx / d) * reach - (dy / d) * waver;
    const hy = sy + (dy / d) * reach + (dx / d) * waver;
    if (side > 0) {
      p.handRX = hx;
      p.handRY = hy;
      p.pointR = 1;
    } else {
      p.handLX = hx;
      p.handLY = hy;
      p.pointL = 1;
    }
    p.lean += (dx / d) * (0.14 + jab * 0.008) * out;
    p.facing += side * 0.3;
  };
}

export function* pointAt(a: Actor, x: number, y: number, seconds = 2.4): Routine {
  const side = x >= a.x ? 1 : -1;
  a.dir = side;
  a.gesture = pointing(a, side, () => ({ x, y }));
  let left = seconds;
  while (left > 0) {
    a.lookAt(x, y, 1);
    yield* wait(Math.min(left, 0.9));
    a.look({ kind: "user" }, 1);
    yield* wait(Math.min(left, 0.6));
    left -= 1.5;
  }
  a.gesture = null;
}

/** Raps on the inside of the screen. */
export function* knock(a: Actor, times = 2): Routine {
  const BEAT = 0.26;
  const RAISE = 0.3;
  a.look({ kind: "user" }, times * BEAT + 1.6);
  let t = -RAISE;
  let last = -1;
  a.gesture = (p, dt) => {
    t += dt;
    const beat = Math.floor(t / BEAT);
    const u = (t % BEAT) / BEAT;
    const hit = t >= 0 && beat < times ? Math.sin(u * Math.PI) : 0;
    p.handRX = 26;
    p.handRY = -72 + hit * 4;
    p.squash += hit * 0.03;
    p.headX += hit * 1.5;
    p.tilt += 0.06;
    if (t >= 0 && beat !== last && beat < times) {
      last = beat;
      a.cue("knock");
    }
  };
  // The fist stays up for a moment while he waits to be noticed.
  yield* wait(RAISE + times * BEAT + 0.7);
  a.gesture = null;
}

export function* wave(a: Actor, seconds = 2.2): Routine {
  let t = 0;
  a.look({ kind: "user" }, seconds + 0.4);
  a.gesture = (p, dt) => {
    t += dt;
    // The arm comes up first, then the wave swings from the elbow and eases off.
    const swing = clamp((t - 0.22) / 0.2, 0, 1) * clamp((seconds - t) / 0.35, 0, 1);
    p.handRX = 37 + Math.sin(t * 10.5) * 8 * swing;
    p.handRY = -89 + Math.abs(Math.sin(t * 10.5)) * 3 * swing;
    p.tilt += 0.09;
    p.lean += 0.03;
    p.smile += 0.3;
  };
  yield* wait(seconds);
  a.gesture = null;
}

export function* shrug(a: Actor): Routine {
  yield* tween(1.5, (u) => {
    // Up quickly, held, then let go.
    const k = smooth(clamp(u / 0.22, 0, 1)) * smooth(clamp((1 - u) / 0.3, 0, 1));
    a.gesture = (p) => {
      p.handLX = lerp(p.handLX, -47, k);
      p.handLY = lerp(p.handLY, -54, k);
      p.handRX = lerp(p.handRX, 47, k);
      p.handRY = lerp(p.handRY, -54, k);
      p.headY += 3 * k;
      p.tilt += 0.13 * k;
      p.browRaise += 0.6 * k;
      p.smile -= 0.5 * k;
    };
  });
  a.gesture = null;
}

export function* nod(a: Actor, times = 1): Routine {
  let t = 0;
  a.gesture = (p, dt) => {
    t += dt;
    p.pitch += Math.max(0, Math.sin(t * 10.5)) * 0.5;
    p.lidL += 0.2;
    p.lidR += 0.2;
  };
  yield* wait(times * 0.6 + 0.15);
  a.gesture = null;
}

/** Rubs his paws together, eyes up and away: thinking. */
export function* ponder(a: Actor, seconds = 3): Routine {
  let t = 0;
  a.feel("thinking", seconds);
  a.gesture = (p, dt) => {
    t += dt;
    const r = Math.sin(t * 8) * 3.5;
    p.handLX = -5;
    p.handLY = -45 + r;
    p.handRX = 5;
    p.handRY = -45 - r;
  };
  yield* wait(seconds);
  a.gesture = null;
}

export function* clap(a: Actor, seconds = 1.9): Routine {
  let t = 0;
  let last = -1;
  a.feel("delighted", seconds + 0.4);
  a.gesture = (p, dt) => {
    t += dt;
    const open = Math.abs(Math.sin(t * 13)) * 9;
    p.handLX = -3 - open;
    p.handLY = -56;
    p.handRX = 3 + open;
    p.handRY = -56;
    p.squash += (1 - open / 9) * 0.03;
    const beat = Math.floor((t * 13) / Math.PI);
    if (beat !== last) {
      last = beat;
      a.cue("clap");
    }
  };
  yield* wait(seconds);
  a.gesture = null;
}

/** Collapses onto his back in theatrical despair. */
export function* flop(a: Actor, seconds = 3): Routine {
  a.need("ground");
  const dir = a.dir;
  let k = 0;
  a.feel("sad", seconds + 1);
  a.gesture = (p) => {
    p.spin = -dir * (Math.PI / 2) * k;
    p.lift = -9 * k;
    p.handLX = lerp(p.handLX, -8, k);
    p.handLY = lerp(p.handLY, -92, k);
    p.handRX = lerp(p.handRX, 36, k);
    p.handRY = lerp(p.handRY, -40, k);
    p.footLY = 2 * k;
    p.footRY = 5 * k;
    p.lidL = Math.max(p.lidL, k);
    p.lidR = Math.max(p.lidR, k);
    p.mouthOpen = 0.4 * k;
  };
  yield* tween(0.45, (u) => (k = easeOutBack(u, 1)));
  a.cue("thud");
  yield* wait(seconds);
  yield* tween(0.4, (u) => (k = 1 - easeInOut(u)));
  a.gesture = null;
}

/** Bobs and steps in time. `bpm` comes from the music when it is known. */
/** One beat's bounce: up on the beat, flat between. */
const pulse = (beat: number) => Math.max(0, Math.sin(beat * Math.PI * 2));
/** Side to side, one way per beat. */
const sway = (beat: number) => Math.sin(beat * Math.PI);

/**
 * A dance step: `pose` gets the beats since the step began, and `side`, the
 * way he happens to favour this time, -1 or 1.
 */
interface DanceStep {
  beats: number;
  pose: (p: Pose, beat: number, side: number) => void;
}

const DANCE: DanceStep[] = [
  // Fists pumping in turn while he rocks.
  {
    beats: 4,
    pose: (p, b) => {
      const up = Math.sin(b * Math.PI * 2);
      p.squash += pulse(b) * 0.09;
      p.pitch += pulse(b) * 0.28;
      p.lean += sway(b) * 0.1;
      p.handLX = -30 - sway(b) * 6;
      p.handLY = -52 + up * 8;
      p.handRX = 30 - sway(b) * 6;
      p.handRY = -52 - up * 8;
      p.footLY = -Math.max(0, sway(b)) * 6;
      p.footRY = -Math.max(0, -sway(b)) * 6;
    },
  },
  // Raising the roof.
  {
    beats: 4,
    pose: (p, b) => {
      const k = pulse(b);
      p.handLX = -44 - k * 2;
      p.handLY = -78 - k * 9;
      p.handRX = 44 + k * 2;
      p.handRY = -78 - k * 9;
      p.pitch -= 0.24 - k * 0.12;
      p.squash += 0.1 - k * 0.17;
      p.lift += k * 4;
      p.lean += sway(b) * 0.05;
      p.mouthOpen = 0.6;
    },
  },
  // One arm to the sky and a hand on his hip, swapping sides every two beats.
  {
    beats: 4,
    pose: (p, b, side) => {
      const to = Math.floor(b / 2) % 2 ? -side : side;
      const k = pulse(b);
      const sky = { x: to * 48, y: -90 - k * 5 };
      const hip = { x: -to * 27, y: -38 + k * 2 };
      const [l, r] = to > 0 ? [hip, sky] : [sky, hip];
      p.handLX = l.x;
      p.handLY = l.y;
      p.handRX = r.x;
      p.handRY = r.y;
      if (to > 0) p.pointR = 1;
      else p.pointL = 1;
      p.lean -= to * 0.09;
      p.facing = to * 0.28;
      p.yaw += to * 0.35;
      p.pitch -= 0.12;
      p.squash += k * 0.07;
      if (to > 0) p.footLY = -k * 5;
      else p.footRY = -k * 5;
    },
  },
  // The twist: hips one way, arms the other, low on his feet.
  {
    beats: 4,
    pose: (p, b) => {
      const turn = sway(b);
      p.facing = turn * 0.75;
      p.yaw -= turn * 0.25;
      p.squash += 0.06 + Math.abs(turn) * 0.05;
      p.lean += turn * 0.05;
      p.handLX = -24 + turn * 12;
      p.handLY = -46 - turn * 7;
      p.handRX = 24 + turn * 12;
      p.handRY = -46 + turn * 7;
      p.footLX = -17 + turn * 3;
      p.footRX = 17 + turn * 3;
    },
  },
  // Side-on, shaking his tail at you over his shoulder.
  {
    beats: 4,
    pose: (p, b, side) => {
      p.facing = side * 0.85;
      p.lean += side * 0.15;
      p.yaw = -side * 0.75;
      p.handLX = side * 12 - 9;
      p.handLY = -34 + pulse(b) * 3;
      p.handRX = side * 12 + 9;
      p.handRY = -34 + pulse(b + 0.5) * 3;
      p.squash += 0.07 + pulse(b) * 0.05;
      p.tailLift = 0.95;
      p.tailWag = 0.95;
      p.tailWagHz *= 2;
      p.lidL += 0.25;
      p.lidR += 0.25;
      p.smirk = 1;
    },
  },
  // Two star jumps.
  {
    beats: 2,
    pose: (p, b) => {
      const air = Math.sin((b % 1) * Math.PI);
      p.lift += air * 15;
      p.squash += lerp(0.16, -0.12, air);
      p.handLX = lerp(-30, -50, air);
      p.handLY = lerp(-36, -78, air);
      p.handRX = lerp(30, 50, air);
      p.handRY = lerp(-36, -78, air);
      p.footLX = -17 - air * 8;
      p.footRX = 17 + air * 8;
      p.footLY = -air * 4;
      p.footRY = -air * 4;
      p.mouthOpen = 0.3 + air * 0.5;
    },
  },
  // Stepping side to side, both arms swinging across.
  {
    beats: 4,
    pose: (p, b) => {
      const to = sway(b);
      p.lean += to * 0.15;
      p.tilt += to * 0.08;
      p.headX += to * 3;
      p.squash += pulse(b) * 0.07;
      p.handLX = -30 + to * 16;
      p.handLY = -50 - Math.abs(to) * 10;
      p.handRX = 30 + to * 16;
      p.handRY = -50 - Math.abs(to) * 10;
      p.footLX = -17 + to * 5;
      p.footRX = 17 + to * 5;
      p.footLY = -Math.max(0, -to) * 5;
      p.footRY = -Math.max(0, to) * 5;
    },
  },
];

/** Strings dance steps together on the beat, never the same one twice running, and ends on a flourish. */
export function* dance(a: Actor, seconds = 6, bpm = 112): Routine {
  a.need("ground");
  a.feel("happy", seconds);
  const FLOURISH = 0.55;
  let t = 0;
  let step = DANCE[0];
  let began = 0;
  let side = chance(0.5) ? 1 : -1;
  a.gesture = (p, dt) => {
    t += dt;
    const beat = (t * bpm) / 60;
    if (beat - began >= step.beats) {
      began += step.beats;
      const last = step;
      step = pick(DANCE.filter((other) => other !== last));
      side = chance(0.5) ? 1 : -1;
    }
    p.tailLift = 0.6;
    p.tailWag = 0.5;
    p.tailWagHz = bpm / 60;
    if (seconds - t < FLOURISH) {
      // Arms flung wide, chin up.
      const k = smooth(clamp((t - (seconds - FLOURISH)) / 0.14, 0, 1));
      p.handLX = lerp(p.handLX, -50, k);
      p.handLY = lerp(p.handLY, -80, k);
      p.handRX = lerp(p.handRX, 50, k);
      p.handRY = lerp(p.handRY, -80, k);
      p.pitch -= 0.22 * k;
      p.mouthOpen = 0.7 * k;
      p.squash -= 0.06 * k;
    } else {
      step.pose(p, beat - began, side);
    }
  };
  yield* wait(seconds);
  a.gesture = null;
}

/** A little jump of fright, fur on end. */
export function* startle(a: Actor): Routine {
  a.feel("scared", 1.3);
  if (a.mode === "ground") {
    a.sitting = false;
    const ledge = a.ledge;
    a.launch(0, -430 * a.scale, ledge?.id ?? null);
    yield* until(() => a.mode !== "air", 3);
  } else {
    yield* wait(0.6);
  }
}

/** Bats at the cursor. */
export function* swat(a: Actor): Routine {
  const c = a.world.cursor;
  const s = a.scale;
  const side = c.x >= a.x ? 1 : -1;
  a.feel("annoyed", 1.6);
  a.look({ kind: "cursor" }, 1.4);
  for (let i = 0; i < 2; i++) {
    yield* tween(0.42, (u) => {
      // Draw back, lash out fast, come back slowly.
      const k = u < 0.3 ? -0.25 * Math.sin((u / 0.3) * Math.PI) : Math.sin(Math.pow((u - 0.3) / 0.7, 0.55) * Math.PI);
      a.gesture = (p) => {
        const tx = clamp((c.x - a.x) / s, -60, 60);
        const ty = clamp((c.y - a.y) / s, -120, -10);
        if (side > 0) {
          p.handRX = lerp(34, tx, k);
          p.handRY = lerp(-70, ty, k);
        } else {
          p.handLX = lerp(-34, tx, k);
          p.handLY = lerp(-70, ty, k);
        }
        p.lean += side * 0.1 * k;
      };
    });
    a.cue("swat");
  }
  a.gesture = null;
}

export function* yawn(a: Actor): Routine {
  yield* tween(2.8, (u) => {
    // It builds slowly, holds at full stretch, and collapses.
    const k = smooth(clamp(u / 0.45, 0, 1)) * smooth(clamp((1 - u) / 0.25, 0, 1));
    a.gesture = (p) => {
      p.mouthOpen = Math.max(p.mouthOpen, k);
      p.mouthW = lerp(p.mouthW, 0.8, k);
      p.lidL = Math.max(p.lidL, k * 1.2);
      p.lidR = Math.max(p.lidR, k * 1.2);
      p.pitch -= 0.3 * k;
      p.handLX = lerp(p.handLX, -36, k);
      p.handLY = lerp(p.handLY, -86, k);
      p.handRX = lerp(p.handRX, 36, k);
      p.handRY = lerp(p.handRY, -86, k);
      p.squash -= 0.08 * k;
    };
  });
  a.gesture = null;
}

/** Leans in and sniffs at something beside him. */
export function* sniff(a: Actor, x: number, y: number, seconds = 2.2): Routine {
  const side = x >= a.x ? 1 : -1;
  let t = 0;
  a.lookAt(x, y, seconds);
  a.feel("curious", seconds);
  a.gesture = (p, dt) => {
    t += dt;
    // Lean in, then sniff in short bursts with a pause between them.
    const lean = smooth(clamp(t / 0.35, 0, 1));
    const burst = Math.sin(t * 2.6 * Math.PI) > -0.2 ? 1 : 0;
    p.lean += side * 0.2 * lean;
    p.facing += side * 0.4 * lean;
    p.headX += side * 5 * lean + Math.sin(t * 30) * 0.9 * burst;
    p.headY += Math.sin(t * 30) * 0.9 * burst;
  };
  yield* wait(seconds);
  a.gesture = null;
}

/** Sits on the edge with his legs dangling. */
export function* sit(a: Actor, seconds: number): Routine {
  a.need("ground");
  a.sitting = true;
  yield* until(() => a.mode !== "ground" || !a.sitting, seconds);
  a.sitting = false;
}

/** Holds up a cardboard sign. */
export function* holdSign(a: Actor, text: string, seconds = 4): Routine {
  a.look({ kind: "user" }, seconds);
  let k = 0;
  a.puppet.held = { hand: "R", draw: (ctx, grip) => drawSign(ctx, grip.x, grip.y, text, k) };
  a.gesture = (p) => {
    p.handRX = 31;
    p.handRY = lerp(-34, -62, k);
  };
  try {
    yield* tween(0.3, (u) => (k = easeOutBack(u)));
    yield* wait(seconds);
    yield* tween(0.2, (u) => (k = 1 - u));
  } finally {
    a.puppet.held = null;
    a.gesture = null;
  }
}

function drawSign(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, k: number) {
  if (k < 0.05) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(0.07);
  ctx.scale(1, Math.min(1, k));
  ctx.lineJoin = "round";
  // Stick.
  ctx.beginPath();
  ctx.rect(-2.6, -70, 5.2, 84);
  ctx.fillStyle = "#a9794a";
  ctx.fill();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = "#3b2a18";
  ctx.stroke();
  // Board, sized to the text.
  ctx.font = "700 21px 'Comic Sans MS', 'Segoe Print', cursive";
  const w = Math.max(58, ctx.measureText(text).width + 22);
  ctx.beginPath();
  ctx.moveTo(-w / 2, -108);
  ctx.lineTo(w / 2 - 3, -110);
  ctx.lineTo(w / 2, -70);
  ctx.lineTo(-w / 2 + 2, -68);
  ctx.closePath();
  ctx.fillStyle = "#c9a26b";
  ctx.fill();
  ctx.lineWidth = 2.6;
  ctx.stroke();
  ctx.fillStyle = "#2d1f10";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, -88);
  ctx.restore();
}

/** How far above his feet his hands are while he hangs from an edge, in character units. */
const HANG_REACH = 84;

/**
 * An edge he could catch with his hands from where he is: one spanning his
 * position, from `above` over his hands to `below` under them.
 */
export function edgeToHang(a: Actor, above = 70, below = 40): Ledge | null {
  const hands = a.y - HANG_REACH * a.scale;
  let best: Ledge | null = null;
  for (const l of a.world.ledges) {
    if (a.x < l.x1 + 12 || a.x > l.x2 - 12) continue;
    const d = l.y - hands;
    if (d < -above * a.scale || d > below * a.scale) continue;
    if (!best || Math.abs(d) < Math.abs(best.y - hands)) best = l;
  }
  return best;
}

/** Catches an edge with both hands and hangs there, legs kicking, then pulls himself up or lets go. */
export function* hangFrom(a: Actor, ledge: Ledge): Routine {
  const s = a.scale;
  const x = clamp(a.x, ledge.x1 + 14, ledge.x2 - 14);
  const fromY = a.y;
  const hangY = ledge.y + HANG_REACH * s;
  a.stick(9);
  a.gripLocked = true;
  a.feel("surprised", 0.6);
  const relaxed = a.mood === "sleepy";
  let k = 0;
  a.gesture = (p, dt) => {
    k += dt;
    const kick = relaxed ? Math.sin(k * 3) * 3 : Math.sin(k * 13) * 6;
    p.handLX = -17;
    p.handLY = -88;
    p.handRX = 17;
    p.handRY = -88;
    p.footLX = -10 + kick;
    p.footRX = 10 - kick;
    p.footLY = 5;
    p.footRY = 5;
    p.squash = -0.1;
  };
  yield* tween(0.14, (u) => {
    a.x = lerp(a.x, x, u);
    a.y = lerp(fromY, hangY, easeOut(u));
  });
  const gone = () => a.world.ledge(ledge.id) == null;
  const hang = relaxed ? rand(4, 8) : rand(1.2, 3.5);
  yield* until(gone, hang * 0.5);
  if (!gone() && chance(0.6)) a.look({ kind: "user" }, 1.2);
  yield* until(gone, hang * 0.5);

  const edge = a.world.ledge(ledge.id);
  if (edge && chance(relaxed ? 0.5 : 0.75)) {
    a.feel("strained", 0.8);
    yield* tween(0.45, (u) => (a.y = lerp(hangY, edge.y, easeInOut(u))));
    a.gesture = null;
    a.place(edge, a.x);
    yield* wait(0.25);
    return;
  }
  // Lets go.
  a.gesture = null;
  a.gripLocked = false;
  a.feel(edge ? "unsure" : "scared", 0.8);
  a.launch(0, 0);
}
