use std::path::{Path, PathBuf};
use reqwest::Client;
use log::{info, warn};
use tokio::fs;
use sha2::{Sha256, Digest};

pub struct ArtworkDownloader {
    cache_dir: PathBuf,
    client: Client,
}

impl ArtworkDownloader {
    pub fn new(cache_dir: PathBuf) -> Self {
        ArtworkDownloader {
            cache_dir,
            client: Client::new(),
        }
    }

    /// Download poster and save to cache
    pub async fn download_poster(
        &self,
        poster_url: &str,
        filename: &str,
    ) -> anyhow::Result<PathBuf> {
        let cache_path = self.cache_dir.join("posters").join(filename);
        
        // Create posters directory if it doesn't exist
        tokio::fs::create_dir_all(cache_path.parent().unwrap()).await?;

        // Check if already cached
        if cache_path.exists() {
            info!("Using cached poster: {}", cache_path.display());
            return Ok(cache_path);
        }

        info!("Downloading poster: {}", poster_url);
        let response = self.client.get(poster_url).send().await?;

        if !response.status().is_success() {
            warn!("Failed to download poster: {}", response.status());
            return Err(anyhow::anyhow!("Download failed: {}", response.status()));
        }

        let bytes = response.bytes().await?;
        fs::write(&cache_path, bytes).await?;
        info!("Poster saved: {}", cache_path.display());

        Ok(cache_path)
    }

    /// Download backdrop and save to cache
    pub async fn download_backdrop(
        &self,
        backdrop_url: &str,
        filename: &str,
    ) -> anyhow::Result<PathBuf> {
        let cache_path = self.cache_dir.join("backdrops").join(filename);
        
        // Create backdrops directory if it doesn't exist
        tokio::fs::create_dir_all(cache_path.parent().unwrap()).await?;

        // Check if already cached
        if cache_path.exists() {
            info!("Using cached backdrop: {}", cache_path.display());
            return Ok(cache_path);
        }

        info!("Downloading backdrop: {}", backdrop_url);
        let response = self.client.get(backdrop_url).send().await?;

        if !response.status().is_success() {
            warn!("Failed to download backdrop: {}", response.status());
            return Err(anyhow::anyhow!("Download failed: {}", response.status()));
        }

        let bytes = response.bytes().await?;
        fs::write(&cache_path, bytes).await?;
        info!("Backdrop saved: {}", cache_path.display());

        Ok(cache_path)
    }

    /// Generate cache filename from URL
    pub fn generate_cache_filename(url: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(url.as_bytes());
        let result = hasher.finalize();
        format!("{:x}.jpg", result)
    }

    /// Clear old cached artwork (older than N days)
    pub async fn cleanup_old_cache(&self, days: u64) -> anyhow::Result<u32> {
        let mut removed_count = 0;
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(days * 86400);

        for subdir in &["posters", "backdrops"] {
            let cache_subdir = self.cache_dir.join(subdir);
            if !cache_subdir.exists() {
                continue;
            }

            if let Ok(mut entries) = fs::read_dir(&cache_subdir).await {
                loop {
                    match entries.next_entry().await {
                        Ok(Some(entry)) => {
                            let path = entry.path();
                            if let Ok(metadata) = fs::metadata(&path).await {
                                if let Ok(modified) = metadata.modified() {
                                    if modified < cutoff {
                                        if fs::remove_file(&path).await.is_ok() {
                                            removed_count += 1;
                                        }
                                    }
                                }
                            }
                        }
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
            }
        }

        info!("Cleanup removed {} old artwork files", removed_count);
        Ok(removed_count)
    }
}
