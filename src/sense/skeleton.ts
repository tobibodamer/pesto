import type { World } from "../world/world";
import { call } from "./bridge";

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
        if (parts.length) w.setSkeleton(hwnd, parts);
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
