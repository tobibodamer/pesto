import type {
  AudioEvent,
  CursorEvent,
  FocusEvent,
  FocusedElement,
  MediaEvent,
  MonitorInfo,
  MonitorsEvent,
  Rect,
  SystemEvent,
  WindowInfo,
  WindowsEvent,
} from "../sense/types";

/** A horizontal edge Pesto can stand, walk and sit on. */
export interface Ledge {
  id: string;
  x1: number;
  x2: number;
  y: number;
  /** The window whose top edge this is, or null for a monitor's floor. */
  hwnd: number | null;
}

/** Room he needs above a ledge to stand on it. */
const HEADROOM = 110;
const MIN_LEDGE = 70;
/** Element tops this close to the window's own top, or to each other, count as the same ledge. */
const SAME_EDGE = 30;
const MAX_INNER_LEDGES = 24;

/** Ledges found inside a window, relative to its top-left, valid while it keeps its size and title. */
interface Skeleton {
  w: number;
  h: number;
  title: string;
  edges: { x1: number; x2: number; y: number }[];
}

/**
 * Everything Pesto knows about the desktop right now, in physical
 * virtual-desktop pixels, plus the terrain derived from it.
 */
export class World {
  monitors: MonitorInfo[] = [];
  virtual: Rect = { x: 0, y: 0, w: 1920, h: 1080 };
  windows: WindowInfo[] = [];
  foreground: number | null = null;
  moving: number | null = null;
  cursor = { x: 0, y: 0, buttons: 0, vx: 0, vy: 0, speed: 0, lastMove: 0 };
  audio: AudioEvent = { out: 0, mic: 0, sessions: [] };
  media: MediaEvent = { sessions: [] };
  system: SystemEvent = { idleMs: 0, battery: null, cpu: 0 };
  ledges: Ledge[] = [];
  /** The focused element inside the foreground app. */
  focus: FocusedElement | null = null;
  /** World time the caret last moved: a sign someone is typing. */
  caretMovedAt = -Infinity;
  /** Seconds since the stage started; advanced by the stage. */
  time = 0;

  private listeners = new Map<string, Set<(payload: any) => void>>();
  private byHwnd = new Map<number, WindowInfo>();
  private skeletons = new Map<number, Skeleton>();
  private lastCursorT = 0;

  on<K extends keyof WorldEvents>(name: K, fn: (payload: WorldEvents[K]) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit<K extends keyof WorldEvents>(name: K, payload: WorldEvents[K]) {
    this.listeners.get(name)?.forEach((fn) => fn(payload));
  }

  setMonitors(e: MonitorsEvent) {
    this.monitors = e.monitors;
    this.virtual = e.virtual;
    this.rebuildLedges();
    this.emit("monitors", e);
  }

  setWindows(e: WindowsEvent) {
    const before = this.byHwnd;
    const prevForeground = this.foreground;
    this.windows = e.windows;
    this.moving = e.moving;
    this.foreground = e.foreground;
    this.byHwnd = new Map(e.windows.map((w) => [w.hwnd, w]));
    for (const [hwnd, s] of this.skeletons) {
      const w = this.byHwnd.get(hwnd);
      if (!w || w.state === "minimized" || w.rect.w !== s.w || w.rect.h !== s.h || w.title !== s.title) this.skeletons.delete(hwnd);
    }
    this.rebuildLedges();

    for (const w of e.windows) {
      const old = before.get(w.hwnd);
      if (!old) this.emit("windowOpened", w);
      else if (old.title !== w.title) this.emit("titleChanged", { window: w, previous: old.title });
      if (old && old.state !== "minimized" && w.state === "minimized") this.emit("windowMinimized", w);
    }
    for (const [hwnd, old] of before) if (!this.byHwnd.has(hwnd)) this.emit("windowClosed", old);
    if (e.foreground !== prevForeground) {
      const w = e.foreground == null ? null : (this.byHwnd.get(e.foreground) ?? null);
      this.emit("focusChanged", w);
    }
  }

  setCursor(e: CursorEvent) {
    const c = this.cursor;
    const dt = Math.max(0.004, this.time - this.lastCursorT);
    const dx = e.x - c.x;
    const dy = e.y - c.y;
    if (dx !== 0 || dy !== 0) {
      // Smoothed so a single jittery sample does not read as a flick.
      c.vx = c.vx * 0.5 + (dx / dt) * 0.5;
      c.vy = c.vy * 0.5 + (dy / dt) * 0.5;
      c.lastMove = this.time;
      this.lastCursorT = this.time;
    }
    const pressed = e.buttons & ~c.buttons;
    const released = c.buttons & ~e.buttons;
    c.x = e.x;
    c.y = e.y;
    c.buttons = e.buttons;
    if (pressed) this.emit("mouseDown", { x: e.x, y: e.y, buttons: pressed });
    if (released) this.emit("mouseUp", { x: e.x, y: e.y, buttons: released });
  }

  setAudio(e: AudioEvent) {
    const before = this.audio.out;
    this.audio = e;
    this.emit("audio", { now: e.out, before });
  }

  setMedia(e: MediaEvent) {
    this.media = e;
    this.emit("media", e);
  }

  /** Whether a window's inside is known and still current. */
  hasSkeleton(hwnd: number) {
    return this.skeletons.has(hwnd);
  }

  /**
   * Takes the structural parts of a window (screen rects) and keeps their top
   * edges as ledges, relative to the window so they ride along when it moves.
   */
  setSkeleton(hwnd: number, parts: Rect[]) {
    const w = this.byHwnd.get(hwnd);
    if (!w) return;
    const r = w.rect;
    const edges = parts
      .map((p) => ({ x1: Math.max(p.x, r.x) - r.x, x2: Math.min(p.x + p.w, r.x + r.w) - r.x, y: p.y - r.y }))
      .filter((e) => e.x2 - e.x1 >= MIN_LEDGE && e.y >= SAME_EDGE && e.y <= r.h - SAME_EDGE)
      .sort((a, b) => a.y - b.y || a.x1 - b.x1);
    const merged: Skeleton["edges"] = [];
    for (const e of edges) {
      const same = merged.find((m) => Math.abs(m.y - e.y) <= 4 && e.x1 <= m.x2 + 8 && e.x2 >= m.x1 - 8);
      if (same) {
        same.x1 = Math.min(same.x1, e.x1);
        same.x2 = Math.max(same.x2, e.x2);
      } else merged.push({ ...e });
    }
    // Wide edges first: those are the shelves worth having when there are too many.
    merged.sort((a, b) => b.x2 - b.x1 - (a.x2 - a.x1));
    this.skeletons.set(hwnd, { w: r.w, h: r.h, title: w.title, edges: merged.slice(0, MAX_INNER_LEDGES).sort((a, b) => a.y - b.y || a.x1 - b.x1) });
    this.rebuildLedges();
  }

  /** The topmost visible window under a point. */
  windowAt(x: number, y: number): WindowInfo | null {
    for (const w of this.windows) {
      if (w.state === "minimized") continue;
      const r = w.rect;
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return w;
    }
    return null;
  }

  setSystem(e: SystemEvent) {
    this.system = e;
  }

  setFocus(e: FocusEvent) {
    const before = this.focus;
    const now = e.element;
    this.focus = now;
    if (!now) return;
    const same = before && before.hwnd === now.hwnd && before.kind === now.kind && before.name === now.name && sameRect(before.rect, now.rect);
    if (!same) this.emit("elementFocused", now);
    else if (now.caret && (!before.caret || !sameRect(before.caret, now.caret))) {
      this.caretMovedAt = this.time;
      this.emit("caretMoved", now);
    }
  }

  /** Whether the caret has moved in the last couple of seconds. */
  get typing() {
    return this.time - this.caretMovedAt < 2;
  }

  /** Where the action is in the focused app: the caret if there is one, else the middle of the focused element. */
  get actionPoint(): { x: number; y: number } | null {
    const f = this.focus;
    if (!f) return null;
    if (f.caret) return { x: f.caret.x + f.caret.w / 2, y: f.caret.y + f.caret.h / 2 };
    if (f.rect.w <= 0 || f.rect.h <= 0) return null;
    return { x: f.rect.x + f.rect.w / 2, y: f.rect.y + Math.min(f.rect.h / 2, 40) };
  }

  /** Advances time and lets cursor velocity decay when no samples arrive. */
  tick(dt: number) {
    this.time += dt;
    const c = this.cursor;
    if (this.time - c.lastMove > 0.05) {
      c.vx *= Math.exp(-dt * 18);
      c.vy *= Math.exp(-dt * 18);
    }
    c.speed = Math.hypot(c.vx, c.vy);
  }

  window(hwnd: number | null): WindowInfo | null {
    return hwnd == null ? null : (this.byHwnd.get(hwnd) ?? null);
  }

  get focused(): WindowInfo | null {
    return this.window(this.foreground);
  }

  monitorAt(x: number, y: number): MonitorInfo | null {
    for (const m of this.monitors) {
      if (x >= m.rect.x && x < m.rect.x + m.rect.w && y >= m.rect.y && y < m.rect.y + m.rect.h) return m;
    }
    let best: MonitorInfo | null = null;
    let bestD = Infinity;
    for (const m of this.monitors) {
      const cx = Math.max(m.rect.x, Math.min(x, m.rect.x + m.rect.w));
      const cy = Math.max(m.rect.y, Math.min(y, m.rect.y + m.rect.h));
      const d = Math.hypot(x - cx, y - cy);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  get primary(): MonitorInfo | null {
    return this.monitors.find((m) => m.primary) ?? this.monitors[0] ?? null;
  }

  ledge(id: string | null): Ledge | null {
    return id == null ? null : (this.ledges.find((l) => l.id === id) ?? null);
  }

  /** The highest ledge at or below `y` that spans `x`. */
  ledgeBelow(x: number, y: number, slack = 4): Ledge | null {
    let best: Ledge | null = null;
    for (const l of this.ledges) {
      if (x < l.x1 || x > l.x2 || l.y < y - slack) continue;
      if (!best || l.y < best.y) best = l;
    }
    return best;
  }

  /** The ledge a window currently offers nearest to `x` (and to `y`, when given), if any. */
  ledgeOfWindow(hwnd: number, x: number, y?: number): Ledge | null {
    let best: Ledge | null = null;
    let bestD = Infinity;
    for (const l of this.ledges) {
      if (l.hwnd !== hwnd) continue;
      const d = (x < l.x1 ? l.x1 - x : x > l.x2 ? x - l.x2 : 0) + (y == null ? 0 : Math.abs(l.y - y) * 2);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  }

  private rebuildLedges() {
    const ledges: Ledge[] = [];

    // Floors: the top of each taskbar. Neighbouring monitors at the same
    // height join into one long floor he can walk straight across.
    const floors = this.monitors
      .map((m) => ({ x1: m.work.x, x2: m.work.x + m.work.w, y: m.work.y + m.work.h }))
      .sort((a, b) => a.x1 - b.x1);
    for (const f of floors) {
      const last = ledges[ledges.length - 1];
      if (last && last.y === f.y && Math.abs(last.x2 - f.x1) <= 2) last.x2 = f.x2;
      else ledges.push({ id: `floor:${f.x1}`, x1: f.x1, x2: f.x2, y: f.y, hwnd: null });
    }

    const live = this.windows.filter((w) => w.state !== "minimized");
    // An edge at height y, cut down to its monitor and to what no window above it in the z-order hides.
    const visible = (z: number, x1: number, x2: number, y: number): [number, number][] => {
      const mon = this.monitorAt((x1 + x2) / 2, y + 1);
      if (!mon || y - mon.rect.y < HEADROOM || y >= mon.work.y + mon.work.h - 20) return [];
      let spans: [number, number][] = [[Math.max(x1, mon.rect.x), Math.min(x2, mon.rect.x + mon.rect.w)]];
      for (let i = 0; i < z; i++) {
        const o = live[i].rect;
        if (y <= o.y || y >= o.y + o.h) continue;
        const next: [number, number][] = [];
        for (const [a, b] of spans) {
          if (o.x + o.w <= a || o.x >= b) next.push([a, b]);
          else {
            if (o.x > a) next.push([a, o.x]);
            if (o.x + o.w < b) next.push([o.x + o.w, b]);
          }
        }
        spans = next;
      }
      return spans.filter(([a, b]) => b - a >= MIN_LEDGE);
    };
    live.forEach((w, z) => {
      const r = w.rect;
      if (w.state === "normal") {
        visible(z, r.x, r.x + r.w, r.y).forEach(([a, b], i) => ledges.push({ id: `w:${w.hwnd}:${i}`, x1: a, x2: b, y: r.y, hwnd: w.hwnd }));
      }
      // Shelves inside it: toolbars, tab strips, panes.
      this.skeletons.get(w.hwnd)?.edges.forEach((e, k) => {
        const y = r.y + e.y;
        visible(z, r.x + e.x1, r.x + e.x2, y).forEach(([a, b], i) => ledges.push({ id: `e:${w.hwnd}:${k}:${i}`, x1: a, x2: b, y, hwnd: w.hwnd }));
      });
    });

    this.ledges = ledges;
  }
}

export interface WorldEvents {
  monitors: MonitorsEvent;
  windowOpened: WindowInfo;
  windowClosed: WindowInfo;
  windowMinimized: WindowInfo;
  titleChanged: { window: WindowInfo; previous: string };
  focusChanged: WindowInfo | null;
  mouseDown: { x: number; y: number; buttons: number };
  mouseUp: { x: number; y: number; buttons: number };
  audio: { now: number; before: number };
  media: MediaEvent;
  elementFocused: FocusedElement;
  caretMoved: FocusedElement;
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
