// Live preview of Pesto on a fake desktop: trigger reactions and emotions,
// slow time down, and grab him or drag windows with the mouse.
//   pnpm studio
import { REACTION_NAMES, type ReactionName } from "../src/brain/director";
import type { Hat } from "../src/pesto/draw";
import { EMOTION_NAMES, type Emotion } from "../src/pesto/pose";
import type { WindowInfo } from "../src/sense/types";
import { Stage } from "../src/stage/stage";

const W = 1500;
const H = 800;
const FLOOR = 752;
const STEP = 1 / 60;

const START_WINDOWS: WindowInfo[] = [
  { hwnd: 1, title: "Notes", exe: "notepad.exe", pid: 1, rect: { x: 180, y: 330, w: 480, h: 300 }, monitor: 0, state: "normal" },
  { hwnd: 2, title: "Browser", exe: "chrome.exe", pid: 2, rect: { x: 800, y: 170, w: 420, h: 420 }, monitor: 0, state: "normal" },
];

const view = document.getElementById("view")!;
const desk = document.getElementById("desk")!;
const hud = document.getElementById("hud")!;
const panel = document.getElementById("panel")!;
desk.style.width = `${W}px`;
desk.style.height = `${H}px`;

const state = {
  paused: false,
  speed: 1,
  follow: false,
  dark: false,
  autonomous: true,
  hat: null as Hat,
  border: true,
  sign: "23 min.",
  windows: structuredClone(START_WINDOWS),
  foreground: 2,
  moving: null as number | null,
};

// ───────────────────────── desktop ─────────────────────────

const taskbar = document.createElement("div");
taskbar.style.cssText = `position:absolute;left:0;top:${FLOOR}px;width:${W}px;height:${H - FLOOR}px;background:#27324a`;
desk.appendChild(taskbar);

const winEls = new Map<number, HTMLElement>();
for (const w of START_WINDOWS) {
  const el = document.createElement("div");
  el.className = "win";
  el.innerHTML = `<div class="bar"><span>${w.title}</span><div class="min" title="Minimise">–</div></div>`;
  desk.appendChild(el);
  winEls.set(w.hwnd, el);
}

let root: HTMLElement;
let stage: Stage;

function makeStage() {
  root?.remove();
  root = document.createElement("div");
  root.style.cssText = "position:absolute;left:0;top:0;z-index:5";
  desk.appendChild(root);
  stage = new Stage(root);
  stage.world.setMonitors({
    monitors: [{ id: 0, rect: { x: 0, y: 0, w: W, h: H }, work: { x: 0, y: 0, w: W, h: FLOOR }, scale: 1, primary: true }],
    virtual: { x: 0, y: 0, w: W, h: H },
  });
  pushWindows();
  stage.world.setCursor({ x: 700, y: 300, buttons: 0 });
  stage.director.autonomous = state.autonomous;
  stage.actor.puppet.hat = state.hat;
  stage.stickerBorder = state.border ? 1.5 : 0;
  Object.assign(window, { pesto: stage });
}

function pushWindows() {
  stage.world.setWindows({ windows: structuredClone(state.windows), foreground: state.foreground, moving: state.moving });
}

// ───────────────────────── view transform ─────────────────────────

let k = 1;
let ox = 0;
let oy = 0;

function layout() {
  const vw = view.clientWidth;
  const vh = view.clientHeight;
  const fit = Math.min(vw / W, vh / H);
  if (state.follow) {
    k = fit * 2.2;
    const a = stage.actor.visible ? stage.actor : { x: stage.can.x, y: stage.can.y };
    ox = Math.min(0, Math.max(vw - W * k, vw / 2 - a.x * k));
    oy = Math.min(0, Math.max(vh - H * k, vh * 0.62 - a.y * k));
  } else {
    k = fit;
    ox = (vw - W * k) / 2;
    oy = (vh - H * k) / 2;
  }
  desk.style.transform = `translate(${ox}px, ${oy}px) scale(${k})`;
}

function toDesk(e: PointerEvent) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left - ox) / k, y: (e.clientY - r.top - oy) / k };
}

// ───────────────────────── mouse ─────────────────────────

let dragWin: { hwnd: number; dx: number; dy: number } | null = null;

function windowBarAt(x: number, y: number) {
  for (const w of [...state.windows].reverse()) {
    if (w.state === "minimized") continue;
    const r = w.rect;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + 30) return w;
  }
  return null;
}

view.addEventListener("pointerdown", (e) => {
  view.setPointerCapture(e.pointerId);
  const p = toDesk(e);
  const target = e.target as HTMLElement;
  if (target.classList.contains("min")) {
    const w = windowBarAt(p.x, p.y);
    if (w) {
      w.state = "minimized";
      pushWindows();
    }
    return;
  }
  const overPesto = stage.actor.hitRect;
  const onPesto = overPesto && p.x >= overPesto.x && p.x <= overPesto.x + overPesto.w && p.y >= overPesto.y && p.y <= overPesto.y + overPesto.h;
  const bar = !onPesto && windowBarAt(p.x, p.y);
  if (bar) {
    dragWin = { hwnd: bar.hwnd, dx: p.x - bar.rect.x, dy: p.y - bar.rect.y };
    state.foreground = bar.hwnd;
    state.moving = bar.hwnd;
    pushWindows();
    return;
  }
  stage.world.setCursor({ x: p.x, y: p.y, buttons: 1 });
});

view.addEventListener("pointermove", (e) => {
  const p = toDesk(e);
  if (dragWin) {
    const w = state.windows.find((o) => o.hwnd === dragWin!.hwnd)!;
    w.rect.x = Math.round(p.x - dragWin.dx);
    w.rect.y = Math.round(Math.max(0, p.y - dragWin.dy));
    pushWindows();
  }
  stage.world.setCursor({ x: p.x, y: p.y, buttons: e.buttons & 1 && !dragWin ? 1 : 0 });
});

view.addEventListener("pointerup", (e) => {
  const p = toDesk(e);
  if (dragWin) {
    dragWin = null;
    state.moving = null;
    pushWindows();
  }
  stage.world.setCursor({ x: p.x, y: p.y, buttons: 0 });
});

// ───────────────────────── panel ─────────────────────────

function section(title: string) {
  const h = document.createElement("h2");
  h.textContent = title;
  const grid = document.createElement("div");
  grid.className = "grid";
  panel.append(h, grid);
  return grid;
}

function button(parent: HTMLElement, label: string, onClick: (b: HTMLButtonElement) => void) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", () => onClick(b));
  parent.appendChild(b);
  return b;
}

function toggle(parent: HTMLElement, label: string, get: () => boolean, set: (v: boolean) => void) {
  const b = button(parent, label, () => {
    set(!get());
    b.classList.toggle("on", get());
  });
  b.classList.toggle("on", get());
  return b;
}

function radio<T>(parent: HTMLElement, options: [string, T][], get: () => T, set: (v: T) => void) {
  const buttons = options.map(([label, value]) =>
    button(parent, label, () => {
      set(value);
      buttons.forEach((b, i) => b.classList.toggle("on", options[i][1] === get()));
    }),
  );
  buttons.forEach((b, i) => b.classList.toggle("on", options[i][1] === get()));
}

const time = section("Time");
const pauseBtn = toggle(time, "Pause", () => state.paused, (v) => (state.paused = v));
button(time, "Step", () => {
  state.paused = true;
  pauseBtn.classList.add("on");
  tick(STEP);
});
radio(time, [["¼×", 0.25], ["½×", 0.5], ["1×", 1], ["2×", 2]], () => state.speed, (v) => (state.speed = v));

const scene = section("Scene");
toggle(scene, "Autonomous", () => state.autonomous, (v) => {
  state.autonomous = v;
  stage.director.autonomous = v;
});
toggle(scene, "Follow", () => state.follow, (v) => (state.follow = v));
toggle(scene, "Dark", () => state.dark, (v) => {
  state.dark = v;
  desk.style.background = v ? "#1d2330" : "#7fa8e8";
});
toggle(scene, "Border", () => state.border, (v) => {
  state.border = v;
  stage.stickerBorder = v ? 1.5 : 0;
});
button(scene, "Restore windows", () => {
  state.windows = structuredClone(START_WINDOWS);
  pushWindows();
});
button(scene, "Reset", () => makeStage());

const hat = section("Hat");
radio(hat, [["None", null], ["Nightcap", "nightcap"], ["Bottlecap", "bottlecap"]] as [string, Hat][], () => state.hat, (v) => {
  state.hat = v;
  stage.actor.puppet.hat = v;
});

const reactions = section("Reactions");
for (const name of REACTION_NAMES) {
  button(reactions, name, () => perform(name));
}
const sign = document.createElement("input");
sign.type = "text";
sign.value = state.sign;
sign.placeholder = "Sign text";
sign.addEventListener("input", () => (state.sign = sign.value));
panel.appendChild(sign);

const emotions = section("Emotions");
for (const name of EMOTION_NAMES) {
  button(emotions, name, () => stage.actor.feel(name as Emotion, 4));
}

function perform(name: ReactionName) {
  void stage.director.perform(name, { target: "cursor", text: state.sign });
}

// ───────────────────────── loop ─────────────────────────

function tick(dt: number) {
  stage.step(dt);
}

function drawDesk() {
  for (const w of stage.world.windows) {
    const el = winEls.get(w.hwnd);
    if (!el) continue;
    el.style.display = w.state === "minimized" ? "none" : "";
    el.style.zIndex = w.hwnd === state.foreground ? "2" : "1";
    Object.assign(el.style, { left: `${w.rect.x}px`, top: `${w.rect.y}px`, width: `${w.rect.w}px`, height: `${w.rect.h}px` });
  }
  const a = stage.actor;
  hud.textContent = `${stage.world.time.toFixed(2)}s  ${a.mode}${a.sitting ? " sit" : ""}${a.busy ? " busy" : ""}  ${a.feeling}`;
}

makeStage();
desk.style.background = "#7fa8e8";

let last = performance.now();
let acc = 0;
function frame(t: number) {
  const real = Math.min(0.1, (t - last) / 1000);
  last = t;
  if (!state.paused) {
    acc += real * state.speed;
    while (acc >= STEP) {
      tick(STEP);
      acc -= STEP;
    }
  }
  stage.render();
  layout();
  drawDesk();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
