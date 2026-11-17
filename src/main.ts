import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { connectJobs, listenForHooks, syncHooks } from "./brain/agents";
import { Decider } from "./brain/decider";
import { Hands } from "./brain/hands";
import { Journal } from "./brain/journal";
import { Mind } from "./brain/mind";
import { DebugPanel } from "./debug/panel";
import { trace } from "./debug/trace";
import { absorb, loadConfig, saveConfig, type Config, type Patch } from "./config";
import { Ears } from "./hear/ears";
import { connectSenses, holdInteractive, setHitRegions } from "./sense/bridge";
import { Sight } from "./sense/sight";
import { Surveyor } from "./sense/skeleton";
import { Stage } from "./stage/stage";
import { ElevenVoice } from "./voice/eleven";

const root = document.getElementById("stage")!;
const config = await loadConfig();
const stage = new Stage(root, { scale: config.body.scale, can: config.body.can, border: config.body.border });
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
const voice = new ElevenVoice(config, () => world.primary?.rect ?? null);
const journal = new Journal(world, actor);
const sight = new Sight(world);
const hands = new Hands(world, sight);
const jobs = await connectJobs(config, world);
const mind = new Mind({ config, journal, director, actor, voice, paper, sight, hands, jobs, now });
const decider = new Decider({ config, world, journal, director, actor, mind, now });
const ears = new Ears({ config, director, actor, journal, mind, decider, paper, now });
await ears.connect();

actor.on("cue", (name) => voice.cue(name));

/** Puts settings into effect, wherever they were changed: here, in the settings window or in config.json through it. */
function apply(patch: Patch<Config>) {
  absorb(config, patch);
  if (patch.hear) ears.enable(config.hear.enabled);
  if (patch.decider) decider.retry();
  if (patch.debug) trace.enable(config.debug.panel);
  if (patch.agents && ("watch" in patch.agents || "port" in patch.agents)) void listenForHooks(config).then(() => syncHooks(config, true));
  if (patch.body) {
    stage.resize(config.body.scale, config.body.can);
    stage.stickerBorder = config.body.border;
  }
}
trace.enable(config.debug.panel);
const debugPanel = new DebugPanel(root, world, actor);

function change(patch: Patch<Config>) {
  apply(patch);
  void saveConfig(patch);
}
await listen<Patch<Config>>("config://changed", (e) => apply(e.payload));

// Learns the shelves inside windows only when he might use them: when picked up, carried, landing or choosing where to go.
const surveyor = new Surveyor(world);
actor.on("grabbed", () => surveyor.wantAt(world.cursor.x, world.cursor.y));
actor.on("landed", () => surveyor.wantAt(actor.x, actor.y + 4));
director.onScout = (monitor) => surveyor.wantAround(monitor);
// A window he reads he may be about to walk into.
sight.onLook = (hwnd) => surveyor.want(hwnd);
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
    { ...toggle("Voice", !config.voice.muted, (on) => change({ voice: { muted: !on } })), divide: true },
    { label: "Volume", slide: { value: config.voice.volume, set: (volume) => change({ voice: { volume } }) } },
    { label: "Width", slide: { value: config.voice.width, set: (width) => change({ voice: { width } }) } },
    toggle("Sounds", config.sfx.enabled, (on) => change({ sfx: { enabled: on } })),
    toggle("Ears", config.hear.enabled, (on) => change({ hear: { enabled: on } })),
    toggle("Captions", config.voice.captions, (on) => change({ voice: { captions: on } })),
    toggle("Reactions", config.decider.enabled, (on) => change({ decider: { enabled: on } })),
    toggle("Sticker border", config.body.border > 0, (on) => change({ body: { border: on ? 1.5 : 0 } })),
    toggle("Debug", config.debug.panel, (on) => change({ debug: { panel: on } })),
    { label: "Settings…", divide: true, action: () => void invoke("settings_open") },
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

// News from his errands waits until he is free and nobody is talking to him.
setInterval(() => {
  jobs.tick();
  if (!jobs.news.length || mind.busy || ears.listening || !mind.configured) return;
  const lines = jobs.takeNews();
  journal.add("pesto", `news: ${lines.join(" ")}`);
  void mind.wake({ kind: "news", lines });
}, 1000);

let last = performance.now();
function frame(t: number) {
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  stage.step(dt);
  journal.update(dt);
  decider.update(dt);
  stage.render();
  debugPanel.update();
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
//   pesto.director.perform("tap", { target: "cursor" })   or "throw", or "point"
//   pesto.sight.look(pesto.world.foreground)              what he can see inside a window
//   pesto.decider.last                the last silent decision and why
//   pesto.trace.lines                 what his ears and the decision model did, while Debug is on
Object.assign(window, {
  pesto: { stage, world, actor, director, journal, mind, decider, ears, sight, hands, jobs, config, trace, say: (text: string) => mind.wake({ kind: "said", text }) },
});
