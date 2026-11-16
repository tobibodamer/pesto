import type { World } from "../world/world";
import { call } from "./bridge";
import type { Rect } from "./types";

/** Bars drawn as bars in nearly every app: both their top and bottom lines are visible. */
const BARS = new Set(["toolbar", "tabs", "menu", "statusbar", "header"]);
/** Boxes with a visible frame, at least along the top. */
const BOXES = new Set(["edit", "document"]);

/**
 * The visible lines among a window's parts, as zero-height rects. Panes,
 * groups and custom blocks are left out: in web and Electron apps they are
 * layout boxes with no border, and standing on them looks like standing on air.
 */
export function visibleLines(parts: (Rect & { kind: string })[]): Rect[] {
  return parts.flatMap((p) => {
    if (BARS.has(p.kind)) return [{ ...p, h: 0 }, { ...p, y: p.y + p.h, h: 0 }];
    if (BOXES.has(p.kind)) return [{ ...p, h: 0 }];
    return [];
  });
}

/**
 * Learns the inside of windows on demand: one bounded UI Automation scan per
 * window, kept by the world until the window resizes or changes title.
 */
export class Surveyor {
  private inFlight = new Set<number>();
  /** Last time each window failed or came back empty, so a window with nothing to offer is not asked again at once. */
  private emptyAt = new Map<number, number>();

  constructor(private world: World) {}

  /** Scans a window unless its inside is already known or being looked at. */
  want(hwnd: number | null | undefined) {
    const w = this.world;
    if (hwnd == null || this.inFlight.has(hwnd) || w.hasSkeleton(hwnd)) return;
    if (w.time - (this.emptyAt.get(hwnd) ?? -Infinity) < 20) return;
    this.inFlight.add(hwnd);
    call("window_skeleton", { hwnd })
      .then((parts) => {
        const lines = visibleLines(parts);
        if (lines.length) w.setSkeleton(hwnd, lines);
        else this.emptyAt.set(hwnd, w.time);
      })
      .catch(() => this.emptyAt.set(hwnd, w.time))
      .finally(() => this.inFlight.delete(hwnd));
  }

  /** The window under a point. */
  wantAt(x: number, y: number) {
    this.want(this.world.windowAt(x, y)?.hwnd);
  }

  /** The few windows he might go to next on a monitor: the visible ones near the top of the z-order. */
  wantAround(monitor: number, count = 3) {
    for (const win of this.world.windows.filter((x) => x.monitor === monitor && x.state !== "minimized").slice(0, count)) this.want(win.hwnd);
  }
}
