import type { Can } from "../can/can";
import { CAN } from "../can/can";
import type { Rect } from "../sense/types";
import type { Ledge, World } from "../world/world";
import { Climb } from "./climb";
import { Spring, approach, chance, clamp, clamp01, noise, rand, sign, type Vec } from "./math";
import { EMOTIONS, REST, applyPose, clonePose, type Emotion, type Pose } from "./pose";
import { Puppet } from "./puppet";
import { Interrupted, type Routine } from "./routine";

/**
 * can     hidden inside the trash can
 * emerge  half out of the can, clipped at its rim
 * ground  on a ledge: standing, walking or sitting
 * air     jumping, falling or thrown
 * glass   on the screen itself: climbing, clinging or sliding down
 * held    dangling from the cursor by the scruff
 */
export type Mode = "can" | "emerge" | "ground" | "air" | "glass" | "held";

export type Attention =
  /** Whatever is most interesting: the cursor while it moves, otherwise he looks around. */
  | { kind: "auto" }
  | { kind: "cursor" }
  /** Straight out of the screen, at the person. */
  | { kind: "user" }
  | { kind: "point"; x: number; y: number };

export interface ActorEvents {
  grabbed: void;
  /** Let go gently. `onLedge` is false when he was left on bare glass. */
  dropped: { onLedge: boolean };
  thrown: void;
  /** Landed after a fall or a throw. `hard` when it was a long way down. */
  landed: { hard: boolean };
  petted: void;
  poked: void;
  shaken: void;
  /** The ledge under him vanished. */
  lostFooting: void;
  /** Slid all the way down the glass. */
  slid: void;
  /** A moment that should make a sound: "knock", "clank", "lid", "clap", "thud", "swat". */
  cue: string;
}

export const GRAVITY = 2300;
const WALK_SPEED = 100;
const RUN_SPEED = 400;
const SLIDE_SPEED = 330;
/** Height of the scruff above his feet, in units. */
const SCRUFF = 100;

/**
 * Pesto's body: where he is, what he physically can do from there, and the
 * pose that follows from it. It knows nothing about why he does things; the
 * director drives it through routines.
 */
export class Actor {
  puppet = new Puppet();
  /** Feet position in world pixels. */
  x = 0;
  y = 0;
  /** Pixels per character unit. */
  scale = 0.8;
  mode: Mode = "can";
  vx = 0;
  vy = 0;
  /** Last horizontal heading, -1 or 1. */
  dir = -1;

  ledgeId: string | null = null;
  walkTarget: number | null = null;
  running = false;
  sitting = false;

  /** Ledge a jump is aimed at; others are passed through. Null lands on anything. */
  landOn: string | null = null;
  /** Radians per second while tumbling through the air. */
  tumble = 0;

  climbTarget: Vec | null = null;
  /** Seconds of grip left while clinging. */
  grip = 0;
  /** Keeps him on the glass regardless of grip, while a routine needs him there. */
  gripLocked = false;
  sliding = false;

  mood: Emotion = "neutral";
  attention: Attention = { kind: "auto" };
  /** Transient pose changes layered on by the running routine. */
  gesture: ((pose: Pose, dt: number) => void) | null = null;
  /** World y below which he is hidden, while he is partly inside the can. */
  clipY: number | null = null;
  dizzy = 0;
  /** True while he is saying something; `speech` is how open his mouth is, 0..1. */
  talking = false;
  speech = 0;

  private emotion: Emotion | null = null;
  private emotionLeft = 0;
  private attentionLeft = 0;
  private routine: Routine | null = null;
  private routineDone: ((finished: boolean) => void) | null = null;
  private listeners = new Map<string, Set<(payload: any) => void>>();

  private rideHwnd: number | null = null;
  private rideOffset = 0;
  /** How far below the top of the window he rides on he stands: 0 on its top edge, more on a shelf inside it. */
  private rideDrop = 0;
  private rideVx = 0;
  private walkPhase = 0;
  private climb: Climb | null = null;
  private airTime = 0;
  private fallFrom = 0;
  private landKick = 0;
  private hangBeat = 0;
  private swing = new Spring(0, 9, 0.28);
  private press: { x: number; y: number; t: number } | null = null;
  private petMeter = 0;
  private petting = 0;
  private shakeFlips = 0;
  private shakeDir = 0;
  private shakeWindow = 0;
  private wander: Vec | null = null;
  private wanderLeft = 0;
  private gaze = { x: 0, y: 0 };
  /** Where the head is turned, trailing the eyes. */
  private headAim = { x: 0, y: 0 };
  private gazeGoal = { x: 0, y: 0 };
  private dart = { x: 0, y: 0 };
  private dartIn = 0;
  private prevX = 0;
  private prevY = 0;
  private base: Pose = clonePose(REST);

  constructor(
    readonly world: World,
    readonly can: Can,
  ) {
    world.on("mouseDown", (e) => this.onMouseDown(e));
    world.on("mouseUp", () => this.onMouseUp());
  }

  on<K extends keyof ActorEvents>(name: K, fn: (payload: ActorEvents[K]) => void) {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
  }

  private emit<K extends keyof ActorEvents>(name: K, payload: ActorEvents[K]) {
    this.listeners.get(name)?.forEach((fn) => fn(payload));
  }

  /** Marks a moment that should be heard. */
  cue(name: string) {
    this.emit("cue", name);
  }

  // ───────────────────────── routines ─────────────────────────

  /** Whether a routine is currently driving him. */
  get busy() {
    return this.routine !== null;
  }

  /**
   * Starts a routine, dropping whatever was running. The promise resolves
   * true when it runs to the end, false when it was interrupted.
   */
  run(routine: Routine): Promise<boolean> {
    this.stop();
    this.routine = routine;
    return new Promise((resolve) => (this.routineDone = resolve));
  }

  /** Drops the running routine. His body stays wherever it was and physics takes over. */
  stop() {
    if (!this.routine) return;
    this.routine.return?.();
    this.endRoutine(false);
  }

  private endRoutine(finished: boolean) {
    const done = this.routineDone;
    this.routine = null;
    this.routineDone = null;
    this.gesture = null;
    this.gripLocked = false;
    this.walkTarget = null;
    this.climbTarget = null;
    done?.(finished);
  }

  /** For routines: bail out unless he is still in the mode the routine needs. */
  need(...modes: Mode[]) {
    if (!modes.includes(this.mode)) throw new Interrupted(`needs ${modes.join("/")}, is ${this.mode}`);
  }

  // ───────────────────────── expression ─────────────────────────

  /** Shows an emotion for `seconds`, then falls back to his mood. */
  feel(emotion: Emotion, seconds = 2.5) {
    this.emotion = emotion;
    this.emotionLeft = seconds;
  }

  get feeling(): Emotion {
    return this.emotion ?? this.mood;
  }

  /** Directs his eyes for `seconds`, then back to looking around on his own. */
  look(attention: Attention, seconds = 3) {
    this.attention = attention;
    this.attentionLeft = seconds;
  }

  lookAt(x: number, y: number, seconds = 3) {
    this.look({ kind: "point", x, y }, seconds);
  }

  // ───────────────────────── geometry ─────────────────────────

  get ledge(): Ledge | null {
    return this.world.ledge(this.ledgeId);
  }

  /** Centre of his head in world pixels. */
  get head(): Vec {
    return { x: this.x, y: this.y - 98 * this.scale };
  }

  /** A puppet-space point in world pixels. */
  toWorld(p: Vec): Vec {
    return { x: this.x + p.x * this.scale, y: this.y + p.y * this.scale };
  }

  get visible() {
    return this.mode !== "can";
  }

  /** Where clicks should land on him instead of the app underneath. */
  get hitRect(): Rect | null {
    if (!this.visible) return null;
    const s = this.scale;
    return { x: this.x - 50 * s, y: this.y - 156 * s, w: 100 * s, h: 164 * s };
  }

  private over(px: number, py: number) {
    if (!this.visible || this.mode === "emerge") return false;
    const s = this.scale;
    const dx = (px - this.x) / (46 * s);
    const dy = (py - (this.y - 72 * s)) / (84 * s);
    return dx * dx + dy * dy < 1;
  }

  /** Puts him on a ledge, standing. */
  place(ledge: Ledge, x: number) {
    this.mode = "ground";
    this.ledgeId = ledge.id;
    this.x = clamp(x, ledge.x1 + 14, ledge.x2 - 14);
    this.y = ledge.y;
    this.vx = this.vy = 0;
    this.sliding = false;
    this.clipY = null;
    this.rideHwnd = ledge.hwnd;
    const w = this.world.window(ledge.hwnd);
    this.rideOffset = w ? this.x - w.rect.x : 0;
    this.rideDrop = w ? this.y - w.rect.y : 0;
  }

  /** Launches him into the air with a velocity in pixels per second. */
  launch(vx: number, vy: number, landOn: string | null = null) {
    this.mode = "air";
    this.vx = vx;
    this.vy = vy;
    this.landOn = landOn;
    this.ledgeId = null;
    this.sitting = false;
    this.airTime = 0;
    this.fallFrom = this.y;
    if (Math.abs(vx) > 20) this.dir = sign(vx);
  }

  /** Sticks him to the glass where he is. */
  stick(grip: number) {
    this.mode = "glass";
    this.vx = this.vy = 0;
    this.grip = grip;
    this.sliding = false;
    this.ledgeId = null;
    this.sitting = false;
    this.tumble = 0;
  }

  /** Hides him inside the can. */
  vanish() {
    this.mode = "can";
    this.x = this.can.x;
    this.y = this.can.y;
    this.vx = this.vy = 0;
    this.ledgeId = null;
    this.clipY = null;
    this.sitting = false;
    this.tumble = 0;
    this.puppet.target.spin = 0;
  }

  // ───────────────────────── cursor interaction ─────────────────────────

  private onMouseDown(e: { x: number; y: number; buttons: number }) {
    if (!(e.buttons & 1) || !this.over(e.x, e.y)) return;
    this.press = { x: e.x, y: e.y, t: this.world.time };
  }

  private onMouseUp() {
    const press = this.press;
    this.press = null;
    if (this.mode === "held") {
      this.release();
      return;
    }
    if (press && this.world.time - press.t < 0.4) {
      this.stop();
      this.emit("poked", undefined);
    }
  }

  private grab() {
    this.stop();
    this.mode = "held";
    this.ledgeId = null;
    this.sitting = false;
    this.clipY = null;
    this.tumble = 0;
    this.swing.snap(0);
    this.shakeFlips = 0;
    this.emit("grabbed", undefined);
  }

  private release() {
    const c = this.world.cursor;
    this.puppet.target.spin = 0;
    if (c.speed > 950) {
      const k = Math.min(1, 2400 / c.speed);
      this.launch(c.vx * k, c.vy * k);
      this.tumble = clamp(c.vx / 110, -16, 16);
      this.emit("thrown", undefined);
      return;
    }
    const below = this.world.ledgeBelow(this.x, this.y - 6);
    if (below && below.y - this.y < 52) {
      this.place(below, this.x);
      this.landKick = 0.5;
      this.emit("dropped", { onLedge: true });
    } else {
      this.stick(rand(1.6, 2.6));
      this.emit("dropped", { onLedge: false });
    }
  }

  private interact(dt: number) {
    const c = this.world.cursor;
    if (this.press && this.mode !== "held" && Math.hypot(c.x - this.press.x, c.y - this.press.y) > 8) this.grab();

    // Petting: strokes across him with no button held.
    const hovering = c.buttons === 0 && this.over(c.x, c.y) && this.mode !== "held" && this.mode !== "air";
    if (hovering && c.speed > 60 && c.speed < 2200) this.petMeter += c.speed * dt;
    else this.petMeter = Math.max(0, this.petMeter - 260 * dt);
    this.petMeter = Math.min(this.petMeter, 420);
    if (this.petMeter > 190 && hovering) {
      if (this.petting <= 0) this.emit("petted", undefined);
      this.petting = 0.7;
    } else {
      this.petting = Math.max(0, this.petting - dt);
    }

    if (this.mode === "held") {
      this.shakeWindow -= dt;
      if (this.shakeWindow <= 0) this.shakeFlips = 0;
      const d = Math.abs(c.vx) > 900 ? sign(c.vx) : 0;
      if (d !== 0 && d !== this.shakeDir) {
        this.shakeDir = d;
        this.shakeFlips++;
        this.shakeWindow = 0.9;
        if (this.shakeFlips >= 5) {
          this.shakeFlips = 0;
          this.dizzy = 5;
          this.emit("shaken", undefined);
        }
      }
    }
  }

  // ───────────────────────── frame update ─────────────────────────

  update(dt: number) {
    this.prevX = this.x;
    this.prevY = this.y;

    this.interact(dt);

    if (this.routine) {
      try {
        if (this.routine.next(dt).done) this.endRoutine(true);
      } catch (err) {
        if (!(err instanceof Interrupted)) console.error("routine failed", err);
        this.endRoutine(false);
      }
    }

    if (this.emotionLeft > 0 && (this.emotionLeft -= dt) <= 0) this.emotion = null;
    if (this.attentionLeft > 0 && (this.attentionLeft -= dt) <= 0) this.attention = { kind: "auto" };
    this.dizzy = Math.max(0, this.dizzy - dt);
    this.landKick = Math.max(0, this.landKick - dt * 3.2);

    const pose = applyPose(this.base, REST);
    this.puppet.planted = false;
    if (this.mode !== "glass" || !this.climbTarget) this.climb = null;
    switch (this.mode) {
      case "ground":
        this.updateGround(dt, pose);
        break;
      case "air":
        this.updateAir(dt, pose);
        break;
      case "glass":
        this.updateGlass(dt, pose);
        break;
      case "held":
        this.updateHeld(dt, pose);
        break;
      case "emerge":
        applyPose(pose, { handLX: -30, handLY: -52, handRX: 30, handRY: -52, earL: -0.1, earR: -0.1 });
        break;
      case "can":
        this.x = this.can.x;
        this.y = this.can.y;
        break;
    }

    this.express(pose);
    this.aimGaze(dt, pose);
    if (this.talking) this.talk(pose);
    this.gesture?.(pose, dt);
    if (this.landKick > 0) pose.squash += this.landKick * 0.34;

    Object.assign(this.puppet.target, pose);
    this.puppet.grounded = this.mode === "ground" && !this.sitting;
    this.puppet.eyesOnly = false;
    this.puppet.update(dt, { x: (this.x - this.prevX) / this.scale, y: (this.y - this.prevY) / this.scale });
  }

  private express(pose: Pose) {
    let feeling = this.feeling;
    if (this.petting > 0) feeling = "pleased";
    else if (this.dizzy > 0 && this.mode !== "held") feeling = "dizzy";
    addEmotion(pose, feeling);
    if (this.dizzy > 0) {
      const t = this.puppet.time;
      pose.tilt += Math.sin(t * 5) * 0.16 * Math.min(1, this.dizzy);
      pose.gazeX = Math.cos(t * 9);
      pose.gazeY = Math.sin(t * 9);
      pose.lean += Math.sin(t * 2.4) * 0.08 * Math.min(1, this.dizzy);
    }
  }

  /** Mouth follows the voice; free hands gesture along with it. */
  private talk(pose: Pose) {
    const t = this.puppet.time;
    pose.mouthOpen = Math.max(pose.mouthOpen, this.speech * 0.9);
    pose.headY -= this.speech * 1.2;
    pose.browRaise += this.speech * 0.15;
    if (this.mode === "ground" && this.walkTarget == null && !this.sitting) {
      pose.handLX += noise(t * 1.4, 11) * 6 - 2;
      pose.handLY -= 12 + noise(t * 1.9, 12) * 8;
      pose.handRX += noise(t * 1.5, 13) * 6 + 2;
      pose.handRY -= 12 + noise(t * 1.7, 14) * 8;
    }
  }

  private aimGaze(dt: number, pose: Pose) {
    if (this.dizzy > 0) return;
    const c = this.world.cursor;
    const head = this.head;
    let target: Vec | null;
    let a = this.attention;

    if (a.kind === "auto") {
      // Follow the cursor while it is doing something; once it rests, let
      // his eyes drift to other things and back to the person.
      const idle = this.world.time - c.lastMove;
      if (idle < 2.2) a = { kind: "cursor" };
      else {
        this.wanderLeft -= dt;
        if (this.wanderLeft <= 0) {
          this.wanderLeft = rand(1.2, 4);
          this.wander = chance(0.35)
            ? null
            : { x: head.x + rand(-420, 420), y: head.y + rand(-260, 120) };
        }
        a = this.wander ? { kind: "point", x: this.wander.x, y: this.wander.y } : { kind: "user" };
      }
    }
    if (a.kind === "cursor") target = { x: c.x, y: c.y };
    else if (a.kind === "point") target = { x: a.x, y: a.y };
    else target = null;

    let gx = 0;
    let gy = 0;
    if (target) {
      const dx = target.x - head.x;
      const dy = target.y - head.y;
      const d = Math.hypot(dx, dy);
      // Close things pull the eyes hard; far things saturate.
      const k = d < 1 ? 0 : Math.min(1, d / 170) / d;
      gx = dx * k;
      gy = dy * k;
    }
    // A big change of subject comes with a blink, as it does for anyone.
    if (Math.hypot(gx - this.gazeGoal.x, gy - this.gazeGoal.y) > 0.7 && chance(0.7)) this.puppet.blinkNow();
    this.gazeGoal.x = gx;
    this.gazeGoal.y = gy;

    // The eyes get there first; the head turns after them and takes over part of the look.
    this.gaze.x = approach(this.gaze.x, gx, 26, dt);
    this.gaze.y = approach(this.gaze.y, gy, 26, dt);
    this.headAim.x = approach(this.headAim.x, gx, 6.5, dt);
    this.headAim.y = approach(this.headAim.y, gy, 6.5, dt);

    // Eyes are never quite still: small darts around whatever they rest on.
    if ((this.dartIn -= dt) <= 0) {
      this.dartIn = rand(0.4, 1.9);
      this.dart.x = rand(-0.075, 0.075);
      this.dart.y = rand(-0.05, 0.05);
    }

    pose.gazeX += this.gaze.x + (this.gaze.x - this.headAim.x) * 0.45 + this.dart.x;
    pose.gazeY += this.gaze.y + (this.gaze.y - this.headAim.y) * 0.45 + this.dart.y;
    pose.yaw += this.headAim.x * 0.55;
    pose.pitch += this.headAim.y * 0.42;
    pose.tilt += this.headAim.x * 0.045;
    // Ears swivel toward whatever he is watching, ahead of the head.
    pose.earL += -this.gaze.x * 0.12;
    pose.earR += this.gaze.x * 0.12;
  }

  // ───────────────────────── ground ─────────────────────────

  private updateGround(dt: number, pose: Pose) {
    let ledge = this.ledge;
    const rideWin = this.world.window(this.rideHwnd);

    // Ride the window he stands on.
    if (rideWin && this.rideHwnd != null) {
      const moved = this.world.ledgeOfWindow(this.rideHwnd, rideWin.rect.x + this.rideOffset, rideWin.rect.y + this.rideDrop);
      const shelf = rideWin.rect.y + this.rideDrop;
      if (moved && Math.abs(moved.y - shelf) < 12 && rideWin.rect.x + this.rideOffset >= moved.x1 - 30 && rideWin.rect.x + this.rideOffset <= moved.x2 + 30) {
        ledge = moved;
        this.ledgeId = moved.id;
        const nx = clamp(rideWin.rect.x + this.rideOffset, moved.x1 + 10, moved.x2 - 10);
        this.rideVx = approach(this.rideVx, (nx - this.x) / Math.max(dt, 0.001), 12, dt);
        this.x = nx;
        this.y = moved.y;
      } else {
        ledge = null;
      }
    } else if (this.rideHwnd != null) {
      ledge = null;
    }

    if (!ledge) {
      // The floor is gone. Hang for a beat, then notice and drop.
      if (this.hangBeat === 0) {
        this.hangBeat = 0.32;
        this.stop();
        this.emit("lostFooting", undefined);
      }
      this.hangBeat -= dt;
      applyPose(pose, { ...EMOTIONS.surprised, footLY: 4, footRY: 4, handLX: -36, handLY: -50, handRX: 36, handRY: -50 });
      if (this.hangBeat <= 0) {
        this.hangBeat = 0;
        this.launch(0, 0);
      }
      return;
    }
    this.hangBeat = 0;
    this.y = ledge.y;

    const s = this.scale;
    if (this.walkTarget != null) {
      this.sitting = false;
      const goal = clamp(this.walkTarget, ledge.x1 + 14, ledge.x2 - 14);
      const dx = goal - this.x;
      const speed = (this.running ? RUN_SPEED : WALK_SPEED) * s;
      const step = speed * dt;
      if (Math.abs(dx) <= step) {
        this.x = goal;
        this.walkTarget = null;
      } else {
        this.dir = sign(dx);
        this.x += this.dir * step;
        this.walkPhase += ((step / s) / (this.running ? 62 : 36)) * Math.PI * 2;
        walkPose(pose, this.walkPhase, this.dir, this.running);
      }
      if (rideWin) this.rideOffset = this.x - rideWin.rect.x;
    } else if (this.sitting) {
      const t = this.puppet.time;
      applyPose(pose, {
        lift: -6,
        squash: 0.07,
        footLX: -14 + Math.sin(t * 2.1) * 3,
        footLY: 15 + Math.sin(t * 2.1) * 1.5,
        footRX: 14 + Math.sin(t * 2.1 + 2.4) * 3,
        footRY: 15 + Math.sin(t * 2.1 + 2.4) * 1.5,
        handLX: -29,
        handLY: -10,
        handRX: 29,
        handRY: -10,
        tailLift: -0.25,
        tailCurl: 0.02,
      });
    } else {
      // Standing still is never still: his weight wanders from foot to foot
      // and the head rights itself against the lean.
      const t = this.puppet.time;
      const sway = noise(t * 0.45, 3) * 0.03;
      pose.lean += sway;
      pose.tilt -= sway * 0.7;
      pose.headX += noise(t * 0.4, 7) * 0.9;
      pose.handLX += noise(t * 0.6, 21) * 0.8;
      pose.handRX += noise(t * 0.6, 22) * 0.8;
    }

    // A window dragged out from under him pulls him off balance.
    if (Math.abs(this.rideVx) > 200) {
      const k = clamp(this.rideVx / 2200, -1, 1);
      pose.lean -= k * 0.5;
      pose.handLX -= k * 10;
      pose.handRX -= k * 10;
      pose.handLY -= Math.abs(k) * 14;
      pose.handRY -= Math.abs(k) * 14;
      if (Math.abs(k) > 0.45) addEmotion(pose, "scared");
    }
    this.rideVx = approach(this.rideVx, 0, 6, dt);
  }

  // ───────────────────────── air ─────────────────────────

  private updateAir(dt: number, pose: Pose) {
    this.airTime += dt;
    const prevY = this.y;
    this.vy += GRAVITY * this.scale * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    const v = this.world.virtual;
    if (this.x < v.x + 30) {
      this.x = v.x + 30;
      this.vx = Math.abs(this.vx) * 0.45;
    } else if (this.x > v.x + v.w - 30) {
      this.x = v.x + v.w - 30;
      this.vx = -Math.abs(this.vx) * 0.45;
    }

    if (this.vy > 0) {
      for (const l of this.world.ledges) {
        if (this.landOn && l.id !== this.landOn) continue;
        if (prevY <= l.y + 0.5 && this.y >= l.y && this.x >= l.x1 - 6 && this.x <= l.x2 + 6) {
          const hard = l.y - this.fallFrom > 260 * this.scale || Math.abs(this.tumble) > 2;
          this.place(l, this.x);
          this.landKick = hard ? 1 : 0.7;
          this.tumble = 0;
          this.puppet.target.spin = 0;
          pose.spin = 0;
          this.emit("landed", { hard });
          return;
        }
      }
      // A jump that overshot its ledge falls back to landing on anything.
      const aim = this.world.ledge(this.landOn);
      if (aim && this.y > aim.y + 40) this.landOn = null;
      if (this.y > v.y + v.h + 400) {
        this.vanish();
        return;
      }
    }

    const d = this.dir;
    if (this.tumble !== 0) {
      pose.spin = (this.puppet.target.spin ?? 0) + this.tumble * dt;
      applyPose(pose, { handLX: -34, handLY: -64, handRX: 34, handRY: -64, footLX: -16, footLY: 4, footRX: 16, footRY: 4 });
      addEmotion(pose, "scared");
    } else if (this.vy < 0) {
      applyPose(pose, {
        facing: d * 0.6,
        squash: -0.16,
        lean: d * 0.16,
        handLX: -22 + d * 14,
        handLY: -84,
        handRX: 22 + d * 14,
        handRY: -84,
        footLX: -9 - d * 7,
        footLY: 6,
        footRX: 9 - d * 7,
        footRY: 3,
        tailLift: -0.2,
        tailCurl: 0,
      });
    } else {
      const flail = Math.sin(this.airTime * 22) * 5;
      applyPose(pose, {
        facing: d * 0.4,
        squash: -0.06,
        handLX: -35,
        handLY: -78 + flail,
        handRX: 35,
        handRY: -78 - flail,
        footLX: -15,
        footLY: 3,
        footRX: 15,
        footRY: 3,
        tailLift: 0.6,
        earL: 0.2,
        earR: 0.2,
      });
    }
  }

  // ───────────────────────── glass ─────────────────────────

  private updateGlass(dt: number, pose: Pose) {
    const s = this.scale;
    const t = this.puppet.time;

    if (this.sliding) {
      const prevY = this.y;
      this.vy = approach(this.vy, SLIDE_SPEED * s, 2.2, dt);
      this.y += this.vy * dt;
      const l = this.world.ledgeBelow(this.x, prevY);
      if (l && this.y >= l.y) {
        this.place(l, this.x);
        this.landKick = 0.55;
        this.emit("slid", undefined);
        return;
      }
      if (this.y > this.world.virtual.y + this.world.virtual.h + 400) {
        this.vanish();
        return;
      }
      applyPose(pose, {
        squash: -0.07,
        handLX: -31,
        handLY: -86,
        handRX: 31,
        handRY: -86,
        footLX: -19,
        footLY: 1,
        footRX: 19,
        footRY: 1,
        tailLift: 0.5,
        brow: 0.8,
        smile: -0.25,
        mouthW: 0.7,
        earL: 0.5,
        earR: 0.5,
      });
      // He holds your eye the whole way down.
      this.attention = { kind: "user" };
      this.attentionLeft = 0.2;
      return;
    }

    if (this.climbTarget) {
      const now = this.puppet.pose;
      this.climb ??= new Climb(this.x, this.y, s, [
        { x: now.handLX, y: now.handLY },
        { x: now.handRX, y: now.handRY },
      ]);
      const climb = this.climb;
      const bounds = this.world.virtual;
      const arrived = climb.step(dt, this.climbTarget, bounds.x + 40 * s, bounds.x + bounds.w - 40 * s);
      if (dt > 0 && Math.abs(climb.x - this.x) / dt > 40 * s) this.dir = sign(climb.x - this.x);
      this.x = climb.x;
      this.y = climb.y;
      this.puppet.planted = true;
      applyPose(pose, climb.pose());
      if (climb.doing === "pull") {
        applyPose(pose, { brow: -0.3, tongue: 0.7 });
      } else if (climb.doing === "leap") {
        applyPose(pose, { browRaise: 0.7, mouthOpen: 0.45, smile: 0.8, earL: -0.2, earR: -0.2, tailLift: 0.2 });
      } else if (climb.doing === "rest") {
        // A breather: he checks whether you are watching.
        this.attention = { kind: "user" };
        this.attentionLeft = 0.2;
      } else {
        addEmotion(pose, "scared", 0.9);
      }
      if (arrived) {
        this.climbTarget = null;
        this.climb = null;
      }
      return;
    }

    // Clinging: fine at first, then visibly running out of strength.
    if (!this.gripLocked) this.grip -= dt;
    const tired = this.gripLocked ? 0.25 : clamp01(1 - this.grip / 2.2);
    const shake = Math.sin(t * 46) * tired * 1.6;
    applyPose(pose, {
      handLX: -47 + shake,
      handLY: -68 + tired * 5,
      handRX: 47 + shake,
      handRY: -64 + tired * 5,
      footLX: -23,
      footLY: -2 + tired * 3,
      footRX: 23,
      footRY: -5 + tired * 3,
      headX: shake * 0.5,
      tailLift: -0.45,
      tailCurl: 0.03,
    });
    if (tired > 0.4) addEmotion(pose, "strained", clamp01((tired - 0.4) / 0.4));
    if (this.grip <= 0 && !this.gripLocked) {
      this.sliding = true;
      this.vy = 0;
      this.stop();
    }
  }

  // ───────────────────────── held ─────────────────────────

  private updateHeld(dt: number, pose: Pose) {
    const c = this.world.cursor;
    const s = this.scale;
    const angle = this.swing.step(clamp(-c.vx / 1500, -1.1, 1.1), dt);
    // Hang from the scruff: rotate about the grab point, not the feet.
    const arm = (SCRUFF - 45) * s;
    this.x = c.x - Math.sin(angle) * arm;
    this.y = c.y + Math.cos(angle) * arm + 45 * s;
    const t = this.puppet.time;
    applyPose(pose, {
      spin: angle,
      squash: -0.08,
      handLX: -21,
      handLY: -27,
      handRX: 21,
      handRY: -27,
      footLX: -11 + Math.sin(t * 3) * 1.5,
      footLY: 9,
      footRX: 11 + Math.sin(t * 3 + 2) * 1.5,
      footRY: 9,
      headY: 3,
      tailLift: -0.9,
      tailCurl: 0.02,
      tailWag: 0,
      earL: 0.35,
      earR: 0.35,
      smile: -0.1,
      brow: 0.35,
    });
    // He looks at whatever he is being carried over.
    this.attention = { kind: "point", x: this.x + clamp(c.vx, -300, 300), y: this.y + 200 };
    this.attentionLeft = 0.3;
  }

  /** The can's rim in world pixels, where he is clipped while half inside. */
  get rimY() {
    return this.can.y + CAN.rimY * this.can.scale;
  }
}

export function addEmotion(pose: Pose, emotion: Emotion, weight = 1) {
  const patch = EMOTIONS[emotion] as Partial<Pose>;
  for (const k in patch) {
    const key = k as keyof Pose;
    const rest = REST[key];
    // Emotions are stored as absolute values; apply them as offsets from
    // rest so they stack on top of whatever the body is doing.
    pose[key] += (patch[key]! - rest) * weight;
  }
}

function walkPose(pose: Pose, phase: number, dir: number, running: boolean) {
  const stride = running ? 15.5 : 9;
  const high = running ? 10 : 6;
  const bob = (running ? 3 : 1.6) * (0.5 + 0.5 * Math.cos(phase * 2));
  const swing = running ? 15 : 9;
  // The arm on the side he faces is the far one, half hidden by his body.
  const farHand = { x: dir * 13 + dir * swing * Math.sin(phase), y: -31 - Math.abs(Math.sin(phase)) * 3 };
  const nearHand = { x: dir * 1 - dir * swing * Math.sin(phase), y: -29 - Math.abs(Math.sin(phase)) * 3 };
  const L = dir > 0 ? nearHand : farHand;
  const R = dir > 0 ? farHand : nearHand;
  applyPose(pose, {
    facing: dir * 0.82,
    yaw: dir * 0.42,
    lean: dir * (running ? 0.24 : 0.07) + Math.sin(phase) * (running ? 0.035 : 0.05),
    tilt: -Math.sin(phase) * (running ? 0.03 : 0.045),
    headY: Math.cos(phase * 2 - 0.9) * (running ? 1.6 : 0.9),
    lift: bob,
    squash: -0.025 * Math.cos(phase * 2),
    footLX: -5 + dir * stride * Math.sin(phase),
    footLY: bob - Math.max(0, Math.cos(phase)) * high,
    footRX: 5 - dir * stride * Math.sin(phase),
    footRY: bob - Math.max(0, -Math.cos(phase)) * high,
    handLX: L.x,
    handLY: L.y,
    handRX: R.x,
    handRY: R.y,
    tailLift: running ? 0.3 : 0.2,
    tailCurl: running ? 0.03 : 0.08,
    tailWag: 0.12,
    tailWagHz: running ? 3 : 1.6,
    earL: running ? 0.25 : 0,
    earR: running ? 0.25 : 0,
  });
}
