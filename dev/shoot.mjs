// Renders dev/sheet.ts to PNGs with headless Edge, so the character can be
// inspected without launching the overlay.
//   node dev/shoot.mjs emotions turns@1500x1250     pose sheets (dev/sheet.ts)
//   node dev/shoot.mjs film:emerge film:climb      film strips (dev/film.ts)
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "out");
mkdirSync(out, { recursive: true });

async function bundle(entry) {
  const result = await build({
    entryPoints: [resolve(here, entry)],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
  });
  return result.outputFiles[0].text;
}
const scripts = { sheet: await bundle("sheet.ts"), film: await bundle("film.ts") };

const edge = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find(existsSync);
if (!edge) throw new Error("Edge not found");

const sets = process.argv.slice(2);
if (sets.length === 0) sets.push("emotions");

for (const spec of sets) {
  const [target, size] = spec.split("@");
  const isFilm = target.startsWith("film:");
  const set = isFilm ? target.slice(5) : target;
  const js = isFilm ? scripts.film : scripts.sheet;
  const [w, h] = (size ?? (isFilm ? "1800x720" : "1500x1000")).split("x").map(Number);
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#7fa8e8"><script>window.SHEET=${JSON.stringify(set)}</script><script>${js.replace(/<\/script>/g, "<\\/script>")}</script>`;
  const page = resolve(out, `${isFilm ? "film-" : ""}${set}.html`);
  writeFileSync(page, html);
  const png = resolve(out, `${isFilm ? "film-" : ""}${set}.png`);
  const r = spawnSync(
    edge,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${w},${h}`,
      "--virtual-time-budget=8000",
      `--screenshot=${png}`,
      pathToFileURL(page).href,
    ],
    { stdio: "pipe" },
  );
  if (r.status !== 0) console.error(r.stderr.toString());
  console.log(png);
}
