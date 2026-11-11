// An emoji thrown from (x, y) in layer at velocity (vx, vy) px/s, falling under gravity g px/s², spinning
// spin degrees and fading out over its last fade share of ms. It starts at from times its size and is
// gone once it lands.
export interface Fling {
  x: number
  y: number
  vx: number
  vy: number
  g: number
  ms: number
  size: number
  spin: number
  delay?: number
  fade: number
  from?: number
}

export function fling(layer: HTMLElement, emoji: string, { x, y, vx, vy, g, ms, size, spin, delay = 0, fade, from = 1 }: Fling) {
  const el = document.createElement('span')
  el.className = 'reaction'
  el.textContent = emoji
  layer.appendChild(el)
  const steps = Math.max(10, Math.round(ms / 180))
  const frames: Keyframe[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const s = (t * ms) / 1000
    frames.push({
      transform: `translate(${x + vx * s}px, ${y + vy * s + (g * s * s) / 2}px) translate(-50%, -50%) rotate(${spin * t}deg) scale(${i ? size : size * from})`,
      opacity: t > 1 - fade ? (1 - t) / fade : 1,
    })
  }
  el.animate(frames, { duration: ms, delay, fill: 'backwards' }).onfinish = () => el.remove()
}
