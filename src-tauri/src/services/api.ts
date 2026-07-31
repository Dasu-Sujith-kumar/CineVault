import { invoke } from '@tauri-apps/api/tauri'

export interface LibraryItem {
  id: string
  title: string
  item_type: string
  year?: number
  plot?: string
  genres?: string[]
  poster_path?: string
  file_path?: string
}

export interface SearchFilters {
  item_type?: string
  genres?: string[]
  year_from?: number
  year_to?: number
  show_adult: boolean
  sort_by: string
  sort_order: string
}

export interface SearchResult {
  items: LibraryItem[]
  total: number
  page: number
  page_size: number
}

export interface LibraryStats {
  total_items: number
  total_movies: number
  total_tv_shows: number
  total_episodes: number
  matched_items: number
  unmatched_items: number
  with_metadata?: number
}

export interface DashboardData {
  continue_watching: LibraryItem[]
  recently_added: LibraryItem[]
}

export interface Episode {
  id: string
  show_id: string
  season: number
  episode: number
  title: string
  plot?: string
  air_date?: string
}

export interface Collection {
  id: string
  name: string
  description?: string
  is_auto_generated: boolean
  created_at?: string
  updated_at?: string
}

export interface LibraryRoot {
  id: string
  path: string
  library_kind: string
  created_at: string
}

export const cinevaultApi = {
  /**
   * Get library statistics
   */
  async getLibraryStats(): Promise<LibraryStats> {
    try {
      return await invoke('get_library_stats')
    } catch (error) {
      console.error('Failed to get library stats:', error)
      throw error
    }
  },

  /**
   * Search library with filters
   */
  async searchLibrary(
    query: string,
    itemType?: string,
    page: number = 1,
    pageSize: number = 20,
  ): Promise<SearchResult> {
    try {
      return await invoke('search_library', {
        query,
        itemType,
        page,
        pageSize,
      })
    } catch (error) {
      console.error('Failed to search library:', error)
      throw error
    }
  },

  /**
   * Get dashboard items (continue watching, recently added)
   */
  async getDashboardItems(): Promise<DashboardData> {
    try {
      return await invoke('get_dashboard_items')
    } catch (error) {
      console.error('Failed to get dashboard items:', error)
      throw error
    }
  },

  /**
   * Get single item detail
   */
  async getItemDetail(itemId: string): Promise<LibraryItem> {
    try {
      return await invoke('get_item_detail', { itemId })
    } catch (error) {
      console.error('Failed to get item detail:', error)
      throw error
    }
  },

  /**
   * Save playback progress
   */
  async saveProgress(itemId: string, progressMs: number, completed: boolean): Promise<void> {
    try {
      await invoke('save_progress', {
        itemId,
        progressMs,
        completed,
      })
    } catch (error) {
      console.error('Failed to save progress:', error)
      throw error
    }
  },

  /**
   * Get all collections
   */
  async getCollections() {
    try {
      return await invoke('get_collections')
    } catch (error) {
      console.error('Failed to get collections:', error)
      throw error
    }
  },

  /**
   * Get items in a collection
   */
  async getCollectionItems(collectionId: string) {
    try {
      return await invoke('get_collection_items', { collectionId })
    } catch (error) {
      console.error('Failed to get collection items:', error)
      throw error
    }
  },

  /**
   * Create a new collection
   */
  async createCollection(name: string, description?: string): Promise<string> {
    try {
      return await invoke('create_collection', { name, description })
    } catch (error) {
      console.error('Failed to create collection:', error)
      throw error
    }
  },

  /**
   * Add item to collection
   */
  async addToCollection(collectionId: string, itemId: string): Promise<void> {
    try {
      await invoke('add_to_collection', { collectionId, itemId })
    } catch (error) {
      console.error('Failed to add to collection:', error)
      throw error
    }
  },

  /**
   * Remove item from collection
   */
  async removeFromCollection(collectionId: string, itemId: string): Promise<void> {
    try {
      await invoke('remove_from_collection', { collectionId, itemId })
    } catch (error) {
      console.error('Failed to remove from collection:', error)
      throw error
    }
  },

  /**
   * Delete collection
   */
  async deleteCollection(collectionId: string): Promise<void> {
    try {
      await invoke('delete_collection', { collectionId })
    } catch (error) {
      console.error('Failed to delete collection:', error)
      throw error
    }
  },

  /**
   * Get episodes for a TV show
   */
  async getEpisodes(itemId: string): Promise<Episode[]> {
    try {
      return await invoke('get_episodes', { itemId })
    } catch (error) {
      console.error('Failed to get episodes:', error)
      return []
    }
  },

  /**
   * Get library roots
   */
  async getLibraryRoots(): Promise<LibraryRoot[]> {
    try {
      return await invoke('get_library_roots')
    } catch (error) {
      console.error('Failed to get library roots:', error)
      throw error
    }
  },

  /**
   * Add library root
   */
  async addLibraryRoot(path: string, libraryKind: string): Promise<LibraryRoot> {
    try {
      return await invoke('add_library_root', { path, libraryKind })
    } catch (error) {
      console.error('Failed to add library root:', error)
      throw error
    }
  },

  /**
   * Remove library root
   */
  async removeLibraryRoot(rootId: string): Promise<void> {
    try {
      await invoke('remove_library_root', { rootId })
    } catch (error) {
      console.error('Failed to remove library root:', error)
      throw error
    }
  },

  /**
   * Scan library root
   */
  async scanLibraryRoot(rootId: string): Promise<string> {
    try {
      return await invoke('scan_library_root', { rootId })
    } catch (error) {
      console.error('Failed to scan library root:', error)
      throw error
    }
  },

  /**
   * Search TMDB for a title
   */
  async searchTmdb(query: string, type: 'movie' | 'tv'): Promise<any[]> {
    try {
      // Use demo mode or actual API key from .env
      const apiKey = (import.meta as any).env?.VITE_TMDB_API_KEY || 'demo'
      const response = await fetch(
        `https://api.themoviedb.org/3/search/${type}?api_key=${apiKey}&query=${encodeURIComponent(query)}`
      )
      const data = await response.json()
      return data.results || []
    } catch (error) {
      console.error('Failed to search TMDB:', error)
      throw error
    }
  },

  /**
   * Update library item with TMDB metadata
   */
  async updateItemMetadata(
    itemId: string,
    metadata: {
      tmdb_id?: number
      title?: string
      year?: number
      plot?: string
      rating?: number
      poster_path?: string
      backdrop_path?: string
      adult?: boolean
      genres?: string[]
    }
  ): Promise<string> {
    try {
      return await invoke('update_item_metadata', { itemId, metadata })
    } catch (error) {
      console.error('Failed to update metadata:', error)
      throw error
    }
  },

  /**
   * Cache TMDB poster and backdrop artwork
   */
  async cacheTmdbArtwork(
    posterPath?: string,
    backdropPath?: string
  ): Promise<string> {
    try {
      return await invoke('cache_tmdb_artwork', {
        posterPath: posterPath || null,
        backdropPath: backdropPath || null,
      })
    } catch (error) {
      console.error('Failed to cache artwork:', error)
      throw error
    }
  },

  /**
   * Save current playback progress for an item
   */
  async savePlaybackProgress(
    itemId: string,
    progressMs: number,
    episodeId?: string
  ): Promise<string> {
    try {
      return await invoke('save_playback_progress', {
        itemId,
        progressMs,
        episodeId: episodeId || null,
      })
    } catch (error) {
      console.error('Failed to save playback progress:', error)
      throw error
    }
  },

  /**
   * Record that user watched an item
   */
  async recordWatchHistory(
    itemId: string,
    durationWatchedMs: number,
    completed: boolean,
    episodeId?: string
  ): Promise<string> {
    try {
      return await invoke('record_watch_history', {
        itemId,
        durationWatchedMs,
        completed,
        episodeId: episodeId || null,
      })
    } catch (error) {
      console.error('Failed to record watch history:', error)
      throw error
    }
  },

  /**
   * Get playback progress for an item
   */
  async getPlaybackProgress(itemId: string): Promise<number | null> {
    try {
      return await invoke('get_playback_progress', { itemId })
    } catch (error) {
      console.error('Failed to get playback progress:', error)
      return null
    }
  },

  /**
   * Get watch history for an item
   */
  async getWatchHistory(itemId: string): Promise<any[]> {
    try {
      return await invoke('get_watch_history', { itemId })
    } catch (error) {
      console.error('Failed to get watch history:', error)
      return []
    }
  },

  /**
   * Scan for external subtitles associated with a media file
   */
  async scanSubtitles(
    itemId: string,
    mediaFilePath: string
  ): Promise<any[]> {
    try {
      return await invoke('scan_subtitles', {
        itemId,
        mediaFilePath,
      })
    } catch (error) {
      console.error('Failed to scan subtitles:', error)
      return []
    }
  },

  /**
   * Load app state
   */
  async loadAppState(): Promise<string | null> {
    try {
      return await invoke('app_state_load', { dbPath: './cinevault.db' })
    } catch (error) {
      console.error('Failed to load app state:', error)
      return null
    }
  },

  /**
   * Save app state
   */
  async saveAppState(stateJson: string): Promise<void> {
    try {
      await invoke('app_state_save', { stateJson })
    } catch (error) {
      console.error('Failed to save app state:', error)
      throw error
    }
  },

  /**
   * Get unmatched library items (items without TMDB metadata)
   */
  async getUnmatchedItems(limit: number = 50): Promise<LibraryItem[]> {
    try {
      return await invoke('get_unmatched_items', { limit })
    } catch (error) {
      console.error('Failed to get unmatched items:', error)
      return []
    }
  },

  /**
   * Get items by genre
   */
  async getItemsByGenre(genre: string, limit: number = 20): Promise<LibraryItem[]> {
    try {
      return await invoke('search_by_genre', { genre, limit })
    } catch (error) {
      console.error('Failed to search by genre:', error)
      return []
    }
  },

  /**
   * Fetch collection data from TMDB and create auto-collection
   */
  async fetchTmdbCollection(
    tmdbId: number,
    collectionName: string
  ): Promise<any> {
    try {
      return await invoke('fetch_tmdb_collection', {
        tmdb_id: tmdbId,
        collection_name: collectionName,
      })
    } catch (error) {
      console.error('Failed to fetch TMDB collection:', error)
      throw error
    }
  },

  /**
   * Add item to a collection
   */
  async addItemToCollection(
    collectionId: string,
    itemId: string
  ): Promise<void> {
    try {
      await invoke('add_item_to_collection', { collectionId, itemId })
    } catch (error) {
      console.error('Failed to add item to collection:', error)
      throw error
    }
  },

  /**
   * Get all collections for an item
   */
  async getCollectionsForItem(itemId: string): Promise<Collection[]> {
    try {
      return await invoke('get_collections_for_item', { itemId })
    } catch (error) {
      console.error('Failed to get item collections:', error)
      return []
    }
  },

  /**
   * Advanced search with multiple filters
   */
  async advancedSearch(
    query?: string,
    itemType?: string,
    yearFrom?: number,
    yearTo?: number,
    genres?: string[],
    minRating?: number,
    maxRating?: number,
    sortBy: string = 'title',
    sortOrder: string = 'asc',
    limit: number = 20,
    offset: number = 0
  ): Promise<any> {
    try {
      return await invoke('advanced_search', {
        query,
        item_type: itemType,
        year_from: yearFrom,
        year_to: yearTo,
        genres,
        min_rating: minRating,
        max_rating: maxRating,
        sort_by: sortBy,
        sort_order: sortOrder,
        limit,
        offset,
      })
    } catch (error) {
      console.error('Failed to perform advanced search:', error)
      return { items: [], total: 0, limit, offset }
    }
  },

  /**
   * Get comprehensive viewing statistics
   */
  async getViewingStatistics(): Promise<any> {
    try {
      return await invoke('get_viewing_statistics')
    } catch (error) {
      console.error('Failed to get viewing statistics:', error)
      return {
        total_items_watched: 0,
        total_hours_watched: 0,
        watches_by_type: [],
        most_watched_items: [],
        watch_trends_30_days: [],
      }
    }
  },

  /**
   * Get favorite genres based on watch history
   */
  async getFavoriteGenres(limit: number = 10): Promise<any[]> {
    try {
      return await invoke('get_favorite_genres', { limit })
    } catch (error) {
      console.error('Failed to get favorite genres:', error)
      return []
    }
  },

  /**
   * Get daily watch statistics for past N days
   */
  async getDailyWatchStats(days: number = 30): Promise<any[]> {
    try {
      return await invoke('get_daily_watch_stats', { days })
    } catch (error) {
      console.error('Failed to get daily watch stats:', error)
      return []
    }
  },
}

// Default export for convenience
export const api = cinevaultApi
