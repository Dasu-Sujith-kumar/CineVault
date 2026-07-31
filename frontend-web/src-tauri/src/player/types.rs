use super::ipc::MpvIpc;
use std::process::Child;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use std::sync::atomic::AtomicBool;

#[cfg(windows)]
pub struct OverlayInsets {
    pub top: AtomicI32,
    pub bottom: AtomicI32,
}

pub struct PlayerProc {
    pub child: Mutex<Option<Child>>,
    pub now_playing: Mutex<Option<String>>,
    // Persists even if the mpv process exits; used for safe restarts (Case B).
    pub last_media_key: Mutex<Option<String>>,
    // External subtitles loaded for the last played media; used to restore on restart.
    pub last_extra_subs: Mutex<Vec<String>>,
    pub ipc: Mutex<Option<MpvIpc>>,
    pub ipc_path: Mutex<Option<String>>,
    #[cfg(windows)]
    pub mpv_hwnd: Mutex<Option<isize>>,
    #[cfg(windows)]
    pub overlay_hwnd: Mutex<Option<isize>>,
    #[cfg(windows)]
    pub activity_watcher_stop: Mutex<Option<Arc<AtomicBool>>>,
    #[cfg(windows)]
    pub overlay_insets: Arc<OverlayInsets>,
}

impl PlayerProc {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            now_playing: Mutex::new(None),
            last_media_key: Mutex::new(None),
            last_extra_subs: Mutex::new(Vec::new()),
            ipc: Mutex::new(None),
            ipc_path: Mutex::new(None),
            #[cfg(windows)]
            mpv_hwnd: Mutex::new(None),
            #[cfg(windows)]
            overlay_hwnd: Mutex::new(None),
            #[cfg(windows)]
            activity_watcher_stop: Mutex::new(None),
            #[cfg(windows)]
            overlay_insets: Arc::new(OverlayInsets {
                top: AtomicI32::new(0),
                bottom: AtomicI32::new(0),
            }),
        }
    }

    #[cfg(windows)]
    pub fn clear_overlay_insets(&self) {
        self.overlay_insets.top.store(0, Ordering::SeqCst);
        self.overlay_insets.bottom.store(0, Ordering::SeqCst);
    }
}

#[derive(serde::Serialize)]
pub struct PlayerState {
    pub connected: bool,
    pub status: String,
    pub now_playing: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub struct PlayerTrack {
    pub id: i64,
    pub label: String,
    pub lang: Option<String>,
    pub selected: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct PlayerTracks {
    pub audio: Vec<PlayerTrack>,
    pub subtitles: Vec<PlayerTrack>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackInfo {
    pub time_pos_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
    pub paused: Option<bool>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayerPlaybackEventPayload {
    pub media_key: String,
    pub seq: u64,
    pub at_ms: u64,
    pub connected: bool,
    pub time_pos_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
    pub paused: Option<bool>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRenderSettings {
    pub volume: Option<f64>,
    pub brightness: Option<f64>,
    pub subtitle_font_size: Option<f64>,
    pub subtitle_border_size: Option<f64>,
    pub subtitle_shadow_offset: Option<f64>,
    pub subtitle_position: Option<f64>,
}
