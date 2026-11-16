// Builds dev/out/rate.html: every sound on one page, to play and rate by ear.
//   node dev/rate.mjs
// It shows the takes in dev/out/takes (made by `node dev/sfx.mjs --takes`), what is in public/sfx,
// and what was set aside in dev/out/old. The page is one file with the audio inside it.
// Ratings already given are read from dev/out/ratings.txt, in the form the page's Copy button
// writes them, so each sound starts with its last mark and the page reports only what changes.
import { createHash } from "node:crypto";
import fs from "node:fs";

const rated = {};
if (fs.existsSync("dev/out/ratings.txt")) {
  for (const line of fs.readFileSync("dev/out/ratings.txt", "utf8").split(/\r?\n/)) {
    const [, mark, list] = /^(good|ok|bad|unrated):(.*)$/.exec(line.trim()) ?? [];
    for (const [, name, note] of (list ?? "").matchAll(/([\w-]+)(?: \(([^)]*)\))?/g)) rated[name] = { mark: mark === "unrated" ? undefined : mark, note };
  }
}

const clips = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".mp3"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((f) => {
          const bytes = fs.readFileSync(`${dir}/${f}`);
          const name = f.slice(0, -4);
          // Marks are kept under the sound itself, not just its name, so a replaced sound starts unrated.
          return { name, key: `${name}:${createHash("sha1").update(bytes).digest("hex").slice(0, 8)}`, seed: rated[name] ?? {}, data: bytes.toString("base64") };
        })
    : [];

const groups = [
  { title: "Takes", clips: clips("dev/out/takes") },
  { title: "In the app", clips: clips("public/sfx") },
  { title: "Set aside", clips: clips("dev/out/old") },
].filter((g) => g.clips.length);

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pesto sounds</title>
<style>
  :root { color-scheme: light dark; --line: #8884; --good: #2e9e5b; --ok: #c9972b; --bad: #d1483f; }
  body { margin: 0; padding: 20px 16px 220px; font: 14px/1.4 system-ui, sans-serif; max-width: 760px; margin-inline: auto; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.6; margin: 28px 0 8px; }
  .row { display: grid; grid-template-columns: minmax(120px, 1fr) auto minmax(80px, 1.4fr); gap: 8px; align-items: center; padding: 5px 0; border-top: 1px solid var(--line); }
  .row.gap { margin-top: 12px; }
  button, input, textarea { font: inherit; color: inherit; }
  .play { text-align: left; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: none; cursor: pointer; }
  .play.on { border-color: currentColor; }
  .marks { display: flex; gap: 4px; }
  .marks button { width: 34px; height: 30px; border: 1px solid var(--line); border-radius: 8px; background: none; cursor: pointer; }
  .marks button.good.set { background: var(--good); color: #fff; }
  .marks button.ok.set { background: var(--ok); color: #fff; }
  .marks button.bad.set { background: var(--bad); color: #fff; }
  .note { min-width: 0; padding: 5px 8px; border: 1px solid var(--line); border-radius: 8px; background: none; }
  footer { position: fixed; inset: auto 0 0 0; padding: 10px 16px; background: Canvas; border-top: 1px solid var(--line); }
  footer div { max-width: 760px; margin-inline: auto; display: flex; gap: 8px; align-items: stretch; }
  textarea { flex: 1; height: 120px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: none; resize: none; font: 12px/1.4 ui-monospace, monospace; }
  #copy { padding: 0 16px; border: 1px solid var(--line); border-radius: 8px; background: none; cursor: pointer; }
</style>
<main></main>
<footer><div><textarea id="out" readonly></textarea><button id="copy">Copy</button></div></footer>
<script>
const GROUPS = ${JSON.stringify(groups)};
const KEY = "pesto.ratings";
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
const main = document.querySelector("main");
const out = document.getElementById("out");
let playing = null;

function report() {
  const lines = [];
  // Only what differs from the marks the page was built with.
  const changed = GROUPS.flatMap((g) => g.clips).filter((c) => saved[c.key].mark !== c.seed.mark || (saved[c.key].note || "") !== (c.seed.note || ""));
  for (const mark of ["good", "ok", "bad", undefined]) {
    const clips = changed.filter((c) => saved[c.key].mark === mark);
    if (clips.length) lines.push((mark ?? "unrated") + ": " + clips.map((c) => c.name + (saved[c.key].note ? " (" + saved[c.key].note + ")" : "")).join(", "));
  }
  out.value = lines.join("\\n");
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {}
}

for (const group of GROUPS) {
  const h = document.createElement("h2");
  h.textContent = group.title;
  main.append(h);
  let stem = "";
  for (const clip of group.clips) {
    const row = document.createElement("div");
    row.className = "row";
    const now = clip.name.replace(/-\\d+$/, "");
    if (group.title !== "In the app" && stem && now !== stem) row.classList.add("gap");
    stem = now;
    const state = (saved[clip.key] ??= { ...clip.seed });

    const play = document.createElement("button");
    play.className = "play";
    play.textContent = "▶  " + clip.name;
    const audio = new Audio("data:audio/mpeg;base64," + clip.data);
    audio.onended = () => play.classList.remove("on");
    play.onclick = () => {
      if (playing) { playing.audio.pause(); playing.play.classList.remove("on"); }
      audio.currentTime = 0;
      void audio.play();
      play.classList.add("on");
      playing = { audio, play };
    };

    const marks = document.createElement("div");
    marks.className = "marks";
    for (const [mark, sign] of [["good", "+"], ["ok", "~"], ["bad", "−"]]) {
      const b = document.createElement("button");
      b.className = mark + (state.mark === mark ? " set" : "");
      b.textContent = sign;
      b.title = mark;
      b.onclick = () => {
        state.mark = state.mark === mark ? undefined : mark;
        for (const other of marks.children) other.classList.toggle("set", other === b && !!state.mark);
        report();
      };
      marks.append(b);
    }

    const note = document.createElement("input");
    note.className = "note";
    note.value = state.note ?? "";
    note.oninput = () => { state.note = note.value.trim(); report(); };

    row.append(play, marks, note);
    main.append(row);
  }
}
report();
document.getElementById("copy").onclick = async () => {
  out.select();
  try { await navigator.clipboard.writeText(out.value); } catch { document.execCommand("copy"); }
};
</script>
`;

fs.mkdirSync("dev/out", { recursive: true });
fs.writeFileSync("dev/out/rate.html", html);
console.log("dev/out/rate.html", groups.map((g) => `${g.title}: ${g.clips.length}`).join(", "));
