import { drawJunk, type Junk, type Litter } from "../stage/litter";
import type { Actor } from "./actor";
import { clamp, easeOut, lerp, smooth, type Vec } from "./math";
import { tween, until, wait, type Routine } from "./routine";

/**
 * Showing exactly which thing he means: a finger on it, the tip of his bent
 * straw on it, or a paper ball off it. All of these work on a ledge and
 * while he clings to the glass.
 */

const SHOULDER = { x: 21, y: -56 };
/** From his palm to the tip of a pointing finger, in units. */
const FINGER = 11;
/** How far from the shoulder a pointing hand gets; the arm is all but straight there, so the finger lies along the reach. */
const ARM = 42;
/** How far from the shoulder the hand holding the straw gets. */
const GRIP = 31;
const STRAW = { shaft: 86, tip: 16, bend: 0.55, butt: 14 };
/** The straw's tip is at most this far from the hand that holds it. */
const HOLD_MOST = 90;

/** The furthest from his shoulder he can put a fingertip, and the tip of the straw, in units. */
export const FINGER_REACH = ARM + FINGER;
export const STRAW_REACH = GRIP + HOLD_MOST - 3;

/** The way to a spot from the shoulder on `side`, by default the one nearer to it, in units. */
function toward(a: Actor, x: number, y: number, side = x >= a.x ? 1 : -1) {
  const dx = (x - a.x) / a.scale - side * SHOULDER.x;
  const dy = (y - a.y) / a.scale - SHOULDER.y;
  return { side, dx, dy, d: Math.hypot(dx, dy) || 1 };
}

/** How far a spot is from the shoulder he would reach for it with, in units. */
export function reachTo(a: Actor, x: number, y: number) {
  return toward(a, x, y).d;
}

/** Whether he can touch a spot from where he is, with a finger or the straw. */
export function within(a: Actor, x: number, y: number) {
  return (a.mode === "ground" || a.mode === "glass") && reachTo(a, x, y) <= STRAW_REACH;
}

function drawStraw(ctx: CanvasRenderingContext2D, grip: Vec, target: Vec, hold: number, side: number) {
  const along = Math.atan2(target.y - grip.y, target.x - grip.x);
  const tip = { x: grip.x + Math.cos(along) * hold, y: grip.y + Math.sin(along) * hold };
  // The short end hooks down from the joint; the shaft runs back from there through his hand.
  const hook = along - side * STRAW.bend;
  const joint = { x: tip.x - Math.cos(hook) * STRAW.tip, y: tip.y - Math.sin(hook) * STRAW.tip };
  const back = Math.atan2(grip.y - joint.y, grip.x - joint.x);
  const length = Math.min(STRAW.shaft, Math.hypot(grip.x - joint.x, grip.y - joint.y) + STRAW.butt);
  const end = { x: joint.x + Math.cos(back) * length, y: joint.y + Math.sin(back) * length };
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(joint.x, joint.y);
    ctx.lineTo(tip.x, tip.y);
  };
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";
  trace();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#2b2a2c";
  ctx.stroke();
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = "#f6f1e7";
  ctx.stroke();
  ctx.setLineDash([2.6, 5.2]);
  ctx.strokeStyle = "#d8493f";
  ctx.stroke();
  // The concertina.
  ctx.setLineDash([]);
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = "#2b2a2c";
  ctx.beginPath();
  for (const d of [3.5, 6, 8.5]) {
    const x = joint.x + Math.cos(back) * d;
    const y = joint.y + Math.sin(back) * d;
    ctx.moveTo(x - Math.sin(back) * 3, y + Math.cos(back) * 3);
    ctx.lineTo(x + Math.sin(back) * 3, y - Math.cos(back) * 3);
  }
  ctx.stroke();
  ctx.restore();
}

/** How far off the spot the fingertip or straw hovers between taps, in units. */
const HOVER = 11;
const TAP = 0.28;
/** Before a push his hand comes back this much further, then goes this far past the glass, in units. */
const DRAW_BACK = 16;
const PRESS_IN = 4;

/**
 * Puts a fingertip on a spot, or the tip of his straw when his arm is too
 * short, taps it `taps` times and keeps it there for `hold` seconds, looking
 * between the spot and the person. `at` is asked every frame, so the spot may
 * move. He has to be within reach already. With `press` he pushes it once
 * instead, drawing back first and leaning his weight in.
 */
export function* indicate(
  a: Actor,
  at: () => Vec | null,
  opts: { taps?: number; press?: boolean; hold?: number; onTouch?: (spot: Vec) => void } = {},
): Routine {
  let spot = at();
  if (!spot) return;
  const first = toward(a, spot.x, spot.y);
  const side = first.side;
  const straw = first.d > FINGER_REACH;
  // Where along the straw he grips it is settled once, so that tapping moves the whole straw.
  const hold = clamp(first.d - 24, 30, HOLD_MOST);
  const clinging = a.mode === "glass";
  if (clinging) a.gripLocked = true;
  else a.dir = side;

  let raised = 0;
  let off = HOVER;
  /** How far into a push he is: below zero while he draws back for it. */
  let pushed = 0;
  a.gesture = (p) => {
    spot = at() ?? spot!;
    const v = toward(a, spot.x, spot.y, side);
    const d = v.d;
    const r = straw ? clamp(d - hold - off, 12, GRIP) : clamp(d - FINGER - off, 8, ARM);
    const hx = side * SHOULDER.x + (v.dx / d) * r;
    const hy = SHOULDER.y + (v.dy / d) * r;
    if (side > 0) {
      p.handRX = lerp(p.handRX, hx, raised);
      p.handRY = lerp(p.handRY, hy, raised);
      if (!straw) p.pointR = raised;
    } else {
      p.handLX = lerp(p.handLX, hx, raised);
      p.handLY = lerp(p.handLY, hy, raised);
      if (!straw) p.pointL = raised;
    }
    if (!clinging) {
      p.lean += (v.dx / d) * (0.1 * raised + 0.2 * pushed);
      p.facing += side * 0.28 * raised;
      p.squash += 0.05 * Math.max(0, pushed);
    }
  };
  if (straw) {
    a.puppet.held = {
      hand: side > 0 ? "R" : "L",
      draw: (ctx, grip) => {
        if (raised > 0.3) drawStraw(ctx, grip, { x: (spot!.x - a.x) / a.scale, y: (spot!.y - a.y) / a.scale }, hold, side);
      },
    };
  }

  try {
    a.lookAt(spot.x, spot.y, 2);
    yield* tween(0.24, (u) => (raised = smooth(u)));
    const taps = opts.taps ?? 0;
    for (let i = 0; i < taps; i++) {
      let touched = false;
      yield* tween(TAP, (u) => {
        // Pressed a little past the glass, so the tap lands however his arm lags.
        off = HOVER - Math.sin(u * Math.PI) * (HOVER + 3);
        if (u >= 0.5 && !touched) {
          touched = true;
          if (i === 0) a.cue("knock");
          opts.onTouch?.(spot!);
        }
      });
    }
    if (opts.press) {
      yield* tween(0.16, (u) => {
        off = HOVER + DRAW_BACK * smooth(u);
        pushed = -0.5 * smooth(u);
      });
      yield* tween(0.08, (u) => {
        off = lerp(HOVER + DRAW_BACK, -PRESS_IN, easeOut(u));
        pushed = lerp(-0.5, 1, easeOut(u));
      });
      // His arm trails the pose by about this much, so it counts as pressed when the hand is seen to land.
      yield* wait(0.08);
      a.cue("press");
      opts.onTouch?.(spot);
      yield* wait(0.16);
      yield* tween(0.14, (u) => (pushed = 1 - smooth(u)));
    }
    const from = off;
    yield* tween(0.12, (u) => (off = from * (1 - smooth(u))));
    if (taps === 0 && !opts.press) opts.onTouch?.(spot);
    // He checks that they saw, then looks at it again himself.
    for (let left = opts.hold ?? 1; left > 0; left -= 1.7) {
      a.look({ kind: "user" }, 1);
      yield* wait(Math.min(left, 0.9));
      a.lookAt(spot.x, spot.y, 1);
      yield* wait(clamp(left - 0.9, 0, 0.8));
    }
    yield* tween(0.18, (u) => (raised = 1 - smooth(u)));
  } finally {
    a.puppet.held = null;
    a.gesture = null;
    // Holding on for this took most of his grip.
    if (a.mode === "glass") a.grip = 1.4;
  }
}

/**
 * Winds up and throws a crumpled paper ball that bounces off the glass
 * exactly at a spot, from wherever he is standing. `onHit` is called as it
 * strikes.
 */
export function* throwBall(a: Actor, litter: Litter, x: number, y: number, onHit?: () => void): Routine<Junk | null> {
  const side = x >= a.x ? 1 : -1;
  if (a.mode === "ground") a.dir = side;
  const from = { x: side * 48, y: -72 };
  let wind = 0;
  let fling = 0;
  a.lookAt(x, y, 2);
  a.puppet.held = {
    hand: side > 0 ? "R" : "L",
    draw: (ctx, grip) => {
      ctx.save();
      ctx.translate(grip.x + side * 3, grip.y - 3);
      ctx.scale(0.8, 0.8);
      drawJunk(ctx, "paper");
      ctx.restore();
    },
  };
  a.gesture = (p) => {
    // Back over his shoulder, then out past his nose.
    const hx = lerp(lerp(side * 30, side * 4, wind), from.x, fling);
    const hy = lerp(lerp(-40, -82, wind), from.y, fling);
    if (side > 0) {
      p.handRX = hx;
      p.handRY = hy;
    } else {
      p.handLX = hx;
      p.handLY = hy;
    }
    p.lean += side * (-0.17 * wind * (1 - fling) + 0.24 * fling);
    p.squash += 0.06 * wind * (1 - fling);
    p.facing += side * 0.3;
  };
  try {
    yield* tween(0.34, (u) => (wind = easeOut(u)));
    yield* wait(0.1);
    yield* tween(0.09, (u) => (fling = u));
    a.puppet.held = null;
    const hand = a.toWorld(from);
    const ball = litter.throwAt(hand.x, hand.y, x, y);
    a.cue("swat");
    yield* until(() => {
      a.lookAt(ball.x, ball.y, 0.4);
      return !ball.aim;
    }, 1.5);
    onHit?.();
    yield* tween(0.3, (u) => {
      fling = 1 - smooth(u);
      wind = fling;
    });
    a.look({ kind: "user" }, 1.2);
    yield* wait(0.5);
    return ball;
  } finally {
    a.puppet.held = null;
    a.gesture = null;
  }
}
