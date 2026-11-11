// Sound effects, made on the fly with Web Audio (no files to load). On unless turned off with the
// Sounds setting, which this browser remembers.
import { store } from './storage.ts'

let ctx: AudioContext | null = null
let on = store.get('sound') !== '0'

export const soundOn = () => on
export const setSound = (v: boolean) => {
  on = v
  store.set('sound', v ? null : '0')
}

// The audio context. Browsers only let it play once the player has pressed something on the page,
// so it's started on the first press, ready for the first click. Until then this stays quiet.
function audio() {
  if (!ctx) {
    // Older Safari only has the prefixed one.
    const AC: typeof AudioContext | undefined = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx.state === 'running' ? ctx : null
}
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => on && audio(), { capture: true, passive: true })

// A soft wooden clack, like two blocks knocked together: a sharp tick, a short ringing body and a faint
// thump underneath. It's made once, sample by sample, and every join plays that same recording, so it
// sounds the same every time, the last join too. Scheduling tones to start and fade at set times
// doesn't: when the page is busy right after a join (finishing the jigsaw is), they reach the audio
// late and most of the clack is already over by the time it plays.
let clack: AudioBuffer | null = null

function makeClack(rate: number) {
  const n = Math.round(rate * 0.075)
  const buf = new AudioBuffer({ length: n, sampleRate: rate })
  const out = buf.getChannelData(0)
  // A tone that hits at once (in 2 ms) and fades away exponentially over decay seconds, sliding from
  // one frequency to another.
  const hit = (from: number, to: number, peak: number, decay: number) => {
    let phase = 0
    for (let i = 0; i < n; i++) {
      const t = i / rate
      if (t > decay) break
      const f = from * (to / from) ** (t / decay)
      phase += (2 * Math.PI * f) / rate
      const env = t < 0.002 ? 0.0001 * (peak / 0.0001) ** (t / 0.002) : peak * (0.0001 / peak) ** ((t - 0.002) / (decay - 0.002))
      out[i] += Math.sin(phase) * env
    }
  }
  // The body: a few out of tune partials, like a wood block ringing. Higher ones fade first.
  const base = 620
  hit(base, base, 0.6, 0.06)
  hit(base * 2.4, base * 2.4, 0.25, 0.035)
  hit(base * 4.1, base * 4.1, 0.12, 0.018)
  // The thump: a quiet low tone that drops a little, giving it some weight.
  hit(160, 120, 0.3, 0.04)
  // The tick: a very short burst of bright noise, through a band pass filter.
  const w = (2 * Math.PI * 3800) / rate
  const alpha = Math.sin(w) / (2 * 0.9)
  const a0 = 1 + alpha
  const [b0, b2, a1, a2] = [alpha / a0, -alpha / a0, (-2 * Math.cos(w)) / a0, (1 - alpha) / a0]
  let [x1, x2, y1, y2] = [0, 0, 0, 0]
  const len = Math.round(rate * 0.012)
  for (let i = 0; i < n; i++) {
    const x = i < len ? (Math.random() * 2 - 1) * (1 - i / len) ** 4 : 0
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
    ;[x2, x1, y2, y1] = [x1, x, y1, y]
    out[i] += y * 0.4
  }
  return buf
}

// Other players' joins are quieter than your own, and every join is a touch higher or lower.
export function playSnap({ local = true } = {}) {
  if (!on) return
  const a = audio()
  if (!a) return
  if (clack?.sampleRate !== a.sampleRate) clack = makeClack(a.sampleRate)
  const src = a.createBufferSource()
  src.buffer = clack
  src.playbackRate.value = 0.92 + Math.random() * 0.16
  const gain = a.createGain()
  gain.gain.value = local ? 0.4 : 0.15
  src.connect(gain).connect(a.destination)
  src.onended = () => gain.disconnect()
  // No start time: it plays as soon as it reaches the audio, however late that is, and all of it.
  src.start()
}
