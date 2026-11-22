/**
 * Maps an analysis result onto the brain viewer's atlases: which DK parcels
 * and aseg structures carry which row, the symmetric color limit, per-vertex
 * surface colors, and the recoded `aparc+aseg` overlay with its color table.
 *
 * The figure palette is ColorBrewer RdBu (9 classes), a colorblind-safe
 * diverging scale: blue is a negative statistic (smaller in the focal group,
 * or a negative association) and red a positive one. Non-significant parcels
 * are drawn muted toward the cortex gray; significant ones keep full color
 * and get a dark outline. The selected measure gets an Okabe-Ito bluish-green
 * outline. These colors belong to the figure, not the chrome, so they do not
 * follow the theme.
 */

import { measureLabel } from '../../../../shared/brain-atlas'
import {
  PARC_METRICS,
  parseMeasureId,
  type ParcMetric,
} from '../../../../shared/group-analysis'
import {
  atlasName,
  isWholeStructure,
  measureVolumeSource,
  measureVolumeValues,
  surfaceAtlasFiles,
  type VolumeSourceId,
} from './atlas-display'
import type { ColorLut } from './color-lut'
import type { Annotation } from './freesurfer'

/** The statistic a map colors by. */
export type BrainStat = 'd' | 't'

/**
 * The part of a result row a map needs; v1 rows and v2 term rows (whose
 * `t` is null for an F term) both fit.
 */
export interface BrainRow {
  measureId: string
  d: number | null
  t: number | null
  significant: boolean
}

/** An RGB triple, 0-255. */
export type Rgb = readonly [number, number, number]

/** ColorBrewer RdBu, 9 classes, from most negative to most positive. */
export const DIVERGING_STOPS: readonly Rgb[] = [
  [33, 102, 172],
  [67, 147, 195],
  [146, 197, 222],
  [209, 229, 240],
  [247, 247, 247],
  [253, 219, 199],
  [244, 165, 130],
  [214, 96, 77],
  [178, 24, 43],
]

/** The unmapped cortex gray, before sulcal shading. */
export const CORTEX_GRAY = 196
/** The outline of a significant parcel. */
export const SIGNIFICANT_OUTLINE: Rgb = [28, 28, 30]
/** The outline of the selected measure (Okabe-Ito bluish green). */
export const SELECTED_OUTLINE: Rgb = [0, 158, 115]
/**
 * How far a non-significant color moves toward the cortex gray: enough to
 * set it back from the outlined significant parcels, not so far that its
 * sign and size are lost.
 */
export const MUTED_MIX = 0.3
/** The sulcal shading of an unmapped (gray) vertex, as a share. */
const GRAY_SHADE = 0.16
/** The sulcal shading under a statistic color: subtle, so the color reads. */
const COLOR_SHADE = 0.06

/** One row placed on the map. */
export interface MappedValue {
  measureId: string
  value: number
  significant: boolean
}

/**
 * A set of cortical rows that can be drawn on the cortex at once: one
 * atlas, one metric, per hemisphere or bilateral means.
 */
export interface CorticalLayer {
  /**
   * `<metric>:<hemi|bi>` for DK, `<atlas>:<metric>:<hemi|bi>` for a
   * `parc` atlas.
   */
  key: string
  /** `dk`, or the `parc` atlas. */
  atlas: string
  metric: ParcMetric
  bilateral: boolean
  label: string
  count: number
}

/** Everything the viewer draws for one result, statistic, and layer. */
export interface BrainMap {
  stat: BrainStat
  /** The symmetric color limit: values map from -limit to +limit. */
  limit: number
  /** The surface atlas of the cortical layer, or null without one. */
  surfaceAtlas: string | null
  /** Region to value, per hemisphere, in the layer's atlas. */
  cortex: { lh: Map<string, MappedValue>; rh: Map<string, MappedValue> }
  /** The label map of the cut and slice views. */
  volumeSource: VolumeSourceId
  /** Label value to value, in that label map. */
  labels: Map<number, MappedValue>
}

/** The label map a map draws on and the color table naming its labels. */
export interface VolumeLabels {
  sourceId: VolumeSourceId
  lut: ColorLut | null
}

const METRIC_NAMES: Readonly<Record<ParcMetric, string>> = {
  ThickAvg: 'Thickness',
  ThickStd: 'Thickness SD',
  SurfArea: 'Area',
  GrayVol: 'Gray-matter volume',
  NumVert: 'Vertex count',
  MeanCurv: 'Mean curvature',
  GausCurv: 'Gaussian curvature',
  FoldInd: 'Folding index',
  CurvInd: 'Curvature index',
  GWC: 'Gray-to-white contrast',
}

function layerKeyOf(
  atlas: string,
  metric: ParcMetric,
  bilateral: boolean,
): string {
  const tail = `${metric}:${bilateral ? 'bi' : 'hemi'}`
  return atlas === 'dk' ? tail : `${atlas}:${tail}`
}

/** The cortical layer parts of a measure, or null outside the cortex. */
function cortexOf(measureId: string): {
  atlas: string
  metric: ParcMetric
  hemisphere: 'lh' | 'rh' | 'bi'
  region: string
} | null {
  const parsed = parseMeasureId(measureId)
  if (parsed?.source === 'dk') return { ...parsed, atlas: 'dk' }
  if (parsed?.source === 'parc' && surfaceAtlasFiles(parsed.atlas)) {
    return parsed
  }
  return null
}

/**
 * Give the atlas of a cortical layer key.
 *
 * @returns `dk` or the `parc` atlas.
 */
export function layerAtlas(key: string): string {
  const parts = key.split(':')
  return parts.length === 3 ? parts[0]! : 'dk'
}

/**
 * Give a row's statistic, or null when the row has none.
 *
 * @returns A finite value or null.
 */
export function statValue(row: BrainRow, stat: BrainStat): number | null {
  const value = stat === 'd' ? row.d : row.t
  return value !== null && Number.isFinite(value) ? value : null
}

/**
 * List the cortical layers a result's DK rows form, most rows first.
 *
 * @returns One layer per metric and hemisphere mode.
 */
export function corticalLayers(
  rows: readonly BrainRow[],
  added: ReadonlyMap<string, string> = new Map(),
): CorticalLayer[] {
  const counts = new Map<string, CorticalLayer>()
  for (const row of rows) {
    const parsed = cortexOf(row.measureId)
    if (!parsed) continue
    const bilateral = parsed.hemisphere === 'bi'
    const key = layerKeyOf(parsed.atlas, parsed.metric, bilateral)
    const what = `${METRIC_NAMES[parsed.metric]}, ${bilateral ? 'bilateral mean' : 'per hemisphere'}`
    const layer = counts.get(key) ?? {
      key,
      atlas: parsed.atlas,
      metric: parsed.metric,
      bilateral,
      label:
        parsed.atlas === 'dk'
          ? what
          : `${atlasName(parsed.atlas, added)}: ${what.charAt(0).toLowerCase()}${what.slice(1)}`,
      count: 0,
    }
    layer.count += 1
    counts.set(key, layer)
  }
  // DK first, then each atlas by its row count.
  return [...counts.values()].sort(
    (a, b) =>
      Number(b.atlas === 'dk') - Number(a.atlas === 'dk') ||
      b.count - a.count ||
      a.atlas.localeCompare(b.atlas) ||
      PARC_METRICS.indexOf(a.metric) - PARC_METRICS.indexOf(b.metric) ||
      Number(a.bilateral) - Number(b.bilateral),
  )
}

/**
 * Give the layer a measure belongs to.
 *
 * @returns The layer key, or null for a measure outside the cortex.
 */
export function layerKeyForMeasure(measureId: string | null): string | null {
  const parsed = measureId ? cortexOf(measureId) : null
  return parsed
    ? layerKeyOf(parsed.atlas, parsed.metric, parsed.hemisphere === 'bi')
    : null
}

/**
 * Say whether a measure has a place on a brain map: a cortical region of a
 * drawable surface atlas, or a structure of a drawable label map.
 */
export function isDrawableMeasure(measureId: string): boolean {
  return cortexOf(measureId) !== null || measureVolumeSource(measureId) !== null
}

/**
 * List the measures that have no place on a brain map (global measures,
 * Brain-PAD, and tables without a label map), in row order.
 *
 * @returns Their display labels.
 */
export function unmappedMeasures(rows: readonly BrainRow[]): string[] {
  return rows
    .filter((row) => !isDrawableMeasure(row.measureId))
    .map((row) => measureLabel(row.measureId))
}

/** List the label maps a result's measures are drawn on, `aseg` first. */
export function volumeSources(rows: readonly BrainRow[]): VolumeSourceId[] {
  const found = new Set<VolumeSourceId>(['aseg'])
  for (const row of rows) {
    const source = measureVolumeSource(row.measureId)
    if (source) found.add(source)
  }
  return [...found]
}

/**
 * Round a color limit up to a readable value: 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8
 * times a power of ten.
 *
 * @param floor - The smallest limit to return.
 */
export function niceLimit(value: number, floor: number): number {
  const target = Math.max(Math.abs(value), floor)
  if (!Number.isFinite(target) || target <= 0) return floor
  const power = 10 ** Math.floor(Math.log10(target))
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (step * power >= target - 1e-12) return step * power
  }
  return 10 * power
}

/**
 * Place a result's rows on the atlases for one statistic, cortical layer,
 * and label map.
 *
 * In the label map, a structure prefers the selected row, then a single
 * row over a bilateral mean, then either over a whole-structure union
 * (`Whole_...`). The limit spans every placed value, with a floor of 0.5
 * for d and 2 for t so that a null result does not look saturated.
 *
 * @param layerKey - The cortical layer, or null for none.
 * @param volume - The label map and its color table; `aseg` when omitted.
 */
export function buildBrainMap(
  result: { rows: readonly BrainRow[] },
  stat: BrainStat,
  layerKey: string | null,
  selection: string | null,
  volume: VolumeLabels = { sourceId: 'aseg', lut: null },
): BrainMap {
  const cortex = {
    lh: new Map<string, MappedValue>(),
    rh: new Map<string, MappedValue>(),
  }
  const labels = new Map<number, MappedValue>()
  const labelRank = new Map<number, number>()
  let largest = 0
  for (const row of result.rows) {
    const value = statValue(row, stat)
    if (value === null) continue
    const mapped: MappedValue = {
      measureId: row.measureId,
      value,
      significant: row.significant,
    }
    const cortical = cortexOf(row.measureId)
    if (cortical) {
      const key = layerKeyOf(
        cortical.atlas,
        cortical.metric,
        cortical.hemisphere === 'bi',
      )
      if (key !== layerKey) continue
      const sides =
        cortical.hemisphere === 'bi'
          ? (['lh', 'rh'] as const)
          : [cortical.hemisphere]
      for (const side of sides) cortex[side].set(cortical.region, mapped)
      largest = Math.max(largest, Math.abs(value))
    }
    const parsed = parseMeasureId(row.measureId)
    const whole = parsed?.source === 'vol' && isWholeStructure(parsed.structure)
    const bilateral =
      (parsed?.source === 'aseg' || parsed?.source === 'vol') &&
      parsed.hemisphere === 'bi'
    const rank = row.measureId === selection ? 0 : whole ? 3 : bilateral ? 2 : 1
    let placed = false
    for (const index of measureVolumeValues(
      volume.sourceId,
      row.measureId,
      volume.lut,
    )) {
      if ((labelRank.get(index) ?? Infinity) > rank) {
        labelRank.set(index, rank)
        labels.set(index, mapped)
        placed = true
      }
    }
    if (placed) largest = Math.max(largest, Math.abs(value))
  }
  return {
    stat,
    limit: niceLimit(largest, stat === 'd' ? 0.5 : 2),
    surfaceAtlas: layerKey ? layerAtlas(layerKey) : null,
    cortex,
    volumeSource: volume.sourceId,
    labels,
  }
}

/** Format a statistic with a true minus sign. */
export function formatStat(value: number, digits = 2): string {
  const text = Math.abs(value).toFixed(digits)
  return value < 0 && Number(text) !== 0 ? `\u2212${text}` : text
}

/**
 * Give the diverging color of a value.
 *
 * @returns The RGB color, clamped at the limit.
 */
export function divergingColor(value: number, limit: number): Rgb {
  const unit = limit > 0 ? Math.max(-1, Math.min(1, value / limit)) : 0
  const position = ((unit + 1) / 2) * (DIVERGING_STOPS.length - 1)
  const low = Math.floor(position)
  const high = Math.min(low + 1, DIVERGING_STOPS.length - 1)
  const fraction = position - low
  const a = DIVERGING_STOPS[low]!
  const b = DIVERGING_STOPS[high]!
  return [
    Math.round(a[0] + (b[0] - a[0]) * fraction),
    Math.round(a[1] + (b[1] - a[1]) * fraction),
    Math.round(a[2] + (b[2] - a[2]) * fraction),
  ]
}

/**
 * Give the color a mapped value is drawn in: full for a significant row,
 * muted toward the cortex gray otherwise.
 */
export function parcelColor(mapped: MappedValue, limit: number): Rgb {
  const color = divergingColor(mapped.value, limit)
  if (mapped.significant) return color
  return [
    Math.round(color[0] + (CORTEX_GRAY - color[0]) * MUTED_MIX),
    Math.round(color[1] + (CORTEX_GRAY - color[1]) * MUTED_MIX),
    Math.round(color[2] + (CORTEX_GRAY - color[2]) * MUTED_MIX),
  ]
}

/**
 * Mark the vertices that touch another parcel, once per annotation.
 *
 * @returns 1 for a border vertex, 0 otherwise.
 */
export function parcelBorders(
  annotation: Annotation,
  triangles: Uint32Array,
): Uint8Array {
  const entry = annotation.vertexEntry
  const border = new Uint8Array(entry.length)
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const a = triangles[i]!
    const b = triangles[i + 1]!
    const c = triangles[i + 2]!
    if (entry[a] !== entry[b] || entry[b] !== entry[c]) {
      border[a] = 1
      border[b] = 1
      border[c] = 1
    }
  }
  return border
}

/** What coloring one hemisphere's surface needs. */
export interface SurfaceColorInput {
  annotation: Annotation
  /**
   * The region of each annotation entry (null for a non-region); the entry
   * names when omitted.
   */
  regions?: readonly (string | null)[]
  /** Sulcal depth per vertex, for shading; positive is deep. */
  sulc: Float32Array
  border: Uint8Array
  values: Map<string, MappedValue>
  limit: number
  selection: string | null
}

/**
 * Color one hemisphere: sulc-shaded gray, parcels by value over a subtler
 * shading, and outlines of significant and selected parcels.
 *
 * @returns RGBA per vertex.
 */
export function surfaceColors(input: SurfaceColorInput): Uint8Array {
  const { annotation, sulc, border, values, limit, selection } = input
  const count = annotation.vertexEntry.length
  const rgba = new Uint8Array(count * 4)
  const byEntry = annotation.entries.map((entry, index) => {
    const region = input.regions ? input.regions[index] : entry.name
    return region ? values.get(region) : undefined
  })
  const colors = byEntry.map((mapped) =>
    mapped ? parcelColor(mapped, limit) : null,
  )
  for (let v = 0; v < count; v++) {
    const entry = annotation.vertexEntry[v]!
    const mapped = entry >= 0 ? byEntry[entry] : undefined
    const depth = Math.max(-1, Math.min(1, (sulc[v] ?? 0) / 8))
    const shade = 1 - (mapped ? COLOR_SHADE : GRAY_SHADE) * depth
    let color: Rgb
    if (mapped && border[v] && mapped.measureId === selection) {
      color = SELECTED_OUTLINE
    } else if (mapped && border[v] && mapped.significant) {
      color = SIGNIFICANT_OUTLINE
    } else {
      const base = (entry >= 0 ? colors[entry] : null) ?? [
        CORTEX_GRAY,
        CORTEX_GRAY,
        CORTEX_GRAY,
      ]
      color = [base[0] * shade, base[1] * shade, base[2] * shade]
    }
    rgba[v * 4] = Math.round(Math.min(255, color[0]))
    rgba[v * 4 + 1] = Math.round(Math.min(255, color[1]))
    rgba[v * 4 + 2] = Math.round(Math.min(255, color[2]))
    rgba[v * 4 + 3] = 255
  }
  return rgba
}

/** A label color table in NiiVue's `ColorMap` layout. */
export interface LabelColorTable {
  R: number[]
  G: number[]
  B: number[]
  A: number[]
  I: number[]
}

/**
 * A slab in voxel space: the voxels where `v0 + vi*i + vj*j + vk*k` lies
 * within [0, thickness]. The cut view keeps only the overlay on its cut face,
 * so labels behind the face do not show through the brain.
 */
export interface VoxelSlab {
  v0: number
  vi: number
  vj: number
  vk: number
  thickness: number
}

/** The recoded label map. */
export interface LabelOverlay {
  /** One code per voxel: 0 clear, then one per mapped label, then outlines. */
  codes: Uint16Array
  table: LabelColorTable
  /** The raw-voxel centroid of the selected measure's labels, if drawn. */
  selectedCentroid: [number, number, number] | null
  /**
   * The selected measure's voxel nearest that centroid: a point inside
   * the structure, which a curved cortical region's centroid may not be.
   */
  selectedPoint: [number, number, number] | null
}

/**
 * Recode `aparc+aseg` for the slice and cut views: each mapped label gets
 * its color (significant opaque, others muted and, on slices, translucent),
 * and the clear voxels that touch a significant or selected label become its
 * outline.
 *
 * @param labels - The label volume in file order.
 * @param slab - Keep only the voxels of this slab (the cut face).
 * @param mask - Keep only the voxels this mask marks (1), or all.
 */
export function labelOverlay(
  labels: ArrayLike<number>,
  dims: readonly [number, number, number],
  map: Pick<BrainMap, 'labels' | 'limit'>,
  selection: string | null,
  slab: VoxelSlab | null = null,
  mask: Uint8Array | null = null,
): LabelOverlay {
  const [nx, ny, nz] = dims
  const total = nx * ny * nz
  if (labels.length < total) {
    throw new TypeError('The label volume is smaller than its dimensions.')
  }
  const indices = [...map.labels.keys()].sort((a, b) => a - b)
  const codeOf = new Map(indices.map((index, i) => [index, i + 1]))
  const significantOutline = indices.length + 1
  const selectedOutline = indices.length + 2
  const table: LabelColorTable = { R: [0], G: [0], B: [0], A: [0], I: [0] }
  for (const [i, index] of indices.entries()) {
    const mapped = map.labels.get(index)!
    const color = parcelColor(mapped, map.limit)
    table.R.push(color[0])
    table.G.push(color[1])
    table.B.push(color[2])
    table.A.push(mapped.significant || slab ? 255 : 150)
    table.I.push(i + 1)
  }
  for (const [code, color] of [
    [significantOutline, SIGNIFICANT_OUTLINE],
    [selectedOutline, SELECTED_OUTLINE],
  ] as const) {
    table.R.push(color[0])
    table.G.push(color[1])
    table.B.push(color[2])
    table.A.push(255)
    table.I.push(code)
  }
  const outlineCode = new Uint16Array(indices.length + 1)
  for (const [index, code] of codeOf) {
    const mapped = map.labels.get(index)!
    outlineCode[code] =
      mapped.measureId === selection
        ? selectedOutline
        : mapped.significant
          ? significantOutline
          : 0
  }
  const codes = new Uint16Array(total)
  const inSlab = slab
    ? (x: number, y: number, z: number): boolean => {
        const v = slab.v0 + slab.vi * x + slab.vj * y + slab.vk * z
        return v >= 0 && v <= slab.thickness
      }
    : null
  let sumX = 0
  let sumY = 0
  let sumZ = 0
  let selectedCount = 0
  const slab2 = nx * ny
  for (let i = 0; i < total; i++) {
    const code = codeOf.get(labels[i]!)
    if (code === undefined || (mask && !mask[i])) continue
    const x = i % nx
    const y = Math.floor(i / nx) % ny
    const z = Math.floor(i / slab2)
    if (inSlab && !inSlab(x, y, z)) continue
    codes[i] = code
    if (outlineCode[code] === selectedOutline) {
      sumX += x
      sumY += y
      sumZ += z
      selectedCount += 1
    }
  }
  const steps: readonly [number, number, number, number][] = [
    [-1, -1, 0, 0],
    [1, 1, 0, 0],
    [-nx, 0, -1, 0],
    [nx, 0, 1, 0],
    [-slab2, 0, 0, -1],
    [slab2, 0, 0, 1],
  ]
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      const row = nx * (y + ny * z)
      for (let x = 1; x < nx - 1; x++) {
        const i = row + x
        const code = codes[i]!
        if (code === 0 || code > indices.length) continue
        const outline = outlineCode[code]!
        if (!outline) continue
        for (const [offset, dx, dy, dz] of steps) {
          const j = i + offset
          const neighbor = codes[j]!
          if (
            (neighbor === 0 ||
              (neighbor === significantOutline &&
                outline === selectedOutline)) &&
            (!inSlab || inSlab(x + dx, y + dy, z + dz))
          ) {
            codes[j] = outline
          }
        }
      }
    }
  }
  const selectedCentroid: [number, number, number] | null =
    selectedCount > 0
      ? [sumX / selectedCount, sumY / selectedCount, sumZ / selectedCount]
      : null
  let selectedPoint: [number, number, number] | null = null
  if (selectedCentroid) {
    let best = Infinity
    for (let i = 0; i < total; i++) {
      const code = codes[i]!
      if (code === 0 || code > indices.length) continue
      if (outlineCode[code] !== selectedOutline) continue
      const x = i % nx
      const y = Math.floor(i / nx) % ny
      const z = Math.floor(i / slab2)
      const d =
        (x - selectedCentroid[0]) ** 2 +
        (y - selectedCentroid[1]) ** 2 +
        (z - selectedCentroid[2]) ** 2
      if (d < best) {
        best = d
        selectedPoint = [x, y, z]
      }
    }
  }
  return { codes, table, selectedCentroid, selectedPoint }
}

/** The `aparc+aseg` label of the brainstem. */
export const BRAINSTEM_LABEL = 16

/**
 * Find the centroid of one label in a label volume.
 *
 * @param labels - The label volume in file order.
 * @returns The voxel centroid, or null when the label is absent.
 */
export function labelCentroid(
  labels: ArrayLike<number>,
  dims: readonly [number, number, number],
  label: number,
): [number, number, number] | null {
  const [nx, ny, nz] = dims
  const plane = nx * ny
  const total = Math.min(labels.length, plane * nz)
  let sumX = 0
  let sumY = 0
  let sumZ = 0
  let count = 0
  for (let i = 0; i < total; i++) {
    if (labels[i] !== label) continue
    sumX += i % nx
    sumY += Math.floor(i / nx) % ny
    sumZ += Math.floor(i / plane)
    count += 1
  }
  return count > 0 ? [sumX / count, sumY / count, sumZ / count] : null
}

/**
 * Give the measure drawn at a DK parcel of one hemisphere.
 *
 * @returns The measure ID, or null when nothing is drawn there.
 */
export function measureAtParcel(
  map: Pick<BrainMap, 'cortex'>,
  hemisphere: 'lh' | 'rh',
  region: string,
): string | null {
  return map.cortex[hemisphere].get(region)?.measureId ?? null
}

/**
 * Give the measure drawn at an `aparc+aseg` label.
 *
 * @returns The measure ID, or null when nothing is drawn there.
 */
export function measureAtLabel(
  map: Pick<BrainMap, 'labels'>,
  label: number,
): string | null {
  return map.labels.get(label)?.measureId ?? null
}
