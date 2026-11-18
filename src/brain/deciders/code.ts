import type { Config } from "../../config";
import type { Emotion } from "../../pesto/pose";
import type { ReactionName } from "../director";
import { weighted, type Backend, type CallScene, type Scene, type Taken, type Verdict } from "./backend";

type Odds = Partial<Record<ReactionName, number>>;

/** The chance of speaking up at a check-in when `decider.speakUp` is "sometimes". */
export const SOMETIMES = 0.2;
/** Seconds after a reaction he picked himself before he picks another, so he does not twitch at every window. */
export const REST = 25;

/** The odds of each reaction to what just happened; whatever is left over is doing nothing. */
function odds(scene: Scene): Odds {
  const { trigger: t, out } = scene;
  if (!t) {
    if (!scene.checkIn) return {};
    return out ? { glance: 0.08, goHome: scene.sitting ? 0.06 : 0.12 } : { peek: 0.08, rustle: 0.06 };
  }
  // His reflexes already answer being touched; how he feels about it is left to `touched`.
  if (t.kind === "touch" || t.kind === "user" || t.kind === "pesto") return {};
  if (t.kind === "audio") {
    if (!t.text.startsWith("▶") || !scene.playing) return {};
    return out ? { dance: 0.35, glance: 0.2 } : { peek: 0.2, rustle: 0.15 };
  }
  if (t.text === "the person is back") return out ? { approach: 0.3, glance: 0.4 } : { peek: 0.4, approach: 0.15 };
  if (/^(switched to|opened) /.test(t.text)) return out ? { glance: 0.25, approach: 0.05 } : { rustle: 0.12, peek: 0.1, approach: 0.02 };
  if (/ now shows /.test(t.text)) return out ? { glance: 0.15 } : { rustle: 0.06 };
  if (t.text.startsWith("closed ")) return out ? { glance: 0.12 } : { rustle: 0.08 };
  return {};
}

const TOUCHED: [RegExp, Emotion, number][] = [
  [/^petted/, "happy", 0.7],
  [/^(threw|shook)|mid-air/, "grumpy", 0.7],
  [/^poked/, "annoyed", 0.5],
  [/^picked .* up/, "surprised", 0.3],
];

function feeling(scene: Scene, reaction: ReactionName | "none", rand: () => number): Emotion | null {
  const t = scene.trigger;
  if (t?.kind === "touch") {
    const hit = TOUCHED.find(([re]) => re.test(t.text));
    return hit && rand() < hit[2] ? hit[1] : null;
  }
  if (reaction === "approach" || reaction === "peek") return rand() < 0.5 ? "curious" : null;
  return null;
}

export function speaksUp(mode: Config["decider"]["speakUp"], checkIn: boolean, rand: () => number): boolean {
  if (!checkIn || mode === "never") return false;
  return mode === "always" || rand() < SOMETIMES;
}

/**
 * Decisions made in code, for when there is no decision model: simple odds
 * per kind of event, a rest after each reaction, and no judgment of what
 * they are doing, so no pestering and nothing while they talk.
 */
export class CodeDecider implements Backend {
  readonly label = "code";
  private restUntil = -Infinity;

  constructor(private deps: { config: Config; now: () => number; rand: () => number }) {}

  async react(scene: Scene): Promise<Verdict> {
    const { config, now, rand } = this.deps;
    const allowed = Object.fromEntries(Object.entries(odds(scene)).filter(([name]) => name in scene.reactions)) as Odds;
    const left = Math.max(0, 1 - Object.values(allowed).reduce((sum, p) => sum + (p ?? 0), 0));
    const resting = now() < this.restUntil;
    const reaction = resting ? "none" : (weighted<ReactionName | "none">({ ...allowed, none: left }, rand) ?? "none");
    if (reaction !== "none") this.restUntil = now() + REST;
    return { reaction, feeling: feeling(scene, reaction, rand), speak: speaksUp(config.decider.speakUp, scene.checkIn, rand), slacking: null };
  }

  async called(scene: CallScene): Promise<Taken> {
    const { rand } = this.deps;
    const sounds: Record<string, number> =
      scene.asleep ? { grumble: 0.7, huh: 0.3 }
      : scene.spokeAgo < 30 ? { none: 0.6, huh: 0.4 }
      : scene.mood === "grumpy" || scene.mood === "annoyed" ? { grumble: 0.5, huh: 0.5 }
      : scene.mood === "sleepy" ? { grumble: 0.4, huh: 0.6 }
      : scene.busy ? { huh: 0.6, grumble: 0.25, chitter: 0.15 }
      : { huh: 0.65, chitter: 0.25, grumble: 0.1 };
    const sound = weighted(sounds, rand) ?? "huh";
    const face: Emotion | null =
      scene.asleep || scene.mood === "sleepy" ? "sleepy"
      : sound === "chitter" ? "happy"
      : sound === "grumble" ? "grumpy"
      : sound === "huh" && rand() < 0.5 ? "curious"
      : null;
    return { sound: sound === "none" ? null : sound, feeling: face };
  }

  async aside(): Promise<string | null> {
    return null;
  }

  async replying(): Promise<number | null> {
    return null;
  }
}
