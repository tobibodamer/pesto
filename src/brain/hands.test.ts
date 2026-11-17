import { describe, expect, it } from "vitest";
import type { MonitorInfo, Openable, WindowInfo } from "../sense/types";
import { handle, pick, placement } from "./hands";

const screen = (id: number, x: number, taskbar = 40): MonitorInfo => ({
  id,
  rect: { x, y: 0, w: 1920, h: 1080 },
  work: { x, y: 0, w: 1920, h: 1080 - taskbar },
  scale: 1,
  primary: id === 0,
});
/** The main screen with a second one to its left and a third to its right, as Windows numbers them. */
const monitors = [screen(0, 0), screen(1, -1920), screen(2, 1920)];
const win = (over: Partial<WindowInfo> = {}): WindowInfo => ({ hwnd: 1, title: "Notes", exe: "notes.exe", pid: 1, rect: { x: 100, y: 100, w: 800, h: 600 }, monitor: 0, state: "normal", ...over });

describe("placement", () => {
  it.each([
    ["left", { x: 0, y: 0, w: 960, h: 1040 }, "to the left half"],
    ["the right side", { x: 960, y: 0, w: 960, h: 1040 }, "to the right half"],
    ["top", { x: 0, y: 0, w: 1920, h: 520 }, "to the top half"],
    ["bottom right", { x: 960, y: 520, w: 960, h: 520 }, "to the bottom right corner"],
    ["upper left", { x: 0, y: 0, w: 960, h: 520 }, "to the top left corner"],
    ["center", { x: 560, y: 220, w: 800, h: 600 }, "to the middle"],
  ])("puts a window %s", (to, rect, words) => {
    expect(placement(to, win(), monitors)).toEqual({ rect, maximize: false, words });
  });

  it("fills the screen", () => {
    expect(placement("full", win(), monitors)).toMatchObject({ maximize: true, words: "to fill the screen" });
  });

  it("moves to a numbered screen, keeping its place there", () => {
    expect(placement("screen 2", win(), monitors)).toEqual({ rect: { x: -1820, y: 100, w: 800, h: 600 }, maximize: false, words: "to screen 2" });
  });

  it("takes a screen and a place together", () => {
    expect(placement("screen 3 left", win(), monitors)).toEqual({ rect: { x: 1920, y: 0, w: 960, h: 1040 }, maximize: false, words: "to the left half on screen 3" });
  });

  it("goes to the next screen to the right, and round to the first", () => {
    expect(placement("next screen", win(), monitors)?.words).toBe("to screen 3");
    expect(placement("next screen", win({ monitor: 2, rect: { x: 2020, y: 100, w: 800, h: 600 } }), monitors)?.words).toBe("to screen 2");
    expect(placement("previous screen", win(), monitors)?.words).toBe("to screen 2");
  });

  it("keeps a maximised window maximised on the screen it moves to", () => {
    const moved = placement("next screen", win({ state: "maximized", rect: { x: 0, y: 0, w: 1920, h: 1040 } }), monitors);
    expect(moved).toMatchObject({ maximize: true, words: "to screen 3" });
    expect(moved!.rect.x).toBeGreaterThanOrEqual(1920);
  });

  it("gives a minimised window a roomy place instead of where it is hidden", () => {
    const moved = placement("center", win({ state: "minimized", rect: { x: -32000, y: -32000, w: 160, h: 28 } }), monitors);
    expect(moved!.rect).toEqual({ x: 288, y: 130, w: 1344, h: 780 });
  });

  it("knows no place in other words, a screen that is not there, or the screen it is on", () => {
    expect(placement("over there", win(), monitors)).toBeNull();
    expect(placement("screen 7", win(), monitors)).toBeNull();
    expect(placement("screen 1", win(), monitors)).toBeNull();
  });
});

describe("handle", () => {
  it("finds the caption buttons from the right edge, larger on a scaled screen", () => {
    expect(handle(win(), "close", 1)).toEqual({ x: 777, y: 16 });
    expect(handle(win(), "maximize", 1)).toEqual({ x: 731, y: 16 });
    expect(handle(win(), "minimize", 1.5)).toEqual({ x: 627.5, y: 24 });
    expect(handle(win(), "move", 1)).toEqual({ x: 400, y: 16 });
  });
});

describe("pick", () => {
  const apps: Openable[] = ["Spotify", "Google Chrome", "Chrome Remote Desktop", "Visual Studio Code", "Visual Studio 2022", "Word", "WordPad", "Downloads", "Firefox"].map((name) => ({ name, target: name }));
  const hit = (asked: string) => pick(asked, apps).hit?.name ?? null;
  const close = (asked: string) => pick(asked, apps).close.map((c) => c.name);

  it("takes an exact name however it is written", () => {
    expect(hit("spotify")).toBe("Spotify");
    expect(hit("  Visual-Studio code ")).toBe("Visual Studio Code");
    expect(hit("word")).toBe("Word");
  });

  it("takes the one name that holds what was asked", () => {
    expect(hit("fire")).toBe("Firefox");
    expect(hit("vs code")).toBeNull();
    expect(hit("studio 2022")).toBe("Visual Studio 2022");
    expect(hit("the spotify app")).toBe("Spotify");
  });

  it("offers the names it could be when several fit as well", () => {
    expect(hit("chrome")).toBeNull();
    expect(close("chrome")).toEqual(["Google Chrome", "Chrome Remote Desktop"]);
    expect(close("visual studio")).toEqual(["Visual Studio Code", "Visual Studio 2022"]);
  });

  it("offers what looks alike when nothing fits", () => {
    expect(close("spotfy")).toEqual(["Spotify"]);
    expect(close("zzz")).toEqual([]);
  });
});
