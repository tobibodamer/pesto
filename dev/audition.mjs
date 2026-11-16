// Renders a speech file through the voice chain at several places on the screens,
// so changes to the sound can be judged from files instead of live.
//   node dev/audition.mjs dev/out/audition/voice-4-scruffy-duck.mp3 [label]
// Writes dev/out/audition/<label>-<scene>.wav. Needs the app running via `pnpm dev:debug`.
import fs from "node:fs";

const [file, label = "space"] = process.argv.slice(2);
if (!file) {
  console.error("usage: node dev/audition.mjs <speech.mp3> [label]");
  process.exit(2);
}
const port = process.env.PESTO_DEBUG_PORT ?? "9333";
const speech = fs.readFileSync(file).toString("base64");

async function inPage(speech) {
  const { Hrirs } = await import("/src/voice/hrir.ts");
  const { Spatializer, seenFromChair } = await import("/src/voice/space.ts");
  const { smallBody } = await import("/src/voice/eleven.ts");
  const bytes = Uint8Array.from(atob(speech), (c) => c.charCodeAt(0));
  const voice = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(bytes.buffer);
  const screen = { x: 0, y: 0, w: 1920, h: 1080 };
  const walk = Array.from({ length: 60 }, (_, i) => [(i * voice.duration) / 60, { x: -1800 + (i * 5600) / 59, y: 1000 }, false]);
  const scenes = {
    centre: [[0, { x: 960, y: 600 }, false]],
    "can-corner": [[0, { x: 1770, y: 1000 }, false]],
    "right-monitor-far-edge": [[0, { x: 3800, y: 700 }, false]],
    "left-monitor": [[0, { x: -1000, y: 700 }, false]],
    "inside-can": [[0, { x: 1770, y: 1000 }, true]],
    "walk-left-to-right": walk,
  };
  const out = {};
  for (const [name, steps] of Object.entries(scenes)) {
    const frames = Math.ceil((voice.duration + 0.4) * 48000);
    const ctx = new OfflineAudioContext(2, frames, 48000);
    const space = new Spatializer(ctx, await Hrirs.load(ctx), ctx.destination);
    const body = smallBody(ctx);
    body.output.connect(space.input);
    const source = ctx.createBufferSource();
    source.buffer = voice;
    source.connect(body.input);
    source.start(0.05);
    for (const [t, point, muffled] of steps) {
      const aim = () => {
        const seen = seenFromChair(point, screen);
        space.aim(seen.azimuth, seen.elevation, seen.metres, muffled);
      };
      if (t === 0) aim();
      else void ctx.suspend((Math.round((t * 48000) / 128) * 128) / 48000).then(() => (aim(), ctx.resume()));
    }
    const rendered = await ctx.startRendering();
    const pcm = new Int16Array(frames * 2);
    for (let ch = 0; ch < 2; ch++) {
      const data = rendered.getChannelData(ch);
      for (let i = 0; i < frames; i++) pcm[i * 2 + ch] = Math.max(-1, Math.min(1, data[i])) * 32767;
    }
    const raw = new Uint8Array(pcm.buffer);
    let text = "";
    for (let i = 0; i < raw.length; i += 32768) text += String.fromCharCode.apply(null, raw.subarray(i, i + 32768));
    out[name] = btoa(text);
  }
  return out;
}

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && new URL(t.url).pathname === "/");
if (!page) throw new Error("overlay page not found");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, fail) => {
  ws.onopen = ok;
  ws.onerror = fail;
});
ws.send(
  JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: `(${inPage})(${JSON.stringify(speech)})`, awaitPromise: true, returnByValue: true },
  }),
);
ws.onmessage = (m) => {
  const { id, result } = JSON.parse(m.data);
  if (id !== 1) return;
  if (result.exceptionDetails) {
    console.error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    process.exit(1);
  }
  for (const [name, b64] of Object.entries(result.result.value)) {
    const pcm = Buffer.from(b64, "base64");
    const head = Buffer.alloc(44);
    head.write("RIFF", 0);
    head.writeUInt32LE(36 + pcm.length, 4);
    head.write("WAVEfmt ", 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(2, 22);
    head.writeUInt32LE(48000, 24);
    head.writeUInt32LE(48000 * 4, 28);
    head.writeUInt16LE(4, 32);
    head.writeUInt16LE(16, 34);
    head.write("data", 36);
    head.writeUInt32LE(pcm.length, 40);
    const path = `dev/out/audition/${label}-${name}.wav`;
    fs.writeFileSync(path, Buffer.concat([head, pcm]));
    console.log(path);
  }
  ws.close();
};
