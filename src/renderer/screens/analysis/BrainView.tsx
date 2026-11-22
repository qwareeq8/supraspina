/**
 * The Brain tab of the Analysis results: the statistic of each cortical
 * region on the fsaverage5 surfaces (DK, Destrieux, DKT, Brodmann areas,
 * Yeo, Schaefer, or an added atlas), a clip-plane cut through `brain.mgz`
 * that reveals the labeled structures, and orthogonal slices, all drawn by
 * NiiVue. Subfield, nucleus, and white-matter atlases are subject-space
 * label maps, drawn on one subject's brain with the group's statistics.
 * The NiiVue chunk loads only when this view mounts, and the viewer is
 * disposed when the view unmounts or the project changes. FreeSurfer's
 * template files come from the saved FreeSurfer home through main; none
 * are bundled.
 */

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import {
  FREESURFER_LUT_ASSET_ID,
  FSAVERAGE_ASSET_IDS,
  measureLabel,
  type BrainAssetId,
} from '../../../shared/brain-atlas'
import {
  parseMeasureId,
  type AnyGroupAnalysisResult,
  type GroupAnalysisTerm,
} from '../../../shared/group-analysis'
import { getApi } from '../../state/api'
import { useApp } from '../../state/context'
import {
  Btn,
  ErrorState,
  FONTS,
  LoadingState,
  Segments,
  THEMES,
  type Theme,
} from '../../ui'
import {
  atlasName,
  atlasRules,
  measureVolumeSource,
  missingSurfaceAtlas,
  surfaceAtlasFiles,
  volumeSourceFiles,
  volumeSourceNeedsLut,
} from './brain/atlas-display'
import {
  DIVERGING_STOPS,
  MUTED_MIX,
  CORTEX_GRAY,
  SIGNIFICANT_OUTLINE,
  buildBrainMap,
  corticalLayers,
  formatStat,
  layerKeyForMeasure,
  statValue,
  unmappedMeasures,
  volumeSources,
  type BrainRow,
  type BrainStat,
} from './brain/brain-map'
import { brainResultText } from './brain/brain-result'
import { parseColorLut, type ColorLut } from './brain/color-lut'
import {
  annotationFromLabels,
  readAnnotation,
  readLabel,
  type Annotation,
} from './brain/freesurfer'
import {
  CLOSE_UPS,
  DEFAULT_CUT,
  brainViewCaption,
  brainViewStem,
  closeUpCut,
} from './brain/presets'
import { appZoom, supportsWebGl2 } from './brain/support'
import { useFitHeight } from './fit'
import {
  FIGURE_COLORS,
  figureFont,
  screenPalette,
  type FigureDpi,
  type FigureWidthMm,
} from '../../figures/style'
import { brainFigurePng } from './brain/brain-export'
import type {
  BrainMode,
  BrainViewer,
  CloseUp,
  ClosePreset,
  CutPlane,
  Hemisphere,
  SurfaceKind,
  SurfaceView,
  TemplateFiles,
} from './brain/viewer'

/** The size of an exported brain figure. */
export interface BrainExportSize {
  widthMm: FigureWidthMm
  dpi: FigureDpi
}

/** The imperative handle of the Brain view. */
export interface BrainViewHandle {
  /** Draw the exported figure as PNG; rejects while nothing is drawn. */
  capturePng(size: BrainExportSize): Promise<Uint8Array>
}

/** The drawn Brain view as the export dialog can include it. */
export interface BrainCapture {
  /** The file stem, named after the view. */
  stem: string
  /** Draw the view's exported figure as PNG. */
  capture(size: BrainExportSize): Promise<Uint8Array>
}

/** Configuration for {@link BrainView}. */
export interface BrainViewProps {
  result: AnyGroupAnalysisResult
  /** The drawn term of a v2 result; its first term when omitted. */
  term?: GroupAnalysisTerm | null | undefined
  /** The drawn term's rows; the result's rows when omitted. */
  rows?: readonly BrainRow[] | undefined
  /** The selected measure ID shared with the other result tabs. */
  selection: string | null
  onSelect: (measureId: string) => void
  /** A subject whose volumes the cut and slice views show instead. */
  subjectId?: string | null | undefined
  ref?: Ref<BrainViewHandle>
  /** Open on the slices of `subjectId`, as "Inspect this subject's brain" asks. */
  openVolumes?: boolean | undefined
  /** Receive the drawn view while it can be captured, and null otherwise. */
  onCapture?: ((capture: BrainCapture | null) => void) | undefined
}

/** The message shown on a display without WebGL2. */
export const NO_WEBGL2_MESSAGE =
  '3D and slice maps need WebGL2, which this display does not provide.'

const TEMPLATE_SOURCE = 'template'
/** The least height of the Brain view, in CSS pixels; a shorter page scrolls. */
const BRAIN_MIN_HEIGHT = 240
/** The slice panel's black, as NiiVue draws outside the head. */
const SLICE_BACKGROUND_RGB = [0, 0, 0] as const
const SLICE_BACKGROUND: [number, number, number] = [0, 0, 0]
/** The caption over the black slices, the dark theme's text in both themes. */
const SLICE_CAPTION = THEMES.dark.text

type LoadPhase =
  | { kind: 'loading' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string }
  /** `present` lists the readable template and labeling-cache assets. */
  | { kind: 'ready'; present: ReadonlySet<string> }
  | { kind: 'lost' }

/** A surface atlas's fsaverage5 drawing, once asked for. */
type AtlasPhase =
  | { kind: 'loading' }
  | { kind: 'missing'; message: string }
  | { kind: 'ready' }

/** The name of the `aparc+aseg` label map in the controls. */
const ASEG_LABELS = 'Desikan-Killiany and aseg'

type VolumePhase =
  | { kind: 'loading' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function hexToUnit(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!match) return [1, 1, 1]
  return [1, 2, 3].map((i) => Number.parseInt(match[i]!, 16) / 255) as [
    number,
    number,
    number,
  ]
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function rgb(color: readonly number[]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`
}

async function readTemplate(
  read: (assetId: BrainAssetId) => Promise<Uint8Array>,
): Promise<TemplateFiles> {
  const ids = FSAVERAGE_ASSET_IDS.filter((id) => id.startsWith('fsaverage5/'))
  const bytes = new Map(
    await Promise.all(ids.map(async (id) => [id, await read(id)] as const)),
  )
  const hemi = (h: Hemisphere): TemplateFiles['surfaces'][Hemisphere] => ({
    pial: bytes.get(`fsaverage5/surf/${h}.pial`)!,
    inflated: bytes.get(`fsaverage5/surf/${h}.inflated`)!,
    sulc: bytes.get(`fsaverage5/surf/${h}.sulc`)!,
    annot: bytes.get(`fsaverage5/label/${h}.aparc.annot`)!,
  })
  return { surfaces: { lh: hemi('lh'), rh: hemi('rh') } }
}

function ControlGroup({
  t,
  label,
  id,
  place = 'above',
  children,
}: {
  t: Theme
  label: string
  id?: string
  /**
   * Where the label shows: above the control, before it, or only to
   * assistive technology when the control names itself (its options or its
   * own accessible name say what it sets).
   */
  place?: 'above' | 'inline' | 'hidden'
  children: ReactNode
}): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: place === 'inline' ? 'row' : 'column',
        alignItems: place === 'inline' ? 'center' : undefined,
        gap: place === 'inline' ? 6 : 3,
      }}
    >
      <span
        id={id}
        style={{
          ...(place === 'hidden' ? VISUALLY_HIDDEN : {}),
          fontSize: 11,
          color: t.dim,
          fontFamily: FONTS.sans,
          letterSpacing: 0.2,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  )
}

function RangeControl({
  t,
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  t: Theme
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (value: number) => void
}): ReactNode {
  const id = useId()
  const shown = `${formatStat(value, 0)}${unit}`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label
        htmlFor={id}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
          fontSize: 11,
          color: t.dim,
          fontFamily: FONTS.sans,
          letterSpacing: 0.2,
        }}
      >
        <span>{label}</span>
        <span
          style={{
            fontFamily: FONTS.sans,
            color: t.text,
          }}
        >
          {shown}
        </span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={shown}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ width: 132, accentColor: t.accent, margin: 0 }}
      />
    </div>
  )
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}

/** The widest the cortical layer select grows, in CSS pixels. */
export const LAYER_SELECT_WIDTH = 260

const selectStyle = (t: Theme): CSSProperties => ({
  height: 'var(--ss-input-h)',
  maxWidth: 260,
  padding: '0 8px',
  border: `1px solid ${t.dim}`,
  borderRadius: 4,
  background: t.bg,
  color: t.text,
  fontFamily: FONTS.sans,
  fontSize: 11.5,
})

function Colorbar({
  t,
  stat,
  limit,
  negative,
  positive,
}: {
  t: Theme
  stat: BrainStat
  limit: number
  negative: string
  positive: string
}): ReactNode {
  const gradient = `linear-gradient(to right, ${DIVERGING_STOPS.map(rgb).join(', ')})`
  const muted = rgb(
    DIVERGING_STOPS[1]!.map((c) =>
      Math.round(c + (CORTEX_GRAY - c) * MUTED_MIX),
    ),
  )
  // The scale and its legend are figure text, so they take the figure serif.
  const text: CSSProperties = {
    fontFamily: figureFont('screen'),
    fontSize: 11,
    color: t.dim,
    whiteSpace: 'nowrap',
  }
  const tick: CSSProperties = {
    fontFamily: figureFont('screen'),
    fontSize: 11,
    color: t.textSoft,
  }
  const swatch = (background: string, outlined: boolean): ReactNode => (
    <span
      style={{
        width: 14,
        height: 10,
        borderRadius: 2,
        background,
        ...(outlined
          ? { boxShadow: `inset 0 0 0 2px ${rgb(SIGNIFICANT_OUTLINE)}` }
          : {}),
      }}
    />
  )
  return (
    <div
      role="img"
      aria-label={`Color scale of ${stat} from ${formatStat(-limit)}, ${lowerFirst(negative)}, to ${formatStat(limit)}, ${lowerFirst(positive)}. Significant regions are outlined; the others are muted.`}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 14,
        rowGap: 4,
      }}
    >
      <span
        aria-hidden="true"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span style={text}>{negative}</span>
        <span style={tick}>{formatStat(-limit)}</span>
        <span
          style={{
            width: 132,
            height: 10,
            borderRadius: 2,
            background: gradient,
            boxShadow: `inset 0 0 0 1px ${t.border}`,
          }}
        />
        <span style={tick}>{formatStat(limit)}</span>
        <span style={text}>{positive}</span>
        <span style={{ ...tick, color: t.dimText }}>
          (<i>{stat}</i>)
        </span>
      </span>
      <span
        aria-hidden="true"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}
      >
        <span
          style={{
            ...text,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          {swatch(rgb(DIVERGING_STOPS[1]!), true)}
          Significant
        </span>
        <span
          style={{
            ...text,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          {swatch(muted, false)}
          Not significant
        </span>
      </span>
    </div>
  )
}

/**
 * Read a surface atlas's fsaverage5 drawing: an annotation per hemisphere,
 * or fsaverage label files combined and subsampled to fsaverage5.
 */
async function readSurfaceAtlas(
  atlasId: string,
  read: (assetId: BrainAssetId) => Promise<Uint8Array>,
): Promise<Record<Hemisphere, Annotation>> {
  const files = surfaceAtlasFiles(atlasId)
  if (!files)
    throw new Error(`${atlasName(atlasId)} has no fsaverage5 drawing.`)
  const hemi = async (h: Hemisphere): Promise<Annotation> => {
    if (files.kind === 'annot') return readAnnotation(await read(files[h]))
    const labels = await Promise.all(
      files[h].map(async (item, index) => ({
        name: item.name,
        // Distinct colors keep neighboring areas apart in the borders.
        rgb: [index + 1, 0, 0] as [number, number, number],
        label: readLabel(await read(item.assetId)),
      })),
    )
    return annotationFromLabels(labels, FSAVERAGE5_VERTEX_COUNT)
  }
  const [lh, rh] = await Promise.all([hemi('lh'), hemi('rh')])
  return { lh, rh }
}

/** The vertex count of fsaverage5, which label sets subsample to. */
const FSAVERAGE5_VERTEX_COUNT = 10_242

/** The surface atlases the DK annotation draws (no file to read). */
const DK_DRAWN = new Set(['dk', 'dkpial', 'gwc'])

/** Render the brain maps of an analysis result. */
export function BrainView({
  result,
  term = null,
  rows: termRows,
  selection,
  onSelect,
  subjectId = null,
  ref,
  onCapture,
  openVolumes = false,
}: BrainViewProps): ReactNode {
  const { t, resolvedTheme, projectRef, setRoute } = useApp()
  const palette = screenPalette(t, resolvedTheme)
  const [webgl2] = useState(supportsWebGl2)
  const [attempt, setAttempt] = useState(0)
  const [mode, setMode] = useState<BrainMode>(
    openVolumes && subjectId ? 'slices' : 'surface',
  )
  const [surface, setSurface] = useState<SurfaceKind>('inflated')
  // Null until the operator picks one: the map's own hemisphere is shown.
  const [hemisphereChoice, setHemisphere] = useState<Hemisphere | null>(null)
  const [view, setView] = useState<SurfaceView>('lateral')
  const [cut, setCut] = useState<CutPlane>(DEFAULT_CUT)
  const [statChoice, setStatChoice] = useState<BrainStat>('d')
  // The first view follows the shared selection into its layer and labels.
  const [layerChoice, setLayerChoice] = useState<string | null>(() =>
    layerKeyForMeasure(selection),
  )
  const [labelChoice, setLabelChoice] = useState<string | null>(() =>
    selection ? measureVolumeSource(selection) : null,
  )
  const [closePreset, setClosePreset] = useState<ClosePreset | null>(null)
  const [source, setSource] = useState<string>(subjectId ?? TEMPLATE_SOURCE)
  const [seen, setSeen] = useState({ selection, subjectId })
  const [subjects, setSubjects] = useState<{
    key: string
    ids: string[]
  } | null>(null)
  const hintId = useId()
  const canvasHost = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<BrainViewer | null>(null)
  const onSelectRef = useRef(onSelect)
  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  const rows: readonly BrainRow[] = termRows ?? result.rows
  const [addedNames, setAddedNames] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  )
  const layers = useMemo(
    () => corticalLayers(rows, addedNames),
    [rows, addedNames],
  )
  const labelSources = useMemo(() => volumeSources(rows), [rows])
  const hasD = useMemo(
    () => rows.some((row) => statValue(row, 'd') !== null),
    [rows],
  )
  const stat: BrainStat = hasD ? statChoice : 't'

  // Follow the shared selection into its cortical layer and label map, and
  // a newly inspected subject into the source, when they change.
  if (seen.selection !== selection || seen.subjectId !== subjectId) {
    const layer = layerKeyForMeasure(selection)
    const labels = selection ? measureVolumeSource(selection) : null
    if (seen.selection !== selection) {
      if (layer && layers.some((item) => item.key === layer)) {
        setLayerChoice(layer)
      }
      if (labels && labels !== 'aseg' && labelSources.includes(labels)) {
        setLabelChoice(labels)
      }
    }
    if (seen.subjectId !== subjectId && subjectId) {
      setSource(subjectId)
      // A subject's brain shows in its volumes; the surfaces are fsaverage.
      if (openVolumes && mode === 'surface') setMode('slices')
    }
    setSeen({ selection, subjectId })
  }
  const labelSource =
    labelChoice && labelSources.includes(labelChoice) ? labelChoice : 'aseg'
  // A label map colors the cortex of its own atlas only: DK in aparc+aseg,
  // Destrieux and DKT in their +aseg volumes, none in the others.
  const shownLayers =
    mode === 'surface'
      ? layers
      : layers.filter(
          (layer) =>
            layer.atlas === (labelSource === 'aseg' ? 'dk' : labelSource),
        )
  const layerKey =
    layerChoice && shownLayers.some((item) => item.key === layerChoice)
      ? layerChoice
      : (shownLayers[0]?.key ?? null)
  const labelFiles = volumeSourceFiles(labelSource)
  const subjectOnly = labelFiles?.subjectOnly ?? false

  const projectKey = projectRef
    ? JSON.stringify([projectRef.projectId, projectRef.root, projectRef.epoch])
    : null
  const loadKey = projectKey ? `${projectKey}:${attempt}` : null
  const [load, setLoad] = useState<{ key: string; phase: LoadPhase } | null>(
    null,
  )
  const phase: LoadPhase =
    load && load.key === loadKey ? load.phase : { kind: 'loading' }
  const present = phase.kind === 'ready' ? phase.present : null

  // FreeSurfer's color table names the labels of atlas label maps; read it
  // once, when such a map is first drawn.
  const needsLut =
    mode !== 'surface' &&
    labelSource !== 'aseg' &&
    volumeSourceNeedsLut(labelSource)
  const [lut, setLut] = useState<{
    key: string
    lut: ColorLut | null
    message: string | null
  } | null>(null)
  const lutReady = lut && lut.key === loadKey ? lut : null
  useEffect(() => {
    if (!projectRef || !loadKey || !needsLut || lutReady || !present) {
      return undefined
    }
    let live = true
    const settle = (value: ColorLut | null, message: string | null): void => {
      if (live) setLut({ key: loadKey, lut: value, message })
    }
    if (!present.has(FREESURFER_LUT_ASSET_ID)) {
      settle(
        null,
        'The FreeSurfer home lacks FreeSurferColorLUT.txt, which names the atlas labels.',
      )
      return undefined
    }
    getApi()
      .brainViewer.readAsset({
        project: projectRef,
        assetId: FREESURFER_LUT_ASSET_ID,
      })
      .then((asset) =>
        settle(parseColorLut(new TextDecoder().decode(asset.data)), null),
      )
      .catch((error: unknown) =>
        settle(
          null,
          errorText(error, 'FreeSurferColorLUT.txt could not be read.'),
        ),
      )
    return () => {
      live = false
    }
  }, [projectRef, loadKey, needsLut, lutReady, present])

  // An added label map brings its own color table, read with its volumes
  // (every subject's copy is the atlas's one table).
  const [table, setTable] = useState<{ key: string; lut: ColorLut } | null>(
    null,
  )
  const tableKey = `${loadKey}:${labelSource}`
  const labelLut = labelFiles?.colorTable
    ? table && table.key === tableKey
      ? table.lut
      : null
    : (lutReady?.lut ?? null)
  const map = useMemo(
    () =>
      buildBrainMap({ rows }, stat, layerKey, selection, {
        sourceId: labelSource,
        lut: labelLut,
      }),
    [rows, stat, layerKey, selection, labelSource, labelLut],
  )
  const unmapped = useMemo(() => unmappedMeasures(rows), [rows])
  // A result without left-hemisphere measures opens on the right, so the
  // first map is not all gray.
  const hemisphere: Hemisphere =
    hemisphereChoice ??
    (map.cortex.lh.size > 0 || map.cortex.rh.size === 0 ? 'lh' : 'rh')
  const hemisphereNote = useMemo(
    () => missingHemisphereNote(rows, map, hemisphere, layers.length),
    [rows, map, hemisphere, layers.length],
  )

  // Name added atlases by their catalog labels.
  const hasAdded = useMemo(
    () => rows.some((row) => /^(?:parc|vol):user-/.test(row.measureId)),
    [rows],
  )
  useEffect(() => {
    if (!projectRef || !hasAdded) return undefined
    let live = true
    getApi()
      .groupAnalysis.atlases({
        project: projectRef,
        reconOutdatedSubjectIds: [],
      })
      .then(
        (catalog) => {
          if (!live) return
          setAddedNames(
            new Map(
              catalog.atlases
                .filter((entry) => entry.origin === 'added')
                .map((entry) => [entry.atlasId, entry.label]),
            ),
          )
        },
        () => undefined,
      )
    return () => {
      live = false
    }
  }, [projectRef, hasAdded])

  // List the analyzed subjects for the volume source picker, once per result.
  const subjectsKey =
    projectKey && phase.kind === 'ready' && mode !== 'surface'
      ? `${projectKey}:${result.resultId}`
      : null
  const firstRow = rows[0]?.measureId ?? null
  const detailTerm =
    result.schemaVersion === 2
      ? (term?.termId ?? result.terms[0]?.termId ?? null)
      : null
  useEffect(() => {
    if (!projectRef || !subjectsKey || !firstRow) return undefined
    let live = true
    const api = getApi().groupAnalysis
    const request = {
      project: projectRef,
      resultId: result.resultId,
      measureId: firstRow,
    }
    ;(detailTerm
      ? api.measureDetail({ ...request, termId: detailTerm })
      : api.measureDetail(request)
    ).then(
      (detail) => {
        if (!live) return
        const ids = [...new Set(detail.subjects.map((s) => s.subjectId))].sort()
        setSubjects({ key: subjectsKey, ids })
      },
      () => {
        if (live) setSubjects({ key: subjectsKey, ids: [] })
      },
    )
    return () => {
      live = false
    }
  }, [projectRef, subjectsKey, firstRow, result.resultId, detailTerm])
  const subjectIds = useMemo(
    () =>
      subjects && subjects.key === subjectsKey
        ? [...new Set([...(subjectId ? [subjectId] : []), ...subjects.ids])]
        : subjectId
          ? [subjectId]
          : [],
    [subjects, subjectsKey, subjectId],
  )

  // A subject-space atlas has no template version: draw it on the chosen
  // subject, or on the first analyzed subject that has its labels.
  const [display, setDisplay] = useState<{
    key: string
    subject: string | null
  } | null>(null)
  const displayKey =
    subjectOnly &&
    source === TEMPLATE_SOURCE &&
    projectKey &&
    subjects?.key === subjectsKey
      ? `${projectKey}:${labelSource}:${subjectIds.join(',')}`
      : null
  useEffect(() => {
    if (!projectRef || !displayKey || !labelFiles) return undefined
    let live = true
    const run = async (): Promise<void> => {
      for (const id of subjectIds.slice(0, 40)) {
        const report = await getApi().brainViewer.assets({
          project: projectRef,
          subjectId: id,
        })
        if (!live) return
        const has = new Set(report.assets.map((asset) => asset.assetId))
        if (
          has.has('subject/mri/brain.mgz') &&
          labelFiles.labels.every((file) => has.has(file.assetId)) &&
          (!labelFiles.colorTable || has.has(labelFiles.colorTable))
        ) {
          setDisplay({ key: displayKey, subject: id })
          return
        }
      }
      if (live) setDisplay({ key: displayKey, subject: null })
    }
    run().catch(() => {
      if (live) setDisplay({ key: displayKey, subject: null })
    })
    return () => {
      live = false
    }
  }, [projectRef, displayKey, labelFiles, subjectIds])
  const displaySubject =
    display && display.key === displayKey ? display.subject : undefined
  const effectiveSource =
    subjectOnly && source === TEMPLATE_SOURCE
      ? (displaySubject ?? null)
      : source

  const volumeKey =
    loadKey &&
    phase.kind === 'ready' &&
    mode !== 'surface' &&
    effectiveSource !== null &&
    (!needsLut || lutReady)
      ? `${loadKey}:${effectiveSource}:${labelSource}`
      : null
  const [volumes, setVolumes] = useState<{
    key: string
    phase: VolumePhase
  } | null>(null)
  let volumePhase: VolumePhase | null =
    mode === 'surface'
      ? null
      : volumeKey === null
        ? { kind: 'loading' }
        : volumes && volumes.key === volumeKey
          ? volumes.phase
          : { kind: 'loading' }
  if (
    mode !== 'surface' &&
    displaySubject === null &&
    subjectOnly &&
    source === TEMPLATE_SOURCE
  ) {
    volumePhase = {
      kind: 'unavailable',
      message: `No analyzed subject has ${atlasName(labelSource, addedNames)} labels yet; label subjects in Choose measures to draw them.`,
    }
  } else if (mode !== 'surface' && needsLut && lutReady && !lutReady.lut) {
    volumePhase = { kind: 'unavailable', message: lutReady.message ?? '' }
  }

  // Create the viewer: check the template, read it, load NiiVue, attach.
  useEffect(() => {
    if (!projectRef || !loadKey || !webgl2) return undefined
    let live = true
    let viewer: BrainViewer | null = null
    const settle = (next: LoadPhase): void => {
      if (live) setLoad({ key: loadKey, phase: next })
    }
    const api = getApi()
    const run = async (): Promise<void> => {
      const report = await api.brainViewer.assets({ project: projectRef })
      if (!live) return
      if (!report.available) {
        settle({
          kind: 'unavailable',
          message:
            report.unavailableReason ?? 'The FreeSurfer template is missing.',
        })
        return
      }
      const files = await readTemplate(async (assetId) => {
        const asset = await api.brainViewer.readAsset({
          project: projectRef,
          assetId,
        })
        return asset.data
      })
      const module = await import('./brain/viewer')
      const host = canvasHost.current
      if (!live || !host) return
      const canvas = host.querySelector('canvas')
      if (!canvas) return
      const created = await module.createBrainViewer(
        canvas,
        {
          onPick: (measureId) => {
            if (live && measureId) onSelectRef.current(measureId)
          },
          onContextLost: () => settle({ kind: 'lost' }),
        },
        window.devicePixelRatio || 1,
      )
      if (!live) {
        created.dispose()
        return
      }
      viewer = created
      created.setTemplate(files)
      viewerRef.current = created
      settle({
        kind: 'ready',
        present: new Set(report.assets.map((asset) => asset.assetId)),
      })
    }
    run().catch((error: unknown) => {
      settle({
        kind: 'error',
        message: errorText(error, 'The brain view could not start.'),
      })
    })
    return () => {
      live = false
      viewer?.dispose()
      if (viewerRef.current === viewer) viewerRef.current = null
    }
  }, [projectRef, loadKey, webgl2])

  // Read the drawn surface atlas's fsaverage5 labels once per viewer.
  const surfaceAtlas = map.surfaceAtlas
  const [atlases, setAtlases] = useState<{
    key: string
    phases: ReadonlyMap<string, AtlasPhase>
  } | null>(null)
  const atlasPhases =
    atlases && atlases.key === loadKey
      ? atlases.phases
      : new Map<string, AtlasPhase>()
  const atlasPhase: AtlasPhase =
    surfaceAtlas === null || DK_DRAWN.has(surfaceAtlas)
      ? { kind: 'ready' }
      : (atlasPhases.get(surfaceAtlas) ?? { kind: 'loading' })
  useEffect(() => {
    if (
      !projectRef ||
      !loadKey ||
      !present ||
      surfaceAtlas === null ||
      DK_DRAWN.has(surfaceAtlas)
    ) {
      return undefined
    }
    const viewer = viewerRef.current
    if (!viewer || viewer.hasSurfaceAtlas(surfaceAtlas)) return undefined
    let live = true
    const settle = (next: AtlasPhase): void => {
      if (!live) return
      setAtlases((prior) => {
        const phases = new Map(
          prior && prior.key === loadKey ? prior.phases : [],
        )
        phases.set(surfaceAtlas, next)
        return { key: loadKey, phases }
      })
    }
    const missing = missingSurfaceAtlas(surfaceAtlas, present)
    if (missing) {
      settle({ kind: 'missing', message: missing })
      return undefined
    }
    settle({ kind: 'loading' })
    readSurfaceAtlas(
      surfaceAtlas,
      async (assetId) =>
        (await getApi().brainViewer.readAsset({ project: projectRef, assetId }))
          .data,
    )
      .then((annotations) => {
        if (!live) return
        viewer.setSurfaceAtlas(
          surfaceAtlas,
          atlasRules(surfaceAtlas),
          annotations,
        )
        settle({ kind: 'ready' })
      })
      .catch((error: unknown) =>
        settle({
          kind: 'missing',
          message: errorText(
            error,
            `${atlasName(surfaceAtlas)} could not be read.`,
          ),
        }),
      )
    return () => {
      live = false
    }
  }, [projectRef, loadKey, present, surfaceAtlas])

  // Read the volumes the cut and slice views need, from the template or the
  // chosen subject, and the drawn atlas's label map.
  const baseLoaded = useRef<string | null>(null)
  useEffect(() => {
    if (!projectRef || !volumeKey || effectiveSource === null) return undefined
    const viewer = viewerRef.current
    if (!viewer) return undefined
    let live = true
    const settle = (next: VolumePhase): void => {
      if (live) setVolumes({ key: volumeKey, phase: next })
    }
    const api = getApi()
    const subject = effectiveSource === TEMPLATE_SOURCE ? null : effectiveSource
    const baseKey = `${loadKey}:${effectiveSource}`
    const run = async (): Promise<void> => {
      const read = async (assetId: BrainAssetId): Promise<Uint8Array> =>
        (
          await api.brainViewer.readAsset(
            subject
              ? { project: projectRef, assetId, subjectId: subject }
              : { project: projectRef, assetId },
          )
        ).data
      const atlasFiles =
        labelSource === 'aseg' ? [] : (labelFiles?.labels ?? [])
      const colorTable = labelFiles?.colorTable ?? null
      if (subject) {
        const report = await api.brainViewer.assets({
          project: projectRef,
          subjectId: subject,
        })
        const has = new Set(report.assets.map((asset) => asset.assetId))
        if (
          !has.has('subject/mri/brain.mgz') ||
          !has.has('subject/mri/aparc+aseg.mgz')
        ) {
          settle({
            kind: 'unavailable',
            message: `The FreeSurfer volumes of ${subject} are missing; run reconstruction for this subject.`,
          })
          return
        }
        if (
          !atlasFiles.every((file) => has.has(file.assetId)) ||
          (colorTable !== null && !has.has(colorTable))
        ) {
          settle({
            kind: 'unavailable',
            message: `${subject} has no ${atlasName(labelSource, addedNames)} labels; choose a labeled subject or label it in Choose measures.`,
          })
          return
        }
      }
      if (baseLoaded.current !== baseKey || !viewer.hasVolumes()) {
        const [brain, labels] = await Promise.all(
          subject
            ? [
                read('subject/mri/brain.mgz'),
                read('subject/mri/aparc+aseg.mgz'),
              ]
            : [
                read('fsaverage/mri/brain.mgz'),
                read('fsaverage/mri/aparc+aseg.mgz'),
              ],
        )
        if (!live) return
        await viewer.setVolumes({ brain, labels })
        baseLoaded.current = baseKey
      }
      const [maps, tableText] = await Promise.all([
        Promise.all(
          atlasFiles.map(async (file) => ({
            bytes: await read(file.assetId),
            hemisphere: file.hemisphere,
          })),
        ),
        colorTable
          ? read(colorTable).then((bytes) => new TextDecoder().decode(bytes))
          : null,
      ])
      if (!live) return
      if (tableText !== null) {
        setTable({ key: tableKey, lut: parseColorLut(tableText) })
      }
      await viewer.setLabelMap(labelSource, maps.length > 0 ? maps : null)
      settle({ kind: 'ready' })
    }
    run().catch((error: unknown) => {
      baseLoaded.current = null
      settle({
        kind: 'error',
        message: errorText(error, 'The brain volumes could not be read.'),
      })
    })
    return () => {
      live = false
    }
    // The `labelFiles` and `addedNames` values follow `labelSource`, which
    // the key holds.
  }, [projectRef, volumeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Place a close-up on the loaded volumes, and again when they change.
  const volumesReady = mode === 'surface' || volumePhase?.kind === 'ready'
  const closeHemisphere: Hemisphere = (() => {
    const parsed = selection ? parseMeasureId(selection) : null
    const side = parsed && 'hemisphere' in parsed ? parsed.hemisphere : null
    return side === 'lh' || side === 'rh' ? side : hemisphere
  })()
  const closeKey =
    closePreset && volumeKey && volumePhase?.kind === 'ready'
      ? `${volumeKey}:${closePreset}:${closeHemisphere}`
      : null
  const [close, setClose] = useState<{
    key: string
    closeUp: CloseUp | null
  } | null>(null)
  useEffect(() => {
    if (!closeKey || !closePreset) return
    const viewer = viewerRef.current
    if (!viewer) return
    const made = viewer.closeUp(closePreset, closeHemisphere)
    setClose({ key: closeKey, closeUp: made })
    if (made) {
      setCut(
        viewer.cutThrough(
          closeUpCut(closePreset, closeHemisphere),
          made.centerMm,
        ),
      )
    }
  }, [closeKey, closePreset, closeHemisphere])
  const closeUp = close && close.key === closeKey ? close.closeUp : null
  const closeMissing =
    closePreset !== null &&
    close !== null &&
    close.key === closeKey &&
    closeUp === null

  // Slices draw on black like any MRI viewer, so their panel is black edge
  // to edge in both themes; the 3D views sit on the theme surface, like the
  // other figures, and an export draws them on the print paper.
  const slicePanel = mode === 'slices'
  const background = useMemo(
    () => (slicePanel ? SLICE_BACKGROUND : hexToUnit(palette.paper)),
    [slicePanel, palette.paper],
  )
  const exportBackground = useMemo(
    () => (slicePanel ? SLICE_BACKGROUND : hexToUnit(FIGURE_COLORS.paper)),
    [slicePanel],
  )
  const panelColor = slicePanel ? rgb(SLICE_BACKGROUND_RGB) : palette.paper
  // The view takes the height left on the page, so the canvas and the color
  // scale show without scrolling.
  const [fitHeight, fitRef] = useFitHeight(BRAIN_MIN_HEIGHT)
  const zoom = appZoom()
  const surfaceDrawable = atlasPhase.kind !== 'loading'
  useEffect(() => {
    const viewer = viewerRef.current
    if (
      phase.kind !== 'ready' ||
      !viewer ||
      !volumesReady ||
      !surfaceDrawable
    ) {
      return
    }
    viewer.apply(
      {
        mode,
        surface,
        hemisphere,
        view,
        cut,
        background,
        closeUp: mode === 'surface' ? null : closeUp,
      },
      map,
      selection,
    )
  }, [
    phase.kind,
    volumesReady,
    surfaceDrawable,
    mode,
    surface,
    hemisphere,
    view,
    cut,
    background,
    closeUp,
    map,
    selection,
  ])

  // Offer the drawn view to the export dialog while it can be captured.
  const onCaptureRef = useRef(onCapture)
  useEffect(() => {
    onCaptureRef.current = onCapture
  }, [onCapture])
  const drawing = phase.kind === 'ready' && volumesReady && surfaceDrawable
  const subjectShown =
    mode !== 'surface' &&
    effectiveSource !== null &&
    effectiveSource !== TEMPLATE_SOURCE
  const labelName =
    labelSource === 'aseg' ? null : atlasName(labelSource, addedNames)
  const description = {
    mode,
    stat,
    layerKey,
    surface,
    hemisphere,
    view,
    cut,
    subject: effectiveSource !== TEMPLATE_SOURCE,
    labelMap: labelSource,
    closeUp: mode === 'surface' ? null : (closeUp?.preset ?? null),
  }
  const stem = brainViewStem(description)
  const viewCaption = brainViewCaption(
    description,
    layers.find((layer) => layer.key === layerKey)?.label ?? null,
    labelName,
  )
  const text = useMemo(
    () => brainResultText(result, term, rows.length),
    [result, term, rows.length],
  )
  const { negative, positive } = text
  // The latest export inputs, read when an export asks for the figure.
  const exportRef = useRef({
    background: exportBackground,
    caption: viewCaption,
    limit: map.limit,
    mode,
    stat,
    stem,
    text,
    name: result.name,
  })
  useEffect(() => {
    exportRef.current = {
      background: exportBackground,
      caption: viewCaption,
      limit: map.limit,
      mode,
      stat,
      stem,
      text,
      name: result.name,
    }
  })
  const exportFigure = useCallback(
    (size: BrainExportSize): Promise<Uint8Array> => {
      const viewer = viewerRef.current
      if (!viewer) {
        return Promise.reject(new Error('The brain view is not drawing.'))
      }
      const inputs = exportRef.current
      return brainFigurePng(
        (draw) => viewer.renderFrames(inputs.background, draw),
        {
          background: inputs.background,
          widthMm: size.widthMm,
          dpi: size.dpi,
          lines: [
            inputs.text.contrast,
            [inputs.caption],
            inputs.text.correction,
          ],
          scale: {
            stat: inputs.stat,
            limit: inputs.limit,
            negative: inputs.text.negative,
            positive: inputs.text.positive,
          },
          title: `Brain map: ${inputs.name}`,
          summary: `${inputs.caption}. Colored by ${inputs.stat} from ${formatStat(-inputs.limit)} to ${formatStat(inputs.limit)}.`,
          // The volume render's ray jitter grains at print size; render the
          // cut at twice the resolution and scale it down.
          supersample: inputs.mode === 'cut' ? 2 : 1,
        },
      )
    },
    [],
  )
  useEffect(() => {
    const report = onCaptureRef.current
    if (!report || !drawing) return undefined
    report({ stem, capture: exportFigure })
    return () => report(null)
  }, [drawing, stem, exportFigure])

  useImperativeHandle(
    ref,
    () => ({
      capturePng: (size) =>
        phase.kind === 'ready'
          ? exportFigure(size)
          : Promise.reject(new Error('The brain view is not drawing.')),
    }),
    [phase.kind, exportFigure],
  )

  const onCanvasKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // Keep every key away from NiiVue's own shortcuts; Tab still moves focus.
      if (event.key === 'Tab') return
      event.stopPropagation()
      const viewer = viewerRef.current
      if (!viewer || phase.kind !== 'ready') return
      const step = event.shiftKey ? 45 : 15
      const moves: Record<string, [number, number, number]> =
        mode === 'slices'
          ? {
              ArrowLeft: [-1, 0, 0],
              ArrowRight: [1, 0, 0],
              ArrowUp: [0, 0, 1],
              ArrowDown: [0, 0, -1],
              PageUp: [0, 1, 0],
              PageDown: [0, -1, 0],
            }
          : {
              ArrowLeft: [-step, 0, 0],
              ArrowRight: [step, 0, 0],
              ArrowUp: [0, step, 0],
              ArrowDown: [0, -step, 0],
            }
      const move = moves[event.key]
      if (move) {
        event.preventDefault()
        if (mode === 'slices') viewer.moveCrosshair(move[0], move[1], move[2])
        else viewer.rotate(move[0], move[1])
      }
    },
    [mode, phase.kind],
  )

  const selectedRow = selection
    ? rows.find((row) => row.measureId === selection)
    : undefined
  const selectedValue = selectedRow ? statValue(selectedRow, stat) : null
  const selectedMapped =
    selection !== null &&
    (mode === 'surface'
      ? [...map.cortex.lh.values(), ...map.cortex.rh.values()].some(
          (m) => m.measureId === selection,
        )
      : [...map.labels.values()].some((m) => m.measureId === selection))
  const caption = !selectedRow
    ? mode === 'slices'
      ? 'Click a region to select its measure.'
      : 'Drag to rotate; click a region to select its measure.'
    : selectedMapped && selectedValue !== null
      ? `${measureLabel(selectedRow.measureId)}: ${stat} ${formatStat(selectedValue)}, ${selectedRow.significant ? 'significant' : 'not significant'}.`
      : `${measureLabel(selectedRow.measureId)} is not drawn on this map.`
  const notes = [
    mode === 'surface' && atlasPhase.kind === 'missing'
      ? atlasPhase.message
      : null,
    mode === 'surface' &&
    view !== 'dorsal' &&
    view !== 'ventral' &&
    atlasPhase.kind === 'ready'
      ? hemisphereNote
      : null,
    mode !== 'surface' && closeMissing && closePreset
      ? `The drawn volumes have no ${CLOSE_STRUCTURE[closePreset]} label.`
      : null,
  ].filter((note): note is string => note !== null)

  if (!webgl2) {
    return (
      <div role="status" style={messageStyle(t)}>
        {NO_WEBGL2_MESSAGE}
      </div>
    )
  }

  const toolbar = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
        flexShrink: 0,
        columnGap: 10,
        rowGap: 8,
      }}
    >
      <ControlGroup t={t} label="Show" place="hidden">
        <Segments
          t={t}
          small
          ariaLabel="Brain view"
          value={mode}
          options={[
            { value: 'surface', label: 'Surface' },
            { value: 'cut', label: 'Cut' },
            { value: 'slices', label: 'Slices' },
          ]}
          onChange={(value) => setMode(value as BrainMode)}
        />
      </ControlGroup>
      <ControlGroup t={t} label="Color by" place="inline">
        <Segments
          t={t}
          small
          ariaLabel="Color by statistic"
          value={stat}
          options={[
            { value: 'd', label: 'd' },
            { value: 't', label: 't' },
          ]}
          disabledOptions={hasD ? undefined : ['d']}
          onChange={(value) => setStatChoice(value as BrainStat)}
        />
      </ControlGroup>
      {shownLayers.length > 0 ? (
        <ControlGroup t={t} label="Cortex" place="hidden">
          <select
            aria-label="Cortical measure"
            value={layerKey ?? ''}
            onChange={(event) => setLayerChoice(event.target.value)}
            // Atlas layer names run long; the select shows a typical name
            // in full, the toolbar wraps when the row runs short, and the
            // title carries the whole name.
            title={shownLayers.find((layer) => layer.key === layerKey)?.label}
            style={{ ...selectStyle(t), maxWidth: LAYER_SELECT_WIDTH }}
          >
            {shownLayers.map((layer) => (
              <option key={layer.key} value={layer.key}>
                {layer.label}
              </option>
            ))}
          </select>
        </ControlGroup>
      ) : null}
      {mode === 'surface' ? (
        <>
          <ControlGroup t={t} label="Surface" place="hidden">
            <Segments
              t={t}
              small
              ariaLabel="Surface"
              value={surface}
              options={[
                { value: 'pial', label: 'Pial' },
                { value: 'inflated', label: 'Inflated' },
              ]}
              onChange={(value) => setSurface(value as SurfaceKind)}
            />
          </ControlGroup>
          <ControlGroup t={t} label="Hemisphere" place="hidden">
            <Segments
              t={t}
              small
              ariaLabel="Hemisphere"
              value={hemisphere}
              options={[
                { value: 'lh', label: 'Left' },
                { value: 'rh', label: 'Right' },
              ]}
              disabledOptions={
                view === 'dorsal' || view === 'ventral'
                  ? ['lh', 'rh']
                  : undefined
              }
              onChange={(value) => setHemisphere(value as Hemisphere)}
            />
          </ControlGroup>
          <ControlGroup t={t} label="View" place="hidden">
            <Segments
              t={t}
              small
              ariaLabel="View"
              value={view}
              options={[
                { value: 'lateral', label: 'Lateral' },
                { value: 'medial', label: 'Medial' },
                { value: 'dorsal', label: 'Dorsal' },
                { value: 'ventral', label: 'Ventral' },
              ]}
              onChange={(value) => setView(value as SurfaceView)}
            />
          </ControlGroup>
        </>
      ) : (
        <>
          {labelSources.length > 1 ? (
            <ControlGroup t={t} label="Labels" place="hidden">
              <select
                aria-label="Label map"
                value={labelSource}
                onChange={(event) => setLabelChoice(event.target.value)}
                style={selectStyle(t)}
              >
                {labelSources.map((id) => (
                  <option key={id} value={id}>
                    {id === 'aseg' ? ASEG_LABELS : atlasName(id, addedNames)}
                  </option>
                ))}
              </select>
            </ControlGroup>
          ) : null}
          <ControlGroup t={t} label="Volumes" place="hidden">
            <select
              aria-label={subjectOnly ? 'Display subject' : 'Volume source'}
              value={effectiveSource ?? TEMPLATE_SOURCE}
              onChange={(event) => setSource(event.target.value)}
              style={selectStyle(t)}
            >
              <option value={TEMPLATE_SOURCE} disabled={subjectOnly}>
                fsaverage template
              </option>
              {subjectIds.map((id) => (
                <option key={id} value={id}>
                  Subject {id}
                </option>
              ))}
            </select>
          </ControlGroup>
          <ControlGroup t={t} label="Close-up" place="hidden">
            <select
              aria-label="Close-up"
              value={closePreset ?? ''}
              onChange={(event) => {
                if (event.target.value === '') {
                  // The whole brain opens on the first cut again.
                  setClosePreset(null)
                  setCut(DEFAULT_CUT)
                } else {
                  setClosePreset(event.target.value as ClosePreset)
                }
              }}
              style={selectStyle(t)}
            >
              <option value="">Whole brain</option>
              {CLOSE_UPS.map((item) => (
                <option key={item.preset} value={item.preset}>
                  {item.label}
                </option>
              ))}
            </select>
          </ControlGroup>
        </>
      )}
      {mode === 'cut' ? (
        <>
          <RangeControl
            t={t}
            label="Cut depth"
            value={cut.depthMm}
            min={-80}
            max={80}
            step={1}
            unit=" mm"
            onChange={(depthMm) => setCut((c) => ({ ...c, depthMm }))}
          />
          <RangeControl
            t={t}
            label="View azimuth"
            value={cut.azimuth}
            min={0}
            max={355}
            step={5}
            unit={'\u00b0'}
            onChange={(azimuth) => setCut((c) => ({ ...c, azimuth }))}
          />
          <RangeControl
            t={t}
            label="View elevation"
            value={cut.elevation}
            min={-90}
            max={90}
            step={5}
            unit={'\u00b0'}
            onChange={(elevation) => setCut((c) => ({ ...c, elevation }))}
          />
        </>
      ) : null}
    </div>
  )

  let overlay: ReactNode = null
  if (phase.kind === 'loading') {
    overlay = (
      <LoadingState t={t} block label="Reading the fsaverage template" />
    )
  } else if (phase.kind === 'unavailable') {
    overlay = (
      <div style={{ ...messageStyle(t), border: 'none' }}>
        <span>{phase.message}</span>
        <Btn
          t={t}
          small
          label="Open Diagnostics"
          onClick={() => setRoute('diagnostics')}
        />
      </div>
    )
  } else if (phase.kind === 'error') {
    overlay = (
      <ErrorState
        t={t}
        title={phase.message}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    )
  } else if (phase.kind === 'lost') {
    overlay = (
      <ErrorState
        t={t}
        title="The 3D view lost its graphics context."
        retryLabel="Reload the view"
        onRetry={() => setAttempt((value) => value + 1)}
      />
    )
  } else if (mode === 'surface' && atlasPhase.kind === 'loading') {
    overlay = (
      <LoadingState
        t={t}
        block
        label={`Reading the ${atlasName(surfaceAtlas ?? 'dk', addedNames)} labels`}
      />
    )
  } else if (volumePhase?.kind === 'loading') {
    overlay = (
      <LoadingState
        t={t}
        block
        label={
          effectiveSource === TEMPLATE_SOURCE
            ? 'Reading the fsaverage volumes'
            : effectiveSource === null
              ? 'Finding a subject with these labels'
              : `Reading the volumes of ${effectiveSource}`
        }
      />
    )
  } else if (
    volumePhase?.kind === 'unavailable' ||
    volumePhase?.kind === 'error'
  ) {
    overlay = (
      <div role="alert" style={{ ...messageStyle(t), border: 'none' }}>
        {volumePhase.message}
      </div>
    )
  }

  return (
    <section
      ref={fitRef}
      aria-label="Brain map"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        height: fitHeight ?? undefined,
        minHeight: BRAIN_MIN_HEIGHT,
      }}
    >
      {toolbar}
      <div
        onKeyDownCapture={onCanvasKey}
        onKeyUpCapture={(event) => {
          if (event.key !== 'Tab') event.stopPropagation()
        }}
        style={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 140,
          borderRadius: 5,
          border: `1px solid ${t.border}`,
          background: panelColor,
          overflow: 'hidden',
        }}
      >
        <div
          ref={canvasHost}
          style={{
            position: 'absolute',
            inset: 0,
            // Undo the "Larger text" zoom of the app root inside the canvas
            // host: NiiVue maps pointer offsets with the device pixel ratio
            // alone, which a zoomed ancestor would skew. Percentages resolve
            // against the frame before this zoom applies.
            zoom: 1 / zoom,
            background: panelColor,
            visibility: overlay ? 'hidden' : 'visible',
          }}
        >
          <canvas
            key={loadKey ?? 'none'}
            role="application"
            aria-roledescription="brain view"
            aria-label={`Brain map of ${stat} by region`}
            aria-describedby={hintId}
            tabIndex={0}
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              outlineOffset: -2,
            }}
          />
        </div>
        <p
          aria-live="polite"
          style={{
            // The caption sits in the canvas's top corner, which the
            // centered drawing leaves free, so the canvas keeps the height.
            position: 'absolute',
            top: 6,
            left: 8,
            maxWidth: 'min(60%, 420px)',
            margin: 0,
            padding: '2px 6px',
            borderRadius: 3,
            background: `color-mix(in srgb, ${panelColor} 85%, transparent)`,
            pointerEvents: 'none',
            visibility: overlay ? 'hidden' : 'visible',
            fontFamily: FONTS.sans,
            fontSize: 12,
            lineHeight: 1.4,
            color: slicePanel
              ? SLICE_CAPTION
              : selectedRow
                ? palette.ink
                : palette.muted,
          }}
        >
          {notes.map((note) => (
            <span key={note} style={{ display: 'block' }}>
              {note}
            </span>
          ))}
          {caption}
        </p>
        {overlay ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 12,
              background: t.surface,
            }}
          >
            {overlay}
          </div>
        ) : null}
      </div>
      <span id={hintId} style={VISUALLY_HIDDEN}>
        {mode === 'slices'
          ? 'Click a region to select its measure. Arrow keys and Page Up or Page Down move the slices.'
          : 'Drag to rotate and click a region to select its measure. Arrow keys rotate the view.'}
      </span>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          columnGap: 16,
          rowGap: 4,
          flexShrink: 0,
        }}
      >
        <Colorbar
          t={t}
          stat={stat}
          limit={map.limit}
          negative={negative}
          positive={positive}
        />
        {subjectShown ? (
          <p
            style={{
              margin: 0,
              fontFamily: FONTS.sans,
              fontSize: 11,
              color: t.textSoft,
            }}
          >
            Labels drawn on {effectiveSource}; colors are group statistics.
          </p>
        ) : null}
        {unmapped.length > 0 ? (
          <p
            style={{
              margin: 0,
              flex: '1 1 200px',
              fontFamily: FONTS.sans,
              fontSize: 11,
              color: t.dimText,
            }}
          >
            Not on the map: {unmapped.join(', ')}.
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** The structure each close-up centers on, for its missing-label note. */
const CLOSE_STRUCTURE: Readonly<Record<ClosePreset, string>> = {
  brainstem: 'brainstem',
  thalamus: 'thalamus',
  hippocampus: 'hippocampus or amygdala',
}

/**
 * Say why the shown hemisphere is gray: the result has no measure of it,
 * or the chosen cortical layer has none.
 *
 * @returns The sentence, or null when the hemisphere has values.
 */
function missingHemisphereNote(
  rows: readonly BrainRow[],
  map: { cortex: Record<Hemisphere, Map<string, unknown>> },
  hemisphere: Hemisphere,
  layerCount: number,
): string | null {
  if (map.cortex[hemisphere].size > 0) return null
  if (layerCount === 0) return 'No cortical measure is in this result.'
  const side = hemisphere === 'lh' ? 'left' : 'right'
  const inResult = rows.some((row) => {
    const parsed = parseMeasureId(row.measureId)
    return (
      (parsed?.source === 'dk' || parsed?.source === 'parc') &&
      (parsed.hemisphere === hemisphere || parsed.hemisphere === 'bi')
    )
  })
  return inResult
    ? `No ${side}-hemisphere measure is on this cortical layer.`
    : `No ${side}-hemisphere measure is in this result.`
}

function messageStyle(t: Theme): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: 'calc(var(--ss-card-pad) * 2)',
    border: `1px solid ${t.border}`,
    borderRadius: 5,
    color: t.textSoft,
    fontFamily: FONTS.sans,
    fontSize: 12,
    textAlign: 'center',
  }
}
