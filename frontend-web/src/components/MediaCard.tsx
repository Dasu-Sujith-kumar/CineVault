import type { KeyboardEvent, MouseEvent } from "react";
import { MoreHorizontal, Play, Trash2, Tv, Video } from "lucide-react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { MediaItem } from "@/lib/store";
import { isTauriRuntime, openPlayerWindow } from "@/lib/desktop-player";
import { toImageSrc } from "@/lib/image-src";
import { useApp } from "@/components/AppContext";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";

interface MediaCardProps {
  item: MediaItem;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDuration(minutes?: number): string {
  if (!Number.isFinite(minutes) || !minutes || minutes <= 0) return "Runtime pending";
  const totalMinutes = Math.round(minutes);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(mins).padStart(2, "0")}m` : `${mins}m`;
}

function libraryKindLabel(kind: MediaItem["libraryKind"]): string {
  switch (kind) {
    case "shows":
      return "Shows";
    case "anime":
      return "Anime";
    case "cartoon":
      return "Cartoon";
    case "hentai":
      return "Hentai";
    case "movieShorts":
      return "Short";
    case "others":
      return "Other";
    case "movies":
    default:
      return "Movie";
  }
}

export function MediaCard({ item }: MediaCardProps) {
  const navigate = useNavigate();
  const { addToHistory, removeItem } = useApp();

  const openDetails = () => {
    navigate(`/item/${item.id}`);
  };

  const onCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetails();
    }
  };

  const onQuickPlay = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    if (!isTauriRuntime()) {
      toast.error("Playback is available in the desktop app");
      return;
    }

    const playPath =
      item.mediaType === "movie"
        ? (item.videoPath ?? "").trim()
        : (
            item.tv?.selectedEpisodePath
            ?? item.tv?.episodeList?.find((episode) => Boolean(episode.path?.trim()))?.path
            ?? ""
          ).trim();

    if (!playPath) {
      toast.error(
        item.mediaType === "movie"
          ? "Set a video path in the Manage tab first"
          : "Scan the TV folder in the Manage tab first",
      );
      return;
    }

    addToHistory(item.id);
    openPlayerWindow(playPath, null, item.title)
      .then(() => toast("Opening player..."))
      .catch((err) => {
        toast.error(errorMessage(err, "Failed to start player"));
      });
  };

  const onRemoveItem = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const confirmed = window.confirm(`Remove "${item.title}" from your library?`);
    if (!confirmed) return;

    removeItem(item.id);
    toast.success("Item removed");
  };

  const thumbnail = toImageSrc(item.posterUrl || item.backdropUrl);
  const playbackReady = item.mediaType === "movie"
    ? Boolean(item.videoPath?.trim())
    : Boolean(
        item.tv?.selectedEpisodePath?.trim()
        || item.tv?.episodeList?.find((episode) => Boolean(episode.path?.trim()))?.path?.trim(),
      );
  const metadataParts = [
    item.mediaType === "movie" ? "Movie" : "TV Show",
    item.year || "Year unknown",
    formatDuration(item.durationMinutes),
  ];

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      role="link"
      tabIndex={0}
      onClick={openDetails}
      onKeyDown={onCardKeyDown}
      className="group relative w-full max-w-[170px] cursor-pointer rounded-[22px] outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <div className="rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(5,7,11,0.96),rgba(8,10,14,0.98))] p-2 shadow-[0_16px_30px_rgba(0,0,0,0.2)] transition-all duration-300 group-hover:-translate-y-1 group-hover:border-white/14 group-hover:shadow-[0_22px_42px_rgba(0,0,0,0.26)]">
        {/* CARD CONTRAST FIX START */}
        <div className="relative overflow-hidden rounded-[16px] bg-secondary">
          <div className="aspect-[2/3]">
            <img
              src={thumbnail}
              alt={item.title}
              className="h-full w-full object-cover brightness-[0.84] contrast-[1.06] saturate-[0.96] transition-transform duration-500 group-hover:scale-[1.035]"
              loading="lazy"
            />
          </div>
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.02),rgba(4,6,10,0.16)_72%,rgba(4,6,10,0.32)_100%)]" />
          <div className="absolute inset-x-0 top-0 h-[36%] bg-[linear-gradient(180deg,rgba(3,6,10,0.86),rgba(3,6,10,0.46),transparent)]" />
          <div className="absolute inset-x-0 bottom-0 h-[42%] bg-[linear-gradient(0deg,rgba(3,6,10,0.94),rgba(3,6,10,0.58),transparent)]" />

          <div className="absolute inset-x-0 top-0 flex items-center justify-between p-2">
            <div className="flex items-center gap-1 rounded-full border border-white/14 bg-black/55 px-2 py-1 text-[8px] uppercase tracking-[0.18em] text-white/90 shadow-[0_8px_18px_rgba(0,0,0,0.28)] backdrop-blur-lg [text-shadow:0_1px_4px_rgba(0,0,0,0.9)]">
              {item.mediaType === "movie" ? <Video className="h-2 w-2" /> : <Tv className="h-2 w-2" />}
              <span>{item.mediaType === "movie" ? "Movie" : "Series"}</span>
            </div>
            <div className="flex items-center gap-1">
              {item.contentRating === "adult" ? (
                <div className="flex h-6 items-center rounded-full border border-red-300/30 bg-red-600/80 px-2 text-[9px] font-bold text-white shadow-[0_8px_18px_rgba(0,0,0,0.28)] backdrop-blur-lg">
                  +18
                </div>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onRemoveItem}
                className="h-6 w-6 rounded-full border border-white/14 bg-black/55 text-white/82 opacity-0 shadow-[0_8px_18px_rgba(0,0,0,0.28)] backdrop-blur-lg hover:bg-destructive hover:text-destructive-foreground group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={`Remove ${item.title}`}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
              <div className="flex h-6 min-w-6 items-center justify-center rounded-full border border-white/14 bg-black/55 px-1.5 shadow-[0_8px_18px_rgba(0,0,0,0.28)] backdrop-blur-lg">
                <span
                  className={`h-2.5 w-2.5 rounded-full shadow-[0_0_16px_currentColor] ${
                    playbackReady ? "bg-emerald-300 text-emerald-300" : "bg-amber-300 text-amber-300"
                  }`}
                  aria-hidden="true"
                />
              </div>
            </div>
          </div>

          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
            <div className="rounded-full border border-white/14 bg-black/58 px-2 py-1 text-[9px] text-white/90 shadow-[0_10px_20px_rgba(0,0,0,0.3)] backdrop-blur-lg [text-shadow:0_1px_4px_rgba(0,0,0,0.9)]">
              {playbackReady ? "Playback ready" : "Attach file path"}
            </div>
            <Button
              size="icon"
              onClick={onQuickPlay}
              className="h-7 w-7 rounded-full border border-white/30 bg-white/95 text-[#10181f] shadow-[0_12px_22px_rgba(0,0,0,0.34)] hover:bg-white"
              aria-label={`Play ${item.title}`}
            >
              <Play className="h-3 w-3" fill="currentColor" />
            </Button>
          </div>
        </div>
        {/* CARD CONTRAST FIX END */}

        <div className="mt-2.5 flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-[0.9rem] font-semibold leading-[1.14] tracking-tight text-white">
              {item.title}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-white/54">
              <span className="text-white/72">{libraryKindLabel(item.libraryKind)}</span>
              {metadataParts.map((part, index) => (
                <span key={`${item.id}-${part}-${index}`} className="flex items-center gap-1.5">
                  <span className="h-1 w-1 rounded-full bg-white/24" aria-hidden="true" />
                  <span>{part}</span>
                </span>
              ))}
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              openDetails();
            }}
            className="mt-0.5 h-7 w-7 shrink-0 rounded-full text-white/54 hover:bg-white/[0.06] hover:text-white"
            aria-label={`Open ${item.title}`}
          >
            <MoreHorizontal className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </motion.article>
  );
}
