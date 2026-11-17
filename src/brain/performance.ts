import { trace } from "../debug/trace";
import type { Actor } from "../pesto/actor";
import { EMOTIONS, type Emotion } from "../pesto/pose";
import type { Sight } from "../sense/sight";
import type { MediaVerb, WindowVerb } from "../sense/types";
import type { Paper } from "../stage/bubble";
import { spokenText, type Line, type Utterance, type Voice } from "../voice/voice";
import { REACTIONS, type Director, type ReactionName, type Target } from "./director";
import { Fumble, handle, type Hands } from "./hands";
import type { ScriptItem } from "./script";

export interface PerformanceDeps {
  director: Director;
  actor: Actor;
  voice: Voice;
  paper: Paper;
  sight: Sight;
  hands: Hands;
  /** Short window ids (w1, w2, …) from the snapshot the script was written against. */
  windowIds: Map<string, number>;
  /** Whether this script may change their desktop. Only one they asked for may. */
  mayAct: boolean;
  captions: boolean;
  /** Stage clock in seconds. */
  now: () => number;
}

/** Script names that differ from the reaction they run. */
const ALIASES: Record<string, ReactionName> = { look: "glance", go: "approach", home: "goHome", think: "ponder", out: "comeOut" };

const WINDOW_VERBS = new Set<string>(["focus", "minimize", "maximize", "restore", "close"] satisfies WindowVerb[]);
const MEDIA_VERBS = new Set<string>(["play", "pause", "next", "previous"] satisfies MediaVerb[]);
/** Directions that change their desktop instead of only moving him. */
const ACTIONS = new Set(["press", "move", "open", ...WINDOW_VERBS, ...MEDIA_VERBS]);
/** Doing one of these a second time changes nothing, so a script that repeats itself does not get to. */
const ONCE = new Set(["open", "move", ...WINDOW_VERBS]);
/** Other spellings a model reaches for. */
const ACTION_ALIASES: Record<string, string> = { click: "press", minimise: "minimize", maximise: "maximize", prev: "previous", skip: "next", resume: "play", stop: "pause", launch: "open", start: "open" };

const actionName = (name: string) => {
  const action = ACTION_ALIASES[name] ?? name;
  return ACTIONS.has(action) ? action : null;
};

/** A direction as the model wrote it, to quote back when it goes wrong. */
const written = (item: Extract<ScriptItem, { kind: "do" }>) => `<${[item.name, ...Object.entries(item.attrs).map(([k, v]) => `${k}="${v}"`)].join(" ")}/>`;

/**
 * Plays a script as it streams in. Speech and body are two tracks: each runs
 * its own items in order, and an item also waits until everything written
 * before it on the other track has at least begun. So he can walk while he
 * talks, but never says "this one" before he has started to point. Words
 * after something he does to their desktop wait until it is done.
 */
export class Performance {
  /** What he actually said, for the journal. */
  said: string[] = [];
  /** What he actually did. */
  did: string[] = [];
  /** Set when something he tried on their desktop did not work. Nothing written after it is played. */
  failed: { direction: string; why: string } | null = null;

  private voiceTail: Promise<void> = Promise.resolve();
  private bodyTail: Promise<void> = Promise.resolve();
  private voiceBegun: Promise<void> = Promise.resolve();
  private bodyBegun: Promise<void> = Promise.resolve();
  private changesDone: Promise<void> = Promise.resolve();
  private cancelled = false;
  private current: Utterance | null = null;
  private pending = new Set<Line>();
  private changes = new Set<string>();

  constructor(private deps: PerformanceDeps) {}

  private get dropping() {
    return this.cancelled || !!this.failed;
  }

  push(item: ScriptItem) {
    if (this.dropping) return;
    if (item.kind === "say") this.pushSay(item.text);
    else this.pushDo(item);
  }

  private pushSay(text: string) {
    const { voice, actor, paper } = this.deps;
    const line = voice.prepare(text);
    this.pending.add(line);
    let begun!: () => void;
    const gate = Promise.all([this.voiceTail, this.bodyBegun]);
    this.voiceBegun = new Promise<void>((r) => (begun = r));
    this.voiceTail = gate.then(async () => {
      this.pending.delete(line);
      if (this.dropping) {
        line.discard();
        begun();
        return;
      }
      const u = line.play();
      this.current = u;
      await u.started;
      begun();
      this.said.push(spokenText(text));
      actor.talking = true;
      if (this.deps.captions || !voice.audible) paper.show(spokenText(text), "speech");
      const pump = setInterval(() => (actor.speech = u.level()), 33);
      await u.finished;
      clearInterval(pump);
      actor.speech = 0;
      actor.talking = false;
      this.current = null;
    });
  }

  private pushDo(item: Extract<ScriptItem, { kind: "do" }>) {
    let begun!: () => void;
    const gate = Promise.all([this.bodyTail, this.voiceBegun]);
    this.bodyBegun = new Promise<void>((r) => (begun = r));
    const action = actionName(item.name);
    this.bodyTail = gate.then(async () => {
      if (!action) begun();
      try {
        if (this.dropping) return;
        if (action) await this.change(action, item);
        else await this.act(item);
      } catch (err) {
        console.warn("performance: direction failed", item, err);
      } finally {
        begun();
      }
    });
    if (action) this.changesDone = this.bodyTail;
  }

  private target(value: string | undefined): Target | undefined {
    if (!value) return undefined;
    if (value === "cursor" || value === "user") return value;
    if (value === "can") return { x: this.deps.director.can.x, y: this.deps.director.can.y - 60 };
    if (value === "focus") return this.deps.director.world.actionPoint ?? undefined;
    if (/^e\d+$/.test(value)) return this.deps.sight.locate(value) ?? undefined;
    const hwnd = this.deps.windowIds.get(value);
    if (hwnd != null) return { window: hwnd };
    const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(value);
    return m ? { x: +m[1], y: +m[2] } : undefined;
  }

  private async act(item: Extract<ScriptItem, { kind: "do" }>) {
    const { director, paper } = this.deps;
    const a = item.attrs;
    const seconds = a.s ? Math.min(30, Math.max(0.1, parseFloat(a.s))) : undefined;
    const name = item.name;

    if (name === "wait") {
      await new Promise((r) => setTimeout(r, (seconds ?? 0.6) * 1000));
      return;
    }
    if (name === "note") {
      if (!item.body) return;
      this.did.push(`showed a note: ${item.body.slice(0, 80)}`);
      paper.show(item.body, "note", seconds ?? Math.max(6, item.body.length / 14), this.deps.now());
      return;
    }
    if (name === "sign") {
      if (!item.body) return;
      this.did.push(`held up a sign: ${item.body}`);
      await director.perform("sign", { text: item.body.slice(0, 24), seconds: seconds ?? 4 });
      return;
    }

    const reaction = (ALIASES[name] ?? name) as ReactionName;
    if (!(reaction in REACTIONS)) return trace.log("script", `no such direction: ${name}`);
    const emotion = a.as && a.as in EMOTIONS ? (a.as as Emotion) : undefined;
    const where = a.at ?? a.to;
    const target = this.target(where);
    if (where && !target) trace.log("script", `${name}: nothing known as "${where}"`);
    this.did.push(this.describe(name, a));
    await director.perform(reaction, { target, emotion, seconds });
  }

  /** Something he does to their desktop. When it does not work, the rest of the script is dropped. */
  private async change(action: string, item: Extract<ScriptItem, { kind: "do" }>) {
    if (!this.deps.mayAct) return trace.log("script", `${action}: he only changes things when asked to`);
    const same = written(item);
    if (ONCE.has(action) && this.changes.has(same)) return trace.log("script", `${same}: already done`);
    this.changes.add(same);
    try {
      const did = await this.attempt(action, item.attrs);
      this.did.push(did);
      trace.log("script", did);
    } catch (err) {
      if (!(err instanceof Fumble)) throw err;
      if (this.cancelled) return;
      this.failed = { direction: written(item), why: err.message };
      this.pending.forEach((line) => line.discard());
      this.pending.clear();
      this.did.push(`tried ${this.describe(action, item.attrs)}, which did not work: ${err.message}`);
      this.deps.actor.feel("unsure", 2.5);
      trace.log("script", `${action} failed: ${err.message}`);
    }
  }

  private async attempt(action: string, a: Record<string, string>): Promise<string> {
    const { hands, sight, windowIds, director } = this.deps;
    if (MEDIA_VERBS.has(action)) return hands.media(action as MediaVerb);
    if (action === "open") {
      const what = a.what ?? a.at ?? a.app ?? a.name ?? a.url ?? a.path ?? a.to ?? "";
      // A window he can already see is not opened again but brought to the front.
      if (!windowIds.has(what)) return hands.open(what);
      action = "focus";
      a = { at: what };
    }

    const where = a.at ?? a.window ?? (action === "move" ? undefined : a.to) ?? "";
    const seen = sight.get(where);
    if (action === "press" || (action === "focus" && seen)) {
      if (windowIds.has(where)) throw new Fumble(`${where} is a window, not something to press; a window takes focus, minimize, maximize, restore, close or move`);
      if (!seen) throw new Fumble(`nothing is known as "${where}"; look into the window first and use an id like e12`);
      const spot = sight.locate(seen.id);
      if (!spot) throw new Fumble("its window has changed since you looked; look again");
      return this.touch(spot, () => (action === "press" ? hands.press(seen) : hands.focus(seen)));
    }

    const hwnd = windowIds.get(where) ?? seen?.hwnd;
    const win = director.world.window(hwnd ?? null);
    if (hwnd == null || !win) throw new Fumble(`there is no window "${where}"; the windows are ${[...windowIds.keys()].join(", ")}`);
    const act = () => (action === "move" ? hands.move(hwnd, a.to ?? "") : hands.window(hwnd, action as WindowVerb));
    if (win.state === "minimized") return act();
    const scale = director.world.monitors.find((m) => m.id === win.monitor)?.scale ?? 1;
    return this.touch({ window: hwnd, at: handle(win, action as WindowVerb | "move", scale) }, act);
  }

  /** He goes and presses the spot, and `act` starts as his hand lands on it. */
  private async touch(target: Target, act: () => Promise<string>): Promise<string> {
    const landed: { result?: Promise<string> } = {};
    await this.deps.director.perform("press", {
      target,
      act: () => {
        landed.result ??= act();
        landed.result.catch(() => {});
      },
    });
    if (!landed.result) throw new Fumble("something stopped you before you got to it");
    return landed.result;
  }

  /** A direction as a line for the journal, with the things he saw named instead of numbered. */
  private describe(name: string, attrs: Record<string, string>) {
    const bits = Object.entries(attrs).map(([k, v]) => {
      const seen = this.deps.sight.get(v);
      return `${k} ${seen ? `${seen.kind}${seen.name ? ` «${seen.name}»` : ""}` : v}`;
    });
    return bits.length ? `${name} (${bits.join(", ")})` : name;
  }

  /** Resolves when everything pushed so far has played out. */
  async settle() {
    await Promise.all([this.voiceTail, this.bodyTail]);
  }

  /** Resolves when whatever he was told to do to their desktop so far is done, or has failed. Talking may still be going on. */
  async changed() {
    await this.changesDone;
  }

  /** After a failure has been dealt with: what is pushed from now on plays again. */
  recover() {
    this.failed = null;
  }

  /** Resolves when everything pushed so far has played out and the last caption has had its moment. */
  async finish() {
    await this.settle();
    if (!this.deps.voice.audible || this.deps.captions) {
      // Leave the last caption readable for a moment.
      await new Promise((r) => setTimeout(r, 900));
      if (!this.cancelled) this.deps.paper.hide();
    }
  }

  /** Stops speaking and drops everything not yet started. */
  cancel() {
    this.cancelled = true;
    this.current?.stop();
    this.pending.forEach((l) => l.discard());
    this.pending.clear();
    this.deps.actor.stop();
    this.deps.paper.hide();
  }
}
