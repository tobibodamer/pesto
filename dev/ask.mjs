// Shows what the big model writes when something is said to him, without the app: his prompt, a
// made-up desktop and his tools go to the model in config.json, and its script and tool calls are printed.
//   node dev/ask.mjs "maximize this window" "open Downloads"
//   node dev/ask.mjs --times 3 "click the search button in VS Code"   each one three times, to see how steady it is
//   node dev/ask.mjs --event "They have been scrolling for 20 minutes"   a wake they did not ask for
//   node dev/ask.mjs --prompt                                         print his prompt
// Nothing is pressed or opened: `look` answers with a made-up VS Code window, `read` with one line.
import { build } from "esbuild";
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(resolve(here, "out"), { recursive: true });
const bundled = resolve(here, "out/ask-bundle.mjs");
await build({
  stdin: { contents: `export { personaPrompt, wakeMessage } from "./src/brain/persona";\nexport { toolsFor } from "./src/brain/tools";\nexport { DEFAULTS } from "./src/config";`, resolveDir: resolve(here, ".."), loader: "ts" },
  bundle: true,
  format: "esm",
  outfile: bundled,
  logLevel: "error",
});
const { personaPrompt, wakeMessage, toolsFor, DEFAULTS } = await import(`${pathToFileURL(bundled).href}?${Date.now()}`);

const saved = JSON.parse(fs.readFileSync(`${process.env.APPDATA}/dev.pesto.app/config.json`, "utf8").replace(/^﻿/, ""));
const mind = { ...DEFAULTS.mind, ...saved.mind };
const you = { ...DEFAULTS.you, ...saved.you };

const SNAPSHOT = `Time: Tuesday 15:20
Screen 1 (main), 2560×1440:
  w1 code «performance.ts - pesto - Visual Studio Code» [focused]
  w2 firefox «Tauri 2.0 | Tauri — Mozilla Firefox»
  w3 explorer «Dokumente»
Screen 2, 1920×1080:
  w4 spotify «Spotify Premium» [maximized]
  w5 discord «#general | Luna - Discord»
Minimised:
  w6 notepad «notes.txt - Editor»
Cursor is on screen 1.
Current window has had focus for 4 min.
Focused inside it: edit «performance.ts» in code.`;
const INSIDE_W1 = `Inside w1:
button: e1 «Explorer (Ctrl+Shift+E)» top left · e2 «Search (Ctrl+Shift+F)» top left · e3 «Source Control (Ctrl+Shift+G)» left · e4 «Run and Debug (Ctrl+Shift+D)» left · e5 «Extensions (Ctrl+Shift+X)» left · e6 «Toggle Panel (Ctrl+J)» top right
tab: e7 «performance.ts» top · e8 «mind.ts» top · e9 «hands.ts» top
menuitem: e10 «File» top left · e11 «Edit» top left · e12 «View» top left`;

function answer(name, args, asked) {
  if (name === "look") return args.window === "w1" ? INSIDE_W1 : `Nothing can be made out inside ${args.window}: this app does not say what is in its window. You can still point at the window itself.`;
  if (name === "read" && asked) return `The text in ${args.target}:\nimport { trace } from "../debug/trace";`;
  return `There is no tool called ${name}. The tools are ${asked ? "look and read" : "look"}; anything else is a direction you write in your script.`;
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args.splice(i, 2)[1];
};
const times = Number(flag("--times") ?? 1);
const event = flag("--event");
const showPrompt = args.includes("--prompt");
const lines = args.filter((a) => !a.startsWith("--")).map((text) => ({ asked: true, text }));
if (event) lines.push({ asked: false, text: event });

for (const { asked, text } of lines) {
  const system = personaPrompt({ audioTags: true, tools: true, acts: asked, you, today: new Date() });
  if (showPrompt) console.log(system);
  for (let run = 0; run < times; run++) {
    console.log(`\n=== ${asked ? "said" : "event"}: ${text}`);
    const reason = asked ? `They just said to you: "${text}"` : `You woke because: ${text}\nThey did not speak to you. React briefly, or not at all.`;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: wakeMessage({ log: "", snapshot: SNAPSHOT, self: "You are out of the can, standing on the screen.", reason }) },
    ];
    for (let step = 0; step < 5; step++) {
      const res = await fetch(`${mind.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${mind.apiKey}` },
        body: JSON.stringify({ model: mind.model, temperature: mind.temperature, max_tokens: 1400, tools: toolsFor(asked), tool_choice: "auto", messages, ...(mind.reasoningEffort ? { reasoning_effort: mind.reasoningEffort } : {}) }),
      });
      if (!res.ok) {
        console.log(`  ${res.status} ${(await res.text()).slice(0, 300)}`);
        break;
      }
      const json = await res.json();
      const choice = json.choices[0];
      const thought = json.usage?.completion_tokens_details?.reasoning_tokens;
      console.log(`  wrote: ${choice.message.content ?? ""}${choice.finish_reason === "length" ? "  [cut off]" : ""}${thought > 100 ? `  [thought for ${thought} tokens]` : ""}`);
      const calls = choice.message.tool_calls ?? [];
      if (!calls.length) break;
      messages.push({ role: "assistant", content: choice.message.content || null, tool_calls: calls });
      for (const call of calls) {
        console.log(`  calls: ${call.function.name} ${call.function.arguments}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: answer(call.function.name, JSON.parse(call.function.arguments || "{}"), asked) });
      }
    }
  }
}
if (!lines.length && showPrompt) console.log(personaPrompt({ audioTags: true, tools: true, acts: true, you, today: new Date() }));
