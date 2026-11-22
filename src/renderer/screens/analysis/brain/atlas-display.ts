/**
 * Where the brain viewer draws each atlas. Surface atlases are drawn on
 * fsaverage5: the DK, Destrieux, and Yeo annotations FreeSurfer ships, the
 * Brodmann areas built from fsaverage's label files, and the fsaverage5
 * template labels of the labeling cache (DKT, Schaefer, and added gcs or
 * annot atlases). Volume atlases are subject-space label maps drawn on one
 * subject's `brain.mgz`: the recon's `aparc+aseg`, Destrieux, DKT,
 * `wmparc`, and `entowm` volumes, and the labeling cache's subfield,
 * nucleus, and added label maps.
 *
 * A measure meets its drawing through names: a surface region is the
 * annotation name with the atlas's hemisphere token removed (as the
 * sidecar names regions), and a volume structure is the color-table name
 * of a label value.
 */

import {
  ATLAS_SOURCES,
  BUILT_IN_ATLASES,
} from '../../../../shared/atlas-labeling'
import {
  BA_LABEL_NAMES,
  FSAVERAGE_ASSET_IDS,
  measureLabelIndices,
  asegLabelIndices,
  type BrainAssetId,
} from '../../../../shared/brain-atlas'
import {
  HEMISPHERE_TOKEN_RULES,
  joinHemisphereToken,
  parseMeasureId,
  splitHemisphereToken,
  type HemisphereTokenRule,
} from '../../../../shared/group-analysis'
import {
  BRAINSTEM_SUBFIELDS,
  isAmygdalaNucleus,
  isHippocampalSubfield,
  isThalamicNucleus,
  type ColorLut,
} from './color-lut'

/** A hemisphere of the fsaverage5 surfaces. */
export type SurfaceHemisphere = 'lh' | 'rh'

/** The vertex count of fsaverage5. */
export const FSAVERAGE5_VERTICES = 10_242

/** Label names that are not regions, as the sidecar skips them. */
const NOT_REGIONS = new Set([
  'unknown',
  '???',
  'background',
  'medial_wall',
  'medialwall',
  'freesurfer_defined_medial_wall',
  'background+freesurfer_defined_medial_wall',
])
const REGION = /^[A-Za-z0-9_.&-]{1,64}$/

/**
 * Spell a label name in the measure grammar's region characters, as the
 * sidecar's `region_name` does.
 *
 * @returns The region, or null for a non-region label.
 */
export function regionName(name: string): string | null {
  const trimmed = name.trim()
  if (NOT_REGIONS.has(trimmed.toLowerCase())) return null
  const cleaned = trimmed.replace(/[^A-Za-z0-9_.&-]/g, '_').slice(0, 64)
  return REGION.test(cleaned) ? cleaned : null
}

/**
 * Give the region a surface label stands for: its name without the
 * hemisphere token of the atlas's first matching rule.
 *
 * @returns The region, or null for a non-region label.
 */
export function surfaceRegion(
  name: string,
  rules: readonly HemisphereTokenRule[],
  hemisphere: SurfaceHemisphere,
): string | null {
  for (const rule of rules) {
    const split = splitHemisphereToken(rule, name)
    if (split.hemisphere === hemisphere) return regionName(split.structure)
  }
  return regionName(name)
}

/** The rules tried for an atlas whose rules the viewer does not know. */
const ANY_RULES = HEMISPHERE_TOKEN_RULES.filter((rule) => rule !== 'none')

/**
 * Give an atlas's hemisphere-token rules.
 *
 * @returns The built-in or source rules; every rule for an added atlas.
 */
export function atlasRules(atlasId: string): readonly HemisphereTokenRule[] {
  const builtIn = BUILT_IN_ATLASES.find((item) => item.atlasId === atlasId)
  if (builtIn) return builtIn.hemisphereRules
  const source = ATLAS_SOURCES.find((item) => item.atlasIds.includes(atlasId))
  return source ? source.hemisphereRules : ANY_RULES
}

const SCHAEFER = /^schaefer(\d+)-(\d+)$/

/** Name an atlas for the viewer's controls. */
export function atlasName(
  atlasId: string,
  added: ReadonlyMap<string, string> = new Map(),
): string {
  if (atlasId === 'dk') return 'Desikan-Killiany'
  const builtIn = BUILT_IN_ATLASES.find((item) => item.atlasId === atlasId)
  if (builtIn) return builtIn.label
  const schaefer = SCHAEFER.exec(atlasId)
  if (schaefer) {
    return `Schaefer 2018, ${schaefer[1]} parcels, ${schaefer[2]} networks`
  }
  return added.get(atlasId) ?? `Added atlas ${atlasId}`
}

/**
 * How one surface atlas reaches fsaverage5:
 *
 * - `annot`: one annotation per hemisphere (FreeSurfer's or the labeling
 *   cache's template labels).
 * - `labels`: fsaverage label files per hemisphere, combined by the largest
 *   value and subsampled to the fsaverage5 vertices.
 */
export type SurfaceAtlasFiles =
  | { kind: 'annot'; lh: BrainAssetId; rh: BrainAssetId }
  | {
      kind: 'labels'
      lh: { name: string; assetId: BrainAssetId }[]
      rh: { name: string; assetId: BrainAssetId }[]
    }

/** The atlases drawn on the DK annotation (the pial and contrast tables). */
const DK_ANNOTATION_ATLASES = new Set(['dk', 'dkpial', 'gwc'])

/**
 * Give the files that draw a surface atlas on fsaverage5.
 *
 * @param atlasId - The atlas ID of a `parc` measure, or `dk`.
 * @returns The files, or null for an atlas the viewer cannot draw.
 */
export function surfaceAtlasFiles(atlasId: string): SurfaceAtlasFiles | null {
  const both = (
    make: (hemi: SurfaceHemisphere) => BrainAssetId,
  ): SurfaceAtlasFiles => ({ kind: 'annot', lh: make('lh'), rh: make('rh') })
  if (DK_ANNOTATION_ATLASES.has(atlasId)) {
    return both((hemi) => `fsaverage5/label/${hemi}.aparc.annot`)
  }
  switch (atlasId) {
    case 'a2009s':
      return both((hemi) => `fsaverage5/label/${hemi}.aparc.a2009s.annot`)
    case 'yeo7':
      return both(
        (hemi) => `fsaverage5/label/${hemi}.Yeo2011_7Networks_N1000.annot`,
      )
    case 'yeo17':
      return both(
        (hemi) => `fsaverage5/label/${hemi}.Yeo2011_17Networks_N1000.annot`,
      )
    case 'ba':
    case 'bathresh': {
      const suffix = atlasId === 'ba' ? '_exvivo' : '_exvivo.thresh'
      const list = (hemi: SurfaceHemisphere) =>
        BA_LABEL_NAMES.map((name) => ({
          name: `${name}${suffix}`,
          assetId:
            `fsaverage/label/${hemi}.${name}${suffix}.label` as BrainAssetId,
        }))
      return { kind: 'labels', lh: list('lh'), rh: list('rh') }
    }
  }
  if (
    atlasId === 'dkt' ||
    SCHAEFER.test(atlasId) ||
    /^user-[a-f0-9]{8}$/.test(atlasId)
  ) {
    return both(
      (hemi) =>
        `atlas/${atlasId}/templates-fsaverage5/${hemi}.${atlasId}.annot` as BrainAssetId,
    )
  }
  return null
}

/**
 * Say why a surface atlas cannot be drawn although the viewer knows it: its
 * template labels have not been made yet.
 *
 * @returns The fact, or null when the files are present.
 */
export function missingSurfaceAtlas(
  atlasId: string,
  present: ReadonlySet<string>,
): string | null {
  const files = surfaceAtlasFiles(atlasId)
  if (!files) return `${atlasName(atlasId)} has no fsaverage5 drawing.`
  const ids =
    files.kind === 'annot'
      ? [files.lh, files.rh]
      : [...files.lh, ...files.rh].map((item) => item.assetId)
  if (ids.every((id) => present.has(id))) return null
  if (ids.some((id) => id.startsWith('atlas/'))) {
    return `${atlasName(atlasId)} has no fsaverage5 template labels yet; label the template in Choose measures to draw it.`
  }
  return `The FreeSurfer home lacks the fsaverage files of ${atlasName(atlasId)}.`
}

/** True when an asset ID is one of the fsaverage5 DK base files. */
export function isBaseTemplateAsset(id: string): boolean {
  return (FSAVERAGE_ASSET_IDS as readonly string[]).includes(id)
}

/**
 * A label map the cut and slice views can draw:
 *
 * - `aseg`: `aparc+aseg` (DK and aseg), the template's or a subject's.
 * - `a2009s`, `dkt`: the recon's Destrieux and DKT `+aseg` volumes.
 * - `wmparc`, `entowm`: the recon's white-matter label maps.
 * - `brainstem-ss`, `hippo-amygdala`, `thalamic`, `user-...`: the
 *   labeling cache's label maps.
 */
export type VolumeSourceId = string

/** The files of one label map. */
export interface VolumeSourceFiles {
  /** The label maps; hippocampus and amygdala have one per hemisphere. */
  labels: { assetId: BrainAssetId; hemisphere: SurfaceHemisphere | null }[]
  /** True when only a subject has it (no fsaverage version). */
  subjectOnly: boolean
  /**
   * The subject's copy of the atlas's own color table, which names an
   * added map's labels; FreeSurfer's table names the others.
   */
  colorTable?: BrainAssetId
}

/** The labeling-cache atlases with subject label maps. */
const CACHE_VOLUME_FILES: Readonly<Record<string, VolumeSourceFiles>> = {
  'brainstem-ss': {
    labels: [
      {
        assetId:
          'atlas/brainstem-ss/subject/brainstemSsLabels.FSvoxelSpace.mgz',
        hemisphere: null,
      },
    ],
    subjectOnly: true,
  },
  'hippo-amygdala': {
    labels: (['lh', 'rh'] as const).map((hemisphere) => ({
      assetId:
        `atlas/hippo-amygdala/subject/${hemisphere}.hippoAmygLabels.FSvoxelSpace.mgz` as BrainAssetId,
      hemisphere,
    })),
    subjectOnly: true,
  },
  thalamic: {
    labels: [
      {
        assetId: 'atlas/thalamic/subject/ThalamicNuclei.FSvoxelSpace.mgz',
        hemisphere: null,
      },
    ],
    subjectOnly: true,
  },
}

/**
 * Give the files of one label map.
 *
 * @returns The files, or null for an unknown map.
 */
export function volumeSourceFiles(
  sourceId: VolumeSourceId,
): VolumeSourceFiles | null {
  const recon = (file: string): VolumeSourceFiles => ({
    labels: [
      { assetId: `subject/mri/${file}` as BrainAssetId, hemisphere: null },
    ],
    subjectOnly: true,
  })
  switch (sourceId) {
    case 'aseg':
      return {
        labels: [{ assetId: 'subject/mri/aparc+aseg.mgz', hemisphere: null }],
        subjectOnly: false,
      }
    case 'a2009s':
      return recon('aparc.a2009s+aseg.mgz')
    case 'dkt':
      return recon('aparc.DKTatlas+aseg.mgz')
    case 'wmparc':
      return recon('wmparc.mgz')
    case 'entowm':
      return recon('entowm.mgz')
  }
  if (CACHE_VOLUME_FILES[sourceId]) return CACHE_VOLUME_FILES[sourceId]
  if (/^user-[a-f0-9]{8}$/.test(sourceId)) {
    return {
      labels: [
        {
          assetId: `atlas/${sourceId}/subject/${sourceId}.mgz` as BrainAssetId,
          hemisphere: null,
        },
      ],
      subjectOnly: true,
      colorTable: `atlas/${sourceId}/subject/${sourceId}.ctab` as BrainAssetId,
    }
  }
  return null
}

/**
 * The label maps whose labels are named by `FreeSurferColorLUT.txt`; an
 * added map brings its own table (`colorTable`).
 */
export function volumeSourceNeedsLut(sourceId: VolumeSourceId): boolean {
  return (
    sourceId !== 'aseg' &&
    sourceId !== 'entowm' &&
    !/^user-[a-f0-9]{8}$/.test(sourceId)
  )
}

/** The value a right-hemisphere label gets in a merged two-file map. */
export const RIGHT_FILE_OFFSET = 100_000

/**
 * The `entowm` labels, as `entowm.stats` of FreeSurfer 8.2 names them; the
 * gyrus ambiens reuses 3201/4201, which the color table names otherwise.
 */
const ENTOWM_LABELS: Readonly<Record<string, number>> = {
  'wm-lh-entorhinal': 3006,
  'wm-lh-gyrus-ambiens': 3201,
  'wm-rh-entorhinal': 4006,
  'wm-rh-gyrus-ambiens': 4201,
}

/** Volume-table names that differ from the color table's. */
const NAME_ALIASES: Readonly<Record<string, string>> = {
  Hippocampal_tail: 'HP_tail',
  'hippocampal-fissure': 'hippocampal_fissure',
}

/** The label maps the measures of a `vol` atlas are drawn on. */
const VOL_ATLAS_SOURCE: Readonly<Record<string, VolumeSourceId>> = {
  wmparc: 'wmparc',
  entowm: 'entowm',
  'brainstem-ss': 'brainstem-ss',
  'hippo-amygdala': 'hippo-amygdala',
  thalamic: 'thalamic',
}

/**
 * Give the label map a measure is drawn on: `aseg` for the DK and aseg
 * measures, the atlas's own map for the rest, or null.
 *
 * @returns The label map's ID, or null for a measure no map draws.
 */
export function measureVolumeSource(measureId: string): VolumeSourceId | null {
  const parsed = parseMeasureId(measureId)
  if (!parsed) return null
  if (parsed.source === 'dk' || parsed.source === 'aseg') return 'aseg'
  if (parsed.source === 'parc') {
    return parsed.atlas === 'a2009s' || parsed.atlas === 'dkt'
      ? parsed.atlas
      : null
  }
  if (parsed.source === 'vol') {
    if (VOL_ATLAS_SOURCE[parsed.atlas]) return VOL_ATLAS_SOURCE[parsed.atlas]!
    return /^user-[a-f0-9]{8}$/.test(parsed.atlas) ? parsed.atlas : null
  }
  return null
}

function lutValue(lut: ColorLut | null, name: string): number | null {
  return lut?.byName.get(NAME_ALIASES[name] ?? name)?.index ?? null
}

function lutValues(
  lut: ColorLut | null,
  keep: (index: number, name: string) => boolean,
): number[] {
  if (!lut) return []
  return [...lut.byIndex.values()]
    .filter((entry) => keep(entry.index, entry.name))
    .map((entry) => entry.index)
}

function offsetFor(hemisphere: SurfaceHemisphere): number {
  return hemisphere === 'rh' ? RIGHT_FILE_OFFSET : 0
}

/** The label values of one hemisphere's structure in the hippocampus map. */
function hippocampusValues(
  lut: ColorLut | null,
  hemisphere: SurfaceHemisphere,
  structure: string,
): number[] {
  const offset = offsetFor(hemisphere)
  const whole: Record<string, (index: number, name: string) => boolean> = {
    Whole_hippocampus: (index) => isHippocampalSubfield(index),
    Whole_hippocampal_head: (index, name) =>
      isHippocampalSubfield(index) && name.endsWith('-head'),
    Whole_hippocampal_body: (index, name) =>
      isHippocampalSubfield(index) && name.endsWith('-body'),
    Whole_amygdala: (index) => isAmygdalaNucleus(index),
  }
  const values = whole[structure]
    ? lutValues(lut, whole[structure])
    : [lutValue(lut, structure)].filter((v): v is number => v !== null)
  return values.map((value) => value + offset)
}

/**
 * Say whether a structure stands for a union of labels (`Whole_...`), which
 * gives way to its parts where both are measured.
 */
export function isWholeStructure(structure: string): boolean {
  return /(?:^|-)Whole_/.test(structure)
}

/**
 * Give the label values one measure covers in one label map.
 *
 * @param lut - FreeSurfer's color table, or null when unread.
 * @returns The values (in a merged hippocampus map, right values carry
 *   `RIGHT_FILE_OFFSET`), or an empty list when the measure is not drawn on
 *   this map.
 */
export function measureVolumeValues(
  sourceId: VolumeSourceId,
  measureId: string,
  lut: ColorLut | null,
): number[] {
  const parsed = parseMeasureId(measureId)
  if (!parsed) return []
  const sides = (hemisphere: string): SurfaceHemisphere[] =>
    hemisphere === 'bi'
      ? ['lh', 'rh']
      : hemisphere === 'lh' || hemisphere === 'rh'
        ? [hemisphere]
        : []
  if (parsed.source === 'aseg') {
    return sourceId === 'brainstem-ss' ||
      sourceId === 'hippo-amygdala' ||
      sourceId === 'thalamic' ||
      sourceId === 'entowm' ||
      sourceId.startsWith('user-')
      ? []
      : asegLabelIndices(parsed.structure, parsed.hemisphere === 'bi')
  }
  if (parsed.source === 'dk') {
    return sourceId === 'aseg' ? measureLabelIndices(measureId) : []
  }
  if (parsed.source === 'parc') {
    if (parsed.atlas !== sourceId) return []
    return sides(parsed.hemisphere).flatMap((hemi) => {
      const name =
        sourceId === 'a2009s'
          ? `ctx_${hemi}_${parsed.region}`
          : `ctx-${hemi}-${parsed.region}`
      const value = lutValue(lut, name)
      return value === null ? [] : [value]
    })
  }
  if (parsed.source !== 'vol' || measureVolumeSource(measureId) !== sourceId) {
    return []
  }
  const { structure, hemisphere } = parsed
  switch (sourceId) {
    case 'brainstem-ss':
      if (structure === 'Whole_brainstem') {
        return Object.values(BRAINSTEM_SUBFIELDS)
      }
      return [lutValue(lut, structure)].filter((v): v is number => v !== null)
    case 'hippo-amygdala':
      return sides(hemisphere).flatMap((hemi) =>
        hippocampusValues(lut, hemi, structure),
      )
    case 'thalamic':
      return sides(hemisphere).flatMap((hemi) => {
        const name = joinHemisphereToken('left-right-prefix', hemi, structure)
        if (structure === 'Whole_thalamus') {
          const base = hemi === 'lh' ? 8100 : 8200
          return lutValues(
            lut,
            (index) =>
              isThalamicNucleus(index) && index > base && index < base + 100,
          )
        }
        const value = lutValue(lut, name)
        return value === null ? [] : [value]
      })
    case 'entowm':
      return sides(hemisphere).flatMap((hemi) => {
        const value =
          ENTOWM_LABELS[
            joinHemisphereToken('lh-rh-hyphen-infix', hemi, structure)
          ]
        return value === undefined ? [] : [value]
      })
  }
  // The wmparc and added label maps take the first rule whose name the table
  // knows.
  const rules = atlasRules(sourceId)
  if (hemisphere === 'mid') {
    const value = lutValue(lut, structure)
    return value === null ? [] : [value]
  }
  return sides(hemisphere).flatMap((hemi) => {
    for (const rule of rules) {
      const value = lutValue(lut, joinHemisphereToken(rule, hemi, structure))
      if (value !== null) return [value]
    }
    return []
  })
}
