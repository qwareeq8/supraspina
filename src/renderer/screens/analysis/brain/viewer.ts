/**
 * The NiiVue side of the brain viewer, loaded on demand so that the NiiVue
 * chunk stays out of the startup bundle. One WebGL2 canvas shows the
 * fsaverage5 surfaces (Surface), a volume rendering of `brain.mgz` cut by a
 * clip plane (Cut), or orthogonal slices (Slices), with the statistic
 * painted on the surface atlas's parcels and on a recoded label map: the
 * template's or a subject's `aparc+aseg`, or a subject's atlas label map.
 *
 * NiiVue reads nothing over the network here: every file arrives as bytes
 * from main, the fonts and matcaps it embeds are data URLs, and it compiles
 * no WebAssembly, so the production CSP holds. Its own keyboard shortcuts
 * (view cycling, clip presets, a version alert) never see a key, because the
 * React wrapper handles keys in the capture phase.
 */

import {
  MULTIPLANAR_TYPE,
  Niivue,
  NVImage,
  NVMesh,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import type { HemisphereTokenRule } from '../../../../shared/group-analysis'
import { RIGHT_FILE_OFFSET, surfaceRegion } from './atlas-display'
import {
  BRAINSTEM_LABEL,
  labelOverlay,
  measureAtLabel,
  measureAtParcel,
  parcelBorders,
  surfaceColors,
  type BrainMap,
  type VoxelSlab,
} from './brain-map'
import type { PixelBox } from './brain-figure-layout'
import {
  BRAINSTEM_SUBFIELDS,
  isAmygdalaNucleus,
  isHippocampalSubfield,
  isThalamicNucleus,
} from './color-lut'
import {
  readAnnotation,
  readCurvature,
  readSurface,
  type Annotation,
  type Surface,
} from './freesurfer'

/** The kind of drawing on the canvas. */
export type BrainMode = 'surface' | 'cut' | 'slices'
/** The surface geometry. */
export type SurfaceKind = 'pial' | 'inflated'
/** A camera preset for the surface view. */
export type SurfaceView = 'lateral' | 'medial' | 'dorsal' | 'ventral'
/** A hemisphere. */
export type Hemisphere = 'lh' | 'rh'
/** One slice plane. */
export type SlicePlane = 'axial' | 'coronal' | 'sagittal'
/** A close-up of the cut and slice views. */
export type ClosePreset = 'brainstem' | 'thalamus' | 'hippocampus'

/**
 * A cut through the volume, seen from a viewing direction: the part nearer
 * the viewer is removed, and the cut face lies `depthMm` beyond the volume
 * center (negative is nearer the viewer).
 */
export interface CutPlane {
  depthMm: number
  /** The viewing azimuth, in degrees, as NiiVue's camera azimuth. */
  azimuth: number
  /** The viewing elevation, in degrees. */
  elevation: number
}

/**
 * A close-up on one structure: the slices show one plane through it and
 * the cut view centers on it, both zoomed.
 */
export interface CloseUp {
  preset: ClosePreset
  hemisphere: Hemisphere | null
  /** The structure's centroid, in mm. */
  centerMm: [number, number, number]
  /** Where the slice crosshair goes, in mm. */
  crosshairMm: [number, number, number]
  plane: SlicePlane
  zoom: number
  /** Leave only the brainstem, cerebellum, and diencephalon in the cut. */
  hideCerebrum: boolean
}

/** Everything the canvas shows besides the data. */
export interface ViewState {
  mode: BrainMode
  surface: SurfaceKind
  hemisphere: Hemisphere
  view: SurfaceView
  cut: CutPlane
  /** The canvas background, 0-1 RGB. */
  background: readonly [number, number, number]
  /** A close-up of the cut and slice views, or null for the whole brain. */
  closeUp?: CloseUp | null
}

/** The raw template files, keyed by asset ID. */
export interface TemplateFiles {
  surfaces: Record<
    Hemisphere,
    {
      pial: Uint8Array
      inflated: Uint8Array
      sulc: Uint8Array
      annot: Uint8Array
    }
  >
}

/** The volumes of the cut and slice views: `brain.mgz` and `aparc+aseg`. */
export interface VolumeFiles {
  brain: Uint8Array
  labels: Uint8Array
}

/** One file of an atlas label map, with the hemisphere it holds, if any. */
export interface LabelMapFile {
  bytes: Uint8Array
  hemisphere: Hemisphere | null
}

/** One render of an export. */
export interface FrameRequest {
  /** The multiplier of the screen resolution. */
  scale: number
  /**
   * The width-to-height ratio of the canvas for this render, or null to
   * keep the screen's.
   */
  aspect?: number | null
}

/** One rendered export frame. */
export interface RenderedFrame {
  canvas: HTMLCanvasElement
  /** The slice panes, in frame pixels; null outside Slices. */
  tiles: PixelBox[] | null
}

/** What the viewer reports back. */
export interface ViewerCallbacks {
  /** A click landed on a drawn measure (null for none). */
  onPick(measureId: string | null): void
  /** The WebGL context was lost; the viewer is unusable. */
  onContextLost(): void
}

/** The controller BrainView drives. */
export interface BrainViewer {
  setTemplate(files: TemplateFiles): void
  /** Add a surface atlas's fsaverage5 annotations; DK is built in. */
  setSurfaceAtlas(
    atlasId: string,
    rules: readonly HemisphereTokenRule[],
    annotations: Record<Hemisphere, Annotation>,
  ): void
  hasSurfaceAtlas(atlasId: string): boolean
  setVolumes(files: VolumeFiles): Promise<void>
  hasVolumes(): boolean
  /**
   * Draw an atlas label map instead of `aparc+aseg` (null puts it back).
   * Two files merge into one map, the right one's labels offset by
   * `RIGHT_FILE_OFFSET`.
   */
  setLabelMap(sourceId: string, files: LabelMapFile[] | null): Promise<void>
  /** The label map drawn now: `aseg` or an atlas's. */
  labelMap(): string
  apply(state: ViewState, map: BrainMap, selection: string | null): void
  /** Rotate the camera by degrees (Surface and Cut). */
  rotate(azimuth: number, elevation: number): void
  /** Move the slice crosshair by voxels (Slices). */
  moveCrosshair(dx: number, dy: number, dz: number): void
  /** Place the slice crosshair at a point in mm (Slices). */
  setCrosshairMm(mm: readonly [number, number, number]): void
  /**
   * The close-up of a structure in the loaded volumes, or null when they
   * lack it: the brainstem (centered on its label, the crosshair at the
   * pons-medulla boundary when the subfields are drawn), the thalami, or
   * one hippocampus and amygdala.
   */
  closeUp(preset: ClosePreset, hemisphere: Hemisphere): CloseUp | null
  /** The cut at the given angles whose face passes through a point. */
  cutThrough(cut: CutPlane, mm: readonly [number, number, number]): CutPlane
  /**
   * Draw the current view for an export on the given background (0-1 RGB),
   * without the selection outline, the crosshair, or the orientation
   * letters, run `draw` with a function that renders a frame at a
   * multiplier of the screen resolution (capped by the GPU's limits) and
   * copies it to a 2D canvas, then redraw the screen view, all in one task.
   */
  renderFrames<T>(
    background: readonly [number, number, number],
    draw: (renderFrame: (request: FrameRequest) => RenderedFrame) => T,
  ): T
  dispose(): void
}

/** The camera of each surface preset; NiiVue's azimuth 90 faces the left side. */
export function surfaceCamera(
  view: SurfaceView,
  hemisphere: Hemisphere,
): { azimuth: number; elevation: number } {
  switch (view) {
    case 'lateral':
      return { azimuth: hemisphere === 'lh' ? 90 : 270, elevation: 0 }
    case 'medial':
      return { azimuth: hemisphere === 'lh' ? 270 : 90, elevation: 0 }
    case 'dorsal':
      return { azimuth: 0, elevation: 90 }
    case 'ventral':
      return { azimuth: 180, elevation: -90 }
  }
}

/** The camera that faces a cut obliquely, so its face and depth both read. */
export function cutCamera(cut: CutPlane): {
  azimuth: number
  elevation: number
} {
  return {
    azimuth: cut.azimuth + 20,
    elevation: Math.max(-75, Math.min(75, cut.elevation + 15)),
  }
}

/**
 * NiiVue's `[depth, azimuth, elevation]` clip plane for a cut. NiiVue keeps
 * the side a plane's azimuth points away from, and its clip azimuth runs
 * opposite to the camera azimuth, so a cut seen from camera azimuth A uses
 * clip azimuth 360 - A.
 */
export function cutClipPlane(cut: CutPlane): [number, number, number] {
  return [
    -cut.depthMm / CLIP_FOV_MM,
    (((360 - cut.azimuth) % 360) + 360) % 360,
    cut.elevation,
  ]
}

/**
 * The unit normal NiiVue gives a clip plane, in fractional volume
 * coordinates; the kept side has `dot(n, f - 0.5) + depth >= 0`.
 */
export function clipNormal(azimuth: number, elevation: number): number[] {
  const phi = (-elevation * Math.PI) / 180
  const theta = (((azimuth + 180 - 90) % 360) * Math.PI) / 180
  return [
    Math.cos(phi) * Math.cos(theta),
    Math.cos(phi) * Math.sin(theta),
    Math.sin(phi),
  ]
}

/** The camera's framing of a 3D view: what it turns about and its zoom. */
export interface CameraFit {
  /** The point the camera turns about, centered on the canvas, in mm. */
  pivot: [number, number, number]
  /** The scene radius NiiVue scales by (its `furthestFromPivot`). */
  radius: number
  /** NiiVue's `volScaleMultiplier`. */
  scale: number
}

/** The share of the canvas a fitted 3D view fills. */
const FIT_FILL = 0.9

/**
 * Fit points to the canvas as NiiVue's orthographic 3D camera sees them:
 * rotate them as the camera does (`rotateX(270 - elevation)` after
 * `rotateZ(azimuth - 180)`), center their projected box, and choose the
 * zoom at which the box fills `FIT_FILL` of the canvas.
 *
 * @param points - The x, y, z triplets in mm.
 * @param azimuth - The camera azimuth in degrees.
 * @param elevation - The camera elevation in degrees.
 * @returns The fit, or null without points.
 */
export function fitCamera(
  points: ArrayLike<number>,
  azimuth: number,
  elevation: number,
  aspect: number,
): CameraFit | null {
  const count = Math.floor(points.length / 3)
  if (count === 0 || !(aspect > 0)) return null
  const step = Math.max(1, Math.floor(count / 4000))
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < count; i += step) {
    for (let k = 0; k < 3; k++) {
      const value = points[i * 3 + k]!
      box[k] = Math.min(box[k]!, value)
      box[k + 3] = Math.max(box[k + 3]!, value)
    }
  }
  const center = [0, 1, 2].map((k) => (box[k]! + box[k + 3]!) / 2)
  const z = ((azimuth - 180) * Math.PI) / 180
  const x = ((270 - elevation) * Math.PI) / 180
  const [cz, sz, cx, sx] = [Math.cos(z), Math.sin(z), Math.cos(x), Math.sin(x)]
  const rotate = (d: readonly number[]): [number, number, number] => {
    const qx = cz * d[0]! - sz * d[1]!
    const qy = sz * d[0]! + cz * d[1]!
    return [qx, cx * qy - sx * d[2]!, sx * qy + cx * d[2]!]
  }
  const flat = [Infinity, Infinity, -Infinity, -Infinity]
  let radius = 1
  for (let i = 0; i < count; i += step) {
    const d = [0, 1, 2].map((k) => points[i * 3 + k]! - center[k]!)
    const r = rotate(d)
    flat[0] = Math.min(flat[0]!, r[0])
    flat[1] = Math.min(flat[1]!, r[1])
    flat[2] = Math.max(flat[2]!, r[0])
    flat[3] = Math.max(flat[3]!, r[1])
    radius = Math.max(radius, Math.hypot(d[0]!, d[1]!, d[2]!))
  }
  // Move the pivot to the projected box's center: rotate the offset back
  // (the inverse of a rotation is its transpose).
  const ox = (flat[0]! + flat[2]!) / 2
  const oy = (flat[1]! + flat[3]!) / 2
  const qx = ox
  const qy = cx * oy
  const qz = -sx * oy
  const back = [cz * qx + sz * qy, -sz * qx + cz * qy, qz]
  const pivot = [0, 1, 2].map((k) => center[k]! + back[k]!) as [
    number,
    number,
    number,
  ]
  const halfW = Math.max(1, (flat[2]! - flat[0]!) / 2)
  const halfH = Math.max(1, (flat[3]! - flat[1]!) / 2)
  // NiiVue shows +-0.8 radius / scale on the shorter side.
  const scale =
    aspect >= 1
      ? 0.8 * radius * Math.min(aspect / halfW, 1 / halfH) * FIT_FILL
      : 0.8 * radius * Math.min(1 / halfW, 1 / (aspect * halfH)) * FIT_FILL
  return { pivot, radius, scale }
}

/**
 * The 2D pan and zoom that center the slices on a point: NiiVue shifts each
 * pane's window by the pan and then divides it by the zoom about 0 mm, so
 * the pan is `volumeCenter - point * zoom`.
 *
 * @param point - The point to center, in mm.
 * @param volumeCenter - The volume's center, in mm.
 * @returns NiiVue's `pan2Dxyzmm`.
 */
export function slicePan(
  point: readonly number[],
  volumeCenter: readonly number[],
  zoom: number,
): [number, number, number, number] {
  return [
    volumeCenter[0]! - point[0]! * zoom,
    volumeCenter[1]! - point[1]! * zoom,
    volumeCenter[2]! - point[2]! * zoom,
    zoom,
  ]
}

/** The thickness of the colored cut face, in mm. */
const CUT_FACE_MM = 5

/** The error of a frame that could not be copied. */
const COPY_FAILED =
  'The brain view could not be copied for export. Let it draw, then export again.'

/** The longest side of an export render, in pixels. */
const MAX_EXPORT_PIXELS = 8192
/**
 * The most pixels an export render draws: a volume render's cost grows
 * with them, and a software renderer stalls long before the GPU limits.
 */
const MAX_EXPORT_AREA = 16_000_000

/** The volume field of view the clip depth is a fraction of, in mm. */
const CLIP_FOV_MM = 256
/** The gap between inflated hemispheres, in mm. */
const INFLATED_GAP_MM = 6
/** The share of a slice pane the brain fills. */
const SLICE_FILL = 0.86
/** The `brain.mgz` value below which the gray colormap draws black. */
const BRAIN_FLOOR = 12

/**
 * The `aparc+aseg` labels a brainstem close-up keeps in its cut: brainstem,
 * cerebellum, fourth ventricle, ventral diencephalon, and thalamus.
 */
const BELOW_CEREBRUM = new Set([16, 7, 8, 46, 47, 15, 28, 60, 10, 49])

/**
 * A mesh shader that keeps the vertex colors bright: a soft headlight
 * (facing surfaces at full color, silhouettes darker), no specular white.
 */
const MESH_SHADER = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN;
out vec4 color;
void main() {
	vec3 n = normalize(vN);
	float light = 0.66 + 0.34 * abs(n.z);
	color = vec4(vClr.rgb * light, opacity);
}`

interface HemiAtlas {
  annotation: Annotation
  border: Uint8Array
  /** The region of each annotation entry. */
  regions: (string | null)[]
}

interface Hemi {
  sulc: Float32Array
  /** The atlases drawn on this hemisphere, by atlas ID. */
  atlases: Map<string, HemiAtlas>
  surfaces: Record<SurfaceKind, { surface: Surface; mesh: NVMesh }>
}

interface LabelVolume {
  image: NVImage
  source: ArrayLike<number>
}

interface Volumes {
  brain: NVImage
  /** The original `brain.mgz` voxels, kept while a close-up hides some. */
  brainImg: ArrayLike<number>
  aseg: LabelVolume
  /** The drawn label map: `aseg` itself or an atlas's. */
  overlay: LabelVolume & { sourceId: string }
  dims: [number, number, number]
  /** The row-major 4x4 voxel-to-mm matrix of the file order. */
  affine: number[][]
  /** The brain's box in mm (the labeled voxels), min then max. */
  box: [number, number, number, number, number, number] | null
  /** The voxels a brainstem close-up keeps, made on first use. */
  belowCerebrum: Uint8Array | null
  /** A sparse sample of the brain's voxels, in mm, for framing the cut. */
  points: Float32Array
  /** The same sample of the voxels a brainstem close-up keeps. */
  belowPoints: Float32Array | null
}

/** The voxel stride of the framing sample. */
const SAMPLE_STRIDE = 4

interface Internals {
  uiData: { mouseDepthPicker: boolean; dpr: number }
  mousePos: number[]
  backgroundMasksOverlays: number
  pivot3D: number[]
  furthestFromPivot: number
  setPivot3D?: () => void
  screenSlices?: { leftTopWidthHeight: number[]; axCorSag: number }[]
  createCustomMeshShader?: (text: string, name: string) => unknown
  meshShaders?: { Name: string }[]
}

function shiftX(surface: Surface, hemisphere: Hemisphere): Surface {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < surface.positions.length; i += 3) {
    min = Math.min(min, surface.positions[i]!)
    max = Math.max(max, surface.positions[i]!)
  }
  const shift =
    hemisphere === 'lh'
      ? -max - INFLATED_GAP_MM / 2
      : -min + INFLATED_GAP_MM / 2
  const positions = surface.positions.slice()
  for (let i = 0; i < positions.length; i += 3)
    positions[i] = positions[i]! + shift
  return { ...surface, positions }
}

// NiiVue declares every one of NVImage.new's twenty parameters; the leading
// two suffice, and the name's extension selects the MGZ reader.
const newImage = NVImage.new as unknown as (
  buffer: ArrayBuffer,
  name: string,
) => Promise<NVImage>

function readVolume(bytes: Uint8Array, name: string): Promise<NVImage> {
  return newImage(bytes.slice().buffer, name)
}

function readAffine(image: NVImage): number[][] {
  const affine = (image.hdr as unknown as { affine?: number[][] } | null)
    ?.affine
  if (!Array.isArray(affine) || affine.length < 3) {
    throw new TypeError('The label volume has no voxel-to-mm matrix.')
  }
  return affine
}

function dimsOf(image: NVImage): [number, number, number] {
  const dims = image.hdr?.dims
  if (!dims || dims.length < 4 || !image.img) {
    throw new TypeError('The label volume has no dimensions.')
  }
  return [dims[1]!, dims[2]!, dims[3]!]
}

function atlasOf(
  annotation: Annotation,
  triangles: Uint32Array,
  rules: readonly HemisphereTokenRule[],
  hemisphere: Hemisphere,
): HemiAtlas {
  return {
    annotation,
    border: parcelBorders(annotation, triangles),
    regions: annotation.entries.map((entry) =>
      surfaceRegion(entry.name, rules, hemisphere),
    ),
  }
}

/**
 * Attach NiiVue to a canvas.
 *
 * @param canvas - The canvas, already in the document.
 * @throws Error when WebGL2 is unavailable.
 */
export async function createBrainViewer(
  canvas: HTMLCanvasElement,
  callbacks: ViewerCallbacks,
  pixelRatio: number,
): Promise<BrainViewer> {
  const nv = new Niivue({
    backColor: [1, 1, 1, 1],
    show3Dcrosshair: false,
    isColorbar: false,
    isOrientCube: false,
    isRuler: false,
    logLevel: 'error',
    loadingText: '',
    dragAndDropEnabled: false,
    scrollRequiresFocus: true,
    forceDevicePixelRatio: pixelRatio,
    multiplanarShowRender: SHOW_RENDER.NEVER,
    multiplanarLayout: MULTIPLANAR_TYPE.ROW,
    multiplanarEqualSize: true,
    isClipAllVolumes: true,
    crosshairColor: [1, 1, 1, 0.45],
    clipPlaneHotKey: '',
    cycleClipPlaneHotKey: '',
    viewModeHotKey: '',
  })
  const internals = nv as unknown as Internals
  let lost = false
  let disposed = false
  const onLost = (event: Event): void => {
    event.preventDefault()
    if (lost || disposed) return
    lost = true
    callbacks.onContextLost()
  }
  canvas.addEventListener('webglcontextlost', onLost)
  await nv.attachToCanvas(canvas)
  internals.backgroundMasksOverlays = 1
  nv.setClipPlaneColor([0, 0, 0, 0])
  nv.addColormap('ssBrainGray', {
    R: [0, 0, 150, 205, 245],
    G: [0, 0, 150, 205, 245],
    B: [0, 0, 150, 205, 245],
    A: [0, 0, 255, 255, 255],
    I: [0, 12, 40, 90, 255],
  })
  let meshShader = -1
  if (internals.createCustomMeshShader && internals.meshShaders) {
    const shader = internals.createCustomMeshShader(MESH_SHADER, 'ssBright')
    internals.meshShaders.push(shader as { Name: string })
    meshShader = internals.meshShaders.length - 1
  }

  // Frame the 3D views ourselves: NiiVue turns about the center of every
  // loaded mesh or the whole volume, which leaves one hemisphere or the
  // brain small and off-center.
  let fit: { key: string; points: () => ArrayLike<number> } | null = null
  let applied: { key: string; aspect: number; fit: CameraFit } | null = null
  const baseSetPivot = internals.setPivot3D?.bind(nv)
  if (baseSetPivot) {
    internals.setPivot3D = () => {
      baseSetPivot()
      if (!fit || !current || current.state.mode === 'slices') return
      const aspect = canvas.width / Math.max(1, canvas.height)
      if (
        !applied ||
        applied.key !== fit.key ||
        Math.abs(applied.aspect - aspect) > 1e-3
      ) {
        const { azimuth, elevation } = currentCamera(current.state)
        const made = fitCamera(fit.points(), azimuth, elevation, aspect)
        if (!made) return
        applied = { key: fit.key, aspect, fit: made }
        nv.scene.volScaleMultiplier = made.scale
      }
      internals.pivot3D = applied.fit.pivot
      internals.furthestFromPivot = applied.fit.radius
    }
  }

  const hemis = new Map<Hemisphere, Hemi>()
  let volumes: Volumes | null = null
  let current: {
    state: ViewState
    map: BrainMap
    selection: string | null
  } | null = null
  let lastCamera = ''
  let lastOverlayKey = ''
  let lastSurfaceKey = ''
  let lastSliceKey = ''
  let hidden = false

  const surfaceAtlas = (hemi: Hemi): HemiAtlas => {
    const id = current?.map.surfaceAtlas ?? 'dk'
    return hemi.atlases.get(id) ?? hemi.atlases.get('dk')!
  }

  const visibleMeshes = (): { hemisphere: Hemisphere; surface: Surface }[] => {
    if (!current || current.state.mode !== 'surface') return []
    const { state } = current
    const sides: Hemisphere[] =
      state.view === 'dorsal' || state.view === 'ventral'
        ? ['lh', 'rh']
        : [state.hemisphere]
    return sides.flatMap((hemisphere) => {
      const hemi = hemis.get(hemisphere)
      return hemi
        ? [{ hemisphere, surface: hemi.surfaces[state.surface].surface }]
        : []
    })
  }

  const pickSurface = (mm: readonly number[]): string | null => {
    let best: { hemisphere: Hemisphere; vertex: number } | null = null
    let bestDistance = 25
    for (const { hemisphere, surface } of visibleMeshes()) {
      const p = surface.positions
      for (let v = 0; v < surface.vertexCount; v++) {
        const d =
          (p[v * 3]! - mm[0]!) ** 2 +
          (p[v * 3 + 1]! - mm[1]!) ** 2 +
          (p[v * 3 + 2]! - mm[2]!) ** 2
        if (d < bestDistance) {
          bestDistance = d
          best = { hemisphere, vertex: v }
        }
      }
    }
    if (!best || !current) return null
    const atlas = surfaceAtlas(hemis.get(best.hemisphere)!)
    const entry = atlas.annotation.vertexEntry[best.vertex]!
    const region = entry >= 0 ? atlas.regions[entry] : null
    return region ? measureAtParcel(current.map, best.hemisphere, region) : null
  }

  const pickVolume = (mm: readonly number[]): string | null => {
    if (!volumes || !current) return null
    // The overlay holds codes; read the label from the original values.
    const overlay = volumes.overlay.image
    const codes = overlay.img
    overlay.img = volumes.overlay.source as never
    try {
      const vox = overlay.mm2vox([mm[0]!, mm[1]!, mm[2]!])
      const value = overlay.getValue(vox[0]!, vox[1]!, vox[2]!)
      return Number.isFinite(value)
        ? measureAtLabel(current.map, Math.round(value))
        : null
    } finally {
      overlay.img = codes as never
    }
  }

  nv.onLocationChange = (data: unknown): void => {
    if (!current || current.state.mode !== 'slices' || disposed) return
    const mm = (data as { mm?: ArrayLike<number> } | null)?.mm
    if (!mm) return
    callbacks.onPick(pickVolume([mm[0]!, mm[1]!, mm[2]!]))
  }

  // Treat a short, still press as a click and pick through NiiVue's depth
  // picker; NiiVue only picks in 3D on double-click by itself.
  let press: { x: number; y: number; time: number } | null = null
  const onPointerDown = (event: PointerEvent): void => {
    press = { x: event.clientX, y: event.clientY, time: event.timeStamp }
  }
  const onPointerUp = (event: PointerEvent): void => {
    const start = press
    press = null
    if (!start || !current || current.state.mode === 'slices' || lost) return
    if (
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 ||
      event.timeStamp - start.time > 600
    ) {
      return
    }
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height
    const sentinel = new Float32Array([-1, -1, -1])
    nv.scene.crosshairPos = sentinel as never
    internals.mousePos = [x, y]
    internals.uiData.mouseDepthPicker = true
    nv.drawScene()
    nv.drawScene()
    const frac = nv.scene.crosshairPos as ArrayLike<number>
    if (frac[0] === -1 && frac[1] === -1 && frac[2] === -1) {
      callbacks.onPick(null)
      return
    }
    const mm = nv.frac2mm(frac as never, 0, true)
    const point = [mm[0]!, mm[1]!, mm[2]!]
    callbacks.onPick(
      current.state.mode === 'surface' ? pickSurface(point) : pickVolume(point),
    )
  }
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointerup', onPointerUp)

  const recolorSurfaces = (map: BrainMap, selection: string | null): void => {
    for (const [hemisphere, hemi] of hemis) {
      const atlas = surfaceAtlas(hemi)
      const rgba = surfaceColors({
        annotation: atlas.annotation,
        regions: atlas.regions,
        sulc: hemi.sulc,
        border: atlas.border,
        values: map.cortex[hemisphere],
        limit: map.limit,
        selection,
      })
      for (const kind of ['pial', 'inflated'] as const) {
        const mesh = hemi.surfaces[kind].mesh
        mesh.rgba255 = rgba
        mesh.updateMesh(nv.gl)
      }
    }
  }

  const voxelToMm = (vox: readonly number[]): [number, number, number] => {
    const a = volumes!.affine
    const [x, y, z] = [0, 1, 2].map(
      (r) =>
        a[r]![0]! * vox[0]! +
        a[r]![1]! * vox[1]! +
        a[r]![2]! * vox[2]! +
        a[r]![3]!,
    )
    return [x!, y!, z!]
  }

  const voxelToFrac = (vox: readonly number[]): Float32Array | null => {
    if (!volumes) return null
    return nv.mm2frac(voxelToMm(vox) as never) as Float32Array
  }

  // The cut face as a slab in voxel space: NiiVue's plane value is linear in
  // the fractional coordinates, which are affine in the voxel indices.
  const cutSlab = (cut: CutPlane): VoxelSlab | null => {
    if (!volumes) return null
    const [depth, azimuth, elevation] = cutClipPlane(cut)
    const n = clipNormal(azimuth, elevation)
    const value = (vox: readonly number[]): number => {
      const f = voxelToFrac(vox)
      if (!f) return Number.NaN
      return (
        n[0]! * (f[0]! - 0.5) +
        n[1]! * (f[1]! - 0.5) +
        n[2]! * (f[2]! - 0.5) +
        depth
      )
    }
    const v0 = value([0, 0, 0])
    const slab: VoxelSlab = {
      v0,
      vi: value([1, 0, 0]) - v0,
      vj: value([0, 1, 0]) - v0,
      vk: value([0, 0, 1]) - v0,
      thickness: CUT_FACE_MM / CLIP_FOV_MM,
    }
    return Object.values(slab).every(Number.isFinite) ? slab : null
  }

  /** The mm of every `SAMPLE_STRIDE`-th voxel along each axis that `keep` takes. */
  const samplePoints = (keep: (index: number) => boolean): Float32Array => {
    if (!volumes) return new Float32Array(0)
    const [nx, ny, nz] = volumes.dims
    const out: number[] = []
    for (let z = 0; z < nz; z += SAMPLE_STRIDE) {
      for (let y = 0; y < ny; y += SAMPLE_STRIDE) {
        for (let x = 0; x < nx; x += SAMPLE_STRIDE) {
          if (keep(x + nx * (y + ny * z))) out.push(...voxelToMm([x, y, z]))
        }
      }
    }
    return Float32Array.from(out)
  }

  const belowCerebrum = (): Uint8Array | null => {
    if (!volumes) return null
    if (!volumes.belowCerebrum) {
      const source = volumes.aseg.source
      const keep = new Uint8Array(source.length)
      for (let i = 0; i < source.length; i++) {
        if (BELOW_CEREBRUM.has(source[i]!)) keep[i] = 1
      }
      volumes.belowCerebrum = keep
    }
    return volumes.belowCerebrum
  }

  // Show only what lies below the cerebrum, or all of the brain again.
  const hideCerebrum = (hide: boolean): void => {
    if (!volumes || hide === hidden) return
    const brain = volumes.brain
    if (hide) {
      const keep = belowCerebrum()!
      const Typed = (
        volumes.brainImg as unknown as {
          constructor: new (n: number) => Record<number, number>
        }
      ).constructor
      const masked = new Typed(volumes.brainImg.length)
      for (let i = 0; i < keep.length; i++) {
        masked[i] = keep[i] ? volumes.brainImg[i]! : 0
      }
      brain.img = masked as never
    } else {
      brain.img = volumes.brainImg as never
    }
    hidden = hide
    lastOverlayKey = ''
  }

  let lastTable: unknown = null
  let selectedPoint: [number, number, number] | null = null
  const recodeOverlay = (
    map: BrainMap,
    selection: string | null,
    slab: VoxelSlab | null,
  ): void => {
    if (!volumes) return
    const overlay = labelOverlay(
      volumes.overlay.source,
      volumes.dims,
      map,
      selection,
      slab,
      hidden ? belowCerebrum() : null,
    )
    // Keep the file's voxel type: NiiVue uploads the texture by that type.
    const Typed = (
      volumes.overlay.source as unknown as {
        constructor: new (n: number) => { set(a: ArrayLike<number>): void }
      }
    ).constructor
    const codes = new Typed(overlay.codes.length)
    codes.set(overlay.codes)
    volumes.overlay.image.img = codes as never
    volumes.overlay.image.setColormapLabel(overlay.table)
    lastTable = overlay.table
    selectedPoint = overlay.selectedPoint
  }

  const showVolumes = (show: boolean): void => {
    if (!volumes) return
    const { brain } = volumes
    const overlay = volumes.overlay.image
    const present = nv.volumes.includes(brain)
    if (show && !present) {
      nv.addVolume(brain)
      nv.addVolume(overlay)
    } else if (!show && present) {
      nv.removeVolume(overlay)
      nv.removeVolume(brain)
    }
  }

  /**
   * Repaint the current map without its selection outline, and return what
   * puts the outline back: the saved colors and codes, not a recomputation.
   */
  const hideSelection = (): (() => void) => {
    if (!current || current.selection === null) return () => undefined
    const { state, map } = current
    if (state.mode === 'surface') {
      const saved = [...hemis.values()].flatMap((hemi) =>
        (['pial', 'inflated'] as const).map(
          (kind) =>
            [
              hemi.surfaces[kind].mesh,
              hemi.surfaces[kind].mesh.rgba255,
            ] as const,
        ),
      )
      recolorSurfaces(map, null)
      return () => {
        for (const [mesh, rgba] of saved) {
          mesh.rgba255 = rgba
          mesh.updateMesh(nv.gl)
        }
      }
    }
    if (!volumes) return () => undefined
    const labels = volumes.overlay.image
    const img = labels.img
    const table = lastTable
    const point = selectedPoint
    recodeOverlay(map, null, state.mode === 'cut' ? cutSlab(state.cut) : null)
    nv.updateGLVolume()
    return () => {
      labels.img = img as NonNullable<typeof img>
      labels.setColormapLabel(table as never)
      lastTable = table
      selectedPoint = point
      nv.updateGLVolume()
    }
  }

  /** Copy the drawn frame to a 2D canvas, refusing a blank one. */
  const copyFrame = (): HTMLCanvasElement => {
    const copy = document.createElement('canvas')
    copy.width = canvas.width
    copy.height = canvas.height
    const context = copy.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error(COPY_FAILED)
    context.drawImage(canvas, 0, 0)
    // A drawn frame is opaque; a lost or cleared buffer copies as
    // transparent. Sample rows rather than read the whole frame.
    const rows = Math.min(copy.height, 32)
    for (let i = 0; i < rows; i += 1) {
      const y = Math.floor(((i + 0.5) * copy.height) / rows)
      const row = context.getImageData(0, y, copy.width, 1).data
      for (let at = 3; at < row.length; at += 4) {
        if (row[at] !== 0) return copy
      }
    }
    throw new Error(COPY_FAILED)
  }

  /** The slice panes NiiVue drew last, in canvas pixels. */
  const sliceTiles = (): PixelBox[] | null => {
    if (current?.state.mode !== 'slices') return null
    const tiles = (internals.screenSlices ?? [])
      .filter((tile) => tile.axCorSag >= 0 && tile.axCorSag <= 2)
      .map(({ leftTopWidthHeight: [x, y, width, height] }) => ({
        x: Math.max(0, Math.round(x!)),
        y: Math.max(0, Math.round(y!)),
        width: Math.round(width!),
        height: Math.round(height!),
      }))
    return tiles.length > 0 ? tiles : null
  }

  const surfacePoints = (): Float32Array => {
    const meshes = visibleMeshes()
    const total = meshes.reduce((n, m) => n + m.surface.positions.length, 0)
    const points = new Float32Array(total)
    let at = 0
    for (const { surface } of meshes) {
      points.set(surface.positions, at)
      at += surface.positions.length
    }
    return points
  }

  const currentCamera = (
    state: ViewState,
  ): { azimuth: number; elevation: number } => {
    if (state.mode === 'surface') {
      return surfaceCamera(state.view, state.hemisphere)
    }
    return cutCamera(state.cut)
  }

  /** The brain's center in mm: its box's center, or the volume's. */
  const brainCenter = (): [number, number, number] => {
    const box = volumes?.box
    if (!box) {
      const mm = nv.frac2mm([0.5, 0.5, 0.5] as never, 0, true)
      return [mm[0]!, mm[1]!, mm[2]!]
    }
    return [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2]
  }

  /** Center the slice panes on a point at a zoom. */
  const panSlices = (point: readonly number[], zoom: number): void => {
    const center = nv.frac2mm([0.5, 0.5, 0.5] as never, 0, true)
    nv.scene.pan2Dxyzmm = slicePan(
      point,
      [center[0]!, center[1]!, center[2]!],
      zoom,
    ) as never
  }

  /** The zoom at which the brain's box fills a slice pane. */
  const brainZoom = (): number => {
    const box = volumes?.box
    if (!box) return 1
    const low = nv.frac2mm([0, 0, 0] as never, 0, true)
    const high = nv.frac2mm([1, 1, 1] as never, 0, true)
    const fov = Math.min(...[0, 1, 2].map((k) => Math.abs(high[k]! - low[k]!)))
    const extent = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2])
    return Math.max(1, Math.min(2, (SLICE_FILL * fov) / Math.max(1, extent)))
  }

  /** The voxels of a set of labels in a label volume, as a centroid. */
  const centroidOf = (
    source: ArrayLike<number>,
    keep: (value: number) => boolean,
  ): { voxel: [number, number, number]; count: number } | null => {
    if (!volumes) return null
    const [nx, ny] = volumes.dims
    const plane = nx * ny
    let sx = 0
    let sy = 0
    let sz = 0
    let count = 0
    for (let i = 0; i < source.length; i++) {
      const value = source[i]!
      if (value === 0 || !keep(value)) continue
      sx += i % nx
      sy += Math.floor(i / nx) % ny
      sz += Math.floor(i / plane)
      count += 1
    }
    return count > 0
      ? { voxel: [sx / count, sy / count, sz / count], count }
      : null
  }

  /**
   * The point on the pons-medulla boundary: the centroid of the pons and
   * medulla voxels within 1.5 mm of the level halfway between the pons's
   * lowest and the medulla's highest 5% (superior is the mm z axis).
   */
  const ponsMedulla = (): [number, number, number] | null => {
    if (!volumes || volumes.overlay.sourceId !== 'brainstem-ss') return null
    const source = volumes.overlay.source
    const [nx, ny] = volumes.dims
    const plane = nx * ny
    const a = volumes.affine[2]!
    const ponsZ: number[] = []
    const medullaZ: number[] = []
    for (let i = 0; i < source.length; i++) {
      const value = source[i]
      if (
        value !== BRAINSTEM_SUBFIELDS.pons &&
        value !== BRAINSTEM_SUBFIELDS.medulla
      ) {
        continue
      }
      const z =
        a[0]! * (i % nx) +
        a[1]! * (Math.floor(i / nx) % ny) +
        a[2]! * Math.floor(i / plane) +
        a[3]!
      ;(value === BRAINSTEM_SUBFIELDS.pons ? ponsZ : medullaZ).push(z)
    }
    if (ponsZ.length === 0 || medullaZ.length === 0) return null
    ponsZ.sort((x, y) => x - y)
    medullaZ.sort((x, y) => x - y)
    const level =
      (ponsZ[Math.floor(ponsZ.length * 0.05)]! +
        medullaZ[Math.floor(medullaZ.length * 0.95)]!) /
      2
    return centroidOfBand(source, level)
  }

  const centroidOfBand = (
    source: ArrayLike<number>,
    level: number,
  ): [number, number, number] | null => {
    if (!volumes) return null
    const [nx, ny] = volumes.dims
    const plane = nx * ny
    const a = volumes.affine[2]!
    let sx = 0
    let sy = 0
    let sz = 0
    let count = 0
    for (let i = 0; i < source.length; i++) {
      const value = source[i]
      if (
        value !== BRAINSTEM_SUBFIELDS.pons &&
        value !== BRAINSTEM_SUBFIELDS.medulla
      ) {
        continue
      }
      const x = i % nx
      const y = Math.floor(i / nx) % ny
      const z = Math.floor(i / plane)
      if (Math.abs(a[0]! * x + a[1]! * y + a[2]! * z + a[3]! - level) > 1.5) {
        continue
      }
      sx += x
      sy += y
      sz += z
      count += 1
    }
    return count > 0 ? voxelToMm([sx / count, sy / count, sz / count]) : null
  }

  const viewer: BrainViewer = {
    setTemplate(files) {
      for (const hemisphere of ['lh', 'rh'] as const) {
        const raw = files.surfaces[hemisphere]
        const annotation = readAnnotation(raw.annot)
        const sulc = readCurvature(raw.sulc)
        const pial = readSurface(raw.pial)
        const inflated = shiftX(readSurface(raw.inflated), hemisphere)
        if (
          [sulc.length, pial.vertexCount, inflated.vertexCount].some(
            (n) => n !== annotation.vertexEntry.length,
          )
        ) {
          throw new TypeError(
            'The fsaverage5 surfaces and annotation disagree on the vertex count.',
          )
        }
        const blank = new Uint8Array(pial.vertexCount * 4).fill(200)
        const make = (surface: Surface, kind: SurfaceKind): NVMesh => {
          const mesh = new NVMesh(
            surface.positions,
            surface.triangles,
            `${hemisphere}.${kind}`,
            blank.slice(),
            1,
            false,
            nv.gl,
          )
          if (meshShader >= 0) {
            ;(mesh as unknown as { meshShaderIndex: number }).meshShaderIndex =
              meshShader
          }
          nv.addMesh(mesh)
          return mesh
        }
        hemis.set(hemisphere, {
          sulc,
          atlases: new Map([
            ['dk', atlasOf(annotation, pial.triangles, ['none'], hemisphere)],
          ]),
          surfaces: {
            pial: { surface: pial, mesh: make(pial, 'pial') },
            inflated: { surface: inflated, mesh: make(inflated, 'inflated') },
          },
        })
      }
      lastSurfaceKey = ''
    },

    setSurfaceAtlas(atlasId, rules, annotations) {
      for (const hemisphere of ['lh', 'rh'] as const) {
        const hemi = hemis.get(hemisphere)
        if (!hemi) throw new TypeError('Load the fsaverage5 template first.')
        const annotation = annotations[hemisphere]
        const pial = hemi.surfaces.pial.surface
        if (annotation.vertexEntry.length !== pial.vertexCount) {
          throw new TypeError(
            'The atlas labels and the fsaverage5 surfaces disagree on the vertex count.',
          )
        }
      }
      for (const hemisphere of ['lh', 'rh'] as const) {
        const hemi = hemis.get(hemisphere)!
        hemi.atlases.set(
          atlasId,
          atlasOf(
            annotations[hemisphere],
            hemi.surfaces.pial.surface.triangles,
            rules,
            hemisphere,
          ),
        )
      }
      lastSurfaceKey = ''
    },

    hasSurfaceAtlas: (atlasId) =>
      hemis.get('lh')?.atlases.has(atlasId) ?? false,

    async setVolumes(files) {
      if (volumes) {
        showVolumes(false)
        volumes = null
      }
      hidden = false
      const brain = await readVolume(files.brain, 'brain.mgz')
      const labels = await readVolume(files.labels, 'aparc+aseg.mgz')
      const dims = dimsOf(labels)
      brain.colormap = 'ssBrainGray'
      brain.cal_min = 0
      brain.cal_max = 255
      const source = labels.img as unknown as ArrayLike<number>
      const aseg = { image: labels, source }
      volumes = {
        brain,
        brainImg: brain.img as unknown as ArrayLike<number>,
        aseg,
        overlay: { ...aseg, sourceId: 'aseg' },
        dims,
        affine: readAffine(labels),
        box: null,
        belowCerebrum: null,
        points: new Float32Array(0),
        belowPoints: null,
      }
      // The brain's box: the voxels brain.mgz draws (above the colormap's
      // black), which a template's blurred edge extends past its labels.
      const [nx, ny, nz] = dims
      const low = [nx, ny, nz]
      const high = [-1, -1, -1]
      const intensity = volumes.brainImg
      const sameGrid = intensity.length === source.length
      for (let i = 0; i < source.length; i++) {
        if (sameGrid ? intensity[i]! <= BRAIN_FLOOR : source[i] === 0) continue
        const v = [i % nx, Math.floor(i / nx) % ny, Math.floor(i / (nx * ny))]
        for (let k = 0; k < 3; k++) {
          low[k] = Math.min(low[k]!, v[k]!)
          high[k] = Math.max(high[k]!, v[k]!)
        }
      }
      volumes.points = samplePoints((i) =>
        sameGrid ? intensity[i]! > BRAIN_FLOOR : source[i] !== 0,
      )
      if (high[0]! >= 0) {
        const a = voxelToMm(low)
        const b = voxelToMm(high)
        volumes.box = [
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.min(a[2], b[2]),
          Math.max(a[0], b[0]),
          Math.max(a[1], b[1]),
          Math.max(a[2], b[2]),
        ]
      }
      lastOverlayKey = ''
      lastSliceKey = ''
      applied = null
    },

    hasVolumes: () => volumes !== null,

    async setLabelMap(sourceId, files) {
      if (!volumes) throw new TypeError('Load the brain volumes first.')
      const shown = nv.volumes.includes(volumes.brain)
      let next: Volumes['overlay']
      if (files === null || files.length === 0) {
        next = { ...volumes.aseg, sourceId: 'aseg' }
      } else {
        const images = await Promise.all(
          files.map((file) => readVolume(file.bytes, `${sourceId}.mgz`)),
        )
        const size = volumes.dims[0] * volumes.dims[1] * volumes.dims[2]
        for (const image of images) {
          const dims = dimsOf(image)
          if (dims[0] * dims[1] * dims[2] !== size) {
            throw new TypeError(
              "The atlas label map does not match the subject's brain volume.",
            )
          }
        }
        let source = images[0]!.img as unknown as ArrayLike<number>
        if (images.length > 1) {
          const merged = new Int32Array(size)
          images.forEach((image, index) => {
            const offset =
              files[index]!.hemisphere === 'rh' ? RIGHT_FILE_OFFSET : 0
            const img = image.img as unknown as ArrayLike<number>
            for (let i = 0; i < size; i++) {
              if (img[i]) merged[i] = img[i]! + offset
            }
          })
          source = merged
          images[0]!.img = merged as never
        }
        next = { image: images[0]!, source, sourceId }
      }
      if (shown) {
        nv.removeVolume(volumes.overlay.image)
        nv.addVolume(next.image)
      }
      volumes.overlay = next
      lastOverlayKey = ''
    },

    labelMap: () => volumes?.overlay.sourceId ?? 'aseg',

    apply(state, map, selection) {
      if (disposed || lost) return
      const previous = current
      current = { state, map, selection }
      nv.opts.backColor = [...state.background, 1]
      const closeUp = state.closeUp ?? null
      const surfaceKey = JSON.stringify([
        map.stat,
        map.limit,
        map.surfaceAtlas,
        [...map.cortex.lh.entries()],
        [...map.cortex.rh.entries()],
        selection,
      ])
      if (surfaceKey !== lastSurfaceKey) {
        recolorSurfaces(map, selection)
        lastSurfaceKey = surfaceKey
      }
      const surfaceMode = state.mode === 'surface'
      for (const [hemisphere, hemi] of hemis) {
        const shown =
          surfaceMode &&
          (state.view === 'dorsal' ||
            state.view === 'ventral' ||
            state.hemisphere === hemisphere)
        hemi.surfaces.pial.mesh.visible = shown && state.surface === 'pial'
        hemi.surfaces.inflated.mesh.visible =
          shown && state.surface === 'inflated'
      }
      showVolumes(!surfaceMode)
      hideCerebrum(
        state.mode === 'cut' && closeUp !== null && closeUp.hideCerebrum,
      )
      let recoded = false
      if (!surfaceMode && volumes) {
        const slab = state.mode === 'cut' ? cutSlab(state.cut) : null
        const overlayKey = JSON.stringify([
          map.stat,
          map.limit,
          map.volumeSource,
          volumes.overlay.sourceId,
          [...map.labels.entries()],
          selection,
          slab,
          hidden,
        ])
        if (overlayKey !== lastOverlayKey) {
          recodeOverlay(map, selection, slab)
          lastOverlayKey = overlayKey
          recoded = true
          nv.updateGLVolume()
        }
      }
      if (state.mode === 'slices') {
        fit = null
        const sliceKey = JSON.stringify([closeUp, volumes?.box ?? null])
        if (closeUp) {
          nv.setSliceType(
            closeUp.plane === 'sagittal'
              ? SLICE_TYPE.SAGITTAL
              : closeUp.plane === 'coronal'
                ? SLICE_TYPE.CORONAL
                : SLICE_TYPE.AXIAL,
          )
        } else {
          nv.setSliceType(SLICE_TYPE.MULTIPLANAR)
        }
        nv.setClipPlane([2, 0, 0])
        if (sliceKey !== lastSliceKey && volumes) {
          lastSliceKey = sliceKey
          if (closeUp) {
            panSlices(closeUp.centerMm, closeUp.zoom)
            nv.scene.crosshairPos = nv.mm2frac([
              ...closeUp.crosshairMm,
            ] as never) as never
          } else {
            // The 3D views' picking moves the crosshair, so place it anew:
            // inside the selected structure, or at the brain's center.
            panSlices(brainCenter(), brainZoom())
            const inside =
              selection && selectedPoint ? voxelToFrac(selectedPoint) : null
            nv.scene.crosshairPos = (inside ??
              nv.mm2frac(brainCenter() as never)) as never
          }
        }
        // A newly selected structure moves the slices to a voxel inside it,
        // so every pane passes through it.
        if (recoded && selectedPoint && selection !== previous?.selection) {
          const frac = voxelToFrac(selectedPoint)
          if (frac) nv.scene.crosshairPos = frac as never
        }
      } else {
        lastSliceKey = ''
        nv.setSliceType(SLICE_TYPE.RENDER)
        const camera = currentCamera(state)
        const fitKey = JSON.stringify([
          state.mode,
          camera,
          state.mode === 'surface'
            ? [state.surface, state.view, state.hemisphere]
            : null,
          state.mode === 'cut' ? (closeUp?.centerMm ?? null) : null,
          volumes?.box ?? null,
        ])
        if (state.mode === 'cut' && closeUp?.hideCerebrum && volumes) {
          if (!volumes.belowPoints) {
            const keep = belowCerebrum()!
            volumes.belowPoints = samplePoints((i) => keep[i] === 1)
          }
          const points = volumes.belowPoints
          fit = { key: fitKey, points: () => points }
        } else if (state.mode === 'cut' && closeUp) {
          const center = closeUp.centerMm
          // The structure's surroundings, a 60 mm box, framed at its zoom.
          const span = 120 / closeUp.zoom
          const points: number[] = []
          for (const dx of [-span, span]) {
            for (const dy of [-span, span]) {
              for (const dz of [-span, span]) {
                points.push(center[0] + dx, center[1] + dy, center[2] + dz)
              }
            }
          }
          fit = { key: fitKey, points: () => points }
        } else if (state.mode === 'cut' && volumes) {
          const points = volumes.points
          fit = { key: fitKey, points: () => points }
        } else if (state.mode === 'surface') {
          fit = { key: fitKey, points: surfacePoints }
        } else {
          fit = null
        }
        const cameraKey = JSON.stringify([state.mode, camera])
        if (cameraKey !== lastCamera) {
          nv.setRenderAzimuthElevation(camera.azimuth, camera.elevation)
          lastCamera = cameraKey
        }
        nv.setClipPlane(
          state.mode === 'cut' ? cutClipPlane(state.cut) : [2, 0, 0],
        )
      }
      nv.drawScene()
    },

    rotate(azimuth, elevation) {
      if (disposed || lost) return
      nv.setRenderAzimuthElevation(
        nv.scene.renderAzimuth + azimuth,
        Math.max(-90, Math.min(90, nv.scene.renderElevation + elevation)),
      )
    },

    moveCrosshair(dx, dy, dz) {
      if (disposed || lost) return
      nv.moveCrosshairInVox(dx, dy, dz)
      nv.drawScene()
      if (!current || current.state.mode !== 'slices') return
      const mm = nv.frac2mm(nv.scene.crosshairPos as never, 0, true)
      callbacks.onPick(pickVolume([mm[0]!, mm[1]!, mm[2]!]))
    },

    setCrosshairMm(mm) {
      if (disposed || lost || !volumes) return
      nv.scene.crosshairPos = nv.mm2frac([...mm] as never) as never
      nv.drawScene()
    },

    closeUp(preset, hemisphere) {
      if (!volumes) return null
      const overlay = volumes.overlay
      const aseg = volumes.aseg.source
      const offset = hemisphere === 'rh' ? RIGHT_FILE_OFFSET : 0
      let found: { voxel: [number, number, number] } | null
      if (preset === 'brainstem') {
        const subfields = new Set<number>(Object.values(BRAINSTEM_SUBFIELDS))
        found =
          (overlay.sourceId === 'brainstem-ss'
            ? centroidOf(overlay.source, (v) => subfields.has(v))
            : null) ?? centroidOf(aseg, (v) => v === BRAINSTEM_LABEL)
      } else if (preset === 'thalamus') {
        found =
          (overlay.sourceId === 'thalamic'
            ? centroidOf(overlay.source, isThalamicNucleus)
            : null) ?? centroidOf(aseg, (v) => v === 10 || v === 49)
      } else {
        const left = hemisphere === 'lh'
        found =
          (overlay.sourceId === 'hippo-amygdala'
            ? centroidOf(overlay.source, (v) => {
                const raw = v - offset
                return (
                  raw > 0 &&
                  raw < RIGHT_FILE_OFFSET &&
                  (isHippocampalSubfield(raw) || isAmygdalaNucleus(raw))
                )
              })
            : null) ??
          centroidOf(aseg, (v) =>
            left ? v === 17 || v === 18 : v === 53 || v === 54,
          )
      }
      if (!found) return null
      const centerMm = voxelToMm(found.voxel)
      const crosshairMm =
        preset === 'brainstem' ? (ponsMedulla() ?? centerMm) : centerMm
      return {
        preset,
        hemisphere: preset === 'hippocampus' ? hemisphere : null,
        centerMm,
        crosshairMm: [centerMm[0], crosshairMm[1], crosshairMm[2]],
        plane: preset === 'thalamus' ? 'coronal' : 'sagittal',
        zoom: preset === 'thalamus' ? 2 : 2.5,
        hideCerebrum: preset === 'brainstem',
      }
    },

    cutThrough(cut, mm) {
      const frac = volumes
        ? (nv.mm2frac([...mm] as never) as Float32Array)
        : null
      if (!frac) return cut
      const [, azimuth, elevation] = cutClipPlane(cut)
      const n = clipNormal(azimuth, elevation)
      // The cut face lies where dot(n, f - 0.5) equals depthMm / CLIP_FOV_MM.
      const offset =
        n[0]! * (frac[0]! - 0.5) +
        n[1]! * (frac[1]! - 0.5) +
        n[2]! * (frac[2]! - 0.5)
      const depthMm = Math.round(offset * CLIP_FOV_MM)
      return { ...cut, depthMm: Math.max(-80, Math.min(80, depthMm)) }
    },

    renderFrames(background, draw) {
      if (disposed || lost) throw new Error('The brain view is not drawing.')
      const gl = nv.gl
      const limit = Math.min(
        MAX_EXPORT_PIXELS,
        ...(gl
          ? [
              (gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array)[0]!,
              gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
            ]
          : []),
      )
      const ratio = nv.opts.forceDevicePixelRatio
      const host = canvas.parentElement
      const hostStyle = host?.getAttribute('style') ?? null
      const crosshair = nv.opts.crosshairWidth
      const letters = nv.opts.isOrientationTextVisible
      let resized = false
      let showSelection: () => void = () => undefined
      // The drawing buffer is not preserved, so draw and copy in the same
      // task; the screen view returns before the frame is presented. The
      // selection outline, crosshair, and orientation letters are screen
      // aids, so the figure leaves them out.
      try {
        nv.opts.backColor = [...background, 1]
        nv.opts.crosshairWidth = 0
        nv.opts.isOrientationTextVisible = false
        showSelection = hideSelection()
        return draw(({ scale, aspect = null }) => {
          if (aspect !== null && host && aspect > 0) {
            // Shape the canvas like the content, so its pixels go to the
            // brain rather than to empty margins.
            const height = Math.max(1, host.clientHeight)
            host.style.right = 'auto'
            host.style.bottom = 'auto'
            host.style.height = `${height}px`
            host.style.width = `${Math.round(height * aspect)}px`
            resized = true
          }
          const screen = {
            width:
              aspect !== null && host ? host.clientWidth * ratio : canvas.width,
            height:
              aspect !== null && host
                ? host.clientHeight * ratio
                : canvas.height,
          }
          const longest = Math.max(screen.width, screen.height, 1)
          const area = Math.max(1, screen.width * screen.height)
          const wanted = Math.max(
            1,
            Math.min(scale, limit / longest, Math.sqrt(MAX_EXPORT_AREA / area)),
          )
          nv.opts.forceDevicePixelRatio = ratio * wanted
          if (wanted > 1 || resized) {
            nv.resizeListener()
            resized = true
          } else {
            nv.drawScene()
          }
          // A browser may give a smaller drawing buffer than asked for;
          // then draw at the screen resolution instead.
          if (
            wanted > 1 &&
            gl &&
            (gl.drawingBufferWidth !== canvas.width ||
              gl.drawingBufferHeight !== canvas.height)
          ) {
            nv.opts.forceDevicePixelRatio = ratio
            nv.resizeListener()
          }
          return { canvas: copyFrame(), tiles: sliceTiles() }
        })
      } finally {
        nv.opts.forceDevicePixelRatio = ratio
        nv.opts.crosshairWidth = crosshair
        nv.opts.isOrientationTextVisible = letters
        if (host && hostStyle !== null) host.setAttribute('style', hostStyle)
        else host?.removeAttribute('style')
        if (current) nv.opts.backColor = [...current.state.background, 1]
        showSelection()
        if (resized) nv.resizeListener()
        else nv.drawScene()
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      nv.onLocationChange = () => undefined
      nv.cleanup()
      hemis.clear()
      volumes = null
      current = null
      // Release the context now rather than when the canvas is collected;
      // Chromium caps live WebGL contexts per renderer.
      if (!lost) nv.gl?.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
  return viewer
}
