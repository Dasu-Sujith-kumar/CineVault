import { useEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { Maximize, Minimize, Pause, Play, RefreshCw, RotateCcw, RotateCw, Settings, SunMedium, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { toast } from "@/components/ui/sonner";
import {
  PLAYER_ACTIVITY_EVENT,
  PLAYER_KEY_EVENT,
  PLAYER_LOAD_EVENT,
  PLAYER_PLAYBACK_EVENT,
  PLAYER_VIDEO_CLICK_EVENT,
  PlayerOpenPayload,
  PlaybackInfo,
  PlayerPlaybackEvent,
  PlayerRenderSettings,
  PlayerSubtitleStyleInput,
  PlayerTrack,
  PlayerTracks,
  debugLog,
  desktopPickSubtitleFile,
  isTauriRuntime,
  playerAddExternalSubtitle,
  playerAdjustBrightness,
  playerAdjustVolume,
  playerClearResumePosition,
  playerGetPlaybackInfo,
  playerGetRenderSettings,
  playerGetResumePosition,
  playerListExternalSubtitles,
  playerListTracks,
  playerPlayPath,
  playerRemoveExternalSubtitle,
  playerSeekRelative,
  playerSetAudioTrack,
  playerSetBrightness,
  playerSetOverlayRegion,
  playerSetPause,
  playerSetResumePosition,
  playerSetSubtitleStyle,
  playerSetSubtitleTrack,
  playerSetVolume,
  playerStop,
} from "@/lib/desktop-player";

const monoStyle = { fontFamily: '"Cascadia Code","IBM Plex Mono","Consolas",monospace' } as const;
const shellStyle = { fontFamily: '"Segoe UI Variable Display","Bahnschrift","Trebuchet MS",sans-serif' } as const;
const DEFAULT_RENDER_SETTINGS: PlayerRenderSettings = {
  volume: 100,
  brightness: 0,
  subtitleFontSize: 48,
  subtitleBorderSize: 2,
  subtitleShadowOffset: 1,
  subtitlePosition: 100,
};

type FeedbackHudState =
  | {
      kind: "volume" | "brightness";
      value: number;
    }
  | {
      kind: "status";
      label: string;
      icon: "maximize" | "minimize";
    };

function formatTimeShort(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

function fileNameFromPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/[/\\]+/);
  const name = parts[parts.length - 1] || trimmed;
  const lastDot = name.lastIndexOf(".");
  return lastDot > 0 ? name.slice(0, lastDot) : name;
}

function parseStartParam(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function pickTrack(tracks: PlayerTrack[], id: number | null): PlayerTrack | null {
  return tracks.find((track) => track.selected) ?? tracks.find((track) => track.id === id) ?? tracks[0] ?? null;
}

function trackLabel(track: PlayerTrack | null, fallback: string): string {
  if (!track) return fallback;
  return `${track.lang ? `${track.lang.toUpperCase()} / ` : ""}${track.label}`;
}

function hasPlaybackSnapshot(info: PlaybackInfo | null): boolean {
  return Boolean(info && (info.timePosSeconds != null || info.durationSeconds != null || info.paused != null));
}

function shouldClearResume(positionSeconds: number, durationSeconds: number | null | undefined): boolean {
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return false;
  if (!Number.isFinite(durationSeconds) || durationSeconds == null || durationSeconds <= 0) return false;
  return positionSeconds >= durationSeconds - 20 || positionSeconds / durationSeconds >= 0.98;
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export default function PlayerPage() {
  const [params] = useSearchParams();
  const initialMediaPath = (params.get("mediaPath") ?? "").trim();
  const initialStart = parseStartParam(params.get("start"));
  const initialDisplayTitle = (params.get("title") ?? "").trim();
  const [mediaPath, setMediaPath] = useState(initialMediaPath);
  const [displayTitle, setDisplayTitle] = useState(initialDisplayTitle);
  const [tracks, setTracks] = useState<PlayerTracks>({ audio: [], subtitles: [] });
  const [audioTrackId, setAudioTrackId] = useState<number | null>(null);
  const [subtitleTrackId, setSubtitleTrackId] = useState(0);
  const [playbackInfo, setPlaybackInfo] = useState<PlaybackInfo | null>(null);
  const [smoothTimePosSeconds, setSmoothTimePosSeconds] = useState<number | null>(null);
  const [renderSettings, setRenderSettings] = useState<PlayerRenderSettings>(DEFAULT_RENDER_SETTINGS);
  const [externalSubtitles, setExternalSubtitles] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [controlsHovering, setControlsHovering] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [scrubSeconds, setScrubSeconds] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverRatio, setHoverRatio] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [feedbackHud, setFeedbackHud] = useState<FeedbackHudState | null>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const hideCursorTimerRef = useRef<number | null>(null);
  const feedbackHudTimerRef = useRef<number | null>(null);
  const lastVideoClickAtRef = useRef(0);
  const lastPointerMoveRef = useRef({ at: 0, x: 0, y: 0 });
  const lastPayloadRef = useRef<PlayerOpenPayload | null>(
    initialMediaPath
      ? {
          mediaPath: initialMediaPath,
          startPositionSeconds: initialStart,
          displayTitle: initialDisplayTitle || null,
        }
      : null,
  );
  const bumpControlsRef = useRef<() => void>(() => {});
  const toggleFullscreenRef = useRef<() => void>(() => {});
  const pauseBusyRef = useRef(false);
  const closingRef = useRef(false);
  const playerDeadRef = useRef(false);
  const startupAttemptRef = useRef(0);
  const mediaPathRef = useRef(initialMediaPath);
  const playbackInfoRef = useRef<PlaybackInfo | null>(null);
  const lastTimeRef = useRef(0);
  const lastPauseActionAtRef = useRef(0);
  const lastPlaybackSeqRef = useRef(0);
  const playbackClockRef = useRef({
    hasBase: false,
    baseTime: 0,
    baseAt: 0,
    displayTime: 0,
    paused: true,
    duration: null as number | null,
    lastCommitAt: 0,
  });
  const lastTimePosEventAtMsRef = useRef(0);
  const playbackTimeRafRef = useRef<number | null>(null);
  const isFullscreenRef = useRef(false);
  const snapshotWaiterRef = useRef<{
    mediaKey: string;
    attempt: number;
    timeoutId: number;
    resolve: (info: PlaybackInfo) => void;
  } | null>(null);
  const webviewRef = useRef<any>(null);
  const webviewBgAlphaRef = useRef<0 | 1 | null>(null);
  const winRef = useRef<any>(null);
  const topShellRef = useRef<HTMLDivElement | null>(null);
  const bottomShellRef = useRef<HTMLDivElement | null>(null);
  const topEdgeTriggerRef = useRef<HTMLDivElement | null>(null);
  const bottomEdgeTriggerRef = useRef<HTMLDivElement | null>(null);
  const overlaySyncRafRef = useRef<number | null>(null);
  const scheduleOverlayRegionSyncRef = useRef<() => void>(() => {});
  const listenersReadyRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!listenersReadyRef.current) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    listenersReadyRef.current = { promise, resolve };
  }

  const setWebviewBgAlpha = useCallback((alpha: 0 | 1) => {
    const webview = webviewRef.current;
    if (!webview) return;
    if (webviewBgAlphaRef.current === alpha) return;
    webviewBgAlphaRef.current = alpha;
    webview.setBackgroundColor({ red: 0, green: 0, blue: 0, alpha }).catch(() => {});
  }, []);

  const resetPlaybackClock = useCallback(() => {
    const clock = playbackClockRef.current;
    clock.hasBase = false;
    clock.baseTime = 0;
    clock.baseAt = 0;
    clock.displayTime = 0;
    clock.paused = true;
    clock.duration = null;
    clock.lastCommitAt = 0;
    setSmoothTimePosSeconds(null);
  }, []);

  const applyPlaybackSnapshotToClock = useCallback((snapshot: PlaybackInfo) => {
    const clock = playbackClockRef.current;
    const now = window.performance.now();

    clock.paused = snapshot.paused === true;
    clock.duration =
      typeof snapshot.durationSeconds === "number" && Number.isFinite(snapshot.durationSeconds) && snapshot.durationSeconds > 0
        ? snapshot.durationSeconds
        : null;

    if (typeof snapshot.timePosSeconds !== "number" || !Number.isFinite(snapshot.timePosSeconds)) {
      // No time update, but pause changes should still affect the clock immediately.
      if (clock.hasBase && typeof snapshot.paused === "boolean") {
        clock.baseTime = clock.displayTime;
        clock.baseAt = now;
      }
      return;
    }

    const target = Math.max(0, snapshot.timePosSeconds);
    lastTimePosEventAtMsRef.current = Date.now();
    clock.hasBase = true;
    clock.baseTime = target;
    clock.baseAt = now;

    const drift = Math.abs(clock.displayTime - target);
    if (!Number.isFinite(clock.displayTime) || drift > 1.25) {
      clock.displayTime = target;
      clock.lastCommitAt = now;
      setSmoothTimePosSeconds(target);
    }
  }, []);

  const applyOptimisticPauseToClock = useCallback((pause: boolean) => {
    const clock = playbackClockRef.current;
    if (!clock.hasBase) return;
    const now = window.performance.now();
    clock.paused = pause;
    // Keep continuity: treat the current displayed time as the new base time.
    clock.baseTime = clock.displayTime;
    clock.baseAt = now;
  }, []);

  const applyOptimisticSeekToClock = useCallback((timeSeconds: number) => {
    const clock = playbackClockRef.current;
    const now = window.performance.now();
    const target = Math.max(0, timeSeconds);
    clock.hasBase = true;
    clock.baseTime = target;
    clock.baseAt = now;
    clock.displayTime = target;
    clock.lastCommitAt = now;
    setSmoothTimePosSeconds(target);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    const tick = (now: number) => {
      const clock = playbackClockRef.current;

      if (clock.hasBase) {
        const elapsed = (now - clock.baseAt) / 1000;
        let target = clock.baseTime + (clock.paused ? 0 : elapsed);

        if (typeof clock.duration === "number" && Number.isFinite(clock.duration) && clock.duration > 0) {
          target = Math.min(clock.duration, target);
        }
        target = Math.max(0, target);

        const lastTimePosAt = lastTimePosEventAtMsRef.current;
        const staleTimePos = !clock.paused && lastTimePosAt > 0 && Date.now() - lastTimePosAt > 900;
        if (!staleTimePos) {
          const delta = target - clock.displayTime;
          if (!Number.isFinite(clock.displayTime) || Math.abs(delta) > 1.5) {
            clock.displayTime = target;
          } else {
            clock.displayTime += delta * 0.25;
          }
        }

        // Commit ~30fps to keep the slider buttery without over-rendering.
        if (now - clock.lastCommitAt >= 33) {
          clock.lastCommitAt = now;
          setSmoothTimePosSeconds(clock.displayTime);
        }
      }

      playbackTimeRafRef.current = window.requestAnimationFrame(tick);
    };

    playbackTimeRafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (playbackTimeRafRef.current != null) {
        window.cancelAnimationFrame(playbackTimeRafRef.current);
        playbackTimeRafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title = useMemo(() => (displayTitle.trim() ? displayTitle.trim() : fileNameFromPath(mediaPath)), [displayTitle, mediaPath]);
  const hasMedia = mediaPath.trim().length > 0;
  const duration = playbackInfo?.durationSeconds ?? 0;
  const rawTimePos = playbackInfo?.timePosSeconds ?? 0;
  const timePos = smoothTimePosSeconds ?? rawTimePos;
  const paused = playbackInfo?.paused ?? null;
  const shownTime = scrubSeconds ?? timePos;
  const showLoading = hasMedia && !hasPlaybackSnapshot(playbackInfo) && !playbackError;
  const forceShowControls = settingsOpen || showLoading || Boolean(playbackError) || !hasMedia;
  const allowAutoHide = hasMedia && !settingsOpen && !playbackError;
  const fullOverlay = settingsOpen || showLoading || Boolean(playbackError) || !hasMedia;
  const videoReady = hasMedia && hasPlaybackSnapshot(playbackInfo) && !playbackError;
  const activeAudio = useMemo(() => pickTrack(tracks.audio, audioTrackId), [tracks.audio, audioTrackId]);
  const activeSubtitle = useMemo(() => (subtitleTrackId === 0 ? null : pickTrack(tracks.subtitles, subtitleTrackId)), [tracks.subtitles, subtitleTrackId]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    // Keep the webview itself black. The native window region is what exposes mpv
    // behind it; making the full webview transparent can show a white desktop/app surface.
    setWebviewBgAlpha(1);
  }, [setWebviewBgAlpha]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    const isEditable = (target: EventTarget | null) => {
      const node = target as HTMLElement | null;
      if (!node) return false;
      if (node.isContentEditable) return true;
      const tag = node.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };

    const blockDefaultMediaKeys = (event: KeyboardEvent) => {
      if (!mediaPathRef.current.trim()) return;
      if (isEditable(event.target)) return;
      const code = event.code || event.key;
      if (
        code === "Space" ||
        code === "ArrowLeft" ||
        code === "ArrowRight" ||
        code === "ArrowUp" ||
        code === "ArrowDown"
      ) {
        // Prevent browser defaults (scroll/button activation) so we don't double-trigger with
        // the native (mpv/window) key watcher.
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", blockDefaultMediaKeys, true);
    window.addEventListener("keyup", blockDefaultMediaKeys, true);
    return () => {
      window.removeEventListener("keydown", blockDefaultMediaKeys, true);
      window.removeEventListener("keyup", blockDefaultMediaKeys, true);
    };
  }, []);

  const toNativePx = (cssPx: number) => {
    const dpr = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
    return Math.max(0, Math.ceil(cssPx * dpr));
  };

  const getCssHeight = (node: HTMLElement | null) => {
    if (!node) return 0;
    const rect = node.getBoundingClientRect();
    return Number.isFinite(rect.height) ? rect.height : 0;
  };

  const syncOverlayRegion = useCallback(() => {
    if (!isTauriRuntime()) return;

    // When showing modals/sheets/errors, keep the overlay fully interactive.
    const wantsFullOverlay =
      fullOverlay || !hasMedia || Boolean(playbackError);

    let topCssPx = 0;
    let bottomCssPx = 0;

    if (wantsFullOverlay) {
      topCssPx = window.innerHeight;
      bottomCssPx = 0;
    } else if (controlsVisible || controlsHovering) {
      topCssPx = getCssHeight(topShellRef.current);
      bottomCssPx = getCssHeight(bottomShellRef.current);
      // If layout isn't measured yet, fall back to edge triggers so the window never becomes empty.
      if (topCssPx < 1) topCssPx = getCssHeight(topEdgeTriggerRef.current);
      if (bottomCssPx < 1) bottomCssPx = getCssHeight(bottomEdgeTriggerRef.current);
    } else {
      // No overlay strips while controls are hidden; even transparent CSS can still leave a
      // compositor-visible band over mpv on Windows.
      topCssPx = 0;
      bottomCssPx = 0;
    }

    const topNativePx = Math.max(0, toNativePx(topCssPx));
    const bottomNativePx = Math.max(0, toNativePx(bottomCssPx));
    playerSetOverlayRegion(topNativePx, bottomNativePx).catch(() => {});
  }, [
    controlsHovering,
    controlsVisible,
    fullOverlay,
    hasMedia,
    playbackError,
    toNativePx,
  ]);

  const scheduleOverlayRegionSync = useCallback(() => {
    if (!isTauriRuntime()) return;
    if (overlaySyncRafRef.current != null) return;
    overlaySyncRafRef.current = window.requestAnimationFrame(() => {
      overlaySyncRafRef.current = null;
      syncOverlayRegion();
    });
  }, [syncOverlayRegion]);
  scheduleOverlayRegionSyncRef.current = scheduleOverlayRegionSync;

  const clearHideTimer = () => {
    if (hideControlsTimerRef.current != null) {
      window.clearTimeout(hideControlsTimerRef.current);
      hideControlsTimerRef.current = null;
    }
  };

  const clearCursorHideTimer = () => {
    if (hideCursorTimerRef.current != null) {
      window.clearTimeout(hideCursorTimerRef.current);
      hideCursorTimerRef.current = null;
    }
  };

  const clearFeedbackHudTimer = () => {
    if (feedbackHudTimerRef.current != null) {
      window.clearTimeout(feedbackHudTimerRef.current);
      feedbackHudTimerRef.current = null;
    }
  };

  const scheduleControlsHide = useCallback(() => {
    clearHideTimer();
    clearCursorHideTimer();
    if (forceShowControls || controlsHovering || scrubSeconds != null) {
      setControlsVisible(true);
      setCursorVisible(true);
      return;
    }
    hideCursorTimerRef.current = window.setTimeout(() => {
      setCursorVisible(false);
      hideCursorTimerRef.current = null;
    }, 1000);
    hideControlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      setCursorVisible(false);
      hideControlsTimerRef.current = null;
    }, 1400);
  }, [controlsHovering, forceShowControls, scrubSeconds]);

  const bumpControls = useCallback(() => {
    setControlsVisible(true);
    setCursorVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);
  bumpControlsRef.current = bumpControls;

  useEffect(() => {
    const forceShow = () => bumpControlsRef.current();
    window.addEventListener("mousemove", forceShow, true);
    window.addEventListener("mousedown", forceShow, true);
    window.addEventListener("keydown", forceShow, true);
    return () => {
      window.removeEventListener("mousemove", forceShow, true);
      window.removeEventListener("mousedown", forceShow, true);
      window.removeEventListener("keydown", forceShow, true);
    };
  }, []);

  const mergeRenderSettings = (next: Partial<PlayerRenderSettings>) => {
    setRenderSettings((prev) => ({ ...prev, ...next }));
  };

  const showFeedbackHud = (kind: "volume" | "brightness", value: number) => {
    setFeedbackHud({ kind, value });
    clearFeedbackHudTimer();
    feedbackHudTimerRef.current = window.setTimeout(() => {
      setFeedbackHud(null);
      feedbackHudTimerRef.current = null;
    }, 1100);
  };

  const showStatusHud = (label: string, icon: "maximize" | "minimize") => {
    setFeedbackHud({ kind: "status", label, icon });
    clearFeedbackHudTimer();
    feedbackHudTimerRef.current = window.setTimeout(() => {
      setFeedbackHud(null);
      feedbackHudTimerRef.current = null;
    }, 900);
  };

  const persistResumePoint = useCallback(
    async (key: string, info = playbackInfoRef.current) => {
      const mediaKey = key.trim();
      if (!mediaKey) return;
      const position = info?.timePosSeconds ?? lastTimeRef.current;
      const durationSeconds = info?.durationSeconds ?? null;
      if (!Number.isFinite(position) || position <= 0) return;
      if (shouldClearResume(position, durationSeconds)) {
        await playerClearResumePosition(mediaKey).catch(() => {});
        return;
      }
      await playerSetResumePosition(mediaKey, position, durationSeconds).catch(() => {});
    },
    [],
  );

  const markPlayerDead = useCallback((message: string) => {
    debugLog(`markPlayerDead: ${message}`).catch(() => {});
    playerDeadRef.current = true;
    setConnectionError(message);
  }, []);

  const requestPlaybackInfo = async (key: string) => {
    const mediaKey = key.trim();
    if (!mediaKey) return null;

    const info = await playerGetPlaybackInfo(mediaKey).catch((err) => {
      debugLog(`❌ requestPlaybackInfo: playerGetPlaybackInfo failed: ${err}`).catch(() => {});
      if (mediaPathRef.current === mediaKey) {
        markPlayerDead(errorMessage(err, "Player disconnected"));
      }
      return null;
    });

    if (!info) return null;
    if (mediaPathRef.current !== mediaKey) return info;

    playbackInfoRef.current = info;
    setPlaybackInfo(info);
    applyPlaybackSnapshotToClock(info);

    if (typeof info.timePosSeconds === "number") {
      lastTimeRef.current = info.timePosSeconds;
    }

    if (hasPlaybackSnapshot(info)) {
      setPlaybackError(null);
      setConnectionError(null);
      playerDeadRef.current = false;
    }

    return info;
  };

  const waitForPlaybackSnapshot = useCallback((mediaKey: string, attempt: number, timeoutMs: number) => {
    const trimmed = mediaKey.trim();
    if (!trimmed) return Promise.resolve(null);

    const existing = playbackInfoRef.current;
    if (mediaPathRef.current === trimmed && hasPlaybackSnapshot(existing)) {
      return Promise.resolve(existing);
    }

    const prev = snapshotWaiterRef.current;
    if (prev) {
      window.clearTimeout(prev.timeoutId);
      snapshotWaiterRef.current = null;
    }

    return new Promise<PlaybackInfo | null>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        const waiter = snapshotWaiterRef.current;
        if (!waiter) return;
        if (waiter.mediaKey !== trimmed || waiter.attempt !== attempt) return;
        snapshotWaiterRef.current = null;
        resolve(null);
      }, timeoutMs);

      snapshotWaiterRef.current = {
        mediaKey: trimmed,
        attempt,
        timeoutId,
        resolve: (info) => {
          window.clearTimeout(timeoutId);
          snapshotWaiterRef.current = null;
          resolve(info);
        },
      };
    });
  }, []);

  const refreshTracksAndSubs = async (key: string) => {
    const mediaKey = key.trim();
    if (!mediaKey) return { audio: [], subtitles: [] } as PlayerTracks;
    const [nextTracks, nextSubs] = await Promise.all([
      playerListTracks(key).catch(() => ({ audio: [], subtitles: [] } as PlayerTracks)),
      playerListExternalSubtitles(key).catch(() => [] as string[]),
    ]);
    if (mediaPathRef.current !== mediaKey) return nextTracks;
    setTracks(nextTracks);
    setExternalSubtitles(nextSubs);
    setAudioTrackId((current) => {
      const selectedId = nextTracks.audio.find((track) => track.selected)?.id;
      if (selectedId != null) return selectedId;
      if (current != null && nextTracks.audio.some((track) => track.id === current)) return current;
      return nextTracks.audio[0]?.id ?? null;
    });
    setSubtitleTrackId((current) => {
      const selectedId = nextTracks.subtitles.find((track) => track.selected)?.id;
      if (selectedId != null) return selectedId;
      if (current !== 0 && nextTracks.subtitles.some((track) => track.id === current)) return current;
      return 0;
    });
    return nextTracks;
  };

  const refreshRenderSettings = async (key: string) => {
    const mediaKey = key.trim();
    if (!mediaKey) return null;
    const next = await playerGetRenderSettings(key).catch(() => null);
    if (next && mediaPathRef.current === mediaKey) {
      setRenderSettings({ ...DEFAULT_RENDER_SETTINGS, ...next });
    }
    return next;
  };

  const refreshAll = async (key: string) =>
    Promise.all([requestPlaybackInfo(key), refreshTracksAndSubs(key), refreshRenderSettings(key)]);

  const startPlayback = async ({
    mediaPath: nextPathRaw,
    startPositionSeconds,
    displayTitle: nextDisplayTitleRaw,
  }: PlayerOpenPayload) => {
    const nextPath = (nextPathRaw ?? "").trim();
    if (!nextPath) return toast.error("Missing media path");
    const nextDisplayTitle = (nextDisplayTitleRaw ?? "").trim();
    lastPayloadRef.current = {
      mediaPath: nextPath,
      startPositionSeconds: startPositionSeconds ?? null,
      displayTitle: nextDisplayTitle || null,
    };
    startupAttemptRef.current += 1;
    const attempt = startupAttemptRef.current;
    const previousPath = mediaPathRef.current.trim();
    if (previousPath && previousPath !== nextPath) {
      await persistResumePoint(previousPath);
    }
    setMediaPath(nextPath);
    setDisplayTitle(nextDisplayTitle);
    mediaPathRef.current = nextPath;
    setTracks({ audio: [], subtitles: [] });
    setAudioTrackId(null);
    setSubtitleTrackId(0);
    setExternalSubtitles([]);
    setPlaybackInfo(null);
    playbackInfoRef.current = null;
    lastTimeRef.current = 0;
    setRenderSettings(DEFAULT_RENDER_SETTINGS);
    setScrubSeconds(null);
    setHoverTime(null);
    setHoverRatio(0);
    setPlaybackError(null);
    setConnectionError(null);
    playerDeadRef.current = false;
    lastPlaybackSeqRef.current = 0;
    resetPlaybackClock();
    bumpControls();

    try {
      await listenersReadyRef.current?.promise;

      const resumePosition =
        typeof startPositionSeconds === "number" && Number.isFinite(startPositionSeconds)
          ? startPositionSeconds
          : await playerGetResumePosition(nextPath).catch(() => null);
      const resolvedStart =
        typeof resumePosition === "number" && Number.isFinite(resumePosition) && resumePosition > 0 ? resumePosition : null;

      const snapshotPromise = waitForPlaybackSnapshot(nextPath, attempt, 3400);
      await playerPlayPath(nextPath, resolvedStart);

      const snapshot = await snapshotPromise;
      if (!snapshot && attempt === startupAttemptRef.current && mediaPathRef.current === nextPath) {
        setPlaybackError("The player did not report playback state. Try restarting this title.");
      }
      refreshTracksAndSubs(nextPath).catch(() => {});
      refreshRenderSettings(nextPath).catch(() => {});
    } catch (error) {
      setPlaybackError(errorMessage(error, "Playback failed to start. Verify the file and try again."));
      throw error;
    }
  };

  const seekTo = async (targetSeconds: number) => {
    const mediaKey = mediaPath.trim();
    if (!mediaKey) return;

    const current = typeof smoothTimePosSeconds === "number" ? smoothTimePosSeconds : lastTimeRef.current;
    const delta = targetSeconds - current;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.01) return;

    const optimistic: PlaybackInfo = {
      timePosSeconds: targetSeconds,
      durationSeconds: playbackInfoRef.current?.durationSeconds ?? playbackInfo?.durationSeconds ?? null,
      paused: playbackInfoRef.current?.paused ?? playbackInfo?.paused ?? null,
    };
    playbackInfoRef.current = optimistic;
    setPlaybackInfo(optimistic);
    lastTimeRef.current = targetSeconds;
    applyOptimisticSeekToClock(targetSeconds);

    await playerSeekRelative(mediaKey, delta);
  };

  const seekDelta = async (delta: number) => {
    const mediaKey = mediaPath.trim();
    if (!mediaKey) return;

    const current = typeof smoothTimePosSeconds === "number" ? smoothTimePosSeconds : lastTimeRef.current;
    const target = Math.max(0, current + delta);

    const optimistic: PlaybackInfo = {
      timePosSeconds: target,
      durationSeconds: playbackInfoRef.current?.durationSeconds ?? playbackInfo?.durationSeconds ?? null,
      paused: playbackInfoRef.current?.paused ?? playbackInfo?.paused ?? null,
    };
    playbackInfoRef.current = optimistic;
    setPlaybackInfo(optimistic);
    lastTimeRef.current = target;
    applyOptimisticSeekToClock(target);

    await playerSeekRelative(mediaKey, delta);
  };

  const togglePause = async () => {
    const mediaKey = mediaPath.trim();
    if (!mediaKey) return;
    if (closingRef.current) return;

    if (pauseBusyRef.current) return;
    const now = Date.now();
    if (now - lastPauseActionAtRef.current < 350) return;
    lastPauseActionAtRef.current = now;

    pauseBusyRef.current = true;
    try {
      const currentPaused = playbackInfoRef.current?.paused ?? false;
      const nextPause = !currentPaused;
      const optimistic: PlaybackInfo = {
        timePosSeconds: playbackInfoRef.current?.timePosSeconds ?? playbackInfo?.timePosSeconds ?? null,
        durationSeconds: playbackInfoRef.current?.durationSeconds ?? playbackInfo?.durationSeconds ?? null,
        paused: nextPause,
      };

      playbackInfoRef.current = optimistic;
      setPlaybackInfo(optimistic);
      applyOptimisticPauseToClock(nextPause);

      playerSetPause(mediaKey, nextPause).catch((err) => {
        markPlayerDead(errorMessage(err, "Player disconnected"));
      });
    } catch (err) {
      markPlayerDead(errorMessage(err, "Player disconnected"));
      toast.error(errorMessage(err, "Play/pause failed"));
    } finally {
      pauseBusyRef.current = false;
    }
  };

  const setVolumeTo = async (target: number) => {
    if (!mediaPath.trim()) return;
    const next = await playerSetVolume(mediaPath, target);
    mergeRenderSettings({ volume: next });
    showFeedbackHud("volume", next);
  };

  const adjustVolume = async (delta: number) => {
    if (!mediaPath.trim()) return;
    const next = await playerAdjustVolume(mediaPath, delta);
    mergeRenderSettings({ volume: next });
    showFeedbackHud("volume", next);
  };

  const setBrightnessTo = async (target: number) => {
    if (!mediaPath.trim()) return;
    const next = await playerSetBrightness(mediaPath, target);
    mergeRenderSettings({ brightness: next });
    showFeedbackHud("brightness", next);
  };

  const adjustBrightness = async (delta: number) => {
    if (!mediaPath.trim()) return;
    const next = await playerAdjustBrightness(mediaPath, delta);
    mergeRenderSettings({ brightness: next });
    showFeedbackHud("brightness", next);
  };

  const commitSubtitleStyle = async (style: PlayerSubtitleStyleInput) => {
    if (!mediaPath.trim()) return;
    const next = await playerSetSubtitleStyle(mediaPath, style);
    setRenderSettings({ ...DEFAULT_RENDER_SETTINGS, ...next });
  };

  const toggleFullscreen = async () => {
    if (!isTauriRuntime()) return;
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const win = getCurrentWebviewWindow();
    const next = !(await win.isFullscreen());
    if (next) {
      await win.unmaximize().catch(() => {});
      await win.setFullscreen(true);
    } else {
      await win.setFullscreen(false);
    }
    await win.setFocus().catch(() => {});
    const actual = await win.isFullscreen().catch(() => next);
    isFullscreenRef.current = actual;
    setIsFullscreen(actual);
    showStatusHud(actual ? "Fullscreen" : "Windowed", actual ? "maximize" : "minimize");
  };
  toggleFullscreenRef.current = () => {
    toggleFullscreen().catch(() => {});
  };

  const exitFullscreenOrClose = async () => {
    if (!isTauriRuntime()) {
      await closeWindow();
      return;
    }
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const win = getCurrentWebviewWindow();
    const fullscreen = await win.isFullscreen().catch(() => isFullscreenRef.current);
    if (fullscreen) {
      await win.setFullscreen(false).catch(() => {});
      await win.setFocus().catch(() => {});
      isFullscreenRef.current = false;
      setIsFullscreen(false);
      showStatusHud("Windowed", "minimize");
      return;
    }
    await closeWindow();
  };

  const restoreMainWindow = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const main = await WebviewWindow.getByLabel("main");
    await main?.show().catch(() => {});
    await main?.setFocus().catch(() => {});
  }, []);

  const shutdownPlayerWindow = useCallback(
    async (closeSelf: boolean, reason = "unknown") => {
      if (!isTauriRuntime() || closingRef.current) return;
      closingRef.current = true;
      playerDeadRef.current = true;
      try {
        await persistResumePoint(mediaPathRef.current);
        // Only stop player during intentional shutdown, not during accidental triggers
        if (reason === "user_close" || reason === "system_close") {
          debugLog(`🚨 playerStop triggered from shutdownPlayerWindow (${reason})`).catch(() => {});
          await playerStop().catch(() => {});
        } else {
          debugLog(`shutdownPlayerWindow called with reason: ${reason} - skipping playerStop`).catch(() => {});
        }
      } finally {
        try {
          await restoreMainWindow();
        } finally {
          if (closeSelf) {
            const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
            await getCurrentWebviewWindow().close().catch(() => {});
          }
          closingRef.current = false;
        }
      }
    },
    [persistResumePoint, restoreMainWindow],
  );

  const closeWindow = async () => {
    await shutdownPlayerWindow(true, "user_close");
  };

  useEffect(() => {
    document.body.classList.add("cinevault-player-transparent");
    document.documentElement.classList.add("cinevault-player-transparent");
    if (!isTauriRuntime()) {
      return () => {
        document.body.classList.remove("cinevault-player-transparent");
        document.documentElement.classList.remove("cinevault-player-transparent");
      };
    }

    let unlistenLoad: null | (() => void) = null;
    let unlistenResize: null | (() => void) = null;
    let unlistenClose: null | (() => void) = null;
    let unlistenActivity: null | (() => void) = null;
    let unlistenKey: null | (() => void) = null;
    let unlistenPlayback: null | (() => void) = null;
    let unlistenVideoClick: null | (() => void) = null;

    (async () => {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const win = getCurrentWebviewWindow();
      winRef.current = win;

      unlistenPlayback = await win
        .listen<PlayerPlaybackEvent>(PLAYER_PLAYBACK_EVENT, (event) => {
          const payload = event.payload;
          const mediaKey = String(payload?.mediaKey ?? "").trim();
          if (!mediaKey) return;

          const currentKey = mediaPathRef.current.trim();
          if (currentKey && currentKey !== mediaKey) return;

          const seq = typeof payload?.seq === "number" && Number.isFinite(payload.seq) ? payload.seq : null;
          if (seq != null) {
            if (seq <= lastPlaybackSeqRef.current) return;
            lastPlaybackSeqRef.current = seq;
          }

          const nextInfo: PlaybackInfo = {
            timePosSeconds:
              typeof payload?.timePosSeconds === "number" && Number.isFinite(payload.timePosSeconds) ? payload.timePosSeconds : null,
            durationSeconds:
              typeof payload?.durationSeconds === "number" && Number.isFinite(payload.durationSeconds) ? payload.durationSeconds : null,
            paused: typeof payload?.paused === "boolean" ? payload.paused : null,
          };

          playbackInfoRef.current = nextInfo;
          setPlaybackInfo(nextInfo);
          applyPlaybackSnapshotToClock(nextInfo);

          if (typeof nextInfo.timePosSeconds === "number" && Number.isFinite(nextInfo.timePosSeconds)) {
            lastTimeRef.current = nextInfo.timePosSeconds;
            lastTimePosEventAtMsRef.current =
              typeof payload?.atMs === "number" && Number.isFinite(payload.atMs) ? payload.atMs : Date.now();
          }

          if (payload?.connected === false) {
            playerDeadRef.current = true;
            setConnectionError("Player disconnected");
          } else {
            if (playerDeadRef.current) {
              playerDeadRef.current = false;
            }
            setConnectionError(null);
          }

          if (hasPlaybackSnapshot(nextInfo)) {
            setPlaybackError(null);
          }

          const waiter = snapshotWaiterRef.current;
          if (waiter && waiter.mediaKey === mediaKey && waiter.attempt === startupAttemptRef.current && hasPlaybackSnapshot(nextInfo)) {
            window.clearTimeout(waiter.timeoutId);
            snapshotWaiterRef.current = null;
            waiter.resolve(nextInfo);
          }
        })
        .catch((err) => {
          debugLog(`playback listener failed: ${String(err)}`).catch(() => {});
          return null;
        });

      // Keep listener setup resilient: a failure registering one handler should not
      // prevent pause/seek/close from working.
      let lastToggleAt = 0;
      unlistenKey = await win
        .listen<string>(PLAYER_KEY_EVENT, (event) => {
          const action = String(event.payload || "");
          debugLog(`player key event: ${action}`).catch(() => {});
          bumpControlsRef.current();
          if (action === "toggle_pause") {
            const now = Date.now();
            if (now - lastToggleAt < 300) {
              debugLog("player key event: toggle_pause blocked (duplicate)").catch(() => {});
              return; // 🔥 prevent double fire from overlay + mpv
            }
            lastToggleAt = now;
            togglePause().catch(() => {});
            return;
          }
          if (action === "seek_back") {
            seekDelta(-10).catch(() => {});
            return;
          }
          if (action === "seek_forward") {
            seekDelta(10).catch(() => {});
            return;
          }
          if (action === "volume_up") {
            adjustVolume(5).catch(() => {});
            return;
          }
          if (action === "volume_down") {
            adjustVolume(-5).catch(() => {});
            return;
          }
          if (action === "brightness_up") {
            adjustBrightness(3).catch(() => {});
            return;
          }
          if (action === "brightness_down") {
            adjustBrightness(-3).catch(() => {});
            return;
          }
          if (action === "fullscreen") {
            toggleFullscreenRef.current();
            return;
          }
          if (action === "close") {
            exitFullscreenOrClose().catch(() => {});
          }
        })
        .catch((err) => {
          debugLog(`key listener failed: ${String(err)}`).catch(() => {});
          return null;
        });

      unlistenActivity = await win
        .listen(PLAYER_ACTIVITY_EVENT, () => {
          bumpControlsRef.current();
        })
        .catch((err) => {
          debugLog(`activity listener failed: ${String(err)}`).catch(() => {});
          return null;
        });

      unlistenLoad = await win
        .listen<PlayerOpenPayload>(PLAYER_LOAD_EVENT, (event) => {
          startPlayback(event.payload).catch((err) =>
            toast.error((err as { message?: string })?.message || "Failed to start playback"),
          );
        })
        .catch((err) => {
          debugLog(`load listener failed: ${String(err)}`).catch(() => {});
          return null;
        });

      unlistenVideoClick = await win
        .listen(PLAYER_VIDEO_CLICK_EVENT, () => {
          const now = Date.now();
          bumpControlsRef.current();
          win.setFocus().catch(() => {});
          if (now - lastVideoClickAtRef.current <= 320) {
            toggleFullscreenRef.current();
            lastVideoClickAtRef.current = 0;
            return;
          }
          lastVideoClickAtRef.current = now;
        })
        .catch((err) => {
          debugLog(`video click listener failed: ${String(err)}`).catch(() => {});
          return null;
        });

      unlistenResize = await win
        .onResized(() => {
          win.isFullscreen().then(setIsFullscreen).catch(() => {});
          scheduleOverlayRegionSyncRef.current();
        })
        .catch((err) => {
          debugLog(`resize listener failed: ${String(err)}`).catch(() => {});
          return null;
        });

      unlistenClose = await win
        .onCloseRequested(async () => {
          await shutdownPlayerWindow(false, "system_close");
        })
        .catch((err) => {
          debugLog(`close listener failed: ${String(err)}`).catch(() => {});
          return null;
        });

      // Best-effort webview handle for background color control (don’t fail listener setup if missing).
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        webviewRef.current = getCurrentWebview();
        webviewBgAlphaRef.current = null;
        // Start opaque so we never flash the underlying desktop while mpv attaches.
        setWebviewBgAlpha(1);
      } catch (err) {
        debugLog(`getCurrentWebview failed: ${String(err)}`).catch(() => {});
      }

      debugLog("player listeners ready").catch(() => {});
      listenersReadyRef.current?.resolve();
      win.isFullscreen().then(setIsFullscreen).catch(() => {});
      scheduleOverlayRegionSyncRef.current();
    })().catch((err) => {
      debugLog(`listener init failed: ${String(err)}`).catch(() => {});
      listenersReadyRef.current?.resolve();
    });

    return () => {
      document.body.classList.remove("cinevault-player-transparent");
      document.documentElement.classList.remove("cinevault-player-transparent");
      unlistenLoad?.();
      unlistenResize?.();
      unlistenClose?.();
      unlistenActivity?.();
      unlistenKey?.();
      unlistenPlayback?.();
      unlistenVideoClick?.();
      clearHideTimer();
      clearCursorHideTimer();
      clearFeedbackHudTimer();
      if (overlaySyncRafRef.current != null) {
        window.cancelAnimationFrame(overlaySyncRafRef.current);
        overlaySyncRafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mediaPathRef.current = mediaPath.trim();
  }, [mediaPath]);

  useEffect(() => {
    playbackInfoRef.current = playbackInfo;
  }, [playbackInfo]);

  useEffect(() => {
    if (!isTauriRuntime() || !mediaPath.trim() || paused !== true) return;
    persistResumePoint(mediaPath).catch(() => {});
  }, [mediaPath, paused, persistResumePoint]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    scheduleOverlayRegionSync();
  }, [controlsHovering, controlsVisible, fullOverlay, hasMedia, isFullscreen, playbackError, scheduleOverlayRegionSync]);

  useEffect(() => {
    if (fullOverlay) {
      setControlsVisible(true);
      setCursorVisible(true);
      clearHideTimer();
      clearCursorHideTimer();
      return;
    }
    bumpControlsRef.current();
    return () => {
      clearHideTimer();
      clearCursorHideTimer();
    };
  }, [controlsHovering, fullOverlay, mediaPath, paused, scheduleControlsHide, scrubSeconds]);

  useEffect(() => {
    if (!initialMediaPath) return;
    startPlayback({ mediaPath: initialMediaPath, startPositionSeconds: initialStart, displayTitle: initialDisplayTitle || null }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMediaPath]);

  useEffect(() => {
    if (!isTauriRuntime() || !mediaPath.trim() || !settingsOpen) return;
    refreshTracksAndSubs(mediaPath).catch(() => {});
    refreshRenderSettings(mediaPath).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaPath, settingsOpen]);

  useEffect(() => {
    if (isTauriRuntime()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTauriRuntime()) return;
      if (!mediaPath.trim()) return;
      bumpControlsRef.current();
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        togglePause().catch(() => {});
      } else if (event.key === "ArrowLeft") {
        seekDelta(-10).catch(() => {});
      } else if (event.key === "ArrowRight") {
        seekDelta(10).catch(() => {});
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        adjustVolume(5).catch(() => {});
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        adjustVolume(-5).catch(() => {});
      } else if (event.key.toLowerCase() === "b") {
        adjustBrightness(3).catch(() => {});
      } else if (event.key.toLowerCase() === "n") {
        adjustBrightness(-3).catch(() => {});
      } else if (event.key.toLowerCase() === "f" || event.key === "Enter") {
        toggleFullscreen().catch(() => {});
      } else if (event.key === "Escape") {
        exitFullscreenOrClose().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaPath]);

  const handlePlayerWheel = (event: WheelEvent<HTMLDivElement>) => {
    bumpControlsRef.current();
    if (settingsOpen || !mediaPath.trim()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-player-slider]")) return;
    event.preventDefault();
    if (event.ctrlKey) {
      adjustBrightness(event.deltaY > 0 ? -3 : 3).catch(() => {});
      return;
    }
    adjustVolume(event.deltaY > 0 ? -5 : 5).catch(() => {});
  };

  const handlePointerMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const now = Date.now();
    if (now - lastPointerMoveRef.current.at < 40) return;
    lastPointerMoveRef.current = { at: now, x: event.clientX, y: event.clientY };
    bumpControlsRef.current();
  };

  const handlePlayerDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("button, input, select, textarea, a, [data-player-slider]")) return;
    toggleFullscreenRef.current();
  };

  const handleTimelineHover = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!hasMedia || duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    setHoverRatio(ratio);
    setHoverTime(ratio * duration);
    bumpControlsRef.current();
  };

  const retryPlayback = async () => {
    const payload = lastPayloadRef.current;
    if (!payload) return;
    await startPlayback(payload);
  };

  if (!isTauriRuntime()) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div className="glass-card max-w-md rounded-3xl p-8">
          <div className="text-lg font-semibold">Desktop Player</div>
          <p className="mt-2 text-sm text-muted-foreground">This route runs inside the CineVault desktop runtime.</p>
        </div>
      </div>
    );
  }

  const status = playbackError
    ? "Error"
    : connectionError
      ? "Reconnecting"
      : !mediaPath.trim()
        ? "Idle"
        : showLoading
          ? "Starting"
          : paused
            ? "Paused"
            : "Playing";
  const sliderMax = duration > 0 ? duration : 100;
  const audioSummary = trackLabel(activeAudio, tracks.audio.length ? "Audio ready" : "No audio info");
  const subtitleSummary = subtitleTrackId === 0 ? "Subs off" : trackLabel(activeSubtitle, "Subtitle ready");
  const volumeValue = Math.round(renderSettings.volume ?? DEFAULT_RENDER_SETTINGS.volume ?? 100);
  const brightnessValue = Math.round(renderSettings.brightness ?? DEFAULT_RENDER_SETTINGS.brightness ?? 0);
  const subtitleFontSize = renderSettings.subtitleFontSize ?? DEFAULT_RENDER_SETTINGS.subtitleFontSize ?? 48;
  const subtitleBorderSize = renderSettings.subtitleBorderSize ?? DEFAULT_RENDER_SETTINGS.subtitleBorderSize ?? 2;
  const subtitleShadowOffset = renderSettings.subtitleShadowOffset ?? DEFAULT_RENDER_SETTINGS.subtitleShadowOffset ?? 1;
  const subtitlePosition = renderSettings.subtitlePosition ?? DEFAULT_RENDER_SETTINGS.subtitlePosition ?? 92;
  const brightnessLabel = `${brightnessValue > 0 ? "+" : ""}${brightnessValue}`;
  const edgeTriggerStateClass = controlsVisible || fullOverlay ? "pointer-events-none opacity-0" : "pointer-events-auto opacity-100";
  const topShellStateClass = controlsVisible ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-full opacity-0";
  const bottomShellStateClass = controlsVisible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0";
  const topContentStateClass = controlsVisible ? "opacity-100 translate-y-0" : "-translate-y-5 opacity-0";
  const bottomContentStateClass = controlsVisible ? "opacity-100 translate-y-0" : "translate-y-5 opacity-0";
  const cursorStateClass = allowAutoHide && !cursorVisible ? "cursor-none" : "cursor-default";
  const baseBackdropOpacityClass = hasMedia && !playbackError && !settingsOpen ? "opacity-0" : "opacity-100";

  return (
    <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
      <div
        className={`relative min-h-screen overflow-hidden bg-black text-white ${cursorStateClass}`}
        style={shellStyle}
        onMouseMove={handlePointerMove}
        onMouseDown={() => {
          bumpControlsRef.current();
          winRef.current?.setFocus?.().catch?.(() => {});
        }}
        onDoubleClick={handlePlayerDoubleClick}
        onWheel={handlePlayerWheel}
      >
        <div
          className={`pointer-events-none absolute inset-0 z-0 bg-[#05070b] transition-opacity duration-300 ${baseBackdropOpacityClass}`}
        />

        {(playbackError || !mediaPath.trim()) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center px-6">
            <div className="w-full max-w-xl rounded-[24px] border border-white/10 bg-[#08111a]/82 px-8 py-10 text-center shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-white/[0.04]">
                {playbackError ? (
                  <X className="h-7 w-7 text-rose-200" />
                ) : (
                  <Play className="h-7 w-7 text-amber-200" fill="currentColor" />
                )}
              </div>
              <div className="mt-6 text-[11px] uppercase tracking-[0.34em] text-sky-200/80">
                {playbackError ? "Playback error" : "Ready"}
              </div>
              <h2 className="mt-3 text-3xl font-semibold">
                {playbackError ? "Playback could not start" : "Nothing playing yet"}
              </h2>
              <p className="mt-4 text-sm leading-6 text-white/60">
                {playbackError || "Start a title from the library to launch playback here."}
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                {playbackError && (
                  <Button
                    onClick={() => retryPlayback().catch((err) => toast.error(errorMessage(err, "Retry failed")))}
                    className="rounded-full bg-[linear-gradient(135deg,#8be0ff,#7cf1c5)] px-6 text-[#091218] hover:brightness-105"
                  >
                    Retry
                  </Button>
                )}
                <Button onClick={() => closeWindow().catch(() => {})} className="rounded-full bg-white/[0.08] px-6 text-white hover:bg-white/[0.14]">Close</Button>
              </div>
            </div>
          </div>
        )}

        {feedbackHud && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center px-6">
            <div className="rounded-[20px] border border-white/10 bg-[#050b12]/78 px-6 py-4 text-center shadow-[0_22px_70px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
              <div className="flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.28em] text-white/56">
                {feedbackHud.kind === "volume" ? (
                  <Volume2 className="h-4 w-4" />
                ) : feedbackHud.kind === "brightness" ? (
                  <SunMedium className="h-4 w-4" />
                ) : "icon" in feedbackHud && feedbackHud.icon === "maximize" ? (
                  <Maximize className="h-4 w-4" />
                ) : (
                  <Minimize className="h-4 w-4" />
                )}
                <span>
                  {feedbackHud.kind === "volume"
                    ? "Volume"
                    : feedbackHud.kind === "brightness"
                      ? "Brightness"
                      : "Display mode"}
                </span>
              </div>
              <div className="mt-2 text-3xl font-semibold">
                {feedbackHud.kind === "status"
                  ? feedbackHud.label
                  : feedbackHud.kind === "volume"
                    ? `${Math.round(feedbackHud.value)}%`
                    : `${Math.round(feedbackHud.value) > 0 ? "+" : ""}${Math.round(feedbackHud.value)}`}
              </div>
            </div>
          </div>
        )}

        <div
          ref={topEdgeTriggerRef}
          className={`absolute inset-x-0 top-0 z-10 h-10 bg-transparent transition-opacity duration-200 ${edgeTriggerStateClass}`}
          onMouseEnter={() => bumpControlsRef.current()}
          onMouseMove={() => bumpControlsRef.current()}
        />
        <div
          ref={bottomEdgeTriggerRef}
          className={`absolute inset-x-0 bottom-0 z-10 h-12 bg-transparent transition-opacity duration-200 ${edgeTriggerStateClass}`}
          onMouseEnter={() => bumpControlsRef.current()}
          onMouseMove={() => bumpControlsRef.current()}
        />

        <div
          ref={topShellRef}
          className={`absolute inset-x-0 top-0 z-20 overflow-visible bg-transparent transition-[opacity,transform] duration-250 ease-out ${topShellStateClass}`}
          onMouseEnter={() => {
            setControlsHovering(true);
            bumpControlsRef.current();
          }}
          onMouseLeave={() => {
            setControlsHovering(false);
            scheduleControlsHide();
          }}
        >
          <div className={`pointer-events-auto mx-auto flex max-w-[1700px] items-start gap-4 px-4 py-3 transition-all duration-250 ease-out sm:px-6 ${topContentStateClass}`}>
            <div className="flex min-w-0 flex-1 items-start gap-4">
              <div className="min-w-0 flex-1" data-tauri-drag-region>
                <div className="text-[10px] uppercase tracking-[0.28em] text-white/62 drop-shadow-[0_2px_8px_rgba(0,0,0,0.85)]">
                  {status}{mediaPath.trim() ? ` | ${tracks.audio.length} audio | ${tracks.subtitles.length} subs` : ""}
                </div>
                <h1 className="mt-2 truncate text-xl font-semibold tracking-tight drop-shadow-[0_3px_12px_rgba(0,0,0,0.9)] sm:text-[1.65rem]">{title || "Untitled Session"}</h1>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-white/72">
                  <span className="rounded-lg border border-white/12 bg-black/38 px-3 py-1 shadow-[0_8px_22px_rgba(0,0,0,0.22)] backdrop-blur-md">{audioSummary}</span>
                  <span className="rounded-lg border border-white/12 bg-black/38 px-3 py-1 shadow-[0_8px_22px_rgba(0,0,0,0.22)] backdrop-blur-md">{subtitleSummary}</span>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" onClick={() => setSettingsOpen(true)} className="h-10 rounded-xl border border-white/12 bg-black/45 px-4 text-white shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur-md transition-transform duration-200 ease-out hover:scale-[1.02] hover:bg-black/62 active:scale-[0.96]"><Settings className="h-4 w-4" /><span className="hidden sm:inline">Settings</span></Button>
              <Button variant="ghost" onClick={() => toggleFullscreen().catch(() => {})} className="h-10 w-10 rounded-xl border border-white/12 bg-black/45 text-white shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur-md transition-transform duration-200 ease-out hover:scale-[1.02] hover:bg-black/62 active:scale-[0.96]">{isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}</Button>
              <Button variant="ghost" onClick={() => closeWindow().catch(() => {})} className="h-10 w-10 rounded-xl border border-white/12 bg-black/45 text-white shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur-md transition-transform duration-200 ease-out hover:scale-[1.02] hover:bg-orange-300/18 active:scale-[0.96]"><X className="h-4 w-4" /></Button>
            </div>
          </div>
        </div>

        <div
          ref={bottomShellRef}
          className={`absolute inset-x-0 bottom-0 z-20 overflow-visible bg-transparent transition-[opacity,transform] duration-250 ease-out ${bottomShellStateClass}`}
          onMouseEnter={() => {
            setControlsHovering(true);
            bumpControlsRef.current();
          }}
          onMouseLeave={() => {
            setControlsHovering(false);
            scheduleControlsHide();
          }}
        >
          <div className={`pointer-events-auto mx-auto max-w-[1700px] px-3 pb-3 transition-all duration-250 ease-out sm:px-5 ${bottomContentStateClass}`}>
            <div className="flex flex-col gap-2 rounded-[18px] border border-white/10 bg-black/42 px-3 py-2 shadow-[0_14px_44px_rgba(0,0,0,0.32)] backdrop-blur-xl lg:flex-row lg:items-center">
              <div className="flex shrink-0 items-center justify-center gap-1.5">
                <Button variant="ghost" size="icon" onClick={() => seekDelta(-10).catch(() => {})} className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.05] text-white transition-transform duration-200 ease-out hover:scale-[1.02] hover:bg-white/[0.12] active:scale-[0.92]" disabled={!mediaPath.trim()}><RotateCcw className="h-4 w-4" /></Button>
                <Button
                  onClick={() => togglePause().catch(() => {})}
                  className="h-9 w-9 rounded-full bg-[linear-gradient(135deg,#ffc078,#ff8c69)] p-0 text-[#1d120b] shadow-[0_14px_28px_rgba(255,152,103,0.18)] transition-transform duration-200 ease-out hover:scale-[1.02] hover:brightness-105 active:scale-[0.94]"
                  disabled={!mediaPath.trim()}
                  aria-label={paused ? "Play" : "Pause"}
                >
                  <span className="relative inline-flex h-4 w-4 items-center justify-center">
                    <Play
                      className={`absolute h-4 w-4 transition-[opacity,transform] duration-200 ease-out ${paused ? "opacity-100 scale-100" : "opacity-0 scale-75"}`}
                      fill="currentColor"
                    />
                    <Pause
                      className={`absolute h-4 w-4 transition-[opacity,transform] duration-200 ease-out ${paused ? "opacity-0 scale-75" : "opacity-100 scale-100"}`}
                    />
                  </span>
                </Button>
                <Button variant="ghost" size="icon" onClick={() => seekDelta(10).catch(() => {})} className="h-9 w-9 rounded-full border border-white/10 bg-white/[0.05] text-white transition-transform duration-200 ease-out hover:scale-[1.02] hover:bg-white/[0.12] active:scale-[0.92]" disabled={!mediaPath.trim()}><RotateCw className="h-4 w-4" /></Button>
              </div>

              <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-white/60">
                <span className="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1" style={monoStyle}>
                  {formatTimeShort(shownTime)}
                </span>
                <div
                  className="relative min-w-0 flex-1"
                  data-player-slider="timeline"
                  onMouseMove={handleTimelineHover}
                  onMouseLeave={() => setHoverTime(null)}
                >
                  {hoverTime != null && duration > 0 && (
                    <div
                      className="pointer-events-none absolute -top-9 z-10 rounded-lg border border-white/10 bg-[#07111a]/92 px-2.5 py-1 text-[11px] text-white/78 shadow-[0_10px_24px_rgba(0,0,0,0.26)] backdrop-blur-xl"
                      style={{ left: `${hoverRatio * 100}%`, transform: "translateX(-50%)" }}
                    >
                      {formatTimeShort(hoverTime)}
                    </div>
                  )}
                  <Slider
                    value={[Math.min(sliderMax, Math.max(0, shownTime))]}
                    min={0}
                    max={sliderMax}
                    step={0.25}
                    onValueChange={(value) => {
                      setScrubSeconds(value[0] ?? 0);
                      bumpControlsRef.current();
                    }}
                    onValueCommit={(value) => {
                      setScrubSeconds(null);
                      seekTo(value[0] ?? 0).catch((err) => toast.error((err as { message?: string })?.message || "Seek failed"));
                    }}
                    className="w-full"
                    trackClassName="h-1.5 rounded-full bg-black/36 shadow-[0_1px_4px_rgba(0,0,0,0.3)]"
                    rangeClassName="bg-[linear-gradient(90deg,#59d8ff,#ffbe77)]"
                    thumbClassName="h-4 w-4 border border-white/70 bg-white shadow-[0_0_0_4px_rgba(89,216,255,0.18)]"
                    disabled={!mediaPath.trim() || duration <= 0}
                  />
                </div>
                <span className="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1" style={monoStyle}>
                  {duration > 0 ? formatTimeShort(duration) : "LIVE"}
                </span>
              </div>

              <div className="hidden shrink-0 items-center gap-2 text-[11px] text-white/52 xl:flex">
                <span className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1">Vol {volumeValue}%</span>
                <span className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1">Bright {brightnessLabel}</span>
              </div>
            </div>
          </div>
        </div>

        <SheetContent side="right" className="w-full border-l border-white/10 bg-[#06101a]/96 p-0 text-white backdrop-blur-3xl sm:max-w-[440px]" onOpenAutoFocus={(event) => event.preventDefault()}>
          <div className="h-full overflow-y-auto px-5 py-6">
            <SheetHeader className="pr-8 text-left">
              <div className="text-[11px] uppercase tracking-[0.34em] text-sky-200/78">Playback settings</div>
              <SheetTitle className="mt-2 text-2xl font-semibold tracking-tight text-white">Audio, picture, subtitles</SheetTitle>
              <SheetDescription className="text-sm leading-6 text-white/58">Adjust playback without leaving the player.</SheetDescription>
            </SheetHeader>

            <div className="mt-6 space-y-5">
              <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-4">
                <div className="text-[10px] uppercase tracking-[0.34em] text-white/44">Current file</div>
                <div className="mt-3 text-lg font-semibold">{title || "Untitled Session"}</div>
                <div className="mt-3 text-[11px] leading-5 text-white/42" style={monoStyle}>{mediaPath || "No media path assigned"}</div>
              </section>

              <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-4">
                <div className="space-y-4">
                  <div>
                    <Label className="text-[11px] uppercase tracking-[0.28em] text-white/46">Audio track</Label>
                    <Select value={audioTrackId != null ? String(audioTrackId) : "none"} onValueChange={(value) => {
                      if (value === "none") return;
                      setAudioTrackId(Number(value));
                      playerSetAudioTrack(mediaPath, Number(value)).then(() => refreshTracksAndSubs(mediaPath)).catch((err) => toast.error((err as { message?: string })?.message || "Audio switch failed"));
                    }}>
                      <SelectTrigger className="mt-2 h-12 rounded-2xl border-white/10 bg-white/[0.04] text-white"><SelectValue placeholder="Audio track" /></SelectTrigger>
                      <SelectContent className="border-white/10 bg-[#08131f] text-white">
                        {tracks.audio.length === 0 ? <SelectItem value="none">No audio metadata</SelectItem> : tracks.audio.map((track) => <SelectItem key={track.id} value={String(track.id)}>{trackLabel(track, `Track ${track.id}`)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label className="text-[11px] uppercase tracking-[0.28em] text-white/46">Subtitle track</Label>
                    <Select value={String(subtitleTrackId)} onValueChange={(value) => {
                      setSubtitleTrackId(Number(value));
                      playerSetSubtitleTrack(mediaPath, Number(value)).then(() => refreshTracksAndSubs(mediaPath)).catch((err) => toast.error((err as { message?: string })?.message || "Subtitle switch failed"));
                    }}>
                      <SelectTrigger className="mt-2 h-12 rounded-2xl border-white/10 bg-white/[0.04] text-white"><SelectValue placeholder="Subtitle track" /></SelectTrigger>
                      <SelectContent className="border-white/10 bg-[#08131f] text-white">
                        <SelectItem value="0">Off</SelectItem>
                        {tracks.subtitles.map((track) => <SelectItem key={track.id} value={String(track.id)}>{trackLabel(track, `Subtitle ${track.id}`)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>

              <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.34em] text-white/44">Picture and sound</div>
                    <p className="mt-2 text-sm leading-6 text-white/52">Wheel adjusts volume, Ctrl+wheel adjusts brightness while the sheet is closed.</p>
                  </div>
                </div>

                <div className="mt-4 space-y-4">
                  <div data-player-slider="volume">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-[11px] uppercase tracking-[0.28em] text-white/46">Volume</Label>
                      <span className="text-sm font-medium text-white/74">{volumeValue}%</span>
                    </div>
                    <Slider
                      className="mt-3"
                      value={[volumeValue]}
                      min={0}
                      max={130}
                      step={1}
                      onValueChange={(value) => mergeRenderSettings({ volume: value[0] ?? volumeValue })}
                      onValueCommit={(value) => {
                        setVolumeTo(value[0] ?? volumeValue).catch((err) =>
                          toast.error((err as { message?: string })?.message || "Volume update failed"),
                        );
                      }}
                      trackClassName="h-3 rounded-full bg-white/[0.08]"
                      rangeClassName="bg-[linear-gradient(90deg,#5dd2ff,#8bf3cb)]"
                      thumbClassName="h-[18px] w-[18px] border border-white/70 bg-white shadow-[0_0_0_4px_rgba(93,210,255,0.18)]"
                    />
                  </div>

                  <div data-player-slider="brightness">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-[11px] uppercase tracking-[0.28em] text-white/46">Brightness</Label>
                      <span className="text-sm font-medium text-white/74">{brightnessLabel}</span>
                    </div>
                    <Slider
                      className="mt-3"
                      value={[brightnessValue]}
                      min={-100}
                      max={100}
                      step={1}
                      onValueChange={(value) => mergeRenderSettings({ brightness: value[0] ?? brightnessValue })}
                      onValueCommit={(value) => {
                        setBrightnessTo(value[0] ?? brightnessValue).catch((err) =>
                          toast.error((err as { message?: string })?.message || "Brightness update failed"),
                        );
                      }}
                      trackClassName="h-3 rounded-full bg-white/[0.08]"
                      rangeClassName="bg-[linear-gradient(90deg,#6578ff,#ffb86b)]"
                      thumbClassName="h-[18px] w-[18px] border border-white/70 bg-white shadow-[0_0_0_4px_rgba(101,120,255,0.18)]"
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.34em] text-white/44">Subtitle styling</div>
                    <p className="mt-2 text-sm leading-6 text-white/52">Change subtitle scale, outline, shadow, and vertical position for this player session.</p>
                  </div>
                  <Button
                    variant="ghost"
                    className="h-9 rounded-full border border-white/10 bg-white/[0.04] px-3 text-white hover:bg-white/[0.12]"
                    onClick={() =>
                      commitSubtitleStyle({
                        fontSize: DEFAULT_RENDER_SETTINGS.subtitleFontSize,
                        borderSize: DEFAULT_RENDER_SETTINGS.subtitleBorderSize,
                        shadowOffset: DEFAULT_RENDER_SETTINGS.subtitleShadowOffset,
                        position: DEFAULT_RENDER_SETTINGS.subtitlePosition,
                      }).catch((err) => toast.error((err as { message?: string })?.message || "Subtitle reset failed"))
                    }
                    disabled={!mediaPath.trim()}
                  >
                    Reset
                  </Button>
                </div>

                <div className="mt-4 space-y-4">
                  <div data-player-slider="subtitle-font">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-[11px] uppercase tracking-[0.28em] text-white/46">Font size</Label>
                      <span className="text-sm font-medium text-white/74">{Math.round(subtitleFontSize)}</span>
                    </div>
                    <Slider
                      className="mt-3"
                      value={[subtitleFontSize]}
                      min={18}
                      max={80}
                      step={1}
                      onValueChange={(value) => mergeRenderSettings({ subtitleFontSize: value[0] ?? subtitleFontSize })}
                      onValueCommit={(value) => {
                        commitSubtitleStyle({ fontSize: value[0] ?? subtitleFontSize }).catch((err) =>
                          toast.error((err as { message?: string })?.message || "Subtitle size update failed"),
                        );
                      }}
                    />
                  </div>

                  <div data-player-slider="subtitle-border">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-[11px] uppercase tracking-[0.28em] text-white/46">Outline</Label>
                      <span className="text-sm font-medium text-white/74">{subtitleBorderSize.toFixed(1)}</span>
                    </div>
                    <Slider
                      className="mt-3"
                      value={[subtitleBorderSize]}
                      min={0}
                      max={6}
                      step={0.25}
                      onValueChange={(value) => mergeRenderSettings({ subtitleBorderSize: value[0] ?? subtitleBorderSize })}
                      onValueCommit={(value) => {
                        commitSubtitleStyle({ borderSize: value[0] ?? subtitleBorderSize }).catch((err) =>
                          toast.error((err as { message?: string })?.message || "Subtitle outline update failed"),
                        );
                      }}
                    />
                  </div>

                  <div data-player-slider="subtitle-shadow">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-[11px] uppercase tracking-[0.28em] text-white/46">Shadow</Label>
                      <span className="text-sm font-medium text-white/74">{subtitleShadowOffset.toFixed(1)}</span>
                    </div>
                    <Slider
                      className="mt-3"
                      value={[subtitleShadowOffset]}
                      min={0}
                      max={6}
                      step={0.25}
                      onValueChange={(value) => mergeRenderSettings({ subtitleShadowOffset: value[0] ?? subtitleShadowOffset })}
                      onValueCommit={(value) => {
                        commitSubtitleStyle({ shadowOffset: value[0] ?? subtitleShadowOffset }).catch((err) =>
                          toast.error((err as { message?: string })?.message || "Subtitle shadow update failed"),
                        );
                      }}
                    />
                  </div>

                  <div data-player-slider="subtitle-position">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-[11px] uppercase tracking-[0.28em] text-white/46">Vertical position</Label>
                      <span className="text-sm font-medium text-white/74">{Math.round(subtitlePosition)}%</span>
                    </div>
                    <Slider
                      className="mt-3"
                      value={[subtitlePosition]}
                      min={70}
                      max={100}
                      step={1}
                      onValueChange={(value) => mergeRenderSettings({ subtitlePosition: value[0] ?? subtitlePosition })}
                      onValueCommit={(value) => {
                        commitSubtitleStyle({ position: value[0] ?? subtitlePosition }).catch((err) =>
                          toast.error((err as { message?: string })?.message || "Subtitle position update failed"),
                        );
                      }}
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-4">
                <div className="text-[10px] uppercase tracking-[0.34em] text-white/44">Quick actions</div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="ghost" className="h-11 rounded-full border border-white/10 bg-white/[0.05] px-4 text-white hover:bg-white/[0.12]" onClick={() => {
                    desktopPickSubtitleFile().then((path) => {
                      if (!path) return;
                      return playerAddExternalSubtitle(mediaPath, path).then(() => refreshTracksAndSubs(mediaPath)).then(() => toast.success("Subtitle imported"));
                    }).catch((err) => toast.error((err as { message?: string })?.message || "Subtitle import failed"));
                  }} disabled={!mediaPath.trim()}>Import subtitle</Button>
                  <Button variant="ghost" className="h-11 rounded-full border border-white/10 bg-white/[0.05] px-4 text-white hover:bg-white/[0.12]" onClick={() => refreshAll(mediaPath).catch((err) => toast.error((err as { message?: string })?.message || "Refresh failed"))} disabled={!mediaPath.trim()}><RefreshCw className="h-4 w-4" />Sync player</Button>
                </div>
              </section>

              <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-4">
                <div className="text-[10px] uppercase tracking-[0.34em] text-white/44">External subtitles</div>
                {externalSubtitles.length === 0 ? (
                  <p className="mt-4 text-sm leading-6 text-white/52">Imported subtitle files appear here for quick cleanup.</p>
                ) : (
                  <div className="mt-4 space-y-2">
                    {externalSubtitles.map((path) => (
                      <div key={path} className="rounded-[22px] border border-white/10 bg-white/[0.04] px-3 py-3">
                        <div className="truncate text-[11px] text-white/56" style={monoStyle}>{path}</div>
                        <div className="mt-3 flex justify-end">
                          <Button variant="ghost" className="h-9 rounded-full border border-white/10 bg-white/[0.04] px-3 text-white hover:bg-white/[0.12]" onClick={() => playerRemoveExternalSubtitle(mediaPath, path).then(() => refreshTracksAndSubs(mediaPath)).catch((err) => toast.error((err as { message?: string })?.message || "Remove failed"))}>Remove</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        </SheetContent>
      </div>
    </Sheet>
  );
}
