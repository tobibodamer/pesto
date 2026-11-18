import type { Config } from "../../config";
import { gemini } from "./gemini";
import { openai } from "./openai";
import type { Provider } from "./provider";

export type { Ask, Message, Provider, Said } from "./provider";

export const PROVIDERS: Record<Config["mind"]["provider"], Provider> = { openai, gemini };
