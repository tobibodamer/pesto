// Film strips: runs a scripted scenario on a fake desktop and lays out
// frames from chosen moments side by side, to check motion without the app.
import { seed } from "../src/pesto/math";
import * as moves from "../src/pesto/moves";
import type { WindowInfo } from "../src/sense/types";
import { Stage } from "../src/stage/stage";

declare global {
  interface Window {
    SHEET?: string;
  }
}

const W = 1500;
const H = 800;
const FLOOR = 752;

const WINDOWS: WindowInfo[] = [
  { hwnd: 1, title: "Notes", exe: "notepad.exe", pid: 1, rect: { x: 180, y: 330, w: 480, h: 300 }, monitor: 0, state: "normal" },
  { hwnd: 2, title: "Browser", exe: "chrome.exe", pid: 2, rect: { x: 800, y: 170, w: 420, h: 420 }, monitor: 0, state: "normal" },
];

interface Scenario {
  /** Seconds at which to capture a frame. */
  frames: number[];
  /** Called once at t=0, then every simulation step. */
  script: (stage: Stage, t: number, first: boolean) => void;
  zoom?: number;
}

function at(t: number, when: number, fn: () => void, dt = 1 / 60) {
  if (t >= when && t < when + dt) fn();
}

const SCENARIOS: Record<string, Scenario> = {
  emerge: {
    frames: [0.2, 0.9, 1.25, 1.5, 1.75, 1.95, 2.15, 2.4, 3.2, 4.2, 5.4, 6.4],
    script: (s, t, first) => {
      if (first) {
        s.director.autonomous = false;
        void s.actor.run(
          (function* () {
            yield* moves.exitCan(s.actor);
            yield* moves.travel(s.actor, "w:1:0", 420);
          })(),
        );
      }
    },
  },
  climb: {
    frames: [0.6, 1.2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    script: (s, t, first) => {
      if (first) {
        s.director.autonomous = false;
        void s.actor.run(
          (function* () {
            yield* moves.exitCan(s.actor, { quick: true });
            yield* moves.travel(s.actor, "w:2:0", 1000);
            yield* moves.sit(s.actor, 1.5);
            yield* moves.pointAt(s.actor, 400, 250, 1.5);
            yield* moves.enterCan(s.actor);
          })(),
        );
      }
    },
  },
  // The climb up the glass, close up.
  ascent: {
    zoom: 2.4,
    frames: [2.1, 2.35, 2.6, 2.85, 3.1, 3.35, 3.6, 3.85, 4.1, 4.35, 4.6, 4.85, 5.1, 5.35, 5.6, 5.85],
    script: (s, t, first) => {
      if (first) {
        s.director.autonomous = false;
        void s.actor.run(
          (function* () {
            yield* moves.exitCan(s.actor, { quick: true });
            yield* moves.travel(s.actor, "w:2:0", 1000);
          })(),
        );
      }
    },
  },
  // The dance, close up, a frame every few beats.
  dance: {
    zoom: 3,
    frames: [3.2, 4.0, 4.8, 5.6, 6.4, 7.2, 8.0, 8.8, 9.6, 10.4, 11.2, 12.75],
    script: (s, t, first) => {
      if (first) {
        s.director.autonomous = false;
        const a = s.actor;
        void a.run(
          (function* () {
            yield* moves.exitCan(a, { quick: true });
            yield* moves.walkTo(a, 1100);
            yield* moves.dance(a, 10);
          })(),
        );
      }
    },
  },
  gestures: {
    zoom: 2.2,
    frames: [1.2, 2.1, 3.2, 4.6, 6.4, 8.3, 9.7, 11.6, 13.2, 14.6, 16.4, 18.6],
    script: (s, t, first) => {
      if (first) {
        s.director.autonomous = false;
        const a = s.actor;
        void a.run(
          (function* () {
            yield* moves.exitCan(a, { quick: true });
            yield* moves.walkTo(a, 1100);
            yield* moves.wave(a, 1.2);
            yield* moves.knock(a, 3);
            yield* moves.holdSign(a, "23 min.", 1.6);
            yield* moves.ponder(a, 1.6);
            yield* moves.shrug(a);
            yield* moves.clap(a, 1.2);
            yield* moves.dance(a, 2);
            yield* moves.yawn(a);
            yield* moves.flop(a, 1.6);
            yield* moves.startle(a);
          })(),
        );
      }
    },
  },
  handling: {
    zoom: 1.6,
    frames: [1.0, 1.6, 2.2, 2.8, 3.3, 3.6, 4.4, 5.2, 6.2, 7.6, 8.6, 9.4],
    script: (s, t, first) => {
      const a = s.actor;
      const w = s.world;
      if (first) {
        s.director.autonomous = false;
        void a.run(
          (function* () {
            yield* moves.exitCan(a, { quick: true });
            yield* moves.walkTo(a, 1150);
          })(),
        );
      }
      // Grab him by the scruff at 1.4 s, carry him over open glass, let go.
      if (t > 1.3 && t < 1.4) w.setCursor({ x: a.x, y: a.y - 70, buttons: 0 });
      at(t, 1.4, () => w.setCursor({ x: a.x, y: a.y - 70, buttons: 1 }));
      if (t > 1.42 && t < 3.3) {
        const u = (t - 1.42) / 1.88;
        w.setCursor({ x: 1150 - u * 420 + Math.sin(t * 9) * 60, y: 660 - u * 430, buttons: 1 });
      }
      at(t, 3.3, () => w.setCursor({ x: w.cursor.x, y: w.cursor.y, buttons: 0 }));
      // Then pick him up again and throw him.
      at(t, 7.0, () => w.setCursor({ x: a.x, y: a.y - 60, buttons: 0 }));
      at(t, 7.05, () => w.setCursor({ x: a.x, y: a.y - 60, buttons: 1 }));
      if (t > 7.07 && t < 7.5) w.setCursor({ x: w.cursor.x - 24, y: w.cursor.y - 10, buttons: 1 });
      at(t, 7.5, () => w.setCursor({ x: w.cursor.x - 24, y: w.cursor.y - 10, buttons: 0 }));
    },
  },
  // Close on the face: the cursor jumps across the screen and his eyes get there before his head.
  look: {
    zoom: 4,
    frames: [4.9, 5.03, 5.07, 5.12, 5.2, 5.32, 5.5, 5.9, 6.6, 7.4, 8.2, 9],
    script: (s, t, first) => {
      const a = s.actor;
      if (first) {
        s.director.autonomous = false;
        void a.run(
          (function* () {
            yield* moves.exitCan(a, { quick: true });
            yield* moves.walkTo(a, 1100);
          })(),
        );
      }
      s.world.setCursor(t < 5 ? { x: 760, y: 640, buttons: 0 } : { x: 1440, y: 470, buttons: 0 });
    },
  },
  // Close on the arm as a point sweeps from low right, overhead, to low left, then he sits.
  reach: {
    zoom: 4,
    frames: [3.0, 3.6, 4.2, 4.8, 5.4, 6.0, 6.6, 7.2, 7.8, 8.4, 9.8, 10.6],
    script: (s, t, first) => {
      const a = s.actor;
      if (first) {
        s.director.autonomous = false;
        void a.run(
          (function* () {
            yield* moves.exitCan(a, { quick: true });
            yield* moves.walkTo(a, 1100);
          })(),
        );
      }
      const u = Math.min(1, Math.max(0, (t - 3) / 5.4));
      const ang = -0.3 + u * (Math.PI + 0.6);
      const x = a.x + Math.cos(ang) * 300;
      const y = a.y - 50 - Math.sin(ang) * 300;
      s.world.setCursor({ x, y, buttons: 0 });
      at(t, 2.9, () => (a.gesture = moves.pointing(a, 1, () => s.world.cursor)));
      at(t, 8.6, () => (a.gesture = null));
      at(t, 9, () => void a.run(moves.sit(a, 3)));
    },
  },
  // Close on the body through a walk, a startled hop and its landing.
  step: {
    zoom: 4,
    frames: [1.3, 1.42, 1.54, 1.66, 1.78, 1.9, 4.03, 4.12, 4.24, 4.36, 4.42, 4.52],
    script: (s, t, first) => {
      const a = s.actor;
      if (first) {
        s.director.autonomous = false;
        void a.run(
          (function* () {
            yield* moves.exitCan(a, { quick: true });
            yield* moves.walkTo(a, 1150, false);
          })(),
        );
      }
      at(t, 4, () => void a.run(moves.startle(a)));
    },
  },
  idle: {
    frames: [2, 6, 10, 14, 18, 24, 30, 38, 46, 54, 62, 70],
    script: (s, t, first) => {
      s.world.setCursor({ x: 700 + Math.sin(t * 0.7) * 400, y: 400 + Math.cos(t * 0.9) * 200, buttons: 0 });
    },
  },
  ride: {
    zoom: 1.4,
    frames: [7.5, 8.9, 9.15, 9.3, 9.5, 9.75, 10.1, 11.4, 11.6, 11.8, 12.1, 13.2],
    script: (s, t, first) => {
      const a = s.actor;
      if (first) {
        s.director.autonomous = false;
        void a.run(
          (function* () {
            yield* moves.exitCan(a, { quick: true });
            yield* moves.travel(a, "w:1:0", 420);
          })(),
        );
      }
      // Drag the window he stands on, then minimise it out from under him.
      const wins = structuredClone(WINDOWS);
      if (t > 9 && t < 10) wins[0].rect.x = 180 + Math.sin((t - 9) * Math.PI) * 420;
      if (t > 11.5) wins[0].state = "minimized";
      s.world.setWindows({ windows: wins, foreground: 2, moving: t > 9 && t < 10 ? 1 : null });
    },
  },
};

const name = window.SHEET ?? "emerge";
const scenario = SCENARIOS[name];
const cols = 4;
const tileW = Math.floor(window.innerWidth / cols);
const zoom = scenario.zoom ?? 1;
const k = (tileW / W) * zoom;
const tileH = Math.round(H * (tileW / W));

document.body.style.cssText = "margin:0;background:#11151c;display:flex;flex-wrap:wrap;font:600 13px system-ui;color:#fff";

for (const frameAt of scenario.frames) {
  const tile = document.createElement("div");
  tile.style.cssText = `position:relative;width:${tileW}px;height:${tileH}px;overflow:hidden;outline:1px solid #000;background:#7fa8e8`;
  const desk = document.createElement("div");
  desk.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0`;
  tile.appendChild(desk);
  document.body.appendChild(tile);

  const taskbar = document.createElement("div");
  taskbar.style.cssText = `position:absolute;left:0;top:${FLOOR}px;width:${W}px;height:${H - FLOOR}px;background:#27324a`;
  desk.appendChild(taskbar);
  const winEls = WINDOWS.map(() => {
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;background:#f4f5f7;border-radius:8px;box-shadow:0 6px 24px #0005;border-top:30px solid #dfe3ea";
    desk.appendChild(el);
    return el;
  });

  const root = document.createElement("div");
  root.style.cssText = "position:absolute;left:0;top:0";
  desk.appendChild(root);

  seed(1234);
  const stage = new Stage(root);
  stage.director.hour = () => 14;
  stage.world.setMonitors({
    monitors: [{ id: 0, rect: { x: 0, y: 0, w: W, h: H }, work: { x: 0, y: 0, w: W, h: FLOOR }, scale: 1, primary: true }],
    virtual: { x: 0, y: 0, w: W, h: H },
  });
  stage.world.setWindows({ windows: WINDOWS, foreground: 2, moving: null });
  stage.world.setCursor({ x: 700, y: 300, buttons: 0 });

  const dt = 1 / 60;
  let first = true;
  for (let t = 0; t < frameAt; t += dt) {
    scenario.script(stage, t, first);
    first = false;
    stage.step(dt);
  }
  stage.render();

  stage.world.windows.forEach((w, i) => {
    const el = winEls[WINDOWS.findIndex((o) => o.hwnd === w.hwnd)] ?? winEls[i];
    el.style.display = w.state === "minimized" ? "none" : "";
    Object.assign(el.style, { left: `${w.rect.x}px`, top: `${w.rect.y}px`, width: `${w.rect.w}px`, height: `${w.rect.h - 30}px` });
  });

  // Zoomed strips keep Pesto centred instead of showing the whole desktop.
  const fx = zoom > 1 ? Math.min(0, Math.max(tileW - W * k, tileW / 2 - stage.actor.x * k)) : 0;
  const fy = zoom > 1 ? Math.min(0, Math.max(tileH - H * k, tileH * 0.62 - stage.actor.y * k)) : 0;
  desk.style.transform = `translate(${fx}px, ${fy}px) scale(${k})`;

  const cur = document.createElement("div");
  cur.style.cssText = `position:absolute;left:${stage.world.cursor.x - 5}px;top:${stage.world.cursor.y - 5}px;width:10px;height:10px;border-radius:50%;background:${stage.world.cursor.buttons ? "#ff3d5a" : "#fff"};outline:2px solid #000;z-index:9`;
  desk.appendChild(cur);

  const label = document.createElement("div");
  label.style.cssText = "position:absolute;left:6px;top:4px;text-shadow:0 1px 2px #000;z-index:10";
  label.textContent = `${frameAt.toFixed(2)}s  ${stage.actor.mode}${stage.actor.sitting ? " sit" : ""}`;
  tile.appendChild(label);
}
