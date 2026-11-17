import { beforeEach, describe, expect, it } from "vitest";
import { Can } from "../can/can";
import { World } from "../world/world";
import { Actor, GIRTH, STANDOFF } from "./actor";
import { seed } from "./math";
import { walkTo } from "./moves";

const FLOOR = 1000;
const DT = 1 / 60;

function setup(x = 400) {
  const world = new World();
  world.setMonitors({
    monitors: [{ id: 0, rect: { x: 0, y: 0, w: 1920, h: 1080 }, work: { x: 0, y: 0, w: 1920, h: FLOOR }, scale: 1, primary: true }],
    virtual: { x: 0, y: 0, w: 1920, h: 1080 },
  });
  const actor = new Actor(world, new Can());
  actor.place(world.ledges[0], x);
  const bumps: { speed: number; stumbled: boolean }[] = [];
  actor.on("bumped", (b) => bumps.push(b));
  return { world, actor, bumps };
}

/** Whether the cursor is inside his body. */
function inside(a: Actor) {
  const c = a.world.cursor;
  const rx = GIRTH * a.scale;
  const ry = 75 * a.scale;
  return ((c.x - a.x) / rx) ** 2 + ((c.y - (a.y - ry)) / ry) ** 2 < 0.98;
}

/** Runs frames until `done`, failing if he is ever found with the cursor in him. `each` runs before every frame. */
function run(world: World, a: Actor, seconds: number, done: () => boolean, each?: (t: number) => void) {
  for (let t = 0; t < seconds; t += DT) {
    each?.(t);
    world.tick(DT);
    a.update(DT);
    expect(inside(a)).toBe(false);
    if (done()) return t;
  }
  return seconds;
}

beforeEach(() => seed(7));

describe("the cursor in his way", () => {
  it("stops him short of it, then he hops over and walks on", async () => {
    const { world, actor: a, bumps } = setup();
    world.setCursor({ x: 700, y: FLOOR - 40, buttons: 0 });
    let arrived: boolean | null = null;
    void a.run(walkTo(a, 1000, false)).then((ok) => (arrived = ok));

    run(world, a, 10, () => a.balked);
    expect(a.balked).toBe(true);
    expect(700 - a.x).toBeCloseTo((GIRTH + STANDOFF) * a.scale, 0);

    let flew = false;
    run(world, a, 10, () => !a.busy, () => (flew ||= a.mode === "air"));
    await Promise.resolve();
    expect(flew).toBe(true);
    expect(arrived).toBe(true);
    expect(a.x).toBe(1000);
    expect(bumps).toEqual([]);
  });

  it.each([5, 12, 35, 60, 85, 110, 130, 145, 149])("clears it at %i units up", (up) => {
    const { world, actor: a, bumps } = setup();
    world.setCursor({ x: 700, y: FLOOR - up * a.scale, buttons: 0 });
    void a.run(walkTo(a, 1000, true));
    run(world, a, 10, () => !a.busy);
    expect(a.x).toBe(1000);
    expect(bumps).toEqual([]);
  });

  it("walks on when it leaves before he has hopped", () => {
    const { world, actor: a } = setup();
    world.setCursor({ x: 700, y: FLOOR - 40, buttons: 0 });
    void a.run(walkTo(a, 1000, false));
    run(world, a, 10, () => a.balked);
    world.setCursor({ x: 700, y: 300, buttons: 0 });
    let flew = false;
    run(world, a, 10, () => !a.busy, () => (flew ||= a.mode === "air"));
    expect(flew).toBe(false);
    expect(a.x).toBe(1000);
  });

  it("walks under it when it is over his head", () => {
    const { world, actor: a } = setup();
    world.setCursor({ x: 700, y: FLOOR - 170 * a.scale, buttons: 0 });
    void a.run(walkTo(a, 1000, false));
    let stopped = false;
    run(world, a, 10, () => !a.busy, () => (stopped ||= a.balked));
    expect(stopped).toBe(false);
    expect(a.x).toBe(1000);
  });

  it("throws him back when it drops in front of him at a run, harder than at a walk", () => {
    const hit = (running: boolean) => {
      const { world, actor: a, bumps } = setup();
      void a.run(walkTo(a, 1000, running));
      run(world, a, 0.5, () => false);
      const front = a.x + GIRTH * a.scale;
      world.setCursor({ x: front + 6, y: FLOOR - 60, buttons: 0 });
      const at = a.x;
      run(world, a, 0.25, () => false);
      return { bumps, back: at - a.x };
    };
    const walk = hit(false);
    const sprint = hit(true);
    expect(walk.bumps).toHaveLength(1);
    expect(sprint.bumps).toHaveLength(1);
    expect(sprint.bumps[0].speed).toBeGreaterThan(walk.bumps[0].speed * 3);
    expect(walk.back).toBeGreaterThan(0);
    expect(sprint.back).toBeGreaterThan(walk.back * 2);
  });

  it("backs off when it is pushed into him, without a bump", () => {
    const { world, actor: a, bumps } = setup();
    void a.run(walkTo(a, 1000, false));
    run(world, a, 0.5, () => false);
    const at = a.x;
    world.setCursor({ x: a.x + 10, y: FLOOR - 60, buttons: 0 });
    for (let i = 0; i < 20; i++) {
      world.tick(DT);
      a.update(DT);
    }
    expect(a.x).toBeLessThan(at);
    expect(bumps).toEqual([]);
  });

  it("gives up when it keeps getting in front of him", async () => {
    const { world, actor: a } = setup();
    let arrived: boolean | null = null;
    void a.run(walkTo(a, 1400, false)).then((ok) => (arrived = ok));
    // Always just ahead of him, and up in his face whenever he jumps.
    const each = () => world.setCursor({ x: a.x + (GIRTH + STANDOFF) * a.scale, y: a.y - 60 * a.scale, buttons: 0 });
    for (let t = 0; t < 40 && a.busy; t += DT) {
      each();
      world.tick(DT);
      a.update(DT);
    }
    await Promise.resolve();
    expect(arrived).toBe(false);
    expect(a.x).toBeLessThan(1400 - 100);
  });

  it("bounces off it in the air and still lands", () => {
    const { world, actor: a, bumps } = setup();
    world.setCursor({ x: 600, y: FLOOR - 200, buttons: 0 });
    a.launch(500, -700);
    run(world, a, 5, () => a.mode === "ground");
    expect(bumps.length).toBeGreaterThan(0);
    expect(a.mode).toBe("ground");
    expect(a.x).toBeLessThan(600);
  });

  it("does not balance on top of it", () => {
    const { world, actor: a } = setup();
    world.setCursor({ x: 400, y: FLOOR - 300, buttons: 0 });
    a.x = 400;
    a.y = FLOOR - 500;
    a.launch(0, 0);
    run(world, a, 6, () => a.mode === "ground");
    expect(a.mode).toBe("ground");
  });

  it("lets the cursor into him while he stands", () => {
    const { world, actor: a, bumps } = setup();
    world.setCursor({ x: a.x, y: a.y - 60, buttons: 0 });
    for (let i = 0; i < 30; i++) {
      world.tick(DT);
      a.update(DT);
    }
    expect(a.x).toBe(400);
    expect(bumps).toEqual([]);
  });
});
