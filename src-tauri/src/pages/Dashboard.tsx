import { useState, useEffect } from 'react'
import { useDashboard } from '../hooks/useLibrary'
import { api } from '../services/api'
import ProgressBar from '../components/ProgressBar'

interface WatchedItem {
  id: string
  title: string
  watched_at: string
  item_type: string
  year?: number
}

interface LibraryHealth {
  total_items: number
  with_metadata: number
  without_metadata: number
  unmatched_count: number
}

export default function Dashboard() {
  const { data, isLoading, error, load } = useDashboard()
  const [lastRefresh, setLastRefresh] = useState<string | null>(null)
  const [recentlyWatched] = useState<WatchedItem[]>([])
  const [libraryHealth, setLibraryHealth] = useState<LibraryHealth | null>(null)
  const [loadingWatchHistory] = useState(false)

  useEffect(() => {
    const loadDashboard = async () => {
      load()
      
      // Load library stats for health indicators
      try {
        const stats = await api.getLibraryStats()
        if (stats) {
          const withMetadata = stats.with_metadata || stats.matched_items || 0
          const totalItems = stats.total_items || 0
          setLibraryHealth({
            total_items: totalItems,
            with_metadata: withMetadata,
            without_metadata: totalItems - withMetadata,
            unmatched_count: totalItems - withMetadata,
          })
        }
      } catch (err) {
        console.error('Failed to load library stats:', err)
      }

      setLastRefresh(new Date().toLocaleTimeString())
    }

    loadDashboard()
  }, [load])

  const getMediaIcon = (type: string) => {
    return type === 'tv' ? '📺' : '🎬'
  }

  const handleRefresh = async () => {
    await load()
    setLastRefresh(new Date().toLocaleTimeString())
  }

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr)
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return dateStr
    }
  }

  const getHealthStatus = (health: LibraryHealth | null) => {
    if (!health) return 'Loading...'
    const metadataPercent = health.total_items > 0 ? Math.round((health.with_metadata / health.total_items) * 100) : 0
    return `${metadataPercent}% matched`
  }

  const libraryHealthStyle: React.CSSProperties = {
    backgroundColor: 'rgba(100, 200, 255, 0.1)',
    border: '1px solid rgba(100, 200, 255, 0.3)',
    borderRadius: '12px',
    padding: '20px',
    marginBottom: '30px',
    backdropFilter: 'blur(10px)',
  }

  const healthTitleStyle: React.CSSProperties = {
    marginTop: 0,
    marginBottom: '15px',
    fontSize: '1.1rem',
    fontWeight: '600',
    color: '#64c8ff',
  }

  const healthGridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '15px',
  }

  const healthStatStyle: React.CSSProperties = {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: '8px',
    padding: '15px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  }

  const statLabelStyle: React.CSSProperties = {
    fontSize: '0.85rem',
    color: '#aaa',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  }

  const statValueStyle: React.CSSProperties = {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    color: '#fff',
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Welcome to CineVault</h1>
        <p className="dashboard-subtitle">Your personal media library</p>
        {lastRefresh && <p className="last-refresh">Last updated: {lastRefresh}</p>}
        <button onClick={handleRefresh} className="refresh-button" disabled={isLoading}>
          {isLoading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* Library Health Panel */}
      {libraryHealth && (
        <div style={libraryHealthStyle}>
          <h3 style={healthTitleStyle}>📊 Library Health</h3>
          <div style={healthGridStyle}>
            <div style={healthStatStyle}>
              <span style={statLabelStyle}>Total Items</span>
              <span style={statValueStyle}>{libraryHealth.total_items}</span>
            </div>
            <div style={healthStatStyle}>
              <span style={statLabelStyle}>With Metadata</span>
              <span style={statValueStyle}>{libraryHealth.with_metadata}</span>
            </div>
            <div style={healthStatStyle}>
              <span style={statLabelStyle}>Unmatched</span>
              <span style={statValueStyle}>{libraryHealth.unmatched_count}</span>
            </div>
            <div style={healthStatStyle}>
              <span style={statLabelStyle}>Coverage</span>
              <span style={statValueStyle}>{getHealthStatus(libraryHealth)}</span>
            </div>
          </div>
        </div>
      )}

      <div className="dashboard-section">
        <h2 className="section-title">📺 Continue Watching</h2>
        {isLoading && data === null ? (
          <p className="empty-state">Loading...</p>
        ) : data?.continue_watching && data.continue_watching.length > 0 ? (
          <div className="items-grid">
            {data.continue_watching.map((item) => (
              <div key={item.id} className="item-card">
                <div className="item-card-header">
                  <span className="item-badge">{getMediaIcon(item.item_type)}</span>
                </div>
                <div className="item-card-content">
                  <p className="item-title">{item.title}</p>
                  {item.year && <p className="item-year">{item.year}</p>}
                  <div style={{ marginTop: '0.75rem' }}>
                    <ProgressBar progress={45} isWatched={false} showLabel={true} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-state">No items in progress. Start watching something!</p>
        )}
      </div>

      <div className="dashboard-section">
        <h2 className="section-title">✨ Recently Added</h2>
        {isLoading && data === null ? (
          <p className="empty-state">Loading...</p>
        ) : data?.recently_added && data.recently_added.length > 0 ? (
          <div className="items-grid">
            {data.recently_added.map((item) => (
              <div key={item.id} className="item-card">
                <div className="item-card-header">
                  <span className="item-badge">{getMediaIcon(item.item_type)}</span>
                </div>
                <div className="item-card-content">
                  <p className="item-title">{item.title}</p>
                  {item.year && <p className="item-year">{item.year}</p>}
                  {item.plot && <p className="item-plot">{item.plot.substring(0, 100)}...</p>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-state">No items added yet</p>
        )}
      </div>

      <div className="dashboard-section">
        <h2 className="section-title">🕐 Recently Watched</h2>
        {recentlyWatched.length > 0 ? (
          <div className="items-grid">
            {recentlyWatched.map((item) => (
              <div key={`${item.id}-${item.watched_at}`} className="item-card">
                <div className="item-card-header">
                  <span className="item-badge">{getMediaIcon(item.item_type)}</span>
                </div>
                <div className="item-card-content">
                  <p className="item-title">{item.title}</p>
                  {item.year && <p className="item-year">{item.year}</p>}
                  <p className="item-subtitle" style={{ marginTop: '0.5rem', fontSize: '0.85rem', opacity: 0.8 }}>
                    Watched {formatDate(item.watched_at)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : loadingWatchHistory ? (
          <p className="empty-state">Loading...</p>
        ) : (
          <p className="empty-state">No watch history yet</p>
        )}
      </div>
    </div>
  )
}
