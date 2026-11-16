import type { Config } from "../config";
import { http, sse } from "../net";
import type { Actor } from "../pesto/actor";
import * as moves from "../pesto/moves";
import type { Sight } from "../sense/sight";
import type { Paper } from "../stage/bubble";
import type { Voice } from "../voice/voice";
import type { Director } from "./director";
import type { Journal } from "./journal";
import { Performance } from "./performance";
import { personaPrompt, wakeMessage } from "./persona";
import { ScriptParser } from "./script";
import { TOOLS, Toolbox, type ToolCall } from "./tools";

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
/** How many times in one wake he may stop to look at something before he has to answer. */
const MAX_LOOKS = 3;

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface Delta {
  content?: string;
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
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

  private turns: Turn[] = [];
  private journalMark = 0;
  private performance: Performance | null = null;
  private abort: AbortController | null = null;
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
    const { config, journal, director, actor, voice, paper, sight } = this.deps;
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
      sight,
      windowIds: snap.ids,
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
    const toolbox = new Toolbox({
      sight,
      world: director.world,
      windowIds: snap.ids,
      // His eyes go to what he is reading.
      onLook: (hwnd) => {
        const at = director.resolve({ window: hwnd });
        if (at) actor.lookAt(at.x, at.y + 80, 2.5);
      },
    });
    const messages: Message[] = [
      { role: "system", content: personaPrompt({ audioTags: voice.audible && /_v[34]/.test(config.voice.model), tools: !this.toolless }) },
      ...this.turns.flatMap((t): Message[] => [
        { role: "user", content: t.user },
        { role: "assistant", content: t.assistant },
      ]),
      { role: "user", content: user },
    ];
    let raw = "";

    try {
      for (let looks = 0; ; looks++) {
        const said = await this.ask(messages, looks < MAX_LOOKS, abort.signal, (text) => {
          raw += text;
          parser.feed(text);
        });
        // Whatever he said before stopping to look is spoken while he looks.
        parser.end();
        if (!said.calls.length || looks >= MAX_LOOKS) break;
        raw += " ";
        messages.push({
          role: "assistant",
          content: said.text || null,
          tool_calls: said.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
        });
        for (const call of said.calls) messages.push({ role: "tool", tool_call_id: call.id, content: await toolbox.run(call) });
        if (abort.signal.aborted) break;
      }
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

  /**
   * One request to the model. Text is handed to `onText` as it streams; tool
   * calls are collected and returned. With `mayLook` false he has to answer
   * with what he already knows.
   */
  private async ask(messages: Message[], mayLook: boolean, signal: AbortSignal, onText: (text: string) => void): Promise<{ text: string; calls: ToolCall[] }> {
    const { config } = this.deps;
    const body = (tools: boolean) =>
      JSON.stringify({
        model: config.mind.model,
        temperature: config.mind.temperature,
        stream: true,
        max_tokens: 700,
        ...(config.mind.reasoningEffort ? { reasoning_effort: config.mind.reasoningEffort } : {}),
        ...(tools ? { tools: TOOLS, tool_choice: mayLook ? "auto" : "none" } : {}),
        messages,
      });
    const post = (tools: boolean) =>
      http(`${config.mind.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${config.mind.apiKey}` },
        body: body(tools),
      });
    let res = await post(!this.toolless);
    if (!res.ok && !this.toolless && (res.status === 400 || res.status === 422) && messages.every((m) => m.role !== "tool")) {
      // Some endpoints and models take no tools at all. He manages with window titles there.
      console.warn(`mind: the model turned down tools (${res.status}); going on without`);
      this.toolless = true;
      res = await post(false);
    }
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);

    let text = "";
    const calls: ToolCall[] = [];
    for await (const data of sse(res)) {
      if (data === "[DONE]") break;
      const delta = (JSON.parse(data) as { choices?: { delta?: Delta }[] }).choices?.[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        onText(delta.content);
      }
      for (const part of delta?.tool_calls ?? []) {
        const call = (calls[part.index] ??= { id: "", name: "", arguments: "" });
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
      }
    }
    return { text, calls: calls.filter(Boolean) };
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
