use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use log::{info, warn};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FFProbeMetadata {
    pub resolution: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_codec: Option<String>,
    pub bitrate_kbps: Option<u32>,
    pub fps: Option<f64>,
    pub duration_seconds: Option<u32>,
    pub audio_codec: Option<String>,
    pub audio_channels: Option<u32>,
    pub sample_rate: Option<u32>,
}

impl FFProbeMetadata {
    pub fn new() -> Self {
        FFProbeMetadata {
            resolution: None,
            width: None,
            height: None,
            video_codec: None,
            bitrate_kbps: None,
            fps: None,
            duration_seconds: None,
            audio_codec: None,
            audio_channels: None,
            sample_rate: None,
        }
    }

    /// Convert to JSON for storage
    pub fn to_json(&self) -> Value {
        json!({
            "resolution": self.resolution,
            "width": self.width,
            "height": self.height,
            "video_codec": self.video_codec,
            "bitrate_kbps": self.bitrate_kbps,
            "fps": self.fps,
            "duration_seconds": self.duration_seconds,
            "audio_codec": self.audio_codec,
            "audio_channels": self.audio_channels,
            "sample_rate": self.sample_rate,
        })
    }
}

/// Extract metadata from a media file using ffprobe
pub fn extract_metadata(file_path: &Path) -> anyhow::Result<FFProbeMetadata> {
    let output = Command::new("ffprobe")
        .arg("-v")
        .arg("quiet")
        .arg("-print_format")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg(file_path.to_string_lossy().to_string())
        .output();

    match output {
        Ok(result) => {
            if !result.status.success() {
                warn!("ffprobe failed for: {}", file_path.display());
                return Ok(FFProbeMetadata::new());
            }

            let stdout = String::from_utf8(result.stdout)?;
            parse_ffprobe_json(&stdout)
        }
        Err(e) => {
            warn!("Failed to run ffprobe: {}. Make sure ffprobe is installed.", e);
            Ok(FFProbeMetadata::new())
        }
    }
}

/// Parse ffprobe JSON output
fn parse_ffprobe_json(json_str: &str) -> anyhow::Result<FFProbeMetadata> {
    let mut metadata = FFProbeMetadata::new();

    if let Ok(parsed) = serde_json::from_str::<Value>(json_str) {
        // Extract duration from format
        if let Some(format) = parsed.get("format") {
            if let Some(duration_str) = format.get("duration").and_then(|v| v.as_str()) {
                if let Ok(duration) = duration_str.parse::<f64>() {
                    metadata.duration_seconds = Some(duration as u32);
                }
            }

            if let Some(bitrate_str) = format.get("bit_rate").and_then(|v| v.as_str()) {
                if let Ok(bitrate) = bitrate_str.parse::<u32>() {
                    metadata.bitrate_kbps = Some(bitrate / 1000);
                }
            }
        }

        // Extract video and audio stream info
        if let Some(streams) = parsed.get("streams").and_then(|v| v.as_array()) {
            for stream in streams {
                let codec_type = stream
                    .get("codec_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if codec_type == "video" {
                    // Video codec
                    if let Some(codec) = stream.get("codec_name").and_then(|v| v.as_str()) {
                        metadata.video_codec = Some(codec.to_string());
                    }

                    // Resolution
                    if let (Some(w), Some(h)) = (
                        stream.get("width").and_then(|v| v.as_i64()),
                        stream.get("height").and_then(|v| v.as_i64()),
                    ) {
                        metadata.width = Some(w as u32);
                        metadata.height = Some(h as u32);
                        metadata.resolution = Some(format!("{}x{}", w, h));
                    }

                    // FPS
                    if let Some(r_frame_rate) = stream.get("r_frame_rate").and_then(|v| v.as_str()) {
                        if let Some(fps) = parse_frame_rate(r_frame_rate) {
                            metadata.fps = Some(fps);
                        }
                    }
                } else if codec_type == "audio" {
                    // Only process first audio stream
                    if metadata.audio_codec.is_none() {
                        if let Some(codec) = stream.get("codec_name").and_then(|v| v.as_str()) {
                            metadata.audio_codec = Some(codec.to_string());
                        }

                        if let Some(channels) = stream.get("channels").and_then(|v| v.as_i64()) {
                            metadata.audio_channels = Some(channels as u32);
                        }

                        if let Some(sample_rate) = stream
                            .get("sample_rate")
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<u32>().ok())
                        {
                            metadata.sample_rate = Some(sample_rate);
                        }
                    }
                }
            }
        }
    }

    Ok(metadata)
}

/// Parse frame rate string (e.g., "24000/1001" -> 23.976)
fn parse_frame_rate(rate_str: &str) -> Option<f64> {
    let parts: Vec<&str> = rate_str.split('/').collect();
    if parts.len() == 2 {
        if let (Ok(num), Ok(den)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
            if den != 0.0 {
                return Some(num / den);
            }
        }
    }
    rate_str.parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_frame_rate() {
        assert_eq!(parse_frame_rate("24000/1001"), Some(23.976023976023977));
        assert_eq!(parse_frame_rate("30"), Some(30.0));
        assert_eq!(parse_frame_rate("23.976"), Some(23.976));
    }
}
