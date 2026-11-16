export interface TraceLine {
  /** Wall-clock milliseconds. */
  at: number;
  from: string;
  text: string;
}

const KEEP = 200;

/**
 * A running record of what his ears, the decision model and his legs are
 * doing, for the debug panel and the devtools console. Costs nothing while off.
 */
export const trace = {
  on: false,
  lines: [] as TraceLine[],
  /** Things that are true right now, one line per key, shown above the log. */
  status: new Map<string, string>(),

  /** Records something that happened. */
  log(from: string, text: string) {
    if (!this.on) return;
    this.lines.push({ at: Date.now(), from, text });
    if (this.lines.length > KEEP) this.lines.splice(0, this.lines.length - KEEP);
    console.debug(`[${from}] ${text}`);
  },

  /** Sets or, with null, clears a line of current state. */
  set(key: string, text: string | null) {
    if (!this.on) return;
    if (text == null) this.status.delete(key);
    else this.status.set(key, text);
  },

  enable(on: boolean) {
    this.on = on;
    if (!on) this.status.clear();
  },
};
