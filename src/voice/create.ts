import type { Config } from "../config";
import type { World } from "../world/world";
import { ElevenVoice } from "./eleven";
import { SilentVoice, type Voice } from "./voice";

/** Builds the voice the config asks for, falling back to captions only. */
export function createVoice(config: Config, world: World): Voice {
  const { provider, apiKey, voiceId } = config.voice;
  if (provider === "elevenlabs" && apiKey && voiceId) return new ElevenVoice(config, () => world.primary?.rect ?? null);
  return new SilentVoice();
}
