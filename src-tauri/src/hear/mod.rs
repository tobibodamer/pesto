//! His ears: the microphone, his name, and the person's voice while he listens.
//!
//! One thread owns the microphone. While idle it only runs the keyword model.
//! Once his name is heard (or the app asks for it) it follows their voice
//! until their turn is over, reporting it to the overlay as it goes:
//!
//!   hear://status  { ready, error }      the microphone came up or went away
//!   hear://wake    { keyword }           his name was said
//!   hear://barge   {}                    they started talking over him while he spoke
//!   hear://voice   { level, speaking }   their voice, 25 times a second while listening
//!   hear://words   { text, done }        what they have said so far, and how finished it sounds (0..1)
//!   hear://ended   { text, spoke }       their turn is over
//!
//! Audio leaves the machine only during a turn, and only when speech to text
//! is set up: from a moment before his name until the turn ends.

mod mic;
mod stt;
mod wake;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use sherpa_onnx::{LinearResampler, SileroVadModelConfig, VadModelConfig, VoiceActivityDetector, Wave};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

use self::mic::Mic;
use self::wake::{Wake, SAMPLE_RATE};
use crate::sense::{emit_event, SenseState};

const RATE: usize = SAMPLE_RATE as usize;
/// Samples per `hear://voice` report.
const FRAME: usize = RATE / 25;
/// How long they must have been quiet before their turn counts as over, when nothing understands the words.
const END_SILENCE: usize = RATE * 11 / 10;
/// The same while the words are being transcribed: the transcriber normally calls the end first.
const END_SILENCE_TRANSCRIBED: usize = RATE * 3;
/// When the transcriber finds the sentence this finished, a short silence is enough to end the turn.
const SOUNDS_DONE: f32 = 0.65;
const END_SILENCE_DONE: usize = RATE * 6 / 10;
/// How much from before his name goes to the transcriber: the name itself and whatever ran straight on from it.
const BEFORE_NAME: usize = RATE * 3 / 2;
/// Speech shorter than this is a cough or the tail of his name, not a turn.
const MIN_SPEECH: usize = RATE / 4;
/// How long he waits for them to start after his name.
const WAIT_AFTER_NAME: f32 = 5.0;
/// How long they must talk over him, without a break, before it counts as cutting him off. A short "mhm" does not.
const BARGE_SPEECH: usize = RATE * 6 / 10;
/// No turn is longer than this.
const LONGEST_TURN: usize = RATE * 45;
const RETRY: Duration = Duration::from_secs(3);

enum Command {
    Enable { on: bool, threshold: f32, stt: Option<stt::Settings> },
    Listen { seconds: f32 },
    Talking(bool),
    Stop,
    Feed(Vec<f32>),
}

pub struct Hear {
    commands: Mutex<Sender<Command>>,
    ready: AtomicBool,
}

impl Hear {
    fn send(&self, command: Command) -> Result<(), String> {
        let tx = self.commands.lock().map_err(|e| e.to_string())?;
        tx.send(command).map_err(|e| e.to_string())
    }
}

/// Starts or stops listening to the microphone. Nothing is captured while off.
/// Without `stt` he hears his name and their voice but not what they say.
#[tauri::command]
pub fn hear_enable(hear: State<'_, Arc<Hear>>, on: bool, threshold: f32, stt: Option<stt::Settings>) -> Result<(), String> {
    hear.send(Command::Enable { on, threshold, stt })
}

/// Listens for a turn without his name being said, giving up after `seconds` of nothing.
#[tauri::command]
pub fn hear_listen(hear: State<'_, Arc<Hear>>, seconds: f32) -> Result<(), String> {
    if !hear.ready.load(Ordering::Acquire) {
        return Err("the microphone is not being listened to".into());
    }
    hear.send(Command::Listen { seconds })
}

/// Tells his ears whether he is speaking, so that their voice over his starts a turn without his name.
#[tauri::command]
pub fn hear_talking(hear: State<'_, Arc<Hear>>, on: bool) -> Result<(), String> {
    hear.send(Command::Talking(on))
}

#[tauri::command]
pub fn hear_stop(hear: State<'_, Arc<Hear>>) -> Result<(), String> {
    hear.send(Command::Stop)
}

/// Plays a WAV into his ears in place of the microphone, at the speed it would be spoken.
/// For trying things without saying them: `node dev/poke.mjs "pesto.ears.feed('C:/…/hey.wav')"`.
#[tauri::command]
pub fn hear_feed(hear: State<'_, Arc<Hear>>, path: String) -> Result<(), String> {
    if !hear.ready.load(Ordering::Acquire) {
        return Err("the microphone is not being listened to".into());
    }
    let wave = Wave::read(&path).ok_or(format!("could not read {path}"))?;
    let samples = if wave.sample_rate() == SAMPLE_RATE {
        wave.samples().to_vec()
    } else {
        LinearResampler::create(wave.sample_rate(), SAMPLE_RATE).ok_or("no resampler")?.resample(wave.samples(), true)
    };
    hear.send(Command::Feed(samples))
}

#[derive(Serialize, Clone)]
struct Status {
    ready: bool,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct WakeEvent {
    keyword: String,
}

#[derive(Serialize, Clone)]
struct VoiceEvent {
    level: f32,
    speaking: bool,
}

#[derive(Serialize, Clone)]
struct WordsEvent {
    text: String,
    done: Option<f32>,
}

#[derive(Serialize, Clone)]
struct EndedEvent {
    text: Option<String>,
    spoke: bool,
}

/// One turn being listened to. Times are counted in samples heard.
struct Turn {
    heard: usize,
    speech: usize,
    quiet: usize,
    /// Samples he waits for them to start.
    patience: usize,
    frame: Vec<f32>,
    /// The transcriber for this turn, and the words it has made out so far.
    session: Option<stt::Session>,
    words: String,
    /// How finished the words sound to the transcriber, 0..1.
    done: f32,
}

impl Turn {
    fn new(patience_seconds: f32, session: Option<stt::Session>) -> Self {
        Self {
            heard: 0,
            speech: 0,
            quiet: 0,
            patience: (patience_seconds.clamp(1.0, 60.0) * RATE as f32) as usize,
            frame: Vec::with_capacity(FRAME),
            session,
            words: String::new(),
            done: 0.0,
        }
    }

    fn spoke(&self) -> bool {
        self.speech >= MIN_SPEECH
    }

    fn over(&self) -> bool {
        if self.spoke() {
            let silence = if self.session.is_none() {
                END_SILENCE
            } else if self.done >= SOUNDS_DONE && !only_name(&self.words) {
                END_SILENCE_DONE
            } else {
                END_SILENCE_TRANSCRIBED
            };
            self.quiet >= silence || self.heard >= LONGEST_TURN
        } else {
            self.heard >= self.patience
        }
    }
}

fn models_dir(app: &AppHandle) -> PathBuf {
    let bundled = app.path().resolve("models", BaseDirectory::Resource).ok().filter(|p| p.is_dir());
    bundled.unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/models")))
}

fn load_vad(models: &std::path::Path) -> Result<VoiceActivityDetector, String> {
    let config = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(models.join("vad.onnx").to_string_lossy().into_owned()),
            threshold: 0.5,
            min_silence_duration: 0.2,
            min_speech_duration: 0.1,
            window_size: 512,
            max_speech_duration: 60.0,
        },
        sample_rate: SAMPLE_RATE,
        num_threads: 1,
        ..Default::default()
    };
    VoiceActivityDetector::create(&config, 60.0).ok_or("the voice activity model did not load".into())
}

/// Whether all that was said is his name, which starts a turn but is not one.
fn only_name(text: &str) -> bool {
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    !words.is_empty() && words.iter().all(|w| matches!(w.as_str(), "pesto" | "presto" | "hey" | "hi" | "yo" | "ok" | "okay" | "hello" | "hallo"))
}

/// Loudness of a stretch of speech as 0..1, from about a whisper to a raised voice.
fn level(frame: &[f32]) -> f32 {
    let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32).sqrt();
    ((20.0 * rms.max(1e-6).log10() + 52.0) / 36.0).clamp(0.0, 1.0)
}

struct Ears {
    app: AppHandle,
    hear: Arc<Hear>,
    models: PathBuf,
    threshold: f32,
    mic: Option<Mic>,
    resampler: Option<LinearResampler>,
    wake: Option<Wake>,
    vad: Option<VoiceActivityDetector>,
    turn: Option<Turn>,
    stt: Option<stt::Settings>,
    /// The last moments heard, kept so the transcriber gets his name and what ran on from it.
    recent: VecDeque<f32>,
    /// A recording being heard in place of the microphone.
    fed: VecDeque<f32>,
    error: Option<String>,
    /// Whether he is speaking, and how long they have been talking over him without a break.
    talking: bool,
    over_him: usize,
}

impl Ears {
    fn emit<T: Serialize>(&self, name: &str, payload: &T) {
        emit_event(&self.app, name, payload, None);
    }

    fn report(&mut self, error: Option<String>) {
        let ready = self.mic.is_some();
        if self.hear.ready.swap(ready, Ordering::AcqRel) == ready && self.error == error {
            return;
        }
        self.error = error.clone();
        self.emit("hear://status", &Status { ready, error });
    }

    fn open(&mut self) {
        let opened = (|| {
            if self.wake.is_none() {
                self.wake = Some(Wake::load(&self.models.join("kws"), self.threshold)?);
            }
            if self.vad.is_none() {
                self.vad = Some(load_vad(&self.models)?);
            }
            let mic = Mic::open()?;
            self.resampler = if mic.rate == SAMPLE_RATE {
                None
            } else {
                Some(LinearResampler::create(mic.rate, SAMPLE_RATE).ok_or("no resampler")?)
            };
            self.mic = Some(mic);
            Ok::<(), String>(())
        })();
        self.report(opened.err());
    }

    fn close(&mut self) {
        self.mic = None;
        self.resampler = None;
        self.end_turn(false);
        self.report(None);
    }

    fn begin_turn(&mut self, patience: f32, before: Vec<f32>) {
        let session = self.stt.as_ref().map(|settings| stt::Session::open(settings, before));
        self.turn = Some(Turn::new(patience, session));
    }

    /// Ends the turn with whatever words were made out, if it is to be reported at all.
    fn end_turn(&mut self, report: bool) {
        if let Some(turn) = self.turn.take() {
            if report {
                let text = Some(turn.words.clone()).filter(|w| !w.is_empty() && !only_name(w));
                self.emit("hear://ended", &EndedEvent { text, spoke: turn.spoke() });
            }
        }
    }

    /// Takes in what the transcriber has made out. Returns true when it says their turn is over.
    fn listen_to_transcriber(&mut self) -> bool {
        let Some(turn) = self.turn.as_mut() else {
            return false;
        };
        let events: Vec<stt::Heard> = turn.session.as_ref().map(|s| s.heard.try_iter().collect()).unwrap_or_default();
        let mut finished = false;
        let mut failed = None;
        let mut words = None;
        for event in events {
            match event {
                stt::Heard::Partial { text, done } => {
                    turn.words = text.clone();
                    turn.done = done.unwrap_or(0.0);
                    words = Some(WordsEvent { text, done });
                }
                stt::Heard::Committed(text) => {
                    if !text.is_empty() && !only_name(&text) {
                        turn.words = text;
                        finished = true;
                    }
                }
                stt::Heard::Failed(err) => {
                    turn.session = None;
                    failed = Some(err);
                }
            }
        }
        if let Some(words) = words {
            self.emit("hear://words", &words);
        }
        if let Some(err) = failed {
            eprintln!("[hear] speech to text: {err}");
            self.report(Some(format!("speech to text: {err}")));
        } else if finished {
            self.report(None);
        }
        finished
    }

    fn hear(&mut self, samples: Vec<f32>) {
        let mut samples = match &self.resampler {
            Some(r) => r.resample(&samples, false),
            None => samples,
        };
        if !self.fed.is_empty() {
            let n = samples.len().min(self.fed.len());
            samples = self.fed.drain(..n).collect();
        }
        // The voice detector runs all the time, so that at his name it already knows whether they are still talking.
        let Some(vad) = self.vad.as_ref() else {
            return;
        };
        vad.accept_waveform(&samples);
        while !vad.is_empty() {
            vad.pop();
        }
        let speaking = vad.detected();
        self.recent.extend(&samples);
        let extra = self.recent.len().saturating_sub(BEFORE_NAME);
        self.recent.drain(..extra);
        if let Some(keyword) = self.wake.as_mut().and_then(|w| w.hear(&samples)) {
            self.emit("hear://wake", &WakeEvent { keyword });
            self.emit("hear://voice", &VoiceEvent { level: 0.0, speaking });
            let before = self.recent.iter().copied().collect();
            self.begin_turn(WAIT_AFTER_NAME, before);
            return;
        }
        if self.talking && self.turn.is_none() {
            self.over_him = if speaking { self.over_him + samples.len() } else { 0 };
            if self.over_him >= BARGE_SPEECH {
                self.talking = false;
                self.emit("hear://barge", &serde_json::json!({}));
                let before = self.recent.iter().copied().collect();
                self.begin_turn(WAIT_AFTER_NAME, before);
                if let Some(turn) = self.turn.as_mut() {
                    turn.speech = std::mem::take(&mut self.over_him);
                }
                return;
            }
        }
        let finished = self.listen_to_transcriber();
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        if let Some(session) = &turn.session {
            session.send(&samples);
        }
        turn.heard += samples.len();
        if speaking {
            turn.speech += samples.len();
            turn.quiet = 0;
        } else {
            turn.quiet += samples.len();
        }
        turn.frame.extend_from_slice(&samples);
        let mut reports = Vec::new();
        while turn.frame.len() >= FRAME {
            let frame: Vec<f32> = turn.frame.drain(..FRAME).collect();
            reports.push(VoiceEvent { level: if speaking { level(&frame) } else { 0.0 }, speaking });
        }
        let over = finished || turn.over();
        for report in &reports {
            self.emit("hear://voice", report);
        }
        if over {
            self.end_turn(true);
        }
    }

    fn run(mut self, commands: Receiver<Command>, sense: Arc<SenseState>) {
        let mut enabled = false;
        let mut retry_at = Instant::now();
        let mut checked = Instant::now();
        while !sense.shutdown.load(Ordering::Acquire) {
            for command in commands.try_iter() {
                match command {
                    Command::Enable { on, threshold, stt } => {
                        self.stt = stt.filter(|s| !s.api_key.is_empty() && !s.model.is_empty());
                        if (threshold - self.threshold).abs() > 0.001 {
                            self.threshold = threshold;
                            self.wake = None;
                            self.mic = None;
                        }
                        enabled = on;
                        if !on {
                            self.close();
                        }
                        retry_at = Instant::now();
                    }
                    Command::Listen { seconds } => {
                        if self.mic.is_some() {
                            self.begin_turn(seconds, Vec::new());
                        }
                    }
                    Command::Talking(on) => {
                        self.talking = on;
                        self.over_him = 0;
                    }
                    Command::Stop => self.end_turn(false),
                    Command::Feed(samples) => self.fed.extend(samples),
                }
            }
            if !enabled {
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            if self.mic.is_none() {
                if Instant::now() >= retry_at {
                    self.open();
                    retry_at = Instant::now() + RETRY;
                }
                if self.mic.is_none() {
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            }
            if checked.elapsed() > Duration::from_secs(2) {
                checked = Instant::now();
                if self.mic.as_ref().is_some_and(|m| m.stale()) {
                    self.mic = None;
                    self.end_turn(true);
                    retry_at = Instant::now();
                    continue;
                }
            }
            let chunk = self.mic.as_ref().map(|m| m.audio.recv_timeout(Duration::from_millis(100)));
            match chunk {
                Some(Ok(samples)) => self.hear(samples),
                Some(Err(RecvTimeoutError::Timeout)) | None => {}
                Some(Err(RecvTimeoutError::Disconnected)) => {
                    self.mic = None;
                    self.end_turn(true);
                }
            }
        }
    }
}

pub fn start(app: &AppHandle, sense: Arc<SenseState>) -> Arc<Hear> {
    let (tx, rx) = channel();
    let hear = Arc::new(Hear { commands: Mutex::new(tx), ready: AtomicBool::new(false) });
    let models = models_dir(app);
    let app = app.clone();
    let shared = Arc::clone(&hear);
    thread::Builder::new()
        .name("hear".into())
        .spawn(move || {
            let ears = Ears {
                app,
                hear: shared,
                models,
                threshold: 0.35,
                mic: None,
                resampler: None,
                wake: None,
                vad: None,
                turn: None,
                stt: None,
                recent: VecDeque::with_capacity(BEFORE_NAME),
                fed: VecDeque::new(),
                error: None,
                talking: false,
                over_him: 0,
            };
            ears.run(rx, sense)
        })
        .expect("spawn hear");
    hear
}
