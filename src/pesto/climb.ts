import { chance, clamp, clamp01, easeIn, easeInOut, easeOut, lerp, rand, smooth, type Vec } from "./math";
import type { PartialPose } from "./pose";

/** Where a paw likes to be relative to his feet, in units, for the paw on his right. */
const HAND_HOME = { x: 48, y: -64 };
const FOOT_HOME = { x: 21, y: -4 };
/** How far a planted paw may drift from home before it lets go and reaches again. */
const HAND_SLACK = 27;
const FOOT_SLACK = 11;
/** How high above his feet a paw can take a hold. */
const HAND_STRETCH = 88;
const FOOT_STRETCH = 16;

/**
 * A paw on the glass. It is planted (fixed in the world while his body
 * moves), reaching for its next hold, or let go and carried along with him.
 */
class Paw {
  private from: Vec = { x: 0, y: 0 };
  private to: Vec = { x: 0, y: 0 };
  private t = 1;
  private seconds = 0;
  /** Offset from his feet while it is let go, in units. */
  private carried: Vec | null = null;

  constructor(
    readonly side: number,
    public x: number,
    public y: number,
  ) {}

  get reaching() {
    return this.t < 1;
  }

  get free() {
    return this.carried != null;
  }

  reach(x: number, y: number, seconds: number) {
    this.from = { x: this.x, y: this.y };
    this.to = { x, y };
    this.carried = null;
    this.t = 0;
    this.seconds = seconds;
  }

  /** Lets go of the glass and moves to `offset` from his feet, staying there as he moves. */
  letGo(offset: Vec, body: Vec, scale: number, seconds: number) {
    this.from = { x: (this.x - body.x) / scale, y: (this.y - body.y) / scale };
    this.carried = offset;
    this.t = 0;
    this.seconds = seconds;
  }

  /** Grips the glass where it is. */
  plant() {
    this.carried = null;
    this.t = 1;
  }

  step(dt: number, body: Vec, scale: number) {
    const moving = this.t < 1;
    if (moving) this.t = this.seconds > 0 ? Math.min(1, this.t + dt / this.seconds) : 1;
    const e = easeInOut(this.t);
    if (this.carried) {
      this.x = body.x + lerp(this.from.x, this.carried.x, e) * scale;
      this.y = body.y + lerp(this.from.y, this.carried.y, e) * scale;
    } else if (moving) {
      // Lifted a little toward him in the middle of the reach.
      const lift = Math.sin(this.t * Math.PI) * 3 * scale;
      this.x = lerp(this.from.x, this.to.x, e) - this.side * lift;
      this.y = lerp(this.from.y, this.to.y, e);
    }
  }
}

type Stride =
  | { kind: "pull"; from: Vec; to: Vec; t: number; seconds: number; last: boolean }
  | { kind: "leap"; from: Vec; to: Vec; t: number; crouch: number; flight: number; land: number; stage: 0 | 1 | 2 }
  | { kind: "rest"; from: Vec; t: number; seconds: number; slip: number; slipAt: number; stage: 0 | 1 | 2 };

/**
 * Climbing as he would actually do it: hand over hand in pulls of uneven
 * length and tempo, veering left and right of the straight line, with the
 * odd leap, breather and slip. Paws stay where they grip while his body
 * moves, and let go to reach again once they are left behind.
 */
export class Climb {
  /** What he is in the middle of, for his face. */
  doing: "pull" | "leap" | "rest" | "slip" = "pull";
  private hands: [Paw, Paw];
  private feet: [Paw, Paw];
  private stride: Stride | null = null;
  private lead = chance(0.5) ? 0 : 1;
  private veer = chance(0.5) ? 1 : -1;
  /** Pulls since he last leapt or rested. */
  private pulls = 0;
  private vx = 0;
  private vy = 0;
  private squash = 0;

  /** @param hands where his hands are now relative to his feet, in units, left then right. */
  constructor(
    public x: number,
    public y: number,
    private scale: number,
    hands: [Vec, Vec],
  ) {
    const s = scale;
    this.hands = [new Paw(-1, x + hands[0].x * s, y + hands[0].y * s), new Paw(1, x + hands[1].x * s, y + hands[1].y * s)];
    this.feet = [new Paw(-1, x - FOOT_HOME.x * s, y + FOOT_HOME.y * s), new Paw(1, x + FOOT_HOME.x * s, y + FOOT_HOME.y * s)];
  }

  /** Moves him on toward `target`, keeping between `minX` and `maxX`. True once he is there. */
  step(dt: number, target: Vec, minX: number, maxX: number): boolean {
    const s = this.scale;
    const px = this.x;
    const py = this.y;
    this.stride ??= this.plan(target, minX, maxX);
    const st = this.stride;
    let done = false;
    let arrived = false;

    if (st.kind === "pull") {
      st.t = Math.min(1, st.t + dt / st.seconds);
      // He sinks a touch as the hand goes up, then heaves.
      const heave = easeInOut(clamp01((st.t - 0.25) / 0.75));
      this.x = lerp(st.from.x, st.to.x, heave);
      this.y = lerp(st.from.y, st.to.y, heave) + Math.sin(clamp01(st.t / 0.3) * Math.PI) * 2.5 * s;
      this.squash = -0.07 * Math.sin(heave * Math.PI);
      this.doing = "pull";
      done = st.t >= 1;
      arrived = done && st.last;
    } else if (st.kind === "leap") {
      st.t += dt;
      const dip = 8 * s;
      this.doing = "leap";
      if (st.t < st.crouch) {
        const k = smooth(st.t / st.crouch);
        this.y = st.from.y + dip * k;
        this.squash = 0.24 * k;
      } else if (st.t < st.crouch + st.flight) {
        if (st.stage === 0) {
          st.stage = 1;
          const body = { x: this.x, y: this.y };
          for (const hand of this.hands) hand.letGo({ x: hand.side * 47, y: -82 }, body, s, 0.09);
          for (const foot of this.feet) foot.letGo({ x: foot.side * 15, y: 8 }, body, s, 0.12);
        }
        const v = (st.t - st.crouch) / st.flight;
        this.x = lerp(st.from.x, st.to.x, easeOut(v));
        this.y = lerp(st.from.y + dip, st.to.y, easeOut(v));
        this.squash = -0.24 * (1 - v * 0.6);
      } else {
        if (st.stage < 2) {
          st.stage = 2;
          for (const hand of this.hands) this.grab(hand, HAND_HOME, st.to, hand.side > 0 ? 0.06 : 0.09, HAND_STRETCH);
          for (const foot of this.feet) this.grab(foot, FOOT_HOME, st.to, foot.side > 0 ? 0.16 : 0.11, FOOT_STRETCH);
        }
        const w = clamp01((st.t - st.crouch - st.flight) / st.land);
        this.x = st.to.x;
        this.y = st.to.y + Math.sin(w * Math.PI) * 5 * s;
        this.squash = 0.2 * Math.sin(w * Math.PI);
        done = w >= 1;
      }
    } else {
      st.t += dt;
      this.squash = 0;
      this.doing = st.stage === 0 ? "rest" : "slip";
      let drop = 0;
      if (st.slip > 0 && st.stage === 0 && st.t >= st.slipAt) {
        st.stage = 1;
        const body = { x: this.x, y: this.y };
        for (const paw of [...this.hands, ...this.feet]) {
          paw.letGo({ x: (paw.x - body.x) / s, y: (paw.y - body.y) / s }, body, s, 0);
        }
      }
      if (st.stage > 0) {
        const k = clamp01((st.t - st.slipAt) / 0.2);
        drop = st.slip * easeIn(k);
        if (k >= 1 && st.stage === 1) {
          st.stage = 2;
          for (const paw of [...this.hands, ...this.feet]) paw.plant();
        }
      }
      // He hangs and sways until he goes on, or until his grip gives.
      const hang = st.stage === 0 ? Math.sin(clamp01(st.t / (st.slip > 0 ? st.slipAt : st.seconds)) * Math.PI) : 0;
      this.x = st.from.x;
      this.y = st.from.y + drop + Math.sin(st.t * 3.4) * 1.2 * s * hang;
      done = st.t >= st.seconds;
    }

    if (dt > 0) {
      this.vx = (this.x - px) / dt;
      this.vy = (this.y - py) / dt;
    }
    const body = { x: this.x, y: this.y };
    for (const paw of [...this.hands, ...this.feet]) paw.step(dt, body, s);
    this.keepUp(this.hands, HAND_HOME, HAND_SLACK, 14, 0.13);
    this.keepUp(this.feet, FOOT_HOME, FOOT_SLACK, 6, 0.1);
    if (done) this.stride = null;
    return arrived;
  }

  private plan(target: Vec, minX: number, maxX: number): Stride {
    const s = this.scale;
    const from = { x: this.x, y: this.y };
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 34 * s) {
      this.reachAhead(target, 0.2);
      return { kind: "pull", from, to: { ...target }, t: 0, seconds: 0.16 + d / (s * 260), last: true };
    }
    if (this.pulls >= 2 && chance(0.16)) {
      this.pulls = 0;
      const seconds = rand(0.45, 0.95);
      return { kind: "rest", from, t: 0, seconds, slip: chance(0.35) ? rand(9, 15) * s : 0, slipAt: seconds * 0.3, stage: 0 };
    }
    const leap = d > 150 * s && this.pulls >= 1 && chance(0.26);
    const length = leap ? Math.min(d - 30 * s, rand(95, 150) * s) : Math.min(d, rand(20, 62) * s);
    // He veers off the straight line, less and less as he closes in.
    if (chance(0.75)) this.veer = -this.veer;
    const angle = Math.atan2(dy, dx) + this.veer * rand(0.12, 0.5) * clamp01(d / (240 * s)) * (leap ? 0.5 : 1);
    const to = { x: clamp(this.x + Math.cos(angle) * length, minX, maxX), y: this.y + Math.sin(angle) * length };
    if (leap) {
      this.pulls = 0;
      return { kind: "leap", from, to, t: 0, crouch: rand(0.16, 0.24), flight: 0.14 + length / (s * 620), land: 0.2, stage: 0 };
    }
    this.pulls++;
    const seconds = 0.13 + length / (s * rand(210, 380));
    this.reachAhead(to, seconds);
    return { kind: "pull", from, to, t: 0, seconds, last: false };
  }

  /** Sends the leading hand and the opposite foot to holds for a pull that ends at `to`. */
  private reachAhead(to: Vec, seconds: number) {
    this.grab(this.hands[this.lead], { x: rand(44, 52), y: -rand(60, 78) }, to, seconds * 0.38, HAND_STRETCH);
    this.grab(this.feet[1 - this.lead], { x: rand(17, 24), y: -rand(2, 9) }, to, seconds * 0.45, FOOT_STRETCH);
    this.lead = 1 - this.lead;
  }

  /**
   * Reaches a paw to `home` (given for the right-hand side) relative to
   * `body`, no higher above where he is now than `stretch` units.
   */
  private grab(paw: Paw, home: Vec, body: Vec, seconds: number, stretch: number) {
    const s = this.scale;
    const x = clamp(body.x + paw.side * home.x * s, this.x - 54 * s, this.x + 54 * s);
    const y = Math.max(body.y + home.y * s, this.y - stretch * s);
    paw.reach(x, y, seconds);
  }

  /** Any paw his body has left too far behind lets go and reaches for a hold beside him, one of a pair at a time. */
  private keepUp(pair: [Paw, Paw], home: Vec, slack: number, lookAhead: number, seconds: number) {
    const s = this.scale;
    const speed = Math.hypot(this.vx, this.vy) || 1;
    let busy = pair.some((paw) => paw.reaching);
    for (const paw of pair) {
      if (paw.reaching || paw.free) continue;
      const off = Math.hypot((paw.x - this.x) / s - paw.side * home.x, (paw.y - this.y) / s - home.y);
      if (off <= slack || (busy && off <= slack * 1.6)) continue;
      const ahead = speed > 20 * s ? lookAhead * s : 0;
      paw.reach(
        this.x + (paw.side * home.x + rand(-3, 3)) * s + (this.vx / speed) * ahead,
        this.y + (home.y + rand(-4, 4)) * s + (this.vy / speed) * ahead,
        seconds,
      );
      busy = true;
    }
  }

  pose(): PartialPose {
    const s = this.scale;
    const at = (paw: Paw): Vec => ({ x: (paw.x - this.x) / s, y: (paw.y - this.y) / s });
    const [hl, hr] = this.hands.map(at);
    const [fl, fr] = this.feet.map(at);
    return {
      handLX: hl.x,
      handLY: hl.y,
      handRX: hr.x,
      handRY: hr.y,
      footLX: clamp(fl.x, -30, -10),
      footLY: clamp(fl.y, -16, 9),
      footRX: clamp(fr.x, 10, 30),
      footRY: clamp(fr.y, -16, 9),
      // He leans toward the higher hand and into the way he is going.
      lean: clamp((hl.y - hr.y) * 0.0035 + this.vx / (s * 2600), -0.2, 0.2),
      squash: this.squash,
      pitch: clamp(this.vy / (s * 900), -0.35, 0.3),
      tailLift: -0.5,
      tailCurl: 0.04,
      tailWag: 0.25,
      tailWagHz: 1.6,
    };
  }
}
