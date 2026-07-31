use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use regex::Regex;
use log::info;

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "avi", "m4v", "mov", "wmv", "flv", "webm", 
    "m2ts", "ts", "mts", "m2v", "3gp", "ogv"
];

pub const SUBTITLE_EXTENSIONS: &[&str] = &[
    "srt", "ass", "ssa", "vtt", "sub", "smi", "sbv"
];

#[derive(Debug, Clone)]
pub struct MediaFile {
    pub path: PathBuf,
    pub filename: String,
    pub extension: String,
    pub file_size: u64,
    pub modified_time: String,
    pub created_time: String,
}

#[derive(Debug, Clone)]
pub struct ScanResult {
    pub movies: Vec<MediaFile>,
    pub tv_shows: Vec<MediaFile>,
    pub total_files: usize,
}

impl ScanResult {
    pub fn new() -> Self {
        ScanResult {
            movies: Vec::new(),
            tv_shows: Vec::new(),
            total_files: 0,
        }
    }
}

/// Scan a directory recursively for video files
pub fn scan_directory(root_path: &Path) -> anyhow::Result<ScanResult> {
    info!("Starting scan of: {}", root_path.display());
    
    let mut result = ScanResult::new();

    for entry in WalkDir::new(root_path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        
        // Skip directories
        if path.is_dir() {
            continue;
        }

        // Check if it's a video file
        if let Some(ext) = path.extension() {
            if let Some(ext_str) = ext.to_str() {
                if VIDEO_EXTENSIONS.contains(&ext_str.to_lowercase().as_str()) {
                    result.total_files += 1;
                    
                    if let Ok(media_file) = create_media_file(path) {
                        // Detect if it's a TV show (contains S##E## pattern) or movie
                        if is_tv_show(&media_file.filename) {
                            result.tv_shows.push(media_file);
                        } else {
                            result.movies.push(media_file);
                        }
                    }
                }
            }
        }
    }

    info!("Scan complete. Found {} movies, {} TV episodes", 
        result.movies.len(), result.tv_shows.len());
    
    Ok(result)
}

/// Create a MediaFile from a path
fn create_media_file(path: &Path) -> anyhow::Result<MediaFile> {
    let metadata = fs::metadata(path)?;
    let modified = metadata.modified()?;
    let modified_time = chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339();
    
    #[cfg(target_os = "windows")]
    let created_time = {
        use std::os::windows::fs::MetadataExt;
        let creation = metadata.creation_time();
        let secs = (creation / 10_000_000) as i64 - 116_444_736_000_000_000i64;
        match chrono::DateTime::from_timestamp(secs / 1_000_000, ((secs % 1_000_000) * 1000) as u32) {
            Some(dt) => dt.to_rfc3339(),
            None => modified_time.clone(),
        }
    };

    #[cfg(not(target_os = "windows"))]
    let created_time = {
        modified_time.clone()
    };

    let filename = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    Ok(MediaFile {
        path: path.to_path_buf(),
        filename,
        extension,
        file_size: metadata.len(),
        modified_time,
        created_time,
    })
}

/// Detect if filename matches TV show pattern (S##E##)
fn is_tv_show(filename: &str) -> bool {
    let tv_pattern = Regex::new(r"[Ss]\d{1,2}[Ee]\d{1,2}").unwrap();
    tv_pattern.is_match(filename)
}

/// Find external subtitles for a media file
pub fn find_subtitles(media_path: &Path) -> Vec<PathBuf> {
    let parent = media_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = media_path.file_stem().unwrap_or_default();
    
    let mut subtitles = Vec::new();

    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                if let Some(ext_str) = ext.to_str() {
                    if SUBTITLE_EXTENSIONS.contains(&ext_str.to_lowercase().as_str()) {
                        // Check if filename starts with the media file stem
                        if let Some(filename) = path.file_name() {
                            if filename.to_string_lossy().starts_with(&stem.to_string_lossy().to_string()) {
                                subtitles.push(path);
                            }
                        }
                    }
                }
            }
        }
    }

    subtitles
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tv_pattern_detection() {
        assert!(is_tv_show("Breaking Bad S01E01.mkv"));
        assert!(is_tv_show("Game of Thrones - s05e03.mp4"));
        assert!(!is_tv_show("Inception.mkv"));
        assert!(!is_tv_show("Avatar 2009.mp4"));
    }
}
