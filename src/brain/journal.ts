import type { Actor } from "../pesto/actor";
import type { FocusedElement, WindowInfo } from "../sense/types";
import type { World } from "../world/world";

export type JournalKind =
  /** Something the person did or that happened on the desktop. */
  | "desk"
  /** Sound and media. */
  | "audio"
  /** The person touched Pesto. */
  | "touch"
  /** Something Pesto did or said. */
  | "pesto"
  /** Something the person said to Pesto. */
  | "user";

export interface JournalEntry {
  /** Epoch milliseconds. */
  at: number;
  kind: JournalKind;
  text: string;
  /** How much a reaction is warranted, 0 (background) to 3 (hard to ignore). */
  weight: number;
}

const MAX_ENTRIES = 600;
const TITLE_MAX = 90;

const clip = (s: string, n = TITLE_MAX) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const app = (w: WindowInfo) => w.exe.replace(/\.exe$/, "");
const element = (f: FocusedElement) => `${f.kind}${f.name ? ` «${clip(f.name, 40)}»` : ""} in ${f.exe.replace(/\.exe$/, "")}`;
const two = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

/**
 * The running account of what has been happening: the one thing every model
 * reads to know what the person is doing. It records changes, not states, and
 * drops the noise (a title flickering, focus bouncing through a window).
 */
export class Journal {
  entries: JournalEntry[] = [];
  /** Wall clock, injectable for tests. */
  now = () => Date.now();

  private listeners = new Set<(entry: JournalEntry) => void>();
  private pendingFocus: { w: WindowInfo; since: number } | null = null;
  private pendingTitle: { w: WindowInfo; since: number } | null = null;
  private focus: { hwnd: number; exe: string; title: string; since: number } | null = null;
  private soundFor = 0;
  private quietFor = 0;
  private sounding = false;
  private talkFor = 0;
  private hushFor = 0;
  private talking = false;
  private away = false;
  private lastMedia = "";
  private typingSince = -Infinity;
  private typingLogged = false;

  constructor(
    private world: World,
    actor: Actor,
  ) {
    world.on("focusChanged", (w) => {
      this.pendingFocus = w ? { w, since: world.time } : null;
      this.pendingTitle = null;
    });
    world.on("titleChanged", ({ window: w }) => {
      if (w.hwnd === world.foreground) this.pendingTitle = { w, since: world.time };
    });
    world.on("windowOpened", (w) => this.add("desk", `opened ${app(w)} «${clip(w.title)}»`, 1));
    world.on("windowClosed", (w) => this.add("desk", `closed ${app(w)} «${clip(w.title)}»`, 1));
    world.on("media", (e) => {
      const s = e.sessions.find((m) => m.status === "playing") ?? e.sessions[0];
      const line = !s ? "" : `${s.status === "playing" ? "▶" : "⏸"} ${mediaApp(s.app)}${[s.artist, s.title].filter(Boolean).join(" – ")}`;
      if (line === this.lastMedia) return;
      this.lastMedia = line;
      if (line) this.add("audio", clip(line, 120), 1);
    });
    actor.on("grabbed", () => this.add("touch", "picked Pesto up by the scruff", 2));
    actor.on("dropped", ({ onLedge }) => this.add("touch", onLedge ? "put Pesto down" : "let go of Pesto on bare glass", 2));
    actor.on("thrown", () => this.add("touch", "threw Pesto", 3));
    actor.on("shaken", () => this.add("touch", "shook Pesto until he was dizzy", 3));
    actor.on("petted", () => this.add("touch", "petted Pesto", 2));
    actor.on("poked", () => this.add("touch", "poked Pesto", 2));
  }

  onEntry(fn: (entry: JournalEntry) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  add(kind: JournalKind, text: string, weight = 0) {
    const entry = { at: this.now(), kind, text, weight };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.listeners.forEach((fn) => fn(entry));
  }

  /** Call once per frame. Settles debounced observations into entries. */
  update(dt: number) {
    const w = this.world;

    // Focus has to rest somewhere for a moment before it counts as a switch.
    if (this.pendingFocus && w.time - this.pendingFocus.since > 0.8) {
      const f = this.pendingFocus.w;
      this.pendingFocus = null;
      const prev = this.focus;
      if (!prev || prev.hwnd !== f.hwnd) {
        const stayed = prev ? Math.round((this.now() - prev.since) / 1000) : 0;
        const after = prev && stayed >= 60 ? ` (after ${Math.round(stayed / 60)} min in ${prev.exe})` : "";
        this.add("desk", `switched to ${app(f)} «${clip(f.title)}»${after}`, 1);
        this.focus = { hwnd: f.hwnd, exe: app(f), title: f.title, since: this.now() };
      }
    }
    // A title change inside the focused window is usually a new tab or document.
    if (this.pendingTitle && w.time - this.pendingTitle.since > 1.2) {
      const t = this.pendingTitle.w;
      this.pendingTitle = null;
      const current = w.window(t.hwnd);
      if (current && this.focus && this.focus.hwnd === t.hwnd && current.title !== this.focus.title) {
        this.focus.title = current.title;
        this.add("desk", `${app(current)} now shows «${clip(current.title)}»`, 1);
      }
    }

    // A few seconds of steady typing is worth a line; a keystroke or two is not.
    if (!w.typing) {
      this.typingSince = -Infinity;
      this.typingLogged = false;
    } else {
      if (this.typingSince === -Infinity) this.typingSince = w.time;
      if (!this.typingLogged && w.time - this.typingSince > 4 && w.focus) {
        this.typingLogged = true;
        this.add("desk", `typing in ${element(w.focus)}`, 0);
      }
    }

    const out = w.audio.out;
    if (out > 0.02) {
      this.soundFor += dt;
      this.quietFor = 0;
      if (!this.sounding && this.soundFor > 1.5) {
        this.sounding = true;
        const who = w.audio.sessions[0]?.exe.replace(/\.exe$/, "");
        this.add("audio", `sound started${who ? ` from ${who}` : ""}`, 0);
      }
    } else {
      this.quietFor += dt;
      this.soundFor = 0;
      if (this.sounding && this.quietFor > 6) {
        this.sounding = false;
        this.add("audio", "it went quiet", 0);
      }
    }

    const mic = w.audio.mic;
    if (mic > 0.06) {
      this.talkFor += dt;
      this.hushFor = 0;
      if (!this.talking && this.talkFor > 0.6) {
        this.talking = true;
        this.add("audio", "the person started talking (mic active)", 0);
      }
    } else {
      this.hushFor += dt;
      this.talkFor = Math.max(0, this.talkFor - dt);
      if (this.talking && this.hushFor > 8) {
        this.talking = false;
        this.add("audio", "the person stopped talking", 0);
      }
    }

    const idle = w.system.idleMs;
    if (!this.away && idle > 3 * 60_000) {
      this.away = true;
      this.add("desk", "no input for 3 minutes; the person may have stepped away", 0);
    } else if (this.away && idle < 3000) {
      this.away = false;
      this.add("desk", "the person is back", 2);
    }
  }

  /** How long the current window has had focus, in seconds. */
  get focusSeconds() {
    return this.focus ? (this.now() - this.focus.since) / 1000 : 0;
  }

  /** The last `count` entries as plain lines, oldest first. */
  render(count = 60, sinceMs = 0): string {
    return this.entries
      .filter((e) => e.at >= sinceMs)
      .slice(-count)
      .map((e) => `${clock(e.at)} ${e.kind === "pesto" ? "Pesto" : e.kind === "user" ? "They said" : "·"} ${e.text}`)
      .join("\n");
  }

  /**
   * A description of the desktop as it is right now. Windows get short ids
   * (w1, w2, …) that a model can use as targets; `ids` maps them back.
   */
  snapshot(): { text: string; ids: Map<string, number> } {
    const w = this.world;
    const ids = new Map<string, number>();
    const lines: string[] = [];
    const d = new Date(this.now());
    lines.push(`Time: ${d.toLocaleDateString("en-GB", { weekday: "long" })} ${two(d.getHours())}:${two(d.getMinutes())}`);
    let n = 0;
    for (const m of w.monitors) {
      const here = w.windows.filter((x) => x.monitor === m.id && x.state !== "minimized");
      lines.push(`Screen ${m.id + 1}${m.primary ? " (main)" : ""}, ${m.rect.w}×${m.rect.h}:${here.length ? "" : " empty desktop"}`);
      for (const x of here.slice(0, 6)) {
        const id = `w${++n}`;
        ids.set(id, x.hwnd);
        const marks = [x.hwnd === w.foreground ? "focused" : "", x.state !== "normal" ? x.state : ""].filter(Boolean).join(", ");
        lines.push(`  ${id} ${app(x)} «${clip(x.title, 70)}»${marks ? ` [${marks}]` : ""}`);
      }
    }
    const min = w.windows.filter((x) => x.state === "minimized").length;
    if (min) lines.push(`${min} more window${min > 1 ? "s" : ""} minimised.`);
    const mon = w.monitorAt(w.cursor.x, w.cursor.y);
    if (mon) lines.push(`Cursor is on screen ${mon.id + 1}.`);
    const playing = w.media.sessions.find((s) => s.status === "playing");
    if (playing) lines.push(`Playing: ${[playing.artist, playing.title].filter(Boolean).join(" – ")}`);
    else if (w.audio.out > 0.02) lines.push(`Sound is playing${w.audio.sessions[0] ? ` from ${w.audio.sessions[0].exe}` : ""}.`);
    if (this.focus) lines.push(`Current window has had focus for ${formatSpan(this.focusSeconds)}.`);
    if (w.focus) lines.push(`Focused inside it: ${element(w.focus)}${w.typing ? ", being typed in" : ""}.`);
    if (w.system.battery && !w.system.battery.charging) lines.push(`Battery ${Math.round(w.system.battery.percent)}%, not charging.`);
    return { text: lines.join("\n"), ids };
  }

  /** The same moment in a few lines, for a model with very little room. */
  brief(): string {
    const w = this.world;
    const d = new Date(this.now());
    const lines = [`It is ${d.toLocaleDateString("en-GB", { weekday: "long" })} ${two(d.getHours())}:${two(d.getMinutes())}.`];
    const focus = w.focused;
    if (focus) lines.push(`They are in ${app(focus)}: «${clip(focus.title, 60)}», for ${formatSpan(this.focusSeconds)} now.`);
    else lines.push("No window has focus.");
    const others = [...new Set(w.windows.filter((x) => x.state !== "minimized" && x.hwnd !== focus?.hwnd).map(app))].slice(0, 5);
    if (others.length) lines.push(`Also open: ${others.join(", ")}.`);
    const playing = w.media.sessions.find((s) => s.status === "playing");
    if (playing) lines.push(`Playing: ${clip([playing.artist, playing.title].filter(Boolean).join(" – "), 60)}.`);
    else if (w.audio.out > 0.02) lines.push("Sound is playing.");
    if (w.system.idleMs > 120_000) lines.push(`They have not touched the computer for ${formatSpan(w.system.idleMs / 1000)}.`);
    return lines.join("\n");
  }
}

function formatSpan(seconds: number) {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

/** The player's name, or nothing when Windows only reports an opaque app id. */
function mediaApp(id: string) {
  const name = id.replace(/\.exe$/i, "").split(/[\\/!]/).pop() ?? "";
  return /^[0-9A-F]{12,}$/i.test(name) || !name ? "" : `${name}: `;
}
