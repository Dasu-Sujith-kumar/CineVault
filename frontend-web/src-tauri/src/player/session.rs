use super::{ipc, mpv};
use crate::{sync_player_process_state, truncate_for_log};
use serde_json::json;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::Manager;

use super::types::PlayerProc;

fn should_retry_ipc_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("pipe is being closed")
        || lower.contains("os error 232")
        || lower.contains("channel closed")
        || lower.contains("not connected")
        || lower.contains("disconnected")
        || lower.contains("timed out")
        || lower.contains("eof")
}

fn reconnect_ipc_for_media(
    player: &tauri::State<PlayerProc>,
    _app_handle: &tauri::AppHandle,
    media_key: &str,
) -> Result<ipc::MpvIpc, String> {
    let existing = player
        .ipc
        .lock()
        .map_err(|_| "player mutex poisoned".to_string())?
        .clone()
        .ok_or_else(|| "mpv IPC is not initialized".to_string())?;

    eprintln!(
        "mpv IPC reconnect requested (media_key=\"{}\")",
        truncate_for_log(media_key, 80)
    );
    ipc::request_reconnect(&existing);
    ipc::wait_for_ipc_connected(&existing, Duration::from_secs(8))?;
    let _ = ipc::refresh_ipc_snapshot(&existing);
    ipc::emit_playback_event(&existing, true);
    Ok(existing)
}

fn restart_mpv_for_media_if_dead(
    player: &tauri::State<PlayerProc>,
    app_handle: &tauri::AppHandle,
    media_key: &str,
) -> Result<(), String> {
    let last = player
        .last_media_key
        .lock()
        .map_err(|_| "player mutex poisoned".to_string())?
        .clone();
    if last.as_deref() != Some(media_key) {
        return Err("mpv process is not running".to_string());
    }

    let window = app_handle
        .get_webview_window("player")
        .ok_or_else(|| "player window not found".to_string())?;

    let extra_subs = player
        .last_extra_subs
        .lock()
        .map_err(|_| "player mutex poisoned".to_string())?
        .clone();

    eprintln!(
        "mpv process is dead for media_key=\"{}\", restarting mpv",
        truncate_for_log(media_key, 140)
    );

    // Best-effort resume near last known position (if any).
    let start_position_seconds = player
        .ipc
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(ipc::read_cached_playback_info))
        .and_then(|info| info.time_pos_seconds);

    mpv::play_path_spawn_mpv(
        window,
        player,
        media_key.to_string(),
        start_position_seconds,
        extra_subs,
    )?;
    Ok(())
}

pub fn require_ipc_for_media(
    player: &tauri::State<PlayerProc>,
    app_handle: &tauri::AppHandle,
    media_key: &str,
) -> Result<ipc::MpvIpc, String> {
    if !sync_player_process_state(player)? {
        // Case B: process dead -> restart mpv (only if it was previously playing this media key).
        restart_mpv_for_media_if_dead(player, app_handle, media_key)?;
    }

    let now = player
        .now_playing
        .lock()
        .map_err(|_| "player mutex poisoned".to_string())?;
    if now.as_deref() != Some(media_key) {
        return Err("mpv is not playing the selected media path".to_string());
    }
    drop(now);

    let ipc_handle = player
        .ipc
        .lock()
        .map_err(|_| "player mutex poisoned".to_string())?
        .clone();
    if let Some(ipc_handle) = ipc_handle {
        if ipc_handle.inner.connected.load(Ordering::SeqCst) {
            return Ok(ipc_handle);
        }
    }

    // Case A/C: pipe closed or write failed -> reconnect IPC (no mpv restart).
    reconnect_ipc_for_media(player, app_handle, media_key)
}

pub fn with_ipc_retry<T, F>(
    player: &tauri::State<PlayerProc>,
    app_handle: &tauri::AppHandle,
    media_key: &str,
    mut op: F,
) -> Result<(ipc::MpvIpc, T), String>
where
    F: FnMut(&ipc::MpvIpc) -> Result<T, String>,
{
    let ipc_handle = require_ipc_for_media(player, app_handle, media_key)?;
    match op(&ipc_handle) {
        Ok(value) => Ok((ipc_handle, value)),
        Err(err) if should_retry_ipc_error(&err) => {
            // Avoid reconnect spam: on pure timeouts while we still think we're connected, bubble up.
            {
                let lower = err.to_ascii_lowercase();
                if lower.contains("mpv ipc request timed out")
                    && ipc_handle.inner.connected.load(Ordering::SeqCst)
                {
                    return Err(err);
                }
            }
            eprintln!(
                "mpv IPC command failed for media_key=\"{}\", retrying after reconnect: {err}",
                truncate_for_log(media_key, 140)
            );
            let ipc_handle = reconnect_ipc_for_media(player, app_handle, media_key)?;
            let value = op(&ipc_handle)?;
            Ok((ipc_handle, value))
        }
        Err(err) => Err(err),
    }
}

pub fn spawn_pause_reconcile(app_handle: tauri::AppHandle, media_key: String, desired_pause: bool) {
    std::thread::spawn(move || {
        // Give mpv a moment to process the command and emit observe_property events.
        std::thread::sleep(Duration::from_millis(220));

        let player = app_handle.state::<PlayerProc>();
        let now_playing = player.now_playing.lock().ok().and_then(|g| g.clone());
        if now_playing.as_deref() != Some(media_key.as_str()) {
            return;
        }

        let Some(ipc_handle) = player.ipc.lock().ok().and_then(|g| g.clone()) else {
            return;
        };

        // Debounce: avoid spam when user double-taps or multiple UI paths trigger toggles.
        let now_ms = crate::now_epoch_ms_u64();
        let last_ms = ipc_handle
            .inner
            .last_pause_reconcile_at_ms
            .load(Ordering::Relaxed);
        if last_ms != 0 && now_ms.saturating_sub(last_ms) < 300 {
            return;
        }
        ipc_handle
            .inner
            .last_pause_reconcile_at_ms
            .store(now_ms, Ordering::Relaxed);

        let observed = ipc_handle.inner.paused.lock().ok().and_then(|g| *g);
        if observed == Some(desired_pause) {
            return;
        }

        // Health check (request/response) to detect "write succeeded but mpv isn't consuming".
        let ping = ipc::mpv_request_timeout(
            &ipc_handle,
            json!({ "command": ["get_property", "pause"] }),
            Duration::from_millis(450),
        );

        match ping {
            Ok(resp) => {
                if ipc::mpv_expect_success(&resp).is_err() {
                    return;
                }
                let paused = resp.get("data").and_then(|v| v.as_bool());
                if paused == Some(desired_pause) {
                    // Observer likely lagged; cache update happens on next property-change.
                    return;
                }

                // mpv is responsive but state didn't change -> resend once.
                let _ = ipc::mpv_send(
                    &ipc_handle,
                    json!({ "command": ["set_property", "pause", desired_pause] }),
                );
            }
            Err(err) => {
                // Treat as IPC stale/dead: force reconnect and retry once.
                eprintln!("mpv IPC pause health-check failed: {err}");
                ipc_handle.inner.connected.store(false, Ordering::SeqCst);
                ipc::request_reconnect(&ipc_handle);
                let _ = ipc::wait_for_ipc_connected(&ipc_handle, Duration::from_secs(3));
                let _ = ipc::mpv_send(
                    &ipc_handle,
                    json!({ "command": ["set_property", "pause", desired_pause] }),
                );
            }
        }
    });
}
