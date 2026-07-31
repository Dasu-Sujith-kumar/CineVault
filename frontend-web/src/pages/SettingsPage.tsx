import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RefreshCw, FolderOpen, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/components/AppContext";
import type { LibraryDbItem } from "@/lib/store";

interface LibraryRoot {
  id: string;
  path: string;
  libraryKind: string;
  createdAt: string;
}

export function SettingsPage() {
  const { replaceLibraryItems } = useApp();
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [newPath, setNewPath] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState("");
  const [scanningRootId, setScanningRootId] = useState<string | null>(null);

  useEffect(() => {
    loadRoots();
  }, []);

  const loadRoots = async () => {
    try {
      const loadedRoots = await invoke<LibraryRoot[]>("get_library_roots");
      setRoots(loadedRoots || []);
    } catch (error) {
      console.error("Failed to load roots:", error);
      setScanMessage("Failed to load library roots");
    }
  };

  const pickFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Library Root Folder",
      });
      if (selected && typeof selected === "string") {
        setNewPath(selected);
      }
    } catch (error) {
      console.error("Failed to pick folder:", error);
    }
  };

  const addRoot = async () => {
    if (!newPath) {
      setScanMessage("Please select a path first");
      return;
    }

    try {
      await invoke("add_library_root", { path: newPath, libraryKind: "general" });
      setNewPath("");
      setScanMessage("Root path added successfully");
      await loadRoots();
      setTimeout(() => setScanMessage(""), 3000);
    } catch (error) {
      console.error("Failed to add root:", error);
      setScanMessage(`Failed to add root: ${error}`);
    }
  };

  const removeRoot = async (rootId: string) => {
    try {
      await invoke("remove_library_root", { rootId });
      const items = await invoke<LibraryDbItem[]>("get_library_items");
      replaceLibraryItems(items || []);
      setScanMessage("Root path removed successfully");
      await loadRoots();
      setTimeout(() => setScanMessage(""), 3000);
    } catch (error) {
      console.error("Failed to remove root:", error);
      setScanMessage(`Failed to remove root: ${error}`);
    }
  };

  const handleScan = async (rootPath: string, rootId?: string) => {
    if (!rootId) {
      setScanMessage("Root ID is required to scan");
      return;
    }

    setIsScanning(true);
    setScanningRootId(rootId);
    setScanMessage("Scanning library...");
    try {
      const scanResult = await invoke<string>("scan_library_root", { rootId });
      console.log("Scan result:", scanResult);
      
      // Load items from database after scan
      const items = await invoke<LibraryDbItem[]>("get_library_items");
      console.log("Items from database:", items);
      replaceLibraryItems(items || []);
      
      setScanMessage(`Library scan completed successfully (${items?.length || 0} items found)`);
    } catch (error) {
      console.error("Scan failed:", error);
      setScanMessage(`Scan failed: ${error}`);
    } finally {
      setIsScanning(false);
      setScanningRootId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground mb-6">Library Settings</h2>
      </div>

      {/* Add New Root Path Section */}
      <div className="glass-card rounded-[24px] border border-border/60 p-6 space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground mb-2">Add Library Root</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Select a folder containing your movies and TV shows. The app will scan this folder recursively for media files.
          </p>
          <div className="flex gap-2 mb-3">
            <Input
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="/path/to/media/library"
              className="flex-1 bg-background/50 border-border/60 text-foreground placeholder:text-muted-foreground/50"
            />
            <Button
              onClick={pickFolder}
              variant="outline"
              className="border-border text-muted-foreground hover:text-foreground"
            >
              <FolderOpen className="h-4 w-4 mr-2" />
              Browse
            </Button>
          </div>
          <Button
            onClick={addRoot}
            disabled={!newPath}
            className="gradient-green text-primary-foreground font-semibold"
          >
            Add Root Path
          </Button>
        </div>
      </div>

      {/* Library Roots Section */}
      <div className="glass-card rounded-[24px] border border-border/60 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-foreground">Library Roots</h3>
        {roots.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No library roots configured yet. Add one above to get started.
          </p>
        ) : (
          <div className="space-y-3">
            {roots.map((root) => (
              <div key={root.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border/40 bg-background/30">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{root.path}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Added {new Date(root.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => handleScan(root.path, root.id)}
                    disabled={isScanning}
                    size="sm"
                    variant="outline"
                    className="border-border text-muted-foreground hover:text-foreground"
                  >
                    <RefreshCw className={`h-4 w-4 ${scanningRootId === root.id ? "animate-spin" : ""}`} />
                  </Button>
                  <Button
                    onClick={() => removeRoot(root.id)}
                    disabled={isScanning}
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Scan Status */}
      {scanMessage && (
        <div className={`rounded-lg p-3 text-sm ${scanMessage.includes("success") ? "bg-green-500/10 text-green-400" : "bg-amber-500/10 text-amber-400"}`}>
          {scanMessage}
        </div>
      )}

      {/* Information Section */}
      <div className="glass-card rounded-[24px] border border-border/60 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-foreground mb-3">How It Works</h3>
        <ul className="text-sm text-muted-foreground space-y-2">
          <li className="flex gap-2">
            <span className="text-emerald-400">•</span>
            <span>Add one or more root paths to tell CineVault where to find your media files</span>
          </li>
          <li className="flex gap-2">
            <span className="text-emerald-400">•</span>
            <span>Click the scan button to automatically discover all supported media files</span>
          </li>
          <li className="flex gap-2">
            <span className="text-emerald-400">•</span>
            <span>The app will extract metadata from filenames and video files</span>
          </li>
          <li className="flex gap-2">
            <span className="text-emerald-400">•</span>
            <span>Use the "Auto Fetch" button in item details to enrich metadata with TMDB information</span>
          </li>
          <li className="flex gap-2">
            <span className="text-emerald-400">•</span>
            <span>Supported formats: MP4, MKV, AVI, MOV, WebM, and more</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

