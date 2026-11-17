use std::mem::size_of;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

use tauri::State;
use windows::core::HRESULT;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::Accessibility::{
    ExpandCollapseState_Collapsed, IUIAutomationElement, IUIAutomationExpandCollapsePattern,
    IUIAutomationInvokePattern, IUIAutomationLegacyIAccessiblePattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTextPattern, IUIAutomationTogglePattern,
    IUIAutomationValuePattern, UIA_ExpandCollapsePatternId, UIA_E_TIMEOUT, UIA_InvokePatternId,
    UIA_LegacyIAccessiblePatternId, UIA_SelectionItemPatternId, UIA_TextPatternId,
    UIA_TogglePatternId, UIA_ValuePatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEINPUT, MOUSE_EVENT_FLAGS, VK_LBUTTON, VK_RBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetCursorPos, GetWindowThreadProcessId, SetCursorPos, WindowFromPoint, GA_ROOT,
};

use super::window::bring_forward;
use crate::sense::elements::with_element;
use crate::sense::SenseState;

/// A call that outlasts the wait has still gone through: a button that opens a dialog only
/// answers once the dialog is closed.
fn went_through(result: windows::core::Result<()>) -> bool {
    match result {
        Ok(()) => true,
        Err(e) => e.code() == HRESULT(UIA_E_TIMEOUT as i32),
    }
}

/// Works the element through whatever it offers for that, without the mouse.
fn by_pattern(e: &IUIAutomationElement) -> Option<&'static str> {
    unsafe {
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            if went_through(p.Invoke()) {
                return Some("pressed");
            }
        }
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
            if went_through(p.Toggle()) {
                return Some("toggled");
            }
        }
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            if went_through(p.Select()) {
                return Some("selected");
            }
        }
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
            let open = p.CurrentExpandCollapseState().is_ok_and(|s| s != ExpandCollapseState_Collapsed);
            if went_through(if open { p.Collapse() } else { p.Expand() }) {
                return Some(if open { "closed" } else { "opened" });
            }
        }
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
            if went_through(p.DoDefaultAction()) {
                return Some("pressed");
            }
        }
    }
    None
}

struct PassThrough<'a>(&'a SenseState);
impl Drop for PassThrough<'_> {
    fn drop(&mut self) {
        self.0.pass_through.store(false, Ordering::Relaxed);
    }
}

fn mouse(flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dwFlags: flags, ..Default::default() },
        },
    }
}

/// Whether a click at this point would land in the window, or on the overlay that lets it through.
fn reachable(root: HWND, at: POINT) -> bool {
    unsafe {
        let hit = WindowFromPoint(at);
        if GetAncestor(hit, GA_ROOT) == root {
            return true;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hit, Some(&mut pid));
        pid == std::process::id()
    }
}

/// A real click in the middle of the element, for apps that say where a thing is but not how to
/// work it. The cursor is back where it was a moment later.
fn click(state: &SenseState, hwnd: i64, e: &IUIAutomationElement) -> Result<(), String> {
    let r = unsafe { e.CurrentBoundingRectangle() }.map_err(|_| "it is not there any more")?;
    if r.right - r.left < 2 || r.bottom - r.top < 2 {
        return Err("it is not on screen any more".into());
    }
    let at = POINT { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    let root = HWND(hwnd as isize as *mut _);
    unsafe {
        let down = |key: u16| (GetAsyncKeyState(key as i32) as u16 & 0x8000) != 0;
        if down(VK_LBUTTON.0) || down(VK_RBUTTON.0) {
            return Err("they are using the mouse".into());
        }
        if !reachable(root, at) {
            bring_forward(root)?;
            sleep(Duration::from_millis(150));
            if !reachable(root, at) {
                return Err("something is covering it".into());
            }
        }
        state.pass_through.store(true, Ordering::Relaxed);
        let _guard = PassThrough(state);
        // Long enough for the cursor thread to make the overlay click-through.
        sleep(Duration::from_millis(40));
        let mut back = POINT::default();
        let _ = GetCursorPos(&mut back);
        SetCursorPos(at.x, at.y).map_err(|_| "the cursor would not move")?;
        let sent = SendInput(&[mouse(MOUSEEVENTF_LEFTDOWN), mouse(MOUSEEVENTF_LEFTUP)], size_of::<INPUT>() as i32);
        sleep(Duration::from_millis(30));
        let _ = SetCursorPos(back.x, back.y);
        if sent != 2 {
            return Err("Windows would not take the click".into());
        }
    }
    Ok(())
}

fn press(state: &SenseState, hwnd: i64, e: &IUIAutomationElement) -> Result<String, String> {
    let enabled = unsafe { e.CurrentIsEnabled() }.map_err(|_| "it is not there any more")?;
    if !enabled.as_bool() {
        return Err("it is greyed out".into());
    }
    if let Some(how) = by_pattern(e) {
        return Ok(how.into());
    }
    click(state, hwnd, e).map(|()| "clicked".into())
}

fn text(e: &IUIAutomationElement, limit: i32) -> String {
    let clipped = |s: String| s.trim().chars().take(limit as usize).collect::<String>();
    unsafe {
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
            let mut seen = String::new();
            if let Ok(ranges) = p.GetVisibleRanges() {
                for i in 0..ranges.Length().unwrap_or(0) {
                    if let Ok(part) = ranges.GetElement(i).and_then(|r| r.GetText(limit)) {
                        seen.push_str(&part.to_string());
                        seen.push('\n');
                    }
                    if seen.len() >= limit as usize {
                        break;
                    }
                }
            }
            if seen.trim().is_empty() {
                seen = p.DocumentRange().and_then(|r| r.GetText(limit)).map(|t| t.to_string()).unwrap_or_default();
            }
            if !seen.trim().is_empty() {
                return clipped(seen);
            }
        }
        if let Ok(value) = e.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).and_then(|p| p.CurrentValue()) {
            if !value.is_empty() {
                return clipped(value.to_string());
            }
        }
        clipped(e.CurrentName().map(|n| n.to_string()).unwrap_or_default())
    }
}

/// Works an element from the window's latest scan the way a click would. Resolves to how it was done.
#[tauri::command]
pub async fn element_press(state: State<'_, Arc<SenseState>>, hwnd: i64, key: u32) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_element(hwnd, key, |e| press(&state, hwnd, e)))
        .await
        .map_err(|e| e.to_string())?
}

/// Brings the element's window forward and gives the element the keyboard focus.
#[tauri::command]
pub async fn element_focus(hwnd: i64, key: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_element(hwnd, key, |e| {
            bring_forward(HWND(hwnd as isize as *mut _))?;
            unsafe { e.SetFocus() }.map_err(|_| "it would not take the cursor".to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What is visible of a document's text, or the value of a field, at most `limit` characters.
#[tauri::command]
pub async fn element_text(hwnd: i64, key: u32, limit: i32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || with_element(hwnd, key, |e| Ok(text(e, limit.clamp(1, 20_000)))))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::act::window::tests::window_of;
    use crate::sense::elements::elements;
    use std::process::Command;
    use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

    fn checked(hwnd: i64, key: u32) -> i32 {
        with_element(hwnd, key, |e| {
            unsafe { e.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId).and_then(|p| p.CurrentToggleState()) }
                .map(|s| s.0)
                .map_err(|e| e.to_string())
        })
        .unwrap()
    }

    #[test]
    #[ignore]
    fn charmap_press_click_and_text() {
        let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        let state = SenseState::new_initial();
        let mut child = Command::new(r"C:\Windows\System32\charmap.exe").spawn().unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let hwnd = window_of(child.id()).expect("charmap window").0 as isize as i64;
            sleep(Duration::from_millis(500));
            let all = elements(hwnd).unwrap();
            println!("{} elements", all.len());
            for e in all.iter().filter(|e| e.kind != "text").take(30) {
                println!("  {} {} «{}» at {},{}", e.key, e.kind, e.name, e.rect.x, e.rect.y);
            }

            let tick = all.iter().find(|e| e.kind == "checkbox").expect("a checkbox");
            let before = checked(hwnd, tick.key);
            let how = with_element(hwnd, tick.key, |e| press(&state, hwnd, e)).unwrap();
            sleep(Duration::from_millis(300));
            println!("checkbox by pattern: {how}, {before} -> {}", checked(hwnd, tick.key));
            assert_ne!(checked(hwnd, tick.key), before);

            with_element(hwnd, tick.key, |e| click(&state, hwnd, e)).unwrap();
            sleep(Duration::from_millis(300));
            println!("checkbox by a real click: back to {}", checked(hwnd, tick.key));
            assert_eq!(checked(hwnd, tick.key), before);
            assert!(!state.pass_through.load(Ordering::Relaxed));

            // The button beside the field puts the selected character into it.
            let field = all.iter().find(|e| e.kind == "edit").expect("a field");
            let select = all
                .iter()
                .filter(|e| e.kind == "button" && e.rect.x > field.rect.x && (e.rect.y - field.rect.y).abs() < field.rect.h)
                .min_by_key(|e| e.rect.x)
                .expect("the button beside the field");
            let how = with_element(hwnd, select.key, |e| press(&state, hwnd, e)).unwrap();
            sleep(Duration::from_millis(300));
            let held = with_element(hwnd, field.key, |e| Ok(text(e, 100))).unwrap();
            println!("button «{}»: {how}; the field now holds {held:?}", select.name);
            assert!(!held.is_empty());

            assert_eq!(with_element(hwnd, 0, |_| Ok(())), Err("it is not there any more".to_string()));
        }));
        let _ = child.kill();
        result.unwrap();
    }
}
