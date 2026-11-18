import { sse } from "../../net";
import type { ToolCall } from "../tools";
import { MAX_TOKENS, trimSlash, type Message, type Provider } from "./provider";

interface Delta {
  content?: string;
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

function wire(m: Message) {
  switch (m.role) {
    case "assistant":
      return m.calls?.length
        ? {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
          }
        : { role: "assistant", content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.callId, content: m.content };
    default:
      return m;
  }
}

/** Any endpoint that speaks OpenAI's `/chat/completions`. */
export const openai: Provider = {
  tools: "maybe",

  request(mind, { messages, tools, offer, mayCall }) {
    return {
      url: `${trimSlash(mind.baseUrl)}/chat/completions`,
      headers: { authorization: `Bearer ${mind.apiKey}` },
      body: {
        model: mind.model,
        temperature: mind.temperature,
        stream: true,
        max_tokens: MAX_TOKENS,
        ...(mind.reasoningEffort ? { reasoning_effort: mind.reasoningEffort } : {}),
        ...(offer ? { tools, tool_choice: mayCall ? "auto" : "none" } : {}),
        messages: messages.map(wire),
      },
    };
  },

  async read(res, onText) {
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
  },
};
