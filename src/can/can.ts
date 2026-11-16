import { Spring, clamp01 } from "../pesto/math";

const INK = "#2b2a2c";
const BODY = "#a8a9ab";
const BODY_LIGHT = "#bcbdbf";
const GROOVE = "#8b8c8f";
const RIM = "#b6b7b9";
const LID = "#9c9da0";
const LID_LIGHT = "#b3b4b7";
const DARK = "#0c0c10";
const LINE = 2.8;

/** Lid opening (0..1) at which he peeks out. */
export const LID_PEEK = 0.14;
export const LID_OPEN = 1;
const MAX_ANGLE = 1.95;

/** Can geometry in can units: origin at the bottom centre, y grows downward. */
export const CAN = {
  height: 96,
  rimY: -96,
  topHalf: 43,
  bottomHalf: 34,
  /** Where his eyes sit when he peeks, in can units. */
  eyes: { x: -7, y: -106 },
};

type Ctx = CanvasRenderingContext2D;

/**
 * Pesto's home. It has a lid on a hinge that he pushes open, and it rattles
 * when he moves around inside.
 */
export class Can {
  x = 0;
  y = 0;
  /** Pixels per can unit. */
  scale = 1.1;
  /** Desired lid opening, 0 closed to 1 flipped fully back. */
  lid = 0;
  /** Whether his eyes show in the gap. */
  eyes = false;
  /** A cardboard sign hung on the front, or null. */
  sign: string | null = null;

  private lidSpring = new Spring(0, 15, 0.42);
  private rattle = 0;
  private rattlePhase = 0;

  /** Current lid opening after easing. */
  get opening() {
    return clamp01(this.lidSpring.x);
  }

  /** Shakes the can as if something moved inside. */
  shake(strength = 1) {
    this.rattle = Math.max(this.rattle, strength);
  }

  /** Slams the lid shut without the usual bounce. */
  slam() {
    this.lid = 0;
    this.lidSpring.v = -14;
  }

  update(dt: number) {
    this.lidSpring.step(this.lid, dt);
    if (this.lidSpring.x < 0) {
      this.lidSpring.x = 0;
      this.lidSpring.v = Math.abs(this.lidSpring.v) * 0.35;
    }
    this.rattle *= Math.exp(-dt * 3.2);
    this.rattlePhase += dt * 38;
  }

  /** Whether the can is visibly changing and needs repainting. */
  get lively() {
    return this.rattle > 0.01 || Math.abs(this.lidSpring.v) > 0.01 || Math.abs(this.lidSpring.x - this.lid) > 0.001;
  }

  private wobble(ctx: Ctx) {
    if (this.rattle > 0.01) {
      ctx.rotate(Math.sin(this.rattlePhase) * 0.045 * this.rattle);
      ctx.translate(Math.sin(this.rattlePhase * 1.3) * 1.6 * this.rattle, 0);
    }
  }

  private lidTransform(ctx: Ctx) {
    // Hinged at the right end of the rim.
    ctx.translate(CAN.topHalf + 3, CAN.rimY - 1);
    ctx.rotate(this.opening * MAX_ANGLE);
  }

  /** The lid, drawn with its hinge at the origin and extending left. */
  private drawLid(ctx: Ctx) {
    ctx.save();
    this.lidTransform(ctx);
    ctx.lineJoin = "round";
    // Handle.
    ctx.beginPath();
    ctx.roundRect(-64, -25, 36, 16, 5);
    ctx.fillStyle = LID;
    ctx.fill();
    ctx.lineWidth = LINE;
    ctx.strokeStyle = INK;
    ctx.stroke();
    // Plate.
    ctx.beginPath();
    ctx.roundRect(-97, -13, 102, 13, 5);
    ctx.fillStyle = LID;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = LID_LIGHT;
    ctx.fillRect(-97, -13, 102, 4.5);
    ctx.restore();
    ctx.stroke();
    ctx.restore();
  }

  private gapPath(ctx: Ctx) {
    const a = this.opening * MAX_ANGLE;
    const hx = CAN.topHalf + 3;
    const hy = CAN.rimY - 1;
    // Far end of the lid's underside.
    const lx = hx - Math.cos(a) * 97;
    const ly = hy - Math.sin(a) * 97;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(lx, ly);
    ctx.lineTo(-CAN.topHalf - 2, hy);
    ctx.closePath();
  }

  private drawMouth(ctx: Ctx) {
    ctx.beginPath();
    ctx.ellipse(0, CAN.rimY + 2, CAN.topHalf, 9, 0, 0, Math.PI * 2);
    ctx.fillStyle = DARK;
    ctx.fill();
    ctx.lineWidth = LINE;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }

  private drawBody(ctx: Ctx) {
    const t = CAN.topHalf;
    const b = CAN.bottomHalf;
    ctx.lineJoin = "round";
    const shell = () => {
      ctx.beginPath();
      ctx.moveTo(-t + 2, CAN.rimY + 6);
      ctx.lineTo(-b, -9);
      ctx.quadraticCurveTo(-b + 1, 0, -b + 10, 0);
      ctx.lineTo(b - 10, 0);
      ctx.quadraticCurveTo(b - 1, 0, b, -9);
      ctx.lineTo(t - 2, CAN.rimY + 6);
      ctx.closePath();
    };
    shell();
    ctx.fillStyle = BODY;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = BODY_LIGHT;
    ctx.beginPath();
    ctx.moveTo(t - 15, CAN.rimY);
    ctx.lineTo(t + 4, CAN.rimY);
    ctx.lineTo(b + 4, 2);
    ctx.lineTo(b - 8, 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    shell();
    ctx.lineWidth = LINE;
    ctx.strokeStyle = INK;
    ctx.stroke();

    ctx.strokeStyle = GROOVE;
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    for (const k of [-1, 0, 1]) {
      ctx.beginPath();
      ctx.moveTo(k * 20, CAN.rimY + 24);
      ctx.lineTo(k * 16.5, -15);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.roundRect(-t - 4, CAN.rimY - 1, (t + 4) * 2, 12, 4.5);
    ctx.fillStyle = RIM;
    ctx.fill();
    ctx.lineWidth = LINE;
    ctx.strokeStyle = INK;
    ctx.stroke();

    if (this.sign) {
      ctx.save();
      ctx.translate(0, -48);
      ctx.rotate(-0.06);
      ctx.beginPath();
      ctx.roundRect(-30, -13, 60, 26, 3);
      ctx.fillStyle = "#c9a26b";
      ctx.fill();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = "#4a3620";
      ctx.stroke();
      ctx.fillStyle = "#33240f";
      ctx.font = "700 10px 'Comic Sans MS', 'Segoe Print', cursive";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.sign, 0, 1);
      ctx.restore();
    }
  }

  /**
   * Draws the whole can as one piece, for when Pesto is inside or away.
   * `drawEyes` is called with the context positioned for his peeking eyes.
   */
  drawWhole(ctx: Ctx, drawEyes?: (ctx: Ctx) => void) {
    ctx.save();
    this.wobble(ctx);
    if (this.opening > 0.4) {
      // Flipped back: the lid stands behind and the mouth is open to the sky.
      this.drawLid(ctx);
      this.drawMouth(ctx);
    } else {
      if (this.opening > 0.012) {
        this.gapPath(ctx);
        // The darkness thins out toward the open left side of the gap.
        const left = -CAN.topHalf - 2;
        const shade = ctx.createLinearGradient(left, 0, left + 26, 0);
        shade.addColorStop(0, "rgba(12, 12, 16, 0)");
        shade.addColorStop(1, DARK);
        ctx.fillStyle = shade;
        ctx.fill();
        if (this.eyes && drawEyes && this.opening > 0.05) {
          ctx.save();
          this.gapPath(ctx);
          ctx.clip();
          drawEyes(ctx);
          ctx.restore();
        }
      }
      this.drawLid(ctx);
    }
    this.drawBody(ctx);
    ctx.restore();
  }

  /** The parts behind Pesto while he climbs in or out: the lid and the dark mouth. */
  drawBack(ctx: Ctx) {
    ctx.save();
    this.wobble(ctx);
    this.drawLid(ctx);
    this.drawMouth(ctx);
    ctx.restore();
  }

  /** The parts in front of Pesto while he climbs in or out. */
  drawFront(ctx: Ctx) {
    ctx.save();
    this.wobble(ctx);
    this.drawBody(ctx);
    ctx.restore();
  }
}
