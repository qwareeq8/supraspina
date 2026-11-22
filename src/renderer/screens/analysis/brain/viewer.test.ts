// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NVImage } from '@niivue/niivue'
import { buildBrainMap } from './brain-map'
import {
  clipNormal,
  createBrainViewer,
  cutCamera,
  cutClipPlane,
  fitCamera,
  slicePan,
  surfaceCamera,
  type BrainViewer,
  type TemplateFiles,
  type ViewState,
} from './viewer'

interface FakeImage {
  name: string
  hdr: { dims: number[]; affine: number[][] }
  img: ArrayLike<number>
  colormap: string
  cal_min: number
  cal_max: number
  setColormapLabel: ReturnType<typeof vi.fn>
  mm2vox(mm: number[]): number[]
  getValue(x: number, y: number, z: number): number
}

interface FakeNiivue {
  opts: Record<string, unknown>
  scene: {
    crosshairPos: ArrayLike<number>
    renderAzimuth: number
    renderElevation: number
  }
  uiData: { mouseDepthPicker: boolean; dpr: number }
  mousePos: number[]
  backgroundMasksOverlays: number
  volumes: FakeImage[]
  meshes: { name: string; visible: boolean; rgba255: Uint8Array }[]
  onLocationChange: (data: unknown) => void
  pickFrac: number[] | null
  cleanup: ReturnType<typeof vi.fn>
  setClipPlane: ReturnType<typeof vi.fn>
  setSliceType: ReturnType<typeof vi.fn>
  setScale: ReturnType<typeof vi.fn>
  setRenderAzimuthElevation: ReturnType<typeof vi.fn>
  moveCrosshairInVox: ReturnType<typeof vi.fn>
  updateGLVolume: ReturnType<typeof vi.fn>
  drawScene: ReturnType<typeof vi.fn>
  resizeListener: ReturnType<typeof vi.fn>
  gl: {
    getExtension: () => { loseContext: ReturnType<typeof vi.fn> }
    maxSize: number
    bufferMax: number
  }
}

const fake = vi.hoisted(() => ({
  instances: [] as unknown[],
  loseContext: null as unknown,
}))

vi.mock('@niivue/niivue', () => {
  const loseContext = vi.fn()
  fake.loseContext = loseContext
  class Niivue {
    opts: Record<string, unknown>
    scene = {
      crosshairPos: [0.5, 0.5, 0.5] as ArrayLike<number>,
      renderAzimuth: 0,
      renderElevation: 0,
    }
    uiData = { mouseDepthPicker: false, dpr: 1 }
    mousePos = [0, 0]
    backgroundMasksOverlays = 0
    volumes: unknown[] = []
    meshes: unknown[] = []
    onLocationChange: (data: unknown) => void = () => undefined
    pickFrac: number[] | null = null
    // The GPU limits renderFrame reads, as MAX_VIEWPORT_DIMS and
    // MAX_RENDERBUFFER_SIZE.
    gl = ((owner: { canvas: HTMLCanvasElement | null }) => ({
      getExtension: () => ({ loseContext }),
      MAX_VIEWPORT_DIMS: 1,
      MAX_RENDERBUFFER_SIZE: 2,
      maxSize: 4096,
      // The drawing buffer a browser gives, at most this wide.
      bufferMax: 1e9,
      getParameter(name: number): number | Int32Array {
        return name === 1
          ? Int32Array.of(this.maxSize, this.maxSize)
          : this.maxSize
      },
      get drawingBufferWidth(): number {
        return Math.min(owner.canvas?.width ?? 0, this.bufferMax)
      },
      get drawingBufferHeight(): number {
        return owner.canvas?.height ?? 0
      },
    }))(this)
    canvas: HTMLCanvasElement | null = null
    // Size the drawing buffer as NiiVue does: 50 CSS pixels times the ratio.
    resizeListener = vi.fn(() => {
      this.canvas!.width = 50 * (this.opts['forceDevicePixelRatio'] as number)
      this.drawScene()
    })
    cleanup = vi.fn()
    setClipPlane = vi.fn()
    setSliceType = vi.fn()
    setScale = vi.fn()
    moveCrosshairInVox = vi.fn()
    updateGLVolume = vi.fn()
    setClipPlaneColor = vi.fn()
    addColormap = vi.fn()
    setRenderAzimuthElevation = vi.fn((a: number, e: number) => {
      this.scene.renderAzimuth = a
      this.scene.renderElevation = e
    })
    drawScene = vi.fn(() => {
      if (this.uiData.mouseDepthPicker) {
        this.uiData.mouseDepthPicker = false
        if (this.pickFrac) this.scene.crosshairPos = this.pickFrac
      }
    })
    constructor(opts: Record<string, unknown>) {
      this.opts = { ...opts }
      fake.instances.push(this)
    }
    async attachToCanvas(canvas: HTMLCanvasElement): Promise<this> {
      this.canvas = canvas
      return this
    }
    addMesh(mesh: unknown): void {
      this.meshes.push(mesh)
    }
    addVolume(volume: unknown): void {
      this.volumes.push(volume)
    }
    removeVolume(volume: unknown): void {
      this.volumes = this.volumes.filter((item) => item !== volume)
    }
    frac2mm(frac: ArrayLike<number>): number[] {
      return [0, 1, 2].map((i) => (frac[i]! - 0.5) * 256)
    }
    mm2frac(mm: ArrayLike<number>): Float32Array {
      return Float32Array.from([0, 1, 2].map((i) => mm[i]! / 256 + 0.5))
    }
  }
  class NVMesh {
    visible: boolean
    rgba255: Uint8Array
    updateMesh = vi.fn()
    constructor(
      _pts: Float32Array,
      _tris: Uint32Array,
      public name: string,
      rgba: Uint8Array,
      _opacity: number,
      visible: boolean,
    ) {
      this.rgba255 = rgba
      this.visible = visible
    }
  }
  const newImage = vi.fn(async (_buffer: ArrayBuffer, name: string) => {
    const img = new Int16Array(125)
    for (let z = 1; z <= 3; z++) {
      for (let y = 1; y <= 3; y++) {
        for (let x = 1; x <= 3; x++) img[x + 5 * (y + 5 * z)] = 16
      }
    }
    const image = {
      name,
      hdr: {
        dims: [3, 5, 5, 5],
        affine: [
          [1, 0, 0, -2],
          [0, 1, 0, -2],
          [0, 0, 1, -2],
          [0, 0, 0, 1],
        ],
      },
      img: img as ArrayLike<number>,
      colormap: '',
      cal_min: 0,
      cal_max: 0,
      setColormapLabel: vi.fn(),
      mm2vox: (mm: number[]) => mm.map((v) => Math.round(v + 2)),
      getValue(x: number, y: number, z: number): number {
        return (this.img as ArrayLike<number>)[x + 5 * (y + 5 * z)] ?? 0
      },
    }
    return image
  })
  return {
    Niivue,
    NVMesh,
    NVImage: { new: newImage },
    SLICE_TYPE: {
      AXIAL: 0,
      CORONAL: 1,
      SAGITTAL: 2,
      MULTIPLANAR: 3,
      RENDER: 4,
    },
    SHOW_RENDER: { NEVER: 0 },
    MULTIPLANAR_TYPE: { ROW: 3 },
  }
})

class Writer {
  private readonly parts: number[] = []
  bytes(...values: number[]): this {
    this.parts.push(...values)
    return this
  }
  i32(value: number): this {
    const view = new DataView(new ArrayBuffer(4))
    view.setInt32(0, value, false)
    return this.bytes(...new Uint8Array(view.buffer))
  }
  f32(value: number): this {
    const view = new DataView(new ArrayBuffer(4))
    view.setFloat32(0, value, false)
    return this.bytes(...new Uint8Array(view.buffer))
  }
  name(value: string): this {
    this.i32(value.length + 1)
    for (const char of value) this.parts.push(char.charCodeAt(0))
    return this.bytes(0)
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

// Four vertices: two in precentral near x = -40, two in insula near x = -30.
const POSITIONS = [-40, 0, 0, -40, 10, 0, -30, 0, 0, -30, 10, 0]

function surfaceBytes(): Uint8Array {
  const writer = new Writer().bytes(0xff, 0xff, 0xfe, 0x0a, 0x0a).i32(4).i32(2)
  for (const value of POSITIONS) writer.f32(value)
  for (const index of [0, 1, 2, 1, 2, 3]) writer.i32(index)
  return writer.done()
}

function sulcBytes(): Uint8Array {
  const writer = new Writer().bytes(0xff, 0xff, 0xff).i32(4).i32(2).i32(1)
  for (let i = 0; i < 4; i++) writer.f32(0)
  return writer.done()
}

function annotBytes(): Uint8Array {
  const writer = new Writer().i32(4)
  for (const [vertex, label] of [
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 2],
  ]) {
    writer.i32(vertex!).i32(label!)
  }
  writer.i32(1).i32(2).name('t')
  writer.name('precentral').i32(1).i32(0).i32(0).i32(0)
  writer.name('insula').i32(2).i32(0).i32(0).i32(0)
  return writer.done()
}

function template(): TemplateFiles {
  const hemi = {
    pial: surfaceBytes(),
    inflated: surfaceBytes(),
    sulc: sulcBytes(),
    annot: annotBytes(),
  }
  return { surfaces: { lh: hemi, rh: hemi } }
}

const MAP = buildBrainMap(
  {
    rows: [
      {
        measureId: 'dk:bi:precentral:ThickAvg',
        t: -3,
        significant: true,
        d: -0.7,
      },
      {
        measureId: 'aseg:Brain-Stem',
        t: -3,
        significant: true,
        d: -0.48,
      },
    ],
  },
  'd',
  'ThickAvg:bi',
  null,
)

function state(overrides: Partial<ViewState> = {}): ViewState {
  return {
    mode: 'surface',
    surface: 'pial',
    hemisphere: 'lh',
    view: 'lateral',
    cut: { depthMm: 0, azimuth: 180, elevation: 0 },
    background: [1, 1, 1],
    ...overrides,
  }
}

function canvas(): HTMLCanvasElement {
  const element = document.createElement('canvas')
  element.width = 100
  element.height = 100
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect
  document.body.append(element)
  return element
}

function click(target: HTMLCanvasElement, x = 50, y = 50, drag = 0): void {
  target.dispatchEvent(
    new MouseEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }),
  )
  target.dispatchEvent(
    new MouseEvent('pointerup', {
      clientX: x + drag,
      clientY: y,
      bubbles: true,
    }),
  )
}

function niivue(): FakeNiivue {
  return fake.instances.at(-1) as FakeNiivue
}

describe('brain viewer controller', () => {
  let element: HTMLCanvasElement
  let viewer: BrainViewer
  const onPick = vi.fn()
  const onContextLost = vi.fn()

  beforeEach(async () => {
    element = canvas()
    viewer = await createBrainViewer(element, { onPick, onContextLost }, 2)
  })

  afterEach(() => {
    viewer.dispose()
    element.remove()
    onPick.mockReset()
    onContextLost.mockReset()
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockRestore?.()
  })

  it('configures NiiVue for the production CSP and the app', () => {
    const nv = niivue()
    expect(nv.opts).toMatchObject({
      forceDevicePixelRatio: 2,
      dragAndDropEnabled: false,
      clipPlaneHotKey: '',
      viewModeHotKey: '',
      isClipAllVolumes: true,
    })
    expect(nv.backgroundMasksOverlays).toBe(1)
  })

  it('shows one hemisphere per lateral view, colored per vertex', () => {
    viewer.setTemplate(template())
    viewer.apply(state(), MAP, null)
    const nv = niivue()
    const visible = nv.meshes.filter((mesh) => mesh.visible)
    expect(visible.map((mesh) => mesh.name)).toEqual(['lh.pial'])
    expect(visible[0]!.rgba255).toHaveLength(16)
    expect(nv.setRenderAzimuthElevation).toHaveBeenLastCalledWith(90, 0)
    expect(nv.setClipPlane).toHaveBeenLastCalledWith([2, 0, 0])
    expect(nv.volumes).toHaveLength(0)

    viewer.apply(state({ view: 'dorsal', surface: 'inflated' }), MAP, null)
    expect(nv.meshes.filter((mesh) => mesh.visible).map((m) => m.name)).toEqual(
      ['lh.inflated', 'rh.inflated'],
    )
  })

  it('refuses surfaces that disagree with the annotation', () => {
    const files = template()
    files.surfaces.rh = {
      ...files.surfaces.rh,
      sulc: new Writer()
        .bytes(0xff, 0xff, 0xff)
        .i32(1)
        .i32(0)
        .i32(1)
        .f32(0)
        .done(),
    }
    expect(() => viewer.setTemplate(files)).toThrow(/disagree on the vertex/)
  })

  it('selects the parcel under a click and ignores drags and background', () => {
    viewer.setTemplate(template())
    viewer.apply(state(), MAP, null)
    const nv = niivue()
    nv.pickFrac = [-40 / 256 + 0.5, 0.5, 0.5]
    click(element)
    expect(onPick).toHaveBeenLastCalledWith('dk:bi:precentral:ThickAvg')
    expect(nv.mousePos).toEqual([50, 50])

    nv.pickFrac = [-30 / 256 + 0.5, 0.5, 0.5]
    click(element)
    expect(onPick).toHaveBeenLastCalledWith(null)

    nv.pickFrac = null
    click(element)
    expect(onPick).toHaveBeenLastCalledWith(null)

    onPick.mockReset()
    click(element, 50, 50, 20)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('recodes the label overlay for slices and follows the selection', async () => {
    viewer.setTemplate(template())
    await viewer.setVolumes({
      brain: new Uint8Array(1),
      labels: new Uint8Array(1),
    })
    expect(viewer.hasVolumes()).toBe(true)
    viewer.apply(state({ mode: 'slices' }), MAP, 'aseg:Brain-Stem')
    const nv = niivue()
    expect(nv.volumes.map((volume) => volume.name)).toEqual([
      'brain.mgz',
      'aparc+aseg.mgz',
    ])
    const labels = nv.volumes[1]!
    expect(labels.img).toBeInstanceOf(Int16Array)
    // Codes follow label order: 16 (brainstem) comes before 1024 and 2024.
    expect(labels.img[2 + 5 * (2 + 5 * 2)]).toBe(1)
    expect(labels.setColormapLabel).toHaveBeenCalledTimes(1)
    expect(nv.setSliceType).toHaveBeenLastCalledWith(3)
    // The crosshair moves to the brainstem centroid, voxel (2, 2, 2) = 0 mm.
    expect(Array.from(nv.scene.crosshairPos)).toEqual([0.5, 0.5, 0.5])

    nv.onLocationChange({ mm: [0, 0, 0] })
    expect(onPick).toHaveBeenLastCalledWith('aseg:Brain-Stem')
    nv.onLocationChange({ mm: [2, 2, 2] })
    expect(onPick).toHaveBeenLastCalledWith(null)
    // The overlay keeps its codes after a lookup.
    expect(labels.img[2 + 5 * (2 + 5 * 2)]).toBe(1)

    viewer.moveCrosshair(1, 0, 0)
    expect(nv.moveCrosshairInVox).toHaveBeenCalledWith(1, 0, 0)
    viewer.setCrosshairMm([10, 0, 0])
    expect(nv.scene.crosshairPos[0]).toBeCloseTo(10 / 256 + 0.5)
  })

  it('puts the slice crosshair inside the selection after a 3D pick', async () => {
    viewer.setTemplate(template())
    await viewer.setVolumes({
      brain: new Uint8Array(1),
      labels: new Uint8Array(1),
    })
    viewer.apply(state(), MAP, 'aseg:Brain-Stem')
    const nv = niivue()
    // A surface pick leaves the crosshair wherever the mesh was hit.
    nv.scene.crosshairPos = [0.02, 0.9, 0.1]
    viewer.apply(state({ mode: 'slices' }), MAP, 'aseg:Brain-Stem')
    expect(Array.from(nv.scene.crosshairPos)).toEqual([0.5, 0.5, 0.5])
    // Without a selection the slices start at the brain's center.
    viewer.apply(state(), MAP, null)
    nv.scene.crosshairPos = [0.02, 0.9, 0.1]
    viewer.apply(state({ mode: 'slices' }), MAP, null)
    expect(Array.from(nv.scene.crosshairPos)).toEqual([0.5, 0.5, 0.5])
  })

  it("centers a close-up on a subject's brainstem", async () => {
    // The subject's head sits 10 mm right, 4 mm back, and 20 mm up.
    const read = vi.mocked(NVImage.new)
    const original = read.getMockImplementation()!
    read.mockImplementation(async (...args: Parameters<typeof original>) => {
      const image = await original(...args)
      ;(image.hdr as unknown as { affine: number[][] }).affine = [
        [1, 0, 0, 8],
        [0, 1, 0, -6],
        [0, 0, 1, 18],
        [0, 0, 0, 1],
      ]
      return image
    })
    try {
      expect(viewer.closeUp('brainstem', 'lh')).toBeNull()
      await viewer.setVolumes({
        brain: new Uint8Array(1),
        labels: new Uint8Array(1),
      })
      const close = viewer.closeUp('brainstem', 'lh')!
      expect(close).toMatchObject({
        preset: 'brainstem',
        centerMm: [10, -4, 20],
        crosshairMm: [10, -4, 20],
        plane: 'sagittal',
        zoom: 2.5,
        hideCerebrum: true,
      })
      // The fixture has no thalamus or hippocampus labels.
      expect(viewer.closeUp('thalamus', 'lh')).toBeNull()
      expect(viewer.closeUp('hippocampus', 'rh')).toBeNull()
      // Seen from the left the face moves to x = 10 mm; from the front to
      // y = -4 mm.
      expect(
        viewer.cutThrough(
          { depthMm: -8, azimuth: 90, elevation: 0 },
          close.centerMm,
        ),
      ).toEqual({ depthMm: 10, azimuth: 90, elevation: 0 })
      expect(
        viewer.cutThrough(
          { depthMm: 16, azimuth: 180, elevation: 0 },
          close.centerMm,
        ),
      ).toEqual({ depthMm: 4, azimuth: 180, elevation: 0 })
    } finally {
      read.mockImplementation(original)
    }
  })

  it('draws a brainstem close-up as one zoomed sagittal slice', async () => {
    viewer.setTemplate(template())
    await viewer.setVolumes({
      brain: new Uint8Array(1),
      labels: new Uint8Array(1),
    })
    const closeUp = viewer.closeUp('brainstem', 'lh')!
    viewer.apply(state({ mode: 'slices', closeUp }), MAP, null)
    const nv = niivue() as FakeNiivue & {
      scene: { pan2Dxyzmm?: number[] }
    }
    expect(nv.setSliceType).toHaveBeenLastCalledWith(2)
    expect(nv.scene.pan2Dxyzmm).toEqual(slicePan([0, 0, 0], [0, 0, 0], 2.5))
    // The cut hides the cerebrum: the brain keeps only labeled voxels below
    // it, and so does the overlay.
    viewer.apply(state({ mode: 'cut', closeUp }), MAP, null)
    const brain = nv.volumes[0]!
    expect(brain.img[0]).toBe(0)
  })

  it('draws an atlas label map and merges per-hemisphere files', async () => {
    viewer.setTemplate(template())
    await viewer.setVolumes({
      brain: new Uint8Array(1),
      labels: new Uint8Array(1),
    })
    expect(viewer.labelMap()).toBe('aseg')
    await viewer.setLabelMap('hippo-amygdala', [
      { bytes: new Uint8Array(1), hemisphere: 'lh' },
      { bytes: new Uint8Array(1), hemisphere: 'rh' },
    ])
    expect(viewer.labelMap()).toBe('hippo-amygdala')
    const map = buildBrainMap({ rows: [] }, 'd', null, null)
    map.labels.set(100_016, {
      measureId: 'vol:hippo-amygdala:rh:HP_tail',
      value: 1,
      significant: true,
    })
    viewer.apply(state({ mode: 'slices' }), map, null)
    const nv = niivue()
    const overlay = nv.volumes[1]!
    // Both fixture files label the block 16; the right one reads 100016.
    nv.onLocationChange({ mm: [0, 0, 0] })
    expect(onPick).toHaveBeenLastCalledWith('vol:hippo-amygdala:rh:HP_tail')
    expect(overlay.img[2 + 5 * (2 + 5 * 2)]).toBe(1)
    await viewer.setLabelMap('aseg', null)
    expect(viewer.labelMap()).toBe('aseg')
    expect(nv.volumes[1]!.name).toBe('aparc+aseg.mgz')
  })

  it('cuts with a clip plane and keeps only the overlay on the face', async () => {
    viewer.setTemplate(template())
    await viewer.setVolumes({
      brain: new Uint8Array(1),
      labels: new Uint8Array(1),
    })
    const cut = { depthMm: 0, azimuth: 90, elevation: 0 }
    viewer.apply(state({ mode: 'cut', cut }), MAP, null)
    const nv = niivue()
    expect(nv.setClipPlane).toHaveBeenLastCalledWith(cutClipPlane(cut))
    expect(nv.setRenderAzimuthElevation).toHaveBeenLastCalledWith(110, 15)
    const labels = nv.volumes[1]!
    // Seen from the left, the cut removes x < 0 mm and colors the 3 mm face
    // behind the plane: voxels at x = 0 and 1 mm, not the removed x = -1 mm.
    const code = (x: number): number => labels.img[x + 5 * (2 + 5 * 2)]!
    expect([code(1), code(2), code(3)]).toEqual([0, 1, 1])

    viewer.rotate(15, 100)
    expect(nv.setRenderAzimuthElevation).toHaveBeenLastCalledWith(125, 90)
  })

  /** Stub 2D contexts whose copies read as drawn (opaque) or blank. */
  function stubCopies(
    onDraw: (source: HTMLCanvasElement) => void = () => undefined,
    alpha = 255,
  ): void {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          drawImage: onDraw,
          getImageData: () => ({ data: Uint8ClampedArray.of(0, 0, 0, alpha) }),
        }) as never,
    )
  }

  it('renders a frame on the export background at a multiplier', () => {
    viewer.setTemplate(template())
    const screen = [0.08, 0.09, 0.11] as const
    viewer.apply(state({ background: screen }), MAP, null)
    const nv = niivue()
    const drawn: [number, unknown][] = []
    stubCopies((source) => drawn.push([source.width, nv.opts['backColor']]))
    const frame = viewer.renderFrames([1, 1, 1], (render) =>
      render({ scale: 3 }),
    )
    // Drawn at three times the ratio of 2 on white, copied, then restored.
    expect(frame.canvas.width).toBe(300)
    expect(frame.tiles).toBeNull()
    expect(drawn).toEqual([[300, [1, 1, 1, 1]]])
    expect(element.width).toBe(100)
    expect(nv.opts['forceDevicePixelRatio']).toBe(2)
    expect(nv.opts['backColor']).toEqual([...screen, 1])
    expect(nv.resizeListener).toHaveBeenCalledTimes(2)

    // The GPU's largest drawing buffer caps the multiplier.
    nv.gl.maxSize = 200
    expect(
      viewer.renderFrames([1, 1, 1], (render) => render({ scale: 3 })).canvas
        .width,
    ).toBe(200)

    // At the screen resolution the frame is drawn without resizing.
    nv.resizeListener.mockClear()
    nv.drawScene.mockClear()
    expect(
      viewer.renderFrames([0, 0, 0], (render) => render({ scale: 1 })).canvas
        .width,
    ).toBe(100)
    expect(nv.resizeListener).not.toHaveBeenCalled()
    expect(nv.drawScene).toHaveBeenCalledTimes(2)
  })

  it('draws at the screen resolution when the buffer comes out smaller', () => {
    viewer.setTemplate(template())
    viewer.apply(state(), MAP, null)
    const nv = niivue()
    nv.gl.bufferMax = 250
    stubCopies()
    expect(
      viewer.renderFrames([1, 1, 1], (render) => render({ scale: 3 })).canvas
        .width,
    ).toBe(100)
    expect(element.width).toBe(100)
    expect(nv.opts['forceDevicePixelRatio']).toBe(2)
  })

  it('refuses a frame it cannot copy and restores the screen view', () => {
    viewer.setTemplate(template())
    const screen = [0.08, 0.09, 0.11] as const
    viewer.apply(state({ background: screen }), MAP, null)
    const nv = niivue()
    stubCopies(() => undefined, 0)
    expect(() =>
      viewer.renderFrames([1, 1, 1], (render) => render({ scale: 3 })),
    ).toThrow(/could not be copied/)
    expect(nv.opts['backColor']).toEqual([...screen, 1])
    expect(nv.opts['forceDevicePixelRatio']).toBe(2)
    expect(element.width).toBe(100)
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    expect(() =>
      viewer.renderFrames([1, 1, 1], (render) => render({ scale: 1 })),
    ).toThrow(/could not be copied/)
    expect(nv.opts['backColor']).toEqual([...screen, 1])
  })

  it('leaves the selection outline out of the exported frames', () => {
    viewer.setTemplate(template())
    const nv = niivue()
    const mesh = (): { rgba255: Uint8Array } =>
      nv.meshes.find((m) => m.name === 'lh.pial')!
    viewer.apply(state(), MAP, null)
    const plain = Array.from(mesh().rgba255)
    viewer.apply(state(), MAP, 'dk:bi:precentral:ThickAvg')
    const outlined = mesh().rgba255
    expect(Array.from(outlined)).not.toEqual(plain)
    const drawn: number[][] = []
    stubCopies(() => drawn.push(Array.from(mesh().rgba255)))
    viewer.renderFrames([1, 1, 1], (render) => [
      render({ scale: 1 }),
      render({ scale: 3 }),
    ])
    // Both frames draw without the outline; the saved colors come back.
    expect(drawn).toEqual([plain, plain])
    expect(mesh().rgba255).toBe(outlined)
  })

  /** Make the next volumes' label voxels come from a function of x, y, z. */
  function labelVoxels(
    label: (x: number, y: number, z: number) => number,
  ): () => void {
    const read = vi.mocked(NVImage.new)
    const original = read.getMockImplementation()!
    read.mockImplementation(async (...args: Parameters<typeof original>) => {
      const image = await original(...args)
      const img = new Int16Array(125)
      for (let z = 0; z < 5; z++) {
        for (let y = 0; y < 5; y++) {
          for (let x = 0; x < 5; x++) img[x + 5 * (y + 5 * z)] = label(x, y, z)
        }
      }
      ;(image as { img: ArrayLike<number> }).img = img
      return image
    })
    return () => read.mockImplementation(original)
  }

  it('draws a surface atlas by its regions and picks them', () => {
    viewer.setTemplate(template())
    expect(viewer.hasSurfaceAtlas('a2009s')).toBe(false)
    const annotation = {
      vertexEntry: Int32Array.of(0, 0, 1, 1),
      entries: [
        {
          name: 'G_precentral',
          value: 1,
          rgb: [1, 0, 0] as [number, number, number],
        },
        {
          name: 'Unknown',
          value: 2,
          rgb: [2, 0, 0] as [number, number, number],
        },
      ],
    }
    viewer.setSurfaceAtlas('a2009s', ['none'], {
      lh: annotation,
      rh: annotation,
    })
    expect(viewer.hasSurfaceAtlas('a2009s')).toBe(true)
    const map = buildBrainMap(
      {
        rows: [
          {
            measureId: 'parc:a2009s:lh:G_precentral:ThickAvg',
            d: -1,
            t: -3,
            significant: true,
          },
        ],
      },
      'd',
      'a2009s:ThickAvg:hemi',
      null,
    )
    viewer.apply(state(), map, null)
    const nv = niivue()
    nv.pickFrac = [-40 / 256 + 0.5, 0.5, 0.5]
    click(element)
    expect(onPick).toHaveBeenLastCalledWith(
      'parc:a2009s:lh:G_precentral:ThickAvg',
    )
    // The unknown label is no region.
    nv.pickFrac = [-30 / 256 + 0.5, 0.5, 0.5]
    click(element)
    expect(onPick).toHaveBeenLastCalledWith(null)
    const short = { vertexEntry: Int32Array.of(0), entries: annotation.entries }
    expect(() =>
      viewer.setSurfaceAtlas('dkt', ['none'], { lh: short, rh: short }),
    ).toThrow(/disagree on the vertex count/)
  })

  it('needs the template before an atlas and the volumes before a map', async () => {
    const annotation = { vertexEntry: new Int32Array(4), entries: [] }
    expect(() =>
      viewer.setSurfaceAtlas('a2009s', [], { lh: annotation, rh: annotation }),
    ).toThrow(/template first/)
    await expect(viewer.setLabelMap('thalamic', [])).rejects.toThrow(
      /volumes first/,
    )
  })

  it('refuses a label map on another grid', async () => {
    await viewer.setVolumes({
      brain: new Uint8Array(1),
      labels: new Uint8Array(1),
    })
    const read = vi.mocked(NVImage.new)
    const original = read.getMockImplementation()!
    read.mockImplementationOnce(
      async (...args: Parameters<typeof original>) => {
        const image = await original(...args)
        ;(image.hdr as unknown as { dims: number[] }).dims = [3, 4, 5, 5]
        return image
      },
    )
    await expect(
      viewer.setLabelMap('thalamic', [
        { bytes: new Uint8Array(1), hemisphere: null },
      ]),
    ).rejects.toThrow(/does not match/)
  })

  it('finds the pons-medulla boundary in drawn brainstem subfields', async () => {
    // Medulla (175) below z = 2, pons (174) from z = 2: the boundary lies
    // between -1 and 0 mm.
    const restore = labelVoxels((x, y, z) =>
      x >= 1 && x <= 3 && y >= 1 && y <= 3 && z >= 1 ? (z < 2 ? 175 : 174) : 0,
    )
    try {
      await viewer.setVolumes({
        brain: new Uint8Array(1),
        labels: new Uint8Array(1),
      })
      await viewer.setLabelMap('brainstem-ss', [
        { bytes: new Uint8Array(1), hemisphere: null },
      ])
      const close = viewer.closeUp('brainstem', 'lh')!
      expect(close.centerMm[0]).toBeCloseTo(0)
      expect(close.crosshairMm[2]).toBeGreaterThanOrEqual(-1)
      expect(close.crosshairMm[2]).toBeLessThanOrEqual(0)
    } finally {
      restore()
    }
  })

  it('places the thalamus and hippocampus close-ups', async () => {
    const restore = labelVoxels((x, y, z) =>
      z !== 2
        ? 0
        : x === 1
          ? 10
          : x === 3
            ? 49
            : y === 0
              ? 17
              : y === 4
                ? 54
                : 0,
    )
    try {
      await viewer.setVolumes({
        brain: new Uint8Array(1),
        labels: new Uint8Array(1),
      })
      expect(viewer.closeUp('thalamus', 'lh')).toMatchObject({
        plane: 'coronal',
        zoom: 2,
        hideCerebrum: false,
        hemisphere: null,
        centerMm: [0, 0, 0],
      })
      const left = viewer.closeUp('hippocampus', 'lh')!
      expect(left).toMatchObject({ plane: 'sagittal', hemisphere: 'lh' })
      expect(left.centerMm[1]).toBeCloseTo(-2)
      expect(viewer.closeUp('hippocampus', 'rh')!.centerMm[1]).toBeCloseTo(2)
    } finally {
      restore()
    }
  })

  it('hides the cerebrum in a brainstem cut and shows it again', async () => {
    viewer.setTemplate(template())
    await viewer.setVolumes({
      brain: new Uint8Array(1),
      labels: new Uint8Array(1),
    })
    const nv = niivue()
    const closeUp = viewer.closeUp('brainstem', 'lh')!
    viewer.apply(state({ mode: 'cut', closeUp }), MAP, null)
    const brain = nv.volumes[0]!
    const masked = brain.img
    viewer.apply(state({ mode: 'cut', closeUp: null }), MAP, null)
    expect(brain.img).not.toBe(masked)
    expect(nv.setSliceType).toHaveBeenLastCalledWith(4)
  })

  it('frames the 3D views through NiiVue pivot', async () => {
    const nv = niivue() as FakeNiivue & {
      setPivot3D?: () => void
      pivot3D?: number[]
      furthestFromPivot?: number
      scene: { volScaleMultiplier?: number }
    }
    viewer.dispose()
    // A NiiVue with a pivot to override.
    const proto = Object.getPrototypeOf(nv) as { setPivot3D?: () => void }
    proto.setPivot3D = function (this: { pivot3D: number[] }) {
      this.pivot3D = [0, 0, 0]
    }
    try {
      viewer = await createBrainViewer(element, { onPick, onContextLost }, 2)
      const framed = niivue() as typeof nv
      viewer.setTemplate(template())
      viewer.apply(state(), MAP, null)
      framed.setPivot3D!()
      // The left hemisphere's vertices span x -40 to -30 and y 0 to 10.
      expect(framed.pivot3D![1]).toBeCloseTo(5)
      expect(framed.scene.volScaleMultiplier).toBeGreaterThan(0)
      const first = framed.scene.volScaleMultiplier
      framed.scene.volScaleMultiplier = 9
      framed.setPivot3D!()
      // The same view keeps a zoom the operator set.
      expect(framed.scene.volScaleMultiplier).toBe(9)
      viewer.apply(state({ view: 'dorsal' }), MAP, null)
      framed.setPivot3D!()
      expect(framed.scene.volScaleMultiplier).not.toBe(9)
      expect(first).toBeGreaterThan(0)
      await viewer.setVolumes({
        brain: new Uint8Array(1),
        labels: new Uint8Array(1),
      })
      viewer.apply(state({ mode: 'cut' }), MAP, null)
      framed.setPivot3D!()
      expect(framed.pivot3D!.map((v) => Math.round(v))).toEqual([0, 0, 0])
      const closeUp = viewer.closeUp('thalamus', 'lh')
      expect(closeUp).toBeNull()
    } finally {
      delete proto.setPivot3D
    }
  })

  it('shapes the canvas for an export and reports the slice panes', async () => {
    viewer.setTemplate(template())
    await viewer.setVolumes({
      brain: new Uint8Array(1),
      labels: new Uint8Array(1),
    })
    viewer.apply(state({ mode: 'slices' }), MAP, null)
    const nv = niivue() as FakeNiivue & {
      screenSlices: { leftTopWidthHeight: number[]; axCorSag: number }[]
    }
    nv.screenSlices = [
      { leftTopWidthHeight: [0, 0, 30.4, 30], axCorSag: 0 },
      { leftTopWidthHeight: [30.4, 0, 30, 30], axCorSag: 1 },
      { leftTopWidthHeight: [60, 0, 30, 30], axCorSag: 4 },
    ]
    stubCopies()
    const host = element.parentElement!
    const before = host.getAttribute('style')
    const frame = viewer.renderFrames([0, 0, 0], (render) =>
      render({ scale: 1, aspect: 3 }),
    )
    expect(frame.tiles).toEqual([
      { x: 0, y: 0, width: 30, height: 30 },
      { x: 30, y: 0, width: 30, height: 30 },
    ])
    // The crosshair and letters return after the export.
    expect(nv.opts['crosshairWidth']).toBeUndefined()
    expect(host.getAttribute('style')).toBe(before)
  })

  it('reports a lost context once and stops drawing', () => {
    viewer.setTemplate(template())
    const event = new Event('webglcontextlost', { cancelable: true })
    element.dispatchEvent(event)
    element.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(event.defaultPrevented).toBe(true)
    expect(onContextLost).toHaveBeenCalledTimes(1)
    const nv = niivue()
    nv.drawScene.mockClear()
    viewer.apply(state(), MAP, null)
    expect(nv.drawScene).not.toHaveBeenCalled()
    expect(() =>
      viewer.renderFrames([1, 1, 1], (render) => render({ scale: 1 })),
    ).toThrow(/not drawing/)
  })

  it('releases NiiVue and the context on dispose', () => {
    viewer.setTemplate(template())
    viewer.apply(state(), MAP, null)
    const nv = niivue()
    viewer.dispose()
    viewer.dispose()
    expect(nv.cleanup).toHaveBeenCalledTimes(1)
    expect(fake.loseContext).toHaveBeenCalled()
    onPick.mockReset()
    nv.pickFrac = [-40 / 256 + 0.5, 0.5, 0.5]
    click(element)
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe('camera and clip conventions', () => {
  it('places the surface presets', () => {
    expect(surfaceCamera('lateral', 'rh')).toEqual({
      azimuth: 270,
      elevation: 0,
    })
    expect(surfaceCamera('medial', 'lh')).toEqual({
      azimuth: 270,
      elevation: 0,
    })
    expect(surfaceCamera('medial', 'rh')).toEqual({ azimuth: 90, elevation: 0 })
    expect(surfaceCamera('dorsal', 'lh')).toEqual({ azimuth: 0, elevation: 90 })
    expect(surfaceCamera('ventral', 'lh')).toEqual({
      azimuth: 180,
      elevation: -90,
    })
  })

  it('faces the cut obliquely and mirrors the clip azimuth', () => {
    expect(cutCamera({ depthMm: 0, azimuth: 90, elevation: 80 })).toEqual({
      azimuth: 110,
      elevation: 75,
    })
    expect(cutClipPlane({ depthMm: 16, azimuth: 90, elevation: 10 })).toEqual([
      -16 / 256,
      270,
      10,
    ])
    expect(cutClipPlane({ depthMm: 0, azimuth: 0, elevation: 0 })[1]).toBe(0)
    const normal = clipNormal(270, 0)
    expect(normal[0]).toBeCloseTo(1)
    expect(normal[1]).toBeCloseTo(0)
    expect(clipNormal(0, 90)[2]).toBeCloseTo(-1)
  })
})

describe('framing', () => {
  it('fits a lateral hemisphere to a wide canvas and centers it', () => {
    // A box 160 mm long (y), 100 mm tall (z), 60 mm wide (x), off center.
    const points: number[] = []
    for (const x of [-70, -10]) {
      for (const y of [-100, 60]) {
        for (const z of [-40, 60]) points.push(x, y, z)
      }
    }
    const fit = fitCamera(points, 90, 0, 3)!
    // The pivot is the box's center; seen from the left, y spans the width
    // and z the height.
    expect(fit.pivot.map((v) => Math.round(v))).toEqual([-40, -20, 10])
    const halfHeight = (0.8 * fit.radius) / fit.scale
    expect(halfHeight).toBeCloseTo(50 / 0.9, 5)
    // On a square canvas the 160 mm length limits the fit instead.
    const square = fitCamera(points, 90, 0, 1)!
    expect((0.8 * square.radius) / square.scale).toBeCloseTo(80 / 0.9, 5)
    expect(fitCamera([], 90, 0, 1)).toBeNull()
  })

  it('pans the slices so a point sits at the pane centers', () => {
    expect(slicePan([10, -20, 5], [0, 0, 0], 2)).toEqual([-20, 40, -10, 2])
    expect(slicePan([0, 0, 0], [1, 2, 3], 1)).toEqual([1, 2, 3, 1])
  })
})
