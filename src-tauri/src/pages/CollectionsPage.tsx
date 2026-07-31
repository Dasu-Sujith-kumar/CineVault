import { useState, useEffect } from 'react'
import { cinevaultApi, LibraryItem, Collection as ApiCollection } from '../services/api'

interface Collection extends ApiCollection {
  item_count: number
}

interface CollectionWithItems extends Collection {
  items: LibraryItem[]
}

export default function CollectionsPage() {
  const [collections, setCollections] = useState<Collection[]>([])
  const [filteredCollections, setFilteredCollections] = useState<Collection[]>([])
  const [selectedCollection, setSelectedCollection] = useState<CollectionWithItems | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const [newCollectionName, setNewCollectionName] = useState('')
  const [newCollectionDescription, setNewCollectionDescription] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'manual' | 'auto'>('all')
  const [sortBy, setSortBy] = useState<'name' | 'items' | 'recent'>('name')

  useEffect(() => {
    loadCollections()
  }, [])

  useEffect(() => {
    filterAndSortCollections()
  }, [collections, searchQuery, filterType, sortBy])

  const filterAndSortCollections = () => {
    let filtered = collections.slice()

    // Filter by type
    if (filterType === 'manual') {
      filtered = filtered.filter(c => !c.is_auto_generated)
    } else if (filterType === 'auto') {
      filtered = filtered.filter(c => c.is_auto_generated)
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(c =>
        c.name.toLowerCase().includes(query) ||
        (c.description && c.description.toLowerCase().includes(query))
      )
    }

    // Sort
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'items':
          return b.item_count - a.item_count
        case 'recent':
          return (new Date(b.updated_at || 0).getTime()) - (new Date(a.updated_at || 0).getTime())
        case 'name':
        default:
          return a.name.localeCompare(b.name)
      }
    })

    setFilteredCollections(filtered)
  }

  const loadCollections = async () => {
    try {
      setIsLoading(true)
      setError(null)
      const result = await cinevaultApi.getCollections() as Collection[]
      setCollections(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load collections')
      console.error('Failed to load collections:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCreateCollection = async () => {
    if (!newCollectionName.trim()) {
      setError('Collection name cannot be empty')
      return
    }

    try {
      await cinevaultApi.createCollection(newCollectionName, newCollectionDescription || undefined)
      await loadCollections()
      setNewCollectionName('')
      setNewCollectionDescription('')
      setShowCreateModal(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create collection')
    }
  }

  const handleDeleteCollection = async (collectionId: string) => {
    if (!window.confirm('Are you sure you want to delete this collection? This cannot be undone.')) return

    try {
      await cinevaultApi.deleteCollection(collectionId)
      await loadCollections()
      setSelectedCollection(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete collection')
    }
  }

  const handleViewCollection = async (collection: Collection) => {
    try {
      const items = await cinevaultApi.getCollectionItems(collection.id) as LibraryItem[]
      setSelectedCollection({
        ...collection,
        items,
      })
      setShowDetailsModal(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load collection items')
    }
  }

  const handleRemoveFromCollection = async (collectionId: string, itemId: string) => {
    try {
      await cinevaultApi.removeFromCollection(collectionId, itemId)
      // Reload collection details
      if (selectedCollection && selectedCollection.id === collectionId) {
        const items = await cinevaultApi.getCollectionItems(collectionId) as LibraryItem[]
        setSelectedCollection({
          ...selectedCollection,
          items,
        })
      }
      // Reload collections list
      await loadCollections()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove item from collection')
    }
  }

  const calculateCollectionStats = (collection: CollectionWithItems) => {
    const items = collection.items
    const movieCount = items.filter(i => i.item_type === 'movie').length
    const tvCount = items.filter(i => i.item_type === 'tv').length
    
    // Calculate average year
    const yearsWithData = items.filter(i => i.year).map(i => i.year!) as number[]
    const avgYear = yearsWithData.length > 0 
      ? Math.round(yearsWithData.reduce((a, b) => a + b, 0) / yearsWithData.length)
      : null

    // Get all genres
    const allGenres = items
      .flatMap(i => i.genres || [])
      .reduce((acc, genre) => {
        acc[genre] = (acc[genre] || 0) + 1
        return acc
      }, {} as Record<string, number>)

    const topGenres = Object.entries(allGenres)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([genre]) => genre)

    return { movieCount, tvCount, avgYear, topGenres }
  }

  return (
    <div className="collections-page">
      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <div className="page-header">
        <div>
          <h1>Collections</h1>
          <p className="page-subtitle">{filteredCollections.length} of {collections.length} collection{collections.length !== 1 ? 's' : ''}</p>
        </div>
        <button className="primary-button" onClick={() => setShowCreateModal(true)}>
          + New Collection
        </button>
      </div>

      {/* Search and Filter Controls */}
      <div className="collections-toolbar">
        <div className="search-box">
          <input
            type="text"
            placeholder="Search collections..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          {searchQuery && (
            <button
              className="clear-search-btn"
              onClick={() => setSearchQuery('')}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        <div className="filter-controls">
          <select value={filterType} onChange={(e) => setFilterType(e.target.value as any)} className="filter-select">
            <option value="all">All Collections</option>
            <option value="manual">Manual Only</option>
            <option value="auto">Auto-Generated Only</option>
          </select>

          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="filter-select">
            <option value="name">Sort by Name</option>
            <option value="items">Sort by Items Count</option>
            <option value="recent">Sort by Recent</option>
          </select>
        </div>
      </div>

      <div className="page-header">
        <div>
          <h1>Collections</h1>
          <p className="page-subtitle">{collections.length} collection{collections.length !== 1 ? 's' : ''}</p>
        </div>
        <button className="primary-button" onClick={() => setShowCreateModal(true)}>
          + New Collection
        </button>
      </div>

      {isLoading ? (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading collections...</p>
        </div>
      ) : filteredCollections.length > 0 ? (
        <div className="collections-grid">
          {filteredCollections.map((collection) => (
            <div
              key={collection.id}
              className="collection-card"
              onClick={() => handleViewCollection(collection)}
              style={{ cursor: 'pointer' }}
            >
              <div className="collection-card-badge">
                {collection.is_auto_generated && <span className="auto-generated-badge">Auto</span>}
              </div>
              <div className="collection-header">
                <div>
                  <h3>{collection.name}</h3>
                  {collection.description && <p className="collection-description">{collection.description}</p>}
                </div>
              </div>
              <div className="collection-stats">
                <span className="item-count">{collection.item_count} item{collection.item_count !== 1 ? 's' : ''}</span>
              </div>
              <div className="collection-actions">
                {!collection.is_auto_generated && (
                  <button
                    className="delete-button"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteCollection(collection.id)
                    }}
                    title="Delete collection"
                  >
                    🗑️
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <p>{searchQuery ? 'No collections match your search.' : 'No collections yet.'}</p>
          <p className="empty-hint">{searchQuery ? 'Try adjusting your search.' : 'Create a new collection to organize your media!'}</p>
        </div>
      )}

      {/* Create Collection Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Create New Collection</h3>
            <input
              type="text"
              placeholder="Collection name (e.g., My Favorites)"
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              className="modal-input"
              autoFocus
            />
            <textarea
              placeholder="Description (optional)"
              value={newCollectionDescription}
              onChange={(e) => setNewCollectionDescription(e.target.value)}
              className="modal-input modal-textarea"
              rows={3}
            />
            <div className="modal-buttons">
              <button className="cancel-button" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button className="primary-button" onClick={handleCreateCollection}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Collection Details Modal */}
      {showDetailsModal && selectedCollection && (
        <div className="modal-overlay" onClick={() => setShowDetailsModal(false)}>
          <div className="modal-content modal-large" onClick={(e) => e.stopPropagation()}>
            <div className="collection-details-header">
              <div>
                <h2>{selectedCollection.name}</h2>
                {selectedCollection.description && <p className="modal-description">{selectedCollection.description}</p>}
              </div>
              <button className="close-modal-button" onClick={() => setShowDetailsModal(false)}>
                ✕
              </button>
            </div>

            {/* Collection Statistics */}
            {(() => {
              const stats = calculateCollectionStats(selectedCollection)
              return (
                <div className="collection-stats-panel">
                  <div className="stat-box">
                    <span className="stat-label">Total Items</span>
                    <span className="stat-value">{selectedCollection.items.length}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-label">Movies</span>
                    <span className="stat-value">{stats.movieCount}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-label">TV Shows</span>
                    <span className="stat-value">{stats.tvCount}</span>
                  </div>
                  {stats.avgYear && (
                    <div className="stat-box">
                      <span className="stat-label">Avg Year</span>
                      <span className="stat-value">{stats.avgYear}</span>
                    </div>
                  )}
                  {stats.topGenres.length > 0 && (
                    <div className="stat-box stat-box-wide">
                      <span className="stat-label">Top Genres</span>
                      <div className="stat-genres">
                        {stats.topGenres.map(g => (
                          <span key={g} className="genre-badge">{g}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })()}

            <div className="collection-items-list">
              {selectedCollection.items.length > 0 ? (
                <div className="items-grid">
                  {selectedCollection.items.map((item) => (
                    <div key={item.id} className="item-in-collection">
                      <div className="item-poster-small">
                        <span>{item.item_type === 'movie' ? '🎬' : '📺'}</span>
                      </div>
                      <div className="item-info-small">
                        <h4>{item.title}</h4>
                        {item.year && <p>{item.year}</p>}
                      </div>
                      <button
                        className="remove-button"
                        onClick={() => handleRemoveFromCollection(selectedCollection.id, item.id)}
                        title="Remove from collection"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-message">No items in this collection yet</p>
              )}
            </div>

            <div className="modal-buttons">
              <button className="cancel-button" onClick={() => setShowDetailsModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
