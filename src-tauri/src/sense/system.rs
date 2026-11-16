use std::mem::size_of;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tauri::AppHandle;
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::System::Threading::GetSystemTimes;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

use super::monitors::query_monitors;
use super::types::{BatteryStatus, SystemEvent};
use super::{emit_event, SenseState};
use crate::overlay::fit_overlay_to_virtual;

#[derive(Clone, Copy, Default)]
struct CpuTimes {
    idle: u64,
    kernel: u64,
    user: u64,
}

fn filetime_to_u64(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
}

fn read_cpu_times() -> Option<CpuTimes> {
    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let res = unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) };
    if res.is_err() {
        return None;
    }
    Some(CpuTimes {
        idle: filetime_to_u64(idle),
        kernel: filetime_to_u64(kernel),
        user: filetime_to_u64(user),
    })
}

fn compute_cpu(prev: CpuTimes, curr: CpuTimes) -> f32 {
    let d_idle = curr.idle.saturating_sub(prev.idle);
    let d_kernel = curr.kernel.saturating_sub(prev.kernel);
    let d_user = curr.user.saturating_sub(prev.user);
    // Win32 GetSystemTimes includes idle time inside kernel time.
    let d_total = d_kernel.saturating_add(d_user);
    if d_total == 0 {
        0.0
    } else {
        (d_total.saturating_sub(d_idle) as f64 / d_total as f64).clamp(0.0, 1.0) as f32
    }
}

fn read_idle_ms() -> u32 {
    let mut lii = LASTINPUTINFO {
        cbSize: size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if unsafe { GetLastInputInfo(&mut lii) }.as_bool() {
        let now = unsafe { GetTickCount64() } as u32;
        now.wrapping_sub(lii.dwTime)
    } else {
        0
    }
}

fn read_battery() -> Option<BatteryStatus> {
    let mut sps = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut sps) }.is_err() {
        return None;
    }
    // 128 = no system battery, 255 = unknown status.
    if (sps.BatteryFlag & 128) != 0 || sps.BatteryLifePercent == 255 {
        return None;
    }
    Some(BatteryStatus {
        percent: sps.BatteryLifePercent.min(100),
        charging: sps.ACLineStatus == 1 || (sps.BatteryFlag & 8) != 0,
    })
}

pub fn query_initial_system() -> SystemEvent {
    SystemEvent {
        idle_ms: read_idle_ms(),
        battery: read_battery(),
        cpu: 0.0,
    }
}

pub fn spawn_system_thread(
    app: AppHandle,
    state: Arc<SenseState>,
    overlay_hwnd: isize,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("sense-system".into())
        .spawn(move || {
            let mut prev_cpu = read_cpu_times();
            let mut tick: u64 = 0;

            while state.wait_or_shutdown(Duration::from_secs(1)) {
                tick = tick.wrapping_add(1);

                let curr_cpu = read_cpu_times();
                let cpu = match (prev_cpu, curr_cpu) {
                    (Some(p), Some(c)) => compute_cpu(p, c),
                    _ => 0.0,
                };
                if curr_cpu.is_some() {
                    prev_cpu = curr_cpu;
                }

                let event = SystemEvent {
                    idle_ms: read_idle_ms(),
                    battery: read_battery(),
                    cpu,
                };

                if let Ok(mut snap) = state.snapshot.write() {
                    snap.system = event.clone();
                }
                emit_event(
                    &app,
                    "sense://system",
                    &event,
                    state.log_counters.as_ref().map(|c| &c.system),
                );

                // Fallback display layout check in case a display change missed WM_DISPLAYCHANGE.
                if tick.is_multiple_of(2) {
                    let monitors = query_monitors();
                    let changed = state
                        .snapshot
                        .read()
                        .map(|s| s.monitors != monitors)
                        .unwrap_or(false);
                    if changed {
                        let v = monitors.virtual_rect;
                        if let Ok(mut snap) = state.snapshot.write() {
                            snap.monitors = monitors.clone();
                        }
                        emit_event(
                            &app,
                            "sense://monitors",
                            &monitors,
                            state.log_counters.as_ref().map(|c| &c.monitors),
                        );
                        fit_overlay_to_virtual(overlay_hwnd, v);
                    } else {
                        crate::overlay::reassert_topmost(overlay_hwnd);
                    }
                }

                if let Some(counters) = &state.log_counters {
                    counters.flush_second();
                }
            }
        })
        .expect("spawn sense-system")
}
