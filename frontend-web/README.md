# CineVault Desktop App

`frontend-web/` is the main app in this repo. It is a React + Vite frontend wrapped in Tauri, with a Rust bridge that controls `mpv` through JSON IPC.

## What Works

- Local library persistence through Tauri + SQLite
- Movie file mapping
- TV show folder scanning with episode detection
- Resume tracking per media path
- Playlists and categories stored in local app state
- Desktop player window with transport, audio/subtitle track selection, subtitle import/remove, and render controls
- URL-backed main library tabs through `?tab=...`

## Development

```powershell
npm install
npm run dev
```

## Desktop Development

```powershell
npm install
npm run tauri:dev
```

## Validation

```powershell
npm run lint
npm run build
npm test
cd src-tauri
cargo check
```

## Notes

- Desktop playback is started through `player_play_path`, not the old `player_play_item` stub.
- Static assets are served from `static/` so build output does not mirror `public/node_modules`.
- The app state and playback resume data are stored locally; no external metadata API is required for core playback and library management.
