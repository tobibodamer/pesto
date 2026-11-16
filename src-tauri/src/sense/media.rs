use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tauri::AppHandle;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

use super::types::{MediaEvent, MediaSession, PlaybackStatus};
use super::{emit_event, SenseState};

struct WinRtGuard(bool);
impl Drop for WinRtGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { RoUninitialize() };
        }
    }
}

fn init_winrt() -> Result<WinRtGuard, windows::core::Error> {
    match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
        Ok(()) => Ok(WinRtGuard(true)),
        Err(e) if e.code() == RPC_E_CHANGED_MODE => Ok(WinRtGuard(false)),
        Err(e) => Err(e),
    }
}

fn read_sessions(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
) -> windows::core::Result<MediaEvent> {
    let list = manager.GetSessions()?;
    let mut sessions = Vec::new();

    for session in list {
        let app = session
            .SourceAppUserModelId()
            .map(|s| s.to_string_lossy())
            .unwrap_or_default();

        let status = match session.GetPlaybackInfo().and_then(|p| p.PlaybackStatus()) {
            Ok(s) if s == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing => {
                PlaybackStatus::Playing
            }
            Ok(s) if s == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused => {
                PlaybackStatus::Paused
            }
            _ => PlaybackStatus::Stopped,
        };

        let (title, artist) = match session
            .TryGetMediaPropertiesAsync()
            .and_then(|op| op.get())
        {
            Ok(props) => (
                props.Title().map(|s| s.to_string_lossy()).unwrap_or_default(),
                props
                    .Artist()
                    .map(|s| s.to_string_lossy())
                    .unwrap_or_default(),
            ),
            Err(_) => (String::new(), String::new()),
        };

        sessions.push(MediaSession {
            app,
            title,
            artist,
            status,
        });
    }

    Ok(MediaEvent { sessions })
}

pub fn spawn_media_thread(app: AppHandle, state: Arc<SenseState>) -> JoinHandle<()> {
    thread::Builder::new()
        .name("sense-media".into())
        .spawn(move || {
            let _winrt = match init_winrt() {
                Ok(g) => g,
                Err(err) => {
                    eprintln!("[sense/media] RoInitialize failed: {err}");
                    return;
                }
            };

            let mut manager: Option<GlobalSystemMediaTransportControlsSessionManager> = None;
            let mut last_event = MediaEvent {
                sessions: Vec::new(),
            };

            loop {
                if manager.is_none() {
                    match GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
                        .and_then(|op| op.get())
                    {
                        Ok(m) => manager = Some(m),
                        Err(err) => eprintln!("[sense/media] RequestAsync failed: {err}"),
                    }
                }

                if let Some(ref mgr) = manager {
                    match read_sessions(mgr) {
                        Ok(ev) => {
                            if ev != last_event {
                                last_event = ev.clone();
                                if let Ok(mut snap) = state.snapshot.write() {
                                    snap.media = ev.clone();
                                }
                                emit_event(
                                    &app,
                                    "sense://media",
                                    &ev,
                                    state.log_counters.as_ref().map(|c| &c.media),
                                );
                            }
                        }
                        Err(err) => {
                            eprintln!("[sense/media] GetSessions failed: {err}");
                            manager = None;
                        }
                    }
                }

                if !state.wait_or_shutdown(Duration::from_secs(1)) {
                    break;
                }
            }
        })
        .expect("spawn sense-media")
}
