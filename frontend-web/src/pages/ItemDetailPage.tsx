import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Bookmark, Film, Heart, Play, Sparkles, Star, Trash2, Tv, Users,
} from "lucide-react";
import { useApp } from "@/components/AppContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { MediaGrid } from "@/components/MediaGrid";
import { AutoFetchDialog } from "@/components/AutoFetchDialog";
import {
  PlaybackInfo,
  PlayerTracks,
  debugLog,
  desktopPickFolder,
  desktopPickSubtitleFile,
  desktopPickVideoFile,
  isTauriRuntime,
  libraryScanTvShow,
  openPlayerWindow,
  playerAddExternalSubtitle,
  playerClearResumePosition,
  playerGetPlaybackInfo,
  playerGetResumePosition,
  playerListExternalSubtitles,
  playerListTracks,
  playerRemoveExternalSubtitle,
  playerSeekRelative,
  playerSetAudioTrack,
  playerSetSubtitleTrack,
  playerTogglePause,
} from "@/lib/desktop-player";
import type { ContentRating, MediaType, MediaItem, TvEpisode } from "@/lib/store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cacheMetadataImage } from "@/lib/media-metadata";
import { isRemoteHttpImageUrl, toImageSrc } from "@/lib/image-src";

function normalizeGenres(genres: string[]): Set<string> {
  return new Set(
    genres
      .map((g) => g.trim().toLowerCase())
      .filter(Boolean),
  );
}

function normalizeIds(values: string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let overlap = 0;
  for (const value of a) {
    if (b.has(value)) overlap += 1;
  }
  return overlap;
}

function pickRecommended(all: MediaItem[], base: MediaItem): MediaItem[] {
  const baseGenres = normalizeGenres(base.genre);
  const baseCategories = normalizeIds(base.categoryIds);
  const basePlaylists = normalizeIds(base.playlists);

  if (baseGenres.size === 0 && baseCategories.size === 0 && basePlaylists.size === 0) {
    return [];
  }

  const scored = all
    .filter((i) => i.id !== base.id && i.contentRating === base.contentRating)
    .map((candidate) => {
      const genreOverlap = countOverlap(normalizeGenres(candidate.genre), baseGenres);
      const categoryOverlap = countOverlap(normalizeIds(candidate.categoryIds), baseCategories);
      const playlistOverlap = countOverlap(normalizeIds(candidate.playlists), basePlaylists);
      const sharedSignals = genreOverlap + categoryOverlap + playlistOverlap;

      if (sharedSignals === 0) {
        return { candidate, score: 0 };
      }

      const score =
        categoryOverlap * 5 +
        genreOverlap * 4 +
        playlistOverlap * 3 +
        (candidate.mediaType === base.mediaType ? 1 : 0) +
        (candidate.year === base.year ? 0.25 : 0);

      return { candidate, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 18)
    .map((x) => x.candidate);

  return scored;
}

function formatTimeShort(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDurationMinutes(minutes?: number): string {
  if (!Number.isFinite(minutes) || !minutes || minutes <= 0) return "Runtime pending";
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return hours > 0 ? `${hours}h ${String(mins).padStart(2, "0")}m` : `${mins}m`;
}

function formatAirDateLabel(value?: string): string | null {
  if (!value?.trim()) return null;
  const normalized = value.trim();
  const isoPrefix = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoPrefix) {
    const [_, year, month, day] = isoPrefix;
    const parsed = new Date(`${year}-${month}-${day}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(parsed);
    }
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(parsed);
  }

  return normalized;
}

function firstMappedEpisodePath(episodeList?: TvEpisode[]): string {
  return episodeList?.find((episode) => Boolean(episode.path?.trim()))?.path?.trim() ?? "";
}

function summarizePathForLog(path: string): { len: number; tail: string } {
  const trimmed = path.trim();
  const tail = trimmed.length <= 24 ? trimmed : trimmed.slice(-24);
  return { len: trimmed.length, tail };
}

function mergeEpisodeList(existing: TvEpisode[] | undefined, scanned: TvEpisode[] | undefined): TvEpisode[] {
  const merged = new Map<string, TvEpisode>();

  for (const episode of existing ?? []) {
    const key = `${episode.season}:${episode.episode}`;
    merged.set(key, { ...episode });
  }

  for (const episode of scanned ?? []) {
    const key = `${episode.season}:${episode.episode}`;
    const current = merged.get(key);
    const scannedPath = episode.path?.trim();
    const currentPath = current?.path?.trim();
    merged.set(key, {
      // Prefer the freshly-scanned episode metadata (especially `path`) over any stale cached entry.
      ...current,
      ...episode,
      path: scannedPath ? scannedPath : currentPath || undefined,
      title: current?.title?.trim() || episode.title,
      overview: current?.overview ?? episode.overview,
      runtimeMinutes: current?.runtimeMinutes ?? episode.runtimeMinutes,
      airDate: current?.airDate ?? episode.airDate,
      stillUrl: current?.stillUrl ?? episode.stillUrl,
    });
  }

  return Array.from(merged.values()).sort((a, b) =>
    a.season - b.season
    || a.episode - b.episode
    || a.title.localeCompare(b.title),
  );
}

function groupEpisodesBySeason(episodeList?: TvEpisode[]): Array<{ season: number; episodes: TvEpisode[] }> {
  const groups = new Map<number, TvEpisode[]>();

  for (const episode of episodeList ?? []) {
    const current = groups.get(episode.season) ?? [];
    current.push(episode);
    groups.set(episode.season, current);
  }

  return Array.from(groups.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([season, episodes]) => ({
      season,
      episodes: episodes.sort((a, b) => a.episode - b.episode || a.title.localeCompare(b.title)),
    }));
}

function episodeKey(episode: Pick<TvEpisode, "season" | "episode">): string {
  return `${episode.season}:${episode.episode}`;
}

function findEpisodeByKey(episodes: TvEpisode[] | undefined, key: string | null): TvEpisode | null {
  if (!key) return null;
  return episodes?.find((episode) => episodeKey(episode) === key) ?? null;
}

export default function ItemDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const {
    state,
    updateItem,
    removeItem,
    toggleFavorite,
    toggleBookmark,
    addToHistory,
  } = useApp();

  const item = useMemo(() => state.items.find((i) => i.id === id) || null, [state.items, id]);
  const recommended = useMemo(() => (item ? pickRecommended(state.items, item) : []), [state.items, item]);

  const [form, setForm] = useState({
    title: "",
    overview: "",
    year: "",
    rating: 0,
    durationMinutes: "",
    genre: "",
    posterUrl: "",
    backdropUrl: "",
    contentRating: "regular" as ContentRating,
    mediaType: "movie" as MediaType,
    videoPath: "",
    tvRootPath: "",
    categoryIds: [] as string[],
  });

  const [activeMediaPath, setActiveMediaPath] = useState<string>("");
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [selectedEpisodeKey, setSelectedEpisodeKey] = useState<string | null>(null);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [resumePositionSeconds, setResumePositionSeconds] = useState<number | null>(null);
  const [resumeMediaPath, setResumeMediaPath] = useState<string | null>(null);
  const [autoFetchDialogOpen, setAutoFetchDialogOpen] = useState(false);

  const isDesktop = isTauriRuntime();
  const lastTvStateDebugRef = useRef<string>("");
  const [tracks, setTracks] = useState<PlayerTracks>({ audio: [], subtitles: [] });
  const [audioTrackId, setAudioTrackId] = useState<number>(1);
  const [subtitleTrackId, setSubtitleTrackId] = useState<number>(0);
  const [playbackInfo, setPlaybackInfo] = useState<PlaybackInfo | null>(null);
  const [externalSubtitles, setExternalSubtitles] = useState<string[]>([]);
  const [resumeSavedSeconds, setResumeSavedSeconds] = useState<number | null>(null);

  const refreshPlaybackInfo = useCallback(async (overrideMediaPath?: string) => {
    if (!item) return;
    if (!isDesktop) return;
    const mediaKey = (overrideMediaPath ?? activeMediaPath).trim();
    if (!mediaKey) {
      setTracks({ audio: [], subtitles: [] });
      setExternalSubtitles([]);
      setResumeSavedSeconds(null);
      setPlaybackInfo(null);
      return;
    }
    const [t, subs, pos, info] = await Promise.all([
      playerListTracks(mediaKey).catch(() => ({ audio: [], subtitles: [] })),
      playerListExternalSubtitles(mediaKey).catch(() => [] as string[]),
      playerGetResumePosition(mediaKey).catch(() => null),
      playerGetPlaybackInfo(mediaKey).catch(() => null),
    ]);
    setTracks(t);
    setExternalSubtitles(subs);
    setResumeSavedSeconds(pos);
    setPlaybackInfo(info);
  }, [activeMediaPath, isDesktop, item]);

  const setSelectedEpisodePath = useCallback((path: string) => {
    const nextPath = path.trim();
    const matchedEpisode = item?.tv?.episodeList?.find((episode) => episode.path?.trim() === nextPath);
    setSelectedEpisodeKey(matchedEpisode ? episodeKey(matchedEpisode) : null);
    setActiveMediaPath(nextPath);
    if (!item || item.mediaType !== "tv") return;
    updateItem(item.id, {
      tv: {
        selectedEpisodePath: nextPath || undefined,
      },
    });
  }, [item, updateItem]);

  const selectEpisode = useCallback((episode: TvEpisode) => {
    setSelectedEpisodeKey(episodeKey(episode));
    const nextPath = episode.path?.trim() ?? "";
    setActiveMediaPath(nextPath);
    if (!item || item.mediaType !== "tv" || !nextPath) return;

    updateItem(item.id, {
      tv: {
        selectedEpisodePath: nextPath,
      },
    });
  }, [item, updateItem]);

  useEffect(() => {
    if (!item) return;
    setForm({
      title: item.title,
      overview: item.overview,
      year: item.year,
      rating: item.rating,
      durationMinutes: item.durationMinutes != null ? String(item.durationMinutes) : "",
      genre: item.genre.join(", "),
      posterUrl: item.posterUrl,
      backdropUrl: item.backdropUrl,
      contentRating: item.contentRating,
      mediaType: item.mediaType,
      videoPath: item.videoPath ?? "",
      tvRootPath: item.tv?.rootPath ?? "",
      categoryIds: item.categoryIds,
    });
  }, [item]);

  useEffect(() => {
    if (!item) return;
    if (item.mediaType === "tv") {
      const episodes = item.tv?.episodeList ?? [];
      const currentEpisode = findEpisodeByKey(episodes, selectedEpisodeKey);
      const savedPath = (item.tv?.selectedEpisodePath ?? firstMappedEpisodePath(episodes) ?? "").trim();
      const savedEpisode = episodes.find((episode) => episode.path?.trim() === savedPath) ?? null;
      const nextEpisode = currentEpisode ?? savedEpisode ?? episodes[0] ?? null;

      if (nextEpisode) {
        const nextKey = episodeKey(nextEpisode);
        if (nextKey !== selectedEpisodeKey) setSelectedEpisodeKey(nextKey);
        setActiveMediaPath(nextEpisode.path?.trim() ?? "");
      } else {
        if (selectedEpisodeKey !== null) setSelectedEpisodeKey(null);
        setActiveMediaPath(savedPath);
      }
      return;
    }

    const next =
      item.videoPath ?? "";
    if (selectedEpisodeKey !== null) setSelectedEpisodeKey(null);
    setActiveMediaPath(String(next ?? "").trim());
  }, [item, selectedEpisodeKey]);

  useEffect(() => {
    setAudioTrackId(1);
    setSubtitleTrackId(0);
  }, [activeMediaPath]);

  useEffect(() => {
    if (!item) return;
    void refreshPlaybackInfo();
  }, [item, refreshPlaybackInfo]);

  useEffect(() => {
    if (!isDesktop) return;
    if (!item || item.mediaType !== "tv") return;
    const mapped = (item.tv?.episodeList ?? []).filter((episode) => Boolean(episode.path?.trim())).length;
    const total = item.tv?.episodeList?.length ?? 0;
    const sample = (item.tv?.episodeList ?? []).find((episode) => episode.path?.trim())?.path?.trim() ?? "";
    const sampleSummary = summarizePathForLog(sample);
    const fingerprint = `${item.id}:${total}:${mapped}:${sampleSummary.len}:${sampleSummary.tail}`;
    if (fingerprint === lastTvStateDebugRef.current) return;
    lastTvStateDebugRef.current = fingerprint;
    debugLog(
      `tv state now total=${total} mapped=${mapped} samplePathLen=${sampleSummary.len} samplePathTail=${sampleSummary.tail}`,
    ).catch(() => {});
  }, [isDesktop, item]);

  useEffect(() => {
    if (!item || item.mediaType !== "tv") {
      setSelectedSeason(null);
      return;
    }

    const groups = groupEpisodesBySeason(item.tv?.episodeList);
    if (groups.length === 0) {
      setSelectedSeason(null);
      return;
    }

    setSelectedSeason((current) => (
      current !== null && groups.some((group) => group.season === current)
        ? current
        : groups[0].season
    ));
  }, [item]);

  useEffect(() => {
    if (!item || !isDesktop) return;

    const hasRemotePoster = isRemoteHttpImageUrl(item.posterUrl);
    const hasRemoteBackdrop = isRemoteHttpImageUrl(item.backdropUrl);
    const hasRemoteCast = (item.cast ?? []).some((member) => isRemoteHttpImageUrl(member.profileUrl));
    if (!hasRemotePoster && !hasRemoteBackdrop && !hasRemoteCast) return;

    let cancelled = false;

    void (async () => {
      const [cachedPosterUrl, cachedBackdropUrl, cachedCast] = await Promise.all([
        cacheMetadataImage(item.posterUrl),
        cacheMetadataImage(item.backdropUrl),
        Promise.all(
          (item.cast ?? []).map(async (member) => ({
            ...member,
            profileUrl: member.profileUrl ? await cacheMetadataImage(member.profileUrl) : member.profileUrl,
          })),
        ),
      ]);

      if (cancelled) return;

      const posterChanged = Boolean(cachedPosterUrl && cachedPosterUrl !== item.posterUrl);
      const backdropChanged = Boolean(cachedBackdropUrl && cachedBackdropUrl !== item.backdropUrl);
      const castChanged = cachedCast.some((member, index) => member.profileUrl !== item.cast?.[index]?.profileUrl);
      if (!posterChanged && !backdropChanged && !castChanged) return;

      updateItem(item.id, {
        ...(posterChanged ? { posterUrl: cachedPosterUrl } : {}),
        ...(backdropChanged ? { backdropUrl: cachedBackdropUrl } : {}),
        ...(castChanged ? { cast: cachedCast } : {}),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [isDesktop, item, updateItem]);

  if (!item) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-10 max-w-5xl">
          <Button variant="ghost" onClick={() => navigate("/")} className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back
          </Button>
          <div className="glass-card rounded-lg p-6 mt-6">
            <h1 className="text-xl font-semibold text-foreground">Item not found</h1>
            <p className="text-sm text-muted-foreground mt-2">
              This item does not exist in your library (or was removed).
            </p>
          </div>
        </div>
      </div>
    );
  }

  const pickDefaultMediaPath = (): string | null => {
    if (item.mediaType === "movie") {
      const p = (form.videoPath || item.videoPath || "").trim();
      return p ? p : null;
    }

    if (selectedEpisodeKey) {
      const selectedEpisode = findEpisodeByKey(item.tv?.episodeList, selectedEpisodeKey);
      const selectedPath = selectedEpisode?.path?.trim() ?? "";
      return selectedPath || null;
    }

    const selected = activeMediaPath.trim();
    if (selected) return selected;
    const saved = (item.tv?.selectedEpisodePath ?? "").trim();
    if (saved) return saved;
    const first = firstMappedEpisodePath(item.tv?.episodeList).trim();
    return first ? first : null;
  };

  const onSaveMetadata = () => {
    const parsedDuration = Number.parseInt(form.durationMinutes, 10);
    const updates: Partial<MediaItem> = {
      title: form.title,
      overview: form.overview,
      year: form.year,
      rating: form.rating,
      durationMinutes: Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : undefined,
      genre: form.genre.split(",").map((g) => g.trim()).filter(Boolean),
      posterUrl: form.posterUrl,
      backdropUrl: form.backdropUrl,
      contentRating: form.contentRating,
      mediaType: form.mediaType,
      categoryIds: form.categoryIds,
    };

    if (form.mediaType === "movie") {
      updates.videoPath = form.videoPath.trim() || undefined;
      updates.tv = undefined;
      setActiveMediaPath((form.videoPath || "").trim());
    } else {
      updates.videoPath = undefined;
      updates.tv = {
        rootPath: form.tvRootPath.trim() || undefined,
        selectedEpisodePath:
          activeMediaPath.trim()
          || item.tv?.selectedEpisodePath
          || firstMappedEpisodePath(item.tv?.episodeList),
      };
    }

    updateItem(item.id, updates);
    toast.success("Metadata saved");
  };

  const handleAutoFetchMetadata = (metadata: Partial<MediaItem>) => {
    // Update form with fetched metadata
    setForm((prev) => ({
      ...prev,
      title: metadata.title || prev.title,
      overview: metadata.overview || prev.overview,
      year: metadata.year || prev.year,
      rating: metadata.rating ?? prev.rating,
      genre: metadata.genre ? metadata.genre.join(", ") : prev.genre,
      posterUrl: metadata.posterUrl || prev.posterUrl,
      backdropUrl: metadata.backdropUrl || prev.backdropUrl,
    }));
    toast.success("Metadata loaded. Click Save to apply changes.");
  };

  const playNow = async (mediaPath: string, startPositionSeconds?: number | null) => {
    if (item.mediaType === "tv") {
      setSelectedEpisodePath(mediaPath);
    }
    addToHistory(item.id);
    await openPlayerWindow(mediaPath, startPositionSeconds ?? null, item.title);
    toast("Opening player...");
  };

  const onPlayClicked = async (mediaPathOverride?: string) => {
    try {
      if (!isDesktop) {
        toast.error("Playback is available in the desktop app");
        return;
      }

      const mediaPath = (mediaPathOverride ?? pickDefaultMediaPath() ?? "").trim();
      if (!mediaPath) {
        toast.error(
          item.mediaType === "movie"
            ? "Set a video path first (Manage tab)"
            : activeEpisode
              ? "This episode has no mapped video file. Scan your TV show folder first."
              : "Scan your TV show folder first (Manage tab)",
        );
        return;
      }

      if (item.mediaType === "tv") {
        setSelectedEpisodePath(mediaPath);
      }

      const pos = await playerGetResumePosition(mediaPath).catch(() => null);
      if (pos !== null && pos > 5) {
        setResumeMediaPath(mediaPath);
        setResumePositionSeconds(pos);
        setResumeDialogOpen(true);
        return;
      }

      await playNow(mediaPath, null);
    } catch (err) {
      console.error(err);
      toast.error(errorMessage(err, "Failed to start player"));
    }
  };

  const onScanTvClicked = async () => {
    const root = form.tvRootPath.trim();
    if (!root) {
      toast.error("Set a TV show root folder path first");
      return;
    }
    if (!isDesktop) {
      toast.error("TV folder scanning is available in the desktop app");
      return;
    }

    try {
      toast("Scanning TV show folder...");
      const scan = await libraryScanTvShow(root);
      const scanSample = scan.episodeList?.[0]?.path ?? "";
      const scanSummary = summarizePathForLog(scanSample);
      await debugLog(
        `tv scan frontend received episodes=${scan.episodes} samplePathLen=${scanSummary.len} samplePathTail=${scanSummary.tail}`,
      ).catch(() => {});
      const mergedEpisodeList = mergeEpisodeList(item.tv?.episodeList, scan.episodeList);
      const mergedSample = mergedEpisodeList?.[0]?.path ?? "";
      const mergedSummary = summarizePathForLog(mergedSample);
      await debugLog(
        `tv scan merged total=${mergedEpisodeList.length} mapped=${mergedEpisodeList.filter((episode) => Boolean(episode.path?.trim())).length} sampleMergedPathLen=${mergedSummary.len} sampleMergedPathTail=${mergedSummary.tail}`,
      ).catch(() => {});
      const selectedEpisodePath = firstMappedEpisodePath(mergedEpisodeList);
      updateItem(item.id, {
        mediaType: "tv",
        videoPath: undefined,
        tv: {
          rootPath: scan.rootPath,
          seasons: Math.max(scan.seasons, item.tv?.seasons ?? 0),
          episodes: Math.max(scan.episodes, item.tv?.episodes ?? 0, mergedEpisodeList.length),
          episodeList: mergedEpisodeList,
          selectedEpisodePath,
        },
      });
      // Avoid calling `setSelectedEpisodePath()` here because it used to re-apply stale `item.tv` from an older
      // render and could overwrite the freshly-merged `episodeList`.
      const cleanedSelected = selectedEpisodePath.trim();
      setActiveMediaPath(cleanedSelected);
      const selectedEpisode = mergedEpisodeList.find((episode) => episode.path?.trim() === cleanedSelected);
      setSelectedEpisodeKey(selectedEpisode ? episodeKey(selectedEpisode) : null);
      const mapped = mergedEpisodeList.filter((episode) => Boolean(episode.path?.trim())).length;
      toast.success(mapped > 0 ? `Mapped ${mapped} / ${scan.episodes} episodes` : `Found ${scan.episodes} episodes (no files mapped)`);
    } catch (err) {
      console.error(err);
      toast.error(errorMessage(err, "Failed to scan TV show folder"));
    }
  };

  const onDeleteItem = () => {
    removeItem(item.id);
    setDeleteDialogOpen(false);
    toast.success("Item deleted");
    navigate("/");
  };

  const defaultMediaPath = pickDefaultMediaPath();
  const hasPlaybackFile = Boolean(defaultMediaPath?.trim());
  const playbackSummary =
    playbackInfo?.timePosSeconds != null && playbackInfo?.durationSeconds != null
      ? `${formatTimeShort(playbackInfo.timePosSeconds)} / ${formatTimeShort(playbackInfo.durationSeconds)}`
      : "Player idle";
  const resumeSummary =
    resumeSavedSeconds !== null ? `Saved at ${formatTimeShort(resumeSavedSeconds)}` : "No saved position yet";
  const playableEpisodes = (item.tv?.episodeList ?? []).filter((episode) => Boolean(episode.path?.trim()));
  const selectedEpisode = findEpisodeByKey(item.tv?.episodeList, selectedEpisodeKey);
  const fileStatusLabel = item.mediaType === "movie"
    ? hasPlaybackFile
      ? "Movie file mapped"
      : "No movie file set"
    : playableEpisodes.length > 0
      ? `${playableEpisodes.length} episode files mapped`
      : "No TV folder scanned";
  const assignedCategories = item.categoryIds
    .map((categoryId) => state.categories.find((entry) => entry.id === categoryId))
    .filter((category): category is (typeof state.categories)[number] => Boolean(category));
  const seasonGroups = groupEpisodesBySeason(item.tv?.episodeList);
  const selectedSeasonGroup = seasonGroups.find((group) => group.season === selectedSeason) ?? seasonGroups[0] ?? null;
  const activeEpisode =
    item.mediaType === "tv"
      ? selectedEpisode
        ?? item.tv?.episodeList?.find((episode) => episode.path?.trim() === activeMediaPath.trim())
        ?? item.tv?.episodeList?.find((episode) => episode.path?.trim() === item.tv?.selectedEpisodePath?.trim())
        ?? item.tv?.episodeList?.[0]
      : null;
  const selectedEpisodeSelectValue = activeEpisode ? episodeKey(activeEpisode) : "";
  const episodeSummary = activeEpisode
    ? `S${activeEpisode.season}E${String(activeEpisode.episode).padStart(2, "0")} - ${activeEpisode.title}`
    : item.mediaType === "tv"
      ? "Episode not selected"
      : "Single-file playback";
  const sessionStatus =
    playbackInfo?.paused === true ? "Paused" : playbackInfo?.paused === false ? "Playing" : "Idle";

  return (
    <>
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.08),transparent_24%),radial-gradient(circle_at_top_right,rgba(249,115,22,0.14),transparent_32%),hsl(var(--background))]">
      <div className="relative overflow-hidden border-b border-border/60">
        <div className="absolute inset-0">
          <img
            src={toImageSrc(item.backdropUrl)}
            alt={`${item.title} backdrop`}
            className="h-full w-full scale-[1.04] object-cover object-center"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,10,16,0.18),rgba(7,10,16,0.72),rgba(8,12,20,0.97))]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.22),transparent_34%),radial-gradient(circle_at_left,rgba(34,197,94,0.12),transparent_28%)]" />
        </div>

        <div className="container relative mx-auto max-w-6xl px-4 py-6 sm:py-8 lg:py-10">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate(-1)}
            className="border border-white/12 bg-black/35 text-white shadow-[0_14px_40px_rgba(0,0,0,0.24)] backdrop-blur-xl hover:bg-black/55"
          >
            <ArrowLeft className="mr-1 h-4 w-4" /> Back
          </Button>

          <div className="mt-8 grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-end">
            <div className="space-y-4">
              <div className="overflow-hidden rounded-[30px] border border-white/12 bg-black/35 shadow-[0_26px_80px_rgba(0,0,0,0.48)] backdrop-blur-sm">
                <img
                  src={toImageSrc(item.posterUrl)}
                  alt={item.title}
                  className="aspect-[2/3] w-full object-cover"
                  loading="lazy"
                />
              </div>

              <div className="rounded-[24px] border border-white/12 bg-black/30 p-4 text-white/72 shadow-[0_22px_60px_rgba(0,0,0,0.24)] backdrop-blur-xl">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.3em] text-white/44">
                  {item.mediaType === "movie" ? <Film className="h-3.5 w-3.5" /> : <Tv className="h-3.5 w-3.5" />}
                  <span>{item.mediaType === "movie" ? "Watch setup" : "Series setup"}</span>
                </div>
                <div className="mt-3 space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-white/54">Files</span>
                    <span className="text-right text-white">{fileStatusLabel}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-white/54">Resume</span>
                    <span className="text-right text-white">{resumeSummary}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-[34px] border border-white/12 bg-[linear-gradient(180deg,rgba(9,14,22,0.78),rgba(9,14,22,0.58))] p-6 text-white shadow-[0_32px_90px_rgba(0,0,0,0.34)] backdrop-blur-2xl sm:p-7">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="border-white/12 bg-white/[0.08] text-white backdrop-blur">
                  {item.mediaType === "movie" ? "Movie" : "TV Show"}
                </Badge>
                <Badge className="border-white/12 bg-white/[0.08] text-white/80 backdrop-blur">
                  {fileStatusLabel}
                </Badge>
                {item.contentRating === "adult" && (
                  <Badge className="bg-adult text-destructive-foreground">18+</Badge>
                )}
              </div>

              <div className="mt-4 flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl xl:text-[3.2rem]">
                    {item.title}
                  </h1>
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-white/64">
                    <span>{item.year}</span>
                    <span className="h-1 w-1 rounded-full bg-white/28" />
                    <div className="flex items-center gap-1.5">
                      <Star className="h-4 w-4 fill-[#f7c948] text-[#f7c948]" />
                      <span className="font-medium text-white">{item.rating}</span>
                    </div>
                    <span className="h-1 w-1 rounded-full bg-white/28" />
                    <span>{sessionStatus}</span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 shrink-0">
                  {item.mediaType === "tv" && (item.tv?.episodeList?.length ?? 0) > 0 ? (
                    <Select
                      value={selectedEpisodeSelectValue}
                      onValueChange={(key) => {
                        const episode = findEpisodeByKey(item.tv?.episodeList, key);
                        if (episode) selectEpisode(episode);
                      }}
                    >
                      <SelectTrigger className="h-11 w-[230px] rounded-full border-white/14 bg-white/[0.06] px-4 text-white hover:bg-white/12">
                        <SelectValue placeholder="Choose episode" />
                      </SelectTrigger>
                      <SelectContent>
                        {(item.tv?.episodeList ?? []).map((episode) => {
                          const code = `S${episode.season}E${String(episode.episode).padStart(2, "0")}`;
                          return (
                            <SelectItem key={`hero-${episodeKey(episode)}`} value={episodeKey(episode)}>
                              {code} - {episode.title}{episode.path?.trim() ? "" : " (no file)"}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <Button
                    onClick={() => onPlayClicked()}
                    className="h-11 rounded-full bg-[linear-gradient(135deg,#8bf3cb,#fcd34d)] px-5 font-semibold text-[#122018] shadow-[0_20px_45px_rgba(132,204,22,0.28)] hover:brightness-105"
                  >
                    <Play className="mr-1 h-4 w-4" fill="currentColor" /> Play
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => toggleFavorite(item.id)}
                    className="h-11 rounded-full border-white/14 bg-white/[0.06] px-4 text-white hover:bg-white/12"
                  >
                    <Heart className={`h-4 w-4 ${item.isFavorite ? "fill-[#fb7185] text-[#fb7185]" : ""}`} />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => toggleBookmark(item.id)}
                    className="h-11 rounded-full border-white/14 bg-white/[0.06] px-4 text-white hover:bg-white/12"
                  >
                    <Bookmark className={`h-4 w-4 ${item.isBookmarked ? "fill-[#7dd3fc] text-[#7dd3fc]" : ""}`} />
                  </Button>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {item.genre.map((genre) => (
                  <span
                    key={genre}
                    className="rounded-full border border-white/12 bg-white/[0.07] px-3 py-1 text-xs text-white/78 backdrop-blur"
                  >
                    {genre}
                  </span>
                ))}
                {assignedCategories.map((category) => (
                  <span
                    key={category.id}
                    className="rounded-full border border-white/12 bg-black/20 px-3 py-1 text-xs text-white"
                  >
                    <span
                      className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
                      style={{ backgroundColor: category.color }}
                    />
                    <span className="align-middle">{category.name}</span>
                  </span>
                ))}
              </div>

              <p className="mt-5 max-w-3xl text-sm leading-7 text-white/74 sm:text-[15px]">
                {item.overview || "No synopsis added yet. Clean up this entry from the Manage tab and map the right file before playback."}
              </p>

              <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-[22px] border border-white/12 bg-black/20 p-4">
                  <div className="text-[11px] uppercase tracking-[0.24em] text-white/42">Type</div>
                  <div className="mt-2 text-sm font-medium text-white">{item.mediaType === "movie" ? "Single title" : "Episode library"}</div>
                </div>
                <div className="rounded-[22px] border border-white/12 bg-black/20 p-4">
                  <div className="text-[11px] uppercase tracking-[0.24em] text-white/42">Session</div>
                  <div className="mt-2 text-sm font-medium text-white">{playbackSummary}</div>
                </div>
                <div className="rounded-[22px] border border-white/12 bg-black/20 p-4">
                  <div className="text-[11px] uppercase tracking-[0.24em] text-white/42">Resume</div>
                  <div className="mt-2 text-sm font-medium text-white">{resumeSummary}</div>
                </div>
                <div className="rounded-[22px] border border-white/12 bg-black/20 p-4">
                  <div className="text-[11px] uppercase tracking-[0.24em] text-white/42">Now queued</div>
                  <div className="mt-2 text-sm font-medium text-white">{episodeSummary}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto max-w-6xl px-4 pb-12 pt-8">
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-2 rounded-[26px] border border-border/60 bg-card/80 p-2 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur">
            <TabsTrigger value="overview" className="rounded-full px-4 py-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              Overview
            </TabsTrigger>
            <TabsTrigger value="cast" className="rounded-full px-4 py-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              Cast
            </TabsTrigger>
            <TabsTrigger value="manage" className="rounded-full px-4 py-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              Manage
            </TabsTrigger>
            <TabsTrigger value="playback" className="rounded-full px-4 py-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              Playback
            </TabsTrigger>
            <TabsTrigger value="related" className="rounded-full px-4 py-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              Related
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-0">
            <div className="space-y-5">
              <div className="rounded-[30px] border border-border/60 bg-card/85 p-6 shadow-[0_24px_60px_rgba(15,23,42,0.07)]">
                <div className="text-[11px] uppercase tracking-[0.28em] text-primary/70">Description</div>
                <h3 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
                  {item.mediaType === "movie" ? "Movie summary" : "Series summary"}
                </h3>
                <p className="mt-4 text-sm leading-7 text-muted-foreground">
                  {item.overview || "No synopsis added yet. Use the Manage tab if you want to clean up the summary or artwork."}
                </p>
                {item.tagline ? (
                  <p className="mt-4 rounded-[20px] border border-border/60 bg-secondary/35 px-4 py-3 text-sm italic text-foreground/88">
                    {item.tagline}
                  </p>
                ) : null}
              </div>

              {item.mediaType === "tv" ? (
                <div className="rounded-xl border border-border/60 bg-card/85 p-5 shadow-[0_18px_42px_rgba(15,23,42,0.06)]">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.22em] text-primary/70">Season guide</div>
                      <h3 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
                        {selectedSeasonGroup ? `Season ${selectedSeasonGroup.season}` : "Episodes"}
                      </h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="rounded-full border border-border/70 bg-secondary/55 px-3 py-1">
                        {item.tv?.seasons ?? seasonGroups.length} seasons
                      </span>
                      <span className="rounded-full border border-border/70 bg-secondary/55 px-3 py-1">
                        {item.tv?.episodes ?? item.tv?.episodeList?.length ?? 0} episodes
                      </span>
                    </div>
                  </div>

                  {seasonGroups.length > 1 ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {seasonGroups.map((group) => (
                        <button
                          key={`season-switch-${group.season}`}
                          type="button"
                          onClick={() => setSelectedSeason(group.season)}
                          className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                            selectedSeasonGroup?.season === group.season
                              ? "border-primary/50 bg-primary text-primary-foreground shadow-[0_10px_24px_rgba(34,197,94,0.16)]"
                              : "border-border/70 bg-secondary/35 text-muted-foreground hover:border-primary/25 hover:text-foreground"
                          }`}
                        >
                          {`Season ${group.season}`}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {selectedSeasonGroup ? (
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-foreground">
                          {`${selectedSeasonGroup.episodes.length} episode${selectedSeasonGroup.episodes.length === 1 ? "" : "s"} in view`}
                        </div>
                        {activeEpisode && activeEpisode.season === selectedSeasonGroup.season ? (
                          <span className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs text-primary">
                            {`Current: S${activeEpisode.season}E${String(activeEpisode.episode).padStart(2, "0")}`}
                          </span>
                        ) : null}
                      </div>

                      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                        {selectedSeasonGroup.episodes.map((episode) => {
                          const isPlayable = Boolean(episode.path?.trim());
                          const isActive = Boolean(
                            activeEpisode
                            && activeEpisode.season === episode.season
                            && activeEpisode.episode === episode.episode,
                          );
                          const code = `S${episode.season}E${String(episode.episode).padStart(2, "0")}`;
                          return (
                            <button
                              key={`${episode.season}-${episode.episode}`}
                              type="button"
                              onClick={() => selectEpisode(episode)}
                              aria-pressed={isActive}
                              className={`rounded-lg border p-3 text-left transition ${
                                isActive
                                  ? "border-primary/50 bg-primary/10 shadow-[0_12px_28px_rgba(34,197,94,0.08)]"
                                  : "border-border/60 bg-secondary/25"
                              } hover:border-primary/35 hover:bg-primary/5`}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-[10px] uppercase tracking-[0.18em] text-primary/70">{code}</span>
                                <span className={`rounded-full px-2 py-1 text-[10px] ${isPlayable ? "bg-emerald-500/12 text-emerald-300" : "bg-white/6 text-muted-foreground"}`}>
                                  {isPlayable ? "Mapped" : "No file"}
                                </span>
                              </div>
                              <div className="mt-2 line-clamp-1 text-sm font-semibold text-foreground">{episode.title}</div>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                {episode.runtimeMinutes ? <span>{formatDurationMinutes(episode.runtimeMinutes)}</span> : null}
                                {formatAirDateLabel(episode.airDate) ? <span>{formatAirDateLabel(episode.airDate)}</span> : null}
                              </div>
                              <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                                {episode.overview || "No episode synopsis imported for this entry yet."}
                              </p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-4 text-sm leading-7 text-muted-foreground">
                      Episode metadata has not been imported yet. Re-add the title from the metadata search to populate season and episode details.
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="cast" className="mt-0">
            <div className="rounded-xl border border-border/60 bg-card/85 p-5 shadow-[0_18px_42px_rgba(15,23,42,0.06)]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-primary/70">
                    <Users className="h-3.5 w-3.5" />
                    <span>Cast</span>
                  </div>
                  <h3 className="mt-2 text-xl font-semibold tracking-tight text-foreground">Cast directory</h3>
                </div>
                <span className="rounded-full border border-border/70 bg-secondary/55 px-3 py-1 text-xs text-muted-foreground">
                  {(item.cast ?? []).length} credits
                </span>
              </div>

              {item.cast && item.cast.length > 0 ? (
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {item.cast.map((member) => (
                    <div
                      key={`${member.id}-${member.name}`}
                      className="overflow-hidden rounded-lg border border-border/60 bg-secondary/25"
                    >
                      <div className="aspect-square bg-[radial-gradient(circle_at_top,rgba(34,197,94,0.16),transparent_38%),linear-gradient(180deg,rgba(15,23,42,0.2),rgba(15,23,42,0.9))]">
                        {member.profileUrl ? (
                          <img
                            src={toImageSrc(member.profileUrl)}
                            alt={member.name}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                            <Users className="h-7 w-7" />
                          </div>
                        )}
                      </div>
                      <div className="space-y-1.5 p-3">
                        <div className="line-clamp-1 text-sm font-semibold text-foreground">{member.name}</div>
                        <div className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                          {member.character || "Role not available"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-5 text-sm leading-7 text-muted-foreground">
                  No cast metadata has been imported for this title yet.
                </p>
              )}
            </div>
          </TabsContent>

              <TabsContent value="manage" className="mt-0">
                <div className="rounded-[28px] border border-border/60 bg-card/85 p-5 shadow-[0_22px_60px_rgba(15,23,42,0.06)]">
                  <div className="mb-5 flex flex-col gap-2 border-b border-border/60 pb-4 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.28em] text-primary/70">Manage local entry</div>
                      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                        Clean up library info, artwork, and file mappings here. Metadata can come from the live search, and this tab is where you attach the actual playable files.
                      </p>
                    </div>
                    <span className="rounded-full border border-border bg-secondary/70 px-3 py-1 text-xs text-muted-foreground">
                      {item.mediaType === "movie" ? "Movie workflow" : "TV workflow"}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div>
                      <Label className="text-muted-foreground">Title</Label>
                      <Input
                        value={form.title}
                        onChange={(e) => setForm({ ...form, title: e.target.value })}
                        className="bg-secondary border-border mt-1"
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                      <div>
                        <Label className="text-muted-foreground">Year</Label>
                        <Input
                          value={form.year}
                          onChange={(e) => setForm({ ...form, year: e.target.value })}
                          className="bg-secondary border-border mt-1"
                        />
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Rating</Label>
                        <Input
                          type="number"
                          step="0.1"
                          min="0"
                          max="10"
                          value={form.rating}
                          onChange={(e) => setForm({ ...form, rating: parseFloat(e.target.value) || 0 })}
                          className="bg-secondary border-border mt-1"
                        />
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Duration (min)</Label>
                        <Input
                          type="number"
                          min="1"
                          value={form.durationMinutes}
                          onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
                          className="bg-secondary border-border mt-1"
                          placeholder="125"
                        />
                      </div>
                    </div>
                    <div className="lg:col-span-2">
                      <Label className="text-muted-foreground">Overview</Label>
                      <Textarea
                        value={form.overview}
                        onChange={(e) => setForm({ ...form, overview: e.target.value })}
                        className="bg-secondary border-border mt-1"
                        rows={4}
                      />
                    </div>
                    <div className="lg:col-span-2">
                      <Label className="text-muted-foreground">Genres (comma-separated)</Label>
                      <Input
                        value={form.genre}
                        onChange={(e) => setForm({ ...form, genre: e.target.value })}
                        className="bg-secondary border-border mt-1"
                      />
                    </div>
                    <div className="lg:col-span-2 grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <div>
                        <Label className="text-muted-foreground">Poster Image URL</Label>
                        <Input
                          value={form.posterUrl}
                          onChange={(e) => setForm({ ...form, posterUrl: e.target.value })}
                          className="bg-secondary border-border mt-1"
                          placeholder="https://..."
                        />
                      </div>
                      <div>
                        <Label className="text-muted-foreground">Backdrop Image URL</Label>
                        <Input
                          value={form.backdropUrl}
                          onChange={(e) => setForm({ ...form, backdropUrl: e.target.value })}
                          className="bg-secondary border-border mt-1"
                          placeholder="https://..."
                        />
                      </div>
                    </div>
                    <div>
                      <Label className="text-muted-foreground">Content Rating</Label>
                      <Select
                        value={form.contentRating}
                        onValueChange={(v) => setForm({ ...form, contentRating: v as ContentRating })}
                      >
                        <SelectTrigger className="bg-secondary border-border mt-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="regular">Regular</SelectItem>
                          <SelectItem value="adult">Adult (18+)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-muted-foreground">Media Type</Label>
                      <Select
                        value={form.mediaType}
                        onValueChange={(v) => setForm({ ...form, mediaType: v as MediaType })}
                      >
                        <SelectTrigger className="bg-secondary border-border mt-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="movie">Movie</SelectItem>
                          <SelectItem value="tv">TV Show</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="lg:col-span-2">
                      <Label className="text-muted-foreground">Categories</Label>
                      {state.categories.length === 0 ? (
                        <p className="mt-2 text-xs leading-6 text-muted-foreground">
                          Create categories from the Library view first, then assign them here.
                        </p>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {state.categories.map((category) => {
                            const selected = form.categoryIds.includes(category.id);
                            return (
                              <button
                                key={category.id}
                                type="button"
                                onClick={() =>
                                  setForm((current) => ({
                                    ...current,
                                    categoryIds: selected
                                      ? current.categoryIds.filter((categoryId) => categoryId !== category.id)
                                      : [...current.categoryIds, category.id],
                                  }))
                                }
                                className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                                  selected
                                    ? "border-primary bg-primary/15 text-foreground"
                                    : "border-border bg-secondary/50 text-muted-foreground"
                                }`}
                              >
                                <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ backgroundColor: category.color }} />
                                <span className="align-middle">{category.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {form.mediaType === "movie" ? (
                      <div className="lg:col-span-2">
                        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                          <div className="flex-1">
                            <Label className="text-muted-foreground">Video Path (Desktop)</Label>
                            <Input
                              value={form.videoPath}
                              onChange={(e) => setForm({ ...form, videoPath: e.target.value })}
                              className="bg-secondary border-border mt-1 font-mono"
                              placeholder="D:\\Movies\\My Movie.mkv"
                            />
                          </div>
                          <Button
                            variant="outline"
                            className="border-border text-muted-foreground"
                            disabled={!isDesktop}
                            onClick={() => {
                              desktopPickVideoFile(form.videoPath.trim() || undefined)
                                .then((p) => {
                                  if (!p) return;
                                  setForm((prev) => ({ ...prev, videoPath: p }));
                                })
                                .catch((err) => {
                                  toast.error(errorMessage(err, "Failed to open file picker"));
                                });
                            }}
                          >
                            Browse
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          This path will be used when you press Play.
                        </p>
                      </div>
                    ) : (
                      <div className="lg:col-span-2">
                        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                          <div className="flex-1">
                            <Label className="text-muted-foreground">TV Show Root Folder (Desktop)</Label>
                            <Input
                              value={form.tvRootPath}
                              onChange={(e) => setForm({ ...form, tvRootPath: e.target.value })}
                              className="bg-secondary border-border mt-1 font-mono"
                              placeholder="D:\\TV\\My Show"
                            />
                          </div>
                          <Button
                            variant="outline"
                            className="border-border text-muted-foreground"
                            disabled={!isDesktop}
                            onClick={() => {
                              desktopPickFolder(form.tvRootPath.trim() || undefined)
                                .then((p) => {
                                  if (!p) return;
                                  setForm((prev) => ({ ...prev, tvRootPath: p }));
                                })
                                .catch((err) => {
                                  toast.error(errorMessage(err, "Failed to open folder picker"));
                                });
                            }}
                          >
                            Browse
                          </Button>
                          <Button
                            className="gradient-green text-primary-foreground font-semibold"
                            onClick={() => onScanTvClicked()}
                            disabled={!isDesktop}
                          >
                            Scan
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">
                          Supported layouts include <span className="font-mono">show\season 1\episode 1\video.mkv</span>, <span className="font-mono">show\s1\ep1\video.mkv</span>, and direct episode files inside each season folder.
                        </p>
                        {item.tv?.episodeList && item.tv.episodeList.length > 0 ? (
                          <p className="text-xs text-muted-foreground mt-1">
                            Detected: {item.tv.seasons ?? "-"} seasons, {item.tv.episodes ?? item.tv.episodeList.length} episodes.
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground mt-1">
                            No episodes scanned yet.
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <Button
                      variant="destructive"
                      onClick={() => setDeleteDialogOpen(true)}
                      className="font-semibold sm:self-start"
                    >
                      <Trash2 className="mr-1 h-4 w-4" />
                      Delete Item
                    </Button>

                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => setAutoFetchDialogOpen(true)}
                        className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                      >
                        <Sparkles className="mr-1 h-4 w-4" />
                        Auto Fetch
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setForm({
                            title: item.title,
                            overview: item.overview,
                            year: item.year,
                            rating: item.rating,
                            durationMinutes: item.durationMinutes != null ? String(item.durationMinutes) : "",
                            genre: item.genre.join(", "),
                            posterUrl: item.posterUrl,
                            backdropUrl: item.backdropUrl,
                            contentRating: item.contentRating,
                            mediaType: item.mediaType,
                            videoPath: item.videoPath ?? "",
                            tvRootPath: item.tv?.rootPath ?? "",
                            categoryIds: item.categoryIds,
                          });
                          toast("Reset changes");
                        }}
                        className="border-border text-muted-foreground"
                      >
                        Reset
                      </Button>
                      <Button onClick={onSaveMetadata} className="gradient-green text-primary-foreground font-semibold">
                        Save
                      </Button>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="playback" className="mt-0">
                <div className="rounded-[28px] border border-border/60 bg-card/85 p-5 shadow-[0_22px_60px_rgba(15,23,42,0.06)]">
                  {!isDesktop ? (
                    <div className="rounded-[22px] border border-border/60 bg-secondary/35 p-5">
                      <h3 className="text-base font-semibold text-foreground">Desktop-only playback panel</h3>
                      <p className="mt-3 text-sm leading-6 text-muted-foreground">
                        Live transport controls, track switching, and subtitle import are only available in the desktop shell.
                        Run <span className="font-mono">npm run tauri:dev</span> when you want to test the real player workflow.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-5">
                      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                        <div className="rounded-[22px] border border-border/60 bg-secondary/35 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="text-sm font-semibold text-foreground">Selected media</h3>
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-border text-muted-foreground"
                              onClick={() => onPlayClicked(activeMediaPath)}
                              disabled={!activeMediaPath.trim()}
                            >
                              Open Player
                            </Button>
                          </div>

                          {item.mediaType === "movie" ? (
                            <div className="mt-3 space-y-2">
                              <p className="text-sm text-muted-foreground">
                                Use the mapped movie file below when you press Play.
                              </p>
                              <div className="rounded-xl border border-border/60 bg-background/40 px-3 py-3 text-xs text-foreground">
                                <span className="font-medium text-muted-foreground">Movie file</span>
                                <div className="mt-2 break-all font-mono">{item.videoPath || "No file set yet"}</div>
                              </div>
                            </div>
                          ) : (
                            <>
                              {(item.tv?.episodeList?.length ?? 0) > 0 ? (
                                <div className="mt-3 space-y-3">
                                  <Label className="text-muted-foreground">Episode</Label>
                                  <Select
                                    value={selectedEpisodeSelectValue}
                                    onValueChange={(key) => {
                                      const episode = findEpisodeByKey(item.tv?.episodeList, key);
                                      if (episode) selectEpisode(episode);
                                    }}
                                  >
                                    <SelectTrigger className="bg-secondary border-border mt-1">
                                      <SelectValue placeholder="Select episode" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {(item.tv?.episodeList ?? []).map((ep) => {
                                        const code = `S${ep.season}E${String(ep.episode).padStart(2, "0")}`;
                                        return (
                                          <SelectItem key={`playback-${episodeKey(ep)}`} value={episodeKey(ep)}>
                                            {code} - {ep.title}{ep.path?.trim() ? "" : " (no file)"}
                                          </SelectItem>
                                        );
                                      })}
                                    </SelectContent>
                                  </Select>
                                  {activeEpisode ? (
                                    <div className="rounded-xl border border-border/60 bg-background/40 px-3 py-3 text-xs text-foreground">
                                      <span className="font-medium text-muted-foreground">Selected episode</span>
                                      <div className="mt-2 text-sm font-semibold text-foreground">
                                        {`S${activeEpisode.season}E${String(activeEpisode.episode).padStart(2, "0")} - ${activeEpisode.title}`}
                                      </div>
                                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                        {activeEpisode.runtimeMinutes ? <span>{formatDurationMinutes(activeEpisode.runtimeMinutes)}</span> : null}
                                        {activeEpisode.airDate ? <span>{activeEpisode.airDate}</span> : null}
                                      </div>
                                      <p className="mt-3 leading-6 text-muted-foreground">
                                        {activeEpisode.overview || "No episode synopsis available for this selection yet."}
                                      </p>
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                                  Episode metadata has not been imported yet. Import the title metadata, then scan the TV folder in the Manage tab to link real files season by season.
                                </p>
                              )}
                            </>
                          )}

                          {activeMediaPath.trim() ? (
                            <div className="mt-3 rounded-xl border border-border/60 bg-background/40 px-3 py-3 text-xs text-foreground">
                              <span className="font-medium text-muted-foreground">Active path</span>
                              <div className="mt-2 break-all font-mono">{activeMediaPath}</div>
                            </div>
                          ) : null}
                        </div>

                        <div className="rounded-[22px] border border-border/60 bg-secondary/35 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="text-sm font-semibold text-foreground">Resume</h3>
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-border text-muted-foreground"
                              onClick={() => {
                                const mediaKey = activeMediaPath.trim();
                                if (!mediaKey) {
                                  toast.error("Select a media path first");
                                  return;
                                }
                                playerClearResumePosition(mediaKey)
                                  .then(() => refreshPlaybackInfo())
                                  .then(() => toast("Resume position cleared"))
                                  .catch(() => toast.error("Failed to clear resume position"));
                              }}
                              disabled={!activeMediaPath.trim() || resumeSavedSeconds === null}
                            >
                              Clear
                            </Button>
                          </div>
                          <p className="mt-3 text-sm text-muted-foreground">{resumeSummary}</p>
                          <p className="mt-2 text-xs leading-6 text-muted-foreground">
                            The desktop player keeps this updated while watching, pausing, and closing.
                          </p>
                        </div>
                      </div>

                      <div className="rounded-[22px] border border-border/60 bg-secondary/35 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-sm font-semibold text-foreground">Transport</h3>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-border text-muted-foreground"
                            onClick={() => refreshPlaybackInfo().catch(() => {})}
                          >
                            Refresh
                          </Button>
                        </div>
                        <p className="mt-3 text-sm text-muted-foreground">
                          {playbackSummary}
                          {playbackInfo?.paused === true ? " | Paused" : playbackInfo?.paused === false ? " | Playing" : ""}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            className="border-border text-muted-foreground"
                            onClick={() => {
                              const mediaKey = activeMediaPath.trim();
                              if (!mediaKey) {
                                toast.error("Select a media path first");
                                return;
                              }
                              playerSeekRelative(mediaKey, -10)
                                .then(() => refreshPlaybackInfo())
                                .catch((err) => {
                                  toast.error(errorMessage(err, "Seek failed"));
                                });
                            }}
                          >
                            -10s
                          </Button>
                          <Button
                            variant="outline"
                            className="border-border text-muted-foreground"
                            onClick={() => {
                              const mediaKey = activeMediaPath.trim();
                              if (!mediaKey) {
                                toast.error("Select a media path first");
                                return;
                              }
                              playerSeekRelative(mediaKey, 10)
                                .then(() => refreshPlaybackInfo())
                                .catch((err) => {
                                  toast.error(errorMessage(err, "Seek failed"));
                                });
                            }}
                          >
                            +10s
                          </Button>
                          <Button
                            className="gradient-green text-primary-foreground font-semibold"
                            onClick={() => {
                              const mediaKey = activeMediaPath.trim();
                              if (!mediaKey) {
                                toast.error("Select a media path first");
                                return;
                              }
                              void (async () => {
                                let currentPaused =
                                  typeof playbackInfo?.paused === "boolean" ? playbackInfo.paused : null;
                                if (currentPaused == null) {
                                  const info = await playerGetPlaybackInfo(mediaKey).catch(() => null);
                                  currentPaused = typeof info?.paused === "boolean" ? info.paused : false;
                                 }
                                 const nextPause = !currentPaused;
                                 await playerTogglePause(mediaKey);
                                 await refreshPlaybackInfo().catch(() => {});
                                 toast(nextPause ? "Paused" : "Resumed");
                               })().catch(async (err) => {
                                await refreshPlaybackInfo().catch(() => {});
                                toast.error(errorMessage(err, "Pause failed"));
                              });
                            }}
                          >
                            {playbackInfo?.paused ? "Resume" : "Pause"}
                          </Button>
                        </div>
                        <p className="mt-3 text-xs leading-6 text-muted-foreground">
                          These controls sync with the desktop player while it is open.
                        </p>
                      </div>

                      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <div className="rounded-[22px] border border-border/60 bg-secondary/35 p-4">
                          <Label className="text-muted-foreground">Audio Track</Label>
                          <Select
                            value={String(audioTrackId)}
                            onValueChange={(v) => {
                              const id = Number(v);
                              if (!Number.isFinite(id)) return;
                              setAudioTrackId(id);
                              const mediaKey = activeMediaPath.trim();
                              if (!mediaKey) return;
                              playerSetAudioTrack(mediaKey, id).catch(() => {});
                            }}
                          >
                            <SelectTrigger className="bg-secondary border-border mt-1">
                              <SelectValue placeholder="Select audio" />
                            </SelectTrigger>
                            <SelectContent>
                              {tracks.audio.map((t) => (
                                <SelectItem key={t.id} value={String(t.id)}>
                                  {t.label}{t.lang ? ` (${t.lang})` : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="rounded-[22px] border border-border/60 bg-secondary/35 p-4">
                          <Label className="text-muted-foreground">Subtitles</Label>
                          <Select
                            value={String(subtitleTrackId)}
                            onValueChange={(v) => {
                              const id = Number(v);
                              if (!Number.isFinite(id)) return;
                              setSubtitleTrackId(id);
                              const mediaKey = activeMediaPath.trim();
                              if (!mediaKey) return;
                              playerSetSubtitleTrack(mediaKey, id).catch(() => {});
                            }}
                          >
                            <SelectTrigger className="bg-secondary border-border mt-1">
                              <SelectValue placeholder="Select subtitles" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="0">Off</SelectItem>
                              {tracks.subtitles.map((t) => (
                                <SelectItem key={t.id} value={String(t.id)}>
                                  {t.label}{t.lang ? ` (${t.lang})` : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {externalSubtitles.length} imported subtitle {externalSubtitles.length === 1 ? "file" : "files"} attached.
                          </p>
                        </div>
                      </div>

                      <div className="rounded-[22px] border border-border/60 bg-secondary/35 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold text-foreground">External subtitles</h3>
                            <p className="mt-2 text-xs leading-6 text-muted-foreground">
                              Import local subtitle files and clean them up from here.
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            className="border-border text-muted-foreground"
                            onClick={() => {
                              const mediaKey = activeMediaPath.trim();
                              if (!mediaKey) {
                                toast.error("Select a media path first");
                                return;
                              }
                              desktopPickSubtitleFile(undefined)
                                .then((path) => {
                                  if (!path) return;
                                  return playerAddExternalSubtitle(mediaKey, path)
                                    .then(() => refreshPlaybackInfo())
                                    .then(() => toast.success("Subtitle added"));
                                })
                                .catch((err) => {
                                  toast.error(errorMessage(err, "Failed to import subtitle"));
                                });
                            }}
                            disabled={!activeMediaPath.trim()}
                          >
                            Import Subtitle
                          </Button>
                        </div>

                        <div className="mt-4 space-y-2">
                          {externalSubtitles.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No external subtitles added.</p>
                          ) : (
                            externalSubtitles.map((p) => (
                              <div key={p} className="flex items-center justify-between gap-3 bg-secondary/60 border border-border rounded-lg p-2">
                                <span className="text-xs text-foreground truncate font-mono">{p}</span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="border-border text-muted-foreground"
                                  onClick={() => {
                                    const mediaKey = activeMediaPath.trim();
                                    if (!mediaKey) {
                                      toast.error("Select a media path first");
                                      return;
                                    }
                                    playerRemoveExternalSubtitle(mediaKey, p)
                                      .then(() => refreshPlaybackInfo())
                                      .then(() => toast("Subtitle removed"))
                                      .catch(() => toast.error("Failed to remove subtitle"));
                                  }}
                                >
                                  Remove
                                </Button>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="related" className="mt-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-foreground">Similar Picks</h2>
                    <Button variant="outline" size="sm" className="border-border text-muted-foreground" onClick={() => navigate("/")}>
                      Browse Library
                    </Button>
                  </div>
                  <MediaGrid items={recommended} emptyMessage="No related items share genres, categories, or playlists yet." />
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">Delete this item?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes <span className="font-medium text-foreground">{item.title}</span> from your library, playlists, and history.
              File mappings and imported metadata stored inside this entry will be removed from the app state.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" className="border-border text-muted-foreground">
                Cancel
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant="destructive" onClick={onDeleteItem}>
                Delete Item
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={resumeDialogOpen}
        onOpenChange={(open) => {
          setResumeDialogOpen(open);
          if (!open) setResumeMediaPath(null);
        }}
      >
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">Resume playback?</AlertDialogTitle>
            <AlertDialogDescription>
              {resumePositionSeconds !== null
                ? `Continue from ${formatTimeShort(resumePositionSeconds)}?`
                : "Continue from your last position?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" className="border-border text-muted-foreground">
                Cancel
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                variant="outline"
                className="border-border text-muted-foreground"
                onClick={() => {
                  const mediaPath = (resumeMediaPath ?? "").trim();
                  if (!mediaPath) return;
                  setResumeDialogOpen(false);
                  setResumeMediaPath(null);
                  setResumePositionSeconds(null);
                  playNow(mediaPath, 0).catch(() => {});
                }}
              >
                Start Over
              </Button>
            </AlertDialogAction>
            <AlertDialogAction asChild>
              <Button
                className="gradient-green text-primary-foreground font-semibold"
                onClick={() => {
                  const mediaPath = (resumeMediaPath ?? "").trim();
                  if (!mediaPath) return;
                  const pos = resumePositionSeconds ?? null;
                  setResumeDialogOpen(false);
                  setResumeMediaPath(null);
                  setResumePositionSeconds(null);
                  playNow(mediaPath, pos).catch(() => {});
                }}
              >
                Resume
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AutoFetchDialog
        item={item}
        open={autoFetchDialogOpen}
        onOpenChange={setAutoFetchDialogOpen}
        onMetadataLoaded={handleAutoFetchMetadata}
      />
    </>
  );
}
