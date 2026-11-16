/**
 * The contract between the Rust sense layer and the overlay.
 * Every coordinate is a physical pixel in virtual-desktop space, so the
 * primary monitor's top-left is (0,0) and monitors to its left are negative.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MonitorInfo {
  id: number;
  rect: Rect;
  /** Rect minus the taskbar and other app bars. */
  work: Rect;
  /** DPI scale, 1 = 96 dpi. */
  scale: number;
  primary: boolean;
}

/** Event `sense://monitors`. Sent at boot and whenever the display layout changes. */
export interface MonitorsEvent {
  monitors: MonitorInfo[];
  /** Bounding box of all monitors; the overlay window covers exactly this. */
  virtual: Rect;
}

export type WindowState = "normal" | "maximized" | "minimized" | "fullscreen";

export interface WindowInfo {
  hwnd: number;
  title: string;
  /** Lowercase executable name without path, e.g. "chrome.exe". */
  exe: string;
  pid: number;
  /** Visible frame bounds (DWM extended frame bounds, without the invisible resize border). */
  rect: Rect;
  /** `MonitorInfo.id` of the monitor holding most of the window. */
  monitor: number;
  state: WindowState;
}

/**
 * Event `sense://windows`. Sent whenever anything in it changes, at most 60 Hz.
 * `windows` is in z-order, topmost first, and holds only real top-level app
 * windows: visible, not cloaked, not tool windows, not the overlay itself.
 */
export interface WindowsEvent {
  windows: WindowInfo[];
  foreground: number | null;
  /** Window the user is currently dragging or resizing, if any. */
  moving: number | null;
}

/** Bitmask for `CursorEvent.buttons`. */
export const enum MouseButton {
  Left = 1,
  Right = 2,
  Middle = 4,
}

/** Event `sense://cursor`. Sent when position or buttons change, at most 120 Hz. */
export interface CursorEvent {
  x: number;
  y: number;
  buttons: number;
}

export interface AudioSession {
  exe: string;
  /** 0..1 */
  peak: number;
}

/**
 * Event `sense://audio`. Sent at 20 Hz while anything is audible, and once
 * more with zeros when it goes quiet.
 */
export interface AudioEvent {
  /** Peak of the default output device, 0..1. */
  out: number;
  /** Peak of the default microphone, 0..1. Zero when nothing is capturing. */
  mic: number;
  /** Apps currently producing sound, loudest first. Refreshed at 2 Hz. */
  sessions: AudioSession[];
}

export type PlaybackStatus = "playing" | "paused" | "stopped";

export interface MediaSession {
  /** Source app id as Windows reports it, e.g. "Spotify.exe" or "Chrome". */
  app: string;
  title: string;
  artist: string;
  status: PlaybackStatus;
}

/** Event `sense://media`. Sent when the system media sessions change. */
export interface MediaEvent {
  sessions: MediaSession[];
}

/** Event `sense://system`. Sent at 1 Hz. */
export interface SystemEvent {
  /** Milliseconds since the last keyboard or mouse input. */
  idleMs: number;
  battery: { percent: number; charging: boolean } | null;
  /** Total CPU load, 0..1. */
  cpu: number;
}

/** The element holding the keyboard focus inside the foreground app, as UI Automation reports it. */
export interface FocusedElement {
  /** Control type, lowercase: "edit", "document", "button", "listitem", … "other" for the rest. */
  kind: string;
  /** Its accessible name, whitespace collapsed, at most 60 characters. Often a label, sometimes a document title. */
  name: string;
  rect: Rect;
  exe: string;
  /** The top-level window it belongs to. */
  hwnd: number;
  /** The text caret, for apps that report one. Moves as someone types. */
  caret: Rect | null;
}

/** Event `sense://focus`. Polled at about 7 Hz, sent when anything in it changes. Null while Pesto's own windows have focus. */
export interface FocusEvent {
  element: FocusedElement | null;
}

/** Result of the `sense_snapshot` command: the latest value of every event. */
export interface SenseSnapshot {
  monitors: MonitorsEvent;
  windows: WindowsEvent;
  cursor: CursorEvent;
  audio: AudioEvent;
  media: MediaEvent;
  system: SystemEvent;
  focus: FocusEvent;
}

export interface SenseEvents {
  "sense://monitors": MonitorsEvent;
  "sense://windows": WindowsEvent;
  "sense://cursor": CursorEvent;
  "sense://audio": AudioEvent;
  "sense://media": MediaEvent;
  "sense://system": SystemEvent;
  "sense://focus": FocusEvent;
}

/**
 * Tauri commands the overlay calls.
 *
 * The overlay window is click-through by default. Rust makes it interactive
 * while the cursor is inside any hit region, or while `hold` is set (used
 * during a drag so the pointer cannot escape).
 */
export interface SenseCommands {
  sense_snapshot(): SenseSnapshot;
  overlay_set_hit_regions(args: { regions: Rect[] }): void;
  overlay_hold_interactive(args: { hold: boolean }): void;
  /** The big structural parts of a window (toolbars, tab strips, panes), from a scan bounded to about 150 ms. */
  window_skeleton(args: { hwnd: number }): (Rect & { kind: string })[];
  /** The named controls and texts visible in a window, its own bars and buttons first, from a scan bounded to about 700 ms. */
  window_elements(args: { hwnd: number }): (Rect & { kind: string; name: string })[];
  app_quit(): void;
}
