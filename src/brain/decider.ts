import type { Config } from "../config";
import { trace } from "../debug/trace";
import type { Actor } from "../pesto/actor";
import { random } from "../pesto/math";
import type { World } from "../world/world";
import { CodeDecider } from "./deciders/code";
import { SystemOneDecider } from "./deciders/systemone";
import type { Backend, Scene, Taken } from "./deciders/backend";
import type { Director, ReactionName } from "./director";
import type { Journal, JournalEntry } from "./journal";
import type { Mind } from "./mind";

export { ASIDES } from "./deciders/backend";

/** How he pesters someone who is procrastinating, one rung at a time. */
const LADDER = ["none", "peek", "approach", "knock", "sign", "speak"] as const;

/** Failed requests in a row after which the model is left alone and he decides in code. */
const GIVE_UP_AFTER = 5;
/** Seconds after giving up before the model is tried once more. */
const RETRY_AFTER = 600;

/**
 * Pesto's quick, wordless judgment. After anything notable happens it asks a
 * backend how he feels about it and what, if anything, he does, and hands
 * off to the big model only when it is worth speaking. The backend is the
 * System One model when configured and answering, and plain code otherwise.
 */
export class Decider {
  private due = Infinity;
  private dwellIn = 75;
  private cooling = 0;
  private inFlight = false;
  private failures = 0;
  private gaveUpAt = -Infinity;
  private rung = 0;
  private rungHeld = 0;
  private slackSince = 0;
  private slackFocus: number | null = null;
  private trigger: JournalEntry | null = null;
  private fresh = false;
  private checkIn = false;

  private systemOne: SystemOneDecider;
  private code: CodeDecider;

  constructor(
    private deps: {
      config: Config;
      world: World;
      journal: Journal;
      director: Director;
      actor: Actor;
      mind: Mind;
      now: () => number;
      rand?: () => number;
    },
  ) {
    const { config, journal, now } = deps;
    this.systemOne = new SystemOneDecider({ config, journal, now });
    this.code = new CodeDecider({ config, now, rand: deps.rand ?? random });
    deps.journal.onEntry((e) => {
      if (e.kind === "pesto" || e.weight < 1) return;
      this.trigger = e;
      this.fresh = true;
      // Let a burst of events settle into one decision.
      this.due = Math.min(this.due, deps.now() + 1.3);
    });
  }

  /** The last answer from the decision model, for debugging. */
  get last() {
    return this.systemOne.last;
  }

  /** Which backend decides right now, or null when reactions are off. */
  get backend(): "systemone" | "none" | null {
    const { decider } = this.deps.config;
    if (!decider.enabled) return null;
    return decider.provider === "systemone" && !this.down() ? "systemone" : "none";
  }

  /** Tries the model again after it kept failing, for when its settings have changed. */
  retry() {
    this.failures = 0;
  }

  update(dt: number) {
    const { config, world, mind, actor, director } = this.deps;
    if (!config.decider.enabled) return;
    this.cooling = Math.max(0, this.cooling - dt);
    this.rungHeld += dt;

    // With nothing happening, still check in now and then while they are at the keyboard.
    if (world.system.idleMs < 60_000) {
      this.dwellIn -= dt;
      if (this.dwellIn <= 0) {
        this.dwellIn = 75;
        this.checkIn = true;
        this.due = Math.min(this.due, this.deps.now());
      }
    }
    if (this.deps.now() < this.due || this.cooling > 0 || this.inFlight) return;
    if (mind.busy || director.attentive || actor.mode === "held" || actor.mode === "air") return;
    this.due = Infinity;
    this.cooling = 5;
    void this.decide();
  }

  /** True while the model has failed too often to be asked, apart from one try every RETRY_AFTER seconds. */
  private down() {
    if (this.failures < GIVE_UP_AFTER) return false;
    if (this.deps.now() - this.gaveUpAt < RETRY_AFTER) return true;
    this.failures = GIVE_UP_AFTER - 1;
    return false;
  }

  /** Runs one decision on the current backend, falling back to code when the model does not answer. */
  private async judge<T>(run: (b: Backend) => Promise<T>): Promise<{ value: T; by: Backend }> {
    if (this.backend !== "systemone") {
      if (this.deps.config.decider.provider !== "systemone") trace.set("decider", "deciding in code");
      return { value: await run(this.code), by: this.code };
    }
    try {
      const value = await run(this.systemOne);
      this.failures = 0;
      return { value, by: this.systemOne };
    } catch (err) {
      if (++this.failures === GIVE_UP_AFTER) this.gaveUpAt = this.deps.now();
      const gaveUp = this.failures >= GIVE_UP_AFTER;
      console.warn(`decider: ${err}${gaveUp ? ` (deciding in code, trying again in ${RETRY_AFTER / 60} min)` : ""}`);
      if (gaveUp) trace.set("decider", "system one is not answering: deciding in code");
      return { value: await run(this.code), by: this.code };
    }
  }

  private async decide() {
    const { config, world, journal, director, actor, mind } = this.deps;
    const out = actor.mode !== "can";
    const playing = world.media.sessions.some((s) => s.status === "playing") && world.audio.out > 0.02;

    const reactions: Partial<Record<ReactionName | "none", string>> = {
      none: "Nothing. Ordinary activity that does not concern him.",
      ...(out
        ? {
            glance: "Flick his eyes at it for a moment and go back to what he was doing.",
            approach: "Walk over and sit next to it, watching. For something he wants a closer look at.",
            goHome: "Go back into his can. Nothing here needs him and he has been out a while.",
            ...(playing ? { dance: "Dance, because good music is playing." } : {}),
          }
        : {
            rustle: "A faint rustle inside the can. He noticed, but stays hidden.",
            peek: "Lift the lid a little and watch from the dark.",
            approach: "Climb out, walk over and sit next to it. For something he really wants to see up close.",
          }),
    };
    const trigger = this.fresh ? this.trigger : null;
    const scene: Scene = { out, sitting: actor.sitting, playing, trigger, checkIn: this.checkIn, spokeAgo: this.deps.now() - mind.lastSpokeAt, reactions };
    this.fresh = false;
    this.checkIn = false;

    this.inFlight = true;
    const { value: v, by } = await this.judge((b) => b.react(scene)).finally(() => (this.inFlight = false));
    const said = (what: string) => trace.log("decider", `${by.label} → ${what}`);
    // They may have started talking to him while it was deciding.
    if (director.attentive) return said("nothing: he is listening to them");

    const focus = world.focused;
    const target = focus ? { window: focus.hwnd } : ("cursor" as const);
    const free = director.autonomous && (!actor.busy || actor.sitting) && !mind.busy;

    // Procrastination overrides the ordinary choice with the next rung of the ladder.
    if (v.slacking != null && v.slacking > 0.62 && focus) {
      if (this.slackFocus !== focus.hwnd || this.rung === 0) {
        if (this.rung === 0) this.slackSince = this.deps.now();
        this.slackFocus = focus.hwnd;
      }
      if (this.rung === 0 || this.rungHeld > 50) {
        this.rung = Math.min(LADDER.length - 1, this.rung + 1);
        this.rungHeld = 0;
        said(`pester: ${LADDER[this.rung]}${free ? "" : ", but he is busy"}`);
        if (free) await this.pester(LADDER[this.rung], target);
      }
      return;
    }
    if (v.slacking != null && v.slacking < 0.35 && this.rung > 0) {
      // They stopped on their own. That deserves a little applause.
      const earned = this.rung >= 2;
      this.rung = 0;
      this.slackFocus = null;
      if (earned && free) {
        void director.perform("clap");
        return;
      }
    }

    const mayWake = free && mind.configured && this.deps.now() - mind.lastSpokeAt > config.mind.quietSeconds && !journal.personTalking;
    if (v.speak && mayWake) {
      const why = trigger?.text ?? "Nothing new happened; you are checking in on what they are doing.";
      said(`speaks up about: ${why}`);
      void mind.wake({ kind: "event", why });
      return;
    }

    if (!free) return said("nothing: he is busy");
    said(`${v.reaction}${v.feeling ? `, feeling ${v.feeling}` : ""}`);
    if (v.reaction !== "none") {
      void director.perform(v.reaction, { target, emotion: v.feeling ?? undefined });
    } else if (v.feeling && v.feeling !== "neutral" && (out || director.can.eyes)) {
      void director.perform("emote", { emotion: v.feeling, seconds: 3 });
    }
  }

  /**
   * What, if anything, shows on him at what they have said so far, while they
   * are still talking. Null means keep listening as he was, which it mostly is.
   */
  async aside(soFar: string, last: string | null): Promise<string | null> {
    if (!this.backend) return null;
    return (await this.judge((b) => b.aside(soFar, last))).value;
  }

  /**
   * How likely it is, 0..1, that what they said right after his answer was
   * meant for him. Null when nothing judges it, leaving it to the word and time rules.
   */
  async replying(heard: string, hisLast: string): Promise<number | null> {
    if (!this.backend) return null;
    return (await this.judge((b) => b.replying(heard, hisLast))).value;
  }

  /**
   * How he takes being called by name: the sound he makes, if any, and his
   * face while he listens. Null when reactions are off.
   */
  async called(): Promise<Taken | null> {
    const { actor, mind, director } = this.deps;
    if (!this.backend) return null;
    const scene = { asleep: director.asleep, hidden: actor.mode === "can", busy: actor.busy, mood: actor.mood, spokeAgo: this.deps.now() - mind.lastSpokeAt, hour: director.hour() };
    const { value, by } = await this.judge((b) => b.called(scene));
    trace.log("decider", `${by.label} → called: ${value.sound ?? "no sound"}${value.feeling ? `, feeling ${value.feeling}` : ""}`);
    return value;
  }

  private async pester(rung: (typeof LADDER)[number], target: { window: number } | "cursor") {
    const { director, mind } = this.deps;
    const minutes = Math.max(1, Math.round((this.deps.now() - this.slackSince) / 60));
    switch (rung) {
      case "peek":
        await director.perform("peek", { target, seconds: 6, emotion: "annoyed" });
        break;
      case "approach":
        if (await director.perform("approach", { target })) await director.perform("sit", { seconds: 40 });
        break;
      case "knock":
        if (await director.perform("approach", { target })) await director.perform("knock");
        break;
      case "sign":
        await director.perform("sign", { text: `${minutes} min.`, seconds: 6 });
        break;
      case "speak":
        if (mind.configured) await mind.wake({ kind: "event", why: `They have been procrastinating for ${minutes} minutes and ignored your knocking and your sign.` });
        else await director.perform("flop", { seconds: 4 });
        break;
    }
  }
}
