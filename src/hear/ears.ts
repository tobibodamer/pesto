import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Decider } from "../brain/decider";
import type { Director } from "../brain/director";
import type { Journal } from "../brain/journal";
import type { Mind } from "../brain/mind";
import type { Config } from "../config";
import type { Actor } from "../pesto/actor";

/** Events from the microphone side (`src-tauri/src/hear`). */
interface HearEvents {
  /** The wake word was heard. */
  "hear://wake": { keyword: string };
  /** Their voice while he listens, about 25 times a second. */
  "hear://voice": { level: number; speaking: boolean };
  /** Their turn is over. `text` is null when nothing was understood, `spoke` whether they said anything at all. */
  "hear://ended": { text: string | null; spoke: boolean };
  /** Whether the microphone is being listened to, and why not if it is not. */
  "hear://status": { ready: boolean; error: string | null };
}

/** How long after his name he waits to see whether they keep talking before he makes a sound. */
const ACK_AFTER_MS = 300;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Being called and spoken to. The microphone side reports his name, their
 * voice and the end of their turn; this turns those into the conversation:
 * he snaps to attention at once, acknowledges if they pause, listens visibly,
 * and hands what they said to the mind.
 */
export class Ears {
  /** Whether he is listening to a turn right now. */
  listening = false;
  status: HearEvents["hear://status"] = { ready: false, error: null };

  private calls = 0;

  constructor(
    private deps: {
      config: Config;
      director: Director;
      actor: Actor;
      journal: Journal;
      mind: Mind;
      decider: Decider;
    },
  ) {}

  async connect() {
    const on = <K extends keyof HearEvents>(name: K, fn: (payload: HearEvents[K]) => void) => listen<HearEvents[K]>(name, (e) => fn(e.payload));
    await on("hear://status", (s) => {
      this.status = s;
      if (s.error) console.warn("ears:", s.error);
    });
    await on("hear://wake", () => void this.called());
    await on("hear://voice", (v) => {
      if (this.listening) this.deps.director.hearing = v;
    });
    await on("hear://ended", (e) => void this.ended(e));
    this.enable(this.deps.config.hear.enabled);
  }

  enable(on: boolean) {
    const { hear } = this.deps.config;
    void invoke("hear_enable", { on, threshold: hear.threshold }).catch((err) => console.warn("ears:", err));
    if (!on && this.listening) this.relax();
  }

  /** Plays a WAV into his ears in place of the microphone, for trying things without saying them. */
  feed(path: string) {
    return invoke("hear_feed", { path });
  }

  private async called() {
    const { director, actor, mind, decider, journal } = this.deps;
    const call = ++this.calls;
    const wasTalking = actor.talking;
    const again = this.listening;
    // Asked before anything else so the answer is there by the time it is needed.
    const take = decider.called();

    mind.interrupt();
    this.listening = true;
    director.listen(true, { called: !again });
    journal.add("user", "called your name", 0);

    await sleep(ACK_AFTER_MS);
    const taken = await Promise.race([take, sleep(250).then(() => null)]);
    if (call !== this.calls || !this.listening) return;
    if (taken?.feeling && taken.feeling !== "neutral") actor.feel(taken.feeling, 600);
    // A sound only into silence: never over them, and not right after being cut off.
    if (director.hearing.speaking || wasTalking || again) return;
    const sound = taken ? taken.sound : actor.mood === "sleepy" ? "grumble" : "huh";
    if (sound) actor.cue(sound);
  }

  private async ended(e: HearEvents["hear://ended"]) {
    if (!this.listening) return;
    const { director, actor, mind, config } = this.deps;
    if (!e.text) {
      this.relax();
      if (e.spoke) actor.feel("unsure", 2.5);
      return;
    }
    this.listening = false;
    director.hearing = { level: 0, speaking: false };
    const call = this.calls;
    await mind.wake({ kind: "said", text: e.text });
    if (call !== this.calls || this.listening) return;
    if (config.hear.followUp <= 0 || !config.hear.enabled) return director.listen(false);
    // He stays with them for a moment: a reply needs no name.
    try {
      await invoke("hear_listen", { seconds: config.hear.followUp });
      this.listening = true;
      director.listen(true);
    } catch {
      director.listen(false);
    }
  }

  private relax() {
    this.listening = false;
    this.deps.director.listen(false);
  }
}
