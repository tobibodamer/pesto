import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { absorb, loadConfig, saveConfig, type Config } from "./config";

type Path = string;

interface Base {
  label: string;
  /** One line under the label, for settings whose effect is not obvious from the name. */
  hint?: string;
  /** Greyed out while this is false, but still editable. */
  when?: (c: Config) => boolean;
}
type Field = Base &
  (
    | { kind: "switch"; key: Path; invert?: boolean }
    | { kind: "text"; key: Path; placeholder?: string; secret?: boolean; suggest?: string[] }
    | { kind: "select"; key: Path; options: [value: string, label: string][] }
    | { kind: "number"; key: Path; min: number; max: number; unit: string }
    | {
        kind: "slider";
        key: Path;
        min: number;
        max: number;
        step: number;
        show: (v: number) => string;
        /** Shown and set as 1 − the stored value. */
        invert?: boolean;
        /** Saves only when let go, for settings that restart something. */
        onRelease?: boolean;
      }
    | { kind: "hotkey" }
  );

interface Section {
  id: string;
  title: string;
  /** What the section is for, under its title. */
  about?: string;
  /** The switch in the section's header; the rest grey out while it is off. */
  on?: { key: Path; invert?: boolean };
  fields: Field[];
}

const percent = (v: number) => `${Math.round(v * 100)}%`;
const usesVoice = (c: Config) => c.voice.provider === "elevenlabs";
const transcribes = (c: Config) => c.hear.provider === "elevenlabs";

const SECTIONS: Section[] = [
  {
    id: "general",
    title: "General",
    fields: [
      { kind: "slider", key: "body.scale", label: "Size", min: 0.4, max: 1.6, step: 0.05, show: percent },
      { kind: "slider", key: "body.border", label: "Sticker border", min: 0, max: 3, step: 0.1, show: (v) => v.toFixed(1) },
      { kind: "hotkey", label: "Talk hotkey", hint: "Opens a box to type to him, from any app." },
    ],
  },
  {
    id: "mind",
    about: "The model he thinks and talks with.",
    title: "Mind",
    fields: [
      { kind: "text", key: "mind.baseUrl", label: "Endpoint", hint: "Any OpenAI-compatible API.", placeholder: "https://api.openai.com/v1" },
      { kind: "text", key: "mind.apiKey", label: "API key", secret: true },
      { kind: "text", key: "mind.model", label: "Model" },
      { kind: "slider", key: "mind.temperature", label: "Temperature", hint: "Higher makes him more surprising, lower more predictable.", min: 0, max: 2, step: 0.05, show: (v) => v.toFixed(2) },
      {
        kind: "select",
        key: "mind.reasoningEffort",
        label: "Reasoning",
        hint: "How long the model thinks before answering. More is smarter but slower.",
        options: [
          ["", "Provider default"],
          ["minimal", "Minimal"],
          ["low", "Low"],
          ["medium", "Medium"],
          ["high", "High"],
        ],
      },
      { kind: "number", key: "mind.quietSeconds", label: "Quiet between remarks", hint: "The shortest gap before he speaks up without being asked.", min: 0, max: 7200, unit: "s" },
    ],
  },
  {
    id: "reactions",
    about: "A small local model that picks his silent reactions and decides when something is worth saying.",
    title: "Reactions",
    on: { key: "decider.enabled" },
    fields: [
      { kind: "text", key: "decider.baseUrl", label: "Endpoint", hint: "An Ollama server with the System One API.", placeholder: "http://localhost:11434" },
      { kind: "text", key: "decider.model", label: "Model" },
      { kind: "slider", key: "decider.speakAbove", label: "Speak-up threshold", hint: "How sure he must be that something is worth saying. Higher is quieter.", min: 0, max: 1, step: 0.01, show: percent },
    ],
  },
  {
    id: "voice",
    about: "Speech that sounds from where he stands on your screens.",
    title: "Voice",
    on: { key: "voice.muted", invert: true },
    fields: [
      {
        kind: "select",
        key: "voice.provider",
        label: "Provider",
        options: [
          ["elevenlabs", "ElevenLabs"],
          ["none", "None"],
        ],
      },
      { kind: "text", key: "voice.apiKey", label: "API key", secret: true, when: usesVoice },
      { kind: "text", key: "voice.voiceId", label: "Voice ID", hint: "From your ElevenLabs voice library.", when: usesVoice },
      {
        kind: "text",
        key: "voice.model",
        label: "Model",
        when: usesVoice,
        suggest: ["eleven_v4_turbo", "eleven_v3", "eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"],
      },
      { kind: "slider", key: "voice.volume", label: "Volume", min: 0, max: 1, step: 0.01, show: percent, when: usesVoice },
      { kind: "slider", key: "voice.stability", label: "Stability", hint: "Lower sounds more expressive, higher more even.", min: 0, max: 1, step: 0.01, show: percent, when: usesVoice },
      { kind: "slider", key: "voice.width", label: "Width", hint: "How far left and right his voice moves as he walks across your screens.", min: 0, max: 1, step: 0.01, show: percent, when: usesVoice },
      { kind: "switch", key: "voice.captions", label: "Captions", hint: "Also show what he says in a speech bubble." },
    ],
  },
  {
    id: "ears",
    about: "Listens on your microphone for his name and what you say to him.",
    title: "Ears",
    on: { key: "hear.enabled" },
    fields: [
      {
        kind: "slider",
        key: "hear.threshold",
        label: "Name sensitivity",
        hint: "Higher hears his name more easily, but mishears other words more often.",
        min: 0.05,
        max: 0.95,
        step: 0.01,
        show: percent,
        invert: true,
        onRelease: true,
      },
      { kind: "number", key: "hear.followUp", label: "Reply without name", hint: "How long after he answers you can reply without his name. 0 is off.", min: 0, max: 60, unit: "s" },
      { kind: "switch", key: "hear.asides", label: "React while you talk", hint: "He reacts to what you say before you finish. Needs Reactions and speech to text." },
      {
        kind: "select",
        key: "hear.provider",
        label: "Speech to text",
        hint: "Without it he hears his name, but not what you say.",
        options: [
          ["elevenlabs", "ElevenLabs"],
          ["none", "None"],
        ],
      },
      { kind: "text", key: "hear.apiKey", label: "API key", hint: "Needs the Speech to Text permission.", secret: true, placeholder: "Same as voice", when: transcribes },
      {
        kind: "select",
        key: "hear.model",
        label: "Model",
        when: transcribes,
        options: [
          ["scribe_v3_live", "Scribe v3 live"],
          ["scribe_v2_realtime", "Scribe v2 realtime"],
        ],
      },
      { kind: "text", key: "hear.language", label: "Language", hint: "A two-letter code like en or de. Empty detects it and allows mixing.", placeholder: "Auto", when: transcribes, suggest: ["en", "de", "fr", "es", "it", "nl", "pl", "pt", "ja"] },
    ],
  },
];

const nav = document.querySelector("nav")!;
const main = document.querySelector("main")!;
const config = await loadConfig();
/** Called after any change, to bring every control in line with `config`. */
const syncs: (() => void)[] = [];
const sync = () => syncs.forEach((s) => s());

function read(path: Path): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], config);
}

function write(path: Path, value: unknown) {
  const keys = path.split(".");
  const patch = keys.reduceRight<unknown>((inner, k) => ({ [k]: inner }), value);
  absorb(config, patch);
  sync();
  void saveConfig(patch as Parameters<typeof saveConfig>[0]);
}

let uid = 0;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function control(field: Field, id: string): HTMLElement {
  switch (field.kind) {
    case "switch": {
      const input = el("input", { type: "checkbox", className: "switch", id });
      const value = () => Boolean(read(field.key)) !== !!field.invert;
      input.addEventListener("change", () => write(field.key, input.checked !== !!field.invert));
      syncs.push(() => (input.checked = value()));
      return el("div", { className: "control" }, input);
    }
    case "text": {
      const input = el("input", { type: field.secret ? "password" : "text", id, placeholder: field.placeholder ?? "", spellcheck: false, autocomplete: "off" });
      const box = el("div", { className: "control" }, input);
      if (field.suggest) {
        const list = el("datalist", { id: `${id}-list` }, ...field.suggest.map((v) => el("option", { value: v })));
        input.setAttribute("list", list.id);
        box.append(list);
      }
      if (field.secret) box.append(revealer(input));
      let timer = 0;
      const commit = () => {
        clearTimeout(timer);
        const value = input.value.trim();
        if (value !== read(field.key)) write(field.key, value);
      };
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = window.setTimeout(commit, 600);
      });
      input.addEventListener("change", commit);
      syncs.push(() => {
        if (document.activeElement !== input) input.value = String(read(field.key));
      });
      return box;
    }
    case "select": {
      const select = el("select", { id }, ...field.options.map(([value, label]) => el("option", { value }, label)));
      select.addEventListener("change", () => write(field.key, select.value));
      syncs.push(() => (select.value = String(read(field.key))));
      return el("div", { className: "control" }, select);
    }
    case "number": {
      const input = el("input", { type: "number", id, min: String(field.min), max: String(field.max), step: "1" });
      input.addEventListener("change", () => {
        const n = Number(input.value);
        if (input.value === "" || !Number.isFinite(n)) return sync();
        write(field.key, Math.max(field.min, Math.min(field.max, n)));
      });
      syncs.push(() => {
        if (document.activeElement !== input) input.value = String(read(field.key));
      });
      return el("div", { className: "control" }, input, el("span", { className: "unit" }, field.unit));
    }
    case "slider": {
      const flip = (v: number) => (field.invert ? Math.round((1 - v) * 1000) / 1000 : v);
      const input = el("input", { type: "range", id, min: String(flip(field.invert ? field.max : field.min)), max: String(flip(field.invert ? field.min : field.max)), step: String(field.step) });
      const out = el("output");
      const show = () => (out.textContent = field.show(Number(input.value)));
      input.addEventListener("input", () => (field.onRelease ? show() : write(field.key, flip(Number(input.value)))));
      if (field.onRelease) input.addEventListener("change", () => write(field.key, flip(Number(input.value))));
      syncs.push(() => {
        if (document.activeElement !== input || !field.onRelease) input.value = String(flip(read(field.key) as number));
        show();
      });
      return el("div", { className: "control" }, input, out);
    }
    case "hotkey":
      return hotkey(id);
  }
}

const EYE =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7c1.9 0 3.6-.6 5-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/></svg>';

function revealer(input: HTMLInputElement) {
  const button = el("button", { type: "button", className: "reveal", innerHTML: EYE, title: "Show" });
  button.addEventListener("click", () => {
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    button.innerHTML = hidden ? EYE_OFF : EYE;
    button.title = hidden ? "Hide" : "Show";
  });
  return button;
}

const MODIFIERS: Record<string, string> = { Control: "ctrl", Alt: "alt", Shift: "shift", Meta: "super" };

/** "ctrl+alt+p" as it reads on the keyboard. */
function spell(keys: string) {
  const name = (k: string) => ({ ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Win" })[k] ?? k.replace(/^(Key|Digit)/, "").replace(/^./, (c) => c.toUpperCase());
  return keys ? keys.split("+").map(name).join(" + ") : "None";
}

/** The key part of a shortcut, as the hotkey parser on the Rust side reads it. */
function keyName(e: KeyboardEvent) {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  return e.code;
}

function hotkey(id: string): HTMLElement {
  const button = el("button", { type: "button", className: "keys", id });
  const error = el("span", { className: "error" });
  let keys = "";
  let waiting = false;
  const show = () => {
    button.textContent = waiting ? "Press keys…" : spell(keys);
    button.classList.toggle("waiting", waiting);
  };
  const finish = async (next: string) => {
    if (!waiting) return;
    waiting = false;
    show();
    try {
      await invoke("ask_hotkey", { keys: next });
      keys = next;
      error.textContent = "";
    } catch (err) {
      error.textContent = `${spell(next)} is not available`;
      console.warn("hotkey:", err);
    }
    show();
  };
  button.addEventListener("click", async () => {
    if (waiting) return void finish(keys);
    waiting = true;
    error.textContent = "";
    show();
    // Released while choosing, so pressing it here does not open the talk box.
    await invoke("ask_hotkey", { keys: null }).catch(() => {});
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (!waiting) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return void finish(keys);
      if (e.key in MODIFIERS) return;
      const held = Object.entries(MODIFIERS)
        .filter(([, name]) => ({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, super: e.metaKey })[name])
        .map(([, name]) => name);
      // A bare key would be taken from every other app.
      if (!held.length) return;
      void finish([...held, keyName(e)].join("+"));
    },
    true,
  );
  button.addEventListener("blur", () => void finish(keys));
  window.addEventListener("blur", () => void finish(keys));
  void invoke<string>("ask_hotkey_get")
    .then((k) => (keys = k))
    .catch(() => {})
    .finally(show);
  show();
  return el("div", { className: "control" }, button, error);
}

function section(s: Section): HTMLElement {
  const header = el("header", {}, el("h1", {}, s.title));
  const node = el("section", { id: s.id, role: "tabpanel" }, header);
  if (s.about) node.append(el("p", { className: "about" }, s.about));
  const enabled = () => (s.on ? Boolean(read(s.on.key)) !== !!s.on.invert : true);
  if (s.on) {
    const on = s.on;
    const input = el("input", { type: "checkbox", className: "switch", title: s.title });
    input.setAttribute("aria-label", s.title);
    input.addEventListener("change", () => write(on.key, input.checked !== !!on.invert));
    syncs.push(() => (input.checked = enabled()));
    header.append(input);
  }
  for (const field of s.fields) {
    const id = `f${uid++}`;
    const label = el("div", { className: "label" }, el("label", { htmlFor: id }, field.label));
    const row = el("div", { className: "row" }, label, control(field, id));
    if (field.hint) {
      label.append(el("p", { className: "hint", id: `${id}-hint` }, field.hint));
      row.querySelector(`#${id}`)?.setAttribute("aria-describedby", `${id}-hint`);
    }
    syncs.push(() => row.classList.toggle("idle", !enabled() || (field.when ? !field.when(config) : false)));
    node.append(row);
  }
  return node;
}

const tabs = SECTIONS.map((s) => {
  const tab = el("button", { type: "button" }, s.title);
  tab.setAttribute("role", "tab");
  tab.addEventListener("click", () => select(s.id));
  nav.append(tab);
  main.append(section(s));
  return { id: s.id, tab };
});

function select(id: string) {
  for (const t of tabs) {
    t.tab.setAttribute("aria-selected", String(t.id === id));
    document.getElementById(t.id)!.hidden = t.id !== id;
  }
  try {
    localStorage.setItem("settings.tab", id);
  } catch {}
}

const file = el("button", { type: "button", className: "file" }, "config.json");
file.addEventListener("click", () => void invoke("config_open"));
nav.append(file);

let remembered: string | null = null;
try {
  remembered = localStorage.getItem("settings.tab");
} catch {}
select(tabs.some((t) => t.id === remembered) ? remembered! : SECTIONS[0].id);
sync();

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  // Blurring commits whatever is half typed.
  (document.activeElement as HTMLElement | null)?.blur();
  void invoke("settings_hide");
});

if ("__TAURI_INTERNALS__" in window) {
  // Changes made elsewhere: his menu, or config.json edited by hand and reopened here.
  await listen("config://changed", (e) => {
    absorb(config, e.payload);
    sync();
  });
  await listen("settings://shown", async () => {
    absorb(config, await loadConfig());
    sync();
  });
}
