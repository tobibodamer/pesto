# Pesto

A desktop companion for Windows: a small raccoon who lives in a trash can on your desktop. He walks and climbs on taskbars and window edges, watches what you do, and talks to you out loud when you call his name.

- [pesto-spec.md](pesto-spec.md) describes the character and how he should behave.
- [PROGRESS.md](PROGRESS.md) tracks what is built, what is half there and what is next.
- [ideas.md](ideas.md) collects ideas that are not planned yet.

## Requirements

- Windows 10 or 11 with WebView2
- Node.js and pnpm
- Rust (stable) for Tauri 2

## Running

```bash
pnpm install
```

```bash
pnpm dev
```

This starts Vite on port 1422 and opens the overlay: one transparent, click-through window over all monitors.

If Windows has reserved port 1422 (`listen EACCES ::1:1422`), check with `netsh interface ipv4 show excludedportrange protocol=tcp` and run Tauri with a `--config` file that moves `devUrl` and `beforeDevCommand` to a free port.

## Configuration

Settings live in `%APPDATA%\dev.pesto.app\config.json`. Every key is optional; missing keys fall back to the defaults in [src/config.ts](src/config.ts). The tray menu opens a Settings window for the same file.

| Section | What it sets |
|---|---|
| `mind` | The model that speaks and plans. `provider` is `openai` (any OpenAI-compatible chat endpoint, the default) or `gemini` (Google's Gemini API, free tier with a key from [AI Studio](https://aistudio.google.com/apikey)). `baseUrl`, `apiKey`, `model`; for Gemini an empty `baseUrl` or `model` means `https://generativelanguage.googleapis.com/v1beta` and `gemini-3.6-flash`. |
| `decider` | His silent reactions and when he speaks up unprompted. `provider` is `systemone` (a small decision model on Ollama's `/v1/systemone` at `baseUrl`, default `http://localhost:11434`) or `none` (simple rules in code, no setup). When System One stops answering he decides in code and tries the model again every 10 minutes. Without a model, `speakUp` (`never`, `sometimes`, `always`) sets how often a check-in wakes the mind. |
| `voice` | ElevenLabs text to speech: `apiKey`, `voiceId`. Without it he answers in speech bubbles. |
| `hear` | Microphone, wake word and ElevenLabs Scribe speech to text. |
| `body` | His size, the can's size and the sticker border. |
| `debug` | `panel: true` shows what his ears and the decider are doing. |

## Talking to him

- Say "Pesto" or "hey Pesto" and keep talking.
- Press Ctrl+Alt+P (or pick Talk… in the tray) to type to him. Enter sends, Esc closes. `ask.hotkey` changes the shortcut.

## How it is built

Tauri 2 with one WebView2 overlay window. Coordinates everywhere are physical virtual-desktop pixels.

| Path | Contents |
|---|---|
| `src-tauri/src/overlay.rs` | The overlay window |
| `src-tauri/src/sense/` | Monitors, windows, focused element, cursor, audio, media, idle, battery, CPU, window outlines via UI Automation |
| `src-tauri/src/hear/`, `src-tauri/models/` | Microphone thread, wake word (sherpa-onnx keyword spotting) and voice activity (Silero) |
| `src/sense/` | The sense contract and bridge to the webview |
| `src/world/` | World model: ledges from taskbars and window tops |
| `src/pesto/`, `src/can/`, `src/render/`, `src/stage/` | Character rig, emotions, moves, the can, drawing |
| `src/brain/` | Director (reflexes and idle life), journal, decider and its backends (`deciders/`), mind, performance scripts |
| `src/voice/`, `public/hrir`, `public/sfx` | Speech, binaural rendering, generated sounds |
| `src/hear/` | The conversation around the microphone |
| `dev/` | Dev harness and tools |

Behaviour runs in three tiers. Reflexes such as blinking, gaze and being grabbed are plain code. Silent reactions come from the decider, a few times a minute at most: a small decision model when there is one, otherwise rules in code. Only speech and plans go to the big model, which answers in a performance script: plain text is speech, `<direction/>` tags are stage directions, so he can move mid-sentence.

## Dev tools

| Command | What it does |
|---|---|
| `pnpm studio` | Pesto on a fake desktop in the browser: trigger reactions and emotions, slow time, drag him and windows around |
| `pnpm sheet emotions` | Renders pose sheets from `dev/sheet.ts` to `dev/out/` with headless Edge |
| `pnpm sheet film:climb` | Renders a film strip from `dev/film.ts` |
| `pnpm dev:debug` | Runs the app with the webview debugging port open (9333) |
| `node dev/poke.mjs "<expr>"` | Evaluates an expression in the running overlay, e.g. `"pesto.say('hi')"` |
| `node dev/audition.mjs <speech.mp3>` | Renders a line through the voice chain at several screen positions to WAVs |
| `pnpm typecheck` | TypeScript check |

To check the wake word against a folder of recordings (files named `no-*.wav` must stay silent):

```bash
cd src-tauri && PESTO_WAKE_WAVS=<folder> cargo test wake -- --ignored --nocapture
```
