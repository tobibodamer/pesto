// Evaluates an expression inside the running overlay and prints the result.
//   node dev/poke.mjs "pesto.decider.last"
//   node dev/poke.mjs "pesto.director.perform('dance')"
// Needs the app started with `pnpm dev:debug`, which opens the webview's debugging port.
const port = process.env.PESTO_DEBUG_PORT ?? "9333";
const expression = process.argv.slice(2).join(" ");
if (!expression) {
  console.error('usage: node dev/poke.mjs "<expression>"');
  process.exit(2);
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
    params: {
      expression: `(async () => { const v = await (${expression}); return typeof v === "string" ? v : JSON.stringify(v, (k, x) => (typeof x === "function" ? undefined : x), 2); })()`,
      awaitPromise: true,
      returnByValue: true,
    },
  }),
);
ws.onmessage = (m) => {
  const { id, result } = JSON.parse(m.data);
  if (id !== 1) return;
  if (result.exceptionDetails) {
    console.error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    process.exitCode = 1;
  } else console.log(result.result.value);
  ws.close();
};
