import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

// The app's own confirmation dialog, used instead of the browser's confirm().
interface ConfirmProps {
  title: string
  text?: ReactNode
  children?: ReactNode
  action: ReactNode
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function Confirm({ title, text, children, action, danger = false, onConfirm, onCancel }: ConfirmProps) {
  // Escape cancels only this dialog, not a window underneath it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onCancel()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onCancel])

  return createPortal(
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="alertdialog" aria-label={title}>
        <h1>{title}</h1>
        {text && <p className="modal-text">{text}</p>}
        {children}
        <div className="row modal-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className={`primary${danger ? ' danger' : ''}`} autoFocus onClick={onConfirm}>
            {action}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
