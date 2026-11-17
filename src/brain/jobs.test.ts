import { describe, expect, it } from "vitest";
import { Fumble } from "./hands";
import { fakeJobs } from "./jobs.fake";
import { projectName, type HookEvent } from "./jobs";

const hook = (e: Partial<HookEvent>): HookEvent => ({
  event: "Stop",
  session: "s-theirs",
  cwd: "X:\\repos\\luna-ai",
  subagent: false,
  permissionMode: "default",
  title: null,
  said: null,
  message: null,
  type: null,
  prompt: null,
  reason: null,
  ...e,
});

describe("Jobs: timers", () => {
  it("rings once when due, and is gone after", () => {
    const t = fakeJobs();
    expect(t.jobs.timer(600, "tea")).toBe("set timer t1 for tea, 10 min");
    t.clock.now += 540_000;
    t.jobs.tick();
    expect(t.jobs.news).toEqual([]);
    expect(t.jobs.describe()).toContain("Timer t1 for tea: rings in 60 s.");
    t.clock.now += 60_000;
    t.jobs.tick();
    t.jobs.tick();
    expect(t.jobs.takeNews()).toEqual(["Timer t1 for tea has run out."]);
    expect(t.jobs.timers).toEqual([]);
  });

  it("rings a timer that ran out while he was not running, saying so", () => {
    const t = fakeJobs({ stored: [{ kind: "timer", id: "t1", what: "pasta", due: 1_000_000 - 600_000 }] });
    t.jobs.tick();
    expect(t.jobs.takeNews()[0]).toMatch(/pasta has run out \(10 min ago/);
  });

  it("can be cancelled", async () => {
    const t = fakeJobs();
    t.jobs.timer(60, "eggs");
    expect(await t.jobs.cancel("t1")).toBe("cancelled timer t1 for eggs");
    expect(t.jobs.jobs).toEqual([]);
  });

  it("refuses a timer without a length", () => {
    expect(() => fakeJobs().jobs.timer(0, "x")).toThrow(Fumble);
  });
});

describe("Jobs: agents he starts", () => {
  it("starts Claude Code in the project named, and hears it finish", async () => {
    const t = fakeJobs();
    const { said, agent } = await t.jobs.start("Pesto", "fix the flaky test");
    expect(said).toBe("asked Claude Code (a1) in pesto to: fix the flaky test");
    expect(agent.cwd).toBe("X:\\repos\\pesto");
    expect(t.runs[0]).toEqual({ job: "a1", cwd: "X:\\repos\\pesto", prompt: "fix the flaky test", resume: null, fork: false, permissionMode: "acceptEdits", allow: [] });

    t.jobs.onRun({ kind: "session", job: "a1", session: "s1" });
    t.jobs.onRun({ kind: "step", job: "a1", text: "Running the tests" });
    expect(t.jobs.describe()).toContain("a1 in pesto, yours: working, on «fix the flaky test», now: Running the tests");
    t.jobs.onRun({ kind: "done", job: "a1", session: "s1", result: "Fixed. Want me to commit?", failed: false, denials: [], cost: 0.1 });
    expect(t.jobs.takeNews()).toEqual(["Claude Code a1 in pesto (the one you set going) has finished and waits for them. It said: «Fixed. Want me to commit?»"]);
  });

  it("continues its own session in place, and can allow what was refused", async () => {
    const t = fakeJobs();
    await t.jobs.start("pesto", "download the page");
    t.jobs.onRun({ kind: "done", job: "a1", session: "s1", result: "I was not allowed.", failed: false, denials: [{ what: "run `curl x`", rule: "Bash(curl x)" }], cost: 0 });
    expect(t.jobs.takeNews()[0]).toContain('It was not allowed to run `curl x`; with their yes you can reply with allow="yes".');
    const { said } = await t.jobs.reply("a1", "go ahead", true);
    expect(said).toBe("told a1 in pesto: go ahead, allowing run `curl x`");
    expect(t.runs[1]).toMatchObject({ resume: "s1", fork: false, allow: ["Bash(curl x)"] });
  });

  it("will not reply to one that is still working, and stops it on cancel", async () => {
    const t = fakeJobs();
    await t.jobs.start("pesto", "x");
    t.jobs.onRun({ kind: "session", job: "a1", session: "s1" });
    await expect(t.jobs.reply("a1", "and y", false)).rejects.toThrow(/still working/);
    expect(await t.jobs.cancel("a1")).toBe("stopped a1 in pesto");
    expect(t.stopped).toEqual(["a1"]);
    t.jobs.onRun({ kind: "ended", job: "a1", why: "stopped" });
    expect(t.jobs.news).toEqual([]);
  });

  it("says which projects there are when the name is unknown", async () => {
    await expect(fakeJobs().jobs.start("nope", "x")).rejects.toThrow(/pesto, luna-ai/);
  });

  it("takes a full path as a project", async () => {
    const t = fakeJobs();
    await t.jobs.start("D:\\work\\shop", "x");
    expect(t.runs[0].cwd).toBe("D:\\work\\shop");
  });

  it("forgets a run that was going when he was restarted", () => {
    const t = fakeJobs({ stored: [{ kind: "agent", id: "a1", cwd: "c", name: "c", own: true, task: "x", state: "working", since: 1_000_000, session: "s1" }] });
    expect(t.jobs.agents[0].state).toBe("stopped");
  });
});

describe("Jobs: their own sessions", () => {
  it("passes on that a session finished, unless they are at their desk", () => {
    const t = fakeJobs();
    t.jobs.onHook(hook({ event: "UserPromptSubmit", prompt: "add the approvals page" }));
    expect(t.jobs.agents[0]).toMatchObject({ id: "a1", own: false, state: "working", task: "add the approvals page", name: "luna-ai" });
    t.desk.at = true;
    t.jobs.onHook(hook({ said: "Done." }));
    expect(t.jobs.news).toEqual([]);
    t.desk.at = false;
    t.jobs.onHook(hook({ event: "UserPromptSubmit", prompt: "now the tests" }));
    t.jobs.onHook(hook({ said: "Tests pass." }));
    expect(t.jobs.takeNews()).toEqual(["Claude Code a1 in luna-ai has finished and waits for them. It said: «Tests pass.»"]);
  });

  it("answers a session still open in their window as a copy of it", async () => {
    const t = fakeJobs();
    t.jobs.onHook(hook({ said: "Shall I go on?" }));
    const { said } = await t.jobs.reply("a1", "yes", false);
    expect(said).toContain("as a copy of the session");
    expect(t.runs[0]).toMatchObject({ cwd: "X:\\repos\\luna-ai", resume: "s-theirs", fork: true, permissionMode: "default" });
    expect(t.jobs.agents[0]).toMatchObject({ own: true, forked: true, state: "working" });
    // From now on its own run reports, and the old session's hooks no longer match it.
    t.jobs.onRun({ kind: "session", job: "a1", session: "s-copy" });
    t.jobs.onHook(hook({ said: "late" }));
    expect(t.jobs.agents).toHaveLength(2);
  });

  it("continues a session they closed in place", async () => {
    const t = fakeJobs();
    t.jobs.onHook(hook({ said: "Done." }));
    t.jobs.onHook(hook({ event: "SessionEnd", reason: "prompt_input_exit" }));
    expect(t.jobs.describe()).toContain("a1 in luna-ai: they closed its window just now; you can still continue it with a reply. Its last words: «Done.»");
    await t.jobs.reply("a1", "one more thing", false);
    expect(t.runs[0]).toMatchObject({ resume: "s-theirs", fork: false });
  });

  it("tells them a session waits in its window, and leaves answering it to them", async () => {
    const t = fakeJobs();
    t.jobs.onHook(hook({ event: "Notification", type: "permission_prompt", message: "Claude needs your permission to use Bash" }));
    expect(t.jobs.takeNews()).toEqual(["Claude Code a1 in luna-ai is waiting for them in its own window: Claude needs your permission to use Bash"]);
    await expect(t.jobs.reply("a1", "yes", false)).rejects.toThrow(/answer it there/);
  });

  it("ignores subagents, idle reminders, and his own runs", async () => {
    const t = fakeJobs();
    t.jobs.onHook(hook({ subagent: true }));
    t.jobs.onHook(hook({ event: "Notification", type: "idle_prompt", message: "waiting" }));
    expect(t.jobs.news).toEqual([]);
    await t.jobs.start("pesto", "x");
    t.jobs.onRun({ kind: "session", job: "a2", session: "mine" });
    t.jobs.onHook(hook({ session: "mine", said: "hi" }));
    expect(t.jobs.agents.filter((a) => a.session === "mine")).toHaveLength(1);
    expect(t.jobs.news).toEqual([]);
  });
});

describe("projectName", () => {
  it("names worktrees by their repository", () => {
    expect(projectName("X:\\repos\\pesto")).toBe("pesto");
    expect(projectName("X:\\repos\\pesto\\.claude\\worktrees\\brave-fox")).toBe("pesto (brave-fox)");
    expect(projectName("/home/me/shop/")).toBe("shop");
  });
});
