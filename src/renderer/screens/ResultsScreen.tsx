import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type {
  ArtifactImagePreview,
  ResultAnalysisCohortChange,
  ResultArtifact,
  ResultPage,
} from '../../shared/contract'
import {
  executionFallbackDetail,
  executionFallbackFact,
} from '../../shared/execution-fallback'
import { unitReuseFact } from '../../shared/unit-reuse'
import type { ProjectConfig } from '../../shared/project-schema'
import type { StepKey } from '../../shared/steps'
import type { RunManifest, Subject, ToolStatus } from '../../shared/types'
import type { ProjectRef } from '../../shared/types'
import {
  PIPELINE_STEPS_IN_DISPLAY_ORDER,
  pipelineStep,
} from '../../shared/steps'
import { getApi } from '../state/api'
import { useApp } from '../state/context'
import { manifestRunLabel, manifestRunPhrase } from '../state/run-label'
import {
  cohortCurrencyNotice,
  outdatedCohortStages,
} from '../state/stage-currency'
import {
  Btn,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  FONTS,
  FreshnessStamp,
  Hint,
  InlineCode,
  LoadingState,
  Page,
  RefreshButton,
  StateLine,
  TEXT_GAP,
  TextInput,
  TextPill,
  NoticeGlyph,
} from '../ui'

/** Project and artifact focus state for Results. */
export interface ResultsScreenProps {
  cfg?: ProjectConfig
  subjects?: Subject[]
  toolStatus?: ToolStatus | null
  refresh?: () => void
  focusStepKey?: StepKey
}

function auditTime(value: number | null): string {
  return value === null ? 'not recorded' : new Date(value).toLocaleString()
}

/** Audit values that are words, not digests or IDs, and so read in sans. */
const AUDIT_WORDS: ReadonlySet<unknown> = new Set(['not recorded', 'none'])

/**
 * Render audit rows. Digests and IDs are set in mono; a row marked as prose,
 * such as a check verdict or a time, and an absent value read in sans.
 */
function AuditGrid({
  rows,
}: {
  rows: Array<[label: string, value: ReactNode, prose?: boolean]>
}): ReactNode {
  const { t } = useApp()
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'max-content minmax(0, 1fr)',
        gap: '5px 10px',
        margin: '8px 0 0',
        fontSize: 11,
      }}
    >
      {rows.map(([label, value, prose = false]) => (
        <Fragment key={label}>
          <dt style={{ color: t.dimText }}>{label}</dt>
          <dd
            style={{
              margin: 0,
              fontFamily:
                prose || value == null || AUDIT_WORDS.has(value)
                  ? FONTS.sans
                  : FONTS.mono,
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap',
            }}
          >
            {value ?? 'not recorded'}
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

type PreviewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'text'; text: string; truncated: boolean }
  | { phase: 'image'; image: ArtifactImagePreview }
  | { phase: 'unsupported' }
  | { phase: 'error'; message: string }

interface ArtifactActionError {
  title: string
  detail: string
  /** The action that recovers from the failure, when one exists. */
  action?: { label: string; run: () => void }
}

/**
 * The host's answer for an artifact identity it no longer holds. It keeps a
 * bounded set of listed identities and releases the least recently used, so
 * a listing on screen can outlive the identity of one of its rows.
 */
const UNKNOWN_ARTIFACT_IDENTITY = 'Select a known artifact identity.'

function isUnknownArtifactIdentity(cause: unknown): boolean {
  return (
    cause instanceof Error && cause.message.includes(UNKNOWN_ARTIFACT_IDENTITY)
  )
}

/**
 * The same artifact across two listings. A new listing can give a row a new
 * identity, so match what the row describes rather than its identity.
 */
function artifactRowKey(artifact: ResultArtifact): string {
  return JSON.stringify([
    artifact.stepKey,
    artifact.subjectId,
    artifact.kind,
    artifact.label,
    artifact.displayPath,
    artifact.runId,
  ])
}

/** The detector page size, which the inventory contract caps at 500 rows. */
const FETCH_LIMIT = 500
/** The row count rendered at once, which keeps the list DOM bounded. */
const VIEW_PAGE_SIZE = 100
/** The continuation budget that bounds one automatic inventory sweep. */
const MAX_AUTO_FETCHES = 10
const RUN_PAGE_SIZE = 200

const RESULT_PRESENCE_LABEL: Record<ResultArtifact['presence'], string> = {
  expected: 'Expected',
  produced: 'Produced',
  absent: 'Absent',
  partial: 'Partial',
  unknown: 'Unknown',
}

const RESULT_KIND_LABEL: Record<ResultArtifact['kind'], string> = {
  dir: 'Directory',
  csv: 'CSV',
  png: 'PNG',
  html: 'HTML',
  xlsx: 'XLSX',
  pdf: 'PDF',
  txt: 'Text',
  nii: 'NIfTI',
}

const RESULT_PROVENANCE_LABEL: Record<ResultArtifact['provenance'], string> = {
  current: 'Current',
  stale: 'Stale',
  unknown: 'Unknown',
}

function presenceStatus(
  presence: ResultArtifact['presence'],
): 'done' | 'partial' | 'missing' | 'pending' | 'warn' {
  switch (presence) {
    case 'produced':
      return 'done'
    case 'partial':
      return 'partial'
    case 'absent':
      return 'missing'
    case 'expected':
      return 'pending'
    case 'unknown':
      return 'warn'
  }
}

/**
 * One row's state in the inventory summary. An expected row of a stage that
 * the saved configuration turns off is `stageOff`, because no run produces
 * it until the stage is turned on.
 */
type InventoryBucket = ResultArtifact['presence'] | 'stageOff'

/** The summary buckets in display order, which partition every counted row. */
const INVENTORY_BUCKETS: ReadonlyArray<[InventoryBucket, string]> = [
  ['produced', 'produced'],
  ['partial', 'partial'],
  ['absent', 'missing'],
  ['expected', 'expected'],
  ['stageOff', 'not produced (stage off)'],
  ['unknown', 'unknown'],
]

function inventoryBucket(
  artifact: ResultArtifact,
  cfg: ProjectConfig,
): InventoryBucket {
  return artifact.presence === 'expected' &&
    cfg.steps[artifact.stepKey]?.enabled === false
    ? 'stageOff'
    : artifact.presence
}

function PresenceChip({
  artifact,
  stageOff,
}: {
  artifact: ResultArtifact
  stageOff: boolean
}): ReactNode {
  const { t } = useApp()
  return stageOff ? (
    <Chip t={t} status="na" label="Stage off" small />
  ) : (
    <Chip
      t={t}
      status={presenceStatus(artifact.presence)}
      label={RESULT_PRESENCE_LABEL[artifact.presence]}
      small
    />
  )
}

/**
 * Explain an unknown provenance from what the inspected run holds. Without a
 * receipt, the detector names this run as the producer only when the run has
 * a job for the node, so an output on disk with no producer run came from
 * another run or from outside Supraspina.
 */
function unknownProvenanceText(artifact: ResultArtifact): string {
  if (artifact.receiptSha256 !== null) {
    return "This run holds a provenance receipt for this output, but its currentness could not be judged against this run's configuration and cohort."
  }
  if (artifact.runId !== null) {
    return 'This run holds no provenance receipt for this output yet. The receipt is recorded when its job finishes successfully.'
  }
  return artifact.exists
    ? 'This run holds no provenance receipt for this output, so another run or a process outside Supraspina produced it. Choose the producing run in Run to see its receipt.'
    : 'This run holds no provenance receipt for this output because the run did not produce it.'
}

/** The placeholder row count that stands in for an unloaded inventory. */
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5]

function InventoryProgress({
  label,
  loaded,
  total,
}: {
  label: string
  loaded?: number
  total?: number
}): ReactNode {
  const { t } = useApp()
  // Report a share of the inventory once the detector states its size, and
  // pulse an indeterminate bar until then.
  const determinate = loaded !== undefined && total !== undefined && total > 0
  const ratio = determinate ? Math.min(1, loaded / total) : 1
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        role="status"
        aria-live="polite"
        style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.dimText }}
      >
        {label}
      </span>
      <div
        role="progressbar"
        aria-label="Detector inventory progress"
        {...(determinate
          ? {
              'aria-valuemin': 0,
              'aria-valuemax': total,
              'aria-valuenow': loaded,
            }
          : {})}
        style={{
          height: 4,
          borderRadius: 2,
          background: t.surface2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.round(ratio * 100)}%`,
            background: t.accent,
            ...(determinate ? {} : { animation: 'ssPulse 1.4s infinite' }),
          }}
        />
      </div>
    </div>
  )
}

function InventorySkeleton(): ReactNode {
  const { t } = useApp()
  return (
    // Keep the placeholder rows out of the accessibility tree, which the
    // status text and the progress bar already describe.
    <div
      aria-hidden="true"
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      {SKELETON_ROWS.map((row) => (
        <div
          key={row}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 8,
            padding: '9px 11px',
            borderBottom: `1px solid ${t.borderSoft}`,
          }}
        >
          <span style={{ minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                height: 10,
                width: `${52 + (row % 3) * 14}%`,
                borderRadius: 3,
                background: t.surface3,
                animation: 'ssPulse 1.4s infinite',
              }}
            />
            <span
              style={{
                display: 'block',
                marginTop: 6,
                height: 8,
                width: '36%',
                borderRadius: 3,
                background: t.surface2,
                animation: 'ssPulse 1.4s infinite',
              }}
            />
          </span>
          <span
            style={{
              alignSelf: 'center',
              height: 16,
              width: 58,
              borderRadius: 8,
              background: t.surface2,
              animation: 'ssPulse 1.4s infinite',
            }}
          />
        </div>
      ))}
    </div>
  )
}

function sameProject(left: ProjectRef | null, right: ProjectRef): boolean {
  return (
    left?.projectId === right.projectId &&
    left.root === right.root &&
    left.configPath === right.configPath &&
    left.epoch === right.epoch
  )
}

/**
 * Browse detector-backed artifacts without exposing usable paths to the
 * renderer.
 */
export function ResultsScreen({
  ...props
}: ResultsScreenProps = {}): ReactNode {
  const { projectEpoch } = useApp()
  return (
    <ResultsProject
      key={`${projectEpoch}:${props.focusStepKey ?? 'all'}`}
      {...props}
    />
  )
}

function ResultsProject({
  refresh,
  focusStepKey,
}: ResultsScreenProps): ReactNode {
  const app = useApp()
  const { t, projectRef, setRoute, savedCfg } = app
  const [items, setItems] = useState<ResultArtifact[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  // Whether the automatic sweep spent its budget with rows still unread.
  const [sweepStopped, setSweepStopped] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<ArtifactActionError | null>(
    null,
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewState>({ phase: 'idle' })
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [runOptions, setRunOptions] = useState<RunManifest[]>([])
  const [runCursor, setRunCursor] = useState<string | null>(null)
  const [loadingRuns, setLoadingRuns] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState('')
  const [inventoryRunId, setInventoryRunId] = useState<string | null>(null)
  // Name the inventory run by its manifest; the raw run id stays out of copy.
  const inventoryRunPhrase = useMemo(() => {
    if (!inventoryRunId) return null
    const manifest = runOptions.find(
      (option) => option.runId === inventoryRunId,
    )
    return manifest ? manifestRunPhrase(manifest) : null
  }, [inventoryRunId, runOptions])
  const [stageFilter, setStageFilter] = useState<StepKey | 'all'>(
    focusStepKey ?? 'all',
  )
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [total, setTotal] = useState(0)
  const [viewPage, setViewPage] = useState(0)
  // Stage currency and the analysis-cohort change of the latest first page,
  // which cover the whole inventory rather than the rows on one page.
  const [cohortCurrency, setCohortCurrency] = useState<{
    stageCurrency: NonNullable<ResultPage['stageCurrency']>
    change: ResultAnalysisCohortChange | null
  } | null>(null)
  const autoFetchesRef = useRef(0)
  const requestRef = useRef(0)
  const runRequestRef = useRef(0)
  const previewRequestRef = useRef(0)
  const actionRequestRef = useRef(0)
  // The row to select again once a re-listing reaches it.
  const reselectRef = useRef<string | null>(null)
  const latestProjectRef = useRef(projectRef)
  useLayoutEffect(() => {
    latestProjectRef.current = projectRef
    return () => {
      latestProjectRef.current = null
    }
  }, [projectRef])

  const load = useCallback(
    async (cursor?: string): Promise<void> => {
      if (!projectRef) return
      const captured = projectRef
      const token = ++requestRef.current
      if (cursor) setLoadingMore(true)
      else {
        setLoading(true)
        setItems([])
        setSelectedId(null)
        setPreview({ phase: 'idle' })
        setActionError(null)
        setViewPage(0)
        setSweepStopped(false)
        autoFetchesRef.current = 0
        actionRequestRef.current += 1
      }
      setError(null)
      try {
        const page: ResultPage = await getApi().results.list({
          project: captured,
          limit: FETCH_LIMIT,
          ...(selectedRunId ? { runId: selectedRunId } : {}),
          ...(stageFilter !== 'all' ? { stepKey: stageFilter } : {}),
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(cursor ? { cursor } : {}),
        })
        if (
          token !== requestRef.current ||
          !sameProject(latestProjectRef.current, captured)
        )
          return
        setItems((current) =>
          cursor
            ? [
                ...current,
                ...page.items.filter(
                  (item) =>
                    !current.some(
                      (existing) => existing.artifactId === item.artifactId,
                    ),
                ),
              ]
            : page.items,
        )
        setNextCursor(page.nextCursor)
        setSweepStopped(
          page.nextCursor !== null &&
            autoFetchesRef.current >= MAX_AUTO_FETCHES,
        )
        setTruncated(page.truncated)
        // Keep the detector total, which covers the whole filtered inventory,
        // rather than the row count of the page that just arrived.
        setTotal(
          (current) =>
            page.total ??
            (cursor ? current + page.items.length : page.items.length),
        )
        setInventoryRunId(
          page.runId ?? (selectedRunId || page.items[0]?.runId || null),
        )
        if (!cursor) {
          setCohortCurrency({
            stageCurrency: page.stageCurrency ?? {},
            change: page.analysisCohortChange ?? null,
          })
        }
        if (
          !cursor &&
          focusStepKey === stageFilter &&
          !query.trim() &&
          !selectedRunId
        ) {
          setSelectedId(
            page.items.find((item) => item.stepKey === focusStepKey)
              ?.artifactId ??
              page.items[0]?.artifactId ??
              null,
          )
        }
        const wanted = reselectRef.current
        if (wanted !== null) {
          const match = page.items.find(
            (item) => artifactRowKey(item) === wanted,
          )
          if (match) setSelectedId(match.artifactId)
          if (match || page.nextCursor === null) reselectRef.current = null
        }
        setUpdatedAt(new Date().toISOString())
      } catch (cause) {
        if (
          token === requestRef.current &&
          sameProject(latestProjectRef.current, captured)
        ) {
          setError(
            cause instanceof Error ? cause.message : 'Retry loading artifacts.',
          )
        }
      } finally {
        if (
          token === requestRef.current &&
          sameProject(latestProjectRef.current, captured)
        ) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [focusStepKey, projectRef, query, selectedRunId, stageFilter],
  )

  useEffect(() => {
    if (!projectRef) return
    void Promise.resolve().then(() => load())
  }, [projectRef, load])

  // Continue the filtered inventory in the background so the presence counts
  // describe every detected artifact rather than the first page alone. A
  // filter change bumps the request token, which abandons the sweep.
  useEffect(() => {
    if (!projectRef || loading || loadingMore || error || !nextCursor) return
    if (autoFetchesRef.current >= MAX_AUTO_FETCHES) return
    autoFetchesRef.current += 1
    void load(nextCursor)
  }, [projectRef, loading, loadingMore, error, nextCursor, load])

  const loadRuns = useCallback(
    async (cursor?: string): Promise<void> => {
      if (!projectRef) return
      const captured = projectRef
      const token = ++runRequestRef.current
      setLoadingRuns(true)
      setRunError(null)
      try {
        const page = await getApi().manifest.list({
          project: captured,
          limit: RUN_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        })
        if (
          token !== runRequestRef.current ||
          !sameProject(latestProjectRef.current, captured)
        )
          return
        setRunOptions((current) =>
          cursor
            ? [
                ...current,
                ...page.items.filter(
                  (manifest) =>
                    !current.some(
                      (existing) => existing.runId === manifest.runId,
                    ),
                ),
              ]
            : page.items,
        )
        setRunCursor(page.nextCursor)
      } catch (cause) {
        if (
          token === runRequestRef.current &&
          sameProject(latestProjectRef.current, captured)
        ) {
          setRunError(
            cause instanceof Error
              ? cause.message
              : 'Retry loading run history.',
          )
        }
      } finally {
        if (
          token === runRequestRef.current &&
          sameProject(latestProjectRef.current, captured)
        ) {
          setLoadingRuns(false)
        }
      }
    },
    [projectRef],
  )

  useEffect(() => {
    if (!projectRef) return
    void Promise.resolve().then(() => loadRuns())
  }, [projectRef, loadRuns])

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput), 250)
    return () => window.clearTimeout(timer)
  }, [queryInput])

  const selected = useMemo(
    () => items.find((item) => item.artifactId === selectedId) ?? null,
    [items, selectedId],
  )

  useEffect(() => {
    const artifact = selected
    const token = ++previewRequestRef.current
    if (!artifact || !projectRef || artifact.presence !== 'produced') {
      return
    }
    const captured = projectRef
    let active = true
    const current = (): boolean =>
      active &&
      token === previewRequestRef.current &&
      sameProject(latestProjectRef.current, captured)
    void (async () => {
      await Promise.resolve()
      if (!current()) return
      try {
        if (artifact.kind === 'png') {
          setPreview({ phase: 'loading' })
          const image = await getApi().artifact.previewImage({
            project: captured,
            artifactId: artifact.artifactId,
            maxBytes: 8 * 1024 * 1024,
          })
          if (current()) setPreview({ phase: 'image', image })
          return
        }
        if (['csv', 'txt', 'html'].includes(artifact.kind)) {
          setPreview({ phase: 'loading' })
          const value = await getApi().artifact.readText({
            project: captured,
            artifactId: artifact.artifactId,
            maxBytes: 512 * 1024,
          })
          if (current()) setPreview({ phase: 'text', ...value })
          return
        }
        setPreview({ phase: 'unsupported' })
      } catch (cause: unknown) {
        if (!current()) return
        setPreview({
          phase: 'error',
          message:
            cause instanceof Error
              ? cause.message
              : 'The preview failed without an error detail.',
        })
      }
    })()
    return () => {
      active = false
    }
  }, [selected, projectRef])

  const counts = useMemo(() => {
    const buckets: Record<InventoryBucket, number> = {
      produced: 0,
      partial: 0,
      absent: 0,
      expected: 0,
      stageOff: 0,
      unknown: 0,
    }
    let stale = 0
    for (const item of items) {
      buckets[inventoryBucket(item, savedCfg)] += 1
      if (item.provenance === 'stale') stale += 1
    }
    return { buckets, stale }
  }, [items, savedCfg])

  // Trust the detector total, and never let it fall below the counted rows.
  const inventoryTotal = Math.max(total, items.length)
  const counted = items.length
  const countsComplete = nextCursor === null && counted >= inventoryTotal
  // The sweep runs until the detector has no cursor or the budget is spent;
  // a manual Load more after the budget counts as counting while it loads.
  const counting = nextCursor !== null && (!sweepStopped || loadingMore)
  const pageCount = Math.max(1, Math.ceil(counted / VIEW_PAGE_SIZE))
  const currentPage = Math.min(viewPage, pageCount - 1)
  const pageStart = currentPage * VIEW_PAGE_SIZE
  const visible = items.slice(pageStart, pageStart + VIEW_PAGE_SIZE)
  // Name every nonzero bucket so the named counts add up to the counted rows.
  // Stale provenance overlaps the presence buckets, so it stands apart.
  const countText = [
    INVENTORY_BUCKETS.filter(([bucket]) => counts.buckets[bucket] > 0)
      .map(([bucket, label]) => `${counts.buckets[bucket]} ${label}`)
      .join(', '),
    ...(counts.stale > 0 ? [`${counts.stale} with stale provenance`] : []),
  ].join(TEXT_GAP)
  // The range shows only when the inventory spans more than one page.
  const rangeText =
    visible.length >= inventoryTotal
      ? ''
      : `${TEXT_GAP}${pageStart + 1}-${pageStart + visible.length} of ${inventoryTotal}`
  const inventorySummary = countsComplete
    ? `${countText}${rangeText}`
    : counting
      ? `${counted} of ${inventoryTotal} counted so far: ${countText}${rangeText}`
      : `${counted} of ${inventoryTotal} counted: ${countText}${rangeText}`
  const progressLabel = counting
    ? `Counting the rest of the inventory: ${counted} of ${inventoryTotal} artifacts so far...`
    : nextCursor !== null
      ? `Counting paused at ${counted} of ${inventoryTotal} artifacts to limit detector load. Load more counts up to ${FETCH_LIMIT} more.`
      : `${counted} of ${inventoryTotal} artifacts counted`

  /** List the artifacts again and select this one once it is listed. */
  const relist = (artifact: ResultArtifact): void => {
    reselectRef.current = artifactRowKey(artifact)
    void load()
  }

  /**
   * State an Open or Reveal failure. An identity the host released means the
   * listing on screen is older than the identities it holds, so offer Refresh
   * rather than an order to select another identity.
   */
  const artifactActionError = (
    artifact: ResultArtifact,
    cause: unknown,
    action: 'open' | 'reveal',
  ): ArtifactActionError => {
    if (isUnknownArtifactIdentity(cause)) {
      return {
        title:
          action === 'open'
            ? 'The artifact list expired before this artifact opened.'
            : 'The artifact list expired before this artifact was revealed.',
        detail:
          'Supraspina keeps a bounded number of listed artifact identities and has released this one. Refresh lists the artifacts again and selects this one if it is still listed.',
        action: { label: 'Refresh', run: () => relist(artifact) },
      }
    }
    const retry =
      action === 'open'
        ? 'Retry opening the artifact.'
        : 'Retry revealing the artifact.'
    return {
      title: retry,
      detail: cause instanceof Error ? cause.message : retry,
    }
  }

  const open = (artifact: ResultArtifact): void => {
    if (!projectRef || !artifact.openable) return
    const captured = projectRef
    const token = ++actionRequestRef.current
    setActionError(null)
    void getApi()
      .artifact.open({
        project: captured,
        artifactId: artifact.artifactId,
      })
      .catch((cause: unknown) => {
        if (
          token !== actionRequestRef.current ||
          !sameProject(latestProjectRef.current, captured)
        )
          return
        setActionError(artifactActionError(artifact, cause, 'open'))
      })
  }

  const reveal = (artifact: ResultArtifact): void => {
    if (!projectRef || !artifact.revealable) return
    const captured = projectRef
    const token = ++actionRequestRef.current
    setActionError(null)
    void getApi()
      .artifact.reveal({
        project: captured,
        artifactId: artifact.artifactId,
      })
      .catch((cause: unknown) => {
        if (
          token !== actionRequestRef.current ||
          !sameProject(latestProjectRef.current, captured)
        )
          return
        setActionError(artifactActionError(artifact, cause, 'reveal'))
      })
  }

  // Name the cohort stages Run all would repeat because the analysis cohort
  // changed after this run; the rows keep this run's own provenance.
  const currencyNotice = cohortCurrency?.change
    ? cohortCurrencyNotice(
        outdatedCohortStages(
          cohortCurrency.stageCurrency,
          (stepKey) =>
            cohortCurrency.stageCurrency[stepKey]?.cause === 'analysis-cohort',
        ),
        cohortCurrency.stageCurrency,
        cohortCurrency.change,
      )
    : null

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {items.length > 0 && (
        <StateLine t={t} color={t.dim}>
          {inventorySummary}
        </StateLine>
      )}
      {loading && (
        <span role="status" style={{ fontSize: 11, color: t.dimText }}>
          Updating results...
        </span>
      )}
      {updatedAt && <FreshnessStamp t={t} at={updatedAt} />}
      <RefreshButton
        t={t}
        ariaLabel="Refresh results"
        title="Refresh results"
        onClick={() => {
          refresh?.()
          void load()
        }}
        disabled={!projectRef || loading}
      />
    </div>
  )

  return (
    <Page t={t} title="Results" right={header}>
      {!projectRef ? (
        <EmptyState
          t={t}
          icon="project"
          message="No project is open."
          hint="Open a project to see its output files."
        />
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            // Fill the page body so the list and preview reach its bottom.
            height: '100%',
            minHeight: 0,
          }}
        >
          <div style={{ flexShrink: 0 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns:
                  'minmax(200px, 280px) minmax(160px, 220px) minmax(220px, 360px)',
                justifyContent: 'start',
                gap: 12,
                alignItems: 'start',
              }}
            >
              <Field t={t} label="Run" controlId="results-run-filter">
                <select
                  id="results-run-filter"
                  value={selectedRunId}
                  onChange={(event) => setSelectedRunId(event.target.value)}
                  // Name the run only when it is not the default latest run.
                  title={
                    inventoryRunPhrase && selectedRunId !== ''
                      ? `Shows the ${inventoryRunPhrase}.`
                      : undefined
                  }
                  style={{
                    height: 'var(--ss-input-h)',
                    width: '100%',
                    padding: '0 8px',
                    border: `1px solid ${t.dim}`,
                    borderRadius: 4,
                    background: t.bg,
                    color: t.text,
                    fontFamily: FONTS.sans,
                    fontSize: 11.5,
                  }}
                >
                  <option value="">Latest run</option>
                  {runOptions.map((manifest) => (
                    <option key={manifest.runId} value={manifest.runId}>
                      {manifestRunLabel(manifest)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field t={t} label="Stage" controlId="results-stage-filter">
                <select
                  id="results-stage-filter"
                  value={stageFilter}
                  onChange={(event) =>
                    setStageFilter(event.target.value as StepKey | 'all')
                  }
                  style={{
                    height: 'var(--ss-input-h)',
                    width: '100%',
                    padding: '0 8px',
                    border: `1px solid ${t.dim}`,
                    borderRadius: 4,
                    background: t.bg,
                    color: t.text,
                    fontFamily: FONTS.sans,
                    fontSize: 11.5,
                  }}
                >
                  <option value="all">All stages</option>
                  {PIPELINE_STEPS_IN_DISPLAY_ORDER.map((step) => (
                    <option key={step.key} value={step.key}>
                      {step.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field t={t} label="Search" controlId="results-artifact-search">
                <span
                  title="Each search term must match the label, stage, subject, path, type, state, run, or producer."
                  style={{ display: 'flex' }}
                >
                  <TextInput
                    t={t}
                    value={queryInput}
                    onChange={setQueryInput}
                    placeholder="Subject, stage, or label"
                  />
                </span>
              </Field>
            </div>
            {(runCursor || runError) && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 10,
                }}
              >
                {runCursor && (
                  <Btn
                    t={t}
                    small
                    ghost
                    label={
                      loadingRuns ? 'Loading older runs...' : 'Load older runs'
                    }
                    disabled={loadingRuns}
                    onClick={() => void loadRuns(runCursor)}
                  />
                )}
                {runError && <Hint t={t}>{runError}</Hint>}
              </div>
            )}
          </div>

          {!error && currencyNotice && (
            <div
              role="status"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                margin: '10px 0 0',
                flexShrink: 0,
                padding: '8px 12px',
                borderRadius: 6,
                border: `1px solid color-mix(in srgb, ${t.warning} 27%, transparent)`,
                background: t.warningSoft,
              }}
            >
              <span
                style={{ display: 'inline-flex', paddingTop: 1, flexShrink: 0 }}
              >
                <NoticeGlyph t={t} tone="warn" />
              </span>
              <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 3 }}>
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 12,
                    fontWeight: 600,
                    color: t.text,
                  }}
                >
                  {currencyNotice.headline}
                </span>
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 11.5,
                    color: t.textSoft,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {currencyNotice.detail} Provenance below still describes the
                  cohort this run recorded.
                </span>
              </div>
            </div>
          )}

          {error ? (
            <ErrorState
              t={t}
              title="Could not load results."
              detail={error}
              onRetry={() => void load()}
            />
          ) : loading && items.length === 0 ? (
            <Card
              t={t}
              title="Output files"
              padded={false}
              style={{ marginTop: 12 }}
            >
              <div
                role="region"
                aria-label="Output files"
                aria-busy="true"
                style={{ display: 'flex', flexDirection: 'column' }}
              >
                <div style={{ padding: '10px 11px' }}>
                  <InventoryProgress label="Loading results..." />
                </div>
                <InventorySkeleton />
              </div>
            </Card>
          ) : items.length === 0 ? (
            <Card t={t} style={{ marginTop: 12 }}>
              <EmptyState
                t={t}
                icon="results"
                message={
                  stageFilter !== 'all' || queryInput.trim()
                    ? noMatchFact(stageFilter, queryInput.trim())
                    : 'No output files yet.'
                }
                hint={
                  stageFilter !== 'all' || queryInput.trim()
                    ? 'Change the stage or search terms.'
                    : 'Run the workflow from Runs to produce them.'
                }
                action={
                  stageFilter !== 'all' || queryInput.trim() ? (
                    <Btn
                      t={t}
                      label="Clear filters"
                      onClick={() => {
                        setStageFilter('all')
                        setQueryInput('')
                        setQuery('')
                      }}
                    />
                  ) : (
                    <Btn
                      t={t}
                      label="Open Runs"
                      onClick={() => setRoute('runs')}
                    />
                  )
                }
              />
            </Card>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)',
                gap: 14,
                // Both panes fill the height left under the filters; below
                // the floor the page scrolls instead of squeezing them.
                flex: 1,
                minHeight: 320,
                marginTop: 12,
              }}
            >
              <Card
                t={t}
                title="Output files"
                padded={false}
                style={{ overflow: 'hidden' }}
              >
                <div
                  style={{
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  <div
                    role="region"
                    aria-label="Output files"
                    aria-busy={loading || loadingMore ? 'true' : undefined}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      flex: 1,
                      minHeight: 0,
                      overflowY: 'auto',
                    }}
                  >
                    {visible.map((artifact) => {
                      const active = artifact.artifactId === selectedId
                      return (
                        <button
                          key={artifact.artifactId}
                          type="button"
                          aria-current={active ? 'true' : undefined}
                          onClick={() => {
                            actionRequestRef.current += 1
                            reselectRef.current = null
                            setActionError(null)
                            setSelectedId(artifact.artifactId)
                            setPreview({ phase: 'idle' })
                          }}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'minmax(0, 1fr) auto',
                            gap: 8,
                            padding: '9px 11px',
                            textAlign: 'left',
                            border: 'none',
                            borderBottom: `1px solid ${t.borderSoft}`,
                            borderLeft: `3px solid ${active ? t.accent : 'transparent'}`,
                            background: active ? t.accentSoft : 'transparent',
                            color: t.text,
                            cursor: 'pointer',
                          }}
                        >
                          <span style={{ minWidth: 0 }}>
                            <span
                              style={{
                                display: 'block',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                fontFamily: FONTS.sans,
                                fontSize: 12.5,
                                fontWeight: 700,
                              }}
                            >
                              {artifact.label}
                            </span>
                            <StateLine
                              t={t}
                              size={10.5}
                              style={{ display: 'block', marginTop: 2 }}
                            >
                              {pipelineStep(artifact.stepKey).name}
                              {' / '}
                              {artifact.subjectId ? (
                                <InlineCode>{artifact.subjectId}</InlineCode>
                              ) : (
                                'cohort'
                              )}
                              {artifact.provenanceDetails?.receipt
                                ?.executionFallback &&
                                `${TEXT_GAP}${executionFallbackFact(
                                  artifact.provenanceDetails.receipt
                                    .executionFallback,
                                )}`}
                            </StateLine>
                          </span>
                          {/* Center the pill without stretching it to the label height. */}
                          <span style={{ alignSelf: 'center' }}>
                            <PresenceChip
                              artifact={artifact}
                              stageOff={
                                inventoryBucket(artifact, savedCfg) ===
                                'stageOff'
                              }
                            />
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {(pageCount > 1 ||
                    nextCursor ||
                    truncated ||
                    !countsComplete) && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 8,
                        padding: 10,
                      }}
                    >
                      {!countsComplete && (
                        <div style={{ flexBasis: '100%' }}>
                          <InventoryProgress
                            label={progressLabel}
                            loaded={counted}
                            total={inventoryTotal}
                          />
                        </div>
                      )}
                      {pageCount > 1 && (
                        <>
                          <Btn
                            t={t}
                            small
                            ghost
                            label="Previous page"
                            disabled={currentPage === 0}
                            onClick={() =>
                              setViewPage(Math.max(0, currentPage - 1))
                            }
                          />
                          <StateLine t={t}>
                            Page {currentPage + 1} of {pageCount}
                          </StateLine>
                          <Btn
                            t={t}
                            small
                            ghost
                            label="Next page"
                            disabled={currentPage >= pageCount - 1}
                            onClick={() =>
                              setViewPage(
                                Math.min(pageCount - 1, currentPage + 1),
                              )
                            }
                          />
                        </>
                      )}
                      {nextCursor && sweepStopped && (
                        <Btn
                          t={t}
                          small
                          label={
                            loadingMore
                              ? 'Loading more artifacts...'
                              : 'Load more'
                          }
                          disabled={loadingMore}
                          onClick={() => void load(nextCursor)}
                        />
                      )}
                      {!nextCursor && truncated && (
                        <Hint t={t}>
                          This list is cut short. Narrow the stage or search to
                          list the rest.
                        </Hint>
                      )}
                    </div>
                  )}
                </div>
              </Card>

              <ArtifactPreview
                artifact={selected}
                stageOff={
                  selected !== null &&
                  inventoryBucket(selected, savedCfg) === 'stageOff'
                }
                preview={preview}
                actionError={actionError}
                onOpen={open}
                onReveal={reveal}
              />
            </div>
          )}
        </div>
      )}
    </Page>
  )
}

/**
 * State that the inventory filters matched no artifact, naming the chosen stage
 * and quoting the search.
 *
 * @param stage - The stage filter, or 'all' when no stage is chosen.
 * @param search - The trimmed artifact search, or '' when there is none.
 */
function noMatchFact(stage: StepKey | 'all', search: string): string {
  const filters: string[] = []
  if (stage !== 'all') filters.push(`the stage "${pipelineStep(stage).name}"`)
  if (search) filters.push(`the search "${search}"`)
  return `No artifacts match ${filters.join(' and ')}.`
}

function ArtifactPreview({
  artifact,
  stageOff,
  preview,
  actionError,
  onOpen,
  onReveal,
}: {
  artifact: ResultArtifact | null
  stageOff: boolean
  preview: PreviewState
  actionError: ArtifactActionError | null
  onOpen: (artifact: ResultArtifact) => void
  onReveal: (artifact: ResultArtifact) => void
}): ReactNode {
  const { t } = useApp()
  if (!artifact) {
    return (
      <Card t={t} title="Preview">
        <div
          style={{
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <EmptyState
            t={t}
            icon="results"
            message="No file is selected."
            hint="Select a file to preview it."
          />
        </div>
      </Card>
    )
  }

  return (
    // Let the title, path, and actions wrap instead of keeping the fixed-height
    // card header, which pushes Reveal past the edge under a long path or a
    // large text scale.
    <Card
      t={t}
      title={artifact.label}
      sub={artifact.displayPath}
      subMono
      wrapTitle
      // The pane keeps its height, and a long preview scrolls inside it.
      style={{ overflow: 'auto' }}
      action={
        <>
          <Btn
            t={t}
            small
            label="Open"
            disabled={!artifact.openable}
            onClick={() => onOpen(artifact)}
          />
          <Btn
            t={t}
            small
            ghost
            label="Reveal"
            disabled={!artifact.revealable}
            onClick={() => onReveal(artifact)}
          />
        </>
      }
    >
      <ArtifactDetails
        artifact={artifact}
        stageOff={stageOff}
        preview={preview}
        actionError={actionError}
      />
    </Card>
  )
}

function ArtifactDetails({
  artifact,
  stageOff,
  preview,
  actionError,
}: {
  artifact: ResultArtifact
  stageOff: boolean
  preview: PreviewState
  actionError: ArtifactActionError | null
}): ReactNode {
  const { t } = useApp()
  const receipt = artifact.provenanceDetails?.receipt ?? null
  const runBinding = artifact.provenanceDetails?.runBinding ?? null

  return (
    <>
      <div
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}
      >
        <TextPill
          t={t}
          label={RESULT_KIND_LABEL[artifact.kind]}
          color={t.dim}
          ariaLabel={`Type: ${RESULT_KIND_LABEL[artifact.kind]}`}
        />
        <TextPill
          t={t}
          label={RESULT_PROVENANCE_LABEL[artifact.provenance]}
          color={t.dim}
          ariaLabel={`Provenance: ${RESULT_PROVENANCE_LABEL[artifact.provenance]}`}
        />
        <PresenceChip artifact={artifact} stageOff={stageOff} />
      </div>
      {artifact.provenance === 'unknown' && (
        <Hint t={t} style={{ marginBottom: 10 }}>
          {unknownProvenanceText(artifact)}
        </Hint>
      )}
      {actionError && (
        <div style={{ marginBottom: 10 }}>
          <ErrorState
            t={t}
            title={actionError.title}
            detail={actionError.detail}
            {...(actionError.action
              ? {
                  onRetry: actionError.action.run,
                  retryLabel: actionError.action.label,
                }
              : {})}
          />
        </div>
      )}
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content minmax(0, 1fr)',
          gap: '5px 10px',
          margin: '0 0 12px',
          fontSize: 11.5,
        }}
      >
        <dt style={{ color: t.dimText }}>Subject</dt>
        <dd
          style={{
            margin: 0,
            fontFamily: artifact.subjectId ? FONTS.mono : FONTS.sans,
          }}
        >
          {artifact.subjectId ?? 'cohort'}
        </dd>
        <dt style={{ color: t.dimText }}>Stage</dt>
        <dd style={{ margin: 0 }}>
          {pipelineStep(artifact.stepKey).name} (
          <InlineCode>{artifact.stepKey}</InlineCode>)
        </dd>
        {receipt?.executionFallback && (
          <>
            <dt style={{ color: t.dimText }}>Rerun</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>
              <span style={{ display: 'block' }}>
                {executionFallbackFact(receipt.executionFallback)}.
              </span>
              <span style={{ display: 'block', color: t.textSoft }}>
                {executionFallbackDetail(receipt.executionFallback)}
              </span>
            </dd>
          </>
        )}
        {receipt?.unitReuse && (
          <>
            <dt style={{ color: t.dimText }}>Subjects</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>
              {unitReuseFact(receipt.unitReuse, 'past')}
            </dd>
          </>
        )}
      </dl>
      <details
        style={{
          margin: '0 0 10px',
          padding: '8px 10px',
          border: `1px solid ${t.borderSoft}`,
          borderRadius: 6,
          background: t.surface2,
        }}
      >
        <summary
          style={{
            cursor: 'pointer',
            color: t.text,
            fontFamily: FONTS.sans,
            fontSize: 11.5,
            fontWeight: 700,
          }}
        >
          Producer identifiers
        </summary>
        <Hint t={t} style={{ marginTop: 6 }}>
          These support identifiers correlate this artifact with the durable run
          state and a redacted debug bundle.
        </Hint>
        <AuditGrid
          rows={[
            ['Producer run', artifact.runId ?? 'not recorded'],
            ['Producer job', artifact.producerNodeId ?? 'not recorded'],
            ['Receipt SHA-256', artifact.receiptSha256 ?? 'not recorded'],
          ]}
        />
      </details>
      {receipt && (
        <details
          style={{
            margin: '0 0 10px',
            padding: '8px 10px',
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 6,
            background: t.surface2,
          }}
        >
          <summary
            style={{
              cursor: 'pointer',
              color: t.text,
              fontFamily: FONTS.sans,
              fontSize: 11.5,
              fontWeight: 700,
            }}
          >
            SHA-256 receipt provenance
          </summary>
          <Hint t={t} style={{ marginTop: 6 }}>
            The digest check shows whether the stored payload matches its
            recorded SHA-256. Currentness against this inventory run is judged
            separately, from the payload and detector evidence.
          </Hint>
          <AuditGrid
            rows={[
              [
                'Digest check',
                receipt.signatureValid ? 'valid' : 'invalid',
                true,
              ],
              ['Receipt digest', receipt.signature || 'not recorded'],
              ['Receipt version', receipt.receiptVersion ?? 'not recorded'],
              ['Committed', auditTime(receipt.committedAtMs), true],
              ['Producer job', receipt.jobId ?? 'not recorded'],
              [
                'Analysis cohort',
                receipt.analysisCohortDigest ?? 'not recorded',
              ],
              [
                'Selected subset',
                receipt.selectedSubsetDigest ?? 'not recorded',
              ],
              ['Input T1', receipt.inputT1Fingerprint ?? 'not recorded'],
              ['Step parameters', receipt.stepParamsDigest ?? 'not recorded'],
              ['Tool evidence', receipt.toolEvidenceDigest ?? 'not recorded'],
              [
                'External inputs',
                receipt.externalInputsDigest ?? 'not recorded',
              ],
              ['Adapter', receipt.adapterIdentity ?? 'not recorded'],
              [
                'Adapter implementation',
                receipt.adapterImplementationSha256 ?? 'not recorded',
              ],
              ['Output schema', receipt.outputSchemaIdentity ?? 'not recorded'],
              [
                'Upstream receipt digests',
                receipt.upstreamSignatures.length > 0
                  ? receipt.upstreamSignatures.join('\n')
                  : 'none',
              ],
              ['Scientific baseline', receipt.baselineDigest ?? 'not recorded'],
            ]}
          />
        </details>
      )}
      {runBinding && (
        <details
          style={{
            margin: '0 0 10px',
            padding: '8px 10px',
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 6,
            background: t.surface2,
          }}
        >
          <summary
            style={{
              cursor: 'pointer',
              color: t.text,
              fontFamily: FONTS.sans,
              fontSize: 11.5,
              fontWeight: 700,
            }}
          >
            Reviewed run binding
          </summary>
          <Hint t={t} style={{ marginTop: 6 }}>
            These identities are covered by the exact plan digest, which is
            separate from the artifact receipt digest above.
          </Hint>
          <AuditGrid
            rows={[
              ['Plan', runBinding.planDigest ?? 'not recorded'],
              ['Configuration', runBinding.configDigest ?? 'not recorded'],
              ['QC records', runBinding.qcDigest ?? 'not recorded'],
              ['Registry', runBinding.registryDigest ?? 'not recorded'],
              ['Environment', runBinding.environmentDigest ?? 'not recorded'],
            ]}
          />
        </details>
      )}
      {artifact.detail && <Hint t={t}>{artifact.detail}</Hint>}
      {stageOff ? (
        <Hint t={t} style={{ marginTop: 10 }}>
          {pipelineStep(artifact.stepKey).name} is off in the project
          configuration, so this artifact is not produced. Turn the stage on to
          produce it.
        </Hint>
      ) : artifact.presence !== 'produced' ? (
        <Hint t={t} style={{ marginTop: 10 }}>
          The detector reports this artifact as {artifact.presence}, so it has
          no preview.
        </Hint>
      ) : preview.phase === 'loading' ? (
        <LoadingState t={t} label="Loading the bounded preview..." />
      ) : preview.phase === 'text' ? (
        <div style={{ marginTop: 10 }}>
          {preview.text.length === 0 ? (
            <Hint t={t}>This artifact is empty.</Hint>
          ) : (
            <pre
              aria-label={
                artifact.kind === 'html'
                  ? 'Inert HTML source preview'
                  : 'Text artifact preview'
              }
              style={{
                maxHeight: 420,
                overflow: 'auto',
                margin: 0,
                padding: 10,
                borderRadius: 6,
                background: t.surface2,
                color: t.textSoft,
                fontFamily: FONTS.mono,
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              }}
            >
              {preview.text}
            </pre>
          )}
          {preview.truncated && (
            <Hint t={t} style={{ marginTop: 6 }}>
              The preview ends at its bounded limit. Open shows the whole
              artifact externally.
            </Hint>
          )}
        </div>
      ) : preview.phase === 'image' ? (
        <div style={{ marginTop: 10 }}>
          <img
            src={preview.image.dataUrl}
            alt={`Preview of ${artifact.label}`}
            style={{ display: 'block', maxWidth: '100%', maxHeight: 520 }}
          />
          {preview.image.truncated && (
            <Hint t={t}>
              The host downsampled or truncated this preview. Open shows the
              full image externally.
            </Hint>
          )}
        </div>
      ) : preview.phase === 'error' ? (
        <ErrorState
          t={t}
          title="Could not load the preview."
          detail={preview.message}
        />
      ) : (
        <Hint t={t} style={{ marginTop: 10 }}>
          This artifact has no embedded preview. Open shows it through the host.
        </Hint>
      )}
    </>
  )
}
