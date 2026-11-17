use std::mem::size_of;
use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic,
    IsWindow, IsZoomed, PeekMessageW, PostMessageW, SetForegroundWindow, SetWindowPos,
    ShowWindowAsync, MSG, PM_NOREMOVE, SHOW_WINDOW_CMD, SWP_NOACTIVATE, SWP_NOZORDER, SW_MAXIMIZE,
    SW_MINIMIZE, SW_RESTORE, WM_CLOSE,
};

use crate::sense::types::Rect;

const GONE: &str = "that window is gone";

fn hwnd_of(hwnd: i64) -> HWND {
    HWND(hwnd as isize as *mut _)
}

fn alive(hwnd: HWND) -> bool {
    unsafe { IsWindow(hwnd) }.as_bool()
}

/// Polls `done` every 10 ms until it holds or `limit` runs out.
fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let started = Instant::now();
    loop {
        if done() {
            return true;
        }
        if started.elapsed() >= limit {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn show(hwnd: HWND, cmd: SHOW_WINDOW_CMD) -> Result<(), String> {
    if !alive(hwnd) {
        return Err(GONE.into());
    }
    let _ = unsafe { ShowWindowAsync(hwnd, cmd) };
    Ok(())
}

/// Restores a minimised or maximised window and waits until it is neither.
fn unsnap(hwnd: HWND) -> Result<(), String> {
    let snapped = || unsafe { IsIconic(hwnd).as_bool() || IsZoomed(hwnd).as_bool() };
    if !snapped() {
        return Ok(());
    }
    show(hwnd, SW_RESTORE)?;
    if wait_until(Duration::from_millis(300), || !snapped()) {
        Ok(())
    } else if !alive(hwnd) {
        Err(GONE.into())
    } else {
        Err("that window would not restore".into())
    }
}

/// Makes `hwnd` the foreground window, restoring it first if it is minimised.
///
/// Windows only lets the foreground process hand out focus, and this process never is, so the
/// call joins the input queue of the current foreground thread for the duration of the switch.
pub fn bring_forward(hwnd: HWND) -> Result<(), String> {
    if !alive(hwnd) {
        return Err(GONE.into());
    }
    if unsafe { IsIconic(hwnd) }.as_bool() {
        show(hwnd, SW_RESTORE)?;
        wait_until(Duration::from_millis(300), || {
            !unsafe { IsIconic(hwnd) }.as_bool()
        });
    }

    unsafe {
        // AttachThreadInput needs this thread to own a message queue.
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, HWND::default(), 0, 0, PM_NOREMOVE);

        let me = GetCurrentThreadId();
        let front = GetForegroundWindow();
        let front_thread = if front.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(front, None)
        };
        let attached = front_thread != 0
            && front_thread != me
            && AttachThreadInput(me, front_thread, true).as_bool();

        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);

        if attached {
            let _ = AttachThreadInput(me, front_thread, false);
        }
    }

    if wait_until(
        Duration::from_millis(200),
        || unsafe { GetForegroundWindow() } == hwnd,
    ) {
        Ok(())
    } else if !alive(hwnd) {
        Err(GONE.into())
    } else {
        Err("Windows would not let me bring it forward".into())
    }
}

pub(crate) fn act(hwnd: i64, verb: &str) -> Result<(), String> {
    let hwnd = hwnd_of(hwnd);
    if !alive(hwnd) {
        return Err(GONE.into());
    }
    match verb {
        "focus" => bring_forward(hwnd),
        "minimize" => show(hwnd, SW_MINIMIZE),
        "maximize" => show(hwnd, SW_MAXIMIZE),
        "restore" => {
            show(hwnd, SW_RESTORE)?;
            bring_forward(hwnd)
        }
        "close" => {
            unsafe { PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)) }.map_err(|_| GONE.into())
        }
        _ => Err(format!("I do not know how to {verb} a window")),
    }
}

fn outer_rect(hwnd: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut r) }.ok().map(|_| r)
}

fn frame_rect(hwnd: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut _,
            size_of::<RECT>() as u32,
        )
    }
    .ok()
    .map(|_| r)
}

/// The visible frame, or the window rect when DWM does not report one.
pub(crate) fn visible_rect(hwnd: HWND) -> Option<Rect> {
    let r = frame_rect(hwnd).or_else(|| outer_rect(hwnd))?;
    Some(Rect {
        x: r.left,
        y: r.top,
        w: r.right - r.left,
        h: r.bottom - r.top,
    })
}

/// Moves the window so its visible frame covers `target`, allowing for the invisible
/// resize border that the window rect includes.
fn set_frame(hwnd: HWND, target: Rect) -> Result<(), String> {
    let outer = outer_rect(hwnd).ok_or(GONE)?;
    let frame = frame_rect(hwnd).unwrap_or(outer);
    let left = frame.left - outer.left;
    let top = frame.top - outer.top;
    let right = outer.right - frame.right;
    let bottom = outer.bottom - frame.bottom;
    unsafe {
        SetWindowPos(
            hwnd,
            HWND::default(),
            target.x - left,
            target.y - top,
            target.w + left + right,
            target.h + top + bottom,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
    }
    .map_err(|_| "that window would not move".into())
}

fn off_by(a: Rect, b: Rect) -> i32 {
    [a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h]
        .into_iter()
        .map(i32::abs)
        .max()
        .unwrap_or(0)
}

pub(crate) fn place(hwnd: i64, rect: Rect) -> Result<(), String> {
    let hwnd = hwnd_of(hwnd);
    if !alive(hwnd) {
        return Err(GONE.into());
    }
    if rect.w <= 0 || rect.h <= 0 {
        return Err("that is not a place a window can go".into());
    }
    unsnap(hwnd)?;
    set_frame(hwnd, rect)?;
    // Crossing onto a monitor with a different scale changes the border, so measure again.
    if visible_rect(hwnd).is_some_and(|now| off_by(now, rect) > 1) {
        set_frame(hwnd, rect)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn window_act(hwnd: i64, verb: String) -> Result<(), String> {
    super::blocking(move || act(hwnd, &verb)).await
}

#[tauri::command]
pub async fn window_place(hwnd: i64, rect: Rect) -> Result<(), String> {
    super::blocking(move || place(hwnd, rect)).await
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::process::Command;
    use windows::Win32::Foundation::{BOOL, TRUE};
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, IsWindowVisible, GW_OWNER,
    };

    struct Find {
        pid: u32,
        found: HWND,
    }

    unsafe extern "system" fn each(hwnd: HWND, lp: LPARAM) -> BOOL {
        let find = &mut *(lp.0 as *mut Find);
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let owned = GetWindow(hwnd, GW_OWNER)
            .map(|o| !o.0.is_null())
            .unwrap_or(false);
        if pid == find.pid && IsWindowVisible(hwnd).as_bool() && !owned {
            find.found = hwnd;
            return BOOL(0);
        }
        TRUE
    }

    pub(crate) fn window_of(pid: u32) -> Option<HWND> {
        let mut find = Find {
            pid,
            found: HWND::default(),
        };
        let mut hwnd = None;
        wait_until(Duration::from_secs(5), || {
            let _ = unsafe { EnumWindows(Some(each), LPARAM(&mut find as *mut Find as isize)) };
            if !find.found.0.is_null() {
                hwnd = Some(find.found);
            }
            hwnd.is_some()
        });
        hwnd
    }

    #[test]
    #[ignore]
    fn charmap_round_trip() {
        // The app runs per-monitor aware, so window and frame rects share one pixel space.
        let _ =
            unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };

        let mut child = Command::new(r"C:\Windows\System32\charmap.exe")
            .spawn()
            .unwrap();
        let result = std::panic::catch_unwind(|| {
            let hwnd = window_of(child.id()).expect("charmap window");
            let raw = hwnd.0 as isize as i64;
            let before = visible_rect(hwnd).unwrap();
            println!("charmap frame before: {before:?}");

            let target = Rect {
                x: before.x + 40,
                y: before.y + 30,
                w: before.w + 60,
                h: before.h + 40,
            };
            place(raw, target).unwrap();
            thread::sleep(Duration::from_millis(100));
            let after = visible_rect(hwnd).unwrap();
            println!("asked for {target:?}, got {after:?}");
            assert!(
                off_by(after, target) <= 2,
                "frame {after:?} is not {target:?}"
            );

            act(raw, "minimize").unwrap();
            assert!(wait_until(Duration::from_millis(500), || unsafe {
                IsIconic(hwnd)
            }
            .as_bool()));
            act(raw, "restore").unwrap();
            assert!(!unsafe { IsIconic(hwnd) }.as_bool());

            act(raw, "minimize").unwrap();
            assert!(wait_until(Duration::from_millis(500), || unsafe {
                IsIconic(hwnd)
            }
            .as_bool()));
            let forward = bring_forward(hwnd);
            println!("bring_forward: {forward:?}");
            forward.unwrap();
            assert_eq!(unsafe { GetForegroundWindow() }, hwnd);

            assert!(act(raw, "wiggle").is_err());
            act(raw, "close").unwrap();
        });

        let exited = wait_until(Duration::from_secs(3), || {
            matches!(child.try_wait(), Ok(Some(_)))
        });
        if !exited {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
        assert!(exited, "charmap did not close on WM_CLOSE");
        assert_eq!(act(0x7fff_fff0, "focus"), Err(GONE.to_string()));
    }
}
