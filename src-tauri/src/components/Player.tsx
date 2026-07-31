import { useState, useEffect, useRef } from 'react'
import { api } from '../services/api'

interface PlayerProps {
  itemId?: string
  title: string
  onClose: () => void
}

interface Subtitle {
  path: string
  language: string
  is_forced: boolean
  is_sdh: boolean
}

export default function Player({ itemId, title, onClose }: PlayerProps) {
  const [isPlaying, setIsPlaying] = useState(true)
  const [progress, setProgress] = useState(0)
  const [duration] = useState(0)
  const [volume, setVolume] = useState(100)
  const [fullscreen, setFullscreen] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [subtitles, setSubtitles] = useState<Subtitle[]>([])
  const [selectedSubtitleIndex, setSelectedSubtitleIndex] = useState<number | null>(null)
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false)
  const [subtitlesLoading, setSubtitlesLoading] = useState(false)
  const controlsTimeout = useRef<number | null>(null)
  const progressSaveInterval = useRef<number | null>(null)

  const ref = useRef<HTMLDivElement>(null)

  // Load saved playback progress on mount
  useEffect(() => {
    const loadProgress = async () => {
      if (itemId) {
        const savedProgress = await api.getPlaybackProgress(itemId)
        if (savedProgress) {
          setProgress(savedProgress)
        }
      }
    }
    loadProgress()
  }, [itemId])

  // Load subtitles
  useEffect(() => {
    const loadSubtitles = async () => {
      if (itemId) {
        setSubtitlesLoading(true)
        try {
          // For now, we'll use itemId and a placeholder path
          // In a real implementation, we'd have the actual file path from the item
          const subs = await api.scanSubtitles(itemId, '')
          setSubtitles(subs)
        } catch (err) {
          console.error('Failed to load subtitles:', err)
          setSubtitles([]) // Graceful fallback
        } finally {
          setSubtitlesLoading(false)
        }
      }
    }
    loadSubtitles()
  }, [itemId])

  // Save progress periodically during playback
  useEffect(() => {
    if (isPlaying && itemId) {
      progressSaveInterval.current = window.setInterval(() => {
        api.savePlaybackProgress(itemId, progress).catch((err) => {
          console.error('Failed to save progress:', err)
        })
      }, 5000) // Save every 5 seconds
    }

    return () => {
      if (progressSaveInterval.current) {
        clearInterval(progressSaveInterval.current)
      }
    }
  }, [isPlaying, itemId, progress])

  // Record watch history when closing
  useEffect(() => {
    return () => {
      if (itemId && progress > 0) {
        const completed = duration > 0 && progress >= duration * 0.9 // 90% watched = completed
        api.recordWatchHistory(itemId, progress, completed).catch((err) => {
          console.error('Failed to record watch history:', err)
        })
      }
    }
  }, [])

  useEffect(() => {
    // In real implementation, would launch MPV or embed player here
    // For now, show a placeholder

    const handleMouseMove = () => {
      setShowControls(true)
      if (controlsTimeout.current) {
        clearTimeout(controlsTimeout.current)
      }
      controlsTimeout.current = window.setTimeout(() => {
        if (isPlaying) setShowControls(false)
      }, 3000)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'Space':
          e.preventDefault()
          setIsPlaying(!isPlaying)
          break
        case 'KeyF':
          setFullscreen(!fullscreen)
          break
        case 'Escape':
          if (fullscreen) setFullscreen(false)
          else onClose()
          break
        case 'ArrowRight':
          setProgress(Math.min(progress + 5000, duration))
          break
        case 'ArrowLeft':
          setProgress(Math.max(progress - 5000, 0))
          break
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('keydown', handleKeyDown)
      if (controlsTimeout.current) clearTimeout(controlsTimeout.current)
    }
  }, [isPlaying, progress, duration, fullscreen, onClose])

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const percent = (e.clientX - rect.left) / rect.width
    setProgress(percent * duration)
  }

  const playerClass = fullscreen ? 'player-fullscreen' : ''

  return (
    <div ref={ref} className={`player-container ${playerClass}`}>
      <div className="player-video">
        {/* Video element would go here */}
        <div className="player-placeholder">
          <p>🎬 {title}</p>
          <p>Player would launch here (MPV integration)</p>
        </div>
      </div>

      {showControls && (
        <div className="player-controls">
          {/* Progress bar */}
          <div className="progress-container" onClick={handleProgressClick}>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${(progress / duration) * 100}%` }}></div>
            </div>
          </div>

          {/* Control buttons */}
          <div className="controls-bottom">
            <div className="controls-left">
              <button
                className="control-button"
                onClick={() => setIsPlaying(!isPlaying)}
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button className="control-button" onClick={() => setProgress(Math.max(0, progress - 10000))}>
                ⏪
              </button>
              <button className="control-button" onClick={() => setProgress(Math.min(duration, progress + 10000))}>
                ⏩
              </button>

              {/* Volume */}
              <div className="volume-control">
                <span className="volume-icon">🔊</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={volume}
                  onChange={(e) => setVolume(parseInt(e.target.value))}
                  className="volume-slider"
                />
              </div>

              {/* Time */}
              <span className="time-display">
                {formatTime(progress)} / {formatTime(duration)}
              </span>
            </div>

            <div className="controls-right">
              <div className="subtitle-control-wrapper">
                <button 
                  className="control-button" 
                  title="Subtitles"
                  onClick={() => setShowSubtitleMenu(!showSubtitleMenu)}
                >
                  CC
                  {subtitles.length > 0 && <span className="subtitle-badge">{subtitles.length}</span>}
                </button>
                {showSubtitleMenu && (
                  <div className="subtitle-menu">
                    <div className="subtitle-menu-header">
                      <h4>Subtitles</h4>
                      {subtitlesLoading && <span className="loading-indicator">...</span>}
                    </div>
                    <div className="subtitle-menu-items">
                      <button 
                        key="none"
                        className={`subtitle-menu-item ${selectedSubtitleIndex === null ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedSubtitleIndex(null)
                          setShowSubtitleMenu(false)
                        }}
                      >
                        None
                      </button>
                      {subtitles.map((sub, idx) => (
                        <button
                          key={idx}
                          className={`subtitle-menu-item ${selectedSubtitleIndex === idx ? 'selected' : ''}`}
                          onClick={() => {
                            setSelectedSubtitleIndex(idx)
                            setShowSubtitleMenu(false)
                          }}
                        >
                          <span className="subtitle-language">{sub.language}</span>
                          {sub.is_forced && <span className="subtitle-tag forced">Forced</span>}
                          {sub.is_sdh && <span className="subtitle-tag sdh">SDH</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <button className="control-button" title="Settings">
                ⚙️
              </button>
              <button
                className="control-button"
                onClick={() => setFullscreen(!fullscreen)}
                title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {fullscreen ? '◱' : '⛶'}
              </button>
              <button className="control-button" onClick={onClose} title="Close">
                ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
