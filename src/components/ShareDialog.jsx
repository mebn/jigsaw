import { useEffect, useRef, useState } from 'react'
import Dialog from './Dialog.jsx'
import { api } from '../lib/api.js'
import { renderShare, shareImage } from '../lib/share.js'
import { framesFor, renderTimelapse } from '../lib/timelapse.js'

// Sharing a finished jigsaw: a picture of it with the podium, to copy, or a GIF of it being put
// together, to share or save. Both are made when the dialog opens, and shown before they're picked.
export default function ShareDialog({ engine, ranked, onClose, closing }) {
  // The picture as a promise, so copying it still counts as the click that asked for it.
  const picture = useRef(null)
  picture.current ??= renderShare({ image: engine.refImg, ranked })
  const [pictureUrl, setPictureUrl] = useState(null)
  // The GIF: null while it's being made, 'none' when there's nothing to make it from, else { blob, url }.
  const [gif, setGif] = useState(null)
  // What the last click did, shown on its button for a moment: 'copied', 'saved' or 'shared'.
  const [done, setDone] = useState(null)

  useEffect(() => {
    let url = null
    picture.current.then((blob) => setPictureUrl((url = URL.createObjectURL(blob))), () => {})
    return () => url && URL.revokeObjectURL(url)
  }, [])

  useEffect(() => {
    let stop = false
    let url = null
    api
      .snapshots(engine.room.id)
      .then((list) => {
        const frames = framesFor(list, engine.unit)
        if (frames.length < 2) return 'none'
        return renderTimelapse({ room: engine.room, geo: engine.geo, image: engine.refImg, frames, stopped: () => stop })
      })
      .catch(() => 'none')
      .then((blob) => {
        if (stop || !blob) return
        if (blob === 'none') return setGif('none')
        url = URL.createObjectURL(blob)
        setGif({ blob, url })
      })
    return () => {
      stop = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [engine])

  const flash = (what) => {
    setDone(what)
    setTimeout(() => setDone((d) => (d === what ? null : d)), 2500)
  }

  const copy = async () => {
    const result = await shareImage(picture.current, 'jigsaw').catch(() => null)
    if (result) flash(result)
  }

  const file = gif?.blob && new File([gif.blob], 'jigsaw.gif', { type: 'image/gif' })
  const canShare = !!file && !!navigator.canShare?.({ files: [file] })
  const shareGif = async () => {
    if (canShare) {
      try {
        await navigator.share({ files: [file], title: 'Jigsaw' })
        flash('shared')
      } catch {}
      return
    }
    const a = document.createElement('a')
    a.href = gif.url
    a.download = file.name
    a.click()
    flash('gif-saved')
  }

  return (
    <Dialog title="Share" className="share-dialog" bodyClass="share-body" onClose={onClose} closing={closing}>
      <div className="share-option">
        <div className="share-preview">{pictureUrl ? <img src={pictureUrl} alt="" /> : <div className="spin" />}</div>
        <p className="modal-text">The finished jigsaw with the podium.</p>
        <button className="secondary" onClick={copy}>
          {done === 'copied' ? 'Copied' : done === 'saved' ? 'Saved' : 'Copy image'}
        </button>
      </div>
      <div className="share-option">
        <div className="share-preview">
          {gif === 'none' ? (
            <p className="modal-text">No timelapse: this jigsaw was started before they were recorded.</p>
          ) : gif ? (
            <img src={gif.url} alt="" />
          ) : (
            <div className="spin" />
          )}
        </div>
        <p className="modal-text">A timelapse of the jigsaw coming together.</p>
        <button className="primary" disabled={!gif || gif === 'none'} onClick={shareGif}>
          {done === 'shared' ? 'Shared' : done === 'gif-saved' ? 'Saved' : canShare ? 'Share GIF' : 'Save GIF'}
        </button>
      </div>
    </Dialog>
  )
}
