import type { ReactNode } from 'react'
import type { Engine } from '../lib/engine.ts'
import { Tray as TrayIcon } from './icons.tsx'
import PlaceButton from './PlaceButton.tsx'

// Toolbar button: drag it onto the board to put a tray there, or click to put one in the middle.
interface TrayButtonProps {
  engine: Engine
  hint?: ReactNode
}

export function TrayButton({ engine, hint }: TrayButtonProps) {
  const place = (x: number | null, y: number | null) => {
    if (x == null) return engine.addTray()
    const r = engine.canvas.getBoundingClientRect()
    engine.addTray(x - r.left, y! - r.top)
  }
  return (
    <PlaceButton onPlace={place} ghost="tray-ghost" label="Tray" shortcut="T" title="Drag a tray onto the board">
      <TrayIcon />
      {hint}
    </PlaceButton>
  )
}
