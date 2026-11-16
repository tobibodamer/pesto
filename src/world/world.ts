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

  /** The ledge a window currently offers nearest to `x`, if any. */
  ledgeOfWindow(hwnd: number, x: number): Ledge | null {
    let best: Ledge | null = null;
    let bestD = Infinity;
    for (const l of this.ledges) {
      if (l.hwnd !== hwnd) continue;
      const d = x < l.x1 ? l.x1 - x : x > l.x2 ? x - l.x2 : 0;
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
    live.forEach((w, z) => {
      if (w.state !== "normal") return;
      const y = w.rect.y;
      const mon = this.monitorAt(w.rect.x + w.rect.w / 2, y + 1);
      if (!mon || y - mon.rect.y < HEADROOM || y >= mon.work.y + mon.work.h - 20) return;

      // Start with the window's top edge inside its monitor, then cut away
      // every span hidden by a window above it in the z-order.
      let spans: [number, number][] = [
        [Math.max(w.rect.x, mon.rect.x), Math.min(w.rect.x + w.rect.w, mon.rect.x + mon.rect.w)],
      ];
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
      spans
        .filter(([a, b]) => b - a >= MIN_LEDGE)
        .forEach(([a, b], i) => ledges.push({ id: `w:${w.hwnd}:${i}`, x1: a, x2: b, y, hwnd: w.hwnd }));
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
