import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, type Config } from "../config";
import { postJson } from "../net";
import { Decider } from "./decider";

vi.mock("../net", () => ({ postJson: vi.fn() }));
const post = vi.mocked(postJson);

/** Just enough of everything the decider looks at, for driving it in steps. */
function rig(decider: Partial<Config["decider"]>, rand = () => 0.99) {
  const config = structuredClone(DEFAULTS);
  Object.assign(config.decider, decider);
  const clock = { t: 1000 };
  const wakes: string[] = [];
  const performed: string[] = [];
  const mind = { busy: false, configured: true, lastSpokeAt: -Infinity, wake: async (r: { why: string }) => void wakes.push(r.why) };
  const deps = {
    config,
    world: { system: { idleMs: 0 }, media: { sessions: [] }, audio: { out: 0 }, focused: null },
    journal: { onEntry: () => {}, personTalking: false, render: () => "", brief: () => "" },
    director: { autonomous: true, can: { eyes: false }, asleep: false, hour: () => 14, perform: async (name: string) => (performed.push(name), true) },
    actor: { mode: "can", sitting: false, busy: false, mood: "neutral" },
    mind,
    now: () => clock.t,
    rand,
  };
  const d = new Decider(deps as unknown as ConstructorParameters<typeof Decider>[0]);
  /** Runs the 75 s check-in and lets its decision finish. */
  const checkIn = async () => {
    clock.t += 75;
    d.update(75);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { d, deps, clock, wakes, performed, mind, checkIn };
}

beforeEach(() => {
  post.mockReset();
});

describe("speaking up without a decision model", () => {
  it("speaks up at a check-in when set to always", async () => {
    const r = rig({ provider: "none", speakUp: "always" });
    await r.checkIn();
    expect(r.wakes).toHaveLength(1);
  });

  it("stays quiet when set to never", async () => {
    const r = rig({ provider: "none", speakUp: "never" });
    await r.checkIn();
    expect(r.wakes).toHaveLength(0);
  });

  it("speaks up on a low roll when set to sometimes, and not on a high one", async () => {
    const low = rig({ provider: "none", speakUp: "sometimes" }, () => 0.01);
    await low.checkIn();
    expect(low.wakes).toHaveLength(1);
    const high = rig({ provider: "none", speakUp: "sometimes" }, () => 0.99);
    await high.checkIn();
    expect(high.wakes).toHaveLength(0);
  });

  it("keeps quiet within mind.quietSeconds of his last remark", async () => {
    const r = rig({ provider: "none", speakUp: "always" });
    r.mind.lastSpokeAt = r.clock.t;
    await r.checkIn();
    expect(r.wakes).toHaveLength(0);
  });

  it("keeps quiet while the person is talking", async () => {
    const r = rig({ provider: "none", speakUp: "always" });
    r.deps.journal.personTalking = true;
    await r.checkIn();
    expect(r.wakes).toHaveLength(0);
  });

  it("does not ask the model", async () => {
    const r = rig({ provider: "none" });
    await r.checkIn();
    expect(post).not.toHaveBeenCalled();
    expect(r.d.backend).toBe("none");
  });
});

describe("falling back from System One", () => {
  it("decides in code when the model fails, and stops asking after five failures in a row", async () => {
    post.mockRejectedValue(new Error("connection refused"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig({ provider: "systemone", speakUp: "always" });
    for (let i = 0; i < 5; i++) await r.checkIn();
    expect(post).toHaveBeenCalledTimes(5);
    expect(r.d.backend).toBe("none");
    expect(r.wakes.length).toBeGreaterThan(0);
    await r.checkIn();
    expect(post).toHaveBeenCalledTimes(5);
  });

  it("tries the model once more after ten minutes", async () => {
    post.mockRejectedValue(new Error("connection refused"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig({ provider: "systemone" });
    for (let i = 0; i < 5; i++) await r.checkIn();
    r.clock.t += 600;
    await r.checkIn();
    expect(post).toHaveBeenCalledTimes(6);
    expect(r.d.backend).toBe("none");
  });

  it("uses the model's own speak-up judgment while it answers", async () => {
    post.mockResolvedValue({ answers: { reaction: { type: "choice", choice: "none", probabilities: { none: 1 }, confidence: 1 }, speak: { type: "noul", noul: 0.1 }, slacking: { type: "noul", noul: 0 } } });
    const r = rig({ provider: "systemone", speakUp: "always" });
    await r.checkIn();
    expect(post).toHaveBeenCalledTimes(1);
    expect(r.wakes).toHaveLength(0);
  });

  it("asks nothing at all with reactions off", async () => {
    const r = rig({ enabled: false, speakUp: "always" });
    await r.checkIn();
    expect(await r.d.called()).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(r.wakes).toHaveLength(0);
  });
});
