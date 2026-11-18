import { describe, expect, it, vi } from "vitest";
import { DEFAULTS, mindSettings, type Config } from "../../config";
import { toolsFor } from "../tools";
import { gemini, schema } from "./gemini";
import type { Message } from "./provider";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: globalThis.fetch }));

const mind: Config["mind"] = mindSettings({ ...DEFAULTS.mind, provider: "gemini", apiKey: "k" });

function stream(...chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
        c.close();
      },
    }),
  );
}

const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;

describe("gemini request", () => {
  const messages: Message[] = [
    { role: "system", content: "You are Pesto." },
    { role: "user", content: "earlier" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: "what is in my editor?" },
    {
      role: "assistant",
      content: "Let me look.",
      calls: [
        { id: "a1", name: "look", arguments: '{"window":"w2"}', signature: "SIG" },
        { id: "a2", name: "read", arguments: '{"target":"w2"}' },
      ],
    },
    { role: "tool", callId: "a1", name: "look", content: "buttons: Save" },
    { role: "tool", callId: "a2", name: "read", content: "hello" },
  ];

  it("goes to the streaming endpoint with the key in a header", () => {
    const req = gemini.request(mind, { messages, tools: [], offer: false, mayCall: false });
    expect(req.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse");
    expect(req.headers).toEqual({ "x-goog-api-key": "k" });
  });

  it("maps the conversation to alternating contents", () => {
    const body = gemini.request(mind, { messages, tools: [], offer: false, mayCall: false }).body as Record<string, unknown>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: "You are Pesto." }] });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "earlier" }] },
      { role: "model", parts: [{ text: "earlier answer" }] },
      { role: "user", parts: [{ text: "what is in my editor?" }] },
      {
        role: "model",
        parts: [
          { text: "Let me look." },
          { functionCall: { id: "a1", name: "look", args: { window: "w2" } }, thoughtSignature: "SIG" },
          { functionCall: { id: "a2", name: "read", args: { target: "w2" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "a1", name: "look", response: { result: "buttons: Save" } } },
          { functionResponse: { id: "a2", name: "read", response: { result: "hello" } } },
        ],
      },
    ]);
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig).toEqual({ temperature: 0.9, maxOutputTokens: 1400, thinkingConfig: { thinkingLevel: "low" } });
  });

  it("declares tools and whether they may be called", () => {
    const tools = toolsFor(true);
    const auto = gemini.request(mind, { messages, tools, offer: true, mayCall: true }).body as Record<string, any>;
    expect(auto.tools[0].functionDeclarations.map((d: { name: string }) => d.name)).toEqual(["look", "read"]);
    expect(auto.tools[0].functionDeclarations[0].parameters.required).toEqual(["window"]);
    expect(auto.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    const none = gemini.request(mind, { messages, tools, offer: true, mayCall: false }).body as Record<string, any>;
    expect(none.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
  });

  it("gives Gemini 2.5 a thinking budget instead of a level", () => {
    const body = gemini.request({ ...mind, model: "gemini-2.5-flash-lite", reasoningEffort: "minimal" }, { messages, tools: [], offer: false, mayCall: false }).body as Record<string, any>;
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    const plain = gemini.request({ ...mind, reasoningEffort: "" }, { messages, tools: [], offer: false, mayCall: false }).body as Record<string, any>;
    expect(plain.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("drops schema keywords Gemini turns down", () => {
    expect(
      schema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: { tags: { type: "array", items: { type: "string", $comment: "x" } }, additionalProperties: { type: "string" } },
        required: ["tags"],
      }),
    ).toEqual({
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } }, additionalProperties: { type: "string" } },
      required: ["tags"],
    });
  });
});

describe("gemini stream", () => {
  it("streams text and collects a function call with its signature", async () => {
    const res = stream(
      event({ candidates: [{ content: { role: "model", parts: [{ text: "Hm, " }] } }] }),
      // An event split across reads.
      event({ candidates: [{ content: { role: "model", parts: [{ text: "let me look." }] } }] }).slice(0, 20),
      event({ candidates: [{ content: { role: "model", parts: [{ text: "let me look." }] } }] }).slice(20),
      event({ candidates: [{ content: { role: "model", parts: [{ text: "pondering", thought: true }] } }] }),
      event({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "fc1", name: "look", args: { window: "w2" } }, thoughtSignature: "SIG" }] }, finishReason: "STOP" }] }),
    );
    const seen: string[] = [];
    const said = await gemini.read(res, (t) => seen.push(t));
    expect(seen).toEqual(["Hm, ", "let me look."]);
    expect(said).toEqual({ text: "Hm, let me look.", calls: [{ id: "fc1", name: "look", arguments: '{"window":"w2"}', signature: "SIG" }] });
  });

  it("makes up distinct ids for calls that come without one", async () => {
    const res = stream(
      event({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "look", args: { window: "w1" } } },
                { functionCall: { name: "look", args: { window: "w2" } } },
              ],
            },
          },
        ],
      }),
    );
    const { calls } = await gemini.read(res, () => {});
    expect(calls).toHaveLength(2);
    expect(calls[0].id).toBeTruthy();
    expect(calls[0].id).not.toBe(calls[1].id);
    expect(calls[0].signature).toBeUndefined();
  });

  it("throws on an error in the stream", async () => {
    await expect(gemini.read(stream(event({ error: { code: 429, message: "Resource exhausted" } })), () => {})).rejects.toThrow("429: Resource exhausted");
  });
});
