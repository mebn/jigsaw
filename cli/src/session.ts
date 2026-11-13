// The site the terminal plays on, who is logged in there, and the API calls it makes. The login is
// kept between runs in a small file in the user's config folder, one per site.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import jpeg from 'jpeg-js'
import { ERRORS } from '../../shared/protocol.ts'
import type { PlayerLogin, RoomDetails, RoomSummary } from '../../shared/protocol.ts'
import type { Picture } from './view.ts'

const configDir = () =>
  process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'jigsaw')
    : process.platform === 'win32' && process.env.APPDATA
      ? join(process.env.APPDATA, 'jigsaw')
      : join(homedir(), '.config', 'jigsaw')
const loginsFile = () => join(configDir(), 'logins.json')

function readLogins(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(loginsFile(), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

// Error messages from the server, as they're shown.
const nice = (msg: string) => {
  if (msg === ERRORS.unknownPassphrase) return 'Unknown passphrase'
  if (msg === ERRORS.nameTaken) return 'That name is taken'
  return msg ? msg[0].toUpperCase() + msg.slice(1) : 'Something went wrong, try again'
}

// An answer from the server that wasn't ok. error: what it said, as sent (see ERRORS).
class ApiError extends Error {
  error: string
  constructor(error: string) {
    super(nice(error))
    this.error = error
  }
}

export class Session {
  origin: string
  me: PlayerLogin | null = null
  private listeners = new Set<() => void>()

  constructor(origin: string) {
    this.origin = origin
  }

  get passphrase() {
    return this.me?.passphrase || null
  }

  private async request<T>(path: string, body?: unknown, as?: string | null): Promise<T> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (as) headers['X-Passphrase'] = as
    let res: Response
    try {
      res = await fetch(this.origin + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch (e) {
      throw new Error(`Can't reach ${this.origin}: ${(e as Error & { cause?: Error }).cause?.message || (e as Error).message}`)
    }
    if (!res.ok) throw new ApiError(((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText)
    return res.json() as Promise<T>
  }

  // Logs in with a passphrase saved earlier (or given on the command line), if any.
  async restore(passphrase: string | null) {
    const saved = passphrase || readLogins()[this.origin]
    if (!saved) return
    try {
      this.set(await this.request<PlayerLogin>('/api/players/login', { passphrase: saved }))
    } catch (e) {
      // A passphrase that no longer works is forgotten; the player is a guest. One that only couldn't
      // be checked (no network, the site down, too many tries) is kept for next time.
      if (!passphrase && e instanceof ApiError && e.error === ERRORS.unknownPassphrase) this.save(null)
    }
  }

  private save(passphrase: string | null) {
    const all = readLogins()
    if (passphrase) all[this.origin] = passphrase
    else delete all[this.origin]
    try {
      mkdirSync(configDir(), { recursive: true })
      writeFileSync(loginsFile(), JSON.stringify(all, null, 2), { mode: 0o600 })
    } catch {}
  }

  // Calls fn whenever who is logged in changes; returns a function that stops it.
  listen(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private set(p: PlayerLogin | null) {
    this.me = p
    this.save(p?.passphrase || null)
    for (const fn of this.listeners) fn()
  }

  signUp = async (name: string) => this.set(await this.request<PlayerLogin>('/api/players', { name }))
  login = async (passphrase: string) => this.set(await this.request<PlayerLogin>('/api/players/login', { passphrase }))
  loginEmail = async (email: string, password: string) =>
    this.set(await this.request<PlayerLogin>('/api/players/email-login', { email, password }))
  logout = () => this.set(null)

  rooms = () => this.request<RoomSummary[]>('/api/rooms', undefined, this.passphrase)
  room = (id: string) => this.request<RoomDetails>(`/api/rooms/${encodeURIComponent(id)}`)
  // A jigsaw's picture ('image') or its small one ('thumb'), decoded.
  async picture(id: string, which: 'image' | 'thumb'): Promise<Picture> {
    const res = await fetch(`${this.origin}/api/rooms/${encodeURIComponent(id)}/${which}`)
    if (!res.ok) throw new Error(`Couldn't load the picture (${res.status})`)
    const type = res.headers.get('content-type') || ''
    if (!/jpe?g/.test(type)) throw new Error(`The picture is ${type}; only JPEG pictures can be shown`)
    return jpeg.decode(new Uint8Array(await res.arrayBuffer()), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 })
  }
}
