// Generates Pesto's non-verbal sounds into public/sfx with ElevenLabs sound generation.
//   node dev/sfx.mjs                 all that are missing
//   node dev/sfx.mjs knock lid       just these, replacing what is there
//   node dev/sfx.mjs --takes 3 chew  three more takes of each named sound into dev/out/takes, to choose from by ear
//                                    with `node dev/rate.mjs`. Takes are brought to the same peak (needs ffmpeg) so
//                                    they compare like for like, and are numbered on from the ones already made.
//                                    Copy the one you like over public/sfx/<name>.mp3 and move the rest to dev/out/old.
//                                    How loud a sound then plays is set by SOUNDS in src/voice/eleven.ts.
//   node dev/sfx.mjs --takes 2 mutter --prompt "a tiny gremlin mumbling"
//                                    the same, described another way, to try a prompt before it goes in the table.
//                                    dev/out/takes.txt notes which prompt made each take.
// Reads the ElevenLabs key from the app's config.json.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const SOUNDS = {
  chitter: [1.0, "a small raccoon chittering happily, a short soft trill, very close, dry, no background"],
  eep: [0.5, "a tiny startled squeak from a small furry animal being picked up, one short high eep, close, dry"],
  huh: [0.5, "a small raccoon making a short questioning grunt, like a confused huh, close, dry"],
  grumble: [0.9, "a small raccoon grumbling under its breath, a short low annoyed mutter, close, dry"],
  yelp: [0.6, "a small raccoon giving one short surprised squeal, close, dry, no background"],
  gasp: [0.6, "a tiny cartoon animal's sharp startled gasp, close, dry"],
  dizzy: [1.4, "a small dazed raccoon making a wobbly woozy groan, cartoonish, close, dry"],
  squeak: [1.2, "rubbery paws squeaking as they slide slowly down a pane of glass, one continuous descending squeak"],
  knock: [0.7, "two quick light knuckle knocks on a thick glass window, close, dry"],
  press: [0.5, "a small soft paw pushing one plastic button firmly, a single short dull click with a soft pad thump, close, dry, no background"],
  clap: [1.6, "one very small creature clapping tiny soft paws, six quick little claps, close, dry"],
  swat: [0.5, "a small soft furry paw swiping quickly through the air, a faint short natural whoosh like a cloth flicked once, no synthesizer, no laser, dry, no background"],
  land: [0.5, "four small soft paws landing lightly on a wooden shelf, a quiet pat, dry"],
  thud: [0.5, "a small soft furry body landing on a hard floor, a gentle dull thump, dry"],
  rustle: [1.5, "something small rummaging through crumpled paper and wrappers inside a metal bin, muffled, close"],
  clank: [0.9, "an empty tin can knocking and rolling inside a metal trash can, short metallic clatter"],
  lid: [0.6, "a light metal trash can lid being set down with a soft metallic clink"],
  chew: [1.6, "a small raccoon nibbling at soft food with its mouth closed, gentle quick little chewing, muffled and quiet, not crunchy, not crispy, no lip smacking, wildlife field recording, very close, dry, no background"],
  mutter: [1.8, "a tiny gremlin mumbling to itself, small raspy creature babble, squeaky and croaky, mischievous, a little creature voice and not a human, very close, dry, no background"],
  mutter2: [1.8, "a small mischievous goblin creature grumbling under its breath, quick little raspy gibberish with chitters and squeaks, high-pitched and tiny, cartoon creature voice, not a human, very close, dry, no background"],
  mutter3: [1.8, "a small furry movie creature babbling quietly to itself, soft high cooing gibberish with little chirps and purrs, cute and tiny, a creature and not a human, very close, dry, no background"],
  sniff: [0.5, "a small raccoon giving one quick soft sniff through its nose, no voice, very quiet, close, dry, no background"],
  snort: [0.5, "a small raccoon giving one short snorty breath, a wet little nasal snort, wildlife field recording, quiet, very close, dry, no background, not a dog"],
  snort2: [0.5, "a small raccoon giving one short snorty breath, a wet little nasal snort, wildlife field recording, quiet, very close, dry, no background, not a dog"],
  snuffle: [0.6, "a small raccoon snuffling, two quick tiny nasal snorts, wildlife field recording, quiet, very close, dry, no background, not a dog"],
  whuff: [0.5, "a small furry animal's single soft whuff, a short breathy exhale like a little dog, not a human, quiet, close, dry, no background"],
  whuff2: [0.5, "a small furry animal's single soft whuff, a short breathy exhale like a little dog, not a human, quiet, close, dry, no background"],
  churr: [0.6, "a raccoon's short low churr, one soft purring animal grunt, not a human voice, close, dry, no background"],
  churr2: [0.6, "a raccoon's short low churr, one soft purring animal grunt, not a human voice, close, dry, no background"],
  trill: [0.6, "a real raccoon's short churring trill, one quick soft chitter-purr, wildlife field recording, very close, dry, no background, no human voice"],
  trill2: [0.6, "a real raccoon's short churring trill, one quick soft chitter-purr, wildlife field recording, very close, dry, no background, no human voice"],
  whine: [0.6, "a small animal's tiny strained whine, one short thin high squeak of effort like a puppy, not a human voice, close, dry, no background"],
  slap: [0.5, "two small soft paws slapping onto a pane of glass and gripping it, one quick light pat, dry"],
  scrabble: [0.7, "small claws scrabbling quickly up a pane of glass, a short burst of light ticking scratches, dry"],
  snore: [2.4, "a small raccoon asleep, one light little snore, a thin wheezy nasal whistle in and a tiny snuffle out, high and small, not deep, not a human, wildlife field recording, very close, dry, no background"],
};

const config = JSON.parse(fs.readFileSync(`${process.env.APPDATA}/dev.pesto.app/config.json`, "utf8").replace(/^﻿/, ""));
const wanted = process.argv.slice(2);
const flag = wanted.indexOf("--takes");
const takes = flag < 0 ? 0 : Number(wanted.splice(flag, 2)[1]);
const other = wanted.indexOf("--prompt");
const prompt = other < 0 ? null : wanted.splice(other, 2)[1];
if (takes) fs.mkdirSync("dev/out/takes", { recursive: true });

/** The number of the last take made of a sound, wherever it has ended up since. */
function lastTake(name) {
  const files = ["takes", "old", "used"].flatMap((dir) => (fs.existsSync(`dev/out/${dir}`) ? fs.readdirSync(`dev/out/${dir}`) : []));
  return Math.max(0, ...files.map((f) => (f.startsWith(`${name}-`) ? Number(f.slice(name.length + 1, -4)) || 0 : 0)));
}

/** Brings a file's loudest moment to `peak` dB and eases its first few milliseconds in, so it cannot start on a click. Without ffmpeg it stays as generated. */
function level(file, peak = -6) {
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const max = /max_volume: ([-\d.]+) dB/.exec(probe.stderr ?? "")?.[1];
  if (max == null) return;
  const levelled = file.replace(/\.mp3$/, ".levelled.mp3");
  const done = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-af", `afade=t=in:d=0.004,volume=${peak - Number(max)}dB`, "-b:a", "128k", levelled]);
  if (done.status === 0) fs.renameSync(levelled, file);
}

for (const [name, [seconds, described]] of Object.entries(SOUNDS)) {
  if (takes ? !wanted.includes(name) : wanted.length ? !wanted.includes(name) : fs.existsSync(`public/sfx/${name}.mp3`)) continue;
  const text = prompt ?? described;
  const first = takes ? lastTake(name) + 1 : 1;
  for (let take = first; take < first + (takes || 1); take++) {
    const file = takes ? `dev/out/takes/${name}-${take}.mp3` : `public/sfx/${name}.mp3`;
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
    if (takes) {
      level(file);
      fs.appendFileSync("dev/out/takes.txt", `${name}-${take}: ${text}\n`);
    }
    console.log(file, fs.statSync(file).size);
  }
}
