// Dialogs over the gallery or the table: logging in (as on the website: a new player's name, a
// passphrase, or an email and password), a new player's passphrase, and the account.
import { LIMITS } from '../../shared/protocol.ts'
import type { InputEvent } from './input.ts'
import { C, inRect } from './screen.ts'
import type { Cells, Rect, Rgb, Scene, Terminal } from './screen.ts'
import type { Session } from './session.ts'

type Row =
  | { t: 'text'; text: string; fg?: Rgb; bold?: boolean }
  | { t: 'gap' }
  | { t: 'tabs'; tabs: string[]; value: number; focused: boolean; pick: (i: number) => void }
  | { t: 'field'; label: string; value: string; secret?: boolean; focused: boolean; bad?: boolean; focus: () => void }
  | { t: 'buttons'; items: { label: string; primary?: boolean; focused?: boolean; fn: () => void }[] }

// Breaks text into lines at most w wide, at spaces.
function wrap(text: string, w: number) {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > w) {
      out.push(line)
      line = word
    } else line = line ? line + ' ' + word : word
  }
  out.push(line)
  return out
}

abstract class Dialog implements Scene {
  protected term: Terminal
  private hits: { r: Rect; fn: () => void }[] = []
  abstract title: string
  abstract rows(): Row[]
  abstract key(e: Extract<InputEvent, { kind: 'key' }>): void

  constructor(term: Terminal) {
    this.term = term
  }

  close() {
    this.term.pop(this)
  }

  input(e: InputEvent) {
    if (e.kind === 'key') return this.key(e)
    if (e.kind === 'mouse' && e.type === 'down' && e.button === 0) {
      const hit = this.hits.find((h) => inRect(h.r, e.col, e.row))
      hit?.fn()
      this.term.invalidate()
    }
  }

  draw(c: Cells) {
    // Everything behind is dimmed.
    for (let k = 0; k < c.w * c.h; k++) {
      const v = c.fg[k]
      c.fg[k] = (((v >> 16) * 0.35) << 16) | ((((v >> 8) & 255) * 0.35) << 8) | ((v & 255) * 0.35)
      const b = c.bg[k]
      c.bg[k] = (((b >> 16) * 0.35) << 16) | ((((b >> 8) & 255) * 0.35) << 8) | ((b & 255) * 0.35)
    }
    const W = Math.min(60, c.w - 2)
    const inner = W - 6
    const lines: ((col: number, row: number) => void)[] = []
    this.hits = []
    for (const r of this.rows()) {
      if (r.t === 'gap') lines.push(() => {})
      else if (r.t === 'text')
        for (const l of wrap(r.text, inner)) lines.push((col, row) => c.text(col, row, l, r.fg || C.text, C.panel, r.bold))
      else if (r.t === 'tabs')
        lines.push((col, row) => {
          let x = col
          r.tabs.forEach((label, i) => {
            const on = i === r.value
            const text = ` ${label} `
            const bg = on ? (r.focused ? C.accent : C.field) : C.panel
            const fg = on && r.focused ? C.black : on ? C.text : C.dim
            const end = c.text(x, row, text, fg, bg, on)
            this.hits.push({ r: { col: x, row, w: end - x, h: 1 }, fn: () => r.pick(i) })
            x = end + 1
          })
        })
      else if (r.t === 'field')
        lines.push((col, row) => {
          const lw = 12
          c.text(col, row, r.label, r.bad ? C.bad : C.dim, C.panel)
          const fw = inner - lw
          c.fill({ col: col + lw, row, w: fw, h: 1 }, r.focused ? [64, 66, 76] : C.field)
          const shown = r.secret ? '•'.repeat(r.value.length) : r.value
          const visible = [...shown].slice(-(fw - 2)).join('')
          const end = c.text(col + lw + 1, row, visible, C.text, undefined)
          if (r.focused) c.put(end, row, '▏', C.accent)
          this.hits.push({ r: { col, row, w: inner, h: 1 }, fn: r.focus })
        })
      else
        lines.push((col, row) => {
          let x = col
          for (const b of r.items) {
            const bg = b.focused ? C.accent : b.primary ? [70, 72, 84] as Rgb : C.field
            const end = c.text(x, row, ` ${b.label} `, b.focused ? C.black : C.text, bg, !!b.primary)
            this.hits.push({ r: { col: x, row, w: end - x, h: 1 }, fn: b.fn })
            x = end + 2
          }
        })
    }
    const H = lines.length + 4
    const box = { col: Math.floor((c.w - W) / 2), row: Math.max(0, Math.floor((c.h - H) / 2)), w: W, h: H }
    c.fill(box, C.panel)
    c.frame(box, C.dim)
    c.text(box.col + 2, box.row, ` ${this.title} `, C.text, C.panel, true)
    c.text(box.col + W - 9, box.row + H - 1, ' Esc ✕ ', C.dim, C.panel)
    this.hits.push({ r: { col: box.col + W - 9, row: box.row + H - 1, w: 7, h: 1 }, fn: () => this.key({ kind: 'key', key: 'escape' }) })
    lines.forEach((draw, k) => draw(box.col + 3, box.row + 2 + k))
  }
}

// What a text field does with a key: types, deletes or clears. True when it used the key.
function edit(value: string, e: Extract<InputEvent, { kind: 'key' }>, max: number): string | null {
  if (e.key === 'backspace') return [...value].slice(0, -1).join('')
  if (e.ctrl && e.key === 'u') return ''
  if (e.ctrl || [...e.key].length !== 1) return null
  return (value + e.key).slice(0, max)
}

const looksLikePassphrase = (name: string) => /^\s*[a-z]+(\s+[a-z]+){3}\s*$/i.test(name)

// Log in or pick a name. onDone(true) once someone is logged in, onDone(false) when it's closed.
export class LoginDialog extends Dialog {
  title = 'Log in'
  private session: Session
  private onDone: (ok: boolean) => void
  private tab = 0
  private name = ''
  private phrase = ''
  private email = ''
  private password = ''
  // 0 the tabs, then the fields, then the button.
  private focus = 1
  private busy = false
  private error = ''
  private reason: string

  // reason: why it opened, shown at the top (such as when a guest picks up a piece).
  constructor(term: Terminal, session: Session, onDone: (ok: boolean) => void, reason = '') {
    super(term)
    this.session = session
    this.onDone = onDone
    this.reason = reason
  }

  private get fields() {
    return this.tab === 2 ? 2 : 1
  }

  rows(): Row[] {
    const f = (i: number) => this.focus === i
    const rows: Row[] = []
    if (this.reason) rows.push({ t: 'text', text: this.reason, fg: C.accent }, { t: 'gap' })
    rows.push({ t: 'tabs', tabs: ['New player', 'Passphrase', 'Email'], value: this.tab, focused: f(0), pick: (i) => this.switchTo(i) }, { t: 'gap' })
    const bad = !!this.error
    if (this.tab === 0) {
      rows.push({ t: 'text', text: 'Pick a name to play with. Everyone in the jigsaw sees it.' }, { t: 'gap' })
      rows.push({ t: 'field', label: 'Name', value: this.name, focused: f(1), bad, focus: () => (this.focus = 1) })
      if (looksLikePassphrase(this.name))
        rows.push({ t: 'text', text: 'This looks like a passphrase. Your name is shown to everyone, so never put your passphrase in it.', fg: C.bad })
    } else if (this.tab === 1) {
      rows.push({ t: 'text', text: 'Enter the four word passphrase you got when you first picked a name.' }, { t: 'gap' })
      rows.push({ t: 'field', label: 'Passphrase', value: this.phrase, focused: f(1), bad, focus: () => (this.focus = 1) })
    } else {
      rows.push({ t: 'text', text: 'Enter the email and password you switched your account to.' }, { t: 'gap' })
      rows.push({ t: 'field', label: 'Email', value: this.email, focused: f(1), bad, focus: () => (this.focus = 1) })
      rows.push({ t: 'field', label: 'Password', value: this.password, secret: true, focused: f(2), bad, focus: () => (this.focus = 2) })
    }
    if (this.error) rows.push({ t: 'text', text: this.error, fg: C.bad })
    rows.push({ t: 'gap' })
    const label = this.busy ? '…' : this.tab === 0 ? 'Continue →' : 'Log in →'
    rows.push({ t: 'buttons', items: [{ label, primary: true, focused: f(this.fields + 1), fn: () => this.submit() }] })
    rows.push({ t: 'gap' }, { t: 'text', text: 'Tab next field · ←/→ on the tabs to switch', fg: C.dim })
    return rows
  }

  private switchTo(i: number) {
    this.tab = i
    this.error = ''
    this.focus = 1
    this.term.invalidate()
  }

  private async submit() {
    if (this.busy) return
    const go =
      this.tab === 0
        ? this.name.trim() && (() => this.session.signUp(this.name.trim().slice(0, LIMITS.name)))
        : this.tab === 1
          ? this.phrase.trim() && (() => this.session.login(this.phrase.trim()))
          : this.email.trim() && this.password && (() => this.session.loginEmail(this.email.trim(), this.password))
    if (!go) return
    this.busy = true
    this.error = ''
    this.term.invalidate()
    try {
      await go()
      this.close()
      // A new player sees their passphrase once, as on the website after signing up.
      if (this.tab === 0) this.term.push(new PassphraseDialog(this.term, this.session.me!.passphrase, () => this.onDone(true)))
      else this.onDone(true)
    } catch (e) {
      this.error = (e as Error).message
    }
    this.busy = false
    this.term.invalidate()
  }

  key(e: Extract<InputEvent, { kind: 'key' }>) {
    const last = this.fields + 1
    if (e.key === 'escape') {
      this.close()
      this.onDone(false)
    } else if (e.key === 'tab' || e.key === 'down' || e.key === 'up') {
      const back = e.key === 'up' || (e.key === 'tab' && e.shift)
      this.focus = (this.focus + (back ? last : 1)) % (last + 1)
    } else if (this.focus === 0 && (e.key === 'left' || e.key === 'right')) {
      this.tab = (this.tab + (e.key === 'left' ? 2 : 1)) % 3
      this.error = ''
    } else if (e.key === 'enter') {
      if (this.focus === 0 || this.focus < this.fields) this.focus++
      else this.submit()
    } else if (this.focus >= 1 && this.focus <= this.fields) {
      const field = this.tab === 0 ? 'name' : this.tab === 1 ? 'phrase' : this.focus === 1 ? 'email' : 'password'
      const max = field === 'name' ? LIMITS.name : field === 'email' ? LIMITS.email : 200
      const v = edit(this[field], e, max)
      if (v !== null) {
        this[field] = v
        this.error = ''
      }
    }
    this.term.invalidate()
  }
}

// A new player's passphrase, shown once.
export class PassphraseDialog extends Dialog {
  title = 'Your passphrase'
  private phrase: string
  private onDone: () => void
  constructor(term: Terminal, phrase: string, onDone: () => void) {
    super(term)
    this.phrase = phrase
    this.onDone = onDone
  }
  rows(): Row[] {
    return [
      {
        t: 'text',
        text: 'Keep these four words somewhere safe. They are your login: use them to play as you on the website, another device, or after logging out. Press L on the jigsaws page to see them again.',
      },
      { t: 'gap' },
      { t: 'text', text: this.phrase, fg: C.accent, bold: true },
      { t: 'gap' },
      { t: 'buttons', items: [{ label: 'Got it →', primary: true, focused: true, fn: () => this.done() }] },
    ]
  }
  private done() {
    this.close()
    this.onDone()
  }
  key(e: Extract<InputEvent, { kind: 'key' }>) {
    if (e.key === 'enter' || e.key === 'escape') this.done()
  }
}

// Who is logged in, their passphrase, and logging out.
export class AccountDialog extends Dialog {
  title = 'Account'
  private session: Session
  private focus = 1
  constructor(term: Terminal, session: Session) {
    super(term)
    this.session = session
  }
  rows(): Row[] {
    const me = this.session.me!
    const rows: Row[] = [{ t: 'text', text: `Logged in as ${me.name}${me.email ? ` (${me.email})` : ''}.` }, { t: 'gap' }]
    if (me.passphrase) rows.push({ t: 'text', text: 'Your passphrase, to log in elsewhere:', fg: C.dim }, { t: 'text', text: me.passphrase, fg: C.accent, bold: true }, { t: 'gap' })
    rows.push({
      t: 'buttons',
      items: [
        { label: 'Log out', focused: this.focus === 0, fn: () => this.logout() },
        { label: 'Close', primary: true, focused: this.focus === 1, fn: () => this.close() },
      ],
    })
    return rows
  }
  private logout() {
    this.session.logout()
    this.close()
  }
  key(e: Extract<InputEvent, { kind: 'key' }>) {
    if (e.key === 'escape') return this.close()
    if (e.key === 'left' || e.key === 'right' || e.key === 'tab') this.focus = 1 - this.focus
    else if (e.key === 'enter') this.focus === 0 ? this.logout() : this.close()
    this.term.invalidate()
  }
}
