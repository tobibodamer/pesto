import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../config";
import { http } from "../../net";
import { RateLimited } from "./backend";
import { fromGemini, GeminiDecisions, toGemini } from "./gemini";

vi.mock("../../net", () => ({ http: vi.fn() }));
const fetched = vi.mocked(http);

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function asker(over: { key?: string; mindKey?: string; mind?: "openai" | "gemini"; model?: string } = {}) {
  const config = structuredClone(DEFAULTS);
  config.decider.provider = "gemini";
  config.decider.apiKey = over.key ?? "";
  config.decider.model = over.model ?? "";
  config.mind.provider = over.mind ?? "openai";
  config.mind.apiKey = over.mindKey ?? "";
  return new GeminiDecisions(config);
}

beforeEach(() => {
  fetched.mockReset();
});

describe("translating questions for Gemini", () => {
  it("renames yes and no to true and false descriptions", () => {
    expect(toGemini({ speak: { type: "noul", instructions: "Speak?", criteria: { yes: "notable", no: "routine" } } })).toEqual({
      speak: { type: "noul", instructions: "Speak?", criteria: { true_description: "notable", false_description: "routine" } },
    });
  });

  it("passes choice and score questions through", () => {
    const questions = {
      reaction: { type: "choice" as const, instructions: "Do what?", criteria: { none: "", glance: "a look" } },
      level: { type: "score" as const, instructions: "How much?", criteria: ["low", "mid", "high"] },
    };
    expect(toGemini(questions)).toEqual(questions);
  });
});

describe("translating Gemini's answers", () => {
  it("keeps the probability of a noul answer", () => {
    expect(fromGemini({ speak: { type: "noul", noul: 0.83, confidence: 0.83 } })).toEqual({ speak: { type: "noul", noul: 0.83 } });
  });

  it("turns a score's weighted average into its likeliest level", () => {
    const a = fromGemini({ level: { type: "score", score: 1.4, probabilities: { "0": 0.2, "1": 0.2, "2": 0.6 }, confidence: 0.6 } });
    expect(a.level).toMatchObject({ type: "score", score: 2 });
  });

  it("keeps choice answers as they are", () => {
    const choice = { type: "choice" as const, choice: "glance", probabilities: { glance: 0.7, none: 0.3 }, confidence: 0.7 };
    expect(fromGemini({ reaction: choice })).toEqual({ reaction: choice });
  });
});

describe("asking Gemini", () => {
  it("sends input, questions, model and key to the Decisions API", async () => {
    fetched.mockResolvedValue(reply(200, { answers: { speak: { type: "noul", noul: 0.2, confidence: 0.8 } }, usage: {} }));
    const answers = await asker({ key: "k" }).ask("the state", { speak: { type: "noul", instructions: "Speak?", criteria: { yes: "y", no: "n" } } });
    const [url, init] = fetched.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "k" });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gemini-decision-1",
      input: "the state",
      questions: { speak: { type: "noul", instructions: "Speak?", criteria: { true_description: "y", false_description: "n" } } },
    });
    expect(answers).toEqual({ speak: { type: "noul", noul: 0.2 } });
  });

  it("uses the mind's key when the mind runs on Gemini and the decider has none", async () => {
    fetched.mockResolvedValue(reply(200, { answers: {} }));
    const a = asker({ mind: "gemini", mindKey: "mind-key" });
    expect(a.ready()).toBe(true);
    await a.ask("s", {});
    expect(fetched.mock.calls[0][1]?.headers).toMatchObject({ "x-goog-api-key": "mind-key" });
  });

  it("is not ready without a key of its own or from a Gemini mind", () => {
    expect(asker({ mind: "openai", mindKey: "openai-key" }).ready()).toBe(false);
  });

  it("treats a safety block as no decision", async () => {
    fetched.mockResolvedValue(reply(400, { error: { code: "safety", message: "blocked" } }));
    expect(await asker({ key: "k" }).ask("s", {})).toEqual({});
  });

  it("reports a rate limit so the decider can rest it", async () => {
    fetched.mockResolvedValue(reply(429, { error: { message: "slow down" } }));
    await expect(asker({ key: "k" }).ask("s", {})).rejects.toBeInstanceOf(RateLimited);
  });

  it("fails on any other error", async () => {
    fetched.mockResolvedValue(reply(400, { error: { code: "invalid_argument", message: "too many options" } }));
    await expect(asker({ key: "k" }).ask("s", {})).rejects.toThrow(/400/);
  });
});
