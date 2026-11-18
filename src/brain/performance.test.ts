import { afterEach, describe, expect, it, vi } from "vitest";
import type { Line, Utterance, Voice } from "../voice/voice";
import { Fumble } from "./hands";
import { fakeJobs } from "./jobs.fake";
import { Performance, type PerformanceDeps } from "./performance";
import { parseScript } from "./script";

/** A promise settled from outside. */
function latch() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

/** Lets every queued continuation run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** A voice whose lines start and finish only when the test says so. */
function fakeVoice(audible = true) {
  const lines: { text: string; started: () => void; finished: () => void; played: boolean; discarded: boolean; stopped: boolean }[] = [];
  const voice: Voice = {
    audible,
    cue() {},
    place() {},
    prepare(text): Line {
      const started = latch();
      const finished = latch();
      const line = { text, started: started.open, finished: finished.open, played: false, discarded: false, stopped: false };
      lines.push(line);
      return {
        discard: () => void (line.discarded = true),
        play(): Utterance {
          line.played = true;
          return {
            started: started.promise,
            finished: finished.promise,
            level: () => 0.5,
            stop() {
              line.stopped = true;
              started.open();
              finished.open();
            },
          };
        },
      };
    },
  };
  return { voice, lines };
}

function setup(opts: { audible?: boolean; captions?: boolean; mayAct?: boolean } = {}) {
  const log: string[] = [];
  const { voice, lines } = fakeVoice(opts.audible);
  const performs: { name: string; args: Record<string, unknown>; done: () => void }[] = [];
  const shown: { text: string; kind: string; seconds?: number }[] = [];
  const actor = {
    talking: false,
    inSpeech: false,
    speech: 0,
    stopped: 0,
    /** As on the real actor, stopping him ends the move he is in. */
    stop() {
      actor.stopped++;
      performs.forEach((p) => p.done());
    },
    feel() {},
  };
  const paper = { hidden: 0, show: (text: string, kind: string, seconds?: number) => void shown.push({ text, kind, seconds }), hide: () => void paper.hidden++ };
  const director = {
    can: { x: 500, y: 900 },
    world: {
      actionPoint: { x: 7, y: 8 } as { x: number; y: number } | null,
      monitors: [{ id: 0, scale: 1 }],
      window: (hwnd: number | null) => (hwnd === 4242 ? { hwnd, rect: { x: 0, y: 0, w: 800, h: 600 }, monitor: 0, state: director.windowState } : null),
    },
    windowState: "normal",
    /** Set to have him stopped on the way, before his hand lands. */
    stoppedShort: false,
    perform(name: string, args: Record<string, unknown>) {
      log.push(`do ${name}`);
      const done = latch();
      performs.push({ name, args, done: done.open });
      return done.promise.then(() => {
        if (!director.stoppedShort) (args.act as (() => void) | undefined)?.();
        return !director.stoppedShort;
      });
    },
  };
  const sight = {
    get: (id: string) => (id === "e3" ? { id, hwnd: 77, key: 9, kind: "button", name: "Search" } : null),
    locate: (id: string) => (id === "e3" ? { window: 77, at: { x: 4, y: 5 } } : null),
  };
  const hands = {
    /** Set to make whatever he tries next go wrong, for this reason. */
    fail: null as string | null,
    tried: [] as string[],
    attempt(what: string) {
      hands.tried.push(what);
      log.push(`act ${what}`);
      return hands.fail ? Promise.reject(new Fumble(hands.fail)) : Promise.resolve(what);
    },
    press: (seen: { name: string }) => hands.attempt(`press ${seen.name}`),
    focus: (seen: { name: string }) => hands.attempt(`focus ${seen.name}`),
    window: (hwnd: number, verb: string) => hands.attempt(`${verb} ${hwnd}`),
    move: (hwnd: number, to: string) => hands.attempt(`move ${hwnd} ${to}`),
    media: (verb: string) => hands.attempt(verb),
    open: (what: string) => hands.attempt(`open ${what}`),
  };
  const errands = fakeJobs();
  const performance = new Performance({
    director,
    actor,
    voice,
    paper,
    sight,
    hands,
    jobs: errands.jobs,
    windowIds: new Map([["w2", 4242]]),
    mayAct: opts.mayAct ?? true,
    captions: opts.captions ?? false,
    now: () => 12,
  } as unknown as PerformanceDeps);
  const push = (script: string) => parseScript(script).forEach((item) => performance.push(item));
  /** Starts and finishes whatever is waiting, until nothing is left. */
  const playOut = async () => {
    for (let quiet = 0; quiet < 3; ) {
      await settle();
      const line = lines.find((l) => l.played && !l.stopped && !("over" in l));
      const move = performs.find((p) => !("over" in p));
      if (line) {
        log.push(`say ${line.text}`);
        line.started();
        line.finished();
        Object.assign(line, { over: true });
      }
      if (move) {
        move.done();
        Object.assign(move, { over: true });
      }
      quiet = line || move ? 0 : quiet + 1;
    }
    await performance.finish();
  };
  return { performance, push, playOut, lines, performs, shown, actor, paper, director, hands, log, errands };
}

afterEach(() => vi.useRealTimers());

describe("Performance: the two tracks", () => {
  it("plays speech and directions in the order written", async () => {
    const t = setup();
    t.push('<emote as="smug"/> Oh. <go to="w2"/> Cool. <point at="cursor"/>');
    await t.playOut();
    expect(t.log).toEqual(["do emote", "say Oh.", "do approach", "say Cool.", "do point"]);
  });

  it("does not say the line until the move before it has begun", async () => {
    const t = setup();
    t.push('First. <point at="cursor"/> This one.');
    await settle();
    expect(t.lines.map((l) => l.played)).toEqual([true, false]);
    expect(t.performs).toEqual([]);

    t.lines[0].started();
    await settle();
    // He points while the first line is still being spoken.
    expect(t.performs.map((p) => p.name)).toEqual(["point"]);
    expect(t.lines[1].played).toBe(false);

    t.lines[0].finished();
    await settle();
    // And says "this one" while he is still pointing.
    expect(t.lines[1].played).toBe(true);
  });

  it("does not start a move until the line before it is being spoken", async () => {
    const t = setup();
    t.push("Watch. <dance/>");
    await settle();
    expect(t.performs).toEqual([]);
    t.lines[0].started();
    await settle();
    expect(t.performs.map((p) => p.name)).toEqual(["dance"]);
  });

  it("prepares every line at once, so each is ready when its turn comes", () => {
    const t = setup();
    t.push("One. Two. Three.");
    expect(t.lines.map((l) => l.text)).toEqual(["One.", "Two.", "Three."]);
  });

  it("moves his mouth only while a line is sounding", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.push("Hello.");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.actor.talking).toBe(false);
    t.lines[0].started();
    await vi.advanceTimersByTimeAsync(40);
    expect(t.actor.talking).toBe(true);
    expect(t.actor.speech).toBe(0.5);
    t.lines[0].finished();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.actor.talking).toBe(false);
    expect(t.actor.speech).toBe(0);
  });

  it("stays in the middle of his reply between sentences", async () => {
    const t = setup();
    t.push("One. Two.");
    await settle();
    expect(t.actor.inSpeech).toBe(false);
    t.lines[0].started();
    await settle();
    t.lines[0].finished();
    await settle();
    expect(t.actor.talking).toBe(false);
    expect(t.actor.inSpeech).toBe(true);
  });
});

describe("Performance: what he said", () => {
  it("records what was spoken without the delivery tags", async () => {
    const t = setup();
    t.push("[snorts] Sure. [whispers] Fine.");
    await t.playOut();
    expect(t.performance.said).toEqual(["Sure.", "Fine."]);
    expect(t.lines[0].text).toBe("[snorts] Sure.");
  });

  it("shows no caption while the voice is audible and captions are off", async () => {
    const t = setup();
    t.push("Hello.");
    await t.playOut();
    expect(t.shown).toEqual([]);
    expect(t.paper.hidden).toBe(0);
  });

  it("captions each line when asked to, and clears the last one", async () => {
    vi.useFakeTimers();
    const t = setup({ captions: true });
    t.push("[snorts] Sure.");
    await vi.advanceTimersByTimeAsync(0);
    t.lines[0].started();
    t.lines[0].finished();
    const done = t.performance.finish();
    await vi.advanceTimersByTimeAsync(899);
    expect(t.shown).toEqual([{ text: "Sure.", kind: "speech", seconds: undefined }]);
    expect(t.paper.hidden).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(t.paper.hidden).toBe(1);
  });

  it("captions without being asked when nothing can be heard", async () => {
    vi.useFakeTimers();
    const t = setup({ audible: false });
    t.push("Hello.");
    await vi.advanceTimersByTimeAsync(0);
    t.lines[0].started();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.shown.map((s) => s.text)).toEqual(["Hello."]);
  });
});

describe("Performance: directions", () => {
  const one = async (script: string) => {
    const t = setup();
    t.push(script);
    await t.playOut();
    return t;
  };

  it("runs script names under the reaction they stand for", async () => {
    const t = await one('<look at="cursor"/><go to="cursor"/><home/><think/><out/>');
    expect(t.performs.map((p) => p.name)).toEqual(["glance", "approach", "goHome", "ponder", "comeOut"]);
    expect(t.performance.did).toEqual(["look (at cursor)", "go (to cursor)", "home", "think", "out"]);
  });

  it("skips a direction that does not exist", async () => {
    const t = await one("<moonwalk/> Fine. <dance/>");
    expect(t.performs.map((p) => p.name)).toEqual(["dance"]);
    expect(t.performance.did).toEqual(["dance"]);
    expect(t.performance.said).toEqual(["Fine."]);
  });

  it.each([
    ["cursor", "cursor"],
    ["user", "user"],
    ["w2", { window: 4242 }],
    ["e3", { window: 77, at: { x: 4, y: 5 } }],
    ["focus", { x: 7, y: 8 }],
    ["can", { x: 500, y: 840 }],
    ["120, -40.5", { x: 120, y: -40.5 }],
    ["w9", undefined],
    ["e99", undefined],
    ["the red button", undefined],
  ])("resolves the target %j", async (at, target) => {
    const t = await one(`<point at="${at}"/>`);
    expect(t.performs[0].args.target).toEqual(target);
  });

  it("has no target for focus when nothing is focused", async () => {
    const t = setup();
    t.director.world.actionPoint = null;
    t.push('<point at="focus"/>');
    await t.playOut();
    expect(t.performs[0].args.target).toBeUndefined();
  });

  it("takes the target from either at or to", async () => {
    const t = await one('<go to="w2"/><go at="w2"/>');
    expect(t.performs.map((p) => p.args.target)).toEqual([{ window: 4242 }, { window: 4242 }]);
  });

  it("passes on a face he has and drops one he has not", async () => {
    const t = await one('<emote as="smug"/><emote as="flabbergasted"/>');
    expect(t.performs.map((p) => p.args.emotion)).toEqual(["smug", undefined]);
  });

  it("keeps durations between a tenth of a second and thirty", async () => {
    const t = await one('<dance s="4"/><dance s="900"/><dance s="0"/><dance/>');
    expect(t.performs.map((p) => p.args.seconds)).toEqual([4, 30, 0.1, undefined]);
  });

  it("names what he saw in the journal line instead of its number", async () => {
    const t = await one('<tap at="e3"/>');
    expect(t.performance.did).toEqual(["tap (at button «Search»)"]);
  });

  it("holds up a sign, cut to what fits on the cardboard", async () => {
    const t = await one('<sign s="9">this is far too much to write on one sign</sign><sign>ok</sign><sign></sign>');
    expect(t.performs.map((p) => [p.name, p.args])).toEqual([
      ["sign", { text: "this is far too much to ", seconds: 9 }],
      ["sign", { text: "ok", seconds: 4 }],
    ]);
    expect(t.performance.did).toEqual(["held up a sign: this is far too much to write on one sign", "held up a sign: ok"]);
  });

  it("slides out a note that stays long enough to read", async () => {
    const long = "word ".repeat(40).trim();
    const t = await one(`<note>short</note><note>${long}</note><note s="3">quick</note>`);
    expect(t.shown).toEqual([
      { text: "short", kind: "note", seconds: 6 },
      { text: long, kind: "note", seconds: long.length / 14 },
      { text: "quick", kind: "note", seconds: 3 },
    ]);
    expect(t.performs).toEqual([]);
  });

  it("waits without doing anything", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.push('<wait s="2"/><dance/>');
    await vi.advanceTimersByTimeAsync(1999);
    expect(t.performs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.performs.map((p) => p.name)).toEqual(["dance"]);
    expect(t.performance.did).toEqual(["dance"]);
  });

  it("carries on after a direction that throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    const perform = t.director.perform;
    t.director.perform = (name, args) => (name === "dance" ? Promise.reject(new Error("slipped")) : perform(name, args));
    t.push("<dance/> Ow. <clap/>");
    await t.playOut();
    expect(t.performs.map((p) => p.name)).toEqual(["clap"]);
    expect(t.performance.said).toEqual(["Ow."]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("Performance: changing their desktop", () => {
  it("presses the thing as his hand lands, and holds the words after it until then", async () => {
    const t = setup();
    t.push('Fine. <press at="e3"/> Done.');
    await settle();
    t.lines[0].started();
    t.lines[0].finished();
    await settle();
    expect(t.performs.map((p) => [p.name, p.args.target])).toEqual([["press", { window: 77, at: { x: 4, y: 5 } }]]);
    expect(t.hands.tried).toEqual([]);
    expect(t.lines[1].played).toBe(false);

    t.performs[0].done();
    await settle();
    expect(t.hands.tried).toEqual(["press Search"]);
    expect(t.lines[1].played).toBe(true);
    expect(t.performance.did).toEqual(["press Search"]);
    expect(t.performance.failed).toBeNull();
  });

  it("takes click for press", async () => {
    const t = setup();
    t.push('<click at="e3"/>');
    await t.playOut();
    expect(t.hands.tried).toEqual(["press Search"]);
  });

  it("puts the cursor in a field, and brings a window forward, under the same name", async () => {
    const t = setup();
    t.push('<focus at="e3"/><focus at="w2"/>');
    await t.playOut();
    expect(t.hands.tried).toEqual(["focus Search", "focus 4242"]);
  });

  it("goes to the caption button for what he does to a window", async () => {
    const t = setup();
    t.push('<close at="w2"/><minimise at="w2"/><move at="w2" to="top right"/>');
    await t.playOut();
    expect(t.performs.map((p) => p.args.target)).toEqual([
      { window: 4242, at: { x: 777, y: 16 } },
      { window: 4242, at: { x: 685, y: 16 } },
      { window: 4242, at: { x: 400, y: 16 } },
    ]);
    expect(t.hands.tried).toEqual(["close 4242", "minimize 4242", "move 4242 top right"]);
  });

  it("restores a minimised window without going anywhere", async () => {
    const t = setup();
    t.director.windowState = "minimized";
    t.push('<restore at="w2"/>');
    await t.playOut();
    expect(t.performs).toEqual([]);
    expect(t.hands.tried).toEqual(["restore 4242"]);
  });

  it("works what is playing from where he stands", async () => {
    const t = setup();
    t.push("<pause/><next/>");
    await t.playOut();
    expect(t.performs).toEqual([]);
    expect(t.hands.tried).toEqual(["pause", "next"]);
  });

  it("opens things by name, and brings a window he was told to open to the front instead", async () => {
    const t = setup();
    t.push('<open what="Downloads"/><launch app="Spotify"/><open at="w2"/>');
    await t.playOut();
    expect(t.hands.tried).toEqual(["open Downloads", "open Spotify", "focus 4242"]);
    expect(t.performs.map((p) => p.args.target)).toEqual([{ window: 4242, at: { x: 400, y: 16 } }]);
  });

  it("drops the rest of the script when it does not work, and plays again once that is dealt with", async () => {
    const t = setup();
    t.hands.fail = "it is greyed out";
    t.push('<press at="e3"/> Done. <dance/>');
    await t.playOut();
    expect(t.performance.failed).toEqual({ direction: '<press at="e3"/>', why: "it is greyed out" });
    expect(t.performs.map((p) => p.name)).toEqual(["press"]);
    expect(t.lines.map((l) => [l.played, l.discarded])).toEqual([[false, true]]);
    expect(t.performance.said).toEqual([]);
    expect(t.performance.did).toEqual(["tried press (at button «Search»), which did not work: it is greyed out"]);

    t.push("Still dropped.");
    expect(t.lines.length).toBe(1);
    t.performance.recover();
    t.hands.fail = null;
    t.push("Hm.");
    await t.playOut();
    expect(t.performance.said).toEqual(["Hm."]);
  });

  it("says when what he was doing to their desktop is over, without waiting for his talking", async () => {
    const t = setup();
    let over = false;
    t.push('<press at="e3"/> There you go.');
    void t.performance.changed().then(() => (over = true));
    await settle();
    expect(over).toBe(false);
    t.performs[0].done();
    await settle();
    expect(over).toBe(true);
    expect(t.lines[0].played).toBe(true);
    t.lines[0].started();
    t.lines[0].finished();
    await t.performance.finish();
  });

  it("fails on something he never saw, without setting off", async () => {
    const t = setup();
    t.push('<press at="Save"/> Done.');
    await t.playOut();
    expect(t.performs).toEqual([]);
    expect(t.hands.tried).toEqual([]);
    expect(t.performance.failed?.why).toContain("look into the window first");
    expect(t.performance.said).toEqual([]);
  });

  it("does not open or close the same thing twice in one script, but presses as often as written", async () => {
    const t = setup();
    t.push('<open what="Downloads"/><open what="Downloads"/><close at="w2"/><close at="w2"/><press at="e3"/><press at="e3"/><next/><next/>');
    await t.playOut();
    expect(t.hands.tried).toEqual(["open Downloads", "close 4242", "press Search", "press Search", "next", "next"]);
  });

  it("says what a window takes when told to press one", async () => {
    const t = setup();
    t.push('<press at="w2"/>');
    await t.playOut();
    expect(t.hands.tried).toEqual([]);
    expect(t.performance.failed?.why).toContain("w2 is a window, not something to press");
  });

  it("fails on a window that is not there", async () => {
    const t = setup();
    t.push('<close at="w9"/>');
    await t.playOut();
    expect(t.hands.tried).toEqual([]);
    expect(t.performance.failed?.why).toBe('there is no window "w9"; the windows are w2');
  });

  it("fails when he is stopped before his hand lands", async () => {
    const t = setup();
    t.director.stoppedShort = true;
    t.push('<press at="e3"/> Done.');
    await t.playOut();
    expect(t.hands.tried).toEqual([]);
    expect(t.performance.failed?.why).toBe("something stopped you before you got to it");
  });

  it("changes nothing in a script they did not ask for", async () => {
    const t = setup({ mayAct: false });
    t.push('<close at="w2"/> There. <pause/>');
    await t.playOut();
    expect(t.performs).toEqual([]);
    expect(t.hands.tried).toEqual([]);
    expect(t.performance.failed).toBeNull();
    expect(t.performance.said).toEqual(["There."]);
  });
});

describe("Performance: being cut off", () => {
  it("stops the line he is on and drops the rest", async () => {
    const t = setup();
    t.push("One. <dance/> Two. Three.");
    await settle();
    t.lines[0].started();
    await settle();
    t.performance.cancel();
    await t.performance.finish();

    expect(t.lines.map((l) => [l.stopped, l.discarded])).toEqual([
      [true, false],
      [false, true],
      [false, true],
    ]);
    expect(t.lines.map((l) => l.played)).toEqual([true, false, false]);
    expect(t.performs.map((p) => p.name)).toEqual(["dance"]);
    expect(t.performance.said).toEqual(["One."]);
    expect(t.actor.stopped).toBe(1);
    expect(t.actor.talking).toBe(false);
    expect(t.actor.inSpeech).toBe(false);
    expect(t.paper.hidden).toBe(1);
  });

  it("ignores what is still streaming in afterwards", async () => {
    const t = setup();
    t.performance.cancel();
    t.push("Too late. <dance/>");
    await t.performance.finish();
    expect(t.lines).toEqual([]);
    expect(t.performs).toEqual([]);
  });
});

describe("Performance: errands", () => {
  it("hands a job to Claude Code and shows what it passed on", async () => {
    const t = setup();
    t.push('On it. <agent in="pesto">Fix the flaky test in ears.ts.</agent> Done.');
    await t.playOut();
    expect(t.errands.runs[0]).toMatchObject({ cwd: "X:\\repos\\pesto", prompt: "Fix the flaky test in ears.ts." });
    expect(t.shown.find((s) => s.kind === "note")?.text).toBe("**→ pesto**  Fix the flaky test in ears.ts.");
    expect(t.performance.did).toContain("asked Claude Code (a1) in pesto to: Fix the flaky test in ears.ts.");
  });

  it("sets timers from minutes", async () => {
    const t = setup();
    t.push('<timer min="10" for="tea"/> Ten minutes.');
    await t.playOut();
    expect(t.errands.jobs.timers[0]).toMatchObject({ id: "t1", what: "tea", due: 1_000_000 + 600_000 });
  });

  it("does nothing of the kind when nobody asked", async () => {
    const t = setup({ mayAct: false });
    t.push('<agent in="pesto">delete everything</agent> <timer s="5"/>');
    await t.playOut();
    expect(t.errands.runs).toEqual([]);
    expect(t.errands.jobs.jobs).toEqual([]);
  });

  it("drops the rest when an agent cannot be reached", async () => {
    const t = setup();
    t.push('<reply to="a9">yes</reply> Told it.');
    await t.playOut();
    expect(t.performance.failed?.why).toMatch(/there is no agent a9/);
    expect(t.log).not.toContain("say Told it.");
  });
});
