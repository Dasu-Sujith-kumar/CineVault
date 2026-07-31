use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use uuid::Uuid;
use chrono::Utc;
use crate::scanner::MediaFile;
use crate::ffprobe::FFProbeMetadata;
use crate::parser::FilenameMetadata;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fingerprint {
    pub size_bytes: u64,
    pub mtime: String,
    pub created: String,
}

impl Fingerprint {
    pub fn new(media_file: &MediaFile) -> Self {
        Fingerprint {
            size_bytes: media_file.file_size,
            mtime: media_file.modified_time.clone(),
            created: media_file.created_time.clone(),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "size_bytes": self.size_bytes,
            "mtime": self.mtime,
            "created": self.created,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataJson {
    pub schema_version: u32,
    pub id: String,                    // UUID - never changes
    #[serde(rename = "type")]
    pub item_type: String,             // "movie" or "tv"
    pub library_kind: String,
    pub title: String,
    pub year: Option<u32>,
    pub tmdb_id: Option<i64>,
    pub imdb_id: Option<String>,
    pub plot: Option<String>,
    pub rating: Option<String>,
    pub genres: Vec<String>,
    pub runtime: Option<u32>,
    pub language: Option<String>,
    pub fingerprint: Fingerprint,
    pub file_hash_sha256: Option<String>,
    pub filename_metadata: FilenameMetadata,
    pub ffprobe_metadata: FFProbeMetadata,
    pub external_subtitles: Vec<ExternalSubtitle>,
    pub is_adult_override: bool,
    pub artwork_version: u32,
    pub poster_filename: Option<String>,
    pub poster_tmdb_path: Option<String>,
    pub backdrop_filename: Option<String>,
    pub backdrop_tmdb_path: Option<String>,
    pub matched_at: Option<String>,
    pub last_updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalSubtitle {
    pub filename: String,
    pub language: String,
    pub format: String,
}

impl MetadataJson {
    pub fn new_movie(
        title: &str,
        media_file: &MediaFile,
        ffprobe_meta: FFProbeMetadata,
        filename_meta: FilenameMetadata,
    ) -> Self {
        let now = Utc::now().to_rfc3339();
        
        MetadataJson {
            schema_version: 1,
            id: Uuid::new_v4().to_string(),
            item_type: "movie".to_string(),
            library_kind: "movies".to_string(),
            title: title.to_string(),
            year: filename_meta.year,
            tmdb_id: None,
            imdb_id: None,
            plot: None,
            rating: None,
            genres: Vec::new(),
            runtime: ffprobe_meta.duration_seconds,
            language: if filename_meta.languages.is_empty() {
                None
            } else {
                Some(filename_meta.languages[0].clone())
            },
            fingerprint: Fingerprint::new(media_file),
            file_hash_sha256: None,
            filename_metadata: filename_meta,
            ffprobe_metadata: ffprobe_meta,
            external_subtitles: Vec::new(),
            is_adult_override: false,
            artwork_version: 1,
            poster_filename: None,
            poster_tmdb_path: None,
            backdrop_filename: None,
            backdrop_tmdb_path: None,
            matched_at: None,
            last_updated: now,
        }
    }

    pub fn new_tv_show(
        title: &str,
        media_file: &MediaFile,
        ffprobe_meta: FFProbeMetadata,
        filename_meta: FilenameMetadata,
    ) -> Self {
        let now = Utc::now().to_rfc3339();
        
        MetadataJson {
            schema_version: 1,
            id: Uuid::new_v4().to_string(),
            item_type: "tv".to_string(),
            library_kind: "tvShows".to_string(),
            title: title.to_string(),
            year: filename_meta.year,
            tmdb_id: None,
            imdb_id: None,
            plot: None,
            rating: None,
            genres: Vec::new(),
            runtime: None,
            language: if filename_meta.languages.is_empty() {
                None
            } else {
                Some(filename_meta.languages[0].clone())
            },
            fingerprint: Fingerprint::new(media_file),
            file_hash_sha256: None,
            filename_metadata: filename_meta,
            ffprobe_metadata: ffprobe_meta,
            external_subtitles: Vec::new(),
            is_adult_override: false,
            artwork_version: 1,
            poster_filename: None,
            poster_tmdb_path: None,
            backdrop_filename: None,
            backdrop_tmdb_path: None,
            matched_at: None,
            last_updated: now,
        }
    }

    pub fn to_json_string(&self) -> anyhow::Result<String> {
        Ok(serde_json::to_string_pretty(self)?)
    }
}

/// Clean title by removing year, quality, source, etc.
pub fn clean_title(filename: &str) -> String {
    // Remove extension
    let without_ext = if let Some(pos) = filename.rfind('.') {
        &filename[..pos]
    } else {
        filename
    };

    // Remove quality, source, codec patterns
    let patterns_to_remove = [
        r"\d{3,4}p",              // 1080p, 720p, etc.
        r"\b(BluRay|WEB|DVDRip|HDRip|BDRip|CAM|HDTV)\b",
        r"\b(x264|x265|H\.264|H\.265|HEVC|AV1|VP9)\b",
        r"\b(19|20)\d{2}\b",      // Year
        r"\[.*?\]",               // [bracketed content]
        r"\(.*?\)",               // (parenthetical content)
        r"\.|-",                  // Dots and dashes used as separators
    ];

    let mut cleaned = without_ext.to_string();
    for pattern in &patterns_to_remove {
        if let Ok(re) = regex::Regex::new(pattern) {
            cleaned = re.replace_all(&cleaned, " ").to_string();
        }
    }

    // Clean up whitespace
    let cleaned = cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    if cleaned.is_empty() {
        without_ext.to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_title() {
        assert_eq!(
            clean_title("Avatar 2009 1080p BluRay x264.mkv"),
            "Avatar"
        );
        
        assert_eq!(
            clean_title("Breaking.Bad.S01E01.720p.WEBRip.x265.mkv"),
            "Breaking Bad"
        );
    }
}
