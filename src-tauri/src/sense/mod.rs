pub mod audio;
pub mod cursor;
pub mod focus;
pub mod media;
pub mod monitors;
pub mod skeleton;
pub mod system;
pub mod types;
pub mod windows;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use self::types::{AudioEvent, FocusEvent, MediaEvent, Rect, SenseSnapshot};

pub struct SenseLogCounters {
    pub monitors: AtomicU64,
    pub windows: AtomicU64,
    pub cursor: AtomicU64,
    pub audio: AtomicU64,
    pub media: AtomicU64,
    pub system: AtomicU64,
    pub focus: AtomicU64,
}

impl SenseLogCounters {
    pub fn from_env() -> Option<Arc<Self>> {
        if std::env::var("PESTO_SENSE_LOG").as_deref() == Ok("1") {
            Some(Arc::new(Self {
                monitors: AtomicU64::new(0),
                windows: AtomicU64::new(0),
                cursor: AtomicU64::new(0),
                audio: AtomicU64::new(0),
                media: AtomicU64::new(0),
                system: AtomicU64::new(0),
                focus: AtomicU64::new(0),
            }))
        } else {
            None
        }
    }

    pub fn flush_second(&self) {
        let entries = [
            ("sense://monitors", self.monitors.swap(0, Ordering::Relaxed)),
            ("sense://windows", self.windows.swap(0, Ordering::Relaxed)),
            ("sense://cursor", self.cursor.swap(0, Ordering::Relaxed)),
            ("sense://audio", self.audio.swap(0, Ordering::Relaxed)),
            ("sense://media", self.media.swap(0, Ordering::Relaxed)),
            ("sense://system", self.system.swap(0, Ordering::Relaxed)),
            ("sense://focus", self.focus.swap(0, Ordering::Relaxed)),
        ];
        for (name, count) in entries {
            if count > 0 {
                eprintln!("[sense] {name}: {count}");
            }
        }
    }
}

pub struct SenseState {
    pub snapshot: RwLock<SenseSnapshot>,
    pub hit_regions: RwLock<Vec<Rect>>,
    pub hold_interactive: AtomicBool,
    pub shutdown: AtomicBool,
    shutdown_mu: Mutex<bool>,
    shutdown_cv: Condvar,
    pub log_counters: Option<Arc<SenseLogCounters>>,
}

impl SenseState {
    pub fn new_initial() -> Arc<Self> {
        let monitors = monitors::query_monitors();
        let mut exe_cache = HashMap::new();
        let windows = windows::query_windows(&monitors.monitors, &mut exe_cache, None);
        let cursor = cursor::query_cursor();
        let system = system::query_initial_system();

        let log_counters = SenseLogCounters::from_env();
        if log_counters.is_some() {
            eprintln!(
                "[sense] init: monitors={}, virtual=({},{} {}x{}), windows={}, cursor=({},{} buttons={})",
                monitors.monitors.len(),
                monitors.virtual_rect.x,
                monitors.virtual_rect.y,
                monitors.virtual_rect.w,
                monitors.virtual_rect.h,
                windows.windows.len(),
                cursor.x,
                cursor.y,
                cursor.buttons
            );
        }

        let snapshot = SenseSnapshot {
            monitors,
            windows,
            cursor,
            audio: AudioEvent {
                out: 0.0,
                mic: 0.0,
                sessions: Vec::new(),
            },
            media: MediaEvent {
                sessions: Vec::new(),
            },
            system,
            focus: FocusEvent { element: None },
        };

        Arc::new(Self {
            snapshot: RwLock::new(snapshot),
            hit_regions: RwLock::new(Vec::new()),
            hold_interactive: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            shutdown_mu: Mutex::new(false),
            shutdown_cv: Condvar::new(),
            log_counters,
        })
    }

    /// Sleeps for `dur` unless shutdown is signaled. Returns `true` to continue, `false` to exit.
    pub fn wait_or_shutdown(&self, dur: Duration) -> bool {
        if self.shutdown.load(Ordering::Acquire) {
            return false;
        }
        if let Ok(guard) = self.shutdown_mu.lock() {
            if *guard {
                return false;
            }
            let (guard, _) = self
                .shutdown_cv
                .wait_timeout_while(guard, dur, |stopped| !*stopped)
                .unwrap_or_else(|e| e.into_inner());
            !*guard
        } else {
            !self.shutdown.load(Ordering::Acquire)
        }
    }

    pub fn signal_shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        if let Ok(mut guard) = self.shutdown_mu.lock() {
            *guard = true;
            self.shutdown_cv.notify_all();
        }
    }
}

pub fn emit_event<T: Serialize + ?Sized>(
    app: &AppHandle,
    name: &str,
    payload: &T,
    counter: Option<&AtomicU64>,
) {
    if let Err(err) = app.emit_to("overlay", name, payload) {
        eprintln!("[sense] emit {name} failed: {err}");
    } else if let Some(c) = counter {
        c.fetch_add(1, Ordering::Relaxed);
    }
}

pub struct SenseHandles {
    windows_tid: Arc<AtomicU32>,
    threads: Vec<JoinHandle<()>>,
}

impl SenseHandles {
    pub fn shutdown(mut self, state: &SenseState) {
        state.signal_shutdown();
        windows::stop_windows_thread(self.windows_tid.load(Ordering::Acquire));
        for h in self.threads.drain(..) {
            let _ = h.join();
        }
    }
}

pub fn start_sense(app: AppHandle, state: Arc<SenseState>, overlay_hwnd: isize) -> SenseHandles {
    let windows_tid = Arc::new(AtomicU32::new(0));
    let threads = vec![
        cursor::spawn_cursor_thread(app.clone(), Arc::clone(&state)),
        windows::spawn_windows_thread(app.clone(), Arc::clone(&state), Arc::clone(&windows_tid)),
        audio::spawn_audio_thread(app.clone(), Arc::clone(&state)),
        media::spawn_media_thread(app.clone(), Arc::clone(&state)),
        focus::spawn_focus_thread(app.clone(), Arc::clone(&state)),
        system::spawn_system_thread(app, Arc::clone(&state), overlay_hwnd),
    ];
    SenseHandles {
        windows_tid,
        threads,
    }
}
