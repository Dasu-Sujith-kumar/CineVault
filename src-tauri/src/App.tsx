import { useState, useEffect } from 'react'
import { api } from './services/api'
import Dashboard from './pages/Dashboard'
import LibraryPage from './pages/LibraryPage'
import { SearchResultsPage } from './pages/SearchResultsPage'
import CollectionsPage from './pages/CollectionsPage'
import StatisticsPage from './pages/StatisticsPage'
import SettingsPage from './pages/SettingsPage'
import './App.css'

interface SearchQueryState {
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

function App() {
  const [currentPage, setCurrentPage] = useState<'dashboard' | 'library' | 'collections' | 'statistics' | 'settings' | 'search-results'>('dashboard')
  const [searchQuery, setSearchQuery] = useState<SearchQueryState>({})
  const [isLoading, setIsLoading] = useState(true)
  const [scanProgress, setScanProgress] = useState('')

  useEffect(() => {
    const initializeApp = async () => {
      try {
        setIsLoading(true)
        setScanProgress('Loading library roots...')

        // Get all library roots
        const roots = await api.getLibraryRoots()
        
        if (roots && roots.length > 0) {
          setScanProgress(`Found ${roots.length} library root(s). Starting scan...`)

          // Auto-scan all roots
          for (const root of roots) {
            setScanProgress(`Scanning ${root.library_kind} library...`)
            try {
              await api.scanLibraryRoot(root.id)
            } catch (err) {
              console.error(`Failed to scan root ${root.id}:`, err)
            }
          }
        }

        setScanProgress('Loading complete!')
        setTimeout(() => setIsLoading(false), 500)
      } catch (err) {
        console.error('Failed to initialize app:', err)
        setIsLoading(false)
      }
    }

    initializeApp()
  }, [])

  return (
    <div className="app">
      <nav className="navbar">
        <div className="navbar-brand">
          <h1>🎬 CineVault</h1>
          {scanProgress && <span className="scan-status">{scanProgress}</span>}
        </div>
        <div className="navbar-menu">
          <button 
            className={`nav-button ${currentPage === 'dashboard' ? 'active' : ''}`}
            onClick={() => setCurrentPage('dashboard')}
          >
            Dashboard
          </button>
          <button 
            className={`nav-button ${currentPage === 'library' ? 'active' : ''}`}
            onClick={() => setCurrentPage('library')}
          >
            Library
          </button>
          <button 
            className={`nav-button ${currentPage === 'collections' ? 'active' : ''}`}
            onClick={() => setCurrentPage('collections')}
          >
            Collections
          </button>
          <button 
            className={`nav-button ${currentPage === 'statistics' ? 'active' : ''}`}
            onClick={() => setCurrentPage('statistics')}
          >
            Statistics
          </button>
          <button 
            className={`nav-button ${currentPage === 'settings' ? 'active' : ''}`}
            onClick={() => setCurrentPage('settings')}
          >
            Settings
          </button>
        </div>
      </nav>

      <main className="main-content">
        {isLoading && <div className="loading">
          <div className="loading-spinner"></div>
          <p>{scanProgress || 'Initializing...'}</p>
        </div>}
        
        {!isLoading && currentPage === 'dashboard' && <Dashboard />}
        {!isLoading && currentPage === 'library' && <LibraryPage onSearch={(query) => {
          setSearchQuery(query)
          setCurrentPage('search-results')
        }} />}
        {!isLoading && currentPage === 'search-results' && <SearchResultsPage searchQuery={searchQuery} onBack={() => setCurrentPage('library')} />}
        {!isLoading && currentPage === 'collections' && <CollectionsPage />}
        {!isLoading && currentPage === 'statistics' && <StatisticsPage />}
        {!isLoading && currentPage === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}

export default App
