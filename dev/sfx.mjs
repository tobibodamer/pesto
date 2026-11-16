// Generates Pesto's non-verbal sounds into public/sfx with ElevenLabs sound generation.
//   node dev/sfx.mjs            all that are missing
//   node dev/sfx.mjs knock lid  just these, replacing what is there
// Reads the ElevenLabs key from the app's config.json.
import fs from "node:fs";

const SOUNDS = {
  chitter: [1.0, "a small raccoon chittering happily, a short soft trill, very close, dry, no background"],
  yelp: [0.6, "a small raccoon giving one short surprised squeal, close, dry, no background"],
  gasp: [0.6, "a tiny cartoon animal's sharp startled gasp, close, dry"],
  dizzy: [1.4, "a small dazed raccoon making a wobbly woozy groan, cartoonish, close, dry"],
  squeak: [1.2, "rubbery paws squeaking as they slide slowly down a pane of glass, one continuous descending squeak"],
  knock: [0.7, "two quick light knuckle knocks on a thick glass window, close, dry"],
  clap: [1.6, "one very small creature clapping tiny soft paws, six quick little claps, close, dry"],
  swat: [0.5, "a quick soft paw swipe through the air, a small whoosh, dry"],
  land: [0.5, "four small soft paws landing lightly on a wooden shelf, a quiet pat, dry"],
  thud: [0.5, "a small soft furry body landing on a hard floor, a gentle dull thump, dry"],
  rustle: [1.5, "something small rummaging through crumpled paper and wrappers inside a metal bin, muffled, close"],
  clank: [0.9, "an empty tin can knocking and rolling inside a metal trash can, short metallic clatter"],
  lid: [0.6, "a light metal trash can lid being set down with a soft metallic clink"],
};

const config = JSON.parse(fs.readFileSync(`${process.env.APPDATA}/dev.pesto.app/config.json`, "utf8").replace(/^﻿/, ""));
const wanted = process.argv.slice(2);

for (const [name, [seconds, text]] of Object.entries(SOUNDS)) {
  const file = `public/sfx/${name}.mp3`;
  if (wanted.length ? !wanted.includes(name) : fs.existsSync(file)) continue;
  const res = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "xi-api-key": config.voice.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ text, duration_seconds: seconds, prompt_influence: 0.6 }),
  });
  if (!res.ok) {
    console.error(name, res.status, (await res.text()).slice(0, 200));
    continue;
  }
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(name, fs.statSync(file).size);
}
