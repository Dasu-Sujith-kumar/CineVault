use serde::{Deserialize, Serialize};
use reqwest::Client;
use log::info;
use std::collections::HashMap;

#[derive(Clone)]
pub struct TMDbClient {
    api_key: String,
    client: Client,
    base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMovie {
    pub id: i64,
    pub title: String,
    pub release_date: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub genre_ids: Vec<i64>,
    pub vote_average: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchTV {
    pub id: i64,
    pub name: String,
    pub first_air_date: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub genre_ids: Vec<i64>,
    pub vote_average: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MovieDetails {
    pub id: i64,
    pub title: String,
    pub release_date: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub genres: Vec<GenreInfo>,
    pub runtime: Option<i64>,
    pub imdb_id: Option<String>,
    pub rating: Option<f64>,
    pub adult: bool,
    pub belongs_to_collection: Option<CollectionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TVDetails {
    pub id: i64,
    pub name: String,
    pub first_air_date: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub genres: Vec<GenreInfo>,
    pub imdb_id: Option<String>,
    pub vote_average: f64,
    pub number_of_seasons: i64,
    pub number_of_episodes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenreInfo {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionInfo {
    pub id: i64,
    pub name: String,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse<T> {
    pub results: Vec<T>,
    pub total_results: i64,
    pub total_pages: i64,
}

impl TMDbClient {
    pub fn new(api_key: &str) -> Self {
        TMDbClient {
            api_key: api_key.to_string(),
            client: Client::new(),
            base_url: "https://api.themoviedb.org/3".to_string(),
        }
    }

    /// Search for movies by title
    pub async fn search_movies(&self, query: &str, year: Option<u32>) -> anyhow::Result<Vec<SearchMovie>> {
        let url = format!("{}/search/movie", self.base_url);
        
        let mut params = vec![
            ("api_key", self.api_key.clone()),
            ("query", query.to_string()),
        ];

        if let Some(y) = year {
            params.push(("year", y.to_string()));
        }

        let response = self.client
            .get(&url)
            .query(&params)
            .send()
            .await?;

        if !response.status().is_success() {
            anyhow::bail!("TMDB API error: {}", response.status());
        }

        let search_resp: SearchResponse<SearchMovie> = response.json().await?;
        info!("Found {} movies for query: {}", search_resp.results.len(), query);
        
        Ok(search_resp.results)
    }

    /// Search for TV shows by title
    pub async fn search_tv(&self, query: &str, year: Option<u32>) -> anyhow::Result<Vec<SearchTV>> {
        let url = format!("{}/search/tv", self.base_url);
        
        let mut params = vec![
            ("api_key", self.api_key.clone()),
            ("query", query.to_string()),
        ];

        if let Some(y) = year {
            params.push(("first_air_date_year", y.to_string()));
        }

        let response = self.client
            .get(&url)
            .query(&params)
            .send()
            .await?;

        if !response.status().is_success() {
            anyhow::bail!("TMDB API error: {}", response.status());
        }

        let search_resp: SearchResponse<SearchTV> = response.json().await?;
        info!("Found {} TV shows for query: {}", search_resp.results.len(), query);
        
        Ok(search_resp.results)
    }

    /// Get movie details by TMDB ID
    pub async fn get_movie(&self, tmdb_id: i64) -> anyhow::Result<MovieDetails> {
        let url = format!("{}/movie/{}", self.base_url, tmdb_id);
        let params = vec![("api_key", self.api_key.clone())];

        let response = self.client
            .get(&url)
            .query(&params)
            .send()
            .await?;

        if !response.status().is_success() {
            anyhow::bail!("TMDB API error: {}", response.status());
        }

        let details: MovieDetails = response.json().await?;
        Ok(details)
    }

    /// Get TV show details by TMDB ID
    pub async fn get_tv(&self, tmdb_id: i64) -> anyhow::Result<TVDetails> {
        let url = format!("{}/tv/{}", self.base_url, tmdb_id);
        let params = vec![("api_key", self.api_key.clone())];

        let response = self.client
            .get(&url)
            .query(&params)
            .send()
            .await?;

        if !response.status().is_success() {
            anyhow::bail!("TMDB API error: {}", response.status());
        }

        let details: TVDetails = response.json().await?;
        Ok(details)
    }

    /// Get image URL from TMDB poster path
    pub fn get_poster_url(&self, poster_path: &str, width: u32) -> String {
        format!("https://image.tmdb.org/t/p/w{}{}", width, poster_path)
    }

    /// Get image URL from TMDB backdrop path
    pub fn get_backdrop_url(&self, backdrop_path: &str, width: u32) -> String {
        format!("https://image.tmdb.org/t/p/w{}{}", width, backdrop_path)
    }
}

/// Simple match score calculator
pub struct MatchScorer;

impl MatchScorer {
    /// Score movie match (0-100)
    pub fn score_movie(title: &str, year: Option<u32>, tmdb_result: &SearchMovie) -> u32 {
        let mut score = 0u32;

        // Title match (0-70 points)
        let title_lower = title.to_lowercase();
        let result_lower = tmdb_result.title.to_lowercase();
        
        if title_lower == result_lower {
            score += 70;
        } else if result_lower.contains(&title_lower) || title_lower.contains(&result_lower) {
            score += 50;
        } else if levenshtein_similarity(&title_lower, &result_lower) > 0.8 {
            score += 40;
        }

        // Year match (0-30 points)
        if let (Some(y), Some(release)) = (year, &tmdb_result.release_date) {
            if release.starts_with(&y.to_string()) {
                score += 30;
            } else if let Ok(release_year) = release.chars().take(4).collect::<String>().parse::<u32>() {
                if (release_year as i32 - y as i32).abs() <= 1 {
                    score += 20;
                } else if (release_year as i32 - y as i32).abs() <= 3 {
                    score += 10;
                }
            }
        }

        score
    }

    /// Score TV match (0-100)
    pub fn score_tv(title: &str, year: Option<u32>, tmdb_result: &SearchTV) -> u32 {
        let mut score = 0u32;

        // Title match (0-70 points)
        let title_lower = title.to_lowercase();
        let result_lower = tmdb_result.name.to_lowercase();
        
        if title_lower == result_lower {
            score += 70;
        } else if result_lower.contains(&title_lower) || title_lower.contains(&result_lower) {
            score += 50;
        } else if levenshtein_similarity(&title_lower, &result_lower) > 0.8 {
            score += 40;
        }

        // Year match (0-30 points)
        if let (Some(y), Some(first_air)) = (year, &tmdb_result.first_air_date) {
            if first_air.starts_with(&y.to_string()) {
                score += 30;
            } else if let Ok(air_year) = first_air.chars().take(4).collect::<String>().parse::<u32>() {
                if (air_year as i32 - y as i32).abs() <= 1 {
                    score += 20;
                } else if (air_year as i32 - y as i32).abs() <= 3 {
                    score += 10;
                }
            }
        }

        score
    }
}

/// Simple Levenshtein similarity (0.0-1.0)
fn levenshtein_similarity(s1: &str, s2: &str) -> f64 {
    let len1 = s1.len();
    let len2 = s2.len();
    let max_len = len1.max(len2) as f64;
    
    if max_len == 0.0 {
        return 1.0;
    }

    let distance = levenshtein_distance(s1, s2) as f64;
    1.0 - (distance / max_len)
}

fn levenshtein_distance(s1: &str, s2: &str) -> usize {
    let len1 = s1.len();
    let len2 = s2.len();
    let mut matrix = vec![vec![0; len2 + 1]; len1 + 1];

    for i in 0..=len1 {
        matrix[i][0] = i;
    }
    for j in 0..=len2 {
        matrix[0][j] = j;
    }

    let s1_chars: Vec<char> = s1.chars().collect();
    let s2_chars: Vec<char> = s2.chars().collect();

    for i in 1..=len1 {
        for j in 1..=len2 {
            let cost = if s1_chars[i - 1] == s2_chars[j - 1] { 0 } else { 1 };
            matrix[i][j] = *[
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost,
            ]
            .iter()
            .min()
            .unwrap();
        }
    }

    matrix[len1][len2]
}
