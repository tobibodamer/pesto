use std::str::FromStr;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Tried in order after the configured one, until one is free.
const HOTKEYS: [&str; 3] = ["ctrl+alt+p", "alt+shift+p", "ctrl+alt+shift+p"];

/// The little text box for typing to Pesto. The overlay never takes focus,
/// so typing happens in this separate window, which the overlay places next
/// to him when the hotkey asks for it.
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle(app);
                }
            })
            .build(),
    )?;

    let configured = crate::config::read(app).ok().and_then(|c| {
        c.pointer("/ask/hotkey")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    });
    for keys in configured.iter().map(String::as_str).chain(HOTKEYS) {
        let registered = Shortcut::from_str(keys)
            .map_err(|e| e.to_string())
            .and_then(|s| app.global_shortcut().register(s).map_err(|e| e.to_string()));
        match registered {
            Ok(()) => {
                println!("[ask] hotkey: {keys}");
                break;
            }
            Err(e) => eprintln!("[ask] hotkey {keys:?} unavailable: {e}"),
        }
    }
    Ok(())
}

pub fn toggle(app: &AppHandle) {
    let open = app
        .get_webview_window("ask")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if open {
        ask_hide(app.clone());
    } else {
        let _ = app.emit_to("overlay", "ask://open", ());
    }
}

/// Shows the box with its bottom centre at a point in virtual-desktop pixels.
#[tauri::command]
pub fn ask_show(app: AppHandle, x: i32, y: i32) {
    let Some(win) = app.get_webview_window("ask") else {
        return;
    };
    let size = win.outer_size().unwrap_or_default();
    let _ = win.set_position(PhysicalPosition::new(
        x - size.width as i32 / 2,
        y - size.height as i32,
    ));
    let _ = win.show();
    let _ = win.set_focus();
    let _ = win.emit("ask://shown", ());
}

#[tauri::command]
pub fn ask_hide(app: AppHandle) {
    if let Some(win) = app.get_webview_window("ask") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            let _ = app.emit_to("overlay", "ask://closed", ());
        }
    }
}

#[tauri::command]
pub fn ask_submit(app: AppHandle, text: String) {
    let _ = app.emit_to("overlay", "ask://said", text);
    ask_hide(app);
}
