import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  BarChart3,
  CalendarClock,
  Clapperboard,
  Clock3,
  Database,
  Film,
  Flame,
  HardDrive,
  Heart,
  History,
  Palette,
  PlayCircle,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Star,
  TrendingUp,
  Tv,
  X,
} from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { AppHeader } from "@/components/AppHeader";
import { AppSidebar } from "@/components/AppSidebar";
import { MediaGrid } from "@/components/MediaGrid";
import { useApp } from "@/components/AppContext";
import { Label } from "@/components/ui/label";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { SettingsPage } from "@/pages/SettingsPage";
import type { MediaItem } from "@/lib/store";

const TAB_COPY: Record<string, { title: string; description: string }> = {
  home: {
    title: "Home",
    description: "A live dashboard for recent activity, discovery, library growth, and viewing habits.",
  },
  movies: {
    title: "Movies",
    description: "Browse feature films without dashboard analytics in the way.",
  },
  shows: {
    title: "TV Shows",
    description: "Browse series folders discovered under the Shows root.",
  },
  anime: {
    title: "Anime",
    description: "Anime films and series discovered under the Anime root.",
  },
  cartoon: {
    title: "Cartoon",
    description: "Cartoon films and series discovered under the Cartoon root.",
  },
  hentai: {
    title: "Hentai",
    description: "Adult anime from the Hentai root. Items here are always marked 18+.",
  },
  "movie-shorts": {
    title: "Movie Shorts",
    description: "Short films and compact videos discovered under the Movie Shorts root.",
  },
  favorites: {
    title: "Favorites",
    description: "The small list you actually want to revisit.",
  },
  bookmarks: {
    title: "Bookmarks",
    description: "Titles you flagged but have not committed to yet.",
  },
  history: {
    title: "History",
    description: "Recent playback starts across your library.",
  },
  playlists: {
    title: "Playlists",
    description: "Manual collections for mood, genre, or anything else.",
  },
  categories: {
    title: "Categories",
    description: "Custom labels used to organize the library your way.",
  },
  settings: {
    title: "Settings",
    description: "Configure library paths and application preferences.",
  },
};

const GRID_TABS = new Set(["movies", "shows", "anime", "cartoon", "hentai", "movie-shorts", "favorites", "bookmarks", "history"]);
const AVAILABLE_TABS = new Set([...Object.keys(TAB_COPY), "movies"]);
const GRID_EMPTY_MESSAGES: Record<string, string> = {
  movies: "No movies match the current filters.",
  shows: "No shows match the current filters.",
  anime: "No anime titles match the current filters.",
  cartoon: "No cartoon titles match the current filters.",
  hentai: "No hentai titles match the current filters.",
  "movie-shorts": "No movie shorts match the current filters.",
  favorites: "Nothing is marked as a favorite yet.",
  bookmarks: "No bookmarked titles in this view.",
  history: "No watch history yet.",
};
const PAGE_SIZE = 20;

function buildPaginationTokens(currentPage: number, totalPages: number) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const tokens: Array<number | "ellipsis-start" | "ellipsis-end"> = [1];
  const windowStart = Math.max(2, currentPage - 1);
  const windowEnd = Math.min(totalPages - 1, currentPage + 1);

  if (windowStart > 2) tokens.push("ellipsis-start");
  for (let page = windowStart; page <= windowEnd; page += 1) {
    tokens.push(page);
  }
  if (windowEnd < totalPages - 1) tokens.push("ellipsis-end");
  tokens.push(totalPages);

  return tokens;
}

function normalizeTab(value: string | null): string {
  if (!value || value === "dashboard") return "home";
  if (value === "tvshows") return "shows";
  if (value === "shorts" || value === "movieShorts") return "movie-shorts";
  return value && AVAILABLE_TABS.has(value) ? value : "home";
}

const Index = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    state, getFilteredItems, getItemsByLibraryKind, addPlaylist, removePlaylist,
    addCategory, removeCategory,
  } = useApp();
  const [searchQuery, setSearchQuery] = useState("");
  const [showAdvSearch, setShowAdvSearch] = useState(false);
  const [genreFilter, setGenreFilter] = useState("");
  const [yearFilter, setYearFilter] = useState("");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [newCatName, setNewCatName] = useState("");
  const [newCatColor, setNewCatColor] = useState("#22c55e");
  const [showPlaylistDialog, setShowPlaylistDialog] = useState(false);
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const activeTab = normalizeTab(searchParams.get("tab"));

  const handleTabChange = useCallback((tab: string) => {
    if (tab === "add") {
      navigate("/add");
      return;
    }
    const nextParams = new URLSearchParams(searchParams);
    if (tab === "home") {
      nextParams.delete("tab");
    } else {
      nextParams.set("tab", tab);
    }
    setSearchParams(nextParams);
  }, [navigate, searchParams, setSearchParams]);

  const filterItems = useCallback((items: MediaItem[]) =>
    items.filter((item) => {
      if (searchQuery && !item.title.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
      if (genreFilter && !item.genre.some((g) => g.toLowerCase().includes(genreFilter.toLowerCase()))) {
        return false;
      }
      if (yearFilter && item.year !== yearFilter) return false;
      return true;
    }),
  [genreFilter, searchQuery, yearFilter]);

  const movies = useMemo(() => filterItems(getItemsByLibraryKind("movies")), [filterItems, getItemsByLibraryKind]);
  const shows = useMemo(() => filterItems(getItemsByLibraryKind("shows")), [filterItems, getItemsByLibraryKind]);
  const animeItems = useMemo(() => filterItems(getItemsByLibraryKind("anime")), [filterItems, getItemsByLibraryKind]);
  const cartoonItems = useMemo(() => filterItems(getItemsByLibraryKind("cartoon")), [filterItems, getItemsByLibraryKind]);
  const hentaiItems = useMemo(() => filterItems(getItemsByLibraryKind("hentai")), [filterItems, getItemsByLibraryKind]);
  const movieShorts = useMemo(() => filterItems(getItemsByLibraryKind("movieShorts")), [filterItems, getItemsByLibraryKind]);
  const favorites = useMemo(
    () => filterItems(getFilteredItems().filter((item) => item.isFavorite)),
    [filterItems, getFilteredItems]
  );
  const bookmarks = useMemo(
    () => filterItems(getFilteredItems().filter((item) => item.isBookmarked)),
    [filterItems, getFilteredItems]
  );
  const historyItems = useMemo(
    () =>
      filterItems(
        state.history
          .map((id) => state.items.find((item) => item.id === id))
          .filter(Boolean) as MediaItem[]
      ),
    [filterItems, state.history, state.items]
  );
  const categoryCards = useMemo(
    () => state.categories.map((category) => ({
      category,
      items: state.items.filter((item) =>
        item.categoryIds.includes(category.id)
      ),
    })),
    [state.categories, state.items],
  );

  const isGridTab = GRID_TABS.has(activeTab);
  const currentGridItems = useMemo(() => {
    switch (activeTab) {
      case "movies":
        return movies;
      case "shows":
        return shows;
      case "anime":
        return animeItems;
      case "cartoon":
        return cartoonItems;
      case "hentai":
        return hentaiItems;
      case "movie-shorts":
        return movieShorts;
      case "favorites":
        return favorites;
      case "bookmarks":
        return bookmarks;
      case "history":
        return historyItems;
      default:
        return [];
    }
  }, [activeTab, animeItems, bookmarks, cartoonItems, favorites, hentaiItems, historyItems, movieShorts, movies, shows]);
  const pageSizeValue = PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(currentGridItems.length / pageSizeValue));
  const pageStart = currentGridItems.length === 0 ? 0 : (currentPage - 1) * pageSizeValue + 1;
  const pageEnd = currentGridItems.length === 0 ? 0 : Math.min(currentPage * pageSizeValue, currentGridItems.length);
  const paginatedGridItems = useMemo(
    () => currentGridItems.slice(pageStart > 0 ? pageStart - 1 : 0, pageEnd),
    [currentGridItems, pageEnd, pageStart]
  );
  const paginationTokens = useMemo(
    () => buildPaginationTokens(currentPage, totalPages),
    [currentPage, totalPages]
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, searchQuery, genreFilter, yearFilter]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [currentPage]);

  const currentCopy = TAB_COPY[activeTab] ?? {
    title: "Library",
    description: "Browse and organize what you already added.",
  };

  const recentlyWatched = useMemo(
    () =>
      [...state.items]
        .filter((item) => Number.isFinite(item.lastWatched))
        .sort((a, b) => (b.lastWatched ?? 0) - (a.lastWatched ?? 0))
        .slice(0, 6),
    [state.items],
  );
  const recentlyAdded = useMemo(
    () => [...state.items].sort((a, b) => b.addedAt - a.addedAt).slice(0, 6),
    [state.items],
  );
  const continueWatching = useMemo(
    () => recentlyWatched.length > 0 ? recentlyWatched : historyItems.slice(0, 6),
    [historyItems, recentlyWatched],
  );
  const recentImports = useMemo(
    () => recentlyAdded.filter((item) => Date.now() - item.addedAt < 30 * 24 * 60 * 60 * 1000),
    [recentlyAdded],
  );
  const favoriteGenres = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of state.items) {
      for (const genre of item.genre) {
        counts.set(genre, (counts.get(genre) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [state.items]);
  const mostWatchedCategories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const itemId of state.history) {
      const item = state.items.find((entry) => entry.id === itemId);
      if (!item) continue;
      const label = item.libraryKind === "movieShorts" ? "Shorts" : item.libraryKind;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [state.history, state.items]);
  const categoryTotals = [
    { label: "Movies", value: movies.length, icon: Film, color: "bg-sky-300" },
    { label: "TV Shows", value: shows.length, icon: Tv, color: "bg-amber-300" },
    { label: "Anime", value: animeItems.length, icon: Sparkles, color: "bg-fuchsia-300" },
    { label: "Cartoon", value: cartoonItems.length, icon: Palette, color: "bg-cyan-300" },
    { label: "Hent", value: hentaiItems.length, icon: Flame, color: "bg-rose-300" },
    { label: "Shorts", value: movieShorts.length, icon: Clapperboard, color: "bg-indigo-300" },
  ];
  const maxCategoryTotal = Math.max(1, ...categoryTotals.map((entry) => entry.value));
  const totalRuntimeMinutes = state.items.reduce((sum, item) => sum + (item.durationMinutes ?? 0), 0);
  const weeklyActivity = Math.min(state.history.length, 7);
  const monthlyActivity = Math.min(state.history.length, 30);
  const storageEstimateGb = Math.max(0.1, state.items.length * 1.8 + totalRuntimeMinutes * 0.012);

  const renderEmptyLibraryState = () => (
    <div className="rounded-[28px] border border-dashed border-border/70 bg-card/35 px-8 py-14">
      <div className="max-w-2xl">
        <div className="text-[11px] uppercase tracking-[0.28em] text-primary/70">Start here</div>
        <h3 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
          Build the library before you worry about metadata APIs.
        </h3>
        <p className="mt-4 text-sm leading-7 text-muted-foreground">
          Right now the app has no titles. Add a movie or show first, then map files from the detail screen.
          That makes the upcoming API pass much easier to wire into a real workflow.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button className="gradient-green text-primary-foreground font-semibold" onClick={() => navigate("/add")}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add Your First Title
          </Button>
          <Button variant="outline" className="border-border text-muted-foreground" onClick={() => setShowAdvSearch(true)}>
            <SlidersHorizontal className="mr-1.5 h-4 w-4" />
            Preview Filters
          </Button>
        </div>
      </div>
    </div>
  );

  const renderDashboard = () => {
    const dashboardStats = [
      { label: "Continue Watching", value: continueWatching.length, note: "Titles with recent activity", icon: PlayCircle },
      { label: "Recently Added", value: recentlyAdded.length, note: "Newest local entries", icon: CalendarClock },
      { label: "Viewing History", value: state.history.length, note: "Tracked playback starts", icon: History },
      { label: "Favorites", value: favorites.length, note: "Pinned picks", icon: Heart },
      { label: "Library Growth", value: state.items.length, note: "Total catalog entries", icon: Database },
      { label: "Storage Usage", value: `${storageEstimateGb.toFixed(1)} GB`, note: "Estimated from local runtime", icon: HardDrive },
    ];

    return (
      <div className="space-y-6">
        <section className="overflow-hidden rounded-[24px] border border-white/8 bg-[linear-gradient(135deg,rgba(8,12,18,0.98),rgba(12,26,24,0.94),rgba(26,18,8,0.9))] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-emerald-200/72">
                <SidebarTrigger className="h-6 w-6" />
                <span>Dashboard</span>
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">CineVault Home</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/62">
                Recent playback, discovery cues, growth, and viewing patterns stay here so library shelves can stay focused.
              </p>
            </div>
            <Button className="h-10 rounded-xl bg-[linear-gradient(135deg,#8bf3cb,#f2c14e)] px-4 font-semibold text-[#101813] hover:brightness-105" onClick={() => navigate("/add")}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add Title
            </Button>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            {dashboardStats.map((stat) => {
              const Icon = stat.icon;
              return (
                <div key={stat.label} className="rounded-xl border border-white/10 bg-white/[0.055] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/48">{stat.label}</div>
                    <Icon className="h-4 w-4 text-white/66" />
                  </div>
                  <div className="mt-3 text-2xl font-semibold text-white">{stat.value}</div>
                  <div className="mt-1 text-xs text-white/48">{stat.note}</div>
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Continue Watching</h2>
              <p className="text-sm text-muted-foreground">Resume titles that were recently opened.</p>
            </div>
            <Button variant="outline" size="sm" className="rounded-xl border-border text-muted-foreground" onClick={() => handleTabChange("history")}>
              View History
            </Button>
          </div>
          <MediaGrid items={continueWatching} emptyMessage="No playback history yet." />
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Recently Added</h2>
                <p className="text-sm text-muted-foreground">The latest local entries and imports.</p>
              </div>
              <Badge variant="secondary" className="rounded-lg">{recentImports.length} new this month</Badge>
            </div>
            <MediaGrid items={recentlyAdded} emptyMessage="No media has been added yet." />
          </section>

          <section className="space-y-4">
            <div className="rounded-[20px] border border-border/60 bg-card/55 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-foreground">Viewing Activity</h2>
                  <p className="mt-1 text-sm text-muted-foreground">Weekly and monthly playback starts.</p>
                </div>
                <BarChart3 className="h-5 w-5 text-primary" />
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border/60 bg-background/40 p-3">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">This week</div>
                  <div className="mt-2 text-2xl font-semibold">{weeklyActivity}</div>
                </div>
                <div className="rounded-xl border border-border/60 bg-background/40 p-3">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">This month</div>
                  <div className="mt-2 text-2xl font-semibold">{monthlyActivity}</div>
                </div>
              </div>
            </div>

            <div className="rounded-[20px] border border-border/60 bg-card/55 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-foreground">Library Mix</h2>
                <TrendingUp className="h-5 w-5 text-amber-300" />
              </div>
              <div className="mt-4 space-y-3">
                {categoryTotals.map((entry) => {
                  const Icon = entry.icon;
                  return (
                    <div key={entry.label}>
                      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-2"><Icon className="h-3.5 w-3.5" />{entry.label}</span>
                        <span>{entry.value}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-secondary">
                        <div className={`h-full ${entry.color}`} style={{ width: `${Math.max(4, (entry.value / maxCategoryTotal) * 100)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <section className="rounded-[20px] border border-border/60 bg-card/55 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">Favorite Genres</h2>
              <Star className="h-5 w-5 text-fuchsia-300" />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {favoriteGenres.length === 0 ? (
                <p className="text-sm text-muted-foreground">Genre metadata will appear here after imports are enriched.</p>
              ) : favoriteGenres.map(([genre, count]) => (
                <Badge key={genre} variant="secondary" className="rounded-lg">{genre} - {count}</Badge>
              ))}
            </div>
          </section>

          <section className="rounded-[20px] border border-border/60 bg-card/55 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">Most Watched Categories</h2>
              <Clock3 className="h-5 w-5 text-cyan-300" />
            </div>
            <div className="mt-4 space-y-2">
              {mostWatchedCategories.length === 0 ? (
                <p className="text-sm text-muted-foreground">Watch categories populate once titles are played.</p>
              ) : mostWatchedCategories.map(([category, count]) => (
                <div key={category} className="flex items-center justify-between rounded-xl bg-background/40 px-3 py-2 text-sm">
                  <span className="capitalize">{category}</span>
                  <span className="text-muted-foreground">{count}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-[20px] border border-border/60 bg-card/55 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">Discovery Widgets</h2>
              <Sparkles className="h-5 w-5 text-emerald-300" />
            </div>
            <div className="mt-4 space-y-2 text-sm text-muted-foreground">
              <p>{favorites[0]?.title ? `Recommended from favorites: ${favorites[0].title}` : "Mark favorites to seed recommendations."}</p>
              <p>{recentlyAdded[0]?.title ? `Trending locally: ${recentlyAdded[0].title}` : "Recently added titles will surface here."}</p>
              <p>{recentImports[0]?.title ? `Recently imported: ${recentImports[0].title}` : "New imports from the last month will appear here."}</p>
            </div>
          </section>
        </div>
      </div>
    );
  };

  const renderContent = () => {
    if (activeTab === "home") {
      return renderDashboard();
    }

    if (state.items.length === 0 && (activeTab === "movies" || activeTab === "shows" || activeTab === "anime" || activeTab === "cartoon" || activeTab === "hentai" || activeTab === "movie-shorts")) {
      return renderEmptyLibraryState();
    }

    switch (activeTab) {
      case "movies":
      case "shows":
      case "anime":
      case "cartoon":
      case "hentai":
      case "movie-shorts":
      case "favorites":
      case "bookmarks":
      case "history":
        return <MediaGrid items={paginatedGridItems} emptyMessage={GRID_EMPTY_MESSAGES[activeTab]} />;
      case "playlists":
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">Your Playlists</h2>
              <Button size="sm" variant="outline" onClick={() => setShowPlaylistDialog(true)}
                className="border-border text-muted-foreground hover:text-foreground">
                <Plus className="mr-1 h-4 w-4" /> New Playlist
              </Button>
            </div>
            {state.playlists.map((playlist) => {
              const items = playlist.itemIds
                .map((id) => state.items.find((item) => item.id === id))
                .filter(Boolean) as typeof state.items;
              return (
                <div key={playlist.id} className="glass-card rounded-[24px] border border-border/60 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="font-semibold text-foreground">{playlist.name}</h3>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">{items.length} items</Badge>
                      <Button size="sm" variant="ghost" onClick={() => removePlaylist(playlist.id)}
                        className="h-7 px-2 text-destructive hover:text-destructive">
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  {items.length > 0 ? <MediaGrid items={items} /> : <p className="text-sm text-muted-foreground">No items in this playlist.</p>}
                </div>
              );
            })}
          </div>
        );
      case "categories":
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">Categories</h2>
              <Button size="sm" variant="outline" onClick={() => setShowCategoryDialog(true)}
                className="border-border text-muted-foreground hover:text-foreground">
                <Plus className="mr-1 h-4 w-4" /> New Category
              </Button>
            </div>
            {categoryCards.length === 0 ? (
              <div className="rounded-[22px] border border-dashed border-border/70 bg-card/35 px-6 py-10 text-sm text-muted-foreground">
                Create a category first, then assign it from the item Manage tab.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {categoryCards.map(({ category, items }) => (
                  <div key={category.id} className="glass-card rounded-[22px] border border-border/60 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: category.color }} />
                        <span className="truncate text-sm font-medium text-foreground">{category.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-xs">{items.length} titles</Badge>
                        <Button size="sm" variant="ghost" onClick={() => removeCategory(category.id)}
                          className="h-7 px-2 text-destructive hover:text-destructive">
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    <p className="mt-3 text-xs leading-6 text-muted-foreground">
                      {items.length > 0
                        ? items.slice(0, 3).map((item) => item.title).join(", ")
                        : "No titles assigned yet."}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      case "settings":
        return <SettingsPage />;
      default:
        return null;
    }
  };

  const renderPaginationControls = () => {
    if (!isGridTab || currentGridItems.length === 0 || totalPages <= 1) {
      return null;
    }

    return (
      <div className="mb-5 rounded-[22px] border border-border/60 bg-card/75 p-4 shadow-[0_18px_48px_rgba(15,23,42,0.08)]">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-primary/70">Shelf pagination</div>
            <p className="mt-2 text-sm text-muted-foreground">
              Showing {pageStart}-{pageEnd} of {currentGridItems.length} titles. Fixed at {pageSizeValue} per page.
            </p>
          </div>

          <Pagination className="mx-0 w-auto justify-start xl:justify-end">
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    setCurrentPage((page) => Math.max(1, page - 1));
                  }}
                  aria-disabled={currentPage === 1}
                  className={currentPage === 1 ? "pointer-events-none opacity-45" : ""}
                />
              </PaginationItem>
              {paginationTokens.map((token) => (
                <PaginationItem key={String(token)}>
                  {typeof token === "number" ? (
                    <PaginationLink
                      href="#"
                      isActive={token === currentPage}
                      onClick={(event) => {
                        event.preventDefault();
                        setCurrentPage(token);
                      }}
                    >
                      {token}
                    </PaginationLink>
                  ) : (
                    <PaginationEllipsis />
                  )}
                </PaginationItem>
              ))}
              <PaginationItem>
                <PaginationNext
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    setCurrentPage((page) => Math.min(totalPages, page + 1));
                  }}
                  aria-disabled={currentPage === totalPages}
                  className={currentPage === totalPages ? "pointer-events-none opacity-45" : ""}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      </div>
    );
  };

  return (
    <SidebarProvider defaultOpen={false}>
      <AppSidebar activeTab={activeTab} onTabChange={handleTabChange} />
      <div className="flex min-h-screen w-full bg-background">
        <div className="flex flex-1 flex-col">
          <AppHeader searchQuery={searchQuery} onSearchChange={setSearchQuery} />
          <main className="container mx-auto flex-1 px-4 py-6">
            {activeTab !== "home" && (
              <div className="mb-5 rounded-[20px] border border-border/60 bg-card/55 p-4 shadow-[0_18px_42px_rgba(0,0,0,0.10)]">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.26em] text-primary/72">
                      <SidebarTrigger className="h-6 w-6" />
                      <span>Browse</span>
                    </div>
                    <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{currentCopy.title}</h1>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                      {currentCopy.description}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {isGridTab && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowAdvSearch(!showAdvSearch)}
                        className="h-9 rounded-xl border-border px-3 text-muted-foreground hover:text-foreground"
                      >
                        <SlidersHorizontal className="mr-1 h-4 w-4" />
                        {showAdvSearch ? "Hide Filters" : "Filters"}
                      </Button>
                    )}
                    <Button className="h-9 rounded-xl bg-[linear-gradient(135deg,#8bf3cb,#f2c14e)] px-4 font-semibold text-[#122018] shadow-[0_12px_28px_rgba(132,204,22,0.16)] hover:brightness-105" onClick={() => navigate("/add")}>
                      <Plus className="mr-1.5 h-4 w-4" />
                      Add Title
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {renderPaginationControls()}

            {activeTab !== "home" && showAdvSearch && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="glass-card mb-6 rounded-[24px] border border-border/60 p-4"
              >
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Advanced Filters</h3>
                  <Button variant="ghost" size="icon" onClick={() => { setGenreFilter(""); setYearFilter(""); setShowAdvSearch(false); }}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">Genre</Label>
                    <Input
                      placeholder="e.g. Action"
                      value={genreFilter}
                      onChange={(e) => setGenreFilter(e.target.value)}
                      className="h-8 border-border bg-secondary text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Year</Label>
                    <Input
                      placeholder="e.g. 2024"
                      value={yearFilter}
                      onChange={(e) => setYearFilter(e.target.value)}
                      className="h-8 border-border bg-secondary text-sm"
                    />
                  </div>
                  <div className="flex items-end">
                    <Button variant="outline" size="sm" onClick={() => { setGenreFilter(""); setYearFilter(""); }}
                      className="border-border text-muted-foreground">
                      Clear Filters
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}

            {renderContent()}
          </main>
        </div>
      </div>

      <Dialog open={showPlaylistDialog} onOpenChange={setShowPlaylistDialog}>
        <DialogContent className="bg-card border-border">
          <DialogHeader><DialogTitle className="text-foreground">Create Playlist</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input placeholder="Playlist name" value={newPlaylistName} onChange={(e) => setNewPlaylistName(e.target.value)}
              className="bg-secondary border-border" />
            <Button className="w-full gradient-green text-primary-foreground font-semibold" onClick={() => {
              if (newPlaylistName.trim()) {
                addPlaylist(newPlaylistName.trim());
                setNewPlaylistName("");
                setShowPlaylistDialog(false);
              }
            }}>Create</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showCategoryDialog} onOpenChange={setShowCategoryDialog}>
        <DialogContent className="bg-card border-border">
          <DialogHeader><DialogTitle className="text-foreground">Add Category</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input placeholder="Category name" value={newCatName} onChange={(e) => setNewCatName(e.target.value)}
              className="bg-secondary border-border" />
            <div>
              <Label className="text-xs text-muted-foreground">Color</Label>
              <input type="color" value={newCatColor} onChange={(e) => setNewCatColor(e.target.value)} className="h-10 w-full cursor-pointer rounded" />
            </div>
            <Button className="w-full gradient-green text-primary-foreground font-semibold" onClick={() => {
              if (newCatName.trim()) {
                addCategory(newCatName.trim(), newCatColor);
                setNewCatName("");
                setShowCategoryDialog(false);
              }
            }}>Add Category</Button>
          </div>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
};

export default Index;
