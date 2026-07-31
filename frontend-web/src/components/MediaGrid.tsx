import { Film } from "lucide-react";
import { MediaItem } from "@/lib/store";
import { MediaCard } from "@/components/MediaCard";

interface MediaGridProps {
  items: MediaItem[];
  emptyMessage?: string;
}

export function MediaGrid({ items, emptyMessage = "No items found" }: MediaGridProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-[20px] border border-dashed border-border/70 bg-card/35 px-6 py-20 text-center text-muted-foreground">
        <Film className="mb-4 h-12 w-12 opacity-30" />
        <p className="text-base font-medium text-foreground/88">{emptyMessage}</p>
        <p className="mt-2 max-w-md text-sm leading-6">
          Add a title, adjust your filters, or switch sections to keep building the library.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-4 justify-items-start">
      {items.map((item) => (
        <MediaCard key={item.id} item={item} />
      ))}
    </div>
  );
}
