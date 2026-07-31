export function isTauriRuntime(): boolean {
  const w = window as unknown as Record<string, unknown> | undefined;
  if (!w) return false;
  return Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

async function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) return undefined as unknown as T;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, args);
}

export async function debugLog(message: string): Promise<void> {
  await desktopInvoke<void>("debug_log", { message });
}

export type PlayerTrack = {
  id: number;
  label: string;
  lang?: string | null;
  selected: boolean;
};

export type PlayerTracks = {
  audio: PlayerTrack[];
  subtitles: PlayerTrack[];
};

export type PlaybackInfo = {
  timePosSeconds: number | null;
  durationSeconds: number | null;
  paused: boolean | null;
};

type PlaybackInfoShape = {
  timePosSeconds?: unknown;
  durationSeconds?: unknown;
  paused?: unknown;
};

export type PlayerRenderSettings = {
  volume: number | null;
  brightness: number | null;
  subtitleFontSize: number | null;
  subtitleBorderSize: number | null;
  subtitleShadowOffset: number | null;
  subtitlePosition: number | null;
};

export type PlayerSubtitleStyleInput = {
  fontSize?: number | null;
  borderSize?: number | null;
  shadowOffset?: number | null;
  position?: number | null;
};

const VIDEO_EXTENSIONS = ["mkv", "mp4", "avi", "mov", "m4v", "webm", "ts"];
const SUBTITLE_EXTENSIONS = ["srt", "ass", "ssa", "sub", "vtt"];

export type TvEpisode = {
  season: number;
  episode: number;
  title: string;
  path?: string;
  overview?: string;
  runtimeMinutes?: number;
  airDate?: string;
  stillUrl?: string;
};

export type TvShowScanResult = {
  rootPath: string;
  seasons: number;
  episodes: number;
  episodeList: TvEpisode[];
};

export async function libraryScanTvShow(rootPath: string): Promise<TvShowScanResult> {
  if (!isTauriRuntime()) throw new Error("Not running in desktop runtime");
  const raw = await desktopInvoke<unknown>("library_scan_tv_show", { rootPath });
  return normalizeTvShowScanResult(raw);
}

function normalizeTvShowScanResult(raw: unknown): TvShowScanResult {
  const value = (raw ?? {}) as Record<string, unknown>;
  const root =
    (typeof value.rootPath === "string" && value.rootPath.trim()) ||
    (typeof value.root_path === "string" && value.root_path.trim()) ||
    "";
  const seasons = typeof value.seasons === "number" && Number.isFinite(value.seasons) ? value.seasons : 0;
  const episodes = typeof value.episodes === "number" && Number.isFinite(value.episodes) ? value.episodes : 0;
  const listRaw = (value.episodeList ?? value.episode_list) as unknown;
  const episodeList = Array.isArray(listRaw) ? listRaw.map(normalizeTvEpisode).filter(Boolean) as TvEpisode[] : [];
  if (!root) {
    throw new Error("TV scan result missing rootPath");
  }
  return { rootPath: root, seasons, episodes, episodeList };
}

function normalizeTvEpisode(raw: unknown): TvEpisode | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const season = typeof value.season === "number" && Number.isFinite(value.season) ? value.season : 1;
  const episode = typeof value.episode === "number" && Number.isFinite(value.episode) ? value.episode : 1;
  const title = typeof value.title === "string" ? value.title : "";
  // IMPORTANT: `store.ts` normalizers treat missing/invalid as `undefined` (not `null`).
  // Returning `null` here causes paths to be dropped when saving to app state, making episodes look unmapped.
  const path = typeof value.path === "string" ? value.path.trim() : undefined;
  return {
    season,
    episode,
    title,
    path,
    overview: typeof value.overview === "string" ? value.overview : undefined,
    runtimeMinutes:
      typeof value.runtimeMinutes === "number"
        ? value.runtimeMinutes
        : typeof value.runtime_minutes === "number"
          ? value.runtime_minutes
          : undefined,
    airDate:
      typeof value.airDate === "string"
        ? value.airDate
        : typeof value.air_date === "string"
          ? value.air_date
          : undefined,
    stillUrl:
      typeof value.stillUrl === "string"
        ? value.stillUrl
        : typeof value.still_url === "string"
          ? value.still_url
          : undefined,
  };
}

export async function desktopPickVideoFile(defaultPath?: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: "Select Video File",
    multiple: false,
    directory: false,
    defaultPath,
    filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function desktopPickSubtitleFile(defaultPath?: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: "Select Subtitle File",
    multiple: false,
    directory: false,
    defaultPath,
    filters: [{ name: "Subtitles", extensions: SUBTITLE_EXTENSIONS }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function desktopPickFolder(defaultPath?: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: "Select Folder",
    multiple: false,
    directory: true,
    defaultPath,
  });
  return typeof selected === "string" ? selected : null;
}

export async function playerPlayPath(mediaPath: string, startPositionSeconds?: number | null): Promise<void> {
  await desktopInvoke<void>("player_play_path", {
    mediaPath,
    startPositionSeconds: startPositionSeconds ?? null,
  });
}

export async function playerStop(): Promise<void> {
  await desktopInvoke<void>("player_stop");
}

export async function playerSetOverlayRegion(topHeight: number, bottomHeight: number): Promise<void> {
  if (!isTauriRuntime()) return;
  await desktopInvoke<void>("player_set_overlay_region", { topHeight, bottomHeight });
}

export async function playerGetPlaybackInfo(mediaKey: string): Promise<PlaybackInfo | null> {
  debugLog(`📊 playerGetPlaybackInfo: START - mediaKey=${mediaKey}`).catch(() => {});
  if (!isTauriRuntime()) {
    debugLog(`❌ playerGetPlaybackInfo: not Tauri runtime`).catch(() => {});
    return null;
  }
  try {
    const info = await desktopInvoke<PlaybackInfoShape | null>("player_get_playback_info", { mediaKey });
    debugLog(`✅ playerGetPlaybackInfo: desktopInvoke completed - info=${JSON.stringify(info)}`).catch(() => {});
    const value = (info ?? {}) as PlaybackInfoShape;
    const timePosSeconds =
      typeof value.timePosSeconds === "number" && Number.isFinite(value.timePosSeconds)
        ? value.timePosSeconds
        : null;
    const durationSeconds =
      typeof value.durationSeconds === "number" && Number.isFinite(value.durationSeconds)
        ? value.durationSeconds
        : null;
    const paused = typeof value.paused === "boolean" ? value.paused : null;
    const result = { timePosSeconds, durationSeconds, paused };
    debugLog(`📈 playerGetPlaybackInfo: processed result - ${JSON.stringify(result)}`).catch(() => {});
    return result;
  } catch (err) {
    debugLog(`❌ playerGetPlaybackInfo: desktopInvoke failed - ${err}`).catch(() => {});
    throw err;
  }
}

export async function playerSetPause(mediaKey: string, pause: boolean): Promise<void> {
  debugLog(`📤 playerSetPause: START - mediaKey=${mediaKey}, pause=${pause}`).catch(() => {});
  try {
    await desktopInvoke<void>("player_set_pause", { mediaKey, pause });
    debugLog(`✅ playerSetPause: desktopInvoke completed`).catch(() => {});
  } catch (err) {
    debugLog(`❌ playerSetPause: desktopInvoke failed - ${err}`).catch(() => {});
    throw err;
  }
  debugLog(`🏁 playerSetPause: END`).catch(() => {});
}

export async function playerTogglePause(mediaKey: string): Promise<void> {
  await desktopInvoke<void>("player_toggle_pause", { mediaKey });
}

export async function playerSeekRelative(mediaKey: string, deltaSeconds: number): Promise<void> {
  await desktopInvoke<void>("player_seek_relative", { mediaKey, deltaSeconds });
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRenderSettings(settings: unknown): PlayerRenderSettings {
  const value = (settings ?? {}) as Record<string, unknown>;
  return {
    volume: normalizeFiniteNumber(value.volume),
    brightness: normalizeFiniteNumber(value.brightness),
    subtitleFontSize: normalizeFiniteNumber(value.subtitleFontSize),
    subtitleBorderSize: normalizeFiniteNumber(value.subtitleBorderSize),
    subtitleShadowOffset: normalizeFiniteNumber(value.subtitleShadowOffset),
    subtitlePosition: normalizeFiniteNumber(value.subtitlePosition),
  };
}

export async function playerGetRenderSettings(mediaKey: string): Promise<PlayerRenderSettings> {
  if (!isTauriRuntime()) {
    return {
      volume: 100,
      brightness: 0,
      subtitleFontSize: 48,
      subtitleBorderSize: 2,
      subtitleShadowOffset: 1,
      subtitlePosition: 100,
    };
  }
  const settings = await desktopInvoke<PlayerRenderSettings>("player_get_render_settings", { mediaKey });
  return normalizeRenderSettings(settings);
}

export async function playerSetVolume(mediaKey: string, volume: number): Promise<number> {
  const next = await desktopInvoke<number>("player_set_volume", { mediaKey, volume });
  return normalizeFiniteNumber(next) ?? 100;
}

export async function playerAdjustVolume(mediaKey: string, delta: number): Promise<number> {
  const next = await desktopInvoke<number>("player_adjust_volume", { mediaKey, delta });
  return normalizeFiniteNumber(next) ?? 100;
}

export async function playerSetBrightness(mediaKey: string, brightness: number): Promise<number> {
  const next = await desktopInvoke<number>("player_set_brightness", { mediaKey, brightness });
  return normalizeFiniteNumber(next) ?? 0;
}

export async function playerAdjustBrightness(mediaKey: string, delta: number): Promise<number> {
  const next = await desktopInvoke<number>("player_adjust_brightness", { mediaKey, delta });
  return normalizeFiniteNumber(next) ?? 0;
}

export async function playerSetSubtitleStyle(
  mediaKey: string,
  style: PlayerSubtitleStyleInput,
): Promise<PlayerRenderSettings> {
  const settings = await desktopInvoke<PlayerRenderSettings>("player_set_subtitle_style", {
    mediaKey,
    fontSize: style.fontSize ?? null,
    borderSize: style.borderSize ?? null,
    shadowOffset: style.shadowOffset ?? null,
    position: style.position ?? null,
  });
  return normalizeRenderSettings(settings);
}

export async function playerGetResumePosition(mediaKey: string): Promise<number | null> {
  const pos = await desktopInvoke<number | null>("player_get_resume_position", { mediaKey });
  return typeof pos === "number" && Number.isFinite(pos) ? pos : null;
}

export async function playerSetResumePosition(
  mediaKey: string,
  positionSeconds: number,
  durationSeconds?: number | null,
): Promise<void> {
  await desktopInvoke<void>("player_set_resume_position", {
    mediaKey,
    positionSeconds,
    durationSeconds: durationSeconds ?? null,
  });
}

export async function playerClearResumePosition(mediaKey: string): Promise<void> {
  await desktopInvoke<void>("player_clear_resume_position", { mediaKey });
}

export async function playerListTracks(mediaKey: string): Promise<PlayerTracks> {
  if (!isTauriRuntime()) return { audio: [], subtitles: [] };
  const tracks = await desktopInvoke<PlayerTracks>("player_list_tracks", { mediaKey });
  return {
    audio: Array.isArray(tracks?.audio) ? tracks.audio : [],
    subtitles: Array.isArray(tracks?.subtitles) ? tracks.subtitles : [],
  };
}

export async function playerSetAudioTrack(mediaKey: string, trackId: number): Promise<void> {
  await desktopInvoke<void>("player_set_audio_track", { mediaKey, trackId });
}

export async function playerSetSubtitleTrack(mediaKey: string, trackId: number): Promise<void> {
  await desktopInvoke<void>("player_set_subtitle_track", { mediaKey, trackId });
}

export async function playerListExternalSubtitles(mediaKey: string): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  const paths = await desktopInvoke<string[]>("player_list_external_subtitles", { mediaKey });
  return Array.isArray(paths) ? paths.map(String) : [];
}

export async function playerAddExternalSubtitle(mediaKey: string, path: string): Promise<void> {
  await desktopInvoke<void>("player_add_external_subtitle", { mediaKey, path });
}

export async function playerRemoveExternalSubtitle(mediaKey: string, path: string): Promise<void> {
  await desktopInvoke<void>("player_remove_external_subtitle", { mediaKey, path });
}

export type PlayerOpenPayload = {
  mediaPath: string;
  startPositionSeconds: number | null;
  displayTitle?: string | null;
};

export const PLAYER_WINDOW_LABEL = "player";
export const PLAYER_LOAD_EVENT = "cinevault:player-load";
export const PLAYER_ACTIVITY_EVENT = "cinevault:player-activity";
export const PLAYER_KEY_EVENT = "cinevault:player-key";
export const PLAYER_VIDEO_CLICK_EVENT = "cinevault:player-video-click";
export const PLAYER_PLAYBACK_EVENT = "cinevault:player-playback";

export type PlayerPlaybackEvent = PlaybackInfo & {
  mediaKey: string;
  seq: number;
  atMs: number;
  connected: boolean;
};

export async function openPlayerWindow(
  mediaPath: string,
  startPositionSeconds?: number | null,
  displayTitle?: string | null,
): Promise<void> {
  if (!isTauriRuntime()) throw new Error("Not running in desktop runtime");
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const payload: PlayerOpenPayload = {
    mediaPath,
    startPositionSeconds: startPositionSeconds ?? null,
    displayTitle: displayTitle ?? null,
  };

  const existing = await WebviewWindow.getByLabel(PLAYER_WINDOW_LABEL);
  if (existing) {
    await existing.setFullscreen(false).catch(() => {});
    await existing.unmaximize().catch(() => {});
    await existing.show().catch(() => {});
    await existing.setFocus().catch(() => {});
    await existing.emit(PLAYER_LOAD_EVENT, payload).catch(() => {});
    return;
  }

  const startParam =
    typeof startPositionSeconds === "number" && Number.isFinite(startPositionSeconds)
      ? `&start=${encodeURIComponent(String(startPositionSeconds))}`
      : "";

  const titleParam = displayTitle?.trim() ? `&title=${encodeURIComponent(displayTitle.trim())}` : "";

  const win = new WebviewWindow(PLAYER_WINDOW_LABEL, {
    url: `/#/player?mediaPath=${encodeURIComponent(mediaPath)}${startParam}${titleParam}`,
    title: "CineVault Player",
    width: 1280,
    height: 720,
    resizable: true,
    focus: true,
    transparent: true,
    decorations: false,
    shadow: false,
    center: true,
    maximized: false,
    fullscreen: false,
    visible: false,
    backgroundColor: { red: 0, green: 0, blue: 0, alpha: 1 },
  });

  await new Promise<void>((resolve, reject) => {
    void win.once("tauri://created", async () => {
      // Webview background is set by PlayerPage using the webview API (webview-only),
      // because Window background color alpha is ignored on Windows.
      await win.show().catch(() => {});
      await win.setFocus().catch(() => {});
      resolve();
    });

    void win.once<string | { message?: string }>("tauri://error", async (event) => {
      const payload = event.payload;
      const message =
        typeof payload === "string"
          ? payload
          : typeof payload?.message === "string"
            ? payload.message
            : "Failed to create player window";
      reject(new Error(message));
    });
  });
}
