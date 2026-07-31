use crate::player::types::{
    PlaybackInfo, PlayerProc, PlayerRenderSettings, PlayerState, PlayerTracks,
};
use crate::player::{ipc, mpv, session};
use crate::{
    kill_child_quick, stop_player_activity_watcher, sync_player_process_state, truncate_for_log,
    AppDb,
};
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

#[tauri::command]
pub fn player_get_state(player: tauri::State<PlayerProc>) -> PlayerState {
    let running = sync_player_process_state(&player).unwrap_or(false);
    let mut now_playing: Option<String> = None;

    let ipc_connected = if let Ok(guard) = player.ipc.lock() {
        guard
            .as_ref()
            .map(|ipc| ipc.inner.connected.load(Ordering::SeqCst))
            .unwrap_or(false)
    } else {
        false
    };

    let connected = running && ipc_connected;

    if running {
        if let Ok(guard) = player.now_playing.lock() {
            now_playing = guard.clone();
        }
    }

    PlayerState {
        connected,
        status: if connected {
            "running".to_string()
        } else if running {
            "connecting".to_string()
        } else {
            "idle".to_string()
        },
        now_playing,
    }
}

#[tauri::command]
pub fn player_play_item(
    item_id: String,
    start_position_seconds: Option<f64>,
) -> Result<(), String> {
    println!(
        "player_play_item (stub): {} (start_position_seconds={:?})",
        item_id, start_position_seconds
    );
    Ok(())
}

#[tauri::command]
pub fn player_play_path(
    window: tauri::WebviewWindow,
    player: tauri::State<PlayerProc>,
    db: tauri::State<AppDb>,
    media_path: String,
    start_position_seconds: Option<f64>,
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

    // Read any stored external subtitle paths for this file and add them at launch.
    let extra_subs: Vec<String> =
        {
            let conn = db
                .conn
                .lock()
                .map_err(|_| "db mutex poisoned".to_string())?;

            let mut stmt = conn
      .prepare("SELECT path FROM external_subtitles WHERE item_id = ?1 ORDER BY added_at_ms ASC")
      .map_err(|e| e.to_string())?;

            let rows = stmt
                .query_map(params![media_path.clone()], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;

            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
            out
        };

    mpv::play_path_spawn_mpv(
        window,
        &player,
        media_path,
        start_position_seconds,
        extra_subs,
    )
}

#[tauri::command]
pub fn player_stop(player: tauri::State<PlayerProc>) -> Result<(), String> {
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
    if let Ok(mut guard) = player.last_media_key.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = player.last_extra_subs.lock() {
        guard.clear();
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
    player.clear_overlay_insets();
    Ok(())
}

#[tauri::command]
pub fn player_get_resume_position(
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
pub fn player_set_resume_position(
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
pub fn player_clear_resume_position(
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

#[tauri::command]
pub fn player_get_playback_info(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
) -> Result<PlaybackInfo, String> {
    let ipc_handle = match session::require_ipc_for_media(&player, &app_handle, &media_key) {
        Ok(ipc) => ipc,
        Err(err) => {
            // When the player isn't running, the library page still asks for playback info to show
            // "Idle" status. Treat "mpv process is not running" as a non-fatal empty snapshot.
            if err
                .to_ascii_lowercase()
                .contains("mpv process is not running")
            {
                return Ok(PlaybackInfo {
                    time_pos_seconds: None,
                    duration_seconds: None,
                    paused: None,
                });
            }
            return Err(err);
        }
    };
    let mut info = ipc::read_cached_playback_info(&ipc_handle);
    if info.time_pos_seconds.is_none() && info.duration_seconds.is_none() && info.paused.is_none() {
        let _ = ipc::refresh_ipc_snapshot(&ipc_handle);
        info = ipc::read_cached_playback_info(&ipc_handle);
    }
    Ok(info)
}

#[tauri::command]
pub fn player_set_pause(
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
    eprintln!("🔍 player_set_pause: calling with_ipc_retry");
    let (ipc, _) = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
        let command = json!({ "command": ["set_property", "pause", pause] });
        let connected = ipc
            .inner
            .connected
            .load(std::sync::atomic::Ordering::SeqCst);
        eprintln!(
            "📤 player_set_pause: connected={} sending mpv command: {}",
            connected, command
        );
        ipc::mpv_send(ipc, command)
    })?;
    ipc::emit_playback_event(&ipc, true);
    // Non-blocking reliability: if the state doesn't flip shortly, reconnect IPC and retry once.
    session::spawn_pause_reconcile(app_handle, media_key, pause);
    Ok(())
}

#[tauri::command]
pub fn player_toggle_pause(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
) -> Result<(), String> {
    let (ipc, _) = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
        ipc::mpv_send_untracked(ipc, json!({ "command": ["cycle", "pause"] }))
    })?;
    ipc::emit_playback_event(&ipc, true);
    Ok(())
}

#[tauri::command]
pub fn player_seek_relative(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
    delta_seconds: f64,
) -> Result<(), String> {
    let (ipc, _) = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
        ipc::mpv_send(
            ipc,
            json!({ "command": ["seek", delta_seconds, "relative", "exact"] }),
        )
    })?;
    ipc::emit_playback_event(&ipc, true);
    Ok(())
}

#[tauri::command]
pub fn player_get_render_settings(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
) -> Result<PlayerRenderSettings, String> {
    let (_, settings) = session::with_ipc_retry(
        &player,
        &app_handle,
        &media_key,
        ipc::mpv_read_render_settings,
    )?;
    Ok(settings)
}

#[tauri::command]
pub fn player_set_volume(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
    volume: f64,
) -> Result<f64, String> {
    let (_, next) = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
        let next = clamp_volume(volume);
        ipc::mpv_set_f64_property(ipc, "volume", next)?;
        Ok(next)
    })?;
    Ok(next)
}

#[tauri::command]
pub fn player_adjust_volume(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
    delta: f64,
) -> Result<f64, String> {
    let (_, next) = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
        let current = ipc::mpv_get_f64_property(ipc, "volume")?.unwrap_or(100.0);
        let next = clamp_volume(current + delta);
        ipc::mpv_set_f64_property(ipc, "volume", next)?;
        Ok(next)
    })?;
    Ok(next)
}

#[tauri::command]
pub fn player_set_brightness(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
    brightness: f64,
) -> Result<f64, String> {
    let (_, next) = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
        let next = clamp_brightness(brightness);
        ipc::mpv_set_f64_property(ipc, "brightness", next)?;
        Ok(next)
    })?;
    Ok(next)
}

#[tauri::command]
pub fn player_adjust_brightness(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
    delta: f64,
) -> Result<f64, String> {
    let (_, next) = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
        let current = ipc::mpv_get_f64_property(ipc, "brightness")?.unwrap_or(0.0);
        let next = clamp_brightness(current + delta);
        ipc::mpv_set_f64_property(ipc, "brightness", next)?;
        Ok(next)
    })?;
    Ok(next)
}

#[tauri::command]
pub fn player_set_subtitle_style(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
    font_size: Option<f64>,
    border_size: Option<f64>,
    shadow_offset: Option<f64>,
    position: Option<f64>,
) -> Result<PlayerRenderSettings, String> {
    let (_, settings) = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
        if let Some(value) = font_size {
            ipc::mpv_set_f64_property(ipc, "sub-font-size", clamp_sub_font_size(value))?;
        }
        if let Some(value) = border_size {
            ipc::mpv_set_f64_property(ipc, "sub-border-size", clamp_sub_border_size(value))?;
        }
        if let Some(value) = shadow_offset {
            ipc::mpv_set_f64_property(ipc, "sub-shadow-offset", clamp_sub_shadow_offset(value))?;
        }
        if let Some(value) = position {
            ipc::mpv_set_f64_property(ipc, "sub-pos", clamp_sub_position(value))?;
        }
        ipc::mpv_read_render_settings(ipc)
    })?;
    Ok(settings)
}

#[tauri::command]
pub fn player_list_tracks(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
) -> Result<PlayerTracks, String> {
    let ipc = session::require_ipc_for_media(&player, &app_handle, &media_key)?;

    if let Ok(guard) = ipc.inner.tracks.lock() {
        if let Some(cached) = guard.as_ref() {
            return Ok(cached.clone());
        }
    }

    for _ in 0..24 {
        thread::sleep(Duration::from_millis(25));
        if let Ok(guard) = ipc.inner.tracks.lock() {
            if let Some(cached) = guard.as_ref() {
                return Ok(cached.clone());
            }
        }
    }

    let (_, tracks) =
        session::with_ipc_retry(&player, &app_handle, &media_key, ipc::refresh_track_cache)?;
    Ok(tracks)
}

#[tauri::command]
pub fn player_set_audio_track(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
    track_id: i64,
) -> Result<(), String> {
    let _ = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
        ipc::mpv_send(ipc, json!({ "command": ["set_property", "aid", track_id] }))?;
        let _ = ipc::refresh_track_cache(ipc);
        Ok(())
    })?;
    Ok(())
}

#[tauri::command]
pub fn player_set_subtitle_track(
    player: tauri::State<PlayerProc>,
    app_handle: tauri::AppHandle,
    media_key: String,
    track_id: i64,
) -> Result<(), String> {
    let _ = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
        ipc::mpv_send(ipc, json!({ "command": ["set_property", "sid", track_id] }))?;
        let _ = ipc::refresh_track_cache(ipc);
        Ok(())
    })?;
    Ok(())
}

#[tauri::command]
pub fn player_list_external_subtitles(
    db: tauri::State<AppDb>,
    media_key: String,
) -> Result<Vec<String>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    let mut stmt = conn
        .prepare("SELECT path FROM external_subtitles WHERE item_id = ?1 ORDER BY added_at_ms DESC")
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

#[tauri::command]
pub fn player_add_external_subtitle(
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

    conn.execute(
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

    if is_current_media {
        let _ = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            ipc::mpv_send(
                ipc,
                json!({ "command": ["sub-add", path.clone(), "select"] }),
            )?;
            let _ = ipc::refresh_track_cache(ipc);
            Ok(())
        });
    }

    Ok(())
}

#[tauri::command]
pub fn player_remove_external_subtitle(
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
        let _ = session::with_ipc_retry(&player, &app_handle, &media_key, |ipc| {
            ipc::remove_live_external_subtitle(ipc, &path)
        });
    }

    Ok(())
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
