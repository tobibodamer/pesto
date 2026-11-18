import { describe, expect, it } from "vitest";
import { Can } from "../can/can";
import { World } from "../world/world";
import { Actor } from "./actor";

function setup() {
  const actor = new Actor(new World(), new Can());
  const heard: string[] = [];
  let brokeOff = 0;
  actor.on("cue", (name) => heard.push(name));
  actor.on("brokeOff", () => brokeOff++);
  return { actor, heard, brokeOffs: () => brokeOff };
}

describe("sounds while he talks", () => {
  it("plays everything when he is not talking", () => {
    const { actor, heard } = setup();
    for (const name of ["chitter", "huh", "eep", "knock"]) actor.cue(name);
    expect(heard).toEqual(["chitter", "huh", "eep", "knock"]);
  });

  it("leaves out noises from his mouth but keeps blurts and bumps", () => {
    const { actor, heard, brokeOffs } = setup();
    actor.inSpeech = true;
    for (const name of ["chitter", "huh", "sniff", "mutter", "eep", "gasp", "yelp", "knock", "thud", "lid"]) actor.cue(name);
    expect(heard).toEqual(["eep", "gasp", "yelp", "knock", "thud", "lid"]);
    expect(brokeOffs()).toBe(0);
  });

  it("breaks off his reply for a sound that should", () => {
    const { actor, heard, brokeOffs } = setup();
    actor.inSpeech = true;
    actor.on("brokeOff", () => (actor.inSpeech = false));
    actor.cue("dizzy", { breaksOff: true });
    expect(brokeOffs()).toBe(1);
    expect(heard).toEqual(["dizzy"]);
  });

  it("makes no noise of effort mid-reply, even between sentences", () => {
    const { actor, heard } = setup();
    actor.inSpeech = true;
    for (let i = 0; i < 20; i++) actor.strain("breath", 1);
    expect(heard).toEqual([]);
  });
});
