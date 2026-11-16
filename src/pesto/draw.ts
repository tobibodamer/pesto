import { clamp, clamp01, lerp, smooth, type Vec } from "./math";
import type { Pose } from "./pose";

export const COLORS = {
  outline: "#252020",
  fur: "#8b8784",
  cream: "#ece6dd",
  mask: "#332c2c",
  paw: "#443b3a",
  earIn: "#4a403f",
  nose: "#1b1717",
  mouth: "#5c2632",
  tongue: "#ee8a98",
  tailDark: "#3a3232",
  tailLight: "#a6a19d",
  white: "#fffdf9",
  pupil: "#15100f",
  shut: "#d3cbc3",
  blush: "#f08d8d",
  sweat: "#bfe6ff",
};

/**
 * Line width in character units. Lines are inked twice, the second pass
 * slipped toward the shadow side, so they swell there like a brush stroke.
 */
export const OUTLINE = 2;
const INK_X = 0.9;
const INK_Y = 1.3;
const INNER = 1.7;
/** One translucent wash for every shadow, so it works over any fur colour. */
const SHADE = "rgba(28, 22, 26, 0.16)";
/** How far a shadow falls from what casts it: the light sits up and to the left. */
const CAST_X = 2.4;
const CAST_Y = 3.4;

const HEAD = 0.95;
const ARM_UPPER = 17;
const ARM_LOWER = 17;
const ARM_SHOULDER = 15;
const ARM_WRIST = 8.4;
const LEG_HIP = 18;
const LEG_ANKLE = 12.5;
/** Height of the ankle joint above the sole. */
const ANKLE = 6;
const EYE_X = 18;
const EYE_Y = -31;

export type Hat = "nightcap" | "bottlecap" | null;

export interface DrawInput {
  pose: Pose;
  /** Tail centreline from base to tip, in the same space as the pose. */
  tail: Vec[];
  time: number;
  hat?: Hat;
  /** Draws whatever he is holding, called with the context at each hand. */
  held?: { hand: "L" | "R" | "both"; draw: (ctx: CanvasRenderingContext2D, grip: Grip) => void } | null;
  /** Draw only the eyes, for when he sits in the dark. */
  eyesOnly?: boolean;
  arms: ArmLayers;
}

/**
 * Where each arm sits in the stack, left then right, each 0 to 1 so an arm
 * can fade from one layer to the next instead of jumping.
 */
export interface ArmLayers {
  /** 0 behind his torso, 1 in front of it. */
  front: [number, number];
  /** 1 when the arm crosses in front of his face, 0 when his head covers it. */
  overFace: [number, number];
}

/**
 * Where a pose would like each arm to be, as signed margins: above zero wants
 * the arm in front of his torso, or across his face. Whoever animates him
 * turns these into `ArmLayers` over time.
 */
export function armWants(p: Pose): ArmLayers {
  const farSide = p.facing >= 0 ? 1 : -1;
  const turned = Math.abs(p.facing) - 0.3;
  // His head, roughly: an ellipse around the middle of his face.
  const hx = 58 * Math.sin(p.lean) + p.headX;
  const hy = -8 - 58 * Math.cos(p.lean) * (1 - p.squash) + p.headY - 32 * HEAD;
  const side = (s: number, x: number, y: number, back: number): [number, number] => {
    // The far arm goes behind him once he has turned, as long as it just hangs.
    const hangs = (y + 40) / 30;
    const behind = Math.max(back - 0.5, s === farSide ? Math.min(turned, hangs) : -1);
    const reach = Math.hypot((x - hx) / (50 * HEAD), (y - hy) / (37 * HEAD));
    return [-behind, 1.36 - reach];
  };
  const l = side(-1, p.handLX, p.handLY, p.armBackL);
  const r = side(1, p.handRX, p.handRY, p.armBackR);
  return { front: [l[0], r[0]], overFace: [l[1], r[1]] };
}

export interface Grip {
  x: number;
  y: number;
  /** Second hand when held with both. */
  x2: number;
  y2: number;
}

/** Points on Pesto that other systems want, filled in by `drawPesto`. */
export interface Anchors {
  head: Vec;
  handL: Vec;
  handR: Vec;
  mouth: Vec;
  top: Vec;
}

type Ctx = CanvasRenderingContext2D;

/**
 * Inks around a shape that is filled afterwards. Shapes inked this way before
 * any of them is filled merge into one silhouette, with no line between them.
 */
function inkAround(ctx: Ctx, trace: () => void) {
  ctx.strokeStyle = COLORS.outline;
  ctx.lineWidth = OUTLINE * 2;
  trace();
  ctx.stroke();
  ctx.save();
  ctx.translate(INK_X, INK_Y);
  trace();
  ctx.stroke();
  ctx.restore();
}

/** The heavy half of an ink line. Draw it before the shape's fill, which hides its lit side. */
function inkUnder(ctx: Ctx, trace: () => void, width = OUTLINE) {
  ctx.save();
  ctx.translate(INK_X, INK_Y);
  trace();
  ctx.lineWidth = width;
  ctx.strokeStyle = COLORS.outline;
  ctx.stroke();
  ctx.restore();
}

function inkOver(ctx: Ctx, trace: () => void, width = OUTLINE) {
  trace();
  ctx.lineWidth = width;
  ctx.strokeStyle = COLORS.outline;
  ctx.stroke();
}

/** A filled shape with an ink outline. */
function inked(ctx: Ctx, trace: () => void, fill: string, width = OUTLINE) {
  inkUnder(ctx, trace, width);
  trace();
  ctx.fillStyle = fill;
  ctx.fill();
  inkOver(ctx, trace, width);
}

/** Fills a line of varying weight: `at` traces it over 0..1, `half` is half its width there. */
function brush(ctx: Ctx, at: (t: number) => Vec, half: (t: number) => number, steps = 14) {
  const spine: Vec[] = [];
  for (let i = 0; i <= steps; i++) spine.push(at(i / steps));
  const near: Vec[] = [];
  const far: Vec[] = [];
  spine.forEach((pt, i) => {
    const a = spine[Math.max(i - 1, 0)];
    const b = spine[Math.min(i + 1, steps)];
    const w = half(i / steps) / (Math.hypot(b.x - a.x, b.y - a.y) || 1);
    const nx = (b.y - a.y) * w;
    const ny = (a.x - b.x) * w;
    near.push({ x: pt.x + nx, y: pt.y + ny });
    far.push({ x: pt.x - nx, y: pt.y - ny });
  });
  ctx.beginPath();
  near.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
  for (let i = steps; i >= 0; i--) ctx.lineTo(far[i].x, far[i].y);
  ctx.closePath();
  ctx.fill();
}

function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, Math.PI * 2);
}

/**
 * Darkens everything outside an ellipse. Called inside a clip, what stays
 * dark is the rim of the clipped shape that turns away from the light.
 */
function shadeAround(ctx: Ctx, x: number, y: number, rx: number, ry: number, rot = 0) {
  ctx.beginPath();
  ctx.rect(x - 500, y - 500, 1000, 1000);
  ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, Math.PI * 2);
  ctx.fillStyle = SHADE;
  ctx.fill("evenodd");
}

let scratch: Ctx | null = null;

/** A cleared canvas the size of `like`'s, sharing its transform and line style. */
function scratchLayer(like: Ctx): Ctx {
  scratch ??= document.createElement("canvas").getContext("2d")!;
  const { width, height } = like.canvas;
  if (scratch.canvas.width !== width || scratch.canvas.height !== height) {
    scratch.canvas.width = width;
    scratch.canvas.height = height;
  }
  scratch.resetTransform();
  scratch.clearRect(0, 0, width, height);
  scratch.setTransform(like.getTransform());
  scratch.lineJoin = like.lineJoin;
  scratch.lineCap = like.lineCap;
  return scratch;
}

export function drawPesto(target: Ctx, input: DrawInput): Anchors {
  /** What is being painted on: the caller's canvas, or a scratch layer while a part fades in. */
  let ctx = target;
  const p = input.pose;
  const f = clamp(p.facing, -1, 1);
  const af = Math.abs(f);
  const sq = clamp(p.squash, -0.5, 0.6);
  const sx = 1 + sq * 0.55;
  const sy = 1 - sq;
  const cosL = Math.cos(p.lean);
  const sinL = Math.sin(p.lean);
  const PIVOT = -8;

  /** Body-local point to figure space: squash, then lean around the hips. */
  const B = (x: number, y: number): Vec => {
    const qx = x * sx;
    const qy = y * sy - PIVOT;
    return { x: qx * cosL - qy * sinL, y: qx * sinL + qy * cosL + PIVOT };
  };
  const curveB = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    const a = B(x1, y1);
    const b = B(x2, y2);
    const c = B(x, y);
    ctx.bezierCurveTo(a.x, a.y, b.x, b.y, c.x, c.y);
  };

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.translate(0, -p.lift);
  if (p.spin !== 0) {
    ctx.translate(0, -45);
    ctx.rotate(p.spin);
    ctx.translate(0, 45);
  }

  const neck = B(0, -66);
  const headRot = p.lean * 0.6 + p.tilt;
  const hx = neck.x + p.headX;
  const hy = neck.y + p.headY;
  const cosH = Math.cos(headRot);
  const sinH = Math.sin(headRot);
  const headPt = (x: number, y: number): Vec => ({
    x: hx + (x * cosH - y * sinH) * HEAD,
    y: hy + (x * sinH + y * cosH) * HEAD,
  });
  const inHead = (draw: () => void) => {
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(headRot);
    ctx.scale(HEAD, HEAD);
    draw();
    ctx.restore();
  };

  const anchors: Anchors = {
    head: headPt(0, -32),
    handL: { x: p.handLX, y: p.handLY },
    handR: { x: p.handRX, y: p.handRY },
    mouth: headPt(p.yaw * 14.5, -14),
    top: headPt(0, -70),
  };

  if (input.eyesOnly) {
    inHead(() => drawEyes(ctx, p, true));
    ctx.restore();
    return anchors;
  }

  /**
   * Paints something at partial opacity as a whole, so the layers inside it
   * do not show through each other.
   */
  const faded = (alpha: number, paint: () => void) => {
    if (alpha <= 0.004) return;
    if (alpha >= 0.996) return paint();
    ctx = scratchLayer(target);
    paint();
    ctx = target;
    ctx.save();
    ctx.resetTransform();
    ctx.globalAlpha = alpha;
    ctx.drawImage(scratch!.canvas, 0, 0);
    ctx.restore();
  };

  // The arm on the side he turns toward ends up behind his torso.
  const farSide = f >= 0 ? 1 : -1;
  const shoulder = (s: number): Vec => {
    const isFar = s === farSide;
    const x = isFar ? s * (21 - 7 * af) : s * (21 - 17 * af);
    return B(x + f * 2, -56);
  };

  drawTail(ctx, input.tail, p.bristle);

  const arms = [-1, 1].map((s) => armGeometry(p, s, shoulder(s)));
  anchors.handL = arms[0].hand;
  anchors.handR = arms[1].hand;

  // An arm is always drawn behind him, and again in front as far as it has
  // come round: faded in, so it never jumps from one side to the other.
  const inFront = (arm: Arm) => smooth(clamp01(input.arms.front[arm.s < 0 ? 0 : 1]));
  const overFace = (arm: Arm) => smooth(clamp01(input.arms.overFace[arm.s < 0 ? 0 : 1]));
  for (const arm of arms) {
    armPath(ctx, arm, WHOLE);
    ctx.fillStyle = COLORS.outline;
    ctx.fill();
    armPath(ctx, arm, null);
    ctx.fillStyle = armFur(ctx, arm);
    ctx.fill();
    ctx.fillStyle = SHADE;
    ctx.fill();
    drawHand(ctx, arm);
  }

  const bodyPath = () => {
    // A plump egg. Its domed top hides under his head until he tilts it.
    const a = B(0, -73);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    curveB(-21, -73, -38, -62, -37.5, -33);
    curveB(-37.5, -17, -24, -11, 0, -11);
    curveB(24, -11, 37.5, -17, 37.5, -33);
    curveB(38, -62, 21, -73, 0, -73);
    ctx.closePath();
  };

  // The torso is inked first and filled last, with the legs in between, so
  // they grow out of him without a seam. The far leg goes first so the near
  // one overlaps it in profile.
  const legOrder = f >= 0 ? [1, -1] : [-1, 1];
  const hipX = 13 * (1 - 0.45 * af);
  const legs: Leg[] = legOrder.map((s, i) => ({
    hip: B(s * hipX, -21),
    x: s < 0 ? p.footLX : p.footRX,
    y: s < 0 ? p.footLY : p.footRY,
    // Seen from the front his feet point outward; as he turns they swing round to point where he is going.
    toes: s * 9.5 * (1 - af) + f * 15.5,
    far: i === 0 && af > 0.3,
  }));
  inkAround(ctx, bodyPath);
  for (const leg of legs) {
    legPath(ctx, leg, WHOLE);
    ctx.fillStyle = COLORS.outline;
    ctx.fill();
    legPath(ctx, leg, null);
    ctx.fillStyle = furToPaw(ctx, leg.hip, { x: leg.x, y: leg.y - ANKLE }, 4, 0);
    ctx.fill();
    // Under the belly the legs are in its shade, the far one twice over.
    ctx.fillStyle = SHADE;
    ctx.fill();
    if (leg.far) ctx.fill();
  }
  bodyPath();
  ctx.fillStyle = COLORS.fur;
  ctx.fill();
  ctx.save();
  bodyPath();
  ctx.clip();

  // Belly: an egg of cream fur, fuller at the bottom.
  const bw = 21.5 * (1 - 0.32 * af);
  const bx = f * 15;
  const top = B(bx, -57);
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  curveB(bx + bw * 0.72, -57, bx + bw * 1.04, -43, bx + bw, -32);
  curveB(bx + bw * 0.96, -20.5, bx + bw * 0.5, -14.5, bx, -14.5);
  curveB(bx - bw * 0.5, -14.5, bx - bw * 0.96, -20.5, bx - bw, -32);
  curveB(bx - bw * 1.04, -43, bx - bw * 0.72, -57, bx, -57);
  ctx.closePath();
  ctx.fillStyle = COLORS.cream;
  ctx.fill();

  /**
   * The side of the belly away from the light, and the chest under his chin:
   * the head's own outline, dropped a little. Call it inside a clip.
   */
  const shadeBody = () => {
    const lit = B(-5 - f * 9, -47);
    shadeAround(ctx, lit.x, lit.y, 35 * sx, 34 * sy, p.lean);
    ctx.save();
    ctx.translate(CAST_X * 0.5, CAST_Y);
    inHead(() => headPath(ctx, clamp(p.yaw, -1, 1)));
    ctx.restore();
    ctx.fillStyle = SHADE;
    ctx.fill();
  };
  shadeBody();
  // Each arm in front of him leaves a little shade beneath it, thinning out toward the shoulder.
  for (const arm of arms) {
    ctx.save();
    ctx.globalAlpha = inFront(arm);
    ctx.translate(CAST_X, CAST_Y);
    armPath(ctx, arm, THINNING);
    ctx.fillStyle = SHADE;
    ctx.fill();
    ellipse(ctx, arm.hand.x + arm.reach.x * 4, arm.hand.y + arm.reach.y * 4, 6, 6);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  for (const leg of legs) drawFoot(ctx, leg);

  /**
   * An arm in front of him. Its line fades in partway along, so it grows out
   * of him without a shoulder, and over his body it takes the body's
   * shading, so only that line sets it apart. `acrossFace` is for an arm
   * drawn on top of his head, which needs its whole line there.
   */
  const paintArm = (arm: Arm, acrossFace: boolean) => {
    const head = () => inHead(() => headPath(ctx, clamp(p.yaw, -1, 1)));
    ctx.fillStyle = COLORS.outline;
    armPath(ctx, arm, GROWING);
    ctx.fill();
    if (acrossFace) {
      ctx.save();
      head();
      ctx.clip();
      armPath(ctx, arm, WHOLE);
      ctx.fill();
      ctx.restore();
    }
    armPath(ctx, arm, null);
    ctx.fillStyle = armFur(ctx, arm);
    ctx.fill();
    ctx.save();
    ctx.clip();
    // Its own underside is in shade: the arm again, nudged toward the light, leaves it.
    ctx.fillStyle = SHADE;
    ctx.fill();
    ctx.translate(-CAST_X * 0.75, -CAST_Y * 0.75);
    armPath(ctx, arm, THICKENING);
    ctx.fillStyle = armFur(ctx, arm);
    ctx.fill();
    ctx.translate(CAST_X * 0.75, CAST_Y * 0.75);
    bodyPath();
    ctx.clip();
    if (acrossFace) {
      head();
      ctx.rect(-600, -600, 1200, 1200);
      ctx.clip("evenodd");
    }
    shadeBody();
    ctx.restore();
  };

  // His head sits in front of his arms.
  for (const arm of arms) faded(inFront(arm), () => paintArm(arm, false));

  inHead(() => drawHead(ctx, p, input));

  if (input.held && input.held.hand !== "both") {
    const s = input.held.hand === "L" ? -1 : 1;
    const hxp = s < 0 ? p.handLX : p.handRX;
    const hyp = s < 0 ? p.handLY : p.handRY;
    input.held.draw(ctx, { x: hxp, y: hyp, x2: hxp, y2: hyp });
  } else if (input.held) {
    input.held.draw(ctx, { x: p.handLX, y: p.handLY, x2: p.handRX, y2: p.handRY });
  }

  // Except an arm raised to his face, which goes on again in front of it. Hands are always on top.
  for (const arm of arms) {
    const front = inFront(arm);
    faded(front * overFace(arm), () => paintArm(arm, true));
    faded(front, () => drawHand(ctx, arm));
  }

  ctx.restore();
  return anchors;
}

/** How far a limb's ink line stands off the limb at parameter t (0 at the body, 1 at the paw). */
type Pad = (t: number) => number;
const WHOLE: Pad = () => OUTLINE;
/** Not a line but a slimmer limb, down to nothing at the body: the shape of the shade an arm leaves. */
const THINNING: Pad = (t) => -7 * (1 - smooth(clamp01(t / 0.55)));
/** A limb grown fat at the body and true to size from halfway along. */
const THICKENING: Pad = (t) => 5 * (1 - smooth(clamp01(t / 0.55)));
/** Starts inside the limb, so nothing shows until the line has begun. */
const GROWING: Pad = (t) => (OUTLINE + 0.4) * smooth(clamp01((t - 0.12) / 0.4)) - 0.4;

const LIMB_STEPS = 12;
const CAP_STEPS = 6;
const INK_LENGTH = Math.hypot(INK_X, INK_Y);

/**
 * Traces a tapering limb along the curve from `a` to `b` bent toward `c`.
 * With a `pad` it traces the limb's ink line instead: the limb grown outward,
 * further on the side that faces away from the light.
 */
function limbPath(ctx: Ctx, a: Vec, c: Vec, b: Vec, w0: number, w1: number, pad: Pad | null) {
  const reach = (t: number, nx: number, ny: number) => {
    const half = lerp(w0, w1, t) / 2;
    if (!pad) return half;
    return half + pad(t) * (1 + 0.65 * Math.max(0, (nx * INK_X + ny * INK_Y) / INK_LENGTH));
  };
  const left: Vec[] = [];
  const right: Vec[] = [];
  const along: Vec[] = [];
  for (let i = 0; i <= LIMB_STEPS; i++) {
    const t = i / LIMB_STEPS;
    const u = 1 - t;
    const x = u * u * a.x + 2 * u * t * c.x + t * t * b.x;
    const y = u * u * a.y + 2 * u * t * c.y + t * t * b.y;
    let dx = u * (c.x - a.x) + t * (b.x - c.x);
    let dy = u * (c.y - a.y) + t * (b.y - c.y);
    const d = Math.hypot(dx, dy) || 1;
    dx /= d;
    dy /= d;
    along.push({ x: dx, y: dy });
    const l = reach(t, -dy, dx);
    const r = reach(t, dy, -dx);
    left.push({ x: x - dy * l, y: y + dx * l });
    right.push({ x: x + dy * r, y: y - dx * r });
  }
  /** A rounded end at `at`, swinging from the normal `from` through `via` to the opposite normal. */
  const cap = (at: Vec, t: number, from: Vec, via: Vec) => {
    for (let i = 1; i < CAP_STEPS; i++) {
      const ang = (i / CAP_STEPS) * Math.PI;
      const nx = from.x * Math.cos(ang) + via.x * Math.sin(ang);
      const ny = from.y * Math.cos(ang) + via.y * Math.sin(ang);
      const r = reach(t, nx, ny);
      ctx.lineTo(at.x + nx * r, at.y + ny * r);
    }
  };
  const t0 = along[0];
  const t1 = along[LIMB_STEPS];
  ctx.beginPath();
  ctx.moveTo(left[0].x, left[0].y);
  for (let i = 1; i <= LIMB_STEPS; i++) ctx.lineTo(left[i].x, left[i].y);
  cap(b, 1, { x: -t1.y, y: t1.x }, t1);
  for (let i = LIMB_STEPS; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
  cap(a, 0, { x: t0.y, y: -t0.x }, { x: -t0.x, y: -t0.y });
  ctx.closePath();
}

/**
 * Fur that darkens into the paw's colour toward the end of a limb running
 * from `from` to `to`: between `start` and `end` units short of `to`.
 */
function furToPaw(ctx: Ctx, from: Vec, to: Vec, start: number, end: number): CanvasGradient {
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d;
  dy /= d;
  const fade = ctx.createLinearGradient(to.x - dx * start, to.y - dy * start, to.x - dx * end, to.y - dy * end);
  fade.addColorStop(0, COLORS.fur);
  fade.addColorStop(1, COLORS.paw);
  return fade;
}

interface Leg {
  hip: Vec;
  /** Where the sole meets the ground, under the ankle. */
  x: number;
  y: number;
  /** How far the toes reach from the ankle; negative points left. */
  toes: number;
  far: boolean;
}

function legPath(ctx: Ctx, leg: Leg, pad: Pad | null) {
  const ankle = { x: leg.x, y: leg.y - ANKLE };
  const knee = { x: (leg.hip.x + ankle.x) / 2, y: (leg.hip.y + ankle.y) / 2 };
  limbPath(ctx, leg.hip, knee, ankle, LEG_HIP, LEG_ANKLE, pad);
}

/**
 * A small dark paw that the leg runs into: a flat-soled mound with toes at
 * its longer end. No line crosses the ankle. It lies flat when planted and
 * droops toe-first when the leg hangs.
 */
function drawFoot(ctx: Ctx, leg: Leg) {
  const dx = leg.x - leg.hip.x;
  const dy = leg.y - ANKLE - leg.hip.y;
  const len = Math.hypot(dx, dy);
  const hang = clamp01((len - 15) / 10);
  const xl = Math.min(-5.6, leg.toes);
  const xr = Math.max(5.6, leg.toes);
  const top = -ANKLE - 1.6;
  /**
   * One end of the foot, from the sole up to the top of its mound. `e` is
   * the end's x and `o` which way it points; the further out the end, the
   * more it divides into three toes.
   */
  const end = (e: number, o: number, up: boolean) => {
    const w = clamp01((Math.abs(e) - 5.6) / 3.5);
    const pts: [number, number, number, number][] = [
      [e + o * 1.9, 0.2, e + o * (0.9 - 1.3 * w), -2.2],
      [e + o * (1.6 + 0.7 * w), -3.3, e + o * (0.2 - 1.2 * w), -4.5],
      [e + o * (0.5 + 0.9 * w), -6.9, e - o * 2.4, -6.9],
    ];
    if (up) {
      for (const [cx, cy, x, y] of pts) ctx.quadraticCurveTo(cx, cy, x, y);
    } else {
      // The same curves walked from the top of the mound down to the sole.
      for (let i = pts.length - 1; i >= 0; i--) {
        const to = i > 0 ? [pts[i - 1][2], pts[i - 1][3]] : [e - o * 3, 0.5];
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], to[0], to[1]);
      }
    }
  };
  /** From the ankle's near side round the heel, the sole and the toes, to its far side. */
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(-4.4, top);
    ctx.quadraticCurveTo((xl - 2.4 - 4.4) / 2, top - 0.2, xl + 2.4, -6.9);
    end(xl, -1, false);
    ctx.lineTo(xr - 3, 0.5);
    end(xr, 1, true);
    ctx.quadraticCurveTo((xr - 2.4 + 4.4) / 2, top - 0.2, 4.4, top);
  };
  const place = () => {
    ctx.translate(leg.x, leg.y - ANKLE);
    ctx.rotate(hang * (clamp(dx / (len || 1), -1, 1) * 0.5 + clamp(leg.toes / 8, -1, 1) * 0.35));
    ctx.translate(0, ANKLE);
  };
  // The foot is inked everywhere but across the leg that runs into it.
  ctx.save();
  legPath(ctx, leg, null);
  ctx.rect(leg.x - 80, leg.y - 80, 160, 160);
  ctx.clip("evenodd");
  place();
  trace();
  ctx.lineWidth = PAW_LINE * 2;
  ctx.strokeStyle = COLORS.outline;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  place();
  trace();
  ctx.fillStyle = COLORS.paw;
  ctx.fill();
  ctx.restore();
}

/**
 * Where the elbow goes. The two ways an arm can fold are blended by how
 * natural each looks (out and down, like a relaxed arm), so the elbow
 * swings through straight instead of flipping from one side to the other.
 */
function chooseElbow(sh: Vec, hand: Vec, s: number): Vec {
  let dx = hand.x - sh.x;
  let dy = hand.y - sh.y;
  let d = Math.hypot(dx, dy) || 0.001;
  const max = ARM_UPPER + ARM_LOWER - 0.5;
  if (d > max) {
    dx *= max / d;
    dy *= max / d;
    d = max;
  }
  const a = d / 2;
  const h = Math.sqrt(Math.max(0, ARM_UPPER * ARM_UPPER - a * a));
  const nx = -dy / d;
  const ny = dx / d;
  const bend = Math.tanh(((nx * s + ny * 0.6) * h) / 6);
  return { x: sh.x + dx / 2 + nx * h * bend, y: sh.y + dy / 2 + ny * h * bend };
}

interface Arm {
  s: number;
  sh: Vec;
  el: Vec;
  hand: Vec;
  /** Unit vector along the forearm, toward the fingers. */
  reach: Vec;
  point: number;
}

function armGeometry(p: Pose, s: number, sh: Vec): Arm {
  let hand = { x: s < 0 ? p.handLX : p.handRX, y: s < 0 ? p.handLY : p.handRY };
  const reach = Math.hypot(hand.x - sh.x, hand.y - sh.y);
  const point = s < 0 ? p.pointL : p.pointR;
  // A pointing arm stretches a little, the way a cartoon arm does.
  const max = (ARM_UPPER + ARM_LOWER) * (1 + 0.3 * point) - 0.5;
  if (reach > max) {
    hand = { x: sh.x + ((hand.x - sh.x) * max) / reach, y: sh.y + ((hand.y - sh.y) * max) / reach };
  }
  const el = chooseElbow(sh, hand, s);
  const along = Math.hypot(hand.x - el.x, hand.y - el.y) || 1;
  return { s, sh, hand, el, reach: { x: (hand.x - el.x) / along, y: (hand.y - el.y) / along }, point };
}

function armPath(ctx: Ctx, arm: Arm, pad: Pad | null) {
  limbPath(ctx, arm.sh, arm.el, arm.hand, ARM_SHOULDER, ARM_WRIST, pad);
}

/** The fur of an arm, darkening into the hand. */
function armFur(ctx: Ctx, arm: Arm): CanvasGradient {
  return furToPaw(ctx, arm.el, arm.hand, 4.5, 0.5);
}

const PAW_LINE = 1.2;
const PALM = 4.2;
const PALM_X = 2.6;
/** His four fingers: the angle each leaves the palm at, and how far it sticks out. */
const FINGERS = [
  { angle: -0.68, length: 3.6 },
  { angle: -0.23, length: 4.8 },
  { angle: 0.23, length: 4.8 },
  { angle: 0.68, length: 3.6 },
];

/** Adds one tapering finger to the path, curling in a little toward the middle of the hand. */
function finger(ctx: Ctx, angle: number, length: number, base: number, tip: number) {
  const bend = angle * 0.8;
  const bx = PALM_X + Math.cos(angle) * (PALM - 1.6);
  const by = Math.sin(angle) * (PALM - 1.6);
  const tx = PALM_X + Math.cos(bend) * (PALM + length);
  const ty = Math.sin(bend) * (PALM + length);
  let dx = tx - bx;
  let dy = ty - by;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d;
  dy /= d;
  const mx = lerp(bx, tx, 0.55);
  const my = lerp(by, ty, 0.55);
  ctx.moveTo(bx + dy * base, by - dx * base);
  ctx.quadraticCurveTo(mx + dy * base, my - dx * base, tx - dx * tip + dy * tip, ty - dy * tip - dx * tip);
  ctx.quadraticCurveTo(tx + dx * tip * 1.2, ty + dy * tip * 1.2, tx - dx * tip - dy * tip, ty - dy * tip + dx * tip);
  ctx.quadraticCurveTo(mx - dy * base, my + dx * base, bx - dy * base, by + dx * base);
  ctx.closePath();
}

/**
 * A tiny grabby hand the arm runs into: a round palm, four short tapering
 * fingers and a thumb. No line crosses the wrist. The thumb sits on whichever
 * side faces up and in, and slides across behind the palm as the arm swings,
 * so the hand never flips. Pointing folds it into a fist with the two middle
 * fingers together as one.
 */
function drawHand(ctx: Ctx, arm: Arm) {
  const { hand, reach, point: k, s } = arm;
  const ang = Math.atan2(reach.y, reach.x);
  const side = Math.tanh((Math.cos(ang) - 0.6 * s * Math.sin(ang)) * 2.5);
  /** The palm, whole or only the part of its rim that faces the fingers, then the fingers and thumb. */
  const trace = (rim: number) => {
    ctx.beginPath();
    ctx.arc(PALM_X, 0, PALM, -rim, rim);
    FINGERS.forEach((f, i) => {
      const middle = i === 1 || i === 2;
      finger(ctx, lerp(f.angle, middle ? 0 : f.angle * 0.8, k), lerp(f.length, middle ? 7 : 0.6, k), lerp(1.25, 1.45, k), lerp(0.6, 0.8, k));
    });
    finger(ctx, -side * 1.2, 3.6 * Math.abs(side) * (1 - 0.7 * k), 1.5, 0.7);
  };
  ctx.save();
  ctx.translate(hand.x, hand.y);
  ctx.rotate(ang);
  trace(2.25);
  ctx.lineWidth = PAW_LINE * 2;
  ctx.strokeStyle = COLORS.outline;
  ctx.stroke();
  trace(Math.PI);
  ctx.fillStyle = COLORS.paw;
  ctx.fill();
  ctx.restore();
}

/**
 * Head silhouette in head space: origin at the neck, skull centre at (0,-32).
 * A broad, flat-topped skull that is widest at the cheek fluff. `turn` is the
 * yaw: the cheek he turns toward foreshortens, the other swells.
 */
function headPath(ctx: Ctx, turn: number, chin = true) {
  const kr = 1 - 0.06 * turn;
  const kl = 1 + 0.06 * turn;
  const R = (x: number) => x * kr;
  const L = (x: number) => -x * kl;
  // The crown tuft sits on the back of the skull, so it slides against the turn.
  const t = -turn * 3.5;
  ctx.beginPath();
  ctx.moveTo(t - 8.5, -66.6);
  ctx.quadraticCurveTo(t - 8.4, -69.6, t - 5.6, -71.4);
  ctx.quadraticCurveTo(t - 4.4, -68.8, t - 2.2, -68);
  ctx.quadraticCurveTo(t - 1.4, -71.4, t + 2.4, -73.6);
  ctx.quadraticCurveTo(t + 2.2, -69.8, t + 4.4, -68.2);
  ctx.quadraticCurveTo(t + 5.6, -70, t + 8.6, -70.8);
  ctx.quadraticCurveTo(t + 8.6, -68.4, t + 10, -66.6);
  ctx.bezierCurveTo(R(27), -66.4, R(42.5), -57.5, R(44.2), -40);
  // Cheek fluff: two sharp flicks, the upper one longer.
  ctx.quadraticCurveTo(R(45.6), -33.4, R(55.4), -28.6);
  ctx.quadraticCurveTo(R(49), -26.6, R(47), -22);
  ctx.quadraticCurveTo(R(47.6), -16.4, R(52.2), -12.4);
  if (chin) {
    ctx.bezierCurveTo(R(43.5), -1.6, R(23), 3.2, 0, 3.2);
    ctx.bezierCurveTo(L(23), 3.2, L(43.5), -1.6, L(52.2), -12.4);
  } else {
    ctx.moveTo(L(52.2), -12.4);
  }
  ctx.quadraticCurveTo(L(47.6), -16.4, L(47), -22);
  ctx.quadraticCurveTo(L(49), -26.6, L(55.4), -28.6);
  ctx.quadraticCurveTo(L(45.6), -33.4, L(44.2), -40);
  ctx.bezierCurveTo(L(42.5), -57.5, L(27), -66.4, t - 8.5, -66.6);
  if (chin) ctx.closePath();
}

/**
 * Inks his head. Under the chin, where his head runs into his chest, there
 * is no line: it comes in from each cheek and thins away before the middle.
 */
function inkHead(ctx: Ctx, turn: number) {
  headPath(ctx, turn, false);
  ctx.lineWidth = OUTLINE;
  ctx.strokeStyle = COLORS.outline;
  ctx.stroke();
  const END = 0.74;
  ctx.fillStyle = COLORS.outline;
  for (const k of [1 - 0.06 * turn, -(1 + 0.06 * turn)]) {
    brush(
      ctx,
      // Along the jaw, from the cheek's lower flick toward the chin.
      (along) => {
        const t = along * END;
        const u = 1 - t;
        return {
          x: k * (u * u * u * 52.2 + 3 * u * u * t * 43.5 + 3 * u * t * t * 23),
          y: u * u * u * -12.4 + 3 * u * u * t * -1.6 + 3 * u * t * t * 3.2 + t * t * t * 3.2,
        };
      },
      (along) => (OUTLINE / 2) * (1 - smooth(clamp01((along * END - 0.36) / (END - 0.36)))),
      12,
    );
  }
}

function drawEar(ctx: Ctx, p: Pose, s: number) {
  const ear = s < 0 ? p.earL : p.earR;
  const flat = clamp01(ear);
  // The ear on the side he turns away from recedes: smaller and in shade.
  const away = clamp01(-p.yaw * s);
  ctx.save();
  ctx.translate(s * (29.5 + flat * 5) - p.yaw * 5, -56 - p.pitch * 3 + flat * 7);
  ctx.rotate(s * (0.36 + ear * 0.8));
  ctx.scale((1 - away * 0.1) * 1.04, (1 - flat * 0.18) * 1.04);

  const outer = () => {
    ctx.beginPath();
    ctx.moveTo(-14.5, 6);
    ctx.bezierCurveTo(-17, -9, -10.5, -21.5, -3 + s, -25.2);
    ctx.quadraticCurveTo(s, -27.4, 3 + s, -25.2);
    ctx.bezierCurveTo(10.5, -21.5, 17, -9, 14.5, 6);
    ctx.closePath();
  };
  inked(ctx, outer, COLORS.fur);
  ctx.beginPath();
  ctx.moveTo(-8.4, 5);
  ctx.bezierCurveTo(-10.4, -5, -5.8, -14.6, -1.6 + s, -17.4);
  ctx.quadraticCurveTo(s, -18.8, 1.6 + s, -17.4);
  ctx.bezierCurveTo(5.8, -14.6, 10.4, -5, 8.4, 5);
  ctx.closePath();
  ctx.fillStyle = COLORS.earIn;
  ctx.fill();
  if (away > 0.02) {
    outer();
    ctx.globalAlpha = away;
    ctx.fillStyle = SHADE;
    ctx.fill();
  }
  ctx.restore();
}

/** Runs `trace` in the frame of one mask half: centred beside the eye, +x pointing at the cheek. */
function inPatch(ctx: Ctx, cx: number, cy: number, s: number, xs: number, rot: number, trace: () => void) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(s * xs, 1);
  ctx.beginPath();
  trace();
  ctx.restore();
}

/**
 * One half of the bandit mask: a band that is fullest around the eye and
 * sweeps out and down to the cheek, where it ends in a few small tufts.
 */
function maskPatch(ctx: Ctx) {
  ctx.moveTo(-15.5, -1.5);
  ctx.bezierCurveTo(-15.5, -9.5, -9.5, -14, -2, -14);
  ctx.bezierCurveTo(8, -14, 18, -9.6, 25.6, -2.6);
  ctx.quadraticCurveTo(23.2, -1.8, 22.8, 0.3);
  ctx.quadraticCurveTo(24.8, 0.9, 25.6, 3);
  ctx.quadraticCurveTo(23, 3.1, 22.2, 5);
  ctx.quadraticCurveTo(23.6, 6, 23.8, 8.2);
  ctx.bezierCurveTo(17, 11.6, 8, 13.4, -1, 12.8);
  ctx.bezierCurveTo(-9.5, 12.2, -15.5, 6.5, -15.5, -1.5);
  ctx.closePath();
}

/** The pale brow: an arc lying along the top of the mask and thinning to a point at its outer end. `lift` raises it as the brows go up. */
function browPatch(ctx: Ctx, lift: number) {
  ctx.moveTo(-15.5, -6);
  ctx.bezierCurveTo(-17.6, -13.5 - lift, -11, -19 - lift, -2, -19.2 - lift);
  ctx.bezierCurveTo(9, -19.2 - lift, 20.5, -13.6 - lift, 28.4, -2.4);
  ctx.quadraticCurveTo(20, -9, 8, -9);
  ctx.lineTo(-8, 2);
  ctx.closePath();
}

/** Drawn in head space: origin at the neck, skull centre at (0,-32). */
function drawHead(ctx: Ctx, p: Pose, input: DrawInput) {
  const h = clamp(p.yaw, -1, 1);
  const pt = clamp(p.pitch, -1, 1);
  const outline = () => headPath(ctx, h);

  drawEar(ctx, p, -1);
  drawEar(ctx, p, 1);

  ctx.save();
  ctx.translate(INK_X, INK_Y);
  inkHead(ctx, h);
  ctx.restore();
  outline();
  ctx.fillStyle = COLORS.fur;
  ctx.fill();

  ctx.save();
  outline();
  ctx.clip();

  // The cheek and jaw on the side away from the light.
  shadeAround(ctx, -9 - h * 8, -44 + pt * 4, 54, 46);

  const patches = [-1, 1].map((s) => {
    const xs = 1 - 0.24 * h * s;
    const cx = s * (EYE_X + 3) * xs + h * 12;
    const cy = EYE_Y + 0.6 + pt * 6.6 - p.browRaise * 1.2;
    const rot = s * (0.2 + p.brow * 0.1);
    return (trace: () => void) => inPatch(ctx, cx, cy, s, xs, rot, trace);
  });
  for (const inHalf of patches) {
    inHalf(() => browPatch(ctx, p.browRaise * 1.6));
    ctx.fillStyle = COLORS.cream;
    ctx.fill();
  }

  // Muzzle: fuller at the jowls than at the bridge of the nose. The mask lies over its upper corners.
  const mx = h * 14;
  const my = -16.6 + pt * 9;
  ctx.beginPath();
  ctx.moveTo(mx, my - 12.4);
  ctx.bezierCurveTo(mx + 8.4, my - 12.4, mx + 16.2, my - 7.4, mx + 16.8, my + 1.2);
  ctx.bezierCurveTo(mx + 17.2, my + 8.6, mx + 9.4, my + 12.6, mx, my + 12.6);
  ctx.bezierCurveTo(mx - 9.4, my + 12.6, mx - 17.2, my + 8.6, mx - 16.8, my + 1.2);
  ctx.bezierCurveTo(mx - 16.2, my - 7.4, mx - 8.4, my - 12.4, mx, my - 12.4);
  ctx.closePath();
  ctx.fillStyle = COLORS.cream;
  ctx.fill();

  for (const inHalf of patches) {
    inHalf(() => maskPatch(ctx));
    ctx.fillStyle = COLORS.mask;
    ctx.fill();
  }

  if (p.blush > 0.01) {
    ctx.globalAlpha = p.blush * 0.55;
    ctx.fillStyle = COLORS.blush;
    for (const s of [-1, 1]) {
      ellipse(ctx, s * 33 * (1 - 0.2 * h * s) + h * 12, -16 + pt * 7, 7, 4.2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  inkHead(ctx, h);

  drawEyes(ctx, p, false);

  // Nose.
  ctx.save();
  ctx.translate(h * 15.5, -24 + pt * 11);
  ctx.beginPath();
  ctx.moveTo(-5.5, -2.4);
  ctx.quadraticCurveTo(0, -4.9, 5.5, -2.4);
  ctx.bezierCurveTo(6.5, 0.6, 2.6, 3.5, 0, 4);
  ctx.bezierCurveTo(-2.6, 3.5, -6.5, 0.6, -5.5, -2.4);
  ctx.closePath();
  ctx.fillStyle = COLORS.nose;
  ctx.fill();
  ellipse(ctx, -1.8, -1.6, 2, 1, -0.2);
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fill();
  ctx.restore();

  drawMouth(ctx, p, h * 14.5, -19.9 + pt * 10);

  if (p.sweat > 0.02) {
    for (let i = 0; i < 2; i++) {
      const phase = (input.time * 0.9 + i * 0.5) % 1;
      const s = i === 0 ? 1 : -1;
      ctx.save();
      ctx.globalAlpha = p.sweat * (1 - phase) * 0.95;
      ctx.translate(s * (44 + i * 3), -56 + phase * 20);
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.bezierCurveTo(4, 0, 3.4, 4, 0, 4);
      ctx.bezierCurveTo(-3.4, 4, -4, 0, 0, -5);
      ctx.fillStyle = COLORS.sweat;
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = COLORS.outline;
      ctx.stroke();
      ctx.restore();
    }
  }

  if (input.hat === "nightcap") drawNightcap(ctx, p, input.time);
  else if (input.hat === "bottlecap") drawBottlecap(ctx);
}

const EYE_RIM = 1.1;
const LID_SHADE = "rgba(52, 44, 62, 0.2)";

function drawEyes(ctx: Ctx, p: Pose, glow: boolean) {
  const h = clamp(p.yaw, -1, 1);
  const pt = clamp(p.pitch, -1, 1);
  const ink = glow ? "#000" : COLORS.outline;
  for (const s of [-1, 1]) {
    const xs = 1 - 0.2 * h * s;
    const cx = s * EYE_X * (1 - 0.24 * h * s) + h * 12;
    const cy = EYE_Y + pt * 7 - p.browRaise * 1.1;
    const wide = 1 + 0.08 * p.browRaise;
    const rx = 9.5 * xs * wide;
    const ry = 10.2 * wide;
    const lid = clamp01(s < 0 ? p.lidL : p.lidR);
    const low = clamp01(s < 0 ? p.lowL : p.lowR);
    // Where the lids meet when the eye shuts.
    const shutY = cy + ry * 0.3;
    const bend = lerp(3.2, -4.4, p.eyeSmile);

    if (lid > 0.955) {
      // Shut: a single arc, cheerful or drowsy.
      ctx.fillStyle = glow ? "#000" : COLORS.shut;
      brush(
        ctx,
        (t) => ({ x: cx + (t * 2 - 1) * rx * 0.92, y: shutY - bend * 0.25 + bend * 3.7 * t * (1 - t) }),
        (t) => 0.5 + 0.95 * Math.sin(Math.PI * t) ** 0.6,
      );
      continue;
    }

    // The lids are lines, not shapes: the eye is cut to the opening between
    // them and the cut is inked, so a closing eye shows the face behind it.
    // `v` runs across the eye from its inner corner (-1) to its outer one (1).
    // Over the last of the way both lids close onto the shut arc.
    const closing = smooth(clamp01((lid - 0.6) / 0.4));
    const shut = (v: number) => shutY + bend * (0.675 - 0.925 * v * v);
    // An open lid hugs the top of the eye and flattens as it lowers, all the
    // more under a slanted brow. That slant doubles as his eyebrow.
    const mid = cy - ry + Math.min(lid, 0.6) * 2 * ry;
    const lowered = lerp(3, 1.4, smooth(clamp01((lid - 0.4) / 0.3))) * (1 - 0.6 * Math.min(1, Math.abs(p.brow)));
    const arch = lerp(ry * 0.62, lowered, smooth(clamp01(lid / 0.4)));
    const slant = p.brow * 0.42 * rx;
    const upper = (v: number) => lerp(mid + arch * v * v + slant * v, shut(v), closing);
    const rise = low * ry * 1.05;
    const raised = Math.max(clamp01(rise / 1.5), clamp01(closing * 4));
    const lower = (v: number) =>
      lerp(lerp(cy + ry + 2, cy + ry - rise - 0.45 + 2.6 * v * v, clamp01(rise / 1.5)), shut(v), closing);
    const across = (v: number) => cx + s * v * rx;

    ctx.save();
    ctx.beginPath();
    const SPAN = 1.3;
    for (let i = 0; i <= 12; i++) {
      const v = lerp(-SPAN, SPAN, i / 12);
      ctx.lineTo(across(v), upper(v));
    }
    for (let i = 12; i >= 0; i--) {
      const v = lerp(-SPAN, SPAN, i / 12);
      ctx.lineTo(across(v), lower(v));
    }
    ctx.closePath();
    ctx.clip();
    ellipse(ctx, cx, cy, rx + EYE_RIM, ry + EYE_RIM);
    ctx.fillStyle = ink;
    ctx.fill();
    ellipse(ctx, cx, cy, rx, ry);
    ctx.fillStyle = glow ? "#e9eef2" : COLORS.white;
    ctx.fill();
    ctx.clip();

    // The upper lid shades the top of the eye.
    ctx.beginPath();
    for (let i = 0; i <= 12; i++) {
      const v = lerp(-SPAN, SPAN, i / 12);
      ctx.lineTo(across(v), upper(v));
    }
    ctx.lineWidth = 6.4;
    ctx.strokeStyle = LID_SHADE;
    ctx.stroke();

    // A big dark pupil that slides under the rim of the eye when he looks
    // aside, but never out of sight behind a lid.
    const rp = Math.min(6.5 * p.pupil, ry - 1.4);
    const gx = clamp(p.gazeX, -1, 1);
    const gy = clamp(p.gazeY, -1, 1);
    const gl = Math.hypot(gx, gy);
    const gk = gl > 1 ? 1 / gl : 1;
    const px = cx + gx * gk * (rx - rp * 0.7 * xs);
    const pv = (s * (px - cx)) / rx;
    const top = upper(pv);
    const bottom = Math.min(lower(pv), cy + ry);
    const highest = top + rp * 0.3;
    const lowest = bottom - rp * 0.3;
    const py = highest > lowest ? (top + bottom) / 2 : clamp(cy + gy * gk * (ry - rp * 0.76) + 0.5, highest, lowest);
    ellipse(ctx, px, py, rp * xs, rp);
    ctx.fillStyle = COLORS.pupil;
    ctx.fill();
    const glint = Math.min(Math.max(py - rp * 0.4, top + rp * 0.36 + 1.6), py + rp * 0.2);
    ellipse(ctx, px - rp * 0.34, glint, rp * 0.36, rp * 0.36);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ellipse(ctx, px + rp * 0.4, py + rp * 0.42, rp * 0.15, rp * 0.15);
    ctx.fill();
    ctx.restore();

    // The upper lid: a heavy line, thin at the inner corner, that runs a
    // little past the outer one and levels off there.
    const FROM = -0.97;
    const TURN = 0.92;
    const TO = 1.22;
    const slope = (upper(TURN) - upper(TURN - 0.05)) / 0.05;
    ctx.fillStyle = ink;
    brush(
      ctx,
      (t) => {
        const v = lerp(FROM, TO, t);
        if (v <= TURN) return { x: across(v), y: upper(v) };
        const past = v - TURN;
        return { x: across(v), y: upper(TURN) + slope * past * 0.4 - 6 * past * past };
      },
      (t) => 0.45 + 1.0 * smooth(clamp01(t / 0.3)) * (1 - smooth(clamp01((t - 0.7) / 0.3))) - 0.2 * t,
      18,
    );
    if (raised > 0.05) {
      brush(
        ctx,
        (t) => ({ x: across(lerp(-0.92, 0.92, t)), y: lower(lerp(-0.92, 0.92, t)) }),
        (t) => 0.8 * raised * Math.sin(Math.PI * t) ** 0.7,
      );
    }
  }
}

function drawMouth(ctx: Ctx, p: Pose, x: number, y: number) {
  const smile = clamp(p.smile, -1, 1);
  const open = clamp01(p.mouthOpen);
  const w = 7.8 * clamp(p.mouthW, 0.35, 1.4) * (1 + 0.12 * Math.max(0, smile));
  const top = 2.6;
  const cornerY = top + 1.1 - smile * 2.9;
  const dip = top + lerp(0.3, 4.6, clamp01(smile * 0.75 + 0.35));
  // A smirk hitches one corner of a smile higher than the other.
  const tug = clamp(p.smirk, -1, 1) * Math.max(0, smile) * 1.9;
  const cl = cornerY + tug * 0.7;
  const cr = cornerY - tug;
  const wr = w + Math.abs(tug) * 0.8;

  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = 1.95;
  ctx.strokeStyle = COLORS.outline;

  const lip = () => {
    ctx.moveTo(-w, cl);
    ctx.quadraticCurveTo(-w * 0.52, dip + tug * 0.3, 0, top);
    ctx.quadraticCurveTo(wr * 0.52, dip - tug * 0.2, wr, cr);
  };

  if (open > 0.04) {
    const depth = 2.2 + open * 10.5;
    const jaw = () => {
      ctx.beginPath();
      lip();
      ctx.bezierCurveTo(wr * 0.95, cr + depth * 0.9, w * 0.5, top + depth, 0, top + depth);
      ctx.bezierCurveTo(-w * 0.5, top + depth, -w * 0.95, cl + depth * 0.9, -w, cl);
      ctx.closePath();
    };
    jaw();
    ctx.fillStyle = COLORS.mouth;
    ctx.fill();
    ctx.save();
    jaw();
    ctx.clip();
    ellipse(ctx, 0, top + depth + 0.6, w * 0.66, depth * 0.52);
    ctx.fillStyle = COLORS.tongue;
    ctx.fill();
    ctx.restore();
    jaw();
    ctx.stroke();
  } else {
    ctx.beginPath();
    lip();
    ctx.stroke();
  }

  // Philtrum.
  ctx.beginPath();
  ctx.moveTo(0, -0.4);
  ctx.lineTo(0, top);
  ctx.stroke();

  if (p.tongue > 0.05) {
    const t = clamp01(p.tongue);
    ctx.beginPath();
    const tx = w * 0.42;
    const ty = (top + dip) / 2 + 0.6;
    ctx.moveTo(tx - 3.3, ty);
    ctx.bezierCurveTo(tx - 3.6, ty + 6.5 * t, tx + 3.9, ty + 6.5 * t, tx + 3.3, ty - 0.4);
    ctx.closePath();
    ctx.fillStyle = COLORS.tongue;
    ctx.fill();
    ctx.lineWidth = INNER;
    ctx.stroke();
  }
  ctx.restore();
}

function drawNightcap(ctx: Ctx, p: Pose, time: number) {
  const sway = Math.sin(time * 1.3) * 1.5 + p.tilt * 14;
  ctx.save();
  ctx.translate(-p.yaw * 4, -3 * p.pitch);
  inked(
    ctx,
    () => {
      ctx.beginPath();
      ctx.moveTo(-31, -58);
      ctx.bezierCurveTo(-26, -86, 6, -92, 24, -76);
      ctx.bezierCurveTo(36, -68, 46, -60 + sway, 47, -52 + sway);
      ctx.bezierCurveTo(40, -58, 34, -60, 31, -58);
      ctx.closePath();
    },
    "#8fa0b8",
  );
  inked(ctx, () => ellipse(ctx, 48, -48 + sway, 6.5, 6.5), "#f4f1ec");
  inked(
    ctx,
    () => {
      ctx.beginPath();
      ctx.moveTo(-34, -60);
      ctx.bezierCurveTo(-14, -70, 16, -70, 34, -60);
      ctx.bezierCurveTo(37, -57, 36, -52, 33, -51);
      ctx.bezierCurveTo(14, -61, -14, -61, -33, -51);
      ctx.bezierCurveTo(-36, -52, -37, -57, -34, -60);
      ctx.closePath();
    },
    "#f4f1ec",
  );
  ctx.restore();
}

function drawBottlecap(ctx: Ctx) {
  ctx.save();
  ctx.translate(2, -68.5);
  ctx.rotate(0.12);
  inked(
    ctx,
    () => {
      const n = 9;
      ctx.beginPath();
      ctx.moveTo(-17, 2);
      for (let i = 0; i < n; i++) {
        const x0 = -17 + (34 / n) * i;
        ctx.quadraticCurveTo(x0 + 17 / n, 6.5, x0 + 34 / n, 2);
      }
      ctx.lineTo(14, -6);
      ctx.quadraticCurveTo(0, -11, -14, -6);
      ctx.closePath();
    },
    "#d6524a",
  );
  ctx.beginPath();
  ctx.moveTo(-9, -5);
  ctx.quadraticCurveTo(-2, -8, 4, -6.5);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.stroke();
  ctx.restore();
}

/** Catmull-Rom through the tail nodes, resampled evenly enough for striping. */
function tailSpine(nodes: Vec[], samples: number): Vec[] {
  const out: Vec[] = [];
  const n = nodes.length;
  for (let i = 0; i < samples; i++) {
    const u = (i / (samples - 1)) * (n - 1);
    const k = Math.min(n - 2, Math.floor(u));
    const t = u - k;
    const p0 = nodes[Math.max(0, k - 1)];
    const p1 = nodes[k];
    const p2 = nodes[k + 1];
    const p3 = nodes[Math.min(n - 1, k + 2)];
    const t2 = t * t;
    const t3 = t2 * t;
    out.push({
      x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    });
  }
  return out;
}

export function tailRadius(t: number, bristle: number): number {
  const grow = clamp01(t / 0.45);
  let r = 7.5 + 9.3 * grow * grow * (3 - 2 * grow);
  if (t > 0.74) r *= lerp(1, 0.66, (t - 0.74) / 0.26);
  return r * (1 + 0.38 * bristle);
}

const STRIPES: [number, number][] = [
  [0.15, 0.27],
  [0.39, 0.51],
  [0.63, 0.75],
  [0.87, 1.01],
];

function drawTail(ctx: Ctx, nodes: Vec[], bristle: number) {
  if (nodes.length < 3) return;
  const S = 56;
  const spine = tailSpine(nodes, S);
  const left: Vec[] = [];
  const right: Vec[] = [];
  const along: Vec[] = [];
  const radius: number[] = [];
  for (let i = 0; i < S; i++) {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(S - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const t = i / (S - 1);
    const jag = bristle > 0.05 ? (i % 2 ? 1 : -1) * 1.7 * bristle : 0;
    const r = tailRadius(t, bristle) + jag;
    along.push({ x: tx, y: ty });
    radius.push(r);
    left.push({ x: spine[i].x - ty * r, y: spine[i].y + tx * r });
    right.push({ x: spine[i].x + ty * r, y: spine[i].y - tx * r });
  }
  const tip = spine[S - 1];
  const tipAng = Math.atan2(along[S - 1].y, along[S - 1].x);
  const tipR = tailRadius(1, bristle);

  const outline = () => {
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < S; i++) ctx.lineTo(left[i].x, left[i].y);
    ctx.arc(tip.x, tip.y, tipR, tipAng + Math.PI / 2, tipAng - Math.PI / 2, true);
    for (let i = S - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
    ctx.closePath();
  };
  /** Control point that bows a band's edge toward the tip, as on a round tail. */
  const bow = (i: number): Vec => ({
    x: spine[i].x + along[i].x * radius[i] * 0.62,
    y: spine[i].y + along[i].y * radius[i] * 0.62,
  });

  inkUnder(ctx, outline);
  outline();
  ctx.fillStyle = COLORS.tailLight;
  ctx.fill();

  ctx.save();
  outline();
  ctx.clip();
  ctx.fillStyle = COLORS.tailDark;
  for (const [t0, t1] of STRIPES) {
    const i0 = Math.round(t0 * (S - 1));
    const i1 = Math.min(S - 1, Math.round(t1 * (S - 1)));
    const c0 = bow(i0);
    ctx.beginPath();
    ctx.moveTo(left[i0].x, left[i0].y);
    for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(left[i].x, left[i].y);
    if (t1 > 1) {
      ctx.arc(tip.x, tip.y, tipR + 3, tipAng + Math.PI / 2, tipAng - Math.PI / 2, true);
    } else {
      const c1 = bow(i1);
      ctx.quadraticCurveTo(c1.x, c1.y, right[i1].x, right[i1].y);
    }
    for (let i = i1 - 1; i >= i0; i--) ctx.lineTo(right[i].x, right[i].y);
    ctx.quadraticCurveTo(c0.x, c0.y, left[i0].x, left[i0].y);
    ctx.closePath();
    ctx.fill();
  }
  // The same silhouette nudged toward the light leaves a shaded underside,
  // wherever the tail happens to be pointing.
  ctx.translate(-CAST_X * 1.7, -CAST_Y * 1.7);
  ctx.beginPath();
  ctx.rect(tip.x - 600, tip.y - 600, 1200, 1200);
  ctx.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < S; i++) ctx.lineTo(left[i].x, left[i].y);
  ctx.arc(tip.x, tip.y, tipR, tipAng + Math.PI / 2, tipAng - Math.PI / 2, true);
  for (let i = S - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
  ctx.closePath();
  ctx.fillStyle = SHADE;
  ctx.fill("evenodd");
  ctx.restore();

  inkOver(ctx, outline);
}
