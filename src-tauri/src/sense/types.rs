use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn contains(self, px: i32, py: i32) -> bool {
        self.w > 0
            && self.h > 0
            && px >= self.x
            && px < self.x.saturating_add(self.w)
            && py >= self.y
            && py < self.y.saturating_add(self.h)
    }

    pub fn intersection_area(self, other: Rect) -> i64 {
        let x1 = self.x.max(other.x);
        let y1 = self.y.max(other.y);
        let x2 = self.x.saturating_add(self.w).min(other.x.saturating_add(other.w));
        let y2 = self.y.saturating_add(self.h).min(other.y.saturating_add(other.h));
        let w = (x2 - x1).max(0) as i64;
        let h = (y2 - y1).max(0) as i64;
        w * h
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MonitorInfo {
    pub id: usize,
    pub rect: Rect,
    pub work: Rect,
    pub scale: f64,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MonitorsEvent {
    pub monitors: Vec<MonitorInfo>,
    #[serde(rename = "virtual")]
    pub virtual_rect: Rect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowState {
    Normal,
    Maximized,
    Minimized,
    Fullscreen,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WindowInfo {
    pub hwnd: i64,
    pub title: String,
    pub exe: String,
    pub pid: u32,
    pub rect: Rect,
    pub monitor: usize,
    pub state: WindowState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WindowsEvent {
    pub windows: Vec<WindowInfo>,
    pub foreground: Option<i64>,
    pub moving: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CursorEvent {
    pub x: i32,
    pub y: i32,
    pub buttons: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AudioSession {
    pub exe: String,
    pub peak: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AudioEvent {
    pub out: f32,
    pub mic: f32,
    pub sessions: Vec<AudioSession>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackStatus {
    Playing,
    Paused,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MediaSession {
    pub app: String,
    pub title: String,
    pub artist: String,
    pub status: PlaybackStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MediaEvent {
    pub sessions: Vec<MediaSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BatteryStatus {
    pub percent: u8,
    pub charging: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SystemEvent {
    #[serde(rename = "idleMs")]
    pub idle_ms: u32,
    pub battery: Option<BatteryStatus>,
    pub cpu: f32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FocusedElement {
    pub kind: String,
    pub name: String,
    pub rect: Rect,
    pub exe: String,
    pub hwnd: i64,
    pub caret: Option<Rect>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FocusEvent {
    pub element: Option<FocusedElement>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SenseSnapshot {
    pub monitors: MonitorsEvent,
    pub windows: WindowsEvent,
    pub cursor: CursorEvent,
    pub audio: AudioEvent,
    pub media: MediaEvent,
    pub system: SystemEvent,
    pub focus: FocusEvent,
}
