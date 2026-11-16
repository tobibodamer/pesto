import type { Config } from "../config";
import { http, sse } from "../net";
import type { Actor } from "../pesto/actor";
import type { Paper } from "../stage/bubble";
import type { Voice } from "../voice/voice";
import type { Director } from "./director";
import type { Journal } from "./journal";
import { Performance } from "./performance";
import { personaPrompt, wakeMessage } from "./persona";
import { ScriptParser } from "./script";

export type WakeReason =
  /** The person said something to him. */
  | { kind: "said"; text: string }
  /** Something happened that he should react to out loud. */
  | { kind: "event"; why: string };

interface Turn {
  user: string;
  assistant: string;
}

const MAX_TURNS = 14;

/**
 * The big model. It is woken rarely: when the person talks to Pesto, or when
 * the decider judges something worth speaking up about. It reads the journal
 * and replies with a performance script that is played as it streams.
 */
export class Mind {
  /** True from wake until the performance has finished. */
  busy = false;
  lastSpokeAt = -Infinity;

  private turns: Turn[] = [];
  private journalMark = 0;
  private performance: Performance | null = null;
  private abort: AbortController | null = null;
  private warned = false;

  constructor(
    private deps: {
      config: Config;
      journal: Journal;
      director: Director;
      actor: Actor;
      voice: Voice;
      paper: Paper;
      now: () => number;
    },
  ) {}

  get configured() {
    const m = this.deps.config.mind;
    return !!(m.baseUrl && m.model);
  }

  /** Cuts him off mid-sentence. */
  interrupt() {
    this.abort?.abort();
    this.performance?.cancel();
  }

  async wake(reason: WakeReason): Promise<void> {
    const { config, journal, director, actor, voice, paper } = this.deps;
    if (!this.configured) {
      if (!this.warned) console.warn("mind: no model configured (config.json → mind.baseUrl, mind.model)");
      this.warned = true;
      return;
    }
    // Someone talking to him always wins; an event never talks over him.
    if (this.busy) {
      if (reason.kind !== "said") return;
      this.interrupt();
    }
    this.busy = true;
    director.autonomous = false;
    if (reason.kind === "said") {
      journal.add("user", reason.text, 3);
      actor.look({ kind: "user" }, 4);
      actor.feel("curious", 3);
    }

    const snap = journal.snapshot();
    const user = wakeMessage({
      log: journal.render(80, this.journalMark),
      snapshot: snap.text,
      self: describeSelf(actor),
      reason:
        reason.kind === "said"
          ? `They just said to you: "${reason.text}"`
          : `You woke because: ${reason.why}\nThey did not speak to you. React briefly, or not at all.`,
    });
    this.journalMark = journal.now() + 1;

    const performance = new Performance({
      director,
      actor,
      voice,
      paper,
      windowIds: snap.ids,
      captions: config.voice.captions,
      now: this.deps.now,
    });
    this.performance = performance;
    const parser = new ScriptParser((item) => performance.push(item));
    this.abort = new AbortController();
    let raw = "";

    try {
      const res = await http(`${config.mind.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: this.abort.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${config.mind.apiKey}` },
        body: JSON.stringify({
          model: config.mind.model,
          temperature: config.mind.temperature,
          stream: true,
          max_tokens: 700,
          ...(config.mind.reasoningEffort ? { reasoning_effort: config.mind.reasoningEffort } : {}),
          messages: [
            { role: "system", content: personaPrompt({ audioTags: voice.audible && /_v[34]/.test(config.voice.model) }) },
            ...this.turns.flatMap((t) => [
              { role: "user", content: t.user },
              { role: "assistant", content: t.assistant },
            ]),
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
      for await (const data of sse(res)) {
        if (data === "[DONE]") break;
        const delta = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content;
        if (delta) {
          raw += delta;
          parser.feed(delta);
        }
      }
      parser.end();
      await performance.finish();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("mind:", err);
        actor.feel("unsure", 2);
      }
    } finally {
      if (raw.trim()) {
        // Keep the log of earlier turns short: the journal already holds the detail.
        this.turns.push({ user: trimForHistory(user), assistant: raw.trim() });
        if (this.turns.length > MAX_TURNS) this.turns.shift();
      }
      if (performance.said.length) {
        journal.add("pesto", `said: "${performance.said.join(" ")}"`);
        this.lastSpokeAt = this.deps.now();
      }
      if (performance.did.length) journal.add("pesto", `did: ${performance.did.join(", ")}`);
      this.journalMark = journal.now() + 1;
      if (this.performance === performance) {
        this.performance = null;
        this.busy = false;
        director.autonomous = true;
      }
    }
  }
}

function describeSelf(actor: Actor): string {
  switch (actor.mode) {
    case "can":
      return "You are inside your can with the lid down.";
    case "held":
      return "They are holding you up by the scruff of your neck.";
    case "glass":
      return "You are clinging to the glass.";
    case "air":
      return "You are in mid-air.";
    case "emerge":
      return "You are half out of your can, hanging on its rim.";
    default:
      return actor.sitting ? "You are out of the can, sitting on a ledge." : "You are out of the can, standing on the screen.";
  }
}

function trimForHistory(user: string) {
  const lines = user.split("\n");
  return lines.length > 30 ? [...lines.slice(0, 8), "…", ...lines.slice(-18)].join("\n") : user;
}
