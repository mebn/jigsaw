import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Back, Close } from './icons.tsx'

// Every window over the board: a title with actions (buttons) and close at the top, an optional
// bar under it (for tabs and buttons that stay put), and a body that scrolls. Rendered on the
// body, so a panel it opens from can't contain it. Without onClose it can't be dismissed.
// Escape closes it, except in a text field with keepTyping (so a half filled form isn't lost).
interface DialogProps {
  title?: string
  label?: string
  className?: string
  bodyClass?: string
  bg?: string
  onBack?: (() => void) | null
  backTitle?: string
  onClose?: (() => void) | null
  closing?: boolean
  closeButton?: boolean
  keepTyping?: boolean
  actions?: ReactNode
  bar?: ReactNode
  footer?: ReactNode
  children?: ReactNode
}

export default function Dialog({
  title,
  label = title,
  className = '',
  bodyClass = '',
  bg = '',
  onBack,
  backTitle = 'Back',
  onClose,
  closing,
  closeButton = true,
  keepTyping = false,
  actions,
  bar,
  footer,
  children,
}: DialogProps) {
  useEffect(() => {
    if (!onClose || closing) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (keepTyping && (e.target as Element | null)?.closest?.('input, textarea')) return
      onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose, closing, keepTyping])

  return createPortal(
    <div
      className={`modal-bg${bg ? ` ${bg}` : ''}${closing ? ' closing' : ''}`}
      onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div className={`modal dialog ${className}`} role="dialog" aria-label={label}>
        <div className="dialog-head">
          <div className="dialog-title">
            {onBack && (
              <button type="button" className="icon-btn" onClick={onBack} aria-label="Back" title={backTitle}>
                <Back />
              </button>
            )}
            {title && <h1>{title}</h1>}
          </div>
          <div className="dialog-actions">
            {actions}
            {onClose && closeButton && (
              <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
                <Close />
              </button>
            )}
          </div>
        </div>
        {bar && <div className="dialog-bar">{bar}</div>}
        <div className={`dialog-body ${bodyClass}`}>{children}</div>
        {footer}
      </div>
    </div>,
    document.body,
  )
}

// Tabs in a row, one of them on. tabs is a list of { key, title, hint }.
export interface Tab<K extends string = string> {
  key: K
  title: string
  hint?: string
}

export function Tabs<K extends string>({ tabs, value, onChange, label }: { tabs: readonly Tab<K>[]; value: K; onChange: (key: K) => void; label?: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          className={`tab${t.key === value ? ' on' : ''}`}
          role="tab"
          aria-selected={t.key === value}
          onClick={() => onChange(t.key)}
          title={t.hint || t.title}
        >
          {t.title}
        </button>
      ))}
    </div>
  )
}
