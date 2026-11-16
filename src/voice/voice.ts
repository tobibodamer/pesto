import type { Vec } from "../pesto/math";

/** One line of speech, synthesised (or timed) and ready to play. */
export interface Line {
  /** Starts it. Safe to call once. */
  play(): Utterance;
  /** Drops it unplayed. */
  discard(): void;
}

export interface Utterance {
  /** Resolves when sound (or the caption) actually begins. */
  started: Promise<void>;
  /** Resolves when it has finished or was stopped. */
  finished: Promise<void>;
  /** Mouth openness right now, 0..1. */
  level(): number;
  stop(): void;
}

/**
 * How Pesto is heard. `where` is asked every frame while he speaks, so the
 * voice can follow him across the screens.
 */
export interface Voice {
  /** Begins preparing a line immediately, so it is ready by the time it is needed. */
  prepare(text: string): Line;
  /** A short non-verbal sound: "knock", "clank", "chitter", … Unknown names are ignored. */
  cue(name: string): void;
  /** Call every frame with where his mouth is and whether he is inside the can. */
  place(where: Vec, muffled: boolean): void;
  /** Whether lines are audible. When false, callers should show captions. */
  readonly audible: boolean;
}

const WORDS_PER_SECOND = 3.1;

/** Strips bracketed delivery cues like [chuckles], which are for the synthesiser, not for reading. */
export const spokenText = (text: string) => text.replace(/\[[^\]]{1,40}\]/g, "").replace(/\s+/g, " ").trim();

/**
 * The silent voice: takes as long as the line would take to say and flaps
 * his mouth in rhythm, so captions and gestures stay in step without audio.
 */
export class SilentVoice implements Voice {
  readonly audible = false;

  prepare(text: string): Line {
    const words = spokenText(text).split(" ").filter(Boolean).length;
    const seconds = Math.max(0.7, words / WORDS_PER_SECOND + 0.25);
    return {
      discard() {},
      play() {
        const t0 = performance.now();
        let stopped = false;
        let done!: () => void;
        const finished = new Promise<void>((r) => (done = r));
        const timer = setTimeout(done, seconds * 1000);
        return {
          started: Promise.resolve(),
          finished,
          level() {
            const t = (performance.now() - t0) / 1000;
            if (stopped || t > seconds) return 0;
            // Roughly syllable-rate flapping with some variation.
            return Math.max(0, Math.sin(t * 19) * 0.55 + Math.sin(t * 7.3) * 0.3 + 0.25);
          },
          stop() {
            stopped = true;
            clearTimeout(timer);
            done();
          },
        };
      },
    };
  }

  cue() {}
  place() {}
}
