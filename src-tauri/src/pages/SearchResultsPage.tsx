import { useState, useEffect } from 'react'
import { LibraryItem } from '../services/api'
import { invoke } from '@tauri-apps/api/tauri'

interface SearchParams {
  query?: string
  minYear?: number
  maxYear?: number
  minRating?: number
  maxRating?: number
  genres?: string[]
  itemType?: 'all' | 'movie' | 'tv'
  sortBy?: 'title' | 'rating' | 'year' | 'added'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

interface SearchResultsPageProps {
  searchQuery: {
    query?: string
    minYear?: number
    maxYear?: number
    minRating?: number
    maxRating?: number
    genres?: string[]
    itemType?: 'all' | 'movie' | 'tv'
    sortBy?: 'title' | 'rating' | 'year' | 'added'
    sortOrder?: 'asc' | 'desc'
  }
  onBack: () => void
}

export function SearchResultsPage({ searchQuery, onBack }: SearchResultsPageProps) {
  const [results, setResults] = useState<LibraryItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const resultsPerPage = 20

  // Parse search parameters
  const parseSearchParams = (): SearchParams => {
    return {
      query: searchQuery.query || '',
      minYear: searchQuery.minYear,
      maxYear: searchQuery.maxYear,
      minRating: searchQuery.minRating,
      maxRating: searchQuery.maxRating,
      genres: searchQuery.genres || [],
      itemType: searchQuery.itemType || 'all',
      sortBy: searchQuery.sortBy || 'title',
      sortOrder: searchQuery.sortOrder || 'asc',
      limit: resultsPerPage,
      offset: (currentPage - 1) * resultsPerPage,
    }
  }

  const performSearch = async () => {
    setLoading(true)
    try {
      const params = parseSearchParams()
      const response = await invoke<{ items: LibraryItem[]; total: number }>('advanced_search', {
        query: params.query,
        minYear: params.minYear,
        maxYear: params.maxYear,
        minRating: params.minRating,
        maxRating: params.maxRating,
        genres: (params.genres ?? []).length > 0 ? params.genres : null,
        itemType: params.itemType !== 'all' ? params.itemType : null,
        sortBy: params.sortBy,
        sortOrder: params.sortOrder,
        limit: params.limit,
        offset: params.offset,
      })
      setResults(response.items)
      setTotalCount(response.total)
    } catch (error) {
      console.error('Search error:', error)
      setResults([])
      setTotalCount(0)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    performSearch()
  }, [searchQuery, currentPage])

  const params = parseSearchParams()
  const totalPages = Math.ceil(totalCount / resultsPerPage)

  return (
    <div className="search-results-page">
      <div className="search-header">
        <button className="back-button" onClick={onBack}>← Back to Library</button>
        <h1>Search Results</h1>
        <p className="result-count">
          Found <strong>{totalCount}</strong> result{totalCount !== 1 ? 's' : ''}
          {params.query && ` for "${params.query}"`}
        </p>
      </div>

      {/* Active Filters Display */}
      {(params.query || params.minYear || params.maxYear || params.minRating || params.maxRating || (params.genres ?? []).length > 0 || params.itemType !== 'all') && (
        <div className="active-filters">
          <span className="filter-label">Active filters:</span>
          {params.query && <span className="filter-tag">Query: {params.query}</span>}
          {params.minYear && <span className="filter-tag">Year ≥ {params.minYear}</span>}
          {params.maxYear && <span className="filter-tag">Year ≤ {params.maxYear}</span>}
          {params.minRating && <span className="filter-tag">Rating ≥ {params.minRating}</span>}
          {params.maxRating && <span className="filter-tag">Rating ≤ {params.maxRating}</span>}
          {params.itemType !== 'all' && <span className="filter-tag">Type: {params.itemType}</span>}
          {(params.genres ?? []).map(g => (
            <span key={g} className="filter-tag">Genre: {g}</span>
          ))}
          <span className="sort-info">Sorted by {params.sortBy} ({params.sortOrder})</span>
        </div>
      )}

      {/* Loading State */}
      {loading && <div className="loading">Loading results...</div>}

      {/* Results Grid */}
      {!loading && results.length > 0 && (
        <>
          <div className="results-grid">
            {results.map(item => (
              <div key={item.id} className="result-item">
                {item.poster_path && (
                  <img src={item.poster_path} alt={item.title} className="result-poster" />
                )}
                <div className="result-info">
                  <h3>{item.title}</h3>
                  {item.year && <p className="year">{item.year}</p>}
                  {item.plot && <p className="description">{item.plot.substring(0, 100)}...</p>}
                  <p className="type">{item.item_type}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="pagination">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                className="pagination-btn"
              >
                ← Previous
              </button>

              <div className="page-info">
                Page <strong>{currentPage}</strong> of <strong>{totalPages}</strong>
              </div>

              <button
                onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage === totalPages}
                className="pagination-btn"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}

      {/* No Results */}
      {!loading && results.length === 0 && totalCount === 0 && (
        <div className="no-results">
          <p>No results found</p>
          {params.query && <p className="subtext">Try adjusting your search query or filters</p>}
        </div>
      )}
    </div>
  )
}
