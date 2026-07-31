use rusqlite::{Connection, Result as SqlResult, params, OptionalExtension};
use std::path::PathBuf;
use uuid::Uuid;
use chrono::Utc;

pub struct Database {
    conn: Connection,
}

impl Database {
    /// Initialize database at given path
    pub fn new(db_path: &PathBuf) -> SqlResult<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
        
        let db = Database { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Initialize SQLite schema (Phase 1A: basic tables only)
    fn init_schema(&self) -> SqlResult<()> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS library_root (
                id TEXT PRIMARY KEY,
                path TEXT UNIQUE NOT NULL,
                library_kind TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS library_items (
                id TEXT PRIMARY KEY,
                stable_id TEXT UNIQUE NOT NULL,
                root_id TEXT NOT NULL,
                type TEXT NOT NULL,
                library_kind TEXT NOT NULL,
                title TEXT NOT NULL,
                tmdb_id INTEGER,
                imdb_id TEXT,
                file_path TEXT UNIQUE NOT NULL,
                file_hash TEXT,
                metadata_json TEXT NOT NULL,
                is_adult_override BOOLEAN DEFAULT 0,
                scanned_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (root_id) REFERENCES library_root(id)
            );

            CREATE INDEX IF NOT EXISTS idx_library_items_title ON library_items(title);
            CREATE INDEX IF NOT EXISTS idx_library_items_type ON library_items(type);
            CREATE INDEX IF NOT EXISTS idx_library_items_kind ON library_items(library_kind);
            CREATE INDEX IF NOT EXISTS idx_library_items_tmdb ON library_items(tmdb_id);
            CREATE INDEX IF NOT EXISTS idx_library_items_file_hash ON library_items(file_hash);

            CREATE TABLE IF NOT EXISTS episodes (
                id TEXT PRIMARY KEY,
                show_id TEXT NOT NULL,
                season INTEGER NOT NULL,
                episode INTEGER NOT NULL,
                title TEXT,
                file_path TEXT NOT NULL,
                file_hash TEXT,
                duration_seconds INTEGER,
                tmdb_id INTEGER,
                metadata_json TEXT,
                scanned_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (show_id) REFERENCES library_items(id),
                UNIQUE(show_id, season, episode)
            );

            CREATE INDEX IF NOT EXISTS idx_episodes_show_id ON episodes(show_id);
            CREATE INDEX IF NOT EXISTS idx_episodes_season ON episodes(season);

            CREATE TABLE IF NOT EXISTS movie_versions (
                id TEXT PRIMARY KEY,
                movie_id TEXT NOT NULL,
                version_name TEXT NOT NULL,
                file_path TEXT UNIQUE NOT NULL,
                file_hash TEXT,
                ffprobe_metadata TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (movie_id) REFERENCES library_items(id),
                UNIQUE(movie_id, version_name)
            );

            CREATE INDEX IF NOT EXISTS idx_movie_versions_movie_id ON movie_versions(movie_id);

            CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                description TEXT,
                poster_path TEXT,
                backdrop_path TEXT,
                tmdb_collection_id INTEGER,
                is_auto_generated BOOLEAN DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS collection_items (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                position INTEGER,
                FOREIGN KEY (collection_id) REFERENCES collections(id),
                FOREIGN KEY (item_id) REFERENCES library_items(id),
                UNIQUE(collection_id, item_id)
            );

            CREATE INDEX IF NOT EXISTS idx_collection_items_collection_id ON collection_items(collection_id);
            CREATE INDEX IF NOT EXISTS idx_collection_items_item_id ON collection_items(item_id);

            CREATE TABLE IF NOT EXISTS playback_progress (
                id TEXT PRIMARY KEY,
                item_id TEXT NOT NULL,
                episode_id TEXT,
                progress_ms INTEGER DEFAULT 0,
                watched BOOLEAN DEFAULT 0,
                last_watched TEXT,
                FOREIGN KEY (item_id) REFERENCES library_items(id),
                FOREIGN KEY (episode_id) REFERENCES episodes(id)
            );

            CREATE INDEX IF NOT EXISTS idx_playback_item_id ON playback_progress(item_id);

            CREATE TABLE IF NOT EXISTS watch_history (
                id TEXT PRIMARY KEY,
                item_id TEXT NOT NULL,
                episode_id TEXT,
                watched_at TEXT NOT NULL,
                duration_watched_ms INTEGER,
                completed BOOLEAN DEFAULT 0,
                FOREIGN KEY (item_id) REFERENCES library_items(id),
                FOREIGN KEY (episode_id) REFERENCES episodes(id)
            );

            CREATE INDEX IF NOT EXISTS idx_watch_history_item_id ON watch_history(item_id);
            CREATE INDEX IF NOT EXISTS idx_watch_history_watched_at ON watch_history(watched_at);

            CREATE TABLE IF NOT EXISTS external_subtitles (
                id TEXT PRIMARY KEY,
                item_id TEXT,
                episode_id TEXT,
                language TEXT NOT NULL,
                format TEXT NOT NULL,
                file_path TEXT NOT NULL,
                is_forced BOOLEAN DEFAULT 0,
                added_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (item_id) REFERENCES library_items(id),
                FOREIGN KEY (episode_id) REFERENCES episodes(id)
            );

            CREATE INDEX IF NOT EXISTS idx_subtitles_item_id ON external_subtitles(item_id);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            "
        )?;

        // Initialize schema version if not already set
        if self.get_setting("schema_version").is_err() {
            self.set_setting("schema_version", "1")?;
            self.conn.execute(
                "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
                params![1, "Initial schema: library_items, episodes, collections, playback, watch_history"],
            )?;
        }

        Ok(())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> SqlResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> SqlResult<String> {
        self.conn.query_row(
            "SELECT value FROM settings WHERE key = ?",
            params![key],
            |row| row.get(0),
        )
    }

    pub fn insert_library_root(&self, path: &PathBuf, library_kind: &str) -> SqlResult<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO library_root (id, path, library_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            params![id, path.to_string_lossy().to_string(), library_kind, now, now],
        )?;
        Ok(id)
    }

    pub fn insert_library_item(
        &self,
        root_id: &str,
        item_type: &str,
        library_kind: &str,
        title: &str,
        file_path: &str,
        metadata_json: &str,
    ) -> SqlResult<String> {
        let id = Uuid::new_v4().to_string();
        let stable_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        
        self.conn.execute(
            "INSERT INTO library_items (id, stable_id, root_id, type, library_kind, title, file_path, metadata_json, scanned_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![id, stable_id, root_id, item_type, library_kind, title, file_path, metadata_json, now, now],
        )?;
        Ok(id)
    }

    pub fn get_connection(&self) -> &Connection {
        &self.conn
    }

    /// Get library statistics
    pub fn get_stats(&self) -> SqlResult<(i64, i64, i64, i64, i64)> {
        let total_items: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM library_items",
            [],
            |row| row.get(0),
        ).unwrap_or(0);

        let total_movies: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM library_items WHERE type = 'movie'",
            [],
            |row| row.get(0),
        ).unwrap_or(0);

        let total_tv: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM library_items WHERE type = 'tv'",
            [],
            |row| row.get(0),
        ).unwrap_or(0);

        let total_episodes: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM episodes",
            [],
            |row| row.get(0),
        ).unwrap_or(0);

        let matched: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM library_items WHERE tmdb_id IS NOT NULL",
            [],
            |row| row.get(0),
        ).unwrap_or(0);

        Ok((total_items, total_movies, total_tv, total_episodes, matched))
    }

    /// Get continue watching items (with playback progress)
    pub fn get_continue_watching(&self, limit: u32) -> SqlResult<Vec<(String, String, String, Option<u32>, u32)>> {
        let mut stmt = self.conn.prepare(
            "SELECT l.id, l.title, l.type, l.year, COALESCE(p.progress_ms, 0) as progress
             FROM library_items l
             LEFT JOIN playback_progress p ON l.id = p.item_id
             WHERE p.progress_ms > 0 AND p.watched = 0
             ORDER BY p.last_watched DESC NULLS LAST
             LIMIT ?"
        )?;

        let results = stmt.query_map(params![limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<u32>>(3)?,
                row.get::<_, u32>(4)?,
            ))
        })?;

        let mut items = Vec::new();
        for result in results {
            items.push(result?);
        }
        Ok(items)
    }

    /// Get recently added items
    pub fn get_recently_added(&self, limit: u32) -> SqlResult<Vec<(String, String, String, Option<u32>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, type, year FROM library_items
             ORDER BY scanned_at DESC
             LIMIT ?"
        )?;

        let results = stmt.query_map(params![limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<u32>>(3)?,
            ))
        })?;

        let mut items = Vec::new();
        for result in results {
            items.push(result?);
        }
        Ok(items)
    }

    /// Search library items with filters
    pub fn search_items(
        &self,
        query: &str,
        item_type: Option<&str>,
        offset: u32,
        limit: u32,
    ) -> SqlResult<(Vec<(String, String, String, Option<u32>, Option<String>)>, i64)> {
        // Build WHERE clause
        let mut where_parts = vec![];
        
        if !query.is_empty() {
            where_parts.push(format!("title LIKE '%{}%'", query.replace("'", "''")));
        }
        
        if let Some(t) = item_type {
            where_parts.push(format!("type = '{}'", t.replace("'", "''")));
        }

        let where_clause = if where_parts.is_empty() {
            "1=1".to_string()
        } else {
            where_parts.join(" AND ")
        };

        // Get total count
        let total: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM library_items WHERE {}", where_clause),
            [],
            |row| row.get(0),
        ).unwrap_or(0);

        // Get items
        let mut stmt = self.conn.prepare(&format!(
            "SELECT id, title, type, year, plot FROM library_items
             WHERE {}
             ORDER BY title ASC
             LIMIT ? OFFSET ?",
            where_clause
        ))?;

        let results = stmt.query_map(params![limit, offset], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<u32>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;

        let mut items = Vec::new();
        for result in results {
            items.push(result?);
        }
        Ok((items, total))
    }

    /// Get item detail by ID
    pub fn get_item(&self, item_id: &str) -> SqlResult<Option<(String, String, String, Option<u32>, Option<String>, Option<i32>, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, type, year, plot, tmdb_id, metadata_json FROM library_items WHERE id = ?"
        )?;

        let result = stmt.query_row(params![item_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<u32>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i32>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        }).optional()?;

        Ok(result)
    }

    /// Get episodes for a TV show
    pub fn get_episodes(&self, show_id: &str) -> SqlResult<Vec<(i32, i32, String, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT season, episode, title, file_path FROM episodes
             WHERE show_id = ?
             ORDER BY season, episode"
        )?;

        let results = stmt.query_map(params![show_id], |row| {
            Ok((
                row.get::<_, i32>(0)?,
                row.get::<_, i32>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;

        let mut episodes = Vec::new();
        for result in results {
            episodes.push(result?);
        }
        Ok(episodes)
    }

    /// Get all collections
    pub fn get_collections(&self) -> SqlResult<Vec<(String, String, Option<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, description FROM collections ORDER BY name"
        )?;

        let results = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;

        let mut collections = Vec::new();
        for result in results {
            collections.push(result?);
        }
        Ok(collections)
    }

    /// Get items in a collection
    pub fn get_collection_items(&self, collection_id: &str) -> SqlResult<Vec<(String, String, String, Option<u32>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT l.id, l.title, l.type, l.year FROM library_items l
             JOIN collection_items c ON l.id = c.item_id
             WHERE c.collection_id = ?
             ORDER BY c.position"
        )?;

        let results = stmt.query_map(params![collection_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<u32>>(3)?,
            ))
        })?;

        let mut items = Vec::new();
        for result in results {
            items.push(result?);
        }
        Ok(items)
    }

    /// Create a new collection
    pub fn create_collection(&self, name: &str, description: Option<&str>) -> SqlResult<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        
        self.conn.execute(
            "INSERT INTO collections (id, name, description, is_auto_generated, created_at, updated_at)
             VALUES (?, ?, ?, 0, ?, ?)",
            params![id, name, description, now, now],
        )?;
        Ok(id)
    }

    /// Add item to collection
    pub fn add_to_collection(&self, collection_id: &str, item_id: &str) -> SqlResult<()> {
        let id = Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT OR IGNORE INTO collection_items (id, collection_id, item_id, position)
             VALUES (?, ?, ?, (SELECT COUNT(*)+1 FROM collection_items WHERE collection_id = ?))",
            params![id, collection_id, item_id, collection_id],
        )?;
        Ok(())
    }

    /// Remove item from collection
    pub fn remove_from_collection(&self, collection_id: &str, item_id: &str) -> SqlResult<()> {
        self.conn.execute(
            "DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?",
            params![collection_id, item_id],
        )?;
        Ok(())
    }

    /// Delete collection
    pub fn delete_collection(&self, collection_id: &str) -> SqlResult<()> {
        self.conn.execute(
            "DELETE FROM collection_items WHERE collection_id = ?",
            params![collection_id],
        )?;
        self.conn.execute(
            "DELETE FROM collections WHERE id = ?",
            params![collection_id],
        )?;
        Ok(())
    }

    /// Update playback progress
    pub fn update_playback_progress(&self, item_id: &str, progress_ms: u32, completed: bool) -> SqlResult<()> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        
        self.conn.execute(
            "INSERT OR REPLACE INTO playback_progress (id, item_id, progress_ms, watched, last_watched)
             VALUES (?, ?, ?, ?, ?)",
            params![id, item_id, progress_ms, if completed { 1 } else { 0 }, now],
        )?;
        Ok(())
    }
}
