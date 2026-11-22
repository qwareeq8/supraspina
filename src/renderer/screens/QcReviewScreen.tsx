/**
 * Lets reviewers inspect all three verified ENIGMA galleries for each subject,
 * then record a Pass, Fail, or Defer verdict with an autosaved note.
 *
 * Shell theme tokens apply to every surface; only typography changes for the
 * notebook tone. Missing cohort data is bootstrapped through
 * `getApi().subjects.discover`, and shell-owned subject state is preferred when
 * supplied. Screen-local shortcuts stay suppressed while the note editor has
 * focus.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Btn,
  EmptyState,
  ErrorState,
  FONTS,
  FreshnessStamp,
  FreshnessStampReserve,
  formatAgeYears,
  formatRunTime,
  Hint,
  Ico,
  IconButton,
  LoadingState,
  RefreshButton,
  ICONS,
  ICON_SIZE,
  InfoTip,
  Kbd,
  Modal,
  Segments,
  ReviewChip,
  ReviewGlyph,
  STATUS_LABEL,
  StatusGlyph,
  TEXT_GAP,
  NoticeGlyph,
} from '../ui'
import type { Theme } from '../ui'
import { keepRowInView } from '../ui/keepRowInView'
import { useApp } from '../state/context'
import { getApi } from '../state/api'
import {
  manifestRunLabel,
  manifestRunPhrase,
  runTimestampLabel,
} from '../state/run-label'
import {
  useSurfaceRegistration,
  type SurfaceRegistrationState,
} from '../state/surface-registration'
import {
  useDurableDraft,
  useDurableMutations,
} from '../state/durable-mutations-state'
import type { ProjectConfig } from '../../shared/project-schema'
import type {
  QcGalleryPanel,
  QcGalleryView,
  QcReviewOpenGrant,
  ResultArtifact,
} from '../../shared/contract'
import type {
  ManifestStepStatus,
  ProjectRef,
  RunManifest,
} from '../../shared/types'
import {
  AIS_HELP,
  COHORT_LABEL,
  GLOSSARY,
  MATRIX_STEP_HELP,
  QC_VERDICT_HELP,
} from '../../shared/help'
import type { Subject } from '../../shared/types'
import {
  SURFACE_REGISTRATION_HELP,
  hemisphereAdvisory,
  registrationProvisional,
  registrationQueueLine,
  registrationSummary,
  type RegistrationSubjectResult,
  type SurfaceRegistrationStatus,
} from '../../shared/surface-registration'
import { imagesChangedText } from '../../shared/unit-reuse'
import { COHORT_LOADING_VALUE } from '../run-scope'
import { useKeyedPage } from './montage-page'

type QcVerdict = Subject['qc']

type VerdictStatus = 'pass' | 'fail' | 'review' | 'unreviewed'

type TabValue = 'subcortical' | 'internal' | 'external'

interface EnigmaTab {
  value: TabValue
  label: string
  artifactLabel: string
  hint: number
  help: string
}

const SUBCORTICAL_TAB: EnigmaTab = {
  value: 'subcortical',
  label: 'Subcortical',
  artifactLabel: 'Subcortical QC gallery',
  hint: 1,
  help: MATRIX_STEP_HELP.qcsub,
}

const ENIGMA_TABS: readonly EnigmaTab[] = [
  SUBCORTICAL_TAB,
  {
    value: 'internal',
    label: 'Internal cortical',
    artifactLabel: 'Cortical-internal QC gallery',
    hint: 2,
    help: MATRIX_STEP_HELP.qcic,
  },
  {
    value: 'external',
    label: 'External cortical',
    artifactLabel: 'Cortical-external QC gallery',
    hint: 3,
    help: MATRIX_STEP_HELP.qcec,
  },
]

/**
 * Widest montage block in CSS pixels: four panels at the height cap of a
 * square surface panel, so the tiles fill their columns.
 */
const MONTAGE_MAX_WIDTH = 1120

/** Keep text for assistive technology without drawing it. */
const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}

const QC_RESULT_LIMIT = 50
const RUN_PAGE_SIZE = 200

/**
 * How long this app session reuses an authoritative run's gallery inventory.
 * The host's inventory key changes whenever the inventory may change; this
 * also bounds how long the artifact identities in it are relied on.
 */
const INVENTORY_REUSE_MS = 5 * 60 * 1000
/** A bound on retained inventories, one per project and authoritative run. */
const MAX_REUSED_INVENTORIES = 8

/**
 * Gallery inventories of authoritative ENIGMA runs, keyed by project, run, and
 * the host's inventory key. Recomputing one takes seconds on a large cohort,
 * and QC review is reopened often.
 */
const reusedInventories = new Map<
  string,
  { runId: string; items: ResultArtifact[]; expiresAt: number }
>()

function inventoryReuseKey(
  project: ProjectRef,
  runId: string,
  inventoryKey: string,
): string {
  return [project.projectId, String(project.epoch), runId, inventoryKey].join(
    '\u0000',
  )
}

function rememberInventory(
  key: string,
  runId: string,
  items: ResultArtifact[],
): void {
  reusedInventories.delete(key)
  while (reusedInventories.size >= MAX_REUSED_INVENTORIES) {
    const oldest = reusedInventories.keys().next().value as string | undefined
    if (oldest === undefined) break
    reusedInventories.delete(oldest)
  }
  reusedInventories.set(key, {
    runId,
    items,
    expiresAt: Date.now() + INVENTORY_REUSE_MS,
  })
}

/** List the ENIGMA gallery artifacts of one run. */
async function listGalleryInventory(
  project: ProjectRef,
  runId: string,
): Promise<{ runId: string; items: ResultArtifact[] }> {
  const page = await getApi().results.list({
    project,
    stepKey: 'enigma',
    limit: QC_RESULT_LIMIT,
    runId,
  })
  return {
    runId: page.runId ?? runId,
    items: page.items.filter(
      (item) => item.stepKey === 'enigma' && item.kind === 'html',
    ),
  }
}

/**
 * The host's answer for an artifact identity it no longer holds. A reused
 * inventory can outlive its identities, so the answer means the gallery list
 * is out of date rather than that the gallery is gone.
 */
const UNKNOWN_ARTIFACT_IDENTITY = 'Select a known artifact identity.'

function isUnknownArtifactIdentity(cause: unknown): boolean {
  return (
    cause instanceof Error && cause.message.includes(UNKNOWN_ARTIFACT_IDENTITY)
  )
}

/** Cohort, selection, and review state for QC review. */
export interface QcReviewScreenProps {
  cfg?: ProjectConfig
  subjects?: Subject[]
  activeSubjectId?: string | null
  onActiveSubjectChange?: (id: string) => void
  refresh?: () => void
}

function tabFor(value: TabValue): EnigmaTab {
  return ENIGMA_TABS.find((x) => x.value === value) ?? SUBCORTICAL_TAB
}

function sameProject(left: ProjectRef | null, right: ProjectRef): boolean {
  return (
    left?.projectId === right.projectId &&
    left.root === right.root &&
    left.configPath === right.configPath &&
    left.epoch === right.epoch
  )
}

/** Stage states of a run that never started the stage. */
const UNATTEMPTED_STEP_STATUSES: ReadonlySet<ManifestStepStatus> = new Set([
  'planned',
  'waiting',
  'queued',
  'skipped',
  'blocked',
  'withheld',
])

/**
 * Whether a durable run started ENIGMA QC. Only such a run can have produced
 * galleries, so only such a run belongs in the QC artifact run selector.
 */
function ranEnigmaQc(manifest: RunManifest): boolean {
  return (
    !manifest.dryRun &&
    (manifest.steps ?? []).some(
      (step) =>
        step.key === 'enigma' && !UNATTEMPTED_STEP_STATUSES.has(step.status),
    )
  )
}

/**
 * State why a historical run shows no gallery for a tab. A gallery whose
 * files a later run rewrote no longer matches the selected run's receipt,
 * a run whose ENIGMA QC step recorded no receipt produced none, and any
 * other unavailable gallery could not be verified.
 */
function historicalGalleryFact(
  artifact: ResultArtifact | null,
  selectedRunId: string,
  label: string,
): Pick<HistoricalGalleryNotice, 'title' | 'message'> {
  if (
    artifact?.exists &&
    (artifact.provenance === 'stale' ||
      (artifact.runId !== null && artifact.runId !== selectedRunId))
  ) {
    return {
      title: `A later run replaced the ${label} gallery of the selected run.`,
      message:
        'The gallery files on disk no longer match the provenance receipt of the selected run.',
    }
  }
  if (!artifact?.exists || artifact.receiptSha256 === null) {
    return {
      title: `The selected run produced no ${label} gallery.`,
      message:
        'The ENIGMA QC step of the selected run recorded no provenance receipt for this gallery.',
    }
  }
  return {
    title: `Supraspina could not verify the ${label} gallery of the selected run.`,
    message:
      'The gallery files on disk are incomplete, or their provenance could not be judged against the selected run.',
  }
}

function verdictStatus(qc: QcVerdict): VerdictStatus {
  if (qc === 'pass') return 'pass'
  if (qc === 'fail') return 'fail'
  if (qc === 'defer') return 'review'
  return 'unreviewed'
}

/**
 * Label the shared `review` status as the reviewer action "Defer" on this
 * screen. Keep every other verdict aligned with {@link STATUS_LABEL}.
 */
function verdictLabel(status: VerdictStatus): string {
  return status === 'review' ? 'Defer' : STATUS_LABEL[status]
}

const LEGEND_LABEL: Record<VerdictStatus, string> = {
  pass: 'Pass',
  fail: 'Fail',
  review: 'Defer',
  unreviewed: 'Unreviewed',
}

/**
 * The share of the header row the title block claims before the stamp group
 * moves to a row of its own: room for a subject title and a short meta line.
 */
const HEADER_TITLE_BASIS = 280

/**
 * Name the current ENIGMA run the galleries come from, by its phrase. With no
 * phrase the select already says "Current ENIGMA run", so say nothing.
 */
function currentRunHint(runPhrase: string | null): string | null {
  return runPhrase
    ? `The galleries come from the current ENIGMA run, the ${runPhrase}.`
    : null
}

/**
 * Current-run sentences as wide as any: each month's short name with a
 * two-digit day and hour, in the phrase manifestRunPhrase gives a run that is
 * not a dry run (a dry run holds no galleries).
 */
const RUN_HINT_SAMPLES: readonly string[] = Array.from(
  { length: 12 },
  (_, month) =>
    currentRunHint(
      `run started ${runTimestampLabel(new Date(2026, month, 28, 12, 58, 58).getTime())}`,
    ) ?? '',
)

/**
 * Hold the room of the widest current-run sentence under the QC artifact run
 * select, so the header keeps its height when "Resolving the current ENIGMA
 * run..." (one line) gives way to the resolved sentence (two lines at 135%
 * text). Place it in the slot's first grid cell; it neither shows nor
 * announces anything.
 */
function RunHintReserve(p: { t: Theme }): ReactNode {
  return (
    <span
      aria-hidden
      data-reserve="run-hint"
      style={{ gridArea: '1 / 1', display: 'grid', visibility: 'hidden' }}
    >
      {RUN_HINT_SAMPLES.map((sample) => (
        <Hint key={sample} t={p.t} style={{ gridArea: '1 / 1' }}>
          {sample}
        </Hint>
      ))}
    </span>
  )
}

/** The subject fields the header's meta line states. */
type MetaSubject = Pick<Subject, 'age' | 'sex' | 'cohort' | 'ais' | 'tSinceSci'>

function MetaLine(p: {
  t: Theme
  subject: MetaSubject
  color: string
}): ReactNode {
  const { t, subject: s } = p
  // Expand AIS and the subject's grade for reviewers outside the SCI domain.
  const aisGrade = s.ais ? AIS_HELP[s.ais] : undefined
  const aisHelp = s.ais
    ? `${GLOSSARY.AIS}${aisGrade ? ` ${aisGrade}` : ''}`
    : undefined
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        fontFamily: FONTS.sans,
        fontSize: 12,
        color: p.color,
      }}
    >
      {`Age ${formatAgeYears(s.age)}${TEXT_GAP}${s.sex}${TEXT_GAP}`}
      <span title={s.cohort}>{COHORT_LABEL[s.cohort]}</span>
      {s.ais && aisHelp && (
        <>
          {TEXT_GAP}
          AIS {s.ais}
          <InfoTip
            t={t}
            text={aisHelp}
            label={`About AIS grade ${s.ais}`}
            style={{ marginLeft: 4, color: p.color }}
          />
        </>
      )}
      {s.tSinceSci != null && (
        <>
          {TEXT_GAP}
          {s.tSinceSci} {s.tSinceSci === 1 ? 'year' : 'years'} after SCI
          <InfoTip
            t={t}
            text="Years from the spinal cord injury (SCI) to the scan."
            label="About years after SCI"
            style={{ marginLeft: 4, color: p.color }}
          />
        </>
      )}
    </span>
  )
}

/**
 * Meta lines as wide as an SCI subject's: every field present, a two-digit
 * age and time since injury with two decimals as the registry reports them,
 * and the longer SCI cohort label. A control's line is shorter. An
 * unresolved cohort with injury fields reads five characters longer and can
 * still take one more row; reserving for it would leave an empty row under
 * every subject at 100% text.
 */
const META_RESERVE_SAMPLES: readonly MetaSubject[] = [
  { age: 88.88, sex: 'M', cohort: 'SCI_nNP', ais: 'D', tSinceSci: 88.88 },
]

/**
 * Hold the room of the widest meta line under the subject title, so the
 * header keeps its height when J or K moves between a control, whose line
 * fits one row, and an SCI subject, whose line wraps at 115% and 135% text.
 * Place it in the slot's first grid cell; it neither shows nor announces
 * anything, and its tips take no focus.
 */
function MetaLineReserve(p: { t: Theme; color: string }): ReactNode {
  return (
    <span
      aria-hidden
      data-reserve="meta-line"
      style={{ gridArea: '1 / 1', display: 'grid', visibility: 'hidden' }}
    >
      {META_RESERVE_SAMPLES.map((sample) => (
        <span key={sample.cohort} style={{ gridArea: '1 / 1' }}>
          <MetaLine t={p.t} subject={sample} color={p.color} />
        </span>
      ))}
    </span>
  )
}

/**
 * The queue header's surface-registration line: its text and the glyph that
 * leads it, a warning, a running check, the status being read, no flags, or
 * an idle fact.
 */
interface QueueRegistrationLine {
  text: string
  glyph: 'warning' | 'running' | 'reading' | 'clear' | 'idle'
}

/**
 * Word the queue header's registration line for every state of the check,
 * so the line holds its row from the first queue frame and its arrival moves
 * no queue row. registrationQueueLine words the states worth a warning or a
 * running check; the rest read as quiet facts.
 *
 * @param status - The latest status, or null while it is read.
 * @param readError - The error from reading or starting the check.
 */
function queueRegistrationLine(
  status: SurfaceRegistrationStatus | null,
  readError: string | null,
  flaggedInQueue: number,
): QueueRegistrationLine {
  if (!status) {
    return readError
      ? {
          text: 'Surface registration: the status could not be read',
          glyph: 'warning',
        }
      : { text: 'Surface registration: reading...', glyph: 'reading' }
  }
  const line = registrationQueueLine(status, flaggedInQueue)
  if (line) {
    return {
      text: line,
      glyph: status.operation?.state === 'running' ? 'running' : 'warning',
    }
  }
  const { subjects, checked, pending, failed, flaggedSubjects } = status.counts
  if (subjects === 0) {
    return {
      text: 'Surface registration: no reconstructed surfaces yet',
      glyph: 'idle',
    }
  }
  if (pending === 0 && failed === 0 && flaggedSubjects === 0) {
    return { text: 'Surface registration: no subject flagged', glyph: 'clear' }
  }
  // A check the operator stopped, or one about to start on its own.
  return {
    text: `Surface registration: ${checked} of ${checked + pending + failed} checked`,
    glyph: 'idle',
  }
}

interface Palette {
  screenBg: string
  cardBg: string
  ink: string
  inkDim: string
  rule: string
  controlRule: string
  /**
   * The face of the display headings alone: the subject heading and the
   * montage and zoom titles. Labels, notes, and statuses stay sans.
   */
  displayFont: string
  /** The weight that pairs with {@link Palette.displayFont}. */
  displayWeight: number
  railBg: string
  railInk: string
  railInkDim: string
  railRule: string
  activeRowBg: string
  hoverRowBg: string
  noteBg: string
  galleryBg: string
  swatchBg: string
}

/**
 * Build the {@link Palette} for the notebook or dark-shell tone.
 *
 * Draw both tones from active shell tokens. The tone changes only the face of
 * the display headings, serif in notebook mode and bold sans in the shell, so
 * labels, notes, and statuses read the same as on every other screen.
 */
function buildPalette(t: Theme, notebook: boolean): Palette {
  return {
    screenBg: t.bg,
    cardBg: t.surface,
    ink: t.text,
    inkDim: t.dim,
    rule: t.border,
    controlRule: t.dim,
    displayFont: notebook ? FONTS.serif : FONTS.sans,
    displayWeight: notebook ? 400 : 700,
    railBg: t.surface,
    railInk: t.text,
    railInkDim: t.dim,
    railRule: t.border,
    activeRowBg: t.surface2,
    hoverRowBg: t.surface2,
    noteBg: t.surface2,
    galleryBg: t.surface2,
    swatchBg: t.surface3,
  }
}

/** Render detector-backed QC review. */
export function QcReviewScreen(props: QcReviewScreenProps = {}): ReactNode {
  const { projectEpoch } = useApp()
  return <QcReviewProject key={projectEpoch} {...props} />
}

function QcReviewProject(props: QcReviewScreenProps): ReactNode {
  const app = useApp()
  const mutations = useDurableMutations()
  const { t, tweaks, projectRef, configRevision, applyQcWrite } = app
  const notebook = tweaks.qcTone === 'notebook'
  const pal = buildPalette(t, notebook)

  const [discovered, setDiscovered] = useState<Subject[] | null>(() =>
    projectRef ? null : [],
  )
  const [loading, setLoading] = useState(
    props.subjects == null && projectRef !== null,
  )
  const [error, setError] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<Record<string, Partial<Subject>>>({})
  const [localActiveId, setLocalActiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<TabValue>('subcortical')
  const [noteState, setNoteState] = useState<{
    id: string | null
    text: string
  }>({ id: null, text: '' })
  // A shell-supplied cohort is stamped when the shell's discovery answers,
  // which can be after QC review opens (see cohortLoading below).
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(() =>
    props.subjects && (projectRef === null || app.discoveryAnswered)
      ? new Date().toISOString()
      : null,
  )
  const [reloadKey, setReloadKey] = useState(0)
  const [galleries, setGalleries] = useState<ResultArtifact[]>([])
  const [openedGalleries, setOpenedGalleries] = useState<
    Record<string, Partial<Record<TabValue, QcReviewOpenGrant>>>
  >({})
  const [selectedRunId, setSelectedRunId] = useState('')
  const [authoritativeRunId, setAuthoritativeRunId] = useState<string | null>(
    null,
  )
  // The host's token for the authoritative run's current gallery inventory.
  const [inventoryKey, setInventoryKey] = useState<string | null>(null)
  const [authorityError, setAuthorityError] = useState<string | null>(null)
  // The newest run whose galleries exist but cannot back new verdicts;
  // offered for inspection only, never as authority.
  const [earlierGalleryRunId, setEarlierGalleryRunId] = useState<string | null>(
    null,
  )
  // Whether resolving the authority threw, as opposed to the typed expected
  // answer that no current gallery set exists.
  const [authorityFailed, setAuthorityFailed] = useState(false)
  const [resolvedRunId, setResolvedRunId] = useState<string | null>(null)
  const [runOptions, setRunOptions] = useState<RunManifest[]>([])
  // Name the resolved run by its manifest; the raw run id stays out of copy.
  // Only the manifest matching the resolved run may name it, so the hint can
  // never describe a different run than the one the galleries came from.
  const resolvedRunPhrase = useMemo(() => {
    if (!resolvedRunId) return null
    const manifest = runOptions.find((option) => option.runId === resolvedRunId)
    return manifest ? manifestRunPhrase(manifest) : null
  }, [resolvedRunId, runOptions])
  // The selector offers only runs that started ENIGMA QC; stage runs of other
  // steps and dry runs hold no galleries. `runOptions` keeps every loaded
  // manifest so the hint and the earlier-gallery action can name any run.
  const enigmaRunOptions = useMemo(
    () =>
      runOptions.filter(
        (manifest) =>
          ranEnigmaQc(manifest) ||
          manifest.runId === authoritativeRunId ||
          manifest.runId === earlierGalleryRunId,
      ),
    [runOptions, authoritativeRunId, earlierGalleryRunId],
  )
  const [runCursor, setRunCursor] = useState<string | null>(null)
  const [loadingRuns, setLoadingRuns] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [writeFeedback, setWriteFeedback] = useState<{
    subjectId: string
    phase: 'saving' | 'saved' | 'error'
    message?: string
  } | null>(null)

  const cfg = props.cfg ?? app.cfg
  const onActiveChange = props.onActiveSubjectChange
  const propSubjects = props.subjects
  // The shell supplies an empty list until its discovery answers; until then
  // the cohort is loading, not empty, so the queue states the wait and its
  // counts hold the placeholder instead of 0.
  const cohortLoading =
    loading ||
    (propSubjects !== undefined &&
      projectRef !== null &&
      !app.discoveryAnswered)
  // Stamp a shell-supplied cohort once its discovery answers; a stamp taken
  // at mount would state a time for rows that were not read yet.
  if (propSubjects !== undefined && !cohortLoading && lastUpdatedAt === null) {
    setLastUpdatedAt(new Date().toISOString())
  }
  const noteFocused = useRef(false)
  const latestProjectRef = useRef(projectRef)
  useLayoutEffect(() => {
    latestProjectRef.current = projectRef
    return () => {
      latestProjectRef.current = null
    }
  }, [projectRef])
  const writeTokensRef = useRef<Map<string, number>>(new Map())
  const writeRevisionsRef = useRef<Map<string, number>>(new Map())
  const runRequestRef = useRef(0)
  // The newest gallery inventory request; an older answer is dropped.
  const inventoryRequestRef = useRef(0)
  // Gallery identities from a re-list. A stale one is not listed again
  // automatically, so a host that keeps refusing cannot loop.
  const relistedGalleryIdsRef = useRef<ReadonlySet<string>>(new Set())
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const queueRef = useRef<HTMLElement | null>(null)
  const queueHeaderRef = useRef<HTMLDivElement | null>(null)

  // Bootstrap only when the shell omits the cohort. Guard every asynchronous
  // state write with the cancellation flag.
  useEffect(() => {
    if (propSubjects) return
    if (!projectRef) return
    let alive = true
    void (async () => {
      try {
        const rows = await getApi().subjects.discover({
          project: projectRef,
          cfg,
          configRevision,
        })
        if (!alive) return
        setDiscovered(rows)
        setError(null)
        setLastUpdatedAt(new Date().toISOString())
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : 'Retry loading subjects.')
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [propSubjects, reloadKey, cfg, projectRef, configRevision])

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
      } catch (cause: unknown) {
        if (
          token === runRequestRef.current &&
          sameProject(latestProjectRef.current, captured)
        ) {
          setRunError(
            cause instanceof Error
              ? cause.message
              : 'Durable run history could not be loaded.',
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
  }, [projectRef, reloadKey, loadRuns])

  useEffect(() => {
    if (!projectRef) return
    const captured = projectRef
    let alive = true
    void Promise.resolve().then(async () => {
      if (!alive || !sameProject(latestProjectRef.current, captured)) return
      setSelectedRunId('')
      setAuthoritativeRunId(null)
      setInventoryKey(null)
      setOpenedGalleries({})
      setResolvedRunId(null)
      setGalleries([])
      setAuthorityError(null)
      setEarlierGalleryRunId(null)
      setAuthorityFailed(false)
      try {
        const authority = await getApi().qc.authoritativeRun({
          project: captured,
        })
        if (alive && sameProject(latestProjectRef.current, captured)) {
          setAuthoritativeRunId(authority.runId)
          setInventoryKey(authority.inventoryKey ?? null)
          // Present the reviewed operator precondition as the same bounded,
          // actionable state; it is an expected answer, not a failure.
          setAuthorityError(authority.unavailable?.message ?? null)
          setEarlierGalleryRunId(
            authority.unavailable?.reason === 'earlierGallery'
              ? authority.unavailable.earlierRunId
              : null,
          )
        }
      } catch (cause: unknown) {
        if (alive && sameProject(latestProjectRef.current, captured)) {
          setAuthorityFailed(true)
          setAuthorityError(
            cause instanceof Error
              ? cause.message
              : 'The current ENIGMA QC run could not be resolved.',
          )
        }
      }
    })
    return () => {
      alive = false
    }
  }, [projectRef, reloadKey])

  useEffect(() => {
    if (!projectRef) return
    const targetRunId = selectedRunId || authoritativeRunId
    if (!targetRunId) return
    let alive = true
    // Reuse the authoritative run's inventory while the host reports it
    // unchanged; a historical run is always read afresh.
    const reuseKey =
      targetRunId === authoritativeRunId && inventoryKey
        ? inventoryReuseKey(projectRef, targetRunId, inventoryKey)
        : null
    const reused = reuseKey ? reusedInventories.get(reuseKey) : undefined
    const token = ++inventoryRequestRef.current
    const current = (): boolean =>
      alive && token === inventoryRequestRef.current
    if (reused && reused.expiresAt > Date.now()) {
      void Promise.resolve().then(() => {
        if (!current()) return
        setResolvedRunId(reused.runId)
        setGalleries(reused.items)
      })
      return () => {
        alive = false
      }
    }
    void listGalleryInventory(projectRef, targetRunId)
      .then(({ runId, items }) => {
        if (reuseKey && runId === targetRunId) {
          rememberInventory(reuseKey, runId, items)
        }
        if (current()) {
          relistedGalleryIdsRef.current = new Set()
          setResolvedRunId(runId)
          setGalleries(items)
        }
      })
      .catch((cause: unknown) => {
        if (current()) {
          setResolvedRunId(targetRunId)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Retry loading QC artifacts.',
          )
        }
      })
    return () => {
      alive = false
    }
  }, [projectRef, reloadKey, selectedRunId, authoritativeRunId, inventoryKey])

  /**
   * Drop the reused gallery inventory and list it afresh. Resolve whether the
   * fresh inventory replaced the shown one; reject when listing fails.
   */
  const relistGalleries = useCallback(async (): Promise<boolean> => {
    const targetRunId = selectedRunId || authoritativeRunId
    if (!projectRef || !targetRunId) return false
    const captured = projectRef
    const reuseKey =
      targetRunId === authoritativeRunId && inventoryKey
        ? inventoryReuseKey(captured, targetRunId, inventoryKey)
        : null
    if (reuseKey) reusedInventories.delete(reuseKey)
    const token = ++inventoryRequestRef.current
    const { runId, items } = await listGalleryInventory(captured, targetRunId)
    if (reuseKey && runId === targetRunId) {
      rememberInventory(reuseKey, runId, items)
    }
    if (
      token !== inventoryRequestRef.current ||
      !sameProject(latestProjectRef.current, captured)
    ) {
      return false
    }
    relistedGalleryIdsRef.current = new Set(
      items.map((item) => item.artifactId),
    )
    setResolvedRunId(runId)
    setGalleries(items)
    return true
  }, [projectRef, selectedRunId, authoritativeRunId, inventoryKey])

  /**
   * Recover a gallery whose identity the host no longer holds by listing the
   * galleries again, once: an identity that came from such a re-list is not
   * listed again automatically.
   */
  const recoverGalleryIdentity = useCallback(
    async (artifactId: string): Promise<boolean> =>
      relistedGalleryIdsRef.current.has(artifactId) ? false : relistGalleries(),
    [relistGalleries],
  )

  /** Re-discover locally and refresh shell-owned cohort data when available. */
  const reload = useCallback(() => {
    props.refresh?.()
    if (propSubjects) {
      setLastUpdatedAt(new Date().toISOString())
    } else {
      writeTokensRef.current.clear()
      writeRevisionsRef.current.clear()
      setWriteFeedback(null)
      setOverlay({})
      setLoading(true)
    }
    // An explicit refresh reads the gallery inventory afresh.
    reusedInventories.clear()
    setGalleries([])
    setReloadKey((k) => k + 1)
  }, [props, propSubjects])

  const subjects = useMemo<Subject[]>(() => {
    const source = propSubjects ?? discovered ?? []
    if (Object.keys(overlay).length === 0) return source
    return source.map((s) => {
      const patch = overlay[s.id]
      return patch ? { ...s, ...patch } : s
    })
  }, [propSubjects, discovered, overlay])

  // The advisory surface-registration check: its status, the subjects it
  // flags in this queue, and the optional queue filter to them.
  const registration = useSurfaceRegistration(projectRef, reloadKey)
  const registrationStatus = registration.status
  const registrationBySubject = useMemo(
    () =>
      new Map<string, RegistrationSubjectResult>(
        (registrationStatus?.subjects ?? []).map((row) => [row.subjectId, row]),
      ),
    [registrationStatus],
  )
  const flaggedIds = useMemo(
    () =>
      new Set(
        subjects
          .filter((subject) => registrationBySubject.get(subject.id)?.flagged)
          .map((subject) => subject.id),
      ),
    [subjects, registrationBySubject],
  )
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const filterActive = flaggedOnly && flaggedIds.size > 0
  // The queue header states the check in one line, because the verdict
  // rail's Surface registration section can sit below the rail's fold: a
  // running check, why hemispheres stay unchecked when the check cannot run
  // or stopped by itself, and the flags. It states the check from the first
  // frame, so the status's arrival moves no queue row.
  const registrationLine = useMemo(
    () =>
      queueRegistrationLine(
        registrationStatus,
        registration.error,
        flaggedIds.size,
      ),
    [registrationStatus, registration.error, flaggedIds],
  )
  const registrationSectionRef = useRef<HTMLElement | null>(null)
  /** Bring the verdict rail's Surface registration section into view. */
  const showRegistration = useCallback(() => {
    const section = registrationSectionRef.current
    const rail = section?.parentElement
    if (!section || !rail) return
    // The rail is the section's offset parent, so the section's offset is
    // the rail scroll position that shows it at the top. Scroll only the
    // rail: scrollIntoView would also move every scrollable ancestor.
    rail.scrollTop = Math.max(0, section.offsetTop - 8)
    section.focus({ preventScroll: true })
  }, [])
  const queueSubjects = useMemo(
    () =>
      filterActive
        ? subjects.filter((subject) => flaggedIds.has(subject.id))
        : subjects,
    [filterActive, subjects, flaggedIds],
  )

  const requestedId = props.activeSubjectId ?? localActiveId
  const activeIndex = useMemo(() => {
    if (subjects.length === 0) return -1
    if (requestedId) return subjects.findIndex((s) => s.id === requestedId)
    return 0
  }, [subjects, requestedId])
  const requestedUnavailable =
    requestedId !== null && subjects.length > 0 && activeIndex < 0
  const active = activeIndex >= 0 ? subjects[activeIndex] : undefined
  const activeId = active?.id ?? null
  const activeNotes = active?.notes ?? ''
  const activeRevision = active?.qcRevision
  const galleryFor = useCallback(
    (selectedTab: TabValue): ResultArtifact | null => {
      const definition = tabFor(selectedTab)
      return (
        galleries.find((item) => item.label === definition.artifactLabel) ??
        null
      )
    },
    [galleries],
  )
  const selectRun = useCallback((runId: string) => {
    setSelectedRunId(runId)
    setGalleries([])
    setOpenedGalleries({})
    setResolvedRunId(null)
    setWriteFeedback(null)
  }, [])
  const showCurrentRun = useCallback(() => selectRun(''), [selectRun])
  // A run other than the authoritative one is shown for inspection only.
  const inspectingHistorical =
    selectedRunId !== '' && selectedRunId !== authoritativeRunId
  // Without a current gallery set the authority answer is the gallery pane's
  // whole state. The pane's generic "No ... gallery is produced yet" state
  // under it would read as though QC had never run, although earlier galleries
  // exist.
  const galleryAuthority = useMemo<GalleryAuthorityNotice | null>(() => {
    if (authorityError === null || selectedRunId) return null
    const earlierRunId = earlierGalleryRunId
    return {
      failed: authorityFailed,
      message: authorityError,
      // The selector can show the earlier run only once its manifest loaded.
      onInspectEarlier:
        earlierRunId &&
        runOptions.some((manifest) => manifest.runId === earlierRunId)
          ? () => selectRun(earlierRunId)
          : null,
    }
  }, [
    authorityError,
    authorityFailed,
    earlierGalleryRunId,
    runOptions,
    selectRun,
    selectedRunId,
  ])
  const galleryAvailable = useCallback(
    (artifact: ResultArtifact | null): artifact is ResultArtifact =>
      artifact?.presence === 'produced' &&
      artifact.exists &&
      artifact.openable &&
      artifact.provenance === 'current' &&
      typeof artifact.runId === 'string' &&
      typeof artifact.receiptSha256 === 'string',
    [],
  )
  const requiredGalleries = ENIGMA_TABS.map((item) => galleryFor(item.value))
  const allGalleriesAvailable =
    requiredGalleries.every(galleryAvailable) &&
    new Set(requiredGalleries.map((item) => item?.runId)).size === 1 &&
    new Set(requiredGalleries.map((item) => item?.receiptSha256)).size === 1
  const openedForActive = activeId ? openedGalleries[activeId] : undefined
  const reviewedGalleries = ENIGMA_TABS.flatMap((item) => {
    const artifact = galleryFor(item.value)
    const opened = openedForActive?.[item.value]
    return galleryAvailable(artifact) &&
      opened?.tab === item.value &&
      opened.subjectId === activeId &&
      opened.inventoryRunId === resolvedRunId &&
      opened?.runId === artifact.runId &&
      opened.receiptSha256 === artifact.receiptSha256
      ? [opened]
      : []
  })
  const reviewReady =
    Boolean(active) &&
    allGalleriesAvailable &&
    reviewedGalleries.length === ENIGMA_TABS.length
  useLayoutEffect(() => {
    if (activeId && activeRevision !== undefined) {
      const knownRevision = writeRevisionsRef.current.get(activeId)
      if (knownRevision === undefined || activeRevision > knownRevision) {
        writeRevisionsRef.current.set(activeId, activeRevision)
      }
    }
  }, [activeId, activeRevision])

  // Reset the note buffer during render when the active subject changes.
  if (noteState.id !== activeId) {
    setNoteState({ id: activeId, text: activeNotes })
  }
  const noteDraft = noteState.id === activeId ? noteState.text : activeNotes

  const setNoteDraft = useCallback(
    (text: string) => {
      setNoteState({ id: activeId, text })
    },
    [activeId],
  )

  // Keep the active row visible inside the queue. Scroll only the queue's own
  // container: scrollIntoView also scrolls every scrollable ancestor, which
  // would move the page on the initial selection and hide the subject header
  // and the verdict controls.
  useEffect(() => {
    if (!activeId) return
    const queue = queueRef.current
    const row = rowRefs.current.get(activeId)
    if (queue && row) keepRowInView(queue, row, queueHeaderRef.current)
  }, [activeId])

  const move = useCallback(
    (delta: number) => {
      // Move through the queue as shown, filtered or not.
      if (queueSubjects.length === 0) return
      const current = activeId
        ? queueSubjects.findIndex((subject) => subject.id === activeId)
        : -1
      const next =
        current < 0 && filterActive
          ? 0
          : Math.min(
              Math.max((current >= 0 ? current : 0) + delta, 0),
              queueSubjects.length - 1,
            )
      const target = queueSubjects[next]
      if (!target) return
      setLocalActiveId(target.id)
      onActiveChange?.(target.id)
    },
    [queueSubjects, activeId, filterActive, onActiveChange],
  )

  const select = useCallback(
    (id: string) => {
      setLocalActiveId(id)
      onActiveChange?.(id)
    },
    [onActiveChange],
  )

  /** Show only flagged subjects, starting at the first when needed. */
  const toggleFlaggedOnly = useCallback(() => {
    const next = !filterActive
    setFlaggedOnly(next)
    if (next && !(activeId && flaggedIds.has(activeId))) {
      const first = subjects.find((subject) => flaggedIds.has(subject.id))
      if (first) select(first.id)
    }
  }, [filterActive, activeId, flaggedIds, subjects, select])

  const registrationAdvisories = useMemo<RegistrationAdvisoryItem[]>(() => {
    const row = activeId ? registrationBySubject.get(activeId) : undefined
    const reference = registrationStatus?.reference
    if (!row || !reference) return []
    const provisional = registrationProvisional(registrationStatus)
    return row.hemispheres.flatMap((result) => {
      const text = hemisphereAdvisory(result, reference, provisional)
      return text
        ? [{ key: result.hemisphere, text, attention: result.flagged }]
        : []
    })
  }, [activeId, registrationBySubject, registrationStatus])

  /**
   * Persist the latest desired QC record. Serialize and coalesce writes per
   * subject. Read the expected revision immediately before each IPC call so a
   * rapid second edit uses the revision committed by the first.
   */
  const persistQc = useCallback(
    (
      subject: Subject,
      verdict: QcVerdict,
      note: string,
      failureMessage: string,
      reviewGrantIds?: string[],
      annotationOnly = false,
    ): Promise<void> => {
      if (!projectRef) return Promise.resolve()
      const captured = projectRef
      const subjectId = subject.id
      const token = (writeTokensRef.current.get(subjectId) ?? 0) + 1
      writeTokensRef.current.set(subjectId, token)
      setWriteFeedback({ subjectId, phase: 'saving' })
      return mutations
        .enqueue(captured, `qc:${subjectId}`, async () => {
          const expectedRevision =
            writeRevisionsRef.current.get(subjectId) ?? subject.qcRevision
          const result = await getApi().subjects.markQc({
            project: captured,
            subjectId,
            verdict,
            note,
            tags: subject.qcTags ?? [],
            ...(reviewGrantIds ? { reviewGrantIds } : {}),
            ...(annotationOnly ? { annotationOnly: true } : {}),
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          })
          if (result.subjectId !== subjectId) {
            throw new Error(
              'The QC write response identified another subject than the selected one.',
            )
          }
          writeRevisionsRef.current.set(subjectId, result.revision)
          // A QC write changes no detector state, so the committed record
          // updates the subject row for every screen. Detecting the subject
          // again would hold each save for seconds on a large cohort.
          applyQcWrite(captured, result)
          if (
            !sameProject(latestProjectRef.current, captured) ||
            writeTokensRef.current.get(subjectId) !== token
          ) {
            return
          }
          setOverlay((prev) => ({
            ...prev,
            [subjectId]: {
              ...prev[subjectId],
              qc: result.verdict,
              notes: result.note,
              qcTags: result.tags,
              qcRevision: result.revision,
            },
          }))
          setWriteFeedback({ subjectId, phase: 'saved' })
        })
        .catch((cause: unknown) => {
          if (
            sameProject(latestProjectRef.current, captured) &&
            writeTokensRef.current.get(subjectId) === token
          ) {
            setWriteFeedback({
              subjectId,
              phase: 'error',
              message:
                cause instanceof Error &&
                cause.message !== 'The persistent write failed.'
                  ? cause.message
                  : failureMessage,
            })
          }
          throw cause
        })
    },
    [applyQcWrite, mutations, projectRef],
  )

  const setVerdict = useCallback(
    (verdict: QcVerdict) => {
      if (!active || !reviewReady) return
      void persistQc(
        active,
        verdict,
        noteDraft,
        'Retry saving the QC verdict.',
        reviewedGalleries.map((grant) => grant.grantId),
      ).catch(() => undefined)
    },
    [active, noteDraft, persistQc, reviewReady, reviewedGalleries],
  )

  const saveNote = useCallback((): Promise<void> => {
    if (!active || noteDraft === activeNotes) return Promise.resolve()
    return persistQc(
      active,
      active.recordedQcVerdict ?? active.qc ?? null,
      noteDraft,
      'Retry saving the QC note.',
      undefined,
      true,
    )
  }, [active, activeNotes, noteDraft, persistQc])

  useDurableDraft(
    active && projectRef
      ? {
          project: projectRef,
          id: `qc-note:${active.id}`,
          revision: `${active.id}\u0000${noteDraft}`,
          dirty: noteDraft !== activeNotes,
          save: saveNote,
          discard: () => {
            setNoteState({ id: active.id, text: activeNotes })
            setWriteFeedback(null)
          },
        }
      : null,
  )

  // Refresh shortcut handlers in a layout effect so the first keystroke after a
  // cohort load cannot reach a stale active subject.
  const keymapRef = useRef({ move, setVerdict })
  useLayoutEffect(() => {
    keymapRef.current = { move, setVerdict }
  }, [move, setVerdict])

  // Register the screen-local keymap once. Suppress it while a dialog or note
  // editor owns focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (
        document.querySelector(
          'dialog[open], [role="dialog"], [role="alertdialog"]',
        )
      ) {
        return
      }
      if (noteFocused.current) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Let protocol radios and montage panels own arrow keys. Avoid advancing
      // the subject queue from the same event.
      if (
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown'
      ) {
        const el = document.activeElement
        if (
          el &&
          el.closest('[role="radiogroup"],[role="radio"],[data-qc-montage]')
        ) {
          return
        }
      }
      switch (e.key) {
        case 'j':
        case 'J':
        case 'ArrowDown':
        case 'ArrowRight':
          e.preventDefault()
          keymapRef.current.move(1)
          break
        case 'k':
        case 'K':
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault()
          keymapRef.current.move(-1)
          break
        case 'p':
        case 'P':
          e.preventDefault()
          keymapRef.current.setVerdict('pass')
          break
        case 'f':
        case 'F':
          e.preventDefault()
          keymapRef.current.setVerdict('fail')
          break
        case 'd':
        case 'D':
          e.preventDefault()
          keymapRef.current.setVerdict('defer')
          break
        case '1':
          e.preventDefault()
          setTab('subcortical')
          break
        case '2':
          e.preventDefault()
          setTab('internal')
          break
        case '3':
          e.preventDefault()
          setTab('external')
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tally = useMemo(() => {
    const counts = { pass: 0, fail: 0, defer: 0, unreviewed: 0 }
    for (const s of subjects) {
      if (s.qc === 'pass') counts.pass++
      else if (s.qc === 'fail') counts.fail++
      else if (s.qc === 'defer') counts.defer++
      else counts.unreviewed++
    }
    return counts
  }, [subjects])

  const activeTab = tabFor(tab)

  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        // Let both rails yield a little at the minimum window with a large
        // text scale so the review column keeps a usable width.
        gridTemplateColumns:
          'minmax(200px, 220px) minmax(0, 1fr) minmax(252px, 280px)',
        // Bound the row to the screen so the queue, the review column, and the
        // verdict rail each scroll on their own. An auto row would grow to the
        // review column's content, so the page would scroll instead, and
        // keeping the active queue row in view would move the page.
        gridTemplateRows: 'minmax(0, 1fr)',
        background: pal.screenBg,
        color: pal.ink,
        minHeight: 0,
      }}
    >
      <QueueRail
        t={t}
        pal={pal}
        subjects={queueSubjects}
        total={subjects.length}
        filtered={filterActive}
        flaggedIds={flaggedIds}
        registrationLine={registrationLine}
        onShowRegistration={showRegistration}
        activeId={activeId}
        loading={cohortLoading}
        error={error}
        onSelect={select}
        registerRow={(id, el) => {
          if (el) rowRefs.current.set(id, el)
          else rowRefs.current.delete(id)
        }}
        registerList={(el) => {
          queueRef.current = el
        }}
        registerHeader={(el) => {
          queueHeaderRef.current = el
        }}
      />

      <section
        style={{
          minWidth: 0,
          // Scroll the header and the gallery together, so the gallery can
          // use the column's full height at a small window or large text.
          overflow: 'auto',
          // Hold the scrollbar's room even when nothing scrolls, so a gallery
          // that starts to scroll does not narrow the header and rewrap it.
          scrollbarGutter: 'stable',
          display: 'flex',
          flexDirection: 'column',
          background: pal.cardBg,
          borderLeft: `1px solid ${pal.rule}`,
          borderRight: `1px solid ${pal.rule}`,
        }}
      >
        <header
          style={{
            padding: 'var(--ss-header-pad-y) 24px var(--ss-divider-margin)',
            borderBottom: `1px solid ${pal.rule}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            {/* The title block claims a fixed share of the row and the
                stamp's slot holds the widest stamp, so whether the stamp
                shares the title's row follows the pane's width alone, never
                the subject, the time, or whether the cohort has loaded. */}
            <div style={{ flex: `1 1 ${HEADER_TITLE_BASIS}px`, minWidth: 0 }}>
              <h1
                // The page-title metrics, in the tone's display face.
                style={{
                  margin: 0,
                  fontFamily: pal.displayFont,
                  fontWeight: pal.displayWeight,
                  fontSize: 20,
                  letterSpacing: -0.3,
                  color: pal.ink,
                }}
              >
                {active
                  ? `Subject ${active.id.replace(/^sub-/, '')}`
                  : 'QC review'}
              </h1>
              {/* The line shares a grid cell with the widest meta line's
                  hidden room, so the header's height does not follow the
                  subject. */}
              <div
                style={{
                  marginTop: 4,
                  display: 'grid',
                  fontFamily: FONTS.sans,
                  fontSize: 12,
                  color: pal.inkDim,
                }}
              >
                <MetaLineReserve t={t} color={pal.inkDim} />
                <span style={{ gridArea: '1 / 1' }}>
                  {active ? (
                    <MetaLine t={t} subject={active} color={pal.inkDim} />
                  ) : (
                    'no subject selected'
                  )}
                </span>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexShrink: 0,
                // Keep the group at the right edge on a row of its own too.
                marginLeft: 'auto',
                paddingTop: 2,
              }}
            >
              <span style={{ display: 'inline-grid', alignItems: 'center' }}>
                <FreshnessStampReserve />
                {!cohortLoading && lastUpdatedAt !== null && (
                  <span
                    style={{
                      gridArea: '1 / 1',
                      justifySelf: 'end',
                      display: 'flex',
                    }}
                  >
                    <FreshnessStamp
                      t={t}
                      at={lastUpdatedAt}
                      title={`The cohort was last updated at ${formatRunTime(lastUpdatedAt)}.`}
                      color={pal.inkDim}
                    />
                  </span>
                )}
              </span>
              <RefreshButton
                t={t}
                ariaLabel="Re-discover cohort"
                title="Re-discover cohort"
                onClick={reload}
                style={{ color: pal.inkDim, background: 'transparent' }}
              />
            </div>
          </div>

          <div style={{ marginTop: 'var(--ss-section-gap)' }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 12,
                alignItems: 'flex-end',
                marginBottom: 12,
              }}
            >
              <label
                htmlFor="qc-artifact-run"
                style={{
                  flex: '1 1 220px',
                  maxWidth: 340,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  color: pal.inkDim,
                  fontFamily: FONTS.sans,
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                Run
                <select
                  id="qc-artifact-run"
                  value={selectedRunId}
                  onChange={(event) => selectRun(event.target.value)}
                  style={{
                    height: 'var(--ss-input-h)',
                    width: '100%',
                    padding: '0 8px',
                    border: `1px solid ${pal.controlRule}`,
                    borderRadius: 4,
                    background: t.bg,
                    color: pal.ink,
                    fontFamily: FONTS.sans,
                    fontSize: 11,
                    // The bold label around the select must not set its value.
                    fontWeight: 400,
                  }}
                >
                  <option value="">Current ENIGMA run</option>
                  {enigmaRunOptions.map((manifest) => (
                    <option key={manifest.runId} value={manifest.runId}>
                      {manifest.runId === earlierGalleryRunId
                        ? `${manifestRunLabel(manifest)}${TEXT_GAP}earlier ENIGMA galleries`
                        : manifestRunLabel(manifest)}
                    </option>
                  ))}
                </select>
              </label>
              <div
                style={{
                  flex: '1 1 220px',
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  minHeight: 'var(--ss-input-h)',
                }}
              >
                {/* The slot holds the resolved sentence's room from the
                    first frame, so its arrival moves neither the tabs nor
                    the gallery. */}
                <div style={{ display: 'grid', flex: '1 1 auto', minWidth: 0 }}>
                  <RunHintReserve t={t} />
                  <Hint t={t} style={{ gridArea: '1 / 1' }}>
                    {resolvedRunId && inspectingHistorical
                      ? `The ${resolvedRunPhrase ?? 'selected run'} is shown for inspection only. New verdicts use the current ENIGMA run.`
                      : resolvedRunId
                        ? currentRunHint(resolvedRunPhrase)
                        : authorityError
                          ? null
                          : 'Resolving the current ENIGMA run...'}
                  </Hint>
                </div>
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
                {/* The gallery pane states the authority answer when it shows. */}
                {authorityError && !(active && galleryAuthority) && (
                  <Hint t={t}>{authorityError}</Hint>
                )}
              </div>
            </div>
            <Segments
              t={t}
              value={tab}
              ariaLabel="ENIGMA QC protocol"
              options={ENIGMA_TABS.map((x) => ({
                value: x.value,
                label: x.label,
                title: `${x.help} Shortcut: ${x.hint}.`,
              }))}
              onChange={(v) => setTab(v as TabValue)}
            />
          </div>
        </header>

        <div style={{ flex: 1, padding: 'var(--ss-card-pad)' }}>
          {active ? (
            <QcMontage
              key={`${active.id}:${activeTab.value}:${galleryFor(activeTab.value)?.artifactId ?? 'missing'}`}
              t={t}
              pal={pal}
              tab={activeTab.value}
              label={activeTab.label}
              project={projectRef}
              artifact={galleryFor(activeTab.value)}
              // A selected run's inventory always resolves, even when the
              // authority lookup reported no current gallery set.
              resolving={
                resolvedRunId === null &&
                (inspectingHistorical || authorityError === null)
              }
              authority={galleryAuthority}
              historical={
                inspectingHistorical
                  ? {
                      ...historicalGalleryFact(
                        galleryFor(activeTab.value),
                        selectedRunId,
                        activeTab.label,
                      ),
                      onShowCurrent: showCurrentRun,
                    }
                  : null
              }
              subjectId={active.id}
              opened={reviewedGalleries.some(
                (grant) => grant.tab === activeTab.value,
              )}
              onStaleIdentity={recoverGalleryIdentity}
              onRelist={relistGalleries}
              onOpened={(evidence) => {
                setOpenedGalleries((current) => ({
                  ...current,
                  [active.id]: {
                    ...current[active.id],
                    [activeTab.value]: evidence,
                  },
                }))
              }}
            />
          ) : (
            <Placeholder
              ink={pal.ink}
              text={
                cohortLoading
                  ? 'Loading the cohort...'
                  : requestedUnavailable
                    ? `${requestedId} is unavailable in this project.`
                    : 'No subject is selected; the queue lists the subjects to review.'
              }
            />
          )}
        </div>
      </section>

      <VerdictMargin
        t={t}
        pal={pal}
        active={active}
        advisories={registrationAdvisories}
        registration={registration}
        registerRegistrationSection={(el) => {
          registrationSectionRef.current = el
        }}
        flaggedInQueue={flaggedIds.size}
        filterActive={filterActive}
        onToggleFlagged={toggleFlaggedOnly}
        note={noteDraft}
        tally={cohortLoading ? null : tally}
        total={cohortLoading ? null : subjects.length}
        feedback={
          activeId && writeFeedback?.subjectId === activeId
            ? writeFeedback
            : null
        }
        onVerdict={setVerdict}
        verdictDisabledReason={
          !active
            ? 'Select a subject from the queue to record a verdict.'
            : !allGalleriesAvailable
              ? 'Open all three galleries first.'
              : !reviewReady
                ? `Review all three galleries first (${reviewedGalleries.length}/3).`
                : null
        }
        onNoteChange={setNoteDraft}
        onNoteFocus={() => {
          noteFocused.current = true
        }}
        onNoteBlur={() => {
          noteFocused.current = false
          void saveNote().catch(() => undefined)
        }}
      />
    </div>
  )
}

/** The queue registration line's font size in pixels and line height. */
const REGISTRATION_LINE_FONT_SIZE = 11
const REGISTRATION_LINE_HEIGHT = 1.4

/**
 * Lead the queue's registration line with the glyph of its state. The check
 * is a run, so its states draw the matrix's run glyphs.
 */
function RegistrationGlyph(p: {
  t: Theme
  glyph: QueueRegistrationLine['glyph']
}): ReactNode {
  switch (p.glyph) {
    case 'warning':
      return <NoticeGlyph t={p.t} tone="warn" />
    case 'running':
      return <StatusGlyph t={p.t} st="running" progress={null} />
    case 'reading':
      // A read is a wait, not active work: the still waiting ring.
      return <StatusGlyph t={p.t} st="waiting" />
    case 'clear':
      return <StatusGlyph t={p.t} st="done" />
    case 'idle':
      return <StatusGlyph t={p.t} st="pending" />
  }
}

interface QueueRailProps {
  t: Theme
  pal: Palette
  /** The subjects shown, all or only the flagged ones. */
  subjects: Subject[]
  /** The number of subjects in the whole queue. */
  total: number
  /** Whether the queue shows only flagged subjects. */
  filtered: boolean
  /** The subjects whose surface registration the check flags. */
  flaggedIds: ReadonlySet<string>
  /** The check's one-line state, shown from the first queue frame. */
  registrationLine: QueueRegistrationLine
  /** Bring the verdict rail's Surface registration section into view. */
  onShowRegistration: () => void
  activeId: string | null
  loading: boolean
  error: string | null
  onSelect: (id: string) => void
  registerRow: (id: string, el: HTMLButtonElement | null) => void
  /** Register the queue's own scroll container. */
  registerList: (el: HTMLElement | null) => void
  /** Register the sticky header that covers the top of the scrolled queue. */
  registerHeader: (el: HTMLDivElement | null) => void
}

const VERDICT_LEGEND: readonly VerdictStatus[] = [
  'pass',
  'fail',
  'review',
  'unreviewed',
]

function QueueRail(p: QueueRailProps): ReactNode {
  const { t, pal } = p
  return (
    <nav
      ref={(el) => p.registerList(el)}
      aria-label="Subject queue"
      style={{
        // Make the queue its rows' offset parent for keepRowInView.
        position: 'relative',
        overflow: 'auto',
        background: pal.railBg,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        ref={(el) => p.registerHeader(el)}
        style={{
          position: 'sticky',
          top: 0,
          background: pal.railBg,
          borderBottom: `1px solid ${pal.railRule}`,
        }}
      >
        <div
          style={{
            padding: '12px 12px 6px',
            fontFamily: FONTS.sans,
            fontSize: 12,
            fontWeight: 700,
            color: pal.railInk,
          }}
        >
          Queue{TEXT_GAP}
          {p.loading
            ? COHORT_LOADING_VALUE
            : p.filtered
              ? `${p.subjects.length} of ${p.total}, flagged only`
              : p.subjects.length}
        </div>
        <div style={{ padding: '0 12px 6px' }}>
          <button
            type="button"
            title="Show the Surface registration section."
            onClick={p.onShowRegistration}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
              width: '100%',
              // Hold two rows, as most lines take in the rail, so the line
              // that replaces "reading..." moves no queue row; this also
              // keeps a 24 px target. Pixels, not em: the text-scale zoom
              // would scale an em twice.
              minHeight:
                2 * REGISTRATION_LINE_FONT_SIZE * REGISTRATION_LINE_HEIGHT + 8,
              padding: '4px 0',
              border: 'none',
              background: 'transparent',
              color: pal.railInk,
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: FONTS.sans,
              fontSize: REGISTRATION_LINE_FONT_SIZE,
              lineHeight: REGISTRATION_LINE_HEIGHT,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: 15,
                flexShrink: 0,
                color: t.warning,
              }}
            >
              <RegistrationGlyph t={t} glyph={p.registrationLine.glyph} />
            </span>
            <span
              style={{
                textDecoration: 'underline',
                textDecorationColor: pal.railInkDim,
                textUnderlineOffset: 2,
              }}
            >
              {p.registrationLine.text}
            </span>
          </button>
        </div>
        <RailLegend t={t} inkDim={pal.railInkDim} />
      </div>

      {p.loading && (
        // Keep the queue's 12 px gutter: the inline loading row has none.
        <div style={{ padding: '0 12px' }}>
          <LoadingState t={t} label="Loading the cohort..." />
        </div>
      )}
      {p.error && (
        <ErrorState
          t={t}
          title="Could not load the cohort."
          detail={p.error ?? undefined}
        />
      )}
      {!p.loading && !p.error && p.subjects.length === 0 && (
        <EmptyState
          t={t}
          icon="subjects"
          message="No subjects are in this cohort."
          hint="Add subjects to the configured data root, then re-discover the cohort."
        />
      )}

      {p.subjects.map((s) => (
        <QueueRow
          key={s.id}
          t={t}
          pal={pal}
          subject={s}
          flagged={p.flaggedIds.has(s.id)}
          isActive={s.id === p.activeId}
          onSelect={p.onSelect}
          registerRow={p.registerRow}
        />
      ))}
    </nav>
  )
}

function RailLegend(p: { t: Theme; inkDim: string }): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 10px',
        padding: '0 12px 10px',
      }}
    >
      {VERDICT_LEGEND.map((status) => (
        <span
          key={status}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontFamily: FONTS.sans,
            fontSize: 10,
            color: p.inkDim,
          }}
        >
          <ReviewGlyph t={p.t} state={status} />
          {LEGEND_LABEL[status]}
        </span>
      ))}
    </div>
  )
}

interface QueueRowProps {
  t: Theme
  pal: Palette
  subject: Subject
  /** Whether the surface-registration check flags this subject. */
  flagged: boolean
  isActive: boolean
  onSelect: (id: string) => void
  registerRow: (id: string, el: HTMLButtonElement | null) => void
}

/**
 * Make the whole queue row a button. Put its verdict in the accessible name so
 * screen-reader users receive the same state as the decorative glyph. Reveal
 * clickability with a hover tint.
 */
function QueueRow(p: QueueRowProps): ReactNode {
  const { t, pal, subject: s } = p
  const [hover, setHover] = useState(false)
  const status = verdictStatus(s.qc)
  const background = p.isActive
    ? pal.activeRowBg
    : hover
      ? pal.hoverRowBg
      : 'transparent'
  return (
    <button
      type="button"
      ref={(el) => p.registerRow(s.id, el)}
      aria-current={p.isActive ? 'true' : undefined}
      aria-label={`${s.id}, ${s.cohort}, QC ${verdictLabel(status)}${p.flagged ? ', surface registration flagged' : ''}`}
      onClick={() => p.onSelect(s.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        minHeight: 28,
        padding: '6px 12px',
        border: 'none',
        borderLeft: `2px solid ${p.isActive ? t.accent : 'transparent'}`,
        background,
        color: pal.railInk,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <ReviewGlyph t={t} state={status} />
      <span
        style={{
          fontFamily: FONTS.mono,
          fontSize: 12,
          color: pal.railInk,
          flexShrink: 0,
        }}
      >
        {s.id}
      </span>
      {p.flagged && (
        <span
          title="The surface registration fits the atlas poorly."
          style={{ display: 'inline-flex', flexShrink: 0 }}
        >
          <NoticeGlyph t={t} tone="warn" />
        </span>
      )}
      <span
        title={s.cohort}
        style={{
          fontFamily: FONTS.sans,
          fontSize: 10,
          color: pal.railInkDim,
          flex: 1,
          minWidth: 0,
          textAlign: 'right',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {COHORT_LABEL[s.cohort]}
      </span>
    </button>
  )
}

const MONTAGE_FETCH_CONCURRENCY = 4

type PanelImage =
  | { phase: 'pending' }
  | { phase: 'ready'; dataUrl: string }
  | { phase: 'error'; message: string }

interface MontageState {
  key: string
  phase: 'loading' | 'ready' | 'error'
  view: QcGalleryView | null
  message: string | null
  /** Whether the error is a gallery list the host no longer recognizes. */
  stale?: boolean
}

/**
 * The authority answer that leaves the gallery pane without a current gallery
 * set: the typed expected absence, or a failure to resolve the authority.
 */
interface GalleryAuthorityNotice {
  failed: boolean
  message: string
  /** Select the run whose galleries cannot back verdicts, if listed. */
  onInspectEarlier: (() => void) | null
}

/**
 * The fact that leaves the gallery pane without a gallery while a historical
 * run is selected. It points to the current run, which holds the galleries,
 * rather than offering a rerun.
 */
interface HistoricalGalleryNotice {
  title: string
  message: string
  /** Select the current ENIGMA run again. */
  onShowCurrent: () => void
}

function errorMessage(cause: unknown, fallback: string): string {
  return (cause instanceof Error ? cause.message : fallback).slice(0, 512)
}

/**
 * Render the ENIGMA montage without executing or embedding upstream HTML.
 * Revalidate every declared panel, then fetch it through the bounded image
 * bridge and verify its receipt-bound size and SHA-256. Fail closed when a panel
 * changes after verification.
 *
 * Treat display of the complete verified grid as review evidence. Mint a one-use
 * review grant only after every panel renders from verified bytes. Keep Open and
 * Reveal as secondary routes to the same artifact.
 *
 * When the host no longer holds the gallery's identity, list the galleries
 * again once and retry without showing the failure; offer Retry after that.
 */
function QcMontage({
  t,
  pal,
  project,
  artifact,
  tab,
  label,
  subjectId,
  opened,
  onOpened,
  onStaleIdentity,
  onRelist,
  resolving = false,
  authority = null,
  historical = null,
}: {
  t: Theme
  pal: Palette
  project: ProjectRef | null
  artifact: ResultArtifact | null
  tab: TabValue
  label: string
  subjectId: string
  opened: boolean
  onOpened: (grant: QcReviewOpenGrant) => void
  /**
   * List the galleries again after the host refused this gallery's identity.
   * Resolve false when this identity already came from such a re-list.
   */
  onStaleIdentity?: (artifactId: string) => Promise<boolean>
  /** List the galleries again at the reviewer's request. */
  onRelist?: () => Promise<boolean>
  /**
   * Whether the gallery inventory is still loading, which holds back the
   * "run ENIGMA QC" instruction.
   */
  resolving?: boolean
  /** The authority answer that leaves no current gallery set to show. */
  authority?: GalleryAuthorityNotice | null
  /** Why the selected historical run has no gallery for this tab. */
  historical?: HistoricalGalleryNotice | null
}): ReactNode {
  const available =
    artifact?.presence === 'produced' &&
    artifact.exists &&
    artifact.openable &&
    artifact.provenance === 'current' &&
    typeof artifact.runId === 'string' &&
    typeof artifact.receiptSha256 === 'string'
  const artifactId = artifact?.artifactId ?? null
  const loadable = Boolean(project && artifactId && available)
  // A retry of the same gallery identity loads the montage again.
  const [attempt, setAttempt] = useState(0)
  const requestKey = `${artifactId ?? 'none'}\u0000${subjectId}\u0000${tab}\u0000${String(loadable)}\u0000${attempt}`
  const [state, setState] = useState<MontageState>({
    key: requestKey,
    phase: loadable ? 'loading' : 'error',
    view: null,
    message: null,
  })
  const [images, setImages] = useState<Record<string, PanelImage>>({})
  const [zoomIndex, setZoomIndex] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Reset a changed request during render. Keep effect-driven state writes after
  // an await.
  if (state.key !== requestKey) {
    setState({
      key: requestKey,
      phase: loadable ? 'loading' : 'error',
      view: null,
      message: null,
    })
    setImages({})
    setZoomIndex(null)
    setActionError(null)
  }

  const staleMessage = `The ${label} gallery list expired before the montage loaded.`
  /**
   * List the galleries again after the host refused this gallery's identity,
   * then retry. A fresh identity remounts this montage; the same identity
   * loads again in place. Offer Retry when no re-list replaced the list.
   */
  const recoverIdentity = async (
    isCurrent: () => boolean,
    automatic: boolean,
  ): Promise<void> => {
    let message = staleMessage
    try {
      const relisted = automatic
        ? artifactId !== null &&
          onStaleIdentity !== undefined &&
          (await onStaleIdentity(artifactId))
        : onRelist !== undefined && (await onRelist())
      if (!isCurrent()) return
      if (relisted) {
        setAttempt((value) => value + 1)
        return
      }
    } catch (cause: unknown) {
      if (!isCurrent()) return
      message = errorMessage(cause, staleMessage)
    }
    setState({
      key: requestKey,
      phase: 'error',
      view: null,
      message,
      stale: true,
    })
  }
  const retry = (): void => {
    setActionError(null)
    setState({ key: requestKey, phase: 'loading', view: null, message: null })
    void recoverIdentity(() => mountedRef.current, false)
  }
  const recoverFromAction = (): void => {
    void recoverIdentity(() => mountedRef.current, true)
  }

  // Describe the montage, render verified bytes, and attest to the complete
  // display. Guard every asynchronous state write with cancellation state.
  useEffect(() => {
    if (!project || !artifactId || !available) return undefined
    let alive = true
    void (async () => {
      let view: QcGalleryView
      try {
        view = await getApi().qc.galleryImages({
          project,
          artifactId,
          subjectId,
        })
      } catch (cause: unknown) {
        if (!alive) return
        if (isUnknownArtifactIdentity(cause)) {
          await recoverIdentity(() => alive, true)
          return
        }
        setState({
          key: requestKey,
          phase: 'error',
          view: null,
          message: errorMessage(
            cause,
            'Retry describing this QC montage with the detector.',
          ),
        })
        return
      }
      if (!alive) return
      if (view.tab !== tab || view.subjectId !== subjectId) {
        setState({
          key: requestKey,
          phase: 'error',
          view: null,
          message: 'The montage response named another subject or view.',
        })
        return
      }
      setState({ key: requestKey, phase: 'ready', view, message: null })
      setImages(
        Object.fromEntries(
          view.panels.map((panel) => [
            panel.montage.artifactId,
            { phase: 'pending' } as PanelImage,
          ]),
        ),
      )
      const queue = [...view.panels]
      let failed = false
      const worker = async (): Promise<void> => {
        for (;;) {
          const panel = queue.shift()
          if (!panel || !alive) return
          try {
            const image = await getApi().artifact.previewImage({
              project,
              artifactId: panel.montage.artifactId,
            })
            if (!alive) return
            setImages((current) => ({
              ...current,
              [panel.montage.artifactId]: {
                phase: 'ready',
                dataUrl: image.dataUrl,
              },
            }))
          } catch (cause: unknown) {
            failed = true
            if (!alive) return
            setImages((current) => ({
              ...current,
              [panel.montage.artifactId]: {
                phase: 'error',
                message: errorMessage(cause, 'Retry reading this panel.'),
              },
            }))
          }
        }
      }
      await Promise.all(
        Array.from(
          { length: Math.min(MONTAGE_FETCH_CONCURRENCY, view.panels.length) },
          worker,
        ),
      )
      if (!alive || failed) return
      try {
        const { reviewGrant } = await getApi().qc.attestGalleryView({
          project,
          artifactId,
          subjectId,
        })
        if (
          alive &&
          reviewGrant.tab === tab &&
          reviewGrant.subjectId === subjectId
        ) {
          onOpened(reviewGrant)
        }
      } catch (cause: unknown) {
        if (!alive) return
        if (isUnknownArtifactIdentity(cause)) {
          await recoverIdentity(() => alive, true)
          return
        }
        setActionError(
          errorMessage(
            cause,
            'The host rejected the review attestation of this montage, so it needs another review.',
          ),
        )
      }
    })()
    return () => {
      alive = false
    }
    // Exclude the fresh `onOpened` closure to avoid reloading the montage after
    // unrelated keystrokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, artifactId, subjectId, tab, available, requestKey])

  const panels = useMemo(() => state.view?.panels ?? [], [state.view])
  const loaded = panels.filter(
    (panel) => images[panel.montage.artifactId]?.phase === 'ready',
  ).length
  const groups = useMemo(() => {
    const ordered: { group: string; items: QcGalleryPanel[] }[] = []
    for (const panel of panels) {
      const last = ordered[ordered.length - 1]
      if (last && last.group === panel.group) last.items.push(panel)
      else ordered.push({ group: panel.group, items: [panel] })
    }
    return ordered
  }, [panels])

  const focusPanel = useCallback((index: number) => {
    const grid = gridRef.current
    if (!grid) return
    const tiles = grid.querySelectorAll<HTMLButtonElement>('[data-qc-panel]')
    const target = tiles[Math.min(Math.max(index, 0), tiles.length - 1)]
    target?.focus()
  }, [])

  if (!available && authority) {
    return (
      <MontageNotice
        t={t}
        pal={pal}
        label={label}
        available={false}
        title={
          authority.failed
            ? 'Could not resolve the current ENIGMA run.'
            : `No current ${label} gallery exists.`
        }
        message={authority.message}
        actions={
          authority.onInspectEarlier ? (
            <Btn
              t={t}
              small
              secondary
              label="Inspect earlier galleries"
              onClick={authority.onInspectEarlier}
              title="Select the earlier run in QC artifact run for inspection only."
            />
          ) : null
        }
        error={null}
      />
    )
  }
  if (!available && resolving) {
    // The inventory of the authoritative ENIGMA run can take a minute on a
    // large cohort; an empty artifact list until then is not evidence that
    // the gallery has to be produced.
    return (
      <div
        role="status"
        style={{
          minHeight: 300,
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          border: `1px solid ${pal.rule}`,
          borderRadius: 4,
          background: pal.galleryBg,
          fontFamily: FONTS.sans,
          fontSize: 12,
          color: pal.inkDim,
        }}
      >
        Loading the {label} gallery inventory...
      </div>
    )
  }
  if (!available && historical) {
    return (
      <MontageNotice
        t={t}
        pal={pal}
        label={label}
        available={false}
        title={historical.title}
        message={historical.message}
        actions={
          <Btn
            t={t}
            small
            secondary
            label="Show current ENIGMA run"
            onClick={historical.onShowCurrent}
            title="Select Current ENIGMA run in QC artifact run."
          />
        }
        error={null}
      />
    )
  }
  if (!available || state.phase === 'error') {
    return (
      <MontageNotice
        t={t}
        pal={pal}
        label={label}
        available={available}
        message={
          state.message ??
          artifact?.detail ??
          'Run ENIGMA QC, then refresh after the detector reports a produced gallery.'
        }
        actions={
          artifact && project ? (
            <MontageActions
              t={t}
              project={project}
              artifact={artifact}
              tab={tab}
              subjectId={subjectId}
              available={available}
              onOpened={onOpened}
              onError={setActionError}
              onStale={recoverFromAction}
              {...(state.stale ? { onRetry: retry } : {})}
            />
          ) : null
        }
        error={actionError}
      />
    )
  }

  // Every panel has loaded; the count then adds nothing to the picture.
  const allDrawn = state.phase !== 'loading' && loaded === panels.length
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        // Bound the block so the header actions end at the last tile's edge.
        maxWidth: MONTAGE_MAX_WIDTH,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0, display: 'grid', gap: 3 }}>
          <strong
            style={{
              fontFamily: pal.displayFont,
              fontSize: 14,
              fontWeight: pal.displayWeight,
              color: pal.ink,
            }}
          >
            {label} montage{TEXT_GAP}
            {subjectId}
          </strong>
          <span
            style={{
              fontFamily: FONTS.sans,
              fontSize: 11,
              color: pal.inkDim,
              ...(allDrawn ? VISUALLY_HIDDEN : {}),
            }}
          >
            {state.phase === 'loading'
              ? 'Loading the panels...'
              : `${loaded}/${panels.length} panels verified and drawn.`}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          {opened && (
            <ReviewChip t={t} state="pass" label="Reviewed in app" small />
          )}
          {artifact && project && (
            <MontageActions
              t={t}
              project={project}
              artifact={artifact}
              tab={tab}
              subjectId={subjectId}
              available={available}
              onOpened={onOpened}
              onError={setActionError}
              onStale={recoverFromAction}
            />
          )}
        </div>
      </div>

      {actionError && (
        <div
          role="alert"
          style={{ color: t.failed, fontFamily: FONTS.sans, fontSize: 11 }}
        >
          {actionError}
        </div>
      )}

      {state.view?.imagesChangedSinceVerdict && (
        <div
          role="note"
          aria-label="Images changed since the verdict"
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            border: `1px solid color-mix(in srgb, ${t.warning} 27%, transparent)`,
            background: t.warningSoft,
            fontFamily: FONTS.sans,
            fontSize: 12,
            lineHeight: 1.45,
            color: pal.ink,
          }}
        >
          {imagesChangedText(state.view.imagesChangedSinceVerdict)}
        </div>
      )}

      <div
        ref={gridRef}
        data-qc-montage="true"
        role="group"
        aria-label={`${label} montage for ${subjectId}`}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        {groups.map((group) => (
          <section key={group.group} style={{ display: 'grid', gap: 6 }}>
            <h2
              style={{
                margin: 0,
                fontFamily: FONTS.sans,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.2,
                color: pal.inkDim,
              }}
            >
              {group.group}
            </h2>
            <div
              style={{
                display: 'grid',
                // At most four columns, fewer in a narrow pane.
                gridTemplateColumns:
                  'repeat(auto-fill, minmax(max(min(100%, 150px), calc((100% - 3 * var(--ss-gap)) / 4)), 1fr))',
                gap: 'var(--ss-gap)',
              }}
            >
              {group.items.map((panel) => {
                const index = panels.indexOf(panel)
                return (
                  <MontagePanel
                    key={panel.key}
                    t={t}
                    pal={pal}
                    panel={panel}
                    subjectId={subjectId}
                    image={images[panel.montage.artifactId]}
                    index={index}
                    total={panels.length}
                    onOpen={() => setZoomIndex(index)}
                    onMove={(delta) => focusPanel(index + delta)}
                  />
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {zoomIndex !== null && panels[zoomIndex] && project && (
        <MontageLightbox
          t={t}
          pal={pal}
          project={project}
          panels={panels}
          index={zoomIndex}
          subjectId={subjectId}
          label={label}
          onIndexChange={setZoomIndex}
          onClose={() => {
            setZoomIndex(null)
            focusPanel(zoomIndex)
          }}
        />
      )}
    </div>
  )
}

function MontageNotice(p: {
  t: Theme
  pal: Palette
  label: string
  available: boolean
  /** Replace the default headline derived from `available`. */
  title?: string
  message: string
  actions: ReactNode
  error: string | null
}): ReactNode {
  // Keep the fact and its action at the top of the pane. A tall centered box
  // would push the action below the fold of a 768 px window.
  return (
    <div
      data-testid="qc-montage-notice"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 8,
        padding: 16,
        border: `1px solid ${p.pal.rule}`,
        borderRadius: 4,
        background: p.pal.galleryBg,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: p.pal.ink,
        }}
      >
        <NoticeGlyph t={p.t} tone="warn" color={p.pal.ink} />
        <strong
          style={{ fontFamily: FONTS.sans, fontSize: 12, color: p.pal.ink }}
        >
          {p.title ??
            (p.available
              ? `The ${p.label} montage could not be shown.`
              : `No ${p.label} gallery is produced yet.`)}
        </strong>
      </div>
      <span
        style={{
          maxWidth: 640,
          fontFamily: FONTS.sans,
          fontSize: 12,
          color: p.pal.inkDim,
        }}
      >
        {p.message}
      </span>
      {p.actions}
      {p.error && (
        <div
          role="alert"
          style={{ color: p.t.failed, fontFamily: FONTS.sans, fontSize: 11 }}
        >
          {p.error}
        </div>
      )}
    </div>
  )
}

function MontageActions(p: {
  t: Theme
  project: ProjectRef
  artifact: ResultArtifact
  tab: TabValue
  subjectId: string
  available: boolean
  onOpened: (grant: QcReviewOpenGrant) => void
  onError: (message: string | null) => void
  /** Recover after the host refused the gallery's identity. */
  onStale?: () => void
  /** List the galleries again; shown when that is the recovery. */
  onRetry?: () => void
}): ReactNode {
  const label = tabFor(p.tab).label
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {p.onRetry && (
        <Btn
          t={p.t}
          small
          secondary
          label="Retry"
          title={`List the ${label} gallery again and show the montage.`}
          onClick={p.onRetry}
        />
      )}
      <Btn
        t={p.t}
        small
        ghost
        label="Open"
        title={`Open the verified ${p.subjectId} gallery in the system viewer.`}
        disabled={!p.available || !p.artifact.openable}
        onClick={() => {
          p.onError(null)
          void getApi()
            .artifact.open({
              project: p.project,
              artifactId: p.artifact.artifactId,
              focusText: p.subjectId,
            })
            .then(({ reviewGrant }) => {
              if (
                !reviewGrant ||
                reviewGrant.tab !== p.tab ||
                reviewGrant.subjectId !== p.subjectId
              ) {
                p.onError(
                  'Request a matching QC review grant before opening this gallery.',
                )
                return
              }
              p.onOpened(reviewGrant)
            })
            .catch((cause: unknown) => {
              if (isUnknownArtifactIdentity(cause) && p.onStale) {
                p.onStale()
                return
              }
              p.onError(errorMessage(cause, 'Retry opening the QC gallery.'))
            })
        }}
      />
      <Btn
        t={p.t}
        small
        ghost
        label="Reveal"
        title="Show the verified gallery file in the system file manager."
        disabled={!p.artifact.revealable}
        onClick={() => {
          p.onError(null)
          void getApi()
            .artifact.reveal({
              project: p.project,
              artifactId: p.artifact.artifactId,
            })
            .catch((cause: unknown) => {
              if (isUnknownArtifactIdentity(cause) && p.onStale) {
                p.onStale()
                return
              }
              p.onError(errorMessage(cause, 'Retry revealing the QC gallery.'))
            })
        }}
      />
    </div>
  )
}

function MontagePanel(p: {
  t: Theme
  pal: Palette
  panel: QcGalleryPanel
  subjectId: string
  image: PanelImage | undefined
  index: number
  total: number
  onOpen: () => void
  onMove: (delta: number) => void
}): ReactNode {
  const image = p.image ?? { phase: 'pending' as const }
  const shown = useKeyedPage(image.phase === 'ready' ? image.dataUrl : null)
  return (
    <button
      type="button"
      data-qc-panel="true"
      aria-label={`${p.panel.label}, ${p.subjectId}, panel ${p.index + 1} of ${p.total}`}
      disabled={image.phase !== 'ready'}
      onClick={p.onOpen}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          p.onMove(1)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          p.onMove(-1)
        }
      }}
      style={{
        display: 'grid',
        gap: 4,
        padding: 6,
        border: `1px solid ${p.pal.rule}`,
        borderRadius: 4,
        background: p.pal.cardBg,
        color: p.pal.ink,
        textAlign: 'left',
        cursor: image.phase === 'ready' ? 'zoom-in' : 'default',
      }}
    >
      <span
        style={{
          display: 'grid',
          placeItems: 'center',
          // Preserve the wrapper's 4:3 slice and 1:1 surface aspect ratios. Cap
          // only unexpectedly tall panels.
          minHeight: 72,
          maxHeight: 260,
          overflow: 'hidden',
          borderRadius: 2,
          // Show the panel keyed off MATLAB's white page, on the card; the
          // burned-in labels and subject tag keep their pixels.
          background: p.pal.cardBg,
        }}
      >
        {shown !== null ? (
          <img
            src={shown}
            alt={`${p.panel.label} montage panel for ${p.subjectId}`}
            style={{
              display: 'block',
              width: '100%',
              height: 'auto',
              maxHeight: 260,
              objectFit: 'contain',
            }}
          />
        ) : (
          <span
            style={{
              fontFamily: FONTS.sans,
              fontSize: 10.5,
              padding: 8,
              textAlign: 'center',
              color: image.phase === 'error' ? p.t.failed : p.pal.inkDim,
            }}
          >
            {image.phase === 'error' ? image.message : 'Loading the panel...'}
          </span>
        )}
      </span>
      <span
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 11,
            fontWeight: 700,
            color: p.pal.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {p.panel.detail}
        </span>
        {/* Use the search glyph to indicate full-size inspection. */}
        <Ico d={ICONS.search} />
      </span>
    </button>
  )
}

function MontageLightbox(p: {
  t: Theme
  pal: Palette
  project: ProjectRef
  panels: QcGalleryPanel[]
  index: number
  subjectId: string
  label: string
  onIndexChange: (index: number) => void
  onClose: () => void
}): ReactNode {
  const panel = p.panels[p.index]
  const artifactId = panel?.full.artifactId ?? null
  const project = p.project
  const [loaded, setLoaded] = useState<{
    artifactId: string | null
    image: PanelImage
  }>({ artifactId, image: { phase: 'pending' } })

  // Reset during render when the reviewer moves to another panel. Keep fetch
  // state writes after the await.
  if (loaded.artifactId !== artifactId) {
    setLoaded({ artifactId, image: { phase: 'pending' } })
  }
  const image =
    loaded.artifactId === artifactId
      ? loaded.image
      : ({ phase: 'pending' } as PanelImage)

  useEffect(() => {
    if (!artifactId) return undefined
    let alive = true
    void getApi()
      .artifact.previewImage({ project, artifactId })
      .then((preview) => {
        if (alive) {
          setLoaded({
            artifactId,
            image: { phase: 'ready', dataUrl: preview.dataUrl },
          })
        }
      })
      .catch((cause: unknown) => {
        if (alive) {
          setLoaded({
            artifactId,
            image: {
              phase: 'error',
              message: errorMessage(
                cause,
                'Retry reading the full-size panel.',
              ),
            },
          })
        }
      })
    return () => {
      alive = false
    }
  }, [project, artifactId])

  // The enlarged view keys ahead of the gallery panels still queued.
  const shown = useKeyedPage(image.phase === 'ready' ? image.dataUrl : null, 1)
  if (!panel) return null
  const move = (delta: number): void => {
    p.onIndexChange(Math.min(Math.max(p.index + delta, 0), p.panels.length - 1))
  }
  return (
    <Modal
      t={p.t}
      onDismiss={p.onClose}
      label={`${panel.label}, ${p.subjectId}, ${p.label} montage`}
      // The standard dialog padding keeps the title off the card edge.
      cardStyle={{ width: 'min(920px, 96vw)', gap: 10, padding: 18 }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          p.onClose()
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          p.onIndexChange(0)
        } else if (event.key === 'End') {
          event.preventDefault()
          p.onIndexChange(p.panels.length - 1)
        }
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0, display: 'grid', gap: 2 }}>
          {/* The zoom is a dialog, so its title takes dialog-title metrics
              in the tone's display face. */}
          <strong
            style={{
              fontFamily: p.pal.displayFont,
              fontSize: 18,
              fontWeight: p.pal.displayWeight,
              color: p.t.text,
            }}
          >
            {panel.label}
          </strong>
          <span
            style={{ fontFamily: FONTS.mono, fontSize: 11, color: p.t.dimText }}
          >
            {p.subjectId}
            {TEXT_GAP}
            {panel.full.displayPath}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
          }}
        >
          <Btn
            t={p.t}
            small
            ghost
            label="Previous"
            disabled={p.index === 0}
            onClick={() => move(-1)}
          />
          <Btn
            t={p.t}
            small
            ghost
            label="Next"
            disabled={p.index === p.panels.length - 1}
            onClick={() => move(1)}
          />
          <Btn t={p.t} small label="Close" onClick={p.onClose} />
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          minHeight: 320,
          maxHeight: '70vh',
          overflow: 'auto',
          borderRadius: 4,
          background: p.pal.cardBg,
        }}
      >
        {shown !== null ? (
          <img
            src={shown}
            alt={`${panel.label} full-size QC panel for ${p.subjectId}`}
            style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
          />
        ) : (
          <span
            style={{
              fontFamily: FONTS.sans,
              fontSize: 12,
              padding: 16,
              color: image.phase === 'error' ? p.t.failed : p.t.dimText,
            }}
          >
            {image.phase === 'error'
              ? image.message
              : 'Loading the full-size panel...'}
          </span>
        )}
      </div>
      <Hint t={p.t}>
        Panel {p.index + 1} of {p.panels.length}. Left and Right move between
        panels, and Escape closes the view.
      </Hint>
    </Modal>
  )
}

function Placeholder(p: { ink: string; text: string }): ReactNode {
  return (
    <div
      style={{
        height: '100%',
        minHeight: 300,
        display: 'grid',
        placeItems: 'center',
        fontFamily: FONTS.sans,
        fontSize: 13.5,
        color: p.ink,
      }}
    >
      {p.text}
    </div>
  )
}

interface Tally {
  pass: number
  fail: number
  defer: number
  unreviewed: number
}

interface VerdictMarginProps {
  t: Theme
  pal: Palette
  active: Subject | undefined
  /** The active subject's surface-registration advisories. */
  advisories: readonly RegistrationAdvisoryItem[]
  registration: SurfaceRegistrationState
  /** Register the Surface registration section the queue line leads to. */
  registerRegistrationSection: (el: HTMLElement | null) => void
  /** The number of flagged subjects in the queue. */
  flaggedInQueue: number
  filterActive: boolean
  onToggleFlagged: () => void
  note: string
  /** The verdict counts, or null while the cohort loads. */
  tally: Tally | null
  /** The cohort size, or null while the cohort loads. */
  total: number | null
  feedback: {
    subjectId: string
    phase: 'saving' | 'saved' | 'error'
    message?: string
  } | null
  onVerdict: (v: QcVerdict) => void
  verdictDisabledReason: string | null
  onNoteChange: (v: string) => void
  onNoteFocus: () => void
  onNoteBlur: () => void
}

function VerdictMargin(p: VerdictMarginProps): ReactNode {
  const { t, pal } = p
  const current = p.active?.qc ?? null
  const verdictDisabled = p.verdictDisabledReason !== null
  // Keep shortcut disclosure local to QC. Apply the machine-wide command-preview
  // preference only to Pipeline commands.
  const [showHints, setShowHints] = useState(true)
  return (
    <aside
      style={{
        // Make the rail its sections' offset parent, so the queue line can
        // scroll the Surface registration section into view.
        position: 'relative',
        overflow: 'auto',
        padding: 'var(--ss-card-pad)',
        background: pal.cardBg,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--ss-section-gap)',
        color: pal.ink,
      }}
    >
      <RegistrationAdvisory t={t} pal={pal} advisories={p.advisories} />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--ss-gap)',
        }}
      >
        <VerdictButton
          t={t}
          pal={pal}
          label="Pass"
          hint="P"
          tone="success"
          help={QC_VERDICT_HELP.pass}
          active={current === 'pass'}
          disabled={verdictDisabled}
          onClick={() => p.onVerdict('pass')}
        />
        <VerdictButton
          t={t}
          pal={pal}
          label="Fail"
          hint="F"
          tone="danger"
          help={QC_VERDICT_HELP.fail}
          active={current === 'fail'}
          disabled={verdictDisabled}
          onClick={() => p.onVerdict('fail')}
        />
        <VerdictButton
          t={t}
          pal={pal}
          label="Defer"
          hint="D"
          tone="neutral"
          help={QC_VERDICT_HELP.review}
          active={current === 'defer'}
          disabled={verdictDisabled}
          onClick={() => p.onVerdict('defer')}
        />
        {p.verdictDisabledReason && (
          <Hint t={t} style={{ color: pal.inkDim }}>
            {p.verdictDisabledReason}
          </Hint>
        )}
        {p.feedback && (
          <div
            role={p.feedback.phase === 'error' ? 'alert' : 'status'}
            aria-live="polite"
            style={{
              fontFamily: FONTS.sans,
              fontSize: 11,
              color:
                p.feedback.phase === 'error'
                  ? t.failed
                  : p.feedback.phase === 'saved'
                    ? t.done
                    : pal.inkDim,
            }}
          >
            {p.feedback.phase === 'saving'
              ? 'Saving the QC change...'
              : p.feedback.phase === 'saved'
                ? 'The QC change is saved.'
                : (p.feedback.message ?? 'Retry saving the QC change.')}
          </div>
        )}
      </div>

      <label
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          fontFamily: FONTS.sans,
          fontSize: 12,
          color: pal.inkDim,
        }}
      >
        Reviewer note
        <textarea
          value={p.note}
          aria-label="Reviewer note"
          disabled={!p.active}
          onChange={(e) => p.onNoteChange(e.target.value)}
          onFocus={p.onNoteFocus}
          onBlur={p.onNoteBlur}
          rows={5}
          placeholder="Saved when you leave the field."
          style={{
            resize: 'vertical',
            fontFamily: FONTS.sans,
            fontSize: 13,
            lineHeight: 1.5,
            color: pal.ink,
            background: pal.noteBg,
            border: `1px solid ${pal.controlRule}`,
            borderRadius: 4,
            padding: 10,
          }}
        />
      </label>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          paddingTop: 'var(--ss-section-gap)',
        }}
      >
        <div
          style={{ fontFamily: FONTS.sans, fontSize: 12, color: pal.inkDim }}
        >
          Cohort progress{TEXT_GAP}
          {p.total ?? COHORT_LOADING_VALUE}
        </div>
        <TallyRow
          t={t}
          status="pass"
          label="Pass"
          n={p.tally?.pass ?? null}
          ink={pal.ink}
        />
        <TallyRow
          t={t}
          status="fail"
          label="Fail"
          n={p.tally?.fail ?? null}
          ink={pal.ink}
        />
        <TallyRow
          t={t}
          status="review"
          label="Defer"
          n={p.tally?.defer ?? null}
          ink={pal.ink}
        />
        <TallyRow
          t={t}
          status="unreviewed"
          label="Unreviewed"
          n={p.tally?.unreviewed ?? null}
          ink={pal.ink}
        />
      </div>

      <RegistrationSummary
        t={t}
        pal={pal}
        registration={p.registration}
        register={p.registerRegistrationSection}
        flaggedInQueue={p.flaggedInQueue}
        filterActive={p.filterActive}
        onToggleFlagged={p.onToggleFlagged}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          paddingTop: 'var(--ss-section-gap)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span
            style={{ fontFamily: FONTS.sans, fontSize: 12, color: pal.inkDim }}
          >
            Keyboard shortcuts
          </span>
          <IconButton
            t={t}
            d={ICONS.cmd}
            ariaLabel={
              showHints ? 'Hide keyboard shortcuts' : 'Show keyboard shortcuts'
            }
            title={
              showHints ? 'Hide keyboard shortcuts' : 'Show keyboard shortcuts'
            }
            onClick={() => setShowHints((open) => !open)}
            style={{ color: pal.inkDim, background: 'transparent' }}
          />
        </div>
        {showHints && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
            }}
          >
            <KeyHint t={t} keys="J, K" action="Next, previous" />
            <KeyHint t={t} keys="P, F, D" action="Verdict" />
            <KeyHint t={t} keys="1, 2, 3" action="Gallery" />
          </div>
        )}
      </div>
    </aside>
  )
}

/** One advisory line of the active subject's surface-registration check. */
interface RegistrationAdvisoryItem {
  key: string
  text: string
  /** A flagged hemisphere, as opposed to a check that could not run. */
  attention: boolean
}

/**
 * State the active subject's surface-registration advisories above the
 * verdict controls. The check never sets or blocks a verdict.
 */
function RegistrationAdvisory(p: {
  t: Theme
  pal: Palette
  advisories: readonly RegistrationAdvisoryItem[]
}): ReactNode {
  const { t, pal } = p
  if (p.advisories.length === 0) return null
  const attention = p.advisories.some((item) => item.attention)
  return (
    <div
      role="note"
      aria-label="Surface registration advisory"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 6,
        border: attention
          ? `1px solid color-mix(in srgb, ${t.warning} 27%, transparent)`
          : `1px solid ${t.borderSoft}`,
        background: attention ? t.warningSoft : t.surface2,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          paddingTop: 2,
          flexShrink: 0,
          color: attention ? t.warning : pal.inkDim,
        }}
      >
        <NoticeGlyph
          t={t}
          tone={attention ? 'warn' : 'info'}
          color={attention ? undefined : pal.inkDim}
        />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {p.advisories.map((item) => (
          <p
            key={item.key}
            style={{
              margin: 0,
              fontFamily: FONTS.sans,
              fontSize: 12,
              lineHeight: 1.45,
              color: pal.ink,
            }}
          >
            {item.text}
          </p>
        ))}
      </div>
    </div>
  )
}

/**
 * Summarize the cohort's surface-registration check, filter the queue to the
 * flagged subjects, and start or stop a check.
 */
function RegistrationSummary(p: {
  t: Theme
  pal: Palette
  registration: SurfaceRegistrationState
  /** Register the section, which the queue line scrolls to and focuses. */
  register: (el: HTMLElement | null) => void
  flaggedInQueue: number
  filterActive: boolean
  onToggleFlagged: () => void
}): ReactNode {
  const { t, pal } = p
  const { status, error, busy, check, stop } = p.registration
  const running = status?.operation?.state === 'running'
  return (
    <section
      ref={(el) => p.register(el)}
      tabIndex={-1}
      aria-label="Surface registration"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingTop: 'var(--ss-section-gap)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{ fontFamily: FONTS.sans, fontSize: 12, color: pal.inkDim }}
        >
          Surface registration
        </span>
        <InfoTip
          t={t}
          text={SURFACE_REGISTRATION_HELP}
          label="About the surface registration check"
        />
      </div>
      <div
        role="status"
        aria-live="polite"
        style={{
          fontFamily: FONTS.sans,
          fontSize: 12,
          lineHeight: 1.45,
          color: pal.ink,
        }}
      >
        {status
          ? registrationSummary(status)
          : error
            ? null
            : 'Reading the surface registration check...'}
      </div>
      {error && (
        <Hint t={t} style={{ color: t.failed }}>
          {error}
        </Hint>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {p.flaggedInQueue > 0 && (
          <Btn
            t={t}
            small
            secondary
            label={`Show flagged (${p.flaggedInQueue})`}
            ariaPressed={p.filterActive}
            onClick={p.onToggleFlagged}
          />
        )}
        {running ? (
          <Btn
            t={t}
            small
            ghost
            label="Stop the check"
            disabled={busy}
            onClick={stop}
          />
        ) : (
          <Btn
            t={t}
            small
            ghost
            label="Check surface registration"
            disabled={busy || !status?.available}
            title={
              status && !status.available
                ? (status.unavailableReason ?? undefined)
                : 'Check every reconstructed hemisphere without a current result, and retry failed ones.'
            }
            onClick={check}
          />
        )}
      </div>
    </section>
  )
}

interface VerdictButtonProps {
  t: Theme
  pal: Palette
  label: string
  hint: string
  tone: 'success' | 'danger' | 'neutral'
  help: string | undefined
  active: boolean
  disabled: boolean
  onClick: () => void
}

/**
 * Explain each verdict's downstream effect in the hover title.
 *
 * Tint Pass with the shared success green and Fail with danger red, and let the
 * shared pressed look fill the current verdict solid. Ring the current verdict
 * in its status color, amber for Defer, and pair the ring with a check icon,
 * `aria-pressed`, and an explicit current-verdict name to provide non-color
 * cues.
 */
function VerdictButton(p: VerdictButtonProps): ReactNode {
  const { t } = p
  const ring =
    p.tone === 'success' ? t.done : p.tone === 'danger' ? t.failed : t.warning
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div
        style={{
          borderRadius: 6,
          outline: p.active ? `2px solid ${ring}` : 'none',
          outlineOffset: 1,
        }}
      >
        <Btn
          t={t}
          label={p.label}
          hint={p.hint}
          danger={p.tone === 'danger'}
          success={p.tone === 'success'}
          disabled={p.disabled}
          onClick={p.onClick}
          ariaPressed={p.active}
          ariaLabel={`${p.label}${p.active ? ' (current verdict)' : ''}`}
          title={p.help}
          icon={
            p.active ? <Ico d={ICONS.check} size={ICON_SIZE.nav} /> : undefined
          }
          style={{
            width: '100%',
            justifyContent: 'center',
            minHeight: 36,
          }}
        />
      </div>
    </div>
  )
}

interface TallyRowProps {
  t: Theme
  status: VerdictStatus
  label: string
  /** The count, or null while the cohort loads. */
  n: number | null
  ink: string
}

function TallyRow(p: TallyRowProps): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <ReviewGlyph t={p.t} state={p.status} />
      <span
        style={{ fontFamily: FONTS.sans, fontSize: 12, color: p.ink, flex: 1 }}
      >
        {p.label}
      </span>
      <span style={{ fontFamily: FONTS.sans, fontSize: 12, color: p.ink }}>
        {p.n ?? COHORT_LOADING_VALUE}
      </span>
    </div>
  )
}

/** A keyboard shortcut: its keys in mono, and the action in sans. */
function KeyHint(p: { t: Theme; keys: string; action: string }): ReactNode {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontFamily: FONTS.sans,
        fontSize: 11,
        color: p.t.dim,
        whiteSpace: 'nowrap',
      }}
    >
      <Kbd t={p.t}>{p.keys}</Kbd> {p.action}
    </span>
  )
}
