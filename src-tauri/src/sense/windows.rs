use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::mem::size_of;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::core::w;
use windows::Win32::Foundation::{
    CloseHandle, BOOL, HWND, LPARAM, LRESULT, RECT, TRUE, WPARAM,
};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumWindows, GetAncestor,
    GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowLongW, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
    IsWindowVisible, IsZoomed, KillTimer, PostQuitMessage, PostThreadMessageW, RegisterClassW,
    SetTimer, TranslateMessage, CHILDID_SELF, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE,
    EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_SHOW, EVENT_SYSTEM_FOREGROUND,
    EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MOVESIZEEND,
    EVENT_SYSTEM_MOVESIZESTART, GA_ROOT, GWL_EXSTYLE, HWND_MESSAGE, MSG, OBJID_WINDOW,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_APP, WM_QUIT, WM_TIMER, WNDCLASSW,
    WS_EX_TOOLWINDOW,
};

use super::types::{MonitorInfo, Rect, WindowInfo, WindowState, WindowsEvent};
use super::{emit_event, SenseState};

const TIMER_POLL: usize = 1;
const TIMER_COALESCE: usize = 2;
const POLL_IDLE_MS: u32 = 100;
const POLL_MOVING_MS: u32 = 16;
const MIN_EMIT_INTERVAL: Duration = Duration::from_millis(16);
const WM_APP_SHUTDOWN: u32 = WM_APP + 1;

pub fn query_process_exe(pid: u32, cache: &mut HashMap<u32, String>) -> String {
    if let Some(cached) = cache.get(&pid) {
        return cached.clone();
    }
    let handle = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(h) => h,
        Err(_) => return String::new(),
    };

    let mut buf = vec![0u16; 512];
    let mut len = buf.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }

    let exe = if ok.is_ok() && len > 0 {
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        Path::new(&full)
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    } else {
        String::new()
    };

    if !exe.is_empty() {
        cache.insert(pid, exe.clone());
    }
    exe
}

fn rect_from_win32(r: RECT) -> Rect {
    Rect {
        x: r.left,
        y: r.top,
        w: r.right - r.left,
        h: r.bottom - r.top,
    }
}

fn get_window_rect_extended(hwnd: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    let dwm_ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut _,
            size_of::<RECT>() as u32,
        )
    }
    .is_ok();
    if dwm_ok {
        return Some(rect_from_win32(r));
    }
    if unsafe { GetWindowRect(hwnd, &mut r) }.is_ok() {
        return Some(rect_from_win32(r));
    }
    None
}

fn best_monitor_for_rect(rect: Rect, monitors: &[MonitorInfo]) -> (usize, Option<Rect>) {
    if monitors.is_empty() {
        return (0, None);
    }
    let mut best_id = monitors[0].id;
    let mut best_rect = monitors[0].rect;
    let mut best_area: i64 = 0;

    for m in monitors {
        let area = rect.intersection_area(m.rect);
        if area > best_area {
            best_area = area;
            best_id = m.id;
            best_rect = m.rect;
        }
    }

    if best_area == 0 {
        if let Some(primary) = monitors.iter().find(|m| m.primary) {
            return (primary.id, Some(primary.rect));
        }
    }
    (best_id, Some(best_rect))
}

struct EnumCtx<'a> {
    own_pid: u32,
    monitors: &'a [MonitorInfo],
    exe_cache: &'a mut HashMap<u32, String>,
    seen_pids: HashSet<u32>,
    windows: Vec<WindowInfo>,
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut EnumCtx<'_>);

    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 || pid == ctx.own_pid {
        return TRUE;
    }

    if GetAncestor(hwnd, GA_ROOT) != hwnd {
        return TRUE;
    }

    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if (ex_style & WS_EX_TOOLWINDOW.0) != 0 {
        return TRUE;
    }

    let mut cloaked: u32 = 0;
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut _,
        size_of::<u32>() as u32,
    )
    .is_ok()
        && cloaked != 0
    {
        return TRUE;
    }

    let mut class_buf = [0u16; 128];
    let class_len = GetClassNameW(hwnd, &mut class_buf);
    if class_len > 0 {
        let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);
        if class_name == "Progman" || class_name == "WorkerW" {
            return TRUE;
        }
    }

    let title_len = GetWindowTextLengthW(hwnd);
    if title_len <= 0 {
        return TRUE;
    }
    let mut title_buf = vec![0u16; title_len as usize + 1];
    let actual_len = GetWindowTextW(hwnd, &mut title_buf);
    if actual_len <= 0 {
        return TRUE;
    }
    let title = String::from_utf16_lossy(&title_buf[..actual_len as usize]);
    if title.trim().is_empty() || title == "Program Manager" {
        return TRUE;
    }

    let iconic = IsIconic(hwnd).as_bool();
    let zoomed = !iconic && IsZoomed(hwnd).as_bool();
    let rect = match get_window_rect_extended(hwnd) {
        Some(r) => r,
        None => return TRUE,
    };

    if !iconic && (rect.w <= 0 || rect.h <= 0) {
        return TRUE;
    }

    ctx.seen_pids.insert(pid);
    let exe = query_process_exe(pid, ctx.exe_cache);
    let (monitor, mon_rect) = best_monitor_for_rect(rect, ctx.monitors);

    let state = if iconic {
        WindowState::Minimized
    } else if zoomed {
        WindowState::Maximized
    } else if mon_rect.is_some_and(|mr| rect == mr) {
        WindowState::Fullscreen
    } else {
        WindowState::Normal
    };

    ctx.windows.push(WindowInfo {
        hwnd: hwnd.0 as isize as i64,
        title,
        exe,
        pid,
        rect,
        monitor,
        state,
    });

    TRUE
}

pub fn query_windows(
    monitors: &[MonitorInfo],
    exe_cache: &mut HashMap<u32, String>,
    moving: Option<i64>,
) -> WindowsEvent {
    let own_pid = std::process::id();
    let mut ctx = EnumCtx {
        own_pid,
        monitors,
        exe_cache,
        seen_pids: HashSet::new(),
        windows: Vec::new(),
    };

    if let Err(err) = unsafe {
        EnumWindows(
            Some(enum_windows_proc),
            LPARAM(&mut ctx as *mut EnumCtx<'_> as isize),
        )
    } {
        if err.code().0 != 0 {
            eprintln!("[sense/windows] EnumWindows failed: {err}");
        }
    }

    let seen = ctx.seen_pids;
    let windows = ctx.windows;
    exe_cache.retain(|pid, _| seen.contains(pid));

    let fg = unsafe { GetForegroundWindow() };
    let foreground = if !fg.0.is_null() {
        let mut fg_pid = 0u32;
        unsafe { GetWindowThreadProcessId(fg, Some(&mut fg_pid)) };
        if fg_pid != 0 && fg_pid != own_pid {
            Some(fg.0 as isize as i64)
        } else {
            None
        }
    } else {
        None
    };

    let valid_moving = moving.filter(|&h| unsafe { IsWindow(HWND(h as isize as _)).as_bool() });

    WindowsEvent {
        windows,
        foreground,
        moving: valid_moving,
    }
}

struct HookLoopState {
    app: AppHandle,
    state: Arc<SenseState>,
    msg_hwnd: HWND,
    own_pid: u32,
    exe_cache: HashMap<u32, String>,
    last_event: WindowsEvent,
    known_hwnds: HashSet<i64>,
    moving: Option<i64>,
    last_refresh: Instant,
    coalesce_armed: bool,
}

impl HookLoopState {
    fn refresh_and_emit(&mut self) {
        let monitors = self
            .state
            .snapshot
            .read()
            .map(|s| s.monitors.monitors.clone())
            .unwrap_or_default();
        let ev = query_windows(&monitors, &mut self.exe_cache, self.moving);
        self.moving = ev.moving;
        self.last_refresh = Instant::now();
        self.known_hwnds = ev.windows.iter().map(|w| w.hwnd).collect();

        if ev != self.last_event {
            self.last_event = ev.clone();
            if let Ok(mut snap) = self.state.snapshot.write() {
                snap.windows = ev.clone();
            }
            emit_event(
                &self.app,
                "sense://windows",
                &ev,
                self.state.log_counters.as_ref().map(|c| &c.windows),
            );
        }
    }

    fn request_refresh(&mut self) {
        let elapsed = self.last_refresh.elapsed();
        if elapsed >= MIN_EMIT_INTERVAL {
            if self.coalesce_armed {
                unsafe {
                    let _ = KillTimer(self.msg_hwnd, TIMER_COALESCE);
                }
                self.coalesce_armed = false;
            }
            self.refresh_and_emit();
        } else if !self.coalesce_armed {
            let wait_ms = (MIN_EMIT_INTERVAL - elapsed).as_millis().max(1) as u32;
            unsafe {
                SetTimer(self.msg_hwnd, TIMER_COALESCE, wait_ms, None);
            }
            self.coalesce_armed = true;
        }
    }
}

thread_local! {
    static HOOK_STATE: RefCell<Option<HookLoopState>> = const { RefCell::new(None) };
}

unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    HOOK_STATE.with(|cell| {
        let Ok(mut borrow) = cell.try_borrow_mut() else {
            return;
        };
        let Some(ctx) = borrow.as_mut() else {
            return;
        };

        let hwnd_val = hwnd.0 as isize as i64;

        match event {
            EVENT_SYSTEM_MOVESIZESTART => {
                if !hwnd.0.is_null() && GetAncestor(hwnd, GA_ROOT) == hwnd {
                    let mut pid = 0u32;
                    GetWindowThreadProcessId(hwnd, Some(&mut pid));
                    if pid != 0 && pid != ctx.own_pid {
                        ctx.moving = Some(hwnd_val);
                        SetTimer(ctx.msg_hwnd, TIMER_POLL, POLL_MOVING_MS, None);
                        ctx.request_refresh();
                    }
                }
            }
            EVENT_SYSTEM_MOVESIZEEND => {
                ctx.moving = None;
                SetTimer(ctx.msg_hwnd, TIMER_POLL, POLL_IDLE_MS, None);
                ctx.request_refresh();
            }
            EVENT_SYSTEM_FOREGROUND
            | EVENT_SYSTEM_MINIMIZESTART
            | EVENT_SYSTEM_MINIMIZEEND => {
                ctx.request_refresh();
            }
            EVENT_OBJECT_DESTROY => {
                if id_object == OBJID_WINDOW.0
                    && id_child == CHILDID_SELF as i32
                    && !hwnd.0.is_null()
                    && (ctx.known_hwnds.contains(&hwnd_val) || ctx.moving == Some(hwnd_val))
                {
                    if ctx.moving == Some(hwnd_val) {
                        ctx.moving = None;
                        SetTimer(ctx.msg_hwnd, TIMER_POLL, POLL_IDLE_MS, None);
                    }
                    ctx.request_refresh();
                }
            }
            EVENT_OBJECT_SHOW | EVENT_OBJECT_HIDE | EVENT_OBJECT_NAMECHANGE
                if id_object == OBJID_WINDOW.0
                    && id_child == CHILDID_SELF as i32
                    && !hwnd.0.is_null()
                    && GetAncestor(hwnd, GA_ROOT) == hwnd =>
            {
                ctx.request_refresh();
            }
            _ => {}
        }
    });
}

unsafe extern "system" fn msg_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_TIMER => {
            HOOK_STATE.with(|cell| {
                if let Ok(mut borrow) = cell.try_borrow_mut() {
                    if let Some(ctx) = borrow.as_mut() {
                        if wparam.0 == TIMER_COALESCE {
                            let _ = KillTimer(hwnd, TIMER_COALESCE);
                            ctx.coalesce_armed = false;
                            ctx.refresh_and_emit();
                        } else if wparam.0 == TIMER_POLL {
                            ctx.request_refresh();
                        }
                    }
                }
            });
            LRESULT(0)
        }
        WM_APP_SHUTDOWN => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

pub fn spawn_windows_thread(
    app: AppHandle,
    state: Arc<SenseState>,
    thread_id_out: Arc<AtomicU32>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("sense-windows".into())
        .spawn(move || {
            let tid = unsafe { GetCurrentThreadId() };
            thread_id_out.store(tid, Ordering::Release);

            let hinstance = unsafe { GetModuleHandleW(None) }.unwrap_or_default();
            let class_name = w!("PestoWindowsSenseMsg");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(msg_wnd_proc),
                hInstance: hinstance.into(),
                lpszClassName: class_name,
                ..Default::default()
            };
            unsafe {
                RegisterClassW(&wc);
            }

            let msg_hwnd = match unsafe {
                CreateWindowExW(
                    Default::default(),
                    class_name,
                    w!("PestoWindowsSense"),
                    Default::default(),
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    None,
                    hinstance,
                    None,
                )
            } {
                Ok(h) => h,
                Err(err) => {
                    eprintln!("[sense/windows] CreateWindowExW failed: {err}");
                    return;
                }
            };

            let initial = state
                .snapshot
                .read()
                .map(|s| s.windows.clone())
                .unwrap_or(WindowsEvent {
                    windows: Vec::new(),
                    foreground: None,
                    moving: None,
                });
            let known_hwnds = initial.windows.iter().map(|w| w.hwnd).collect();

            HOOK_STATE.with(|cell| {
                *cell.borrow_mut() = Some(HookLoopState {
                    app,
                    state: Arc::clone(&state),
                    msg_hwnd,
                    own_pid: std::process::id(),
                    exe_cache: HashMap::new(),
                    last_event: initial,
                    known_hwnds,
                    moving: None,
                    last_refresh: Instant::now(),
                    coalesce_armed: false,
                });
            });

            let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
            let hook_ranges = [
                (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
                (EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND),
                (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
                (EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE),
                (EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE),
            ];
            let mut hooks: Vec<HWINEVENTHOOK> = Vec::with_capacity(hook_ranges.len());
            for (min_ev, max_ev) in hook_ranges {
                let h = unsafe { SetWinEventHook(min_ev, max_ev, None, Some(win_event_proc), 0, 0, flags) };
                if !h.is_invalid() {
                    hooks.push(h);
                } else {
                    eprintln!("[sense/windows] SetWinEventHook failed for {min_ev:#x}..={max_ev:#x}");
                }
            }

            unsafe {
                SetTimer(msg_hwnd, TIMER_POLL, POLL_IDLE_MS, None);
            }

            if state.shutdown.load(Ordering::Acquire) {
                unsafe {
                    PostQuitMessage(0);
                }
            }

            let mut msg = MSG::default();
            unsafe {
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    if msg.message == WM_APP_SHUTDOWN {
                        break;
                    }
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }

            for h in hooks {
                unsafe {
                    let _ = UnhookWinEvent(h);
                }
            }
            unsafe {
                let _ = KillTimer(msg_hwnd, TIMER_POLL);
                let _ = KillTimer(msg_hwnd, TIMER_COALESCE);
                let _ = DestroyWindow(msg_hwnd);
            }
            HOOK_STATE.with(|cell| {
                *cell.borrow_mut() = None;
            });
        })
        .expect("spawn sense-windows")
}

pub fn stop_windows_thread(thread_id: u32) {
    if thread_id != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_contains_and_intersection() {
        let r = Rect {
            x: -1920,
            y: 0,
            w: 1920,
            h: 1080,
        };
        assert!(r.contains(-1920, 0));
        assert!(r.contains(-1, 1079));
        assert!(!r.contains(0, 0));
        assert!(!r.contains(-1920, 1080));

        let w = Rect {
            x: -100,
            y: 100,
            w: 200,
            h: 300,
        };
        assert_eq!(r.intersection_area(w), 100 * 300);
    }

    #[test]
    fn best_monitor_handles_negative_coords() {
        let mons = vec![
            MonitorInfo {
                id: 0,
                rect: Rect {
                    x: -1920,
                    y: 0,
                    w: 1920,
                    h: 1080,
                },
                work: Rect {
                    x: -1920,
                    y: 0,
                    w: 1920,
                    h: 1040,
                },
                scale: 1.0,
                primary: false,
            },
            MonitorInfo {
                id: 1,
                rect: Rect {
                    x: 0,
                    y: 0,
                    w: 1920,
                    h: 1080,
                },
                work: Rect {
                    x: 0,
                    y: 0,
                    w: 1920,
                    h: 1040,
                },
                scale: 1.0,
                primary: true,
            },
        ];
        let (id, _) = best_monitor_for_rect(
            Rect {
                x: -1500,
                y: 50,
                w: 800,
                h: 600,
            },
            &mons,
        );
        assert_eq!(id, 0);

        // Minimized offscreen fallback picks primary monitor.
        let (min_id, _) = best_monitor_for_rect(
            Rect {
                x: -32000,
                y: -32000,
                w: 160,
                h: 28,
            },
            &mons,
        );
        assert_eq!(min_id, 1);
    }
}
