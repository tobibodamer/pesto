import { CAN, LID_PEEK, type Can } from "../can/can";
import type { Actor } from "../pesto/actor";
import { chance, clamp, pick, rand } from "../pesto/math";
import * as moves from "../pesto/moves";
import type { Emotion } from "../pesto/pose";
import { until, wait, type Routine } from "../pesto/routine";
import type { Litter } from "../stage/litter";
import type { Ledge, World } from "../world/world";

/** Where a reaction is aimed. */
export type Target = { x: number; y: number } | { window: number } | "cursor" | "user";

export interface ReactionArgs {
  target?: Target;
  text?: string;
  seconds?: number;
  emotion?: Emotion;
}

interface Reaction {
  /** One line for whoever chooses reactions: a model, or a person reading the catalog. */
  describe: string;
  /** A routine that takes over his body until it finishes. */
  run?: (d: Director, args: ReactionArgs) => Routine;
  /** An instant change to his face or eyes that leaves whatever he is doing running. */
  now?: (d: Director, args: ReactionArgs) => void;
}

/**
 * Everything Pesto can be told to do without speaking. The idle scheduler,
 * the local decision model and the big model all pick from this one list.
 */
export const REACTIONS = {
  peek: {
    describe: "Lift the can lid a little and watch from the dark for a few seconds. Subtle.",
    run: function* (d, args) {
      if (d.actor.mode !== "can") return;
      d.can.eyes = true;
      d.can.lid = LID_PEEK;
      const p = d.resolve(args.target);
      if (p) d.actor.lookAt(p.x, p.y, args.seconds ?? 3);
      yield* wait(args.seconds ?? rand(2, 4.5));
      d.can.lid = 0;
      yield* wait(0.25);
      d.can.eyes = false;
    },
  },
  rustle: {
    describe: "Rummage inside the can so it rattles. He stays hidden.",
    run: function* (d) {
      d.can.shake(1);
      d.actor.cue("rustle");
      yield* wait(0.5);
      if (chance(0.5)) d.can.shake(0.7);
      yield* wait(0.6);
    },
  },
  chew: {
    describe: "Chew on something inside the can. Heard, not seen.",
    run: function* (d) {
      if (d.actor.mode !== "can") return;
      d.actor.cue("chew");
      for (let bite = 0; bite < 5; bite++) {
        d.can.shake(0.2);
        yield* wait(0.3);
      }
    },
  },
  mutter: {
    describe: "Mutter to himself inside the can, too muffled to make out.",
    run: function* (d) {
      if (d.actor.mode !== "can") return;
      d.actor.cue("mutter");
      d.can.shake(0.15);
      yield* wait(1.8);
    },
  },
  rattle: {
    describe: "Knock a tin around inside the can.",
    run: function* (d) {
      if (d.actor.mode !== "can") return;
      d.actor.cue("clank");
      for (const strength of [1, 0.6, 0.35]) {
        d.can.shake(strength);
        yield* wait(0.3);
      }
    },
  },
  snore: {
    describe: "Snore inside the can, the lid lifting a little with each breath.",
    run: function* (d, args) {
      if (d.actor.mode !== "can") return;
      try {
        for (let left = args.seconds ?? 7; left > 0; left -= 2.6) {
          d.actor.cue("snore");
          d.can.lid = 0.05;
          yield* wait(1.1);
          d.can.lid = 0;
          yield* wait(1.5);
        }
      } finally {
        d.can.lid = 0;
      }
    },
  },
  toss: {
    describe: "Fling a piece of junk out of the can. It lands on the desktop and lies there a while.",
    run: function* (d) {
      const { actor: a, can, litter } = d;
      if (a.mode !== "can") return;
      try {
        can.shake(1);
        a.cue("rustle");
        yield* wait(rand(0.5, 0.9));
        can.lid = 0.6;
        can.shake(0.6);
        a.cue("lid");
        yield* until(() => can.opening > 0.3, 0.4);
        // Toward whichever side has more floor to land on.
        const floor = d.world.ledgeBelow(can.x, can.y - 4);
        const side = floor && can.x - floor.x1 < floor.x2 - can.x ? 1 : -1;
        const k = litter.scale;
        const junk = litter.toss(can.x + side * 8 * k, can.y + (CAN.rimY - 6) * can.scale, side * rand(150, 430) * k, -rand(640, 900) * k);
        yield* wait(0.3);
        // He watches where it went.
        can.eyes = true;
        can.lid = LID_PEEK;
        yield* until(() => {
          a.lookAt(junk.x, junk.y, 0.5);
          return junk.resting;
        }, 2.5);
        yield* wait(0.6);
        can.lid = 0;
        yield* wait(0.25);
      } finally {
        can.lid = 0;
        can.eyes = false;
      }
    },
  },
  lookOut: {
    describe: "Push the lid up with his head and hang on the rim of the can, chin on it, watching for a while.",
    run: function* (d, args) {
      const seconds = args.seconds ?? rand(8, 20);
      const p = d.resolve(args.target);
      if (p) d.actor.lookAt(p.x, p.y, seconds);
      yield* moves.leanOut(d.actor, seconds);
    },
  },
  comeOut: {
    describe: "Climb out of the can and stand beside it.",
    run: (d) => moves.exitCan(d.actor),
  },
  goHome: {
    describe: "Walk back to the can and jump in. The lid slams.",
    run: (d) => moves.enterCan(d.actor),
  },
  wander: {
    describe: "Stroll somewhere else on the screen the person is using and settle there.",
    run: function* (d) {
      const spot = d.pickSpot();
      if (!spot) return;
      yield* moves.travel(d.actor, spot.ledge.id, spot.x);
      if (spot.ledge.hwnd == null || chance(0.4)) return;
      if (d.relaxed && chance(0.6)) yield* moves.lounge(d.actor, rand(10, 24));
      else yield* moves.sit(d.actor, rand(5, 14));
    },
  },
  approach: {
    describe: "Go and stand next to the target, then look back and forth between it and the person.",
    run: function* (d, args) {
      const p = d.resolve(args.target);
      if (!p) return;
      yield* d.goNear(p.x, p.y);
      for (let i = 0; i < 2; i++) {
        d.actor.lookAt(p.x, p.y, 1);
        yield* wait(0.9);
        d.actor.look({ kind: "user" }, 1);
        yield* wait(0.7);
      }
    },
  },
  sit: {
    describe: "Sit down where he is with his legs dangling and watch.",
    run: (d, args) => moves.sit(d.actor, args.seconds ?? 8),
  },
  lounge: {
    describe: "Get properly comfortable: slouch on one arm, or stretch out on his side with his head propped on a paw.",
    run: (d, args) => moves.lounge(d.actor, args.seconds ?? 14),
  },
  groom: {
    describe: "Pull his tail up beside him and groom it with paw and tongue.",
    run: (d, args) => moves.groom(d.actor, args.seconds ?? 7),
  },
  glance: {
    describe: "Flick his eyes to the target for a moment. The smallest possible reaction.",
    now: (d, args) => {
      const p = d.resolve(args.target);
      if (p) d.actor.lookAt(p.x, p.y, args.seconds ?? 1.5);
      else d.actor.look({ kind: "user" }, args.seconds ?? 1.5);
      if (args.emotion) d.actor.feel(args.emotion, args.seconds ?? 1.5);
    },
  },
  emote: {
    describe: "Show an emotion on his face, ears and tail for a few seconds, without moving.",
    now: (d, args) => d.actor.feel(args.emotion ?? "curious", args.seconds ?? 2.5),
  },
  point: {
    describe: "Point at the target from where he stands, glancing between it and the person.",
    run: function* (d, args) {
      const p = d.resolve(args.target);
      if (p) yield* moves.pointAt(d.actor, p.x, p.y, args.seconds ?? 2.4);
    },
  },
  knock: {
    describe: "Knock on the glass from inside to get attention. Mildly annoying.",
    run: (d) => moves.knock(d.actor, 2),
  },
  sign: {
    describe: "Hold up a cardboard sign with a few words on it. Use `text`.",
    run: (d, args) => moves.holdSign(d.actor, args.text ?? "?", args.seconds ?? 4),
  },
  wave: { describe: "Wave at the person.", run: (d) => moves.wave(d.actor) },
  shrug: { describe: "Shrug: no idea, or fine, have it your way.", run: (d) => moves.shrug(d.actor) },
  nod: { describe: "A small approving nod.", run: (d) => moves.nod(d.actor) },
  ponder: { describe: "Rub his paws together and look up, thinking.", run: (d, args) => moves.ponder(d.actor, args.seconds ?? 3) },
  clap: { describe: "A tiny round of applause.", run: (d) => moves.clap(d.actor) },
  flop: { describe: "Collapse onto his back in theatrical despair.", run: (d, args) => moves.flop(d.actor, args.seconds ?? 3) },
  dance: { describe: "Dance to the music.", run: (d, args) => moves.dance(d.actor, args.seconds ?? 7) },
  startle: { describe: "Jump in fright with his fur on end.", run: (d) => moves.startle(d.actor) },
  swat: { describe: "Bat at the cursor, annoyed.", run: (d) => moves.swat(d.actor) },
  yawn: { describe: "A big yawn and stretch.", run: (d) => moves.yawn(d.actor) },
  sniff: {
    describe: "Lean in and sniff at the target, curious.",
    run: function* (d, args) {
      const p = d.resolve(args.target);
      if (p) yield* moves.sniff(d.actor, p.x, p.y);
    },
  },
} satisfies Record<string, Reaction>;

export type ReactionName = keyof typeof REACTIONS;
export const REACTION_NAMES = Object.keys(REACTIONS) as ReactionName[];

/** Reactions that only make sense once he is out of the can. */
const NEEDS_BODY = new Set<ReactionName>([
  "wander", "approach", "sit", "lounge", "groom", "point", "knock", "sign", "wave", "shrug", "nod", "ponder", "clap", "flop", "dance", "startle", "swat", "yawn", "sniff",
]);

/**
 * Decides what Pesto does with himself. On its own it only runs his idle
 * life and his reflexes to being touched; deliberate reactions arrive
 * through `perform`, from the decision model or the big model.
 */
export class Director {
  /** Set false to stop him doing things on his own, e.g. while a model is driving. */
  autonomous = true;
  /** Wall-clock hour, injectable so tests can pin the time of day. */
  hour = () => new Date().getHours();
  /** Called for every reaction he performs, whoever asked for it. */
  onPerform: ((name: ReactionName, args: ReactionArgs) => void) | null = null;

  private attentive = false;
  private grabbedAt = -Infinity;
  private grabs = 0;
  private grabSound = "";
  private idleIn = rand(2, 5);
  private outFor = 0;
  private loudFor = 0;
  /** Until when a slide down the glass will not try to catch an edge again. */
  private catchAfter = 0;
  /** Whether he watches the current burst of typing; decided afresh for each burst. */
  private watchingTyping = false;
  private lastCaretAt = -Infinity;
  private clockIn = 0;

  constructor(
    readonly world: World,
    readonly actor: Actor,
    readonly can: Can,
    readonly litter: Litter,
  ) {
    const a = actor;
    litter.onLand = (junk) => junk.kind === "tin" && a.cue("clank");
    // Clicked while he hangs on the rim, he drops back inside.
    world.on("mouseDown", (e) => {
      const hit = a.hitRect;
      if (a.mode !== "emerge" || !(e.buttons & 1) || !hit) return;
      if (e.x < hit.x || e.x > hit.x + hit.w || e.y < hit.y || e.y > hit.y + hit.h) return;
      a.cue("eep");
      void a.run(moves.duck(a));
    });
    a.on("poked", () => void this.perform("swat"));
    a.on("petted", () => a.cue("chitter"));
    a.on("grabbed", () => this.onGrabbed());
    a.on("dropped", ({ onLedge }) => {
      const edge = onLedge ? null : moves.edgeToHang(a);
      if (edge) {
        void a.run(moves.hangFrom(a, edge));
        return;
      }
      a.feel(onLedge ? "curious" : "strained", 1.6);
      if (onLedge) void a.run(this.inspectGround());
    });
    a.on("thrown", () => a.cue("yelp"));
    a.on("shaken", () => a.cue("dizzy"));
    a.on("landed", ({ hard }) => {
      a.cue(hard ? "thud" : "land");
      if (!hard || a.busy) return;
      a.dizzy = Math.max(a.dizzy, 1.6);
      void a.run(this.glareAfter(1.7));
    });
    a.on("slid", () => {
      a.cue("squeak");
      a.feel("annoyed", 2);
      a.look({ kind: "user" }, 1.5);
    });
    a.on("lostFooting", () => a.cue("gasp"));

    world.on("focusChanged", (w) => {
      if (!w) return;
      const x = w.rect.x + w.rect.w / 2;
      const y = w.rect.y + 24;
      if (a.mode === "can") {
        if (this.autonomous && !a.busy && chance(0.3)) void this.perform("peek", { target: { x, y }, seconds: rand(1.5, 3) });
      } else if (!a.busy || a.sitting) {
        a.lookAt(x, y, 1.4);
      }
    });
    world.on("elementFocused", (f) => {
      const p = world.actionPoint;
      if (!p || f.kind === "window" || f.kind === "pane" || a.mode === "can") return;
      if (!a.busy || a.sitting) a.lookAt(p.x, p.y, 1.2);
    });
    world.on("caretMoved", () => {
      if (world.time - this.lastCaretAt > 2) this.watchingTyping = chance(0.6);
      this.lastCaretAt = world.time;
      const p = world.actionPoint;
      if (!p || !this.watchingTyping || a.mode === "can") return;
      if (!a.busy || a.sitting) a.lookAt(p.x, p.y, 1.2);
    });
    world.on("windowOpened", (w) => {
      if (a.mode === "can" || a.busy) return;
      a.feel("curious", 1.6);
      a.lookAt(w.rect.x + w.rect.w / 2, w.rect.y + 24, 1.6);
    });
    world.on("audio", ({ now, before }) => {
      if (now > 0.62 && before < 0.12 && this.loudFor <= 0) {
        this.loudFor = 4;
        if (a.mode === "can") this.can.shake(0.9);
        else if (a.mode === "ground" && (!a.busy || a.sitting)) void this.perform("startle");
      }
    });
  }

  /**
   * Being picked up surprises him the first time. Do it again soon after and
   * he gets used to it, then tired of it, and mostly stops making a sound.
   */
  private onGrabbed() {
    const a = this.actor;
    const now = this.world.time;
    this.grabs = now - this.grabbedAt < 30 ? this.grabs + 1 : 0;
    this.grabbedAt = now;
    const moods = this.grabs === 0 ? (["surprised", "unsure", "curious"] as const) : this.grabs < 3 ? (["unsure", "annoyed", "sleepy"] as const) : (["annoyed", "grumpy", "glare"] as const);
    a.feel(pick(moods), rand(1.8, 3));
    if (!chance(this.grabs === 0 ? 0.6 : 0.22)) return;
    const sounds = (this.grabs === 0 ? ["eep", "huh", "gasp"] : ["huh", "grumble"]).filter((s) => s !== this.grabSound);
    this.grabSound = pick(sounds);
    a.cue(this.grabSound);
  }

  /**
   * Gives the person his whole attention while they are typing or speaking
   * to him: whatever he was doing stops, and from the can the lid comes up.
   */
  listen(on: boolean) {
    const a = this.actor;
    this.attentive = on;
    if (on) {
      a.stop();
      if (a.mode === "can") {
        this.can.eyes = true;
        this.can.lid = LID_PEEK;
      }
    } else if (a.mode === "can" && !a.busy) {
      this.can.lid = 0;
      this.can.eyes = false;
    }
    a.look({ kind: "user" }, on ? 600 : 1);
    a.feel("curious", on ? 600 : 0.6);
  }

  /**
   * Runs a reaction from the catalog. If it needs him out of the can, he
   * comes out first. Resolves false if something interrupted it.
   */
  perform(name: ReactionName, args: ReactionArgs = {}): Promise<boolean> {
    const reaction: Reaction = REACTIONS[name];
    const d = this;
    this.onPerform?.(name, args);
    if (reaction.now) {
      reaction.now(this, args);
      return Promise.resolve(true);
    }
    const run = reaction.run!;
    return this.actor.run(
      (function* () {
        if (NEEDS_BODY.has(name)) {
          if (d.actor.mode === "can" || d.actor.mode === "emerge") yield* moves.exitCan(d.actor, { quick: true });
          if (d.actor.mode === "air" || d.actor.mode === "glass") yield* until(() => d.actor.mode === "ground", 12);
        }
        yield* run(d, args);
      })(),
    );
  }

  /** Turns a target into a point on screen, or null for "the person". */
  resolve(target: Target | undefined): { x: number; y: number } | null {
    if (target == null || target === "user") return null;
    if (target === "cursor") return { x: this.world.cursor.x, y: this.world.cursor.y };
    if ("window" in target) {
      const w = this.world.window(target.window);
      return w ? { x: w.rect.x + w.rect.w / 2, y: w.rect.y + 20 } : null;
    }
    return target;
  }

  /** Gets him as close to a point as the terrain allows: onto the ledge under it. */
  *goNear(x: number, y: number): Routine {
    const a = this.actor;
    if (a.mode === "can") yield* moves.exitCan(a, { quick: true });
    const ledge = this.world.ledgeBelow(x, y - 30 * a.scale) ?? this.world.ledgeBelow(x, -1e9);
    if (!ledge) return;
    // Stand beside the thing, not on top of it.
    const side = a.x < x ? -1 : 1;
    yield* moves.travel(a, ledge.id, clamp(x + side * 60 * a.scale, ledge.x1 + 20, ledge.x2 - 20));
    a.dir = -side;
  }

  /** A place worth walking to: usually a ledge on the monitor the person is working on. */
  pickSpot(): { ledge: Ledge; x: number } | null {
    const w = this.world;
    const mon = w.monitorAt(w.cursor.x, w.cursor.y) ?? w.primary;
    if (!mon) return null;
    this.onScout?.(mon.id);
    const here = this.actor.ledgeId;
    const options = w.ledges.filter(
      (l) => l.x2 > mon.rect.x + 40 && l.x1 < mon.rect.x + mon.rect.w - 40 && l.y >= mon.rect.y && l.y <= mon.rect.y + mon.rect.h,
    );
    if (options.length === 0) return null;
    // Window tops are more fun than the floor, and somewhere new beats here.
    const weighted = options.flatMap((l) => {
      const weight = (l.hwnd != null ? 3 : 1) + (l.id !== here ? 1 : 0);
      return Array<Ledge>(weight).fill(l);
    });
    const ledge = pick(weighted);
    const x1 = Math.max(ledge.x1, mon.rect.x) + 30;
    const x2 = Math.min(ledge.x2, mon.rect.x + mon.rect.w) - 30;
    if (x2 <= x1) return null;
    return { ledge, x: rand(x1, x2) };
  }

  /** Out long enough, or sleepy enough, to make himself comfortable instead of sitting up straight. */
  get relaxed() {
    return this.loudFor <= 0 && (this.outFor > 30 || this.actor.mood === "sleepy");
  }

  private *inspectGround(): Routine {
    const a = this.actor;
    yield* wait(0.5);
    a.lookAt(a.x + a.dir * 40, a.y + 10, 1.2);
    yield* wait(1.1);
    a.look({ kind: "user" }, 1.2);
    yield* wait(0.8);
  }

  private *glareAfter(delay: number): Routine {
    const a = this.actor;
    yield* wait(delay);
    a.feel("glare", 3);
    a.look({ kind: "user" }, 3);
    yield* wait(2.4);
  }

  /** Called when he looks for somewhere to go on a monitor, so the app can learn what is inside its windows. */
  onScout?: (monitor: number) => void;

  update(dt: number) {
    const a = this.actor;
    this.loudFor = Math.max(0, this.loudFor - dt);
    if ((this.clockIn -= dt) <= 0) {
      this.clockIn = 30;
      const h = this.hour();
      const night = h >= 22 || h < 6;
      a.mood = night ? "sleepy" : "neutral";
      a.puppet.hat = night ? "nightcap" : null;
    }
    if (a.mode !== "can") this.outFor += dt;
    else this.outFor = 0;

    // Sliding down the glass past an edge: usually he grabs it.
    if (a.mode === "glass" && a.sliding && !a.busy && this.world.time > this.catchAfter) {
      const edge = moves.edgeToHang(a, 24, 0);
      if (edge) {
        this.catchAfter = this.world.time + 1;
        if (chance(0.7)) void a.run(moves.hangFrom(a, edge));
      }
    }

    if (!this.autonomous || this.attentive || a.busy || a.mode === "held" || a.mode === "air" || a.mode === "glass") return;
    if ((this.idleIn -= dt) > 0) return;

    const away = this.world.system.idleMs > 4 * 60_000;
    if (a.mode === "can") {
      this.idleIn = rand(7, 22);
      if (away) return;
      const roll = rand(0, 1);
      if (a.mood === "sleepy" && roll < 0.3) void this.perform("snore");
      else if (roll < 0.32) void this.perform("peek", { target: "cursor" });
      else if (roll < 0.44) void this.perform("lookOut");
      else if (roll < 0.51) void this.perform("rustle");
      else if (roll < 0.56) void this.perform("chew");
      else if (roll < 0.61) void this.perform("mutter");
      else if (roll < 0.65) void this.perform("rattle");
      else if (roll < 0.72) void this.perform("toss");
      else void this.perform("comeOut");
      return;
    }
    if (a.mode === "emerge") {
      // Left half out of the can by something that interrupted him.
      this.idleIn = rand(3, 8);
      void this.perform(away || chance(0.5) ? "goHome" : "comeOut");
      return;
    }

    this.idleIn = rand(3, 9);
    if (away || this.outFor > rand(70, 160)) {
      void this.perform("goHome");
      return;
    }
    const c = this.world.cursor;
    // A cursor darting about right next to him is too tempting.
    if (c.speed > 1400 && Math.abs(c.x - a.x) < 260 && Math.abs(c.y - a.y) < 200 && a.ledge) {
      void a.run(moves.jumpTo(a, clamp(c.x, a.ledge.x1 + 20, a.ledge.x2 - 20), a.ledge, { sure: true }));
      return;
    }
    const roll = rand(0, 1);
    if (roll < 0.36) void this.perform("wander");
    else if (roll < 0.54 && this.relaxed && chance(0.6)) void this.perform("lounge", { seconds: rand(12, 28) });
    else if (roll < 0.54) void this.perform("sit", { seconds: rand(6, 16) });
    else if (roll < 0.62) void this.perform("groom", { seconds: rand(6, 11) });
    else if (roll < 0.7 && a.mood === "sleepy") void this.perform("yawn");
    else if (roll < 0.8) void this.perform("glance", { target: "cursor", emotion: "curious" });
    else this.idleIn = rand(2, 5);
  }
}
