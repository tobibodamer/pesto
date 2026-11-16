//! His ears: the microphone, his name, and the person's voice while he listens.
//!
//! One thread owns the microphone. While idle it only runs the keyword model.
//! Once his name is heard (or the app asks for it) it follows their voice
//! until their turn is over, reporting it to the overlay as it goes:
//!
//!   hear://status  { ready, error }      the microphone came up or went away
//!   hear://wake    { keyword }           his name was said
//!   hear://voice   { level, speaking }   their voice, 25 times a second while listening
//!   hear://ended   { text, spoke }       their turn is over

mod mic;
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
/// How long they must have been quiet before their turn counts as over.
const END_SILENCE: usize = RATE * 11 / 10;
/// Speech shorter than this is a cough or the tail of his name, not a turn.
const MIN_SPEECH: usize = RATE / 4;
/// How long he waits for them to start after his name.
const WAIT_AFTER_NAME: f32 = 5.0;
/// No turn is longer than this.
const LONGEST_TURN: usize = RATE * 45;
const RETRY: Duration = Duration::from_secs(3);

enum Command {
    Enable { on: bool, threshold: f32 },
    Listen { seconds: f32 },
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
#[tauri::command]
pub fn hear_enable(hear: State<'_, Arc<Hear>>, on: bool, threshold: f32) -> Result<(), String> {
    hear.send(Command::Enable { on, threshold })
}

/// Listens for a turn without his name being said, giving up after `seconds` of nothing.
#[tauri::command]
pub fn hear_listen(hear: State<'_, Arc<Hear>>, seconds: f32) -> Result<(), String> {
    if !hear.ready.load(Ordering::Acquire) {
        return Err("the microphone is not being listened to".into());
    }
    hear.send(Command::Listen { seconds })
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
}

impl Turn {
    fn new(patience_seconds: f32) -> Self {
        Self {
            heard: 0,
            speech: 0,
            quiet: 0,
            patience: (patience_seconds.clamp(1.0, 60.0) * RATE as f32) as usize,
            frame: Vec::with_capacity(FRAME),
        }
    }

    fn spoke(&self) -> bool {
        self.speech >= MIN_SPEECH
    }

    fn over(&self) -> bool {
        if self.spoke() {
            self.quiet >= END_SILENCE || self.heard >= LONGEST_TURN
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
    /// A recording being heard in place of the microphone.
    fed: VecDeque<f32>,
    error: Option<String>,
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

    fn end_turn(&mut self, report: bool) {
        if let Some(turn) = self.turn.take() {
            if report {
                self.emit("hear://ended", &EndedEvent { text: None, spoke: turn.spoke() });
            }
        }
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
        if let Some(keyword) = self.wake.as_mut().and_then(|w| w.hear(&samples)) {
            self.emit("hear://wake", &WakeEvent { keyword });
            self.emit("hear://voice", &VoiceEvent { level: 0.0, speaking });
            self.turn = Some(Turn::new(WAIT_AFTER_NAME));
            return;
        }
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
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
        let over = turn.over();
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
                    Command::Enable { on, threshold } => {
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
                            self.turn = Some(Turn::new(seconds));
                        }
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
                fed: VecDeque::new(),
                error: None,
            };
            ears.run(rx, sense)
        })
        .expect("spawn hear");
    hear
}
