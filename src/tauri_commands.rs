// Query functions for UI backend (Phase 2: Real data integration)
// These are bridge functions that will be called through Tauri IPC

use crate::db::Database;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use serde_json::json;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LibraryItem {
    pub id: String,
    pub title: String,
    pub item_type: String,
    pub year: Option<u32>,
    pub plot: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchFilters {
    pub item_type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub items: Vec<LibraryItem>,
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Serialize)]
pub struct LibraryStats {
    pub total_items: i64,
    pub total_movies: i64,
    pub total_tv_shows: i64,
    pub total_episodes: i64,
    pub matched_items: i64,
    pub unmatched_items: i64,
}

#[derive(Debug, Serialize)]
pub struct DashboardResponse {
    pub continue_watching: Vec<serde_json::Value>,
    pub recently_added: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct ItemDetail {
    pub id: String,
    pub title: String,
    pub item_type: String,
    pub year: Option<u32>,
    pub plot: Option<String>,
    pub tmdb_id: Option<i32>,
    pub episodes: Vec<EpisodeInfo>,
}

#[derive(Debug, Serialize)]
pub struct EpisodeInfo {
    pub season: i32,
    pub episode: i32,
    pub title: String,
    pub file_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CollectionInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub item_count: i32,
}

/// Get library statistics - real database queries
pub fn get_library_stats(db_path: &str) -> Result<LibraryStats, String> {
    let db = Database::new(&PathBuf::from(db_path))
        .map_err(|e| format!("Database error: {}", e))?;

    let (total_items, total_movies, total_tv_shows, total_episodes, matched) = db
        .get_stats()
        .map_err(|e| format!("Failed to get stats: {}", e))?;

    let unmatched = total_items - matched;

    Ok(LibraryStats {
        total_items,
        total_movies,
        total_tv_shows,
        total_episodes,
        matched_items: matched,
        unmatched_items: unmatched,
    })
}

/// Search library with filters - real database queries
pub fn search_library(
    db_path: &str,
    query: &str,
    filters: Option<SearchFilters>,
    page: u32,
    page_size: u32,
) -> Result<SearchResult, String> {
    let db = Database::new(&PathBuf::from(db_path))
        .map_err(|e| format!("Database error: {}", e))?;

    let offset = (page.saturating_sub(1)) * page_size;
    let item_type = filters.and_then(|f| f.item_type);

    let (items, total) = db
        .search_items(query, item_type.as_deref(), offset, page_size)
        .map_err(|e| format!("Search failed: {}", e))?;

    let library_items = items
        .into_iter()
        .map(|(id, title, item_type, year, plot)| LibraryItem {
            id,
            title,
            item_type,
            year,
            plot,
        })
        .collect();

    Ok(SearchResult {
        items: library_items,
        total,
        page,
        page_size,
    })
}

/// Get dashboard items - real database queries
pub fn get_dashboard_items(db_path: &str) -> Result<DashboardResponse, String> {
    let db = Database::new(&PathBuf::from(db_path))
        .map_err(|e| format!("Database error: {}", e))?;

    // Continue Watching
    let continue_watching = db
        .get_continue_watching(5)
        .map_err(|e| format!("Failed to get continue watching: {}", e))?
        .into_iter()
        .map(|(id, title, item_type, year, progress)| {
            json!({
                "id": id,
                "title": title,
                "type": item_type,
                "year": year,
                "progress_ms": progress
            })
        })
        .collect();

    // Recently Added
    let recently_added = db
        .get_recently_added(12)
        .map_err(|e| format!("Failed to get recently added: {}", e))?
        .into_iter()
        .map(|(id, title, item_type, year)| {
            json!({
                "id": id,
                "title": title,
                "type": item_type,
                "year": year
            })
        })
        .collect();

    Ok(DashboardResponse {
        continue_watching,
        recently_added,
    })
}

/// Get library item detail - real database queries
pub fn get_item_detail(db_path: &str, item_id: &str) -> Result<ItemDetail, String> {
    let db = Database::new(&PathBuf::from(db_path))
        .map_err(|e| format!("Database error: {}", e))?;

    let item = db
        .get_item(item_id)
        .map_err(|e| format!("Failed to get item: {}", e))?
        .ok_or_else(|| "Item not found".to_string())?;

    let (id, title, item_type, year, plot, tmdb_id, _metadata_json) = item;

    // Get episodes if TV show
    let episodes = if item_type == "tv" {
        db.get_episodes(&id)
            .map_err(|e| format!("Failed to get episodes: {}", e))?
            .into_iter()
            .map(|(season, episode, ep_title, file_path)| EpisodeInfo {
                season,
                episode,
                title: ep_title,
                file_path,
            })
            .collect()
    } else {
        Vec::new()
    };

    Ok(ItemDetail {
        id,
        title,
        item_type,
        year,
        plot,
        tmdb_id,
        episodes,
    })
}

/// Update playback progress - real database update
pub fn save_progress(
    db_path: &str,
    item_id: &str,
    progress_ms: u32,
    completed: bool,
) -> Result<(), String> {
    let db = Database::new(&PathBuf::from(db_path))
        .map_err(|e| format!("Database error: {}", e))?;

    db.update_playback_progress(item_id, progress_ms, completed)
        .map_err(|e| format!("Failed to save progress: {}", e))?;

    Ok(())
}

/// Get all collections
pub fn get_collections(db_path: &str) -> Result<Vec<CollectionInfo>, String> {
    let db = Database::new(&PathBuf::from(db_path))
        .map_err(|e| format!("Database error: {}", e))?;

    let collections = db
        .get_collections()
        .map_err(|e| format!("Failed to get collections: {}", e))?;

    let mut result = Vec::new();
    for (id, name, description) in collections {
        let items = db
            .get_collection_items(&id)
            .unwrap_or_default();
        
        result.push(CollectionInfo {
            id,
            name,
            description,
            item_count: items.len() as i32,
        });
    }

    Ok(result)
}

/// Get items in a collection
pub fn get_collection_items(
    db_path: &str,
    collection_id: &str,
) -> Result<Vec<LibraryItem>, String> {
    let db = Database::new(&PathBuf::from(db_path))
        .map_err(|e| format!("Database error: {}", e))?;

    let items = db
        .get_collection_items(collection_id)
        .map_err(|e| format!("Failed to get collection items: {}", e))?;

    let result = items
        .into_iter()
        .map(|(id, title, item_type, year)| LibraryItem {
            id,
            title,
            item_type,
            year,
            plot: None,
        })
        .collect();

    Ok(result)
}

/// Create a new collection
pub fn create_collection(
    db_path: &str,
    name: &str,
    description: Option<&str>,
) -> Result<String, String> {
    let db = Database::new(&PathBuf::from(db_path))
        .map_err(|e| format!("Database error: {}", e))?;

    db.create_collection(name, description)
        .map_err(|e| format!("Failed to create collection: {}", e))
}

/// Add item to collection
pub fn add_to_collection(
    db_path: &str,
    collection_id: &str,
    item_id: &str,
) -> Result<(), String> {
    let db = Database::new(&PathBuf::from(db_path))
        .map_err(|e| format!("Database error: {}", e))?;

    db.add_to_collection(collection_id, item_id)
        .map_err(|e| format!("Failed to add to collection: {}", e))
}

/// Remove item from collection
pub fn remove_from_collection(
    db_path: &str,
    collection_id: &str,
    item_id: &str,
) -> Result<(), String> {
    let db = Database::new(&PathBuf::from(db_path))
        .map_err(|e| format!("Database error: {}", e))?;

    db.remove_from_collection(collection_id, item_id)
        .map_err(|e| format!("Failed to remove from collection: {}", e))
}

/// Delete collection
pub fn delete_collection(db_path: &str, collection_id: &str) -> Result<(), String> {
    let db = Database::new(&PathBuf::from(db_path))
        .map_err(|e| format!("Database error: {}", e))?;

    db.delete_collection(collection_id)
        .map_err(|e| format!("Failed to delete collection: {}", e))
}
