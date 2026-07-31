use super::ipc;
use super::types::PlayerProc;
use crate::*;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub fn resolve_mpv_command() -> PathBuf {
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

pub fn mpv_log_file_path() -> Option<PathBuf> {
    let want_log = cfg!(debug_assertions) || std::env::var("CINEVAULT_MPV_LOG").is_ok();
    if !want_log {
        return None;
    }

    let project_dirs = directories::ProjectDirs::from("com", "movieplayer", "cinevault")?;
    let data_dir = project_dirs.data_dir();
    std::fs::create_dir_all(data_dir).ok()?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis())?;
    let pid = std::process::id();
    Some(data_dir.join(format!("mpv-{pid}-{ts}.log")))
}

pub fn make_mpv_ipc_path() -> Result<String, String> {
    let pid = std::process::id();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    if cfg!(windows) {
        Ok(format!(r"\\.\pipe\cinevault-mpv-{}-{}", pid, ts))
    } else {
        let project_dirs = directories::ProjectDirs::from("com", "movieplayer", "cinevault")
            .ok_or("failed to resolve app data dir")?;
        let data_dir = project_dirs.data_dir();
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let sock = data_dir.join(format!("mpv-{}-{}.sock", pid, ts));
        let _ = std::fs::remove_file(&sock);
        Ok(sock.to_string_lossy().to_string())
    }
}

pub fn play_path_spawn_mpv(
    window: tauri::WebviewWindow,
    player: &tauri::State<PlayerProc>,
    media_path: String,
    start_position_seconds: Option<f64>,
    extra_subs: Vec<String>,
) -> Result<(), String> {
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
        *guard = Some(media_path.clone());
    }
    if let Ok(mut guard) = player.last_extra_subs.lock() {
        *guard = extra_subs.clone();
    }

    let ipc_path = make_mpv_ipc_path()?;
    if let Ok(mut guard) = player.ipc_path.lock() {
        *guard = Some(ipc_path.clone());
    }

    let mpv_cmd = resolve_mpv_command();
    let mut cmd = Command::new(&mpv_cmd);

    #[cfg(windows)]
    let window_hwnd = if window.label() == "player" && std::env::var("CINEVAULT_MPV_EMBED").is_ok()
    {
        window.hwnd().ok().map(|h| {
            let hwnd = windows::Win32::Foundation::HWND(h.0);
            unsafe {
                let root = windows::Win32::UI::WindowsAndMessaging::GetAncestor(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::GA_ROOT,
                );
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
            cmd.arg("--config=no");
            cmd.arg("--load-scripts=no");
            cmd.arg("--no-border");
            cmd.arg("--no-osc");
            cmd.arg("--osd-level=0");
            cmd.arg("--input-default-bindings=no");
            cmd.arg("--input-cursor=yes");
            cmd.arg("--cursor-autohide=2000");
            cmd.arg("--no-cursor-autohide-fs-only");
            cmd.arg("--input-doubleclick-time=0");
            cmd.arg("--no-keepaspect-window");
            cmd.arg("--auto-window-resize=no");
            cmd.arg("--window-dragging=no");
            cmd.arg("--input-builtin-dragging=no");
            cmd.arg("--drag-and-drop=no");
            cmd.arg("--vo=gpu");
            cmd.arg("--background=color");
            cmd.arg("--border-background=color");
            // Some mpv builds only accept explicit color formats here.
            cmd.arg("--background-color=#000000");
            cmd.arg("--sub-use-margins=no");
            cmd.arg("--sub-ass-force-margins=no");
            cmd.arg("--sub-pos=100");
            cmd.arg("--panscan=0.0");
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
        let ipc_handle = ipc::start_mpv_ipc(
            window.app_handle().clone(),
            ipc_path.clone(),
            media_path.clone(),
            child_pid,
        );
        // IMPORTANT: do not fail playback just because IPC hasn't connected yet.
        // mpv can take a moment to create the pipe on slower machines / first-run shader compile.
        // We keep the process alive and let the IPC connection manager keep retrying.
        if let Err(err) = ipc::wait_for_ipc_connected(&ipc_handle, Duration::from_secs(2)) {
            eprintln!("mpv IPC not connected yet (continuing startup): {err}");
        }

        let mut guard = player
            .ipc
            .lock()
            .map_err(|_| "player mutex poisoned".to_string())?;
        *guard = Some(ipc_handle.clone());
    }

    #[cfg(windows)]
    {
        if window.label() == "player" {
            if let Ok(hwnd) = window.hwnd() {
                let overlay_hwnd = unsafe {
                    let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
                    let root = windows::Win32::UI::WindowsAndMessaging::GetAncestor(
                        hwnd,
                        windows::Win32::UI::WindowsAndMessaging::GA_ROOT,
                    );
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
