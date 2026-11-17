import { Fumble } from "./hands";

/**
 * Things he keeps going for them after a wake is over: timers, and coding
 * agents. Agents are Claude Code runs he starts himself, and the person's own
 * sessions, which tell him through hooks when they stop or ask for something.
 * Whatever needs them becomes news, which wakes him to pass it on.
 */

export interface Timer {
  kind: "timer";
  id: string;
  what: string;
  /** Epoch ms. */
  due: number;
}

export interface Denial {
  /** What it was not allowed to do, in a few words. */
  what: string;
  /** The permission rule that allows it next time. */
  rule: string;
}

export type AgentState =
  /** On it. */
  | "working"
  /** Finished its turn and waits for what they say next. */
  | "waiting"
  /** Waits in its own window for them to approve or answer something. */
  | "asking"
  /** Its run broke off. */
  | "failed"
  /** Stopped by him, or lost when he was restarted. */
  | "stopped"
  /** One of their sessions that they have closed. */
  | "closed";

export interface Agent {
  kind: "agent";
  id: string;
  /** The folder it works in. */
  cwd: string;
  /** The project, for saying out loud. */
  name: string;
  /** Started or taken over by him, so he gets its whole run and may continue it. */
  own: boolean;
  session?: string;
  /** What it was last asked. */
  task: string;
  state: AgentState;
  /** What it is doing right now, while it works. */
  step?: string;
  /** Its last message. */
  said?: string;
  /** What it asks for in its own window. */
  asking?: string;
  /** What it was not allowed to do in its last run. */
  denials?: Denial[];
  /** Claude Code's permission mode for the session. */
  mode?: string;
  /** Epoch ms of the last change. */
  since: number;
  /** Continued under a new session, apart from the one still open in their window. */
  forked?: boolean;
}

export type Job = Timer | Agent;

export interface RunArgs {
  job: string;
  cwd: string;
  prompt: string;
  resume: string | null;
  fork: boolean;
  permissionMode: string;
  allow: string[];
}

export type RunEvent =
  | { kind: "session"; job: string; session: string }
  | { kind: "step"; job: string; text: string }
  | { kind: "done"; job: string; session: string; result: string; failed: boolean; denials: Denial[]; cost: number }
  | { kind: "ended"; job: string; why: string };

/** One of their own sessions, as its hooks describe it. */
export interface HookEvent {
  event: "UserPromptSubmit" | "Stop" | "Notification" | "SessionEnd" | string;
  session: string;
  cwd: string;
  subagent: boolean;
  permissionMode: string | null;
  title: string | null;
  said: string | null;
  message: string | null;
  type: string | null;
  prompt: string | null;
  reason: string | null;
}

export interface Project {
  name: string;
  path: string;
}

export interface JobsDeps {
  /** Starts or continues a run of Claude Code. Rejects with why when it cannot. */
  run(args: RunArgs): Promise<void>;
  stop(job: string): Promise<void>;
  projects(): Promise<Project[]>;
  permissionMode(): string;
  /** Epoch ms. */
  now(): number;
  /** Whether they are at their keyboard in a terminal or editor, where they see a session stop for themselves. */
  atDesk(): boolean;
  load(): Job[];
  save(jobs: Job[]): void;
}

const SAID_IN_SNAPSHOT = 400;
const SAID_IN_NEWS = 1500;
/** Agents nothing has happened to for this long are left out of what he is told. */
const STALE = 12 * 3600_000;
const KEPT = 24;
/** Notifications that mean a session waits on them in its own window. */
const ASKS = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

const clip = (s: string, most: number) => (s.length > most ? `${s.slice(0, most)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function projectName(cwd: string): string {
  const s = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const tree = /^(.*)\/\.claude\/worktrees\/([^/]+)/.exec(s);
  if (tree) return `${tree[1].split("/").pop()} (${tree[2]})`;
  return s.split("/").pop() || s;
}

export function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function inTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

export class Jobs {
  jobs: Job[] = [];
  /** What has happened that they should hear about, oldest first. */
  news: string[] = [];
  private projectList: { at: number; items: Project[] } | null = null;

  constructor(private deps: JobsDeps) {
    for (const job of deps.load()) {
      if (job.kind === "agent" && job.own && job.state === "working") {
        job.state = "stopped";
        job.step = "Pesto was restarted while it worked; it may have finished anyway";
      }
      this.jobs.push(job);
    }
  }

  private save() {
    const now = this.deps.now();
    const fresh = this.jobs.filter((j) => j.kind === "timer" || now - j.since < STALE * 2);
    this.jobs = fresh.slice(-KEPT);
    this.deps.save(this.jobs);
  }

  private nextId(prefix: "t" | "a") {
    const used = new Set(this.jobs.map((j) => j.id));
    let n = 1;
    while (used.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  get timers() {
    return this.jobs.filter((j): j is Timer => j.kind === "timer");
  }

  get agents() {
    return this.jobs.filter((j): j is Agent => j.kind === "agent");
  }

  get(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id.trim());
  }

  private agentBySession(session: string) {
    return this.agents.find((a) => a.session === session);
  }

  // ---- Timers ----

  timer(seconds: number, what: string): string {
    if (!(seconds > 0)) throw new Fumble('a timer needs a length in seconds, as in <timer s="600" for="tea"/>');
    const timer: Timer = { kind: "timer", id: this.nextId("t"), what: what.trim() || "a timer", due: this.deps.now() + seconds * 1000 };
    this.jobs.push(timer);
    this.save();
    return `set timer ${timer.id} for ${timer.what}, ${inTime(seconds * 1000)}`;
  }

  /** Call often. Rings the timers that are due. */
  tick() {
    const now = this.deps.now();
    const due = this.timers.filter((t) => t.due <= now);
    if (!due.length) return;
    for (const t of due) this.news.push(`Timer ${t.id} for ${t.what} has run out${now - t.due > 120_000 ? ` (${ago(now - t.due)}, while you were not running)` : ""}.`);
    this.jobs = this.jobs.filter((j) => !due.includes(j as Timer));
    this.save();
  }

  // ---- Agents ----

  async projects(): Promise<Project[]> {
    const now = this.deps.now();
    if (!this.projectList || now - this.projectList.at > 120_000) this.projectList = { at: now, items: await this.deps.projects().catch(() => []) };
    return this.projectList.items;
  }

  /** The folder a project name or path means. */
  async where(asked: string): Promise<{ cwd: string; name: string }> {
    const q = asked.trim();
    if (/^[a-z]:[\\/]/i.test(q) || q.startsWith("\\\\")) return { cwd: q, name: projectName(q) };
    const known = [...(await this.projects()), ...this.agents.map((a) => ({ name: a.name, path: a.cwd }))];
    const want = plain(q);
    const exact = known.find((p) => plain(p.name) === want);
    const hit = exact ?? known.find((p) => plain(p.name).includes(want) && want.length >= 3);
    if (hit) return { cwd: hit.path, name: projectName(hit.path) };
    const names = [...new Set(known.map((p) => p.name))].slice(0, 12).join(", ");
    throw new Fumble(`there is no project called "${q}"; the ones Claude Code knows are ${names || "none"}. A full folder path works too`);
  }

  /** Has Claude Code start on `task` in a project. */
  async start(project: string, task: string): Promise<{ said: string; agent: Agent }> {
    if (!task.trim()) throw new Fumble("say what it should do, as in <agent in=\"pesto\">fix the failing test</agent>");
    const { cwd, name } = await this.where(project);
    const agent: Agent = { kind: "agent", id: this.nextId("a"), cwd, name, own: true, task: clip(oneLine(task), 300), state: "working", since: this.deps.now(), mode: this.deps.permissionMode() };
    await this.launch(agent, task, null, false, []);
    this.jobs.push(agent);
    this.save();
    return { said: `asked Claude Code (${agent.id}) in ${name} to: ${clip(task.trim(), 120)}`, agent };
  }

  /** Passes on what they say to an agent that waits, continuing its session. */
  async reply(id: string, text: string, allow: boolean): Promise<{ said: string; agent: Agent }> {
    const agent = this.get(id);
    if (!agent || agent.kind !== "agent") throw new Fumble(`there is no agent ${id}; the agents are ${this.agents.map((a) => a.id).join(", ") || "none"}`);
    if (!text.trim()) throw new Fumble("say what to tell it");
    if (!agent.session) throw new Fumble(`${agent.id} has no session to continue yet`);
    if (agent.state === "working") throw new Fumble(`${agent.id} is still working; wait until it stops, or cancel it first`);
    if (agent.state === "asking" && !agent.own) throw new Fumble(`${agent.id} waits for them in its own window: ${agent.asking ?? "it asks for something"}. They have to answer it there`);
    // Their own session may still be open in a window of theirs; it carries on apart from that one.
    const fork = !agent.own && agent.state !== "closed";
    const rules = allow ? (agent.denials ?? []).map((d) => d.rule) : [];
    await this.launch(agent, text, agent.session, fork, rules);
    Object.assign(agent, { own: true, task: clip(oneLine(text), 300), state: "working", step: undefined, asking: undefined, since: this.deps.now() });
    if (fork) agent.forked = true;
    this.save();
    const allowed = rules.length ? `, allowing ${agent.denials!.map((d) => d.what).join(", ")}` : "";
    return { said: `told ${agent.id} in ${agent.name}: ${clip(text.trim(), 120)}${allowed}${fork ? ". It goes on as a copy of the session, apart from the one in their window" : ""}`, agent };
  }

  private async launch(agent: Agent, prompt: string, resume: string | null, fork: boolean, allow: string[]) {
    try {
      await this.deps.run({ job: agent.id, cwd: agent.cwd, prompt, resume, fork, permissionMode: agent.mode || this.deps.permissionMode(), allow });
    } catch (why) {
      throw new Fumble(String(why));
    }
  }

  async cancel(id: string): Promise<string> {
    const job = this.get(id);
    if (!job) throw new Fumble(`there is nothing called ${id}`);
    if (job.kind === "timer") {
      this.jobs = this.jobs.filter((j) => j !== job);
      this.save();
      return `cancelled timer ${job.id} for ${job.what}`;
    }
    if (!job.own || job.state !== "working") throw new Fumble(`${job.id} is not a run of yours that is working; there is nothing to stop`);
    job.state = "stopped";
    job.since = this.deps.now();
    this.save();
    await this.deps.stop(job.id);
    return `stopped ${job.id} in ${job.name}`;
  }

  /** What one of his runs reports. */
  onRun(e: RunEvent) {
    const agent = this.get(e.job);
    if (!agent || agent.kind !== "agent") return;
    if (e.kind === "session") agent.session = e.session;
    else if (e.kind === "step") agent.step = e.text;
    else if (agent.state !== "stopped") {
      agent.step = undefined;
      agent.since = this.deps.now();
      if (e.kind === "done") {
        if (e.session) agent.session = e.session;
        agent.said = e.result;
        agent.denials = e.denials;
        agent.state = e.failed ? "failed" : "waiting";
      } else {
        agent.state = "failed";
        agent.said = e.why;
      }
      this.news.push(this.newsOf(agent));
    }
    this.save();
  }

  /** What one of their own sessions reports through its hooks. */
  onHook(e: HookEvent) {
    if (!e.session || e.subagent) return;
    let agent = this.agentBySession(e.session);
    // His own runs report everything through their output already.
    if (agent?.own) return;
    const now = this.deps.now();
    if (!agent) {
      if (e.event === "SessionEnd") return;
      agent = { kind: "agent", id: this.nextId("a"), cwd: e.cwd, name: projectName(e.cwd), own: false, session: e.session, task: "", state: "working", since: now };
      this.jobs.push(agent);
    }
    if (e.permissionMode) agent.mode = e.permissionMode;
    if (e.title) agent.task = oneLine(e.title);
    let tell = false;
    if (e.event === "UserPromptSubmit") {
      Object.assign(agent, { state: "working", asking: undefined, since: now });
      if (!e.title && e.prompt) agent.task = clip(oneLine(e.prompt), 300);
    } else if (e.event === "Stop") {
      Object.assign(agent, { state: "waiting", said: e.said ?? "", asking: undefined, since: now });
      tell = true;
    } else if (e.event === "Notification" && e.type && ASKS.has(e.type)) {
      Object.assign(agent, { state: "asking", asking: e.message ?? "it needs them", since: now });
      tell = true;
    } else if (e.event === "SessionEnd") {
      Object.assign(agent, { state: "closed", since: now });
    }
    if (tell && !this.deps.atDesk()) this.news.push(this.newsOf(agent));
    this.save();
  }

  private newsOf(a: Agent): string {
    const where = `Claude Code ${a.id} in ${a.name}${a.own ? " (the one you set going)" : ""}`;
    const said = a.said ? ` It said: «${clip(a.said, SAID_IN_NEWS)}»` : "";
    const denied = a.denials?.length ? ` It was not allowed to ${a.denials.map((d) => d.what).join(", ")}; with their yes you can reply with allow="yes".` : "";
    if (a.state === "asking") return `${where} is waiting for them in its own window: ${a.asking}`;
    if (a.state === "failed") return `${where} broke off: ${clip(a.said ?? "", 300)}`;
    return `${where} has finished and waits for them.${said}${denied}`;
  }

  /** Takes what has happened since he last passed news on. */
  takeNews(): string[] {
    const out = this.news;
    this.news = [];
    return out;
  }

  /** What he knows about his errands, for each wake. Empty when there are none. */
  describe(projects: Project[] = []): string {
    const now = this.deps.now();
    const lines: string[] = [];
    if (projects.length) lines.push(`Projects Claude Code can work in: ${[...new Set(projects.map((p) => p.name))].join(", ")}.`);
    for (const t of this.timers) lines.push(`Timer ${t.id} for ${t.what}: rings in ${inTime(t.due - now)}.`);
    const agents = this.agents.filter((a) => now - a.since < STALE);
    for (const a of agents) {
      const head = `${a.id} in ${a.name}${a.own ? ", yours" : ""}${a.forked ? " (a copy of their session)" : ""}`;
      const task = a.task ? `, on «${clip(a.task, 100)}»` : "";
      const when = ago(now - a.since);
      if (a.state === "working") lines.push(`${head}: working${task}${a.step ? `, now: ${a.step}` : ""} (since ${when}).`);
      else if (a.state === "asking") lines.push(`${head}: waiting in its own window for them: ${clip(a.asking ?? "", 160)} (${when}).`);
      else if (a.state === "waiting") lines.push(`${head}: finished ${when}${task}, waiting for them. It said: «${clip(a.said ?? "", SAID_IN_SNAPSHOT)}»${a.denials?.length ? ` Not allowed: ${a.denials.map((d) => d.what).join(", ")}.` : ""}`);
      else if (a.state === "closed") lines.push(`${head}: they closed its window ${when}${task}; you can still continue it with a reply.${a.said ? ` Its last words: «${clip(a.said, SAID_IN_SNAPSHOT)}»` : ""}`);
      else lines.push(`${head}: ${a.state} ${when}${a.said ? `: ${clip(a.said, 160)}` : ""}.`);
    }
    if (!lines.length) return "";
    return `Your errands:\n${lines.map((l) => `  ${l}`).join("\n")}`;
  }
}
