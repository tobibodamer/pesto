import { armWants, drawPesto, tailRadius, type Anchors, type ArmLayers, type DrawInput, type Hat } from "./draw";
import { Spring, chance, clamp, lerp, rand, type Vec } from "./math";
import { POSE_KEYS, REST, clonePose, type Pose, type PoseKey } from "./pose";

const TAIL_NODES = 9;
const TAIL_SEGMENT = 9.5;

/** The tail: a chain that is pulled toward a posed curve but keeps its own momentum. */
class Tail {
  nodes: Vec[] = [];
  private vel: Vec[] = [];
  /** Which side it hangs on, -1 left, 1 right. */
  side = -1;
  private flickIn = rand(2, 6);

  constructor() {
    for (let i = 0; i < TAIL_NODES; i++) {
      this.nodes.push({ x: -20 - i * TAIL_SEGMENT, y: -15 });
      this.vel.push({ x: 0, y: 0 });
    }
  }

  step(dt: number, pose: Pose, time: number, drift: Vec, grounded: boolean, twitch: boolean) {
    const af = Math.abs(pose.facing);
    if (af > 0.15) this.side = pose.facing > 0 ? -1 : 1;
    const side = this.side;
    const base = this.nodes[0];
    base.x = side * (23 + 4 * af) + pose.lean * 10;
    base.y = -15 * (1 - pose.squash);

    // Now and then the tip twitches on its own, as a resting animal's tail does.
    if (twitch) this.flickIn -= dt;
    if (this.flickIn <= 0) {
      this.flickIn = rand(2.5, 8);
      const kick = rand(70, 130) * (chance(0.5) ? 1 : -1);
      for (let i = TAIL_NODES - 4; i < TAIL_NODES; i++) {
        const u = (i - (TAIL_NODES - 5)) / 4;
        this.vel[i].x += side * kick * 0.5 * u;
        this.vel[i].y -= kick * u;
      }
    }

    const steps = 2;
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (let i = 1; i < TAIL_NODES; i++) {
        const n = this.nodes[i];
        const v = this.vel[i];
        const prev = this.nodes[i - 1];
        const u = i / (TAIL_NODES - 1);
        if (s === 0) {
          // The figure moved; the tail stays where it was and has to catch up.
          n.x -= drift.x * (0.35 + 0.65 * u);
          n.y -= drift.y * (0.35 + 0.65 * u);
        }
        const wag = pose.tailWag * Math.sin(time * Math.PI * 2 * pose.tailWagHz - i * 0.55) * (0.35 + u);
        const elev = pose.tailLift * 1.2 + pose.tailCurl * i + wag;
        const tx = prev.x + side * Math.cos(elev) * TAIL_SEGMENT;
        const ty = prev.y - Math.sin(elev) * TAIL_SEGMENT;
        const k = lerp(300, 110, u);
        const c = 2 * Math.sqrt(k) * 0.5;
        v.x += ((tx - n.x) * k - v.x * c) * h;
        v.y += ((ty - n.y) * k - v.y * c) * h;
        n.x += v.x * h;
        n.y += v.y * h;
        let dx = n.x - prev.x;
        let dy = n.y - prev.y;
        const d = Math.hypot(dx, dy) || 1;
        n.x = prev.x + (dx / d) * TAIL_SEGMENT;
        n.y = prev.y + (dy / d) * TAIL_SEGMENT;
        if (grounded) {
          const floor = -tailRadius(u, pose.bristle) * 0.8 + pose.lift;
          if (n.y > floor) {
            n.y = floor;
            if (v.y > 0) v.y = 0;
          }
        }
      }
    }
  }
}

const TUNING: Partial<Record<PoseKey, [freq: number, damping: number]>> = {
  facing: [13, 0.85],
  lean: [15, 0.55],
  squash: [20, 0.5],
  lift: [60, 1],
  spin: [60, 1],
  headX: [15, 0.7],
  headY: [15, 0.7],
  tilt: [14, 0.6],
  yaw: [16, 0.75],
  pitch: [16, 0.75],
  gazeX: [30, 0.9],
  gazeY: [30, 0.9],
  pupil: [12, 0.8],
  earL: [17, 0.42],
  earR: [16, 0.42],
  mouthOpen: [34, 0.8],
  // Loose enough that a hand overshoots where it was sent and swings back.
  handLX: [17, 0.52],
  handLY: [17, 0.52],
  handRX: [17, 0.52],
  handRY: [17, 0.52],
  footLX: [45, 1],
  footLY: [45, 1],
  footRX: [45, 1],
  footRY: [45, 1],
  tailLift: [7, 0.9],
  tailCurl: [7, 0.9],
  tailWag: [6, 1],
  tailWagHz: [6, 1],
  bristle: [22, 0.45],
};
const DEFAULT_TUNING: [number, number] = [20, 0.75];
const PAW_KEYS: PoseKey[] = ["handLX", "handLY", "handRX", "handRY", "footLX", "footLY", "footRX", "footRY"];

/**
 * The drawable Pesto. Callers write the pose they want into `target`; the
 * puppet eases toward it and adds the involuntary life on top: breathing,
 * blinking and the tail.
 */
export class Puppet {
  /** Where the body should be. Write to this. */
  target: Pose = clonePose(REST);
  /** Where the body is, after easing. */
  pose: Pose = clonePose(REST);
  hat: Hat = null;
  held: DrawInput["held"] = null;
  eyesOnly = false;
  time = rand(0, 100);
  anchors: Anchors | null = null;
  /** Set false while he hangs or flies so the tail may drop below his feet. */
  grounded = true;
  /** Scales breathing, 0 holds his chest still. */
  breath = 1;
  /** Blinks, ear flicks and tail twitches. Turn off to hold a pose exactly, as the pose sheets do. */
  twitchy = true;
  /** His paws go exactly where the target puts them, with no ease: for when they grip something that does not move with him. */
  planted = false;

  private springs = new Map<PoseKey, Spring>();
  private tail = new Tail();
  private blink = 0;
  private blinkTimer = rand(1, 4);
  private blinkPhase: "open" | "closing" | "shut" | "opening" = "open";
  private blinkHold = 0;
  private doubleBlink = false;
  private flickEar = 0;
  private flickLeft = 0;
  private flickIn = rand(2, 7);
  private flickAgain = false;
  private lagX = new Spring(0, 17, 0.42);
  private lagY = new Spring(0, 19, 0.45);
  private armLagX = new Spring(0, 10, 0.3);
  private armLagY = new Spring(0, 12, 0.32);
  private earLag = new Spring(0, 15, 0.35);
  private vel: Vec = { x: 0, y: 0 };
  private lastLift = 0;
  private out: Pose = clonePose(REST);
  private arms: ArmLayers = { front: [1, 1], overFace: [0, 0] };
  /** Which layer each arm is heading for. It only changes once the pose clearly asks, so an arm near the line stays put. */
  private armGoal = { front: [true, true], overFace: [false, false] };

  constructor() {
    for (const k of POSE_KEYS) {
      const [f, d] = TUNING[k] ?? DEFAULT_TUNING;
      this.springs.set(k, new Spring(REST[k], f, d));
    }
  }

  /** Jump straight to the target pose, skipping the ease. */
  snap() {
    for (const k of POSE_KEYS) {
      this.springs.get(k)!.snap(this.target[k]);
      this.pose[k] = this.target[k];
    }
    this.lagX.snap(0);
    this.lagY.snap(0);
    this.armLagX.snap(0);
    this.armLagY.snap(0);
    this.earLag.snap(0);
    this.vel = { x: 0, y: 0 };
    this.lastLift = this.target.lift;
    const wants = armWants(this.target);
    for (const layer of ["front", "overFace"] as const) {
      for (const i of [0, 1]) {
        this.armGoal[layer][i] = wants[layer][i] > 0;
        this.arms[layer][i] = wants[layer][i] > 0 ? 1 : 0;
      }
    }
  }

  /** The tail's centreline from base to tip, in pose space, as it is right now. */
  get tailNodes(): readonly Vec[] {
    return this.tail.nodes;
  }

  blinkNow() {
    if (this.blinkPhase === "open") this.blinkPhase = "closing";
  }

  /**
   * @param drift how far the figure moved this frame, in character units, so
   * the tail can trail behind.
   */
  update(dt: number, drift: Vec = { x: 0, y: 0 }) {
    this.time += dt;
    for (const k of POSE_KEYS) this.pose[k] = this.springs.get(k)!.step(this.target[k], dt);
    if (this.planted) {
      for (const k of PAW_KEYS) {
        this.springs.get(k)!.snap(this.target[k]);
        this.pose[k] = this.target[k];
      }
    }

    if (this.twitchy) this.blinkTimer -= dt;
    if (this.blinkTimer <= 0 && this.blinkPhase === "open") {
      this.blinkPhase = "closing";
      this.doubleBlink = chance(0.18);
      this.blinkTimer = rand(2.2, 6.5);
    }
    if (this.blinkPhase === "closing") {
      this.blink += dt / 0.06;
      if (this.blink >= 1) {
        this.blink = 1;
        this.blinkPhase = "shut";
        this.blinkHold = 0.035;
      }
    } else if (this.blinkPhase === "shut") {
      if ((this.blinkHold -= dt) <= 0) this.blinkPhase = "opening";
    } else if (this.blinkPhase === "opening") {
      this.blink -= dt / 0.13;
      if (this.blink <= 0) {
        this.blink = 0;
        this.blinkPhase = this.doubleBlink ? "closing" : "open";
        this.doubleBlink = false;
      }
    }

    const o = this.out;
    Object.assign(o, this.pose);
    // Breathing: the chest rises, and the head and paws ride it a beat late.
    const b = Math.sin(this.time * 2.1) * this.breath;
    o.squash += b * 0.014;
    o.headY += Math.sin(this.time * 2.1 - 0.8) * 0.7 * this.breath;
    o.handLY += Math.sin(this.time * 2.1 - 0.4) * 0.6 * this.breath;
    o.handRY += Math.sin(this.time * 2.1 - 0.4) * 0.6 * this.breath;
    o.lidL = Math.max(o.lidL, this.blink);
    o.lidR = Math.max(o.lidR, this.blink);
    // The cheeks come up to meet the lids, and the head dips a hair.
    o.lowL = Math.max(o.lowL, this.blink * 0.3);
    o.lowR = Math.max(o.lowR, this.blink * 0.3);
    o.headY += this.blink * 0.5;
    if (this.twitchy) this.twitchEars(dt, o);
    if (dt > 0) this.overlap(dt, o, drift);
    this.layerArms(dt, o);
    // A blink in a wide-open eye reads as sleepy; keep a cheerful shut eye cheerful.
    if (this.blink > 0.9 && this.pose.lidL < 0.9) o.eyeSmile = 0.25;

    const d = { x: clamp(drift.x, -40, 40), y: clamp(drift.y, -40, 40) };
    this.tail.step(Math.min(dt, 0.05), o, this.time, d, this.grounded, this.twitchy);
  }

  /** One ear flicks by itself every few seconds, sometimes twice. */
  private twitchEars(dt: number, o: Pose) {
    const FLICK = 0.22;
    if (this.flickLeft > 0) {
      this.flickLeft -= dt;
      const k = Math.sin(clamp(1 - this.flickLeft / FLICK, 0, 1) * Math.PI) * 0.34;
      if (this.flickEar < 0) o.earL -= k;
      else o.earR -= k;
      if (this.flickLeft <= 0 && this.flickAgain) {
        this.flickAgain = false;
        this.flickLeft = FLICK;
      }
      return;
    }
    if ((this.flickIn -= dt) > 0) return;
    this.flickIn = rand(3, 10);
    this.flickEar = chance(0.5) ? -1 : 1;
    this.flickLeft = FLICK;
    this.flickAgain = chance(0.35);
  }

  /**
   * Follow-through: when the body speeds up, stops or lands, the head and
   * ears keep going for a moment and then settle, and arms that hang loose
   * swing.
   */
  private overlap(dt: number, o: Pose, drift: Vec) {
    const lift = this.pose.lift;
    const teleported = Math.hypot(drift.x, drift.y) > 30;
    const vx = teleported ? 0 : drift.x / dt;
    const vy = teleported ? 0 : (drift.y - (lift - this.lastLift)) / dt;
    this.lastLift = lift;
    const ax = teleported ? 0 : clamp(vx - this.vel.x, -700, 700);
    const ay = teleported ? 0 : clamp(vy - this.vel.y, -700, 700);
    this.vel.x = vx;
    this.vel.y = vy;
    this.lagX.v -= ax * 0.3;
    this.lagY.v -= ay * 0.3;
    this.armLagX.v -= ax * 0.42;
    this.armLagY.v -= ay * 0.3;
    this.earLag.v += Math.abs(ay) * 0.009 + Math.abs(ax) * 0.004;
    const lx = clamp(this.lagX.step(0, dt), -5, 5);
    const ly = clamp(this.lagY.step(0, dt), -5, 6);
    const ears = clamp(this.earLag.step(0, dt), -0.3, 0.5);
    o.headX += lx;
    o.headY += ly;
    o.tilt += lx * 0.014;
    o.earL += ears;
    o.earR += ears;
    const swingX = clamp(this.armLagX.step(0, dt), -8, 8);
    const swingY = clamp(this.armLagY.step(0, dt), -5, 6);
    if (!this.planted) {
      // The lower a hand hangs, the more freely it swings.
      const looseL = clamp((o.handLY + 52) / 18, 0, 1);
      const looseR = clamp((o.handRY + 52) / 18, 0, 1);
      o.handLX += swingX * looseL;
      o.handLY += swingY * looseL;
      o.handRX += swingX * looseR;
      o.handRY += swingY * looseR;
    }
  }

  /** Moves each arm toward the layer its pose asks for, over a moment instead of at once. */
  private layerArms(dt: number, o: Pose) {
    const CLEARLY = 0.06;
    const SECONDS = 0.14;
    const wants = armWants(o);
    for (const layer of ["front", "overFace"] as const) {
      for (const i of [0, 1]) {
        const want = wants[layer][i];
        if (want > CLEARLY) this.armGoal[layer][i] = true;
        else if (want < -CLEARLY) this.armGoal[layer][i] = false;
        const goal = this.armGoal[layer][i] ? 1 : 0;
        this.arms[layer][i] = clamp(this.arms[layer][i] + Math.sign(goal - this.arms[layer][i]) * (dt / SECONDS), 0, 1);
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    this.anchors = drawPesto(ctx, {
      arms: this.arms,
      pose: this.out,
      tail: this.tail.nodes,
      time: this.time,
      hat: this.hat,
      held: this.held,
      eyesOnly: this.eyesOnly,
    });
  }

  /** Runs the simulation forward without drawing, to settle into a pose. */
  settle(seconds = 1.5) {
    this.snap();
    for (let t = 0; t < seconds; t += 1 / 60) this.update(1 / 60);
  }
}
