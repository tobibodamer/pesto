import { mindSettings, type Config } from "../config";
import { trace } from "../debug/trace";
import { http } from "../net";
import type { Actor } from "../pesto/actor";
import * as moves from "../pesto/moves";
import type { Sight } from "../sense/sight";
import type { Paper } from "../stage/bubble";
import type { Voice } from "../voice/voice";
import type { Director } from "./director";
import type { Hands } from "./hands";
import type { Jobs } from "./jobs";
import type { Journal } from "./journal";
import { Performance } from "./performance";
import { personaPrompt, wakeMessage } from "./persona";
import { ScriptParser } from "./script";
import { PROVIDERS, type Message, type Said } from "./providers";
import { toolsFor, Toolbox, type Tool } from "./tools";

export type WakeReason =
  /** The person said something to him. */
  | { kind: "said"; text: string }
  /** Something happened that he should react to out loud. */
  | { kind: "event"; why: string }
  /** One of his errands needs them: a timer ran out, an agent finished or asks for something. */
  | { kind: "news"; lines: string[] };

interface Turn {
  user: string;
  assistant: string;
}

const MAX_TURNS = 14;
/** How many times in one wake he may stop to find something out, or start again after something he tried did not work, before he has to answer. */
const MAX_STEPS = 8;

/** One request to the model within a wake, and what came of it. */
interface Step {
  wrote: string;
  calls: { name: string; arguments: string; result: string }[];
  /** Why something he tried to do to their desktop did not work, when it did not. */
  failed?: string;
}

/**
 * The big model. It is woken rarely: when the person talks to Pesto, or when
 * the decider judges something worth speaking up about. It reads the journal
 * and replies with a performance script that is played as it streams.
 */
export class Mind {
  /** True from wake until the performance has finished. */
  busy = false;
  lastSpokeAt = -Infinity;
  /** What he said out loud the last time he spoke. */
  lastSaid = "";
  /** The last wake in full, for looking into why he did what he did: `pesto.mind.last`. */
  last: { reason: string; snapshot: string; steps: Step[]; did: string[]; error?: string } | null = null;

  private turns: Turn[] = [];
  private journalMark = 0;
  private performance: Performance | null = null;
  private abort: AbortController | null = null;
  /** Why they stopped him, for the journal once the cut-off reply has wound down. */
  private cutOff: string | null = null;
  private warned = false;
  /** Set once the endpoint has turned down a request that offered tools. */
  private toolless = false;

  constructor(
    private deps: {
      config: Config;
      journal: Journal;
      director: Director;
      actor: Actor;
      voice: Voice;
      paper: Paper;
      sight: Sight;
      hands: Hands;
      jobs: Jobs;
      now: () => number;
    },
  ) {}

  get configured() {
    const m = mindSettings(this.deps.config.mind);
    return !!(m.baseUrl && m.model && (m.provider !== "gemini" || m.apiKey));
  }

  private get provider() {
    return PROVIDERS[this.deps.config.mind.provider] ?? PROVIDERS.openai;
  }

  private get offersTools() {
    return this.provider.tools === "always" || !this.toolless;
  }

  /**
   * Cuts him off mid-sentence, or before he has said anything. With `why`,
   * the journal remembers that they stopped him. Returns whether there was
   * anything to stop.
   */
  interrupt(why?: string): boolean {
    if (!this.busy) return false;
    if (why) this.cutOff = why;
    this.abort?.abort();
    this.performance?.cancel();
    return true;
  }

  async wake(reason: WakeReason): Promise<void> {
    const { config, journal, director, actor, voice, paper, sight, hands, jobs } = this.deps;
    if (!this.configured) {
      if (!this.warned) console.warn("mind: no model configured (settings → Mind)");
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

    // He changes their desktop only when they are the one asking.
    const mayAct = reason.kind === "said";
    const snap = journal.snapshot();
    const user = wakeMessage({
      log: journal.render(80, this.journalMark),
      snapshot: snap.text,
      self: describeSelf(actor),
      errands: jobs.describe(mayAct ? await jobs.projects() : []),
      reason:
        reason.kind === "said"
          ? `They just said to you: "${reason.text}"`
          : reason.kind === "news"
            ? `News for them:\n${reason.lines.map((l) => `- ${l}`).join("\n")}\nThey did not speak to you, and they may be busy with something else. Get their attention with <knock/> first, then tell them in a sentence or two what it is and what it wants from them. Anything long or exact goes in a <note>.`
            : `You woke because: ${reason.why}\nThey did not speak to you. React briefly, or not at all.`,
    });
    this.journalMark = journal.now() + 1;

    const performance = new Performance({
      director,
      actor,
      voice,
      paper,
      sight,
      hands,
      jobs,
      windowIds: snap.ids,
      mayAct,
      captions: config.voice.captions,
      now: this.deps.now,
    });
    this.performance = performance;
    // While the answer is on its way he visibly thinks about it.
    let pondering = reason.kind === "said" && actor.mode === "ground";
    if (pondering) void actor.run(moves.ponder(actor, 20)).then(() => (pondering = false));
    const parser = new ScriptParser((item) => {
      if (pondering) {
        pondering = false;
        actor.stop();
      }
      performance.push(item);
    });
    const abort = (this.abort = new AbortController());
    const tools = toolsFor(mayAct);
    const toolbox = new Toolbox({
      sight,
      hands,
      world: director.world,
      windowIds: snap.ids,
      mayAct,
      // His eyes go to what he is reading.
      onLook: (hwnd) => {
        const at = director.resolve({ window: hwnd });
        if (at) actor.lookAt(at.x, at.y + 80, 2.5);
      },
    });
    const messages: Message[] = [
      { role: "system", content: personaPrompt({ audioTags: voice.audible && /_v[34]/.test(config.voice.model), tools: this.offersTools, acts: mayAct, you: config.you, today: new Date(journal.now()) }) },
      ...this.turns.flatMap((t): Message[] => [
        { role: "user", content: t.user },
        { role: "assistant", content: t.assistant },
      ]),
      { role: "user", content: user },
    ];
    let raw = "";
    const record: NonNullable<Mind["last"]> = (this.last = {
      reason: reason.kind === "said" ? `said: ${reason.text}` : reason.kind === "news" ? `news: ${reason.lines.join(" | ")}` : `event: ${reason.why}`,
      snapshot: snap.text,
      steps: [],
      did: performance.did,
    });

    try {
      for (let step = 0; ; step++) {
        const more = step < MAX_STEPS;
        const said = await this.ask(messages, tools, more, abort.signal, (text) => {
          raw += text;
          parser.feed(text);
        });
        parser.end();
        // Whatever he said before stopping to look is spoken while he looks. What he finds out
        // depends on what he has just done, though, so that has to be over first.
        await performance.changed();
        const taken: Step = { wrote: said.text, calls: [] };
        record.steps.push(taken);
        trace.log("mind", `wrote: ${said.text.replace(/\s+/g, " ")}`);
        if (abort.signal.aborted) break;
        const failed = performance.failed;
        if (failed) taken.failed = `${failed.direction}: ${failed.why}`;
        if ((!said.calls.length && !failed) || !more) break;
        raw += " ";
        performance.recover();
        const note = failed && `Your ${failed.direction} did not work: ${failed.why}. Nothing you wrote after it was said or done.`;
        if (said.calls.length) {
          messages.push({ role: "assistant", content: said.text, calls: said.calls });
          for (const call of said.calls) {
            const result = note ? `Not done. ${note}` : await toolbox.run(call);
            taken.calls.push({ name: call.name, arguments: call.arguments, result });
            trace.log("mind", `${call.name} ${call.arguments} → ${result.replace(/\s+/g, " ").slice(0, 160)}`);
            messages.push({ role: "tool", callId: call.id, name: call.name, content: result });
          }
        } else {
          messages.push({ role: "assistant", content: said.text }, { role: "user", content: `${note} Tell them in a few words, or try another way.` });
        }
        if (abort.signal.aborted) break;
      }
      await performance.finish();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        record.error = String(err);
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
        this.lastSaid = performance.said.join(" ");
        journal.add("pesto", `said: "${this.lastSaid}"`);
        this.lastSpokeAt = this.deps.now();
      }
      if (performance.did.length) journal.add("pesto", `did: ${performance.did.join(", ")}`);
      if (this.cutOff) journal.add("pesto", `was cut off: ${this.cutOff}`, 2);
      this.cutOff = null;
      this.journalMark = journal.now() + 1;
      if (this.performance === performance) {
        this.performance = null;
        this.busy = false;
        actor.inSpeech = false;
        director.autonomous = true;
      }
    }
  }

  /**
   * One request to the model. Text is handed to `onText` as it streams; tool
   * calls are collected and returned. With `mayCall` false he has to answer
   * with what he already knows.
   */
  private async ask(messages: Message[], tools: readonly Tool[], mayCall: boolean, signal: AbortSignal, onText: (text: string) => void): Promise<Said> {
    const mind = mindSettings(this.deps.config.mind);
    const provider = this.provider;
    const post = (offer: boolean) => {
      const req = provider.request(mind, { messages, tools, offer, mayCall });
      return http(req.url, { method: "POST", signal, headers: { "content-type": "application/json", ...req.headers }, body: JSON.stringify(req.body) });
    };
    let res = await post(this.offersTools);
    if (!res.ok && provider.tools === "maybe" && !this.toolless && (res.status === 400 || res.status === 422) && messages.every((m) => m.role !== "tool")) {
      // Some endpoints and models take no tools at all. He manages with window titles there.
      console.warn(`mind: the model turned down tools (${res.status}); going on without`);
      this.toolless = true;
      res = await post(false);
    }
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
    return provider.read(res, onText);
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
