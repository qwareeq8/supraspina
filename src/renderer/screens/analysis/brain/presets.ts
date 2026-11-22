/**
 * View presets of the brain viewer, kept outside the lazily loaded viewer so
 * that the Brain tab can offer them before NiiVue loads.
 */

import type {
  BrainMode,
  ClosePreset,
  CutPlane,
  Hemisphere,
  SurfaceKind,
  SurfaceView,
} from './viewer'

/** The first cut: coronal, seen from the front, through the thalamus. */
export const DEFAULT_CUT: CutPlane = { depthMm: 16, azimuth: 180, elevation: 0 }

/** The close-ups the cut and slice views offer, in menu order. */
export const CLOSE_UPS: readonly { preset: ClosePreset; label: string }[] = [
  { preset: 'brainstem', label: 'Brainstem close-up' },
  { preset: 'thalamus', label: 'Thalamus' },
  { preset: 'hippocampus', label: 'Hippocampus and amygdala' },
]

/**
 * The cut angles of a close-up: the brainstem and a hippocampus are cut
 * sagittally (seen from the hippocampus's side), the thalami coronally
 * from the front.
 */
export function closeUpCut(
  preset: ClosePreset,
  hemisphere: Hemisphere,
): CutPlane {
  if (preset === 'thalamus') return { depthMm: 0, azimuth: 180, elevation: 0 }
  if (preset === 'hippocampus' && hemisphere === 'rh') {
    return { depthMm: 0, azimuth: 270, elevation: 0 }
  }
  return { depthMm: 0, azimuth: 90, elevation: 0 }
}

/** What the Brain tab draws, as far as an exported image names it. */
export interface BrainViewDescription {
  mode: BrainMode
  stat: 'd' | 't'
  /** The cortical layer key, `<metric>:<hemi|bi>`, or null. */
  layerKey: string | null
  surface: SurfaceKind
  hemisphere: Hemisphere
  view: SurfaceView
  cut: CutPlane
  /** True when the volumes are a subject's rather than the template's. */
  subject: boolean
  /** The label map of the cut and slice views; `aseg` when omitted. */
  labelMap?: string
  /** The close-up of the cut and slice views, if any. */
  closeUp?: ClosePreset | null
}

function signed(value: number): string {
  return value < 0 ? `m${Math.abs(value)}` : String(value)
}

/**
 * Name an exported image of the Brain tab after the view it shows, for
 * example `brain-d-thickavg-bi-lh-lateral-inflated`. A subject's ID never
 * enters the name.
 *
 * @returns A `[a-z0-9-]` file stem.
 */
export function brainViewStem(view: BrainViewDescription): string {
  const layer = view.layerKey
    ? view.layerKey.toLowerCase().replace(':hemi', '').replaceAll(':', '-')
    : 'aseg'
  const labels =
    view.labelMap && view.labelMap !== 'aseg' ? [view.labelMap] : []
  const close = view.closeUp ? [view.closeUp] : []
  const parts =
    view.mode === 'surface'
      ? [
          layer,
          view.view === 'dorsal' || view.view === 'ventral'
            ? 'both'
            : view.hemisphere,
          view.view,
          view.surface,
        ]
      : view.mode === 'cut'
        ? [
            'cut',
            ...labels,
            ...close,
            `az${signed(view.cut.azimuth)}`,
            `el${signed(view.cut.elevation)}`,
            `depth${signed(view.cut.depthMm)}`,
            view.subject ? 'subject' : 'fsaverage',
          ]
        : [
            'slices',
            ...labels,
            ...close,
            view.subject ? 'subject' : 'fsaverage',
          ]
  return ['brain', view.stat, ...parts].join('-')
}

const CLOSE_UP_WORDS: Readonly<Record<ClosePreset, string>> = {
  brainstem: 'brainstem close-up',
  thalamus: 'thalamus close-up',
  hippocampus: 'hippocampus and amygdala close-up',
}

/**
 * Describe the drawn view in words for an exported figure's caption. A
 * subject's ID never enters it.
 *
 * @param labelMapName - The drawn label map's name when it is an atlas's (not
 *   `aparc+aseg`).
 */
export function brainViewCaption(
  view: BrainViewDescription,
  layerLabel: string | null,
  labelMapName: string | null = null,
): string {
  const layer =
    view.mode !== 'surface' && labelMapName
      ? labelMapName
      : (layerLabel ?? 'Subcortical volumes')
  const volumes = view.subject
    ? labelMapName
      ? "one subject's brain (labels drawn on it; colors are group statistics)"
      : "a subject's volumes"
    : 'the fsaverage template'
  const close = view.closeUp ? `${CLOSE_UP_WORDS[view.closeUp]}, ` : ''
  if (view.mode === 'surface') {
    const side =
      view.view === 'dorsal' || view.view === 'ventral'
        ? 'both hemispheres'
        : `${view.hemisphere === 'lh' ? 'left' : 'right'} hemisphere`
    return `${layer}; ${side}, ${view.view} view, ${view.surface} surface`
  }
  if (view.mode === 'cut') {
    const { depthMm, azimuth, elevation } = view.cut
    const minus = (value: number): string =>
      value < 0 ? `\u2212${Math.abs(value)}` : String(value)
    return `${layer}; ${close}cut at ${minus(depthMm)} mm, azimuth ${minus(azimuth)}\u00b0, elevation ${minus(elevation)}\u00b0, through ${volumes}`
  }
  const slices = view.closeUp
    ? `${close.slice(0, -2)}, one slice`
    : 'axial, coronal, and sagittal slices'
  return `${layer}; ${slices} through ${volumes}, left hemisphere on the left`
}
