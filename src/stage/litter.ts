import { approach, clamp, pick, rand, sign } from "../pesto/math";
import type { World } from "../world/world";

export const JUNK_KINDS = ["paper", "tin", "peel", "core", "fishbone"] as const;
export type JunkKind = (typeof JUNK_KINDS)[number];

/** One piece of junk on the desktop. Position is its centre, in world pixels. */
export interface Junk {
  kind: JunkKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  /** Radians per second while it is in the air. */
  spin: number;
  /** Whether it has hit anything yet. */
  landed: boolean;
  resting: boolean;
  /** Seconds it has lain still. */
  lain: number;
  /** 0 solid to 1 gone. */
  fade: number;
  /** The window it lies on, which it moves with, and where on that window: from its top-left corner to the piece's foot. */
  hwnd: number | null;
  offset: { x: number; y: number };
  /** The spot on the glass it was thrown at and the seconds until it gets there. Until then it passes over every ledge. */
  aim: { x: number; y: number; t: number } | null;
}

interface Shape {
  /** Distance from its centre to the ground when it lies still, in units. */
  radius: number;
  bounce: number;
  /** It comes to rest at a multiple of this angle. 0 leaves it however it landed. */
  settle: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

const GRAVITY = 2300;
const LINGER = 22;
const MOST = 4;
/** How fast a thrown piece crosses the screen, in units per second. */
const THROW_SPEED = 1150;
const INK = "#2b2a2c";
const LINE = 2.2;

type Ctx = CanvasRenderingContext2D;

function inked(ctx: Ctx, fill: string) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = LINE;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

function crease(ctx: Ctx, points: number[], color: string) {
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = color;
  ctx.stroke();
}

const SHAPES: Record<JunkKind, Shape> = {
  // A crumpled sheet.
  paper: {
    radius: 10,
    bounce: 0.42,
    settle: 0,
    draw: (ctx) => {
      const rim = [10, -2, 7, -8, 1, -10.5, -6, -8.5, -10.5, -3, -9, 4, -4, 9.5, 3, 10, 9, 6];
      ctx.beginPath();
      ctx.moveTo(rim[0], rim[1]);
      for (let i = 2; i < rim.length; i += 2) ctx.lineTo(rim[i], rim[i + 1]);
      ctx.closePath();
      inked(ctx, "#f3efe6");
      crease(ctx, [-6, -8.5, -2, -2, 3, 10], "#b4aea2");
      crease(ctx, [7, -8, -2, -2, -9, 4], "#b4aea2");
      crease(ctx, [10, -2, 3, 2], "#b4aea2");
    },
  },
  // An opened tin with its label still on.
  tin: {
    radius: 9,
    bounce: 0.34,
    settle: Math.PI / 2,
    draw: (ctx) => {
      ctx.beginPath();
      ctx.roundRect(-9, -12, 18, 24, 2.5);
      inked(ctx, "#bcc2c8");
      ctx.fillStyle = "#d65a47";
      ctx.fillRect(-7.9, -5.5, 15.8, 11);
      ctx.fillStyle = "#f3e7c8";
      ctx.fillRect(-7.9, -1.5, 15.8, 3);
      crease(ctx, [-8, -8.5, 8, -8.5], "#8d9399");
      crease(ctx, [-8, 8.5, 8, 8.5], "#8d9399");
      // The lid, bent up on its last bit of rim.
      ctx.beginPath();
      ctx.moveTo(7.5, -12);
      ctx.lineTo(13, -18.5);
      ctx.lineTo(3, -19.5);
      ctx.closePath();
      inked(ctx, "#d3d8dc");
    },
  },
  // A banana peel, flaps splayed.
  peel: {
    radius: 6,
    bounce: 0.12,
    settle: Math.PI * 2,
    draw: (ctx) => {
      const flap = (x1: number, y1: number, x2: number, y2: number, x: number, y: number, back: number) => {
        ctx.beginPath();
        ctx.moveTo(-2.5, -6);
        ctx.bezierCurveTo(x1, y1, x2, y2, x, y);
        ctx.quadraticCurveTo(back, y - 5, 2.5, -6);
        ctx.closePath();
        inked(ctx, "#f1cf52");
      };
      flap(-10, -8, -15, -1, -16, 6, -8);
      flap(8, -8, 14, -1, 16, 6, 7);
      flap(-3, -2, -4, 3, 0, 6.5, 3);
      ctx.beginPath();
      ctx.roundRect(-2.4, -11.5, 4.8, 6.5, 1.5);
      inked(ctx, "#8a6a2c");
    },
  },
  // An apple core.
  core: {
    radius: 10.5,
    bounce: 0.25,
    settle: Math.PI / 2,
    draw: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(-7.5, -10.5);
      ctx.quadraticCurveTo(0, -13.5, 7.5, -10.5);
      ctx.quadraticCurveTo(1.5, 0, 7.5, 10.5);
      ctx.quadraticCurveTo(0, 12.5, -7.5, 10.5);
      ctx.quadraticCurveTo(-1.5, 0, -7.5, -10.5);
      ctx.closePath();
      inked(ctx, "#f4ead0");
      ctx.save();
      ctx.clip();
      ctx.fillStyle = "#d4483c";
      ctx.fillRect(-9, -14, 18, 5.2);
      ctx.fillRect(-9, 8, 18, 6);
      ctx.restore();
      ctx.stroke();
      ctx.fillStyle = "#4d3520";
      ctx.beginPath();
      ctx.ellipse(-1, -1.5, 1, 1.8, 0.2, 0, Math.PI * 2);
      ctx.ellipse(1.4, 1.8, 1, 1.8, -0.2, 0, Math.PI * 2);
      ctx.fill();
      crease(ctx, [0, -11.5, 2, -16], "#4d3520");
    },
  },
  // What is left of a fish.
  fishbone: {
    radius: 6.5,
    bounce: 0.2,
    settle: Math.PI,
    draw: (ctx) => {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const bones = () => {
        ctx.beginPath();
        ctx.moveTo(-6, 0);
        ctx.lineTo(13, 0);
        for (const x of [-2, 3, 8]) {
          const r = 6 - (x + 2) * 0.22;
          ctx.moveTo(x, -r);
          ctx.lineTo(x, r);
        }
      };
      bones();
      ctx.lineWidth = 5.6;
      ctx.strokeStyle = INK;
      ctx.stroke();
      // Tail.
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(18.5, -6.5);
      ctx.lineTo(18.5, 6.5);
      ctx.closePath();
      inked(ctx, "#f5f2ea");
      // Head.
      ctx.beginPath();
      ctx.moveTo(-5.5, -6.5);
      ctx.quadraticCurveTo(-17, -5, -18.5, 1);
      ctx.quadraticCurveTo(-14, 6.5, -5.5, 6.5);
      ctx.closePath();
      inked(ctx, "#f5f2ea");
      bones();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#f5f2ea";
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(-11.5, -1, 1.5, 0, Math.PI * 2);
      ctx.fill();
    },
  },
};

/** Draws a piece of junk centred on the origin, in units. */
export function drawJunk(ctx: Ctx, kind: JunkKind) {
  ctx.save();
  ctx.lineJoin = "round";
  SHAPES[kind].draw(ctx);
  ctx.restore();
}

/**
 * The junk Pesto has thrown out of his can. Each piece flies, bounces and
 * comes to rest on whatever ledge is under it, lies there a while and then
 * fades, so the desktop never fills up.
 */
export class Litter {
  items: Junk[] = [];
  /** Pixels per unit. */
  scale = 1.1;
  /** Called the first time a piece hits something. */
  onLand: ((junk: Junk) => void) | null = null;
  /** Called when a piece thrown at a spot bounces off it. */
  onHit: ((junk: Junk) => void) | null = null;

  constructor(readonly world: World) {}

  /** Throws a piece from a point with a velocity in pixels per second. */
  toss(x: number, y: number, vx: number, vy: number, kind: JunkKind = pick(JUNK_KINDS)): Junk {
    const junk: Junk = { kind, x, y, vx, vy, angle: rand(-1, 1), spin: sign(vx) * rand(5, 11), landed: false, resting: false, lain: 0, fade: 0, hwnd: null, offset: { x: 0, y: 0 }, aim: null };
    this.items.push(junk);
    return junk;
  }

  /** Throws a paper ball from a point so that it bounces off the glass exactly at another. */
  throwAt(x: number, y: number, tx: number, ty: number): Junk {
    const t = clamp(Math.hypot(tx - x, ty - y) / (THROW_SPEED * this.scale), 0.22, 0.7);
    const junk = this.toss(x, y, (tx - x) / t, (ty - y) / t - (GRAVITY * this.scale * t) / 2, "paper");
    junk.aim = { x: tx, y: ty, t };
    return junk;
  }

  update(dt: number) {
    const { world } = this;
    const v = world.virtual;
    const lying = this.items.filter((j) => j.resting);
    this.items = this.items.filter((j) => {
      const shape = SHAPES[j.kind];
      const r = shape.radius * this.scale;
      if (j.resting) {
        j.lain += dt;
        if (shape.settle) j.angle = approach(j.angle, Math.round(j.angle / shape.settle) * shape.settle, 14, dt);
        const win = world.window(j.hwnd);
        if (j.hwnd != null && win && win.state === "normal") {
          j.x = win.rect.x + j.offset.x;
          j.y = win.rect.y + j.offset.y - r;
        }
        const ground = world.ledgeBelow(j.x, j.y + r - 2);
        if (!ground || Math.abs(ground.y - (j.y + r)) > 3) {
          j.resting = false;
          j.hwnd = null;
        }
        // The oldest pieces go first once there are too many.
        const crowded = lying.length > MOST && lying.indexOf(j) < lying.length - MOST;
        if (j.lain > LINGER || crowded || j.fade > 0) j.fade += dt / 0.6;
        return j.fade < 1;
      }

      const before = j.y + r;
      j.vy += GRAVITY * this.scale * dt;
      j.x += j.vx * dt;
      j.y += j.vy * dt;
      j.angle += j.spin * dt;
      if (j.aim) {
        if ((j.aim.t -= dt) > 0) return true;
        j.x = j.aim.x;
        j.y = j.aim.y;
        j.aim = null;
        // Off the glass and back the way it came, with most of the throw gone out of it.
        j.vx *= -0.22;
        j.vy = -340 * this.scale;
        j.spin *= -0.5;
        this.onHit?.(j);
        return true;
      }
      if (j.x < v.x + r || j.x > v.x + v.w - r) {
        j.x = Math.max(v.x + r, Math.min(v.x + v.w - r, j.x));
        j.vx *= -0.5;
        j.spin *= -0.5;
      }
      if (j.vy > 0) {
        for (const l of world.ledges) {
          if (before > l.y + 0.5 || j.y + r < l.y || j.x < l.x1 || j.x > l.x2) continue;
          j.y = l.y - r;
          if (!j.landed) this.onLand?.(j);
          j.landed = true;
          if (j.vy > 260 * this.scale) {
            j.vy *= -shape.bounce;
            j.vx *= 0.6;
            j.spin = (j.vx / r) * 0.8;
          } else {
            j.resting = true;
            j.vx = j.vy = j.spin = 0;
            j.hwnd = l.hwnd;
            const win = world.window(l.hwnd);
            if (win) j.offset = { x: j.x - win.rect.x, y: l.y - win.rect.y };
          }
          break;
        }
      }
      return j.y < v.y + v.h + 300;
    });
  }
}
