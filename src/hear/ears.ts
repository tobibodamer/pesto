import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ASIDES, type Decider } from "../brain/decider";
import type { Director } from "../brain/director";
import type { Journal } from "../brain/journal";
import type { Mind } from "../brain/mind";
import type { Config } from "../config";
import { trace } from "../debug/trace";
import type { Actor } from "../pesto/actor";
import type { Paper } from "../stage/bubble";

/** Events from the microphone side (`src-tauri/src/hear`). */
interface HearEvents {
  /** The wake word was heard. */
  "hear://wake": { keyword: string };
  /** They started talking over him while he spoke. A turn without his name has begun. */
  "hear://barge": Record<string, never>;
  /** Their voice while he listens, about 25 times a second. */
  "hear://voice": { level: number; speaking: boolean };
  /** What they have said so far in this turn, and how finished it sounds, 0..1, when the transcriber can tell. */
  "hear://words": { text: string; done: number | null };
  /** Their turn is over. `text` is null when nothing was understood, `spoke` whether they said anything at all. */
  "hear://ended": { text: string | null; spoke: boolean };
  /** Whether the microphone is being listened to, and why not if it is not. */
  "hear://status": { ready: boolean; error: string | null };
}

/** How long after his name he waits to see whether they keep talking before he makes a sound. */
const ACK_AFTER_MS = 300;

/** Words they must have said before he reacts to any of it: short requests get plain attention. */
const ASIDE_AFTER_WORDS = 7;
/** New words needed since the last look before it is worth another. */
const ASIDE_NEW_WORDS = 5;
/** Least seconds between two looks at what they are saying, and between two visible reactions. */
const ASIDE_EVERY = 2.2;
const ASIDE_REST = 5;
/** Most reactions in one turn. */
const ASIDE_MOST = 3;

/** Sounds a transcriber makes words of that say nothing on their own. */
const FILLER = /^(h+m+|m+h+m+|u+h+m*|u+m+|ä+h+m*|e+h+m*|a+h+|o+h+)$/;

const count = (text: string) => text.split(/\s+/).filter(Boolean).length;
const meaningful = (text: string) =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}']/gu, ""))
    .filter((w) => w && !FILLER.test(w)).length;
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
  /** What they have said so far in the turn being listened to. */
  words: HearEvents["hear://words"] = { text: "", done: null };

  private calls = 0;
  /** Turns in a row heard without his name, the current one included. 0 while he was called by name. */
  private nameless = 0;
  private asides = { judged: 0, judgedAt: 0, shownAt: -Infinity, shown: 0, last: null as string | null, busy: false };
  private told = false;
  /** Whether his ears are watching for their voice over his, and whether the turn being heard began that way. */
  private overHim = false;
  private cutIn = false;

  constructor(
    private deps: {
      config: Config;
      director: Director;
      actor: Actor;
      journal: Journal;
      mind: Mind;
      decider: Decider;
      paper: Paper;
      now: () => number;
    },
  ) {}

  async connect() {
    const on = <K extends keyof HearEvents>(name: K, fn: (payload: HearEvents[K]) => void) => listen<HearEvents[K]>(name, (e) => fn(e.payload));
    await on("hear://status", (s) => {
      this.status = s;
      if (!s.error) return;
      console.warn("ears:", s.error);
      trace.log("hear", s.error);
      // Hearing them but not their words would otherwise look like him ignoring them.
      if (this.told || !s.error.startsWith("speech to text")) return;
      this.told = true;
      const why = /auth|permission/i.test(s.error)
        ? "The ElevenLabs key needs the **Speech to Text** permission, or put another key in `hear.apiKey`."
        : s.error;
      this.deps.paper.show(`I hear you, but not the words. ${why}`, "note", 12, this.deps.now());
    });
    await on("hear://wake", () => void this.called());
    await on("hear://barge", () => this.talkedOver());
    await on("hear://voice", (v) => {
      if (this.listening) this.deps.director.hearing = v;
    });
    await on("hear://words", (w) => {
      this.words = w;
      if (trace.on) trace.set("heard", `${count(w.text)} words${w.done == null ? "" : `, ${w.done.toFixed(2)} finished`}  …${w.text.split(/\s+/).slice(-9).join(" ")}`);
      void this.aside();
    });
    await on("hear://ended", (e) => void this.ended(e));
    this.enable(this.deps.config.hear.enabled);
  }

  enable(on: boolean) {
    const { hear, voice } = this.deps.config;
    const apiKey = hear.apiKey || voice.apiKey;
    const stt = hear.provider === "elevenlabs" && apiKey ? { apiKey, model: hear.model, language: hear.language } : null;
    void invoke("hear_enable", { on, threshold: hear.threshold, stt }).catch((err) => console.warn("ears:", err));
    if (!on && this.listening) this.relax();
  }

  /** Call every frame with whether he is speaking, so that their voice over his cuts him off. */
  speaking(on: boolean) {
    const { hear } = this.deps.config;
    const want = on && hear.enabled && hear.bargeIn;
    if (want === this.overHim) return;
    this.overHim = want;
    void invoke("hear_talking", { on: want }).catch(() => {});
  }

  /** Plays a WAV into his ears in place of the microphone, for trying things without saying them. */
  feed(path: string) {
    return invoke("hear_feed", { path });
  }

  private async called() {
    const { director, actor, mind, decider, journal } = this.deps;
    const call = ++this.calls;
    this.nameless = 0;
    const wasTalking = actor.talking;
    const again = this.listening;
    const woke = director.asleep;
    // Asked before anything else so the answer is there by the time it is needed.
    const take = decider.called();

    mind.interrupt();
    trace.log("hear", again ? "his name, while already listening" : "his name");
    this.begin();
    director.listen(true, { called: !again });
    journal.add("user", "called your name", 0);

    await sleep(ACK_AFTER_MS);
    const taken = await Promise.race([take, sleep(250).then(() => null)]);
    if (call !== this.calls || !this.listening) return;
    if (taken?.feeling && taken.feeling !== "neutral") actor.feel(taken.feeling, 600);
    // A sound only into silence: never over them, and not right after being cut off.
    if (director.hearing.speaking || wasTalking || again) return;
    const sound = taken ? taken.sound : woke || actor.mood === "sleepy" ? "grumble" : "huh";
    if (sound) actor.cue(sound);
  }

  private talkedOver() {
    const { director, mind } = this.deps;
    this.calls++;
    this.nameless++;
    this.overHim = false;
    mind.interrupt("they started talking over him");
    trace.log("hear", "talked over him: he stops and listens");
    this.begin();
    this.cutIn = true;
    director.listen(true);
  }

  /** Now and then, while they are still talking, lets what they have said so far show on him. */
  private async aside() {
    const { config, decider, director, now } = this.deps;
    const s = this.asides;
    const words = count(this.words.text);
    if (!this.listening || s.busy) return;
    const fresh = words - s.judged;
    const wait = !config.hear.asides
      ? "off (hear.asides)"
      : !config.decider.enabled
        ? "off (decision model disabled)"
        : s.shown >= ASIDE_MOST
          ? `${ASIDE_MOST} shown, none left this turn`
          : words < ASIDE_AFTER_WORDS
            ? `starts at ${ASIDE_AFTER_WORDS} words, ${words} so far`
            : fresh < ASIDE_NEW_WORDS
              ? `${ASIDE_NEW_WORDS - fresh} more words until the next look`
              : now() - s.judgedAt < ASIDE_EVERY
                ? "looked a moment ago"
                : now() - s.shownAt < ASIDE_REST
                  ? `resting ${(ASIDE_REST - (now() - s.shownAt)).toFixed(1)} s after ${s.last}`
                  : null;
    trace.set("aside", wait ?? `asking at ${words} words`);
    if (wait) return;
    const call = this.calls;
    s.busy = true;
    s.judged = words;
    s.judgedAt = now();
    const name = await decider.aside(this.words.text, s.last);
    s.busy = false;
    if (!name) return trace.log("aside", `nothing, at ${words} words`);
    if (call !== this.calls || !this.listening) return trace.log("aside", `${name} came too late: their turn was over`);
    if (!director.respond(ASIDES[name])) return trace.log("aside", `${name} dropped: he is not in the listening pose`);
    trace.log("aside", `shows ${name}, at ${words} words`);
    s.last = name;
    s.shown++;
    s.shownAt = now();
  }

  private async ended(e: HearEvents["hear://ended"]) {
    if (!this.listening) return;
    const { director, actor, mind, config } = this.deps;
    trace.log("hear", e.text ? `turn over: "${e.text}"` : e.spoke ? "turn over: nothing understood" : "turn over: they said nothing");
    if (!e.text) {
      this.relax();
      if (e.spoke) actor.feel("unsure", 2.5);
      return;
    }
    this.listening = false;
    director.hearing = { level: 0, speaking: false };
    const call = this.calls;
    if (this.nameless > 0) {
      trace.set("ears", "is that for him?");
      const why = await this.notForHim(e.text, this.cutIn);
      if (call !== this.calls || this.listening) return;
      if (why) {
        trace.log("hear", `not for him: ${why}`);
        this.deps.journal.add("user", `said, not to you: "${e.text}"`, 0);
        return this.relax();
      }
    }
    trace.set("ears", "answering");
    await mind.wake({ kind: "said", text: e.text });
    trace.log("hear", "he has answered");
    if (call !== this.calls || this.listening) return;
    const { followUp, followUpReplies } = config.hear;
    if (followUp <= 0 || !config.hear.enabled) return this.relax();
    if (followUpReplies > 0 && this.nameless >= followUpReplies) {
      trace.log("hear", `${this.nameless} replies without his name: he needs it again`);
      return this.relax();
    }
    // He stays with them for a moment: a reply needs no name.
    try {
      await invoke("hear_listen", { seconds: followUp });
      trace.log("hear", `listening on for ${followUp} s, no name needed`);
      this.begin();
      this.nameless++;
      director.listen(true);
    } catch {
      director.listen(false);
    }
  }

  /** Why what was heard without his name should be left alone, or null when he answers it. */
  private async notForHim(text: string, overHim: boolean): Promise<string | null> {
    const { config, decider, mind } = this.deps;
    const words = meaningful(text);
    if (words < Math.max(1, config.hear.followUpWords)) return words ? `only ${words} word${words === 1 ? "" : "s"}` : "only filler";
    // Talking over him is aimed at him. The decision model hears a change of subject as said to someone else.
    if (config.hear.followUpCheck <= 0 || overHim) return null;
    const p = await decider.replying(text, mind.lastSaid);
    if (p == null) return null;
    return p < config.hear.followUpCheck ? `${p.toFixed(2)} sure it was meant for him` : null;
  }

  private begin() {
    this.listening = true;
    this.cutIn = false;
    trace.set("ears", "listening");
    trace.set("heard", null);
    trace.set("aside", null);
    this.words = { text: "", done: null };
    this.asides = { judged: 0, judgedAt: 0, shownAt: -Infinity, shown: 0, last: null, busy: false };
  }

  private relax() {
    this.listening = false;
    trace.set("ears", "waiting for his name");
    this.deps.director.listen(false);
  }
}
