// Turns what the terminal sends on stdin (in raw mode, with SGR mouse reporting on) into keys and
// mouse events.

export type InputEvent =
  | { kind: 'key'; key: string; shift?: boolean; ctrl?: boolean }
  // col and row are 0-based character cells. button: 0 left, 1 middle, 2 right, 3 none (a move).
  | { kind: 'mouse'; type: 'down' | 'up' | 'move' | 'drag'; button: number; col: number; row: number }
  | { kind: 'wheel'; dir: 1 | -1; col: number; row: number }

const ARROWS: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }

export function parseInput(data: string): InputEvent[] {
  const out: InputEvent[] = []
  let i = 0
  while (i < data.length) {
    const rest = data.slice(i)
    // SGR mouse: ESC [ < b ; x ; y (M press or motion, m release)
    let m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest)
    if (m) {
      const b = Number(m[1])
      const col = Number(m[2]) - 1
      const row = Number(m[3]) - 1
      if (b & 64) out.push({ kind: 'wheel', dir: b & 1 ? 1 : -1, col, row })
      else {
        const button = b & 3
        const type = m[4] === 'm' ? 'up' : b & 32 ? (button === 3 ? 'move' : 'drag') : 'down'
        out.push({ kind: 'mouse', type, button, col, row })
      }
      i += m[0].length
      continue
    }
    // Arrows, with Shift (ESC [ 1 ; 2 A) or without (ESC [ A or ESC O A).
    m = /^\x1b(?:\[(?:1;(\d))?|O)([ABCDHF])/.exec(rest)
    if (m) {
      const mod = Number(m[1] || 1) - 1
      out.push({ kind: 'key', key: ARROWS[m[2]], shift: !!(mod & 1), ctrl: !!(mod & 4) })
      i += m[0].length
      continue
    }
    m = /^\x1b\[Z/.exec(rest)
    if (m) {
      out.push({ kind: 'key', key: 'tab', shift: true })
      i += m[0].length
      continue
    }
    // Any other escape sequence is skipped.
    m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(rest)
    if (m) {
      i += m[0].length
      continue
    }
    const ch = data[i]
    i++
    if (ch === '\x1b') out.push({ kind: 'key', key: 'escape' })
    else if (ch === '\r' || ch === '\n') out.push({ kind: 'key', key: 'enter' })
    else if (ch === '\t') out.push({ kind: 'key', key: 'tab' })
    else if (ch === '\x7f') out.push({ kind: 'key', key: 'backspace' })
    else if (ch < ' ') out.push({ kind: 'key', key: String.fromCharCode(ch.charCodeAt(0) + 96), ctrl: true })
    else out.push({ kind: 'key', key: ch, shift: ch !== ch.toLowerCase() })
  }
  return out
}
