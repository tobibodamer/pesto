use std::mem::size_of;

use windows::Win32::Foundation::{BOOL, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::MONITORINFOF_PRIMARY;

use super::types::{MonitorInfo, MonitorsEvent, Rect};

fn rect_from_win32(r: RECT) -> Rect {
    Rect {
        x: r.left,
        y: r.top,
        w: r.right - r.left,
        h: r.bottom - r.top,
    }
}

unsafe extern "system" fn enum_monitor_proc(
    hmon: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<MonitorInfo>);
    let mut mi = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };

    if GetMonitorInfoW(hmon, &mut mi).as_bool() {
        let mut dpi_x: u32 = 96;
        let mut dpi_y: u32 = 96;
        let scale = if GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y).is_ok()
            && dpi_x > 0
        {
            dpi_x as f64 / 96.0
        } else {
            1.0
        };

        list.push(MonitorInfo {
            id: 0,
            rect: rect_from_win32(mi.rcMonitor),
            work: rect_from_win32(mi.rcWork),
            scale,
            primary: (mi.dwFlags & MONITORINFOF_PRIMARY) != 0,
        });
    }

    TRUE
}

pub fn query_monitors() -> MonitorsEvent {
    let mut monitors: Vec<MonitorInfo> = Vec::new();
    let ok = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(enum_monitor_proc),
            LPARAM(&mut monitors as *mut Vec<MonitorInfo> as isize),
        )
        .as_bool()
    };

    if !ok || monitors.is_empty() {
        eprintln!("[sense/monitors] EnumDisplayMonitors returned no monitors");
        let fallback = Rect {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
        };
        return MonitorsEvent {
            monitors: vec![MonitorInfo {
                id: 0,
                rect: fallback,
                work: fallback,
                scale: 1.0,
                primary: true,
            }],
            virtual_rect: fallback,
        };
    }

    monitors.sort_by_key(|m| (m.rect.x, m.rect.y));
    for (idx, m) in monitors.iter_mut().enumerate() {
        m.id = idx;
    }

    let min_x = monitors.iter().map(|m| m.rect.x).min().unwrap_or(0);
    let min_y = monitors.iter().map(|m| m.rect.y).min().unwrap_or(0);
    let max_x = monitors
        .iter()
        .map(|m| m.rect.x + m.rect.w)
        .max()
        .unwrap_or(1920);
    let max_y = monitors
        .iter()
        .map(|m| m.rect.y + m.rect.h)
        .max()
        .unwrap_or(1080);

    MonitorsEvent {
        monitors,
        virtual_rect: Rect {
            x: min_x,
            y: min_y,
            w: max_x - min_x,
            h: max_y - min_y,
        },
    }
}
