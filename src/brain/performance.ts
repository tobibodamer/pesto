import type { Actor } from "../pesto/actor";
import { EMOTIONS, type Emotion } from "../pesto/pose";
import type { Sight } from "../sense/sight";
import type { Paper } from "../stage/bubble";
import { spokenText, type Line, type Utterance, type Voice } from "../voice/voice";
import { REACTIONS, type Director, type ReactionName, type Target } from "./director";
import type { ScriptItem } from "./script";

export interface PerformanceDeps {
  director: Director;
  actor: Actor;
  voice: Voice;
  paper: Paper;
  sight: Sight;
  /** Short window ids (w1, w2, …) from the snapshot the script was written against. */
  windowIds: Map<string, number>;
  captions: boolean;
  /** Stage clock in seconds. */
  now: () => number;
}

/** Script names that differ from the reaction they run. */
const ALIASES: Record<string, ReactionName> = { look: "glance", go: "approach", home: "goHome", think: "ponder", out: "comeOut" };

/**
 * Plays a script as it streams in. Speech and body are two tracks: each runs
 * its own items in order, and an item also waits until everything written
 * before it on the other track has at least begun. So he can walk while he
 * talks, but never says "this one" before he has started to point.
 */
export class Performance {
  /** What he actually said, for the journal. */
  said: string[] = [];
  /** What he actually did. */
  did: string[] = [];

  private voiceTail: Promise<void> = Promise.resolve();
  private bodyTail: Promise<void> = Promise.resolve();
  private voiceBegun: Promise<void> = Promise.resolve();
  private bodyBegun: Promise<void> = Promise.resolve();
  private cancelled = false;
  private current: Utterance | null = null;
  private pending = new Set<Line>();

  constructor(private deps: PerformanceDeps) {}

  push(item: ScriptItem) {
    if (this.cancelled) return;
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
      if (this.cancelled) {
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
    this.bodyTail = gate.then(async () => {
      begun();
      if (this.cancelled) return;
      try {
        await this.act(item);
      } catch (err) {
        console.warn("performance: direction failed", item, err);
      }
    });
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
    const { director, actor, paper } = this.deps;
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
    if (!(reaction in REACTIONS)) return;
    const emotion = a.as && a.as in EMOTIONS ? (a.as as Emotion) : undefined;
    this.did.push(this.describe(name, a));
    await director.perform(reaction, { target: this.target(a.at ?? a.to), emotion, seconds });
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
  async finish() {
    await Promise.all([this.voiceTail, this.bodyTail]);
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
