import { call } from "../sense/bridge";
import type { Seen, Sight } from "../sense/sight";
import type { MediaVerb, MonitorInfo, Openable, Rect, WindowInfo, WindowVerb } from "../sense/types";
import type { World } from "../world/world";

/** Something he tried on the desktop that did not work. The message says why, in words he can pass on. */
export class Fumble extends Error {}

const tried = <T>(doing: Promise<T>) =>
  doing.catch((why) => {
    throw new Fumble(String(why));
  });

const named = (seen: Seen) => `${seen.kind}${seen.name ? ` «${seen.name}»` : ""}`;
const titled = (win: WindowInfo) => `${win.exe.replace(/\.exe$/, "")} «${win.title.slice(0, 60)}»`;

const DONE: Record<WindowVerb, string> = { focus: "brought forward", minimize: "minimised", maximize: "maximised", restore: "restored", close: "closed" };
const READ_MOST = 3000;
/** How long the list of things that can be opened is trusted. */
const LIST_FRESH = 120_000;

/**
 * Where on a window his hand goes for each thing he does to it, from its
 * top-left corner: the caption buttons, or the middle of the title bar.
 */
export function handle(win: WindowInfo, verb: WindowVerb | "move", scale: number) {
  const fromRight = verb === "close" ? 0.5 : verb === "maximize" || verb === "restore" ? 1.5 : verb === "minimize" ? 2.5 : null;
  return { x: fromRight == null ? win.rect.w / 2 : win.rect.w - fromRight * 46 * scale, y: 16 * scale };
}

export interface Placement {
  rect: Rect;
  /** Fill the screen once it is there. */
  maximize: boolean;
  /** Where that is, for the journal. */
  words: string;
}

/**
 * Works out where "left", "top right", "screen 2", "next screen center" and
 * the like put a window. Null when `to` names no place.
 */
export function placement(to: string, win: WindowInfo, monitors: MonitorInfo[]): Placement | null {
  const t = to.toLowerCase();
  const has = (words: string) => new RegExp(`\\b(${words})\\b`).test(t);
  const across = [...monitors].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
  const here = across.find((m) => m.id === win.monitor) ?? across[0];
  if (!here) return null;

  let mon = here;
  const numbered = /screen\s*(\d+)/.exec(t);
  if (numbered) {
    const found = across.find((m) => m.id === Number(numbered[1]) - 1);
    if (!found) return null;
    mon = found;
  } else if (has("next|other")) mon = across[(across.indexOf(here) + 1) % across.length];
  else if (has("previous|prev")) mon = across[(across.indexOf(here) - 1 + across.length) % across.length];

  const left = has("left");
  const right = has("right");
  const top = has("top|upper");
  const bottom = has("bottom|lower");
  const centre = has("center|centre|middle");
  const full = has("full|fullscreen|maximized|maximised|max");
  const work = mon.work;
  const screen = mon === here ? "" : ` on screen ${mon.id + 1}`;
  const filling = win.state === "maximized" || win.state === "fullscreen";
  const lost = win.state === "minimized" || filling;
  const middle = (w: number, h: number): Rect => ({ x: Math.round(work.x + (work.w - w) / 2), y: Math.round(work.y + (work.h - h) / 2), w: Math.round(w), h: Math.round(h) });
  const roomy = () => middle(work.w * 0.7, work.h * 0.75);

  if (full) return { rect: roomy(), maximize: true, words: `to fill the screen${screen}` };
  if (left || right || top || bottom) {
    const rect = {
      x: work.x + (right ? Math.floor(work.w / 2) : 0),
      y: work.y + (bottom ? Math.floor(work.h / 2) : 0),
      w: left || right ? Math.floor(work.w / 2) : work.w,
      h: top || bottom ? Math.floor(work.h / 2) : work.h,
    };
    const side = [top ? "top" : bottom ? "bottom" : "", left ? "left" : right ? "right" : ""].filter(Boolean).join(" ");
    return { rect, maximize: false, words: `to the ${side} ${(left || right) && (top || bottom) ? "corner" : "half"}${screen}` };
  }
  if (centre) return { rect: lost ? roomy() : middle(Math.min(win.rect.w, work.w), Math.min(win.rect.h, work.h)), maximize: false, words: `to the middle${screen}` };
  if (mon === here) return null;
  if (lost) return { rect: roomy(), maximize: filling, words: `to screen ${mon.id + 1}` };
  // The same place and share of the screen it had on the one it leaves.
  const from = here.work;
  const w = Math.min(work.w, Math.round((win.rect.w / from.w) * work.w));
  const h = Math.min(work.h, Math.round((win.rect.h / from.h) * work.h));
  const x = work.x + Math.round(((win.rect.x - from.x) / from.w) * work.w);
  const y = work.y + Math.round(((win.rect.y - from.y) / from.h) * work.h);
  return {
    rect: { x: Math.max(work.x, Math.min(x, work.x + work.w - w)), y: Math.max(work.y, Math.min(y, work.y + work.h - h)), w, h },
    maximize: false,
    words: `to screen ${mon.id + 1}`,
  };
}

const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** How well a name answers to what was asked for, 0 to 100. Both already made plain. */
function fit(asked: string, name: string): number {
  if (name === asked) return 100;
  if (` ${name} `.includes(` ${asked} `)) return 80;
  if (name.startsWith(asked)) return 70;
  if (name.includes(asked)) return 60;
  if (name.length >= 4 && ` ${asked} `.includes(` ${name} `)) return 55;
  if (asked.split(" ").every((word) => name.includes(word))) return 50;
  return 0;
}

function pairs(s: string) {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** How alike two plain names look, 0 to 1, for suggesting what someone may have meant. */
function alike(a: string, b: string) {
  const x = pairs(a);
  const y = pairs(b);
  let shared = 0;
  for (const p of x) if (y.has(p)) shared++;
  return x.size + y.size ? (2 * shared) / (x.size + y.size) : 0;
}

/**
 * Finds what a name means among the things that can be opened. One clear
 * winner is `hit`; otherwise `close` holds the ones it could be, best first.
 */
export function pick(asked: string, items: Openable[]): { hit: Openable | null; close: Openable[] } {
  const q = plain(asked);
  if (!q) return { hit: null, close: [] };
  const scored = items
    .map((item) => ({ item, name: plain(item.name) }))
    .map((x) => ({ ...x, score: fit(q, x.name) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  const best = scored[0];
  if (best && (best.score === 100 || scored[1]?.score !== best.score)) return { hit: best.item, close: [] };
  if (best) return { hit: null, close: scored.filter((x) => x.score === best.score).slice(0, 6).map((x) => x.item) };
  const near = items
    .map((item) => ({ item, score: alike(q, plain(item.name)) }))
    .filter((x) => x.score > 0.3)
    .sort((a, b) => b.score - a.score);
  return { hit: null, close: near.slice(0, 5).map((x) => x.item) };
}

/**
 * What he can do to the desktop: press things he has seen, work windows and
 * whatever is playing, open things and read them. Each thing he does resolves
 * to a line saying what happened and rejects with a `Fumble` when it did not work.
 */
export class Hands {
  private openables: { at: number; items: Openable[] } | null = null;

  constructor(
    private world: World,
    private sight: Sight,
  ) {}

  async press(seen: Seen): Promise<string> {
    const how = await tried(call("element_press", { hwnd: seen.hwnd, key: seen.key }));
    this.sight.stale(seen.hwnd);
    return `${how} ${named(seen)}`;
  }

  async focus(seen: Seen): Promise<string> {
    await tried(call("element_focus", { hwnd: seen.hwnd, key: seen.key }));
    return `put the cursor in ${named(seen)}`;
  }

  async window(hwnd: number, verb: WindowVerb): Promise<string> {
    const win = this.world.window(hwnd);
    if (!win) throw new Fumble("that window is gone");
    await tried(call("window_act", { hwnd, verb }));
    return `${DONE[verb]} ${titled(win)}`;
  }

  async move(hwnd: number, to: string): Promise<string> {
    const win = this.world.window(hwnd);
    if (!win) throw new Fumble("that window is gone");
    const place = placement(to, win, this.world.monitors);
    if (!place) throw new Fumble(`"${to}" is not a place; say left, right, top, bottom, a corner, center, full, screen 2 or next screen`);
    await tried(call("window_place", { hwnd, rect: place.rect }));
    if (place.maximize) await tried(call("window_act", { hwnd, verb: "maximize" }));
    this.sight.stale(hwnd);
    return `moved ${titled(win)} ${place.words}`;
  }

  async media(verb: MediaVerb): Promise<string> {
    await tried(call("media_act", { verb }));
    return verb === "play" ? "started the music again" : verb === "pause" ? "paused what was playing" : `skipped to the ${verb} track`;
  }

  /** The text in a window, or in one thing he saw there. Empty when the app gives none. */
  async read(hwnd: number, only?: Seen): Promise<string> {
    const text = (seen: Seen) => call("element_text", { hwnd: seen.hwnd, key: seen.key, limit: READ_MOST }).catch(() => "");
    if (only) return (await text(only)).trim();
    const all = await this.sight.look(hwnd);
    const pages = all.filter((e) => e.kind === "document" || e.kind === "edit").sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    for (const page of pages.slice(0, 3)) {
      const found = (await text(page)).trim();
      if (found.length > 40) return found;
    }
    return all
      .filter((e) => e.kind === "text" && e.name)
      .map((e) => e.name)
      .join("\n")
      .slice(0, READ_MOST);
  }

  /** Opens an app or one of their folders by name, a file by its full path, or a web address. */
  async open(what: string): Promise<string> {
    const asked = what.trim();
    if (!asked) throw new Fumble("open needs to be told what, as in <open what=\"Downloads\"/>");
    const launch = async (target: string, said: string) => {
      await tried(call("launch_open", { target }));
      return said;
    };
    if (/^https?:\/\//i.test(asked)) return launch(asked, `opened ${asked} in their browser`);
    if (/^[a-z]:[\\/]/i.test(asked) || asked.startsWith("\\\\")) return launch(asked, `opened ${asked}`);

    const now = Date.now();
    if (!this.openables || now - this.openables.at > LIST_FRESH) this.openables = { at: now, items: await call("launch_list").catch(() => []) };
    const { hit, close } = pick(asked, this.openables.items);
    if (hit) return launch(hit.target, `opened ${hit.name}`);
    if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(asked)) return launch(`https://${asked}`, `opened ${asked} in their browser`);
    const names = close.map((c) => `"${c.name}"`).join(", ");
    throw new Fumble(close.length ? `"${asked}" could be ${names}; open the exact one` : `there is no app or folder called "${asked}"; try its proper name, or a web address`);
  }
}
