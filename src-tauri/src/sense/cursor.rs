use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{CloseHandle, HANDLE, POINT};
use windows::Win32::System::Threading::{
    CreateWaitableTimerExW, SetWaitableTimer, WaitForSingleObject,
    CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

use super::types::CursorEvent;
use super::{emit_event, SenseState};

const CURSOR_PERIOD: Duration = Duration::from_nanos(8_333_333); // 120 Hz

struct TimerHandle(HANDLE);
impl Drop for TimerHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

pub fn query_cursor() -> CursorEvent {
    let mut pt = POINT::default();
    let ok = unsafe { GetCursorPos(&mut pt) }.is_ok();
    let mut buttons: u8 = 0;
    unsafe {
        if (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 {
            buttons |= 1;
        }
        if (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & 0x8000) != 0 {
            buttons |= 2;
        }
        if (GetAsyncKeyState(VK_MBUTTON.0 as i32) as u16 & 0x8000) != 0 {
            buttons |= 4;
        }
    }
    if ok {
        CursorEvent {
            x: pt.x,
            y: pt.y,
            buttons,
        }
    } else {
        CursorEvent { x: 0, y: 0, buttons }
    }
}

fn sleep_until(timer: Option<&TimerHandle>, deadline: Instant) {
    let now = Instant::now();
    if deadline <= now {
        return;
    }
    let dur = deadline - now;
    if let Some(t) = timer {
        // Negative value specifies relative time in 100-nanosecond intervals.
        let due_100ns = -((dur.as_nanos() / 100) as i64).max(1);
        let ok = unsafe { SetWaitableTimer(t.0, &due_100ns, 0, None, None, false) }.is_ok();
        if ok {
            unsafe {
                WaitForSingleObject(t.0, 200);
            }
            return;
        }
    }
    thread::sleep(dur);
}

pub fn spawn_cursor_thread(app: AppHandle, state: Arc<SenseState>) -> JoinHandle<()> {
    thread::Builder::new()
        .name("sense-cursor".into())
        .spawn(move || {
            let timer = unsafe {
                CreateWaitableTimerExW(
                    None,
                    None,
                    CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                    TIMER_ALL_ACCESS.0,
                )
            }
            .ok()
            .map(TimerHandle);

            let mut last_cursor = state
                .snapshot
                .read()
                .map(|s| s.cursor)
                .unwrap_or_else(|_| query_cursor());
            let mut last_interactive = false;
            let mut next_tick = Instant::now() + CURSOR_PERIOD;

            while !state.shutdown.load(Ordering::Relaxed) {
                let mut pt = POINT::default();
                let pos_ok = unsafe { GetCursorPos(&mut pt) }.is_ok();
                let mut buttons: u8 = 0;
                unsafe {
                    if (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 {
                        buttons |= 1;
                    }
                    if (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & 0x8000) != 0 {
                        buttons |= 2;
                    }
                    if (GetAsyncKeyState(VK_MBUTTON.0 as i32) as u16 & 0x8000) != 0 {
                        buttons |= 4;
                    }
                }

                if pos_ok {
                    let current = CursorEvent {
                        x: pt.x,
                        y: pt.y,
                        buttons,
                    };
                    if current != last_cursor {
                        last_cursor = current;
                        if let Ok(mut snap) = state.snapshot.write() {
                            snap.cursor = current;
                        }
                        emit_event(
                            &app,
                            "sense://cursor",
                            &current,
                            state.log_counters.as_ref().map(|c| &c.cursor),
                        );
                    }

                    let interactive = if state.hold_interactive.load(Ordering::Relaxed) {
                        true
                    } else if let Ok(regions) = state.hit_regions.read() {
                        regions.iter().any(|r| r.contains(pt.x, pt.y))
                    } else {
                        false
                    };

                    if interactive != last_interactive {
                        if let Some(win) = app.get_webview_window("overlay") {
                            if let Err(err) = win.set_ignore_cursor_events(!interactive) {
                                eprintln!(
                                    "[sense/cursor] set_ignore_cursor_events failed: {err}"
                                );
                            } else {
                                last_interactive = interactive;
                            }
                        }
                    }
                }

                sleep_until(timer.as_ref(), next_tick);
                let now = Instant::now();
                next_tick += CURSOR_PERIOD;
                if next_tick + CURSOR_PERIOD * 2 < now {
                    next_tick = now + CURSOR_PERIOD;
                }
            }
        })
        .expect("spawn sense-cursor")
}
