import type { Rect } from "../sense/types";

const STYLE = `
.pesto-paper {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 5;
  box-sizing: border-box;
  max-width: 340px;
  padding: 10px 14px;
  font: 600 15px/1.35 "Segoe UI", system-ui, sans-serif;
  color: #2c2321;
  background: #fffdf8;
  border: 2.6px solid #2c2321;
  border-radius: 16px;
  box-shadow: 0 0 0 3.5px #fff, 0 5px 14px rgba(20, 14, 10, 0.32);
  transform-origin: 50% 100%;
  opacity: 0;
  transition: opacity 0.12s ease-out, scale 0.16s cubic-bezier(0.3, 1.5, 0.5, 1);
  scale: 0.85;
  pointer-events: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pesto-paper.on { opacity: 1; scale: 1; }
.pesto-paper.note {
  max-width: 420px;
  padding: 16px 18px;
  font-weight: 500;
  background: #fbf3df;
  border-radius: 3px 14px 4px 12px;
  rotate: -1.2deg;
}
.pesto-paper.note strong { font-weight: 700; }
.pesto-paper.note code { font: 13px/1.3 Consolas, monospace; background: #efe3c6; padding: 1px 4px; border-radius: 3px; }
`;

let styled = false;

/**
 * A piece of paper Pesto holds up: a speech caption, or a note he wants read.
 * It floats above his head and stays on the monitor he is on.
 */
export class Paper {
  private el: HTMLDivElement;
  private hideAt = Infinity;
  private size = { w: 0, h: 0 };
  shown = false;

  constructor(root: HTMLElement) {
    if (!styled) {
      styled = true;
      const style = document.createElement("style");
      style.textContent = STYLE;
      document.head.appendChild(style);
    }
    this.el = document.createElement("div");
    this.el.className = "pesto-paper";
    root.appendChild(this.el);
  }

  /** Shows text. `seconds` of 0 keeps it up until `hide()`. */
  show(text: string, kind: "speech" | "note" = "speech", seconds = 0, now = 0) {
    this.el.className = `pesto-paper ${kind}`;
    if (kind === "note") this.el.innerHTML = renderNote(text);
    else this.el.textContent = text;
    this.size = { w: this.el.offsetWidth, h: this.el.offsetHeight };
    this.shown = true;
    this.hideAt = seconds > 0 ? now + seconds : Infinity;
    requestAnimationFrame(() => this.el.classList.add("on"));
  }

  hide() {
    this.shown = false;
    this.hideAt = Infinity;
    this.el.classList.remove("on");
  }

  /**
   * @param anchor the top of his head, in stage pixels
   * @param bounds the monitor to stay inside, in stage pixels
   */
  update(anchor: { x: number; y: number }, bounds: Rect | null, now: number) {
    if (this.shown && now >= this.hideAt) this.hide();
    if (!this.shown) return;
    let x = anchor.x - this.size.w / 2;
    let y = anchor.y - this.size.h - 14;
    if (bounds) {
      x = Math.max(bounds.x + 8, Math.min(x, bounds.x + bounds.w - this.size.w - 8));
      // No room above: drop it beside him instead.
      if (y < bounds.y + 8) y = Math.min(anchor.y + 150, bounds.y + bounds.h - this.size.h - 8);
    }
    this.el.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Just enough formatting for a note: bold, code and line breaks. */
function renderNote(text: string) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
