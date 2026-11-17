use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use windows::core::{GUID, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOLDERID_AppsFolder, FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads,
    FOLDERID_Music, FOLDERID_Pictures, FOLDERID_Videos, IEnumShellItems, IShellItem,
    SHGetKnownFolderItem, SHGetKnownFolderPath, ShellExecuteW, KF_FLAG_DEFAULT, SIGDN,
    SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

#[derive(Serialize)]
pub struct Openable {
    pub name: String,
    pub target: String,
}

const APPS_PREFIX: &str = "shell:AppsFolder\\";
const REFUSED: &str = "that is not something I may open";

/// The app targets the last listing gave out. Only these are opened: an Apps-folder path can
/// otherwise name any program on disk.
static LISTED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn listed(target: &str) -> bool {
    let known = || {
        let all = LISTED.lock().unwrap_or_else(|e| e.into_inner());
        all.as_ref().is_some_and(|all| all.contains(target))
    };
    known() || (list().is_ok() && known())
}

/// Extensions that run code or hand off to something that does.
const RUNNABLE: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "vb",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "ws",
    "msi",
    "msp",
    "mst",
    "scr",
    "pif",
    "cpl",
    "hta",
    "lnk",
    "url",
    "reg",
    "jar",
    "inf",
    "scf",
    "sct",
    "msc",
    "appref-ms",
    "application",
    "gadget",
    "settingcontent-ms",
    "library-ms",
    "search-ms",
    "appx",
    "msix",
    "appinstaller",
    "dll",
    "sys",
];

/// Initialises COM for this call and undoes it afterwards, so pooled threads keep the apartment
/// they had. A thread that is already multithreaded stays so.
struct Com(bool);
impl Com {
    fn init() -> Self {
        Com(
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
                .is_ok(),
        )
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// Takes ownership of a shell-allocated string.
fn take(p: PWSTR) -> String {
    let s = unsafe { p.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
    s
}

fn display_name(item: &IShellItem, kind: SIGDN) -> Option<String> {
    unsafe { item.GetDisplayName(kind) }.ok().map(take)
}

fn apps() -> windows::core::Result<Vec<Openable>> {
    let folder: IShellItem =
        unsafe { SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, HANDLE::default()) }?;
    let items: IEnumShellItems = unsafe { folder.BindToHandler(None, &BHID_EnumItems) }?;
    let mut out = Vec::new();
    loop {
        let mut slot = [None];
        let mut fetched = 0u32;
        let hr = unsafe { items.Next(&mut slot, Some(&mut fetched)) };
        if hr.is_err() || fetched == 0 {
            break;
        }
        let Some(item) = slot[0].take() else { break };
        let (Some(name), Some(id)) = (
            display_name(&item, SIGDN_NORMALDISPLAY),
            display_name(&item, SIGDN_PARENTRELATIVEPARSING),
        ) else {
            continue;
        };
        if !name.is_empty() && !id.is_empty() {
            out.push(Openable {
                name,
                target: format!("{APPS_PREFIX}{id}"),
            });
        }
    }
    Ok(out)
}

fn known_path(id: &GUID) -> Option<String> {
    unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, HANDLE::default()) }
        .ok()
        .map(take)
        .filter(|p| !p.is_empty() && Path::new(p).is_dir())
}

fn folders() -> Vec<Openable> {
    [
        ("Desktop", FOLDERID_Desktop),
        ("Documents", FOLDERID_Documents),
        ("Downloads", FOLDERID_Downloads),
        ("Pictures", FOLDERID_Pictures),
        ("Music", FOLDERID_Music),
        ("Videos", FOLDERID_Videos),
    ]
    .iter()
    .filter_map(|(name, id)| {
        known_path(id).map(|target| Openable {
            name: (*name).to_string(),
            target,
        })
    })
    .collect()
}

pub(crate) fn list() -> Result<Vec<Openable>, String> {
    let _com = Com::init();
    let mut out = apps().map_err(|_| "I could not read the list of apps")?;
    *LISTED.lock().unwrap_or_else(|e| e.into_inner()) = Some(out.iter().map(|o| o.target.clone()).collect());
    out.extend(folders());
    Ok(out)
}

fn starts_with_ignore_case(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len()
        && s.is_char_boundary(prefix.len())
        && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// Decides whether `target` may be opened, and checks that a file target exists.
fn check(target: &str) -> Result<(), &'static str> {
    if target.is_empty() || target.chars().any(|c| c.is_control() || c == '"') {
        return Err(REFUSED);
    }
    if starts_with_ignore_case(target, "http://") || starts_with_ignore_case(target, "https://") {
        return Ok(());
    }
    if target.starts_with(APPS_PREFIX) {
        return if listed(target) { Ok(()) } else { Err(REFUSED) };
    }

    let path = Path::new(target);
    // Windows drops trailing dots and spaces and reads `name:stream` as a stream, either of
    // which would hide the real extension.
    let colon_after_drive = target.char_indices().any(|(i, c)| c == ':' && i != 1);
    if !path.is_absolute() || colon_after_drive || target.ends_with(['.', ' ']) {
        return Err(REFUSED);
    }
    if !path.exists() {
        return Err("there is no such file");
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| "there is no such file")?;
    for p in [path, canonical.as_path()] {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if RUNNABLE.iter().any(|r| r.eq_ignore_ascii_case(ext)) {
            return Err(REFUSED);
        }
    }
    Ok(())
}

pub(crate) fn open(target: &str) -> Result<(), String> {
    check(target)?;
    let _com = Com::init();
    let file = HSTRING::from(target);
    let result = unsafe {
        ShellExecuteW(
            HWND::default(),
            &HSTRING::from("open"),
            &file,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err("Windows would not open it".into())
    }
}

#[tauri::command]
pub async fn launch_list() -> Result<Vec<Openable>, String> {
    super::blocking(list).await
}

#[tauri::command]
pub async fn launch_open(target: String) -> Result<(), String> {
    super::blocking(move || open(&target)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn lists_apps_and_folders() {
        let all = list().unwrap();
        println!("{} openables", all.len());
        for o in all.iter().take(10) {
            println!("  {} -> {}", o.name, o.target);
        }
        let app = all.iter().find(|o| o.target.starts_with(APPS_PREFIX)).unwrap();
        assert_eq!(check(&app.target), Ok(()));
        let folders: Vec<_> = all
            .iter()
            .filter(|o| !o.target.starts_with(APPS_PREFIX))
            .collect();
        for f in &folders {
            println!("  folder {} -> {}", f.name, f.target);
        }
        assert!(folders.iter().any(|o| o.name == "Documents"));
    }

    #[test]
    fn refuses_what_it_should() {
        assert_eq!(check("https://example.com"), Ok(()));
        assert_eq!(check("HTTP://example.com"), Ok(()));
        assert_eq!(check(r"shell:AppsFolder\..\x"), Err(REFUSED));
        assert_eq!(check(r"shell:AppsFolder\C:\Windows\System32\cmd.exe"), Err(REFUSED));
        assert_eq!(check("ftp://example.com"), Err(REFUSED));
        assert_eq!(check(r"C:\Windows\System32\notepad.exe"), Err(REFUSED));
        assert_eq!(check(r"C:\Windows\System32\NOTEPAD.EXE"), Err(REFUSED));
        assert_eq!(check(r"C:\Windows\System32\notepad.exe."), Err(REFUSED));
        assert_eq!(check(r"C:\Windows\win.ini:x"), Err(REFUSED));
        assert_eq!(check(r"relative\file.txt"), Err(REFUSED));
        assert_eq!(
            check(r"C:\definitely\not\here.txt"),
            Err("there is no such file")
        );
        assert_eq!(check(r"C:\Windows\win.ini"), Ok(()));
        assert_eq!(check(r"C:\Windows"), Ok(()));
    }
}
