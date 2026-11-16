// Runs the overlay with its webview debugging port open, so dev/poke.mjs can reach it.
import { spawn } from "node:child_process";

const port = process.env.PESTO_DEBUG_PORT ?? "9333";
const child = spawn("pnpm", ["tauri", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
child.on("exit", (code) => process.exit(code ?? 0));
