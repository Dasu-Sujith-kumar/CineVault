import { isTauriRuntime } from "@/lib/desktop-player";
import {
  isRemoteHttpImageUrl,
  normalizeStoredImageReference,
} from "@/lib/image-src";

async function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new Error("Not running in desktop runtime");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, args);
}

let metadataCacheDirectory: string | null | undefined;

export type MetadataMediaType = "movie" | "tv";
export type MetadataSearchFilter =
  | "movie"
  | "movies"
  | "movieShorts"
  | "shorts"
  | "tv"
  | "shows"
  | "anime"
  | "cartoon"
  | "hentai";
export type MetadataSource = "tmdb" | "omdb" | "tvdb" | "trakt" | "jikan" | "hhaven";

export type MetadataCastMember = {
  id: string;
  name: string;
  character?: string | null;
  profileUrl?: string | null;
};

export type MetadataEpisode = {
  season: number;
  episode: number;
  title: string;
  path?: string | null;
  overview?: string | null;
  runtimeMinutes?: number | null;
  airDate?: string | null;
  stillUrl?: string | null;
};

export type MetadataSearchResult = {
  provider: MetadataSource;
  source: MetadataSource;
  sourceId: string;
  tmdbId?: number | null;
  title: string;
  overview: string;
  posterUrl: string;
  backdropUrl: string;
  durationMinutes?: number | null;
  rating: number;
  year: string;
  genre: string[];
  mediaType: MetadataMediaType;
};

export type MetadataDetails = {
  source: MetadataSource;
  sourceId: string;
  tmdbId?: number | null;
  imdbId?: string | null;
  tvdbId?: number | null;
  traktId?: number | null;
  malId?: number | null;
  title: string;
  originalTitle?: string | null;
  overview: string;
  tagline?: string | null;
  posterUrl: string;
  backdropUrl: string;
  durationMinutes?: number | null;
  rating: number;
  year: string;
  genre: string[];
  mediaType: MetadataMediaType;
  cast: MetadataCastMember[];
  status?: string | null;
  tv?: {
    seasons: number;
    episodes: number;
    episodeList: MetadataEpisode[];
  } | null;
};

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeCast(value: unknown): MetadataCastMember[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): MetadataCastMember | null => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const id = normalizeString(record.id);
      const name = normalizeString(record.name);
      if (!id || !name) return null;
      return {
        id,
        name,
        character: normalizeString(record.character) || null,
        profileUrl: normalizeStoredImageReference(normalizeString(record.profileUrl)) || null,
      } satisfies MetadataCastMember;
    })
    .filter((entry): entry is MetadataCastMember => entry !== null);
}

function normalizeEpisodes(value: unknown): MetadataEpisode[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): MetadataEpisode | null => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const season = normalizeFiniteNumber(record.season);
      const episode = normalizeFiniteNumber(record.episode);
      const title = normalizeString(record.title);
      if (!season || !episode || !title) return null;
      return {
        season,
        episode,
        title,
        path: normalizeString(record.path) || null,
        overview: normalizeString(record.overview) || null,
        runtimeMinutes: normalizeFiniteNumber(record.runtimeMinutes),
        airDate: normalizeString(record.airDate) || null,
        stillUrl: normalizeStoredImageReference(normalizeString(record.stillUrl)) || null,
      } satisfies MetadataEpisode;
    })
    .filter((entry): entry is MetadataEpisode => entry !== null);
}

function normalizeSearchResults(value: unknown): MetadataSearchResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): MetadataSearchResult | null => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const provider =
        record.provider === "omdb"
          ? "omdb"
          : record.provider === "tvdb"
            ? "tvdb"
            : record.provider === "trakt"
              ? "trakt"
              : record.provider === "jikan"
                ? "jikan"
                : record.provider === "hhaven"
                  ? "hhaven"
                  : record.provider === "tmdb"
                    ? "tmdb"
                    : null;
      const source =
        record.source === "omdb"
          ? "omdb"
          : record.source === "tvdb"
            ? "tvdb"
            : record.source === "trakt"
              ? "trakt"
              : record.source === "jikan"
                ? "jikan"
                : record.source === "hhaven"
                  ? "hhaven"
                  : record.source === "tmdb"
                    ? "tmdb"
                    : null;
      const sourceId = normalizeString(record.sourceId);
      const tmdbId = normalizeFiniteNumber(record.tmdbId);
      const title = normalizeString(record.title);
      const mediaType = record.mediaType === "tv" ? "tv" : record.mediaType === "movie" ? "movie" : null;
      if (!provider || !source || !sourceId || !title || !mediaType) return null;
      return {
        provider,
        source,
        sourceId,
        tmdbId,
        title,
        overview: normalizeString(record.overview),
        posterUrl: normalizeStoredImageReference(normalizeString(record.posterUrl)),
        backdropUrl: normalizeStoredImageReference(normalizeString(record.backdropUrl)),
        durationMinutes: normalizeFiniteNumber(record.durationMinutes),
        rating: normalizeFiniteNumber(record.rating) ?? 0,
        year: normalizeString(record.year),
        genre: Array.isArray(record.genre) ? record.genre.map(normalizeString).filter(Boolean) : [],
        mediaType,
      } satisfies MetadataSearchResult;
    })
    .filter((entry): entry is MetadataSearchResult => entry !== null);
}

function normalizeDetails(value: unknown): MetadataDetails {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    source:
      record.source === "omdb"
        ? "omdb"
        : record.source === "tvdb"
          ? "tvdb"
          : record.source === "trakt"
            ? "trakt"
            : record.source === "jikan"
              ? "jikan"
              : record.source === "hhaven"
                ? "hhaven"
                : "tmdb",
    sourceId: normalizeString(record.sourceId),
    tmdbId: normalizeFiniteNumber(record.tmdbId),
    imdbId: normalizeString(record.imdbId) || null,
    tvdbId: normalizeFiniteNumber(record.tvdbId),
    traktId: normalizeFiniteNumber(record.traktId),
    malId: normalizeFiniteNumber(record.malId),
    title: normalizeString(record.title),
    originalTitle: normalizeString(record.originalTitle) || null,
    overview: normalizeString(record.overview),
    tagline: normalizeString(record.tagline) || null,
    posterUrl: normalizeStoredImageReference(normalizeString(record.posterUrl)),
    backdropUrl: normalizeStoredImageReference(normalizeString(record.backdropUrl)),
    durationMinutes: normalizeFiniteNumber(record.durationMinutes),
    rating: normalizeFiniteNumber(record.rating) ?? 0,
    year: normalizeString(record.year),
    genre: Array.isArray(record.genre) ? record.genre.map(normalizeString).filter(Boolean) : [],
    mediaType: record.mediaType === "tv" ? "tv" : "movie",
    cast: normalizeCast(record.cast),
    status: normalizeString(record.status) || null,
    tv: record.tv && typeof record.tv === "object"
      ? {
          seasons: normalizeFiniteNumber((record.tv as Record<string, unknown>).seasons) ?? 0,
          episodes: normalizeFiniteNumber((record.tv as Record<string, unknown>).episodes) ?? 0,
          episodeList: normalizeEpisodes((record.tv as Record<string, unknown>).episodeList),
        }
      : null,
  };
}

export async function metadataSearch(
  query: string,
  mediaType: MetadataSearchFilter = "movie",
): Promise<MetadataSearchResult[]> {
  const results = await desktopInvoke<unknown>("metadata_search", { query, mediaType });
  return normalizeSearchResults(results);
}

export async function metadataGetDetails(
  sourceId: string,
  mediaType: MetadataMediaType,
  source: MetadataSource,
): Promise<MetadataDetails> {
  const details = await desktopInvoke<unknown>("metadata_get_details", { sourceId, source, mediaType });
  return normalizeDetails(details);
}

export async function getMetadataCacheDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  if (metadataCacheDirectory !== undefined) return metadataCacheDirectory;
  metadataCacheDirectory = await desktopInvoke<string | null>("metadata_get_cache_directory");
  return metadataCacheDirectory;
}

export async function setMetadataCacheDirectory(path: string | null): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  metadataCacheDirectory = await desktopInvoke<string | null>("metadata_set_cache_directory", { path });
  return metadataCacheDirectory;
}

export async function cacheMetadataImage(
  url: string | null | undefined,
  cacheKey?: string | null,
): Promise<string> {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) return "";
  const normalized = normalizeStoredImageReference(trimmed);
  if (!isTauriRuntime() || !isRemoteHttpImageUrl(normalized)) return normalized;
  const cacheDir = await getMetadataCacheDirectory();
  if (!cacheDir) return normalized;

  try {
    const localPath = await desktopInvoke<string>("metadata_cache_image", {
      url: normalized,
      cacheKey: cacheKey ?? null,
    });
    if (!localPath) return normalized;
    return normalizeStoredImageReference(localPath);
  } catch {
    return normalized;
  }
}
