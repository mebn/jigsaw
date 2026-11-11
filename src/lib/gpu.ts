// WebGPU renderer for the table. The engine works out what goes where each frame (see drawGpu() in
// engine.ts); this draws it, the whole table every frame:
//
// - the table,
// - trays (rounded boxes) and reference images,
// - the pieces, one instance each, from their sprites in two texture atlases laid out alike (texture
//   arrays of pages, every sprite in its own cell, with its smaller copies in the mip levels): the
//   picture around each piece, and its shape, which cuts the piece out with a sharp edge at any zoom
//   (see sprites.ts),
// - the selection and hover outlines: the pieces' silhouettes go into a mask, which is grown by the
//   outline's width and has the silhouettes, grown a little, cut back out,
// - the drop shadow of lifted pieces: their silhouettes at a third of the resolution, blurred.
//
// Positions reach the GPU in device pixels, worked out on the CPU, so the shaders don't need the camera.

import { SDF_R } from './sprites.ts'
import type { ShapePixels } from './sprites.ts'

// The atlases' layout (see Gpu): how many sprites (cells), their size in pixels (spw, sph), and how
// many mip levels each comes with (the sprite and its halved copies).
interface GpuAtlasLayout {
  cells: number
  spw: number
  sph: number
  levels: number
}
// A colour, [r, g, b, a], each 0 to 1, not premultiplied.
export type Rgba = readonly number[]
// A run of piece instances, [first, count].
type GpuRange = readonly number[]
// A box on the screen, [x0, y0, x1, y1] in device pixels.
type ScreenBox = readonly number[]
// Instances for one kind of thing: count of them, each PIECE_FLOATS, TRAY_FLOATS or REF_FLOATS
// floats in data.
interface GpuInstances {
  data: Float32Array
  count: number
}
// Another player's outline (see GpuFrame).
export interface GpuOutline {
  range: GpuRange
  box: ScreenBox
  color: Rgba
  over?: boolean
}
// What frame() draws (see there).
interface GpuFrame {
  W: number
  H: number
  cam: readonly number[]
  sprite: readonly number[]
  bg: Rgba
  // The first down trays lie on the table, the rest are lifted.
  trays: GpuInstances & { down: number }
  refs: GpuInstances
  pieces: GpuInstances
  seg: { still: GpuRange; trayed: GpuRange; trayedUp: GpuRange; lift: GpuRange; shade: GpuRange; sel: GpuRange; hl: GpuRange }
  selBox: ScreenBox
  hlBox: ScreenBox
  selColor: Rgba
  hlColor: Rgba
  outline: readonly number[]
  extra?: GpuOutline[]
  selUnder?: boolean
  hlOver?: boolean
  shadow: { color: Rgba; blur: number; ox: number; oy: number } | null
  // Where on the canvas this frame goes, for split screen: its top left corner (device pixels), and
  // whether it clears the canvas first (the first pane does, the others draw beside it). W and H are
  // then the pane's size. Default: all of it.
  pane?: { x: number; y: number; clear: boolean }
}
type PostName = 'blurX' | 'blurY' | 'shadow' | 'sel' | 'hl'
type PipeName =
  | 'bg'
  | 'tray'
  | 'trayMask'
  | 'ref'
  | 'piece'
  | 'maskR'
  | 'maskG'
  | 'shadowMask'
  | 'blur'
  | 'shadow'
  | 'outline'
  | 'picture'
  | 'halveColor'
// Another player's outline's mask, settings and bind group (see extraMask()).
interface ExtraMask {
  tex: GPUTexture
  buf: GPUBuffer
  group: GPUBindGroup
}

// Floats per instance: pieces [m00 m01 m10 m11 x y cell -], trays [rect fill stroke (radius width
// lift angle)], images [rect border (width opacity angle -) part]. An angle (radians) turns the box
// around its middle. The instance classes below write them.
const PIECE_FLOATS = 8
const TRAY_FLOATS = 16
const REF_FLOATS = 16

// A colour premultiplied by its alpha, and by alpha on top.
export const premul = ([r, g, b, a]: Rgba, alpha = 1) => [r * a * alpha, g * a * alpha, b * a * alpha, a * alpha]

// The instances of one kind of thing for a frame, written one after another in the layout its
// shader reads. Colours given to them are premultiplied (see premul()).
class Instances implements GpuInstances {
  data = new Float32Array(0)
  u32 = new Uint32Array(0)
  count = 0
  private floats: number
  constructor(floats: number) {
    this.floats = floats
  }
  // Starts over, with room for n of them (more can still be added).
  reset(n: number) {
    this.count = 0
    this.room(n)
  }
  private room(n: number) {
    if (this.data.length >= n * this.floats) return
    const data = new Float32Array(Math.max(n * this.floats, this.data.length * 2))
    data.set(this.data)
    this.data = data
    this.u32 = new Uint32Array(data.buffer)
  }
  protected next() {
    this.room(this.count + 1)
    return this.count++ * this.floats
  }
}

export class PieceInstances extends Instances {
  constructor() {
    super(PIECE_FLOATS)
  }
  // The piece in atlas cell, turned a (radians) and scaled z (device px per sprite unit), its middle
  // at (x, y) in device px.
  put(cell: number, a: number, z: number, x: number, y: number) {
    const k = this.next()
    const c = Math.cos(a) * z
    const s = Math.sin(a) * z
    this.data.set([c, s, -s, c, x, y], k)
    this.u32[k + 6] = cell
  }
}

export class TrayInstances extends Instances {
  constructor() {
    super(TRAY_FLOATS)
  }
  // A tray's box (device px) with rounded corners, its fill and its border, how far it's lifted (0 to
  // 1, how strong its shadow is), and how far it's turned around its middle (radians).
  put(rect: readonly number[], fill: readonly number[], stroke: readonly number[], radius: number, width: number, lift: number, angle = 0) {
    this.data.set([...rect, ...fill, ...stroke, radius, width, lift, angle], this.next())
  }
}

export class RefInstances extends Instances {
  constructor() {
    super(REF_FLOATS)
  }
  // An image's box (device px), its border, how see-through it is, the part of the picture that
  // shows ([x, y, w, h] as fractions of it), and how far it's turned around its middle (radians).
  put(rect: readonly number[], border: readonly number[], width: number, opacity: number, part: readonly number[], angle = 0) {
    this.data.set([...rect, ...border, width, opacity, angle, 0, ...part], this.next())
  }
}

// The shadow mask's resolution, as a fraction of the screen's.
const SHADOW_K = 3

const COMMON = /* wgsl */ `
struct U {
  // Screen size (device pixels), sprite size (world units).
  s0: vec4f,
  // Atlas page size, cell size (pixels).
  s1: vec4f,
  // Sprite size (pixels), sprites per row, sprites per page.
  s2: vec4f,
  bg: vec4f,
  // The world point at the middle of the screen, device pixels per world unit.
  cam: vec4f,
  // The screen's top left corner on the canvas (device pixels; not 0 for most panes of a split
  // screen), and the size of the screen sized textures (the mask), which hold it from their corner.
  pane: vec4f,
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;

fn clip(d: vec2f) -> vec4f {
  return vec4f(d.x / u.s0.x * 2.0 - 1.0, 1.0 - d.y / u.s0.y * 2.0, 0.0, 1.0);
}

// The corners of a quad drawn as two triangles, in 0..1.
fn corner(vi: u32) -> vec2f {
  let k = vi % 6u;
  return vec2f(select(0.0, 1.0, k == 1u || k == 4u || k == 5u), select(0.0, 1.0, k == 2u || k == 3u || k == 5u));
}

// The point q off a box's middle c, with the box turned by a (radians).
fn turned(c: vec2f, q: vec2f, a: f32) -> vec2f {
  let k = vec2f(cos(a), sin(a));
  return c + vec2f(q.x * k.x - q.y * k.y, q.x * k.y + q.y * k.x);
}

// Signed distance from a box of half size hs, rounded by r, centred on the origin.
fn box(d: vec2f, hs: vec2f, r: f32) -> f32 {
  let q = abs(d) - hs + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// One triangle covering the screen.
@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  return vec4f(f32(vi & 1u) * 4.0 - 1.0, f32(vi >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
`

const BG = /* wgsl */ `
@fragment fn fsBg() -> @location(0) vec4f {
  return vec4f(u.bg.rgb, 1.0);
}
`

const TRAY = /* wgsl */ `
struct O {
  @builtin(position) p: vec4f,
  @location(0) d: vec2f,
  @location(1) @interpolate(flat) hs: vec2f,
  @location(2) @interpolate(flat) fill: vec4f,
  @location(3) @interpolate(flat) stroke: vec4f,
  @location(4) @interpolate(flat) prm: vec4f,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4f, @location(1) fill: vec4f,
              @location(2) stroke: vec4f, @location(3) prm: vec4f) -> O {
  let e = prm.y * 0.5 + 1.0;
  let hs = (rect.zw - rect.xy) * 0.5;
  let q = mix(-hs - e, hs + e, corner(vi));
  var o: O;
  o.p = clip(turned((rect.xy + rect.zw) * 0.5, q, prm.w));
  o.d = q;
  o.hs = hs;
  o.fill = fill;
  o.stroke = stroke;
  o.prm = prm;
  return o;
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let s = box(i.d, i.hs, i.prm.x);
  let f = clamp(0.5 - s, 0.0, 1.0);
  let k = clamp(i.prm.y * 0.5 + 0.5 - abs(s), 0.0, 1.0);
  return i.stroke * k + i.fill * f * (1.0 - i.stroke.a * k);
}
// A lifted tray's shape in the shadow mask, as strong as it's lifted (prm.z).
@fragment fn fsMask(i: O) -> @location(0) vec4f {
  return vec4f(clamp(0.5 - box(i.d, i.hs, i.prm.x), 0.0, 1.0) * i.prm.z);
}
`

const REF = /* wgsl */ `
@group(1) @binding(0) var tex: texture_2d<f32>;
struct O {
  @builtin(position) p: vec4f,
  @location(0) d: vec2f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) hs: vec2f,
  @location(3) @interpolate(flat) border: vec4f,
  @location(4) @interpolate(flat) bw: f32,
  @location(5) @interpolate(flat) op: f32,
  @location(6) @interpolate(flat) part: vec4f,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4f, @location(1) border: vec4f,
              @location(2) prm: vec4f, @location(3) part: vec4f) -> O {
  let e = prm.x * 0.5 + 1.0;
  let hs = (rect.zw - rect.xy) * 0.5;
  let q = mix(-hs - e, hs + e, corner(vi));
  var o: O;
  o.p = clip(turned((rect.xy + rect.zw) * 0.5, q, prm.z));
  o.d = q;
  o.uv = part.xy + (q + hs) / (hs * 2.0) * part.zw;
  o.part = part;
  o.hs = hs;
  o.border = border;
  o.bw = prm.x;
  o.op = prm.y;
  return o;
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let s = box(i.d, i.hs, 0.0);
  let img = textureSample(tex, samp, clamp(i.uv, i.part.xy, i.part.xy + i.part.zw)) * clamp(0.5 - s, 0.0, 1.0) * i.op;
  let k = clamp(i.bw * 0.5 + 0.5 - abs(s), 0.0, 1.0);
  return i.border * k + img * (1.0 - i.border.a * k);
}
`

const PIECE = /* wgsl */ `
// How far a piece's shape's distance reaches either side of its outline, in sprite pixels (see
// SDF_R in sprites.ts).
const SDF_R = ${SDF_R}.0;
@group(1) @binding(0) var atlas: texture_2d_array<f32>;
@group(1) @binding(1) var shapes: texture_2d_array<f32>;
// Each piece's four corners, two vec4s each: the corner in sprite pixels and the outward normal of
// the side coming into it, then the outward normal of the side leaving it and 1 when the corner is
// to be kept sharp (0 next to a side inside a long piece).
@group(1) @binding(2) var<storage, read> corners: array<vec4f>;
struct O {
  @builtin(position) p: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) layer: u32,
  @location(2) sp: vec2f,
  @location(3) @interpolate(flat) cell: u32,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) m: vec4f, @location(1) pos: vec2f,
              @location(2) cell: u32) -> O {
  let c = corner(vi);
  let l = (c - 0.5) * u.s0.zw;
  var o: O;
  o.p = clip(vec2f(m.x * l.x + m.z * l.y, m.y * l.x + m.w * l.y) + pos);
  let perRow = u32(u.s2.z);
  let perPage = u32(u.s2.w);
  let k = cell % perPage;
  o.uv = (vec2f(f32(k % perRow), f32(k / perRow)) * u.s1.zw + c * u.s2.xy) / u.s1.xy;
  o.layer = cell / perPage;
  o.sp = c * u.s2.xy;
  o.cell = cell;
  return o;
}
// How far inside the piece this pixel is, in pixels of the mip level being read (negative outside;
// each level has its own distance, see sprites.ts). Blending the shape's distance between sprite
// pixels rounds the piece's corners off, by up to half a sprite pixel, which shows zoomed far in as
// a gap where corners meet. So near a corner the distance is worked out from the corner itself.
fn inside(i: O, r: f32) -> f32 {
  var d = (r - 0.5) * 2.0 * SDF_R;
  // Full size sprite pixels per pixel of the level being read, near enough.
  let px = max(length(dpdx(i.sp)), length(dpdy(i.sp)));
  let lod = clamp(log2(max(px, 1e-4)), 0.0, f32(textureNumLevels(shapes) - 1u));
  let unit = exp2(lod);
  for (var n = 0u; n < 4u; n++) {
    let a = corners[i.cell * 8u + n * 2u];
    let b = corners[i.cell * 8u + n * 2u + 1u];
    let q = i.sp - a.xy;
    let far = length(q);
    if (b.z > 0.5 && far < 2.5) {
      let h = vec2f(dot(q, a.zw), dot(q, b.xy));
      let out = length(max(h, vec2f(0.0))) + min(max(h.x, h.y), 0.0);
      d = mix(d, -out / unit, clamp(2.5 - far, 0.0, 1.0));
    }
  }
  return d;
}
// How much of this pixel is inside the piece, at a distance d inside it, grown by grow screen
// pixels. The distance changes linearly across the outline at any zoom, so measured in screen
// pixels (fwidth) it gives an edge a pixel wide.
fn cover(d: f32, grow: f32) -> f32 {
  return clamp(d / max(fwidth(d), 1e-4) + 0.5 + grow, 0.0, 1.0);
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let c = textureSample(atlas, samp, i.uv, i.layer);
  let s = textureSample(shapes, samp, i.uv, i.layer);
  let d = inside(i, s.r);
  // A piece reaches a screen pixel past its outline, under the line, so pieces side by side
  // overlap a little instead of letting the table show between them. Past the picture's own edge
  // there is nothing, so it stops there.
  let k = cover(d, 1.0) * clamp(c.a * 2.0, 0.0, 1.0);
  // A thin line on the cut sides' outline, a couple of screen pixels wide at any zoom, so joined
  // pieces still show.
  let line = clamp(1.25 - abs(d) / max(fwidth(d), 1e-4), 0.0, 1.0) * 0.3 * s.g;
  let rgb = mix(c.rgb / max(c.a, 1e-4), vec3f(0.0), line);
  return vec4f(rgb * k, k);
}
@fragment fn fsMask(i: O) -> @location(0) vec4f {
  return vec4f(cover(inside(i, textureSample(shapes, samp, i.uv, i.layer).r), 0.0));
}
`

const POST = /* wgsl */ `
@group(1) @binding(0) var src: texture_2d<f32>;
struct P { a: vec4f, b: vec4f, c: vec4f }
@group(1) @binding(1) var<uniform> pu: P;

// a: direction (x, y), sigma and reach in texels; b: the texture's size.
@fragment fn fsBlur(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let size = pu.b.xy;
  let uv = p.xy / size;
  let sigma = max(pu.a.z, 0.001);
  let n = i32(pu.a.w);
  var sum = 0.0;
  var wsum = 0.0;
  for (var k = -n; k <= n; k++) {
    let x = f32(k);
    let w = exp(-x * x / (2.0 * sigma * sigma));
    sum += textureSampleLevel(src, samp, uv + pu.a.xy * x / size, 0.0).r * w;
    wsum += w;
  }
  return vec4f(sum / wsum);
}

// a: colour; b: offset (device pixels), and the screen size the texture covers.
@fragment fn fsShadow(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let uv = (p.xy - pu.b.xy) / pu.b.zw;
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
  let a = textureSampleLevel(src, samp, uv, 0.0).r;
  return pu.a * select(0.0, a, inside);
}

fn mask(p: vec2f) -> f32 {
  return dot(textureSampleLevel(src, samp, (p - u.pane.xy) / u.pane.zw, 0.0), pu.b);
}

// a: colour; b: which channel of the mask; c: outline width and the cut out's growth (device pixels).
// The mask is grown by the width: the most of it anywhere within a disc that wide, sampled in rings
// that fill the disc, so the outline is as thick everywhere and hugs corners. The mask's soft edge
// keeps the outline's edges smooth.
@fragment fn fsOutline(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let m0 = mask(p.xy);
  var grown = m0;
  for (var ring = 1; ring <= 4; ring++) {
    let rr = pu.c.x * f32(ring) / 4.0;
    let n = 6 * ring + 4;
    let turn = 0.5 * f32(ring % 2);
    for (var k = 0; k < n; k++) {
      let a = (f32(k) + turn) * 6.2831853 / f32(n);
      grown = max(grown, mask(p.xy + vec2f(cos(a), sin(a)) * rr));
    }
  }
  var cut = m0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.7853982;
    cut = max(cut, mask(p.xy + vec2f(cos(a), sin(a)) * pu.c.y));
  }
  return pu.a * (grown * (1.0 - cut));
}
`

// Draws the picture around each piece into its cell of the colour atlas, as the sprite shows it:
// sprite pixels per world unit sc, the piece's middle in the middle of the sprite. Past the
// picture's edge there is nothing, with the pixels it ends in partly covered.
const PICTURE = /* wgsl */ `
struct PU {
  // Atlas page size, sprite size (pixels).
  a: vec4f,
  // Cell size (pixels), sprites per row, sprites per page.
  b: vec4f,
  // sc, picture uv per world unit (x, y), -.
  c: vec4f,
  // The picture's size in world units.
  d: vec4f,
}
@group(0) @binding(0) var<uniform> pu: PU;
@group(0) @binding(1) var pic: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct O {
  @builtin(position) p: vec4f,
  @location(0) @interpolate(flat) org: vec2f,
  @location(1) @interpolate(flat) mid: vec2f,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) cell: u32, @location(0) mid: vec2f) -> O {
  let k = vi % 6u;
  let c = vec2f(select(0.0, 1.0, k == 1u || k == 4u || k == 5u), select(0.0, 1.0, k == 2u || k == 3u || k == 5u));
  let perRow = u32(pu.b.z);
  let n = cell % u32(pu.b.w);
  var o: O;
  o.org = vec2f(f32(n % perRow), f32(n / perRow)) * pu.b.xy;
  let d = o.org + c * pu.a.zw;
  o.p = vec4f(d.x / pu.a.x * 2.0 - 1.0, 1.0 - d.y / pu.a.y * 2.0, 0.0, 1.0);
  o.mid = mid;
  return o;
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let sc = pu.c.x;
  let w = i.mid + (i.p.xy - i.org - pu.a.zw * 0.5) / sc;
  let c = textureSampleLevel(pic, samp, w * pu.c.yz, 0.0);
  let h = 0.5 / sc;
  let cover = clamp((min(w + h, pu.d.xy) - max(w - h, vec2f(0.0))) / (2.0 * h), vec2f(0.0), vec2f(1.0));
  return c * cover.x * cover.y;
}
`

// One mip level from the one above it: each pixel the average of the 2 x 2 it covers (the last row
// or column standing in for a missing one). Cells are a multiple of the coarsest step apart, so each
// sprite's halved copy lands in its own cell.
const HALVE = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  return vec4f(f32(vi & 1u) * 4.0 - 1.0, f32(vi >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let s = vec2i(textureDimensions(src)) - 1;
  let q = vec2i(p.xy) * 2;
  return (textureLoad(src, min(q, s), 0) + textureLoad(src, min(q + vec2i(1, 0), s), 0) +
          textureLoad(src, min(q + vec2i(0, 1), s), 0) + textureLoad(src, min(q + 1, s), 0)) * 0.25;
}
`

// canvas holds the table, top the trays and everything above the notes (see frame()).
export async function createGpu(canvas: HTMLCanvasElement, top: HTMLCanvasElement, atlas: GpuAtlasLayout): Promise<Gpu> {
  if (!navigator.gpu) throw new Error('WebGPU is not available')
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('No WebGPU adapter')
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxTextureDimension2D: Math.min(8192, adapter.limits.maxTextureDimension2D),
      maxTextureArrayLayers: adapter.limits.maxTextureArrayLayers,
    },
  })
  const ctx = canvas.getContext('webgpu')
  if (!ctx) throw new Error('No WebGPU canvas context')
  const format = navigator.gpu.getPreferredCanvasFormat()
  ctx.configure({ device, format, alphaMode: 'opaque' })
  const ctxTop = top.getContext('webgpu')
  if (!ctxTop) throw new Error('No WebGPU canvas context')
  ctxTop.configure({ device, format, alphaMode: 'premultiplied' })
  const gpu = new Gpu(device, ctx, ctxTop, format, atlas)
  await gpu.init()
  return gpu
}

export type { Gpu }

class Gpu {
  declare device: GPUDevice
  declare ctx: GPUCanvasContext
  declare ctxTop: GPUCanvasContext
  declare format: GPUTextureFormat
  // Called with why, when the GPU device is lost.
  declare onLost: ((why: string) => void) | null
  declare cell: { cw: number; ch: number; perRow: number; perPage: number; levels: number }
  declare atlasSize: [number, number]
  declare spritePx: [number, number]
  declare atlas: GPUTexture
  declare shapes: GPUTexture
  declare corners: GPUBuffer
  // Which cells have their shape on the GPU (1).
  declare has: Uint8Array
  declare uniform: Float32Array
  declare ubuf: GPUBuffer
  declare post: Record<PostName, GPUBuffer>
  declare buffers: Record<string, GPUBuffer>
  declare size: [number, number]
  declare xs: ExtraMask[]
  // Made in init().
  declare sampler: GPUSampler
  declare lTex: GPUBindGroupLayout
  declare lPost: GPUBindGroupLayout
  declare g0: GPUBindGroup
  declare gAtlas: GPUBindGroup
  declare pipes: Record<PipeName, GPURenderPipeline>
  // Made in setRefImage().
  declare refTex: GPUTexture
  declare gRef: GPUBindGroup
  // Made in targets().
  declare mask: GPUTexture
  declare shA: GPUTexture
  declare shB: GPUTexture
  declare shSize: [number, number]
  declare gBlurX: GPUBindGroup
  declare gBlurY: GPUBindGroup
  declare gShadow: GPUBindGroup
  declare gSel: GPUBindGroup
  declare gHl: GPUBindGroup

  // atlas: { cells, spw, sph, levels }: how many sprites, their size in pixels, and how many mip
  // levels each comes with (the sprite and its halved copies).
  constructor(device: GPUDevice, ctx: GPUCanvasContext, ctxTop: GPUCanvasContext, format: GPUTextureFormat, { cells, spw, sph, levels }: GpuAtlasLayout) {
    this.device = device
    this.ctx = ctx
    this.ctxTop = ctxTop
    this.format = format
    this.onLost = null
    device.lost.then((info) => this.onLost?.(info.message || info.reason))
    device.addEventListener('uncapturederror', (e) => console.error('WebGPU:', e.error.message))

    // Every cell is a multiple of the coarsest mip level's step, with a clear gutter, so the
    // halved copies land exactly in their cell and never bleed into a neighbour's.
    const P = device.limits.maxTextureDimension2D
    const step = 1 << (levels - 1)
    const cw = Math.ceil((spw + step) / step) * step
    const ch = Math.ceil((sph + step) / step) * step
    const perRow = Math.max(1, Math.floor(P / cw))
    const rows = Math.ceil(cells / perRow)
    const rowsPerPage = Math.max(1, Math.floor(P / ch))
    const layers = Math.ceil(rows / rowsPerPage)
    if (cw > P || ch > P || layers > device.limits.maxTextureArrayLayers) throw new Error('Too many pieces for the GPU')
    const pw = rows > 1 ? perRow * cw : cells * cw
    const ph = (layers > 1 ? rowsPerPage : rows) * ch
    this.cell = { cw, ch, perRow, perPage: perRow * rowsPerPage, levels }
    this.atlasSize = [pw, ph]
    this.spritePx = [spw, sph]
    const atlas = (format: GPUTextureFormat) =>
      device.createTexture({
        size: [pw, ph, layers],
        format,
        mipLevelCount: levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
    this.atlas = atlas('rgba8unorm')
    this.shapes = atlas('rg8unorm')
    // Each piece's corners (see PIECE above), set with setCorners().
    this.corners = device.createBuffer({ size: Math.max(1, cells) * 8 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.has = new Uint8Array(cells)

    this.uniform = new Float32Array(24)
    this.ubuf = device.createBuffer({ size: this.uniform.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    // Blur (two passes), shadow and outline (selection, hover) settings.
    this.post = {} as Record<PostName, GPUBuffer>
    for (const k of ['blurX', 'blurY', 'shadow', 'sel', 'hl'] as const) {
      this.post[k] = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    }
    this.buffers = {}
    this.size = [0, 0]
    // Masks, settings and bind groups for other players' outlines, made as they're needed.
    this.xs = []
  }

  async init() {
    const d = this.device
    const F = GPUShaderStage.FRAGMENT
    const V = GPUShaderStage.VERTEX
    this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })
    const l0 = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: V | F, buffer: {} },
        { binding: 1, visibility: F, sampler: {} },
      ],
    })
    const lAtlas = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, texture: { viewDimension: '2d-array' } },
        { binding: 1, visibility: F, texture: { viewDimension: '2d-array' } },
        { binding: 2, visibility: F, buffer: { type: 'read-only-storage' } },
      ],
    })
    const lTex = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: {} }] })
    const lPost = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, texture: {} },
        { binding: 1, visibility: F, buffer: {} },
      ],
    })
    this.lTex = lTex
    this.lPost = lPost
    this.g0 = d.createBindGroup({
      layout: l0,
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: this.sampler },
      ],
    })
    this.gAtlas = d.createBindGroup({
      layout: lAtlas,
      entries: [
        { binding: 0, resource: this.atlas.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: this.shapes.createView({ dimension: '2d-array' }) },
        { binding: 2, resource: { buffer: this.corners } },
      ],
    })

    const module = async (code: string) => {
      const m = d.createShaderModule({ code: COMMON + code })
      const info = await m.getCompilationInfo()
      const errors = info.messages.filter((x) => x.type === 'error')
      if (errors.length) throw new Error(errors.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('\n'))
      return m
    }
    const [mBg, mTray, mRef, mPiece, mPost] = await Promise.all([BG, TRAY, REF, PIECE, POST].map(module))
    const over: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }
    const max: GPUBlendState = { color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' } }
    const layout = (...groups: GPUBindGroupLayout[]) => d.createPipelineLayout({ bindGroupLayouts: [l0, ...groups] })
    const attrs = (...formats: GPUVertexFormat[]): GPUVertexAttribute[] => {
      let offset = 0
      const sizes: Record<string, number> = { float32x4: 16, float32x2: 8, uint32: 4 }
      const attributes = formats.map((format, shaderLocation) => {
        const a = { format, offset, shaderLocation }
        offset += sizes[format]
        return a
      })
      return attributes
    }
    const pieceBuffers: GPUVertexBufferLayout[] = [{ arrayStride: PIECE_FLOATS * 4, stepMode: 'instance', attributes: attrs('float32x4', 'float32x2', 'uint32') }]
    const pipe = (m: GPUShaderModule, vs: string, fs: string, buffers: GPUVertexBufferLayout[], target: GPUColorTargetState, layoutGroups: GPUBindGroupLayout[]) =>
      d.createRenderPipelineAsync({
        layout: layout(...layoutGroups),
        vertex: { module: m, entryPoint: vs, buffers },
        fragment: { module: m, entryPoint: fs, targets: [target] },
        primitive: { topology: 'triangle-list' },
      })
    const screen: GPUColorTargetState = { format: this.format, blend: over }
    const trayBuffers: GPUVertexBufferLayout[] = [{ arrayStride: TRAY_FLOATS * 4, stepMode: 'instance', attributes: attrs('float32x4', 'float32x4', 'float32x4', 'float32x4') }]
    const [bg, tray, trayMask, ref, piece, maskR, maskG, shadowMask, blur, shadow, outline] = await Promise.all([
      pipe(mBg, 'vsFull', 'fsBg', [], { format: this.format }, []),
      pipe(mTray, 'vs', 'fs', trayBuffers, screen, []),
      pipe(mTray, 'vs', 'fsMask', trayBuffers, { format: 'r8unorm', blend: over }, []),
      pipe(mRef, 'vs', 'fs', [{ arrayStride: REF_FLOATS * 4, stepMode: 'instance', attributes: attrs('float32x4', 'float32x4', 'float32x4', 'float32x4') }], screen, [lTex]),
      pipe(mPiece, 'vs', 'fs', pieceBuffers, screen, [lAtlas]),
      pipe(mPiece, 'vs', 'fsMask', pieceBuffers, { format: 'rg8unorm', blend: max, writeMask: GPUColorWrite.RED }, [lAtlas]),
      pipe(mPiece, 'vs', 'fsMask', pieceBuffers, { format: 'rg8unorm', blend: max, writeMask: GPUColorWrite.GREEN }, [lAtlas]),
      pipe(mPiece, 'vs', 'fsMask', pieceBuffers, { format: 'r8unorm', blend: over }, [lAtlas]),
      pipe(mPost, 'vsFull', 'fsBlur', [], { format: 'r8unorm' }, [lPost]),
      pipe(mPost, 'vsFull', 'fsShadow', [], screen, [lPost]),
      pipe(mPost, 'vsFull', 'fsOutline', [], screen, [lPost]),
    ])
    this.pipes = { bg, tray, trayMask, ref, piece, maskR, maskG, shadowMask, blur, shadow, outline } as Record<PipeName, GPURenderPipeline>
    const mPicture = d.createShaderModule({ code: PICTURE })
    const mHalve = d.createShaderModule({ code: HALVE })
    const halve = (format: GPUTextureFormat) =>
      d.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: mHalve, entryPoint: 'vs' },
        fragment: { module: mHalve, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      })
    ;[this.pipes.picture, this.pipes.halveColor] = await Promise.all([
      d.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: mPicture, entryPoint: 'vs', buffers: [{ arrayStride: 8, stepMode: 'instance', attributes: [{ format: 'float32x2', offset: 0, shaderLocation: 0 }] }] },
        fragment: { module: mPicture, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      }),
      halve('rgba8unorm'),
    ])
    // Until an image is set, images draw from a single clear pixel.
    this.setRefImage(null)
  }

  // The cell's place in the atlases: [x, y, page].
  cellAt(cell: number): [number, number, number] {
    const { cw, ch, perRow, perPage } = this.cell
    const k = cell % perPage
    return [(k % perRow) * cw, Math.floor(k / perRow) * ch, Math.floor(cell / perPage)]
  }

  // Puts a piece's shape (every mip level of it, two bytes a pixel, see sprites.ts) in its cell of
  // the shape atlas.
  upload(cell: number, shape: ShapePixels) {
    if (cell >= this.has.length) return
    const [x, y, z] = this.cellAt(cell)
    shape.forEach(({ w, h, data }, l) => {
      if (l >= this.cell.levels) return
      this.device.queue.writeTexture({ texture: this.shapes, mipLevel: l, origin: { x: x >> l, y: y >> l, z } }, data, { bytesPerRow: w * 2 }, { width: w, height: h })
    })
    this.has[cell] = 1
  }

  // Draws the picture around every piece into the colour atlas, with its halved copies. image: the
  // whole picture; mids: each piece's middle (x, y) in world units; sc: sprite pixels per world
  // unit; size: the picture's size in world units; uv: picture uv per world unit (x, y).
  drawPicture(image: HTMLImageElement, mids: Float32Array, { sc, size, uv }: { sc: number; size: readonly number[]; uv: readonly number[] }) {
    const d = this.device
    const w = image.naturalWidth || image.width
    const h = image.naturalHeight || image.height
    const pic = d.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT })
    d.queue.copyExternalImageToTexture({ source: image }, { texture: pic, premultipliedAlpha: true }, { width: w, height: h })
    const { cw, ch, perRow, perPage } = this.cell
    const ubuf = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(ubuf, 0, new Float32Array([...this.atlasSize, ...this.spritePx, cw, ch, perRow, perPage, sc, uv[0], uv[1], 0, size[0], size[1], 0, 0]))
    const vbuf = d.createBuffer({ size: Math.max(8, mids.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(vbuf, 0, mids)
    const group = d.createBindGroup({
      layout: this.pipes.picture.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 1, resource: pic.createView() },
        { binding: 2, resource: d.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
      ],
    })
    const enc = d.createCommandEncoder()
    const n = this.has.length
    for (let z = 0; z * perPage < n; z++) {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.layer(this.atlas, z, 0), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
      pass.setPipeline(this.pipes.picture)
      pass.setBindGroup(0, group)
      pass.setVertexBuffer(0, vbuf)
      pass.draw(6, Math.min(perPage, n - z * perPage), 0, z * perPage)
      pass.end()
      this.halve(enc, this.atlas, this.pipes.halveColor, z, 0, this.atlasSize[1])
    }
    d.queue.submit([enc.finish()])
    // Freed once the GPU is done with them.
    pic.destroy()
    ubuf.destroy()
    vbuf.destroy()
  }

  // One page and mip level of an atlas, as a 2D view.
  layer(texture: GPUTexture, z: number, level: number) {
    return texture.createView({ dimension: '2d', baseArrayLayer: z, arrayLayerCount: 1, baseMipLevel: level, mipLevelCount: 1 })
  }

  // Remakes the halved copies of rows y0 to y1 (pixels) of an atlas's page z, level by level.
  halve(enc: GPUCommandEncoder, texture: GPUTexture, pipeline: GPURenderPipeline, z: number, y0: number, y1: number) {
    for (let l = 1; l < this.cell.levels; l++) {
      const H = Math.max(1, this.atlasSize[1] >> l)
      const a = Math.min(H, y0 >> l)
      const b = Math.min(H, Math.ceil(y1 / (1 << l)))
      if (b <= a) break
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.layer(texture, z, l), loadOp: 'load', storeOp: 'store' }] })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.layer(texture, z, l - 1) }] }))
      pass.setScissorRect(0, a, Math.max(1, this.atlasSize[0] >> l), b - a)
      pass.draw(3)
      pass.end()
    }
  }

  // Every piece's corners: 32 floats each, as the shader reads them (see PIECE above).
  setCorners(data: Float32Array) {
    this.device.queue.writeBuffer(this.corners, 0, data.buffer, data.byteOffset, data.byteLength)
  }

  // The image reference images show: a canvas, with halved copies made for its mip levels.
  setRefImage(image: HTMLCanvasElement | OffscreenCanvas | null) {
    this.refTex?.destroy()
    const levels: (HTMLCanvasElement | OffscreenCanvas)[] = []
    if (image) {
      let prev = image
      levels.push(prev)
      while (prev.width > 1 || prev.height > 1) {
        const c = new OffscreenCanvas(Math.max(1, prev.width >> 1), Math.max(1, prev.height >> 1))
        const x = c.getContext('2d')!
        x.imageSmoothingQuality = 'high'
        x.drawImage(prev, 0, 0, c.width, c.height)
        levels.push(c)
        prev = c
      }
    }
    const [w, h] = image ? [image.width, image.height] : [1, 1]
    this.refTex = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      mipLevelCount: Math.max(1, levels.length),
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    levels.forEach((src, l) => {
      this.device.queue.copyExternalImageToTexture({ source: src }, { texture: this.refTex, mipLevel: l, premultipliedAlpha: true }, { width: src.width, height: src.height })
    })
    this.gRef = this.device.createBindGroup({ layout: this.lTex, entries: [{ binding: 0, resource: this.refTex.createView() }] })
  }

  // A vertex buffer at least size bytes big, holding data.
  fill(name: string, data: Float32Array, floats: number) {
    const bytes = Math.max(16, floats * 4)
    let b = this.buffers[name]
    if (!b || b.size < bytes) {
      b?.destroy()
      b = this.buffers[name] = this.device.createBuffer({ size: Math.max(bytes, (b?.size || 0) * 2), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    }
    if (floats) this.device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, floats * 4)
    return b
  }

  // The mask and shadow textures, sized to the canvas, so every pane of a split screen fits in them
  // (in their top left corner).
  targets(W: number, H: number) {
    if (this.size[0] === W && this.size[1] === H) return
    this.size = [W, H]
    for (const t of [this.mask, this.shA, this.shB]) t?.destroy()
    for (const x of this.xs) {
      x.tex.destroy()
      x.buf.destroy()
    }
    this.xs = []
    const d = this.device
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    this.mask = d.createTexture({ size: [W, H], format: 'rg8unorm', usage })
    const sw = Math.ceil(W / SHADOW_K)
    const sh = Math.ceil(H / SHADOW_K)
    this.shSize = [sw, sh]
    this.shA = d.createTexture({ size: [sw, sh], format: 'r8unorm', usage })
    this.shB = d.createTexture({ size: [sw, sh], format: 'r8unorm', usage })
    const group = (tex: GPUTexture, buf: GPUBuffer) =>
      d.createBindGroup({
        layout: this.lPost,
        entries: [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: { buffer: buf } },
        ],
      })
    this.gBlurX = group(this.shA, this.post.blurX)
    this.gBlurY = group(this.shB, this.post.blurY)
    this.gShadow = group(this.shA, this.post.shadow)
    this.gSel = group(this.mask, this.post.sel)
    this.gHl = group(this.mask, this.post.hl)
  }

  // The k-th extra outline's mask, settings and bind group.
  extraMask(k: number): ExtraMask {
    let x = this.xs[k]
    if (!x) {
      const d = this.device
      const tex = d.createTexture({ size: this.size, format: 'rg8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
      const buf = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      const group = d.createBindGroup({
        layout: this.lPost,
        entries: [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: { buffer: buf } },
        ],
      })
      x = this.xs[k] = { tex, buf, group }
    }
    return x
  }

  // Draws a frame. f: {
  //   W, H: the screen in device pixels; cam: [x, y, device pixels per world unit]; sprite: [w, h]
  //   in world units; bg: colour [r, g, b, a];
  //   trays: { data, count, down }, the first down lying on the table, the rest lifted (prm.z: how
  //   far); refs: { data, count }; pieces: { data, count }, with ranges [first, count] in seg: still,
  //   trayed, trayedUp (in lifted trays) and lift (drawn in that order), shade (the part of lift
  //   that casts a shadow), sel and hl (outlined); selBox, hlBox: the
  //   outlined pieces' box [x0, y0, x1, y1] in device pixels; selColor, hlColor; outline: [width,
  //   cut]; extra: more outlines, [{ range: [first, count], box, color, over }], over the lifted pieces when over; selUnder: the selection outline goes under the lifted pieces; hlOver: the hover outline (the
  //   carried pieces' then) goes over them; shadow:
  //   { color, blur, ox, oy } in device pixels, or null }
  frame(f: GpuFrame) {
    const d = this.device
    const { W, H } = f
    if (!W || !H) return
    const cv = this.ctx.canvas
    const [TW, TH] = f.pane ? [Math.max(W, cv.width), Math.max(H, cv.height)] : [W, H]
    this.targets(TW, TH)
    const U = this.uniform
    U.set([W, H, f.sprite[0], f.sprite[1], this.atlasSize[0], this.atlasSize[1], this.cell.cw, this.cell.ch])
    U.set([this.spritePx[0], this.spritePx[1], this.cell.perRow, this.cell.perPage], 8)
    U.set(premul(f.bg), 12)
    const px = f.pane?.x || 0
    const py = f.pane?.y || 0
    const load: GPULoadOp = f.pane && !f.pane.clear ? 'load' : 'clear'
    U.set([f.cam[0], f.cam[1], f.cam[2], 0], 16)
    U.set([px, py, TW, TH], 20)
    d.queue.writeBuffer(this.ubuf, 0, U)

    const pieces = this.fill('pieces', f.pieces.data, f.pieces.count * PIECE_FLOATS)
    const trays = this.fill('trays', f.trays.data, f.trays.count * TRAY_FLOATS)
    const refs = this.fill('refs', f.refs.data, f.refs.count * REF_FLOATS)
    const { seg } = f
    const enc = d.createCommandEncoder()
    const draw = (pass: GPURenderPassEncoder, range: GpuRange) => {
      if (range[1]) pass.draw(6, range[1], 0, range[0])
    }
    // A pane is drawn into the top left corner of the textures sized to the canvas, k times smaller.
    const corner = (pass: GPURenderPassEncoder, k = 1) => {
      if (f.pane) pass.setViewport(0, 0, W / k, H / k, 0, 1)
    }

    // Silhouettes of the outlined pieces: the selection in red, the hovered piece in green.
    const sel = seg.sel[1] > 0
    const hl = seg.hl[1] > 0
    if (sel || hl) {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.mask.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
      corner(pass)
      pass.setBindGroup(0, this.g0)
      pass.setBindGroup(1, this.gAtlas)
      pass.setVertexBuffer(0, pieces)
      if (sel) {
        pass.setPipeline(this.pipes.maskR)
        draw(pass, seg.sel)
      }
      if (hl) {
        pass.setPipeline(this.pipes.maskG)
        draw(pass, seg.hl)
      }
      pass.end()
      const post = (buf: GPUBuffer, color: Rgba, ch: number[]) => {
        const [r, q] = f.outline
        d.queue.writeBuffer(buf, 0, new Float32Array([...premul(color), ...ch, r, q, 0, 0]))
      }
      if (sel) post(this.post.sel, f.selColor, [1, 0, 0, 0])
      if (hl) post(this.post.hl, f.hlColor, [0, 1, 0, 0])
    }

    // Other players' outlines, each with a mask of its own, drawn in red like the selection's.
    const extras = (f.extra || []).filter((e) => e.range[1] > 0)
    const masks = extras.map((e, k) => {
      const x = this.extraMask(k)
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: x.tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
      corner(pass)
      pass.setPipeline(this.pipes.maskR)
      pass.setBindGroup(0, this.g0)
      pass.setBindGroup(1, this.gAtlas)
      pass.setVertexBuffer(0, pieces)
      draw(pass, e.range)
      pass.end()
      d.queue.writeBuffer(x.buf, 0, new Float32Array([...premul(e.color), 1, 0, 0, 0, f.outline[0], f.outline[1], 0, 0]))
      return x
    })

    // The lifted pieces' silhouettes and lifted trays' shapes at a third of the resolution, blurred one
    // way, then the other.
    const traysUp = f.trays.count - f.trays.down
    const sh = f.shadow && (seg.shade[1] > 0 || traysUp > 0) ? f.shadow : null
    if (sh) {
      const [sw, shh] = this.shSize
      const sigma = sh.blur / 2 / SHADOW_K
      const reach = Math.min(48, Math.ceil(sigma * 3))
      d.queue.writeBuffer(this.post.blurX, 0, new Float32Array([1, 0, sigma, reach, sw, shh, 0, 0]))
      d.queue.writeBuffer(this.post.blurY, 0, new Float32Array([0, 1, sigma, reach, sw, shh, 0, 0]))
      d.queue.writeBuffer(this.post.shadow, 0, new Float32Array([...premul(sh.color), sh.ox + px, sh.oy + py, sw * SHADOW_K, shh * SHADOW_K]))
      const target = (tex: GPUTexture): GPURenderPassDescriptor => ({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
      let pass = enc.beginRenderPass(target(this.shA))
      corner(pass, SHADOW_K)
      pass.setBindGroup(0, this.g0)
      if (traysUp > 0) {
        pass.setPipeline(this.pipes.trayMask)
        pass.setVertexBuffer(0, trays)
        pass.draw(6, traysUp, 0, f.trays.down)
      }
      if (seg.shade[1]) {
        pass.setPipeline(this.pipes.shadowMask)
        pass.setBindGroup(1, this.gAtlas)
        pass.setVertexBuffer(0, pieces)
        draw(pass, seg.shade)
      }
      pass.end()
      for (const [tex, group] of [
        [this.shB, this.gBlurX],
        [this.shA, this.gBlurY],
      ] as const) {
        pass = enc.beginRenderPass(target(tex))
        pass.setPipeline(this.pipes.blur)
        pass.setBindGroup(0, this.g0)
        pass.setBindGroup(1, group)
        pass.draw(3)
        pass.end()
      }
    }

    // Two layers, with the notes (page elements) over both: the table (background, images, the pieces
    // lying on it) under, and over them the trays, the pieces in them, the pieces being carried and
    // the outlines. Lifted trays go over the shadow, with the pieces in them.
    let pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: load, storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    })
    // Only this frame's part of the canvas.
    const clip = () => {
      if (!f.pane) return
      pass.setViewport(px, py, W, H, 0, 1)
      pass.setScissorRect(px, py, W, H)
    }
    clip()
    pass.setBindGroup(0, this.g0)
    pass.setPipeline(this.pipes.bg)
    pass.draw(3)
    if (f.refs.count) {
      pass.setPipeline(this.pipes.ref)
      pass.setBindGroup(1, this.gRef)
      pass.setVertexBuffer(0, refs)
      pass.draw(6, f.refs.count)
    }
    const piecesOf = (range: GpuRange) => {
      if (!range[1]) return
      pass.setPipeline(this.pipes.piece)
      pass.setBindGroup(1, this.gAtlas)
      pass.setVertexBuffer(0, pieces)
      draw(pass, range)
    }
    // An outline, only where it can be: around the outlined pieces' box.
    const outline = (group: GPUBindGroup, box: ScreenBox) => {
      const [r] = f.outline
      const x0 = Math.max(0, Math.floor(box[0] - r - 2))
      const y0 = Math.max(0, Math.floor(box[1] - r - 2))
      const x1 = Math.min(W, Math.ceil(box[2] + r + 2))
      const y1 = Math.min(H, Math.ceil(box[3] + r + 2))
      if (x1 <= x0 || y1 <= y0) return
      pass.setScissorRect(px + x0, py + y0, x1 - x0, y1 - y0)
      pass.setPipeline(this.pipes.outline)
      pass.setBindGroup(1, group)
      pass.draw(3)
      pass.setScissorRect(px, py, W, H)
    }
    piecesOf(seg.still)
    pass.end()
    pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctxTop.getCurrentTexture().createView(), loadOp: load, storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    })
    clip()
    pass.setBindGroup(0, this.g0)
    if (f.trays.down) {
      pass.setPipeline(this.pipes.tray)
      pass.setVertexBuffer(0, trays)
      pass.draw(6, f.trays.down)
    }
    piecesOf(seg.trayed)
    if (sel && f.selUnder) outline(this.gSel, f.selBox)
    if (hl && !f.hlOver) outline(this.gHl, f.hlBox)
    extras.forEach((e, k) => !e.over && outline(masks[k].group, e.box))
    if (sh) {
      pass.setPipeline(this.pipes.shadow)
      pass.setBindGroup(1, this.gShadow)
      pass.draw(3)
    }
    if (traysUp > 0) {
      pass.setPipeline(this.pipes.tray)
      pass.setVertexBuffer(0, trays)
      pass.draw(6, traysUp, 0, f.trays.down)
    }
    piecesOf(seg.trayedUp)
    piecesOf(seg.lift)
    if (sel && !f.selUnder) outline(this.gSel, f.selBox)
    if (hl && f.hlOver) outline(this.gHl, f.hlBox)
    extras.forEach((e, k) => e.over && outline(masks[k].group, e.box))
    pass.end()
    d.queue.submit([enc.finish()])
  }

  destroy() {
    this.onLost = null
    this.device.destroy()
  }
}
