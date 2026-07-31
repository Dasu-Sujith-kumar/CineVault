import { useState, useEffect } from 'react'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { api } from '../services/api'
import '../StatisticsPage.css'

interface ViewingStats {
  total_items_watched: number
  total_hours_watched: number
  watches_by_type: Array<{ type: string; count: number }>
  most_watched_items: Array<{
    id: string
    title: string
    type: string
    watch_count: number
  }>
  watch_trends_30_days: Array<{ date: string; count: number }>
}

interface DailyStats {
  date: string
  watch_count: number
  hours_watched: number
}

export default function StatisticsPage() {
  const [stats, setStats] = useState<ViewingStats | null>(null)
  const [dailyStats, setDailyStats] = useState<DailyStats[]>([])
  const [favoriteGenres, setFavoriteGenres] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [statsTimeframe, setStatsTimeframe] = useState(30)

  useEffect(() => {
    loadStatistics()
  }, [])

  useEffect(() => {
    loadDailyStats()
  }, [statsTimeframe])

  const loadStatistics = async () => {
    try {
      setLoading(true)
      const [viewingStats, genres] = await Promise.all([
        api.getViewingStatistics(),
        api.getFavoriteGenres(10),
      ])
      setStats(viewingStats)
      setFavoriteGenres(genres || [])
    } catch (error) {
      console.error('Failed to load statistics:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadDailyStats = async () => {
    try {
      const stats = await api.getDailyWatchStats(statsTimeframe)
      setDailyStats(stats || [])
    } catch (error) {
      console.error('Failed to load daily stats:', error)
    }
  }

  const formatHours = (hours: number): string => {
    if (hours < 1) return `${Math.round(hours * 60)}m`
    if (hours < 24) return `${hours.toFixed(1)}h`
    const days = Math.floor(hours / 24)
    const remainingHours = Math.round((hours % 24) * 10) / 10
    return `${days}d ${remainingHours}h`
  }

  if (loading) {
    return (
      <div className="stats-page">
        <div className="stats-header">
          <h1>Viewing Statistics</h1>
        </div>
        <div className="loading-state">
          <p>Loading your statistics...</p>
        </div>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="stats-page">
        <div className="stats-header">
          <h1>Viewing Statistics</h1>
        </div>
        <div className="error-state">
          <p>Unable to load statistics. Start watching to see your stats!</p>
        </div>
      </div>
    )
  }

  return (
    <div className="stats-page">
      <div className="stats-header">
        <h1>Viewing Statistics</h1>
        <p className="stats-subtitle">Track your watching habits and preferences</p>
      </div>

      {/* Summary Cards */}
      <div className="stats-summary">
        <div className="stat-card highlight">
          <div className="stat-value">{stats.total_items_watched}</div>
          <div className="stat-label">Items Watched</div>
        </div>
        <div className="stat-card highlight">
          <div className="stat-value">{formatHours(stats.total_hours_watched)}</div>
          <div className="stat-label">Total Time Watched</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {stats.watch_trends_30_days.length > 0
              ? stats.watch_trends_30_days.reduce((sum, d) => sum + d.count, 0)
              : 0}
          </div>
          <div className="stat-label">Watches (30 days)</div>
        </div>
      </div>

      {/* Watch by Type - Pie Chart */}
      <div className="stats-grid">
        <div className="stat-section">
          <h3 className="section-title">Watches by Type</h3>
          {stats.watches_by_type.length === 0 ? (
            <p className="empty-message">No watch data yet</p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={stats.watches_by_type.map(({ type, count }) => ({
                    name: type === 'movie' ? '🎬 Movies' : '📺 TV Shows',
                    value: count,
                  }))}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent = 0 }) =>
                    `${name} ${(percent * 100).toFixed(0)}%`
                  }
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  <Cell fill="#667eea" />
                  <Cell fill="#764ba2" />
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Most Watched */}
        <div className="stat-section">
          <h3 className="section-title">Most Watched Items</h3>
          <div className="most-watched-list">
            {stats.most_watched_items.length === 0 ? (
              <p className="empty-message">No watch history yet</p>
            ) : (
              stats.most_watched_items.slice(0, 5).map((item, index) => (
                <div key={item.id} className="most-watched-item">
                  <span className="rank">#{index + 1}</span>
                  <div className="item-details">
                    <div className="item-name">{item.title}</div>
                    <div className="item-type">
                      {item.type === 'movie' ? '🎬 Movie' : '📺 Show'}
                    </div>
                  </div>
                  <span className="watch-count">{item.watch_count}x</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Favorite Genres */}
      {favoriteGenres.length > 0 && (
        <div className="stat-section full-width">
          <h3 className="section-title">Favorite Genres</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={favoriteGenres
                .slice(0, 10)
                .map((item: any) => ({
                  name:
                    item.genres && Array.isArray(item.genres) && item.genres.length > 0
                      ? item.genres[0]
                      : 'Unknown',
                  watches: item.watch_count || 1,
                }))}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="name" stroke="#999" />
              <YAxis stroke="#999" />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #333',
                  borderRadius: '4px',
                }}
              />
              <Bar dataKey="watches" fill="#667eea" name="Watches" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Daily Watch Trends */}
      <div className="stat-section full-width">
        <div className="trends-header">
          <h3 className="section-title">Watch Activity</h3>
          <div className="timeframe-selector">
            <button
              className={`timeframe-btn ${statsTimeframe === 7 ? 'active' : ''}`}
              onClick={() => setStatsTimeframe(7)}
            >
              7 days
            </button>
            <button
              className={`timeframe-btn ${statsTimeframe === 30 ? 'active' : ''}`}
              onClick={() => setStatsTimeframe(30)}
            >
              30 days
            </button>
            <button
              className={`timeframe-btn ${statsTimeframe === 90 ? 'active' : ''}`}
              onClick={() => setStatsTimeframe(90)}
            >
              90 days
            </button>
          </div>
        </div>

        {dailyStats.length === 0 ? (
          <p className="empty-message">No watch activity in this timeframe</p>
        ) : (
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={dailyStats}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis
                dataKey="date"
                tickFormatter={(date) =>
                  new Date(date).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })
                }
                stroke="#999"
              />
              <YAxis stroke="#999" />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #333',
                  borderRadius: '4px',
                }}
                labelFormatter={(date) =>
                  new Date(date).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })
                }
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="watch_count"
                stroke="#667eea"
                strokeWidth={2}
                dot={{ fill: '#667eea', r: 4 }}
                activeDot={{ r: 6 }}
                name="Watches"
              />
              <Line
                type="monotone"
                dataKey="hours_watched"
                stroke="#764ba2"
                strokeWidth={2}
                dot={{ fill: '#764ba2', r: 4 }}
                activeDot={{ r: 6 }}
                name="Hours Watched"
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Stats Info */}
      <div className="stats-info">
        <p>📊 Statistics update in real-time as you watch content</p>
      </div>
    </div>
  )
}
