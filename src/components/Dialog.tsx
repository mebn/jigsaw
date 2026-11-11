import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Back, Close } from './icons.tsx'
import { isTyping, useOverlay } from '../lib/overlays.ts'

// Every window over the board: a title with actions (buttons) and close at the top, an optional
// bar under it (for tabs and buttons that stay put), and a body that scrolls. Rendered on the
// body, so a panel it opens from can't contain it. Without onClose it can't be dismissed.
// Escape closes it, except in a text field with keepTyping (so a half filled form isn't lost).
// onKey gets the keys pressed while it is on top, outside text fields.
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
  onKey?: (e: KeyboardEvent) => void
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
  onKey,
  actions,
  bar,
  footer,
  children,
}: DialogProps) {
  const onTop = useOverlay(!closing, () => onClose?.(), { modal: true, keepTyping })
  const key = useRef(onKey)
  key.current = onKey
  const hasKeys = !!onKey
  useEffect(() => {
    if (!hasKeys || closing) return
    const down = (e: KeyboardEvent) => onTop() && !isTyping(e) && key.current?.(e)
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [hasKeys, closing, onTop])

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
