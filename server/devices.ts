import type { IncomingMessage } from 'node:http'
import type { DeviceInfo } from '../shared/protocol.ts'
import type { Db } from './db.ts'
import { ipOf } from './http.ts'

// The browser, system and app a user agent names, as far as it says.
export function parseAgent(ua: string) {
  const inApp =
    /Instagram/.test(ua) ? 'Instagram'
    : /FBAN|FBAV|FB_IAB|FBIOS/.test(ua) ? (/Messenger|MESSENGER/.test(ua) ? 'Messenger' : 'Facebook')
    : /Snapchat/.test(ua) ? 'Snapchat'
    : /musical_ly|TikTok|BytedanceWebview/.test(ua) ? 'TikTok'
    : /LinkedInApp/.test(ua) ? 'LinkedIn'
    : /\bLine\//.test(ua) ? 'Line'
    : /Twitter/.test(ua) ? 'Twitter'
    : /; wv\)/.test(ua) ? 'Android web view'
    : /(iPhone|iPad|iPod).*AppleWebKit(?!.*Safari)/.test(ua) ? 'iOS web view'
    : ''
  const browser =
    /EdgA?\/|EdgiOS\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /CriOS\/|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : ''
  const os =
    /iPhone|iPod/.test(ua) ? 'iOS'
    : /iPad/.test(ua) ? 'iPadOS'
    : /Android/.test(ua) ? 'Android'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : ''
  const mobile = /Mobi|iPhone|iPod|Android/.test(ua)
  return { browser, os, mobile, inApp }
}

const STORAGE = new Set(['persisted', 'ok', 'blocked'])

// What the page says about itself, kept to what fits.
function cleanInfo(info: unknown): Partial<DeviceInfo> {
  if (!info || typeof info !== 'object') return {}
  const i = info as Record<string, unknown>
  return {
    storage: STORAGE.has(String(i.storage)) ? (i.storage as DeviceInfo['storage']) : undefined,
    screen: typeof i.screen === 'string' && /^\d{1,5}x\d{1,5}@[\d.]{1,5}$/.test(i.screen) ? i.screen : undefined,
    webgpu: typeof i.webgpu === 'boolean' ? i.webgpu : undefined,
  }
}

export function createDevices({ prepare }: Db) {
  const upsert = prepare(`
    INSERT INTO devices (player_id, ip, user_agent, browser, os, mobile, in_app, storage, screen, webgpu, first_action, first_seen, last_seen, visits)
    VALUES (:player, :ip, :ua, :browser, :os, :mobile, :inApp, coalesce(:storage, ''), coalesce(:screen, ''), :webgpu, :action, :now, :now, 1)
    ON CONFLICT (player_id, ip, user_agent) DO UPDATE SET
      last_seen = :now,
      visits = visits + 1,
      storage = coalesce(:storage, storage),
      screen = coalesce(:screen, screen),
      webgpu = coalesce(:webgpu, webgpu)`)

  // Notes that this player came from this request's address and browser. Never gets in the way of
  // the request it's part of.
  function seen(playerId: string, req: IncomingMessage, action: string, info: unknown) {
    try {
      const ua = String(req.headers['user-agent'] || '').slice(0, 512)
      const { browser, os, mobile, inApp } = parseAgent(ua)
      const i = cleanInfo(info)
      upsert.run({
        player: playerId,
        ip: ipOf(req),
        ua,
        browser,
        os,
        mobile: mobile ? 1 : 0,
        inApp,
        storage: i.storage ?? null,
        screen: i.screen ?? null,
        webgpu: i.webgpu === undefined ? null : i.webgpu ? 1 : 0,
        action,
        now: Date.now(),
      })
    } catch (e) {
      console.error('devices:', e)
    }
  }

  return { seen }
}

export type Devices = ReturnType<typeof createDevices>
