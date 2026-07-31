use crate::tmdb::{TMDbClient, MatchScorer, SearchMovie, SearchTV, MovieDetails, TVDetails};
use crate::metadata::MetadataJson;
use log::info;

#[derive(Debug, Clone)]
pub struct MatchResult<T> {
    pub tmdb_data: T,
    pub score: u32,
    pub matched: bool,
}

pub struct MetadataMatcher {
    tmdb_client: TMDbClient,
}

impl MetadataMatcher {
    pub fn new(api_key: &str) -> Self {
        MetadataMatcher {
            tmdb_client: TMDbClient::new(api_key),
        }
    }

    /// Auto-match a movie with TMDB
    pub async fn match_movie(&self, metadata: &MetadataJson) -> anyhow::Result<Option<MatchResult<MovieDetails>>> {
        info!("Matching movie: {}", metadata.title);

        // Search TMDB for this movie
        let search_results = self.tmdb_client
            .search_movies(&metadata.title, metadata.year)
            .await?;

        if search_results.is_empty() {
            info!("No TMDB results for: {}", metadata.title);
            return Ok(None);
        }

        // Score results and find best match
        let mut best_match: Option<(SearchMovie, u32)> = None;
        for result in search_results {
            let score = MatchScorer::score_movie(&metadata.title, metadata.year, &result);
            if score > best_match.as_ref().map(|(_, s)| *s).unwrap_or(0) {
                best_match = Some((result, score));
            }
        }

        if let Some((search_result, score)) = best_match {
            if score >= 60 {
                // Fetch full details from TMDB
                let details = self.tmdb_client.get_movie(search_result.id).await?;
                info!("Matched '{}' to TMDB ID {} (score: {})", metadata.title, search_result.id, score);
                
                return Ok(Some(MatchResult {
                    tmdb_data: details,
                    score,
                    matched: true,
                }));
            }
        }

        info!("No high-confidence match for: {}", metadata.title);
        Ok(None)
    }

    /// Auto-match a TV show with TMDB
    pub async fn match_tv(&self, metadata: &MetadataJson) -> anyhow::Result<Option<MatchResult<TVDetails>>> {
        info!("Matching TV show: {}", metadata.title);

        // Search TMDB for this TV show
        let search_results = self.tmdb_client
            .search_tv(&metadata.title, metadata.year)
            .await?;

        if search_results.is_empty() {
            info!("No TMDB results for: {}", metadata.title);
            return Ok(None);
        }

        // Score results and find best match
        let mut best_match: Option<(SearchTV, u32)> = None;
        for result in search_results {
            let score = MatchScorer::score_tv(&metadata.title, metadata.year, &result);
            if score > best_match.as_ref().map(|(_, s)| *s).unwrap_or(0) {
                best_match = Some((result, score));
            }
        }

        if let Some((search_result, score)) = best_match {
            if score >= 60 {
                // Fetch full details from TMDB
                let details = self.tmdb_client.get_tv(search_result.id).await?;
                info!("Matched '{}' to TMDB ID {} (score: {})", metadata.title, search_result.id, score);
                
                return Ok(Some(MatchResult {
                    tmdb_data: details,
                    score,
                    matched: true,
                }));
            }
        }

        info!("No high-confidence match for: {}", metadata.title);
        Ok(None)
    }

    pub fn get_tmdb_client(&self) -> &TMDbClient {
        &self.tmdb_client
    }
}

/// Update metadata with TMDB data
pub fn update_metadata_with_tmdb(metadata: &mut MetadataJson, tmdb_movie: &MovieDetails) {
    metadata.tmdb_id = Some(tmdb_movie.id);
    metadata.imdb_id = tmdb_movie.imdb_id.clone();
    metadata.plot = tmdb_movie.overview.clone();
    metadata.rating = tmdb_movie.imdb_id.clone(); // Could fetch from OMDB if needed
    metadata.runtime = tmdb_movie.runtime.map(|r| r as u32);
    metadata.genres = tmdb_movie.genres.iter().map(|g| g.name.clone()).collect();
    metadata.poster_tmdb_path = tmdb_movie.poster_path.clone();
    metadata.backdrop_tmdb_path = tmdb_movie.backdrop_path.clone();
    metadata.is_adult_override = tmdb_movie.adult;
    metadata.matched_at = Some(chrono::Utc::now().to_rfc3339());
    metadata.artwork_version += 1;
}

/// Update metadata with TMDB TV data
pub fn update_metadata_with_tmdb_tv(metadata: &mut MetadataJson, tmdb_tv: &TVDetails) {
    metadata.tmdb_id = Some(tmdb_tv.id);
    metadata.imdb_id = tmdb_tv.imdb_id.clone();
    metadata.plot = tmdb_tv.overview.clone();
    metadata.genres = tmdb_tv.genres.iter().map(|g| g.name.clone()).collect();
    metadata.poster_tmdb_path = tmdb_tv.poster_path.clone();
    metadata.backdrop_tmdb_path = tmdb_tv.backdrop_path.clone();
    metadata.matched_at = Some(chrono::Utc::now().to_rfc3339());
    metadata.artwork_version += 1;
}
