import type { Config } from "../../config";
import type { Tool, ToolCall } from "../tools";

/** A conversation as the mind keeps it, whatever the provider's wire format. */
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; calls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string };

export interface Ask {
  messages: Message[];
  tools: readonly Tool[];
  /** Whether the tools are sent at all. */
  offer: boolean;
  /** With tools offered, whether he may call them this time. */
  mayCall: boolean;
}

export interface Said {
  text: string;
  calls: ToolCall[];
}

export interface Provider {
  /** Whether every model behind it takes tools. Where some may not, a turned-down request is tried again without. */
  tools: "always" | "maybe";
  /** The request for one step; the response is always a server-sent-event stream. */
  request(mind: Config["mind"], ask: Ask): { url: string; headers: Record<string, string>; body: unknown };
  /** Reads the stream, handing text to `onText` as it arrives. */
  read(res: Response, onText: (text: string) => void): Promise<Said>;
}

/** Output allowance for one step. A model that reasons first spends it out of the same allowance. */
export const MAX_TOKENS = 1400;

export const trimSlash = (url: string) => url.replace(/\/+$/, "");
