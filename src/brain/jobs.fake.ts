/** A Jobs with everything it would ask the desktop for faked, for tests. */
import { Jobs, type Job, type JobsDeps, type RunArgs } from "./jobs";

export function fakeJobs(over: Partial<JobsDeps> & { stored?: Job[] } = {}) {
  const clock = { now: 1_000_000 };
  const runs: RunArgs[] = [];
  const stopped: string[] = [];
  const saved: Job[][] = [];
  const desk = { at: false };
  const jobs = new Jobs({
    run: async (args) => void runs.push(args),
    stop: async (job) => void stopped.push(job),
    projects: async () => [
      { name: "pesto", path: "X:\\repos\\pesto" },
      { name: "luna-ai", path: "X:\\repos\\luna-ai" },
    ],
    permissionMode: () => "acceptEdits",
    now: () => clock.now,
    atDesk: () => desk.at,
    load: () => structuredClone(over.stored ?? []),
    save: (all) => void saved.push(structuredClone(all)),
    ...over,
  });
  return { jobs, clock, runs, stopped, saved, desk };
}
