use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Tried in order after the configured one, until one is free.
const HOTKEYS: [&str; 3] = ["ctrl+alt+p", "alt+shift+p", "ctrl+alt+shift+p"];

/// The talk hotkey: what is registered right now, and the keys to go back to.
#[derive(Default)]
pub struct Hotkey {
    bound: Option<Shortcut>,
    keys: String,
}

fn bind(app: &AppHandle, keys: &str) -> Result<Shortcut, String> {
    let shortcut = Shortcut::from_str(keys).map_err(|e| e.to_string())?;
    app.global_shortcut().register(shortcut).map_err(|e| e.to_string())?;
    Ok(shortcut)
}

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
    let mut hotkey = Hotkey::default();
    for keys in configured.iter().map(String::as_str).chain(HOTKEYS) {
        match bind(app, keys) {
            Ok(shortcut) => {
                println!("[ask] hotkey: {keys}");
                hotkey = Hotkey { bound: Some(shortcut), keys: keys.to_owned() };
                break;
            }
            Err(e) => eprintln!("[ask] hotkey {keys:?} unavailable: {e}"),
        }
    }
    app.manage(Mutex::new(hotkey));
    Ok(())
}

#[tauri::command]
pub fn ask_hotkey_get(hotkey: State<'_, Mutex<Hotkey>>) -> String {
    hotkey.lock().map(|h| h.keys.clone()).unwrap_or_default()
}

/// Makes `keys` the talk hotkey and saves it. Without keys it is released, so
/// it can be pressed while a new one is being chosen; the next call binds again.
/// When `keys` cannot be had, the previous hotkey comes back.
#[tauri::command]
pub fn ask_hotkey(app: AppHandle, hotkey: State<'_, Mutex<Hotkey>>, keys: Option<String>) -> Result<(), String> {
    let mut hotkey = hotkey.lock().map_err(|e| e.to_string())?;
    if let Some(old) = hotkey.bound.take() {
        let _ = app.global_shortcut().unregister(old);
    }
    let Some(keys) = keys else { return Ok(()) };
    match bind(&app, &keys) {
        Ok(shortcut) => {
            hotkey.bound = Some(shortcut);
            if keys != hotkey.keys {
                hotkey.keys = keys.clone();
                crate::config::patch(&app, serde_json::json!({ "ask": { "hotkey": keys } }))?;
            }
            Ok(())
        }
        Err(e) => {
            hotkey.bound = bind(&app, &hotkey.keys).ok();
            Err(e)
        }
    }
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
