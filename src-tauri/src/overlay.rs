use std::sync::Arc;

use tauri::{AppHandle, WebviewWindow};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, MA_NOACTIVATE,
    SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE,
    WM_DISPLAYCHANGE, WM_DPICHANGED, WM_MOUSEACTIVATE, WM_NCDESTROY, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

use crate::sense::monitors::query_monitors;
use crate::sense::types::Rect;
use crate::sense::{emit_event, SenseState};

const SUBCLASS_ID: usize = 0x5045_5354;

struct SubclassCtx {
    app: AppHandle,
    state: Arc<SenseState>,
}

unsafe extern "system" fn overlay_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id_subclass: usize,
    dw_ref_data: usize,
) -> LRESULT {
    match msg {
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_DISPLAYCHANGE => {
            let res = DefSubclassProc(hwnd, msg, wparam, lparam);
            if dw_ref_data != 0 {
                let ctx = &*(dw_ref_data as *const SubclassCtx);
                let monitors = query_monitors();
                let v = monitors.virtual_rect;
                let changed = ctx
                    .state
                    .snapshot
                    .read()
                    .map(|s| s.monitors != monitors)
                    .unwrap_or(true);
                if changed {
                    if let Ok(mut snap) = ctx.state.snapshot.write() {
                        snap.monitors = monitors.clone();
                    }
                    emit_event(
                        &ctx.app,
                        "sense://monitors",
                        &monitors,
                        ctx.state.log_counters.as_ref().map(|c| &c.monitors),
                    );
                }
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    v.x,
                    v.y,
                    v.w,
                    v.h,
                    SWP_NOACTIVATE,
                );
            }
            return res;
        }
        WM_DPICHANGED => {
            let res = DefSubclassProc(hwnd, msg, wparam, lparam);
            if dw_ref_data != 0 {
                let ctx = &*(dw_ref_data as *const SubclassCtx);
                if let Ok(snap) = ctx.state.snapshot.read() {
                    let v = snap.monitors.virtual_rect;
                    let _ = SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        v.x,
                        v.y,
                        v.w,
                        v.h,
                        SWP_NOACTIVATE,
                    );
                }
            }
            return res;
        }
        WM_NCDESTROY => {
            let _ = RemoveWindowSubclass(hwnd, Some(overlay_subclass_proc), SUBCLASS_ID);
            if dw_ref_data != 0 {
                drop(Box::from_raw(dw_ref_data as *mut SubclassCtx));
            }
        }
        _ => {}
    }

    DefSubclassProc(hwnd, msg, wparam, lparam)
}

pub fn configure_overlay(
    window: &WebviewWindow,
    app: AppHandle,
    state: Arc<SenseState>,
    virtual_rect: Rect,
) -> Result<isize, String> {
    let hwnd = window
        .hwnd()
        .map_err(|e| format!("failed to get overlay HWND: {e}"))?;
    let hwnd_val = hwnd.0 as isize;
    let win_hwnd = HWND(hwnd_val as _);

    unsafe {
        let ex = GetWindowLongPtrW(win_hwnd, GWL_EXSTYLE);
        let desired = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(win_hwnd, GWL_EXSTYLE, desired);
    }

    window
        .set_ignore_cursor_events(true)
        .map_err(|e| format!("set_ignore_cursor_events failed: {e}"))?;

    let ctx_ptr = Box::into_raw(Box::new(SubclassCtx { app, state })) as usize;
    let subclass_ok = unsafe {
        SetWindowSubclass(
            win_hwnd,
            Some(overlay_subclass_proc),
            SUBCLASS_ID,
            ctx_ptr,
        )
    }
    .as_bool();
    if !subclass_ok {
        unsafe { drop(Box::from_raw(ctx_ptr as *mut SubclassCtx)) };
        eprintln!("[overlay] SetWindowSubclass failed");
    }

    unsafe {
        if let Err(e) = SetWindowPos(
            win_hwnd,
            HWND_TOPMOST,
            virtual_rect.x,
            virtual_rect.y,
            virtual_rect.w,
            virtual_rect.h,
            SWP_NOACTIVATE | SWP_FRAMECHANGED,
        ) {
            eprintln!("[overlay] SetWindowPos failed: {e}");
        }
        // Windows may swap a process's first ShowWindow for whatever its launcher
        // asked for, which can be "hidden"; the second call is always honoured.
        let _ = ShowWindow(win_hwnd, SW_SHOWNOACTIVATE);
        let _ = ShowWindow(win_hwnd, SW_SHOWNOACTIVATE);
    }
    // The windowing layer re-applies its own record of the window whenever
    // click-through is toggled, so it has to know the window is shown too.
    window
        .show()
        .map_err(|e| format!("show overlay failed: {e}"))?;

    Ok(hwnd_val)
}

pub fn fit_overlay_to_virtual(hwnd: isize, rect: Rect) {
    if hwnd == 0 {
        return;
    }
    unsafe {
        let _ = SetWindowPos(
            HWND(hwnd as _),
            HWND_TOPMOST,
            rect.x,
            rect.y,
            rect.w,
            rect.h,
            SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        );
    }
}

pub fn reassert_topmost(hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    unsafe {
        let _ = SetWindowPos(
            HWND(hwnd as _),
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        );
    }
}
