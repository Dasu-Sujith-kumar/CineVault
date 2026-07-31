import { useState, useEffect } from 'react'
import { useItemDetail } from '../hooks/useLibrary'
import { api, Episode } from '../services/api'
import { TmdbSearchModal, TmdbSearchResult } from '../components/TmdbSearchModal'

interface DetailPageProps {
  itemId: string
  onClose: () => void
  onPlay: (itemId: string) => void
}

export default function DetailPage({ itemId, onClose, onPlay }: DetailPageProps) {
  const { item, isLoading, error, load } = useItemDetail(itemId)
  const [isFavorite, setIsFavorite] = useState(false)
  const [selectedCollection, setSelectedCollection] = useState('')
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [episodesLoading, setEpisodesLoading] = useState(false)
  const [episodesError, setEpisodesError] = useState<string | null>(null)
  
  // TMDB Search Modal state
  const [showTmdbModal, setShowTmdbModal] = useState(false)
  const [tmdbSearching, setTmdbSearching] = useState(false)
  const [tmdbResults, setTmdbResults] = useState<TmdbSearchResult[]>([])
  const [tmdbError, setTmdbError] = useState<string | null>(null)
  const [tmdbQuery, setTmdbQuery] = useState('')

  useEffect(() => {
    load()
  }, [itemId, load])

  useEffect(() => {
    const loadEpisodes = async () => {
      if (item?.item_type === 'tv') {
        setEpisodesLoading(true)
        setEpisodesError(null)
        try {
          const eps = await api.getEpisodes(itemId)
          setEpisodes(eps)
        } catch (err) {
          console.error('Failed to load episodes:', err)
          setEpisodesError('Failed to load episodes')
        } finally {
          setEpisodesLoading(false)
        }
      }
    }

    loadEpisodes()
  }, [item?.item_type, itemId])

  const handleAddToCollection = async () => {
    if (!selectedCollection) return

    try {
      await api.addToCollection(selectedCollection, itemId)
      alert(`Added to collection!`)
      setSelectedCollection('')
    } catch (err) {
      console.error('Failed to add to collection:', err)
      alert('Failed to add to collection')
    }
  }

  const handleToggleFavorite = async () => {
    try {
      setIsFavorite(!isFavorite)
    } catch (err) {
      console.error('Failed to toggle favorite:', err)
    }
  }

  const handleAutoFetch = async () => {
    // Extract filename/title for searching
    const searchQuery = item?.title || 'Unknown'
    setTmdbQuery(searchQuery)
    setShowTmdbModal(true)
    
    // Auto-search based on item type
    const mediaType = item?.item_type === 'tv' ? 'tv' : 'movie'
    await handleTmdbSearch(searchQuery, mediaType)
  }

  const handleTmdbSearch = async (query: string, type: 'movie' | 'tv') => {
    setTmdbSearching(true)
    setTmdbError(null)
    try {
      const results = await api.searchTmdb(query, type)
      setTmdbResults(results)
      if (results.length === 0) {
        setTmdbError('No results found')
      }
    } catch (err) {
      console.error('TMDB search failed:', err)
      setTmdbError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setTmdbSearching(false)
    }
  }

  const handleTmdbSelect = async (result: TmdbSearchResult) => {
    try {
      // Save TMDB metadata to the item
      const metadata = {
        tmdb_id: result.id,
        title: result.title || result.name,
        year: result.year || (result.release_date ? new Date(result.release_date).getFullYear() : undefined),
        plot: result.overview,
        poster_path: result.poster_path,
        rating: result.vote_average,
      }

      // Call backend to save metadata
      if (item?.id) {
        await api.updateItemMetadata(item.id, metadata)
        
        // Cache artwork locally
        if (result.poster_path || result.backdrop_path) {
          await api.cacheTmdbArtwork(result.poster_path, result.backdrop_path)
        }
        
        alert('Metadata and artwork loaded successfully!')
        setShowTmdbModal(false)
        
        // Reload item data
        load()
      }
    } catch (err) {
      console.error('Failed to load metadata:', err)
      setTmdbError('Failed to load metadata')
    }
  }

  if (isLoading) {
    return (
      <div className="detail-page">
        <button className="close-button" onClick={onClose}>
          ← Back
        </button>
        <div className="loading">Loading...</div>
      </div>
    )
  }

  if (error || !item) {
    return (
      <div className="detail-page">
        <button className="close-button" onClick={onClose}>
          ← Back
        </button>
        <div className="error-banner">{error || 'Item not found'}</div>
      </div>
    )
  }

  return (
    <div className="detail-page">
      <button className="close-button" onClick={onClose}>
        ← Back
      </button>

      <div className="detail-header">
        <div className="detail-poster">
          <div className="poster-placeholder">📺</div>
        </div>

        <div className="detail-info">
          <h1>{item.title}</h1>
          <div className="detail-meta">
            <span className="meta-item">{item.item_type === 'movie' ? '🎬 Movie' : '📺 TV Show'}</span>
            {item.year && <span className="meta-item">{item.year}</span>}
          </div>

          <div className="detail-description">
            <p>{item.plot || 'No description available'}</p>
          </div>

          <div className="detail-genres">
            {item.genres && item.genres.map((genre: string) => (
              <span key={genre} className="genre-badge">
                {genre}
              </span>
            ))}
          </div>

          <div className="detail-actions">
            <button className="action-button play-button" onClick={() => onPlay(itemId)}>
              ▶ Play
            </button>
            <button className="action-button" onClick={handleToggleFavorite}>
              {isFavorite ? '★' : '☆'} Favorite
            </button>
            <button className="action-button auto-fetch-button" onClick={handleAutoFetch} title="Fetch metadata from TMDB">
              🔍 Auto Fetch
            </button>
            <button className="action-button" title="More options">
              ⋯ More
            </button>
          </div>

          <div className="detail-add-to-collection">
            <label>Add to Collection:</label>
            <div className="collection-selector">
              <select value={selectedCollection} onChange={(e) => setSelectedCollection(e.target.value)}>
                <option value="">Select a collection...</option>
                <option value="favorites">My Favorites</option>
                <option value="watch-later">Watch Later</option>
                <option value="mcu">Marvel Cinematic Universe</option>
              </select>
              <button onClick={handleAddToCollection} disabled={!selectedCollection}>
                Add
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="detail-tabs">
        <div className="tab-content">
          <h3>Episodes</h3>
          {item?.item_type === 'tv' ? (
            <>
              {episodesLoading && <div className="loading-spinner">Loading episodes...</div>}
              {episodesError && <div className="error-banner">{episodesError}</div>}
              {episodes.length > 0 ? (
                <div className="episodes-container">
                  {Array.from(new Set(episodes.map(ep => ep.season)))
                    .sort((a, b) => a - b)
                    .map((season) => (
                      <div key={season} className="season-group">
                        <h4 className="season-header">Season {season}</h4>
                        <div className="episodes-list">
                          {episodes
                            .filter(ep => ep.season === season)
                            .sort((a, b) => a.episode - b.episode)
                            .map((ep) => (
                              <div key={ep.id} className="episode-item">
                                <span className="episode-number">
                                  E{ep.episode.toString().padStart(2, '0')}
                                </span>
                                <div className="episode-details">
                                  <span className="episode-title">{ep.title || `Episode ${ep.episode}`}</span>
                                  {ep.plot && <span className="episode-plot">{ep.plot}</span>}
                                  {ep.air_date && <span className="episode-date">Aired: {ep.air_date}</span>}
                                </div>
                                <div className="episode-actions">
                                  <button 
                                    className="episode-play-btn"
                                    onClick={() => onPlay(ep.id)}
                                    title="Play episode"
                                  >
                                    ▶ Play
                                  </button>
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="empty-message">No episodes found</p>
              )}
            </>
          ) : (
            <p className="empty-message">Single movie - no episodes</p>
          )}
        </div>
      </div>

      <TmdbSearchModal
        isOpen={showTmdbModal}
        isSearching={tmdbSearching}
        results={tmdbResults}
        query={tmdbQuery}
        mediaType={item?.item_type === 'tv' ? 'tv' : 'movie'}
        onSearch={handleTmdbSearch}
        onSelect={handleTmdbSelect}
        onClose={() => setShowTmdbModal(false)}
        error={tmdbError}
      />
    </div>
  )
}

// Inject styles (moved after function)
const style = document.createElement('style')
style.textContent = `
.detail-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
  background-color: #0f0f0f;
  color: #fff;
  min-height: 100vh;
}

.close-button {
  background: none;
  border: none;
  color: #4a9eff;
  font-size: 1.2rem;
  cursor: pointer;
  margin-bottom: 1.5rem;
  padding: 0;
  transition: color 0.2s;
}

.close-button:hover {
  color: #fff;
}

.loading {
  text-align: center;
  padding: 3rem;
  color: #999;
}

.loading-spinner {
  text-align: center;
  padding: 2rem;
  color: #999;
}

.error-banner {
  background-color: #3a2a2a;
  color: #ff6b6b;
  padding: 1rem;
  border-radius: 4px;
  margin-bottom: 2rem;
  border-left: 4px solid #ff6b6b;
}

.detail-header {
  display: grid;
  grid-template-columns: 250px 1fr;
  gap: 3rem;
  margin-bottom: 3rem;
}

@media (max-width: 768px) {
  .detail-header {
    grid-template-columns: 1fr;
  }
}

.detail-poster {
  width: 250px;
  height: 375px;
  background: linear-gradient(135deg, #1a3a52 0%, #0a1f2e 100%);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 5rem;
  border: 1px solid #333;
}

.poster-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.detail-info h1 {
  font-size: 2.5rem;
  margin: 0 0 1rem 0;
  color: #fff;
}

.detail-meta {
  display: flex;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.meta-item {
  color: #999;
  font-size: 1rem;
}

.detail-description {
  margin-bottom: 1.5rem;
  line-height: 1.6;
  color: #bbb;
}

.detail-genres {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}

.genre-badge {
  background-color: #1a3a52;
  padding: 0.4rem 0.8rem;
  border-radius: 20px;
  font-size: 0.85rem;
  color: #4a9eff;
  border: 1px solid #4a9eff;
}

.detail-actions {
  display: flex;
  gap: 1rem;
  margin-bottom: 2rem;
}

.action-button {
  padding: 0.75rem 1.5rem;
  background-color: #4a9eff;
  color: #fff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1rem;
  transition: background-color 0.2s;
}

.action-button:hover {
  background-color: #357abd;
}

.play-button {
  background-color: #4a9eff;
  font-size: 1.1rem;
}

.auto-fetch-button {
  background-color: #7c3aed;
}

.auto-fetch-button:hover {
  background-color: #6d28d9;
}

.detail-add-to-collection {
  margin-top: 2rem;
  padding-top: 2rem;
  border-top: 1px solid #333;
}

.detail-add-to-collection label {
  display: block;
  margin-bottom: 0.5rem;
  color: #bbb;
  font-size: 0.95rem;
}

.collection-selector {
  display: flex;
  gap: 0.5rem;
}

.collection-selector select {
  flex: 1;
  padding: 0.75rem;
  background-color: #1a1a1a;
  border: 1px solid #333;
  border-radius: 4px;
  color: #fff;
  cursor: pointer;
}

.collection-selector select:focus {
  outline: none;
  border-color: #4a9eff;
}

.collection-selector button {
  padding: 0.75rem 1.5rem;
  background-color: #4a9eff;
  color: #fff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.collection-selector button:hover:not(:disabled) {
  background-color: #357abd;
}

.collection-selector button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.detail-tabs {
  margin-top: 3rem;
  border-top: 1px solid #333;
  padding-top: 2rem;
}

.tab-content h3 {
  font-size: 1.5rem;
  margin-bottom: 1.5rem;
  color: #fff;
}

.episodes-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.episode-item {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 1rem;
  padding: 1rem;
  background-color: #1a1a1a;
  border: 1px solid #333;
  border-radius: 6px;
  transition: border-color 0.2s;
}

.episode-item:hover {
  border-color: #4a9eff;
}

.episode-number {
  font-weight: 600;
  color: #4a9eff;
  font-size: 0.95rem;
  display: flex;
  align-items: center;
}

.episode-details {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.episode-title {
  font-weight: 500;
  color: #fff;
  font-size: 1rem;
}

.episode-plot {
  color: #bbb;
  font-size: 0.85rem;
  line-height: 1.4;
}

.episode-date {
  color: #666;
  font-size: 0.8rem;
}

.empty-message {
  text-align: center;
  color: #666;
  padding: 2rem;
  font-style: italic;
}

@media (max-width: 768px) {
  .detail-page {
    padding: 1rem;
  }

  .detail-header {
    grid-template-columns: 1fr;
    gap: 1.5rem;
  }

  .detail-poster {
    width: 100%;
    height: 300px;
  }

  .detail-info h1 {
    font-size: 1.8rem;
  }

  .detail-actions {
    flex-wrap: wrap;
  }

  .episode-item {
    grid-template-columns: 1fr;
  }
}
`
document.head.appendChild(style)
