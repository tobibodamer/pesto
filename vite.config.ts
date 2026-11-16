import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/dev/out/**"] } },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        overlay: resolve(__dirname, "index.html"),
        ask: resolve(__dirname, "ask.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
});
