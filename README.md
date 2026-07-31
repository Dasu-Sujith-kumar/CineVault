# CineVault / movie-player

A filesystem-first local media manager and MPV-backed desktop player (Tauri + React frontend, Rust backend) that indexes a local library, extracts metadata, matches with TMDB, and provides a desktop playback UI controlled via mpv JSON IPC.

## Quick summary
- Local-first media library scanner + metadata matcher (Rust CLI & Tauri bridge).
- React + Vite frontend wrapped in Tauri for desktop UI.
- mpv used as the playback engine and controlled via JSON IPC from the Rust backend.
- Local persistence using SQLite (rusqlite).

### Stack
- Language(s): Rust (backend / CLI / tauri bridge), TypeScript + React (frontend), CSS, small JS glue for mpv IPC
- Framework / runtime: Tauri (desktop wrapper), Vite + React (frontend dev server)
- Notable libraries:
  - Rust: tokio, rusqlite, reqwest, serde, clap
  - Frontend: React, Vite, @tauri-apps/api
  - Other: mpv (playback engine), ffprobe/ffmpeg (media probing)

## Features
- Filesystem scanner that indexes movies and TV shows and writes metadata.json per item.
- TMDB metadata matching and artwork downloader.
- Desktop player window with transport controls, subtitle import/removal, audio/subtitle track selection, and render controls.
- Resume tracking, playlists and categories stored locally.
- Tauri + SQLite persistence for the desktop app.
- CLI commands for scanning, matching, artwork management, and info.

## Repository layout (top-level, annotated)

```
.
├── Cargo.toml              # Rust workspace / backend (cinevault) manifest
├── Cargo.lock
├── src/                    # Rust CLI / core library — scanner, matcher, db, mpv/tauri commands
│   ├── main.rs
│   ├── db.rs
│   ├── scanner.rs
│   ├── parser.rs
│   ├── metadata.rs
│   ├── tauri_commands.rs    # exports commands used by Tauri frontend
│   └── ...                 # ffprobe.rs, tmdb.rs, artwork.rs, matcher.rs, etc.
├── src-tauri/              # Tauri + frontend-integration config & tiny frontend wrapper
│   ├── Cargo.toml          # tauri side Rust manifest (frontend-web/src-tauri builds here)
│   ├── vite.config.ts
│   └── src/                # (Tauri frontend-side) glue code (if present)
├── frontend-web/           # React + Vite frontend app (UI)
│   ├── package.json
│   ├── src/                # React app (usePlayer hooks, PlayerControls, UI)
│   └── README.md           # frontend-specific developer notes
├── public/                 # static assets served to the frontend
├── index.html
├── styles.css
├── server.js               # small Node server (used by web/dev flows)
├── app.js / mpv-ipc.js     # small JS helpers/utilities for mpv IPC
├── api.md                  # note: contains API key names (do not commit secrets)
├── player-logic.md         # design notes and architecture guidance (player architecture)
└── README.md               # (this file)
```

How it fits together:
- The Rust CLI provides scanning, metadata matching, and artwork tasks (runs standalone or as part of Tauri).
- The frontend (frontend-web) is a React + Vite app that runs in the browser or inside Tauri for desktop.
- Tauri bridges the frontend to Rust commands (tauri_commands.rs) which control mpv via JSON IPC and persist library data to SQLite.

## System prerequisites (recommended)
- Node.js (LTS) + npm or Yarn
- Rust toolchain (stable) + cargo
- mpv (playback engine) installed on host
- ffprobe / ffmpeg (used by media probing code)
- For Tauri desktop builds:
  - Platform-specific prerequisites described in Tauri docs (e.g., build tools, required libraries)
  - Ensure the Rust toolchain and Node toolchain are installed and in PATH

## Environment / API keys
The app can integrate with external metadata providers. Set these as environment variables (DO NOT commit actual keys):
- TMDB_API_KEY
- OMDB_API_KEY
- TVDB_API_KEY
- TRAKT_CLIENT_ID

Where to set them:
- For CLI invocations you can pass `--api-key` (see examples below) or set env vars when running the app.
- For frontend/Tauri, put them in your local environment or use secure platform-specific means (Tauri / OS secrets).

## How to run — development paths

A. Frontend (React + Vite dev server)
```bash
cd frontend-web
npm install
npm run dev           # start Vite dev server
# or to run inside Tauri dev:
npm run tauri:dev
```

B. Desktop (Tauri) — run dev
```bash
cd frontend-web
npm install
npm run tauri:dev     # runs the Tauri dev workflow (requires Rust toolchain & tauri deps)
```

C. Build desktop app (release)
```bash
cd frontend-web
npm install
npm run tauri:build   # builds production desktop app (platform-specific outputs)
```

D. Rust CLI — scanner / matcher / artwork
From the repo root (uses the Rust binary name `cinevault` per Cargo.toml):
```bash
# build once
cargo build --release

# run scanner
cargo run --release -- scan --path /path/to/media --kind movies --db ./cinevault.db

# match metadata
cargo run --release -- match --api-key YOUR_TMDB_KEY --kind all --db ./cinevault.db

# artwork downloader (specify cache dir)
cargo run --release -- artwork --cache-dir ./artwork_cache

# show DB info
cargo run --release -- info --db ./cinevault.db
```

E. Quick web server (legacy / optional)
Root package.json has:
```json
"start": "node server.js"
```
To start that server:
```bash
npm install
npm start
```
(This server is small utility glue; primary desktop app is the Tauri+frontend-web flow.)

## Validation & tests
From frontend-web (recommended):
```bash
cd frontend-web
npm run lint
npm run build
npm test
# rust checks
cd ..
cargo check         # run in repository root for Rust code health
```

## Important implementation notes (from player-logic.md & code)
- The player is designed to be event-driven: the backend observes mpv properties and emits state events to the frontend rather than polling.
- The design uses optimistic UI updates for instant feel and a single source-of-truth player state in the backend/bridge.
- mpv is spawned and managed by the backend (one controller manages lifecycle and IPC).
- Metadata extraction uses ffprobe and Rust scanning/parsing modules.
- Database is SQLite (rusqlite) and metadata.json files are generated in each media folder.

## Security & secrets
- Never commit API keys or credentials. The repository contains example variable names in api.md; remove any real keys from committed files and use environment variables or secret stores for local development.
- The repo currently contains references to external API keys — rotate any leaked keys immediately.

## Contributing
- Open an issue describing the change or idea.
- For code contributions: fork -> feature branch -> PR with descriptive title and tests where appropriate.
- Keep Tauri, Rust and frontend deps up-to-date; run lint and tests in frontend-web before raising PR.

## Troubleshooting / tips
- If mpv fails to start, ensure mpv is installed and available in PATH on your OS.
- If ffprobe-based probing fails, verify ffprobe/ffmpeg binaries are installed.
- For desktop builds, follow Tauri’s platform notes (e.g., on macOS bundle signing, on Windows required C toolchains, etc.)

## License
(Choose & add a license file if you have one; otherwise add an appropriate license here, e.g. MIT.)

---

## Try asking
- "How do I run the scanner over /media/movies and persist to ./cinevault.db? Show the exact cargo command."
- "Which frontend module handles the player state and what files implement the `usePlayer` hook?"
- "Where in the Rust code is mpv spawned and the IPC handled (which file/module) — can you point to the function or file?"


If you want, I can:
- Commit this README.md into the repository (I’ll need the repository target).
- Produce a shorter README focused only on installation and dev commands.
- Create CONTRIBUTING.md or a simple LICENSE file.
