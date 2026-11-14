import { useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../lib/api.ts'
import { useApp } from '../lib/app.ts'
import { LIMITS } from '../../shared/protocol.ts'
import Dialog from './Dialog.tsx'

// A window to write feedback in, from Settings > General. It's kept on the server with who sent it
// (when logged in) and the jigsaw it came from.
export default function Feedback({ onClose, closing }: { onClose: () => void; closing: boolean }) {
  const { player, roomId } = useApp()
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')

  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim() || state === 'sending') return
    setState('sending')
    try {
      await api.feedback(text.trim(), player?.passphrase, roomId)
      setState('sent')
    } catch {
      setState('failed')
    }
  }

  return (
    <Dialog title="Feedback" className="feedback" onClose={onClose} closing={closing} keepTyping>
      {state === 'sent' ? (
        <>
          <p className="modal-text">Thanks, your feedback was sent.</p>
          <div className="row modal-actions">
            <button className="primary" autoFocus onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form className="prompt-form" onSubmit={send}>
          <p className="modal-text">Found a bug, or have an idea? Tell us.</p>
          <textarea
            className="text feedback-text"
            value={text}
            onChange={(e) => (setText(e.target.value), state === 'failed' && setState('idle'))}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && send(e)}
            placeholder="Your feedback"
            aria-label="Your feedback"
            maxLength={LIMITS.text}
            rows={6}
            autoFocus
          />
          {state === 'failed' && <p className="modal-error">Couldn't send it, try again.</p>}
          <div className="row modal-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={!text.trim() || state === 'sending'}>
              {state === 'sending' ? <span className="spin" /> : 'Send'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
