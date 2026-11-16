# Pesto progress

What exists, what is half there, and what is still to build. The character itself is specified in [pesto-spec.md](pesto-spec.md); this file tracks the build against it. Update a row when its state changes.

**Status:** ✅ works and was checked · 🟡 built but unverified or incomplete · ⬜ not started

**Two sessions work in this repo.** The look, rig and animation (`src/pesto/*`, `src/can/*`, `src/render/*`, `dev/studio*`) belong to the design session. Everything else belongs to the build session, which only touches those files where wiring requires it.

## Next up

In order. Each step leaves the app in a runnable state.

1. ✅ **First real launch.** He stands by his can on the primary monitor.
2. 🟡 **Verify on the real desktop.** Senses, rendering, windows on all four monitors and petting are confirmed. Still to try by hand: poking, grab and throw, riding a dragged window.
3. ✅ **Keys.** Entrim (GLM 5.3 Flash) and ElevenLabs are in `%APPDATA%\dev.pesto.app\config.json`.
4. ✅ **Talk to him by text.** `node dev/poke.mjs "pesto.say('…')"` gives a streamed, acted-out, spoken answer.
5. ✅ **Decider live.** About 250 ms per decision on Triton.
6. 🟡 **Voice.** ElevenLabs v4 Turbo through the binaural renderer works. His voice is Scruffy Duck. First listen: startlingly real but too roomy and too wide, and too studio-clean and big. Now: early bounces come from right around him, the Width setting (default 0.3) scales the heard angles, the main screen is narrowed to 0.4 of that and the other monitors open up twice as fast past its edges, and a small-body filter takes out the chest and the air. Open: Tobias judges `dev/out/audition/narrow2-*.wav` (made with `node dev/audition.mjs`); then the can colour and the generated sounds.
7. 🟡 **A way to talk to him without devtools.** Ctrl+Alt+P (or the tray's Talk…) opens a text box above his head; Enter sends, Esc closes. Set `ask.hotkey` in config.json to change it.
8. 🟡 **Talk to him out loud.** Say "Pesto" or "hey Pesto" and keep talking: he snaps to attention, follows your voice, and answers when you have finished. While you are still speaking, what you say can show on him. Next: a local transcriber.
9. ⬜ Then the feature tables below, roughly top to bottom.

### Known rough edges

- Triton serves the decision model with about 500 tokens of context per request, so the decider sees only a few journal lines. Raising `OLLAMA_CONTEXT_LENGTH` (or lowering `OLLAMA_NUM_PARALLEL`) on Triton would let it see more.
- The ElevenLabs plan allows three requests at once and no PCM output; lines are fetched as MP3, two at a time.
- Window titles go to the talking model as they are, including anything private in them. There is no filter yet. The same goes for the names of buttons, tabs and on-screen text in a window he looks into: chat names, file names.
- The model sometimes invents directions; unknown ones are skipped silently.
- The generated sounds in `public/sfx` have not been listened to.

## Architecture

| Part | Where | State |
|---|---|---|
| Overlay window: transparent, click-through, always on top, never takes focus, spans all monitors | `src-tauri/src/overlay.rs` | ✅ |
| Sense layer: monitors, windows (title, exe, rect, state, foreground, dragging), focused element, cursor, audio levels and sessions, media, idle, battery, CPU | `src-tauri/src/sense/` | ✅ events flow; values spot-checked for monitors, windows, cursor, media |
| Sense contract and bridge | `src/sense/` | ✅ |
| World model: events, ledges from taskbars and window tops | `src/world/world.ts` | ✅ in the headless harness, 🟡 on the real desktop |
| Character rig, emotions, moves | `src/pesto/` | ✅ design session is polishing |
| Trash can | `src/can/can.ts` | ✅ |
| Stage: sprites, sticker border, hit regions | `src/stage/` | ✅ |
| Director: idle life, reflexes, reaction catalog | `src/brain/director.ts` | ✅ headless, 🟡 live |
| Journal: debounced activity log and desktop snapshot for the model | `src/brain/journal.ts` | ✅ |
| Decider: small local model picks silent reactions and when to wake the mind | `src/brain/decider.ts` | ✅ decisions live; the pestering ladder is untested |
| Mind: streaming OpenAI-compatible chat that writes a performance script | `src/brain/mind.ts`, `persona.ts` | ✅ |
| Performance script: speech and `<direction/>` tags interleaved on a voice track and a body track | `src/brain/script.ts`, `performance.ts` | ✅ live, no tests |
| Sight: what is inside a window, fetched only when the model asks, so a wake carries titles and nothing more | `src-tauri/src/sense/elements.rs`, `src/sense/sight.ts`, `src/brain/tools.ts` | 🟡 |
| Voice: ElevenLabs speech, binaural renderer on measured KU100 responses, generated sounds, silent captions fallback | `src/voice/`, `public/hrir`, `public/sfx` | 🟡 works, not yet tuned by ear |
| Config file and tray menu (Settings, Quit) | `src-tauri/src/config.rs`, `src/config.ts` | 🟡 |
| Dev harness: pose sheets and film strips via headless Edge, studio page | `dev/` | ✅ |
| Ears: microphone thread with the wake word (sherpa-onnx keyword spotting, no training) and voice activity (Silero); the conversation around it | `src-tauri/src/hear/`, `src-tauri/models/`, `src/hear/ears.ts` | 🟡 checked with synthetic voices played into it, not yet with a real one |
| Live poke: run an expression inside the running overlay from a terminal | `dev/poke.mjs`, `pnpm dev:debug` | ✅ |
| Play a recording into his ears instead of the microphone | `pesto.ears.feed("C:/…/clip.wav")` through poke | ✅ |
| Wake word check over a folder of WAVs (`no-*.wav` must stay silent) | `cargo test wake -- --ignored --nocapture` with `PESTO_WAKE_WAVS` set | ✅ |

### Decisions

- **Tauri 2 + WebView2, one overlay window.** Coordinates everywhere are physical virtual-desktop pixels.
- **Three tiers of behaviour.** Reflexes are code (blink, gaze, startle, riding, being grabbed). Silent reactions are chosen by the small decision model on Triton from a fixed catalog, a few times a minute at most. Only speech and plans go to the big model.
- **The big model is not prompted per event.** The journal collects everything; it is handed over whole when he is spoken to or when the decider says it is worth speaking.
- **The model answers in a performance script,** not tool calls: plain text is speech, tags are stage directions, so speech and movement stream together and he can act mid-sentence.
- **Windows APIs first.** ActivityWatch is an optional extra source, not a dependency.

## Senses

| Feature | State |
|---|---|
| Monitors, work areas, virtual desktop | ✅ |
| Windows on every screen: title, app, position, minimised, foreground, being dragged | ✅ dragging untested |
| Cursor position and buttons | ✅ |
| Audio output level, microphone level, which apps are making sound | 🟡 |
| Now playing (title, artist, playing or paused) | ✅ |
| Idle time, battery, CPU load | 🟡 |
| Per-monitor DPI other than 100 % | ⬜ |
| Browser tabs and URL (UI Automation) | ⬜ |
| Notifications (Windows notification listener) | ⬜ |
| In a call / screen sharing detection | ⬜ |
| ActivityWatch adapter, Discord activity | ⬜ |
| Screen vision: screenshots to the model on demand | ⬜ |
| Focused element in any window (UI Automation): kind, name, rect, text caret | 🟡 `sense/focus.rs`, seen live; the caret is untested. He glances at a newly focused element and watches some bursts of typing; the model gets one line about it |
| Elements that change, move or matter most in a window | ⬜ |
| Window outlines on demand (UI Automation, one scan of at most ~150 ms per window, kept until it resizes or changes title): toolbars, tab strips, panes as shelves | 🟡 `sense/skeleton.rs`, `src/sense/skeleton.ts`; scanned when he is picked up, carried, lands or picks where to go. Chromium and Electron apps, Terminal and Spotify give good outlines; Firefox and Thunderbird give none |
| UI element positions (buttons, tabs, links, fields, menu items, scrollbars, text) for pointing and clicking | 🟡 `sense/elements.rs`, `src/sense/sight.ts`: one scan per look, at most 700 ms and 600 things, the app's own chrome first. Live: VS Code 124 things in 160 ms, WhatsApp 184 in 700 ms. Apps that tell UI Automation nothing (Firefox) give nothing |
| Recycle bin contents, deletes, emptying | ⬜ |
| Downloads folder watcher | ⬜ |
| Typing activity (rate only, never content) | 🟡 from the caret moving |
| Beat detection for music | ⬜ |
| Sudden loud sound detection | ⬜ |
| CPU temperature | ⬜ |
| Focus mode / do not disturb state | ⬜ |

## Talking

| Feature | State |
|---|---|
| Streamed answer acted out as it arrives | ✅ |
| Captions bubble | ✅ |
| Persona: short, scratchy, judgmental but on your side, noises over words | 🟡 reads well, needs tuning over real use |
| Delivery tags written by the model for the expressive voice ([mischievously], [whispers], [snorts], capitals, ellipses) | ✅ |
| ElevenLabs speech (`eleven_v4_turbo`, each sentence fetched ahead) | ✅ |
| His own voice: Scruffy Duck from the public library, made small and tinny by `smallBody` in `src/voice/eleven.ts` | ✅ |
| Binaural voice placed at his position on screen (measured HRIRs, crossfaded convolution, early reflections, muffled inside the can) | 🟡 measured correct, not yet judged by ear |
| Raccoon noises and effects (chitter, yelp, gasp, squeak, knock, clap, rustle, clank, lid, thud) | 🟡 generated by `dev/sfx.mjs`, unheard, as are snoring, chewing and muttering |
| Lip movement driven by the audio | ✅ loudness only |
| Typed input box on a hotkey | ✅ `src-tauri/src/ask.rs`, `ask.html`, `src/ask.ts` |
| Microphone | ✅ default input device, followed when it changes; the Ears toggle in his menu releases it |
| Speech to text | ✅ ElevenLabs `scribe_v3_live` over its realtime socket (`src-tauri/src/hear/stt.rs`), one session per turn, started at his name with the 1.5 s before it. The key needs the Speech to Text permission; `hear.apiKey` takes a separate one. English and German mixed is untested |
| End of turn by meaning rather than silence | 🟡 the model's turn prediction, plus our own shortcut: 0.6 s of silence once it rates the sentence 0.65 finished. Without a transcriber: 1.1 s of silence |
| Reacting while they still speak | 🟡 `Decider.aside` asks one question, how he reacts to what they just said, with `ASIDES` as the choices (a face, a small movement in the listening pose, or nothing), and shows the winner only if it gets at least `ASIDE_AT_LEAST` (0.45) of the answer. Each choice names the kind of sentence first and his reaction second, with no hedging: telling the model that he mostly does nothing made it answer nothing every time. Asked at most every 2.2 s from the seventh word on, three reactions a turn at most, 5 s apart. On 34 sample sentences at about 55 ms each: 13 of 20 emotional ones react, none wrongly, and none of the 14 ordinary ones do; not yet seen on him. `hear.asides` turns it off |
| Eager turns | ⬜ |
| Local speech to text | ⬜ later |
| Wake word "Pesto" / "hey Pesto" | 🟡 about 0.4 s after the name ends. With synthetic voices "hey Pesto" is reliable and the bare name is heard about four times in five; near-homophones ("presto", "pesticide") can set it off. `hear.threshold` in config.json tunes it (lower hears more) |
| First reaction to his name: instant snap to attention; the decision model picks the sound (none, "hm?", chitter, grumble) and his face, played only if you pause after the name | 🟡 decision takes 80–160 ms; sounds unheard |
| Reply without the name for a few seconds after he answers (`hear.followUp`) | 🟡 runs, not yet tried on purpose |
| Interrupting him mid-sentence | 🟡 `mind.interrupt` exists |
| Local speech synthesis | ⬜ later |
| Streaming synthesis over the websocket for a faster first word | ⬜ |
| Listener setup in settings (monitor size and distance, speakers instead of headphones) | ⬜ |
| Whisper mode late at night, shorter answers in the evening | ⬜ |

## Spec coverage

### Getting around

| Behaviour | State |
|---|---|
| Walk on ledges: taskbar, window tops | ✅ |
| Ledges on tab strips, toolbars and panes inside windows | 🟡 dropping him there works; walking and jumping onto them uses the same ledges, unwatched |
| Jump with crouch and wiggle, occasional misjudged ledge grab | ✅ |
| Climb screen edges and window sides | ✅ |
| Climb the scrollbar | ⬜ |
| Go where the action is: climb or jump up to the focused element, inspect it up close, sometimes hang out on top of that window | ⬜ idea from Tobias; the focused-element sense exists |
| Cling to glass, strain, slide down with a squeak | ✅ no sound |
| Catch an edge when dropped just under it or sliding past it: hang by one arm raised beside his head, looking up at it, then pull up or let go | 🟡 `hangFrom` in `moves.ts`, triggered by the director. The arm is short, so the hand sits at ear height; a longer reach would read better |
| Hang by one hand from a tab strip to point below | ⬜ |
| Ride a dragged window, flap when fast, hang a beat when minimised | ✅ headless, 🟡 live |

### Expression

| Behaviour | State |
|---|---|
| Emotion presets on eyes, mask, ears, tail | ✅ 21 |
| Gaze follows cursor and what he talks about | ✅ |
| Ears point at what he attends to | 🟡 |
| Only two eyes in the dark can | ✅ |
| Only eyes on dark backgrounds | ⬜ |
| Shading from his surroundings: tint and light him from what is behind and around him so he does not read as a paper cutout | ⬜ idea from Tobias; needs screen capture |
| Sticker border off by default, switchable from the menu | ✅ |

### Conversation states

| State | State |
|---|---|
| Called: lid flies up, head whips round, freezes mid-task | 🟡 lid pops, he shoots up with ears and fur on end; seen only in traces, not judged by eye |
| Listening: tilt, ears forward, nods on pauses | 🟡 `src/pesto/listening.ts`: tilt, ears forward and flicking with your voice, wide eyes, a nod when you pause; in the can the lid rides on your voice. Not judged by eye |
| Thinking: rubs paws, looks up | ✅ from when you finish until his answer starts |
| Talking: gestures, glances between you and the subject | 🟡 |
| Working: tongue out, muttering | ⬜ |
| Unsure: paw hovering over the button, looks at you | ⬜ |
| Mistake: ears flat, hides evidence | ⬜ |

### Pointing and showing

| Behaviour | State |
|---|---|
| Point from afar with the whole arm | ✅ |
| Go there, tap twice, look back | 🟡 `<tap at="…"/>`, `tap` in the director. He picks the nearest ledge he can reach the spot from; with none, he climbs the glass to it, clings, taps, and slides down when his grip goes. Seen in `film:tap` and `film:cling`, and once live on a VS Code button. A fingertip is exact with his arm straight and a few pixels off with it bent |
| Paper ball thrown at the exact spot | 🟡 `<throw at="…"/>`. It flies over every ledge, bounces off the spot, then falls and lies about like other junk. Seen in `film:throw`, not live. It borrows the "swat" and "land" sounds |
| Bent straw pointer | 🟡 not a direction of its own: `tap` and `point` use it whenever the spot is further than his finger and within about 115 units of his shoulder. The tip sits exactly on the spot. Seen in `film:tap` |
| A ring spreading from the spot he touched (finger, straw or ball) | 🟡 `src/stage/ping.ts`, not seen live |
| Cardboard signs | ✅ |
| Notes slid from under the lid | 🟡 |
| Cards: crumpled sheet smoothed on the glass into a document or small UI | ⬜ |
| Drawing on the screen | ⬜ |
| Generated UI inside a card | ⬜ |
| The model names targets by window id, by something inside a window (e12), by `focus`, or by pixel | 🟡 once live: asked where search is in VS Code, he looked, found the tab and tapped it |

### Agent work

| Behaviour | State |
|---|---|
| Tool use for the mind | 🟡 the loop is there (`src/brain/tools.ts`, `Mind.ask`): he may stop up to three times a wake to call a tool, and what he said before is spoken while it runs. One tool so far, `look`, which lists what is inside a window. Files, shell and web ⬜ |
| "This one": resolve what the cursor is hovering | ⬜ |
| Clicking by walking up and pressing, a real simulated click | ⬜ |
| Two-handed press for big buttons | ⬜ |
| Washing files in a tub | ⬜ |
| Background task in the can with clanking, result dragged to the cursor | ⬜ |
| Waiting with the result, tapping his foot, then knocking | ⬜ |
| Notifications: read first, dismiss spam, point out the important | ⬜ |
| Downloads: catch and bring | ⬜ |
| The hoard: memory, rummaging | ⬜ |
| Permission prompt before anything irreversible | ⬜ |

### Watching you

| Behaviour | State |
|---|---|
| Silent reactions picked by the decider | 🟡 |
| Typo wince | ⬜ |
| Save nod | ⬜ |
| Buried under tabs | ⬜ |
| Same error three times: note | ⬜ |
| Error dialog: startle, hide behind it, poke it | ⬜ |
| Watching a video along with you | ⬜ |
| Confetti for wins | ⬜ |

### Proactivity ladder

| Step | State |
|---|---|
| Rustle, glance, approach, knock, speech | 🟡 each exists, the ladder as a sequence is only wired for scrolling |
| Shrug and wander off when ignored | ⬜ |
| Minimum quiet time between unprompted speech | 🟡 |

### Scrolling routine

| Step | State |
|---|---|
| Detect time-wasting from app and title | 🟡 decider question |
| Eyes follow the scrolling | ⬜ |
| Sits on the browser window staring | 🟡 |
| Knock, "Hey. Stop it." | 🟡 |
| Sign with the minutes | 🟡 |
| Hangs on the scrollbar | ⬜ |
| Finger on the close button | ⬜ |
| Applause when you close it yourself | 🟡 |
| Flop when ignored | 🟡 |

### Idle presence

| Behaviour | State |
|---|---|
| Peeking from the can | ✅ |
| Walks: stretch, sniff, sit with legs dangling | ✅ |
| Lounging: lies down or slouches instead of sitting upright when he is really relaxed outside the can | ✅ headless, 🟡 live. Out for 30 s or sleepy, he slouches on one arm, or with room on the ledge lies on his side with his head on a paw |
| Leaning on the rim of the half-open can, hanging over the edge and looking out | ✅ headless, 🟡 live. Chin and paws on the rim, the lid leaning on the back of his head; a click sends him back in. His arms do not hang over the front |
| Grooming his tail | ✅ headless, 🟡 live |
| Can sounds | 🟡 rustle, chewing, muttering, snoring at night and a tin knocking about, each with its own can movement. The new sounds are unheard |
| Junk tossed out of the can | ✅ headless, 🟡 live. Paper ball, tin, banana peel, apple core, fishbone (`src/stage/litter.ts`). A piece bounces, lies on its ledge for about 20 s and fades; four at most |
| Paper ball play, pounce on a wiggling cursor | ⬜ |

### The trash can

| Behaviour | State |
|---|---|
| Our own can, a bit bigger than the Windows one | ✅ |
| Deleted files land on his head, "You sure?" | ⬜ |
| Full trash, lid will not close | ⬜ |
| Emptying: "My stuff!" | ⬜ |
| Finds: duplicates, forgotten files | ⬜ |
| Decor collected over time | ⬜ |
| Moving the can by dragging it | ✅ |

### Cursor interaction

| Behaviour | State |
|---|---|
| Petting | ✅ headless, 🟡 live |
| Poke, swat | ✅ headless, 🟡 live |
| Scruff grab, limp, looks at what he is over | ✅ headless, 🟡 live |
| Being picked up: surprised at first, resigned then fed up when it keeps happening; a sound only sometimes, never the same twice | 🟡 sounds unheard |
| Hand cursor over him and the can, closed hand while carrying | 🟡 written, not seen |
| Drop: sit on a ledge, otherwise cling and slide | ✅ headless, 🟡 live |
| Shake dizzy, throw tumble and glare | ✅ headless, 🟡 live |
| Drag a file onto him | ⬜ |
| High five | ⬜ |

### Sound and music

| Behaviour | State |
|---|---|
| Dance when music plays | 🟡 not on the beat |
| Head bob, foot tap, dance as an escalation; drumming on the lid | ⬜ |
| Loud audio: paws over ears, lid as helmet | ⬜ |
| Sudden bang: poof | 🟡 startle exists, no trigger |
| Silent during calls, yapping hand | ⬜ |

### Fullscreen

When a video or game takes the whole screen he is no longer on the desktop in front of it. Ideas from Tobias:

| Behaviour | State |
|---|---|
| Behind the fullscreen app instead of over it | ⬜ |
| Pokes a hole in it and looks through | ⬜ |
| Bulges and dents the picture from behind as he moves | ⬜ |
| Knocks from behind: a thump and a few specks of dust | ⬜ |

### Time and system

| Behaviour | State |
|---|---|
| Sleepy and nightcap at night | ✅ |
| Morning coffee from a bottle cap | 🟡 cap exists |
| Sock blanket, asleep against the active window | ⬜ |
| 3 a.m. glare | ⬜ |
| Low battery weakness, perks up on power | ⬜ |
| Hot CPU sweat and fanning | ⬜ |

### Off switch

| Behaviour | State |
|---|---|
| Quit from the tray | 🟡 |
| Push the lid down to shush him | ⬜ |
| Silent with signs only during calls and screen sharing | ⬜ |
| Do-not-disturb sign in focus mode | ⬜ |
| Close the lid (he cant get out, may knock on it from the inside when he wants to get out and shouts) | ⬜ |

### Getting out of the way

| Behaviour | State |
|---|---|
| Rest the cursor on him: he dithers see-through and clicks pass to what is behind him until the cursor leaves. A moving cursor still pets, pokes and grabs | ✅ |
| Taskbars always stay clickable under him, and the part of him over one dithers when the cursor comes near | ✅ |
| The can can be dragged anywhere; it drops onto the ledge below and stays there across restarts | ✅ |
| Pop-art can: tiny most of the time, growing only when he comes out or for an animation. It need not be realistic | ⬜ idea from Tobias |
| He steps aside instead of only fading | ⬜ |

## Housekeeping

| Task | State |
|---|---|
| `vite build` inputs (overlay and ask box) | 🟡 fixed, build not run |
| Privacy filter for window titles before they reach the model | ⬜ |
| Tests for the script parser and the performance player | ⬜ |
| `CLAUDE.md` for agents working in the repo | ⬜ |
| Right-click menu on him or the can: Talk, Go home / Come out, Voice, Volume, Width, Captions, Reactions, Sticker border, Settings, Quit. Switches are saved to config.json | ✅ |
| More switches in the menu as features arrive (sounds, proactivity level, do not disturb) | ⬜ |
| Settings window (`settings.html`, `src/settings.ts`): every config.json key plus the talk hotkey, saved as you go and applied live in the overlay; opened from the tray or his menu | ✅ |
| Start with Windows | ⬜ |
| Installer build | ⬜ |

## Running it

```
pnpm dev                                   the real overlay (its own Vite on port 1422; the studio keeps 1420)
pnpm dev:debug                             the same, with the webview debug port open for poke
node dev/poke.mjs "pesto.say('hello')"      run anything inside the live overlay
node dev/sfx.mjs                           generate missing sounds into public/sfx
pnpm dev:web                               studio page in a browser, no desktop senses
node dev/shoot.mjs emotions film:emerge    pose sheets and film strips into dev/out
node dev/shoot.mjs film:groom film:lounge film:rim film:junk    the idle moves
node dev/shoot.mjs film:tap film:cling film:throw               pointing things out; a cross marks each spot he touched
pnpm typecheck
```

`PESTO_SENSE_LOG=1` prints sense event counts. Through poke or the overlay's devtools, `pesto.say("…")` talks to him, `pesto.director.perform("dance")` plays a reaction, `pesto.director.perform("tap", { target: "cursor" })` (or `"throw"`, `"point"`) shows a spot, `pesto.sight.look(pesto.world.foreground)` lists what he can see in a window, `pesto.decider.last` shows the last silent decision. Debug in his menu (`debug.panel`) draws a live trace in the corner of his screen: every request to the decision model with its time and likeliest answers, what his ears heard, and why he did or did not react while listening. The same lines go to the console and `pesto.trace.lines`.
