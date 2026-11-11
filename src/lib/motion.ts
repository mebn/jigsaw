// Whether the player asked for less motion (the system's reduce motion setting).
export const calmMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
