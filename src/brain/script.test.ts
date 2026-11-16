import { describe, expect, it } from "vitest";
import { ScriptParser, parseScript, type ScriptItem } from "./script";

const say = (text: string): ScriptItem => ({ kind: "say", text });
const act = (name: string, attrs: Record<string, string> = {}, body?: string): ScriptItem => (body === undefined ? { kind: "do", name, attrs } : { kind: "do", name, attrs, body });

/** Feeds a script in pieces, as a stream would deliver it. */
function stream(chunks: string[]) {
  const items: ScriptItem[] = [];
  const parser = new ScriptParser((item) => items.push(item));
  return {
    items,
    parser,
    run() {
      chunks.forEach((c) => parser.feed(c));
      parser.end();
      return items;
    },
  };
}

describe("parseScript", () => {
  it("speaks bare text one sentence at a time", () => {
    expect(parseScript("Oh. We're doing this again? Cool cool cool.")).toEqual([say("Oh."), say("We're doing this again?"), say("Cool cool cool.")]);
  });

  it("keeps a closing quote or bracket with its sentence", () => {
    expect(parseScript('He said "no." Then he left.')).toEqual([say('He said "no."'), say("Then he left.")]);
  });

  it("puts directions between the words around them", () => {
    expect(parseScript('<emote as="smug"/> Look <point at="cursor"/> there.')).toEqual([act("emote", { as: "smug" }), say("Look"), act("point", { at: "cursor" }), say("there.")]);
  });

  it("reads a direction written without the closing slash", () => {
    expect(parseScript('<go to="w2">')).toEqual([act("go", { to: "w2" })]);
  });

  it("lowercases names and reads several attributes", () => {
    expect(parseScript('<Tap at="e12" as="smug" s="2"/>')).toEqual([act("tap", { at: "e12", as: "smug", s: "2" })]);
  });

  it("shows the text of a sign or a note instead of speaking it", () => {
    expect(parseScript('Fine. <sign>23 min.</sign> <note s="8">Buy\nmilk.</note>')).toEqual([say("Fine."), act("sign", {}, "23 min."), act("note", { s: "8" }, "Buy\nmilk.")]);
  });

  it("treats tags inside a sign as part of nothing", () => {
    expect(parseScript("<sign>no <b>more</b> tabs</sign>")).toEqual([act("sign", {}, "no more tabs")]);
  });

  it("still shows a sign the model never closed", () => {
    expect(parseScript("<sign>23 min.")).toEqual([act("sign", {}, "23 min.")]);
  });

  it("drops stray closing tags", () => {
    expect(parseScript("Done.</point> Really.")).toEqual([say("Done."), say("Really.")]);
  });

  it("speaks a lone < as ordinary text", () => {
    expect(parseScript("3 < 5, obviously.")).toEqual([say("3 < 5, obviously.")]);
    expect(parseScript("ends with <")).toEqual([say("ends with <")]);
  });

  it("strips markdown and collapses whitespace", () => {
    expect(parseScript("**Really**   `now`,\n# go.")).toEqual([say("Really now, go.")]);
  });

  it("keeps delivery tags in square brackets for the voice", () => {
    expect(parseScript("[snorts] Sure.")).toEqual([say("[snorts] Sure.")]);
  });

  it("says nothing for an empty or whitespace-only script", () => {
    expect(parseScript("  \n ")).toEqual([]);
  });
});

describe("ScriptParser, streaming", () => {
  it("gives the same items however the text is cut up", () => {
    const text = '<emote as="smug"/> Oh, again? <go to="w2"/> Cool. <sign>23 min.</sign> That one. <point at="10, 20"/>';
    const whole = parseScript(text);
    for (const size of [1, 2, 3, 7, 13]) {
      const chunks = text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))!;
      expect(stream(chunks).run(), `in pieces of ${size}`).toEqual(whole);
    }
  });

  it("hands over a sentence as soon as the next one begins", () => {
    const s = stream([]);
    s.parser.feed("First one. Sec");
    expect(s.items).toEqual([say("First one.")]);
    s.parser.feed("ond one.");
    expect(s.items).toEqual([say("First one.")]);
    s.parser.end();
    expect(s.items).toEqual([say("First one."), say("Second one.")]);
  });

  it("holds back a tag that is still arriving", () => {
    const s = stream([]);
    s.parser.feed('Look <point at="cur');
    expect(s.items).toEqual([]);
    s.parser.feed('sor"/>');
    expect(s.items).toEqual([say("Look"), act("point", { at: "cursor" })]);
  });

  it("gives up on a < that never becomes a tag", () => {
    const s = stream([]);
    s.parser.feed(`a <b ${"x".repeat(250)}. Next`);
    expect(s.items.length).toBe(1);
    expect(s.items[0].kind).toBe("say");
  });

  it("can be ended more than once, as it is around a tool call", () => {
    const s = stream([]);
    s.parser.feed("Let me look");
    s.parser.end();
    s.parser.feed("Found it.");
    s.parser.end();
    s.parser.end();
    expect(s.items).toEqual([say("Let me look"), say("Found it.")]);
  });
});
