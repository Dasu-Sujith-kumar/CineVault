use super::types::{
    PlaybackInfo, PlayerPlaybackEventPayload, PlayerRenderSettings, PlayerTrack, PlayerTracks,
};
use crate::{now_epoch_ms_u64, truncate_for_log, AppDb};
use rusqlite::params;
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::Manager;

pub const PLAYER_PLAYBACK_EVENT: &str = "cinevault:player-playback";

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows::Win32::Foundation::HANDLE;
#[cfg(windows)]
use windows::Win32::System::Pipes::PeekNamedPipe;

fn ipc_trace_enabled() -> bool {
    std::env::var("CINEVAULT_MPV_IPC_TRACE")
        .ok()
        .map(|v| !v.trim().is_empty() && v.trim() != "0" && v.to_ascii_lowercase() != "false")
        .unwrap_or(false)
}

#[cfg(windows)]
fn named_pipe_available_bytes(stream: &MpvStream) -> std::io::Result<u32> {
    unsafe {
        let handle = HANDLE(stream.as_raw_handle() as *mut std::ffi::c_void);
        let mut avail: u32 = 0;
        // PeekNamedPipe returns false on error; we rely on GetLastError via windows crate mapping.
        PeekNamedPipe(handle, None, 0, None, Some(&mut avail), None).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("PeekNamedPipe failed: {e}"),
            )
        })?;
        Ok(avail)
    }
}

#[cfg(windows)]
type MpvStream = std::fs::File;
#[cfg(not(windows))]
type MpvStream = std::os::unix::net::UnixStream;

#[cfg(windows)]
fn connect_mpv_ipc_once(ipc_path: &str) -> std::io::Result<MpvStream> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(ipc_path)
}

#[cfg(not(windows))]
fn connect_mpv_ipc_once(ipc_path: &str) -> std::io::Result<MpvStream> {
    use std::os::unix::net::UnixStream;
    UnixStream::connect(ipc_path)
}

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

fn is_pipe_closed_error(err: &std::io::Error) -> bool {
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("broken pipe")
        || msg.contains("pipe is being closed")
        || msg.contains("not connected")
        || msg.contains("closed")
        || matches!(err.raw_os_error(), Some(232) | Some(109) | Some(233))
}

fn mpv_payload_summary(payload: &JsonValue) -> String {
    let cmd = payload.get("command").unwrap_or(payload);
    truncate_for_log(&cmd.to_string(), 220)
}

pub fn ipc_debug_state(ipc: &MpvIpc) -> String {
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
    let ipc_path = truncate_for_log(&ipc.inner.ipc_path, 140);
    let media_key = truncate_for_log(&ipc.inner.media_key, 80);
    format!(
    "ipc_path=\"{ipc_path}\" pid={pid} media_key=\"{media_key}\" connected={connected} since_tx_ms={since_tx} since_rx_ms={since_rx} (last_tx_ms={last_tx} last_rx_ms={last_rx})"
  )
}

#[derive(Clone)]
pub struct MpvIpc {
    pub inner: Arc<MpvIpcInner>,
}

pub struct MpvIpcInner {
    tx: mpsc::Sender<IpcRequest>,
    next_request_id: AtomicU64,
    pub(crate) connected: AtomicBool,
    conn_gen: AtomicU64,
    pub(crate) last_pause_reconcile_at_ms: AtomicU64,
    reconnect_tx: mpsc::Sender<()>,
    reconnect_pending: AtomicBool,
    ipc_path: String,
    mpv_pid: u32,
    media_key: String,
    app_handle: tauri::AppHandle,
    last_tx_at_ms: AtomicU64,
    last_rx_at_ms: AtomicU64,
    playback_seq: AtomicU64,
    last_playback_emit_at_ms: AtomicU64,

    pub(crate) time_pos_seconds: Mutex<Option<f64>>,
    pub(crate) duration_seconds: Mutex<Option<f64>>,
    pub(crate) paused: Mutex<Option<bool>>,
    pub(crate) tracks: Mutex<Option<PlayerTracks>>,
}

struct IpcRequest {
    request_id: u64,
    payload: JsonValue,
    resp: Option<mpsc::Sender<Result<JsonValue, String>>>,
    retries_left: u8,
}

pub fn start_mpv_ipc(
    app_handle: tauri::AppHandle,
    ipc_path: String,
    media_key: String,
    mpv_pid: u32,
) -> MpvIpc {
    let (tx, rx) = mpsc::channel::<IpcRequest>();

    // Streams are distributed to writer/reader separately. (Receiver isn't clonable.)
    let (writer_stream_tx, writer_stream_rx) = mpsc::channel::<MpvStream>();
    let (reader_stream_tx, reader_stream_rx) = mpsc::channel::<MpvStream>();

    let (reconnect_tx, reconnect_rx) = mpsc::channel::<()>();

    let inner = Arc::new(MpvIpcInner {
        tx,
        next_request_id: AtomicU64::new(1),
        connected: AtomicBool::new(false),
        conn_gen: AtomicU64::new(0),
        last_pause_reconcile_at_ms: AtomicU64::new(0),
        reconnect_tx: reconnect_tx.clone(),
        reconnect_pending: AtomicBool::new(false),
        ipc_path: ipc_path.clone(),
        mpv_pid,
        media_key: media_key.clone(),
        app_handle: app_handle.clone(),
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

    // Pending map only used for request/response commands.
    let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<JsonValue, String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Connection manager: reconnect only when requested (no spam).
    {
        let handle_for_mgr = handle.clone();
        let ipc_path_for_mgr = ipc_path.clone();
        let writer_stream_tx = writer_stream_tx.clone();
        let reader_stream_tx = reader_stream_tx.clone();
        thread::spawn(move || {
            while reconnect_rx.recv().is_ok() {
                handle_for_mgr
                    .inner
                    .reconnect_pending
                    .store(false, Ordering::SeqCst);
                // Drain any extra reconnect requests.
                while reconnect_rx.try_recv().is_ok() {}

                match connect_mpv_ipc_with_retry(&ipc_path_for_mgr) {
                    Ok(stream) => {
                        let read_stream = match stream.try_clone() {
                            Ok(s) => s,
                            Err(e) => {
                                eprintln!("mpv IPC try_clone failed: {e}");
                                continue;
                            }
                        };
                        let conn_gen = handle_for_mgr
                            .inner
                            .conn_gen
                            .fetch_add(1, Ordering::SeqCst)
                            .saturating_add(1);
                        handle_for_mgr.inner.connected.store(true, Ordering::SeqCst);
                        let now = now_epoch_ms_u64();
                        handle_for_mgr
                            .inner
                            .last_tx_at_ms
                            .store(now, Ordering::SeqCst);
                        handle_for_mgr
                            .inner
                            .last_rx_at_ms
                            .store(now, Ordering::SeqCst);
                        eprintln!(
                            "mpv IPC connected: {} (conn_gen={} pid={} media_key=\"{}\")",
                            ipc_path_for_mgr,
                            conn_gen,
                            handle_for_mgr.inner.mpv_pid,
                            truncate_for_log(&handle_for_mgr.inner.media_key, 80)
                        );

                        let _ = writer_stream_tx.send(stream);
                        let _ = reader_stream_tx.send(read_stream);

                        // Observers: fire-and-forget (no waiting).
                        let _ = register_mpv_observers(&handle_for_mgr);

                        // One-off snapshot after connect (best-effort; not polling).
                        {
                            let ipc_for_snapshot = handle_for_mgr.clone();
                            thread::spawn(move || {
                                let _ = wait_for_ipc_connected(
                                    &ipc_for_snapshot,
                                    Duration::from_secs(8),
                                );
                                let _ = refresh_ipc_snapshot(&ipc_for_snapshot);
                                emit_playback_event(&ipc_for_snapshot, true);
                            });
                        }

                        emit_playback_event(&handle_for_mgr, true);
                    }
                    Err(e) => {
                        handle_for_mgr
                            .inner
                            .connected
                            .store(false, Ordering::SeqCst);
                        eprintln!("mpv IPC connect failed: {}", e);
                        emit_playback_event(&handle_for_mgr, true);
                    }
                }
            }
        });
    }

    // Writer thread: writes commands; Case C -> reconnect and retry once.
    {
        let handle_for_writer = handle.clone();
        let pending_for_writer = pending.clone();
        thread::spawn(move || {
            let mut out: Option<MpvStream> = None;
            let mut current_conn_gen: u64 = 0;
            loop {
                if out.is_none() {
                    match writer_stream_rx.recv() {
                        Ok(s) => {
                            out = Some(s);
                            current_conn_gen =
                                handle_for_writer.inner.conn_gen.load(Ordering::SeqCst);
                            if ipc_trace_enabled() {
                                eprintln!("mpv IPC writer attached (conn_gen={current_conn_gen})");
                            }
                            emit_playback_event(&handle_for_writer, true);
                        }
                        Err(_) => break,
                    }
                }

                let mut req = match rx.recv() {
                    Ok(r) => r,
                    Err(_) => break,
                };

                let Some(stream) = out.take() else {
                    continue;
                };

                if let Some(resp_tx) = req.resp.take() {
                    if let Ok(mut map) = pending_for_writer.lock() {
                        map.insert(req.request_id, resp_tx);
                    }
                }

                let summary = mpv_payload_summary(&req.payload);
                let s = req.payload.to_string();
                let write_start = Instant::now();
                if ipc_trace_enabled() {
                    eprintln!(
                        "mpv IPC write begin (conn_gen={} id={} {})",
                        current_conn_gen, req.request_id, summary
                    );
                }

                // Never let the writer thread block indefinitely on a named-pipe write.
                // If the server isn't reading, consider IPC broken and reconnect.
                let timeout = Duration::from_millis(900);
                let (stream, write_result) = match write_json_line_with_timeout(stream, s, timeout)
                {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!(
                            "mpv IPC write timed out (conn_gen={} id={} {}): {} {}",
                            current_conn_gen,
                            req.request_id,
                            summary,
                            e,
                            ipc_debug_state(&handle_for_writer)
                        );
                        handle_for_writer
                            .inner
                            .connected
                            .store(false, Ordering::SeqCst);
                        fail_pending_requests(
                            &pending_for_writer,
                            "mpv IPC disconnected".to_string(),
                        );
                        emit_playback_event(&handle_for_writer, true);
                        request_reconnect(&handle_for_writer);
                        out = None;

                        if req.retries_left > 0 {
                            req.retries_left -= 1;
                            let _ = handle_for_writer.inner.tx.send(req);
                        }
                        continue;
                    }
                };

                match write_result {
                    Ok(()) => {
                        handle_for_writer
                            .inner
                            .last_tx_at_ms
                            .store(now_epoch_ms_u64(), Ordering::SeqCst);
                        if ipc_trace_enabled() {
                            eprintln!(
                                "mpv IPC write end (conn_gen={} id={} {}) elapsed_ms={}",
                                current_conn_gen,
                                req.request_id,
                                summary,
                                write_start.elapsed().as_millis()
                            );
                        }
                        out = Some(stream);
                    }
                    Err(e) => {
                        eprintln!(
                            "mpv IPC write failed (conn_gen={} id={} {}): {} {}",
                            current_conn_gen,
                            req.request_id,
                            summary,
                            e,
                            ipc_debug_state(&handle_for_writer)
                        );
                        handle_for_writer
                            .inner
                            .connected
                            .store(false, Ordering::SeqCst);
                        fail_pending_requests(
                            &pending_for_writer,
                            "mpv IPC disconnected".to_string(),
                        );
                        emit_playback_event(&handle_for_writer, true);

                        request_reconnect(&handle_for_writer);
                        out = None;

                        if req.retries_left > 0 {
                            req.retries_left -= 1;
                            let _ = handle_for_writer.inner.tx.send(req);
                        }
                    }
                }
            }
        });
    }

    // Reader thread: drains mpv events; Case A -> reconnect on EOF/pipe closed.
    {
        let handle_for_reader = handle.clone();
        let pending_for_reader = pending.clone();
        thread::spawn(move || {
            #[cfg(not(windows))]
            {
                use std::io::{BufRead, BufReader};
                loop {
                    let mut reader = match reader_stream_rx.recv() {
                        Ok(s) => BufReader::new(s),
                        Err(_) => break,
                    };
                    let current_conn_gen = handle_for_reader.inner.conn_gen.load(Ordering::SeqCst);
                    if ipc_trace_enabled() {
                        eprintln!("mpv IPC reader attached (conn_gen={current_conn_gen})");
                    }

                    let mut line = String::new();
                    loop {
                        line.clear();
                        match reader.read_line(&mut line) {
                            Ok(0) => {
                                handle_for_reader
                                    .inner
                                    .connected
                                    .store(false, Ordering::SeqCst);
                                fail_pending_requests(
                                    &pending_for_reader,
                                    "mpv IPC disconnected".to_string(),
                                );
                                emit_playback_event(&handle_for_reader, true);
                                request_reconnect(&handle_for_reader);
                                if ipc_trace_enabled() {
                                    eprintln!("mpv IPC EOF (conn_gen={current_conn_gen})");
                                }
                                break;
                            }
                            Ok(_) => {}
                            Err(e) => {
                                handle_for_reader
                                    .inner
                                    .connected
                                    .store(false, Ordering::SeqCst);
                                fail_pending_requests(
                                    &pending_for_reader,
                                    format!("mpv IPC read failed: {e}"),
                                );
                                emit_playback_event(&handle_for_reader, true);
                                if is_pipe_closed_error(&e) {
                                    request_reconnect(&handle_for_reader);
                                }
                                if ipc_trace_enabled() {
                                    eprintln!(
                                        "mpv IPC read error (conn_gen={current_conn_gen}): {e}"
                                    );
                                }
                                break;
                            }
                        }

                        handle_for_reader
                            .inner
                            .last_rx_at_ms
                            .store(now_epoch_ms_u64(), Ordering::SeqCst);

                        handle_incoming_line(&handle_for_reader, &pending_for_reader, line.trim());
                    }
                }
            }

            #[cfg(windows)]
            {
                let mut stream: Option<MpvStream> = None;
                let mut inbuf: Vec<u8> = Vec::with_capacity(8192);
                let mut current_conn_gen: u64 = 0;

                loop {
                    // If we don't have a stream yet, block for one.
                    if stream.is_none() {
                        match reader_stream_rx.recv() {
                            Ok(s) => {
                                current_conn_gen =
                                    handle_for_reader.inner.conn_gen.load(Ordering::SeqCst);
                                if ipc_trace_enabled() {
                                    eprintln!(
                                        "mpv IPC reader attached (conn_gen={current_conn_gen})"
                                    );
                                }
                                stream = Some(s);
                                inbuf.clear();
                            }
                            Err(_) => break,
                        }
                    }

                    // Hot-swap to the latest stream if reconnect created a new connection.
                    while let Ok(s) = reader_stream_rx.try_recv() {
                        current_conn_gen = handle_for_reader.inner.conn_gen.load(Ordering::SeqCst);
                        if ipc_trace_enabled() {
                            eprintln!("mpv IPC reader swapped (conn_gen={current_conn_gen})");
                        }
                        stream = Some(s);
                        inbuf.clear();
                    }

                    let Some(s) = stream.as_mut() else { continue };

                    let avail = match named_pipe_available_bytes(s) {
                        Ok(v) => v,
                        Err(e) => {
                            handle_for_reader
                                .inner
                                .connected
                                .store(false, Ordering::SeqCst);
                            fail_pending_requests(
                                &pending_for_reader,
                                format!("mpv IPC read failed: {e}"),
                            );
                            emit_playback_event(&handle_for_reader, true);
                            request_reconnect(&handle_for_reader);
                            stream = None;
                            continue;
                        }
                    };

                    if avail == 0 {
                        // No data right now; avoid blocking forever so we can accept stream swaps.
                        thread::sleep(Duration::from_millis(8));
                        continue;
                    }

                    let mut tmp = vec![0u8; (avail.min(8192)) as usize];
                    match s.read(&mut tmp) {
                        Ok(0) => {
                            handle_for_reader
                                .inner
                                .connected
                                .store(false, Ordering::SeqCst);
                            fail_pending_requests(
                                &pending_for_reader,
                                "mpv IPC disconnected".to_string(),
                            );
                            emit_playback_event(&handle_for_reader, true);
                            request_reconnect(&handle_for_reader);
                            if ipc_trace_enabled() {
                                eprintln!("mpv IPC EOF (conn_gen={current_conn_gen})");
                            }
                            stream = None;
                            continue;
                        }
                        Ok(n) => {
                            handle_for_reader
                                .inner
                                .last_rx_at_ms
                                .store(now_epoch_ms_u64(), Ordering::SeqCst);
                            inbuf.extend_from_slice(&tmp[..n]);
                        }
                        Err(e) => {
                            handle_for_reader
                                .inner
                                .connected
                                .store(false, Ordering::SeqCst);
                            fail_pending_requests(
                                &pending_for_reader,
                                format!("mpv IPC read failed: {e}"),
                            );
                            emit_playback_event(&handle_for_reader, true);
                            if is_pipe_closed_error(&e) {
                                request_reconnect(&handle_for_reader);
                            }
                            if ipc_trace_enabled() {
                                eprintln!("mpv IPC read error (conn_gen={current_conn_gen}): {e}");
                            }
                            stream = None;
                            continue;
                        }
                    }

                    // Parse complete lines from inbuf.
                    loop {
                        let Some(pos) = inbuf.iter().position(|b| *b == b'\n') else {
                            break;
                        };
                        let line_bytes: Vec<u8> = inbuf.drain(..=pos).collect();
                        let line_str = String::from_utf8_lossy(&line_bytes);
                        let trimmed = line_str.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        handle_incoming_line(&handle_for_reader, &pending_for_reader, trimmed);
                    }
                }
            }
        });
    }

    // Ensure initial connection attempt.
    request_reconnect(&handle);

    handle
}

pub fn request_reconnect(ipc: &MpvIpc) {
    if !ipc.inner.reconnect_pending.swap(true, Ordering::SeqCst) {
        let _ = ipc.inner.reconnect_tx.send(());
    }
}

#[cfg(windows)]
fn write_json_line_with_timeout(
    stream: MpvStream,
    line: String,
    timeout: Duration,
) -> Result<(MpvStream, std::io::Result<()>), String> {
    // Windows named pipes can block indefinitely if the server stops reading (often because
    // the pipe is backpressured in the other direction). We must never block the writer thread.
    let (tx, rx) = mpsc::channel::<(MpvStream, std::io::Result<()>)>();
    thread::spawn(move || {
        let mut stream = stream;
        let res = (|| -> std::io::Result<()> {
            stream.write_all(line.as_bytes())?;
            stream.write_all(b"\n")?;
            Ok(())
        })();
        let _ = tx.send((stream, res));
    });

    match rx.recv_timeout(timeout) {
        Ok(v) => Ok(v),
        Err(mpsc::RecvTimeoutError::Timeout) => Err("mpv IPC write timed out".to_string()),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("mpv IPC write thread disconnected".to_string())
        }
    }
}

#[cfg(not(windows))]
fn write_json_line_with_timeout(
    mut stream: MpvStream,
    line: String,
    _timeout: Duration,
) -> Result<(MpvStream, std::io::Result<()>), String> {
    let res = (|| -> std::io::Result<()> {
        stream.write_all(line.as_bytes())?;
        stream.write_all(b"\n")?;
        Ok(())
    })();
    Ok((stream, res))
}

fn fast_handle_time_pos(ipc: &MpvIpc, line: &str) -> bool {
    if !line.contains("\"event\":\"property-change\"") || !line.contains("\"name\":\"time-pos\"") {
        return false;
    }
    // Try to extract `"data":<number>` without JSON parsing.
    let Some(idx) = line.find("\"data\"") else {
        return true;
    };
    let after = &line[idx + 6..];
    let Some(colon) = after.find(':') else {
        return true;
    };
    let mut s = after[colon + 1..].trim_start();
    if s.starts_with("null") {
        if let Ok(mut guard) = ipc.inner.time_pos_seconds.lock() {
            *guard = None;
        }
        emit_playback_event(ipc, false);
        return true;
    }
    // number ends at comma or }
    let end = s
        .find(|c: char| c == ',' || c == '}')
        .unwrap_or_else(|| s.len());
    s = &s[..end];
    if let Ok(v) = s.trim().parse::<f64>() {
        if let Ok(mut guard) = ipc.inner.time_pos_seconds.lock() {
            *guard = Some(v);
        }
        emit_playback_event(ipc, false);
    }
    true
}

fn handle_incoming_line(
    ipc: &MpvIpc,
    pending: &Arc<Mutex<HashMap<u64, mpsc::Sender<Result<JsonValue, String>>>>>,
    line: &str,
) {
    // Fast-path: time-pos events are frequent; avoid full JSON parse if possible.
    if fast_handle_time_pos(ipc, line) {
        return;
    }

    let Ok(msg) = serde_json::from_str::<JsonValue>(line) else {
        return;
    };

    if let Some(req_id) = msg.get("request_id").and_then(|v| v.as_u64()) {
        if let Ok(mut map) = pending.lock() {
            if let Some(tx) = map.remove(&req_id) {
                let _ = tx.send(Ok(msg));
            }
        }
        return;
    }

    let Some(event) = msg.get("event").and_then(|v| v.as_str()) else {
        return;
    };
    if event != "property-change" {
        return;
    }
    let Some(name) = msg.get("name").and_then(|v| v.as_str()) else {
        return;
    };
    let data = msg.get("data").cloned().unwrap_or(JsonValue::Null);

    match name {
        "duration" => {
            if let Ok(mut guard) = ipc.inner.duration_seconds.lock() {
                *guard = data.as_f64();
            }
            emit_playback_event(ipc, true);
        }
        "pause" => {
            let next_paused = data.as_bool();
            if let Ok(mut guard) = ipc.inner.paused.lock() {
                *guard = next_paused;
            }
            emit_playback_event(ipc, true);

            if next_paused == Some(true) {
                let ipc_for_resume = ipc.clone();
                thread::spawn(move || {
                    let _ = write_resume_position_best_effort(&ipc_for_resume);
                });
            }
        }
        "track-list" => {
            let tracks = parse_track_list(&data);
            if let Ok(mut guard) = ipc.inner.tracks.lock() {
                *guard = Some(tracks);
            }
            emit_playback_event(ipc, true);
        }
        _ => {}
    }
}

pub fn wait_for_ipc_connected(ipc: &MpvIpc, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if ipc.inner.connected.load(Ordering::SeqCst) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err("mpv IPC is not connected yet".to_string())
}

pub fn register_mpv_observers(ipc: &MpvIpc) -> Result<(), String> {
    // Strict rule: no polling. Observe properties and throttle emits to frontend.
    // Use untracked sends so mpv doesn't emit request_id replies for these.
    mpv_send_untracked(
        ipc,
        json!({ "command": ["observe_property", 1, "time-pos"] }),
    )?;
    mpv_send_untracked(
        ipc,
        json!({ "command": ["observe_property", 2, "duration"] }),
    )?;
    mpv_send_untracked(ipc, json!({ "command": ["observe_property", 3, "pause"] }))?;
    mpv_send_untracked(
        ipc,
        json!({ "command": ["observe_property", 4, "track-list"] }),
    )?;
    Ok(())
}

pub fn refresh_ipc_snapshot(ipc: &MpvIpc) -> Result<(), String> {
    // One-off snapshot for initial UI; not polling.
    // Avoid time-pos request here (frontend can start at None and interpolate once events arrive).
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
    Ok(())
}

pub fn read_cached_playback_info(ipc: &MpvIpc) -> PlaybackInfo {
    PlaybackInfo {
        time_pos_seconds: ipc.inner.time_pos_seconds.lock().ok().and_then(|g| *g),
        duration_seconds: ipc.inner.duration_seconds.lock().ok().and_then(|g| *g),
        paused: ipc.inner.paused.lock().ok().and_then(|g| *g),
    }
}

pub fn emit_playback_event(ipc: &MpvIpc, force: bool) {
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
    let _ = ipc
        .inner
        .app_handle
        .emit_to("player", PLAYER_PLAYBACK_EVENT, payload);
}

pub fn mpv_send_untracked(ipc: &MpvIpc, payload: JsonValue) -> Result<(), String> {
    if !payload.is_object() {
        return Err("mpv payload must be a JSON object".to_string());
    }
    let req_id = ipc.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
    if ipc_trace_enabled() {
        eprintln!(
            "mpv_send_untracked queued (conn_gen={} id={} {})",
            ipc.inner.conn_gen.load(Ordering::SeqCst),
            req_id,
            mpv_payload_summary(&payload)
        );
    }
    ipc.inner
        .tx
        .send(IpcRequest {
            request_id: req_id,
            payload,
            resp: None,
            retries_left: 1,
        })
        .map_err(|_| "mpv IPC channel closed".to_string())
}

pub fn mpv_send(ipc: &MpvIpc, mut payload: JsonValue) -> Result<(), String> {
    let is_fire_and_forget = payload
        .get("command")
        .and_then(|c| c.as_array())
        .and_then(|c| c.get(0))
        .and_then(|v| v.as_str())
        .map(|cmd| {
            matches!(
                cmd,
                "set_property"
                    | "cycle"
                    | "seek"
                    | "set"
                    | "add"
                    | "observe_property"
                    | "sub-add"
                    | "sub-remove"
            )
        })
        .unwrap_or(false);

    let req_id = ipc.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
    if !payload.is_object() {
        return Err("mpv payload must be a JSON object".to_string());
    }
    // Critical: for fire-and-forget commands, DO NOT include request_id.
    // This prevents mpv from sending reply messages we will never read/track, which can
    // fill the pipe and lead to "write succeeds but mpv never consumes" deadlocks.
    if !is_fire_and_forget {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("request_id".to_string(), JsonValue::from(req_id));
        }
    }
    let summary = mpv_payload_summary(&payload);
    if ipc_trace_enabled() {
        eprintln!(
            "mpv_send queued (conn_gen={} id={} fire_and_forget={} {})",
            ipc.inner.conn_gen.load(Ordering::SeqCst),
            req_id,
            is_fire_and_forget,
            summary
        );
    }

    if is_fire_and_forget {
        ipc.inner
            .tx
            .send(IpcRequest {
                request_id: req_id,
                payload,
                resp: None,
                retries_left: 1,
            })
            .map_err(|_| format!("mpv IPC channel closed (id={req_id} {summary})"))?;
        return Ok(());
    }

    let (tx, rx) = mpsc::channel::<Result<JsonValue, String>>();
    ipc.inner
        .tx
        .send(IpcRequest {
            request_id: req_id,
            payload,
            resp: Some(tx),
            retries_left: 1,
        })
        .map_err(|_| format!("mpv IPC channel closed (id={req_id} {summary})"))?;

    let resp = rx.recv_timeout(Duration::from_secs(8)).map_err(|_| {
        format!(
            "mpv IPC request timed out (id={req_id} {summary} {})",
            ipc_debug_state(ipc)
        )
    })?;
    let resp =
        resp.map_err(|err| format!("{err} (id={req_id} {summary} {})", ipc_debug_state(ipc)))?;
    mpv_expect_success(&resp).map_err(|err| format!("{err} (id={req_id} {summary})"))
}

pub fn mpv_request(ipc: &MpvIpc, mut payload: JsonValue) -> Result<JsonValue, String> {
    let req_id = ipc.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("request_id".to_string(), JsonValue::from(req_id));
    } else {
        return Err("mpv payload must be a JSON object".to_string());
    }
    let summary = mpv_payload_summary(&payload);
    if ipc_trace_enabled() {
        eprintln!(
            "mpv_request queued (conn_gen={} id={} {})",
            ipc.inner.conn_gen.load(Ordering::SeqCst),
            req_id,
            summary
        );
    }
    let (tx, rx) = mpsc::channel::<Result<JsonValue, String>>();
    ipc.inner
        .tx
        .send(IpcRequest {
            request_id: req_id,
            payload,
            resp: Some(tx),
            retries_left: 1,
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

pub fn mpv_request_timeout(
    ipc: &MpvIpc,
    mut payload: JsonValue,
    timeout: Duration,
) -> Result<JsonValue, String> {
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
            retries_left: 1,
        })
        .map_err(|_| format!("mpv IPC channel closed (id={req_id} {summary})"))?;
    let resp = rx.recv_timeout(timeout).map_err(|_| {
        format!(
            "mpv IPC request timed out (id={req_id} {summary} {})",
            ipc_debug_state(ipc)
        )
    })?;
    resp.map_err(|err| format!("{err} (id={req_id} {summary} {})", ipc_debug_state(ipc)))
}

pub fn mpv_expect_success(resp: &JsonValue) -> Result<(), String> {
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

pub fn mpv_get_property_data(ipc: &MpvIpc, name: &str) -> Result<JsonValue, String> {
    let resp = mpv_request(ipc, json!({ "command": ["get_property", name] }))?;
    mpv_expect_success(&resp)?;
    Ok(resp.get("data").cloned().unwrap_or(JsonValue::Null))
}

pub fn mpv_get_f64_property(ipc: &MpvIpc, name: &str) -> Result<Option<f64>, String> {
    Ok(mpv_get_property_data(ipc, name)?.as_f64())
}

pub fn mpv_set_f64_property(ipc: &MpvIpc, name: &str, value: f64) -> Result<(), String> {
    mpv_send(ipc, json!({ "command": ["set_property", name, value] }))
}

pub fn mpv_read_render_settings(ipc: &MpvIpc) -> Result<PlayerRenderSettings, String> {
    Ok(PlayerRenderSettings {
        volume: mpv_get_f64_property(ipc, "volume")?,
        brightness: mpv_get_f64_property(ipc, "brightness")?,
        subtitle_font_size: mpv_get_f64_property(ipc, "sub-font-size")?,
        subtitle_border_size: mpv_get_f64_property(ipc, "sub-border-size")?,
        subtitle_shadow_offset: mpv_get_f64_property(ipc, "sub-shadow-offset")?,
        subtitle_position: mpv_get_f64_property(ipc, "sub-pos")?,
    })
}

fn fail_pending_requests(
    pending: &Arc<Mutex<HashMap<u64, mpsc::Sender<Result<JsonValue, String>>>>>,
    err: String,
) {
    let mut map = match pending.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    for (_, tx) in map.drain() {
        let _ = tx.send(Err(err.clone()));
    }
}

fn should_clear_resume(position_seconds: f64, duration_seconds: Option<f64>) -> bool {
    let Some(d) = duration_seconds else {
        return false;
    };
    if d <= 0.0 {
        return false;
    }
    position_seconds >= d - 20.0 || (position_seconds / d) >= 0.98
}

fn write_resume_position_best_effort(ipc: &MpvIpc) -> Result<(), String> {
    // Prefer cache so we don't add extra IPC load.
    let mut pos = ipc.inner.time_pos_seconds.lock().ok().and_then(|g| *g);
    let mut dur = ipc.inner.duration_seconds.lock().ok().and_then(|g| *g);

    // If cache is missing (startup), do a one-off fetch. Still no polling.
    if pos.is_none() {
        pos = mpv_get_f64_property(ipc, "time-pos")?;
    }
    if dur.is_none() {
        dur = mpv_get_f64_property(ipc, "duration")?;
    }

    let Some(position_seconds) = pos else {
        return Ok(());
    };
    if position_seconds.is_nan() || position_seconds <= 0.0 {
        return Ok(());
    }

    let db = ipc.inner.app_handle.state::<AppDb>();
    let conn = db
        .conn
        .lock()
        .map_err(|_| "db mutex poisoned".to_string())?;

    if should_clear_resume(position_seconds, dur) {
        conn.execute(
            "DELETE FROM playback WHERE item_id = ?1",
            params![ipc.inner.media_key.clone()],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let updated_at_ms = now_epoch_ms_u64() as i64;
    conn.execute(
        r#"
INSERT INTO playback (item_id, position_seconds, duration_seconds, updated_at_ms)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(item_id) DO UPDATE SET
  position_seconds = excluded.position_seconds,
  duration_seconds = excluded.duration_seconds,
  updated_at_ms = excluded.updated_at_ms
"#,
        params![
            ipc.inner.media_key.clone(),
            position_seconds,
            dur,
            updated_at_ms
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn parse_track_list(data: &JsonValue) -> PlayerTracks {
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

pub fn refresh_track_cache(ipc: &MpvIpc) -> Result<PlayerTracks, String> {
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

pub fn remove_live_external_subtitle(ipc: &MpvIpc, path: &str) -> Result<(), String> {
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
