use std::path::{Path, PathBuf};
use log::info;
use std::io::Write;
use crate::db::Database;
use crate::scanner::scan_directory;
use crate::ffprobe::extract_metadata;
use crate::parser::parse_filename;
use crate::metadata::{MetadataJson, clean_title, ExternalSubtitle};

pub struct ScanCoordinator {
    db: Database,
    root_path: PathBuf,
    root_id: String,
    library_kind: String,
}

impl ScanCoordinator {
    pub fn new(db: Database, root_path: PathBuf, library_kind: &str) -> anyhow::Result<Self> {
        let root_id = db.insert_library_root(&root_path, library_kind)?;
        
        Ok(ScanCoordinator {
            db,
            root_path,
            root_id,
            library_kind: library_kind.to_string(),
        })
    }

    /// Execute complete scan: filesystem + ffprobe + filename parse + metadata.json generation
    pub fn execute_scan(&self) -> anyhow::Result<ScanSummary> {
        info!("Starting full scan of: {}", self.root_path.display());

        // Step 1: Scan filesystem
        let scan_result = scan_directory(&self.root_path)?;
        info!("Found {} items to process", scan_result.total_files);

        let mut summary = ScanSummary::new();
        let total = scan_result.movies.len() + scan_result.tv_shows.len();
        let mut processed = 0;

        // Step 2: Process movies
        for media_file in scan_result.movies {
            processed += 1;
            self.process_movie(&media_file, &mut summary)?;
            print!("\rProcessing: {}/{}", processed, total);
            let _ = std::io::stdout().flush();
        }

        // Step 3: Process TV shows
        for media_file in scan_result.tv_shows {
            processed += 1;
            self.process_tv_show(&media_file, &mut summary)?;
            print!("\rProcessing: {}/{}", processed, total);
            let _ = std::io::stdout().flush();
        }

        println!(); // New line after progress bar
        info!("Scan complete: {} movies, {} TV episodes", 
            summary.movies_processed, summary.tv_processed);

        Ok(summary)
    }

    fn process_movie(&self, media_file: &crate::scanner::MediaFile, summary: &mut ScanSummary) -> anyhow::Result<()> {
        // Extract filename metadata
        let filename_meta = parse_filename(&media_file.filename);
        
        // Extract ffprobe metadata
        let ffprobe_meta = extract_metadata(&media_file.path)
            .unwrap_or_default();

        // Clean title
        let title = clean_title(&media_file.filename);

        // Generate metadata.json
        let mut metadata = MetadataJson::new_movie(
            &title,
            media_file,
            ffprobe_meta,
            filename_meta,
        );

        // Find external subtitles
        metadata.external_subtitles = find_subtitles_for_file(&media_file.path);

        // Generate metadata.json next to media file as: filename.metadata.json
        let metadata_filename = format!("{}.metadata.json", media_file.filename);
        let metadata_path = media_file.path.parent()
            .unwrap_or_else(|| Path::new("."))
            .join(&metadata_filename);

        let json_string = metadata.to_json_string()?;
        std::fs::write(&metadata_path, json_string)?;

        // Insert into database
        let file_path_str = media_file.path.to_string_lossy().to_string();
        let metadata_json_str = serde_json::to_string(&metadata)?;
        
        self.db.insert_library_item(
            &self.root_id,
            "movie",
            "movies",
            &title,
            &file_path_str,
            &metadata_json_str,
        )?;

        summary.movies_processed += 1;
        Ok(())
    }

    fn process_tv_show(&self, media_file: &crate::scanner::MediaFile, summary: &mut ScanSummary) -> anyhow::Result<()> {
        // Extract episode info from filename (S##E##)
        let (_season, _episode) = extract_episode_numbers(&media_file.filename)
            .unwrap_or((0, 0));

        // Extract filename metadata
        let filename_meta = parse_filename(&media_file.filename);
        
        // Extract ffprobe metadata
        let ffprobe_meta = extract_metadata(&media_file.path)
            .unwrap_or_default();

        // Clean title
        let title = clean_title(&media_file.filename);

        // Generate metadata.json
        let mut metadata = MetadataJson::new_tv_show(
            &title,
            media_file,
            ffprobe_meta,
            filename_meta,
        );

        // Find external subtitles
        metadata.external_subtitles = find_subtitles_for_file(&media_file.path);

        // Generate metadata.json next to media file as: filename.metadata.json
        let metadata_filename = format!("{}.metadata.json", media_file.filename);
        let metadata_path = media_file.path.parent()
            .unwrap_or_else(|| Path::new("."))
            .join(&metadata_filename);

        let json_string = metadata.to_json_string()?;
        std::fs::write(&metadata_path, json_string)?;

        // Insert into database
        let file_path_str = media_file.path.to_string_lossy().to_string();
        let metadata_json_str = serde_json::to_string(&metadata)?;
        
        self.db.insert_library_item(
            &self.root_id,
            "tv",
            "tvShows",
            &title,
            &file_path_str,
            &metadata_json_str,
        )?;

        summary.tv_processed += 1;
        Ok(())
    }
}

pub struct ScanSummary {
    pub movies_processed: usize,
    pub tv_processed: usize,
    pub subtitles_found: usize,
}

impl ScanSummary {
    pub fn new() -> Self {
        ScanSummary {
            movies_processed: 0,
            tv_processed: 0,
            subtitles_found: 0,
        }
    }
}

/// Extract season and episode numbers from filename (e.g., "S01E05")
fn extract_episode_numbers(filename: &str) -> Option<(u32, u32)> {
    if let Ok(regex) = regex::Regex::new(r"[Ss](\d{1,2})[Ee](\d{1,2})") {
        if let Some(caps) = regex.captures(filename) {
            if let (Ok(season), Ok(episode)) = (caps[1].parse(), caps[2].parse()) {
                return Some((season, episode));
            }
        }
    }
    None
}

/// Find subtitles for a media file
fn find_subtitles_for_file(media_path: &Path) -> Vec<ExternalSubtitle> {
    let mut subs = Vec::new();
    
    if let Ok(subtitles) = std::fs::read_dir(media_path.parent().unwrap_or_else(|| Path::new("."))) {
        for entry in subtitles.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                if let Some(ext_str) = ext.to_str() {
                    let sub_formats = ["srt", "ass", "ssa", "vtt", "sub", "smi", "sbv"];
                    if sub_formats.contains(&ext_str.to_lowercase().as_str()) {
                        if let Some(filename) = path.file_name() {
                            let filename_str = filename.to_string_lossy().to_string();
                            let language = extract_language_from_subtitle(&filename_str);
                            subs.push(ExternalSubtitle {
                                filename: filename_str,
                                language,
                                format: ext_str.to_lowercase(),
                            });
                        }
                    }
                }
            }
        }
    }

    subs
}

/// Extract language from subtitle filename
fn extract_language_from_subtitle(filename: &str) -> String {
    let lower = filename.to_lowercase();
    
    // Check for language patterns like filename.en.srt or filename.eng.srt
    if lower.contains(".en.") || lower.contains(".eng.") {
        return "English".to_string();
    }
    if lower.contains(".te.") || lower.contains(".tel.") {
        return "Telugu".to_string();
    }
    if lower.contains(".ta.") || lower.contains(".tam.") {
        return "Tamil".to_string();
    }
    if lower.contains(".hi.") || lower.contains(".hin.") {
        return "Hindi".to_string();
    }

    // Default to English
    "English".to_string()
}
