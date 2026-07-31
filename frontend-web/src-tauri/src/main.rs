#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod player;
use player::commands as player_commands;
use player::PlayerProc;
use player_commands::*;

use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use chrono;
use directories::ProjectDirs;
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use tauri::{Emitter, Manager};
use uuid;
#[cfg(windows)]
use windows::Win32::{
    Foundation::{HWND, LPARAM, POINT, RECT},
    Graphics::Gdi::{
        ClientToScreen, CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, HRGN, RGN_OR,
    },
    UI::Input::KeyboardAndMouse::GetAsyncKeyState,
    UI::WindowsAndMessaging::{
        EnumWindows, GetAncestor, GetClientRect, GetCursorPos, GetForegroundWindow,
        GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsWindow, IsWindowVisible,
        SetWindowLongPtrW, SetWindowPos, WindowFromPoint, GA_ROOT, GWL_EXSTYLE, GWL_STYLE,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WS_CAPTION,
        WS_CHILD, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_MAXIMIZEBOX,
        WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
    },
};

const APP_STATE_KEY: &str = "app_state_v1";
const METADATA_IMAGE_CACHE_DIR_KEY: &str = "metadata_image_cache_dir";
const PLAYER_ACTIVITY_EVENT: &str = "cinevault:player-activity";
const PLAYER_KEY_EVENT: &str = "cinevault:player-key";
const PLAYER_VIDEO_CLICK_EVENT: &str = "cinevault:player-video-click";
static OVERLAY_REGION_LAST_LOG_AT_MS: AtomicU64 = AtomicU64::new(0);
static OVERLAY_REGION_LAST_TOP: AtomicI32 = AtomicI32::new(i32::MIN);
static OVERLAY_REGION_LAST_BOTTOM: AtomicI32 = AtomicI32::new(i32::MIN);

#[derive(Clone)]
struct AppDb {
    conn: Arc<Mutex<Connection>>,
}

// Player process + IPC types live in `src/player/`.

impl AppDb {
    fn open() -> Result<Self, String> {
        let project_dirs = ProjectDirs::from("com", "movieplayer", "cinevault")
            .ok_or("failed to resolve app data dir")?;
        let data_dir = project_dirs.data_dir();
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let db_path = data_dir.join("cinevault.sqlite3");

        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            r#"
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS library_root (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    library_kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_items (
    id TEXT PRIMARY KEY,
    stable_id TEXT UNIQUE NOT NULL,
    root_id TEXT NOT NULL,
    type TEXT NOT NULL,
    library_kind TEXT NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    plot TEXT,
    tmdb_id INTEGER,
    imdb_id TEXT,
    file_path TEXT UNIQUE NOT NULL,
    file_hash TEXT,
    metadata_json TEXT NOT NULL,
    is_adult_override BOOLEAN DEFAULT 0,
    scanned_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (root_id) REFERENCES library_root(id)
);

CREATE INDEX IF NOT EXISTS idx_library_items_title ON library_items(title);
CREATE INDEX IF NOT EXISTS idx_library_items_type ON library_items(type);
CREATE INDEX IF NOT EXISTS idx_library_items_kind ON library_items(library_kind);
CREATE INDEX IF NOT EXISTS idx_library_items_tmdb ON library_items(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_library_items_file_hash ON library_items(file_hash);

CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    show_id TEXT NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    title TEXT,
    file_path TEXT NOT NULL,
    file_hash TEXT,
    duration_seconds INTEGER,
    tmdb_id INTEGER,
    metadata_json TEXT,
    scanned_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (show_id) REFERENCES library_items(id),
    UNIQUE(show_id, season, episode)
);

CREATE INDEX IF NOT EXISTS idx_episodes_show_id ON episodes(show_id);
CREATE INDEX IF NOT EXISTS idx_episodes_season ON episodes(season);

CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    tmdb_collection_id INTEGER,
    is_auto_generated BOOLEAN DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_items (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    position INTEGER,
    FOREIGN KEY (collection_id) REFERENCES collections(id),
    FOREIGN KEY (item_id) REFERENCES library_items(id),
    UNIQUE(collection_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_items_collection_id ON collection_items(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_items_item_id ON collection_items(item_id);

CREATE TABLE IF NOT EXISTS playback_progress (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    episode_id TEXT,
    progress_ms INTEGER DEFAULT 0,
    watched BOOLEAN DEFAULT 0,
    last_watched TEXT,
    FOREIGN KEY (item_id) REFERENCES library_items(id),
    FOREIGN KEY (episode_id) REFERENCES episodes(id)
);

CREATE INDEX IF NOT EXISTS idx_playback_item_id ON playback_progress(item_id);

CREATE TABLE IF NOT EXISTS watch_history (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    episode_id TEXT,
    watched_at TEXT NOT NULL,
    duration_watched_ms INTEGER,
    completed BOOLEAN DEFAULT 0,
    FOREIGN KEY (item_id) REFERENCES library_items(id),
    FOREIGN KEY (episode_id) REFERENCES episodes(id)
);

CREATE INDEX IF NOT EXISTS idx_watch_history_item_id ON watch_history(item_id);
CREATE INDEX IF NOT EXISTS idx_watch_history_watched_at ON watch_history(watched_at);

CREATE TABLE IF NOT EXISTS external_subtitles (
    id TEXT PRIMARY KEY,
    item_id TEXT,
    episode_id TEXT,
    language TEXT NOT NULL,
    format TEXT NOT NULL,
    file_path TEXT NOT NULL,
    is_forced BOOLEAN DEFAULT 0,
    added_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES library_items(id),
    FOREIGN KEY (episode_id) REFERENCES episodes(id)
);

CREATE INDEX IF NOT EXISTS idx_subtitles_item_id ON external_subtitles(item_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playback (
  item_id TEXT PRIMARY KEY,
  position_seconds REAL NOT NULL,
  duration_seconds REAL,
  updated_at_ms INTEGER NOT NULL
);
"#,
        )
        .map_err(|e| e.to_string())?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}

fn now_epoch_ms_u64() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn truncate_for_log(input: &str, max_chars: usize) -> String {
    let mut out: String = input.chars().take(max_chars).collect();
    if input.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TvEpisode {
    season: u32,
    episode: u32,
    title: String,
    path: Option<String>,
    overview: Option<String>,
    runtime_minutes: Option<u32>,
    air_date: Option<String>,
    still_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TvShowScanResult {
    root_path: String,
    seasons: u32,
    episodes: u32,
    episode_list: Vec<TvEpisode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataCastMember {
    id: String,
    name: String,
    character: Option<String>,
    profile_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataSearchResult {
    provider: String,
    source: String,
    source_id: String,
    tmdb_id: Option<u64>,
    title: String,
    overview: String,
    poster_url: String,
    backdrop_url: String,
    duration_minutes: Option<u32>,
    rating: f64,
    year: String,
    genre: Vec<String>,
    media_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataTvInfo {
    seasons: u32,
    episodes: u32,
    episode_list: Vec<TvEpisode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataDetails {
    source: String,
    source_id: String,
    tmdb_id: Option<u64>,
    imdb_id: Option<String>,
    tvdb_id: Option<u64>,
    trakt_id: Option<u64>,
    mal_id: Option<u64>,
    title: String,
    original_title: Option<String>,
    overview: String,
    tagline: Option<String>,
    poster_url: String,
    backdrop_url: String,
    duration_minutes: Option<u32>,
    rating: f64,
    year: String,
    genre: Vec<String>,
    media_type: String,
    cast: Vec<MetadataCastMember>,
    status: Option<String>,
    tv: Option<MetadataTvInfo>,
}

#[derive(Default, Clone)]
struct ApiKeys {
    tmdb_api_key: Option<String>,
    omdb_api_key: Option<String>,
    tvdb_api_key: Option<String>,
    trakt_client_id: Option<String>,
}

const METADATA_SOURCE_TMDB: &str = "tmdb";
const METADATA_SOURCE_OMDB: &str = "omdb";
const METADATA_SOURCE_TVDB: &str = "tvdb";
const METADATA_SOURCE_TRAKT: &str = "trakt";
const METADATA_SOURCE_JIKAN: &str = "jikan";
const METADATA_SOURCE_HHAVEN: &str = "hhaven";

#[tauri::command]
fn debug_log(message: String) -> Result<(), String> {
    eprintln!("ui: {}", message);
    Ok(())
}

#[tauri::command]
fn app_state_load(db: tauri::State<AppDb>) -> Result<Option<String>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    conn.query_row(
        "SELECT value FROM kv WHERE key = ?1",
        params![APP_STATE_KEY],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn app_state_save(db: tauri::State<AppDb>, state_json: String) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    conn.execute(
        r#"
INSERT INTO kv (key, value) VALUES (?1, ?2)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
"#,
        params![APP_STATE_KEY, state_json],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn kv_get(db: &AppDb, key: &str) -> Result<Option<String>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

fn kv_set(db: &AppDb, key: &str, value: Option<&str>) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    if let Some(value) = value {
        conn.execute(
            r#"
INSERT INTO kv (key, value) VALUES (?1, ?2)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
"#,
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute("DELETE FROM kv WHERE key = ?1", params![key])
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn metadata_get_cache_directory(db: tauri::State<AppDb>) -> Result<Option<String>, String> {
    kv_get(db.inner(), METADATA_IMAGE_CACHE_DIR_KEY)
}

#[tauri::command]
fn metadata_set_cache_directory(
    db: tauri::State<AppDb>,
    path: Option<String>,
) -> Result<Option<String>, String> {
    let normalized = path.and_then(|value| optional_non_empty(&value));

    if let Some(path) = normalized.as_deref() {
        let path_buf = PathBuf::from(path);
        std::fs::create_dir_all(&path_buf)
            .map_err(|e| format!("failed to create {}: {}", path_buf.display(), e))?;
    }

    kv_set(
        db.inner(),
        METADATA_IMAGE_CACHE_DIR_KEY,
        normalized.as_deref(),
    )?;
    Ok(normalized)
}

// Legacy mpv spawn helpers (superseded by `src/player/mpv.rs`).
#[cfg(any())]
fn resolve_mpv_command() -> PathBuf {
    if let Ok(p) = std::env::var("MPV_PATH") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return pb;
        }
    }

    if cfg!(target_os = "windows") {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        if let Some(repo_root) = manifest_dir.parent().and_then(|p| p.parent()) {
            let bundled = repo_root.join("mpv").join("mpv.exe");
            if bundled.exists() {
                return bundled;
            }
        }
    }

    PathBuf::from("mpv")
}

#[cfg(any())]
fn mpv_log_file_path() -> Option<PathBuf> {
    let want_log = cfg!(debug_assertions) || std::env::var("CINEVAULT_MPV_LOG").is_ok();
    if !want_log {
        return None;
    }

    let project_dirs = ProjectDirs::from("com", "movieplayer", "cinevault")?;
    let data_dir = project_dirs.data_dir();
    std::fs::create_dir_all(data_dir).ok()?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis())?;
    let pid = std::process::id();
    Some(data_dir.join(format!("mpv-{pid}-{ts}.log")))
}

fn kill_child_quick(mut child: Child) {
    // Make sure we never block the UI on process shutdown (close button should feel instant).
    #[cfg(windows)]
    {
        let pid = child.id();
        eprintln!("killing mpv pid={pid}");
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > Duration::from_millis(500) {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break,
        }
    }
}

fn start_process_log_thread<R: Read + Send + 'static>(
    reader: R,
    stream_name: &'static str,
    pid: u32,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let text = line.trim_end_matches(['\r', '\n']);
                    if text.starts_with("AV: ")
                        || text.starts_with("(Paused) AV:")
                        || text.contains("No key binding found for key")
                    {
                        continue;
                    }
                    if !text.is_empty() {
                        println!("mpv[{pid}] {stream_name}: {text}");
                    }
                }
                Err(e) => {
                    eprintln!("mpv[{pid}] {stream_name} read failed: {e}");
                    break;
                }
            }
        }
        eprintln!("mpv[{pid}] {stream_name} closed");
    });
}

// Legacy helper (superseded by `src/player/ipc.rs`).
#[cfg(any())]
fn fail_pending_requests(
    pending: &Arc<Mutex<HashMap<u64, mpsc::Sender<Result<JsonValue, String>>>>>,
    message: String,
) {
    if let Ok(mut map) = pending.lock() {
        for (_, tx) in map.drain() {
            let _ = tx.send(Err(message.clone()));
        }
    }
}

fn sync_player_process_state(player: &tauri::State<PlayerProc>) -> Result<bool, String> {
    let mut running = false;
    let mut exited = false;

    {
        let mut child_guard = player
            .child
            .lock()
            .map_err(|_| "player mutex poisoned".to_string())?;

        if let Some(child) = child_guard.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    eprintln!("mpv process exited pid={}: {status}", child.id());
                    *child_guard = None;
                    exited = true;
                }
                Ok(None) => {
                    running = true;
                }
                Err(e) => {
                    eprintln!("mpv process state check failed: {e}");
                    running = true;
                }
            }
        }
    }

    if exited {
        if let Ok(mut guard) = player.ipc.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = player.ipc_path.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = player.now_playing.lock() {
            *guard = None;
        }
        #[cfg(windows)]
        if let Ok(mut guard) = player.mpv_hwnd.lock() {
            *guard = None;
        }
        #[cfg(windows)]
        if let Ok(mut guard) = player.overlay_hwnd.lock() {
            *guard = None;
        }
        #[cfg(windows)]
        stop_player_activity_watcher(player);
        #[cfg(windows)]
        player.clear_overlay_insets();
    }

    Ok(running)
}

#[cfg(windows)]
fn hwnd_from_isize(h: isize) -> HWND {
    HWND(h as *mut std::ffi::c_void)
}

#[cfg(windows)]
struct EnumFindWindowData {
    pid: u32,
    found_hwnd: isize,
}

#[cfg(windows)]
unsafe extern "system" fn enum_windows_find_first_for_pid(
    hwnd: HWND,
    lparam: LPARAM,
) -> windows::core::BOOL {
    let data = &mut *(lparam.0 as *mut EnumFindWindowData);

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
    if pid != data.pid {
        return windows::core::BOOL(1);
    }

    if !IsWindowVisible(hwnd).as_bool() {
        return windows::core::BOOL(1);
    }

    // Ignore child windows; we want the top-level mpv window.
    let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
    if (style & WS_CHILD.0) != 0 {
        return windows::core::BOOL(1);
    }

    data.found_hwnd = hwnd.0 as isize;
    windows::core::BOOL(0)
}

#[cfg(windows)]
fn find_top_level_window_for_pid(pid: u32) -> Option<isize> {
    let mut data = EnumFindWindowData { pid, found_hwnd: 0 };

    unsafe {
        let _ = EnumWindows(
            Some(enum_windows_find_first_for_pid),
            LPARAM((&mut data as *mut EnumFindWindowData) as isize),
        );
    }

    (data.found_hwnd != 0).then_some(data.found_hwnd)
}

#[cfg(windows)]
fn make_borderless_toolwindow(hwnd_isize: isize) {
    let hwnd = hwnd_from_isize(hwnd_isize);
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let mut new_style = style;
        new_style &=
            !(WS_CAPTION.0 | WS_THICKFRAME.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0);
        new_style |= WS_POPUP.0 | WS_VISIBLE.0;
        let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, new_style as isize);

        let exstyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let mut new_exstyle = exstyle;
        new_exstyle &= !WS_EX_APPWINDOW.0;
        // Avoid mpv stealing focus on click; keep keyboard shortcuts in the app window.
        new_exstyle |= WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0;
        let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_exstyle as isize);

        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

#[cfg(windows)]
fn get_client_screen_rect(hwnd: HWND) -> Result<RECT, String> {
    unsafe {
        let mut client = RECT::default();
        GetClientRect(hwnd, &mut client).map_err(|e| format!("GetClientRect failed: {e:?}"))?;

        let mut origin = POINT {
            x: client.left,
            y: client.top,
        };
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return Err("ClientToScreen failed".to_string());
        }

        Ok(RECT {
            left: origin.x,
            top: origin.y,
            right: origin.x + (client.right - client.left),
            bottom: origin.y + (client.bottom - client.top),
        })
    }
}

#[cfg(windows)]
fn start_sync_mpv_to_overlay_thread(
    overlay_hwnd: isize,
    mpv_hwnd: isize,
    overlay_insets: Arc<player::types::OverlayInsets>,
) {
    thread::spawn(move || {
        let overlay = hwnd_from_isize(overlay_hwnd);
        let mpv = hwnd_from_isize(mpv_hwnd);
        let bleed_px: i32 = 3;

        let mut last_left: i32 = i32::MIN;
        let mut last_top: i32 = i32::MIN;
        let mut last_w: i32 = 0;
        let mut last_h: i32 = 0;
        let mut last_restack = Instant::now() - Duration::from_secs(1);

        loop {
            if unsafe { !IsWindow(Some(overlay)).as_bool() } {
                break;
            }
            if unsafe { !IsWindow(Some(mpv)).as_bool() } {
                break;
            }

            if let Ok(r) = get_client_screen_rect(overlay) {
                let w = (r.right - r.left).max(1);
                let h = (r.bottom - r.top).max(1);
                let top_inset = overlay_insets
                    .top
                    .load(Ordering::SeqCst)
                    .clamp(0, h.saturating_sub(1));
                let bottom_inset = overlay_insets
                    .bottom
                    .load(Ordering::SeqCst)
                    .clamp(0, h.saturating_sub(top_inset + 1));
                let visible_h = (h - top_inset - bottom_inset).max(1);

                let mpv_left = r.left - bleed_px;
                let mpv_top = r.top + top_inset - bleed_px;
                let mpv_w = (w + bleed_px * 2).max(1);
                let mpv_h = (visible_h + bleed_px * 2).max(1);
                let geometry_changed = mpv_left != last_left
                    || mpv_top != last_top
                    || mpv_w != last_w
                    || mpv_h != last_h;
                let needs_restack = last_restack.elapsed() >= Duration::from_millis(250);
                if geometry_changed || needs_restack {
                    // Keep mpv aligned to the actual client area.
                    // Overdraw slightly to cover compositor/DPI seams around the transparent window cutout.
                    let _ = unsafe {
                        SetWindowPos(
                            mpv,
                            Some(overlay),
                            mpv_left,
                            mpv_top,
                            mpv_w,
                            mpv_h,
                            SWP_NOACTIVATE | SWP_SHOWWINDOW,
                        )
                    };
                    last_left = mpv_left;
                    last_top = mpv_top;
                    last_w = mpv_w;
                    last_h = mpv_h;
                    last_restack = Instant::now();
                }
            }

            thread::sleep(Duration::from_millis(66));
        }
    });
}

#[cfg(windows)]
fn stop_player_activity_watcher(player: &tauri::State<PlayerProc>) {
    let old = {
        let mut guard = match player.activity_watcher_stop.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard.take()
    };

    if let Some(flag) = old {
        flag.store(true, Ordering::SeqCst);
    }
}

#[cfg(windows)]
fn start_player_activity_watcher(
    player: &tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    overlay_hwnd: isize,
    mpv_hwnd: isize,
) {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let old = {
        let mut guard = match player.activity_watcher_stop.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard.replace(stop_flag.clone())
    };
    if let Some(flag) = old {
        flag.store(true, Ordering::SeqCst);
    }

    thread::spawn(move || {
        let overlay = hwnd_from_isize(overlay_hwnd);
        let mpv = hwnd_from_isize(mpv_hwnd);
        let mut last_x = i32::MIN;
        let mut last_y = i32::MIN;
        let mut last_left_down = false;
        let mut last_right_down = false;
        let mut last_space_down = false;
        let mut last_left_key_down = false;
        let mut last_right_key_down = false;
        let mut last_up_key_down = false;
        let mut last_down_key_down = false;
        let mut last_escape_down = false;
        let mut last_enter_down = false;
        let mut last_f_down = false;
        let mut last_b_down = false;
        let mut last_n_down = false;
        let mut last_emit = Instant::now() - Duration::from_secs(10);

        loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            if unsafe { !IsWindow(Some(overlay)).as_bool() } {
                break;
            }
            if unsafe { !IsWindow(Some(mpv)).as_bool() } {
                break;
            }

            let bounds = match get_client_screen_rect(overlay) {
                Ok(rect) => rect,
                Err(_) => {
                    thread::sleep(Duration::from_millis(60));
                    continue;
                }
            };

            let mut pt = POINT::default();
            if unsafe { GetCursorPos(&mut pt) }.is_err() {
                thread::sleep(Duration::from_millis(60));
                continue;
            }

            let inside = pt.x >= bounds.left
                && pt.x <= bounds.right
                && pt.y >= bounds.top
                && pt.y <= bounds.bottom;
            let moved = pt.x != last_x || pt.y != last_y;
            let under = unsafe { WindowFromPoint(pt) };
            let under_root = if under.0.is_null() {
                under
            } else {
                let root = unsafe { GetAncestor(under, GA_ROOT) };
                if root.0.is_null() {
                    under
                } else {
                    root
                }
            };
            let on_overlay = under_root == overlay;
            let on_mpv = under_root == mpv;

            let left_down = (unsafe { GetAsyncKeyState(0x01) } as i32 & 0x8000) != 0;
            let right_down = (unsafe { GetAsyncKeyState(0x02) } as i32 & 0x8000) != 0;
            let left_click = left_down && !last_left_down;
            let right_click = right_down && !last_right_down;
            let foreground = unsafe { GetForegroundWindow() };
            let foreground_root = if foreground.0.is_null() {
                foreground
            } else {
                let root = unsafe { GetAncestor(foreground, GA_ROOT) };
                if root.0.is_null() {
                    foreground
                } else {
                    root
                }
            };
            let player_active = foreground_root == overlay || foreground_root == mpv;

            let space_down = (unsafe { GetAsyncKeyState(0x20) } as i32 & 0x8000) != 0;
            let left_key_down = (unsafe { GetAsyncKeyState(0x25) } as i32 & 0x8000) != 0;
            let right_key_down = (unsafe { GetAsyncKeyState(0x27) } as i32 & 0x8000) != 0;
            let up_key_down = (unsafe { GetAsyncKeyState(0x26) } as i32 & 0x8000) != 0;
            let down_key_down = (unsafe { GetAsyncKeyState(0x28) } as i32 & 0x8000) != 0;
            let escape_down = (unsafe { GetAsyncKeyState(0x1B) } as i32 & 0x8000) != 0;
            let enter_down = (unsafe { GetAsyncKeyState(0x0D) } as i32 & 0x8000) != 0;
            let f_down = (unsafe { GetAsyncKeyState(0x46) } as i32 & 0x8000) != 0;
            let b_down = (unsafe { GetAsyncKeyState(0x42) } as i32 & 0x8000) != 0;
            let n_down = (unsafe { GetAsyncKeyState(0x4E) } as i32 & 0x8000) != 0;

            if inside && on_mpv && left_click {
                let _ = app_handle.emit_to("player", PLAYER_VIDEO_CLICK_EVENT, ());
            }

            if inside && on_mpv && !on_overlay && (moved || left_click || right_click) {
                let now = Instant::now();
                if now.duration_since(last_emit) >= Duration::from_millis(45) {
                    let _ = app_handle.emit_to("player", PLAYER_ACTIVITY_EVENT, ());
                    last_emit = now;
                }
            }

            if player_active && space_down && !last_space_down {
                eprintln!(
          "player key toggle_pause (player_active={player_active} inside={inside} on_overlay={on_overlay} on_mpv={on_mpv})"
        );
                if let Err(e) = app_handle.emit_to("player", PLAYER_KEY_EVENT, "toggle_pause") {
                    eprintln!("player key emit failed: {e}");
                }
            }
            if !player_active && inside && space_down && !last_space_down {
                // Helps debug reports like "space doesn't pause" when the player window is visible but
                // not actually the active foreground window.
                eprintln!(
          "player key SPACE ignored (player_active=false inside=true on_overlay={on_overlay} on_mpv={on_mpv})"
        );
            }
            if player_active && left_key_down && !last_left_key_down {
                let _ = app_handle.emit_to("player", PLAYER_KEY_EVENT, "seek_back");
            }
            if player_active && right_key_down && !last_right_key_down {
                let _ = app_handle.emit_to("player", PLAYER_KEY_EVENT, "seek_forward");
            }
            if player_active && up_key_down && !last_up_key_down {
                let _ = app_handle.emit_to("player", PLAYER_KEY_EVENT, "volume_up");
            }
            if player_active && down_key_down && !last_down_key_down {
                let _ = app_handle.emit_to("player", PLAYER_KEY_EVENT, "volume_down");
            }
            if player_active && escape_down && !last_escape_down {
                let _ = app_handle.emit_to("player", PLAYER_KEY_EVENT, "close");
            }
            if player_active && enter_down && !last_enter_down {
                let _ = app_handle.emit_to("player", PLAYER_KEY_EVENT, "fullscreen");
            }
            if player_active && f_down && !last_f_down {
                let _ = app_handle.emit_to("player", PLAYER_KEY_EVENT, "fullscreen");
            }
            if player_active && b_down && !last_b_down {
                let _ = app_handle.emit_to("player", PLAYER_KEY_EVENT, "brightness_up");
            }
            if player_active && n_down && !last_n_down {
                let _ = app_handle.emit_to("player", PLAYER_KEY_EVENT, "brightness_down");
            }

            last_x = pt.x;
            last_y = pt.y;
            last_left_down = left_down;
            last_right_down = right_down;
            last_space_down = space_down;
            last_left_key_down = left_key_down;
            last_right_key_down = right_key_down;
            last_up_key_down = up_key_down;
            last_down_key_down = down_key_down;
            last_escape_down = escape_down;
            last_enter_down = enter_down;
            last_f_down = f_down;
            last_b_down = b_down;
            last_n_down = n_down;

            thread::sleep(Duration::from_millis(45));
        }
    });
}

// Legacy mpv IPC helpers (superseded by `src/player/`).
#[cfg(any())]
#[cfg(windows)]
type MpvStream = std::fs::File;
#[cfg(any())]
#[cfg(not(windows))]
type MpvStream = std::os::unix::net::UnixStream;

#[cfg(any())]
fn is_pipe_closed_error(err: &std::io::Error) -> bool {
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("broken pipe")
        || msg.contains("pipe is being closed")
        || msg.contains("not connected")
        || msg.contains("closed")
        || matches!(err.raw_os_error(), Some(232) | Some(109) | Some(233))
}

#[cfg(any())]
fn make_mpv_ipc_path() -> Result<String, String> {
    let pid = std::process::id();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    if cfg!(windows) {
        Ok(format!(r"\\.\pipe\cinevault-mpv-{}-{}", pid, ts))
    } else {
        let project_dirs = ProjectDirs::from("com", "movieplayer", "cinevault")
            .ok_or("failed to resolve app data dir")?;
        let data_dir = project_dirs.data_dir();
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let sock = data_dir.join(format!("mpv-{}-{}.sock", pid, ts));
        let _ = std::fs::remove_file(&sock);
        Ok(sock.to_string_lossy().to_string())
    }
}

#[cfg(any())]
#[cfg(windows)]
fn connect_mpv_ipc_once(ipc_path: &str) -> std::io::Result<MpvStream> {
    OpenOptions::new().read(true).write(true).open(ipc_path)
}

#[cfg(any())]
#[cfg(not(windows))]
fn connect_mpv_ipc_once(ipc_path: &str) -> std::io::Result<MpvStream> {
    use std::os::unix::net::UnixStream;
    UnixStream::connect(ipc_path)
}

#[cfg(any())]
fn connect_mpv_ipc_with_retry(ipc_path: &str) -> Result<MpvStream, String> {
    let mut last_err: Option<String> = None;
    for _ in 0..160 {
        match connect_mpv_ipc_once(ipc_path) {
            Ok(stream) => return Ok(stream),
            Err(e) => {
                last_err = Some(e.to_string());
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
    Err(format!(
        "failed to connect to mpv IPC at {}: {}",
        ipc_path,
        last_err.unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[cfg(any())]
#[cfg(windows)]
fn set_pipe_nowait_best_effort(stream: &std::fs::File) {
    use std::os::windows::io::AsRawHandle;
    // Non-blocking writes are important to prevent UI "dead" states when mpv is temporarily
    // not draining the pipe. If this fails, we fall back to blocking mode.
    unsafe {
        let handle = HANDLE(stream.as_raw_handle());
        let mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
        match SetNamedPipeHandleState(handle, Some(&mode), None, None) {
            Ok(_) => {
                // Helps verify we're running in non-blocking mode for writes (critical for pause/resume reliability).
                eprintln!("mpv IPC writer set to NOWAIT");
            }
            Err(e) => {
                eprintln!("mpv IPC SetNamedPipeHandleState(NOWAIT) failed: {e:?}");
            }
        };
    }
}

#[cfg(any())]
fn open_resume_writer_db() -> Result<Connection, String> {
    let project_dirs = ProjectDirs::from("com", "movieplayer", "cinevault")
        .ok_or("failed to resolve app data dir")?;
    let data_dir = project_dirs.data_dir();
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let db_path = data_dir.join("cinevault.sqlite3");

    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS playback (
  item_id TEXT PRIMARY KEY,
  position_seconds REAL NOT NULL,
  duration_seconds REAL,
  updated_at_ms INTEGER NOT NULL
);
"#,
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[cfg(any())]
fn upsert_playback(
    conn: &Connection,
    media_key: &str,
    position_seconds: f64,
    duration_seconds: Option<f64>,
) -> Result<(), String> {
    let updated_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    conn.execute(
        r#"
INSERT INTO playback (item_id, position_seconds, duration_seconds, updated_at_ms)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(item_id) DO UPDATE SET
  position_seconds = excluded.position_seconds,
  duration_seconds = excluded.duration_seconds,
  updated_at_ms = excluded.updated_at_ms
"#,
        params![media_key, position_seconds, duration_seconds, updated_at_ms],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(any())]
fn clear_playback(conn: &Connection, media_key: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM playback WHERE item_id = ?1",
        params![media_key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(any())]
fn should_clear_resume(position_seconds: f64, duration_seconds: Option<f64>) -> bool {
    let Some(d) = duration_seconds else {
        return false;
    };
    if d <= 0.0 {
        return false;
    }
    // Consider "watched" if we are very near the end.
    position_seconds >= d - 20.0 || (position_seconds / d) >= 0.98
}

// Legacy mpv IPC implementation (superseded by `src/player/ipc.rs` + `src/player/session.rs`).
// Kept temporarily for reference but excluded from compilation.
#[cfg(any())]
mod legacy_mpv_ipc {
    use super::*;

    fn start_mpv_ipc(
        app_handle: tauri::AppHandle,
        ipc_path: String,
        media_key: String,
        mpv_pid: u32,
    ) -> MpvIpc {
        // Emit playback updates on a dedicated thread so the mpv IPC reader loop never blocks on
        // the frontend/webview event loop (which can stall the pipe and deadlock playback).
        let (playback_event_tx, playback_event_rx) = mpsc::channel::<PlayerPlaybackEventPayload>();
        {
            let app_handle_for_emit = app_handle.clone();
            thread::spawn(move || {
                while let Ok(first) = playback_event_rx.recv() {
                    let mut latest = first;
                    while let Ok(next) = playback_event_rx.try_recv() {
                        latest = next;
                    }
                    let _ = app_handle_for_emit.emit_to("player", PLAYER_PLAYBACK_EVENT, latest);
                }
            });
        }

        let (tx, rx) = mpsc::channel::<IpcRequest>();
        let inner = Arc::new(MpvIpcInner {
            tx,
            playback_event_tx,
            next_request_id: AtomicU64::new(1),
            connected: AtomicBool::new(false),
            ipc_path,
            mpv_pid,
            media_key: media_key.clone(),
            last_tx_at_ms: AtomicU64::new(0),
            last_rx_at_ms: AtomicU64::new(0),
            playback_seq: AtomicU64::new(0),
            last_playback_emit_at_ms: AtomicU64::new(0),
            time_pos_seconds: Mutex::new(None),
            duration_seconds: Mutex::new(None),
            paused: Mutex::new(None),
            tracks: Mutex::new(None),
        });

        let handle = MpvIpc {
            inner: inner.clone(),
        };
        let ipc_path = inner.ipc_path.clone();
        let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<JsonValue, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Resume writes must never block the IPC reader loop (which would eventually deadlock the pipe).
        // Offload DB writes to a dedicated thread.
        enum ResumeMsg {
            Upsert { pos: f64, dur: Option<f64> },
            Clear,
        }
        let (resume_tx, resume_rx) = mpsc::channel::<ResumeMsg>();
        let resume_key = media_key.clone();
        thread::spawn(move || {
            let mut db = match open_resume_writer_db() {
                Ok(c) => Some(c),
                Err(e) => {
                    eprintln!("resume db open failed: {}", e);
                    None
                }
            };
            while let Ok(msg) = resume_rx.recv() {
                let Some(conn) = db.as_mut() else {
                    continue;
                };
                match msg {
                    ResumeMsg::Upsert { pos, dur } => {
                        if let Err(e) = upsert_playback(conn, &resume_key, pos, dur) {
                            eprintln!("resume db write failed: {}", e);
                        }
                    }
                    ResumeMsg::Clear => {
                        if let Err(e) = clear_playback(conn, &resume_key) {
                            eprintln!("resume db clear failed: {}", e);
                        }
                    }
                }
            }
        });

        // Connect once, then split read/write using cloned handles.
        let pending_for_runner = pending.clone();
        let inner_for_runner = inner.clone();
        let handle_for_runner = handle.clone();
        thread::spawn(move || {
            let stream = match connect_mpv_ipc_with_retry(&ipc_path) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("mpv IPC connect failed: {}", e);
                    inner_for_runner.connected.store(false, Ordering::SeqCst);
                    emit_playback_event(&handle_for_runner, true);
                    return;
                }
            };

            let read_stream = match stream.try_clone() {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("mpv IPC clone failed: {}", e);
                    inner_for_runner.connected.store(false, Ordering::SeqCst);
                    emit_playback_event(&handle_for_runner, true);
                    return;
                }
            };

            #[cfg(windows)]
            if std::env::var("CINEVAULT_MPV_PIPE_NOWAIT").is_ok() {
                set_pipe_nowait_best_effort(&stream);
            }

            inner_for_runner.connected.store(true, Ordering::SeqCst);
            inner_for_runner
                .last_tx_at_ms
                .store(now_epoch_ms_u64(), Ordering::SeqCst);
            inner_for_runner
                .last_rx_at_ms
                .store(now_epoch_ms_u64(), Ordering::SeqCst);
            eprintln!(
                "mpv IPC connected: {} (pid={} media_key=\"{}\")",
                ipc_path,
                inner_for_runner.mpv_pid,
                truncate_for_log(&inner_for_runner.media_key, 80)
            );

            let inner_for_writer = inner_for_runner.clone();
            let pending_for_writer = pending_for_runner.clone();
            let handle_for_writer = handle_for_runner.clone();
            let writer_rx = rx;
            thread::spawn(move || {
                let mut out = stream;
                while let Ok(req) = writer_rx.recv() {
                    if let Some(resp_tx) = req.resp {
                        if let Ok(mut map) = pending_for_writer.lock() {
                            map.insert(req.request_id, resp_tx);
                        }
                    }

                    let summary = mpv_payload_summary(&req.payload);
                    let is_pause_cmd = summary.contains("\"pause\"")
                        && (summary.contains("set_property") || summary.contains("cycle"));
                    if is_pause_cmd {
                        eprintln!("mpv IPC write begin (id={} {summary})", req.request_id);
                    }
                    let s = req.payload.to_string();
                    let write_start = Instant::now();
                    if let Err(e) = writeln!(&mut out, "{}", s) {
                        let ipc_for_log = MpvIpc {
                            inner: inner_for_writer.clone(),
                        };
                        let err = format!(
                            "mpv IPC write failed (id={} {}): {} {}",
                            req.request_id,
                            summary,
                            e,
                            ipc_debug_state(&ipc_for_log)
                        );
                        eprintln!("❌ mpv IPC write failed: {}", err);
                        inner_for_writer.connected.store(false, Ordering::SeqCst);
                        if let Ok(mut map) = pending_for_writer.lock() {
                            if let Some(tx) = map.remove(&req.request_id) {
                                let remove_result = tx.send(Err(err.clone()));
                                eprintln!(
                                    "🗑️ mpv IPC write failed: removed pending request result={:?}",
                                    remove_result
                                );
                            }
                        }
                        fail_pending_requests(
                            &pending_for_writer,
                            "mpv IPC disconnected".to_string(),
                        );
                        break;
                    }
                    let elapsed = write_start.elapsed();
                    if is_pause_cmd || elapsed >= Duration::from_millis(250) {
                        eprintln!(
                            "mpv IPC write end (id={} {summary}) elapsed_ms={}",
                            req.request_id,
                            elapsed.as_millis()
                        );
                    }
                    inner_for_writer
                        .last_tx_at_ms
                        .store(now_epoch_ms_u64(), Ordering::SeqCst);
                    // Important: don't call FlushFileBuffers (via `flush()`) on Windows named pipes.
                    // It can block until the server reads, which makes pause/play feel "stuck" and causes timeouts.
                }
                inner_for_writer.connected.store(false, Ordering::SeqCst);
                fail_pending_requests(&pending_for_writer, "mpv IPC disconnected".to_string());
                emit_playback_event(&handle_for_writer, true);
            });

            let handle_for_reader = handle_for_runner.clone();
            thread::spawn(move || {
                let mut last_write = Instant::now() - Duration::from_secs(10);
                let mut last_written_pos: Option<f64> = None;

                let mut reader = BufReader::new(read_stream);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => {
                            // EOF (mpv quit or pipe closed)
                            let ipc_for_log = MpvIpc {
                                inner: inner_for_runner.clone(),
                            };
                            eprintln!(
                                "mpv IPC EOF (pipe closed by mpv) {}",
                                ipc_debug_state(&ipc_for_log)
                            );
                            inner_for_runner.connected.store(false, Ordering::SeqCst);
                            fail_pending_requests(
                                &pending_for_runner,
                                "mpv IPC disconnected".to_string(),
                            );
                            emit_playback_event(&handle_for_reader, true);
                            break;
                        }
                        Ok(_) => {}
                        Err(e) => {
                            let ipc_for_log = MpvIpc {
                                inner: inner_for_runner.clone(),
                            };
                            eprintln!(
                                "mpv IPC read failed: {} {}",
                                e,
                                ipc_debug_state(&ipc_for_log)
                            );
                            inner_for_runner.connected.store(false, Ordering::SeqCst);
                            fail_pending_requests(
                                &pending_for_runner,
                                format!("mpv IPC read failed: {e}"),
                            );
                            emit_playback_event(&handle_for_reader, true);
                            break;
                        }
                    }

                    let Ok(msg) = serde_json::from_str::<JsonValue>(line.trim()) else {
                        continue;
                    };
                    inner_for_runner
                        .last_rx_at_ms
                        .store(now_epoch_ms_u64(), Ordering::SeqCst);

                    if let Some(req_id) = msg.get("request_id").and_then(|v| v.as_u64()) {
                        if let Ok(mut map) = pending_for_runner.lock() {
                            if let Some(tx) = map.remove(&req_id) {
                                let _ = tx.send(Ok(msg));
                            }
                        }
                        continue;
                    }

                    let Some(event) = msg.get("event").and_then(|v| v.as_str()) else {
                        continue;
                    };

                    match event {
                        "property-change" => {
                            let Some(name) = msg.get("name").and_then(|v| v.as_str()) else {
                                continue;
                            };
                            let data = msg.get("data").cloned().unwrap_or(JsonValue::Null);

                            if name == "time-pos" {
                                let pos = data.as_f64();
                                if let Ok(mut guard) = inner_for_runner.time_pos_seconds.lock() {
                                    *guard = pos;
                                }

                                let Some(pos) = pos else {
                                    continue;
                                };

                                // Throttle DB writes.
                                let now = Instant::now();
                                let should_write = now.duration_since(last_write)
                                    >= Duration::from_secs(2)
                                    && last_written_pos
                                        .map(|p| (p - pos).abs() >= 1.0)
                                        .unwrap_or(true);
                                if should_write {
                                    let dur = inner_for_runner
                                        .duration_seconds
                                        .lock()
                                        .ok()
                                        .and_then(|g| *g);
                                    let _ = resume_tx.send(ResumeMsg::Upsert { pos, dur });
                                    last_write = now;
                                    last_written_pos = Some(pos);
                                }

                                emit_playback_event(&handle_for_reader, false);
                            } else if name == "duration" {
                                let dur = data.as_f64();
                                if let Ok(mut guard) = inner_for_runner.duration_seconds.lock() {
                                    *guard = dur;
                                }
                                emit_playback_event(&handle_for_reader, true);
                            } else if name == "pause" {
                                eprintln!("🎬 mpv IPC event pause: START - raw_data={}", data);
                                let paused = data.as_bool();
                                eprintln!("🔍 mpv IPC event pause: parsed paused={:?}", paused);
                                if let Ok(mut guard) = inner_for_runner.paused.lock() {
                                    let old_paused = *guard;
                                    *guard = paused;
                                    eprintln!(
                                        "💾 mpv IPC event pause: updated cache from {:?} to {:?}",
                                        old_paused, paused
                                    );
                                } else {
                                    eprintln!(
                                        "❌ mpv IPC event pause: failed to lock paused mutex"
                                    );
                                }

                                {
                                    let ipc_for_log = MpvIpc {
                                        inner: inner_for_runner.clone(),
                                    };
                                    eprintln!(
                                        "📊 mpv IPC event pause={paused:?} {}",
                                        ipc_debug_state(&ipc_for_log)
                                    );
                                }

                                // Write immediately when pausing.
                                if paused == Some(true) {
                                    eprintln!("⏸️ mpv IPC event pause: pausing detected, writing resume position");
                                    let pos = inner_for_runner
                                        .time_pos_seconds
                                        .lock()
                                        .ok()
                                        .and_then(|g| *g);
                                    if let Some(pos) = pos {
                                        let dur = inner_for_runner
                                            .duration_seconds
                                            .lock()
                                            .ok()
                                            .and_then(|g| *g);
                                        eprintln!("📝 mpv IPC event pause: sending resume upsert pos={:?}, dur={:?}", pos, dur);
                                        let _ = resume_tx.send(ResumeMsg::Upsert { pos, dur });
                                        last_write = Instant::now();
                                        last_written_pos = Some(pos);
                                        eprintln!(
                                            "✅ mpv IPC event pause: resume position written"
                                        );
                                    } else {
                                        eprintln!("❌ mpv IPC event pause: no position available for resume write");
                                    }
                                } else {
                                    eprintln!("▶️ mpv IPC event pause: playing detected, no resume write needed");
                                }
                                eprintln!("🏁 mpv IPC event pause: END");
                                emit_playback_event(&handle_for_reader, true);
                            } else if name == "track-list" {
                                let tracks = parse_track_list(&data);
                                if let Ok(mut guard) = inner_for_runner.tracks.lock() {
                                    *guard = Some(tracks);
                                }
                            }
                        }
                        "end-file" => {
                            let pos = inner_for_runner
                                .time_pos_seconds
                                .lock()
                                .ok()
                                .and_then(|g| *g);
                            let dur = inner_for_runner
                                .duration_seconds
                                .lock()
                                .ok()
                                .and_then(|g| *g);
                            if let Some(pos) = pos {
                                if should_clear_resume(pos, dur) {
                                    let _ = resume_tx.send(ResumeMsg::Clear);
                                } else {
                                    let _ = resume_tx.send(ResumeMsg::Upsert { pos, dur });
                                }
                            }
                        }
                        "shutdown" => {
                            let ipc_for_log = MpvIpc {
                                inner: inner_for_runner.clone(),
                            };
                            eprintln!("mpv IPC event shutdown {}", ipc_debug_state(&ipc_for_log));
                            inner_for_runner.connected.store(false, Ordering::SeqCst);
                            fail_pending_requests(
                                &pending_for_runner,
                                "mpv IPC shutdown".to_string(),
                            );
                            emit_playback_event(&handle_for_reader, true);
                            break;
                        }
                        _ => {}
                    }
                }
            });
        });

        handle
    }

    fn now_epoch_ms_u64() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn truncate_for_log(input: &str, max_chars: usize) -> String {
        let mut out: String = input.chars().take(max_chars).collect();
        if input.chars().count() > max_chars {
            out.push_str("...");
        }
        out
    }

    fn mpv_payload_summary(payload: &JsonValue) -> String {
        let cmd = payload.get("command").unwrap_or(payload);
        truncate_for_log(&cmd.to_string(), 220)
    }

    #[cfg(windows)]
    fn is_pid_running(pid: u32) -> Option<bool> {
        if pid == 0 {
            return None;
        }

        // https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess
        // STILL_ACTIVE = 259
        const STILL_ACTIVE_CODE: u32 = 259;

        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut exit_code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut exit_code).is_ok();
            let _ = CloseHandle(handle);
            ok.then_some(exit_code == STILL_ACTIVE_CODE)
        }
    }

    #[cfg(not(windows))]
    fn is_pid_running(_pid: u32) -> Option<bool> {
        None
    }

    fn ipc_debug_state(ipc: &MpvIpc) -> String {
        let connected = ipc.inner.connected.load(Ordering::SeqCst);
        let now = now_epoch_ms_u64();
        let last_tx = ipc.inner.last_tx_at_ms.load(Ordering::SeqCst);
        let last_rx = ipc.inner.last_rx_at_ms.load(Ordering::SeqCst);
        let since_tx = if last_tx > 0 && now >= last_tx {
            now - last_tx
        } else {
            0
        };
        let since_rx = if last_rx > 0 && now >= last_rx {
            now - last_rx
        } else {
            0
        };
        let pid = ipc.inner.mpv_pid;
        let alive = is_pid_running(pid);
        let media_key = truncate_for_log(&ipc.inner.media_key, 80);
        format!(
    "pid={pid} pid_alive={alive:?} media_key=\"{media_key}\" connected={connected} since_tx_ms={since_tx} since_rx_ms={since_rx} (last_tx_ms={last_tx} last_rx_ms={last_rx})"
  )
    }

    fn mpv_send_untracked(ipc: &MpvIpc, payload: JsonValue) -> Result<(), String> {
        if !payload.is_object() {
            return Err("mpv payload must be a JSON object".to_string());
        }
        // Allocate a local request id for logging/ack purposes only.
        // (We do not inject it into the JSON payload.)
        let req_id = ipc.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        ipc.inner
            .tx
            .send(IpcRequest {
                request_id: req_id,
                payload,
                resp: None,
            })
            .map_err(|_| "mpv IPC channel closed".to_string())
    }

    fn mpv_send(ipc: &MpvIpc, mut payload: JsonValue) -> Result<(), String> {
        // 🔥 Check if this is a fire-and-forget command
        let is_fire_and_forget = payload
            .get("command")
            .and_then(|c| c.as_array())
            .and_then(|c| c.get(0))
            .and_then(|v| v.as_str())
            .map(|cmd| matches!(cmd, "set_property" | "cycle" | "seek" | "set" | "add"))
            .unwrap_or(false);

        eprintln!(
            "🔥 mpv_send: command={}, fire_and_forget={}",
            payload
                .get("command")
                .and_then(|c| c.as_array())
                .and_then(|c| c.get(0))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown"),
            is_fire_and_forget
        );

        let req_id = ipc.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("request_id".to_string(), JsonValue::from(req_id));
        } else {
            return Err("mpv payload must be a JSON object".to_string());
        }
        let summary = mpv_payload_summary(&payload);

        // 🚀 For fire-and-forget commands, don't wait for response
        if is_fire_and_forget {
            eprintln!("📨 mpv_send: sending fire-and-forget command");
            ipc.inner
                .tx
                .send(IpcRequest {
                    request_id: req_id,
                    payload,
                    resp: None,
                })
                .map_err(|_| format!("mpv IPC channel closed (id={req_id} {summary})"))?;
            eprintln!("✅ mpv_send: fire-and-forget command sent successfully");
            return Ok(());
        }

        // 🧠 For request-response commands, wait for response
        eprintln!("📨 mpv_send: sending request-response command");
        let (tx, rx) = mpsc::channel::<Result<JsonValue, String>>();
        ipc.inner
            .tx
            .send(IpcRequest {
                request_id: req_id,
                payload,
                resp: Some(tx),
            })
            .map_err(|_| format!("mpv IPC channel closed (id={req_id} {summary})"))?;

        let resp = rx.recv_timeout(Duration::from_millis(2000)).map_err(|_| {
            format!(
                "mpv IPC request timed out (id={req_id} {summary} {})",
                ipc_debug_state(ipc)
            )
        })?;
        let resp =
            resp.map_err(|err| format!("{err} (id={req_id} {summary} {})", ipc_debug_state(ipc)))?;
        mpv_expect_success(&resp).map_err(|err| format!("{err} (id={req_id} {summary})"))
    }

    fn mpv_request(ipc: &MpvIpc, mut payload: JsonValue) -> Result<JsonValue, String> {
        let req_id = ipc.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("request_id".to_string(), JsonValue::from(req_id));
        } else {
            return Err("mpv payload must be a JSON object".to_string());
        }
        let summary = mpv_payload_summary(&payload);

        let (tx, rx) = mpsc::channel::<Result<JsonValue, String>>();
        ipc.inner
            .tx
            .send(IpcRequest {
                request_id: req_id,
                payload,
                resp: Some(tx),
            })
            .map_err(|_| format!("mpv IPC channel closed (id={req_id} {summary})"))?;

        let resp = rx.recv_timeout(Duration::from_secs(8)).map_err(|_| {
            format!(
                "mpv IPC request timed out (id={req_id} {summary} {})",
                ipc_debug_state(ipc)
            )
        })?;
        resp.map_err(|err| format!("{err} (id={req_id} {summary} {})", ipc_debug_state(ipc)))
    }

    fn mpv_expect_success(resp: &JsonValue) -> Result<(), String> {
        let err = resp
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        if err == "success" {
            Ok(())
        } else {
            Err(err.to_string())
        }
    }

    fn wait_for_ipc_connected(ipc: &MpvIpc, timeout: Duration) -> Result<(), String> {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if ipc.inner.connected.load(Ordering::SeqCst) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(25));
        }
        Err("mpv IPC is not connected yet".to_string())
    }

    fn register_mpv_observers(ipc: &MpvIpc) -> Result<(), String> {
        // Strict rule: no polling. Observe properties and throttle emits to frontend.
        mpv_send(
            ipc,
            json!({ "command": ["observe_property", 1, "time-pos"] }),
        )?;
        mpv_send(
            ipc,
            json!({ "command": ["observe_property", 2, "duration"] }),
        )?;
        mpv_send(ipc, json!({ "command": ["observe_property", 3, "pause"] }))?;
        mpv_send(
            ipc,
            json!({ "command": ["observe_property", 4, "track-list"] }),
        )?;
        Ok(())
    }

    fn start_time_pos_sampler(ipc: MpvIpc) {
        return;
        // Backend requirement: throttle time-pos to ~4–10x/sec.
        const INTERVAL: Duration = Duration::from_millis(125); // 8 Hz
        thread::spawn(move || loop {
            if !ipc.inner.connected.load(Ordering::SeqCst) {
                break;
            }

            // If paused, time-pos won't change; avoid unnecessary requests.
            let paused = ipc.inner.paused.lock().ok().and_then(|g| *g);
            if paused == Some(true) {
                thread::sleep(INTERVAL);
                continue;
            }

            if let Ok(resp) = mpv_request(&ipc, json!({ "command": ["get_property", "time-pos"] }))
            {
                if mpv_expect_success(&resp).is_ok() {
                    if let Ok(mut guard) = ipc.inner.time_pos_seconds.lock() {
                        *guard = resp.get("data").and_then(|v| v.as_f64());
                    }
                    emit_playback_event(&ipc, false);
                }
            }

            thread::sleep(INTERVAL);
        });
    }

    fn refresh_ipc_snapshot(ipc: &MpvIpc) -> Result<(), String> {
        if let Ok(resp) = mpv_request(ipc, json!({ "command": ["get_property", "time-pos"] })) {
            if mpv_expect_success(&resp).is_ok() {
                if let Ok(mut guard) = ipc.inner.time_pos_seconds.lock() {
                    *guard = resp.get("data").and_then(|v| v.as_f64());
                }
            }
        }

        if let Ok(resp) = mpv_request(ipc, json!({ "command": ["get_property", "duration"] })) {
            if mpv_expect_success(&resp).is_ok() {
                if let Ok(mut guard) = ipc.inner.duration_seconds.lock() {
                    *guard = resp.get("data").and_then(|v| v.as_f64());
                }
            }
        }

        if let Ok(resp) = mpv_request(ipc, json!({ "command": ["get_property", "pause"] })) {
            if mpv_expect_success(&resp).is_ok() {
                if let Ok(mut guard) = ipc.inner.paused.lock() {
                    *guard = resp.get("data").and_then(|v| v.as_bool());
                }
            }
        }

        if let Ok(resp) = mpv_request(ipc, json!({ "command": ["get_property", "track-list"] })) {
            if mpv_expect_success(&resp).is_ok() {
                let tracks = parse_track_list(resp.get("data").unwrap_or(&JsonValue::Null));
                if let Ok(mut guard) = ipc.inner.tracks.lock() {
                    *guard = Some(tracks);
                }
            }
        }

        Ok(())
    }

    fn reconnect_ipc_for_media(
        player: &tauri::State<PlayerProc>,
        app_handle: &tauri::AppHandle,
        media_key: &str,
    ) -> Result<MpvIpc, String> {
        let ipc_path = player
            .ipc_path
            .lock()
            .map_err(|_| "player mutex poisoned".to_string())?
            .clone()
            .ok_or_else(|| "mpv IPC path is not initialized".to_string())?;

        let pid = player
            .child
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|c| c.id()))
            .ok_or_else(|| "mpv process is not running".to_string())?;

        eprintln!("mpv IPC disconnected while process is alive, reconnecting... (pid={pid})");
        let ipc = start_mpv_ipc(app_handle.clone(), ipc_path, media_key.to_string(), pid);
        wait_for_ipc_connected(&ipc, Duration::from_secs(8))?;
        register_mpv_observers(&ipc)?;
        let _ = refresh_ipc_snapshot(&ipc);
        emit_playback_event(&ipc, true);

        let mut guard = player
            .ipc
            .lock()
            .map_err(|_| "player mutex poisoned".to_string())?;
        *guard = Some(ipc.clone());

        Ok(ipc)
    }

    fn should_retry_ipc_error(err: &str) -> bool {
        let lower = err.to_ascii_lowercase();
        lower.contains("pipe is being closed")
            || lower.contains("os error 232")
            || lower.contains("channel closed")
            || lower.contains("not connected")
            || lower.contains("disconnected")
            || lower.contains("timed out")
    }

    fn with_ipc_retry<T, F>(
        player: &tauri::State<PlayerProc>,
        app_handle: &tauri::AppHandle,
        media_key: &str,
        mut op: F,
    ) -> Result<(MpvIpc, T), String>
    where
        F: FnMut(&MpvIpc) -> Result<T, String>,
    {
        let ipc = require_ipc_for_media(player, app_handle, media_key)?;
        match op(&ipc) {
            Ok(value) => Ok((ipc, value)),
            Err(err) if should_retry_ipc_error(&err) => {
                // A timeout does not necessarily mean the pipe is broken. Reconnecting on timeouts can also
                // accidentally create multiple active IPC clients (each with observers), amplifying traffic
                // and making the situation worse. Only reconnect on timeouts if we already consider the IPC
                // disconnected.
                {
                    let lower = err.to_ascii_lowercase();
                    if lower.contains("mpv ipc request timed out")
                        && ipc.inner.connected.load(Ordering::SeqCst)
                    {
                        return Err(err);
                    }
                }
                eprintln!(
                    "mpv IPC command failed for media_key=\"{}\", retrying after reconnect: {err}",
                    media_key
                );
                let ipc = reconnect_ipc_for_media(player, app_handle, media_key)?;
                let value = op(&ipc)?;
                Ok((ipc, value))
            }
            Err(err) => Err(err),
        }
    }
} // mod legacy_mpv_ipc

fn start_mpv_exit_watch_thread(app_handle: tauri::AppHandle, expected_pid: u32) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(400));
        let player = app_handle.state::<PlayerProc>();
        let current_pid = player
            .child
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|c| c.id()));
        if current_pid != Some(expected_pid) {
            break;
        }
        let _ = sync_player_process_state(&player);
    });
}

// Legacy spawn path (superseded by `src/player/mpv.rs`).
#[cfg(any())]
mod legacy_player_spawn {
    use super::*;

    fn player_play_path_spawn_mpv(
        window: tauri::WebviewWindow,
        player: tauri::State<PlayerProc>,
        media_path: String,
        start_position_seconds: Option<f64>,
        extra_subs: Vec<String>,
    ) -> Result<(), String> {
        let media_path = media_path.trim().to_string();
        if media_path.is_empty() {
            return Err("media_path is empty".to_string());
        }
        eprintln!(
            "player_play_path media_path=\"{}\" start_position_seconds={:?}",
            truncate_for_log(&media_path, 140),
            start_position_seconds
        );

        let p = PathBuf::from(&media_path);
        if !p.is_file() {
            return Err(format!("media_path is not a file: {}", media_path));
        }

        // Stop any existing mpv instance we spawned.
        if let Ok(mut guard) = player.child.lock() {
            if let Some(child) = guard.take() {
                kill_child_quick(child);
            }
        }
        if let Ok(mut guard) = player.ipc.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = player.ipc_path.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = player.now_playing.lock() {
            *guard = None;
        }
        #[cfg(windows)]
        if let Ok(mut guard) = player.mpv_hwnd.lock() {
            *guard = None;
        }
        #[cfg(windows)]
        if let Ok(mut guard) = player.overlay_hwnd.lock() {
            *guard = None;
        }
        #[cfg(windows)]
        stop_player_activity_watcher(&player);
        #[cfg(windows)]
        {
            player.overlay_insets.top.store(0, Ordering::SeqCst);
            player.overlay_insets.bottom.store(0, Ordering::SeqCst);
        }
        let ipc_path = make_mpv_ipc_path()?;
        if let Ok(mut guard) = player.ipc_path.lock() {
            *guard = Some(ipc_path.clone());
        }

        let mpv_cmd = resolve_mpv_command();
        let mut cmd = Command::new(&mpv_cmd);

        #[cfg(windows)]
        let window_hwnd =
            if window.label() == "player" && std::env::var("CINEVAULT_MPV_EMBED").is_ok() {
                window.hwnd().ok().map(|h| {
                    // Be defensive: depending on platform internals, `hwnd()` might be a child handle.
                    // For embedding, prefer the top-level window handle.
                    let hwnd = HWND(h.0);
                    unsafe {
                        let root = GetAncestor(hwnd, GA_ROOT);
                        if root.0.is_null() {
                            h.0 as isize
                        } else {
                            root.0 as isize
                        }
                    }
                })
            } else {
                None
            };

        #[cfg(windows)]
        if let Some(hwnd) = window_hwnd {
            // Embed MPV directly into the Tauri window using --wid
            cmd.arg(format!("--wid={}", hwnd));
            cmd.arg("--force-window=no");
        } else {
            cmd.arg("--force-window=yes");
        }

        cmd.arg("--keep-open=yes");
        cmd.arg(format!("--input-ipc-server={}", ipc_path));
        if let Some(path) = mpv_log_file_path() {
            eprintln!("mpv log file: {}", path.display());
            cmd.arg(format!("--log-file={}", path.to_string_lossy()));
            if std::env::var("CINEVAULT_MPV_VERBOSE").is_ok() {
                cmd.arg("--msg-level=all=v");
            }
        }

        #[cfg(windows)]
        {
            if window.label() == "player" {
                // In player mode, we run mpv borderless and then keep its window synced behind the
                // Tauri overlay window. mpv stays aligned to the real client area while the overlay
                // window region decides which UI chrome remains visible/hit-testable.
                // Use deterministic settings for the embedded/overlay mode (don't load user config/input.conf).
                cmd.arg("--config=no");
                cmd.arg("--load-scripts=no");
                cmd.arg("--no-border");
                cmd.arg("--no-osc");
                cmd.arg("--osd-level=0");
                // Avoid mpv reacting to clicks/double-clicks (fullscreen toggles, pause, etc).
                // The app UI controls playback via IPC.
                cmd.arg("--input-default-bindings=no");
                cmd.arg("--input-cursor=yes");
                cmd.arg("--cursor-autohide=2000");
                cmd.arg("--no-cursor-autohide-fs-only");
                cmd.arg("--input-doubleclick-time=0");
                cmd.arg("--no-keepaspect-window");
                cmd.arg("--auto-window-resize=no");
                // Prevent mpv from moving its own window when dragging on the video surface.
                cmd.arg("--window-dragging=no");
                cmd.arg("--input-builtin-dragging=no");
                cmd.arg("--drag-and-drop=no");
                // Avoid Windows overlay-plane / occlusion issues when another window (our UI overlay) is on top.
                // These options override the user's mpv.conf for the embedded/overlay player mode only.
                cmd.arg("--vo=gpu");
                // cmd.arg("--gpu-api=opengl");
                // cmd.arg("--gpu-context=win");
                // cmd.arg("--hwdec=auto-copy");
                // Force solid black for any non-video window area so aspect-ratio bars never show up white.
                cmd.arg("--background=color");
                cmd.arg("--border-background=color");
                cmd.arg("--background-color=#000000");
                // Keep subtitles inside the video frame instead of parking them in letterbox margins.
                cmd.arg("--sub-use-margins=no");
                cmd.arg("--sub-ass-force-margins=no");
                cmd.arg("--sub-pos=100");
            }
        }

        if let Some(pos) = start_position_seconds {
            if pos > 0.0 {
                cmd.arg(format!("--start={}", pos));
            }
        }

        for sub in extra_subs {
            cmd.arg(format!("--sub-file={}", sub));
        }

        cmd.arg("--");
        cmd.arg(&media_path);

        let spawn_args = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        println!(
            "spawning mpv: {} {}",
            mpv_cmd.display(),
            spawn_args.join(" ")
        );

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "failed to spawn mpv (set MPV_PATH or place mpv in repo /mpv): {}",
                e
            )
        })?;
        let child_pid = child.id();
        if let Some(stdout) = child.stdout.take() {
            start_process_log_thread(stdout, "stdout", child_pid);
        }
        if let Some(stderr) = child.stderr.take() {
            start_process_log_thread(stderr, "stderr", child_pid);
        }

        {
            let mut guard = player
                .child
                .lock()
                .map_err(|_| "player mutex poisoned".to_string())?;
            *guard = Some(child);
        }

        // Detect unexpected mpv exits even if the UI stops sending commands after an IPC disconnect.
        start_mpv_exit_watch_thread(window.app_handle().clone(), child_pid);

        {
            let mut guard = player
                .now_playing
                .lock()
                .map_err(|_| "player mutex poisoned".to_string())?;
            *guard = Some(media_path.clone());
        }

        {
            let ipc = start_mpv_ipc(
                window.app_handle().clone(),
                ipc_path,
                media_path.clone(),
                child_pid,
            );

            // Critical: don't return to the frontend until IPC is actually usable.
            // This avoids startup race conditions that manifest as timeouts + reconnect storms.
            if let Err(err) = (|| -> Result<(), String> {
                wait_for_ipc_connected(&ipc, Duration::from_secs(8))?;
                register_mpv_observers(&ipc)?;
                refresh_ipc_snapshot(&ipc)?;
                emit_playback_event(&ipc, true);
                Ok(())
            })() {
                // If IPC isn't reachable, ensure we don't leave a zombie mpv process running.
                if let Ok(mut guard) = player.child.lock() {
                    if let Some(child) = guard.take() {
                        kill_child_quick(child);
                    }
                }
                if let Ok(mut guard) = player.ipc.lock() {
                    *guard = None;
                }
                if let Ok(mut guard) = player.now_playing.lock() {
                    *guard = None;
                }
                return Err(err);
            }

            let mut guard = player
                .ipc
                .lock()
                .map_err(|_| "player mutex poisoned".to_string())?;
            *guard = Some(ipc.clone());
        }

        #[cfg(windows)]
        {
            if window.label() == "player" {
                if let Ok(hwnd) = window.hwnd() {
                    // Be defensive: depending on platform internals, `hwnd()` might be a child handle.
                    // We want the top-level overlay window HWND for z-order operations.
                    let overlay_hwnd = unsafe {
                        let root = GetAncestor(hwnd, GA_ROOT);
                        if root.0.is_null() {
                            hwnd.0 as isize
                        } else {
                            root.0 as isize
                        }
                    };

                    if let Ok(mut guard) = player.overlay_hwnd.lock() {
                        *guard = Some(overlay_hwnd);
                    }

                    if window_hwnd.is_none() {
                        // Only do window syncing if MPV is not embedded (--wid not used)
                        // Wait briefly for mpv to create its top-level window, then style + sync it behind overlay.
                        let start = Instant::now();
                        let mut mpv_hwnd: Option<isize> = None;
                        while start.elapsed() < Duration::from_secs(3) {
                            if let Some(found) = find_top_level_window_for_pid(child_pid) {
                                mpv_hwnd = Some(found);
                                break;
                            }
                            thread::sleep(Duration::from_millis(25));
                        }

                        if let Some(mpv_hwnd) = mpv_hwnd {
                            make_borderless_toolwindow(mpv_hwnd);
                            if let Ok(mut guard) = player.mpv_hwnd.lock() {
                                *guard = Some(mpv_hwnd);
                            }

                            println!(
              "mpv window attached (pid={}, mpv_hwnd=0x{:X}, overlay_hwnd=0x{:X})",
              child_pid, mpv_hwnd as usize, overlay_hwnd as usize
            );
                            start_sync_mpv_to_overlay_thread(
                                overlay_hwnd,
                                mpv_hwnd,
                                player.overlay_insets.clone(),
                            );
                            start_player_activity_watcher(
                                &player,
                                window.app_handle().clone(),
                                overlay_hwnd,
                                mpv_hwnd,
                            );
                        } else {
                            eprintln!("warning: could not locate mpv window for pid {}", child_pid);
                        }
                    } else {
                        println!(
                            "mpv embedded in window (pid={}, wid=0x{:X})",
                            child_pid,
                            window_hwnd.unwrap() as usize
                        );
                    }
                }
            }
        }

        Ok(())
    }
} // mod legacy_player_spawn

#[tauri::command]
fn player_set_overlay_region(
    window: tauri::WebviewWindow,
    player: tauri::State<PlayerProc>,
    top_height: i32,
    bottom_height: i32,
) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (window, player, top_height, bottom_height);
        return Ok(());
    }

    #[cfg(windows)]
    {
        if window.label() != "player" {
            return Ok(());
        }

        let force_full_overlay = std::env::var("CINEVAULT_OVERLAY_FULL").is_ok();

        // Debug aid: log region changes (throttled) so we can tell whether click-through
        // is accidentally excluding the control bar.
        let log_overlay = {
            let now = now_epoch_ms_u64();
            let last_at = OVERLAY_REGION_LAST_LOG_AT_MS.load(Ordering::Relaxed);
            let prev_top = OVERLAY_REGION_LAST_TOP.load(Ordering::Relaxed);
            let prev_bottom = OVERLAY_REGION_LAST_BOTTOM.load(Ordering::Relaxed);
            let changed = top_height != prev_top || bottom_height != prev_bottom;
            if changed {
                OVERLAY_REGION_LAST_TOP.store(top_height, Ordering::Relaxed);
                OVERLAY_REGION_LAST_BOTTOM.store(bottom_height, Ordering::Relaxed);
            }
            if changed && (last_at == 0 || now.saturating_sub(last_at) >= 500) {
                OVERLAY_REGION_LAST_LOG_AT_MS.store(now, Ordering::Relaxed);
                eprintln!("overlay region request top={top_height} bottom={bottom_height}");
                true
            } else {
                false
            }
        };

        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let mut root_hwnd = hwnd;
        unsafe {
            let root = GetAncestor(hwnd, GA_ROOT);
            if !root.0.is_null() {
                root_hwnd = root;
            }
        }

        let mut window_rect = RECT::default();
        unsafe {
            GetWindowRect(root_hwnd, &mut window_rect)
                .map_err(|e| format!("GetWindowRect failed: {e:?}"))?;
        }

        let client_rect = get_client_screen_rect(root_hwnd)?;
        let offset_x = client_rect.left - window_rect.left;
        let offset_y = client_rect.top - window_rect.top;
        let w = (client_rect.right - client_rect.left).max(1);
        let h = (client_rect.bottom - client_rect.top).max(1);
        let (top_h, bot_h) = if force_full_overlay {
            (h, 0)
        } else {
            (top_height.clamp(0, h), bottom_height.clamp(0, h))
        };
        if log_overlay {
            eprintln!(
	        "overlay region apply top_h={top_h} bot_h={bot_h} client_w={w} client_h={h} offset_x={offset_x} offset_y={offset_y} force_full={force_full_overlay}"
	      );
        }
        player.overlay_insets.top.store(top_h, Ordering::SeqCst);
        player
            .overlay_insets
            .bottom
            .store(bot_h.min((h - top_h).max(0)), Ordering::SeqCst);

        unsafe {
            if top_h == 0 && bot_h == 0 {
                let empty = CreateRectRgn(0, 0, 0, 0);
                let res = SetWindowRgn(root_hwnd, Some(empty), true);
                if res == 0 {
                    let _ = DeleteObject(empty.into());
                    return Err("SetWindowRgn failed".to_string());
                }
                return Ok(());
            }

            let mut combined: Option<HRGN> = None;

            if top_h > 0 {
                combined = Some(CreateRectRgn(
                    offset_x,
                    offset_y,
                    offset_x + w,
                    offset_y + top_h,
                ));
            }

            if bot_h > 0 {
                let r_bot =
                    CreateRectRgn(offset_x, offset_y + h - bot_h, offset_x + w, offset_y + h);
                if let Some(r) = combined {
                    let _ = CombineRgn(Some(r), Some(r), Some(r_bot), RGN_OR);
                    let _ = DeleteObject(r_bot.into());
                    combined = Some(r);
                } else {
                    combined = Some(r_bot);
                }
            }

            let res = SetWindowRgn(root_hwnd, combined, true);
            if res == 0 {
                return Err("SetWindowRgn failed".to_string());
            }
        }

        Ok(())
    }
}

// Legacy player commands (superseded by `src/player/commands.rs`).
#[cfg(any())]
mod legacy_player_commands {
    use super::*;

    #[tauri::command]
    fn legacy_player_stop(player: tauri::State<PlayerProc>) -> Result<(), String> {
        eprintln!("🔥 player_stop called - killing mpv process");
        // Stop any existing mpv instance we spawned.
        if let Ok(mut guard) = player.child.lock() {
            if let Some(child) = guard.take() {
                kill_child_quick(child);
            }
        }
        if let Ok(mut guard) = player.ipc.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = player.ipc_path.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = player.now_playing.lock() {
            *guard = None;
        }
        #[cfg(windows)]
        if let Ok(mut guard) = player.mpv_hwnd.lock() {
            *guard = None;
        }
        #[cfg(windows)]
        if let Ok(mut guard) = player.overlay_hwnd.lock() {
            *guard = None;
        }
        #[cfg(windows)]
        stop_player_activity_watcher(&player);
        #[cfg(windows)]
        {
            player.overlay_insets.top.store(0, Ordering::SeqCst);
            player.overlay_insets.bottom.store(0, Ordering::SeqCst);
        }
        Ok(())
    }

    #[tauri::command]
    fn legacy_player_get_resume_position(
        db: tauri::State<AppDb>,
        media_key: String,
    ) -> Result<Option<f64>, String> {
        let conn = db
            .conn
            .lock()
            .map_err(|_| "db mutex poisoned".to_string())?;

        conn.query_row(
            "SELECT position_seconds FROM playback WHERE item_id = ?1",
            params![media_key],
            |row| row.get::<_, f64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    #[tauri::command]
    fn legacy_player_set_resume_position(
        db: tauri::State<AppDb>,
        media_key: String,
        position_seconds: f64,
        duration_seconds: Option<f64>,
    ) -> Result<(), String> {
        let conn = db
            .conn
            .lock()
            .map_err(|_| "db mutex poisoned".to_string())?;

        let updated_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as i64;

        conn.execute(
            r#"
INSERT INTO playback (item_id, position_seconds, duration_seconds, updated_at_ms)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(item_id) DO UPDATE SET
  position_seconds = excluded.position_seconds,
  duration_seconds = excluded.duration_seconds,
  updated_at_ms = excluded.updated_at_ms
"#,
            params![media_key, position_seconds, duration_seconds, updated_at_ms],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    #[tauri::command]
    fn legacy_player_clear_resume_position(
        db: tauri::State<AppDb>,
        media_key: String,
    ) -> Result<(), String> {
        let conn = db
            .conn
            .lock()
            .map_err(|_| "db mutex poisoned".to_string())?;

        conn.execute(
            "DELETE FROM playback WHERE item_id = ?1",
            params![media_key],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    fn require_ipc_for_media(
        player: &tauri::State<PlayerProc>,
        app_handle: &tauri::AppHandle,
        media_key: &str,
    ) -> Result<MpvIpc, String> {
        if !sync_player_process_state(player)? {
            return Err("mpv process is not running".to_string());
        }

        let now = player
            .now_playing
            .lock()
            .map_err(|_| "player mutex poisoned".to_string())?;

        if now.as_deref() != Some(media_key) {
            return Err("mpv is not playing the selected media path".to_string());
        }
        drop(now);

        let ipc = player
            .ipc
            .lock()
            .map_err(|_| "player mutex poisoned".to_string())?
            .clone();

        if let Some(ipc) = ipc {
            if ipc.inner.connected.load(Ordering::SeqCst) {
                return Ok(ipc);
            }
        }

        reconnect_ipc_for_media(player, app_handle, media_key)
    }

    fn mpv_get_property_data(ipc: &MpvIpc, name: &str) -> Result<JsonValue, String> {
        let resp = mpv_request(ipc, json!({ "command": ["get_property", name] }))?;
        mpv_expect_success(&resp)?;
        Ok(resp.get("data").cloned().unwrap_or(JsonValue::Null))
    }

    fn mpv_get_f64_property(ipc: &MpvIpc, name: &str) -> Result<Option<f64>, String> {
        Ok(mpv_get_property_data(ipc, name)?.as_f64())
    }

    fn mpv_set_f64_property(ipc: &MpvIpc, name: &str, value: f64) -> Result<(), String> {
        mpv_send(ipc, json!({ "command": ["set_property", name, value] }))
    }

    fn read_cached_playback_info(ipc: &MpvIpc) -> PlaybackInfo {
        PlaybackInfo {
            time_pos_seconds: ipc.inner.time_pos_seconds.lock().ok().and_then(|g| *g),
            duration_seconds: ipc.inner.duration_seconds.lock().ok().and_then(|g| *g),
            paused: ipc.inner.paused.lock().ok().and_then(|g| *g),
        }
    }

    fn emit_playback_event(ipc: &MpvIpc, force: bool) {
        // Requirement: throttle time-pos updates to ~4–10x/sec.
        const TIMEPOS_INTERVAL_MS: u64 = 125; // 8 Hz

        let now_ms = now_epoch_ms_u64();
        if !force {
            let last_ms = ipc.inner.last_playback_emit_at_ms.load(Ordering::Relaxed);
            if last_ms != 0 && now_ms.saturating_sub(last_ms) < TIMEPOS_INTERVAL_MS {
                return;
            }
        }

        ipc.inner
            .last_playback_emit_at_ms
            .store(now_ms, Ordering::Relaxed);
        let seq = ipc.inner.playback_seq.fetch_add(1, Ordering::Relaxed) + 1;

        let payload = PlayerPlaybackEventPayload {
            media_key: ipc.inner.media_key.clone(),
            seq,
            at_ms: now_ms,
            connected: ipc.inner.connected.load(Ordering::SeqCst),
            time_pos_seconds: ipc.inner.time_pos_seconds.lock().ok().and_then(|g| *g),
            duration_seconds: ipc.inner.duration_seconds.lock().ok().and_then(|g| *g),
            paused: ipc.inner.paused.lock().ok().and_then(|g| *g),
        };

        // Best-effort: if the receiver is gone, emitting should not affect playback logic.
        let _ = ipc.inner.playback_event_tx.send(payload);
    }

    fn clamp_volume(value: f64) -> f64 {
        value.clamp(0.0, 130.0)
    }

    fn clamp_brightness(value: f64) -> f64 {
        value.clamp(-100.0, 100.0)
    }

    fn clamp_sub_font_size(value: f64) -> f64 {
        value.clamp(18.0, 80.0)
    }

    fn clamp_sub_border_size(value: f64) -> f64 {
        value.clamp(0.0, 6.0)
    }

    fn clamp_sub_shadow_offset(value: f64) -> f64 {
        value.clamp(0.0, 6.0)
    }

    fn clamp_sub_position(value: f64) -> f64 {
        value.clamp(70.0, 100.0)
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PlaybackInfo {
        time_pos_seconds: Option<f64>,
        duration_seconds: Option<f64>,
        paused: Option<bool>,
    }

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct PlayerPlaybackEventPayload {
        media_key: String,
        seq: u64,
        at_ms: u64,
        connected: bool,
        time_pos_seconds: Option<f64>,
        duration_seconds: Option<f64>,
        paused: Option<bool>,
    }

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct PlayerRenderSettings {
        volume: Option<f64>,
        brightness: Option<f64>,
        subtitle_font_size: Option<f64>,
        subtitle_border_size: Option<f64>,
        subtitle_shadow_offset: Option<f64>,
        subtitle_position: Option<f64>,
    }

    fn mpv_read_render_settings(ipc: &MpvIpc) -> Result<PlayerRenderSettings, String> {
        Ok(PlayerRenderSettings {
            volume: mpv_get_f64_property(ipc, "volume")?,
            brightness: mpv_get_f64_property(ipc, "brightness")?,
            subtitle_font_size: mpv_get_f64_property(ipc, "sub-font-size")?,
            subtitle_border_size: mpv_get_f64_property(ipc, "sub-border-size")?,
            subtitle_shadow_offset: mpv_get_f64_property(ipc, "sub-shadow-offset")?,
            subtitle_position: mpv_get_f64_property(ipc, "sub-pos")?,
        })
    }

    #[tauri::command]
    fn legacy_player_get_playback_info(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
    ) -> Result<PlaybackInfo, String> {
        let ipc = require_ipc_for_media(&player, &app_handle, &media_key)?;
        let mut info = read_cached_playback_info(&ipc);
        if info.time_pos_seconds.is_none()
            && info.duration_seconds.is_none()
            && info.paused.is_none()
        {
            let _ = refresh_ipc_snapshot(&ipc);
            info = read_cached_playback_info(&ipc);
        }
        Ok(info)
    }

    #[tauri::command]
    fn legacy_player_set_pause(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
        pause: bool,
    ) -> Result<(), String> {
        eprintln!(
            "🎬 player_set_pause: START - media_key=\"{}\" pause={}",
            truncate_for_log(&media_key, 140),
            pause
        );
        // Fire-and-forget: if the IPC pipe is under backpressure, waiting (even for a "write ack")
        // makes the UI feel dead and can cascade into reconnect storms. The pause observer will
        // reconcile state shortly after.
        eprintln!("🔍 player_set_pause: calling with_ipc_retry");
        let (ipc, _) = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            let command = json!({ "command": ["set_property", "pause", pause] });
            eprintln!("📤 player_set_pause: sending mpv command: {}", command);
            mpv_send(ipc, command)
        })?;
        eprintln!("✅ player_set_pause: with_ipc_retry completed");
        // Optimistic cache update so the UI can immediately reflect the requested state even if
        // the pause observer event is delayed.
        if let Ok(mut guard) = ipc.inner.paused.lock() {
            *guard = Some(pause);
            eprintln!(
                "💾 player_set_pause: updated optimistic cache to paused={}",
                pause
            );
        } else {
            eprintln!("❌ player_set_pause: failed to update optimistic cache");
        }
        emit_playback_event(&ipc, true);
        eprintln!("🏁 player_set_pause: END");
        Ok(())
    }

    #[tauri::command]
    fn legacy_player_toggle_pause(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
    ) -> Result<(), String> {
        eprintln!(
            "player_toggle_pause media_key=\"{}\"",
            truncate_for_log(&media_key, 140)
        );
        // Same rationale as player_set_pause: don't block on replies for interactive pause toggles.
        let (ipc, _) = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            mpv_send_untracked(ipc, json!({ "command": ["cycle", "pause"] }))
        })?;
        // Best-effort optimistic toggle so the UI doesn't get stuck if pause events are delayed.
        if let Ok(mut guard) = ipc.inner.paused.lock() {
            if let Some(cur) = *guard {
                *guard = Some(!cur);
            }
        }
        emit_playback_event(&ipc, true);
        Ok(())
    }

    #[tauri::command]
    fn legacy_player_seek_relative(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
        delta_seconds: f64,
    ) -> Result<(), String> {
        let (ipc, _) = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            mpv_send(
                ipc,
                json!({ "command": ["seek", delta_seconds, "relative", "exact"] }),
            )
        })?;
        // Best-effort optimistic update for smoother UI while we wait for time-pos updates.
        if let Ok(mut guard) = ipc.inner.time_pos_seconds.lock() {
            if let Some(cur) = *guard {
                *guard = Some((cur + delta_seconds).max(0.0));
            }
        }
        emit_playback_event(&ipc, true);
        Ok(())
    }

    #[tauri::command]
    fn legacy_player_get_render_settings(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
    ) -> Result<PlayerRenderSettings, String> {
        let (_, settings) =
            with_ipc_retry(&player, &app_handle, &media_key, mpv_read_render_settings)?;
        Ok(settings)
    }

    #[tauri::command]
    fn legacy_player_set_volume(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
        volume: f64,
    ) -> Result<f64, String> {
        let (_, next) = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            let next = clamp_volume(volume);
            mpv_set_f64_property(ipc, "volume", next)?;
            Ok(next)
        })?;
        Ok(next)
    }

    #[tauri::command]
    fn legacy_player_adjust_volume(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
        delta: f64,
    ) -> Result<f64, String> {
        let (_, next) = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            let current = mpv_get_f64_property(ipc, "volume")?.unwrap_or(100.0);
            let next = clamp_volume(current + delta);
            mpv_set_f64_property(ipc, "volume", next)?;
            Ok(next)
        })?;
        Ok(next)
    }

    #[tauri::command]
    fn legacy_player_set_brightness(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
        brightness: f64,
    ) -> Result<f64, String> {
        let (_, next) = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            let next = clamp_brightness(brightness);
            mpv_set_f64_property(ipc, "brightness", next)?;
            Ok(next)
        })?;
        Ok(next)
    }

    #[tauri::command]
    fn legacy_player_adjust_brightness(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
        delta: f64,
    ) -> Result<f64, String> {
        let (_, next) = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            let current = mpv_get_f64_property(ipc, "brightness")?.unwrap_or(0.0);
            let next = clamp_brightness(current + delta);
            mpv_set_f64_property(ipc, "brightness", next)?;
            Ok(next)
        })?;
        Ok(next)
    }

    #[tauri::command]
    fn legacy_player_set_subtitle_style(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
        font_size: Option<f64>,
        border_size: Option<f64>,
        shadow_offset: Option<f64>,
        position: Option<f64>,
    ) -> Result<PlayerRenderSettings, String> {
        let (_, settings) = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            if let Some(value) = font_size {
                mpv_set_f64_property(ipc, "sub-font-size", clamp_sub_font_size(value))?;
            }
            if let Some(value) = border_size {
                mpv_set_f64_property(ipc, "sub-border-size", clamp_sub_border_size(value))?;
            }
            if let Some(value) = shadow_offset {
                mpv_set_f64_property(ipc, "sub-shadow-offset", clamp_sub_shadow_offset(value))?;
            }
            if let Some(value) = position {
                mpv_set_f64_property(ipc, "sub-pos", clamp_sub_position(value))?;
            }
            mpv_read_render_settings(ipc)
        })?;
        Ok(settings)
    }

    fn parse_track_list(data: &JsonValue) -> PlayerTracks {
        let Some(list) = data.as_array() else {
            return PlayerTracks {
                audio: Vec::new(),
                subtitles: Vec::new(),
            };
        };

        let mut audio: Vec<PlayerTrack> = Vec::new();
        let mut subtitles: Vec<PlayerTrack> = Vec::new();

        for t in list {
            let Some(ty) = t.get("type").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(id) = t.get("id").and_then(|v| v.as_i64()) else {
                continue;
            };
            let lang = t
                .get("lang")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let title = t
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let codec = t
                .get("codec")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let external = t.get("external").and_then(|v| v.as_bool()).unwrap_or(false);
            let selected = t.get("selected").and_then(|v| v.as_bool()).unwrap_or(false);

            let mut label = title.unwrap_or_else(|| format!("Track {}", id));
            if let Some(c) = codec {
                if !label.to_ascii_lowercase().contains(&c.to_ascii_lowercase()) {
                    label = format!("{} ({})", label, c);
                }
            }
            if external {
                label = format!("{} [ext]", label);
            }

            let out = PlayerTrack {
                id,
                label,
                lang,
                selected,
            };
            match ty {
                "audio" => audio.push(out),
                "sub" => subtitles.push(out),
                _ => {}
            }
        }

        audio.sort_by_key(|t| t.id);
        subtitles.sort_by_key(|t| t.id);

        PlayerTracks { audio, subtitles }
    }

    fn set_cached_tracks(ipc: &MpvIpc, tracks: PlayerTracks) {
        if let Ok(mut guard) = ipc.inner.tracks.lock() {
            *guard = Some(tracks);
        }
    }

    fn refresh_track_cache(ipc: &MpvIpc) -> Result<PlayerTracks, String> {
        let resp = mpv_request(ipc, json!({ "command": ["get_property", "track-list"] }))?;
        mpv_expect_success(&resp)?;
        let tracks = parse_track_list(resp.get("data").unwrap_or(&JsonValue::Null));
        set_cached_tracks(ipc, tracks.clone());
        Ok(tracks)
    }

    fn normalize_media_path(path: &str) -> String {
        let trimmed = path.trim();
        #[cfg(windows)]
        {
            trimmed.replace('/', "\\").to_ascii_lowercase()
        }
        #[cfg(not(windows))]
        {
            trimmed.to_string()
        }
    }

    fn subtitle_track_path(track: &JsonValue) -> Option<&str> {
        [
            "external-filename",
            "external_filename",
            "external-file",
            "external_file",
            "path",
            "demux-filename",
            "demux_filename",
            "ff-index-filename",
            "ff_index_filename",
        ]
        .iter()
        .find_map(|key| track.get(*key).and_then(|value| value.as_str()))
    }

    fn find_external_subtitle_track_id(track_list: &JsonValue, path: &str) -> Option<i64> {
        let target = normalize_media_path(path);
        track_list.as_array()?.iter().find_map(|track| {
            if track.get("type").and_then(|value| value.as_str()) != Some("sub") {
                return None;
            }
            if !track
                .get("external")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                return None;
            }
            let candidate = subtitle_track_path(track)?;
            if normalize_media_path(candidate) == target {
                return track.get("id").and_then(|value| value.as_i64());
            }
            None
        })
    }

    #[tauri::command]
    fn legacy_player_list_tracks(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
    ) -> Result<PlayerTracks, String> {
        let ipc = require_ipc_for_media(&player, &app_handle, &media_key)?;

        // Prefer cache (populated via observe_property on "track-list") to avoid blocking requests.
        if let Ok(guard) = ipc.inner.tracks.lock() {
            if let Some(cached) = guard.as_ref() {
                return Ok(cached.clone());
            }
        }

        // Right after startup / reconnect, mpv typically emits a track-list property-change quickly.
        // Wait briefly so we can use the cached list instead of issuing a blocking get_property request.
        for _ in 0..24 {
            thread::sleep(Duration::from_millis(25));
            if let Ok(guard) = ipc.inner.tracks.lock() {
                if let Some(cached) = guard.as_ref() {
                    return Ok(cached.clone());
                }
            }
        }

        let (_, tracks) = with_ipc_retry(&player, &app_handle, &media_key, refresh_track_cache)?;
        Ok(tracks)
    }

    #[tauri::command]
    fn legacy_player_set_audio_track(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
        track_id: i64,
    ) -> Result<(), String> {
        let _ = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            mpv_send(ipc, json!({ "command": ["set_property", "aid", track_id] }))?;
            let _ = refresh_track_cache(ipc);
            Ok(())
        })?;
        Ok(())
    }

    #[tauri::command]
    fn legacy_player_set_subtitle_track(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        media_key: String,
        track_id: i64,
    ) -> Result<(), String> {
        let _ = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            mpv_send(ipc, json!({ "command": ["set_property", "sid", track_id] }))?;
            let _ = refresh_track_cache(ipc);
            Ok(())
        })?;
        Ok(())
    }

    #[tauri::command]
    fn legacy_player_list_external_subtitles(
        db: tauri::State<AppDb>,
        media_key: String,
    ) -> Result<Vec<String>, String> {
        let conn = db
            .conn
            .lock()
            .map_err(|_| "db mutex poisoned".to_string())?;

        let mut stmt = conn
            .prepare(
                "SELECT path FROM external_subtitles WHERE item_id = ?1 ORDER BY added_at_ms DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![media_key], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }

        Ok(out)
    }

    fn remove_live_external_subtitle(ipc: &MpvIpc, path: &str) -> Result<(), String> {
        let resp = mpv_request(ipc, json!({ "command": ["get_property", "track-list"] }))?;
        mpv_expect_success(&resp)?;
        let track_list = resp.get("data").cloned().unwrap_or(JsonValue::Null);
        let tracks = parse_track_list(&track_list);
        set_cached_tracks(ipc, tracks);

        let Some(track_id) = find_external_subtitle_track_id(&track_list, path) else {
            return Ok(());
        };

        mpv_send(ipc, json!({ "command": ["sub-remove", track_id] }))?;
        let _ = refresh_track_cache(ipc);
        Ok(())
    }

    #[tauri::command]
    fn legacy_player_add_external_subtitle(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        db: tauri::State<AppDb>,
        media_key: String,
        path: String,
    ) -> Result<(), String> {
        let path = path.trim().to_string();
        if path.is_empty() {
            return Err("path is empty".to_string());
        }

        let conn = db
            .conn
            .lock()
            .map_err(|_| "db mutex poisoned".to_string())?;

        let added_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as i64;

        conn
    .execute(
      "INSERT OR IGNORE INTO external_subtitles (item_id, path, added_at_ms) VALUES (?1, ?2, ?3)",
      params![media_key.clone(), path.clone(), added_at_ms],
    )
    .map_err(|e| e.to_string())?;

        let is_current_media = player
            .now_playing
            .lock()
            .ok()
            .and_then(|now| now.clone())
            .as_deref()
            == Some(media_key.as_str());

        // If mpv is currently playing this media key, load the subtitle immediately.
        if is_current_media {
            let _ = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
                mpv_send(
                    ipc,
                    json!({ "command": ["sub-add", path.clone(), "select"] }),
                )?;
                let _ = refresh_track_cache(ipc);
                Ok(())
            });
        }

        Ok(())
    }

    #[tauri::command]
    fn legacy_player_remove_external_subtitle(
        player: tauri::State<PlayerProc>,
        app_handle: tauri::AppHandle,
        db: tauri::State<AppDb>,
        media_key: String,
        path: String,
    ) -> Result<(), String> {
        let path = path.trim().to_string();
        if path.is_empty() {
            return Err("path is empty".to_string());
        }

        {
            let conn = db
                .conn
                .lock()
                .map_err(|_| "db mutex poisoned".to_string())?;

            conn.execute(
                "DELETE FROM external_subtitles WHERE item_id = ?1 AND path = ?2",
                params![media_key.clone(), path.clone()],
            )
            .map_err(|e| e.to_string())?;
        }

        let is_current_media = player
            .now_playing
            .lock()
            .ok()
            .and_then(|now| now.clone())
            .as_deref()
            == Some(media_key.as_str());

        if is_current_media {
            let _ = with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
                remove_live_external_subtitle(ipc, &path)
            });
        }

        Ok(())
    }
} // mod legacy_player_commands

fn is_video_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "mkv" | "mp4" | "avi" | "mov" | "m4v" | "webm" | "ts"
    )
}

fn extract_first_number(s: &str) -> Option<u32> {
    let mut started = false;
    let mut n: u32 = 0;
    let mut found = false;

    for ch in s.chars() {
        if ch.is_ascii_digit() {
            started = true;
            found = true;
            n = n
                .saturating_mul(10)
                .saturating_add((ch as u8 - b'0') as u32);
        } else if started {
            break;
        }
    }

    if found {
        Some(n)
    } else {
        None
    }
}

fn parse_sxe_numbers(name: &str) -> Option<(u32, u32)> {
    let lower = name.to_ascii_lowercase();
    let bytes = lower.as_bytes();

    const MAX_REASONABLE_SEASON: u32 = 100;
    const MAX_REASONABLE_EPISODE: u32 = 10_000;

    for i in 0..bytes.len() {
        if bytes[i] != b's' {
            continue;
        }

        let mut j = i + 1;
        let mut season_digits = 0usize;
        let mut season: u32 = 0;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            season_digits += 1;
            season = season
                .saturating_mul(10)
                .saturating_add((bytes[j] - b'0') as u32);
            j += 1;
        }
        if season_digits == 0 || season == 0 {
            continue;
        }

        let mut k = j;
        while k < bytes.len() && matches!(bytes[k], b' ' | b'.' | b'_' | b'-') {
            k += 1;
        }
        if k >= bytes.len() || bytes[k] != b'e' {
            continue;
        }

        // Support both `S01E02` and `S01EP02`.
        let mut m = k + 1;
        if m < bytes.len() && bytes[m] == b'p' {
            m += 1;
        }
        let mut episode_digits = 0usize;
        let mut episode: u32 = 0;
        while m < bytes.len() && bytes[m].is_ascii_digit() {
            episode_digits += 1;
            episode = episode
                .saturating_mul(10)
                .saturating_add((bytes[m] - b'0') as u32);
            m += 1;
        }

        if episode_digits > 0
            && season > 0
            && episode > 0
            && season <= MAX_REASONABLE_SEASON
            && episode <= MAX_REASONABLE_EPISODE
        {
            return Some((season, episode));
        }
    }

    // Support `1x01` / `01x02` style patterns (avoid resolutions like `1920x1080`).
    for i in 0..bytes.len() {
        if !bytes[i].is_ascii_digit() {
            continue;
        }
        if i > 0 && bytes[i - 1].is_ascii_digit() {
            continue;
        }

        let mut j = i;
        let mut season_digits = 0usize;
        let mut season: u32 = 0;
        while j < bytes.len() && bytes[j].is_ascii_digit() && season_digits < 2 {
            season_digits += 1;
            season = season
                .saturating_mul(10)
                .saturating_add((bytes[j] - b'0') as u32);
            j += 1;
        }
        if season_digits == 0 || season == 0 || season > MAX_REASONABLE_SEASON {
            continue;
        }
        if j >= bytes.len() || bytes[j] != b'x' {
            continue;
        }

        let mut k = j + 1;
        let mut episode_digits = 0usize;
        let mut episode: u32 = 0;
        while k < bytes.len() && bytes[k].is_ascii_digit() && episode_digits < 3 {
            episode_digits += 1;
            episode = episode
                .saturating_mul(10)
                .saturating_add((bytes[k] - b'0') as u32);
            k += 1;
        }
        if episode_digits > 0 && episode > 0 && episode <= MAX_REASONABLE_EPISODE {
            return Some((season, episode));
        }
    }

    None
}

fn parse_season_number(name: &str) -> Option<u32> {
    if let Some((season, _)) = parse_sxe_numbers(name) {
        if season > 0 && season <= 100 {
            return Some(season);
        }
    }

    let lower = name.to_ascii_lowercase();
    // Avoid treating years like 2023 as "season 2023" when episodes live directly in root.
    extract_first_number(&lower).filter(|n| *n > 0 && *n <= 100)
}

fn parse_episode_number(stem: &str) -> Option<u32> {
    if let Some((_, episode)) = parse_sxe_numbers(stem) {
        return Some(episode);
    }

    let lower = stem.to_ascii_lowercase();
    let bytes = lower.as_bytes();

    const MAX_REASONABLE_EPISODE: u32 = 10_000;

    // Support `1x01` style patterns but avoid resolutions like `1920x1080`.
    for i in 0..bytes.len() {
        if !bytes[i].is_ascii_digit() {
            continue;
        }
        if i > 0 && bytes[i - 1].is_ascii_digit() {
            continue;
        }

        let mut j = i;
        let mut season_digits = 0usize;
        let mut season: u32 = 0;
        while j < bytes.len() && bytes[j].is_ascii_digit() && season_digits < 2 {
            season_digits += 1;
            season = season
                .saturating_mul(10)
                .saturating_add((bytes[j] - b'0') as u32);
            j += 1;
        }
        if season_digits == 0 || season == 0 || season > 100 {
            continue;
        }
        if j >= bytes.len() || bytes[j] != b'x' {
            continue;
        }

        let mut k = j + 1;
        while k < bytes.len() && matches!(bytes[k], b' ' | b'.' | b'_' | b'-') {
            k += 1;
        }

        let mut episode_digits = 0usize;
        let mut episode: u32 = 0;
        while k < bytes.len() && bytes[k].is_ascii_digit() && episode_digits < 3 {
            episode_digits += 1;
            episode = episode
                .saturating_mul(10)
                .saturating_add((bytes[k] - b'0') as u32);
            k += 1;
        }
        if episode_digits > 0 && episode > 0 && episode <= MAX_REASONABLE_EPISODE {
            return Some(episode);
        }
    }

    // Support `E01`, `EP01`, `E 01`, `EP-01`, etc (boundary-aware).
    for i in 0..bytes.len() {
        if bytes[i] != b'e' {
            continue;
        }
        if i > 0 && bytes[i - 1].is_ascii_alphanumeric() {
            continue;
        }

        let mut j = i + 1;
        if j < bytes.len() && bytes[j] == b'p' {
            j += 1;
        }
        while j < bytes.len() && matches!(bytes[j], b' ' | b'.' | b'_' | b'-') {
            j += 1;
        }

        let mut episode_digits = 0usize;
        let mut episode: u32 = 0;
        while j < bytes.len() && bytes[j].is_ascii_digit() && episode_digits < 4 {
            episode_digits += 1;
            episode = episode
                .saturating_mul(10)
                .saturating_add((bytes[j] - b'0') as u32);
            j += 1;
        }
        if episode_digits > 0 && episode > 0 && episode <= MAX_REASONABLE_EPISODE {
            return Some(episode);
        }
    }

    if let Some(idx) = lower.find("episode") {
        if let Some(n) = extract_first_number(&lower[idx + "episode".len()..]) {
            if n > 0 {
                return Some(n);
            }
        }
    }

    // `ep` (word-like) fallback.
    if let Some(idx) = lower.find("ep") {
        if idx == 0
            || !lower[..idx]
                .chars()
                .last()
                .unwrap_or(' ')
                .is_ascii_alphanumeric()
        {
            if let Some(n) = extract_first_number(&lower[idx + "ep".len()..]) {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }

    extract_first_number(&lower).filter(|n| *n > 0 && *n < 1000)
}

fn clean_title(stem: &str) -> String {
    let mut out = String::with_capacity(stem.len());
    for ch in stem.chars() {
        if matches!(ch, '.' | '_' | '-') {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn optional_non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn year_from_date(value: Option<&str>) -> String {
    value
        .and_then(|date| date.get(..4))
        .map(str::trim)
        .filter(|year| year.len() == 4 && year.chars().all(|ch| ch.is_ascii_digit()))
        .unwrap_or("")
        .to_string()
}

fn parse_runtime_minutes_text(value: Option<&str>) -> Option<u32> {
    value
        .unwrap_or("")
        .split(|ch: char| !ch.is_ascii_digit())
        .find_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                None
            } else {
                trimmed.parse::<u32>().ok().filter(|minutes| *minutes > 0)
            }
        })
}

fn parse_rating_text(value: Option<&str>) -> Option<f64> {
    value
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|rating| *rating > 0.0)
        .map(|rating| (rating * 10.0).round() / 10.0)
}

fn append_unique_strings(target: &mut Vec<String>, values: impl IntoIterator<Item = String>) {
    for value in values {
        let normalized = value.trim();
        if normalized.is_empty()
            || target
                .iter()
                .any(|entry| entry.eq_ignore_ascii_case(normalized))
        {
            continue;
        }
        target.push(normalized.to_string());
    }
}

fn fallback_non_empty(base: &mut String, fallback: Option<String>) {
    if base.trim().is_empty() {
        if let Some(value) = fallback {
            if !value.trim().is_empty() {
                *base = value;
            }
        }
    }
}

fn fallback_option_string(base: &mut Option<String>, fallback: Option<String>) {
    if base.as_deref().map(str::trim).unwrap_or("").is_empty() {
        *base = fallback.and_then(|value| optional_non_empty(&value));
    }
}

fn fallback_option_u32(base: &mut Option<u32>, fallback: Option<u32>) {
    if base.is_none() {
        *base = fallback;
    }
}

fn fallback_rating(base: &mut f64, fallback: Option<f64>) {
    if *base <= 0.0 {
        if let Some(value) = fallback.filter(|rating| *rating > 0.0) {
            *base = (value * 10.0).round() / 10.0;
        }
    }
}

fn request_json(
    builder: reqwest::blocking::RequestBuilder,
    label: &str,
) -> Result<JsonValue, String> {
    let resp = builder
        .send()
        .map_err(|e| format!("{} request failed: {}", label, e))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!(
            "{} request failed with status {}: {}",
            label, status, body
        ));
    }
    resp.json::<JsonValue>()
        .map_err(|e| format!("{} response parse failed: {}", label, e))
}

fn tmdb_image_url(path: Option<&str>, size: &str) -> String {
    let path = path.unwrap_or("").trim();
    if path.is_empty() {
        String::new()
    } else {
        format!("https://image.tmdb.org/t/p/{}{}", size, path)
    }
}

fn push_api_candidates(base: &Path, out: &mut Vec<PathBuf>) {
    let mut current = Some(base);
    for _ in 0..=4 {
        let Some(path) = current else {
            break;
        };
        out.push(path.join("api.md"));
        current = path.parent();
    }
}

fn api_key_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    push_api_candidates(Path::new(env!("CARGO_MANIFEST_DIR")), &mut candidates);

    if let Ok(current_dir) = std::env::current_dir() {
        push_api_candidates(&current_dir, &mut candidates);
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(dir) = exe_path.parent() {
            push_api_candidates(dir, &mut candidates);
        }
    }

    let mut seen = std::collections::HashSet::new();
    candidates.retain(|path| seen.insert(path.clone()));
    candidates
}

fn parse_api_keys(text: &str) -> ApiKeys {
    let mut keys = ApiKeys::default();

    for raw_line in text.lines() {
        let line = raw_line.trim().trim_end_matches(',');
        let Some((key_raw, value_raw)) = line.split_once(':') else {
            continue;
        };
        let key = key_raw.trim().trim_matches(|ch| ch == '"' || ch == '\'');
        let value = value_raw.trim().trim_matches(|ch| ch == '"' || ch == '\'');
        if value.is_empty() {
            continue;
        }

        match key {
            "TMDB_API_KEY" => keys.tmdb_api_key = Some(value.to_string()),
            "OMDB_API_KEY" => keys.omdb_api_key = Some(value.to_string()),
            "TVDB_API_KEY" => keys.tvdb_api_key = Some(value.to_string()),
            "TRAKT_CLIENT_ID" => keys.trakt_client_id = Some(value.to_string()),
            _ => {}
        }
    }

    keys
}

fn load_api_keys() -> Result<ApiKeys, String> {
    for path in api_key_candidates() {
        if !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;
        let keys = parse_api_keys(&text);
        if keys.tmdb_api_key.is_some()
            || keys.omdb_api_key.is_some()
            || keys.tvdb_api_key.is_some()
            || keys.trakt_client_id.is_some()
        {
            return Ok(keys);
        }
    }

    Err("Could not find usable API keys in api.md".to_string())
}

fn metadata_image_cache_dir(db: &AppDb) -> Result<PathBuf, String> {
    let dir = kv_get(db, METADATA_IMAGE_CACHE_DIR_KEY)?
        .map(PathBuf::from)
        .ok_or("No metadata image folder configured".to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn stable_hash_hex(value: &str) -> String {
    let mut hash: u64 = 14695981039346656037;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(1099511628211);
    }
    format!("{hash:016x}")
}

fn is_remote_http_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

fn sanitize_cache_key(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else {
            out.push('-');
        }
    }

    out.trim_matches('-').to_string()
}

fn find_existing_cache_file(cache_dir: &Path, base_name: &str) -> Option<PathBuf> {
    if base_name.trim().is_empty() {
        return None;
    }

    let exact = cache_dir.join(base_name);
    if exact.is_file() {
        return Some(exact);
    }

    let prefix = format!("{base_name}.");
    std::fs::read_dir(cache_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(|name| name == base_name || name.starts_with(&prefix))
                .unwrap_or(false)
        })
}

fn image_extension_from_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let ext = Path::new(parsed.path())
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())?;

    matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "avif"
    )
    .then_some(ext)
}

fn image_extension_from_content_type(content_type: Option<&str>) -> Option<&'static str> {
    let value = content_type?.trim().to_ascii_lowercase();
    if value.contains("image/jpeg") || value.contains("image/jpg") {
        Some("jpg")
    } else if value.contains("image/png") {
        Some("png")
    } else if value.contains("image/webp") {
        Some("webp")
    } else if value.contains("image/gif") {
        Some("gif")
    } else if value.contains("image/bmp") {
        Some("bmp")
    } else if value.contains("image/avif") {
        Some("avif")
    } else {
        None
    }
}

fn metadata_cache_image_sync(
    db: &AppDb,
    url: String,
    cache_key: Option<String>,
) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("url is empty".to_string());
    }
    if !is_remote_http_url(url) {
        return Err("Only http/https image urls can be cached".to_string());
    }

    if kv_get(db, METADATA_IMAGE_CACHE_DIR_KEY)?.is_none() {
        return Err("No metadata image folder configured".to_string());
    }

    let client = tmdb_client()?;
    let cache_dir = metadata_image_cache_dir(db)?;
    let file_key = stable_hash_hex(url);
    let normalized_cache_key = cache_key
        .as_deref()
        .map(sanitize_cache_key)
        .filter(|value| !value.is_empty());
    let default_ext = image_extension_from_url(url).unwrap_or_else(|| "img".to_string());
    if let Some(key) = normalized_cache_key.as_deref() {
        if let Some(existing) = find_existing_cache_file(&cache_dir, key) {
            return Ok(existing.to_string_lossy().to_string());
        }
    }
    if let Some(existing) = find_existing_cache_file(&cache_dir, &file_key) {
        return Ok(existing.to_string_lossy().to_string());
    }

    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Image download failed: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "Image download failed with status {}: {}",
            status, body
        ));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = response
        .bytes()
        .map_err(|e| format!("Image read failed: {}", e))?;
    if bytes.is_empty() {
        return Err("Image download returned no data".to_string());
    }

    let extension = image_extension_from_content_type(content_type.as_deref())
        .map(str::to_string)
        .or_else(|| image_extension_from_url(url))
        .unwrap_or(default_ext);
    let base_name = normalized_cache_key.unwrap_or(file_key);
    let final_path = cache_dir.join(format!("{}.{}", base_name, extension));

    if !final_path.is_file() {
        std::fs::write(&final_path, &bytes)
            .map_err(|e| format!("failed to write {}: {}", final_path.display(), e))?;
    }

    Ok(final_path.to_string_lossy().to_string())
}

fn tmdb_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

fn tmdb_json(
    client: &Client,
    api_key: &str,
    path: &str,
    extra_params: &[(&str, String)],
) -> Result<JsonValue, String> {
    let mut url = reqwest::Url::parse(&format!("https://api.themoviedb.org/3{}", path))
        .map_err(|e| e.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("api_key", api_key);
        query.append_pair("language", "en-US");
        for (key, value) in extra_params {
            query.append_pair(key, value);
        }
    }

    request_json(client.get(url), "TMDb")
}

fn omdb_json(
    client: &Client,
    api_key: &str,
    extra_params: &[(&str, String)],
) -> Result<JsonValue, String> {
    let mut url = reqwest::Url::parse("https://www.omdbapi.com/").map_err(|e| e.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("apikey", api_key);
        query.append_pair("plot", "full");
        for (key, value) in extra_params {
            query.append_pair(key, value);
        }
    }

    request_json(client.get(url), "OMDb")
}

fn trakt_json(
    client: &Client,
    client_id: &str,
    path: &str,
    extra_params: &[(&str, String)],
) -> Result<JsonValue, String> {
    let mut url =
        reqwest::Url::parse(&format!("https://api.trakt.tv{}", path)).map_err(|e| e.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in extra_params {
            query.append_pair(key, value);
        }
    }

    request_json(
        client
            .get(url)
            .header("trakt-api-version", "2")
            .header("trakt-api-key", client_id)
            .header("Content-Type", "application/json"),
        "Trakt",
    )
}

fn tvdb_login_token(client: &Client, api_key: &str) -> Result<String, String> {
    let payload = request_json(
        client
            .post("https://api4.thetvdb.com/v4/login")
            .json(&json!({ "apikey": api_key })),
        "TVDB login",
    )?;

    payload
        .get("data")
        .and_then(|value| value.get("token"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or("TVDB login did not return a token".to_string())
}

fn tvdb_json(
    client: &Client,
    token: &str,
    path: &str,
    extra_params: &[(&str, String)],
) -> Result<JsonValue, String> {
    let mut url = reqwest::Url::parse(&format!("https://api4.thetvdb.com/v4{}", path))
        .map_err(|e| e.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in extra_params {
            query.append_pair(key, value);
        }
    }

    let payload = request_json(client.get(url).bearer_auth(token), "TVDB")?;
    Ok(payload.get("data").cloned().unwrap_or(JsonValue::Null))
}

fn jikan_json(
    client: &Client,
    path: &str,
    extra_params: &[(&str, String)],
) -> Result<JsonValue, String> {
    let mut url = reqwest::Url::parse(&format!("https://api.jikan.moe/v4{}", path))
        .map_err(|e| e.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in extra_params {
            query.append_pair(key, value);
        }
    }

    request_json(client.get(url), "Jikan")
}

fn tmdb_genre_map(
    client: &Client,
    api_key: &str,
    media_type: &str,
) -> Result<HashMap<u64, String>, String> {
    let payload = tmdb_json(client, api_key, &format!("/genre/{}/list", media_type), &[])?;
    let mut out = HashMap::new();
    for genre in payload
        .get("genres")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
    {
        let Some(id) = genre.get("id").and_then(|value| value.as_u64()) else {
            continue;
        };
        let Some(name) = genre.get("name").and_then(|value| value.as_str()) else {
            continue;
        };
        out.insert(id, name.to_string());
    }
    Ok(out)
}

fn metadata_title(entry: &JsonValue, media_type: &str) -> String {
    entry
        .get(if media_type == "tv" { "name" } else { "title" })
        .and_then(|value| value.as_str())
        .or_else(|| entry.get("title").and_then(|value| value.as_str()))
        .or_else(|| entry.get("name").and_then(|value| value.as_str()))
        .unwrap_or("Untitled")
        .to_string()
}

fn metadata_original_title(entry: &JsonValue, media_type: &str) -> Option<String> {
    optional_non_empty(
        entry
            .get(if media_type == "tv" {
                "original_name"
            } else {
                "original_title"
            })
            .and_then(|value| value.as_str())
            .or_else(|| entry.get("original_title").and_then(|value| value.as_str()))
            .or_else(|| entry.get("original_name").and_then(|value| value.as_str()))
            .unwrap_or(""),
    )
}

fn metadata_year(entry: &JsonValue, media_type: &str) -> String {
    if media_type == "tv" {
        year_from_date(entry.get("first_air_date").and_then(|value| value.as_str()))
    } else {
        year_from_date(entry.get("release_date").and_then(|value| value.as_str()))
    }
}

fn metadata_genres_from_details(entry: &JsonValue) -> Vec<String> {
    entry
        .get("genres")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|genre| {
            genre
                .get("name")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .collect()
}

fn metadata_rating(entry: &JsonValue) -> f64 {
    entry
        .get("vote_average")
        .and_then(|value| value.as_f64())
        .map(|value| (value * 10.0).round() / 10.0)
        .unwrap_or(0.0)
}

fn metadata_runtime_minutes(entry: &JsonValue, media_type: &str) -> Option<u32> {
    if media_type == "movie" {
        return entry
            .get("runtime")
            .and_then(|value| value.as_u64())
            .filter(|value| *value > 0)
            .map(|value| value as u32);
    }

    entry
        .get("episode_run_time")
        .and_then(|value| value.as_array())
        .and_then(|values| values.iter().find_map(|value| value.as_u64()))
        .filter(|value| *value > 0)
        .map(|value| value as u32)
}

fn tmdb_tv_summary(details: &JsonValue) -> MetadataTvInfo {
    let seasons = details
        .get("number_of_seasons")
        .and_then(|value| value.as_u64())
        .map(|value| value as u32)
        .unwrap_or_else(|| {
            details
                .get("seasons")
                .and_then(|value| value.as_array())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|season| {
                            season.get("season_number").and_then(|value| value.as_u64())
                        })
                        .filter(|value| *value > 0)
                        .collect::<std::collections::BTreeSet<_>>()
                        .len() as u32
                })
                .unwrap_or(0)
        });
    let episodes = details
        .get("number_of_episodes")
        .and_then(|value| value.as_u64())
        .map(|value| value as u32)
        .unwrap_or(0);

    MetadataTvInfo {
        seasons,
        episodes,
        episode_list: Vec::new(),
    }
}

fn tmdb_fetch_tv_episode_list(
    client: &Client,
    api_key: &str,
    tmdb_id: u64,
    details: &JsonValue,
) -> Result<(Vec<TvEpisode>, Option<u32>), String> {
    let season_numbers = details
        .get("seasons")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|season| season.get("season_number").and_then(|value| value.as_u64()))
                .map(|value| value as u32)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut duration_minutes = None;
    let mut episode_list = Vec::new();
    for season_number in season_numbers {
        let season_payload = tmdb_json(
            client,
            api_key,
            &format!("/tv/{}/season/{}", tmdb_id, season_number),
            &[],
        )?;

        for episode in season_payload
            .get("episodes")
            .and_then(|value| value.as_array())
            .into_iter()
            .flatten()
        {
            let Some(episode_number) = episode
                .get("episode_number")
                .and_then(|value| value.as_u64())
            else {
                continue;
            };
            let runtime = episode
                .get("runtime")
                .and_then(|value| value.as_u64())
                .filter(|value| *value > 0)
                .map(|value| value as u32);

            if duration_minutes.is_none() && runtime.is_some() {
                duration_minutes = runtime;
            }

            episode_list.push(TvEpisode {
                season: season_number,
                episode: episode_number as u32,
                title: episode
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Episode")
                    .to_string(),
                path: None,
                overview: optional_non_empty(
                    episode
                        .get("overview")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
                runtime_minutes: runtime,
                air_date: optional_non_empty(
                    episode
                        .get("air_date")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
                still_url: optional_non_empty(&tmdb_image_url(
                    episode.get("still_path").and_then(|value| value.as_str()),
                    "w500",
                )),
            });
        }
    }

    episode_list.sort_by(|a, b| a.season.cmp(&b.season).then(a.episode.cmp(&b.episode)));
    Ok((episode_list, duration_minutes))
}

fn metadata_cast(entry: &JsonValue) -> Vec<MetadataCastMember> {
    entry
        .get("credits")
        .and_then(|value| value.get("cast"))
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .take(18)
        .filter_map(|member| {
            let id = member.get("id").and_then(|value| value.as_u64())?;
            let name = member.get("name").and_then(|value| value.as_str())?;
            Some(MetadataCastMember {
                id: id.to_string(),
                name: name.to_string(),
                character: optional_non_empty(
                    member
                        .get("character")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
                profile_url: optional_non_empty(&tmdb_image_url(
                    member.get("profile_path").and_then(|value| value.as_str()),
                    "w185",
                )),
            })
        })
        .collect()
}

fn omdb_lookup_by_imdb_id(
    client: &Client,
    api_key: &str,
    imdb_id: &str,
) -> Result<Option<JsonValue>, String> {
    let payload = omdb_json(client, api_key, &[("i", imdb_id.to_string())])?;
    if payload.get("Response").and_then(|value| value.as_str()) == Some("False") {
        return Ok(None);
    }
    Ok(Some(payload))
}

fn tmdb_find_id_by_external(
    client: &Client,
    api_key: &str,
    external_source: &str,
    external_id: &str,
    media_type: &str,
) -> Result<Option<u64>, String> {
    let payload = tmdb_json(
        client,
        api_key,
        &format!("/find/{}", external_id.trim()),
        &[("external_source", external_source.to_string())],
    )?;
    let list_key = if media_type == "movie" {
        "movie_results"
    } else {
        "tv_results"
    };
    Ok(payload
        .get(list_key)
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .find_map(|entry| entry.get("id").and_then(|value| value.as_u64())))
}

fn omdb_search_results(
    client: &Client,
    keys: &ApiKeys,
    query: &str,
    media_type: &str,
) -> Result<Vec<MetadataSearchResult>, String> {
    let Some(api_key) = keys.omdb_api_key.as_deref() else {
        return Ok(Vec::new());
    };
    let payload = omdb_json(
        client,
        api_key,
        &[
            ("s", query.to_string()),
            (
                "type",
                if media_type == "movie" {
                    "movie".to_string()
                } else {
                    "series".to_string()
                },
            ),
            ("page", "1".to_string()),
        ],
    )?;
    if payload.get("Response").and_then(|value| value.as_str()) == Some("False") {
        return Ok(Vec::new());
    }

    let tmdb_api_key = keys.tmdb_api_key.as_deref();
    let mut results = Vec::new();
    for entry in payload
        .get("Search")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
    {
        let Some(imdb_id) = entry.get("imdbID").and_then(|value| value.as_str()) else {
            continue;
        };
        let mapped_tmdb_id = tmdb_api_key.and_then(|tmdb_key| {
            tmdb_find_id_by_external(client, tmdb_key, "imdb_id", imdb_id, media_type)
                .ok()
                .flatten()
        });

        results.push(MetadataSearchResult {
            provider: METADATA_SOURCE_OMDB.to_string(),
            source: if mapped_tmdb_id.is_some() {
                METADATA_SOURCE_TMDB.to_string()
            } else {
                METADATA_SOURCE_OMDB.to_string()
            },
            source_id: mapped_tmdb_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| imdb_id.to_string()),
            tmdb_id: mapped_tmdb_id,
            title: entry
                .get("Title")
                .and_then(|value| value.as_str())
                .unwrap_or("Untitled")
                .to_string(),
            overview: String::new(),
            poster_url: optional_non_empty(
                entry
                    .get("Poster")
                    .and_then(|value| value.as_str())
                    .unwrap_or(""),
            )
            .unwrap_or_default(),
            backdrop_url: String::new(),
            duration_minutes: None,
            rating: 0.0,
            year: entry
                .get("Year")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            genre: Vec::new(),
            media_type: media_type.to_string(),
        });
    }

    Ok(results)
}

fn trakt_search_results(
    client: &Client,
    client_id: &str,
    media_type: &str,
    query: &str,
) -> Result<Vec<MetadataSearchResult>, String> {
    let trakt_type = if media_type == "movie" {
        "movie"
    } else {
        "show"
    };
    let payload = trakt_json(
        client,
        client_id,
        &format!("/search/{}", trakt_type),
        &[
            ("query", query.to_string()),
            ("limit", "12".to_string()),
            ("extended", "full".to_string()),
        ],
    )?;

    let mut results = Vec::new();
    for entry in payload.as_array().into_iter().flatten() {
        let Some(record) = entry.get(trakt_type) else {
            continue;
        };
        let Some(ids) = record.get("ids") else {
            continue;
        };
        let trakt_id = ids.get("trakt").and_then(|value| value.as_u64());
        let tmdb_id = ids.get("tmdb").and_then(|value| value.as_u64());
        let imdb_id = ids.get("imdb").and_then(|value| value.as_str());
        let tvdb_id = ids.get("tvdb").and_then(|value| value.as_u64());

        let (source, source_id) = if let Some(tmdb_id) = tmdb_id {
            (METADATA_SOURCE_TMDB.to_string(), tmdb_id.to_string())
        } else if media_type == "tv" {
            if let Some(tvdb_id) = tvdb_id {
                (METADATA_SOURCE_TVDB.to_string(), tvdb_id.to_string())
            } else if let Some(imdb_id) = imdb_id {
                (METADATA_SOURCE_OMDB.to_string(), imdb_id.to_string())
            } else if let Some(trakt_id) = trakt_id {
                (METADATA_SOURCE_TRAKT.to_string(), trakt_id.to_string())
            } else {
                continue;
            }
        } else if let Some(imdb_id) = imdb_id {
            (METADATA_SOURCE_OMDB.to_string(), imdb_id.to_string())
        } else if let Some(trakt_id) = trakt_id {
            (METADATA_SOURCE_TRAKT.to_string(), trakt_id.to_string())
        } else {
            continue;
        };

        results.push(MetadataSearchResult {
            provider: METADATA_SOURCE_TRAKT.to_string(),
            source,
            source_id,
            tmdb_id,
            title: record
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("Untitled")
                .to_string(),
            overview: record
                .get("overview")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            poster_url: String::new(),
            backdrop_url: String::new(),
            duration_minutes: record
                .get("runtime")
                .and_then(|value| value.as_u64())
                .map(|value| value as u32),
            rating: record
                .get("rating")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0),
            year: record
                .get("year")
                .and_then(|value| value.as_i64())
                .map(|value| value.to_string())
                .unwrap_or_default(),
            genre: record
                .get("genres")
                .and_then(|value| value.as_array())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            media_type: media_type.to_string(),
        });
    }

    Ok(results)
}

fn tvdb_search_results(
    client: &Client,
    api_key: &str,
    query: &str,
) -> Result<Vec<MetadataSearchResult>, String> {
    let token = tvdb_login_token(client, api_key)?;
    let payload = tvdb_json(
        client,
        &token,
        "/search",
        &[("query", query.to_string()), ("type", "series".to_string())],
    )?;

    let mut results = Vec::new();
    for entry in payload.as_array().into_iter().flatten() {
        let Some(tvdb_id) = tvdb_lookup_id(entry) else {
            continue;
        };
        results.push(MetadataSearchResult {
            provider: METADATA_SOURCE_TVDB.to_string(),
            source: METADATA_SOURCE_TVDB.to_string(),
            source_id: tvdb_id.to_string(),
            tmdb_id: None,
            title: entry
                .get("name")
                .and_then(|value| value.as_str())
                .or_else(|| entry.get("title").and_then(|value| value.as_str()))
                .unwrap_or("Untitled")
                .to_string(),
            overview: entry
                .get("overview")
                .and_then(|value| value.as_str())
                .or_else(|| entry.get("summary").and_then(|value| value.as_str()))
                .unwrap_or("")
                .to_string(),
            poster_url: optional_non_empty(
                entry
                    .get("image_url")
                    .and_then(|value| value.as_str())
                    .or_else(|| entry.get("image").and_then(|value| value.as_str()))
                    .unwrap_or(""),
            )
            .unwrap_or_default(),
            backdrop_url: String::new(),
            duration_minutes: None,
            rating: 0.0,
            year: year_from_date(
                entry
                    .get("firstAired")
                    .and_then(|value| value.as_str())
                    .or_else(|| entry.get("year").and_then(|value| value.as_str())),
            ),
            genre: Vec::new(),
            media_type: "tv".to_string(),
        });
    }

    Ok(results)
}

fn trakt_fetch_details_by_id(
    client: &Client,
    client_id: &str,
    media_type: &str,
    trakt_id: u64,
) -> Result<JsonValue, String> {
    let path = if media_type == "movie" {
        format!("/movies/{}", trakt_id)
    } else {
        format!("/shows/{}", trakt_id)
    };
    trakt_json(
        client,
        client_id,
        &path,
        &[("extended", "full".to_string())],
    )
}

fn tvdb_fetch_details_by_id(
    client: &Client,
    api_key: &str,
    media_type: &str,
    tvdb_id: u64,
) -> Result<(JsonValue, Vec<TvEpisode>), String> {
    let token = tvdb_login_token(client, api_key)?;
    let details = if media_type == "movie" {
        tvdb_json(
            client,
            &token,
            &format!("/movies/{}/extended", tvdb_id),
            &[],
        )?
    } else {
        tvdb_json(
            client,
            &token,
            &format!("/series/{}/extended", tvdb_id),
            &[],
        )?
    };
    let episodes = if media_type == "tv" {
        tvdb_fetch_series_episodes(client, &token, tvdb_id).unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok((details, episodes))
}

fn metadata_details_from_omdb(
    client: &Client,
    keys: &ApiKeys,
    imdb_id: &str,
    media_type: &str,
) -> Result<MetadataDetails, String> {
    if let Some(tmdb_key) = keys.tmdb_api_key.as_deref() {
        if let Ok(Some(tmdb_id)) =
            tmdb_find_id_by_external(client, tmdb_key, "imdb_id", imdb_id, media_type)
        {
            if let Ok(details) = metadata_get_details_sync(
                tmdb_id.to_string(),
                METADATA_SOURCE_TMDB.to_string(),
                media_type.to_string(),
            ) {
                return Ok(details);
            }
        }
    }

    let omdb = omdb_lookup_by_imdb_id(
        client,
        keys.omdb_api_key
            .as_deref()
            .ok_or("OMDB_API_KEY is missing in api.md".to_string())?,
        imdb_id,
    )?
    .ok_or("OMDb did not return a matching title".to_string())?;

    let title = omdb
        .get("Title")
        .and_then(|value| value.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let mut tvdb_id = None;
    let mut trakt_id = None;
    let mut status = None;
    let mut episode_list = Vec::new();
    let mut seasons = None;
    let mut backdrop_url = String::new();

    if media_type == "tv" {
        seasons = omdb
            .get("totalSeasons")
            .and_then(|value| value.as_str())
            .and_then(|value| value.parse::<u32>().ok());

        if let Some(tvdb_api_key) = keys.tvdb_api_key.as_deref() {
            if let Ok(Some((resolved_tvdb_id, tvdb_details, tvdb_episodes))) = tvdb_fetch_details(
                client,
                tvdb_api_key,
                media_type,
                None,
                Some(imdb_id),
                &title,
            ) {
                tvdb_id = Some(resolved_tvdb_id);
                episode_list = tvdb_episodes;
                backdrop_url =
                    tvdb_pick_artwork(&tvdb_details, &["background", "banner", "fanart"])
                        .unwrap_or_default();
                status = optional_non_empty(
                    tvdb_details
                        .get("status")
                        .and_then(|value| value.get("name"))
                        .and_then(|value| value.as_str())
                        .or_else(|| tvdb_details.get("status").and_then(|value| value.as_str()))
                        .unwrap_or(""),
                );
            }
        }
    }

    if media_type == "tv" {
        if let Some(trakt_client_id) = keys.trakt_client_id.as_deref() {
            if let Ok(Some((resolved_trakt_id, trakt))) =
                trakt_fetch_details(client, trakt_client_id, media_type, None, Some(imdb_id))
            {
                trakt_id = Some(resolved_trakt_id);
                if status.is_none() {
                    status = optional_non_empty(
                        trakt
                            .get("status")
                            .and_then(|value| value.as_str())
                            .unwrap_or(""),
                    );
                }
            }
        }
    }

    let poster_url = optional_non_empty(
        omdb.get("Poster")
            .and_then(|value| value.as_str())
            .unwrap_or(""),
    )
    .unwrap_or_default();
    if backdrop_url.trim().is_empty() {
        backdrop_url = poster_url.clone();
    }

    let year = omdb
        .get("Year")
        .and_then(|value| value.as_str())
        .and_then(|value| value.get(..4))
        .unwrap_or("")
        .to_string();

    Ok(MetadataDetails {
        source: METADATA_SOURCE_OMDB.to_string(),
        source_id: imdb_id.to_string(),
        tmdb_id: None,
        imdb_id: Some(imdb_id.to_string()),
        tvdb_id,
        trakt_id,
        mal_id: None,
        title,
        original_title: None,
        overview: omdb
            .get("Plot")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        tagline: None,
        poster_url,
        backdrop_url,
        duration_minutes: parse_runtime_minutes_text(
            omdb.get("Runtime").and_then(|value| value.as_str()),
        ),
        rating: parse_rating_text(omdb.get("imdbRating").and_then(|value| value.as_str()))
            .unwrap_or(0.0),
        year,
        genre: omdb
            .get("Genre")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .split(',')
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect(),
        media_type: media_type.to_string(),
        cast: omdb
            .get("Actors")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .enumerate()
            .map(|(index, value)| MetadataCastMember {
                id: format!("omdb:{}:{}", index, value),
                name: value.to_string(),
                character: None,
                profile_url: None,
            })
            .collect(),
        status,
        tv: if media_type == "tv" {
            Some(MetadataTvInfo {
                seasons: seasons.unwrap_or_else(|| {
                    episode_list
                        .iter()
                        .map(|episode| episode.season)
                        .collect::<std::collections::BTreeSet<_>>()
                        .len() as u32
                }),
                episodes: if episode_list.is_empty() {
                    0
                } else {
                    episode_list.len() as u32
                },
                episode_list,
            })
        } else {
            None
        },
    })
}

fn metadata_details_from_trakt(
    client: &Client,
    keys: &ApiKeys,
    trakt_id: u64,
    media_type: &str,
) -> Result<MetadataDetails, String> {
    let trakt = trakt_fetch_details_by_id(
        client,
        keys.trakt_client_id
            .as_deref()
            .ok_or("TRAKT_CLIENT_ID is missing in api.md".to_string())?,
        media_type,
        trakt_id,
    )?;

    let ids = trakt.get("ids").cloned().unwrap_or(JsonValue::Null);
    if let Some(tmdb_id) = ids.get("tmdb").and_then(|value| value.as_u64()) {
        if let Ok(details) = metadata_get_details_sync(
            tmdb_id.to_string(),
            METADATA_SOURCE_TMDB.to_string(),
            media_type.to_string(),
        ) {
            return Ok(details);
        }
    }
    if let Some(imdb_id) = ids.get("imdb").and_then(|value| value.as_str()) {
        if let Ok(details) = metadata_details_from_omdb(client, keys, imdb_id, media_type) {
            return Ok(details);
        }
    }
    if media_type == "tv" {
        if let Some(tvdb_id) = ids.get("tvdb").and_then(|value| value.as_u64()) {
            if let Ok(details) = metadata_get_details_sync(
                tvdb_id.to_string(),
                METADATA_SOURCE_TVDB.to_string(),
                media_type.to_string(),
            ) {
                return Ok(details);
            }
        }
    }

    Ok(MetadataDetails {
        source: METADATA_SOURCE_TRAKT.to_string(),
        source_id: trakt_id.to_string(),
        tmdb_id: None,
        imdb_id: ids
            .get("imdb")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        tvdb_id: ids.get("tvdb").and_then(|value| value.as_u64()),
        trakt_id: Some(trakt_id),
        mal_id: None,
        title: trakt
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("Untitled")
            .to_string(),
        original_title: None,
        overview: trakt
            .get("overview")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        tagline: optional_non_empty(
            trakt
                .get("tagline")
                .and_then(|value| value.as_str())
                .unwrap_or(""),
        ),
        poster_url: String::new(),
        backdrop_url: String::new(),
        duration_minutes: trakt
            .get("runtime")
            .and_then(|value| value.as_u64())
            .map(|value| value as u32),
        rating: trakt
            .get("rating")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0),
        year: trakt
            .get("year")
            .and_then(|value| value.as_i64())
            .map(|value| value.to_string())
            .unwrap_or_default(),
        genre: trakt
            .get("genres")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        media_type: media_type.to_string(),
        cast: Vec::new(),
        status: optional_non_empty(
            trakt
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or(""),
        ),
        tv: None,
    })
}

fn metadata_details_from_tvdb(
    client: &Client,
    keys: &ApiKeys,
    tvdb_id: u64,
    media_type: &str,
) -> Result<MetadataDetails, String> {
    let (details, episode_list) = tvdb_fetch_details_by_id(
        client,
        keys.tvdb_api_key
            .as_deref()
            .ok_or("TVDB_API_KEY is missing in api.md".to_string())?,
        media_type,
        tvdb_id,
    )?;

    Ok(MetadataDetails {
        source: METADATA_SOURCE_TVDB.to_string(),
        source_id: tvdb_id.to_string(),
        tmdb_id: None,
        imdb_id: None,
        tvdb_id: Some(tvdb_id),
        trakt_id: None,
        mal_id: None,
        title: details
            .get("name")
            .and_then(|value| value.as_str())
            .or_else(|| details.get("title").and_then(|value| value.as_str()))
            .unwrap_or("Untitled")
            .to_string(),
        original_title: optional_non_empty(
            details
                .get("originalName")
                .and_then(|value| value.as_str())
                .unwrap_or(""),
        ),
        overview: details
            .get("overview")
            .and_then(|value| value.as_str())
            .or_else(|| details.get("summary").and_then(|value| value.as_str()))
            .unwrap_or("")
            .to_string(),
        tagline: None,
        poster_url: tvdb_pick_artwork(&details, &["poster"]).unwrap_or_else(|| {
            optional_non_empty(
                details
                    .get("image")
                    .and_then(|value| value.as_str())
                    .unwrap_or(""),
            )
            .unwrap_or_default()
        }),
        backdrop_url: tvdb_pick_artwork(&details, &["background", "banner", "fanart"])
            .unwrap_or_default(),
        duration_minutes: tvdb_value_u64(details.get("runtime")).map(|value| value as u32),
        rating: 0.0,
        year: year_from_date(
            details
                .get("firstAired")
                .and_then(|value| value.as_str())
                .or_else(|| details.get("year").and_then(|value| value.as_str())),
        ),
        genre: details
            .get("genres")
            .and_then(|value| value.as_array())
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                entry
                    .get("name")
                    .and_then(|value| value.as_str())
                    .or_else(|| entry.as_str())
                    .map(str::to_string)
            })
            .collect(),
        media_type: media_type.to_string(),
        cast: tvdb_cast(&details),
        status: optional_non_empty(
            details
                .get("status")
                .and_then(|value| value.get("name"))
                .and_then(|value| value.as_str())
                .or_else(|| details.get("status").and_then(|value| value.as_str()))
                .unwrap_or(""),
        ),
        tv: if media_type == "tv" {
            Some(MetadataTvInfo {
                seasons: episode_list
                    .iter()
                    .map(|episode| episode.season)
                    .collect::<std::collections::BTreeSet<_>>()
                    .len() as u32,
                episodes: episode_list.len() as u32,
                episode_list,
            })
        } else {
            None
        },
    })
}

fn trakt_lookup_id(
    client: &Client,
    client_id: &str,
    media_type: &str,
    tmdb_id: Option<u64>,
    imdb_id: Option<&str>,
) -> Result<Option<u64>, String> {
    let trakt_type = if media_type == "movie" {
        "movie"
    } else {
        "show"
    };
    let payload = if let Some(imdb_id) = imdb_id.filter(|value| !value.trim().is_empty()) {
        trakt_json(
            client,
            client_id,
            &format!("/search/imdb/{}", imdb_id),
            &[("type", trakt_type.to_string())],
        )?
    } else if let Some(tmdb_id) = tmdb_id {
        trakt_json(
            client,
            client_id,
            &format!("/search/tmdb/{}", tmdb_id),
            &[("type", trakt_type.to_string())],
        )?
    } else {
        return Ok(None);
    };

    Ok(payload.as_array().into_iter().flatten().find_map(|entry| {
        entry
            .get(trakt_type)
            .and_then(|value| value.get("ids"))
            .and_then(|value| value.get("trakt"))
            .and_then(|value| value.as_u64())
    }))
}

fn trakt_fetch_details(
    client: &Client,
    client_id: &str,
    media_type: &str,
    tmdb_id: Option<u64>,
    imdb_id: Option<&str>,
) -> Result<Option<(u64, JsonValue)>, String> {
    let Some(trakt_id) = trakt_lookup_id(client, client_id, media_type, tmdb_id, imdb_id)? else {
        return Ok(None);
    };

    let path = if media_type == "movie" {
        format!("/movies/{}", trakt_id)
    } else {
        format!("/shows/{}", trakt_id)
    };

    let details = trakt_json(
        client,
        client_id,
        &path,
        &[("extended", "full".to_string())],
    )?;
    Ok(Some((trakt_id, details)))
}

fn tvdb_value_u64(value: Option<&JsonValue>) -> Option<u64> {
    value.and_then(|entry| {
        entry
            .as_u64()
            .or_else(|| entry.as_i64().filter(|raw| *raw >= 0).map(|raw| raw as u64))
            .or_else(|| {
                entry
                    .as_str()
                    .and_then(|raw| raw.trim().parse::<u64>().ok())
            })
    })
}

fn tvdb_lookup_id(entry: &JsonValue) -> Option<u64> {
    tvdb_value_u64(entry.get("tvdb_id"))
        .or_else(|| tvdb_value_u64(entry.get("tvdbId")))
        .or_else(|| tvdb_value_u64(entry.get("id")))
}

fn tvdb_pick_artwork(entry: &JsonValue, kind_fragments: &[&str]) -> Option<String> {
    entry
        .get("artworks")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .find_map(|art| {
            let kind = art
                .get("type")
                .and_then(|value| value.as_str())
                .or_else(|| {
                    art.get("type")
                        .and_then(|value| value.get("name"))
                        .and_then(|value| value.as_str())
                })
                .unwrap_or("")
                .to_ascii_lowercase();
            if kind_fragments
                .iter()
                .any(|fragment| kind.contains(fragment))
            {
                optional_non_empty(
                    art.get("image")
                        .and_then(|value| value.as_str())
                        .or_else(|| art.get("image_url").and_then(|value| value.as_str()))
                        .unwrap_or(""),
                )
            } else {
                None
            }
        })
}

fn tvdb_cast(entry: &JsonValue) -> Vec<MetadataCastMember> {
    entry
        .get("characters")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .take(18)
        .filter_map(|member| {
            let name = member
                .get("personName")
                .and_then(|value| value.as_str())
                .or_else(|| member.get("name").and_then(|value| value.as_str()))?;
            let id = tvdb_value_u64(member.get("id"))
                .or_else(|| tvdb_value_u64(member.get("peopleId")))
                .map(|value| value.to_string())
                .unwrap_or_else(|| format!("tvdb:{}", name));

            Some(MetadataCastMember {
                id,
                name: name.to_string(),
                character: optional_non_empty(
                    member
                        .get("name")
                        .and_then(|value| value.as_str())
                        .or_else(|| member.get("character").and_then(|value| value.as_str()))
                        .unwrap_or(""),
                ),
                profile_url: optional_non_empty(
                    member
                        .get("image")
                        .and_then(|value| value.as_str())
                        .or_else(|| member.get("image_url").and_then(|value| value.as_str()))
                        .unwrap_or(""),
                ),
            })
        })
        .collect()
}

fn tvdb_fetch_series_episodes(
    client: &Client,
    token: &str,
    series_id: u64,
) -> Result<Vec<TvEpisode>, String> {
    let mut episodes = Vec::new();
    for page in 0..50 {
        let payload = tvdb_json(
            client,
            token,
            &format!("/series/{}/episodes/default", series_id),
            &[("page", page.to_string())],
        )?;

        let page_entries = payload
            .get("episodes")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        let page_len = page_entries.len();

        if page_entries.is_empty() {
            break;
        }

        for episode in page_entries {
            let Some(episode_number) = tvdb_value_u64(episode.get("number"))
                .or_else(|| tvdb_value_u64(episode.get("airedNumber")))
            else {
                continue;
            };
            let season = tvdb_value_u64(episode.get("seasonNumber")).unwrap_or(1) as u32;
            episodes.push(TvEpisode {
                season,
                episode: episode_number as u32,
                title: episode
                    .get("name")
                    .and_then(|value| value.as_str())
                    .or_else(|| episode.get("title").and_then(|value| value.as_str()))
                    .unwrap_or("Episode")
                    .to_string(),
                path: None,
                overview: optional_non_empty(
                    episode
                        .get("overview")
                        .and_then(|value| value.as_str())
                        .or_else(|| episode.get("summary").and_then(|value| value.as_str()))
                        .unwrap_or(""),
                ),
                runtime_minutes: tvdb_value_u64(episode.get("runtime")).map(|value| value as u32),
                air_date: optional_non_empty(
                    episode
                        .get("aired")
                        .and_then(|value| value.as_str())
                        .or_else(|| episode.get("airDate").and_then(|value| value.as_str()))
                        .unwrap_or(""),
                ),
                still_url: optional_non_empty(
                    episode
                        .get("image")
                        .and_then(|value| value.as_str())
                        .or_else(|| episode.get("image_url").and_then(|value| value.as_str()))
                        .unwrap_or(""),
                ),
            });
        }

        if page_len < 100 {
            break;
        }
    }

    episodes.sort_by(|a, b| a.season.cmp(&b.season).then(a.episode.cmp(&b.episode)));
    Ok(episodes)
}

fn tvdb_fetch_details(
    client: &Client,
    api_key: &str,
    media_type: &str,
    tmdb_id: Option<u64>,
    imdb_id: Option<&str>,
    title: &str,
) -> Result<Option<(u64, JsonValue, Vec<TvEpisode>)>, String> {
    let token = tvdb_login_token(client, api_key)?;
    let mut match_entry = None;

    if let Some(remote_id) = imdb_id
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| tmdb_id.map(|value| value.to_string()))
    {
        if let Ok(payload) = tvdb_json(
            client,
            &token,
            &format!("/search/remoteid/{}", remote_id),
            &[],
        ) {
            match_entry = payload
                .as_array()
                .into_iter()
                .flatten()
                .find(|entry| {
                    let kind = entry
                        .get("type")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if media_type == "movie" {
                        kind.contains("movie")
                    } else {
                        kind.contains("series")
                    }
                })
                .cloned();
        }
    }

    if match_entry.is_none() {
        let search_kind = if media_type == "movie" {
            "movie"
        } else {
            "series"
        };
        let payload = tvdb_json(
            client,
            &token,
            "/search",
            &[
                ("query", title.to_string()),
                ("type", search_kind.to_string()),
            ],
        )?;
        match_entry = payload
            .as_array()
            .into_iter()
            .flatten()
            .find(|entry| {
                let kind = entry
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if media_type == "movie" {
                    kind.contains("movie")
                } else {
                    kind.contains("series")
                }
            })
            .cloned();
    }

    let Some(match_entry) = match_entry else {
        return Ok(None);
    };
    let Some(tvdb_id) = tvdb_lookup_id(&match_entry) else {
        return Ok(None);
    };

    let details = if media_type == "movie" {
        tvdb_json(
            client,
            &token,
            &format!("/movies/{}/extended", tvdb_id),
            &[],
        )?
    } else {
        tvdb_json(
            client,
            &token,
            &format!("/series/{}/extended", tvdb_id),
            &[],
        )?
    };

    let episodes = if media_type == "tv" {
        tvdb_fetch_series_episodes(client, &token, tvdb_id).unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(Some((tvdb_id, details, episodes)))
}

fn jikan_image_url(entry: &JsonValue) -> String {
    optional_non_empty(
        entry
            .get("images")
            .and_then(|value| value.get("webp"))
            .and_then(|value| value.get("large_image_url"))
            .and_then(|value| value.as_str())
            .or_else(|| {
                entry
                    .get("images")
                    .and_then(|value| value.get("jpg"))
                    .and_then(|value| value.get("large_image_url"))
                    .and_then(|value| value.as_str())
            })
            .or_else(|| {
                entry
                    .get("images")
                    .and_then(|value| value.get("webp"))
                    .and_then(|value| value.get("image_url"))
                    .and_then(|value| value.as_str())
            })
            .or_else(|| {
                entry
                    .get("images")
                    .and_then(|value| value.get("jpg"))
                    .and_then(|value| value.get("image_url"))
                    .and_then(|value| value.as_str())
            })
            .unwrap_or(""),
    )
    .unwrap_or_default()
}

fn jikan_backdrop_url(entry: &JsonValue) -> String {
    optional_non_empty(
        entry
            .get("trailer")
            .and_then(|value| value.get("images"))
            .and_then(|value| value.get("maximum_image_url"))
            .and_then(|value| value.as_str())
            .or_else(|| {
                entry
                    .get("trailer")
                    .and_then(|value| value.get("images"))
                    .and_then(|value| value.get("large_image_url"))
                    .and_then(|value| value.as_str())
            })
            .unwrap_or(""),
    )
    .unwrap_or_else(|| jikan_image_url(entry))
}

fn jikan_media_type(entry: &JsonValue) -> String {
    match entry
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "movie" => "movie".to_string(),
        _ => "tv".to_string(),
    }
}

fn jikan_genres(entry: &JsonValue) -> Vec<String> {
    let mut genres = Vec::new();
    for key in ["genres", "themes", "demographics", "explicit_genres"] {
        append_unique_strings(
            &mut genres,
            entry
                .get(key)
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .filter_map(|genre| {
                    genre
                        .get("name")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                }),
        );
    }
    append_unique_strings(&mut genres, ["Anime".to_string()]);
    genres
}

fn jikan_fetch_cast(client: &Client, mal_id: u64) -> Result<Vec<MetadataCastMember>, String> {
    let payload = jikan_json(client, &format!("/anime/{}/characters", mal_id), &[])?;
    Ok(payload
        .get("data")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .take(18)
        .filter_map(|entry| {
            let character = entry.get("character")?;
            let name = character.get("name").and_then(|value| value.as_str())?;
            let id = tvdb_value_u64(character.get("mal_id")).map(|value| value.to_string())?;
            Some(MetadataCastMember {
                id,
                name: name.to_string(),
                character: optional_non_empty(
                    entry
                        .get("role")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
                profile_url: optional_non_empty(
                    character
                        .get("images")
                        .and_then(|value| value.get("jpg"))
                        .and_then(|value| value.get("image_url"))
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
            })
        })
        .collect())
}

fn jikan_fetch_episodes(client: &Client, mal_id: u64) -> Result<Vec<TvEpisode>, String> {
    let mut episodes = Vec::new();
    for page in 1..=40 {
        let payload = jikan_json(
            client,
            &format!("/anime/{}/episodes", mal_id),
            &[("page", page.to_string())],
        )?;
        let page_entries = payload
            .get("data")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();

        if page_entries.is_empty() {
            break;
        }

        for episode in page_entries {
            let Some(number) = tvdb_value_u64(episode.get("mal_id"))
                .or_else(|| tvdb_value_u64(episode.get("episode_id")))
                .or_else(|| tvdb_value_u64(episode.get("episode")))
            else {
                continue;
            };

            episodes.push(TvEpisode {
                season: 1,
                episode: number as u32,
                title: episode
                    .get("title")
                    .and_then(|value| value.as_str())
                    .or_else(|| {
                        episode
                            .get("title_romanji")
                            .and_then(|value| value.as_str())
                    })
                    .or_else(|| {
                        episode
                            .get("title_japanese")
                            .and_then(|value| value.as_str())
                    })
                    .unwrap_or("Episode")
                    .to_string(),
                path: None,
                overview: optional_non_empty(
                    episode
                        .get("synopsis")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
                runtime_minutes: parse_runtime_minutes_text(
                    episode.get("duration").and_then(|value| value.as_str()),
                ),
                air_date: optional_non_empty(
                    episode
                        .get("aired")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
                still_url: optional_non_empty(
                    episode
                        .get("images")
                        .and_then(|value| value.get("jpg"))
                        .and_then(|value| value.get("image_url"))
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
            });
        }

        let has_next = payload
            .get("pagination")
            .and_then(|value| value.get("has_next_page"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if !has_next {
            break;
        }
    }

    episodes.sort_by(|a, b| a.episode.cmp(&b.episode));
    Ok(episodes)
}

fn hhaven_token(client: &Client) -> Result<String, String> {
    let body = [
        ("sdkInt", "33"),
        ("board", "goldfish_x86_64"),
        ("brand", "google"),
        (
            "display",
            "sdk_gphone_x86_64-userdebug 13 TE1A.220922.028 10190541 dev-keys",
        ),
        (
            "fingerprint",
            "google/sdk_gphone_x86_64/emu64xa:13/TE1A.220922.028/10190541:userdebug/dev-keys",
        ),
        ("manufacturer", "Google"),
        ("model", "sdk_gphone_x86_64"),
    ]
    .into_iter()
    .map(|(key, value)| {
        format!(
            "{}={}",
            key,
            value
                .replace(' ', "+")
                .replace('/', "%2F")
                .replace(':', "%3A")
        )
    })
    .collect::<Vec<_>>()
    .join("&");

    let payload = request_json(
        client
            .post("https://api.hentaihaven.app/v1/warden")
            .header(
                "content-type",
                "application/x-www-form-urlencoded; charset=utf-8",
            )
            .header("user-agent", "HH_xxx_APP")
            .header("warden", "")
            .body(body),
        "Hentai Haven token",
    )?;

    payload
        .get("data")
        .and_then(|value| value.get("token"))
        .and_then(|value| value.as_str())
        .and_then(optional_non_empty)
        .ok_or_else(|| "Hentai Haven token response did not include a token".to_string())
}

fn hhaven_json(client: &Client, token: &str, path: &str) -> Result<JsonValue, String> {
    request_json(
        client
            .get(format!("https://api.hentaihaven.app/v1/{}", path))
            .header(
                "content-type",
                "application/x-www-form-urlencoded; charset=utf-8",
            )
            .header("user-agent", "HH_xxx_APP")
            .header("warden", token),
        "Hentai Haven",
    )
}

fn json_string_or_number(value: Option<&JsonValue>) -> String {
    match value {
        Some(JsonValue::String(text)) => text.clone(),
        Some(JsonValue::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn json_f64(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(number)) => number.as_f64(),
        Some(JsonValue::String(text)) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn hhaven_genres(details: &JsonValue) -> Vec<String> {
    details
        .get("post_genres")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| entry.get("name").and_then(|value| value.as_str()))
                .filter_map(optional_non_empty)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn hhaven_episode_items(details: &JsonValue) -> Vec<JsonValue> {
    match details.get("post_episodes") {
        Some(JsonValue::Array(items)) => items.clone(),
        Some(JsonValue::Object(_)) => vec![details
            .get("post_episodes")
            .cloned()
            .unwrap_or(JsonValue::Null)],
        _ => Vec::new(),
    }
}

fn hhaven_episode_number(entry: &JsonValue, fallback: u32) -> u32 {
    entry
        .get("chapter_name")
        .and_then(|value| value.as_str())
        .and_then(parse_episode_number)
        .or_else(|| {
            entry
                .get("chapter_slug")
                .and_then(|value| value.as_str())
                .and_then(parse_episode_number)
        })
        .or_else(|| {
            entry
                .get("data_slug")
                .and_then(|value| value.as_str())
                .and_then(parse_episode_number)
        })
        .unwrap_or(fallback)
}

fn hhaven_details_from_payload(source_id: &str, details: &JsonValue) -> MetadataDetails {
    let title = details
        .get("post_title")
        .and_then(|value| value.as_str())
        .and_then(optional_non_empty)
        .unwrap_or_else(|| "Untitled Hentai".to_string());
    let overview = details
        .get("post_content")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let poster_url = details
        .get("post_thumbnail")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let year = year_from_date(details.get("post_date").and_then(|value| value.as_str()));
    let rating = json_f64(
        details
            .get("post_rating")
            .and_then(|value| value.get("rating")),
    )
    .unwrap_or(0.0);
    let episodes = hhaven_episode_items(details);
    let episode_list = episodes
        .iter()
        .enumerate()
        .map(|(index, episode)| {
            let episode_number = hhaven_episode_number(episode, index as u32 + 1);
            TvEpisode {
                season: 1,
                episode: episode_number,
                title: episode
                    .get("chapter_name")
                    .and_then(|value| value.as_str())
                    .and_then(optional_non_empty)
                    .unwrap_or_else(|| format!("Episode {}", episode_number)),
                path: None,
                overview: None,
                runtime_minutes: None,
                air_date: optional_non_empty(
                    episode
                        .get("chapter_date")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
                still_url: optional_non_empty(
                    episode
                        .get("chapter_thumbnail")
                        .and_then(|value| value.as_str())
                        .or_else(|| {
                            episode
                                .get("post_thumbnail")
                                .and_then(|value| value.as_str())
                        })
                        .unwrap_or(""),
                ),
            }
        })
        .collect::<Vec<_>>();

    MetadataDetails {
        source: METADATA_SOURCE_HHAVEN.to_string(),
        source_id: source_id.to_string(),
        tmdb_id: None,
        imdb_id: None,
        tvdb_id: None,
        trakt_id: None,
        mal_id: None,
        title,
        original_title: optional_non_empty(
            details
                .get("post_title_alternative")
                .and_then(|value| value.as_str())
                .unwrap_or(""),
        ),
        overview,
        tagline: None,
        poster_url: poster_url.clone(),
        backdrop_url: episode_list
            .first()
            .and_then(|episode| episode.still_url.clone())
            .unwrap_or_else(|| poster_url.clone()),
        duration_minutes: None,
        rating,
        year,
        genre: hhaven_genres(details),
        media_type: "tv".to_string(),
        cast: Vec::new(),
        status: Some("Released".to_string()),
        tv: Some(MetadataTvInfo {
            seasons: if episode_list.is_empty() { 0 } else { 1 },
            episodes: episode_list.len() as u32,
            episode_list,
        }),
    }
}

fn hhaven_search_results(
    client: &Client,
    query: &str,
) -> Result<Vec<MetadataSearchResult>, String> {
    let token = hhaven_token(client)?;
    let mut url =
        reqwest::Url::parse("https://api.hentaihaven.app/v1/search").map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("q", query);
    let payload = request_json(
        client
            .get(url)
            .header(
                "content-type",
                "application/x-www-form-urlencoded; charset=utf-8",
            )
            .header("user-agent", "HH_xxx_APP")
            .header("warden", &token),
        "Hentai Haven search",
    )?;
    let Some(items) = payload.get("data").and_then(|value| value.as_array()) else {
        return Ok(Vec::new());
    };

    Ok(items
        .iter()
        .filter_map(|entry| {
            let id = json_string_or_number(entry.get("post_ID"));
            let title = entry
                .get("post_title")
                .and_then(|value| value.as_str())
                .and_then(optional_non_empty)?;
            let poster_url = entry
                .get("post_thumbnail")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            Some(MetadataSearchResult {
                provider: METADATA_SOURCE_HHAVEN.to_string(),
                source: METADATA_SOURCE_HHAVEN.to_string(),
                source_id: id,
                tmdb_id: None,
                title,
                overview: String::new(),
                poster_url: poster_url.clone(),
                backdrop_url: poster_url,
                duration_minutes: None,
                rating: 0.0,
                year: String::new(),
                genre: vec!["Hentai".to_string()],
                media_type: "tv".to_string(),
            })
        })
        .collect())
}

fn metadata_details_from_hhaven(
    client: &Client,
    source_id: &str,
) -> Result<MetadataDetails, String> {
    let token = hhaven_token(client)?;
    let payload = hhaven_json(client, &token, &format!("hentai/{}", source_id))?;
    let details = payload
        .get("data")
        .filter(|value| value.is_object())
        .ok_or_else(|| format!("No Hentai Haven metadata found for id '{}'", source_id))?;
    Ok(hhaven_details_from_payload(source_id, details))
}

fn metadata_details_from_jikan(
    client: &Client,
    source_id: &str,
) -> Result<MetadataDetails, String> {
    let mal_id = source_id
        .trim()
        .parse::<u64>()
        .map_err(|_| "Invalid anime id".to_string())?;
    let payload = jikan_json(client, &format!("/anime/{}/full", mal_id), &[])?;
    let details = payload
        .get("data")
        .cloned()
        .ok_or("Jikan details response did not include data".to_string())?;

    let media_type = jikan_media_type(&details);
    let duration_minutes =
        parse_runtime_minutes_text(details.get("duration").and_then(|value| value.as_str()));
    let episode_list = if media_type == "tv" {
        jikan_fetch_episodes(client, mal_id).unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(MetadataDetails {
        source: METADATA_SOURCE_JIKAN.to_string(),
        source_id: source_id.to_string(),
        tmdb_id: None,
        imdb_id: None,
        tvdb_id: None,
        trakt_id: None,
        mal_id: Some(mal_id),
        title: details
            .get("title_english")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .or_else(|| details.get("title").and_then(|value| value.as_str()))
            .unwrap_or("Untitled")
            .to_string(),
        original_title: optional_non_empty(
            details
                .get("title_japanese")
                .and_then(|value| value.as_str())
                .or_else(|| details.get("title").and_then(|value| value.as_str()))
                .unwrap_or(""),
        ),
        overview: details
            .get("synopsis")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        tagline: None,
        poster_url: jikan_image_url(&details),
        backdrop_url: jikan_backdrop_url(&details),
        duration_minutes,
        rating: details
            .get("score")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0),
        year: details
            .get("year")
            .and_then(|value| value.as_i64())
            .map(|value| value.to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                year_from_date(
                    details
                        .get("aired")
                        .and_then(|value| value.get("from"))
                        .and_then(|value| value.as_str()),
                )
            }),
        genre: jikan_genres(&details),
        media_type: media_type.clone(),
        cast: jikan_fetch_cast(client, mal_id).unwrap_or_default(),
        status: optional_non_empty(
            details
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or(""),
        ),
        tv: if media_type == "tv" {
            Some(MetadataTvInfo {
                seasons: 1,
                episodes: details
                    .get("episodes")
                    .and_then(|value| value.as_u64())
                    .map(|value| value as u32)
                    .unwrap_or(episode_list.len() as u32),
                episode_list,
            })
        } else {
            None
        },
    })
}

fn metadata_search_sync(
    query: String,
    media_type: String,
) -> Result<Vec<MetadataSearchResult>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let keys = load_api_keys().unwrap_or_default();
    let client = tmdb_client()?;
    let media_type = match media_type.trim().to_ascii_lowercase().as_str() {
        "movies" | "movie" | "movieshorts" | "movie-shorts" | "shorts" => "movie".to_string(),
        "shows" | "show" | "tvshows" | "tv-shows" | "tv" => "tv".to_string(),
        "cartoon" | "cartoons" => "cartoon".to_string(),
        "anime" => "anime".to_string(),
        "hentai" => "hentai".to_string(),
        other => other.to_string(),
    };

    let mut results = Vec::new();

    if media_type == "movie" {
        if let Some(api_key) = keys.tmdb_api_key.as_deref() {
            if let Ok(payload) = tmdb_json(
                &client,
                api_key,
                "/search/movie",
                &[
                    ("query", query.clone()),
                    ("page", "1".to_string()),
                    ("include_adult", "true".to_string()),
                ],
            ) {
                let movie_genres = tmdb_genre_map(&client, api_key, "movie").unwrap_or_default();

                for entry in payload
                    .get("results")
                    .and_then(|value| value.as_array())
                    .into_iter()
                    .flatten()
                {
                    let Some(tmdb_id) = entry.get("id").and_then(|value| value.as_u64()) else {
                        continue;
                    };

                    let genres = entry
                        .get("genre_ids")
                        .and_then(|value| value.as_array())
                        .map(|ids| {
                            ids.iter()
                                .filter_map(|value| value.as_u64())
                                .filter_map(|id| movie_genres.get(&id))
                                .cloned()
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();

                    results.push(MetadataSearchResult {
                        provider: METADATA_SOURCE_TMDB.to_string(),
                        source: METADATA_SOURCE_TMDB.to_string(),
                        source_id: tmdb_id.to_string(),
                        tmdb_id: Some(tmdb_id),
                        title: metadata_title(entry, "movie"),
                        overview: entry
                            .get("overview")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string(),
                        poster_url: tmdb_image_url(
                            entry.get("poster_path").and_then(|value| value.as_str()),
                            "w500",
                        ),
                        backdrop_url: tmdb_image_url(
                            entry.get("backdrop_path").and_then(|value| value.as_str()),
                            "w1280",
                        ),
                        duration_minutes: None,
                        rating: metadata_rating(entry),
                        year: metadata_year(entry, "movie"),
                        genre: genres,
                        media_type: "movie".to_string(),
                    });
                }
            }
        }

        if let Ok(found) = omdb_search_results(&client, &keys, &query, "movie") {
            results.extend(found);
        }
        if let Some(trakt_client_id) = keys.trakt_client_id.as_deref() {
            if let Ok(found) = trakt_search_results(&client, trakt_client_id, "movie", &query) {
                results.extend(found);
            }
        }
    } else if media_type == "tv" || media_type == "cartoon" {
        if let Ok(found) = omdb_search_results(&client, &keys, &query, "tv") {
            results.extend(found);
        }
        if let Some(tvdb_api_key) = keys.tvdb_api_key.as_deref() {
            if let Ok(found) = tvdb_search_results(&client, tvdb_api_key, &query) {
                results.extend(found);
            }
        }
        if let Some(trakt_client_id) = keys.trakt_client_id.as_deref() {
            if let Ok(found) = trakt_search_results(&client, trakt_client_id, "tv", &query) {
                results.extend(found);
            }
        }
        if media_type == "cartoon" {
            let params = vec![
                ("q", query.clone()),
                ("limit", "12".to_string()),
                ("sfw", "true".to_string()),
            ];
            if let Ok(payload) = jikan_json(&client, "/anime", &params) {
                for entry in payload
                    .get("data")
                    .and_then(|value| value.as_array())
                    .into_iter()
                    .flatten()
                {
                    let Some(source_id) =
                        tvdb_value_u64(entry.get("mal_id")).map(|value| value.to_string())
                    else {
                        continue;
                    };
                    let entry_media_type = jikan_media_type(entry);
                    results.push(MetadataSearchResult {
                        provider: METADATA_SOURCE_JIKAN.to_string(),
                        source: METADATA_SOURCE_JIKAN.to_string(),
                        source_id,
                        tmdb_id: None,
                        title: entry
                            .get("title_english")
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                            .or_else(|| entry.get("title").and_then(|value| value.as_str()))
                            .unwrap_or("Untitled")
                            .to_string(),
                        overview: entry
                            .get("synopsis")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string(),
                        poster_url: jikan_image_url(entry),
                        backdrop_url: jikan_backdrop_url(entry),
                        duration_minutes: parse_runtime_minutes_text(
                            entry.get("duration").and_then(|value| value.as_str()),
                        ),
                        rating: entry
                            .get("score")
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        year: entry
                            .get("year")
                            .and_then(|value| value.as_i64())
                            .map(|value| value.to_string())
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| {
                                year_from_date(
                                    entry
                                        .get("aired")
                                        .and_then(|value| value.get("from"))
                                        .and_then(|value| value.as_str()),
                                )
                            }),
                        genre: jikan_genres(entry),
                        media_type: entry_media_type,
                    });
                }
            }
        }
    } else if media_type == "anime" {
        let params = vec![
            ("q", query.clone()),
            ("limit", "12".to_string()),
            ("sfw", "false".to_string()),
        ];
        if let Ok(payload) = jikan_json(&client, "/anime", &params) {
            for entry in payload
                .get("data")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
            {
                let Some(source_id) =
                    tvdb_value_u64(entry.get("mal_id")).map(|value| value.to_string())
                else {
                    continue;
                };
                let entry_media_type = jikan_media_type(entry);
                results.push(MetadataSearchResult {
                    provider: METADATA_SOURCE_JIKAN.to_string(),
                    source: METADATA_SOURCE_JIKAN.to_string(),
                    source_id,
                    tmdb_id: None,
                    title: entry
                        .get("title_english")
                        .and_then(|value| value.as_str())
                        .filter(|value| !value.trim().is_empty())
                        .or_else(|| entry.get("title").and_then(|value| value.as_str()))
                        .unwrap_or("Untitled")
                        .to_string(),
                    overview: entry
                        .get("synopsis")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string(),
                    poster_url: jikan_image_url(entry),
                    backdrop_url: jikan_backdrop_url(entry),
                    duration_minutes: parse_runtime_minutes_text(
                        entry.get("duration").and_then(|value| value.as_str()),
                    ),
                    rating: entry
                        .get("score")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(0.0),
                    year: entry
                        .get("year")
                        .and_then(|value| value.as_i64())
                        .map(|value| value.to_string())
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| {
                            year_from_date(
                                entry
                                    .get("aired")
                                    .and_then(|value| value.get("from"))
                                    .and_then(|value| value.as_str()),
                            )
                        }),
                    genre: jikan_genres(entry),
                    media_type: entry_media_type,
                });
            }
        }
    } else if media_type == "hentai" {
        if let Ok(found) = hhaven_search_results(&client, &query) {
            results.extend(found);
        }
    } else {
        return Err(
            "media_type must be movie, tv, anime, cartoon, hentai, or movieShorts".to_string(),
        );
    }

    Ok(results.into_iter().take(36).collect())
}

fn metadata_get_details_sync(
    source_id: String,
    source: String,
    media_type: String,
) -> Result<MetadataDetails, String> {
    let source = source.trim().to_ascii_lowercase();
    let media_type = media_type.trim().to_ascii_lowercase();
    if media_type != "movie" && media_type != "tv" {
        return Err("media_type must be movie or tv".to_string());
    }

    let client = tmdb_client()?;
    let keys = load_api_keys().unwrap_or_default();

    if source == METADATA_SOURCE_JIKAN {
        return metadata_details_from_jikan(&client, &source_id);
    }

    if source == METADATA_SOURCE_HHAVEN {
        return metadata_details_from_hhaven(&client, &source_id);
    }

    if source == METADATA_SOURCE_OMDB {
        return metadata_details_from_omdb(&client, &keys, &source_id, &media_type);
    }

    if source == METADATA_SOURCE_TRAKT {
        let trakt_id = source_id
            .trim()
            .parse::<u64>()
            .map_err(|_| "Invalid Trakt id".to_string())?;
        return metadata_details_from_trakt(&client, &keys, trakt_id, &media_type);
    }

    if source == METADATA_SOURCE_TVDB {
        let tvdb_id = source_id
            .trim()
            .parse::<u64>()
            .map_err(|_| "Invalid TVDB id".to_string())?;
        return metadata_details_from_tvdb(&client, &keys, tvdb_id, &media_type);
    }

    if source != METADATA_SOURCE_TMDB {
        return Err(format!("Unsupported metadata source: {}", source));
    }

    let api_key = keys
        .tmdb_api_key
        .as_deref()
        .ok_or("TMDB_API_KEY is missing in api.md".to_string())?;
    let tmdb_id = source_id
        .trim()
        .parse::<u64>()
        .map_err(|_| "Invalid TMDb id".to_string())?;

    let details = tmdb_json(
        &client,
        api_key,
        &format!("/{}/{}", media_type, tmdb_id),
        &[("append_to_response", "credits,external_ids".to_string())],
    )?;

    let imdb_id = optional_non_empty(
        details
            .get("external_ids")
            .and_then(|value| value.get("imdb_id"))
            .and_then(|value| value.as_str())
            .or_else(|| details.get("imdb_id").and_then(|value| value.as_str()))
            .unwrap_or(""),
    );
    let mut tvdb_id = details
        .get("external_ids")
        .and_then(|value| value.get("tvdb_id"))
        .and_then(|value| value.as_u64());
    let mut trakt_id = None;

    let mut title = metadata_title(&details, &media_type);
    let mut original_title = metadata_original_title(&details, &media_type);
    let mut overview = details
        .get("overview")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let mut tagline = optional_non_empty(
        details
            .get("tagline")
            .and_then(|value| value.as_str())
            .unwrap_or(""),
    );
    let mut poster_url = tmdb_image_url(
        details.get("poster_path").and_then(|value| value.as_str()),
        "w500",
    );
    let mut backdrop_url = tmdb_image_url(
        details
            .get("backdrop_path")
            .and_then(|value| value.as_str()),
        "w1280",
    );
    let mut duration_minutes = metadata_runtime_minutes(&details, &media_type);
    let mut rating = metadata_rating(&details);
    let mut year = metadata_year(&details, &media_type);
    let mut genre = metadata_genres_from_details(&details);
    let mut cast = metadata_cast(&details);
    let mut status = optional_non_empty(
        details
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or(""),
    );

    let mut tv = if media_type == "tv" {
        Some(tmdb_tv_summary(&details))
    } else {
        None
    };

    if let Some(omdb_key) = keys.omdb_api_key.as_deref() {
        if let Some(imdb_id) = imdb_id.as_deref() {
            if let Ok(Some(omdb)) = omdb_lookup_by_imdb_id(&client, omdb_key, imdb_id) {
                fallback_non_empty(
                    &mut overview,
                    optional_non_empty(
                        omdb.get("Plot")
                            .and_then(|value| value.as_str())
                            .unwrap_or(""),
                    ),
                );
                fallback_option_u32(
                    &mut duration_minutes,
                    parse_runtime_minutes_text(
                        omdb.get("Runtime").and_then(|value| value.as_str()),
                    ),
                );
                fallback_rating(
                    &mut rating,
                    parse_rating_text(omdb.get("imdbRating").and_then(|value| value.as_str())),
                );
                if year.trim().is_empty() {
                    year = year_from_date(omdb.get("Released").and_then(|value| value.as_str()));
                    if year.trim().is_empty() {
                        year = omdb
                            .get("Year")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string();
                    }
                }
                if poster_url.trim().is_empty() {
                    poster_url = optional_non_empty(
                        omdb.get("Poster")
                            .and_then(|value| value.as_str())
                            .unwrap_or(""),
                    )
                    .unwrap_or_default();
                }
                append_unique_strings(
                    &mut genre,
                    omdb.get("Genre")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .split(',')
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty()),
                );
                if cast.is_empty() {
                    cast = omdb
                        .get("Actors")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .split(',')
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .enumerate()
                        .map(|(index, value)| MetadataCastMember {
                            id: format!("omdb:{}:{}", index, value),
                            name: value.to_string(),
                            character: None,
                            profile_url: None,
                        })
                        .collect();
                }
            }
        }
    }

    if let Some(trakt_client_id) = keys.trakt_client_id.as_deref() {
        if let Ok(Some((resolved_trakt_id, trakt))) = trakt_fetch_details(
            &client,
            trakt_client_id,
            &media_type,
            Some(tmdb_id),
            imdb_id.as_deref(),
        ) {
            trakt_id = Some(resolved_trakt_id);
            fallback_non_empty(
                &mut overview,
                optional_non_empty(
                    trakt
                        .get("overview")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
            );
            fallback_option_u32(
                &mut duration_minutes,
                trakt
                    .get("runtime")
                    .and_then(|value| value.as_u64())
                    .filter(|value| *value > 0)
                    .map(|value| value as u32),
            );
            fallback_rating(
                &mut rating,
                trakt
                    .get("rating")
                    .and_then(|value| value.as_f64())
                    .map(|value| (value * 10.0).round() / 10.0),
            );
            if year.trim().is_empty() {
                year = trakt
                    .get("year")
                    .and_then(|value| value.as_i64())
                    .map(|value| value.to_string())
                    .unwrap_or_default();
            }
            fallback_option_string(
                &mut status,
                optional_non_empty(
                    trakt
                        .get("status")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
            );
            fallback_option_string(
                &mut tagline,
                optional_non_empty(
                    trakt
                        .get("tagline")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
            );
            fallback_non_empty(
                &mut title,
                optional_non_empty(
                    trakt
                        .get("title")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
            );
        }
    }

    if let Some(tvdb_api_key) = keys.tvdb_api_key.as_deref() {
        if let Ok(Some((resolved_tvdb_id, tvdb_details, tvdb_episodes))) = tvdb_fetch_details(
            &client,
            tvdb_api_key,
            &media_type,
            Some(tmdb_id),
            imdb_id.as_deref(),
            &title,
        ) {
            tvdb_id = Some(resolved_tvdb_id);
            fallback_non_empty(
                &mut overview,
                optional_non_empty(
                    tvdb_details
                        .get("overview")
                        .and_then(|value| value.as_str())
                        .or_else(|| tvdb_details.get("summary").and_then(|value| value.as_str()))
                        .unwrap_or(""),
                ),
            );
            fallback_option_string(
                &mut status,
                optional_non_empty(
                    tvdb_details
                        .get("status")
                        .and_then(|value| value.get("name"))
                        .and_then(|value| value.as_str())
                        .or_else(|| tvdb_details.get("status").and_then(|value| value.as_str()))
                        .unwrap_or(""),
                ),
            );
            fallback_non_empty(
                &mut title,
                optional_non_empty(
                    tvdb_details
                        .get("name")
                        .and_then(|value| value.as_str())
                        .or_else(|| tvdb_details.get("title").and_then(|value| value.as_str()))
                        .unwrap_or(""),
                ),
            );
            fallback_option_string(
                &mut original_title,
                optional_non_empty(
                    tvdb_details
                        .get("originalName")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                ),
            );
            fallback_option_u32(
                &mut duration_minutes,
                tvdb_value_u64(tvdb_details.get("runtime")).map(|value| value as u32),
            );
            if year.trim().is_empty() {
                year = year_from_date(
                    tvdb_details
                        .get("firstAired")
                        .and_then(|value| value.as_str())
                        .or_else(|| tvdb_details.get("year").and_then(|value| value.as_str())),
                );
            }
            append_unique_strings(
                &mut genre,
                tvdb_details
                    .get("genres")
                    .and_then(|value| value.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| {
                        entry
                            .get("name")
                            .and_then(|value| value.as_str())
                            .or_else(|| entry.as_str())
                            .map(str::to_string)
                    }),
            );
            if poster_url.trim().is_empty() {
                poster_url = tvdb_pick_artwork(&tvdb_details, &["poster"]).unwrap_or_else(|| {
                    optional_non_empty(
                        tvdb_details
                            .get("image")
                            .and_then(|value| value.as_str())
                            .unwrap_or(""),
                    )
                    .unwrap_or_default()
                });
            }
            if backdrop_url.trim().is_empty() {
                backdrop_url =
                    tvdb_pick_artwork(&tvdb_details, &["background", "banner", "fanart"])
                        .unwrap_or_default();
            }
            if cast.is_empty() {
                cast = tvdb_cast(&tvdb_details);
            }

            if media_type == "tv" && !tvdb_episodes.is_empty() {
                if let Some(existing) = &mut tv {
                    let mut by_key: HashMap<(u32, u32), usize> = existing
                        .episode_list
                        .iter()
                        .enumerate()
                        .map(|(index, episode)| ((episode.season, episode.episode), index))
                        .collect();

                    for tvdb_episode in tvdb_episodes {
                        let key = (tvdb_episode.season, tvdb_episode.episode);
                        if let Some(index) = by_key.get(&key).copied() {
                            let current = &mut existing.episode_list[index];
                            if current.title.trim().is_empty() || current.title == "Episode" {
                                current.title = tvdb_episode.title;
                            }
                            if current
                                .overview
                                .as_deref()
                                .map(str::trim)
                                .unwrap_or("")
                                .is_empty()
                            {
                                current.overview = tvdb_episode.overview;
                            }
                            if current.runtime_minutes.is_none() {
                                current.runtime_minutes = tvdb_episode.runtime_minutes;
                            }
                            if current
                                .air_date
                                .as_deref()
                                .map(str::trim)
                                .unwrap_or("")
                                .is_empty()
                            {
                                current.air_date = tvdb_episode.air_date;
                            }
                            if current
                                .still_url
                                .as_deref()
                                .map(str::trim)
                                .unwrap_or("")
                                .is_empty()
                            {
                                current.still_url = tvdb_episode.still_url;
                            }
                        } else {
                            by_key.insert(key, existing.episode_list.len());
                            existing.episode_list.push(tvdb_episode);
                        }
                    }

                    existing
                        .episode_list
                        .sort_by(|a, b| a.season.cmp(&b.season).then(a.episode.cmp(&b.episode)));
                    existing.seasons = existing
                        .episode_list
                        .iter()
                        .map(|episode| episode.season)
                        .collect::<std::collections::BTreeSet<_>>()
                        .len() as u32;
                    existing.episodes = existing.episode_list.len() as u32;
                } else {
                    tv = Some(MetadataTvInfo {
                        seasons: tvdb_episodes
                            .iter()
                            .map(|episode| episode.season)
                            .collect::<std::collections::BTreeSet<_>>()
                            .len() as u32,
                        episodes: tvdb_episodes.len() as u32,
                        episode_list: tvdb_episodes,
                    });
                }
            }
        }
    }

    if media_type == "tv"
        && tv
            .as_ref()
            .map(|entry| entry.episode_list.is_empty())
            .unwrap_or(false)
    {
        if let Ok((tmdb_episodes, runtime_hint)) =
            tmdb_fetch_tv_episode_list(&client, api_key, tmdb_id, &details)
        {
            if duration_minutes.is_none() {
                duration_minutes = runtime_hint;
            }
            if let Some(existing) = &mut tv {
                existing.seasons = tmdb_episodes
                    .iter()
                    .map(|episode| episode.season)
                    .collect::<std::collections::BTreeSet<_>>()
                    .len() as u32;
                existing.episodes = tmdb_episodes.len() as u32;
                existing.episode_list = tmdb_episodes;
            }
        }
    }

    Ok(MetadataDetails {
        source: METADATA_SOURCE_TMDB.to_string(),
        source_id,
        tmdb_id: Some(tmdb_id),
        imdb_id,
        tvdb_id,
        trakt_id,
        mal_id: None,
        title,
        original_title,
        overview,
        tagline,
        poster_url,
        backdrop_url,
        duration_minutes,
        rating,
        year,
        genre,
        media_type,
        cast,
        status,
        tv,
    })
}

fn collect_video_files(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_video_files(&path, out)?;
            continue;
        }
        if path.is_file() && is_video_file(&path) {
            out.push(path);
        }
    }
    Ok(())
}

fn infer_season_number(root: &Path, path: &Path) -> Option<u32> {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if let Some((season, _)) = parse_sxe_numbers(stem) {
        return Some(season);
    }

    let relative = path.strip_prefix(root).ok()?;
    let mut components = relative.components().collect::<Vec<_>>();
    let _ = components.pop();

    for component in components.iter().rev() {
        let name = component.as_os_str().to_string_lossy();
        if let Some(season) = parse_season_number(&name) {
            return Some(season);
        }
    }

    None
}

fn infer_episode_number(root: &Path, path: &Path) -> Option<u32> {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if let Some(episode) = parse_episode_number(stem) {
        return Some(episode);
    }

    let relative = path.strip_prefix(root).ok()?;
    let mut components = relative.components().collect::<Vec<_>>();
    let _ = components.pop();

    for component in components.iter().rev() {
        let name = component.as_os_str().to_string_lossy();
        if let Some(episode) = parse_episode_number(&name) {
            return Some(episode);
        }
    }

    None
}

fn title_looks_like_code(name: &str) -> bool {
    let cleaned = clean_title(name).to_ascii_lowercase();
    cleaned.is_empty()
        || (parse_episode_number(name).is_some() && cleaned.split_whitespace().count() <= 3)
}

fn infer_episode_title(root: &Path, path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !title_looks_like_code(stem) {
        return clean_title(stem);
    }

    if let Ok(relative) = path.strip_prefix(root) {
        let mut components = relative.components().collect::<Vec<_>>();
        let _ = components.pop();
        for component in components.iter().rev() {
            let name = component.as_os_str().to_string_lossy();
            if !title_looks_like_code(&name) {
                return clean_title(&name);
            }
        }
    }

    clean_title(stem)
}

fn library_scan_tv_show_sync(root_path: String) -> Result<TvShowScanResult, String> {
    let root_path = root_path.trim().to_string();
    if root_path.is_empty() {
        return Err("root_path is empty".to_string());
    }

    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(format!("root_path is not a directory: {}", root_path));
    }

    let mut files = Vec::new();
    collect_video_files(&root, &mut files)?;

    let mut items: Vec<(u32, Option<u32>, PathBuf, String)> = files
        .into_iter()
        .map(|path| {
            (
                infer_season_number(&root, &path).unwrap_or(1),
                infer_episode_number(&root, &path),
                path.clone(),
                infer_episode_title(&root, &path),
            )
        })
        .collect();

    items.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| match (a.1, b.1) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then_with(|| {
                a.2.to_string_lossy()
                    .to_ascii_lowercase()
                    .cmp(&b.2.to_string_lossy().to_ascii_lowercase())
            })
    });

    let mut episode_list = Vec::new();
    let mut next_episode_by_season: HashMap<u32, u32> = HashMap::new();

    for (season, maybe_episode, path, title) in items {
        let next_episode = next_episode_by_season.entry(season).or_insert(1);
        let episode = maybe_episode.unwrap_or(*next_episode);
        if episode >= *next_episode {
            *next_episode = episode + 1;
        }

        episode_list.push(TvEpisode {
            season,
            episode,
            title,
            path: Some(path.to_string_lossy().to_string()),
            overview: None,
            runtime_minutes: None,
            air_date: None,
            still_url: None,
        });
    }

    let seasons = episode_list
        .iter()
        .map(|episode| episode.season)
        .collect::<std::collections::BTreeSet<_>>()
        .len() as u32;
    let episodes = episode_list.len() as u32;

    eprintln!(
        "tv scan result root=\"{}\" seasons={} episodes={}",
        truncate_for_log(&root_path, 180),
        seasons,
        episodes
    );
    for episode in episode_list.iter().take(8) {
        eprintln!(
            "tv scan mapped S{}E{} path=\"{}\"",
            episode.season,
            episode.episode,
            truncate_for_log(episode.path.as_deref().unwrap_or(""), 200)
        );
    }

    Ok(TvShowScanResult {
        root_path,
        seasons,
        episodes,
        episode_list,
    })
}

#[tauri::command]
async fn metadata_search(
    query: String,
    media_type: String,
) -> Result<Vec<MetadataSearchResult>, String> {
    eprintln!(
        "metadata_search: query=\"{}\" media_type={}",
        query, media_type
    );
    tauri::async_runtime::spawn_blocking(move || metadata_search_sync(query, media_type))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn metadata_get_details(
    source_id: String,
    source: String,
    media_type: String,
) -> Result<MetadataDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        metadata_get_details_sync(source_id, source, media_type)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn metadata_cache_image(
    db: tauri::State<'_, AppDb>,
    url: String,
    cache_key: Option<String>,
) -> Result<String, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || metadata_cache_image_sync(&db, url, cache_key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn library_scan_tv_show(root_path: String) -> Result<TvShowScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || library_scan_tv_show_sync(root_path))
        .await
        .map_err(|e| e.to_string())?
}

// Phase 2.1: Real database query commands

#[derive(Serialize)]
struct LibraryStats {
    total_items: i64,
    total_movies: i64,
    total_tv_shows: i64,
    total_episodes: i64,
    matched_items: i64,
    unmatched_items: i64,
}

#[tauri::command]
fn get_library_stats(db: tauri::State<AppDb>) -> Result<LibraryStats, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let total_items: i64 = conn
        .query_row("SELECT COUNT(*) FROM library_items", [], |row| row.get(0))
        .unwrap_or(0);

    let total_movies: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM library_items WHERE type = 'movie'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let total_tv_shows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM library_items WHERE type = 'tv'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let total_episodes: i64 = conn
        .query_row("SELECT COUNT(*) FROM episodes", [], |row| row.get(0))
        .unwrap_or(0);

    let matched_items: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM library_items WHERE tmdb_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let unmatched_items = total_items - matched_items;

    Ok(LibraryStats {
        total_items,
        total_movies,
        total_tv_shows,
        total_episodes,
        matched_items,
        unmatched_items,
    })
}

#[derive(Serialize)]
struct LibraryItem {
    id: String,
    title: String,
    item_type: String,
    year: Option<i32>,
    plot: Option<String>,
    file_path: String,
}

#[derive(Serialize)]
struct LibraryDbItem {
    id: String,
    title: String,
    item_type: String,
    library_kind: String,
    year: Option<i32>,
    plot: Option<String>,
    file_path: String,
    metadata_json: Option<String>,
    is_adult_override: bool,
}

#[derive(Serialize)]
struct SearchResult {
    items: Vec<LibraryItem>,
    total: i64,
    page: u32,
    page_size: u32,
}

#[tauri::command]
fn search_library(
    db: tauri::State<AppDb>,
    query: String,
    item_type: Option<String>,
    page: u32,
    page_size: u32,
) -> Result<SearchResult, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let offset = (page.saturating_sub(1)) * page_size;
    let search_pattern = format!("%{}%", query);

    // Count total results
    let total: i64 = if let Some(ref t) = item_type {
        conn.query_row(
            "SELECT COUNT(*) FROM library_items WHERE title LIKE ? AND type = ?",
            params![&search_pattern, t],
            |row| row.get(0),
        )
        .unwrap_or(0)
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM library_items WHERE title LIKE ?",
            params![&search_pattern],
            |row| row.get(0),
        )
        .unwrap_or(0)
    };

    // Get items
    let items: Vec<LibraryItem> = if let Some(ref t) = item_type {
        let mut stmt = conn
      .prepare(
        "SELECT id, title, type, year, plot, file_path FROM library_items WHERE title LIKE ? AND type = ? ORDER BY title LIMIT ? OFFSET ?",
      )
      .map_err(|e| e.to_string())?;

        let result: Result<Vec<_>, rusqlite::Error> = stmt
            .query_map(params![&search_pattern, t, page_size, offset], |row| {
                Ok(LibraryItem {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    item_type: row.get(2)?,
                    year: row.get(3)?,
                    plot: row.get(4)?,
                    file_path: row.get(5)?,
                })
            })
            .and_then(|rows| rows.collect());

        result.map_err(|e| e.to_string())?
    } else {
        let mut stmt = conn
      .prepare(
        "SELECT id, title, type, year, plot, file_path FROM library_items WHERE title LIKE ? ORDER BY title LIMIT ? OFFSET ?",
      )
      .map_err(|e| e.to_string())?;

        let result: Result<Vec<_>, rusqlite::Error> = stmt
            .query_map(params![&search_pattern, page_size, offset], |row| {
                Ok(LibraryItem {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    item_type: row.get(2)?,
                    year: row.get(3)?,
                    plot: row.get(4)?,
                    file_path: row.get(5)?,
                })
            })
            .and_then(|rows| rows.collect());

        result.map_err(|e| e.to_string())?
    };

    Ok(SearchResult {
        items,
        total,
        page,
        page_size,
    })
}

#[derive(Serialize)]
struct DashboardData {
    continue_watching: Vec<LibraryItem>,
    recently_added: Vec<LibraryItem>,
}

#[tauri::command]
fn get_dashboard_items(db: tauri::State<AppDb>) -> Result<DashboardData, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    // Continue Watching
    let mut stmt = conn
    .prepare(
      "SELECT l.id, l.title, l.type, l.year, l.plot, l.file_path FROM library_items l
       WHERE EXISTS (SELECT 1 FROM playback_progress p WHERE p.item_id = l.id AND p.progress_ms > 0 AND p.watched = 0)
       ORDER BY (SELECT p.last_watched FROM playback_progress p WHERE p.item_id = l.id) DESC
       LIMIT 5",
    )
    .map_err(|e| e.to_string())?;

    let continue_watching = stmt
        .query_map([], |row| {
            Ok(LibraryItem {
                id: row.get(0)?,
                title: row.get(1)?,
                item_type: row.get(2)?,
                year: row.get(3)?,
                plot: row.get(4)?,
                file_path: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // Recently Added
    let mut stmt = conn
    .prepare(
      "SELECT id, title, type, year, plot, file_path FROM library_items ORDER BY scanned_at DESC LIMIT 12",
    )
    .map_err(|e| e.to_string())?;

    let recently_added = stmt
        .query_map([], |row| {
            Ok(LibraryItem {
                id: row.get(0)?,
                title: row.get(1)?,
                item_type: row.get(2)?,
                year: row.get(3)?,
                plot: row.get(4)?,
                file_path: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(DashboardData {
        continue_watching,
        recently_added,
    })
}

#[derive(Serialize)]
struct EpisodeInfo {
    season: i32,
    episode: i32,
    title: String,
    file_path: Option<String>,
}

#[derive(Serialize)]
struct ItemDetail {
    id: String,
    title: String,
    item_type: String,
    year: Option<i32>,
    plot: Option<String>,
    tmdb_id: Option<i32>,
    episodes: Vec<EpisodeInfo>,
}

#[tauri::command]
fn get_item_detail(db: tauri::State<AppDb>, item_id: String) -> Result<ItemDetail, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, title, type, year, plot, tmdb_id FROM library_items WHERE id = ?")
        .map_err(|e| e.to_string())?;

    let (id, title, item_type, year, plot, tmdb_id) = stmt
        .query_row(params![&item_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i32>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i32>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    // Get episodes if TV show
    let mut episodes = Vec::new();
    if item_type == "tv" {
        let mut episode_stmt = conn
      .prepare("SELECT season, episode, title, file_path FROM episodes WHERE show_id = ? ORDER BY season, episode")
      .map_err(|e| e.to_string())?;

        episodes = episode_stmt
            .query_map(params![&item_id], |row| {
                Ok(EpisodeInfo {
                    season: row.get(0)?,
                    episode: row.get(1)?,
                    title: row.get(2)?,
                    file_path: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
    }

    Ok(ItemDetail {
        id,
        title,
        item_type,
        year,
        plot,
        tmdb_id,
        episodes,
    })
}

#[tauri::command]
fn save_progress(
    db: tauri::State<AppDb>,
    item_id: String,
    progress_ms: u32,
    completed: bool,
) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT OR REPLACE INTO playback_progress (id, item_id, progress_ms, watched, last_watched)
     VALUES (?, ?, ?, ?, ?)",
        params![
            format!("{}-playback", item_id),
            &item_id,
            progress_ms,
            if completed { 1 } else { 0 },
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Serialize)]
struct CollectionInfo {
    id: String,
    name: String,
    description: Option<String>,
    item_count: i32,
}

#[tauri::command]
fn get_collections(db: tauri::State<AppDb>) -> Result<Vec<CollectionInfo>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, name, description FROM collections ORDER BY name")
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for row_result in rows {
        let (id, name, description) = row_result.map_err(|e| e.to_string())?;

        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM collection_items WHERE collection_id = ?",
                params![&id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        result.push(CollectionInfo {
            id,
            name,
            description,
            item_count: count,
        });
    }

    Ok(result)
}

#[tauri::command]
fn get_collection_items(
    db: tauri::State<AppDb>,
    collection_id: String,
) -> Result<Vec<LibraryItem>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT l.id, l.title, l.type, l.year, l.plot, l.file_path FROM library_items l
       JOIN collection_items c ON l.id = c.item_id
       WHERE c.collection_id = ?
       ORDER BY c.position",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(params![&collection_id], |row| {
            Ok(LibraryItem {
                id: row.get(0)?,
                title: row.get(1)?,
                item_type: row.get(2)?,
                year: row.get(3)?,
                plot: row.get(4)?,
                file_path: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

#[tauri::command]
fn create_collection(
    db: tauri::State<AppDb>,
    name: String,
    description: Option<String>,
) -> Result<String, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO collections (id, name, description, is_auto_generated, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)",
        params![&id, &name, description, &now, &now],
    )
    .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
fn add_to_collection(
    db: tauri::State<AppDb>,
    collection_id: String,
    item_id: String,
) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let id = uuid::Uuid::new_v4().to_string();

    conn.execute(
        "INSERT OR IGNORE INTO collection_items (id, collection_id, item_id, position)
     VALUES (?, ?, ?, (SELECT COUNT(*)+1 FROM collection_items WHERE collection_id = ?))",
        params![&id, &collection_id, &item_id, &collection_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn remove_from_collection(
    db: tauri::State<AppDb>,
    collection_id: String,
    item_id: String,
) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    conn.execute(
        "DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?",
        params![&collection_id, &item_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn delete_collection(db: tauri::State<AppDb>, collection_id: String) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    conn.execute(
        "DELETE FROM collection_items WHERE collection_id = ?",
        params![&collection_id],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM collections WHERE id = ?",
        params![&collection_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Episode {
    id: String,
    show_id: String,
    season: u32,
    episode: u32,
    title: String,
    plot: Option<String>,
    air_date: Option<String>,
}

#[tauri::command]
fn get_episodes(db: tauri::State<AppDb>, show_id: String) -> Result<Vec<Episode>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, show_id, season, episode, title, plot, air_date FROM episodes 
       WHERE show_id = ? 
       ORDER BY season ASC, episode ASC",
        )
        .map_err(|e| e.to_string())?;

    let episodes = stmt
        .query_map(params![&show_id], |row| {
            Ok(Episode {
                id: row.get(0)?,
                show_id: row.get(1)?,
                season: row.get(2)?,
                episode: row.get(3)?,
                title: row.get(4)?,
                plot: row.get(5)?,
                air_date: row.get(6)?,
            })
        })
        .and_then(|rows| rows.collect())
        .map_err(|e| e.to_string())?;

    Ok(episodes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryRoot {
    id: String,
    path: String,
    library_kind: String,
    created_at: String,
}

#[tauri::command]
fn get_library_roots(db: tauri::State<AppDb>) -> Result<Vec<LibraryRoot>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, path, library_kind, created_at FROM library_root ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let roots = stmt
        .query_map([], |row| {
            Ok(LibraryRoot {
                id: row.get(0)?,
                path: row.get(1)?,
                library_kind: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .and_then(|rows| rows.collect())
        .map_err(|e| e.to_string())?;

    Ok(roots)
}

#[tauri::command]
fn get_library_items(db: tauri::State<AppDb>) -> Result<Vec<LibraryDbItem>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut stmt = conn
    .prepare("SELECT id, title, type, library_kind, year, plot, file_path, metadata_json, is_adult_override FROM library_items ORDER BY title")
    .map_err(|e| e.to_string())?;

    let items: Vec<LibraryDbItem> = stmt
        .query_map([], |row| {
            Ok(LibraryDbItem {
                id: row.get(0)?,
                title: row.get(1)?,
                item_type: row.get(2)?,
                library_kind: row.get(3)?,
                year: row.get(4)?,
                plot: row.get(5)?,
                file_path: row.get(6)?,
                metadata_json: row.get(7)?,
                is_adult_override: row.get(8)?,
            })
        })
        .and_then(|rows| rows.collect())
        .map_err(|e| e.to_string())?;

    eprintln!("DEBUG: Retrieved {} items from database", items.len());
    Ok(items)
}

#[tauri::command]
fn debug_get_item_count(db: tauri::State<AppDb>) -> Result<i64, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM library_items", [], |row| row.get(0))
        .unwrap_or(0);

    eprintln!("DEBUG: Total items in database: {}", count);
    Ok(count)
}

#[tauri::command]
fn add_library_root(
    db: tauri::State<AppDb>,
    path: String,
    library_kind: String,
) -> Result<LibraryRoot, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    // Verify path exists
    if !std::path::Path::new(&path).exists() {
        return Err("Path does not exist".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().to_rfc3339();

    conn.execute(
        "INSERT INTO library_root (id, path, library_kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)",
        params![&id, &path, &library_kind, &now, &now],
    )
    .map_err(|e| e.to_string())?;

    Ok(LibraryRoot {
        id,
        path,
        library_kind,
        created_at: now,
    })
}

fn purge_library_root_items(conn: &Connection, root_id: &str) -> Result<(), String> {
    let item_ids = {
        let mut stmt = conn
            .prepare("SELECT id FROM library_items WHERE root_id = ?")
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(params![root_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        ids
    };

    for item_id in &item_ids {
        conn.execute(
            "DELETE FROM external_subtitles WHERE item_id = ?",
            params![item_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM watch_history WHERE item_id = ?",
            params![item_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM playback_progress WHERE item_id = ?",
            params![item_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM collection_items WHERE item_id = ?",
            params![item_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM episodes WHERE show_id = ?", params![item_id])
            .map_err(|e| e.to_string())?;
    }

    conn.execute(
        "DELETE FROM library_items WHERE root_id = ?",
        params![root_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn remove_library_root(db: tauri::State<AppDb>, root_id: String) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    purge_library_root_items(&conn, &root_id)?;

    conn.execute("DELETE FROM library_root WHERE id = ?", params![&root_id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Parse season and episode number from filename
/// Supports patterns like: S01E05, s01e05, 1x05, 101, etc.
fn parse_episode_info(filename: &str) -> Option<(i32, i32)> {
    let filename_lower = filename.to_lowercase();

    // Pattern 1: S01E05 or s01e05
    if let Some(pos) = filename_lower.find('s') {
        if let Some(e_pos) = filename_lower[pos..].find('e') {
            let e_pos = pos + e_pos;
            let season_str = &filename_lower[pos + 1..e_pos];
            let rest = &filename_lower[e_pos + 1..];

            if let Ok(season) = season_str.parse::<i32>() {
                // Extract episode number (first digits after 'e')
                let ep_str: String = rest.chars().take_while(|c| c.is_numeric()).collect();
                if let Ok(episode) = ep_str.parse::<i32>() {
                    return Some((season, episode));
                }
            }
        }
    }

    // Pattern 2: 1x05 format
    if let Some(x_pos) = filename_lower.find('x') {
        if x_pos > 0 {
            let before_x: String = filename_lower[..x_pos]
                .chars()
                .rev()
                .take_while(|c| c.is_numeric())
                .collect::<String>()
                .chars()
                .rev()
                .collect();

            if let Ok(season) = before_x.parse::<i32>() {
                let after_x = &filename_lower[x_pos + 1..];
                let ep_str: String = after_x.chars().take_while(|c| c.is_numeric()).collect();
                if let Ok(episode) = ep_str.parse::<i32>() {
                    return Some((season, episode));
                }
            }
        }
    }

    None
}

fn stable_hash(input: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn normalize_path_segment(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
        .collect::<String>()
        .to_lowercase()
}

fn language_name_from_segment(value: &str) -> Option<&'static str> {
    match normalize_path_segment(value).as_str() {
        "telugu" | "tel" => Some("Telugu"),
        "tamil" | "tam" => Some("Tamil"),
        "hindi" | "hin" => Some("Hindi"),
        "english" | "eng" => Some("English"),
        "japanese" | "jpn" | "ja" => Some("Japanese"),
        "korean" | "kor" | "ko" => Some("Korean"),
        "chinese" | "chi" | "zho" | "zh" => Some("Chinese"),
        "mandarin" => Some("Mandarin"),
        "cantonese" => Some("Cantonese"),
        "spanish" | "spa" | "es" => Some("Spanish"),
        "italian" | "ita" | "it" => Some("Italian"),
        "french" | "fre" | "fra" | "fr" => Some("French"),
        "german" | "ger" | "deu" | "de" => Some("German"),
        "malayalam" | "mal" => Some("Malayalam"),
        "kannada" | "kan" => Some("Kannada"),
        "marathi" | "mar" => Some("Marathi"),
        "bengali" | "ben" => Some("Bengali"),
        "dual" | "dualaudio" => Some("Dual Audio"),
        "multi" | "multiaudio" => Some("Multi Audio"),
        _ => None,
    }
}

fn folder_language_from_path(root_path: &Path, media_path: &Path) -> Option<String> {
    let relative = media_path.strip_prefix(root_path).unwrap_or(media_path);
    relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .find_map(language_name_from_segment)
        .map(str::to_string)
}

fn infer_library_kind_from_path(root_path: &Path, media_path: &Path, fallback: &str) -> String {
    let relative = media_path.strip_prefix(root_path).unwrap_or(media_path);
    let mut segments = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .map(normalize_path_segment);

    if let Some(first) = segments.next() {
        match first.as_str() {
            "movies" | "movie" => return "movies".to_string(),
            "shows" | "show" | "tv" | "tvshows" | "series" => return "shows".to_string(),
            "anime" => return "anime".to_string(),
            "cartoon" | "cartoons" => return "cartoon".to_string(),
            "hentai" => return "hentai".to_string(),
            "movieshorts" | "shorts" | "shortfilms" => return "movieShorts".to_string(),
            _ => {}
        }
    }

    match normalize_path_segment(fallback).as_str() {
        "shows" | "show" | "tv" | "tvshows" | "series" => "shows".to_string(),
        "anime" => "anime".to_string(),
        "cartoon" | "cartoons" => "cartoon".to_string(),
        "hentai" => "hentai".to_string(),
        "movieshorts" | "shorts" | "shortfilms" => "movieShorts".to_string(),
        "others" | "other" => "others".to_string(),
        _ => "movies".to_string(),
    }
}

fn item_type_for_library_kind(library_kind: &str, filename: &str) -> &'static str {
    if library_kind == "shows"
        || library_kind == "cartoon"
        || library_kind == "hentai"
        || parse_episode_info(filename).is_some()
    {
        "tv"
    } else {
        "movie"
    }
}

fn episode_info_for_show_file(filename: &str) -> (i32, i32) {
    parse_episode_info(filename)
        .or_else(|| parse_episode_number(filename).map(|episode| (1, episode as i32)))
        .unwrap_or((1, 1))
}

fn is_season_folder_name(name: &str) -> bool {
    let normalized = normalize_path_segment(name);
    normalized.starts_with("season")
        || normalized.starts_with('s') && normalized[1..].chars().all(|c| c.is_numeric())
}

fn series_folder_for_episode(root_path: &Path, media_path: &Path) -> PathBuf {
    let parent = media_path.parent().unwrap_or(root_path);
    if let Some(parent_name) = parent.file_name().and_then(|name| name.to_str()) {
        if is_season_folder_name(parent_name) {
            return parent.parent().unwrap_or(parent).to_path_buf();
        }
    }
    parent.to_path_buf()
}

fn series_title_from_folder(folder: &Path) -> String {
    folder
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Untitled Show".to_string())
}

fn is_container_folder_name(name: &str) -> bool {
    matches!(
        normalize_path_segment(name).as_str(),
        "movies"
            | "movie"
            | "shows"
            | "show"
            | "tv"
            | "tvshows"
            | "series"
            | "anime"
            | "cartoon"
            | "cartoons"
            | "hentai"
            | "movieshorts"
            | "shorts"
            | "shortfilms"
            | "others"
            | "other"
            | "telugu"
            | "tel"
            | "tamil"
            | "tam"
            | "hindi"
            | "hin"
            | "english"
            | "eng"
            | "japanese"
            | "jpn"
            | "korean"
            | "kor"
            | "dualaudio"
            | "multiaudio"
    )
}

fn movie_title_from_folder(root_path: &Path, media_path: &Path, fallback_filename: &str) -> String {
    let parent = media_path.parent().unwrap_or(root_path);
    let Some(parent_name) = parent.file_name().and_then(|name| name.to_str()) else {
        return fallback_filename.to_string();
    };

    let parent_name = parent_name.trim();
    if parent_name.is_empty() || is_container_folder_name(parent_name) {
        return fallback_filename.to_string();
    }

    parent_name.to_string()
}

fn build_tv_metadata(
    conn: &Connection,
    show_id: &str,
    root_path: &Path,
    show_folder: &Path,
    library_kind: &str,
    title: &str,
    folder_language: Option<&str>,
) -> Result<String, String> {
    let mut stmt = conn
    .prepare("SELECT season, episode, title, file_path FROM episodes WHERE show_id = ? ORDER BY season, episode")
    .map_err(|e| e.to_string())?;
    let episodes = stmt
        .query_map(params![show_id], |row| {
            let season: i32 = row.get(0)?;
            let episode: i32 = row.get(1)?;
            let title: Option<String> = row.get(2)?;
            let path: String = row.get(3)?;
            Ok(json!({
              "season": season,
              "episode": episode,
              "title": title.unwrap_or_else(|| format!("Episode {}", episode)),
              "path": path
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let seasons = episodes
        .iter()
        .filter_map(|episode| episode.get("season").and_then(|value| value.as_i64()))
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let relative_path = show_folder
        .strip_prefix(root_path)
        .unwrap_or(show_folder)
        .to_string_lossy()
        .replace('\\', "/");

    serde_json::to_string(&json!({
      "schema": "cinevault.show.scan.v1",
      "libraryKind": library_kind,
      "mediaType": "tv",
      "title": title,
      "filePath": show_folder.to_string_lossy().to_string(),
      "relativePath": relative_path,
      "language": folder_language,
      "folderLanguage": folder_language,
      "adult": library_kind == "hentai",
      "tv": {
        "rootPath": show_folder.to_string_lossy().to_string(),
        "seasons": seasons,
        "episodes": episodes.len(),
        "episodeList": episodes
      }
    }))
    .map_err(|e| e.to_string())
}

fn write_json_file(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| format!("failed to write {}: {}", path.display(), e))
}

fn ensure_root_metadata_sidecars(root_id: &str, root_path: &Path) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    write_json_file(
        &root_path.join("metadata.json"),
        &json!({
          "schema": "cinevault.root.v1",
          "rootId": root_id,
          "kind": "root",
          "updatedAt": now,
          "categories": ["Movies", "Shows", "Anime", "Cartoon", "Hentai", "Movie Shorts"]
        }),
    )?;

    for (folder, kind) in [
        ("Movies", "movies"),
        ("Shows", "shows"),
        ("Anime", "anime"),
        ("Cartoon", "cartoon"),
        ("Hentai", "hentai"),
        ("Movie Shorts", "movieShorts"),
    ] {
        let category_path = root_path.join(folder);
        if !category_path.is_dir() {
            continue;
        }
        write_json_file(
            &category_path.join("metadata.json"),
            &json!({
              "schema": "cinevault.category.v1",
              "rootId": root_id,
              "kind": kind,
              "folder": folder,
              "updatedAt": now
            }),
        )?;
    }

    Ok(())
}

#[tauri::command]
fn scan_library_root(
    db: tauri::State<AppDb>,
    root_id: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    // Get root info
    let (path, library_kind) = conn
        .query_row(
            "SELECT path, library_kind FROM library_root WHERE id = ?",
            params![&root_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?;

    purge_library_root_items(&conn, &root_id)?;

    drop(conn);

    // Scan directory for media files recursively
    let mut scan_count = 0;
    let root_path = std::path::Path::new(&path);

    if !root_path.exists() {
        return Err("Root path no longer exists".to_string());
    }

    ensure_root_metadata_sidecars(&root_id, root_path)?;

    fn walk_dir(
        root_path: &std::path::Path,
        dir: &std::path::Path,
        db: &tauri::State<AppDb>,
        root_id: &str,
        library_kind: &str,
        app_handle: &tauri::AppHandle,
        scan_count: &mut i32,
    ) -> Result<(), String> {
        eprintln!("DEBUG walk_dir: Scanning directory: {:?}", dir);
        let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

        for entry in entries.flatten() {
            let entry_path = entry.path();

            if entry_path.is_dir() {
                // Recursively scan subdirectories
                walk_dir(
                    root_path,
                    &entry_path,
                    db,
                    root_id,
                    library_kind,
                    app_handle,
                    scan_count,
                )?;
            } else if let Some(ext) = entry_path.extension() {
                if let Some(ext_str) = ext.to_str() {
                    let ext_lower = ext_str.to_lowercase();
                    let media_exts = vec!["mkv", "mp4", "avi", "mov", "flv", "wmv", "webm"];

                    if media_exts.contains(&ext_lower.as_str()) {
                        eprintln!("DEBUG walk_dir: Found media file: {:?}", entry_path);
                        let conn = db
                            .conn
                            .lock()
                            .map_err(|_| "db mutex poisoned".to_string())?;

                        // Extract filename without extension
                        let filename = entry_path
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("unknown");
                        let relative_path = entry_path
                            .strip_prefix(root_path)
                            .unwrap_or(&entry_path)
                            .to_string_lossy()
                            .replace('\\', "/")
                            .to_lowercase();
                        let inferred_library_kind =
                            infer_library_kind_from_path(root_path, &entry_path, library_kind);
                        let folder_language = folder_language_from_path(root_path, &entry_path);
                        let item_type =
                            item_type_for_library_kind(&inferred_library_kind, filename);
                        let show_folder = if item_type == "tv" {
                            Some(series_folder_for_episode(root_path, &entry_path))
                        } else {
                            None
                        };
                        let item_relative_path = show_folder
                            .as_deref()
                            .unwrap_or(&entry_path)
                            .strip_prefix(root_path)
                            .unwrap_or(show_folder.as_deref().unwrap_or(&entry_path))
                            .to_string_lossy()
                            .replace('\\', "/")
                            .to_lowercase();
                        let stable_id = format!("{}:{}", root_id, item_relative_path);
                        let id = stable_hash(&stable_id);
                        let item_title = show_folder
                            .as_deref()
                            .map(series_title_from_folder)
                            .unwrap_or_else(|| {
                                movie_title_from_folder(root_path, &entry_path, filename)
                            });
                        let item_file_path = show_folder
                            .as_deref()
                            .unwrap_or(&entry_path)
                            .to_string_lossy()
                            .to_string();

                        let now = chrono::Local::now().to_rfc3339();

                        // Extract video metadata using FFprobe
                        let mut video_metadata = serde_json::json!({
                          "resolution": null,
                          "codec": null,
                          "bitrate": null,
                          "audio_tracks": [],
                          "subtitle_tracks": [],
                          "duration": null
                        });

                        if let Ok(output) = std::process::Command::new("ffprobe")
                            .arg("-v")
                            .arg("error")
                            .arg("-select_streams")
                            .arg("v:0")
                            .arg("-show_entries")
                            .arg("stream=codec_name,width,height,bit_rate")
                            .arg("-of")
                            .arg("default=noprint_wrappers=1:nokey=1:noprint_names=1")
                            .arg(entry_path.to_string_lossy().to_string())
                            .output()
                        {
                            if output.status.success() {
                                let output_str = String::from_utf8_lossy(&output.stdout);
                                let lines: Vec<&str> = output_str.trim().split('\n').collect();
                                if lines.len() >= 3 {
                                    // Parse codec, width, height, bitrate from ffprobe output
                                    if let Ok(width) = lines[0].parse::<u32>() {
                                        if let Ok(height) = lines[1].parse::<u32>() {
                                            video_metadata["resolution"] = serde_json::json!({
                                              "width": width,
                                              "height": height
                                            });
                                        }
                                    }
                                    if !lines[2].is_empty() {
                                        video_metadata["codec"] = serde_json::json!(lines[2]);
                                    }
                                }
                            }
                        }

                        // Extract audio tracks
                        if let Ok(output) = std::process::Command::new("ffprobe")
                            .arg("-v")
                            .arg("error")
                            .arg("-select_streams")
                            .arg("a")
                            .arg("-show_entries")
                            .arg("stream=index,codec_name,language")
                            .arg("-of")
                            .arg("csv=p=0")
                            .arg(entry_path.to_string_lossy().to_string())
                            .output()
                        {
                            if output.status.success() {
                                let output_str = String::from_utf8_lossy(&output.stdout);
                                let audio_tracks: Vec<String> = output_str
                                    .trim()
                                    .split('\n')
                                    .filter(|s| !s.is_empty())
                                    .map(|s| s.to_string())
                                    .collect();
                                video_metadata["audio_tracks"] = serde_json::json!(audio_tracks);
                            }
                        }

                        // Extract subtitle tracks
                        if let Ok(output) = std::process::Command::new("ffprobe")
                            .arg("-v")
                            .arg("error")
                            .arg("-select_streams")
                            .arg("s")
                            .arg("-show_entries")
                            .arg("stream=index,codec_name,language")
                            .arg("-of")
                            .arg("csv=p=0")
                            .arg(entry_path.to_string_lossy().to_string())
                            .output()
                        {
                            if output.status.success() {
                                let output_str = String::from_utf8_lossy(&output.stdout);
                                let subtitle_tracks: Vec<String> = output_str
                                    .trim()
                                    .split('\n')
                                    .filter(|s| !s.is_empty())
                                    .map(|s| s.to_string())
                                    .collect();
                                video_metadata["subtitle_tracks"] =
                                    serde_json::json!(subtitle_tracks);
                            }
                        }

                        video_metadata["schema"] = serde_json::json!("cinevault.item.scan.v1");
                        video_metadata["libraryKind"] = serde_json::json!(inferred_library_kind);
                        video_metadata["mediaType"] = serde_json::json!(item_type);
                        video_metadata["title"] = serde_json::json!(&item_title);
                        video_metadata["filePath"] =
                            serde_json::json!(entry_path.to_string_lossy().to_string());
                        video_metadata["relativePath"] = serde_json::json!(relative_path);
                        video_metadata["language"] = serde_json::json!(folder_language);
                        video_metadata["folderLanguage"] = serde_json::json!(folder_language);
                        video_metadata["adult"] =
                            serde_json::json!(inferred_library_kind == "hentai");

                        let video_metadata_json = serde_json::to_string(&video_metadata)
                            .unwrap_or_else(|_| "{}".to_string());
                        let item_metadata_json = if item_type == "tv" {
                            "{}".to_string()
                        } else {
                            video_metadata_json.clone()
                        };

                        if let Err(e) = conn.execute(
                            "INSERT INTO library_items 
               (id, stable_id, root_id, type, library_kind, title, file_path, 
                metadata_json, scanned_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            params![
                                &id,
                                &stable_id,
                                root_id,
                                item_type,
                                &inferred_library_kind,
                                &item_title,
                                &item_file_path,
                                &item_metadata_json,
                                &now,
                                &now,
                            ],
                        ) {
                            if let Err(update_err) = conn.execute(
                "UPDATE library_items
                 SET root_id = ?, type = ?, library_kind = ?, title = ?, metadata_json = ?, scanned_at = ?, updated_at = ?
                 WHERE file_path = ?",
                params![
                  root_id,
                  item_type,
                  &inferred_library_kind,
                  &item_title,
                  &item_metadata_json,
                  &now,
                  &now,
                  &item_file_path,
                ],
              ) {
                eprintln!("Failed to upsert item {}: {}; update failed: {}", filename, e, update_err);
              }
                        } else {
                            eprintln!("DEBUG: Successfully inserted item: {}", filename);
                        }

                        *scan_count += 1;

                        // If TV library, parse episode info
                        if item_type == "tv" {
                            let (season, episode_num) = episode_info_for_show_file(filename);
                            let episode_stable = format!("{}:{}", stable_id, relative_path);
                            let episode_id = stable_hash(&episode_stable);
                            let _ = conn.execute(
                  "INSERT INTO episodes
                   (id, show_id, season, episode, title, file_path, metadata_json, scanned_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(show_id, season, episode) DO UPDATE SET
                     title = excluded.title,
                     file_path = excluded.file_path,
                     metadata_json = excluded.metadata_json,
                     scanned_at = excluded.scanned_at,
                     updated_at = excluded.updated_at",
                  params![
                    &episode_id,
                    &id,
                    season,
                    episode_num,
                    filename,
                    entry_path.to_string_lossy().to_string(),
                    &video_metadata_json,
                    &now,
                    &now,
                  ],
                );

                            if let Some(folder) = show_folder.as_deref() {
                                if let Ok(show_metadata_json) = build_tv_metadata(
                                    &conn,
                                    &id,
                                    root_path,
                                    folder,
                                    &inferred_library_kind,
                                    &item_title,
                                    folder_language.as_deref(),
                                ) {
                                    let _ = conn.execute(
                      "UPDATE library_items SET metadata_json = ?, updated_at = ? WHERE id = ?",
                      params![&show_metadata_json, &now, &id],
                    );
                                }
                            }
                        }

                        // Emit progress event
                        let _ = app_handle.emit(
                            "library:scan-progress",
                            json!({
                              "root_id": root_id,
                              "scanned": *scan_count,
                              "current_file": filename
                            }),
                        );
                    }
                }
            }
        }

        Ok(())
    }

    walk_dir(
        root_path,
        root_path,
        &db,
        &root_id,
        &library_kind,
        &app_handle,
        &mut scan_count,
    )?;

    Ok(format!("Scanned {} files", scan_count))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TmdbMetadata {
    tmdb_id: Option<i64>,
    title: Option<String>,
    year: Option<i32>,
    plot: Option<String>,
    rating: Option<f64>,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    adult: Option<bool>,
    genres: Option<Vec<String>>,
}

#[tauri::command]
fn update_item_metadata(
    db: tauri::State<AppDb>,
    item_id: String,
    metadata: TmdbMetadata,
) -> Result<String, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    // Serialize metadata to JSON
    let metadata_json = serde_json::to_string(&metadata)
        .map_err(|e| format!("Failed to serialize metadata: {}", e))?;

    let now = chrono::Local::now().to_rfc3339();

    // Get file path for sidecar generation
    let file_path: String = conn
        .query_row(
            "SELECT file_path FROM library_items WHERE id = ?",
            params![&item_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    // Update library_items with new metadata
    conn.execute(
        "UPDATE library_items 
       SET metadata_json = ?, tmdb_id = ?, adult = ?, updated_at = ?
       WHERE id = ?",
        params![
            &metadata_json,
            metadata.tmdb_id,
            metadata.adult.unwrap_or(false),
            &now,
            &item_id
        ],
    )
    .map_err(|e| e.to_string())?;

    drop(conn);

    // Generate metadata.json sidecar file next to the media file
    let media_path = std::path::Path::new(&file_path);
    if let Some(parent) = media_path.parent() {
        let sidecar_path = parent.join("metadata.json");

        match std::fs::write(&sidecar_path, &metadata_json) {
            Ok(_) => {
                println!("Wrote metadata sidecar to {:?}", sidecar_path);
            }
            Err(e) => {
                eprintln!("Failed to write metadata sidecar: {}", e);
                // Don't fail if sidecar write fails - DB update is primary
            }
        }
    }

    Ok("Metadata updated".to_string())
}

#[tauri::command]
fn cache_tmdb_artwork(
    poster_path: Option<String>,
    backdrop_path: Option<String>,
) -> Result<String, String> {
    // Create cache directories if they don't exist
    let cache_dir = std::path::Path::new("./cache");
    let posters_dir = cache_dir.join("posters");
    let backdrops_dir = cache_dir.join("backdrops");

    std::fs::create_dir_all(&posters_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&backdrops_dir).map_err(|e| e.to_string())?;

    let mut cached_files = Vec::new();

    // Cache poster
    if let Some(poster) = poster_path {
        if !poster.is_empty() {
            let filename = poster.split('/').last().unwrap_or("poster.jpg");
            let cache_path = posters_dir.join(filename);

            if !cache_path.exists() {
                let url = format!("https://image.tmdb.org/t/p/w500{}", poster);
                if let Ok(response) = std::process::Command::new("curl")
                    .arg("-s")
                    .arg(&url)
                    .output()
                {
                    if !response.status.success() {
                        eprintln!("Failed to download poster from {}", url);
                    } else if let Err(e) = std::fs::write(&cache_path, response.stdout) {
                        eprintln!("Failed to write poster cache: {}", e);
                    } else {
                        cached_files.push(format!("posters/{}", filename));
                    }
                }
            } else {
                cached_files.push(format!("posters/{}", filename));
            }
        }
    }

    // Cache backdrop
    if let Some(backdrop) = backdrop_path {
        if !backdrop.is_empty() {
            let filename = backdrop.split('/').last().unwrap_or("backdrop.jpg");
            let cache_path = backdrops_dir.join(filename);

            if !cache_path.exists() {
                let url = format!("https://image.tmdb.org/t/p/w1280{}", backdrop);
                if let Ok(response) = std::process::Command::new("curl")
                    .arg("-s")
                    .arg(&url)
                    .output()
                {
                    if !response.status.success() {
                        eprintln!("Failed to download backdrop from {}", url);
                    } else if let Err(e) = std::fs::write(&cache_path, response.stdout) {
                        eprintln!("Failed to write backdrop cache: {}", e);
                    } else {
                        cached_files.push(format!("backdrops/{}", filename));
                    }
                }
            } else {
                cached_files.push(format!("backdrops/{}", filename));
            }
        }
    }

    Ok(format!("Cached {} artwork files", cached_files.len()))
}

#[tauri::command]
fn save_playback_progress(
    db: tauri::State<AppDb>,
    item_id: String,
    progress_ms: i64,
    episode_id: Option<String>,
) -> Result<String, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().to_rfc3339();

    conn.execute(
        "INSERT OR REPLACE INTO playback_progress 
       (id, item_id, episode_id, progress_ms, last_watched)
       VALUES (?, ?, ?, ?, ?)",
        params![&id, &item_id, episode_id, progress_ms, &now],
    )
    .map_err(|e| e.to_string())?;

    Ok("Progress saved".to_string())
}

#[tauri::command]
fn record_watch_history(
    db: tauri::State<AppDb>,
    item_id: String,
    duration_watched_ms: i64,
    completed: bool,
    episode_id: Option<String>,
) -> Result<String, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().to_rfc3339();

    conn.execute(
        "INSERT INTO watch_history 
       (id, item_id, episode_id, watched_at, duration_watched_ms, completed)
       VALUES (?, ?, ?, ?, ?, ?)",
        params![
            &id,
            &item_id,
            episode_id,
            &now,
            duration_watched_ms,
            completed
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok("Watch recorded".to_string())
}

#[tauri::command]
fn get_playback_progress(db: tauri::State<AppDb>, item_id: String) -> Result<Option<i64>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let result: Option<i64> = conn
        .query_row(
            "SELECT progress_ms FROM playback_progress WHERE item_id = ?",
            params![&item_id],
            |row| row.get(0),
        )
        .ok();

    Ok(result)
}

#[tauri::command]
fn get_watch_history(
    db: tauri::State<AppDb>,
    item_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT watched_at, duration_watched_ms, completed FROM watch_history 
       WHERE item_id = ? ORDER BY watched_at DESC LIMIT 10",
        )
        .map_err(|e| e.to_string())?;

    let history = stmt
        .query_map(params![&item_id], |row| {
            Ok(serde_json::json!({
              "watched_at": row.get::<_, String>(0)?,
              "duration_watched_ms": row.get::<_, i64>(1)?,
              "completed": row.get::<_, bool>(2)?
            }))
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| e.to_string())?;

    Ok(history)
}

#[tauri::command]
fn scan_subtitles(
    db: tauri::State<AppDb>,
    item_id: String,
    media_file_path: String,
) -> Result<Vec<serde_json::Value>, String> {
    let media_path = std::path::Path::new(&media_file_path);
    let parent = media_path.parent().ok_or("Invalid file path")?;
    let stem = media_path.file_stem().ok_or("Invalid filename")?;

    let mut subtitles = Vec::new();

    // Common subtitle extensions and patterns
    let subtitle_patterns = vec![
        // Format: filename.srt, filename.ass, filename.sub
        (
            stem.to_string_lossy().to_string(),
            vec!["srt", "ass", "ssa", "sub", "sup"],
        ),
        // Format: filename.en.srt, filename.eng.srt
        (format!("{}.??", stem.to_string_lossy()), vec!["srt", "ass"]),
        (
            format!("{}.???", stem.to_string_lossy()),
            vec!["srt", "ass"],
        ),
        // Format: filename.en-US.srt
        (
            format!("{}.??-??", stem.to_string_lossy()),
            vec!["srt", "ass"],
        ),
        // Format: filename.forced.srt, filename.signs.srt
        (
            format!("{}.forced", stem.to_string_lossy()),
            vec!["srt", "ass", "sup"],
        ),
        (
            format!("{}.signs", stem.to_string_lossy()),
            vec!["srt", "ass", "sup"],
        ),
        (
            format!("{}.sdh", stem.to_string_lossy()),
            vec!["srt", "ass", "sup"],
        ),
    ];

    // Scan directory for subtitle files
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if let Some(filename) = entry_path.file_name() {
                let filename_str = filename.to_string_lossy().to_lowercase();

                // Check if file matches any subtitle pattern
                for (pattern, exts) in &subtitle_patterns {
                    if filename_str.starts_with(&pattern.to_lowercase()) {
                        if let Some(ext) = entry_path.extension() {
                            let ext_str = ext.to_string_lossy().to_lowercase();
                            if exts.contains(&ext_str.as_str()) {
                                // Extract language code if present
                                let language = extract_language_code(&filename_str)
                                    .unwrap_or_else(|| "unknown".to_string());

                                // Detect subtitle type (forced, sdh, etc.)
                                let subtitle_type = if filename_str.contains("forced") {
                                    "forced"
                                } else if filename_str.contains("signs")
                                    || filename_str.contains("sdh")
                                {
                                    "hearing_impaired"
                                } else {
                                    "default"
                                };

                                let conn = db
                                    .conn
                                    .lock()
                                    .map_err(|_| "db mutex poisoned".to_string())?;

                                let sub_id = uuid::Uuid::new_v4().to_string();
                                let now = chrono::Local::now().to_rfc3339();

                                // Insert subtitle into database
                                let _ = conn.execute(
                                    "INSERT INTO external_subtitles 
                   (id, item_id, language, format, file_path, is_forced, added_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)",
                                    params![
                                        &sub_id,
                                        &item_id,
                                        &language,
                                        &ext_str,
                                        entry_path.to_string_lossy().to_string(),
                                        subtitle_type == "forced",
                                        &now,
                                    ],
                                );

                                subtitles.push(serde_json::json!({
                                  "id": sub_id,
                                  "language": language,
                                  "format": ext_str,
                                  "file_path": entry_path.to_string_lossy().to_string(),
                                  "is_forced": subtitle_type == "forced",
                                  "is_hearing_impaired": subtitle_type == "hearing_impaired",
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(subtitles)
}

fn extract_language_code(filename: &str) -> Option<String> {
    // Common language code patterns: .en, .eng, .en-US, etc.
    let parts: Vec<&str> = filename.split('.').collect();

    for i in 1..parts.len() {
        let part = parts[i];

        // Two-letter code: en, fr, es, de, etc.
        if part.len() == 2 && part.chars().all(|c| c.is_alphabetic()) {
            return Some(part.to_string());
        }

        // Three-letter code: eng, fra, spa, deu, etc.
        if part.len() == 3 && part.chars().all(|c| c.is_alphabetic()) {
            return Some(part.to_string());
        }

        // BCP 47 format: en-US, fr-CA, etc.
        if part.contains('-') && part.len() <= 10 {
            let codes: Vec<&str> = part.split('-').collect();
            if codes.len() == 2 && codes[0].len() <= 3 && codes[1].len() == 2 {
                return Some(part.to_string());
            }
        }
    }

    None
}

#[tauri::command]
fn get_unmatched_items(
    db: tauri::State<AppDb>,
    limit: i32,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, stable_id, type, title, file_path, metadata_json 
       FROM library_items 
       WHERE metadata_json IS NULL OR metadata_json = '{}' 
       ORDER BY title 
       LIMIT ?",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(params![limit], |row| {
            Ok(serde_json::json!({
              "id": row.get::<_, String>(0)?,
              "stable_id": row.get::<_, String>(1)?,
              "item_type": row.get::<_, String>(2)?,
              "title": row.get::<_, String>(3)?,
              "file_path": row.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

#[tauri::command]
fn search_by_genre(
    db: tauri::State<AppDb>,
    genre: String,
    limit: i32,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let search_pattern = format!("%\"{}\"%", genre);

    let mut stmt = conn
        .prepare(
            "SELECT id, stable_id, type, title, year, rating, poster_path 
       FROM library_items 
       WHERE metadata_json LIKE ? 
       ORDER BY rating DESC, title 
       LIMIT ?",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(params![&search_pattern, limit], |row| {
            Ok(serde_json::json!({
              "id": row.get::<_, String>(0)?,
              "stable_id": row.get::<_, String>(1)?,
              "item_type": row.get::<_, String>(2)?,
              "title": row.get::<_, String>(3)?,
              "year": row.get::<_, Option<i32>>(4)?,
              "rating": row.get::<_, Option<f64>>(5)?,
              "poster_path": row.get::<_, Option<String>>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

#[tauri::command]
fn fetch_tmdb_collection(
    db: tauri::State<AppDb>,
    tmdb_id: i64,
    collection_name: String,
) -> Result<serde_json::Value, String> {
    // Fetch collection from TMDB API
    let url = format!(
        "https://api.themoviedb.org/3/movie/{}/collection?api_key=demo",
        tmdb_id
    );

    let client = reqwest::blocking::Client::new();
    match client.get(&url).send() {
        Ok(response) => {
            match response.json::<serde_json::Value>() {
                Ok(collection_data) => {
                    let conn = db
                        .conn
                        .lock()
                        .map_err(|_| "db mutex poisoned".to_string())?;

                    // Check if collection already exists
                    let existing: Result<String, _> = conn.query_row(
                        "SELECT id FROM collections WHERE name = ?",
                        params![&collection_name],
                        |row| row.get(0),
                    );

                    let collection_id = if let Ok(id) = existing {
                        id
                    } else {
                        let new_id = uuid::Uuid::new_v4().to_string();
                        let now = chrono::Local::now().to_rfc3339();

                        let _ = conn.execute(
              "INSERT INTO collections (id, name, is_auto_generated, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)",
              params![&new_id, &collection_name, true, &now, &now],
            );

                        new_id
                    };

                    Ok(serde_json::json!({
                      "collection_id": collection_id,
                      "name": collection_name,
                      "is_auto_generated": true,
                      "collection_data": collection_data,
                    }))
                }
                Err(_) => Err("Failed to parse TMDB response".to_string()),
            }
        }
        Err(_) => Err("Failed to fetch from TMDB".to_string()),
    }
}

#[tauri::command]
fn add_item_to_collection(
    db: tauri::State<AppDb>,
    collection_id: String,
    item_id: String,
) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let _ = conn.execute(
        "INSERT OR IGNORE INTO collection_items (collection_id, item_id)
     VALUES (?, ?)",
        params![&collection_id, &item_id],
    );

    Ok(())
}

#[tauri::command]
fn get_collections_for_item(
    db: tauri::State<AppDb>,
    item_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.name, c.is_auto_generated, c.created_at
       FROM collections c
       JOIN collection_items ci ON c.id = ci.collection_id
       WHERE ci.item_id = ?
       ORDER BY c.name",
        )
        .map_err(|e| e.to_string())?;

    let collections = stmt
        .query_map(params![&item_id], |row| {
            Ok(serde_json::json!({
              "id": row.get::<_, String>(0)?,
              "name": row.get::<_, String>(1)?,
              "is_auto_generated": row.get::<_, bool>(2)?,
              "created_at": row.get::<_, String>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(collections)
}

#[tauri::command]
fn advanced_search(
    db: tauri::State<AppDb>,
    query: Option<String>,
    item_type: Option<String>,
    year_from: Option<i32>,
    year_to: Option<i32>,
    genres: Option<Vec<String>>,
    min_rating: Option<f64>,
    max_rating: Option<f64>,
    sort_by: String,    // "title", "rating", "year", "added"
    sort_order: String, // "asc" or "desc"
    limit: i32,
    offset: i32,
) -> Result<serde_json::Value, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut where_clauses = vec!["1=1".to_string()];

    // Add search filters
    if let Some(q) = &query {
        where_clauses.push(format!("title LIKE '%{}%'", q.replace("'", "''")));
    }

    if let Some(t) = &item_type {
        where_clauses.push(format!("type = '{}'", t));
    }

    if let Some(yf) = year_from {
        where_clauses.push(format!("year >= {}", yf));
    }

    if let Some(yt) = year_to {
        where_clauses.push(format!("year <= {}", yt));
    }

    if let Some(mr) = min_rating {
        where_clauses.push(format!("rating >= {}", mr));
    }

    if let Some(mr) = max_rating {
        where_clauses.push(format!("rating <= {}", mr));
    }

    // Genre filter (JSON contains search)
    if let Some(g) = &genres {
        if !g.is_empty() {
            let genre_conditions: Vec<String> = g
                .iter()
                .map(|genre| format!("metadata_json LIKE '%\"{}\"'", genre.replace("'", "''")))
                .collect();
            where_clauses.push(format!("({})", genre_conditions.join(" OR ")));
        }
    }

    // Sort options
    match sort_by.as_str() {
        "rating" => "rating DESC NULLS LAST",
        "year" => "year DESC NULLS LAST",
        "added" => "scanned_at DESC",
        _ => "title ASC",
    };

    let order_dir = if sort_order.to_lowercase() == "desc" {
        "DESC"
    } else {
        "ASC"
    };
    let order_clause = match sort_by.as_str() {
        "title" => format!("title {}", order_dir),
        "rating" => format!("rating {} NULLS LAST, title ASC", order_dir),
        "year" => format!("year {} NULLS LAST, title ASC", order_dir),
        "added" => format!("scanned_at {}", order_dir),
        _ => "title ASC".to_string(),
    };

    let where_sql = where_clauses.join(" AND ");
    let query_sql = format!(
        "SELECT id, title, type, year, rating, poster_path FROM library_items
     WHERE {} ORDER BY {} LIMIT ? OFFSET ?",
        where_sql, order_clause
    );

    let mut stmt = conn.prepare(&query_sql).map_err(|e| e.to_string())?;

    let items: Vec<serde_json::Value> = stmt
        .query_map(params![limit, offset], |row| {
            Ok(serde_json::json!({
              "id": row.get::<_, String>(0)?,
              "title": row.get::<_, String>(1)?,
              "type": row.get::<_, String>(2)?,
              "year": row.get::<_, Option<i32>>(3)?,
              "rating": row.get::<_, Option<f64>>(4)?,
              "poster_path": row.get::<_, Option<String>>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // Get total count
    let count_sql = format!("SELECT COUNT(*) FROM library_items WHERE {}", where_sql);
    let total: i32 = conn
        .query_row(&count_sql, [], |row| row.get(0))
        .unwrap_or(0);

    Ok(serde_json::json!({
      "items": items,
      "total": total,
      "limit": limit,
      "offset": offset,
    }))
}

#[tauri::command]
fn get_viewing_statistics(db: tauri::State<AppDb>) -> Result<serde_json::Value, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    // Get total items watched
    let total_watched: i32 = conn
        .query_row(
            "SELECT COUNT(DISTINCT item_id) FROM watch_history WHERE is_completed = 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // Get total hours watched (sum of watch history durations in seconds / 3600)
    let total_seconds: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM watch_history",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let total_hours = (total_seconds as f64) / 3600.0;

    // Get watch count by type
    let mut stmt = conn
        .prepare(
            "SELECT li.type, COUNT(*) as count 
       FROM watch_history wh
       JOIN library_items li ON wh.item_id = li.id
       GROUP BY li.type",
        )
        .map_err(|e| e.to_string())?;

    let watches_by_type = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
              "type": row.get::<_, String>(0)?,
              "count": row.get::<_, i32>(1)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();

    // Get most watched items
    let mut stmt = conn
        .prepare(
            "SELECT li.id, li.title, li.type, COUNT(*) as watch_count
       FROM watch_history wh
       JOIN library_items li ON wh.item_id = li.id
       GROUP BY wh.item_id
       ORDER BY watch_count DESC
       LIMIT 10",
        )
        .map_err(|e| e.to_string())?;

    let most_watched = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
              "id": row.get::<_, String>(0)?,
              "title": row.get::<_, String>(1)?,
              "type": row.get::<_, String>(2)?,
              "watch_count": row.get::<_, i32>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();

    // Get watch trends over past 30 days
    let mut stmt = conn
        .prepare(
            "SELECT DATE(watched_at) as date, COUNT(*) as count
       FROM watch_history
       WHERE watched_at > datetime('now', '-30 days')
       GROUP BY DATE(watched_at)
       ORDER BY date DESC",
        )
        .map_err(|e| e.to_string())?;

    let watch_trends = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
              "date": row.get::<_, String>(0)?,
              "count": row.get::<_, i32>(1)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();

    Ok(serde_json::json!({
      "total_items_watched": total_watched,
      "total_hours_watched": total_hours,
      "watches_by_type": watches_by_type,
      "most_watched_items": most_watched,
      "watch_trends_30_days": watch_trends,
    }))
}

#[tauri::command]
fn get_favorite_genres(
    db: tauri::State<AppDb>,
    limit: i32,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    // This is a simplified version - in production you'd parse genres from metadata_json
    let mut stmt = conn
        .prepare(
            "SELECT li.id, li.metadata_json, COUNT(*) as watch_count
       FROM watch_history wh
       JOIN library_items li ON wh.item_id = li.id
       WHERE li.metadata_json IS NOT NULL AND li.metadata_json != '{}'
       GROUP BY wh.item_id
       ORDER BY watch_count DESC
       LIMIT ?",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
    .query_map(params![limit], |row| {
      let metadata: serde_json::Value = row
        .get::<_, String>(1)
        .and_then(|m| Ok(serde_json::from_str(&m).unwrap_or_default()))
        .unwrap_or_default();

      Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "watch_count": row.get::<_, i32>(2)?,
        "genres": metadata.get("genres").and_then(|g| g.as_array()).map(|g| g.clone()).unwrap_or_default(),
      }))
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .unwrap_or_default();

    Ok(items)
}

#[tauri::command]
fn get_daily_watch_stats(
    db: tauri::State<AppDb>,
    days: i32,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut stmt = conn
        .prepare(&format!(
            "SELECT DATE(watched_at) as date, COUNT(*) as watch_count, 
                SUM(duration_seconds) / 3600.0 as hours_watched
         FROM watch_history
         WHERE watched_at > datetime('now', '-{} days')
         GROUP BY DATE(watched_at)
         ORDER BY date ASC",
            days
        ))
        .map_err(|e| e.to_string())?;

    let stats = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
              "date": row.get::<_, String>(0)?,
              "watch_count": row.get::<_, i32>(1)?,
              "hours_watched": row.get::<_, f64>(2)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();

    Ok(stats)
}

fn main() {
    let db = AppDb::open().expect("failed to open app database");
    tauri::Builder::default()
        .manage(db)
        .manage(PlayerProc::new())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            debug_log,
            player_get_state,
            player_play_item,
            player_play_path,
            player_set_overlay_region,
            player_stop,
            player_get_playback_info,
            player_set_pause,
            player_toggle_pause,
            player_seek_relative,
            player_get_render_settings,
            player_set_volume,
            player_adjust_volume,
            player_set_brightness,
            player_adjust_brightness,
            player_set_subtitle_style,
            player_get_resume_position,
            player_set_resume_position,
            player_clear_resume_position,
            player_list_tracks,
            player_set_audio_track,
            player_set_subtitle_track,
            player_list_external_subtitles,
            player_add_external_subtitle,
            player_remove_external_subtitle,
            metadata_search,
            metadata_get_details,
            metadata_get_cache_directory,
            metadata_set_cache_directory,
            metadata_cache_image,
            library_scan_tv_show,
            // Phase 2.1: Real database queries
            get_library_stats,
            search_library,
            get_dashboard_items,
            get_item_detail,
            save_progress,
            get_collections,
            get_collection_items,
            create_collection,
            add_to_collection,
            remove_from_collection,
            delete_collection,
            get_episodes,
            get_library_roots,
            get_library_items,
            debug_get_item_count,
            add_library_root,
            remove_library_root,
            scan_library_root,
            update_item_metadata,
            cache_tmdb_artwork,
            save_playback_progress,
            record_watch_history,
            get_playback_progress,
            get_watch_history,
            scan_subtitles,
            get_episodes,
            get_unmatched_items,
            search_by_genre,
            fetch_tmdb_collection,
            add_item_to_collection,
            get_collections_for_item,
            advanced_search,
            get_viewing_statistics,
            get_favorite_genres,
            get_daily_watch_stats,
            app_state_load,
            app_state_save
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
