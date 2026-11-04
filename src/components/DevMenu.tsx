// Shortcuts for testing, under the top middle toolbar. Only in development (npm run dev), and only
// while turned on with Dev menu in the settings.
interface DevMenuProps {
  onConnect: () => void
  onRestart: () => void
  onSolve: () => void
  onCelebrate: () => void
}

export default function DevMenu({ onConnect, onRestart, onSolve, onCelebrate }: DevMenuProps) {
  return (
    <div className="float dev-menu" aria-label="Dev menu">
      <span className="dev-label">Dev</span>
      <button className="dev-btn" onClick={onConnect} title="Join two random neighbouring pieces">
        Connect two
      </button>
      <button className="dev-btn" onClick={onRestart} title="Break every piece apart and lay them out again">
        Restart
      </button>
      <button className="dev-btn" onClick={onSolve} title="Put every piece in place">
        Solve
      </button>
      <button className="dev-btn" onClick={onCelebrate} title="Play the finished jigsaw celebration again">
        Celebrate
      </button>
    </div>
  )
}
