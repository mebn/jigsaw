import { createContext, useContext } from 'react'
import type { PlayerLogin } from '../../shared/protocol.ts'

export type Theme = 'light' | 'dark'

// What every page can reach: the look, sound and dev menu settings, and the logged in player.
export interface AppContext {
  theme: Theme
  toggleTheme: () => void
  sound: boolean
  toggleSound: () => void
  devMenu: boolean
  toggleDevMenu: () => void
  player: PlayerLogin | null
  playerId: string | null
  // The player right now, for code that runs after an await (state in a closure may be stale).
  currentPlayer: () => PlayerLogin | null
  name: string | null
  setName: (v: string) => Promise<void>
  // Resolves with the player's id, asking for a name first if needed (null if they cancel).
  requireName: () => Promise<string | null>
  // For event handlers: true if logged in, otherwise opens the prompt.
  ensureName: () => boolean
  openLogin: () => Promise<string | null>
  logout: () => void
  // Switches this player's login from their passphrase to an email and password.
  switchToEmail: (email: string, password: string) => Promise<void>
  roomId: string | null
}

export const AppCtx = createContext<AppContext | null>(null)
export const useApp = () => useContext(AppCtx)!
