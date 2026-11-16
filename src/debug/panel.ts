import type { Actor } from "../pesto/actor";
import type { World } from "../world/world";
import { trace } from "./trace";

const SHOWN = 22;

const clock = (at: number) => {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getMinutes())}:${two(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
};

/**
 * The trace, drawn in the top left corner of the monitor he is on. Clicks
 * pass through it. `root` is the stage's container, in physical pixels.
 */
export class DebugPanel {
  private el = document.createElement("pre");
  private drawn = "";

  constructor(
    root: HTMLElement,
    private world: World,
    private actor: Actor,
  ) {
    Object.assign(this.el.style, {
      position: "absolute",
      margin: "0",
      zIndex: "9",
      display: "none",
      pointerEvents: "none",
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      font: "12px/1.45 ui-monospace, Consolas, monospace",
      color: "#e8e6df",
      background: "rgba(16, 17, 20, 0.86)",
      borderRadius: "8px",
      transformOrigin: "0 0",
    });
    root.appendChild(this.el);
  }

  update() {
    const { el } = this;
    if (!trace.on) {
      if (el.style.display !== "none") el.style.display = "none";
      return;
    }
    const scale = window.devicePixelRatio;
    const screen = (this.world.monitorAt(this.actor.x, this.actor.y) ?? this.world.monitors[0])?.work;
    if (!screen) return;
    el.style.display = "block";
    el.style.left = `${screen.x - this.world.virtual.x + 12 * scale}px`;
    el.style.top = `${screen.y - this.world.virtual.y + 12 * scale}px`;
    el.style.width = `${Math.min(620, screen.w / scale - 24)}px`;
    el.style.padding = "10px 12px";
    el.style.transform = `scale(${scale})`;

    const status = [...trace.status].map(([key, text]) => `${key.padEnd(9)}${text}`);
    const log = trace.lines.slice(-SHOWN).map((l) => `${clock(l.at)} ${l.from.padEnd(8)} ${l.text}`);
    const text = [...status, status.length && log.length ? "" : null, ...log].filter((l) => l != null).join("\n") || "nothing yet";
    if (text !== this.drawn) el.textContent = this.drawn = text;
  }
}
