import { invoke } from "@tauri-apps/api/core";

/**
 * User settings, read from `config.json` in the app's config directory
 * (%APPDATA%\dev.pesto.app on Windows). Anything missing falls back to
 * DEFAULTS, so the file only needs the keys someone wants to change.
 */
export interface Config {
  /** The person he lives with. All of it is told to the mind. */
  you: {
    name: string;
    /** Their work, studies or whatever fills their days. */
    occupation: string;
    /** "YYYY-MM-DD", or empty. */
    birthday: string;
    /** The language he speaks. Empty follows whatever they speak to him. */
    language: string;
    /** Anything else he should know, in their own words. */
    notes: string;
  };
  /** The big model that speaks and plans. Any OpenAI-compatible chat endpoint. */
  mind: {
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    /** How long the model may think before answering. Empty leaves the provider's default. */
    reasoningEffort: string;
    /** Minimum seconds between times he speaks up unprompted. */
    quietSeconds: number;
  };
  /** The small local model that decides his silent reactions. Ollama's /v1/systemone. */
  decider: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    /** Probability above which "should he speak" wakes the mind. */
    speakAbove: number;
  };
  voice: {
    provider: "elevenlabs" | "none";
    apiKey: string;
    voiceId: string;
    model: string;
    /** 0..1. Lower is more expressive and less predictable. */
    stability: number;
    /** 0..1 */
    volume: number;
    /** Show what he says as a speech bubble too. Always on when there is no voice. */
    captions: boolean;
    /** Keeps the voice configured but silent; he falls back to speech bubbles. */
    muted: boolean;
    /** How far to the sides he is heard, 0..1: 0 is always straight ahead, 1 is the true angle to where he stands. Sounds follow it too. */
    width: number;
  };
  /** His little noises: knocks, huffs, squeaks. Local files, so they need no voice provider. */
  sfx: {
    enabled: boolean;
    /** 0..1, all of them. The groups below scale it; 0 silences a group. */
    volume: number;
    /** "hm?", chitters, grumbles, yelps, squeaks. */
    reactions: number;
    /** Huffs, pants and strain while he climbs and runs. */
    breathing: number;
    /** Rustling, chewing, muttering and snoring from inside the can, and its lid. */
    can: number;
    /** Knocks, thuds, landings, swats and clanks. */
    bumps: number;
  };
  /** The microphone: his name, and what is said to him after it. */
  hear: {
    enabled: boolean;
    /** How sure the wake word detector must be that it heard "Pesto", 0..1. Lower hears him called more easily, and by mistake more often. */
    threshold: number;
    /** Seconds after he finishes answering in which a reply needs no name. 0 turns it off. */
    followUp: number;
    /** Replies without his name in a row before he needs it again. 0 allows any number. */
    followUpReplies: number;
    /** Fewest words, not counting "hm" and "uh", a reply without his name needs. */
    followUpWords: number;
    /** How sure the decision model must be that a reply without his name was meant for him, 0..1. 0 skips asking. */
    followUpCheck: number;
    /** Lets what they are saying show on his face while they are still talking. Needs the decision model and speech to text. */
    asides: boolean;
    /** What turns speech into text. With "none" he hears his name but not what is said. */
    provider: "elevenlabs" | "none";
    /** Empty uses the voice's key. */
    apiKey: string;
    /** `scribe_v3_live` ends a turn when the thought is finished; `scribe_v2_realtime` waits for silence. */
    model: string;
    /** ISO 639-1 code such as "en" or "de". Empty lets it work out the language, and mix them. */
    language: string;
  };
  /** Claude Code, the coding agent he hands jobs to and keeps an eye on. */
  agents: {
    /** Lets their own Claude Code sessions tell him when they finish or ask for something, through hooks in ~/.claude/settings.json. */
    watch: boolean;
    /** Where on localhost he listens for those hooks. */
    port: number;
    /** Shared with the hooks so only they are heard. Made on first start. */
    token: string;
    /** How the Claude Code command is called. */
    command: string;
    /** How much the runs he starts may do without asking: Claude Code's permission mode. */
    permissionMode: string;
    /** Empty uses Claude Code's default. */
    model: string;
  };
  debug: {
    /** Shows what his ears and the decision model are doing in a corner of the screen he is on. */
    panel: boolean;
  };
  body: {
    /** Pixels per character unit; he is about 150 units tall. His can and its junk grow and shrink with him. */
    scale: number;
    /** The can's size next to his, on top of `scale`. 1 keeps them as drawn. */
    can: number;
    /** Thickness of the white sticker border around him and his can, in character units. 0 removes it. */
    border: number;
  };
}

export const DEFAULTS: Config = {
  you: { name: "", occupation: "", birthday: "", language: "", notes: "" },
  mind: { baseUrl: "", apiKey: "", model: "", temperature: 0.9, reasoningEffort: "low", quietSeconds: 240 },
  decider: { enabled: true, baseUrl: "http://triton:11434", model: "d1:2b-q8_0", speakAbove: 0.72 },
  voice: { provider: "none", apiKey: "", voiceId: "", model: "eleven_v4_turbo", stability: 0.35, volume: 0.9, captions: false, muted: false, width: 0.3 },
  sfx: { enabled: true, volume: 0.9, reactions: 1, breathing: 1, can: 1, bumps: 1 },
  hear: { enabled: true, threshold: 0.25, followUp: 5, followUpReplies: 2, followUpWords: 1, followUpCheck: 0.5, asides: true, provider: "elevenlabs", apiKey: "", model: "scribe_v3_live", language: "" },
  agents: { watch: false, port: 47733, token: "", command: "claude", permissionMode: "acceptEdits", model: "" },
  debug: { panel: false },
  body: { scale: 0.8, can: 1, border: 0 },
};

function merge<T>(base: T, patch: unknown): T {
  if (patch == null || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in out)) continue;
    const current = out[k];
    out[k] = current && typeof current === "object" ? merge(current, v) : typeof v === typeof current ? v : current;
  }
  return out as T;
}

export async function loadConfig(): Promise<Config> {
  try {
    return merge(DEFAULTS, await invoke<unknown>("config_load"));
  } catch (err) {
    console.warn("config: using defaults", err);
    return structuredClone(DEFAULTS);
  }
}

export type Patch<T> = { [K in keyof T]?: T[K] extends object ? Patch<T[K]> : T[K] };

/** Folds a patch into `config` in place, so everything holding it sees the change. */
export function absorb(config: Config, patch: unknown) {
  const next = merge(config, patch);
  for (const key of Object.keys(next) as (keyof Config)[]) Object.assign(config[key], next[key]);
}

/** Writes changed settings back to config.json; keys not mentioned are left alone. */
export function saveConfig(patch: Patch<Config>): Promise<void> {
  return invoke<void>("config_patch", { patch }).catch((err) => console.warn("config: not saved", err));
}
