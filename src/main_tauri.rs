// Phase 1C: Tauri UI Main Entry Point
// This replaces the CLI with a desktop application

use tauri::{generate_context, generate_handler};

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

fn main() {
    tauri::Builder::default()
        .invoke_handler(generate_handler![
            // Library operations
            tauri_commands::get_library_stats,
            tauri_commands::search_library,
            tauri_commands::get_dashboard_items,
            tauri_commands::get_item_detail,
            tauri_commands::save_progress,
        ])
        .run(generate_context!())
        .expect("error while running tauri application");
}
