use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;

use crate::sense::media::init_winrt;

const BROKEN: &str = "I could not reach the media controls";

pub(crate) fn act(verb: &str) -> Result<(), String> {
    let _winrt = init_winrt().map_err(|_| BROKEN)?;
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .and_then(|op| op.get())
        .map_err(|_| BROKEN)?;
    let session = manager
        .GetCurrentSession()
        .map_err(|_| "nothing is playing")?;
    let op = match verb {
        "play" => session.TryPlayAsync(),
        "pause" => session.TryPauseAsync(),
        "next" => session.TrySkipNextAsync(),
        "previous" => session.TrySkipPreviousAsync(),
        _ => return Err(format!("I do not know how to {verb} music")),
    };
    match op.and_then(|op| op.get()) {
        Ok(true) => Ok(()),
        Ok(false) => Err("the player ignored it".into()),
        Err(_) => Err("the player did not answer".into()),
    }
}

#[tauri::command]
pub async fn media_act(verb: String) -> Result<(), String> {
    super::blocking(move || act(&verb)).await
}
