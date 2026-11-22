/**
 * The measure sources of the measure picker, grouped by tier: the pipeline
 * tables, each subject's FreeSurfer stats (tier A), atlases labeled on
 * demand (tier B), and atlases the operator added. Each source knows which
 * catalog measures belong to it and the facts of its atlas: how many
 * subjects have its files or labels and how many recons are out of date.
 */

import type { AtlasCatalog, AtlasEntry } from '../../../shared/atlas-labeling'
import {
  PARC_METRICS,
  parseMeasureId,
  type GroupAnalysisCatalog,
  type ParcMetric,
} from '../../../shared/group-analysis'

/** The tiers the picker groups sources by. */
export type SourceTier = 'pipeline' | 'stats' | 'labeled' | 'added'

/** The tier headings. */
export const TIER_TEXT: Readonly<Record<SourceTier, string>> = {
  pipeline: 'Pipeline tables',
  stats: "Each subject's FreeSurfer stats",
  labeled: 'Labeled on demand',
  added: 'Added atlases',
}

/** A hemisphere filter of the picker. */
export type HemiFilter = 'lh' | 'rh' | 'bi' | 'mid'

/** One source of measures. */
export interface MeasureSourceOption {
  /** `dk`, `aseg`, `global`, `brainage`, or an atlas ID. */
  id: string
  label: string
  /** A lowercase name for counts, for example "cortical". */
  short: string
  tier: SourceTier
  namespace: 'dk' | 'aseg' | 'global' | 'brainage' | 'parc' | 'vol'
  /** The atlas facts, when the atlas catalog lists the source. */
  entry: AtlasEntry | null
  /** The surface metrics its measures use; empty for volumes. */
  metrics: ParcMetric[]
  /** The hemisphere filters its measures use. */
  hemis: HemiFilter[]
}

const PIPELINE: readonly {
  id: 'dk' | 'aseg' | 'global' | 'brainage'
  label: string
  short: string
  atlasId: string | null
}[] = [
  {
    id: 'dk',
    label: 'Desikan-Killiany (cortical)',
    short: 'cortical',
    atlasId: 'dk',
  },
  {
    id: 'aseg',
    label: 'Subcortical (aseg)',
    short: 'subcortical',
    atlasId: 'aseg',
  },
  {
    id: 'global',
    label: 'Whole-brain measures',
    short: 'whole-brain',
    atlasId: 'aseg-global',
  },
  { id: 'brainage', label: 'Brain-PAD', short: 'Brain-PAD', atlasId: null },
]

/**
 * Give the hemisphere filter of a measure.
 *
 * @returns The filter, or null for whole-brain measures.
 */
export function measureHemi(id: string): HemiFilter | null {
  const parsed = parseMeasureId(id)
  if (!parsed) return null
  switch (parsed.source) {
    case 'dk':
    case 'parc':
      return parsed.hemisphere
    case 'vol':
      return parsed.hemisphere
    case 'aseg':
      if (parsed.hemisphere === 'bi') return 'bi'
      if (parsed.structure.startsWith('Left-')) return 'lh'
      if (parsed.structure.startsWith('Right-')) return 'rh'
      return 'mid'
    default:
      return null
  }
}

/**
 * Give the source ID a measure belongs to.
 *
 * @returns The source ID, or null for an invalid ID.
 */
export function measureSourceId(id: string): string | null {
  const parsed = parseMeasureId(id)
  if (!parsed) return null
  return parsed.source === 'parc' || parsed.source === 'vol'
    ? parsed.atlas
    : parsed.source
}

function tierOf(entry: AtlasEntry): SourceTier {
  if (entry.origin === 'added') return 'added'
  if (entry.tier === 'B') return 'labeled'
  return entry.origin === 'pipeline' ? 'pipeline' : 'stats'
}

const HEMI_ORDER: readonly HemiFilter[] = ['bi', 'lh', 'rh', 'mid']

/**
 * List the measure sources: the pipeline tables first, then every atlas of
 * the atlas catalog by tier, then any atlas the measure catalog has that
 * the atlas catalog does not list (as when it could not be read).
 *
 * @returns The sources in picker order.
 */
export function measureSources(
  catalog: GroupAnalysisCatalog,
  atlases: AtlasCatalog | null,
): MeasureSourceOption[] {
  const metrics = new Map<string, Set<ParcMetric>>()
  const hemis = new Map<string, Set<HemiFilter>>()
  for (const measure of catalog.measures) {
    const parsed = parseMeasureId(measure.measureId)
    const source = measureSourceId(measure.measureId)
    if (!parsed || !source) continue
    if (parsed.source === 'dk' || parsed.source === 'parc') {
      const set = metrics.get(source) ?? new Set()
      set.add(parsed.metric)
      metrics.set(source, set)
    }
    const hemi = measureHemi(measure.measureId)
    if (hemi) {
      const set = hemis.get(source) ?? new Set()
      set.add(hemi)
      hemis.set(source, set)
    }
  }
  const entries = new Map(
    (atlases?.atlases ?? []).map((entry) => [entry.atlasId, entry]),
  )
  const option = (
    id: string,
    label: string,
    short: string,
    tier: SourceTier,
    namespace: MeasureSourceOption['namespace'],
    entry: AtlasEntry | null,
  ): MeasureSourceOption => ({
    id,
    label,
    short,
    tier,
    namespace,
    entry,
    metrics: PARC_METRICS.filter((metric) => metrics.get(id)?.has(metric)),
    hemis: HEMI_ORDER.filter((hemi) => hemis.get(id)?.has(hemi)),
  })
  const sources: MeasureSourceOption[] = PIPELINE.map((item) =>
    option(
      item.id,
      item.label,
      item.short,
      'pipeline',
      item.id,
      item.atlasId ? (entries.get(item.atlasId) ?? null) : null,
    ),
  )
  const listed = new Set(['dk', 'aseg', 'aseg-global'])
  const rest: MeasureSourceOption[] = []
  for (const entry of atlases?.atlases ?? []) {
    if (listed.has(entry.atlasId)) continue
    listed.add(entry.atlasId)
    const namespace = entry.namespace === 'parc' ? 'parc' : 'vol'
    rest.push(
      option(
        entry.atlasId,
        entry.label,
        entry.label,
        tierOf(entry),
        namespace,
        entry,
      ),
    )
  }
  for (const measure of catalog.measures) {
    const parsed = parseMeasureId(measure.measureId)
    if (!parsed || (parsed.source !== 'parc' && parsed.source !== 'vol'))
      continue
    if (listed.has(parsed.atlas)) continue
    listed.add(parsed.atlas)
    rest.push(
      option(
        parsed.atlas,
        parsed.atlas,
        parsed.atlas,
        'stats',
        parsed.source,
        null,
      ),
    )
  }
  const order: SourceTier[] = ['stats', 'labeled', 'added']
  return [
    ...sources,
    ...order.flatMap((tier) => rest.filter((item) => item.tier === tier)),
  ]
}

/**
 * Say how far a source's atlas reaches the subjects, for example "82 of 82
 * subjects have the stats files; 1 recon out of date." or "20 of 82
 * labeled, 2 out of date, 1 failed."
 */
export function sourceFactsText(entry: AtlasEntry): string {
  const { counts } = entry
  const recon =
    counts.reconOutdated > 0
      ? `; ${counts.reconOutdated} ${counts.reconOutdated === 1 ? 'recon' : 'recons'} out of date`
      : ''
  if (entry.tier === 'A') {
    return `${counts.withFiles} of ${counts.total} subjects have the stats files${recon}.`
  }
  const extra = [
    counts.stale > 0 ? `${counts.stale} out of date` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
  ].filter(Boolean)
  const found =
    counts.withFiles > 0
      ? `; ${counts.withFiles} ${counts.withFiles === 1 ? 'recon has' : 'recons have'} the outputs already`
      : ''
  return `${counts.labeled} of ${counts.total} subjects labeled${extra.length > 0 ? `, ${extra.join(', ')}` : ''}${found}${recon}.`
}

/** Give the option text of a source, with its reach in parentheses. */
export function sourceOptionText(source: MeasureSourceOption): string {
  const entry = source.entry
  if (!entry || source.tier === 'pipeline') return source.label
  if (entry.tier === 'A') {
    return `${source.label} (${entry.counts.withFiles} of ${entry.counts.total})`
  }
  return `${source.label} (${entry.counts.labeled + entry.counts.withFiles} of ${entry.counts.total})`
}

/** Format seconds as a duration, for example "about 14 h" or "about 9 min". */
export function durationText(seconds: number): string {
  if (seconds < 90) return 'about 1 min'
  if (seconds < 90 * 60) return `about ${Math.round(seconds / 60)} min`
  const hours = seconds / 3600
  return `about ${hours < 10 ? hours.toFixed(1).replace(/\.0$/, '') : Math.round(hours)} h`
}
