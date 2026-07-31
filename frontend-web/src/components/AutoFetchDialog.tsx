import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { metadataSearch, metadataGetDetails, MetadataSearchFilter } from "@/lib/media-metadata";
import { debugLog } from "@/lib/desktop-player";
import { MediaItem } from "@/lib/store";

interface SearchResult {
  id: string;
  sourceId: string;
  source: "tmdb" | "omdb" | "tvdb" | "trakt" | "jikan" | "hhaven";
  title: string;
  year?: string;
  mediaType: "movie" | "tv";
  posterUrl?: string;
  overview?: string;
}

interface AutoFetchDialogProps {
  item: MediaItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMetadataLoaded: (metadata: Partial<MediaItem>) => void;
}

export function AutoFetchDialog({ item, open, onOpenChange, onMetadataLoaded }: AutoFetchDialogProps) {
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedTab, setSelectedTab] = useState<string>("");
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);

  const searchFilterForItem = (target: MediaItem): MetadataSearchFilter => {
    switch (target.libraryKind) {
      case "hentai":
        return "hentai";
      case "anime":
        return "anime";
      case "cartoon":
        return "cartoon";
      case "movieShorts":
        return "movieShorts";
      case "shows":
        return "tv";
      case "movies":
        return "movie";
      default:
        return target.mediaType === "tv" ? "tv" : "movie";
    }
  };

  const handleSearch = async () => {
    if (!item) return;

    setIsSearching(true);
    try {
      // Extract title from item or videoPath
      const firstEpisodePath = item.tv?.episodeList?.find((episode) => episode.path?.trim())?.path;
      const firstEpisodeStem = firstEpisodePath
        ?.split(/[\\/]+/)
        .pop()
        ?.replace(/\.[^.]+$/, "");
      const searchFilter = searchFilterForItem(item);
      const searchQuery = searchFilter === "hentai"
        ? (item.title || firstEpisodeStem || item.videoPath?.split("\\").pop()?.split(".")[0] || "")
        : (item.title || item.videoPath?.split("\\").pop()?.split(".")[0] || "");
      if (!searchQuery.trim()) {
        toast.error("Cannot determine search query from item");
        return;
      }

      debugLog(`metadata auto-fetch search query="${searchQuery}" filter=${searchFilter} libraryKind=${item.libraryKind} mediaType=${item.mediaType}`).catch(() => {});
      const results = await metadataSearch(searchQuery, searchFilter);
      debugLog(`metadata auto-fetch results count=${results.length} filter=${searchFilter} query="${searchQuery}"`).catch(() => {});
      
      if (!results || results.length === 0) {
        toast.info("No results found for: " + searchQuery);
        setSearchResults([]);
        return;
      }

      // Transform results to our format
      const transformed: SearchResult[] = results.map((result) => ({
        id: result.sourceId,
        sourceId: result.sourceId,
        source: result.source,
        title: result.title,
        year: result.year,
        mediaType: result.mediaType,
        posterUrl: result.posterUrl,
        overview: result.overview,
      }));

      setSearchResults(transformed);
      if (transformed.length > 0) {
        setSelectedTab(transformed[0].id);
      }
      toast.success(`Found ${transformed.length} result(s)`);
    } catch (error) {
      console.error("Search failed:", error);
      toast.error(`Search failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectResult = async (result: SearchResult) => {
    if (!item) return;

    setIsLoadingMetadata(true);
    try {
      // Fetch full metadata for the selected result
      const fullMetadata = await metadataGetDetails(result.sourceId, item.mediaType, result.source);

      if (!fullMetadata) {
        toast.error("Failed to load metadata");
        return;
      }

      // Transform to MediaItem partial
      const metadata: Partial<MediaItem> = {
        title: fullMetadata.title || item.title,
        overview: fullMetadata.overview || item.overview,
        year: fullMetadata.year || item.year,
        genre: fullMetadata.genre || item.genre,
        posterUrl: fullMetadata.posterUrl || item.posterUrl,
        backdropUrl: fullMetadata.backdropUrl || item.backdropUrl,
        rating: fullMetadata.rating || item.rating,
      };

      onMetadataLoaded(metadata);
      onOpenChange(false);
      toast.success("Metadata loaded successfully");
    } catch (error) {
      console.error("Failed to load metadata:", error);
      toast.error(`Failed to load metadata: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsLoadingMetadata(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-foreground flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Auto Fetch Metadata
          </DialogTitle>
        </DialogHeader>

        {searchResults.length === 0 ? (
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              Search for metadata online using the title: <span className="font-semibold text-foreground">{item?.title}</span>
            </p>
            <Button
              onClick={handleSearch}
              disabled={isSearching || !item}
              className="w-full gradient-green text-primary-foreground font-semibold"
            >
              {isSearching ? "Searching..." : "Search Online"}
            </Button>
          </div>
        ) : (
          <Tabs value={selectedTab} onValueChange={setSelectedTab} className="w-full">
            <TabsList className="grid grid-cols-4 gap-2 h-auto p-2 bg-secondary/50">
              {searchResults.map((result) => (
                <TabsTrigger
                  key={result.id}
                  value={result.id}
                  className="text-xs truncate"
                >
                  {result.title.length > 15 ? result.title.substring(0, 15) + "..." : result.title}
                </TabsTrigger>
              ))}
            </TabsList>

            {searchResults.map((result) => (
              <TabsContent key={result.id} value={result.id} className="space-y-4 mt-4">
                <div className="space-y-3">
                  <div>
                    <h3 className="font-semibold text-foreground text-lg">{result.title}</h3>
                    <p className="text-sm text-muted-foreground">
                      {result.year && `Year: ${result.year}`} · {result.mediaType === "tv" ? "TV Show" : "Movie"}
                    </p>
                  </div>

                  {result.posterUrl && (
                    <img
                      src={result.posterUrl}
                      alt={result.title}
                      className="w-24 h-36 object-cover rounded-lg"
                    />
                  )}

                  {result.overview && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground mb-1">Overview</p>
                      <p className="text-sm text-foreground line-clamp-4">{result.overview}</p>
                    </div>
                  )}

                  <Button
                    onClick={() => handleSelectResult(result)}
                    disabled={isLoadingMetadata}
                    className="w-full gradient-green text-primary-foreground font-semibold mt-4"
                  >
                    {isLoadingMetadata ? "Loading Metadata..." : "Use This Metadata"}
                  </Button>
                </div>
              </TabsContent>
            ))}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
