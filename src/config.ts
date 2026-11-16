import { invoke } from "@tauri-apps/api/core";

/**
 * User settings, read from `config.json` in the app's config directory
 * (%APPDATA%\dev.pesto.app on Windows). Anything missing falls back to
 * DEFAULTS, so the file only needs the keys someone wants to change.
 */
export interface Config {
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
  };
  body: {
    /** Pixels per character unit; he is about 150 units tall. */
    scale: number;
    /** Thickness of the white sticker border around him and his can, in character units. 0 removes it. */
    border: number;
  };
}

export const DEFAULTS: Config = {
  mind: { baseUrl: "", apiKey: "", model: "", temperature: 0.9, reasoningEffort: "low", quietSeconds: 240 },
  decider: { enabled: true, baseUrl: "http://triton:11434", model: "d1:2b-q8_0", speakAbove: 0.72 },
  voice: { provider: "none", apiKey: "", voiceId: "", model: "eleven_v4_turbo", stability: 0.35, volume: 0.9, captions: false },
  body: { scale: 0.8, border: 1.5 },
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
