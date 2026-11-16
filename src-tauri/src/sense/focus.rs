use std::collections::HashMap;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tauri::AppHandle;
use windows::core::Interface;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomation2};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GA_ROOT,
    GUITHREADINFO,
};

use super::types::{FocusEvent, FocusedElement, Rect};
use super::windows::query_process_exe;
use super::{emit_event, SenseState};

/// Fast enough to follow the caret while someone types.
const POLL: Duration = Duration::from_millis(150);
const NAME_LIMIT: usize = 60;

fn control_kind(id: i32) -> &'static str {
    match id {
        50000 => "button",
        50002 => "checkbox",
        50003 => "combobox",
        50004 => "edit",
        50005 => "link",
        50006 => "image",
        50007 => "listitem",
        50008 => "list",
        50009 | 50010 => "menu",
        50011 => "menuitem",
        50013 => "radio",
        50014 => "scrollbar",
        50015 => "slider",
        50018 => "tabs",
        50019 => "tab",
        50020 => "text",
        50021 => "toolbar",
        50023 => "tree",
        50024 => "treeitem",
        50026 => "group",
        50028 | 50036 => "table",
        50029 => "row",
        50030 => "document",
        50031 => "button",
        50032 => "window",
        50033 => "pane",
        50037 => "titlebar",
        _ => "other",
    }
}

/// The text caret of the foreground thread in screen pixels, for apps that still report one.
fn caret(foreground: HWND) -> Option<Rect> {
    let thread = unsafe { GetWindowThreadProcessId(foreground, None) };
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetGUIThreadInfo(thread, &mut info) }.ok()?;
    if info.hwndCaret.is_invalid() {
        return None;
    }
    let r = info.rcCaret;
    let mut top_left = POINT { x: r.left, y: r.top };
    if !unsafe { ClientToScreen(info.hwndCaret, &mut top_left) }.as_bool() {
        return None;
    }
    Some(Rect {
        x: top_left.x,
        y: top_left.y,
        w: (r.right - r.left).max(1),
        h: (r.bottom - r.top).max(1),
    })
}

fn query(automation: &IUIAutomation, own_pid: u32, exe_cache: &mut HashMap<u32, String>) -> Option<FocusedElement> {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_invalid() {
        return None;
    }
    let element = unsafe { automation.GetFocusedElement() }.ok()?;
    let pid = unsafe { element.CurrentProcessId() }.ok()? as u32;
    if pid == own_pid {
        return None;
    }
    let r = unsafe { element.CurrentBoundingRectangle() }.ok()?;
    let rect = Rect {
        x: r.left,
        y: r.top,
        w: r.right - r.left,
        h: r.bottom - r.top,
    };
    let kind = unsafe { element.CurrentControlType() }.map(|t| control_kind(t.0)).unwrap_or("other");
    let name: String = unsafe { element.CurrentName() }
        .map(|n| n.to_string())
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(NAME_LIMIT)
        .collect();
    let root = unsafe { GetAncestor(foreground, GA_ROOT) };
    Some(FocusedElement {
        kind: kind.to_string(),
        name,
        rect,
        exe: query_process_exe(pid, exe_cache),
        hwnd: root.0 as i64,
        caret: caret(foreground),
    })
}

/// Follows the keyboard focus inside every app through UI Automation.
pub fn spawn_focus_thread(app: AppHandle, state: Arc<SenseState>) -> JoinHandle<()> {
    thread::Builder::new()
        .name("sense-focus".into())
        .spawn(move || {
            if let Err(err) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
                eprintln!("[sense/focus] CoInitializeEx failed: {err}");
                return;
            }
            let automation: IUIAutomation = match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
                Ok(a) => a,
                Err(err) => {
                    eprintln!("[sense/focus] UI Automation unavailable: {err}");
                    unsafe { CoUninitialize() };
                    return;
                }
            };
            // A hung app must not stall the sense for long.
            if let Ok(a2) = automation.cast::<IUIAutomation2>() {
                unsafe {
                    let _ = a2.SetConnectionTimeout(400);
                    let _ = a2.SetTransactionTimeout(400);
                }
            }

            let own_pid = std::process::id();
            let mut exe_cache = HashMap::new();
            let mut last: Option<FocusedElement> = None;
            while state.wait_or_shutdown(POLL) {
                let element = query(&automation, own_pid, &mut exe_cache);
                if element == last {
                    continue;
                }
                last = element.clone();
                let event = FocusEvent { element };
                if let Ok(mut snap) = state.snapshot.write() {
                    snap.focus = event.clone();
                }
                emit_event(&app, "sense://focus", &event, state.log_counters.as_ref().map(|c| &c.focus));
            }
            drop(automation);
            unsafe { CoUninitialize() };
        })
        .expect("spawn sense-focus thread")
}
