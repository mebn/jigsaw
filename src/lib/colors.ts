// Colours that mean something in play, the same on every page in the room.

// Each player's colour, for their cursor, what they select and their strokes.
const CURSOR_COLORS = ['#e5484d', '#0090ff', '#30a46c', '#f76b15', '#8e4ec6', '#d6409f', '#12a594', '#ca8a04']
export const cursorColor = (id: string) => {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length]
}

// The colours a tray can be, by name, as trays store them.
export const TRAY_COLORS: Record<string, string> = {
  blue: '#3b82f6',
  green: '#22a06b',
  yellow: '#e0a800',
  orange: '#f97316',
  red: '#e5484d',
  purple: '#8e4ec6',
  gray: '#8b8d98',
}
export const trayColor = (name: string | undefined) => TRAY_COLORS[name || ''] || TRAY_COLORS.gray
