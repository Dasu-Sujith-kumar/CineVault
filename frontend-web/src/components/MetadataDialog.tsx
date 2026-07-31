import { useState, useEffect } from "react";
import { MediaItem, ContentRating, MediaType } from "@/lib/store";
import { useApp } from "@/components/AppContext";
import { desktopPickFolder, desktopPickVideoFile, isTauriRuntime } from "@/lib/desktop-player";
import { toast } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface MetadataDialogProps {
  item: MediaItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function MetadataDialog({ item, open, onOpenChange }: MetadataDialogProps) {
  const { updateItem } = useApp();
  const isDesktop = isTauriRuntime();
  const [form, setForm] = useState({
    title: "",
    overview: "",
    year: "",
    rating: 0,
    genre: "",
    posterUrl: "",
    backdropUrl: "",
    contentRating: "regular" as ContentRating,
    mediaType: "movie" as MediaType,
    videoPath: "",
    tvRootPath: "",
  });

  useEffect(() => {
    if (item) {
      setForm({
        title: item.title,
        overview: item.overview,
        year: item.year,
        rating: item.rating,
        genre: item.genre.join(", "),
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        contentRating: item.contentRating,
        mediaType: item.mediaType,
        videoPath: item.videoPath ?? "",
        tvRootPath: item.tv?.rootPath ?? "",
      });
    }
  }, [item]);

  const handleSave = () => {
    if (!item) return;
    const updates: Partial<MediaItem> = {
      title: form.title,
      overview: form.overview,
      year: form.year,
      rating: form.rating,
      genre: form.genre.split(",").map((g) => g.trim()).filter(Boolean),
      posterUrl: form.posterUrl,
      backdropUrl: form.backdropUrl,
      contentRating: form.contentRating,
      mediaType: form.mediaType,
    };

    if (form.mediaType === "movie") {
      updates.videoPath = form.videoPath.trim() || undefined;
      updates.tv = undefined;
    } else {
      updates.videoPath = undefined;
      updates.tv = {
        ...(item.tv ?? {}),
        rootPath: form.tvRootPath.trim() || undefined,
      };
    }

    updateItem(item.id, updates);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-foreground">Edit Metadata</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-muted-foreground">Title</Label>
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="bg-secondary border-border"
            />
          </div>
          <div>
            <Label className="text-muted-foreground">Overview</Label>
            <Textarea
              value={form.overview}
              onChange={(e) => setForm({ ...form, overview: e.target.value })}
              className="bg-secondary border-border"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="text-muted-foreground">Poster Image URL</Label>
              <Input
                value={form.posterUrl}
                onChange={(e) => setForm({ ...form, posterUrl: e.target.value })}
                className="bg-secondary border-border"
                placeholder="https://..."
              />
            </div>
            <div>
              <Label className="text-muted-foreground">Backdrop Image URL</Label>
              <Input
                value={form.backdropUrl}
                onChange={(e) => setForm({ ...form, backdropUrl: e.target.value })}
                className="bg-secondary border-border"
                placeholder="https://..."
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-muted-foreground">Year</Label>
              <Input
                value={form.year}
                onChange={(e) => setForm({ ...form, year: e.target.value })}
                className="bg-secondary border-border"
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
                className="bg-secondary border-border"
              />
            </div>
          </div>
          <div>
            <Label className="text-muted-foreground">Genres (comma-separated)</Label>
            <Input
              value={form.genre}
              onChange={(e) => setForm({ ...form, genre: e.target.value })}
              className="bg-secondary border-border"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-muted-foreground">Content Rating</Label>
              <Select
                value={form.contentRating}
                onValueChange={(v) => setForm({ ...form, contentRating: v as ContentRating })}
              >
                <SelectTrigger className="bg-secondary border-border">
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
                <SelectTrigger className="bg-secondary border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="movie">Movie</SelectItem>
                  <SelectItem value="tv">TV Show</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.mediaType === "movie" ? (
            <div>
              <Label className="text-muted-foreground">Video Path (Desktop)</Label>
              <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                <Input
                  value={form.videoPath}
                  onChange={(e) => setForm({ ...form, videoPath: e.target.value })}
                  className="bg-secondary border-border font-mono"
                  placeholder="D:\\Movies\\My Movie.mkv"
                />
                <Button
                  type="button"
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
            </div>
          ) : (
            <div>
              <Label className="text-muted-foreground">TV Show Root Folder (Desktop)</Label>
              <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                <Input
                  value={form.tvRootPath}
                  onChange={(e) => setForm({ ...form, tvRootPath: e.target.value })}
                  className="bg-secondary border-border font-mono"
                  placeholder="D:\\TV\\My Show"
                />
                <Button
                  type="button"
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
              </div>
            </div>
          )}
          <Button onClick={handleSave} className="w-full gradient-green text-primary-foreground font-semibold">
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
