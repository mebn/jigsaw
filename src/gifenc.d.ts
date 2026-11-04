// gifenc ships without type declarations; this covers the parts the app uses.
declare module 'gifenc' {
  export type Palette = number[][]
  export type Format = 'rgb565' | 'rgb444' | 'rgba4444'
  export interface FrameOptions {
    palette?: Palette | null
    delay?: number
    repeat?: number
    transparent?: boolean
    transparentIndex?: number
    colorDepth?: number
    dispose?: number
    first?: boolean
  }
  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: FrameOptions): void
    finish(): void
    // A copy of the GIF so far.
    bytes(): Uint8Array<ArrayBuffer>
    // The GIF so far, without copying.
    bytesView(): Uint8Array<ArrayBuffer>
    reset(): void
  }
  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: Format; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number }): Palette
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: Format): Uint8Array
}
