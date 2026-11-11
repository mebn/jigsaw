import { useEffect, useRef, useState } from 'react'
import Dialog from './Dialog.tsx'
import type { Engine } from '../lib/engine.ts'
import type { RankedPlayer } from './Players.tsx'
import { api } from '../lib/api.ts'
import { renderShare, saveFile, shareImage } from '../lib/share.ts'
import { framesFor, renderTimelapse } from '../lib/timelapse.ts'

// Sharing a finished jigsaw: a picture of it with the podium, to copy, or a GIF of it being put
// together, to share or save. Both are made when the dialog opens, and shown before they're picked.
interface ShareDialogProps {
  engine: Engine
  ranked: RankedPlayer[]
  onClose: () => void
  closing: boolean
}

interface Gif {
  blob: Blob
  url: string
}

export default function ShareDialog({ engine, ranked, onClose, closing }: ShareDialogProps) {
  // The picture as a promise, so copying it still counts as the click that asked for it.
  const picture = useRef<Promise<Blob> | null>(null)
  picture.current ??= renderShare({ image: engine.refImg, ranked })
  // The picture's address once made, or 'failed'.
  const [pictureUrl, setPictureUrl] = useState<string | null>(null)
  // The GIF: null while it's being made, 'none' when there's nothing to make it from, 'failed' when it
  // couldn't be made, else { blob, url }.
  const [gif, setGif] = useState<Gif | 'none' | 'failed' | null>(null)
  // What the last click did, shown on its button for a moment: 'copied', 'saved' or 'shared'.
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    let url: string | null = null
    picture.current!.then(
      (blob) => setPictureUrl((url = URL.createObjectURL(blob))),
      () => setPictureUrl('failed'),
    )
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [])

  useEffect(() => {
    let stop = false
    let url: string | null = null
    api
      .snapshots(engine.room.id)
      .then<Blob | null | 'none' | 'failed'>((list) => {
        const frames = framesFor(list, engine.unit)
        if (frames.length < 2) return 'none'
        return renderTimelapse({ room: engine.room, geo: engine.geo, image: engine.refImg, frames, stopped: () => stop })
      })
      .catch((): 'failed' => 'failed')
      .then((blob) => {
        if (stop || !blob) return
        if (blob === 'none' || blob === 'failed') return setGif(blob)
        url = URL.createObjectURL(blob)
        setGif({ blob, url })
      })
    return () => {
      stop = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [engine])

  const flash = (what: string) => {
    setDone(what)
    setTimeout(() => setDone((d) => (d === what ? null : d)), 2500)
  }

  const copy = async () => {
    const result = await shareImage(picture.current!).catch(() => null)
    if (result) flash(result)
  }

  const ready = gif && gif !== 'none' && gif !== 'failed' ? gif : null
  const file = ready ? new File([ready.blob], 'jigsaw.gif', { type: 'image/gif' }) : null
  const canShare = !!file && !!navigator.canShare?.({ files: [file] })
  const shareGif = async () => {
    if (canShare) {
      try {
        await navigator.share({ files: [file!], title: 'Jigsaw' })
        flash('shared')
      } catch {}
      return
    }
    saveFile(file!, file!.name)
    flash('gif-saved')
  }
  return (
    <Dialog title="Share" className="share-dialog" bodyClass="share-body" onClose={onClose} closing={closing}>
      <div className="share-option">
        <div className="share-preview">{pictureUrl === 'failed' ? (
            <p className="modal-text">Couldn't make the picture.</p>
          ) : pictureUrl ? (
            <img src={pictureUrl} alt="" />
          ) : (
            <div className="spin" />
          )}</div>
        <p className="modal-text">The finished jigsaw with the podium.</p>
        <button className="secondary" disabled={pictureUrl === 'failed'} onClick={copy}>
          {done === 'copied' ? 'Copied' : done === 'saved' ? 'Saved' : 'Copy image'}
        </button>
      </div>
      <div className="share-option">
        <div className="share-preview">
          {gif === 'none' ? (
            <p className="modal-text">No timelapse: this jigsaw was started before they were recorded.</p>
          ) : gif === 'failed' ? (
            <p className="modal-text">Couldn't make the timelapse.</p>
          ) : gif ? (
            <img src={gif.url} alt="" />
          ) : (
            <div className="spin" />
          )}
        </div>
        <p className="modal-text">A timelapse of the jigsaw coming together.</p>
        <button className="primary" disabled={!ready} onClick={shareGif}>
          {done === 'shared' ? 'Shared' : done === 'gif-saved' ? 'Saved' : canShare ? 'Share GIF' : 'Save GIF'}
        </button>
      </div>
    </Dialog>
  )
}
