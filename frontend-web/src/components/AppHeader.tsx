import { Search, Film } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useApp } from "@/components/AppContext";

interface AppHeaderProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
}

export function AppHeader({ searchQuery, onSearchChange }: AppHeaderProps) {
  const { state } = useApp();

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-xl">
      <div className="container mx-auto flex items-center gap-4 px-4 py-3">
        <div className="flex shrink-0 items-center gap-2">
          <Film className="h-7 w-7 text-primary" />
          <h1 className="hidden text-xl font-bold text-gradient-green sm:block">
            CineVault
          </h1>
        </div>

        <div className="relative max-w-xl flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search your library..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-10 border-border bg-secondary pl-9"
          />
        </div>
      </div>
    </header>
  );
}
