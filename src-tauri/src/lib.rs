mod ask;
mod config;
mod hear;
mod overlay;
mod sense;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, State};

use crate::sense::types::{Rect, SenseSnapshot};
use crate::sense::{start_sense, SenseHandles, SenseState};

struct RuntimeHandles(Mutex<Option<SenseHandles>>);

#[tauri::command]
fn sense_snapshot(state: State<'_, Arc<SenseState>>) -> SenseSnapshot {
    state
        .snapshot
        .read()
        .map(|s| s.clone())
        .unwrap_or_else(|e| e.into_inner().clone())
}

#[tauri::command]
fn overlay_set_hit_regions(state: State<'_, Arc<SenseState>>, regions: Vec<Rect>) {
    if let Ok(mut guard) = state.hit_regions.write() {
        *guard = regions;
    }
}

#[tauri::command]
fn overlay_hold_interactive(state: State<'_, Arc<SenseState>>, hold: bool) {
    state.hold_interactive.store(hold, Ordering::Relaxed);
}

#[tauri::command]
fn app_quit(app: AppHandle) {
    shutdown_and_exit(&app);
}

fn shutdown_sense(app: &AppHandle) {
    let state = app.state::<Arc<SenseState>>();
    state.signal_shutdown();
    if let Some(handles_state) = app.try_state::<RuntimeHandles>() {
        if let Ok(mut guard) = handles_state.0.lock() {
            if let Some(handles) = guard.take() {
                handles.shutdown(&state);
            }
        }
    }
}

fn shutdown_and_exit(app: &AppHandle) {
    shutdown_sense(app);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sense_state = SenseState::new_initial();

    let app = tauri::Builder::default()
        .manage(Arc::clone(&sense_state))
        .manage(RuntimeHandles(Mutex::new(None)))
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            ask::ask_show,
            ask::ask_hide,
            ask::ask_submit,
            config::config_load,
            config::config_patch,
            config::config_open,
            hear::hear_enable,
            hear::hear_listen,
            hear::hear_stop,
            hear::hear_feed,
            sense_snapshot,
            sense::skeleton::window_skeleton,
            overlay_set_hit_regions,
            overlay_hold_interactive,
            app_quit,
        ])
        .setup(move |app| {
            ask::setup(app.handle())?;

            let talk_item = MenuItem::with_id(app, "talk", "Talk…", true, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&talk_item, &settings_item, &quit_item])?;
            let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Pesto")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id() == "quit" {
                        shutdown_and_exit(app);
                    } else if event.id() == "talk" {
                        ask::toggle(app);
                    } else if event.id() == "settings" {
                        config::open_in_editor(app);
                    }
                })
                .build(app)?;

            let overlay_win = app
                .get_webview_window("overlay")
                .ok_or("missing overlay window")?;
            let virtual_rect = sense_state
                .snapshot
                .read()
                .map(|s| s.monitors.virtual_rect)
                .unwrap_or(Rect {
                    x: 0,
                    y: 0,
                    w: 1920,
                    h: 1080,
                });

            let hwnd = overlay::configure_overlay(
                &overlay_win,
                app.handle().clone(),
                Arc::clone(&sense_state),
                virtual_rect,
            )?;

            app.manage(hear::start(app.handle(), Arc::clone(&sense_state)));

            let handles = start_sense(app.handle().clone(), Arc::clone(&sense_state), hwnd);
            if let Ok(mut guard) = app.state::<RuntimeHandles>().0.lock() {
                *guard = Some(handles);
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pesto");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            shutdown_sense(app_handle);
        }
    });
}
