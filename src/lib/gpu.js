// WebGPU renderer for the table. The engine works out what goes where each frame (see drawGpu() in
// engine.js); this draws it, the whole table every frame:
//
// - the table and its dot grid, worked out per pixel,
// - trays (rounded boxes) and reference images,
// - the pieces, one instance each, from their sprites in one texture atlas (a texture array of
//   pages, every sprite in its own cell, with its halved copies in the mip levels),
// - the selection and hover outlines: the pieces' silhouettes go into a mask, which is grown by the
//   outline's width and has the silhouettes, grown a little, cut back out,
// - the drop shadow of lifted pieces: their silhouettes at a third of the resolution, blurred.
//
// Positions reach the GPU in device pixels, worked out on the CPU, so the shaders don't need the camera.

// Floats per instance: pieces [m00 m01 m10 m11 x y cell -], trays [rect fill stroke (radius width - -)],
// images [rect border (width opacity - -)].
export const PIECE_FLOATS = 8
export const TRAY_FLOATS = 16
export const REF_FLOATS = 16

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
  dot: vec4f,
  // The world point at the middle of the screen, device pixels per world unit, dot spacing (world).
  cam: vec4f,
  // Dot size (device pixels).
  misc: vec4f,
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
@fragment fn fsBg(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let z = u.cam.z;
  let w = (p.xy - u.s0.xy * 0.5) / z + u.cam.xy;
  let sp = u.cam.w;
  // How far this pixel is from the nearest dot, in device pixels, and how much of it the dot covers.
  let d = (w - round(w / sp) * sp) * z;
  let s = u.misc.x;
  let c = clamp(s * 0.5 + 0.5 - abs(d), vec2f(0.0), vec2f(min(s, 1.0)));
  let a = c.x * c.y;
  return vec4f(u.bg.rgb * (1.0 - u.dot.a * a) + u.dot.rgb * a, 1.0);
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
  let d = mix(rect.xy - e, rect.zw + e, corner(vi));
  var o: O;
  o.p = clip(d);
  o.d = d - (rect.xy + rect.zw) * 0.5;
  o.hs = (rect.zw - rect.xy) * 0.5;
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
  let d = mix(rect.xy - e, rect.zw + e, corner(vi));
  var o: O;
  o.p = clip(d);
  o.d = d - (rect.xy + rect.zw) * 0.5;
  o.uv = part.xy + (d - rect.xy) / (rect.zw - rect.xy) * part.zw;
  o.part = part;
  o.hs = (rect.zw - rect.xy) * 0.5;
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
@group(1) @binding(0) var atlas: texture_2d_array<f32>;
struct O {
  @builtin(position) p: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) layer: u32,
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
  return o;
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  return textureSample(atlas, samp, i.uv, i.layer);
}
// The piece's shape: its sprite is opaque inside the outline and at most a faint shadow outside it.
@fragment fn fsMask(i: O) -> @location(0) vec4f {
  return vec4f(smoothstep(0.4, 0.75, textureSample(atlas, samp, i.uv, i.layer).a));
}
@fragment fn fsShadow(i: O) -> @location(0) vec4f {
  return vec4f(textureSample(atlas, samp, i.uv, i.layer).a);
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
  return dot(textureSampleLevel(src, samp, p / u.s0.xy, 0.0), pu.b);
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

const premul = ([r, g, b, a]) => [r * a, g * a, b * a, a]

// canvas holds the table, top the trays and everything above the notes (see frame()).
export async function createGpu(canvas, top, atlas) {
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

class Gpu {
  // atlas: { cells, spw, sph, levels }: how many sprites, their size in pixels, and how many mip
  // levels each comes with (the sprite and its halved copies).
  constructor(device, ctx, ctxTop, format, { cells, spw, sph, levels }) {
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
    this.atlas = device.createTexture({
      size: [pw, ph, layers],
      format: 'rgba8unorm',
      mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.has = new Uint8Array(cells)

    this.uniform = new Float32Array(28)
    this.ubuf = device.createBuffer({ size: this.uniform.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    // Blur (two passes), shadow and outline (selection, hover) settings.
    this.post = {}
    for (const k of ['blurX', 'blurY', 'shadow', 'sel', 'hl']) {
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
    const lAtlas = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: { viewDimension: '2d-array' } }] })
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
    this.gAtlas = d.createBindGroup({ layout: lAtlas, entries: [{ binding: 0, resource: this.atlas.createView({ dimension: '2d-array' }) }] })

    const module = async (code) => {
      const m = d.createShaderModule({ code: COMMON + code })
      const info = await m.getCompilationInfo()
      const errors = info.messages.filter((x) => x.type === 'error')
      if (errors.length) throw new Error(errors.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('\n'))
      return m
    }
    const [mBg, mTray, mRef, mPiece, mPost] = await Promise.all([BG, TRAY, REF, PIECE, POST].map(module))
    const over = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }
    const max = { color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' } }
    const layout = (...groups) => d.createPipelineLayout({ bindGroupLayouts: [l0, ...groups] })
    const attrs = (...formats) => {
      let offset = 0
      const sizes = { float32x4: 16, float32x2: 8, uint32: 4 }
      const attributes = formats.map((format, shaderLocation) => {
        const a = { format, offset, shaderLocation }
        offset += sizes[format]
        return a
      })
      return attributes
    }
    const pieceBuffers = [{ arrayStride: PIECE_FLOATS * 4, stepMode: 'instance', attributes: attrs('float32x4', 'float32x2', 'uint32') }]
    const pipe = (m, vs, fs, buffers, target, layoutGroups) =>
      d.createRenderPipelineAsync({
        layout: layout(...layoutGroups),
        vertex: { module: m, entryPoint: vs, buffers },
        fragment: { module: m, entryPoint: fs, targets: [target] },
        primitive: { topology: 'triangle-list' },
      })
    const screen = { format: this.format, blend: over }
    const [bg, tray, ref, piece, maskR, maskG, shadowMask, blur, shadow, outline] = await Promise.all([
      pipe(mBg, 'vsFull', 'fsBg', [], { format: this.format }, []),
      pipe(mTray, 'vs', 'fs', [{ arrayStride: TRAY_FLOATS * 4, stepMode: 'instance', attributes: attrs('float32x4', 'float32x4', 'float32x4', 'float32x4') }], screen, []),
      pipe(mRef, 'vs', 'fs', [{ arrayStride: REF_FLOATS * 4, stepMode: 'instance', attributes: attrs('float32x4', 'float32x4', 'float32x4', 'float32x4') }], screen, [lTex]),
      pipe(mPiece, 'vs', 'fs', pieceBuffers, screen, [lAtlas]),
      pipe(mPiece, 'vs', 'fsMask', pieceBuffers, { format: 'rg8unorm', blend: max, writeMask: GPUColorWrite.RED }, [lAtlas]),
      pipe(mPiece, 'vs', 'fsMask', pieceBuffers, { format: 'rg8unorm', blend: max, writeMask: GPUColorWrite.GREEN }, [lAtlas]),
      pipe(mPiece, 'vs', 'fsShadow', pieceBuffers, { format: 'r8unorm', blend: over }, [lAtlas]),
      pipe(mPost, 'vsFull', 'fsBlur', [], { format: 'r8unorm' }, [lPost]),
      pipe(mPost, 'vsFull', 'fsShadow', [], screen, [lPost]),
      pipe(mPost, 'vsFull', 'fsOutline', [], screen, [lPost]),
    ])
    this.pipes = { bg, tray, ref, piece, maskR, maskG, shadowMask, blur, shadow, outline }
    // Until an image is set, images draw from a single clear pixel.
    this.setRefImage(null)
  }

  // Puts a sprite and its halved copies (canvases or ImageBitmaps) in its atlas cell.
  upload(cell, levels) {
    if (cell >= this.has.length) return
    const { cw, ch, perRow, perPage } = this.cell
    const k = cell % perPage
    const x = (k % perRow) * cw
    const y = Math.floor(k / perRow) * ch
    const z = Math.floor(cell / perPage)
    const n = Math.min(levels.length, this.cell.levels)
    for (let l = 0; l < n; l++) {
      const src = levels[l]
      this.device.queue.copyExternalImageToTexture(
        { source: src },
        { texture: this.atlas, mipLevel: l, origin: { x: x >> l, y: y >> l, z }, premultipliedAlpha: true },
        { width: src.width, height: src.height },
      )
    }
    this.has[cell] = 1
  }

  // The image reference images show: a canvas, with halved copies made for its mip levels.
  setRefImage(image) {
    this.refTex?.destroy()
    const levels = []
    if (image) {
      let prev = image
      levels.push(prev)
      while (prev.width > 1 || prev.height > 1) {
        const c = new OffscreenCanvas(Math.max(1, prev.width >> 1), Math.max(1, prev.height >> 1))
        const x = c.getContext('2d')
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
  fill(name, data, floats) {
    const bytes = Math.max(16, floats * 4)
    let b = this.buffers[name]
    if (!b || b.size < bytes) {
      b?.destroy()
      b = this.buffers[name] = this.device.createBuffer({ size: Math.max(bytes, (b?.size || 0) * 2), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    }
    if (floats) this.device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, floats * 4)
    return b
  }

  // The mask and shadow textures, sized to the screen.
  targets(W, H) {
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
    const group = (tex, buf) =>
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
  extraMask(k) {
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
  //   in world units; bg, dot: colours [r, g, b, a]; dotStep (world units), dotSize (device pixels);
  //   trays, refs: { data, count }; pieces: { data, count }, with ranges [first, count] in seg:
  //   still and lift (drawn in that order), sel and hl (outlined); selBox, hlBox: the
  //   outlined pieces' box [x0, y0, x1, y1] in device pixels; selColor, hlColor; outline: [width,
  //   cut]; extra: more outlines, [{ range: [first, count], box, color, over }], over the lifted pieces when over; selUnder: the selection outline goes under the lifted pieces; hlOver: the hover outline (the
  //   carried pieces' then) goes over them; shadow:
  //   { color, blur, ox, oy } in device pixels, or null }
  frame(f) {
    const d = this.device
    const { W, H } = f
    if (!W || !H) return
    this.targets(W, H)
    const U = this.uniform
    U.set([W, H, f.sprite[0], f.sprite[1], this.atlasSize[0], this.atlasSize[1], this.cell.cw, this.cell.ch])
    U.set([this.spritePx[0], this.spritePx[1], this.cell.perRow, this.cell.perPage], 8)
    U.set(premul(f.bg), 12)
    U.set(premul(f.dot), 16)
    U.set([f.cam[0], f.cam[1], f.cam[2], f.dotStep], 20)
    U.set([f.dotSize, 0, 0, 0], 24)
    d.queue.writeBuffer(this.ubuf, 0, U)

    const pieces = this.fill('pieces', f.pieces.data, f.pieces.count * PIECE_FLOATS)
    const trays = this.fill('trays', f.trays.data, f.trays.count * TRAY_FLOATS)
    const refs = this.fill('refs', f.refs.data, f.refs.count * REF_FLOATS)
    const { seg } = f
    const enc = d.createCommandEncoder()
    const draw = (pass, range) => {
      if (range[1]) pass.draw(6, range[1], 0, range[0])
    }

    // Silhouettes of the outlined pieces: the selection in red, the hovered piece in green.
    const sel = seg.sel[1] > 0
    const hl = seg.hl[1] > 0
    if (sel || hl) {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.mask.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
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
      const post = (buf, color, ch) => {
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
      pass.setPipeline(this.pipes.maskR)
      pass.setBindGroup(0, this.g0)
      pass.setBindGroup(1, this.gAtlas)
      pass.setVertexBuffer(0, pieces)
      draw(pass, e.range)
      pass.end()
      d.queue.writeBuffer(x.buf, 0, new Float32Array([...premul(e.color), 1, 0, 0, 0, f.outline[0], f.outline[1], 0, 0]))
      return x
    })

    // The lifted pieces' silhouettes at a third of the resolution, blurred one way, then the other.
    const sh = f.shadow && seg.lift[1] > 0 ? f.shadow : null
    if (sh) {
      const [sw, shh] = this.shSize
      const sigma = sh.blur / 2 / SHADOW_K
      const reach = Math.min(48, Math.ceil(sigma * 3))
      d.queue.writeBuffer(this.post.blurX, 0, new Float32Array([1, 0, sigma, reach, sw, shh, 0, 0]))
      d.queue.writeBuffer(this.post.blurY, 0, new Float32Array([0, 1, sigma, reach, sw, shh, 0, 0]))
      d.queue.writeBuffer(this.post.shadow, 0, new Float32Array([...premul(sh.color), sh.ox, sh.oy, sw * SHADOW_K, shh * SHADOW_K]))
      const target = (tex) => ({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
      let pass = enc.beginRenderPass(target(this.shA))
      pass.setPipeline(this.pipes.shadowMask)
      pass.setBindGroup(0, this.g0)
      pass.setBindGroup(1, this.gAtlas)
      pass.setVertexBuffer(0, pieces)
      draw(pass, seg.lift)
      pass.end()
      for (const [tex, group] of [
        [this.shB, this.gBlurX],
        [this.shA, this.gBlurY],
      ]) {
        pass = enc.beginRenderPass(target(tex))
        pass.setPipeline(this.pipes.blur)
        pass.setBindGroup(0, this.g0)
        pass.setBindGroup(1, group)
        pass.draw(3)
        pass.end()
      }
    }

    // Two layers, with the notes (page elements) between them: the table (background, images, the
    // pieces lying on it) under, and over them the trays, the pieces in them, the pieces being
    // carried and the outlines.
    let pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    })
    pass.setBindGroup(0, this.g0)
    pass.setPipeline(this.pipes.bg)
    pass.draw(3)
    if (f.refs.count) {
      pass.setPipeline(this.pipes.ref)
      pass.setBindGroup(1, this.gRef)
      pass.setVertexBuffer(0, refs)
      pass.draw(6, f.refs.count)
    }
    const piecesOf = (range) => {
      if (!range[1]) return
      pass.setPipeline(this.pipes.piece)
      pass.setBindGroup(1, this.gAtlas)
      pass.setVertexBuffer(0, pieces)
      draw(pass, range)
    }
    // An outline, only where it can be: around the outlined pieces' box.
    const outline = (group, box) => {
      const [r] = f.outline
      const x0 = Math.max(0, Math.floor(box[0] - r - 2))
      const y0 = Math.max(0, Math.floor(box[1] - r - 2))
      const x1 = Math.min(W, Math.ceil(box[2] + r + 2))
      const y1 = Math.min(H, Math.ceil(box[3] + r + 2))
      if (x1 <= x0 || y1 <= y0) return
      pass.setScissorRect(x0, y0, x1 - x0, y1 - y0)
      pass.setPipeline(this.pipes.outline)
      pass.setBindGroup(1, group)
      pass.draw(3)
      pass.setScissorRect(0, 0, W, H)
    }
    piecesOf(seg.still)
    pass.end()
    pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctxTop.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    })
    pass.setBindGroup(0, this.g0)
    if (f.trays.count) {
      pass.setPipeline(this.pipes.tray)
      pass.setVertexBuffer(0, trays)
      pass.draw(6, f.trays.count)
    }
    if (seg.trayed) piecesOf(seg.trayed)
    if (sel && f.selUnder) outline(this.gSel, f.selBox)
    if (hl && !f.hlOver) outline(this.gHl, f.hlBox)
    extras.forEach((e, k) => !e.over && outline(masks[k].group, e.box))
    if (sh) {
      pass.setPipeline(this.pipes.shadow)
      pass.setBindGroup(1, this.gShadow)
      pass.draw(3)
    }
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
