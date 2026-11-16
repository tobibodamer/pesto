use std::path::Path;

use sherpa_onnx::{KeywordSpotter, KeywordSpotterConfig, OnlineStream};

pub const SAMPLE_RATE: i32 = 16_000;

/// The pieces the model's vocabulary spells his name with. Each line is one
/// way of calling him: its pieces, how strongly it is favoured (`:`), and how
/// sure the model must be (`#`). The longer phrase is harder to hear by
/// mistake, so it gets away with a lower bar.
fn keywords(threshold: f32) -> String {
    format!(
        "▁P EST O :1.5 #{:.2} @pesto\n▁HE Y ▁P EST O :1.0 #{:.2} @hey_pesto\n",
        threshold,
        threshold * 0.8
    )
}

/// Listens for his name in a stream of 16 kHz mono audio.
pub struct Wake {
    spotter: KeywordSpotter,
    stream: OnlineStream,
}

impl Wake {
    /// `dir` holds the keyword model: encoder.onnx, decoder.onnx, joiner.onnx and tokens.txt.
    pub fn load(dir: &Path, threshold: f32) -> Result<Self, String> {
        Self::with_keywords(dir, keywords(threshold.clamp(0.05, 0.95)))
    }

    fn with_keywords(dir: &Path, keywords: String) -> Result<Self, String> {
        let file = |name: &str| {
            let path = dir.join(name);
            if path.is_file() {
                Ok(Some(path.to_string_lossy().into_owned()))
            } else {
                Err(format!("missing {}", path.display()))
            }
        };
        let mut config = KeywordSpotterConfig::default();
        config.model_config.transducer.encoder = file("encoder.onnx")?;
        config.model_config.transducer.decoder = file("decoder.onnx")?;
        config.model_config.transducer.joiner = file("joiner.onnx")?;
        config.model_config.tokens = file("tokens.txt")?;
        config.model_config.num_threads = 1;
        config.keywords_buf = Some(keywords);
        let spotter =
            KeywordSpotter::create(&config).ok_or("the keyword model did not load".to_string())?;
        let stream = spotter.create_stream();
        Ok(Self { spotter, stream })
    }

    /// Takes the next stretch of audio. Returns which phrase was heard, if one just ended.
    pub fn hear(&mut self, samples: &[f32]) -> Option<String> {
        self.stream.accept_waveform(SAMPLE_RATE, samples);
        let mut heard = None;
        while self.spotter.is_ready(&self.stream) {
            self.spotter.decode(&self.stream);
            if let Some(result) = self.spotter.get_result(&self.stream) {
                if !result.keyword.is_empty() {
                    self.spotter.reset(&self.stream);
                    heard = Some(result.keyword);
                }
            }
        }
        heard
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sherpa_onnx::Wave;

    /// Runs every WAV in `PESTO_WAKE_WAVS` past the detector and prints what it heard
    /// and how long after the start. Files whose name starts with `no-` must stay silent.
    ///   $env:PESTO_WAKE_WAVS = "…\wavs"; cargo test wake -- --ignored --nocapture
    #[test]
    #[ignore]
    fn hears_his_name_in_recordings() {
        let dir = std::env::var("PESTO_WAKE_WAVS").expect("set PESTO_WAKE_WAVS to a folder of WAVs");
        let threshold: f32 = std::env::var("PESTO_WAKE_THRESHOLD")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.25);
        let models = Path::new(env!("CARGO_MANIFEST_DIR")).join("models/kws");
        // A file of keyword lines to try instead of the built-in ones.
        let mut wake = match std::env::var("PESTO_WAKE_KEYWORDS") {
            Ok(file) => Wake::with_keywords(&models, std::fs::read_to_string(file).unwrap()),
            Err(_) => Wake::load(&models, threshold),
        }
        .unwrap();
        let mut wrong = Vec::new();
        let mut files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "wav"))
            .collect();
        files.sort();
        for path in files {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let wave = Wave::read(&path.to_string_lossy()).expect("read wav");
            let rate = wave.sample_rate();
            wake.stream = wake.spotter.create_stream();
            let mut heard: Option<(String, f32)> = None;
            // Fed as the microphone would feed it, with a second of quiet after the end.
            let mut samples = if rate == SAMPLE_RATE {
                wave.samples().to_vec()
            } else {
                sherpa_onnx::LinearResampler::create(rate, SAMPLE_RATE).unwrap().resample(wave.samples(), true)
            };
            samples.extend(std::iter::repeat(0.0).take(SAMPLE_RATE as usize));
            for (i, chunk) in samples.chunks(320).enumerate() {
                if let Some(keyword) = wake.hear(chunk) {
                    heard.get_or_insert((keyword, (i + 1) as f32 * 0.02));
                }
            }
            let expected = !name.starts_with("no-");
            let ok = heard.is_some() == expected;
            println!(
                "{} {name}: {}",
                if ok { "ok  " } else { "FAIL" },
                heard
                    .as_ref()
                    .map(|(k, t)| format!("\"{k}\" at {t:.2}s of {:.2}s", wave.samples().len() as f32 / rate as f32))
                    .unwrap_or("nothing".into())
            );
            if !ok {
                wrong.push(name);
            }
        }
        let missed = wrong.iter().filter(|n| !n.starts_with("no-")).count();
        println!("missed {missed}, mistaken {}", wrong.len() - missed);
        assert!(wrong.is_empty(), "wrong: {wrong:?}");
    }
}
