import { useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.ts'
import { useApp } from '../lib/app.ts'
import { paths } from '../lib/router.ts'
import { Lock } from './icons.tsx'
import InviteList from './Invite.tsx'
import TextField from './TextField.tsx'
import CopyButton from './CopyButton.tsx'
import { useOverlay } from '../lib/overlays.ts'

// Explains that this jigsaw is private and gives its link, with a button that copies it.
export default function PrivateRoom({ id, onClose }: { id: string; onClose: () => void }) {
  const link = `${location.origin}${paths.room(id)}`
  const { player } = useApp()
  const [invited, setInvited] = useState(() => new Set<string>())
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(0)
  // Bumped after sending, so the list reloads and shows who has the jigsaw now.
  const [version, setVersion] = useState(0)

  const send = async () => {
    if (!invited.size || sending) return
    setSending(true)
    try {
      const { invited: n } = await api.invite(id, player!.passphrase, [...invited])
      setSent(n)
      setInvited(new Set())
      setVersion((v) => v + 1)
    } catch {
      setSent(-1)
    } finally {
      setSending(false)
    }
  }

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
        <section className="field">
          <h2 className="label">Invite players</h2>
          <InviteList key={version} room={id} selected={invited} onChange={(s) => (setInvited(s), setSent(0))} />
          {player && (
            <button className="secondary" disabled={!invited.size || sending} onClick={send}>
              {sending ? <span className="spin" /> : invited.size > 1 ? `Send ${invited.size} invites` : 'Send invite'}
            </button>
          )}
          {sent > 0 && <p className="modal-note">{sent > 1 ? `${sent} invites sent.` : 'Invite sent.'}</p>}
          {sent < 0 && <p className="modal-error">Could not send the invites, try again.</p>}
        </section>
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
