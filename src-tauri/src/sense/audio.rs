use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::core::{Interface, PWSTR};
use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

use super::types::{AudioEvent, AudioSession};
use super::windows::query_process_exe;
use super::{emit_event, SenseState};

const AUDIO_PERIOD: Duration = Duration::from_millis(50); // 20 Hz
const RETRY_INTERVAL: Duration = Duration::from_secs(2);
const PEAK_THRESHOLD: f32 = 0.001;

struct ComGuard(bool);
impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn init_com() -> Result<ComGuard, windows::core::Error> {
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr == S_OK || hr == S_FALSE {
        Ok(ComGuard(true))
    } else if hr == RPC_E_CHANGED_MODE {
        Ok(ComGuard(false))
    } else {
        Err(windows::core::Error::from(hr))
    }
}

fn device_id(dev: &IMMDevice) -> Option<String> {
    let pwstr: PWSTR = unsafe { dev.GetId() }.ok()?;
    let s = unsafe { pwstr.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(pwstr.0 as *const _)) };
    s
}

struct RenderEndpoint {
    id: String,
    meter: IAudioMeterInformation,
    sessions_mgr: IAudioSessionManager2,
}

struct CaptureEndpoint {
    id: String,
    meter: IAudioMeterInformation,
}

fn acquire_render(enumerator: &IMMDeviceEnumerator) -> Option<RenderEndpoint> {
    let dev = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }.ok()?;
    let id = device_id(&dev)?;
    let meter: IAudioMeterInformation = unsafe { dev.Activate(CLSCTX_ALL, None) }.ok()?;
    let sessions_mgr: IAudioSessionManager2 = unsafe { dev.Activate(CLSCTX_ALL, None) }.ok()?;
    Some(RenderEndpoint {
        id,
        meter,
        sessions_mgr,
    })
}

fn acquire_capture(enumerator: &IMMDeviceEnumerator) -> Option<CaptureEndpoint> {
    let dev = unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) }.ok()?;
    let id = device_id(&dev)?;
    let meter: IAudioMeterInformation = unsafe { dev.Activate(CLSCTX_ALL, None) }.ok()?;
    Some(CaptureEndpoint { id, meter })
}

fn default_endpoint_id(
    enumerator: &IMMDeviceEnumerator,
    flow: windows::Win32::Media::Audio::EDataFlow,
) -> Option<String> {
    let dev = unsafe { enumerator.GetDefaultAudioEndpoint(flow, eConsole) }.ok()?;
    device_id(&dev)
}

struct CachedSession {
    exe: String,
    meter: IAudioMeterInformation,
}

fn refresh_session_list(
    mgr: &IAudioSessionManager2,
    exe_cache: &mut HashMap<u32, String>,
) -> windows::core::Result<Vec<CachedSession>> {
    let session_enum = unsafe { mgr.GetSessionEnumerator()? };
    let count = unsafe { session_enum.GetCount()? };
    let mut result = Vec::new();
    let mut seen_pids = HashSet::new();

    for i in 0..count {
        let Ok(ctrl) = (unsafe { session_enum.GetSession(i) }) else {
            continue;
        };
        let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() else {
            continue;
        };
        let Ok(pid) = (unsafe { ctrl2.GetProcessId() }) else {
            continue;
        };
        let exe = if pid == 0 {
            if unsafe { ctrl2.IsSystemSoundsSession() } == S_OK {
                "system".to_string()
            } else {
                continue;
            }
        } else {
            seen_pids.insert(pid);
            let name = query_process_exe(pid, exe_cache);
            if name.is_empty() {
                continue;
            }
            name
        };

        if let Ok(meter) = ctrl.cast::<IAudioMeterInformation>() {
            result.push(CachedSession { exe, meter });
        }
    }

    exe_cache.retain(|pid, _| seen_pids.contains(pid));
    Ok(result)
}

pub fn spawn_audio_thread(app: AppHandle, state: Arc<SenseState>) -> JoinHandle<()> {
    thread::Builder::new()
        .name("sense-audio".into())
        .spawn(move || {
            let _com = match init_com() {
                Ok(g) => g,
                Err(err) => {
                    eprintln!("[sense/audio] CoInitializeEx failed: {err}");
                    return;
                }
            };

            let mut enumerator: Option<IMMDeviceEnumerator> = None;
            let mut render: Option<RenderEndpoint> = None;
            let mut capture: Option<CaptureEndpoint> = None;
            let mut cached_sessions: Vec<CachedSession> = Vec::new();
            let mut exe_cache: HashMap<u32, String> = HashMap::new();
            let mut last_acquire = Instant::now() - RETRY_INTERVAL;
            let mut was_active = false;
            let mut tick: u64 = 0;

            loop {
                if enumerator.is_none() && last_acquire.elapsed() >= RETRY_INTERVAL {
                    last_acquire = Instant::now();
                    match unsafe {
                        CoCreateInstance::<_, IMMDeviceEnumerator>(
                            &MMDeviceEnumerator,
                            None,
                            CLSCTX_ALL,
                        )
                    } {
                        Ok(e) => enumerator = Some(e),
                        Err(err) => eprintln!("[sense/audio] MMDeviceEnumerator failed: {err}"),
                    }
                }

                if let Some(ref enum_dev) = enumerator {
                    let due_check = last_acquire.elapsed() >= RETRY_INTERVAL;
                    if due_check {
                        last_acquire = Instant::now();

                        let cur_render_id = default_endpoint_id(enum_dev, eRender);
                        if cur_render_id.as_deref() != render.as_ref().map(|r| r.id.as_str()) {
                            render = acquire_render(enum_dev);
                            cached_sessions.clear();
                            if let Some(ref r) = render {
                                if let Ok(list) =
                                    refresh_session_list(&r.sessions_mgr, &mut exe_cache)
                                {
                                    cached_sessions = list;
                                }
                            }
                        }

                        let cur_capture_id = default_endpoint_id(enum_dev, eCapture);
                        if cur_capture_id.as_deref() != capture.as_ref().map(|c| c.id.as_str()) {
                            capture = acquire_capture(enum_dev);
                        }
                    }

                    // 2 Hz session enumeration
                    if tick.is_multiple_of(10) {
                        if let Some(ref r) = render {
                            match refresh_session_list(&r.sessions_mgr, &mut exe_cache) {
                                Ok(list) => cached_sessions = list,
                                Err(_) => {
                                    render = None;
                                    cached_sessions.clear();
                                }
                            }
                        }
                    }
                }

                let mut out = 0.0f32;
                if let Some(ref r) = render {
                    match unsafe { r.meter.GetPeakValue() } {
                        Ok(v) => out = v.clamp(0.0, 1.0),
                        Err(_) => {
                            render = None;
                            cached_sessions.clear();
                        }
                    }
                }

                let mut mic = 0.0f32;
                if let Some(ref c) = capture {
                    match unsafe { c.meter.GetPeakValue() } {
                        Ok(v) => mic = v.clamp(0.0, 1.0),
                        Err(_) => {
                            capture = None;
                        }
                    }
                }

                let active = out > PEAK_THRESHOLD || mic > PEAK_THRESHOLD;
                if active {
                    let mut by_exe: HashMap<String, f32> = HashMap::new();
                    for s in &cached_sessions {
                        if let Ok(p) = unsafe { s.meter.GetPeakValue() } {
                            let peak = p.clamp(0.0, 1.0);
                            if peak >= PEAK_THRESHOLD {
                                by_exe
                                    .entry(s.exe.clone())
                                    .and_modify(|e| *e = e.max(peak))
                                    .or_insert(peak);
                            }
                        }
                    }
                    let mut sessions: Vec<AudioSession> = by_exe
                        .into_iter()
                        .map(|(exe, peak)| AudioSession { exe, peak })
                        .collect();
                    sessions.sort_by(|a, b| b.peak.total_cmp(&a.peak));

                    let event = AudioEvent { out, mic, sessions };
                    if let Ok(mut snap) = state.snapshot.write() {
                        snap.audio = event.clone();
                    }
                    emit_event(
                        &app,
                        "sense://audio",
                        &event,
                        state.log_counters.as_ref().map(|c| &c.audio),
                    );
                    was_active = true;
                } else if was_active {
                    let zero = AudioEvent {
                        out: 0.0,
                        mic: 0.0,
                        sessions: Vec::new(),
                    };
                    if let Ok(mut snap) = state.snapshot.write() {
                        snap.audio = zero.clone();
                    }
                    emit_event(
                        &app,
                        "sense://audio",
                        &zero,
                        state.log_counters.as_ref().map(|c| &c.audio),
                    );
                    was_active = false;
                }

                tick = tick.wrapping_add(1);
                if !state.wait_or_shutdown(AUDIO_PERIOD) {
                    break;
                }
            }
        })
        .expect("spawn sense-audio")
}
