// A jigsaw's link preview picture, which chat apps show for its link (see server/meta.ts): the
// picture whole in the middle, over a blurred copy of it filling the rest. No text. Made here, as
// the server has nothing to draw pictures with.
import { PREVIEW_H, PREVIEW_W } from '../../shared/protocol.ts'

// Room between the picture and the edges.
const PAD = 36
// How small the background is drawn before it's stretched back up, which blurs it the same in
// every browser (not all of them have ctx.filter).
const BLUR_W = 40

// The preview as a JPEG data URL, from the jigsaw's picture.
export function renderPreview(image: HTMLImageElement): string {
  const iw = image.naturalWidth
  const ih = image.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = PREVIEW_W
  canvas.height = PREVIEW_H
  const ctx = canvas.getContext('2d')!

  // The background: the picture covering the whole preview, blurred.
  const small = document.createElement('canvas')
  small.width = BLUR_W
  small.height = Math.round((BLUR_W * PREVIEW_H) / PREVIEW_W)
  const sctx = small.getContext('2d')!
  const cover = Math.max(small.width / iw, small.height / ih)
  sctx.drawImage(image, (small.width - iw * cover) / 2, (small.height - ih * cover) / 2, iw * cover, ih * cover)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(small, 0, 0, PREVIEW_W, PREVIEW_H)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.12)'
  ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H)

  // The picture, whole, with a soft shadow.
  const fit = Math.min((PREVIEW_W - 2 * PAD) / iw, (PREVIEW_H - 2 * PAD) / ih)
  const w = Math.round(iw * fit)
  const h = Math.round(ih * fit)
  const x = Math.round((PREVIEW_W - w) / 2)
  const y = Math.round((PREVIEW_H - h) / 2)
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
  ctx.shadowBlur = 24
  ctx.shadowOffsetY = 6
  ctx.fillStyle = '#fff'
  ctx.fillRect(x, y, w, h)
  ctx.restore()
  ctx.drawImage(image, x, y, w, h)

  return canvas.toDataURL('image/jpeg', 0.85)
}
