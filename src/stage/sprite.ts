import { StickerPainter } from "../render/sticker";

/** One canvas element positioned in virtual-desktop pixels. */
export class Sprite {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly painter: StickerPainter;
  private shown = true;

  constructor(
    parent: HTMLElement,
    readonly width: number,
    readonly height: number,
    /** Where the entity's origin sits inside the canvas. */
    readonly ox: number,
    readonly oy: number,
    z: number,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    Object.assign(this.canvas.style, { position: "absolute", left: "0", top: "0", zIndex: String(z), willChange: "transform" });
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.painter = new StickerPainter(width, height);
  }

  moveTo(x: number, y: number) {
    this.canvas.style.transform = `translate3d(${Math.round(x - this.ox)}px, ${Math.round(y - this.oy)}px, 0)`;
  }

  show(on: boolean) {
    if (on === this.shown) return;
    this.shown = on;
    this.canvas.style.display = on ? "" : "none";
  }

  remove() {
    this.canvas.remove();
  }

  /** Thins out part of what was painted with an ordered dither. `amount` 0 leaves it, 1 removes it. Sprite-local pixels. */
  dissolve(x: number, y: number, w: number, h: number, amount: number) {
    const pattern = dither(this.ctx, amount);
    if (!pattern) return;
    this.ctx.save();
    this.ctx.globalCompositeOperation = "destination-out";
    this.ctx.fillStyle = pattern;
    this.ctx.fillRect(x, y, w, h);
    this.ctx.restore();
  }

  paint(border: number, art: (ctx: CanvasRenderingContext2D) => void) {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.painter.paint(
      this.ctx,
      0,
      0,
      (c) => {
        c.translate(this.ox, this.oy);
        art(c);
      },
      { border, shadow: true },
    );
  }
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const patterns = new Map<number, CanvasPattern | null>();

/** A 4×4 ordered-dither fill covering `amount` of the pixels. */
function dither(ctx: CanvasRenderingContext2D, amount: number): CanvasPattern | null {
  const level = Math.round(Math.max(0, Math.min(1, amount)) * 16);
  if (level === 0) return null;
  let pattern = patterns.get(level);
  if (pattern === undefined) {
    const tile = document.createElement("canvas");
    tile.width = tile.height = 4;
    const t = tile.getContext("2d")!;
    for (let i = 0; i < 16; i++) if (BAYER[i] < level) t.fillRect(i % 4, i >> 2, 1, 1);
    pattern = ctx.createPattern(tile, "repeat");
    patterns.set(level, pattern);
  }
  return pattern;
}
