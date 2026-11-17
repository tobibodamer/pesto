import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Config } from "../config";
import { saveConfig } from "../config";
import type { World } from "../world/world";
import { Jobs, type HookEvent, type Job, type Project, type RunEvent } from "./jobs";

const STORE = "pesto.jobs";
/** Apps in which they see a Claude Code session stop for themselves. */
const DESKS = /^(windowsterminal|wt|cmd|powershell|pwsh|code|cursor|windsurf|claude|alacritty|wezterm-gui|conhost|idea64|webstorm64|zed)\.exe$/i;
/** Seconds since they last touched anything for them still to count as at their desk. */
const AT_DESK = 30;

function load(): Job[] {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "[]") as Job[];
  } catch {
    return [];
  }
}

function save(jobs: Job[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(jobs));
  } catch {
    // Only the errands are lost across a restart.
  }
}

/** Puts his hooks into Claude Code's settings, or takes them out, to match `config.agents.watch`. */
export async function syncHooks(config: Config, force = false) {
  const { watch, port, token } = config.agents;
  if (!force && watch === (await invoke<boolean>("agent_hooks_on").catch(() => false))) return;
  await invoke("agent_hooks", { on: watch, port, token }).catch((err) => console.warn("agents: hooks not changed", err));
}

/** His errands, connected to Claude Code through the Rust side. */
export async function connectJobs(config: Config, world: World): Promise<Jobs> {
  if (!config.agents.token) {
    config.agents.token = crypto.randomUUID();
    void saveConfig({ agents: { token: config.agents.token } });
  }
  const jobs = new Jobs({
    run: (args) => invoke("agent_run", { args: { ...args, command: config.agents.command, model: config.agents.model } }),
    stop: (job) => invoke("agent_stop", { job }),
    projects: () => invoke<Project[]>("agent_projects"),
    permissionMode: () => config.agents.permissionMode,
    now: () => Date.now(),
    atDesk: () => {
      const win = world.window(world.foreground);
      return !!win && DESKS.test(win.exe) && world.system.idleMs < AT_DESK * 1000;
    },
    load,
    save,
  });
  await listen<RunEvent>("agent://run", (e) => jobs.onRun(e.payload));
  await listen<HookEvent>("agent://hook", (e) => jobs.onHook(e.payload));
  await listenForHooks(config);
  await syncHooks(config);
  return jobs;
}

/** Opens the port the hooks post to. A new port takes over from the old one. */
export function listenForHooks(config: Config) {
  return invoke("agent_listen", { port: config.agents.port, token: config.agents.token }).catch((err) => console.warn("agents: not listening for hooks", err));
}
