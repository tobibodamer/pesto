import { deciderSettings, type Config } from "../../config";
import { postJson } from "../../net";
import type { Answer, Asker, Question } from "./model";

/** Ollama's /v1/systemone, which the questions are written for. */
export class SystemOne implements Asker {
  readonly label = "system one";

  constructor(private config: Config) {}

  ready() {
    return true;
  }

  async ask(state: string, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    const { baseUrl, model } = deciderSettings(this.config);
    const { answers } = await postJson<{ answers: Record<string, Answer> }>(`${baseUrl.replace(/\/$/, "")}/v1/systemone`, { model, state, questions });
    return answers;
  }
}
