import { createPortal } from 'react-dom'
import { paths } from '../lib/router.ts'
import { Lock } from './icons.tsx'
import TextField from './TextField.tsx'
import CopyButton from './CopyButton.tsx'
import { useOverlay } from '../lib/overlays.ts'

// Explains that this jigsaw is private and gives its link, with a button that copies it.
export default function PrivateRoom({ id, onClose }: { id: string; onClose: () => void }) {
  const link = `${location.origin}${paths.room(id)}`
  useOverlay(true, onClose, { modal: true })

  return createPortal(
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal private-room" role="dialog" aria-label="Private room">
        <h1 className="private-title">
          <Lock />
          Private room
        </h1>
        <p className="modal-text">
          Only people with the link can see and play this jigsaw. It shows up in their jigsaws once they have opened it.
        </p>
        <div className="room-link">
          <TextField
            value={link}
            readOnly
            onFocus={(e) => e.target.select()}
            aria-label="Link to this jigsaw"
          />
          <CopyButton text={link} label="Copy link" />
        </div>
        <div className="row modal-actions">
          <button className="primary" autoFocus onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
