import type { Config } from "../../config";
import { trace } from "../../debug/trace";
import { postJson } from "../../net";
import { random } from "../../pesto/math";
import type { Emotion } from "../../pesto/pose";
import type { Journal } from "../journal";
import { ASIDES, FEELINGS, type Backend, type CallScene, type Scene, type Taken, type Verdict } from "./backend";

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

export type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

interface SystemOneResponse {
  answers: Record<string, Answer>;
}

const WHO =
  "Pesto is a pet raccoon living in a trash can on this person's desktop, watching what they do. " +
  "He is nosy, cheeky and judgmental but cares about them, and mostly keeps quiet.";

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

const minutesAgo = (seconds: number) => (Number.isFinite(seconds) ? `He last spoke ${Math.round(seconds / 60)} min ago.` : "He has not spoken yet.");

/** Decisions asked of the System One model. Every method throws when the server does not answer. */
export class SystemOneDecider implements Backend {
  readonly label = "system one";
  /** The last decision, for debugging. */
  last: { at: number; state: string; answers: Record<string, Answer> } | null = null;

  private asked = { count: 0, ms: 0, failed: 0 };
  /** Journal lines given to the model. Shrinks when the server says the prompt does not fit its context. */
  private recall = 6;

  constructor(private deps: { config: Config; journal: Journal; now: () => number }) {}

  async react(scene: Scene): Promise<Verdict> {
    const { config, journal } = this.deps;
    const selfLine = [
      scene.out ? (scene.sitting ? "Pesto is out of his can, sitting and watching." : "Pesto is out of his can.") : "Pesto is hidden inside his can.",
      minutesAgo(scene.spokeAgo),
    ].join(" ");
    const questions: Record<string, Question> = {
      reaction: { type: "choice", instructions: "What does Pesto do, without speaking, in response to the most recent thing that happened?", criteria: scene.reactions as Record<string, string> },
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

    let a: Record<string, Answer>;
    for (;;) {
      const recent = this.recall > 0 ? journal.render(this.recall) : "";
      const state = `${WHO}\n\n${recent ? `Recently, oldest first:\n${recent}\n\n` : ""}${journal.brief()}\n${selfLine}`;
      try {
        a = await this.ask("react", state, questions);
        break;
      } catch (err) {
        if (!/context length/i.test(String(err)) || this.recall === 0) throw err;
        this.recall = Math.floor(this.recall / 2);
      }
    }
    const reaction = a.reaction?.type === "choice" ? sample(a.reaction.probabilities) : "none";
    return {
      reaction: reaction in scene.reactions ? (reaction as Verdict["reaction"]) : "none",
      feeling: a.feeling?.type === "choice" && a.feeling.confidence > 0.38 ? (a.feeling.choice as Emotion) : null,
      speak: a.speak?.type === "noul" && a.speak.noul > config.decider.speakAbove,
      slacking: a.slacking?.type === "noul" ? a.slacking.noul : 0,
    };
  }

  async aside(soFar: string, last: string | null): Promise<string | null> {
    const state = [
      "Pesto is a pet raccoon living in a trash can on this person's desktop: nosy, cheeky and judgmental, but he cares about them.",
      "The person is talking to him and he is listening.",
      `They said: "${soFar.split(/\s+/).slice(-45).join(" ")}"`,
    ].join("\n");
    const criteria = Object.fromEntries(Object.entries(ASIDES).filter(([name]) => name !== last).map(([name, a]) => [name, a.describe]));
    const { aside } = await this.ask("aside", state, { aside: { type: "choice", instructions: "How does Pesto react to what they just said?", criteria } });
    if (aside?.type !== "choice") return null;
    const [name, share] = Object.entries(aside.probabilities).sort((x, y) => y[1] - x[1])[0] ?? ["none", 0];
    return name !== "none" && name in ASIDES && share >= ASIDE_AT_LEAST ? name : null;
  }

  async replying(heard: string, hisLast: string): Promise<number | null> {
    const state = [
      WHO,
      hisLast ? `Pesto just said out loud: "${hisLast.split(/\s+/).slice(-40).join(" ")}"` : "Pesto just answered the person.",
      `A few seconds later, without saying his name, the microphone picked up: "${heard.split(/\s+/).slice(-45).join(" ")}"`,
    ].join("\n");
    const { forHim } = await this.ask("reply", state, {
      forHim: {
        type: "noul",
        instructions: "Was that said to Pesto?",
        criteria: {
          yes: "They answer him, ask him something, react to what he said or carry on the conversation with him.",
          no: "They talk to someone else or on a call, think out loud, read something aloud, or it is a video, music or noise in the room.",
        },
      },
    });
    return forHim?.type === "noul" ? forHim.noul : null;
  }

  async called(scene: CallScene): Promise<Taken> {
    const sounds: Record<string, string> = {
      none: "Nothing. He just looks at them and waits. They were already talking with him a moment ago.",
      huh: 'A short, curious "hm?". The ordinary answer.',
      chitter: "A pleased chitter. He is glad they finally want something from him.",
      grumble: "A grumble. He was asleep or busy, or they have been ignoring or annoying him.",
    };
    const state = [
      WHO,
      this.deps.journal.brief(),
      scene.asleep ? "Pesto was asleep inside his can." : scene.hidden ? "Pesto was hidden inside his can." : scene.busy ? "Pesto was out of his can, in the middle of something." : "Pesto was out of his can, doing nothing much.",
      Number.isFinite(scene.spokeAgo) ? minutesAgo(scene.spokeAgo) : "He has not spoken yet today.",
      `It is ${scene.hour}:00. The person just said his name out loud.`,
    ].join("\n");
    const a = await this.ask("called", state, {
      sound: { type: "choice", instructions: "What sound does Pesto make on hearing his name?", criteria: sounds },
      feeling: { type: "choice", instructions: "What does Pesto feel about being called right now?", criteria: FEELINGS as Record<string, string> },
    });
    const sound = a.sound?.type === "choice" ? sample(a.sound.probabilities) : "huh";
    return {
      sound: sound === "none" ? null : sound,
      feeling: a.feeling?.type === "choice" && a.feeling.confidence > 0.38 ? (a.feeling.choice as Emotion) : null,
    };
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
      trace.log("decider", `system one: ${what} ${took()}  ${Object.entries(answers).map(([name, a]) => `${name}: ${brief(a)}`).join("  |  ")}`);
      return answers;
    } catch (err) {
      this.asked.failed++;
      trace.log("decider", `system one: ${what} failed after ${took()}: ${err}`);
      throw err;
    } finally {
      const { count, ms, failed } = this.asked;
      trace.set("decider", `system one: ${count} answers, ${count ? Math.round(ms / count) : 0} ms on average, ${failed} failed`);
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
