import { trace } from "../debug/trace";
import type { Ledge } from "../world/world";
import { RUN_SPEED, SPRINT, type Actor } from "./actor";
import { chance, clamp, easeInOut, easeOut, lerp, rand, sign, smooth, type Vec } from "./math";
import { EDGE, arc, climbTo, exitCan, walkTo } from "./moves";
import { Interrupted, tween, until, wait, type Routine } from "./routine";

/**
 * Getting somewhere in a hurry. Where `travel` ambles, this works out a route
 * over the ledges and the bare glass between them and strings quick moves
 * along it: sprints, running leaps, an edge caught by the hands and hauled
 * over, bounds from hold to hold up the glass and short scrambles. It comes
 * out differently each time.
 */

/** Where a dash ends: standing at `x` on a ledge, or clinging to the glass at a point. */
export type Goal = { ledge: string; x: number } | { x: number; y: number };

/** How high one spring takes his feet, off a ledge and off a hold on the glass, in units. */
const SPRING_UP = 240;
const KICK_UP = 185;
/** How far across one spring carries him on the level; a drop carries him further. */
const SPRING_ACROSS = 430;
/** How far below an edge his feet are once his hands have caught it. */
const LIP = 84;
/** A landing place no ledge has, so that he passes them all on the way to a hold on the glass. */
const GLASS = "~glass~";

type Spring = { kind: "spring"; to: Vec; land: Ledge | null; lip: boolean };
type Leg = { kind: "run"; x: number } | Spring | { kind: "scramble"; to: Vec };

/** Somewhere a route can pass through: a ledge, or a point on the glass. */
interface Stop {
  ledge: Ledge | null;
  x: number;
  y: number;
}

interface Hop {
  legs: Leg[];
  seconds: number;
  /** Where on the far ledge he comes down. */
  x: number;
}

/**
 * The moves that take him from one stop straight to another, however far
 * apart: a run to where he takes off, then as many springs as the height and
 * the distance need, by way of holds on the glass that zigzag between the two.
 * `aim` is the x he is ultimately heading for.
 */
function hop(a: Actor, from: Stop, to: Stop, aim: number): Hop | null {
  const s = a.scale;
  const F = from.ledge;
  const T = to.ledge;
  const rise = (from.y - to.y) / s;
  // A running leap covers ground: he takes off this far short of where he comes down.
  const lead = clamp(Math.abs(rise) * 0.55, 60, 210) * s;
  const short = 40 * s;
  let take = from.x;
  let land = to.x;
  if (F && T) {
    const lo = Math.max(F.x1, T.x1) + EDGE;
    const hi = Math.min(F.x2, T.x2) - EDGE;
    if (lo >= hi) {
      // Side by side: across the gap between their near ends.
      const right = T.x1 >= F.x2 - EDGE;
      take = right ? F.x2 - EDGE : F.x1 + EDGE;
      land = right ? T.x1 + EDGE : T.x2 - EDGE;
    } else {
      land = clamp(aim, lo, hi);
    }
  } else if (T) {
    land = clamp(from.x + clamp(aim - from.x, -220 * s, 220 * s), T.x1 + EDGE, T.x2 - EDGE);
  }
  if (F && (!T || Math.max(F.x1, T.x1) + EDGE < Math.min(F.x2, T.x2) - EDGE)) {
    const d = sign(land - from.x);
    take = land - d * lead;
    // Already past the best place to take off from: he goes from where he is, or backs up just enough to leap at it.
    if ((from.x - take) * d > 0) take = (land - from.x) * d < short && !T ? land - d * short : from.x;
    take = clamp(take, F.x1 + EDGE, F.x2 - EDGE);
    // Straight up or down still needs some sideways travel to read as a leap.
    if (T && Math.abs(land - take) < short) land = clamp(take + sign(aim - take) * 50 * s, T.x1 + EDGE, T.x2 - EDGE);
  }

  const across = Math.abs(land - take) / s;
  const first = F ? SPRING_UP : KICK_UP;
  const power = (n: number) => first + (n - 1) * KICK_UP;
  const reach = (n: number) => n * SPRING_ACROSS + clamp(-rise * 0.8, 0, 470);
  let n = 1;
  while (rise > power(n) + (T ? LIP : 0) || across > reach(n)) if (++n > 40) return null;
  // Too high to land on with his feet, he catches the edge with his hands. Now and then he does that anyway.
  const stretch = rise > power(n);
  const lip = stretch || (!!T && (KICK_UP * (rise - LIP)) / power(n) > 40 && chance(0.2));
  const up = (rise - (lip ? LIP : 0)) * s;

  const legs: Leg[] = [];
  if (Math.abs(take - from.x) > 2) legs.push({ kind: "run", x: take });
  let seconds = Math.abs(take - from.x) / (RUN_SPEED * SPRINT * s);
  const v = a.world.virtual;
  const zig = chance(0.5) ? 1 : -1;
  let at: Vec = { x: take, y: from.y };
  let clinging = !F;
  for (let k = 1; k <= n; k++) {
    const last = k === n;
    let next: Vec = { x: land, y: to.y };
    if (!last) {
      // Each spring takes its share of the height, and the holds swing from side to side of the straight line.
      const share = up > 0 ? power(k) / power(n) : k / n;
      const swing = (k % 2 ? zig : -zig) * rand(35, 85) * s * (across / n > 150 ? 0.4 : 1);
      next = { x: clamp(lerp(take, land, k / n) + swing, v.x + 45 * s, v.x + v.w - 45 * s), y: from.y - up * share };
    }
    const length = Math.hypot(next.x - at.x, next.y - at.y) / s;
    const toGlass = !last || !T;
    if (clinging && toGlass && length < 200 && chance(0.3)) legs.push({ kind: "scramble", to: next });
    else legs.push({ kind: "spring", to: next, land: last ? T : null, lip: last && lip });
    seconds += 0.5 + length / 1500 + (toGlass ? 0.1 : 0);
    at = next;
    clinging = toGlass;
  }
  if (stretch) seconds += 0.35;
  return { legs, seconds, x: land };
}

/**
 * The quickest way from where he is to the goal, as the moves to make: a
 * shortest-path search over every ledge, with `hop` as the way from any one
 * to any other. `taste` holds how much he fancies each stop this time, which
 * is what makes one dash differ from the next; it has to be kept for the whole
 * dash so that he does not change his mind halfway.
 */
function route(a: Actor, goal: Goal, taste: Map<string, number>): Leg[] | null {
  interface Node extends Stop {
    id: string;
    cost: number;
    legs: Leg[];
    via: Node | null;
    settled: boolean;
  }
  const node = (id: string, ledge: Ledge | null, x: number, y: number): Node => ({ id, ledge, x, y, cost: Infinity, legs: [], via: null, settled: false });
  const nodes = a.world.ledges.map((l) => node(l.id, l, 0, l.y));
  let start = a.mode === "ground" ? nodes.find((n) => n.id === a.ledgeId) : undefined;
  if (start) start.x = a.x;
  else nodes.push((start = node("~here~", null, a.x, a.y)));
  start.cost = 0;
  let end = "ledge" in goal ? nodes.find((n) => n.id === goal.ledge) : undefined;
  if (!("ledge" in goal)) nodes.push((end = node(GLASS, null, goal.x, goal.y)));
  if (!end) return null;

  const pace = RUN_SPEED * SPRINT * a.scale;
  for (;;) {
    let at: Node | null = null;
    for (const n of nodes) if (!n.settled && n.cost < (at?.cost ?? Infinity)) at = n;
    if (!at) return null;
    if (at === end) break;
    at.settled = true;
    for (const next of nodes) {
      if (next.settled) continue;
      const h = hop(a, at, next, goal.x);
      if (!h) continue;
      let fancy = taste.get(next.id);
      if (fancy == null) taste.set(next.id, (fancy = rand(0.8, 1.3)));
      // On the last ledge there is still the run to the spot itself.
      const cost = at.cost + h.seconds * fancy + (next === end && next.ledge ? Math.abs(goal.x - h.x) / pace : 0);
      if (cost >= next.cost) continue;
      next.cost = cost;
      next.x = h.x;
      next.legs = h.legs;
      next.via = at;
    }
  }
  const legs: Leg[] = [];
  for (let n: Node | null = end; n; n = n.via) legs.unshift(...n.legs);
  if (end.ledge && Math.abs(goal.x - end.x) > 2) legs.push({ kind: "run", x: goal.x });
  return legs;
}

/** A leg in a few words, for the debug trace. */
function brief(leg: Leg): string {
  if (leg.kind === "run") return `run to ${Math.round(leg.x)}`;
  const to = `${Math.round(leg.to.x)},${Math.round(leg.to.y)}`;
  if (leg.kind === "scramble") return `scramble to ${to}`;
  return `spring to ${to}${leg.lip ? " by the edge" : leg.land ? "" : " on the glass"}`;
}

/** Whether the next move of a route can still be made from where he is: nothing it counts on has shifted. */
function holds(a: Actor, leg: Leg): boolean {
  if (leg.kind === "run") {
    const ledge = a.ledge;
    return a.mode === "ground" && !!ledge && leg.x >= ledge.x1 && leg.x <= ledge.x2;
  }
  if (leg.kind === "scramble") return a.mode === "glass";
  if (!leg.land) return true;
  const now = a.world.ledge(leg.land.id);
  return !!now && Math.abs(now.y - leg.land.y) < 4 && leg.to.x >= now.x1 + 6 && leg.to.x <= now.x2 - 6;
}

/** Whether a move ended where it was meant to. */
function made(a: Actor, leg: Leg): boolean {
  if (leg.kind === "run") return a.mode === "ground" && Math.abs(a.x - leg.x) < 3;
  if (leg.kind === "spring" && leg.land) return a.mode === "ground" && a.ledgeId === leg.land.id;
  return a.mode === "glass" && Math.hypot(a.x - leg.to.x, a.y - leg.to.y) < 4 * a.scale;
}

/**
 * Gets him to the goal as fast as he can go, from wherever he is. He keeps to
 * his route for as long as it holds, and works out a new one from wherever he
 * has ended up when a window shifts or a move goes wrong.
 */
export function* dash(a: Actor, goal: Goal): Routine {
  const s = a.scale;
  const taste = new Map<string, number>();
  const began = a.world.time;
  const bumps = a.knocks;
  let plan: Leg[] = [];
  let ran = false;
  // Moves made on the glass since he last had his feet down or got his breath back.
  let burst = 0;
  let windedAt = Math.round(rand(4, 6));
  let there = false;
  try {
    for (let moves = 0; moves < 80 && !there; moves++) {
      if (a.mode === "can" || a.mode === "emerge") yield* exitCan(a, { quick: true });
      if (a.mode === "air") {
        yield* until(() => a.mode !== "air", 6);
        continue;
      }
      a.need("ground", "glass");
      a.hurried = true;
      a.sitting = false;
      if (a.mode === "glass") {
        a.stick(2.5);
        a.gripLocked = true;
      } else burst = 0;

      if (!plan.length || !holds(a, plan[0])) {
        let target = goal;
        if ("ledge" in goal) {
          const ledge = a.world.ledge(goal.ledge);
          if (!ledge) throw new Interrupted("ledge is gone");
          target = { ledge: goal.ledge, x: clamp(goal.x, ledge.x1 + EDGE, ledge.x2 - EDGE) };
        }
        const found = route(a, target, taste);
        if (!found) throw new Interrupted("no route");
        there = "ledge" in goal ? !found.length : a.mode === "glass" && Math.hypot(goal.x - a.x, goal.y - a.y) < 3 * s;
        if (there) break;
        plan = found;
        if (trace.on) trace.log("dash", plan.map(brief).join(", "));
      }
      const leg = plan.shift()!;

      if (burst >= windedAt) {
        burst = 0;
        windedAt = Math.round(rand(4, 6));
        a.strain("winded", 0.7);
        yield* wait(rand(0.25, 0.45));
      }
      const knocks = a.knocks;
      try {
        if (leg.kind === "run") yield* sprint(a, leg.x);
        else if (leg.kind === "spring") yield* spring(a, leg, ran);
        else {
          if (chance(0.6)) a.cue("scrabble");
          yield* climbTo(a, leg.to.x, leg.to.y);
        }
      } catch (err) {
        // Knocked back by the cursor, he works out a new way from wherever he ends up, until he has had enough of it.
        if (!(err instanceof Interrupted) || a.knocks === knocks || a.knocks - bumps > 6) throw err;
      }
      ran = leg.kind === "run";
      if (a.mode === "glass") burst++;
      if (!made(a, leg)) plan = [];
    }
    if (!there) throw new Interrupted("route too long");
    if (a.world.time - began > 4) a.strain("winded", 0.5);
  } finally {
    a.hurried = false;
  }
}

/** Runs flat out along the ledge he is on. A long stretch he takes in bounds, with a few strides between them. */
function* sprint(a: Actor, x: number): Routine {
  const s = a.scale;
  const dir = sign(x - a.x);
  for (;;) {
    const ledge = a.ledge;
    const left = Math.abs(x - a.x) / s;
    if (!ledge || left < 520) break;
    yield* walkTo(a, a.x + dir * rand(80, 200) * s, true);
    const to = { x: a.x + dir * rand(300, SPRING_ACROSS) * s, y: ledge.y };
    yield* spring(a, { kind: "spring", to, land: ledge, lip: false }, true);
    if (a.mode === "air") yield* until(() => a.mode !== "air", 6);
    if (a.ledgeId !== ledge.id) return;
  }
  yield* walkTo(a, x, true);
}

/**
 * One spring, off a ledge or off the glass: a quick coil, shorter still when
 * he is `running` into it, then through the air to a ledge, to a hold on the
 * glass, or to an edge he catches with his hands and hauls himself over.
 */
function* spring(a: Actor, leg: Spring, running = false): Routine {
  const s = a.scale;
  const grounded = a.mode === "ground";
  const { land } = leg;
  const hold = !land || leg.lip;
  const to = land && leg.lip ? { x: leg.to.x, y: land.y + LIP * s } : leg.to;
  const dir = sign(to.x - a.x);
  const rise = (a.y - to.y) / s;
  const across = Math.abs(to.x - a.x) / s;
  a.dir = dir;
  a.lookAt(leg.to.x, leg.to.y - 40 * s, 0.7);

  try {
    let coil = 0;
    a.gesture = (p) => {
      p.squash += 0.24 * coil;
      p.brow -= 0.3 * coil;
      if (grounded) {
        p.facing = lerp(p.facing, dir * 0.55, coil);
        p.lean += dir * 0.1 * coil;
        p.handLY += 8 * coil;
        p.handRY += 8 * coil;
        p.tailLift = lerp(p.tailLift, 0.55, coil);
      } else {
        p.footLY -= 7 * coil;
        p.footRY -= 7 * coil;
      }
    };
    yield* tween(running ? rand(0.04, 0.06) : grounded ? rand(0.07, 0.12) : rand(0.06, 0.1), (u) => (coil = smooth(u)));
    a.need(grounded ? "ground" : "glass");
    if (!grounded || rise > 150 || across > 330) a.strain("breath", grounded ? 0.3 : 0.15);

    // Up to a hold he arrives at the top of his flight; anywhere else he comes down onto it.
    const v = arc(a, to.x, to.y, hold && rise > 20 ? 0 : clamp(across * 0.13, 34, 100));
    a.gripLocked = false;
    a.launch(v.vx, v.vy, land && !hold ? land.id : GLASS);
    a.gesture = (p) => {
      if (a.mode !== "air") return;
      p.mouthOpen = Math.max(p.mouthOpen, 0.35);
      p.browRaise += 0.35;
      if (a.vy <= 0) return;
      // He means to come down here: paws out ahead of him for the landing, no flailing.
      const d = a.dir;
      p.handLX = -26 + d * 14;
      p.handLY = -60;
      p.handRX = 26 + d * 14;
      p.handRY = -60;
      p.footLX = -13 + d * 9;
      p.footRX = 13 + d * 9;
      p.lean += d * 0.1;
      p.earL = 0;
      p.earR = 0;
    };
    if (!hold) {
      yield* until(() => a.mode !== "air", 6);
      return;
    }

    yield* until(() => a.mode !== "air" || (a.vy >= 0 && a.y >= to.y - 6 * s), 4);
    if (a.mode !== "air") return;
    const from = { x: a.x, y: a.y };
    // Blown off course, he holds on wherever he has got to.
    const grip = Math.hypot(to.x - from.x, to.y - from.y) < 50 * s ? to : from;
    a.stick(2.5);
    a.gripLocked = true;
    a.cue("slap");
    let give = 1;
    const settle = tween(0.09, (u) => {
      a.x = lerp(from.x, grip.x, easeOut(u));
      a.y = lerp(from.y, grip.y, easeOut(u));
      give = 1 - u;
    });
    if (!land || grip !== to) {
      a.gesture = (p) => (p.squash += 0.2 * give);
      yield* settle;
      return;
    }

    // Hands on the edge, feet kicking under it: a beat of hanging, then up and over.
    let t = 0;
    a.gesture = (p, dt) => {
      t += dt;
      p.handLX = -17;
      p.handLY = -88;
      p.handRX = 17;
      p.handRY = -88;
      p.footLX = -10 + Math.sin(t * 18) * 6;
      p.footRX = 10 - Math.sin(t * 18) * 6;
      p.footLY = 5;
      p.footRY = 5;
      p.squash = -0.1;
    };
    yield* settle;
    yield* wait(rand(0.05, 0.16));
    const edge = a.world.ledge(land.id);
    if (!edge || Math.abs(edge.y + LIP * s - a.y) > 10 * s || a.x < edge.x1 || a.x > edge.x2) {
      // The edge has gone from under his hands.
      a.gripLocked = false;
      a.launch(0, 0);
      return;
    }
    a.feel("strained", 0.5);
    a.strain("heave", 0.5);
    const hang = a.y;
    yield* tween(0.24, (u) => (a.y = lerp(hang, edge.y, easeInOut(u))));
    a.place(edge, a.x);
  } finally {
    a.gesture = null;
    // Stopped in mid-flight, he lands on whatever is under him.
    if (a.mode === "air" && a.landOn === GLASS) a.landOn = null;
  }
}
