import { useState, useCallback } from 'react'
import { cinevaultApi, LibraryStats, SearchResult, DashboardData } from '../services/api'

export function useLibraryStats() {
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)
      const data = await cinevaultApi.getLibraryStats()
      setStats(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats')
    } finally {
      setIsLoading(false)
    }
  }, [])

  return { stats, isLoading, error, load }
}

export function useDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)
      const dashboardData = await cinevaultApi.getDashboardItems()
      setData(dashboardData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard')
    } finally {
      setIsLoading(false)
    }
  }, [])

  return { data, isLoading, error, load }
}

export function useLibrarySearch() {
  const [result, setResult] = useState<SearchResult>({
    items: [],
    total: 0,
    page: 1,
    page_size: 20,
  })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = useCallback(
    async (
      query: string,
      itemType?: string,
      page: number = 1,
      pageSize: number = 20,
    ) => {
      try {
        setIsLoading(true)
        setError(null)
        const searchResult = await cinevaultApi.searchLibrary(query, itemType, page, pageSize)
        setResult(searchResult)
        return searchResult
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to search library'
        setError(errorMsg)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [],
  )

  return { result, isLoading, error, search }
}

export function useItemDetail(itemId: string) {
  const [item, setItem] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)
      const itemData = await cinevaultApi.getItemDetail(itemId)
      setItem(itemData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load item')
    } finally {
      setIsLoading(false)
    }
  }, [itemId])

  return { item, isLoading, error, load }
}

export function usePlaybackProgress() {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const saveProgress = useCallback(
    async (itemId: string, progressMs: number, completed: boolean) => {
      try {
        setIsLoading(true)
        setError(null)
        await cinevaultApi.saveProgress(itemId, progressMs, completed)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save progress')
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [],
  )

  return { isLoading, error, saveProgress }
}

export function useAdvancedSearch() {
  const [result, setResult] = useState<any>({
    items: [],
    total: 0,
    limit: 20,
    offset: 0,
  })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = useCallback(
    async (
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
      offset: number = 0,
    ) => {
      try {
        setIsLoading(true)
        setError(null)
        const searchResult = await cinevaultApi.advancedSearch(
          query,
          itemType,
          yearFrom,
          yearTo,
          genres,
          minRating,
          maxRating,
          sortBy,
          sortOrder,
          limit,
          offset,
        )
        setResult(searchResult)
        return searchResult
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to perform advanced search'
        setError(errorMsg)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [],
  )

  return { result, isLoading, error, search }
}
