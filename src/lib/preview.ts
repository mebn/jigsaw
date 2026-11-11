// A jigsaw's link preview picture, which chat apps show for its link (see server/meta.ts): the
// picture filling it, cropped from the middle to its shape. No text. Made here, as the server has
// nothing to draw pictures with.
import { PREVIEW_H, PREVIEW_W } from '../../shared/protocol.ts'

// The preview as a JPEG data URL, from the jigsaw's picture.
export function renderPreview(image: HTMLImageElement): string {
  const iw = image.naturalWidth
  const ih = image.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = PREVIEW_W
  canvas.height = PREVIEW_H
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  // The largest part of the picture with the preview's shape, from its middle.
  const k = Math.min(iw / PREVIEW_W, ih / PREVIEW_H)
  const sw = PREVIEW_W * k
  const sh = PREVIEW_H * k
  ctx.drawImage(image, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, PREVIEW_W, PREVIEW_H)
  return canvas.toDataURL('image/jpeg', 0.85)
}
