import { useState, useEffect, useRef } from 'react'
import { useLibrarySearch, useAdvancedSearch } from '../hooks/useLibrary'
import ProgressBar from '../components/ProgressBar'

const COMMON_GENRES = [
  'Action', 'Comedy', 'Drama', 'Fantasy', 'Horror',
  'Romance', 'Sci-Fi', 'Thriller', 'Animation', 'Documentary'
]

interface FilterPreset {
  name: string
  yearFrom?: number
  yearTo?: number
  selectedGenres: string[]
  minRating?: number
  maxRating?: number
  sortBy: string
  sortOrder: string
}

export default function LibraryPage({ onSearch }: { onSearch?: (query: any) => void }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemType, setItemType] = useState('')
  const [useAdvanced, setUseAdvanced] = useState(false)
  
  // Advanced search filters
  const [yearFrom, setYearFrom] = useState<number | undefined>(undefined)
  const [yearTo, setYearTo] = useState<number | undefined>(undefined)
  const [selectedGenres, setSelectedGenres] = useState<string[]>([])
  const [minRating, setMinRating] = useState<number | undefined>(undefined)
  const [maxRating, setMaxRating] = useState<number | undefined>(undefined)
  const [sortBy, setSortBy] = useState('title')
  const [sortOrder, setSortOrder] = useState('asc')
  
  // Filter presets management
  const [filterPresets, setFilterPresets] = useState<FilterPreset[]>(() => {
    const saved = localStorage.getItem('filterPresets')
    return saved ? JSON.parse(saved) : []
  })
  const [showPresetModal, setShowPresetModal] = useState(false)
  const [presetName, setPresetName] = useState('')

  // Search history management
  interface SearchHistoryEntry {
    query: string
    timestamp: number
  }
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>(() => {
    const saved = localStorage.getItem('searchHistory')
    return saved ? JSON.parse(saved) : []
  })
  const [showHistory, setShowHistory] = useState(false)
  
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const basicSearch = useLibrarySearch()
  const advSearch = useAdvancedSearch()

  // Save presets to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('filterPresets', JSON.stringify(filterPresets))
  }, [filterPresets])

  // Save search history to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('searchHistory', JSON.stringify(searchHistory))
  }, [searchHistory])

  // Use the appropriate search based on mode
  const { result, isLoading, error } = useAdvanced ? advSearch : basicSearch

  // Debounce search query (500ms delay)
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
    }
    debounceTimer.current = setTimeout(() => {
      setDebouncedQuery(searchQuery)
      setCurrentPage(1)
    }, 500)

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
    }
  }, [searchQuery])

  // Perform search when filters change
  useEffect(() => {
    if (useAdvanced) {
      advSearch.search(
        debouncedQuery || undefined,
        itemType || undefined,
        yearFrom,
        yearTo,
        selectedGenres.length > 0 ? selectedGenres : undefined,
        minRating,
        maxRating,
        sortBy,
        sortOrder,
        20,
        (currentPage - 1) * 20
      )
      // Track search in history
      if (debouncedQuery && debouncedQuery.trim()) {
        addToSearchHistory(debouncedQuery)
      }
    } else {
      basicSearch.search(debouncedQuery, itemType || undefined, currentPage, 20)
      // Track search in history
      if (debouncedQuery && debouncedQuery.trim()) {
        addToSearchHistory(debouncedQuery)
      }
    }
  }, [debouncedQuery, currentPage, itemType, useAdvanced, yearFrom, yearTo, selectedGenres, minRating, maxRating, sortBy, sortOrder, advSearch, basicSearch])

  const addToSearchHistory = (query: string) => {
    setSearchHistory(prev => {
      // Remove duplicates and keep only the latest
      const filtered = prev.filter(entry => entry.query !== query)
      // Keep last 10 searches
      const updated = [...filtered, { query, timestamp: Date.now() }].slice(-10)
      return updated
    })
  }

  const rerunHistorySearch = (query: string) => {
    setSearchQuery(query)
    setShowHistory(false)
  }

  const clearSearchHistory = () => {
    if (window.confirm('Clear all search history?')) {
      setSearchHistory([])
    }
  }

  const toggleGenre = (genre: string) => {
    setSelectedGenres(prev =>
      prev.includes(genre)
        ? prev.filter(g => g !== genre)
        : [...prev, genre]
    )
    setCurrentPage(1)
  }

  const handleResetFilters = () => {
    setYearFrom(undefined)
    setYearTo(undefined)
    setSelectedGenres([])
    setMinRating(undefined)
    setMaxRating(undefined)
    setSortBy('title')
    setSortOrder('asc')
    setCurrentPage(1)
  }

  const saveCurrentFiltersAsPreset = () => {
    setShowPresetModal(true)
  }

  const handleSavePreset = () => {
    if (!presetName.trim()) return

    const newPreset: FilterPreset = {
      name: presetName,
      yearFrom,
      yearTo,
      selectedGenres: [...selectedGenres],
      minRating,
      maxRating,
      sortBy,
      sortOrder,
    }

    setFilterPresets(prev => [...prev, newPreset])
    setPresetName('')
    setShowPresetModal(false)
  }

  const loadPreset = (preset: FilterPreset) => {
    setYearFrom(preset.yearFrom)
    setYearTo(preset.yearTo)
    setSelectedGenres([...preset.selectedGenres])
    setMinRating(preset.minRating)
    setMaxRating(preset.maxRating)
    setSortBy(preset.sortBy)
    setSortOrder(preset.sortOrder)
    setCurrentPage(1)
  }

  const deletePreset = (name: string) => {
    setFilterPresets(prev => prev.filter(p => p.name !== name))
  }

  const totalPages = Math.ceil(result.total / 20)
  const hasFilters = yearFrom || yearTo || selectedGenres.length > 0 || minRating || maxRating || sortBy !== 'title'

  return (
    <div className="library-page">
      <div className="library-header">
        <h1>Library</h1>
        <p className="library-subtitle">Search and browse your media collection</p>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="search-controls">
        <div className="search-input-container">
          <input
            type="text"
            className="search-input"
            placeholder="Search by title..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => searchHistory.length > 0 && setShowHistory(true)}
          />
          {searchQuery ? (
            <button
              className="clear-search-btn"
              onClick={() => setSearchQuery('')}
              title="Clear search"
            >
              ✕
            </button>
          ) : searchHistory.length > 0 ? (
            <button
              className="history-btn"
              onClick={() => setShowHistory(!showHistory)}
              title="Search history"
            >
              🕐
            </button>
          ) : null}
          
          {/* Search History Dropdown */}
          {showHistory && searchHistory.length > 0 && (
            <div className="history-dropdown">
              <div className="history-header">
                <span className="history-title">Recent Searches</span>
                <button
                  className="history-clear-btn"
                  onClick={clearSearchHistory}
                  title="Clear all history"
                >
                  🗑️
                </button>
              </div>
              <div className="history-list">
                {[...searchHistory].reverse().map((entry, idx) => (
                  <button
                    key={idx}
                    className="history-item"
                    onClick={() => rerunHistorySearch(entry.query)}
                  >
                    <span className="history-query">{entry.query}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          className={`advanced-toggle-btn ${useAdvanced ? 'active' : ''}`}
          onClick={() => {
            setUseAdvanced(!useAdvanced)
            setCurrentPage(1)
          }}
          title="Toggle advanced search"
        >
          ⚙️ Filters
        </button>

        <select
          value={itemType}
          onChange={(e) => {
            setItemType(e.target.value)
            setCurrentPage(1)
          }}
          className="filter-select"
        >
          <option value="">All Types</option>
          <option value="movie">🎬 Movies</option>
          <option value="tv">📺 TV Shows</option>
        </select>
      </div>

      {/* Advanced Search Controls */}
      {useAdvanced && (
        <div className="advanced-filters">
          <div className="filters-header">
            <h3>Advanced Search</h3>
            <div className="filters-header-buttons">
              {hasFilters && (
                <button
                  className="reset-filters-btn"
                  onClick={handleResetFilters}
                >
                  Reset
                </button>
              )}
              <button
                className="save-preset-btn"
                onClick={saveCurrentFiltersAsPreset}
                title="Save current filters as preset"
              >
                💾 Save Preset
              </button>
            </div>
          </div>

          {/* Filter Presets */}
          {filterPresets.length > 0 && (
            <div className="presets-section">
              <label className="filter-label">Saved Presets</label>
              <div className="presets-list">
                {filterPresets.map((preset, idx) => (
                  <div key={idx} className="preset-item">
                    <button
                      className="preset-load-btn"
                      onClick={() => loadPreset(preset)}
                    >
                      {preset.name}
                    </button>
                    <button
                      className="preset-delete-btn"
                      onClick={() => deletePreset(preset.name)}
                      title="Delete preset"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Year Range */}
          <div className="filter-section">
            <label className="filter-label">Year Range</label>
            <div className="year-range">
              <input
                type="number"
                placeholder="From"
                min="1900"
                max={new Date().getFullYear()}
                value={yearFrom || ''}
                onChange={(e) => {
                  setYearFrom(e.target.value ? parseInt(e.target.value) : undefined)
                  setCurrentPage(1)
                }}
                className="year-input"
              />
              <span className="year-separator">-</span>
              <input
                type="number"
                placeholder="To"
                min="1900"
                max={new Date().getFullYear()}
                value={yearTo || ''}
                onChange={(e) => {
                  setYearTo(e.target.value ? parseInt(e.target.value) : undefined)
                  setCurrentPage(1)
                }}
                className="year-input"
              />
            </div>
            {onSearch && (
              <button
                className="view-all-results-btn"
                onClick={() => onSearch({
                  query: debouncedQuery || undefined,
                  minYear: yearFrom,
                  maxYear: yearTo,
                  minRating,
                  maxRating,
                  genres: selectedGenres.length > 0 ? selectedGenres : undefined,
                  itemType: itemType || undefined,
                  sortBy,
                  sortOrder,
                })}
              >
                View All Results →
              </button>
            )}
          </div>

          {/* Rating Range */}
          <div className="filter-section">
            <label className="filter-label">Rating Range</label>
            <div className="rating-range">
              <input
                type="number"
                placeholder="Min"
                min="0"
                max="10"
                step="0.5"
                value={minRating || ''}
                onChange={(e) => {
                  setMinRating(e.target.value ? parseFloat(e.target.value) : undefined)
                  setCurrentPage(1)
                }}
                className="rating-input"
              />
              <span className="rating-separator">-</span>
              <input
                type="number"
                placeholder="Max"
                min="0"
                max="10"
                step="0.5"
                value={maxRating || ''}
                onChange={(e) => {
                  setMaxRating(e.target.value ? parseFloat(e.target.value) : undefined)
                  setCurrentPage(1)
                }}
                className="rating-input"
              />
            </div>
          </div>

          {/* Genres */}
          <div className="filter-section">
            <label className="filter-label">Genres</label>
            <div className="genre-tags">
              {COMMON_GENRES.map((genre) => (
                <button
                  key={genre}
                  className={`genre-tag ${selectedGenres.includes(genre) ? 'selected' : ''}`}
                  onClick={() => toggleGenre(genre)}
                >
                  {genre}
                </button>
              ))}
            </div>
          </div>

          {/* Sort Options */}
          <div className="filter-section">
            <label className="filter-label">Sort By</label>
            <div className="sort-controls">
              <select
                value={sortBy}
                onChange={(e) => {
                  setSortBy(e.target.value)
                  setCurrentPage(1)
                }}
                className="sort-select"
              >
                <option value="title">Title (A-Z)</option>
                <option value="rating">Rating (High to Low)</option>
                <option value="year">Year (Newest)</option>
                <option value="added">Recently Added</option>
              </select>
              <button
                className={`sort-order-btn ${sortOrder === 'asc' ? 'asc' : 'desc'}`}
                onClick={() => {
                  setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
                  setCurrentPage(1)
                }}
                title={`Sort ${sortOrder === 'asc' ? 'ascending' : 'descending'}`}
              >
                {sortOrder === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isLoading && searchQuery === debouncedQuery ? (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Searching library...</p>
        </div>
      ) : result.items.length > 0 ? (
        <>
          <div className="results-info">
            Found <strong>{result.total}</strong> item{result.total !== 1 ? 's' : ''}
          </div>

          <div className="items-grid">
            {result.items.map((item: any) => (
              <div key={item.id} className="item-card">
                <div className="item-card-header">
                  <span className="item-type-badge">{item.item_type === 'movie' ? '🎬' : '📺'}</span>
                </div>
                <div className="item-card-content">
                  <h3 className="item-title">{item.title}</h3>
                  {item.year && <p className="item-year">{item.year}</p>}
                  {item.plot && <p className="item-plot">{item.plot.substring(0, 80)}...</p>}
                  <div className="item-progress" style={{ marginTop: '0.75rem' }}>
                    <ProgressBar progress={0} isWatched={false} showLabel={false} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button
                className={`pagination-button ${currentPage === 1 ? 'disabled' : ''}`}
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
              >
                ← Previous
              </button>
              <span className="pagination-info">
                Page {currentPage} of {totalPages} 
                <span className="pagination-count">({result.total} total)</span>
              </span>
              <button
                className={`pagination-button ${currentPage === totalPages ? 'disabled' : ''}`}
                onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage === totalPages}
              >
                Next →
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="empty-state">
          <p>No items found</p>
          {searchQuery && <p className="empty-hint">Try a different search term</p>}
        </div>
      )}

      {/* Save Preset Modal */}
      {showPresetModal && (
        <div className="modal-overlay" onClick={() => setShowPresetModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Save Filter Preset</h3>
            <input
              type="text"
              placeholder="Preset name (e.g., 'Sci-Fi 2020s')"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              className="modal-input"
              autoFocus
              onKeyPress={(e) => e.key === 'Enter' && handleSavePreset()}
            />
            <div className="modal-buttons">
              <button className="cancel-button" onClick={() => setShowPresetModal(false)}>
                Cancel
              </button>
              <button className="primary-button" onClick={handleSavePreset}>
                Save Preset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
