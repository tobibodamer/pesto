import type { Config } from "../config";
import type { Vec } from "../pesto/math";
import type { World } from "../world/world";
import { ElevenVoice } from "./eleven";
import { SilentVoice, type Line, type Voice } from "./voice";

/**
 * The voice the config asks for, falling back to captions only. Rebuilt in
 * place when settings change, so everything holding it keeps working.
 */
export class ConfiguredVoice implements Voice {
  private current: Voice = new SilentVoice();
  private built = false;

  constructor(
    private config: Config,
    private world: World,
  ) {
    this.rebuild();
  }

  get audible() {
    return this.current.audible;
  }

  /** Switches between the real voice and captions when the provider or its key has come or gone. */
  rebuild() {
    const { provider, apiKey, voiceId } = this.config.voice;
    const wanted = provider === "elevenlabs" && !!apiKey && !!voiceId;
    if (wanted === this.built) return;
    this.current.close?.();
    this.current = wanted ? new ElevenVoice(this.config, () => this.world.primary?.rect ?? null) : new SilentVoice();
    this.built = wanted;
  }

  prepare(text: string): Line {
    return this.current.prepare(text);
  }

  cue(name: string) {
    this.current.cue(name);
  }

  place(where: Vec, muffled: boolean) {
    this.current.place(where, muffled);
  }
}
