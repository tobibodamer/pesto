import type { World } from "../world/world";
import { call } from "./bridge";
import type { Rect } from "./types";

/** Something inside a window that he has seen and can point at. */
export interface Seen {
  /** Short id a model can use as a target: e1, e2, … Never reused. */
  id: string;
  hwnd: number;
  kind: string;
  name: string;
  /** Relative to the window's top-left corner, so it rides along when the window moves. */
  rect: Rect;
  /** What the `element_*` commands know it by. Good until its window is looked into again. */
  key: number;
}

interface Glance {
  hwnd: number;
  at: number;
  w: number;
  h: number;
  items: Seen[];
}

/** A second look at the same window this soon reuses the first. */
const FRESH = 3;
const REMEMBER = 2000;

/**
 * What he can see inside windows: their buttons, tabs, fields and texts, each
 * with a place. Nothing is scanned until someone looks, one bounded UI
 * Automation scan per look.
 */
export class Sight {
  /** Called with each window that is looked into. */
  onLook: ((hwnd: number) => void) | null = null;

  private byId = new Map<string, Seen>();
  private ids = new Map<string, string>();
  private glances = new Map<number, Glance>();
  private count = 0;

  constructor(private world: World) {}

  /** Everything visible in a window, the app's own bars and buttons first. Empty for apps that tell UI Automation nothing. */
  async look(hwnd: number): Promise<Seen[]> {
    const w = this.world;
    const win = w.window(hwnd);
    if (!win || win.state === "minimized") return [];
    const last = this.glances.get(hwnd);
    if (last && w.time - last.at < FRESH && this.current(last)) return last.items;
    this.onLook?.(hwnd);
    const found = await call("window_elements", { hwnd }).catch(() => []);
    // The window may have moved while it was being read; the scan is in screen pixels.
    const now = w.window(hwnd) ?? win;
    const items = found.map((e) => this.remember(hwnd, e.kind, e.name, { x: e.x - now.rect.x, y: e.y - now.rect.y, w: e.w, h: e.h }, e.key));
    this.glances.set(hwnd, { hwnd, at: w.time, w: now.rect.w, h: now.rect.h, items });
    return items;
  }

  /** Call when something has changed what a window shows: the next look reads it afresh. */
  stale(hwnd: number) {
    const glance = this.glances.get(hwnd);
    if (glance) glance.at = -Infinity;
  }

  get(id: string): Seen | null {
    return this.byId.get(id) ?? null;
  }

  /** Where something he saw is now, as an offset into its window. Null once the window has gone or changed shape. */
  locate(id: string): { window: number; at: { x: number; y: number } } | null {
    const seen = this.byId.get(id);
    const glance = seen && this.glances.get(seen.hwnd);
    if (!seen || !glance || !this.current(glance)) return null;
    return { window: seen.hwnd, at: { x: seen.rect.x + seen.rect.w / 2, y: seen.rect.y + seen.rect.h / 2 } };
  }

  /** Whether the window still looks as it did when he looked: there, and the same size. */
  private current(glance: Glance) {
    const win = this.world.window(glance.hwnd);
    return !!win && win.state !== "minimized" && win.rect.w === glance.w && win.rect.h === glance.h;
  }

  /** The same thing seen again keeps its id. */
  private remember(hwnd: number, kind: string, name: string, rect: Rect, key: number): Seen {
    const same = `${hwnd}|${kind}|${name}|${rect.x},${rect.y}`;
    let id = this.ids.get(same);
    if (!id) {
      id = `e${++this.count}`;
      this.ids.set(same, id);
      if (this.ids.size > REMEMBER) {
        const [oldKey, oldId] = this.ids.entries().next().value!;
        this.ids.delete(oldKey);
        this.byId.delete(oldId);
      }
    }
    const seen = { id, hwnd, kind, name, rect, key };
    this.byId.set(id, seen);
    return seen;
  }
}
