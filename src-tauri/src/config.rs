use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

/// Written on first run so there is something to edit. The frontend fills in
/// every key that is missing, so this only needs the ones people change.
const TEMPLATE: &str = r#"{
  "you": {
    "name": ""
  },
  "mind": {
    "baseUrl": "",
    "apiKey": "",
    "model": ""
  },
  "decider": {
    "enabled": true,
    "baseUrl": "http://triton:11434",
    "model": "d1:2b-q8_0"
  },
  "voice": {
    "provider": "none",
    "apiKey": "",
    "voiceId": "",
    "model": "eleven_v4_turbo"
  }
}
"#;

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("config.json");
    if !path.exists() {
        fs::write(&path, TEMPLATE).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

pub fn read(app: &AppHandle) -> Result<serde_json::Value, String> {
    let path = config_path(app)?;
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("{}: {e}", path.display()))
}

#[tauri::command]
pub fn config_load(app: AppHandle) -> Result<serde_json::Value, String> {
    read(&app)
}

fn merge(into: &mut serde_json::Value, patch: serde_json::Value) {
    match (into, patch) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            for (k, v) in b {
                merge(a.entry(k).or_insert(serde_json::Value::Null), v);
            }
        }
        (slot, v) => *slot = v,
    }
}

/// Merges `patch` into config.json, leaving every other key as it was, and
/// tells every window what changed.
pub fn patch(app: &AppHandle, patch: serde_json::Value) -> Result<(), String> {
    let mut config = read(app)?;
    merge(&mut config, patch.clone());
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path(app)?, text + "
").map_err(|e| e.to_string())?;
    let _ = app.emit("config://changed", patch);
    Ok(())
}

#[tauri::command]
pub fn config_patch(app: AppHandle, patch: serde_json::Value) -> Result<(), String> {
    self::patch(&app, patch)
}

#[tauri::command]
pub fn config_open(app: AppHandle) {
    open_in_editor(&app);
}

pub fn open_in_editor(app: &AppHandle) {
    match config_path(app) {
        Ok(path) => {
            if let Err(e) = std::process::Command::new("notepad.exe").arg(&path).spawn() {
                eprintln!("could not open {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("config: {e}"),
    }
}

#[tauri::command]
pub fn settings_open(app: AppHandle) {
    open_settings(&app);
}

/// Shows the settings window, or brings it forward if it is already open.
pub fn open_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("settings://shown", ());
    }
}

#[tauri::command]
pub fn settings_hide(app: AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.hide();
    }
}
