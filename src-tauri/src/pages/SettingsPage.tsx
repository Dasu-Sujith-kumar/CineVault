import { useState, useEffect } from 'react'
import { open } from '@tauri-apps/api/dialog'
import { api } from '../services/api'

interface LibraryRoot {
  id: string
  path: string
  library_kind: string
  created_at: string
}

interface AppSettings {
  theme: 'dark' | 'light'
  auto_play_next: boolean
  remember_playback: boolean
  quality_preference: 'any' | 'hd' | '4k'
}

export default function SettingsPage() {
  const [libraryRoots, setLibraryRoots] = useState<LibraryRoot[]>([])
  const [settings, setSettings] = useState<AppSettings>({
    theme: 'dark',
    auto_play_next: true,
    remember_playback: true,
    quality_preference: 'any',
  })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [showAddRoot, setShowAddRoot] = useState(false)
  const [newRootPath, setNewRootPath] = useState('')
  const [newRootKind, setNewRootKind] = useState('movies')
  const [isScanning, setIsScanning] = useState<Set<string>>(new Set())
  const [scanningAll, setScanningAll] = useState(false)

  useEffect(() => {
    loadSettings()
    loadLibraryRoots()
  }, [])

  const loadSettings = async () => {
    try {
      const savedSettings = await api.loadAppState()
      if (savedSettings) {
        try {
          const parsed = JSON.parse(savedSettings)
          setSettings(parsed)
        } catch (e) {
          console.error('Failed to parse settings:', e)
        }
      }
    } catch (err) {
      console.error('Failed to load settings:', err)
    }
  }

  const loadLibraryRoots = async () => {
    try {
      setIsLoading(true)
      const roots = await api.getLibraryRoots()
      setLibraryRoots(roots)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load library roots')
    } finally {
      setIsLoading(false)
    }
  }

  const handleAddRoot = async () => {
    if (!newRootPath.trim()) {
      setError('Path cannot be empty')
      setTimeout(() => setError(null), 5000)
      return
    }

    try {
      const newRoot = await api.addLibraryRoot(newRootPath, newRootKind)
      setLibraryRoots([...libraryRoots, newRoot])
      setNewRootPath('')
      setShowAddRoot(false)
      setSuccessMessage('Library root added successfully')
      setTimeout(() => setSuccessMessage(null), 5000)
      
      // Auto-scan the new root
      handleStartScan(newRoot.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add library root')
      setTimeout(() => setError(null), 5000)
    }
  }

  const handleBrowseFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Library Root Folder',
      })
      if (selected && typeof selected === 'string') {
        setNewRootPath(selected)
      }
    } catch (err) {
      console.error('Failed to browse folder:', err)
    }
  }

  const handleRemoveRoot = async (rootId: string) => {
    if (!window.confirm('Remove this library root? Library items from this root will be deleted.')) return

    try {
      await api.removeLibraryRoot(rootId)
      setLibraryRoots(libraryRoots.filter(r => r.id !== rootId))
      setSuccessMessage('Library root removed successfully')
      setTimeout(() => setSuccessMessage(null), 5000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove library root')
      setTimeout(() => setError(null), 5000)
    }
  }

  const handleStartScan = async (rootId: string) => {
    try {
      setIsScanning(new Set([...isScanning, rootId]))
      const result = await api.scanLibraryRoot(rootId)
      setSuccessMessage(`Scan completed: ${result}`)
      setTimeout(() => setSuccessMessage(null), 5000)
      setIsScanning(new Set([...isScanning].filter(id => id !== rootId)))
      loadLibraryRoots()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start scan')
      setIsScanning(new Set([...isScanning].filter(id => id !== rootId)))
      setTimeout(() => setError(null), 5000)
    }
  }

  const handleScanAll = async () => {
    setScanningAll(true)
    try {
      for (const root of libraryRoots) {
        await api.scanLibraryRoot(root.id)
      }
      setSuccessMessage('All library roots scanned successfully')
      setTimeout(() => setSuccessMessage(null), 5000)
      loadLibraryRoots()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scan all roots')
      setTimeout(() => setError(null), 5000)
    } finally {
      setScanningAll(false)
    }
  }

  const handleSettingChange = (key: keyof AppSettings, value: any) => {
    const newSettings = { ...settings, [key]: value }
    setSettings(newSettings)
    try {
      api.saveAppState(JSON.stringify(newSettings))
    } catch (err) {
      console.error('Failed to save settings:', err)
    }
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <div className="header-title">
          <h1>Settings</h1>
          <p className="header-subtitle">Manage your library and preferences</p>
        </div>
        {libraryRoots.length > 0 && (
          <button
            className="primary-button"
            onClick={handleScanAll}
            disabled={scanningAll || isLoading}
          >
            {scanningAll ? '⏳ Scanning All...' : '🔄 Scan All Roots'}
          </button>
        )}
      </div>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {successMessage && (
        <div className="success-banner">
          ✓ {successMessage}
        </div>
      )}

      {/* Library Roots Section */}
      <div className="settings-section">
        <div className="section-header">
          <h3>📁 Library Roots</h3>
          <p className="section-description">Manage your media library folders</p>
        </div>

        {isLoading && libraryRoots.length === 0 ? (
          <div className="loading-state">
            <div className="spinner"></div>
            <p>Loading library roots...</p>
          </div>
        ) : libraryRoots.length > 0 ? (
          <div className="library-roots-list">
            {libraryRoots.map((root) => (
              <div key={root.id} className="library-root-item">
                <div className="root-info">
                  <div className="root-path">
                    <span className="root-icon">📂</span>
                    <div>
                      <div className="path-text">{root.path}</div>
                      <div className="path-meta">{new Date(root.created_at).toLocaleDateString()}</div>
                    </div>
                  </div>
                  <div className="root-kind-badge">{root.library_kind}</div>
                </div>
                <div className="root-actions">
                  {!isScanning.has(root.id) && (
                    <>
                      <button
                        className="scan-button"
                        onClick={() => handleStartScan(root.id)}
                        title="Scan this folder for media"
                        disabled={isLoading}
                      >
                        🔄 Scan
                      </button>
                      <button
                        className="danger-button"
                        onClick={() => handleRemoveRoot(root.id)}
                        title="Remove this library root"
                        disabled={isLoading}
                      >
                        🗑️ Remove
                      </button>
                    </>
                  )}
                  {isScanning.has(root.id) && (
                    <button className="scanning-button" disabled>
                      ⏳ Scanning...
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-state">No library roots configured. Add one to get started!</p>
        )}

        {!showAddRoot ? (
          <button className="primary-button" onClick={() => setShowAddRoot(true)} disabled={isLoading || showAddRoot}>
            + Add Library Root
          </button>
        ) : (
          <div className="add-root-form">
            <div className="form-group">
              <label>Library Type</label>
              <select value={newRootKind} onChange={(e) => setNewRootKind(e.target.value)}>
                <option value="movies">Movies</option>
                <option value="tv">TV Shows</option>
                <option value="anime">Anime</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div className="form-group">
              <label>Folder Path</label>
              <div className="path-input-group">
                <input
                  type="text"
                  placeholder="Enter or browse folder path..."
                  value={newRootPath}
                  onChange={(e) => setNewRootPath(e.target.value)}
                  disabled={isLoading}
                />
                <button onClick={handleBrowseFolder} disabled={isLoading} className="browse-button">
                  📁 Browse
                </button>
              </div>
            </div>

            <div className="form-actions">
              <button className="primary-button" onClick={handleAddRoot} disabled={isLoading || !newRootPath.trim()}>
                Add Root
              </button>
              <button className="secondary-button" onClick={() => setShowAddRoot(false)} disabled={isLoading}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* App Settings Section */}
      <div className="settings-section">
        <div className="section-header">
          <h3>⚙️ Preferences</h3>
          <p className="section-description">Customize your viewing experience</p>
        </div>

        <div className="settings-grid">
          <div className="setting-item">
            <label htmlFor="theme-select">Theme</label>
            <select
              id="theme-select"
              value={settings.theme}
              onChange={(e) => handleSettingChange('theme', e.target.value as 'dark' | 'light')}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>

          <div className="setting-item">
            <label>
              <input
                type="checkbox"
                checked={settings.auto_play_next}
                onChange={(e) => handleSettingChange('auto_play_next', e.target.checked)}
              />
              Auto-play next episode
            </label>
          </div>

          <div className="setting-item">
            <label>
              <input
                type="checkbox"
                checked={settings.remember_playback}
                onChange={(e) => handleSettingChange('remember_playback', e.target.checked)}
              />
              Remember playback position
            </label>
          </div>

          <div className="setting-item">
            <label htmlFor="quality-select">Preferred Quality</label>
            <select
              id="quality-select"
              value={settings.quality_preference}
              onChange={(e) => handleSettingChange('quality_preference', e.target.value as any)}
            >
              <option value="any">Any Quality</option>
              <option value="hd">HD</option>
              <option value="4k">4K</option>
            </select>
          </div>
        </div>
      </div>

      <style>{`
        .settings-page {
          max-width: 1200px;
          margin: 0 auto;
          padding: 20px;
          color: #fff;
        }

        .settings-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 30px;
          padding-bottom: 20px;
          border-bottom: 2px solid rgba(255, 255, 255, 0.1);
        }

        .header-title h1 {
          margin: 0 0 5px 0;
          font-size: 28px;
          font-weight: 600;
        }

        .header-subtitle {
          margin: 0;
          color: rgba(255, 255, 255, 0.7);
          font-size: 14px;
        }

        .error-banner,
        .success-banner {
          padding: 12px 16px;
          margin-bottom: 16px;
          border-radius: 8px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .error-banner {
          background-color: rgba(239, 68, 68, 0.2);
          border: 1px solid rgba(239, 68, 68, 0.5);
          color: #fca5a5;
        }

        .success-banner {
          background-color: rgba(34, 197, 94, 0.2);
          border: 1px solid rgba(34, 197, 94, 0.5);
          color: #86efac;
        }

        .error-banner button {
          background: none;
          border: none;
          color: inherit;
          cursor: pointer;
          font-size: 18px;
          padding: 0;
        }

        .settings-section {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 24px;
          margin-bottom: 24px;
        }

        .section-header {
          margin-bottom: 20px;
        }

        .section-header h3 {
          margin: 0 0 8px 0;
          font-size: 18px;
          font-weight: 600;
        }

        .section-description {
          margin: 0;
          color: rgba(255, 255, 255, 0.6);
          font-size: 13px;
        }

        .library-roots-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-bottom: 16px;
        }

        .library-root-item {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          padding: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .root-info {
          display: flex;
          align-items: center;
          gap: 16px;
          flex: 1;
          min-width: 0;
        }

        .root-path {
          display: flex;
          align-items: center;
          gap: 12px;
          flex: 1;
          min-width: 0;
        }

        .root-icon {
          font-size: 24px;
          flex-shrink: 0;
        }

        .path-text {
          color: #fff;
          font-size: 14px;
          word-break: break-all;
        }

        .path-meta {
          color: rgba(255, 255, 255, 0.5);
          font-size: 12px;
          margin-top: 4px;
        }

        .root-kind-badge {
          background: rgba(59, 130, 246, 0.2);
          border: 1px solid rgba(59, 130, 246, 0.5);
          color: #93c5fd;
          padding: 4px 12px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
          white-space: nowrap;
          flex-shrink: 0;
        }

        .root-actions {
          display: flex;
          gap: 8px;
          flex-shrink: 0;
        }

        .scan-button,
        .danger-button,
        .scanning-button,
        .primary-button,
        .secondary-button,
        .browse-button {
          padding: 8px 16px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          transition: all 0.2s;
        }

        .scan-button {
          background: rgba(59, 130, 246, 0.2);
          color: #93c5fd;
          border: 1px solid rgba(59, 130, 246, 0.3);
        }

        .scan-button:hover:not(:disabled) {
          background: rgba(59, 130, 246, 0.3);
        }

        .danger-button {
          background: rgba(239, 68, 68, 0.2);
          color: #fca5a5;
          border: 1px solid rgba(239, 68, 68, 0.3);
        }

        .danger-button:hover:not(:disabled) {
          background: rgba(239, 68, 68, 0.3);
        }

        .scanning-button {
          background: rgba(251, 146, 60, 0.2);
          color: #fdba74;
          border: 1px solid rgba(251, 146, 60, 0.3);
          cursor: not-allowed;
        }

        .primary-button {
          background: rgba(59, 130, 246, 0.8);
          color: #fff;
          border: 1px solid rgba(59, 130, 246, 0.5);
        }

        .primary-button:hover:not(:disabled) {
          background: rgba(59, 130, 246, 1);
        }

        .secondary-button {
          background: rgba(107, 114, 128, 0.2);
          color: #d1d5db;
          border: 1px solid rgba(107, 114, 128, 0.3);
        }

        .secondary-button:hover:not(:disabled) {
          background: rgba(107, 114, 128, 0.3);
        }

        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .add-root-form {
          background: rgba(255, 255, 255, 0.02);
          border: 1px dashed rgba(59, 130, 246, 0.3);
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 16px;
        }

        .form-group {
          margin-bottom: 16px;
        }

        .form-group label {
          display: block;
          margin-bottom: 8px;
          font-weight: 500;
          color: #fff;
        }

        .form-group input,
        .form-group select {
          width: 100%;
          padding: 10px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 6px;
          color: #fff;
          font-size: 14px;
        }

        .form-group input:focus,
        .form-group select:focus {
          outline: none;
          border-color: rgba(59, 130, 246, 0.5);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
        }

        .path-input-group {
          display: flex;
          gap: 8px;
        }

        .path-input-group input {
          flex: 1;
        }

        .browse-button {
          flex-shrink: 0;
          background: rgba(107, 114, 128, 0.2);
          color: #d1d5db;
          border: 1px solid rgba(107, 114, 128, 0.3);
        }

        .browse-button:hover:not(:disabled) {
          background: rgba(107, 114, 128, 0.3);
        }

        .form-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }

        .form-actions button {
          flex-shrink: 0;
        }

        .settings-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 20px;
        }

        .setting-item {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .setting-item label {
          color: #fff;
          font-weight: 500;
          font-size: 14px;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .setting-item input[type="checkbox"] {
          width: 18px;
          height: 18px;
          cursor: pointer;
        }

        .loading-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          padding: 40px 20px;
          color: rgba(255, 255, 255, 0.6);
        }

        .spinner {
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

        .empty-state {
          text-align: center;
          padding: 40px 20px;
          color: rgba(255, 255, 255, 0.5);
          font-size: 14px;
        }
      `}</style>
    </div>
  )
}
