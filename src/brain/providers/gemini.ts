import { sse } from "../../net";
import type { Tool, ToolCall } from "../tools";
import { MAX_TOKENS, trimSlash, type Message, type Provider } from "./provider";

interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

interface Content {
  role: "user" | "model";
  parts: Part[];
}

interface Chunk {
  candidates?: { content?: { parts?: Part[] } }[];
  error?: { code?: number; message?: string };
}

/** The part of OpenAPI's schema that function declarations accept; anything else is turned down. */
const SCHEMA_KEYS = new Set(["type", "format", "title", "description", "nullable", "enum", "items", "minItems", "maxItems", "properties", "required", "minProperties", "maxProperties", "minLength", "maxLength", "pattern", "minimum", "maximum", "anyOf", "propertyOrdering", "default"]);

export function schema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(schema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([name, s]) => [name, schema(s)])) : k === "items" || k === "anyOf" ? schema(v) : v;
  }
  return out;
}

function args(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parts(m: Message): Part[] {
  switch (m.role) {
    case "assistant":
      return [
        ...(m.content ? [{ text: m.content }] : []),
        ...(m.calls ?? []).map((c) => ({ functionCall: { id: c.id, name: c.name, args: args(c.arguments) }, ...(c.signature ? { thoughtSignature: c.signature } : {}) })),
      ];
    case "tool":
      return [{ functionResponse: { id: m.callId, name: m.name, response: { result: m.content } } }];
    default:
      return [{ text: m.content }];
  }
}

/** Gemini wants turns to alternate, and the answers to one step's calls together in one turn. */
function contents(messages: Message[]): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "model" : "user";
    const last = out.at(-1);
    if (last?.role === role) last.parts.push(...parts(m));
    else out.push({ role, parts: parts(m) });
  }
  return out;
}

/** Gemini 2.5 thinks within a token budget; later models take a level. */
function thinking(model: string, effort: string) {
  if (!effort) return undefined;
  if (/^gemini-2\./.test(model)) return { thinkingBudget: { minimal: 0, low: 512, medium: 1024, high: 2048 }[effort] ?? -1 };
  return { thinkingLevel: effort };
}

let made = 0;

/** Google's own Gemini API. */
export const gemini: Provider = {
  tools: "always",

  request(mind, { messages, tools, offer, mayCall }) {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content);
    const thinkingConfig = thinking(mind.model, mind.reasoningEffort);
    return {
      url: `${trimSlash(mind.baseUrl)}/models/${encodeURIComponent(mind.model)}:streamGenerateContent?alt=sse`,
      headers: { "x-goog-api-key": mind.apiKey },
      body: {
        ...(system.length ? { systemInstruction: { parts: system.map((text) => ({ text })) } } : {}),
        contents: contents(messages),
        ...(offer && tools.length
          ? {
              tools: [{ functionDeclarations: tools.map((t: Tool) => ({ name: t.function.name, description: t.function.description, parameters: schema(t.function.parameters) })) }],
              toolConfig: { functionCallingConfig: { mode: mayCall ? "AUTO" : "NONE" } },
            }
          : {}),
        generationConfig: { temperature: mind.temperature, maxOutputTokens: MAX_TOKENS, ...(thinkingConfig ? { thinkingConfig } : {}) },
      },
    };
  },

  async read(res, onText) {
    let text = "";
    const calls: ToolCall[] = [];
    for await (const data of sse(res)) {
      const chunk = JSON.parse(data) as Chunk;
      if (chunk.error) throw new Error(`${chunk.error.code ?? "gemini"}: ${chunk.error.message ?? "error"}`);
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.thought) continue;
        if (part.functionCall) {
          const { id, name, args = {} } = part.functionCall;
          // Older models give calls no id; the answer is matched to the call by it all the same.
          calls.push({ id: id || `call_${++made}`, name, arguments: JSON.stringify(args), ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}) });
        } else if (part.text) {
          text += part.text;
          onText(part.text);
        }
      }
    }
    return { text, calls };
  },
};
