import { useCallback, useEffect, useState } from "react";
import { isTauriRuntime } from "@/lib/desktop-player";
import { normalizeStoredImageReference } from "@/lib/image-src";

export type ContentRating = "regular" | "adult";
export type MediaType = "movie" | "tv";
export type LibraryKind = "movies" | "shows" | "anime" | "cartoon" | "hentai" | "movieShorts" | "others";

export interface CastMember {
  id: string;
  name: string;
  character?: string;
  profileUrl?: string;
}

export interface TvEpisode {
  season: number;
  episode: number;
  title: string;
  path?: string;
  overview?: string;
  runtimeMinutes?: number;
  airDate?: string;
  stillUrl?: string;
}

export interface TvShowInfo {
  rootPath?: string;
  seasons?: number;
  episodes?: number;
  episodeList?: TvEpisode[];
  selectedEpisodePath?: string;
}

export interface MediaItem {
  id: string;
  title: string;
  originalTitle?: string;
  overview: string;
  tagline?: string;
  posterUrl: string;
  backdropUrl: string;
  durationMinutes?: number;
  videoPath?: string;
  tv?: TvShowInfo;
  tmdbId?: number;
  rating: number;
  year: string;
  genre: string[];
  cast?: CastMember[];
  status?: string;
  language?: string;
  contentRating: ContentRating;
  mediaType: MediaType;
  libraryKind: LibraryKind;
  addedAt: number;
  isFavorite: boolean;
  isBookmarked: boolean;
  playlists: string[];
  categoryIds: string[];
  lastWatched?: number;
}

export interface Playlist {
  id: string;
  name: string;
  itemIds: string[];
}

export interface Category {
  id: string;
  name: string;
  color: string;
}

export interface AppState {
  items: MediaItem[];
  playlists: Playlist[];
  categories: Category[];
  history: string[];
  viewMode: ContentRating | "all";
}

export interface LibraryDbItem {
  id: string;
  title: string;
  item_type?: string;
  itemType?: string;
  library_kind?: string;
  libraryKind?: string;
  year?: number | null;
  plot?: string | null;
  file_path?: string;
  filePath?: string;
  metadata_json?: string | null;
  metadataJson?: string | null;
  is_adult_override?: boolean | number | null;
  isAdultOverride?: boolean | number | null;
}

const LOCAL_STATE_KEY = "movie-app-state";

const DEFAULT_STATE: AppState = {
  items: [],
  playlists: [
    { id: "watchlist", name: "Watch List", itemIds: [] },
    { id: "top-picks", name: "Top Picks", itemIds: [] },
  ],
  categories: [
    { id: "action", name: "Action", color: "#e67e22" },
    { id: "drama", name: "Drama", color: "#3498db" },
    { id: "comedy", name: "Comedy", color: "#2ecc71" },
    { id: "horror", name: "Horror", color: "#e74c3c" },
    { id: "scifi", name: "Sci-Fi", color: "#9b59b6" },
  ],
  history: [],
  viewMode: "all",
};

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const next = entry.trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }

  return out;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const next = value.trim();
  return next ? next : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  const next = finiteNumber(value);
  return next !== undefined && next >= 0 ? Math.round(next) : undefined;
}

function normalizeCastMember(value: unknown): CastMember | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<CastMember> & Record<string, unknown>;
  const id = optionalString(entry.id);
  const name = optionalString(entry.name);
  if (!id || !name) return null;

  return {
    id,
    name,
    character: optionalString(entry.character),
    profileUrl: normalizeStoredImageReference(entry.profileUrl),
  };
}

function findFirstMappedEpisodePath(episodeList?: TvEpisode[]): string | undefined {
  return episodeList?.find((episode) => Boolean(episode.path?.trim()))?.path?.trim() || undefined;
}

function normalizeEpisode(value: unknown): TvEpisode | null {
  const entry = (value ?? {}) as Partial<TvEpisode> & Record<string, unknown>;
  const season = nonNegativeInt(entry.season) ?? 1;
  const episode = nonNegativeInt(entry.episode) ?? 1;
  // Keep episodes even if a metadata provider (or older state) omitted the title.
  const title = optionalString(entry.title) ?? `Episode ${episode}`;

  return {
    season,
    episode,
    title,
    path: optionalString(entry.path),
    overview: optionalString(entry.overview),
    runtimeMinutes: nonNegativeInt(entry.runtimeMinutes),
    airDate: optionalString(entry.airDate),
    stillUrl: normalizeStoredImageReference(entry.stillUrl),
  };
}

function normalizeTvInfo(value: unknown): TvShowInfo | undefined {
  if (!value || typeof value !== "object") return undefined;

  const entry = value as Partial<TvShowInfo> & Record<string, unknown>;
  const episodeListRaw = (entry.episodeList ?? (entry as Record<string, unknown>).episode_list) as unknown;
  const episodeList = Array.isArray(episodeListRaw)
    ? episodeListRaw.map(normalizeEpisode).filter((episode): episode is TvEpisode => episode !== null)
    : undefined;

  const selectedEpisodePath = optionalString(entry.selectedEpisodePath);
  const fallbackPath = findFirstMappedEpisodePath(episodeList);

  return {
    rootPath: optionalString(entry.rootPath ?? (entry as Record<string, unknown>).root_path),
    seasons: nonNegativeInt(entry.seasons),
    episodes: nonNegativeInt(entry.episodes),
    episodeList,
    selectedEpisodePath: selectedEpisodePath ?? fallbackPath,
  };
}

function normalizeLibraryKind(value: unknown): LibraryKind | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, "");

  if (key === "movie" || key === "movies") return "movies";
  if (key === "show" || key === "shows" || key === "tv" || key === "tvshows" || key === "series") return "shows";
  if (key === "anime") return "anime";
  if (key === "cartoon" || key === "cartoons") return "cartoon";
  if (key === "hentai") return "hentai";
  if (key === "movieshorts" || key === "shorts" || key === "shortfilms") return "movieShorts";
  if (key === "other" || key === "others" || key === "general") return "others";

  return undefined;
}

export function libraryKindFromPath(path: string | undefined, mediaType: MediaType = "movie"): LibraryKind {
  const pathSegments = (path ?? "").toLowerCase().split(/[\\/]+/).map((segment) => segment.replace(/[\s_-]+/g, ""));

  if (pathSegments.includes("hentai")) return "hentai";
  if (pathSegments.includes("cartoon") || pathSegments.includes("cartoons")) return "cartoon";
  if (pathSegments.includes("movieshorts") || pathSegments.includes("shorts") || pathSegments.includes("shortfilms")) return "movieShorts";
  if (pathSegments.includes("anime")) return "anime";
  if (pathSegments.includes("shows") || pathSegments.includes("tvshows") || pathSegments.includes("series")) return "shows";
  if (pathSegments.includes("movies") || pathSegments.includes("movie")) return "movies";

  return mediaType === "tv" ? "shows" : "movies";
}

function inferLibraryKind(entry: Partial<MediaItem> & Record<string, unknown>, mediaType: MediaType): LibraryKind {
  const explicit = normalizeLibraryKind(entry.libraryKind ?? (entry as Record<string, unknown>).library_kind);
  if (explicit) return explicit;

  const pathText = [
    optionalString(entry.videoPath ?? (entry as Record<string, unknown>).file_path),
    optionalString(entry.tv?.rootPath ?? (entry as Record<string, unknown>).root_path),
  ].filter(Boolean).join("\\").toLowerCase();
  const pathSegments = pathText.split(/[\\/]+/).map((segment) => segment.replace(/[\s_-]+/g, ""));

  if (pathSegments.includes("hentai")) return "hentai";
  if (pathSegments.includes("cartoon") || pathSegments.includes("cartoons")) return "cartoon";
  if (pathSegments.includes("movieshorts") || pathSegments.includes("shorts") || pathSegments.includes("shortfilms")) return "movieShorts";
  if (pathSegments.includes("anime")) return "anime";
  if (pathSegments.includes("shows") || pathSegments.includes("tvshows") || pathSegments.includes("series")) return "shows";
  if (pathSegments.includes("movies") || pathSegments.includes("movie")) return "movies";

  const genreText = uniqueStrings(entry.genre).join(" ").toLowerCase();
  if (genreText.includes("hentai")) return "hentai";
  if (genreText.includes("cartoon")) return "cartoon";
  if (genreText.includes("anime")) return "anime";
  if (genreText.includes("short")) return "movieShorts";

  return mediaType === "tv" ? "shows" : "movies";
}

function normalizeMediaItem(value: unknown): MediaItem {
  const entry = (value ?? {}) as Partial<MediaItem> & Record<string, unknown>;
  const tv = normalizeTvInfo(entry.tv);
  const mediaType = entry.mediaType === "tv" ? "tv" : "movie";
  const libraryKind = inferLibraryKind({ ...entry, tv }, mediaType);

  return {
    id: optionalString(entry.id) ?? crypto.randomUUID(),
    title: optionalString(entry.title) ?? "Untitled",
    originalTitle: optionalString(entry.originalTitle),
    overview: typeof entry.overview === "string" ? entry.overview : "",
    tagline: optionalString(entry.tagline),
    posterUrl: normalizeStoredImageReference(entry.posterUrl),
    backdropUrl: normalizeStoredImageReference(entry.backdropUrl),
    durationMinutes: nonNegativeInt(entry.durationMinutes),
    videoPath: optionalString(entry.videoPath),
    tv,
    tmdbId: nonNegativeInt(entry.tmdbId),
    rating: finiteNumber(entry.rating) ?? 0,
    year: typeof entry.year === "string" ? entry.year : "",
    genre: uniqueStrings(entry.genre),
    cast: Array.isArray(entry.cast)
      ? entry.cast.map(normalizeCastMember).filter((member): member is CastMember => member !== null)
      : [],
    status: optionalString(entry.status),
    language: optionalString(entry.language ?? entry.folderLanguage ?? entry.folder_language),
    contentRating: entry.contentRating === "adult" || libraryKind === "hentai" ? "adult" : "regular",
    mediaType,
    libraryKind,
    addedAt: finiteNumber(entry.addedAt) ?? Date.now(),
    isFavorite: Boolean(entry.isFavorite),
    isBookmarked: Boolean(entry.isBookmarked),
    playlists: uniqueStrings(entry.playlists),
    categoryIds: uniqueStrings(entry.categoryIds),
    lastWatched: finiteNumber(entry.lastWatched),
  };
}

function normalizePlaylist(value: unknown): Playlist | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<Playlist> & Record<string, unknown>;
  const id = optionalString(entry.id);
  const name = optionalString(entry.name);
  if (!id || !name) return null;

  return {
    id,
    name,
    itemIds: uniqueStrings(entry.itemIds),
  };
}

function normalizeCategory(value: unknown): Category | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<Category> & Record<string, unknown>;
  const id = optionalString(entry.id);
  const name = optionalString(entry.name);
  if (!id || !name) return null;

  return {
    id,
    name,
    color: optionalString(entry.color) ?? "#22c55e",
  };
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function normalizeAppState(raw: unknown): AppState {
  const entry = (raw ?? {}) as Partial<AppState> & Record<string, unknown>;
  const baseItems = Array.isArray(entry.items) ? entry.items.map(normalizeMediaItem) : [];
  const basePlaylists = Array.isArray(entry.playlists)
    ? entry.playlists.map(normalizePlaylist).filter((playlist): playlist is Playlist => playlist !== null)
    : DEFAULT_STATE.playlists;
  const baseCategories = Array.isArray(entry.categories)
    ? entry.categories.map(normalizeCategory).filter((category): category is Category => category !== null)
    : DEFAULT_STATE.categories;

  const items = dedupeById(baseItems);
  const playlists = dedupeById(basePlaylists);
  const categories = dedupeById(baseCategories);

  const validItemIds = new Set(items.map((item) => item.id));
  const validPlaylistIds = new Set(playlists.map((playlist) => playlist.id));
  const validCategoryIds = new Set(categories.map((category) => category.id));

  const playlistMembership = new Map<string, Set<string>>();
  const itemPlaylistMembership = new Map<string, Set<string>>();

  for (const playlist of playlists) {
    const members = new Set(playlist.itemIds.filter((itemId) => validItemIds.has(itemId)));
    playlistMembership.set(playlist.id, members);
  }

  for (const item of items) {
    for (const playlistId of item.playlists) {
      if (!validPlaylistIds.has(playlistId)) continue;
      playlistMembership.get(playlistId)?.add(item.id);
    }
  }

  for (const [playlistId, itemIds] of playlistMembership) {
    for (const itemId of itemIds) {
      let memberships = itemPlaylistMembership.get(itemId);
      if (!memberships) {
        memberships = new Set<string>();
        itemPlaylistMembership.set(itemId, memberships);
      }
      memberships.add(playlistId);
    }
  }

  const normalizedItems = items.map((item) => ({
    ...item,
    playlists: Array.from(itemPlaylistMembership.get(item.id) ?? []),
    categoryIds: item.categoryIds.filter((categoryId) => validCategoryIds.has(categoryId)),
    tv: item.tv
      ? {
          ...item.tv,
          selectedEpisodePath:
            optionalString(item.tv.selectedEpisodePath) ??
            findFirstMappedEpisodePath(item.tv.episodeList),
        }
      : undefined,
  }));

  const normalizedPlaylists = playlists.map((playlist) => ({
    ...playlist,
    itemIds: Array.from(playlistMembership.get(playlist.id) ?? []),
  }));

  const validHistoryIds = new Set(normalizedItems.map((item) => item.id));
  const history = uniqueStrings(entry.history).filter((itemId) => validHistoryIds.has(itemId)).slice(0, 50);
  const viewMode = entry.viewMode === "adult" || entry.viewMode === "regular" ? entry.viewMode : "all";

  return {
    items: normalizedItems,
    playlists: normalizedPlaylists,
    categories,
    history,
    viewMode,
  };
}

function mergeMediaItem(item: MediaItem, updates: Partial<MediaItem>): MediaItem {
  const hasTvUpdate = Object.prototype.hasOwnProperty.call(updates, "tv");
  const nextTv = hasTvUpdate
    ? updates.tv === undefined
      ? undefined
      : {
          ...(item.tv ?? {}),
          ...updates.tv,
        }
    : item.tv;

  return normalizeMediaItem({
    ...item,
    ...updates,
    tv: nextTv,
  });
}

function loadLocalState(): AppState {
  try {
    const raw = localStorage.getItem(LOCAL_STATE_KEY);
    if (raw) {
      return normalizeAppState(JSON.parse(raw));
    }
  } catch {
    return normalizeAppState(DEFAULT_STATE);
  }

  return normalizeAppState(DEFAULT_STATE);
}

function saveLocalState(state: AppState) {
  localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
}

function mediaItemFromDbItem(item: LibraryDbItem, saved?: MediaItem): MediaItem {
  const filePath = optionalString(item.filePath ?? item.file_path) ?? "";
  const itemType = item.itemType ?? item.item_type;
  const libraryKind = normalizeLibraryKind(item.libraryKind ?? item.library_kind)
    ?? libraryKindFromPath(filePath, itemType === "tv" ? "tv" : "movie");
  const metadataJson = item.metadataJson ?? item.metadata_json;
  const parsedMetadata = typeof metadataJson === "string" && metadataJson.trim()
    ? (() => {
        try {
          return JSON.parse(metadataJson) as Record<string, unknown>;
        } catch {
          return {};
        }
      })()
    : {};
  const isAdultOverride = item.isAdultOverride ?? item.is_adult_override;
  const adultFromMetadata = parsedMetadata.adult === true || parsedMetadata.isAdult === true;
  const tvMetadata = parsedMetadata.tv && typeof parsedMetadata.tv === "object"
    ? parsedMetadata.tv as Record<string, unknown>
    : {};
  const episodeListRaw = tvMetadata.episodeList ?? tvMetadata.episode_list;

  return normalizeMediaItem({
    id: item.id,
    title: item.title,
    overview: optionalString(item.plot) ?? optionalString(parsedMetadata.plot) ?? optionalString(parsedMetadata.overview) ?? "",
    posterUrl: saved?.posterUrl || normalizeStoredImageReference(optionalString(parsedMetadata.posterUrl) ?? optionalString(parsedMetadata.poster_path)),
    backdropUrl: saved?.backdropUrl || normalizeStoredImageReference(optionalString(parsedMetadata.backdropUrl) ?? optionalString(parsedMetadata.backdrop_path)),
    rating: finiteNumber(parsedMetadata.rating) ?? saved?.rating ?? 0,
    year: item.year?.toString() || optionalString(parsedMetadata.year) || saved?.year || "",
    genre: uniqueStrings(parsedMetadata.genres ?? parsedMetadata.genre),
    mediaType: itemType === "tv" ? "tv" : "movie",
    libraryKind,
    language: optionalString(parsedMetadata.language ?? parsedMetadata.folderLanguage ?? parsedMetadata.folder_language) ?? saved?.language,
    contentRating: libraryKind === "hentai" || adultFromMetadata || isAdultOverride === true || isAdultOverride === 1 ? "adult" : "regular",
    videoPath: itemType === "tv" ? undefined : filePath,
    tv: itemType === "tv"
      ? {
          rootPath: filePath,
          seasons: nonNegativeInt(tvMetadata.seasons),
          episodes: nonNegativeInt(tvMetadata.episodes),
          episodeList: Array.isArray(episodeListRaw)
            ? episodeListRaw.map(normalizeEpisode).filter((episode): episode is TvEpisode => episode !== null)
            : [],
        }
      : undefined,
    addedAt: saved?.addedAt ?? Date.now(),
    isFavorite: saved?.isFavorite ?? false,
    isBookmarked: saved?.isBookmarked ?? false,
    playlists: saved?.playlists ?? [],
    categoryIds: saved?.categoryIds ?? [],
    lastWatched: saved?.lastWatched,
  });
}

async function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, args);
}

async function loadDesktopState(): Promise<AppState | null> {
  const raw = await desktopInvoke<string | null>("app_state_load");
  let baseState: AppState | null = null;
  
  if (raw) {
    try {
      baseState = normalizeAppState(JSON.parse(raw));
    } catch {
      baseState = null;
    }
  }
  
  // Also load items from database
  try {
    const libraryItems = await desktopInvoke<LibraryDbItem[]>("get_library_items");
    
    if (libraryItems && Array.isArray(libraryItems)) {
      const savedById = new Map((baseState?.items ?? []).map((item) => [item.id, item]));
      const mediaItems = libraryItems.map((item) => mediaItemFromDbItem(item, savedById.get(item.id)));
      
      if (baseState) {
        const validItemIds = new Set(mediaItems.map((item) => item.id));
        baseState.items = mediaItems;
        baseState.history = baseState.history.filter((itemId) => validItemIds.has(itemId));
        baseState.playlists = baseState.playlists.map((playlist) => ({
          ...playlist,
          itemIds: playlist.itemIds.filter((itemId) => validItemIds.has(itemId)),
        }));
      } else {
        baseState = normalizeAppState({
          ...DEFAULT_STATE,
          items: mediaItems,
        });
      }
    }
  } catch (error) {
    console.error("Failed to load library items:", error);
  }
  
  return baseState;
}

async function saveDesktopState(state: AppState): Promise<void> {
  const lightweightState: AppState = {
    ...state,
    items: state.items.map((item) => normalizeMediaItem({
      id: item.id,
      title: item.title,
      overview: "",
      posterUrl: "",
      backdropUrl: "",
      rating: 0,
      year: "",
      genre: [],
      contentRating: item.contentRating,
      mediaType: item.mediaType,
      libraryKind: item.libraryKind,
      language: item.language,
      addedAt: item.addedAt,
      isFavorite: item.isFavorite,
      isBookmarked: item.isBookmarked,
      playlists: item.playlists,
      categoryIds: item.categoryIds,
      lastWatched: item.lastWatched,
    })),
  };

  await desktopInvoke<void>("app_state_save", { stateJson: JSON.stringify(lightweightState) });
}

export function useAppState() {
  const [state, setState] = useState<AppState>(() => (isTauriRuntime() ? normalizeAppState(DEFAULT_STATE) : loadLocalState()));
  const [hydrated, setHydrated] = useState<boolean>(() => !isTauriRuntime());

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;

    void (async () => {
      try {
        const loaded = await loadDesktopState();
        if (!cancelled && loaded) setState(loaded);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })().catch(() => setHydrated(true));

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    if (!isTauriRuntime()) {
      saveLocalState(state);
      return;
    }

    const handle = window.setTimeout(() => {
      saveDesktopState(state).catch(() => {});
    }, 350);

    return () => window.clearTimeout(handle);
  }, [state, hydrated]);

  const addItem = useCallback((item: MediaItem) => {
    setState((current) => ({
      ...current,
      items: [...current.items, normalizeMediaItem(item)],
    }));
  }, []);

  const replaceLibraryItems = useCallback((items: LibraryDbItem[]) => {
    setState((current) => {
      const savedById = new Map(current.items.map((item) => [item.id, item]));
      const nextItems = items.map((item) => mediaItemFromDbItem(item, savedById.get(item.id)));
      const validItemIds = new Set(nextItems.map((item) => item.id));

      return {
        ...current,
        items: nextItems,
        history: current.history.filter((itemId) => validItemIds.has(itemId)),
        playlists: current.playlists.map((playlist) => ({
          ...playlist,
          itemIds: playlist.itemIds.filter((itemId) => validItemIds.has(itemId)),
        })),
      };
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      items: current.items.filter((item) => item.id !== id),
      history: current.history.filter((historyId) => historyId !== id),
      playlists: current.playlists.map((playlist) => ({
        ...playlist,
        itemIds: playlist.itemIds.filter((itemId) => itemId !== id),
      })),
    }));
  }, []);

  const updateItem = useCallback((id: string, updates: Partial<MediaItem>) => {
    setState((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === id ? mergeMediaItem(item, updates) : item)),
    }));
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.id === id ? { ...item, isFavorite: !item.isFavorite } : item,
      ),
    }));
  }, []);

  const toggleBookmark = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.id === id ? { ...item, isBookmarked: !item.isBookmarked } : item,
      ),
    }));
  }, []);

  const addToHistory = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      history: [id, ...current.history.filter((historyId) => historyId !== id)].slice(0, 50),
      items: current.items.map((item) =>
        item.id === id ? { ...item, lastWatched: Date.now() } : item,
      ),
    }));
  }, []);

  const setViewMode = useCallback((mode: ContentRating | "all") => {
    setState((current) => ({ ...current, viewMode: mode }));
  }, []);

  const addPlaylist = useCallback((name: string) => {
    setState((current) => ({
      ...current,
      playlists: [
        ...current.playlists,
        { id: crypto.randomUUID(), name, itemIds: [] },
      ],
    }));
  }, []);

  const removePlaylist = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      playlists: current.playlists.filter((playlist) => playlist.id !== id),
      items: current.items.map((item) => ({
        ...item,
        playlists: item.playlists.filter((playlistId) => playlistId !== id),
      })),
    }));
  }, []);

  const addToPlaylist = useCallback((playlistId: string, itemId: string) => {
    setState((current) => ({
      ...current,
      playlists: current.playlists.map((playlist) =>
        playlist.id === playlistId && !playlist.itemIds.includes(itemId)
          ? { ...playlist, itemIds: [...playlist.itemIds, itemId] }
          : playlist,
      ),
      items: current.items.map((item) =>
        item.id === itemId && !item.playlists.includes(playlistId)
          ? { ...item, playlists: [...item.playlists, playlistId] }
          : item,
      ),
    }));
  }, []);

  const removeFromPlaylist = useCallback((playlistId: string, itemId: string) => {
    setState((current) => ({
      ...current,
      playlists: current.playlists.map((playlist) =>
        playlist.id === playlistId
          ? { ...playlist, itemIds: playlist.itemIds.filter((id) => id !== itemId) }
          : playlist,
      ),
      items: current.items.map((item) =>
        item.id === itemId
          ? { ...item, playlists: item.playlists.filter((id) => id !== playlistId) }
          : item,
      ),
    }));
  }, []);

  const addCategory = useCallback((name: string, color: string) => {
    setState((current) => ({
      ...current,
      categories: [
        ...current.categories,
        { id: crypto.randomUUID(), name, color },
      ],
    }));
  }, []);

  const removeCategory = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      categories: current.categories.filter((category) => category.id !== id),
      items: current.items.map((item) => ({
        ...item,
        categoryIds: item.categoryIds.filter((categoryId) => categoryId !== id),
      })),
    }));
  }, []);

  const updateCategory = useCallback((id: string, updates: Partial<Category>) => {
    setState((current) => ({
      ...current,
      categories: current.categories.map((category) =>
        category.id === id ? { ...category, ...updates } : category,
      ),
    }));
  }, []);

  const setItemCategories = useCallback((itemId: string, categoryIds: string[]) => {
    setState((current) => {
      const validCategoryIds = new Set(current.categories.map((category) => category.id));
      const nextCategoryIds = categoryIds.filter((categoryId) => validCategoryIds.has(categoryId));

      return {
        ...current,
        items: current.items.map((item) =>
          item.id === itemId ? { ...item, categoryIds: nextCategoryIds } : item,
        ),
      };
    });
  }, []);

  const getFilteredItems = useCallback(
    (mediaType?: MediaType) => state.items.filter((item) => {
      if (mediaType && item.mediaType !== mediaType) return false;
      return true;
    }),
    [state.items],
  );

  const getItemsByLibraryKind = useCallback(
    (libraryKind: LibraryKind) => state.items.filter((item) => item.libraryKind === libraryKind),
    [state.items],
  );

  return {
    state,
    addItem,
    replaceLibraryItems,
    removeItem,
    updateItem,
    toggleFavorite,
    toggleBookmark,
    addToHistory,
    setViewMode,
    addPlaylist,
    removePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    addCategory,
    removeCategory,
    updateCategory,
    setItemCategories,
    getFilteredItems,
    getItemsByLibraryKind,
  };
}
