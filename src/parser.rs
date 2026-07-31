use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilenameMetadata {
    pub quality: Option<String>,         // 1080p, 4K, 720p, etc.
    pub source: Option<String>,          // BluRay, WEB, DVDRip, etc.
    pub codec: Option<String>,           // x264, x265, HEVC, etc.
    pub languages: Vec<String>,          // Telugu, English, Hindi, etc.
    pub audio: Option<String>,           // DD+2.0, 5.1, etc.
    pub year: Option<u32>,
}

impl FilenameMetadata {
    pub fn new() -> Self {
        FilenameMetadata {
            quality: None,
            source: None,
            codec: None,
            languages: Vec::new(),
            audio: None,
            year: None,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "quality": self.quality,
            "source": self.source,
            "codec": self.codec,
            "languages": self.languages,
            "audio": self.audio,
            "year": self.year,
        })
    }
}

/// Parse filename to extract quality, source, codec, languages, etc.
pub fn parse_filename(filename: &str) -> FilenameMetadata {
    let mut metadata = FilenameMetadata::new();

    // Extract quality (480p, 720p, 1080p, 1440p, 2160p/4K, etc.)
    if let Some(quality) = extract_quality(filename) {
        metadata.quality = Some(quality);
    }

    // Extract source (BluRay, WEB, WEBRip, DVDRip, HDRip, BDRip, CAM, HDTV)
    if let Some(source) = extract_source(filename) {
        metadata.source = Some(source);
    }

    // Extract codec (x264, x265, H.264, H.265, HEVC, AV1, VP9)
    if let Some(codec) = extract_codec(filename) {
        metadata.codec = Some(codec);
    }

    // Extract languages
    metadata.languages = extract_languages(filename);

    // Extract audio (DD, DDP, TrueHD, FLAC, 2.0, 5.1, 7.1)
    if let Some(audio) = extract_audio(filename) {
        metadata.audio = Some(audio);
    }

    // Extract year (e.g., 2023, 1998)
    if let Some(year) = extract_year(filename) {
        metadata.year = Some(year);
    }

    metadata
}

fn extract_quality(filename: &str) -> Option<String> {
    let quality_patterns = [
        (r"(\d{3,4}p)", "quality_number"),
        (r"(4K|2160p|UHD)", "4k"),
        (r"(8K)", "8k"),
    ];

    for (pattern, _name) in &quality_patterns {
        if let Ok(regex) = Regex::new(pattern) {
            if let Some(caps) = regex.captures(filename) {
                if let Some(match_val) = caps.get(1) {
                    return Some(match_val.as_str().to_uppercase());
                }
            }
        }
    }

    None
}

fn extract_source(filename: &str) -> Option<String> {
    let sources = [
        "BluRay", "BDRip", "BDREMUX",
        "WEB", "WEBRip", "WEB-DL",
        "DVDRip", "DVDRIP",
        "HDRip", "HDRIP",
        "CAM", "HDCAM",
        "HDTV", "TV",
        "Streaming",
    ];

    let lower = filename.to_lowercase();
    for source in &sources {
        if lower.contains(&source.to_lowercase()) {
            return Some(source.to_string());
        }
    }

    None
}

fn extract_codec(filename: &str) -> Option<String> {
    let codecs = [
        "x265", "HEVC", "H.265",
        "x264", "H.264", "AVC",
        "AV1",
        "VP9",
        "MPEG-2",
    ];

    let lower = filename.to_lowercase();
    for codec in &codecs {
        if lower.contains(&codec.to_lowercase()) {
            return Some(codec.to_string());
        }
    }

    None
}

fn extract_languages(filename: &str) -> Vec<String> {
    let language_map = [
        ("telugu", "Telugu"),
        ("tamil", "Tamil"),
        ("kannada", "Kannada"),
        ("malayalam", "Malayalam"),
        ("marathi", "Marathi"),
        ("english", "English"),
        ("hindi", "Hindi"),
        ("bengali", "Bengali"),
        ("gujarati", "Gujarati"),
        ("punjabi", "Punjabi"),
        ("odia", "Odia"),
        ("urdu", "Urdu"),
        ("japanese", "Japanese"),
        ("korean", "Korean"),
        ("chinese", "Chinese"),
        ("spanish", "Spanish"),
        ("french", "French"),
        ("german", "German"),
        ("russian", "Russian"),
        ("arabic", "Arabic"),
        ("en", "English"),
        ("te", "Telugu"),
        ("ta", "Tamil"),
        ("hi", "Hindi"),
        ("ml", "Malayalam"),
        ("kn", "Kannada"),
        ("ja", "Japanese"),
        ("ko", "Korean"),
        ("zh", "Chinese"),
    ];

    let mut languages = Vec::new();
    let lower = filename.to_lowercase();

    for (key, lang) in &language_map {
        if lower.contains(key) && !languages.contains(&lang.to_string()) {
            languages.push(lang.to_string());
        }
    }

    // Always assume English if not explicitly mentioned
    if languages.is_empty() {
        languages.push("English".to_string());
    }

    languages
}

fn extract_audio(filename: &str) -> Option<String> {
    let audio_patterns = [
        "DD+", "DDP", "Dolby.Digital.Plus",
        "TrueHD",
        "DTS",
        "FLAC",
        "AAC",
        "2.0", "2.1",
        "5.1", "5.1.2",
        "7.1", "7.1.2", "7.1.4",
    ];

    let lower = filename.to_lowercase();
    for audio in &audio_patterns {
        if lower.contains(&audio.to_lowercase()) {
            return Some(audio.to_string());
        }
    }

    None
}

fn extract_year(filename: &str) -> Option<u32> {
    // Look for 4-digit year between 1900-2100
    if let Ok(regex) = Regex::new(r"\b(19|20)\d{2}\b") {
        if let Some(caps) = regex.captures(filename) {
            if let Ok(year) = caps[0].parse::<u32>() {
                if year >= 1900 && year <= 2100 {
                    return Some(year);
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_quality() {
        assert_eq!(extract_quality("Movie.2024.1080p.BluRay"), Some("1080P".to_string()));
        assert_eq!(extract_quality("4K.Movie.2024"), Some("4K".to_string()));
    }

    #[test]
    fn test_extract_source() {
        assert_eq!(extract_source("Movie.BluRay.x264"), Some("BluRay".to_string()));
        assert_eq!(extract_source("Movie.WEBRip.h265"), Some("WEBRip".to_string()));
    }

    #[test]
    fn test_extract_languages() {
        let langs = extract_languages("Movie.Telugu.English.2024");
        assert!(langs.contains(&"Telugu".to_string()));
        assert!(langs.contains(&"English".to_string()));
    }

    #[test]
    fn test_extract_year() {
        assert_eq!(extract_year("Avatar.2009.1080p"), Some(2009));
        assert_eq!(extract_year("Breaking Bad S01E01.2008"), Some(2008));
    }
}
