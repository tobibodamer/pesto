import type { Config } from "../config";
import { postJson } from "../net";
import type { Actor } from "../pesto/actor";
import { random } from "../pesto/math";
import type { Emotion } from "../pesto/pose";
import type { World } from "../world/world";
import type { Director, ReactionName } from "./director";
import type { Journal, JournalEntry } from "./journal";
import type { Mind } from "./mind";

/**
 * Ollama's /v1/systemone: a "decision model" that does not write text. It
 * reads a state and answers typed questions with probabilities, in well
 * under a second. Three question types exist:
 *   choice  criteria is { key: description }; answers the best key
 *   noul    criteria is { yes, no };          answers P(yes) as `noul`
 *   score   criteria is 2–10 level strings;   answers the level index
 */
type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria: { yes: string; no: string } }
  | { type: "score"; instructions: string; criteria: string[] };

type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

interface SystemOneResponse {
  answers: Record<string, Answer>;
}

const WHO =
  "Pesto is a pet raccoon living in a trash can on this person's desktop, watching what they do. " +
  "He is nosy, cheeky and judgmental but cares about them, and mostly keeps quiet.";

const FEELINGS: Partial<Record<Emotion, string>> = {
  neutral: "nothing in particular",
  curious: "interested, wants to know more",
  happy: "glad about what is happening",
  smug: "amused at the person's expense, told-you-so",
  annoyed: "disapproving of what the person is doing",
  grumpy: "properly fed up",
  surprised: "caught off guard",
  sad: "let down or ignored",
  sleepy: "it is late and he is tired",
  unsure: "does not know what to make of it",
};

/** How he pesters someone who is procrastinating, one rung at a time. */
const LADDER = ["none", "peek", "approach", "knock", "sign", "speak"] as const;

/**
 * Pesto's quick, wordless judgment. After anything notable happens it asks
 * the local decision model how he feels about it and what, if anything, he
 * does, and hands off to the big model only when it is worth speaking.
 */
export class Decider {
  /** The last decision, for debugging. */
  last: { at: number; state: string; answers: Record<string, Answer> } | null = null;

  private due = Infinity;
  private dwellIn = 75;
  private cooling = 0;
  private inFlight = false;
  private failures = 0;
  private rung = 0;
  private rungHeld = 0;
  private slackSince = 0;
  private slackFocus: number | null = null;
  private trigger: JournalEntry | null = null;
  /** Journal lines given to the model. Shrinks when the server says the prompt does not fit its context. */
  private recall = 6;

  constructor(
    private deps: {
      config: Config;
      world: World;
      journal: Journal;
      director: Director;
      actor: Actor;
      mind: Mind;
      now: () => number;
    },
  ) {
    deps.journal.onEntry((e) => {
      if (e.kind === "pesto" || e.weight < 1) return;
      this.trigger = e;
      // Let a burst of events settle into one decision.
      this.due = Math.min(this.due, deps.now() + 1.3);
    });
  }

  update(dt: number) {
    const { config, world, mind, actor } = this.deps;
    if (!config.decider.enabled || this.failures >= 5) return;
    this.cooling = Math.max(0, this.cooling - dt);
    this.rungHeld += dt;

    // With nothing happening, still check in now and then while they are at the keyboard.
    if (world.system.idleMs < 60_000) {
      this.dwellIn -= dt;
      if (this.dwellIn <= 0) {
        this.dwellIn = 75;
        this.due = Math.min(this.due, this.deps.now());
      }
    }
    if (this.deps.now() < this.due || this.cooling > 0 || this.inFlight) return;
    if (mind.busy || actor.mode === "held" || actor.mode === "air") return;
    this.due = Infinity;
    this.cooling = 5;
    void this.decide();
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

    const selfLine = [
      out ? (actor.sitting ? "Pesto is out of his can, sitting and watching." : "Pesto is out of his can.") : "Pesto is hidden inside his can.",
      Number.isFinite(mind.lastSpokeAt) ? `He last spoke ${Math.round((this.deps.now() - mind.lastSpokeAt) / 60)} min ago.` : "He has not spoken yet.",
    ].join(" ");
    const recent = this.recall > 0 ? journal.render(this.recall) : "";
    const state = `${WHO}\n\n${recent ? `Recently, oldest first:\n${recent}\n\n` : ""}${journal.brief()}\n${selfLine}`;

    const questions: Record<string, Question> = {
      reaction: { type: "choice", instructions: "What does Pesto do, without speaking, in response to the most recent thing that happened?", criteria: reactions as Record<string, string> },
      feeling: { type: "choice", instructions: "What does Pesto feel about what the person is doing right now?", criteria: FEELINGS as Record<string, string> },
      speak: {
        type: "noul",
        instructions: "Should Pesto say something out loud about this right now?",
        criteria: {
          yes: "Something notable just happened that a cheeky pet would comment on: a big context switch, a return after a long time away, something funny, something he was asked to watch for.",
          no: "It is routine, the person is concentrating or in a call, or he has spoken recently.",
        },
      },
      slacking: {
        type: "noul",
        instructions: "Is the person procrastinating right now?",
        criteria: {
          yes: "They are on social media, a feed, short videos, a game or idle browsing, especially after they had been working.",
          no: "They are working, creating, communicating, or deliberately taking a break with something like music or a film.",
        },
      },
    };

    this.inFlight = true;
    let res: SystemOneResponse;
    try {
      res = await postJson<SystemOneResponse>(`${config.decider.baseUrl.replace(/\/$/, "")}/v1/systemone`, { model: config.decider.model, state, questions });
      this.failures = 0;
    } catch (err) {
      if (/context length/i.test(String(err)) && this.recall > 0) {
        this.recall = Math.floor(this.recall / 2);
        this.due = this.deps.now();
        return;
      }
      this.failures++;
      console.warn(`decider: ${err}${this.failures >= 5 ? " (giving up until restart)" : ""}`);
      return;
    } finally {
      this.inFlight = false;
    }
    this.last = { at: this.deps.now(), state, answers: res.answers };

    const a = res.answers;
    const feeling = a.feeling?.type === "choice" && a.feeling.confidence > 0.38 ? (a.feeling.choice as Emotion) : null;
    const speak = a.speak?.type === "noul" ? a.speak.noul : 0;
    const slacking = a.slacking?.type === "noul" ? a.slacking.noul : 0;
    const focus = world.focused;
    const target = focus ? { window: focus.hwnd } : ("cursor" as const);
    const free = director.autonomous && (!actor.busy || actor.sitting) && !mind.busy;

    // Procrastination overrides the ordinary choice with the next rung of the ladder.
    if (slacking > 0.62 && focus) {
      if (this.slackFocus !== focus.hwnd || this.rung === 0) {
        if (this.rung === 0) this.slackSince = this.deps.now();
        this.slackFocus = focus.hwnd;
      }
      if (this.rung === 0 || this.rungHeld > 50) {
        this.rung = Math.min(LADDER.length - 1, this.rung + 1);
        this.rungHeld = 0;
        if (free) await this.pester(LADDER[this.rung], target);
      }
      return;
    }
    if (slacking < 0.35 && this.rung > 0) {
      // They stopped on their own. That deserves a little applause.
      const earned = this.rung >= 2;
      this.rung = 0;
      this.slackFocus = null;
      if (earned && free) {
        void director.perform("clap");
        return;
      }
    }

    const mayWake = mind.configured && this.deps.now() - mind.lastSpokeAt > config.mind.quietSeconds;
    if (speak > config.decider.speakAbove && mayWake && this.trigger) {
      void mind.wake({ kind: "event", why: this.trigger.text });
      return;
    }

    if (!free) return;
    const choice = a.reaction?.type === "choice" ? sample(a.reaction.probabilities) : "none";
    if (choice !== "none" && choice in reactions) {
      void director.perform(choice as ReactionName, { target, emotion: feeling ?? undefined });
    } else if (feeling && feeling !== "neutral" && (out || this.deps.director.can.eyes)) {
      void director.perform("emote", { emotion: feeling, seconds: 3 });
    }
  }

  /**
   * How he takes being called by name: the sound he makes, if any, and his
   * face while he listens. Null when the model is off or does not answer.
   */
  async called(): Promise<{ sound: string | null; feeling: Emotion | null } | null> {
    const { config, journal, actor, mind } = this.deps;
    if (!config.decider.enabled || this.failures >= 5) return null;
    const sounds: Record<string, string> = {
      none: "Nothing. He just looks at them and waits. They were already talking with him a moment ago.",
      huh: 'A short, curious "hm?". The ordinary answer.',
      chitter: "A pleased chitter. He is glad they finally want something from him.",
      grumble: "A grumble. He was asleep or busy, or they have been ignoring or annoying him.",
    };
    const hour = this.deps.director.hour();
    const state = [
      WHO,
      journal.brief(),
      actor.mode === "can" ? "Pesto was hidden inside his can." : actor.busy ? "Pesto was out of his can, in the middle of something." : "Pesto was out of his can, doing nothing much.",
      Number.isFinite(mind.lastSpokeAt) ? `He last spoke ${Math.round((this.deps.now() - mind.lastSpokeAt) / 60)} min ago.` : "He has not spoken yet today.",
      `It is ${hour}:00. The person just said his name out loud.`,
    ].join("\n");
    const questions: Record<string, Question> = {
      sound: { type: "choice", instructions: "What sound does Pesto make on hearing his name?", criteria: sounds },
      feeling: { type: "choice", instructions: "What does Pesto feel about being called right now?", criteria: FEELINGS as Record<string, string> },
    };
    try {
      const { answers: a } = await postJson<SystemOneResponse>(`${config.decider.baseUrl.replace(/\/$/, "")}/v1/systemone`, { model: config.decider.model, state, questions });
      const sound = a.sound?.type === "choice" ? sample(a.sound.probabilities) : "huh";
      return {
        sound: sound === "none" ? null : sound,
        feeling: a.feeling?.type === "choice" && a.feeling.confidence > 0.38 ? (a.feeling.choice as Emotion) : null,
      };
    } catch {
      return null;
    }
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

/** Picks an option at random in proportion to its (sharpened) probability, ignoring long shots. */
function sample(probabilities: Record<string, number>): string {
  const entries = Object.entries(probabilities)
    .filter(([, p]) => p >= 0.1)
    .map(([k, p]) => [k, Math.pow(p, 1.6)] as const);
  const total = entries.reduce((sum, [, p]) => sum + p, 0);
  if (total <= 0) return "none";
  let r = random() * total;
  for (const [k, p] of entries) if ((r -= p) <= 0) return k;
  return entries[entries.length - 1][0];
}
