import { Director } from "../brain/director";
import { CAN, Can } from "../can/can";
import { Actor } from "../pesto/actor";
import { StickerPainter } from "../render/sticker";
import type { Rect } from "../sense/types";
import { World } from "../world/world";
import { Paper } from "./bubble";
import { Menu } from "./menu";

/** One canvas element positioned in virtual-desktop pixels. */
class Sprite {
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

const PAD = 14;

const CAN_KEY = "pesto.can";

function recall(): { x: number; y: number } | null {
  try {
    const at = JSON.parse(localStorage.getItem(CAN_KEY) ?? "null");
    return at && Number.isFinite(at.x) && Number.isFinite(at.y) ? at : null;
  } catch {
    return null;
  }
}

function remember(at: { x: number; y: number }) {
  try {
    localStorage.setItem(CAN_KEY, JSON.stringify(at));
  } catch {
    // Without storage the can simply returns to its corner next time.
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

function overlap(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** What is left of `a` once `b` is cut out of it. */
function without(a: Rect, b: Rect): Rect[] {
  const cut = overlap(a, b);
  if (!cut) return [a];
  const out: Rect[] = [];
  if (cut.y > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: cut.y - a.y });
  if (cut.y + cut.h < a.y + a.h) out.push({ x: a.x, y: cut.y + cut.h, w: a.w, h: a.y + a.h - cut.y - cut.h });
  if (cut.x > a.x) out.push({ x: a.x, y: cut.y, w: cut.x - a.x, h: cut.h });
  if (cut.x + cut.w < a.x + a.w) out.push({ x: cut.x + cut.w, y: cut.y, w: a.x + a.w - cut.x - cut.w, h: cut.h });
  return out;
}

/** How much of him dissolves over a taskbar when the cursor comes for what is under him. */
const VEIL = 0.82;
const VEIL_REACH = 70;
/** Seconds the cursor has to rest on him before he takes it as wanting what is behind him. */
const YIELD_AFTER = 0.45;

/**
 * The whole scene: the world model, the can, Pesto, and the sprites that
 * draw them. `root` is a container whose coordinate space is physical
 * virtual-desktop pixels, offset so that the virtual desktop's corner is (0,0).
 */
export class Stage {
  readonly world = new World();
  readonly can = new Can();
  readonly actor = new Actor(this.world, this.can);
  readonly director = new Director(this.world, this.actor, this.can);

  readonly paper: Paper;
  readonly menu: Menu;

  private pesto: Sprite;
  private canBack: Sprite;
  private canFront: Sprite;
  private canDirty = true;
  private wasSplit = false;
  private border = 1.5;
  private veil = 0;
  private carry: { dx: number; dy: number } | null = null;
  private rest = 0;
  private ghost = 0;

  constructor(root: HTMLElement, options: { scale?: number; border?: number } = {}) {
    if (options.scale) this.actor.scale = options.scale;
    if (options.border != null) this.border = options.border;
    const s = this.actor.scale;
    const cs = this.can.scale;
    this.canBack = new Sprite(root, Math.ceil(190 * cs) + PAD * 2, Math.ceil(215 * cs) + PAD * 2, 72 * cs + PAD, 203 * cs + PAD, 1);
    this.pesto = new Sprite(root, Math.ceil(310 * s) + PAD * 2, Math.ceil(300 * s) + PAD * 2, 155 * s + PAD, 240 * s + PAD, 2);
    this.canFront = new Sprite(root, Math.ceil(110 * cs) + PAD * 2, Math.ceil(110 * cs) + PAD * 2, 55 * cs + PAD, 103 * cs + PAD, 3);
    this.canFront.show(false);
    this.paper = new Paper(root);
    this.menu = new Menu(root);
    this.world.on("monitors", () => this.placeCan());
    this.world.on("mouseDown", (e) => {
      const m = this.menu.rect;
      const v = this.world.virtual;
      if (m && !(e.x - v.x >= m.x && e.x - v.x <= m.x + m.w && e.y - v.y >= m.y && e.y - v.y <= m.y + m.h)) this.menu.close();
      if (e.buttons & 1 && !m && this.overCan(e.x, e.y) && !this.overPesto(e.x, e.y)) this.carry = { dx: this.can.x - e.x, dy: this.can.y - e.y };
    });
    this.world.on("mouseUp", () => this.carry && this.setCanDown());
  }

  /** White sticker border around Pesto and the can, in character units. 0 removes it. */
  get stickerBorder() {
    return this.border;
  }

  set stickerBorder(units: number) {
    this.border = Math.max(0, units);
    this.canDirty = true;
  }

  /** Stands the can where it was last put, or in the bottom-right corner of the primary monitor. */
  placeCan() {
    const m = this.world.primary;
    if (!m) return;
    const saved = recall();
    if (saved && this.world.monitorAt(saved.x, saved.y - 20)) {
      this.can.x = saved.x;
      this.can.y = saved.y;
    } else {
      this.can.x = m.work.x + m.work.w - 150;
      this.can.y = m.work.y + m.work.h;
    }
    this.canDirty = true;
    if (this.actor.mode === "can") this.actor.vanish();
  }

  /** True while the can is being carried by the mouse. */
  get carrying() {
    return this.carry != null;
  }

  /** Lets go of the can: it drops onto whatever ledge is under it and stays there from now on. */
  private setCanDown() {
    this.carry = null;
    const { can, world } = this;
    const ledge = world.ledgeBelow(can.x, can.y - 30, 30);
    if (ledge) {
      const half = 60 * can.scale;
      can.x = Math.max(ledge.x1 + half, Math.min(ledge.x2 - half, can.x));
      can.y = ledge.y;
    } else {
      const m = world.monitorAt(can.x, can.y - 20) ?? world.primary;
      if (m) can.y = m.work.y + m.work.h;
    }
    can.shake(0.7);
    this.actor.cue("clank");
    this.canDirty = true;
    remember({ x: can.x, y: can.y });
  }

  private overCan(x: number, y: number) {
    const cs = this.can.scale;
    return x > this.can.x - 50 * cs && x < this.can.x + 50 * cs && y > this.can.y - 125 * cs && y < this.can.y;
  }

  private overPesto(x: number, y: number) {
    const hit = this.actor.hitRect;
    return !!hit && !this.yielding && x > hit.x && x < hit.x + hit.w && y > hit.y && y < hit.y + hit.h;
  }

  /** The mouse cursor to show while it is over the overlay. */
  get cursor(): string {
    if (this.carrying || this.actor.mode === "held") return "grabbing";
    const { x, y } = this.world.cursor;
    return this.overPesto(x, y) || this.overCan(x, y) ? "grab" : "default";
  }

  step(dt: number) {
    this.world.tick(dt);
    if (this.carry) {
      this.can.x = this.world.cursor.x + this.carry.dx;
      this.can.y = this.world.cursor.y + this.carry.dy;
      this.canDirty = true;
    }
    this.can.update(dt);
    this.director.update(dt);
    this.actor.update(dt);

    const covered = this.covered();
    const { x, y } = this.world.cursor;
    const near = covered.some((r) => x > r.x - VEIL_REACH && x < r.x + r.w + VEIL_REACH && y > r.y - VEIL_REACH && y < r.y + r.h + VEIL_REACH);
    this.veil += ((near ? 1 : 0) - this.veil) * Math.min(1, dt * 12);

    // A moving cursor is for him: petting, poking, grabbing. One that comes to
    // rest on him wants what he is standing in front of, so he thins out and
    // lets clicks through until it leaves.
    const hit = this.actor.hitRect;
    const cursor = this.world.cursor;
    const on = !!hit && this.actor.mode !== "held" && x > hit.x && x < hit.x + hit.w && y > hit.y && y < hit.y + hit.h;
    if (!on) this.rest = 0;
    else if (this.yielding || (cursor.speed < 45 && !cursor.buttons)) this.rest += dt;
    else this.rest = 0;
    this.ghost += ((this.yielding ? 1 : 0) - this.ghost) * Math.min(1, dt * 10);
  }

  /** True while he is letting the mouse through to whatever is behind him. */
  get yielding() {
    return this.rest > YIELD_AFTER;
  }

  /** The taskbars and other reserved strips at the screen edges: the parts of each monitor outside its work area. */
  private bars(): Rect[] {
    return this.world.monitors.flatMap((m) => without(m.rect, m.work));
  }

  /** Where his sprite lies over a taskbar, in world pixels. */
  private covered(): Rect[] {
    if (!this.actor.visible) return [];
    const p = this.pesto;
    const sprite = { x: this.actor.x - p.ox, y: this.actor.y - p.oy, w: p.width, h: p.height };
    return this.bars().flatMap((bar) => overlap(sprite, bar) ?? []);
  }

  render() {
    const { actor, can, world } = this;
    const vx = world.virtual.x;
    const vy = world.virtual.y;
    const cs = can.scale;
    const canBorder = this.border * 0.82;
    const split = actor.mode === "emerge" || actor.clipY != null;

    if (split !== this.wasSplit || can.lively || can.eyes || this.canDirty) {
      this.canDirty = can.lively;
      this.wasSplit = split;
      this.canFront.show(split);
      this.canBack.moveTo(can.x - vx, can.y - vy);
      this.canFront.moveTo(can.x - vx, can.y - vy);
      if (split) {
        this.canBack.paint(canBorder, (c) => {
          c.scale(cs, cs);
          can.drawBack(c);
        });
        this.canFront.paint(canBorder, (c) => {
          c.scale(cs, cs);
          can.drawFront(c);
        });
      } else {
        this.canBack.paint(canBorder, (c) => {
          c.scale(cs, cs);
          can.drawWhole(c, (e) => {
            const k = 0.62;
            e.translate(CAN.eyes.x, CAN.eyes.y + 96.4 * k);
            e.scale(k, k);
            actor.puppet.eyesOnly = true;
            actor.puppet.draw(e);
            actor.puppet.eyesOnly = false;
          });
        });
      }
    }

    const crown = this.crown;
    const mon = world.monitorAt(crown.x, crown.y + 40);
    this.paper.update(
      { x: crown.x - vx, y: crown.y - vy },
      mon ? { x: mon.work.x - vx, y: mon.work.y - vy, w: mon.work.w, h: mon.work.h } : null,
      world.time,
    );

    this.pesto.show(actor.visible);
    if (actor.visible) {
      const s = actor.scale;
      this.pesto.moveTo(actor.x - vx, actor.y - vy);
      this.pesto.paint(this.border * s, (c) => {
        if (actor.clipY != null) {
          c.beginPath();
          c.rect(-1000, -1000, 2000, 1000 + (actor.clipY - actor.y));
          c.clip();
        }
        c.scale(s, s);
        actor.puppet.draw(c);
      });
      if (this.ghost > 0.03) this.pesto.dissolve(0, 0, this.pesto.width, this.pesto.height, this.ghost * 0.75);
      else if (this.veil > 0.03) {
        const left = actor.x - this.pesto.ox;
        const top = actor.y - this.pesto.oy;
        for (const r of this.covered()) this.pesto.dissolve(Math.round(r.x - left), Math.round(r.y - top), Math.ceil(r.w), Math.ceil(r.h), this.veil * VEIL);
      }
    }
  }

  /** The top of his head, or of the can while he is inside it, in world pixels. */
  get crown() {
    const { actor, can } = this;
    return actor.visible ? { x: actor.x, y: actor.y - 152 * actor.scale } : { x: can.x, y: can.y - 128 * can.scale };
  }

  /**
   * Screen areas where the overlay should catch the mouse instead of passing
   * it through. Taskbars are never among them: whatever he stands in front
   * of there stays clickable. Nor is he, while he is yielding.
   */
  hitRegions(): Rect[] {
    let regions: Rect[] = [];
    const hit = this.actor.hitRect;
    if (hit && !this.yielding) regions.push(hit);
    const cs = this.can.scale;
    regions.push({ x: this.can.x - 50 * cs, y: this.can.y - 125 * cs, w: 100 * cs, h: 125 * cs });
    for (const bar of this.bars()) regions = regions.flatMap((r) => without(r, bar));
    const m = this.menu.rect;
    if (m) regions.push({ x: m.x + this.world.virtual.x, y: m.y + this.world.virtual.y, w: m.w, h: m.h });
    return regions;
  }
}
