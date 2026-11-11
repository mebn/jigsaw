import type { SVGProps } from 'react'

export type IconProps = SVGProps<SVGSVGElement>

const Svg = ({ children, ...p }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...p}
  >
    {children}
  </svg>
)

export const Rooms = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
  </Svg>
)

export const Moon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Svg>
)

export const Sound = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5h3l4.5-4v13L7 14.5H4v-5Z" />
    <path d="M15 9a4 4 0 0 1 0 6" />
    <path d="M17.5 6.5a7.5 7.5 0 0 1 0 11" />
  </Svg>
)

export const Plus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const Back = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 5 8 12l7 7" />
  </Svg>
)

export const Arrow = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
)

export const Upload = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m20.5 16-5-5-9 8.5" />
  </Svg>
)

export const Trash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
  </Svg>
)

export const Users = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14.2A5.5 5.5 0 0 1 20.5 19" />
  </Svg>
)

export const User = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Svg>
)

export const Note = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4h14v10l-5 6H5V4Z" />
    <path d="M14 20v-6h5" />
  </Svg>
)

// A speech bubble, for replying to a note.
export const Reply = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5h16v11H10l-6 4V5Z" />
  </Svg>
)

export const Search = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 5 5" />
  </Svg>
)

export const Tray = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <path d="M3.5 9.5h17" />
  </Svg>
)

export const Close = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const Check = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
)

export const Copy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
    <path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" />
  </Svg>
)

// The clock and piece outlines as path data, for drawing them on a canvas too (see share.ts).
export const CLOCK_PATH = 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 7.5V12l3 2'
export const PIECE_PATH = 'M5 5h4.5a2.5 2.5 0 1 1 5 0H19v4.5a2.5 2.5 0 1 1 0 5V19h-4.5a2.5 2.5 0 1 0-5 0H5v-4.5a2.5 2.5 0 1 0 0-5V5Z'

export const Clock = (p: IconProps) => (
  <Svg {...p}>
    <path d={CLOCK_PATH} />
  </Svg>
)

export const Piece = (p: IconProps) => (
  <Svg {...p}>
    <path d={PIECE_PATH} />
  </Svg>
)

export const Help = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4" />
    <circle cx="12" cy="16.6" r=".6" fill="currentColor" />
  </Svg>
)

export const Picture = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4.5 17.5 5-5 3.5 3.5 2.5-2.5 4 4" />
  </Svg>
)

export const GitHub = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 19c-4 1.3-4-2-5.5-2.5M15 21v-3.2c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 3.1 5.4 3.4 5.4 3.4a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.8c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
  </Svg>
)

export const Gear = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </Svg>
)

export const Key = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m10.8 12.2 8.7-8.7M16.5 6.5l2.5 2.5M14 9l2 2" />
  </Svg>
)

export const Chevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="m7 10 5 5 5-5" />
  </Svg>
)

export const Crown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 17.5 3 8l5 3.5L12 5l4 6.5L21 8l-1.5 9.5z" />
  </Svg>
)

export const Lock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </Svg>
)

export const Logout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M9 16l-4-4 4-4M5 12h10" />
  </Svg>
)

export const Changelog = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4h7l4 4v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
    <path d="M14 4v4h4M9 12h6M9 16h4" />
  </Svg>
)

export const External = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Svg>
)

export const Hand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5v-6a1.5 1.5 0 0 1 3 0v6M14 10.5V6a1.5 1.5 0 0 1 3 0v7.5a6.5 6.5 0 0 1-6.5 6.5h-.6a6 6 0 0 1-4.6-2.2l-2.7-3.3a1.6 1.6 0 0 1 2.3-2.2L8 15" />
  </Svg>
)

export const Split = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M12 5v14" />
  </Svg>
)

// Split screen as a half on the left and two quarters on the right.
export const Split3 = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M12 5v14M12 12h9" />
  </Svg>
)

// Split screen in quarters.
export const Split4 = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M12 5v14M3 12h18" />
  </Svg>
)

export const Pencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5Z" />
    <path d="M13.5 7l3 3" />
  </Svg>
)

export const Wrench = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.7 6.3a4 4 0 0 0 5 5L21 10a5.5 5.5 0 0 1-7.4 6.6L7.5 22.7a2.1 2.1 0 0 1-3-3l6.1-6.1A5.5 5.5 0 0 1 17.2 6l-2.5 2.5z" />
  </Svg>
)

export const Share = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15V4M8 7.5 12 3.5l4 4" />
    <path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12" />
  </Svg>
)
