//! Speech to text over ElevenLabs' realtime socket. One session is one turn:
//! audio goes up as it is heard, words come back as they are understood, and
//! the service says when the person has finished.

use std::io::ErrorKind;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;

use super::wake::SAMPLE_RATE;

/// Samples sent per message: a tenth of a second.
const CHUNK: usize = SAMPLE_RATE as usize / 10;

#[derive(Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub api_key: String,
    pub model: String,
    /// ISO 639-1, or empty to let the service work it out.
    pub language: String,
}

pub enum Heard {
    /// The words so far, and how likely it is that they have finished, when the model says.
    Partial { text: String, done: Option<f32> },
    /// A finished stretch of speech.
    Committed(String),
    Failed(String),
}

pub struct Session {
    audio: Sender<Vec<f32>>,
    pub heard: Receiver<Heard>,
}

impl Session {
    /// Connects in the background. `before` is what was heard just before now, sent first.
    pub fn open(settings: &Settings, before: Vec<f32>) -> Self {
        let (audio, audio_rx) = channel();
        let (heard_tx, heard) = channel();
        let _ = audio.send(before);
        let settings = settings.clone();
        thread::Builder::new()
            .name("hear-stt".into())
            .spawn(move || {
                if let Err(err) = run(&settings, audio_rx, &heard_tx) {
                    let _ = heard_tx.send(Heard::Failed(err));
                }
            })
            .expect("spawn hear-stt");
        Self { audio, heard }
    }

    pub fn send(&self, samples: &[f32]) {
        let _ = self.audio.send(samples.to_vec());
    }
}

fn url(settings: &Settings) -> String {
    // Only the live model can tell a finished thought from a pause; the older one waits for silence.
    let commit = if settings.model.contains("live") {
        "commit_strategy=turn_prediction".to_string()
    } else {
        "commit_strategy=vad&vad_silence_threshold_secs=0.8".to_string()
    };
    let language = if settings.language.is_empty() {
        String::new()
    } else {
        format!("&language_code={}", settings.language)
    };
    format!(
        "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id={}&audio_format=pcm_16000&{commit}{language}",
        settings.model
    )
}

fn run(settings: &Settings, audio: Receiver<Vec<f32>>, heard: &Sender<Heard>) -> Result<(), String> {
    let mut request = url(settings).into_client_request().map_err(|e| e.to_string())?;
    request
        .headers_mut()
        .insert("xi-api-key", HeaderValue::from_str(&settings.api_key).map_err(|e| e.to_string())?);
    let (mut socket, _) = tungstenite::connect(request).map_err(|e| e.to_string())?;
    // Short reads, so audio keeps going out between the messages coming in.
    let wait = Some(Duration::from_millis(15));
    match socket.get_mut() {
        MaybeTlsStream::Rustls(tls) => tls.get_mut().set_read_timeout(wait),
        MaybeTlsStream::Plain(tcp) => tcp.set_read_timeout(wait),
        _ => Ok(()),
    }
    .map_err(|e| e.to_string())?;

    let encoder = base64::engine::general_purpose::STANDARD;
    let mut pending: Vec<f32> = Vec::new();
    loop {
        loop {
            match audio.try_recv() {
                Ok(samples) => pending.extend(samples),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    let _ = socket.close(None);
                    return Ok(());
                }
            }
        }
        while pending.len() >= CHUNK {
            let n = pending.len().min(CHUNK * 5);
            let bytes: Vec<u8> = pending
                .drain(..n)
                .flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())
                .collect();
            let message = serde_json::json!({
                "message_type": "input_audio_chunk",
                "audio_base_64": encoder.encode(bytes),
                "commit": false,
                "sample_rate": SAMPLE_RATE,
            });
            socket.send(Message::Text(message.to_string().into())).map_err(|e| e.to_string())?;
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let Ok(m) = serde_json::from_str::<serde_json::Value>(text.as_str()) else {
                    continue;
                };
                let said = || m["text"].as_str().unwrap_or("").trim().to_string();
                let event = match m["message_type"].as_str().unwrap_or("") {
                    "partial_transcript" => Heard::Partial { text: said(), done: m["turn_probability"].as_f64().map(|p| p as f32) },
                    "committed_transcript" | "committed_transcript_with_timestamps" => Heard::Committed(said()),
                    "session_started" | "warning" => continue,
                    kind => match m["error"].as_str() {
                        Some(error) => return Err(format!("{kind}: {error}")),
                        None => continue,
                    },
                };
                if heard.send(event).is_err() {
                    let _ = socket.close(None);
                    return Ok(());
                }
            }
            Ok(Message::Close(_)) => return Err("the transcription service hung up".into()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
}
