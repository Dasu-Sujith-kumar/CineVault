import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Plus, ArrowLeft, Check, Loader2, Star } from "lucide-react";
import { motion } from "framer-motion";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useApp } from "@/components/AppContext";
import { desktopPickFolder, isTauriRuntime } from "@/lib/desktop-player";
import {
  cacheMetadataImage,
  getMetadataCacheDirectory,
  metadataGetDetails,
  metadataSearch,
  MetadataDetails,
  MetadataSearchResult,
  MetadataSource,
  setMetadataCacheDirectory,
} from "@/lib/media-metadata";
import type { LibraryKind, MediaType } from "@/lib/store";

const IMPORT_MAX_ATTEMPTS = 3;
const IMPORT_RETRY_DELAYS_MS = [1500, 3500];
const IMPORT_SLOW_NOTICE_MS = 8000;

function sourceLabel(source: MetadataSource) {
  switch (source) {
    case "tmdb":
      return "TMDb";
    case "omdb":
      return "OMDb";
    case "tvdb":
      return "TVDB";
    case "trakt":
      return "Trakt";
    case "jikan":
      return "Jikan";
    case "hhaven":
      return "Hentai Haven";
    default:
      return source;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}

async function fetchDetailsWithRetry(
  result: MetadataSearchResult,
  onRetry: (nextAttempt: number, message: string) => void,
): Promise<MetadataDetails> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= IMPORT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await metadataGetDetails(result.sourceId, result.mediaType, result.source);
    } catch (error) {
      lastError = error;
      if (attempt >= IMPORT_MAX_ATTEMPTS) break;

      onRetry(attempt + 1, errorMessage(error, "Provider request failed"));
      await sleep(IMPORT_RETRY_DELAYS_MS[attempt - 1] ?? 2500);
    }
  }

  throw lastError;
}

export default function AddItemPage() {
  const navigate = useNavigate();
  const { addItem, updateItem } = useApp();
  const [query, setQuery] = useState("");
  const [mediaFilter, setMediaFilter] = useState<"movie" | "tv" | "anime" | "cartoon" | "hentai" | "shorts">("movie");
  const [results, setResults] = useState<MetadataSearchResult[]>([]);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string>("");
  const [importNotice, setImportNotice] = useState<string>("");
  const [activeTab, setActiveTab] = useState<MetadataSource>("tmdb");
  const [imageCacheDir, setImageCacheDirState] = useState<string>("");
  const trimmedQuery = query.trim();
  const canCreateDraft = trimmedQuery.length > 0;
  const resultKey = (result: MetadataSearchResult) => `${result.provider}:${result.source}:${result.sourceId}:${result.mediaType}`;
  const selectedLibraryKind: LibraryKind =
    mediaFilter === "tv"
      ? "shows"
      : mediaFilter === "anime"
        ? "anime"
        : mediaFilter === "cartoon"
          ? "cartoon"
        : mediaFilter === "hentai"
          ? "hentai"
          : mediaFilter === "shorts"
            ? "movieShorts"
            : "movies";
  const selectedMediaType: MediaType = mediaFilter === "tv" || mediaFilter === "anime" || mediaFilter === "cartoon" || mediaFilter === "hentai" ? "tv" : "movie";
  const selectedContentRating = selectedLibraryKind === "hentai" ? "adult" : "regular";
  const searchFilter = mediaFilter === "hentai"
    ? "hentai"
    : mediaFilter === "anime"
      ? "anime"
      : mediaFilter === "cartoon"
        ? "cartoon"
        : mediaFilter === "tv"
          ? "tv"
          : mediaFilter === "shorts"
            ? "movieShorts"
            : "movie";

  const formatDuration = (minutes?: number | null) => {
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return "Runtime pending";
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return hours > 0 ? `${hours}h ${String(mins).padStart(2, "0")}m` : `${mins}m`;
  };

  const cacheImportedArtwork = async (
    itemId: string,
    posterUrl: string,
    backdropUrl: string,
    cast: Array<{ id: string; name: string; character?: string; profileUrl?: string }>,
    cacheKeys?: {
      poster?: string;
      backdrop?: string;
      cast?: string[];
    },
  ) => {
    const [cachedPosterUrl, cachedBackdropUrl, cachedCast] = await Promise.all([
      cacheMetadataImage(posterUrl, cacheKeys?.poster ?? null),
      cacheMetadataImage(backdropUrl, cacheKeys?.backdrop ?? null),
      Promise.all(
        cast.map(async (member, index) => ({
          ...member,
          profileUrl: member.profileUrl
            ? await cacheMetadataImage(member.profileUrl, cacheKeys?.cast?.[index] ?? null)
            : member.profileUrl,
        })),
      ),
    ]);

    const castChanged = cachedCast.some((member, index) => member.profileUrl !== cast[index]?.profileUrl);
    const posterChanged = cachedPosterUrl && cachedPosterUrl !== posterUrl;
    const backdropChanged = cachedBackdropUrl && cachedBackdropUrl !== backdropUrl;

    if (!posterChanged && !backdropChanged && !castChanged) return;

    updateItem(itemId, {
      ...(posterChanged ? { posterUrl: cachedPosterUrl } : {}),
      ...(backdropChanged ? { backdropUrl: cachedBackdropUrl } : {}),
      ...(castChanged ? { cast: cachedCast } : {}),
    });
  };

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void getMetadataCacheDirectory()
      .then((path) => setImageCacheDirState(path ?? ""))
      .catch(() => {});
  }, []);

  const handleSearch = async () => {
    if (!trimmedQuery) return;
    setSearching(true);
    setSearchError("");
    try {
      const next = await metadataSearch(trimmedQuery, searchFilter);
      setResults(next);
    } catch (error) {
      setResults([]);
      setSearchError(error instanceof Error ? error.message : "Metadata search failed");
    } finally {
      setSearching(false);
    }
  };

  const handleAdd = async (result: MetadataSearchResult) => {
    const key = resultKey(result);
    setAddingKey(key);
    setSearchError("");
    setImportNotice(`Importing details from ${sourceLabel(result.source)}...`);
    let slowNoticeTimer: number | undefined;
    try {
      slowNoticeTimer = window.setTimeout(() => {
        setImportNotice(`${sourceLabel(result.source)} is still fetching cast and episode data. Waiting for it to finish...`);
      }, IMPORT_SLOW_NOTICE_MS);

      const details = await fetchDetailsWithRetry(result, (nextAttempt, message) => {
        setImportNotice(`${sourceLabel(result.source)} failed once (${message}). Retrying import ${nextAttempt}/${IMPORT_MAX_ATTEMPTS}...`);
      });
      if (slowNoticeTimer !== undefined) window.clearTimeout(slowNoticeTimer);
      setImportNotice("Saving title to your library...");

      const mappedEpisodes = details.tv?.episodeList?.map((episode) => ({
        season: episode.season,
        episode: episode.episode,
        title: episode.title,
        path: episode.path ?? undefined,
        overview: episode.overview ?? undefined,
        runtimeMinutes: episode.runtimeMinutes ?? undefined,
        airDate: episode.airDate ?? undefined,
        stillUrl: episode.stillUrl ?? undefined,
      }));

      const firstMappedEpisodePath = mappedEpisodes?.find((episode) => Boolean(episode.path?.trim()))?.path;
      const id = crypto.randomUUID();
      const importedCast = details.cast.map((member) => ({
        id: member.id,
        name: member.name,
        character: member.character ?? undefined,
        profileUrl: member.profileUrl ?? undefined,
      }));
      const importedPosterUrl = details.posterUrl || result.posterUrl || "/placeholder.svg";
      const importedBackdropUrl = details.backdropUrl || result.backdropUrl || "/placeholder.svg";
      const castCacheKeys = importedCast.map((member) => `cast-${details.source}-${member.id}`);

      addItem({
        id,
        title: details.title,
        originalTitle: details.originalTitle ?? undefined,
        overview: details.overview,
        tagline: details.tagline ?? undefined,
        posterUrl: importedPosterUrl,
        backdropUrl: importedBackdropUrl,
        durationMinutes: details.durationMinutes ?? result.durationMinutes ?? undefined,
        videoPath: undefined,
        tv: details.mediaType === "tv" ? {
          seasons: details.tv?.seasons,
          episodes: details.tv?.episodes,
          episodeList: mappedEpisodes,
          selectedEpisodePath: firstMappedEpisodePath,
        } : undefined,
        tmdbId: details.tmdbId ?? undefined,
        rating: details.rating || result.rating,
        year: details.year || result.year,
        genre: details.genre.length > 0 ? details.genre : result.genre,
        cast: importedCast,
        status: details.status ?? undefined,
        contentRating: selectedContentRating,
        mediaType: details.mediaType,
        libraryKind: selectedLibraryKind,
        addedAt: Date.now(),
        isFavorite: false,
        isBookmarked: false,
        playlists: [],
        categoryIds: [],
      });
      void cacheImportedArtwork(id, importedPosterUrl, importedBackdropUrl, importedCast, {
        poster: `poster-${details.source}-${details.sourceId}`,
        backdrop: `backdrop-${details.source}-${details.sourceId}`,
        cast: castCacheKeys,
      }).catch(() => {});
      setAdded((prev) => new Set(prev).add(key));
      setImportNotice("");
    } catch (error) {
      setSearchError(errorMessage(error, `Failed to import metadata from ${sourceLabel(result.source)}`));
      setImportNotice("");
    } finally {
      if (slowNoticeTimer !== undefined) window.clearTimeout(slowNoticeTimer);
      setAddingKey(null);
    }
  };

  const createDraftItem = () => {
    if (!canCreateDraft) return;
    const id = crypto.randomUUID();
    addItem({
      id,
      title: trimmedQuery,
      overview: "Draft entry. Use metadata search to replace this with fetched details, cast, and TV episode info.",
      posterUrl: "/placeholder.svg",
      backdropUrl: "/placeholder.svg",
      durationMinutes: undefined,
      rating: 0,
      year: "",
      genre: mediaFilter === "anime" ? ["Anime"] : mediaFilter === "cartoon" ? ["Cartoon"] : mediaFilter === "hentai" ? ["Hentai", "Anime"] : [],
      contentRating: selectedContentRating,
      mediaType: selectedMediaType,
      libraryKind: selectedLibraryKind,
      addedAt: Date.now(),
      isFavorite: false,
      isBookmarked: false,
      playlists: [],
      categoryIds: [],
    });
    navigate(`/item/${id}`);
  };

  const resultLabel = useMemo(() => {
    if (!trimmedQuery) return "Search by provider";
    if (searching) return `Searching for "${trimmedQuery}"...`;
    if (results.length === 0) return `No matches for "${trimmedQuery}"`;
    return `${results.length} ${results.length === 1 ? "match" : "matches"} from live metadata`;
  }, [results.length, searching, trimmedQuery]);

  const providerTabs = useMemo(() => {
    if (mediaFilter === "movie" || mediaFilter === "shorts") return ["tmdb", "omdb", "trakt"] as MetadataSource[];
    if (mediaFilter === "tv") return ["omdb", "tvdb", "trakt"] as MetadataSource[];
    if (mediaFilter === "cartoon") return ["omdb", "tvdb", "trakt", "jikan"] as MetadataSource[];
    if (mediaFilter === "hentai") return ["hhaven"] as MetadataSource[];
    return ["jikan"] as MetadataSource[];
  }, [mediaFilter]);

  const groupedResults = useMemo(() => {
    const groups: Record<MetadataSource, MetadataSearchResult[]> = {
      tmdb: [],
      omdb: [],
      tvdb: [],
      trakt: [],
      jikan: [],
      hhaven: [],
    };
    for (const result of results) {
      groups[result.provider].push(result);
    }
    return groups;
  }, [results]);

  useEffect(() => {
    const nextActiveTab = providerTabs.find((tab) => groupedResults[tab].length > 0) ?? providerTabs[0];
    setActiveTab(nextActiveTab);
  }, [groupedResults, providerTabs]);

  const renderResultList = (items: MetadataSearchResult[]) => (
    <div className="space-y-3">
      {items.map((result) => (
        <motion.div
          key={resultKey(result)}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-card flex gap-4 rounded-[24px] border border-border/60 p-4"
        >
          <img
            src={result.posterUrl || "/placeholder.svg"}
            alt={result.title}
            className="h-24 w-16 shrink-0 rounded-xl object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-foreground">{result.title}</h3>
              <Badge variant="outline" className="border-border text-[10px] text-muted-foreground">
                {mediaFilter === "hentai" ? "Hentai" : result.mediaType === "movie" ? "Movie" : mediaFilter === "anime" ? "Anime Series" : "TV Show"}
              </Badge>
              <Badge variant="outline" className="border-border text-[10px] text-muted-foreground">
                {sourceLabel(result.provider)}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {[result.year, formatDuration(result.durationMinutes), ...result.genre].filter(Boolean).join(" | ")}
            </p>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {result.overview}
            </p>
            <div className="mt-3 flex items-center gap-1 text-sm text-foreground">
              <Star className="h-4 w-4 fill-primary text-primary" />
              <span>{result.rating.toFixed(1)}</span>
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => void handleAdd(result)}
            disabled={added.has(resultKey(result)) || addingKey === resultKey(result)}
            className={added.has(resultKey(result)) ? "bg-success text-destructive-foreground" : "gradient-green text-primary-foreground"}
          >
            {added.has(resultKey(result)) ? (
              <>
                <Check className="mr-1.5 h-4 w-4" />
                Added
              </>
            ) : addingKey === resultKey(result) ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Importing
              </>
            ) : (
              <>
                <Plus className="mr-1.5 h-4 w-4" />
                Add
              </>
            )}
          </Button>
        </motion.div>
      ))}
    </div>
  );

  const renderResultTab = (items: MetadataSearchResult[], emptyLabel: string) => (
    items.length > 0 ? (
      renderResultList(items)
    ) : (
      <div className="rounded-[24px] border border-dashed border-border/70 bg-card/35 px-6 py-10 text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    )
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")}
            className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Add to Library</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Search the live metadata catalog, then import full title details into your local library.
            </p>
          </div>
        </div>

        <div className="mb-6 rounded-[24px] border border-primary/20 bg-primary/8 p-4 text-sm text-muted-foreground">
          Movies search through TMDb, OMDb, and Trakt. TV search through OMDb, TVDB, and Trakt. Anime search uses Jikan for now.
          If a title is missing or too obscure, create a draft and finish it manually in the Manage view.
        </div>

        {isTauriRuntime() ? (
          <div className="mb-6 flex flex-col gap-3 rounded-[24px] border border-border/60 bg-card/60 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-[0.28em] text-primary/70">Image Cache Folder</div>
              <p className="mt-2 text-sm text-muted-foreground">
                {imageCacheDir
                  ? imageCacheDir
                  : "Not configured yet. Pick a folder if you want posters, backdrops, and cast images stored locally for offline use."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="border-border text-muted-foreground"
                onClick={() => {
                  desktopPickFolder(imageCacheDir || undefined)
                    .then((selected) => {
                      if (!selected) return null;
                      return setMetadataCacheDirectory(selected)
                        .then((saved) => {
                          setImageCacheDirState(saved ?? "");
                        });
                    })
                    .catch((error) => {
                      setSearchError(error instanceof Error ? error.message : "Failed to set image cache folder");
                    });
                }}
              >
                {imageCacheDir ? "Change Folder" : "Choose Folder"}
              </Button>
              {imageCacheDir ? (
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground"
                  onClick={() => {
                    setMetadataCacheDirectory(null)
                      .then(() => setImageCacheDirState(""))
                      .catch((error) => {
                        setSearchError(error instanceof Error ? error.message : "Failed to clear image cache folder");
                      });
                  }}
                >
                  Disable Cache
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="glass-card mb-6 rounded-[24px] border border-border/60 p-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search titles..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
                className="h-11 border-border bg-secondary pl-9"
              />
            </div>
            <Select value={mediaFilter} onValueChange={(v) => setMediaFilter(v as "movie" | "tv" | "anime" | "cartoon" | "hentai" | "shorts")}>
              <SelectTrigger className="w-full border-border bg-secondary sm:w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="movie">Movies</SelectItem>
                <SelectItem value="tv">Shows</SelectItem>
                <SelectItem value="anime">Anime</SelectItem>
                <SelectItem value="cartoon">Cartoon</SelectItem>
                <SelectItem value="hentai">Hentai</SelectItem>
                <SelectItem value="shorts">Movie Shorts</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => void handleSearch()} className="gradient-green text-primary-foreground font-semibold" disabled={!trimmedQuery || searching}>
              {searching ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Search
            </Button>
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{resultLabel}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a provider tab, then import the title with the richest available metadata.
            </p>
          </div>
          <Button
            variant="outline"
            className="border-border text-muted-foreground"
            onClick={createDraftItem}
            disabled={!canCreateDraft}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Create Draft
          </Button>
        </div>

        {searchError ? (
          <div className="mb-4 rounded-[20px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {searchError}
          </div>
        ) : null}
        {importNotice ? (
          <div className="mb-4 rounded-[20px] border border-primary/25 bg-primary/10 px-4 py-3 text-sm text-primary">
            {importNotice}
          </div>
        ) : null}

        {results.length > 0 ? (
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as MetadataSource)} className="space-y-5">
            <TabsList className="flex h-auto w-full flex-wrap justify-start gap-2 rounded-[24px] border border-border/60 bg-card/70 p-2">
              {providerTabs.map((provider) => (
                <TabsTrigger key={provider} value={provider} className="rounded-full px-4 py-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                  {sourceLabel(provider)}
                  <span className="ml-2 text-xs opacity-70">{groupedResults[provider].length}</span>
                </TabsTrigger>
              ))}
            </TabsList>

            {providerTabs.map((provider) => (
              <TabsContent key={provider} value={provider} className="mt-0">
                {renderResultTab(groupedResults[provider], `No ${sourceLabel(provider)} results in this search.`)}
              </TabsContent>
            ))}
          </Tabs>
        ) : (
          <div className="rounded-[28px] border border-dashed border-border/70 bg-card/35 px-6 py-20 text-center text-muted-foreground">
            <Search className="mx-auto mb-4 h-12 w-12 opacity-30" />
            <p className="text-base font-medium text-foreground/88">
              {trimmedQuery ? (searching ? "Searching live metadata..." : "No live matches found.") : "Search for a title to add."}
            </p>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6">
              {trimmedQuery
                ? "Create a draft entry if the title is too obscure, then attach files and refine the library data in the Manage view."
                : "Search uses the live metadata provider and imports the richer title details into your library."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
