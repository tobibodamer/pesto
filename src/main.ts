import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Decider } from "./brain/decider";
import { Journal } from "./brain/journal";
import { Mind } from "./brain/mind";
import { loadConfig } from "./config";
import { connectSenses, holdInteractive, setHitRegions } from "./sense/bridge";
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

actor.on("cue", (name) => voice.cue(name));
director.onPerform = (name) => {
  // What the model asked for is journalled by the mind; this records what he does on his own.
  if (!mind.busy && name !== "glance" && name !== "emote") journal.add("pesto", `did: ${name}`);
};

// The hotkey or the tray asks for the text box; it opens above his head and he listens.
await listen("ask://open", () => {
  const crown = stage.crown;
  const screen = world.monitorAt(crown.x, crown.y + 40)?.work;
  const x = screen ? Math.max(screen.x + 200, Math.min(screen.x + screen.w - 200, crown.x)) : crown.x;
  const y = screen ? Math.max(screen.y + 90, crown.y - 6) : crown.y - 6;
  void invoke("ask_show", { x: Math.round(x), y: Math.round(y) });
  mind.interrupt();
  director.listen(true);
});
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
  holdInteractive(actor.mode === "held");
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// For the devtools console while developing:
//   pesto.say("what am I doing?")     talk to him
//   pesto.director.perform("dance")   make him do something
//   pesto.decider.last                the last silent decision and why
Object.assign(window, {
  pesto: { stage, world, actor, director, journal, mind, decider, config, say: (text: string) => mind.wake({ kind: "said", text }) },
});
