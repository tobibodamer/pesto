import { deciderSettings, type Config } from "../../config";
import { http } from "../../net";
import { RateLimited } from "./backend";
import type { Answer, Asker, Question } from "./model";

const URL = "https://generativelanguage.googleapis.com/v1beta/decisions";

/** Refusals that mean "no decision about this", not that the service is down. */
const BLOCKED = new Set(["safety", "prohibited_content", "blocklist", "image_safety", "content_blocked"]);

type GeminiQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria: { true_description: string; false_description: string } }
  | { type: "score"; instructions: string; criteria: string[] };

type GeminiAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export function toGemini(questions: Record<string, Question>): Record<string, GeminiQuestion> {
  return Object.fromEntries(
    Object.entries(questions).map(([key, q]) => [
      key,
      q.type === "noul" ? { type: "noul", instructions: q.instructions, criteria: { true_description: q.criteria.yes, false_description: q.criteria.no } } : q,
    ]),
  );
}

export function fromGemini(answers: Record<string, GeminiAnswer>): Record<string, Answer> {
  return Object.fromEntries(
    Object.entries(answers).map(([key, a]) => {
      if (a.type === "noul") return [key, { type: "noul", noul: a.noul }];
      // Gemini's score is the weighted average of the levels; the questions expect the likeliest level.
      if (a.type === "score") {
        const best = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0];
        return [key, { ...a, score: best ? Number(best[0]) : Math.round(a.score) }];
      }
      return [key, a];
    }),
  );
}

/** Google's Decisions API, which answers the same kinds of questions in a slightly different shape. */
export class GeminiDecisions implements Asker {
  readonly label = "gemini";

  constructor(private config: Config) {}

  ready() {
    return !!deciderSettings(this.config).apiKey;
  }

  async ask(state: string, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    const { apiKey, model } = deciderSettings(this.config);
    const res = await http(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ model, input: state, questions: toGemini(questions) }),
    });
    if (res.ok) return fromGemini(((await res.json()) as { answers?: Record<string, GeminiAnswer> }).answers ?? {});
    const text = await res.text();
    if (res.status === 429) throw new RateLimited(`429 ${URL}: ${text.slice(0, 200)}`);
    if (res.status === 400) {
      let code = "";
      try {
        code = String((JSON.parse(text) as { error?: { code?: unknown } }).error?.code ?? "").toLowerCase();
      } catch {}
      if (BLOCKED.has(code)) return {};
    }
    throw new Error(`${res.status} ${URL}: ${text.slice(0, 300)}`);
  }
}
