use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::IUIAutomationElement;
use windows::Win32::UI::WindowsAndMessaging::IsWindow;

use super::focus::control_kind;
use super::skeleton::{rect_of, with_uia, Uia};
use super::types::Rect;

#[derive(Serialize)]
pub struct Element {
    #[serde(flatten)]
    pub rect: Rect,
    pub kind: &'static str,
    pub name: String,
    /// Names this element to `with_element` until its window is scanned again.
    pub key: u32,
}

/// UI Automation runs in the multithreaded apartment here, where an element may be used from any thread.
struct Held(IUIAutomationElement);
unsafe impl Send for Held {}

/// The elements of each window's latest scan, kept so that he can act on what he saw.
static HELD: OnceLock<Mutex<HashMap<i64, Vec<(u32, Held)>>>> = OnceLock::new();
static NEXT_KEY: AtomicU32 = AtomicU32::new(1);

fn held() -> std::sync::MutexGuard<'static, HashMap<i64, Vec<(u32, Held)>>> {
    HELD.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs `f` on an element from the latest scan of its window.
pub fn with_element<T>(hwnd: i64, key: u32, f: impl FnOnce(&IUIAutomationElement) -> Result<T, String>) -> Result<T, String> {
    let element = held()
        .get(&hwnd)
        .and_then(|all| all.iter().find(|(k, _)| *k == key))
        .map(|(_, e)| e.0.clone())
        .ok_or("it is not there any more")?;
    with_uia(|_| Ok(f(&element)))?
}

/// A web page can hold tens of thousands of nodes; the scan goes breadth first, so the app's own
/// bars and buttons are found before whichever limit ends it.
const MAX_DEPTH: usize = 30;
const MAX_NODES: usize = 4000;
const MAX_FOUND: usize = 600;
const MAX_TIME: Duration = Duration::from_millis(700);
const NAME_LIMIT: usize = 60;
const MIN_SIDE: i32 = 4;

/// Things someone could mean by "this one": controls, and text.
fn pointable(id: i32) -> bool {
    matches!(
        id,
        50000 // button
        | 50002 // checkbox
        | 50003 // combobox
        | 50004 // edit
        | 50005 // link
        | 50007 // list item
        | 50011 // menu item
        | 50013 // radio button
        | 50014 // scrollbar
        | 50015 // slider
        | 50019 // tab
        | 50020 // text
        | 50024 // tree item
        | 50030 // document
        | 50031 // split button
    )
}

/// Recognisable by kind alone, so worth reporting without a name.
fn speaks_for_itself(id: i32) -> bool {
    matches!(id, 50003 | 50004 | 50014 | 50015 | 50030)
}

/// Whatever is inside these is part of them, not a thing of its own.
fn leaf(id: i32) -> bool {
    matches!(id, 50000 | 50002 | 50004 | 50005 | 50006 | 50011 | 50013 | 50014 | 50015 | 50020 | 50031)
}

fn clip(r: Rect, to: Rect) -> Option<Rect> {
    let x = r.x.max(to.x);
    let y = r.y.max(to.y);
    let w = (r.x + r.w).min(to.x + to.w) - x;
    let h = (r.y + r.h).min(to.y + to.h) - y;
    (w >= MIN_SIDE && h >= MIN_SIDE).then_some(Rect { x, y, w, h })
}

fn scan(uia: &Uia, hwnd: i64) -> windows::core::Result<Vec<Element>> {
    let mut kept = Vec::new();
    let found = walk(uia, hwnd, &mut kept);
    let mut all = held();
    all.retain(|&h, _| unsafe { IsWindow(HWND(h as isize as *mut _)) }.as_bool());
    all.insert(hwnd, kept);
    found
}

fn walk(uia: &Uia, hwnd: i64, kept: &mut Vec<(u32, Held)>) -> windows::core::Result<Vec<Element>> {
    let started = Instant::now();
    let root = unsafe { uia.automation.ElementFromHandleBuildCache(HWND(hwnd as isize as *mut _), &uia.named) }?;
    let Some(bounds) = rect_of(&root) else {
        return Ok(Vec::new());
    };
    let mut found = Vec::new();
    let mut queue = VecDeque::from([(root, 0usize)]);
    let mut seen = 0;
    while let Some((parent, depth)) = queue.pop_front() {
        if started.elapsed() > MAX_TIME {
            break;
        }
        let mut child = unsafe { uia.walker.GetFirstChildElementBuildCache(&parent, &uia.named) }.ok();
        while let Some(e) = child {
            seen += 1;
            if seen > MAX_NODES || found.len() >= MAX_FOUND {
                return Ok(found);
            }
            let kind = unsafe { e.CachedControlType() }.map(|t| t.0).unwrap_or(0);
            let offscreen = unsafe { e.CachedIsOffscreen() }.map(|b| b.as_bool()).unwrap_or(false);
            let rect = rect_of(&e);
            let visible = rect.and_then(|r| clip(r, bounds)).filter(|_| !offscreen);
            if let Some(r) = visible.filter(|_| pointable(kind)) {
                let name: String = unsafe { e.CachedName() }
                    .map(|n| n.to_string())
                    .unwrap_or_default()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(NAME_LIMIT)
                    .collect();
                if !name.is_empty() || speaks_for_itself(kind) {
                    let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
                    kept.push((key, Held(e.clone())));
                    found.push(Element { rect: r, kind: control_kind(kind), name, key });
                }
            }
            // A wrapper with no size of its own can still hold visible things; one that is scrolled away cannot.
            let hidden = offscreen || rect.is_some_and(|r| r.w > 0 && r.h > 0 && visible.is_none());
            if !hidden && !leaf(kind) && depth + 1 < MAX_DEPTH {
                queue.push_back((e.clone(), depth + 1));
            }
            child = unsafe { uia.walker.GetNextSiblingElementBuildCache(&e, &uia.named) }.ok();
        }
    }
    Ok(found)
}

/// The named controls and texts visible in one window, in screen pixels, the app's own chrome first.
/// Bounded in node count and time, so it is safe on any window.
pub fn elements(hwnd: i64) -> Result<Vec<Element>, String> {
    with_uia(|uia| scan(uia, hwnd))
}

#[tauri::command]
pub async fn window_elements(hwnd: i64) -> Result<Vec<Element>, String> {
    tauri::async_runtime::spawn_blocking(move || elements(hwnd))
        .await
        .map_err(|e| e.to_string())?
}
