use std::cell::RefCell;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomation2, IUIAutomationCacheRequest, IUIAutomationElement,
    IUIAutomationTreeWalker, UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId,
    UIA_IsOffscreenPropertyId,
};

use serde::Serialize;

use super::focus::control_kind;
use super::types::Rect;

#[derive(Serialize)]
pub struct Part {
    #[serde(flatten)]
    pub rect: Rect,
    pub kind: &'static str,
}

/// Keeps a scan cheap on huge trees (browsers, Electron): it stops at whichever limit comes first.
const MAX_DEPTH: usize = 8;
const MAX_NODES: usize = 500;
const MAX_TIME: Duration = Duration::from_millis(150);
const MIN_W: i32 = 100;
const MIN_H: i32 = 16;

/// Control types that make up a window's structure: bars, strips, panes and big blocks.
fn structural(id: i32) -> bool {
    matches!(
        id,
        50004 // edit
        | 50008 // list
        | 50010 // menu bar
        | 50017 // status bar
        | 50018 // tab strip
        | 50021 // toolbar
        | 50023 // tree
        | 50025 // custom
        | 50026 // group
        | 50028 // data grid
        | 50030 // document
        | 50033 // pane
        | 50034 // header
        | 50036 // table
    )
}

/// Worth looking inside: containers, not leaves like edits or headers.
fn container(id: i32) -> bool {
    matches!(id, 50025 | 50026 | 50030 | 50032 | 50033 | 50018 | 50021)
}

struct Uia {
    automation: IUIAutomation,
    walker: IUIAutomationTreeWalker,
    cache: IUIAutomationCacheRequest,
}

thread_local! {
    static UIA: RefCell<Option<Uia>> = const { RefCell::new(None) };
}

fn connect() -> windows::core::Result<Uia> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        if let Ok(a2) = windows::core::Interface::cast::<IUIAutomation2>(&automation) {
            let _ = a2.SetConnectionTimeout(300);
            let _ = a2.SetTransactionTimeout(300);
        }
        let cache = automation.CreateCacheRequest()?;
        cache.AddProperty(UIA_BoundingRectanglePropertyId)?;
        cache.AddProperty(UIA_ControlTypePropertyId)?;
        cache.AddProperty(UIA_IsOffscreenPropertyId)?;
        let walker = automation.ControlViewWalker()?;
        Ok(Uia { automation, walker, cache })
    }
}

fn rect_of(e: &IUIAutomationElement) -> Option<Rect> {
    let r = unsafe { e.CachedBoundingRectangle() }.ok()?;
    Some(Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top })
}

fn scan(uia: &Uia, hwnd: i64) -> windows::core::Result<Vec<Part>> {
    let started = Instant::now();
    let root = unsafe { uia.automation.ElementFromHandleBuildCache(HWND(hwnd as isize as *mut _), &uia.cache) }?;
    let mut parts = Vec::new();
    let root_rect = rect_of(&root);
    let mut queue = VecDeque::from([(root, root_rect, 0usize)]);
    let mut seen = 0;
    while let Some((parent, parent_rect, depth)) = queue.pop_front() {
        if depth >= MAX_DEPTH || started.elapsed() > MAX_TIME {
            break;
        }
        let mut child = unsafe { uia.walker.GetFirstChildElementBuildCache(&parent, &uia.cache) }.ok();
        while let Some(e) = child {
            seen += 1;
            if seen > MAX_NODES {
                return Ok(parts);
            }
            let kind = unsafe { e.CachedControlType() }.map(|t| t.0).unwrap_or(0);
            let offscreen = unsafe { e.CachedIsOffscreen() }.map(|b| b.as_bool()).unwrap_or(false);
            if let Some(r) = rect_of(&e).filter(|r| !offscreen && r.w >= MIN_W && r.h >= MIN_H) {
                // Wrappers the size of their parent (common in Chromium and Electron) say nothing and cost no depth.
                let wrapper = Some(r) == parent_rect;
                if structural(kind) && !wrapper {
                    parts.push(Part { rect: r, kind: control_kind(kind) });
                }
                if container(kind) {
                    queue.push_back((e.clone(), Some(r), if wrapper { depth } else { depth + 1 }));
                }
            }
            child = unsafe { uia.walker.GetNextSiblingElementBuildCache(&e, &uia.cache) }.ok();
        }
    }
    Ok(parts)
}

/// The big structural parts of one window (toolbars, tab strips, panes, documents) in screen pixels.
/// Bounded in depth, node count and time, so it is safe to call whenever he needs to know.
#[tauri::command]
pub async fn window_skeleton(hwnd: i64) -> Result<Vec<Part>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        UIA.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                *slot = Some(connect().map_err(|e| e.to_string())?);
            }
            scan(slot.as_ref().unwrap(), hwnd).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
