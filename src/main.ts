import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Decider } from "./brain/decider";
import { Journal } from "./brain/journal";
import { Mind } from "./brain/mind";
import { loadConfig, saveConfig } from "./config";
import { Ears } from "./hear/ears";
import { connectSenses, holdInteractive, setHitRegions } from "./sense/bridge";
import { Surveyor } from "./sense/skeleton";
import { Stage } from "./stage/stage";
import { createVoice } from "./voice/create";

const root = document.getElementById("stage")!;
const config = await loadConfig();
const stage = new Stage(root, { scale: config.body.scale, border: config.body.border });
const { world, actor, director, paper } = stage;

// The stage works in physical pixels; undo the webview's DPI scaling so one
// stage pixel is one screen pixel on every monitor.
function fit() {
  root.style.transform = `scale(${1 / window.devicePixelRatio})`;
}
fit();
window.addEventListener("resize", fit);

await connectSenses(world);

const now = () => world.time;
const voice = createVoice(config, world);
const journal = new Journal(world, actor);
const mind = new Mind({ config, journal, director, actor, voice, paper, now });
const decider = new Decider({ config, world, journal, director, actor, mind, now });
const ears = new Ears({ config, director, actor, journal, mind, decider, paper, now });
await ears.connect();

actor.on("cue", (name) => voice.cue(name));

// Learns the shelves inside windows only when he might use them: when picked up, carried, landing or choosing where to go.
const surveyor = new Surveyor(world);
actor.on("grabbed", () => surveyor.wantAt(world.cursor.x, world.cursor.y));
actor.on("landed", () => surveyor.wantAt(actor.x, actor.y + 4));
director.onScout = (monitor) => surveyor.wantAround(monitor);
setInterval(() => {
  if (actor.mode === "held") surveyor.wantAt(actor.x, actor.y);
}, 250);
director.onPerform = (name) => {
  // What the model asked for is journalled by the mind; this records what he does on his own.
  if (!mind.busy && name !== "glance" && name !== "emote") journal.add("pesto", `did: ${name}`);
};

// The hotkey, the tray or his menu asks for the text box; it opens above his head and he listens.
function openAsk() {
  const crown = stage.crown;
  const screen = world.monitorAt(crown.x, crown.y + 40)?.work;
  const x = screen ? Math.max(screen.x + 200, Math.min(screen.x + screen.w - 200, crown.x)) : crown.x;
  const y = screen ? Math.max(screen.y + 90, crown.y - 6) : crown.y - 6;
  void invoke("ask_show", { x: Math.round(x), y: Math.round(y) });
  mind.interrupt();
  director.listen(true);
}
await listen("ask://open", openAsk);

window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const v = world.virtual;
  const scale = window.devicePixelRatio;
  const out = actor.mode !== "can";
  const toggle = (label: string, on: boolean, set: (on: boolean) => void) => ({ label, checked: on, action: () => set(!on) });
  stage.menu.open(e.clientX * scale, e.clientY * scale, offset(world.monitorAt(world.cursor.x, world.cursor.y)?.rect, v), [
    { label: "Talk…", action: openAsk },
    { label: out ? "Go home" : "Come out", action: () => void director.perform(out ? "goHome" : "comeOut") },
    {
      ...toggle("Voice", !config.voice.muted, (on) => {
        config.voice.muted = !on;
        saveConfig({ voice: { muted: !on } });
      }),
      divide: true,
    },
    {
      label: "Volume",
      slide: {
        value: config.voice.volume,
        set: (volume) => {
          config.voice.volume = volume;
          saveConfig({ voice: { volume } });
        },
      },
    },
    {
      label: "Width",
      slide: {
        value: config.voice.width,
        set: (width) => {
          config.voice.width = width;
          saveConfig({ voice: { width } });
        },
      },
    },
    toggle("Ears", config.hear.enabled, (on) => {
      config.hear.enabled = on;
      saveConfig({ hear: { enabled: on } });
      ears.enable(on);
    }),
    toggle("Captions", config.voice.captions, (on) => {
      config.voice.captions = on;
      saveConfig({ voice: { captions: on } });
    }),
    toggle("Reactions", config.decider.enabled, (on) => {
      config.decider.enabled = on;
      saveConfig({ decider: { enabled: on } });
    }),
    toggle("Sticker border", stage.stickerBorder > 0, (on) => {
      stage.stickerBorder = config.body.border = on ? 1.5 : 0;
      saveConfig({ body: { border: config.body.border } });
    }),
    { label: "Edit settings…", divide: true, action: () => void invoke("config_open") },
    { label: "Quit", action: () => void invoke("app_quit") },
  ]);
});

function offset(rect: { x: number; y: number; w: number; h: number } | undefined, by: { x: number; y: number }) {
  return rect ? { x: rect.x - by.x, y: rect.y - by.y, w: rect.w, h: rect.h } : null;
}
await listen("ask://closed", () => {
  // After a message he is about to answer, so the lid stays up until he has.
  if (!mind.busy) director.listen(false);
});
await listen<string>("ask://said", (e) => void mind.wake({ kind: "said", text: e.payload }).then(() => director.listen(false)));

let last = performance.now();
function frame(t: number) {
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  stage.step(dt);
  journal.update(dt);
  decider.update(dt);
  stage.render();
  voice.place(actor.visible ? actor.toWorld(actor.puppet.anchors?.mouth ?? { x: 0, y: -110 }) : stage.crown, !actor.visible);
  setHitRegions(stage.hitRegions());
  holdInteractive(actor.mode === "held" || stage.carrying);
  if (document.body.style.cursor !== stage.cursor) document.body.style.cursor = stage.cursor;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// For the devtools console while developing:
//   pesto.say("what am I doing?")     talk to him
//   pesto.director.perform("dance")   make him do something
//   pesto.decider.last                the last silent decision and why
Object.assign(window, {
  pesto: { stage, world, actor, director, journal, mind, decider, ears, config, say: (text: string) => mind.wake({ kind: "said", text }) },
});
