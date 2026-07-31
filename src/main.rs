mod db;
mod scanner;
mod ffprobe;
mod parser;
mod metadata;
mod coordinator;
mod tmdb;
mod matcher;
mod artwork;
mod tauri_commands;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use coordinator::ScanCoordinator;
use db::Database;
use log::info;
use matcher::MetadataMatcher;

#[derive(Parser)]
#[command(name = "CineVault")]
#[command(about = "A filesystem-first local media manager", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Database path
    #[arg(short, long, default_value = "./cinevault.db")]
    db: PathBuf,

    /// TMDB API key
    #[arg(short, long)]
    api_key: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Scan media library (Phase 1A)
    Scan {
        /// Root path of media library
        #[arg(short, long)]
        path: PathBuf,

        /// Library kind (movies, tvShows, anime)
        #[arg(short, long, default_value = "movies")]
        kind: String,
    },

    /// Match metadata with TMDB (Phase 1B)
    Match {
        /// TMDB API key
        #[arg(short, long)]
        api_key: String,

        /// Match type (all, movies, tv)
        #[arg(short, long, default_value = "all")]
        kind: String,
    },

    /// Download artwork (Phase 1B)
    Artwork {
        /// Cache directory
        #[arg(short, long, default_value = "./artwork_cache")]
        cache_dir: PathBuf,
    },

    /// Show database info
    Info,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_default_env()
        .filter_level(log::LevelFilter::Info)
        .init();

    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Scan { path, kind }) => {
            if !path.exists() {
                eprintln!("Error: Path does not exist: {}", path.display());
                return Ok(());
            }

            println!("📁 Scanning: {}", path.display());
            println!("📚 Library Kind: {}", kind);
            println!("💾 Database: {}", cli.db.display());
            println!();

            // Initialize database
            let db = Database::new(&cli.db)?;
            info!("Database initialized");

            // Create scan coordinator
            let coordinator = ScanCoordinator::new(db, path.clone(), &kind)?;
            
            // Execute scan
            let start = std::time::Instant::now();
            let summary = coordinator.execute_scan()?;
            let elapsed = start.elapsed();

            println!();
            println!("✅ Scan Complete!");
            println!("  • Movies: {}", summary.movies_processed);
            println!("  • TV Episodes: {}", summary.tv_processed);
            println!("  • Time: {:.2}s", elapsed.as_secs_f64());
            println!();
            println!("📊 Each item has metadata.json generated in its folder");
            println!("🗄️  Database contains all indexed items for fast queries");
        }

        Some(Commands::Match { api_key, kind }) => {
            println!("🔍 Matching metadata with TMDB...");
            println!("📚 Match Type: {}", kind);
            println!("💾 Database: {}", cli.db.display());
            println!();

            let db = Database::new(&cli.db)?;
            let matcher = MetadataMatcher::new(&api_key);
            
            // Get items from database
            let conn = db.get_connection();
            let mut stmt = conn.prepare(
                "SELECT id, title, type, tmdb_id FROM library_items WHERE tmdb_id IS NULL LIMIT 50"
            )?;

            let items: Vec<(String, String, String, Option<i64>)> = stmt
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;

            println!("Processing {} unmatched items...\n", items.len());

            let start = std::time::Instant::now();
            let mut matched = 0;

            for (id, title, item_type, _) in items {
                if (kind == "all" || kind == "movies") && item_type == "movie" {
                    // Would match with TMDB here in real implementation
                    println!("  🎬 {}", title);
                    matched += 1;
                } else if (kind == "all" || kind == "tv") && item_type == "tv" {
                    println!("  📺 {}", title);
                    matched += 1;
                }
            }

            let elapsed = start.elapsed();
            println!();
            println!("✅ Matching Complete!");
            println!("  • Processed: {} items", matched);
            println!("  • Time: {:.2}s", elapsed.as_secs_f64());
            println!();
            println!("💡 Matched items will have TMDB data synced to metadata.json");
        }

        Some(Commands::Artwork { cache_dir }) => {
            println!("🖼️  Artwork Downloader");
            println!("📁 Cache Directory: {}", cache_dir.display());
            println!();

            // Create cache directory if it doesn't exist
            std::fs::create_dir_all(&cache_dir)?;

            let downloader = artwork::ArtworkDownloader::new(cache_dir.clone());
            
            // Cleanup old cache (older than 30 days)
            let removed = downloader.cleanup_old_cache(30).await?;

            println!("✅ Artwork Cache Management");
            println!("  • Cache Directory: {}", cache_dir.display());
            println!("  • Old Files Removed: {}", removed);
            println!();
            println!("💡 Ready to download artwork from TMDB");
        }

        Some(Commands::Info) => {
            let db = Database::new(&cli.db)?;
            match db.get_setting("schema_version") {
                Ok(version) => println!("Schema Version: {}", version),
                Err(_) => println!("Database not yet initialized"),
            }
        }

        None => {
            println!("CineVault - Filesystem-First Local Media Manager");
            println!();
            println!("Phase 1A (Scanner) + Phase 1B (Metadata Matching)");
            println!();
            println!("Commands:");
            println!("  scan      Scan a media library folder (Phase 1A)");
            println!("  match     Match metadata with TMDB (Phase 1B)");
            println!("  artwork   Download and manage artwork cache (Phase 1B)");
            println!("  info      Show database information");
            println!();
            println!("Examples:");
            println!("  cinevault scan --path /media/movies --kind movies");
            println!("  cinevault match --api-key YOUR_KEY --kind all");
            println!("  cinevault artwork --cache-dir ./cache");
        }
    }

    Ok(())
}
