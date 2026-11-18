import type { Config } from "../config";
import { trace } from "../debug/trace";
import { postJson } from "../net";
import type { Actor } from "../pesto/actor";
import type { ListenMove } from "../pesto/listening";
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

type Aside = { describe: string; move?: ListenMove; emotion?: Emotion; seconds?: number };

/**
 * What he can do while someone is still talking to him, without interrupting
 * them: a face, a small movement, or both. All of it is silent. Each says
 * what kind of sentence brings it on and then what he does, in that order
 * and without hedging: the model sorts what was said far more surely than it
 * judges whether he would react, and how sure it has to be is decided here.
 */
export const ASIDES: Record<string, Aside> = {
  none: { describe: "An ordinary request, question, greeting or remark, so he just keeps listening." },
  nod: { describe: "They explain their reasons or make a fair point, so he nods.", move: "nod" },
  intrigued: { describe: "Food, a treat or a secret, so he leans in.", move: "lean", emotion: "curious" },
  puzzled: { describe: "Confusing or self-contradicting, so he tilts his head.", move: "puzzle", emotion: "unsure", seconds: 2.5 },
  pondering: { describe: "A riddle or a hard question for him, so he looks up, thinking.", emotion: "thinking", seconds: 3 },
  attentive: { describe: "Exact codes, numbers or steps to remember, so he concentrates.", emotion: "focused", seconds: 3.5 },
  overwhelmed: { describe: "A flood of jargon or tangled technical detail, so his head spins.", emotion: "dizzy", seconds: 3 },
  amused: { describe: "A funny thing that happened, so he grins.", emotion: "happy", seconds: 2.5 },
  content: { describe: "They say they like him, so he settles, pleased.", emotion: "pleased", seconds: 3 },
  delighted: { describe: "Really good news, so he lights up.", emotion: "delighted", seconds: 2.5 },
  proud: { describe: "Praise or thanks for him, so he preens.", emotion: "proud", seconds: 3 },
  smug: { describe: "They admit he was right or that they made a silly mistake, so he smirks.", emotion: "smug", seconds: 3 },
  deadpan: { describe: "A worn-out joke or a bad pun, so he stares blankly.", emotion: "neutral", seconds: 2.5 },
  sorry: { describe: "Sad news, a loss or a death, so his ears droop.", emotion: "sad", seconds: 4 },
  wincing: { describe: "They hurt themselves, or something gross, so he winces.", emotion: "strained", seconds: 2.5 },
  alarmed: { describe: "Sudden danger, a disaster or an accident, so he pulls back, wide-eyed.", move: "recoil", emotion: "surprised", seconds: 2 },
  worried: { describe: "They are in trouble or afraid of what is coming, so he looks anxious.", emotion: "scared", seconds: 3 },
  disapproving: { describe: "A plan that is clearly a bad idea, so he shakes his head.", move: "shake", emotion: "annoyed", seconds: 2.5 },
  offended: { describe: "An insult to him, his can or raccoons, so he glares.", emotion: "glare", seconds: 3 },
  grumpy: { describe: "Nagging, or a chore for him, so he scowls.", emotion: "grumpy", seconds: 3 },
  guilty: { describe: "They accuse him of doing or breaking something, so he looks caught out.", emotion: "guilty", seconds: 3.5 },
  bored: { describe: "Rambling about something dull, so his eyelids sag.", emotion: "sleepy", seconds: 3.5 },
  dozing: { describe: "Endless tedious droning, so he nods off.", emotion: "asleep", seconds: 2 },
};

/** The share of the model's answer a reaction needs before he shows it. Lower makes him livelier, higher stiller. */
const ASIDE_AT_LEAST = 0.45;

/** An answer in a few words: the likeliest choices with their share, or the number. */
function brief(a: Answer): string {
  if (a.type === "noul") return a.noul.toFixed(2);
  return Object.entries(a.probabilities)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([name, p]) => `${name} ${p.toFixed(2)}`)
    .join(", ");
}

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
  private asked = { count: 0, ms: 0, failed: 0 };
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

  /** Tries the model again after it kept failing, for when its settings have changed. */
  retry() {
    this.failures = 0;
  }

  update(dt: number) {
    const { config, world, mind, actor, director } = this.deps;
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
    if (mind.busy || director.attentive || actor.mode === "held" || actor.mode === "air") return;
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
      res = { answers: await this.ask("react", state, questions) };
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

    // They may have started talking to him while the model was deciding.
    if (director.attentive) return trace.log("decider", "→ nothing: he is listening to them");
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
        trace.log("decider", `→ pester: ${LADDER[this.rung]}${free ? "" : ", but he is busy"}`);
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
      trace.log("decider", `→ speaks up about: ${this.trigger.text}`);
      void mind.wake({ kind: "event", why: this.trigger.text });
      return;
    }

    if (!free) return trace.log("decider", "→ nothing: he is busy");
    const choice = a.reaction?.type === "choice" ? sample(a.reaction.probabilities) : "none";
    trace.log("decider", `→ ${choice}${feeling ? `, feeling ${feeling}` : ""}`);
    if (choice !== "none" && choice in reactions) {
      void director.perform(choice as ReactionName, { target, emotion: feeling ?? undefined });
    } else if (feeling && feeling !== "neutral" && (out || this.deps.director.can.eyes)) {
      void director.perform("emote", { emotion: feeling, seconds: 3 });
    }
  }

  /**
   * What, if anything, shows on him at what they have said so far, while they
   * are still talking. Null means keep listening as he was, which it mostly is.
   */
  async aside(soFar: string, last: string | null): Promise<string | null> {
    const { config } = this.deps;
    if (!config.decider.enabled || this.failures >= 5) return null;
    const state = [
      "Pesto is a pet raccoon living in a trash can on this person's desktop: nosy, cheeky and judgmental, but he cares about them.",
      "The person is talking to him and he is listening.",
      `They said: "${soFar.split(/\s+/).slice(-45).join(" ")}"`,
    ].join("\n");
    const criteria = Object.fromEntries(Object.entries(ASIDES).filter(([name]) => name !== last).map(([name, a]) => [name, a.describe]));
    const questions: Record<string, Question> = { aside: { type: "choice", instructions: "How does Pesto react to what they just said?", criteria } };
    try {
      const { aside } = await this.ask("aside", state, questions);
      if (aside?.type !== "choice") return null;
      const [name, share] = Object.entries(aside.probabilities).sort((x, y) => y[1] - x[1])[0] ?? ["none", 0];
      return name !== "none" && name in ASIDES && share >= ASIDE_AT_LEAST ? name : null;
    } catch (err) {
      console.warn(`decider: ${err}`);
      return null;
    }
  }

  /**
   * How likely it is, 0..1, that what they said right after his answer was
   * meant for him. Null when the model is off or does not answer.
   */
  async replying(heard: string, hisLast: string): Promise<number | null> {
    const { config } = this.deps;
    if (!config.decider.enabled || this.failures >= 5) return null;
    const state = [
      WHO,
      hisLast ? `Pesto just said out loud: "${hisLast.split(/\s+/).slice(-40).join(" ")}"` : "Pesto just answered the person.",
      `A few seconds later, without saying his name, the microphone picked up: "${heard.split(/\s+/).slice(-45).join(" ")}"`,
    ].join("\n");
    const questions: Record<string, Question> = {
      forHim: {
        type: "noul",
        instructions: "Was that said to Pesto?",
        criteria: {
          yes: "They answer him, ask him something, react to what he said or carry on the conversation with him.",
          no: "They talk to someone else or on a call, think out loud, read something aloud, or it is a video, music or noise in the room.",
        },
      },
    };
    try {
      const { forHim } = await this.ask("reply", state, questions);
      return forHim?.type === "noul" ? forHim.noul : null;
    } catch (err) {
      console.warn(`decider: ${err}`);
      return null;
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
      this.deps.director.asleep ? "Pesto was asleep inside his can." : actor.mode === "can" ? "Pesto was hidden inside his can." : actor.busy ? "Pesto was out of his can, in the middle of something." : "Pesto was out of his can, doing nothing much.",
      Number.isFinite(mind.lastSpokeAt) ? `He last spoke ${Math.round((this.deps.now() - mind.lastSpokeAt) / 60)} min ago.` : "He has not spoken yet today.",
      `It is ${hour}:00. The person just said his name out loud.`,
    ].join("\n");
    const questions: Record<string, Question> = {
      sound: { type: "choice", instructions: "What sound does Pesto make on hearing his name?", criteria: sounds },
      feeling: { type: "choice", instructions: "What does Pesto feel about being called right now?", criteria: FEELINGS as Record<string, string> },
    };
    try {
      const a = await this.ask("called", state, questions);
      const sound = a.sound?.type === "choice" ? sample(a.sound.probabilities) : "huh";
      return {
        sound: sound === "none" ? null : sound,
        feeling: a.feeling?.type === "choice" && a.feeling.confidence > 0.38 ? (a.feeling.choice as Emotion) : null,
      };
    } catch {
      return null;
    }
  }

  /** One request to the decision model, timed and traced. */
  private async ask(what: string, state: string, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    const { config } = this.deps;
    const started = performance.now();
    const took = () => `${Math.round(performance.now() - started)} ms`;
    try {
      const { answers } = await postJson<SystemOneResponse>(`${config.decider.baseUrl.replace(/\/$/, "")}/v1/systemone`, { model: config.decider.model, state, questions });
      this.last = { at: this.deps.now(), state, answers };
      this.asked.count++;
      this.asked.ms += performance.now() - started;
      trace.log("decider", `${what} ${took()}  ${Object.entries(answers).map(([name, a]) => `${name}: ${brief(a)}`).join("  |  ")}`);
      return answers;
    } catch (err) {
      this.asked.failed++;
      trace.log("decider", `${what} failed after ${took()}: ${err}`);
      throw err;
    } finally {
      const { count, ms, failed } = this.asked;
      trace.set("decider", `${count} answers, ${count ? Math.round(ms / count) : 0} ms on average, ${failed} failed`);
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
