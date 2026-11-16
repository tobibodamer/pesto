import type { Rect } from "../sense/types";

export interface MenuItem {
  label: string;
  /** Shown as a tick when defined: the item is a switch. */
  checked?: boolean;
  /** Draws a rule above the item. */
  divide?: boolean;
  /** Makes the item a slider from 0 to 1 instead of a button; `set` is called as it moves. */
  slide?: { value: number; set: (value: number) => void };
  action?: () => void;
}

const STYLE = `
.pesto-menu {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 9;
  min-width: 190px;
  padding: 6px;
  font: 600 14px/1 "Segoe UI", system-ui, sans-serif;
  color: #2c2321;
  background: #fffdf8;
  border: 2.6px solid #2c2321;
  border-radius: 14px;
  box-shadow: 0 0 0 3.5px #fff, 0 6px 16px rgba(20, 14, 10, 0.35);
  display: none;
}
.pesto-menu.on { display: block; }
.pesto-menu button {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 8px 10px;
  font: inherit;
  color: inherit;
  text-align: left;
  background: none;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
.pesto-menu button:hover { background: #f1e7d2; }
.pesto-menu button::before {
  content: "";
  flex: none;
  width: 18px;
  font-weight: 800;
}
.pesto-menu button.checked::before { content: "✓"; }
.pesto-menu label {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px 6px 28px;
}
.pesto-menu input {
  flex: 1;
  min-width: 0;
  width: 90px;
  accent-color: #2c2321;
  cursor: pointer;
}
.pesto-menu hr {
  height: 2px;
  margin: 5px 8px;
  background: #e6dcc8;
  border: 0;
}
`;

let styled = false;

/** The right-click menu, drawn on the overlay in the same paper as his notes. */
export class Menu {
  private el: HTMLDivElement;
  private at: Rect | null = null;

  constructor(root: HTMLElement) {
    if (!styled) {
      styled = true;
      const style = document.createElement("style");
      style.textContent = STYLE;
      document.head.appendChild(style);
    }
    this.el = document.createElement("div");
    this.el.className = "pesto-menu";
    root.appendChild(this.el);
  }

  /** Where the open menu is, in stage pixels; null while it is closed. */
  get rect(): Rect | null {
    return this.at;
  }

  /** Opens at a point in stage pixels, kept inside `within`. */
  open(x: number, y: number, within: Rect | null, items: MenuItem[]) {
    this.el.replaceChildren(
      ...items.flatMap((item) => {
        const row = item.slide ? slider(item.label, item.slide) : document.createElement("button");
        if (!item.slide) {
          row.textContent = item.label;
          if (item.checked) row.className = "checked";
          row.addEventListener("click", () => {
            this.close();
            item.action?.();
          });
        }
        return item.divide ? [document.createElement("hr"), row] : [row];
      }),
    );
    this.el.classList.add("on");
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    if (within) {
      x = Math.max(within.x + 8, Math.min(within.x + within.w - w - 8, x));
      y = Math.max(within.y + 8, Math.min(within.y + within.h - h - 8, y - h));
    }
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.at = { x, y, w, h };
  }

  close() {
    this.el.classList.remove("on");
    this.at = null;
  }
}

function slider(text: string, slide: { value: number; set: (value: number) => void }): HTMLElement {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = "1";
  input.step = "0.05";
  input.value = String(slide.value);
  input.addEventListener("input", () => slide.set(Number(input.value)));
  label.append(text, input);
  return label;
}
