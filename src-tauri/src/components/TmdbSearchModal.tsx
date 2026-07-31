import { useState } from 'react'

export interface TmdbSearchResult {
  id: number
  title?: string
  name?: string
  year?: number
  release_date?: string
  first_air_date?: string
  overview?: string
  poster_path?: string
  backdrop_path?: string
  vote_average?: number
}

interface TmdbSearchModalProps {
  isOpen: boolean
  isSearching: boolean
  results: TmdbSearchResult[]
  query: string
  mediaType: 'movie' | 'tv'
  onSearch: (query: string, type: 'movie' | 'tv') => Promise<void>
  onSelect: (result: TmdbSearchResult) => void
  onClose: () => void
  error?: string | null
}

export function TmdbSearchModal({
  isOpen,
  isSearching,
  results,
  query,
  mediaType,
  onSearch,
  onSelect,
  onClose,
  error,
}: TmdbSearchModalProps) {
  const [localQuery, setLocalQuery] = useState(query)
  const [localType, setLocalType] = useState<'movie' | 'tv'>(mediaType)

  const handleSearch = async () => {
    if (localQuery.trim()) {
      await onSearch(localQuery, localType)
    }
  }

  const getTitle = (result: TmdbSearchResult) => {
    return result.title || result.name || 'Unknown'
  }

  const getYear = (result: TmdbSearchResult) => {
    if (result.year) return result.year
    const dateStr = result.release_date || result.first_air_date
    if (dateStr) return new Date(dateStr).getFullYear()
    return null
  }

  if (!isOpen) return null

  return (
    <div className="tmdb-modal-overlay" onClick={onClose}>
      <div className="tmdb-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="tmdb-modal-header">
          <h2>Search TMDB</h2>
          <button className="tmdb-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="tmdb-search-box">
          <div className="tmdb-type-selector">
            <button
              className={`type-btn ${localType === 'movie' ? 'active' : ''}`}
              onClick={() => setLocalType('movie')}
            >
              🎬 Movie
            </button>
            <button
              className={`type-btn ${localType === 'tv' ? 'active' : ''}`}
              onClick={() => setLocalType('tv')}
            >
              📺 TV Show
            </button>
          </div>

          <div className="tmdb-search-input-group">
            <input
              type="text"
              placeholder="Search TMDB..."
              value={localQuery}
              onChange={(e) => setLocalQuery(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              disabled={isSearching}
            />
            <button
              className="tmdb-search-btn"
              onClick={handleSearch}
              disabled={isSearching || !localQuery.trim()}
            >
              {isSearching ? '⏳ Searching...' : '🔍 Search'}
            </button>
          </div>
        </div>

        {error && <div className="tmdb-error">{error}</div>}

        <div className="tmdb-results">
          {results.length > 0 ? (
            <div className="tmdb-results-list">
              {results.map((result) => (
                <div
                  key={result.id}
                  className="tmdb-result-item"
                  onClick={() => onSelect(result)}
                >
                  <div className="tmdb-result-poster">
                    {result.poster_path ? (
                      <img
                        src={`https://image.tmdb.org/t/p/w92${result.poster_path}`}
                        alt={getTitle(result)}
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none'
                        }}
                      />
                    ) : (
                      <div className="tmdb-no-poster">No Poster</div>
                    )}
                  </div>
                  <div className="tmdb-result-info">
                    <div className="tmdb-result-title">{getTitle(result)}</div>
                    {getYear(result) && <div className="tmdb-result-year">{getYear(result)}</div>}
                    {result.vote_average !== undefined && (
                      <div className="tmdb-result-rating">⭐ {result.vote_average.toFixed(1)}</div>
                    )}
                    {result.overview && (
                      <div className="tmdb-result-overview">{result.overview.substring(0, 100)}...</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="tmdb-empty">
              {isSearching ? (
                <>
                  <div className="tmdb-spinner"></div>
                  <p>Searching...</p>
                </>
              ) : (
                <p>No results found. Try searching for something.</p>
              )}
            </div>
          )}
        </div>

        <style>{`
          .tmdb-modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
          }

          .tmdb-modal-content {
            background: #1a1a2e;
            border-radius: 12px;
            width: 90%;
            max-width: 600px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8);
          }

          .tmdb-modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          }

          .tmdb-modal-header h2 {
            margin: 0;
            font-size: 20px;
            color: #fff;
          }

          .tmdb-close-btn {
            background: none;
            border: none;
            color: #fff;
            font-size: 24px;
            cursor: pointer;
            padding: 0;
          }

          .tmdb-close-btn:hover {
            opacity: 0.7;
          }

          .tmdb-search-box {
            padding: 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          }

          .tmdb-type-selector {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
          }

          .type-btn {
            flex: 1;
            padding: 8px 16px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            background: rgba(255, 255, 255, 0.05);
            color: rgba(255, 255, 255, 0.7);
            border-radius: 6px;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.2s;
          }

          .type-btn.active {
            background: rgba(59, 130, 246, 0.8);
            color: #fff;
            border-color: rgba(59, 130, 246, 0.5);
          }

          .type-btn:hover:not(.active) {
            background: rgba(255, 255, 255, 0.1);
          }

          .tmdb-search-input-group {
            display: flex;
            gap: 8px;
          }

          .tmdb-search-input-group input {
            flex: 1;
            padding: 10px 16px;
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 6px;
            color: #fff;
            font-size: 14px;
          }

          .tmdb-search-input-group input:focus {
            outline: none;
            border-color: rgba(59, 130, 246, 0.5);
            background: rgba(255, 255, 255, 0.15);
          }

          .tmdb-search-btn {
            padding: 10px 20px;
            background: rgba(59, 130, 246, 0.8);
            border: 1px solid rgba(59, 130, 246, 0.5);
            border-radius: 6px;
            color: #fff;
            cursor: pointer;
            font-weight: 500;
            white-space: nowrap;
            transition: all 0.2s;
          }

          .tmdb-search-btn:hover:not(:disabled) {
            background: rgba(59, 130, 246, 1);
          }

          .tmdb-search-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .tmdb-error {
            padding: 12px 20px;
            background: rgba(239, 68, 68, 0.2);
            border: 1px solid rgba(239, 68, 68, 0.3);
            color: #fca5a5;
            margin: 0 20px;
            border-radius: 6px;
            font-size: 13px;
          }

          .tmdb-results {
            flex: 1;
            overflow-y: auto;
            padding: 0;
          }

          .tmdb-results-list {
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
          }

          .tmdb-result-item {
            display: flex;
            gap: 12px;
            padding: 12px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
          }

          .tmdb-result-item:hover {
            background: rgba(59, 130, 246, 0.15);
            border-color: rgba(59, 130, 246, 0.3);
          }

          .tmdb-result-poster {
            flex-shrink: 0;
            width: 60px;
            height: 90px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 4px;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .tmdb-result-poster img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }

          .tmdb-no-poster {
            color: rgba(255, 255, 255, 0.3);
            font-size: 11px;
            text-align: center;
            padding: 8px;
          }

          .tmdb-result-info {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 4px;
          }

          .tmdb-result-title {
            color: #fff;
            font-weight: 600;
            font-size: 14px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .tmdb-result-year {
            color: rgba(255, 255, 255, 0.6);
            font-size: 12px;
          }

          .tmdb-result-rating {
            color: #fbbf24;
            font-size: 12px;
            font-weight: 500;
          }

          .tmdb-result-overview {
            color: rgba(255, 255, 255, 0.5);
            font-size: 12px;
            line-height: 1.4;
            overflow: hidden;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
          }

          .tmdb-empty {
            padding: 40px 20px;
            text-align: center;
            color: rgba(255, 255, 255, 0.5);
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
          }

          .tmdb-spinner {
            width: 30px;
            height: 30px;
            border: 3px solid rgba(59, 130, 246, 0.2);
            border-top-color: rgba(59, 130, 246, 0.8);
            border-radius: 50%;
            animation: spin 0.6s linear infinite;
          }

          @keyframes spin {
            to {
              transform: rotate(360deg);
            }
          }

          .tmdb-results::-webkit-scrollbar {
            width: 8px;
          }

          .tmdb-results::-webkit-scrollbar-track {
            background: transparent;
          }

          .tmdb-results::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 4px;
          }

          .tmdb-results::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.3);
          }
        `}</style>
      </div>
    </div>
  )
}
