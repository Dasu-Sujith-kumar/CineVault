import { Suspense, lazy, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppProvider } from "@/components/AppContext";

const queryClient = new QueryClient();
const Index = lazy(() => import("./pages/Index.tsx"));
const AddItemPage = lazy(() => import("./pages/AddItemPage.tsx"));
const ItemDetailPage = lazy(() => import("./pages/ItemDetailPage.tsx"));
const PlayerPage = lazy(() => import("./pages/PlayerPage.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="rounded-[28px] border border-border/60 bg-card/70 px-6 py-5 text-sm text-muted-foreground">
        Loading view...
      </div>
    </div>
  );
}

function App() {
  useEffect(() => {
    const w = window as unknown as Record<string, unknown> | undefined;
    const isTauri = Boolean(w && (w["__TAURI__"] || w["__TAURI_INTERNALS__"]));
    if (!isTauri) return;

    let canceled = false;

    void (async () => {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const win = getCurrentWebviewWindow();
        const res = await fetch("/favicon.ico");
        if (!res.ok) return;
        const bytes = await res.arrayBuffer();
        if (canceled) return;
        await win.setIcon(bytes).catch(() => {});
      } catch {
        // ignore
      }
    })();

    return () => {
      canceled = true;
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppProvider>
          <Toaster />
          <Sonner />
          <HashRouter>
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/add" element={<AddItemPage />} />
                <Route path="/item/:id" element={<ItemDetailPage />} />
                <Route path="/player" element={<PlayerPage />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </HashRouter>
        </AppProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
