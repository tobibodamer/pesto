import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { World } from "../world/world";
import type { Rect, SenseCommands, SenseEvents, SenseSnapshot } from "./types";

type Command = keyof SenseCommands;

/** Calls a Rust command with the argument and return types from the contract. */
export function call<K extends Command>(
  name: K,
  ...args: Parameters<SenseCommands[K]> extends [infer A] ? [A] : []
): Promise<ReturnType<SenseCommands[K]>> {
  return invoke(name, args[0] as Record<string, unknown> | undefined);
}

function on<K extends keyof SenseEvents>(name: K, fn: (payload: SenseEvents[K]) => void) {
  return listen<SenseEvents[K]>(name, (e) => fn(e.payload));
}

/** Feeds the world from the Rust sense layer: one snapshot, then live events. */
export async function connectSenses(world: World) {
  await Promise.all([
    on("sense://monitors", (e) => world.setMonitors(e)),
    on("sense://windows", (e) => world.setWindows(e)),
    on("sense://cursor", (e) => world.setCursor(e)),
    on("sense://audio", (e) => world.setAudio(e)),
    on("sense://media", (e) => world.setMedia(e)),
    on("sense://system", (e) => world.setSystem(e)),
    on("sense://focus", (e) => world.setFocus(e)),
  ]);
  const snap: SenseSnapshot = await call("sense_snapshot");
  world.setMonitors(snap.monitors);
  world.setWindows(snap.windows);
  world.setCursor(snap.cursor);
  world.setAudio(snap.audio);
  world.setMedia(snap.media);
  world.setSystem(snap.system);
  world.setFocus(snap.focus);
}

let lastRegions = "";

/** Tells Rust where the overlay should catch the mouse. Cheap to call every frame. */
export function setHitRegions(regions: Rect[]) {
  const rounded = regions.map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }));
  const key = JSON.stringify(rounded);
  if (key === lastRegions) return;
  lastRegions = key;
  void call("overlay_set_hit_regions", { regions: rounded });
}

let holding = false;

export function holdInteractive(hold: boolean) {
  if (hold === holding) return;
  holding = hold;
  void call("overlay_hold_interactive", { hold });
}
