use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// Written on first run so there is something to edit. The frontend fills in
/// every key that is missing, so this only needs the ones people change.
const TEMPLATE: &str = r#"{
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
