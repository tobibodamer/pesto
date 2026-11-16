/**
 * Everything Pesto owns is drawn as a die-cut sticker: artwork, a white
 * border around its silhouette, and a soft shadow so it reads on any
 * wallpaper or window. Without the border only the shadow lifts it off
 * the screen.
 */
export interface StickerOptions {
  /** Border thickness in canvas pixels. 0 leaves the artwork without one. */
  border: number;
  shadow: boolean;
}

const RING = 18;

export class StickerPainter {
  private ink: HTMLCanvasElement;
  private sil: HTMLCanvasElement;
  private rim: HTMLCanvasElement;
  private inkCtx: CanvasRenderingContext2D;
  private silCtx: CanvasRenderingContext2D;
  private rimCtx: CanvasRenderingContext2D;

  constructor(
    public width: number,
    public height: number,
  ) {
    const make = () => {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      return c;
    };
    this.ink = make();
    this.sil = make();
    this.rim = make();
    this.inkCtx = this.ink.getContext("2d")!;
    this.silCtx = this.sil.getContext("2d")!;
    this.rimCtx = this.rim.getContext("2d")!;
  }

  /**
   * Draws `art` into `dest` at (dx, dy) as a sticker. `art` receives a
   * cleared context the size of this painter.
   */
  paint(
    dest: CanvasRenderingContext2D,
    dx: number,
    dy: number,
    art: (ctx: CanvasRenderingContext2D) => void,
    options: StickerOptions,
  ) {
    const { width: w, height: h } = this;
    const ink = this.inkCtx;
    ink.setTransform(1, 0, 0, 1, 0, 0);
    ink.clearRect(0, 0, w, h);
    ink.save();
    art(ink);
    ink.restore();

    if (options.border > 0) {
      const sil = this.silCtx;
      sil.globalCompositeOperation = "source-over";
      sil.clearRect(0, 0, w, h);
      sil.drawImage(this.ink, 0, 0);
      sil.globalCompositeOperation = "source-in";
      sil.fillStyle = "#fff";
      sil.fillRect(0, 0, w, h);

      const rim = this.rimCtx;
      rim.clearRect(0, 0, w, h);
      for (let i = 0; i < RING; i++) {
        const a = (i / RING) * Math.PI * 2;
        rim.drawImage(this.sil, Math.cos(a) * options.border, Math.sin(a) * options.border);
      }
      rim.drawImage(this.sil, 0, 0);

      dest.save();
      if (options.shadow) {
        dest.shadowColor = "rgba(20, 14, 10, 0.34)";
        dest.shadowBlur = Math.max(6, options.border * 1.6);
        dest.shadowOffsetY = Math.max(2, options.border * 0.45);
      }
      dest.drawImage(this.rim, dx, dy);
      dest.restore();
    } else if (options.shadow) {
      dest.save();
      dest.shadowColor = "rgba(20, 14, 10, 0.42)";
      dest.shadowBlur = 7;
      dest.shadowOffsetY = 2.5;
      dest.drawImage(this.ink, dx, dy);
      dest.restore();
      return;
    }
    dest.drawImage(this.ink, dx, dy);
  }
}
