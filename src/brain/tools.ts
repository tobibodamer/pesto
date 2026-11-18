import type { Seen, Sight } from "../sense/sight";
import type { World } from "../world/world";
import type { Hands } from "./hands";

export interface Tool {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

/**
 * What the big model can ask for before it answers: things whose result he
 * needs. His context holds only window titles; anything more detailed is
 * fetched here, when he wants it, so that a wake stays small. Whatever he
 * does without needing an answer is a direction in his script instead.
 */
const LOOK: Tool[] = [
  {
    type: "function",
    function: {
      name: "look",
      description:
        "Look inside one window: lists its buttons, tabs, links, fields and menu items by name, each with an id like e12 that works as a target in directions. With `find`, lists only what matches, and includes plain text on screen.",
      parameters: {
        type: "object",
        properties: {
          window: { type: "string", description: "The window's id, such as w2." },
          find: { type: "string", description: "Words to look for in names, such as \"save\" or \"close tab\". Leave out to see everything." },
        },
        required: ["window"],
      },
    },
  },
];

/** Offered only when they asked him for something: this shows him their words. */
const ASKED: Tool[] = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read the text in a window: what is visible of the page, document or message it shows. Give an element id instead to read just that field or document.",
      parameters: {
        type: "object",
        properties: { target: { type: "string", description: "A window id such as w2, or an element id such as e12." } },
        required: ["target"],
      },
    },
  },
];

export function toolsFor(mayAct: boolean): readonly Tool[] {
  return mayAct ? [...LOOK, ...ASKED] : LOOK;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  /** What the provider needs back with the call in the next request, such as Gemini's thought signature. */
  signature?: string;
}

const LIST_MOST = 70;
const FIND_MOST = 40;

/** Where in its window something is, in words. */
function place(seen: Seen, w: number, h: number) {
  const x = (seen.rect.x + seen.rect.w / 2) / w;
  const y = (seen.rect.y + seen.rect.h / 2) / h;
  const row = y < 0.2 ? "top" : y > 0.8 ? "bottom" : "";
  const col = x < 0.25 ? "left" : x > 0.75 ? "right" : "";
  return [row, col].filter(Boolean).join(" ") || "middle";
}

/** Runs the model's tool calls against the desktop as it was described to it. */
export class Toolbox {
  constructor(
    private deps: {
      sight: Sight;
      hands: Hands;
      world: World;
      /** Short window ids from the snapshot the model was given. */
      windowIds: Map<string, number>;
      /** Whether they asked him for something this time. */
      mayAct: boolean;
      /** Called when he starts looking into a window. */
      onLook?: (hwnd: number) => void;
    },
  ) {}

  async run(call: ToolCall): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return "Could not read the arguments.";
    }
    if (call.name === "look") return this.look(String(args.window ?? ""), typeof args.find === "string" ? args.find : "");
    if (call.name === "read" && this.deps.mayAct) return this.read(String(args.target ?? args.window ?? "").trim());
    return `There is no tool called ${call.name}. The tools are ${this.deps.mayAct ? "look and read" : "look"}; anything else is a direction you write in your script.`;
  }

  private async read(id: string): Promise<string> {
    const { sight, hands, windowIds } = this.deps;
    const seen = sight.get(id);
    const hwnd = seen?.hwnd ?? windowIds.get(id);
    if (hwnd == null) return `There is nothing called ${id}. The windows are: ${[...windowIds.keys()].join(", ")}.`;
    this.deps.onLook?.(hwnd);
    const text = await hands.read(hwnd, seen ?? undefined);
    return text ? `The text in ${id}:
${text}` : `No text can be read in ${id}: this app does not give it out.`;
  }

  private async look(id: string, find: string): Promise<string> {
    const { sight, world, windowIds } = this.deps;
    const hwnd = windowIds.get(id.trim());
    const win = world.window(hwnd ?? null);
    if (hwnd == null || !win) return `There is no window ${id}. The windows are: ${[...windowIds.keys()].join(", ")}.`;
    this.deps.onLook?.(hwnd);
    const all = await sight.look(hwnd);
    if (!all.length) return `Nothing can be made out inside ${id}: this app does not say what is in its window. You can still point at the window itself.`;

    const words = find.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = words.length
      ? all.filter((e) => words.every((word) => `${e.kind} ${e.name}`.toLowerCase().includes(word)))
      : all.filter((e) => e.kind !== "text");
    if (!matches.length) return `Nothing in ${id} matches "${find}". Try other words, or look without find.`;
    const most = words.length ? FIND_MOST : LIST_MOST;
    const shown = matches.slice(0, most);

    const byKind = new Map<string, string[]>();
    for (const e of shown) {
      let line = byKind.get(e.kind);
      if (!line) byKind.set(e.kind, (line = []));
      line.push(`${e.id}${e.name ? ` «${e.name}»` : ""} ${place(e, win.rect.w, win.rect.h)}`);
    }
    const lines = [`Inside ${id}${words.length ? `, matching "${find}"` : ""}:`];
    for (const [kind, items] of byKind) lines.push(`${kind}: ${items.join(" · ")}`);
    if (matches.length > shown.length) lines.push(`…and ${matches.length - shown.length} more. Use find to narrow it down.`);
    return lines.join("\n");
  }
}
