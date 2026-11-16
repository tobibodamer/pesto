use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, SampleFormat};

/// The default microphone, delivering mono audio at its own sample rate.
pub struct Mic {
    _stream: cpal::Stream,
    pub rate: i32,
    pub audio: Receiver<Vec<f32>>,
    device: String,
    broken: Arc<AtomicBool>,
}

fn default_device() -> Option<(cpal::Device, String)> {
    let device = cpal::default_host().default_input_device()?;
    let id = device.id().ok()?.to_string();
    Some((device, id))
}

impl Mic {
    pub fn open() -> Result<Self, String> {
        let (device, id) = default_device().ok_or("no microphone found")?;
        let config = device.default_input_config().map_err(|e| e.to_string())?;
        let channels = config.channels() as usize;
        let rate = config.sample_rate() as i32;
        let (tx, audio) = channel::<Vec<f32>>();
        let broken = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&broken);
        let on_error = move |err: cpal::Error| {
            if !matches!(err.kind(), ErrorKind::Xrun | ErrorKind::RealtimeDenied) {
                eprintln!("[hear] microphone: {err}");
                flag.store(true, Ordering::Release);
            }
        };
        let stream = match config.sample_format() {
            SampleFormat::F32 => device.build_input_stream(
                config.into(),
                move |data: &[f32], _: &_| {
                    let _ = tx.send(data.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect());
                },
                on_error,
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                config.into(),
                move |data: &[i16], _: &_| {
                    let _ = tx.send(
                        data.chunks(channels)
                            .map(|f| f.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / channels as f32)
                            .collect(),
                    );
                },
                on_error,
                None,
            ),
            other => return Err(format!("microphone sample format {other:?} is not handled")),
        }
        .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok(Self { _stream: stream, rate, audio, device: id, broken })
    }

    /// Whether this is no longer the microphone to listen to: it failed, or another became the default.
    pub fn stale(&self) -> bool {
        self.broken.load(Ordering::Acquire) || default_device().map(|(_, id)| id) != Some(self.device.clone())
    }
}
