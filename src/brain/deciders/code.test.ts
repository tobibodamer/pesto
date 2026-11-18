import { describe, expect, it } from "vitest";
import { DEFAULTS, type Config } from "../../config";
import type { JournalEntry } from "../journal";
import type { CallScene, Scene } from "./backend";
import { CodeDecider, REST, SOMETIMES, speaksUp } from "./code";

/** A random source that hands out these numbers in turn, then repeats the last. */
const rolls = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

const entry = (kind: JournalEntry["kind"], text: string, weight = 1): JournalEntry => ({ at: 0, kind, text, weight });

const OUT = { none: "", glance: "", approach: "", goHome: "" };
const IN_CAN = { none: "", rustle: "", peek: "", approach: "" };
const scene = (over: Partial<Scene> = {}): Scene => ({ out: true, sitting: false, playing: false, trigger: null, checkIn: false, spokeAgo: Infinity, reactions: OUT, ...over });

function decider(rand: () => number, speakUp: Config["decider"]["speakUp"] = "never") {
  const clock = { t: 0 };
  const config = structuredClone(DEFAULTS);
  config.decider.speakUp = speakUp;
  return { d: new CodeDecider({ config, now: () => clock.t, rand }), clock };
}

describe("code decider reactions", () => {
  it("glances at a window switch when the roll lands on it", async () => {
    const { d } = decider(rolls(0.1));
    expect((await d.react(scene({ trigger: entry("desk", "switched to code «x»") }))).reaction).toBe("glance");
  });

  it("does nothing at a window switch on most rolls", async () => {
    const { d } = decider(rolls(0.9));
    expect((await d.react(scene({ trigger: entry("desk", "switched to code «x»") }))).reaction).toBe("none");
  });

  it("only picks what he can do from inside the can", async () => {
    const { d } = decider(rolls(0.05));
    const v = await d.react(scene({ out: false, reactions: IN_CAN, trigger: entry("desk", "opened notes «x»") }));
    expect(v.reaction).toBe("rustle");
  });

  it("dances to music only while it plays", async () => {
    const trigger = entry("audio", "▶ Spotify: Song");
    const playing = { ...OUT, dance: "" };
    expect((await decider(rolls(0.1)).d.react(scene({ trigger, playing: true, reactions: playing }))).reaction).toBe("dance");
    expect((await decider(rolls(0.1)).d.react(scene({ trigger, playing: false }))).reaction).toBe("none");
  });

  it("comes to greet them when they come back", async () => {
    const { d } = decider(rolls(0.05));
    expect((await d.react(scene({ out: false, reactions: IN_CAN, trigger: entry("desk", "the person is back", 2) }))).reaction).toBe("peek");
  });

  it("rests after a reaction before picking another", async () => {
    const { d, clock } = decider(rolls(0.01));
    const trigger = entry("desk", "switched to code «x»");
    expect((await d.react(scene({ trigger }))).reaction).toBe("glance");
    clock.t = REST - 1;
    expect((await d.react(scene({ trigger }))).reaction).toBe("none");
    clock.t = REST + 1;
    expect((await d.react(scene({ trigger }))).reaction).toBe("glance");
  });

  it("leaves being touched to his reflexes and shows how he feels about it", async () => {
    const { d } = decider(rolls(0.1));
    const v = await d.react(scene({ trigger: entry("touch", "petted Pesto", 2) }));
    expect(v).toMatchObject({ reaction: "none", feeling: "happy" });
  });

  it("cannot tell procrastination, so never pesters", async () => {
    const { d } = decider(rolls(0.5));
    expect((await d.react(scene({ checkIn: true }))).slacking).toBeNull();
  });
});

describe("speak-up modes", () => {
  it("never speaks up when set to never", () => {
    expect(speaksUp("never", true, rolls(0))).toBe(false);
  });

  it("speaks up at every check-in when set to always", () => {
    expect(speaksUp("always", true, rolls(0.99))).toBe(true);
  });

  it("speaks up at some check-ins when set to sometimes", () => {
    expect(speaksUp("sometimes", true, rolls(SOMETIMES - 0.01))).toBe(true);
    expect(speaksUp("sometimes", true, rolls(SOMETIMES + 0.01))).toBe(false);
  });

  it("only speaks up at check-ins, never at an event", () => {
    expect(speaksUp("always", false, rolls(0))).toBe(false);
  });

  it("puts it in the verdict", async () => {
    const { d } = decider(rolls(0.99), "always");
    expect((await d.react(scene({ checkIn: true }))).speak).toBe(true);
  });
});

describe("code decider on being called", () => {
  const call = (over: Partial<CallScene> = {}): CallScene => ({ asleep: false, hidden: false, busy: false, mood: "neutral", spokeAgo: Infinity, hour: 14, ...over });

  it("answers with a curious hm on an ordinary roll", async () => {
    const { d } = decider(rolls(0.1, 0.1));
    expect(await d.called(call())).toEqual({ sound: "huh", feeling: "curious" });
  });

  it("chitters now and then", async () => {
    const { d } = decider(rolls(0.75));
    expect(await d.called(call())).toEqual({ sound: "chitter", feeling: "happy" });
  });

  it("grumbles when woken", async () => {
    const { d } = decider(rolls(0.1));
    expect(await d.called(call({ asleep: true, hidden: true }))).toEqual({ sound: "grumble", feeling: "sleepy" });
  });

  it("mostly just looks at them when they were talking a moment ago", async () => {
    const { d } = decider(rolls(0.1));
    expect((await d.called(call({ spokeAgo: 10 }))).sound).toBeNull();
  });

  it("has nothing to add while they talk, and leaves follow-ups to the word rules", async () => {
    const { d } = decider(rolls(0));
    expect(await d.aside()).toBeNull();
    expect(await d.replying()).toBeNull();
  });
});
