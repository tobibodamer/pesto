const STYLE = `
.pesto-ping {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 6;
  width: 44px;
  height: 44px;
  margin: -22px 0 0 -22px;
  box-sizing: border-box;
  border: 3px solid #2c2321;
  border-radius: 50%;
  box-shadow: 0 0 0 2.5px #fff, inset 0 0 0 2.5px #fff;
  pointer-events: none;
  animation: pesto-ping 0.55s cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
}
@keyframes pesto-ping {
  from { scale: 0.15; opacity: 1; }
  60% { opacity: 1; }
  to { scale: var(--size); opacity: 0; }
}
`;

let styled = false;

/** A ring that spreads from the exact spot he touched on the glass and is gone in half a second. */
export class Ping {
  constructor(private root: HTMLElement) {
    if (styled) return;
    styled = true;
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  /** @param x, y the spot in stage pixels */
  at(x: number, y: number, size = 1) {
    const el = document.createElement("div");
    el.className = "pesto-ping";
    el.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
    el.style.setProperty("--size", String(size));
    el.addEventListener("animationend", () => el.remove());
    this.root.appendChild(el);
  }
}
