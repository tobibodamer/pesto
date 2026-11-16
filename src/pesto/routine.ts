/**
 * Behaviours are generators. Each `yield` waits one frame and evaluates to
 * that frame's delta time, so a behaviour reads top to bottom like a script
 * and can be dropped at any frame boundary to interrupt it.
 */
export type Routine<T = void> = Generator<void, T, number>;

/** Thrown inside a routine when the world changed under it and it cannot go on. */
export class Interrupted extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

export function* wait(seconds: number): Routine {
  let t = 0;
  while (t < seconds) t += (yield) ?? 0;
}

/** Calls `fn` with 0..1 every frame for `seconds`, ending exactly on 1. */
export function* tween(seconds: number, fn: (u: number) => void): Routine {
  let t = 0;
  while (t < seconds) {
    fn(t / seconds);
    t += (yield) ?? 0;
  }
  fn(1);
}

/** Waits until `done()` is true. Returns false if `timeout` ran out first. */
export function* until(done: () => boolean, timeout = Infinity): Routine<boolean> {
  let t = 0;
  while (!done()) {
    if (t >= timeout) return false;
    t += (yield) ?? 0;
  }
  return true;
}

/** Runs routines one after another, each frame stepping all of them, until every one has finished. */
export function* together(...routines: Routine[]): Routine {
  const live = new Set(routines);
  let dt = 0;
  while (live.size) {
    for (const r of live) if (r.next(dt).done) live.delete(r);
    if (live.size) dt = (yield) ?? 0;
  }
}
