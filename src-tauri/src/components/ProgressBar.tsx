import React from 'react'

interface ProgressBarProps {
  progress: number // 0-100
  isWatched: boolean
  showLabel?: boolean
}

export const ProgressBar: React.FC<ProgressBarProps> = ({ progress, isWatched, showLabel = true }) => {
  return (
    <div className="progress-bar-container">
      {isWatched ? (
        <div className="watched-badge" title="Watched">
          ✓ Watched
        </div>
      ) : (
        <>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }}></div>
          </div>
          {showLabel && <div className="progress-label">{Math.round(progress)}%</div>}
        </>
      )}
      <style>{`
        .progress-bar-container {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .progress-bar {
          flex: 1;
          height: 3px;
          background-color: #333;
          border-radius: 2px;
          overflow: hidden;
          position: relative;
        }

        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #4a9eff 0%, #357abd 100%);
          transition: width 0.3s ease;
          border-radius: 2px;
        }

        .progress-label {
          font-size: 0.75rem;
          color: #999;
          min-width: 30px;
          text-align: right;
        }

        .watched-badge {
          background-color: #1a5a3a;
          color: #4ade80;
          padding: 0.25rem 0.5rem;
          border-radius: 3px;
          font-size: 0.75rem;
          font-weight: 600;
          white-space: nowrap;
        }
      `}</style>
    </div>
  )
}

export default ProgressBar
