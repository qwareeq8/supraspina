/**
 * Atlas tables for the Analysis panel: Desikan-Killiany (DK) regions and aseg
 * structures with their FreeSurfer `aparc+aseg` label indices, display labels
 * and units for measure IDs, and the brain-viewer asset contract.
 *
 * The indices follow FreeSurfer's `FreeSurferColorLUT.txt` (checked against
 * FreeSurfer 8.2.0): left DK regions are 1000 + k and right ones 2000 + k.
 * `corpuscallosum` (k = 4) is a LUT entry without an `aparc.stats` row, so it
 * is not an analyzable region.
 */

import { BUILT_IN_ATLASES } from './atlas-labeling'
import {
  parseMeasureId,
  type DkMetric,
  type GlobalMeasure,
  type MeasureHemisphere,
} from './group-analysis'

/**
 * Name an atlas in a measure label by its display name without the file or
 * ID note that some names carry, such as "Destrieux" for `a2009s`. An atlas
 * the table does not know keeps its ID.
 */
function atlasDisplayName(atlasId: string): string {
  const label = BUILT_IN_ATLASES.find((a) => a.atlasId === atlasId)?.label
  return label ? label.replace(/\s*\([^)]*\)$/, '') : atlasId
}

/** One analyzable DK region: its `aparc` name, display label, and LUT offset. */
export interface DkRegion {
  name: string
  label: string
  /** The LUT offset k: left is 1000 + k, right is 2000 + k. */
  index: number
}

/** The 34 DK regions `aparc.stats` reports, in LUT order. */
export const DK_REGIONS: readonly DkRegion[] = [
  { name: 'bankssts', label: 'Banks of the STS', index: 1 },
  {
    name: 'caudalanteriorcingulate',
    label: 'Caudal anterior cingulate',
    index: 2,
  },
  { name: 'caudalmiddlefrontal', label: 'Caudal middle frontal', index: 3 },
  { name: 'cuneus', label: 'Cuneus', index: 5 },
  { name: 'entorhinal', label: 'Entorhinal', index: 6 },
  { name: 'fusiform', label: 'Fusiform', index: 7 },
  { name: 'inferiorparietal', label: 'Inferior parietal', index: 8 },
  { name: 'inferiortemporal', label: 'Inferior temporal', index: 9 },
  { name: 'isthmuscingulate', label: 'Isthmus cingulate', index: 10 },
  { name: 'lateraloccipital', label: 'Lateral occipital', index: 11 },
  { name: 'lateralorbitofrontal', label: 'Lateral orbitofrontal', index: 12 },
  { name: 'lingual', label: 'Lingual', index: 13 },
  { name: 'medialorbitofrontal', label: 'Medial orbitofrontal', index: 14 },
  { name: 'middletemporal', label: 'Middle temporal', index: 15 },
  { name: 'parahippocampal', label: 'Parahippocampal', index: 16 },
  { name: 'paracentral', label: 'Paracentral', index: 17 },
  { name: 'parsopercularis', label: 'Pars opercularis', index: 18 },
  { name: 'parsorbitalis', label: 'Pars orbitalis', index: 19 },
  { name: 'parstriangularis', label: 'Pars triangularis', index: 20 },
  { name: 'pericalcarine', label: 'Pericalcarine', index: 21 },
  { name: 'postcentral', label: 'Postcentral', index: 22 },
  { name: 'posteriorcingulate', label: 'Posterior cingulate', index: 23 },
  { name: 'precentral', label: 'Precentral', index: 24 },
  { name: 'precuneus', label: 'Precuneus', index: 25 },
  {
    name: 'rostralanteriorcingulate',
    label: 'Rostral anterior cingulate',
    index: 26,
  },
  { name: 'rostralmiddlefrontal', label: 'Rostral middle frontal', index: 27 },
  { name: 'superiorfrontal', label: 'Superior frontal', index: 28 },
  { name: 'superiorparietal', label: 'Superior parietal', index: 29 },
  { name: 'superiortemporal', label: 'Superior temporal', index: 30 },
  { name: 'supramarginal', label: 'Supramarginal', index: 31 },
  { name: 'frontalpole', label: 'Frontal pole', index: 32 },
  { name: 'temporalpole', label: 'Temporal pole', index: 33 },
  { name: 'transversetemporal', label: 'Transverse temporal', index: 34 },
  { name: 'insula', label: 'Insula', index: 35 },
]

/** One aseg structure: its `aseg.stats` name, display label, and LUT index. */
export interface AsegStructure {
  name: string
  label: string
  index: number
}

/** The aseg structures `dk_all_stats.csv` carries, in LUT order. */
export const ASEG_STRUCTURES: readonly AsegStructure[] = [
  { name: 'Left-Lateral-Ventricle', label: 'Left lateral ventricle', index: 4 },
  {
    name: 'Left-Inf-Lat-Vent',
    label: 'Left inferior lateral ventricle',
    index: 5,
  },
  {
    name: 'Left-Cerebellum-White-Matter',
    label: 'Left cerebellar white matter',
    index: 7,
  },
  {
    name: 'Left-Cerebellum-Cortex',
    label: 'Left cerebellar cortex',
    index: 8,
  },
  { name: 'Left-Thalamus', label: 'Left thalamus', index: 10 },
  { name: 'Left-Caudate', label: 'Left caudate', index: 11 },
  { name: 'Left-Putamen', label: 'Left putamen', index: 12 },
  { name: 'Left-Pallidum', label: 'Left pallidum', index: 13 },
  { name: '3rd-Ventricle', label: 'Third ventricle', index: 14 },
  { name: '4th-Ventricle', label: 'Fourth ventricle', index: 15 },
  { name: 'Brain-Stem', label: 'Brainstem', index: 16 },
  { name: 'Left-Hippocampus', label: 'Left hippocampus', index: 17 },
  { name: 'Left-Amygdala', label: 'Left amygdala', index: 18 },
  { name: 'CSF', label: 'CSF', index: 24 },
  { name: 'Left-Accumbens-area', label: 'Left accumbens', index: 26 },
  { name: 'Left-VentralDC', label: 'Left ventral diencephalon', index: 28 },
  { name: 'Left-vessel', label: 'Left vessel', index: 30 },
  { name: 'Left-choroid-plexus', label: 'Left choroid plexus', index: 31 },
  {
    name: 'Right-Lateral-Ventricle',
    label: 'Right lateral ventricle',
    index: 43,
  },
  {
    name: 'Right-Inf-Lat-Vent',
    label: 'Right inferior lateral ventricle',
    index: 44,
  },
  {
    name: 'Right-Cerebellum-White-Matter',
    label: 'Right cerebellar white matter',
    index: 46,
  },
  {
    name: 'Right-Cerebellum-Cortex',
    label: 'Right cerebellar cortex',
    index: 47,
  },
  { name: 'Right-Thalamus', label: 'Right thalamus', index: 49 },
  { name: 'Right-Caudate', label: 'Right caudate', index: 50 },
  { name: 'Right-Putamen', label: 'Right putamen', index: 51 },
  { name: 'Right-Pallidum', label: 'Right pallidum', index: 52 },
  { name: 'Right-Hippocampus', label: 'Right hippocampus', index: 53 },
  { name: 'Right-Amygdala', label: 'Right amygdala', index: 54 },
  { name: 'Right-Accumbens-area', label: 'Right accumbens', index: 58 },
  { name: 'Right-VentralDC', label: 'Right ventral diencephalon', index: 60 },
  { name: 'Right-vessel', label: 'Right vessel', index: 62 },
  { name: 'Right-choroid-plexus', label: 'Right choroid plexus', index: 63 },
  { name: '5th-Ventricle', label: 'Fifth ventricle', index: 72 },
  { name: 'WM-hypointensities', label: 'WM hypointensities', index: 77 },
  {
    name: 'Left-WM-hypointensities',
    label: 'Left WM hypointensities',
    index: 78,
  },
  {
    name: 'Right-WM-hypointensities',
    label: 'Right WM hypointensities',
    index: 79,
  },
  {
    name: 'non-WM-hypointensities',
    label: 'Non-WM hypointensities',
    index: 80,
  },
  {
    name: 'Left-non-WM-hypointensities',
    label: 'Left non-WM hypointensities',
    index: 81,
  },
  {
    name: 'Right-non-WM-hypointensities',
    label: 'Right non-WM hypointensities',
    index: 82,
  },
  { name: 'Optic-Chiasm', label: 'Optic chiasm', index: 85 },
  { name: 'CC_Posterior', label: 'Corpus callosum, posterior', index: 251 },
  {
    name: 'CC_Mid_Posterior',
    label: 'Corpus callosum, mid-posterior',
    index: 252,
  },
  { name: 'CC_Central', label: 'Corpus callosum, central', index: 253 },
  {
    name: 'CC_Mid_Anterior',
    label: 'Corpus callosum, mid-anterior',
    index: 254,
  },
  { name: 'CC_Anterior', label: 'Corpus callosum, anterior', index: 255 },
]

const DK_BY_NAME = new Map(DK_REGIONS.map((region) => [region.name, region]))
const ASEG_BY_NAME = new Map(
  ASEG_STRUCTURES.map((structure) => [structure.name, structure]),
)

/** The display names of the DK metrics. */
export const DK_METRIC_LABELS: Readonly<Record<DkMetric, string>> = {
  ThickAvg: 'thickness',
  ThickStd: 'thickness SD',
  SurfArea: 'area',
  GrayVol: 'gray-matter volume',
  NumVert: 'vertex count',
  MeanCurv: 'mean curvature',
  GausCurv: 'Gaussian curvature',
  FoldInd: 'folding index',
  CurvInd: 'curvature index',
}

/** The display names of the whole-brain measures. */
const GLOBAL_LABELS: Readonly<Record<GlobalMeasure, string>> = {
  eTIV: 'Estimated total intracranial volume',
  sTIV: 'Total intracranial volume (sTIV)',
  synthsegTIV: 'Total intracranial volume (SynthSeg)',
  meanThickness: 'Mean cortical thickness',
  BrainSegVol: 'Brain segmentation volume',
  BrainSegVolNotVent: 'Brain volume without ventricles',
  CortexVol: 'Cortical gray-matter volume',
  TotalGrayVol: 'Total gray-matter volume',
  SubCortGrayVol: 'Subcortical gray-matter volume',
  CerebralWhiteMatterVol: 'Cerebral white-matter volume',
  SupraTentorialVol: 'Supratentorial volume',
  SurfaceHoles: 'Surface holes',
}

/** The unit of a measure's values. */
export type MeasureUnit =
  | 'mm'
  | 'mm2'
  | 'mm3'
  | '1/mm'
  | '1/mm2'
  | 'count'
  | 'index'
  | 'percent'
  | 'years'

const DK_METRIC_UNITS: Readonly<Record<DkMetric, MeasureUnit>> = {
  ThickAvg: 'mm',
  ThickStd: 'mm',
  SurfArea: 'mm2',
  GrayVol: 'mm3',
  NumVert: 'count',
  MeanCurv: '1/mm',
  GausCurv: '1/mm2',
  FoldInd: 'index',
  CurvInd: 'index',
}

/**
 * Give the `aparc+aseg` label indices of one DK region.
 *
 * @param region - The `aparc` region name, for example `precentral`.
 * @param hemisphere - A hemisphere, or `bi` for both.
 * @returns The indices (one, or left then right), or an empty list for an
 *   unknown region.
 */
export function dkLabelIndices(
  region: string,
  hemisphere: MeasureHemisphere,
): number[] {
  const found = DK_BY_NAME.get(region)
  if (!found) return []
  const left = 1000 + found.index
  const right = 2000 + found.index
  return hemisphere === 'lh'
    ? [left]
    : hemisphere === 'rh'
      ? [right]
      : [left, right]
}

/**
 * Give the `aseg` label indices of one structure or bilateral pair.
 *
 * @param structure - The `aseg.stats` name, or the unprefixed name of a
 *   `Left-`/`Right-` pair when `bilateral` is true.
 * @returns The indices, or an empty list for an unknown structure.
 */
export function asegLabelIndices(
  structure: string,
  bilateral = false,
): number[] {
  if (!bilateral) {
    const found = ASEG_BY_NAME.get(structure)
    return found ? [found.index] : []
  }
  const left = ASEG_BY_NAME.get(`Left-${structure}`)
  const right = ASEG_BY_NAME.get(`Right-${structure}`)
  return left && right ? [left.index, right.index] : []
}

/**
 * Give the `aparc+aseg` label indices a measure maps to in the volume
 * viewer.
 *
 * @returns The indices, or an empty list for a measure with no map (global
 *   measures and Brain-PAD) or an ID outside the tables.
 */
export function measureLabelIndices(id: string): number[] {
  const parsed = parseMeasureId(id)
  if (!parsed) return []
  if (parsed.source === 'dk') {
    return dkLabelIndices(parsed.region, parsed.hemisphere)
  }
  if (parsed.source === 'aseg') {
    return asegLabelIndices(parsed.structure, parsed.hemisphere === 'bi')
  }
  return []
}

/**
 * Say whether a measure can be drawn on a brain map.
 *
 * @returns True when the measure has atlas labels.
 */
export function isMappableMeasure(id: string): boolean {
  return measureLabelIndices(id).length > 0
}

function asegPairLabel(structure: string): string {
  const left = ASEG_BY_NAME.get(`Left-${structure}`)
  const label = left ? left.label.replace(/^Left /, '') : structure
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/**
 * Name a measure for tables and figures, for example "Left precentral
 * thickness" or "Thalamus volume (bilateral mean)".
 *
 * @returns The display label; an ID outside the tables reads as itself.
 */
export function measureLabel(id: string): string {
  const parsed = parseMeasureId(id)
  if (!parsed) return id
  switch (parsed.source) {
    case 'dk': {
      const region = DK_BY_NAME.get(parsed.region)?.label ?? parsed.region
      const metric = DK_METRIC_LABELS[parsed.metric]
      if (parsed.hemisphere === 'bi') {
        return `${region} ${metric} (bilateral mean)`
      }
      const side = parsed.hemisphere === 'lh' ? 'Left' : 'Right'
      return `${side} ${region.charAt(0).toLowerCase()}${region.slice(1)} ${metric}`
    }
    case 'aseg':
      if (parsed.hemisphere === 'bi') {
        return `${asegPairLabel(parsed.structure)} volume (bilateral mean)`
      }
      return `${ASEG_BY_NAME.get(parsed.structure)?.label ?? parsed.structure} volume`
    case 'global':
      return GLOBAL_LABELS[parsed.name]
    case 'brainage':
      return 'Brain-PAD'
    case 'parc': {
      const metric =
        parsed.metric === 'GWC'
          ? 'gray-to-white contrast'
          : DK_METRIC_LABELS[parsed.metric]
      const side =
        parsed.hemisphere === 'bi'
          ? ' (bilateral mean)'
          : parsed.hemisphere === 'lh'
            ? ', left'
            : ', right'
      // The gray-to-white contrast metric already names its atlas.
      return parsed.metric === 'GWC'
        ? `${parsed.region} ${metric}${side}`
        : `${parsed.region} ${metric} (${atlasDisplayName(parsed.atlas)})${side}`
    }
    case 'vol': {
      const side =
        parsed.hemisphere === 'bi'
          ? ' (bilateral mean)'
          : parsed.hemisphere === 'lh'
            ? ', left'
            : parsed.hemisphere === 'rh'
              ? ', right'
              : ''
      return `${parsed.structure} volume (${atlasDisplayName(parsed.atlas)})${side}`
    }
  }
}

/**
 * Give the unit of a measure's values.
 *
 * @throws TypeError when the ID breaks the grammar.
 */
export function measureUnit(id: string): MeasureUnit {
  const parsed = parseMeasureId(id)
  if (!parsed) throw new TypeError(`Use a valid measure ID: ${id}.`)
  switch (parsed.source) {
    case 'dk':
      return DK_METRIC_UNITS[parsed.metric]
    case 'aseg':
      return 'mm3'
    case 'global':
      return parsed.name === 'meanThickness'
        ? 'mm'
        : parsed.name === 'SurfaceHoles'
          ? 'index'
          : 'mm3'
    case 'brainage':
      return 'years'
    case 'parc':
      return parsed.metric === 'GWC'
        ? 'percent'
        : DK_METRIC_UNITS[parsed.metric]
    case 'vol':
      return 'mm3'
  }
}

// -- Brain-viewer assets -------------------------------------------------------

/**
 * The FreeSurfer files the viewer may read, relative to
 * `$FREESURFER_HOME/subjects`. FreeSurfer data is never bundled.
 */
export const FSAVERAGE_ASSET_IDS = [
  'fsaverage5/surf/lh.pial',
  'fsaverage5/surf/rh.pial',
  'fsaverage5/surf/lh.inflated',
  'fsaverage5/surf/rh.inflated',
  'fsaverage5/surf/lh.sulc',
  'fsaverage5/surf/rh.sulc',
  'fsaverage5/label/lh.aparc.annot',
  'fsaverage5/label/rh.aparc.annot',
  'fsaverage/mri/brain.mgz',
  'fsaverage/mri/aparc+aseg.mgz',
] as const

/** The Brodmann-area labels FreeSurfer ships on fsaverage (`*_exvivo`). */
export const BA_LABEL_NAMES = [
  'BA1',
  'BA2',
  'BA3a',
  'BA3b',
  'BA4a',
  'BA4p',
  'BA6',
  'BA44',
  'BA45',
  'V1',
  'V2',
  'MT',
  'entorhinal',
  'perirhinal',
] as const

/**
 * The optional template files of the v2 atlas maps, relative to
 * `$FREESURFER_HOME/subjects`: the fsaverage5 Destrieux and Yeo
 * annotations, and fsaverage's Brodmann-area labels (plain and thresholded),
 * which the viewer subsamples to fsaverage5 (vertices below 10242). Their
 * absence never makes the template unavailable.
 */
export const TEMPLATE_ATLAS_ASSET_IDS = [
  ...(['lh', 'rh'] as const).flatMap(
    (hemi) =>
      [
        `fsaverage5/label/${hemi}.aparc.a2009s.annot`,
        `fsaverage5/label/${hemi}.Yeo2011_7Networks_N1000.annot`,
        `fsaverage5/label/${hemi}.Yeo2011_17Networks_N1000.annot`,
      ] as const,
  ),
  ...(['lh', 'rh'] as const).flatMap((hemi) =>
    BA_LABEL_NAMES.flatMap(
      (name) =>
        [
          `fsaverage/label/${hemi}.${name}_exvivo.label`,
          `fsaverage/label/${hemi}.${name}_exvivo.thresh.label`,
        ] as const,
    ),
  ),
] as const

/** FreeSurfer's color table, at the FreeSurfer home root (not `subjects`). */
export const FREESURFER_LUT_ASSET_ID = 'FreeSurferColorLUT.txt'

/**
 * One subject's volumes, from `derivatives/freesurfer/<subject>/mri/`; a
 * request names the subject separately. The v2 label maps (wmparc,
 * Destrieux, DKT, entorhinal white matter) are optional.
 */
export const SUBJECT_ASSET_IDS = [
  'subject/mri/brain.mgz',
  'subject/mri/aparc+aseg.mgz',
  'subject/mri/wmparc.mgz',
  'subject/mri/aparc.a2009s+aseg.mgz',
  'subject/mri/aparc.DKTatlas+aseg.mgz',
  'subject/mri/entowm.mgz',
] as const

/**
 * A file of the labeling cache, `.supraspina/analysis/atlases/<atlasId>/`:
 * `atlas/<atlasId>/subject/<file>` (the request names the subject) or
 * `atlas/<atlasId>/templates-fsaverage5/<file>`. Main confines it under
 * the cache, refuses a symlinked final component, and checks the file
 * against the atlas recipe's viewer allowlist (`ATLAS_CACHE_VIEWER_FILES`).
 */
export const ATLAS_CACHE_ASSET_ID =
  /^atlas\/[a-z][a-z0-9-]{1,47}\/(?:subject|templates-fsaverage5)\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(?:mgz|annot|label|txt|ctab)$/

/** One labeling-cache asset ID. */
export type AtlasCacheAssetId = `atlas/${string}`

/** One readable viewer asset. */
export type BrainAssetId =
  | (typeof FSAVERAGE_ASSET_IDS)[number]
  | (typeof TEMPLATE_ATLAS_ASSET_IDS)[number]
  | typeof FREESURFER_LUT_ASSET_ID
  | (typeof SUBJECT_ASSET_IDS)[number]
  | AtlasCacheAssetId

/** The most assets one `brainViewer.assets` report lists. */
export const MAX_BRAIN_ASSETS = 256

/** The largest asset main reads. */
export const MAX_BRAIN_ASSET_BYTES = 16 * 1024 * 1024

/** The request of `brainViewer.assets`. */
export interface BrainAssetsRequest {
  /** List one subject's volumes too. */
  subjectId?: string
}

/** The result of `brainViewer.assets`. */
export interface BrainAssetsReport {
  available: boolean
  /** Why the viewer cannot load its template, as a fact. */
  unavailableReason: string | null
  subjectId: string | null
  assets: { assetId: BrainAssetId; bytes: number }[]
}

/** The request of `brainViewer.readAsset`. */
export interface BrainAssetReadRequest {
  assetId: BrainAssetId
  /** Required for a subject asset, refused otherwise. */
  subjectId?: string
}

/** The result of `brainViewer.readAsset`. */
export interface BrainAsset {
  assetId: BrainAssetId
  sha256: string
  data: Uint8Array
}

/**
 * Say whether a value names a readable viewer asset.
 *
 * @returns True for an allowlisted asset ID.
 */
export function isBrainAssetId(value: unknown): value is BrainAssetId {
  return (
    typeof value === 'string' &&
    ((FSAVERAGE_ASSET_IDS as readonly string[]).includes(value) ||
      (TEMPLATE_ATLAS_ASSET_IDS as readonly string[]).includes(value) ||
      value === FREESURFER_LUT_ASSET_ID ||
      (SUBJECT_ASSET_IDS as readonly string[]).includes(value) ||
      isAtlasCacheAssetId(value))
  )
}

/**
 * Say whether a value names a labeling-cache asset.
 *
 * @returns True for an `atlas/...` asset ID.
 */
export function isAtlasCacheAssetId(
  value: unknown,
): value is AtlasCacheAssetId {
  return typeof value === 'string' && ATLAS_CACHE_ASSET_ID.test(value)
}

/**
 * Say whether an asset belongs to one subject rather than the template: a
 * subject volume or a subject's labeling-cache file.
 *
 * @returns True for a subject asset.
 */
export function isSubjectAssetId(id: BrainAssetId): boolean {
  return (
    (SUBJECT_ASSET_IDS as readonly string[]).includes(id) ||
    (isAtlasCacheAssetId(id) && id.split('/')[2] === 'subject')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Validate the result of `brainViewer.assets`.
 *
 * @throws TypeError when the result breaks the contract.
 */
export function parseBrainAssetsReport(value: unknown): BrainAssetsReport {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !==
      'assets,available,subjectId,unavailableReason' ||
    typeof value.available !== 'boolean' ||
    !(
      value.unavailableReason === null ||
      (typeof value.unavailableReason === 'string' &&
        value.unavailableReason.length <= 512)
    ) ||
    value.available === (value.unavailableReason !== null) ||
    !(value.subjectId === null || typeof value.subjectId === 'string') ||
    !Array.isArray(value.assets) ||
    value.assets.length > MAX_BRAIN_ASSETS
  ) {
    throw new TypeError('Provide a valid brain asset report.')
  }
  const assets = value.assets.map((item) => {
    if (
      !isRecord(item) ||
      Object.keys(item).sort().join(',') !== 'assetId,bytes' ||
      !isBrainAssetId(item.assetId) ||
      !isCount(item.bytes) ||
      item.bytes > MAX_BRAIN_ASSET_BYTES
    ) {
      throw new TypeError('Provide a valid brain asset entry.')
    }
    return { assetId: item.assetId, bytes: item.bytes }
  })
  return {
    available: value.available,
    unavailableReason: value.unavailableReason,
    subjectId: value.subjectId,
    assets,
  }
}

/**
 * Validate the result of `brainViewer.readAsset`.
 *
 * @throws TypeError when the result breaks the contract.
 */
export function parseBrainAsset(value: unknown): BrainAsset {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'assetId,data,sha256' ||
    !isBrainAssetId(value.assetId) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !(value.data instanceof Uint8Array) ||
    value.data.byteLength > MAX_BRAIN_ASSET_BYTES
  ) {
    throw new TypeError('Provide a valid brain asset.')
  }
  return { assetId: value.assetId, sha256: value.sha256, data: value.data }
}
