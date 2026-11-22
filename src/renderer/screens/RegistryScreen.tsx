import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {
  RegistryImportFile,
  RegistryImportIssue,
  RegistryImportOnExisting,
  RegistryImportResult,
  RegistryInput,
  RegistryRecord,
} from '../../shared/contract'
import { QC_FAIL_EXCLUSION_REASON } from '../../shared/analysis-cohort'
import { AIS_HELP, COHORT_HELP } from '../../shared/help'
import {
  previewRegistryImportSites,
  REGISTRY_IMPORT_EXAMPLE_CSV,
  type RegistryImportSitePreview,
} from '../../shared/registry-import'
import { normalizeSiteLabel } from '../../shared/sites'
import type {
  AisGrade,
  CohortRole,
  ProjectRef,
  RegistryCohort,
  Sex,
  Subject,
} from '../../shared/types'
import { getApi } from '../state/api'
import { useApp } from '../state/context'
import {
  SITE_HELP,
  SITE_PLACEHOLDER,
  siteConfoundFacts,
  siteCountsText,
  siteHeldText,
  siteLabelError,
  siteLabels,
  siteMixedText,
  summarizeSites,
} from '../state/site-facts'
import {
  useDurableDraft,
  useDurableMutations,
} from '../state/durable-mutations-state'
import {
  Btn,
  ConfirmDialog,
  Card,
  EmptyState,
  ErrorState,
  Field,
  FONTS,
  FreshnessStamp,
  formatAgeYears,
  Hint,
  Ico,
  ICONS,
  ICON_SIZE,
  IconButton,
  InfoTip,
  InlineCode,
  Page,
  RefreshButton,
  Segments,
  TextInput,
  type Theme,
  ChipGlyph,
} from '../ui'
import { SetSiteDialog } from './SetSiteDialog'

const SUBJECT_ID_RE = /^sub-[A-Za-z0-9]{1,124}$/
const COHORT_OPTIONS: readonly RegistryCohort[] = ['CTRL', 'SCI_nNP', 'SCI_P']
const SEX_OPTIONS: readonly Sex[] = ['M', 'F', 'O']

/** Keep text for assistive technology without drawing it. */
const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}

/** What a CSV import accepts and how it treats errors. */
const CSV_IMPORT_HELP =
  'Registry records import from a CSV file with the header subjectId,age,sex,sourceCohortLabel,ais,tSinceSci,site; the site column is optional. Empty age, ais, and tSinceSci values mean unknown, and an empty site means no site. The backend derives each cohort role from sourceCohortLabel; role and QC columns are rejected. The import is all-or-nothing: any error rejects the whole file and changes nothing, and rows that repeat a subject ID are rejected. Reported row numbers count the header as row 1. Files up to 512 KiB.'
const AIS_UNKNOWN = 'unknown'
const AIS_OPTIONS = [
  { value: AIS_UNKNOWN, label: 'Unknown' },
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
  { value: 'C', label: 'C' },
  { value: 'D', label: 'D' },
] as const
const RECENT_LIMIT = 12
/** Preferred width in CSS pixels of the registry form column and its cards. */
const REGISTRY_FORM_WIDTH = 370
/**
 * Size a card in the form column. Beside the records each card fills the
 * column; in a stacked, full-width column the two cards share a row.
 */
const formColumnCard: CSSProperties = {
  flex: `1 1 ${REGISTRY_FORM_WIDTH}px`,
  minWidth: 0,
}
/**
 * Narrowest width in CSS pixels of the records column beside the form. It fits
 * a Recently registered row on one line with its actions in view; a narrower
 * column stacks below the form instead.
 */
const REGISTRY_RECORDS_MIN_WIDTH = 700
const SUBJECT_ID_INPUT_ID = 'registry-subject-id'
const AGE_INPUT_ID = 'registry-age'
const SITE_INPUT_ID = 'registry-site'
const SITE_OPTIONS_ID = 'registry-site-options'

const COHORT_SEGMENT_LABEL: Record<RegistryCohort, string> = {
  CTRL: 'Control',
  SCI_nNP: 'No pain',
  SCI_P: 'Pain',
}

const ROLE_LABEL: Record<CohortRole, string> = {
  healthy: 'Control',
  'sci-no-neuropathic-pain': 'SCI, no pain',
  'sci-neuropathic-pain': 'SCI, pain',
  ambiguous: 'Ambiguous',
}

const T1_AVAILABILITY_LABEL: Record<RegistryRecord['t1Availability'], string> =
  {
    available: 'Available',
    missing: 'Missing',
    ambiguous: 'Ambiguous',
  }

/**
 * The facts for the sentences the sidecar's `RegistryStore.list`
 * (`sidecar/supraspina_sidecar/registry_store.py`) records as a record's
 * unavailable reason, one per cause, each an order. The records enter the
 * plan's registry digest, so the sidecar keeps its wording and each exact
 * sentence is restated for display here. The T1 state "missing" covers a
 * subject folder that is absent, no input that matches the T1 pattern, and a
 * match that cannot be read, so its fact names a readable input. A QC Fail
 * reads as it does on the Subjects screen.
 */
const REGISTRY_UNAVAILABLE_FACTS: ReadonlyMap<string, string> = new Map([
  [
    'Resolve the T1 input state: missing.',
    'No readable T1 input matches the configured pattern.',
  ],
  [
    'Resolve the T1 input state: ambiguous.',
    'More than one T1 input matches the configured pattern.',
  ],
  [
    'Remove the subject because it is excluded by project configuration.',
    'Excluded by project configuration.',
  ],
  [
    'Add the subject because it is not in the configured include set.',
    'Not in the configured include set.',
  ],
  [
    'Resolve QC Fail before including the subject in analysis.',
    QC_FAIL_EXCLUSION_REASON,
  ],
])

/** Any recorded sentence above, standing whole between spaces or the ends. */
const REGISTRY_UNAVAILABLE_SENTENCE = new RegExp(
  `(?<=^|\\s)(?:${[...REGISTRY_UNAVAILABLE_FACTS.keys()]
    .map((sentence) => sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?=\\s|$)`,
  'g',
)

/**
 * State a registry record's unavailable reason for display. The sidecar joins
 * the sentences for every cause that applies with a space; each one it
 * records reads as its fact, and any other text reads as recorded.
 *
 * @param reason - The unavailable reason as the sidecar recorded it.
 * @example
 * registryUnavailableText(
 *   'Resolve the T1 input state: missing. Remove the subject because it is excluded by project configuration.',
 * )
 * // "No readable T1 input matches the configured pattern. Excluded by
 * // project configuration."
 */
function registryUnavailableText(reason: string): string {
  return reason.replace(
    REGISTRY_UNAVAILABLE_SENTENCE,
    (sentence) => REGISTRY_UNAVAILABLE_FACTS.get(sentence) ?? sentence,
  )
}

/** A refresh of shell-owned data after a durable registry write. */
export interface RegistryScreenProps {
  refresh?: () => void
}

/** The registry record under edit and the revision its draft started from. */
interface EditTarget {
  subjectId: string
  revision: number
}

/** The registry fields as entered in the form. */
interface RegistryDraft {
  subjectId: string
  age: string
  /** The chosen sex, or null while the operator has chosen none. */
  sex: Sex | null
  cohort: string
  ais: AisGrade | null
  tSinceSci: string
  /** The site as typed; blank means no site. */
  site: string
}

/** No subject collides with an edit, which keeps its own subject ID. */
const NO_KNOWN_IDS: ReadonlySet<string> = new Set<string>()

const EMPTY_DRAFT: RegistryDraft = {
  subjectId: '',
  age: '',
  sex: null,
  // No default: a preselected label would register an unchosen role.
  cohort: '',
  ais: null,
  tSinceSci: '',
  site: '',
}

function draftOf(record: RegistryRecord): RegistryDraft {
  return {
    subjectId: record.subjectId,
    age: record.age === null ? '' : String(record.age),
    sex: record.sex,
    cohort: record.sourceCohortLabel,
    ais: record.ais,
    tSinceSci: record.tSinceSci === null ? '' : String(record.tSinceSci),
    site: record.site ?? '',
  }
}

/** Identify one draft state so an unchanged form counts as clean. */
function draftKey(draft: RegistryDraft): string {
  return JSON.stringify(draft)
}

function sameProject(left: ProjectRef | null, right: ProjectRef): boolean {
  return (
    left?.projectId === right.projectId &&
    left.root === right.root &&
    left.configPath === right.configPath &&
    left.epoch === right.epoch
  )
}

/** Report whether the selected source label carries the SCI-only fields. */
function isSciCohort(cohort: string): boolean {
  return cohort === 'SCI_nNP' || cohort === 'SCI_P'
}

function isKnownCohort(cohort: string): cohort is RegistryCohort {
  return (COHORT_OPTIONS as readonly string[]).includes(cohort)
}

function validateSubjectId(
  value: string,
  knownIds: ReadonlySet<string>,
): string | null {
  if (value.trim() === '') return 'Required.'
  if (!SUBJECT_ID_RE.test(value)) {
    return 'Use a BIDS subject label such as sub-001 or sub-0004.'
  }
  if (knownIds.has(value))
    return 'Use a subject that is not already registered.'
  return null
}

function validateAge(value: string): string | null {
  // An empty field records an unknown age at scan rather than a missing entry,
  // so only an unusable value is a refusal.
  if (value.trim() === '') return null
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) {
    return 'Enter age in years as a number.'
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 130
    ? null
    : 'Enter an age from 0 to 130 years.'
}

function validateTSinceSci(value: string): string | null {
  if (value.trim() === '') return null
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) {
    return 'Enter years since SCI as a number.'
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 150
    ? null
    : 'Enter a duration from 0 to 150 years.'
}

function compareUpdated(left: RegistryRecord, right: RegistryRecord): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

/** Render subject-registry editing and reconciliation. */
export function RegistryScreen(props: RegistryScreenProps = {}): ReactNode {
  const { projectEpoch } = useApp()
  return <RegistryProject key={projectEpoch} {...props} />
}

function RegistryProject({ refresh }: RegistryScreenProps): ReactNode {
  const {
    t,
    projectRef,
    setRoute,
    setActiveSubjectId,
    subjects,
    applySiteWrite,
  } = useApp()
  const mutations = useDurableMutations()
  const latestProjectRef = useRef(projectRef)
  useLayoutEffect(() => {
    latestProjectRef.current = projectRef
    return () => {
      latestProjectRef.current = null
    }
  }, [projectRef])

  const [records, setRecords] = useState<RegistryRecord[] | null>(() =>
    projectRef ? null : [],
  )
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)

  const [subjectId, setSubjectId] = useState(EMPTY_DRAFT.subjectId)
  const [age, setAge] = useState(EMPTY_DRAFT.age)
  const [sex, setSex] = useState<Sex | null>(EMPTY_DRAFT.sex)
  const [cohort, setCohort] = useState<string>(EMPTY_DRAFT.cohort)
  const [ais, setAis] = useState<AisGrade | null>(EMPTY_DRAFT.ais)
  const [tSinceSci, setTSinceSci] = useState(EMPTY_DRAFT.tSinceSci)
  const [site, setSite] = useState(EMPTY_DRAFT.site)
  const [touched, setTouched] = useState(false)
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [baseline, setBaseline] = useState(() => draftKey(EMPTY_DRAFT))
  const [storedComparison, setStoredComparison] = useState<{
    record: RegistryRecord | null
  } | null>(null)
  const savePromiseRef = useRef<Promise<void> | null>(null)

  const [removeTarget, setRemoveTarget] = useState<RegistryRecord | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [importFile, setImportFile] = useState<RegistryImportFile | null>(null)
  const [onExisting, setOnExisting] = useState<RegistryImportOnExisting>('skip')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<RegistryImportResult | null>(
    null,
  )
  const [importError, setImportError] = useState<string | null>(null)
  const [exampleVisible, setExampleVisible] = useState(false)
  const exampleId = useId()
  const [exampleSavedTo, setExampleSavedTo] = useState<string | null>(null)
  const [exampleError, setExampleError] = useState<string | null>(null)
  const [siteDialogOpen, setSiteDialogOpen] = useState(false)
  const [siteOutcome, setSiteOutcome] = useState<string | null>(null)

  useEffect(() => {
    if (!projectRef) return undefined

    let active = true
    void getApi()
      .registry.list({ project: projectRef })
      .then((rows) => {
        if (!active) return
        setRecords([...rows].sort(compareUpdated))
        setLastUpdatedAt(new Date().toISOString())
      })
      .catch((cause: unknown) => {
        if (!active) return
        setLoadError(
          cause instanceof Error
            ? cause.message
            : 'Retry loading the registry.',
        )
        setRecords([])
        setLastUpdatedAt(new Date().toISOString())
      })
    return () => {
      active = false
    }
  }, [projectRef, reloadNonce])

  /**
   * Re-read the registry after a write, keeping the current rows on screen.
   *
   * Keep this reconciliation distinct from the header Refresh, which blanks the
   * table while a fresh read is in flight.
   */
  const reconcile = useCallback(async (project: ProjectRef): Promise<void> => {
    try {
      const rows = await getApi().registry.list({ project })
      if (!sameProject(latestProjectRef.current, project)) return
      setRecords([...rows].sort(compareUpdated))
      setLastUpdatedAt(new Date().toISOString())
    } catch {
      // Keep the accepted optimistic row visible and let the header Refresh retry
      // the reconciliation.
    }
  }, [])

  const rows = useMemo(() => records ?? [], [records])
  const knownIds = useMemo(
    () => new Set(rows.map((record) => record.subjectId)),
    [rows],
  )
  const sci = isSciCohort(cohort)
  // The registered subject stays fixed while editing, so the duplicate check
  // belongs to creation alone.
  const idError = validateSubjectId(
    subjectId,
    editing ? NO_KNOWN_IDS : knownIds,
  )
  const ageError = validateAge(age)
  const sexError = sex === null ? 'Required.' : null
  const tSinceError = sci ? validateTSinceSci(tSinceSci) : null
  // The edited record may change its own label's spelling; others must agree.
  const otherSiteLabels = useMemo(
    () =>
      siteLabels(
        rows
          .filter((record) => record.subjectId !== editing?.subjectId)
          .map((record) => record.site),
      ),
    [rows, editing],
  )
  const siteError = siteLabelError(site, otherSiteLabels)
  // A stored label from a CSV import can fall outside the offered options.
  const cohortError =
    cohort === ''
      ? 'Required.'
      : isKnownCohort(cohort)
        ? null
        : 'Choose the source cohort label that applies to this subject.'
  // A stored label outside the options is reported at once; a missing one
  // only after the form is touched, as for sex.
  const showCohortError = cohortError !== null && (cohort !== '' || touched)
  const canSave =
    projectRef !== null &&
    idError === null &&
    ageError === null &&
    sexError === null &&
    tSinceError === null &&
    cohortError === null &&
    siteError === null &&
    !saving

  const roleCounts = useMemo(() => {
    const counts = new Map<CohortRole, number>()
    for (const record of rows) {
      counts.set(record.cohortRole, (counts.get(record.cohortRole) ?? 0) + 1)
    }
    return counts
  }, [rows])

  const unregistered = useMemo(
    () =>
      records === null
        ? []
        : subjects.filter((subject) => !knownIds.has(subject.id)),
    [records, subjects, knownIds],
  )

  const applyDraft = (draft: RegistryDraft): void => {
    setSubjectId(draft.subjectId)
    setAge(draft.age)
    setSex(draft.sex)
    setCohort(draft.cohort)
    setAis(draft.ais)
    setTSinceSci(draft.tSinceSci)
    setSite(draft.site)
  }

  /** Return the form to an empty creation draft. */
  const resetForm = (): void => {
    applyDraft(EMPTY_DRAFT)
    setTouched(false)
    setEditing(null)
    setBaseline(draftKey(EMPTY_DRAFT))
    setStoredComparison(null)
  }

  /**
   * Remove the confirmed record against the revision the operator reviewed.
   *
   * The sidecar rejects a record another writer changed since, so the dialog
   * keeps the error and the operator refreshes before deciding again.
   */
  const confirmRemove = async (): Promise<void> => {
    const project = projectRef
    const target = removeTarget
    if (!project || !target || removing) return
    setRemoving(true)
    setRemoveError(null)
    try {
      await getApi().registry.remove({
        project,
        subjectId: target.subjectId,
        expectedRevision: target.revision,
      })
      if (!sameProject(latestProjectRef.current, project)) return
      const rows = await getApi().registry.list({ project })
      if (!sameProject(latestProjectRef.current, project)) return
      setRecords([...rows].sort(compareUpdated))
      setLastUpdatedAt(new Date().toISOString())
      if (editing?.subjectId === target.subjectId) resetForm()
      setRemoveTarget(null)
    } catch (cause: unknown) {
      if (sameProject(latestProjectRef.current, project)) {
        setRemoveError(
          cause instanceof Error
            ? cause.message
            : 'Retry removing the registry record.',
        )
      }
    } finally {
      if (sameProject(latestProjectRef.current, project)) setRemoving(false)
    }
  }

  const prefillSubjectId = (id: string): void => {
    resetForm()
    setSubjectId(id)
    // A site set before registration is the registration's site.
    setSite(subjects.find((subject) => subject.id === id)?.site ?? '')
    setTouched(true)
    document.getElementById(SUBJECT_ID_INPUT_ID)?.focus()
  }

  /** Load one stored record into the form and edit it against its revision. */
  const beginEdit = (record: RegistryRecord): void => {
    const draft = draftOf(record)
    applyDraft(draft)
    setTouched(false)
    setEditing({ subjectId: record.subjectId, revision: record.revision })
    setBaseline(draftKey(draft))
    setStoredComparison(null)
    setSaveError(null)
    document.getElementById(AGE_INPUT_ID)?.focus()
  }

  /**
   * Show the values stored for the edited subject after a rejected save.
   *
   * Keep the operator's draft and adopt the stored revision so the next save
   * either reapplies the draft over the current record or is discarded.
   */
  const loadStoredRecord = async (): Promise<void> => {
    const project = projectRef
    const target = editing
    if (!project || !target) return
    try {
      const rows = await getApi().registry.list({ project })
      if (!sameProject(latestProjectRef.current, project)) return
      setRecords([...rows].sort(compareUpdated))
      setLastUpdatedAt(new Date().toISOString())
      const stored =
        rows.find((row) => row.subjectId === target.subjectId) ?? null
      setStoredComparison({ record: stored })
      setEditing({
        subjectId: target.subjectId,
        revision: stored?.revision ?? 0,
      })
      setSaveError(null)
    } catch (cause: unknown) {
      if (sameProject(latestProjectRef.current, project)) {
        setSaveError(
          cause instanceof Error
            ? cause.message
            : 'Retry loading the saved record.',
        )
      }
    }
  }

  const chooseImportFile = async (): Promise<void> => {
    const project = projectRef
    if (!project || importing) return
    setImportError(null)
    try {
      const file = await getApi().registry.chooseImportCsv({ project })
      if (!file || !sameProject(latestProjectRef.current, project)) return
      setImportFile(file)
      setImportResult(null)
    } catch (cause: unknown) {
      if (sameProject(latestProjectRef.current, project)) {
        setImportError(
          cause instanceof Error ? cause.message : 'Retry choosing a CSV file.',
        )
      }
    }
  }

  const runImport = async (): Promise<void> => {
    const project = projectRef
    const file = importFile
    if (!project || !file || importing) return
    setImporting(true)
    setImportError(null)
    setImportResult(null)
    let outcome: RegistryImportResult | null = null
    try {
      await mutations.enqueue(project, 'registry:import', async () => {
        outcome = await getApi().registry.importCsv({
          project,
          csvText: file.text,
          onExisting,
        })
      })
      // Widen past control-flow analysis: the queued closure above has run.
      const result = outcome as RegistryImportResult | null
      if (!result || !sameProject(latestProjectRef.current, project)) return
      setImportResult(result)
      // Clear the loaded text after every completed validation: a rejected
      // file must be edited and re-chosen, never retried from a stale copy.
      setImportFile(null)
      if (result.applied) {
        refresh?.()
        // Re-read the backend's resolved availability because the import
        // persists placeholder values, exactly like the manual form.
        void reconcile(project)
      }
    } catch (cause: unknown) {
      if (sameProject(latestProjectRef.current, project)) {
        setImportError(
          cause instanceof Error ? cause.message : 'Retry the CSV import.',
        )
      }
    } finally {
      if (sameProject(latestProjectRef.current, project)) setImporting(false)
    }
  }

  const saveExample = async (): Promise<void> => {
    const project = projectRef
    if (!project) return
    setExampleError(null)
    setExampleSavedTo(null)
    try {
      const destination = await getApi().fs.chooseSavePath({
        purpose: 'registry-import-example',
        project,
        defaultPath: 'registry-import-example.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      })
      if (!destination || !sameProject(latestProjectRef.current, project)) {
        return
      }
      await getApi().registry.saveExampleCsv({
        project,
        destinationId: destination.destinationId,
      })
      if (sameProject(latestProjectRef.current, project)) {
        setExampleSavedTo(destination.displayPath)
      }
    } catch (cause: unknown) {
      if (sameProject(latestProjectRef.current, project)) {
        setExampleError(
          cause instanceof Error
            ? cause.message
            : 'Retry saving the example CSV.',
        )
      }
    }
  }

  const onSave = (): Promise<void> => {
    if (savePromiseRef.current) return savePromiseRef.current
    const project = projectRef
    const target = editing
    if (
      !project ||
      sex === null ||
      idError !== null ||
      ageError !== null ||
      sexError !== null ||
      tSinceError !== null ||
      cohortError !== null ||
      siteError !== null
    ) {
      setTouched(true)
      return Promise.reject(
        new Error('Complete every required registry field before saving.'),
      )
    }
    const record: RegistryInput = {
      subjectId,
      age: age.trim() === '' ? null : Number(age),
      sex,
      sourceCohortLabel: cohort,
      ais: sci ? ais : null,
      tSinceSci: sci && tSinceSci.trim() !== '' ? Number(tSinceSci) : null,
      // A new record left without a site omits the key, so it keeps a site
      // set before registration instead of clearing it unseen.
      ...(target === null && normalizeSiteLabel(site) === null
        ? {}
        : { site: normalizeSiteLabel(site) }),
    }
    setSaving(true)
    setSaveError(null)
    let savedRecord: RegistryRecord | null = null
    const completion = mutations
      .enqueue(project, `registry:${record.subjectId}`, async () => {
        savedRecord = await getApi().registry.upsert({
          project,
          record,
          // Reject a save built on values another writer has already replaced.
          ...(target ? { expectedRevision: target.revision } : {}),
        })
      })
      .then(() => {
        const saved = savedRecord
        if (!saved || !sameProject(latestProjectRef.current, project)) return
        setRecords((current) =>
          [
            saved,
            ...(current ?? []).filter(
              (row) => row.subjectId !== saved.subjectId,
            ),
          ].sort(compareUpdated),
        )
        setLastUpdatedAt(saved.updatedAt)
        resetForm()
        refresh?.()
        // Re-read the backend's resolved availability because the write returns
        // placeholder values. Keep the table visible during reconciliation.
        void reconcile(project)
      })
      .catch((cause: unknown) => {
        if (sameProject(latestProjectRef.current, project)) {
          setSaveError(
            cause instanceof Error
              ? cause.message
              : 'Retry saving the subject.',
          )
        }
        throw cause
      })
      .finally(() => {
        savePromiseRef.current = null
        if (sameProject(latestProjectRef.current, project)) setSaving(false)
      })
    savePromiseRef.current = completion
    return completion
  }

  const currentDraft = draftKey({
    subjectId,
    age,
    sex,
    cohort,
    ais,
    tSinceSci,
    site,
  })
  const formDirty = currentDraft !== baseline

  useDurableDraft(
    projectRef
      ? {
          project: projectRef,
          id: 'registry-form',
          revision: currentDraft,
          dirty: formDirty,
          save: onSave,
          discard: () => {
            resetForm()
            setSaveError(null)
          },
        }
      : null,
  )

  const openInQc = (record: RegistryRecord): void => {
    if (!record.runnable) return
    setActiveSubjectId(record.subjectId)
    setRoute('qc')
  }

  const onRefresh = (): void => {
    refresh?.()
    setRecords(null)
    setLoadError(null)
    setSaveError(null)
    setLastUpdatedAt(null)
    setReloadNonce((value) => value + 1)
  }

  const tiles = [
    { label: 'Registered', value: rows.length, always: true },
    {
      label: 'Runnable',
      value: rows.filter((row) => row.runnable).length,
      always: true,
    },
    { label: 'Control', value: roleCounts.get('healthy') ?? 0 },
    {
      label: 'SCI, no pain',
      value: roleCounts.get('sci-no-neuropathic-pain') ?? 0,
    },
    {
      label: 'SCI, pain',
      value: roleCounts.get('sci-neuropathic-pain') ?? 0,
    },
    {
      label: 'Ambiguous',
      value: roleCounts.get('ambiguous') ?? 0,
      warn: true,
    },
  ]

  return (
    <Page
      t={t}
      title="Registry"
      right={
        <>
          <FreshnessStamp t={t} at={lastUpdatedAt} />
          <RefreshButton
            t={t}
            ariaLabel="Refresh registry"
            title="Refresh registry"
            onClick={onRefresh}
            disabled={!projectRef || records === null}
          />
        </>
      }
    >
      {/* State the no-project cause once for the whole screen; the form,
          discovery, and record regions below stay neutral. */}
      {!projectRef && (
        <Hint t={t} style={{ marginBottom: 'var(--ss-section-gap)' }}>
          No project is open. Create or open a project to use its registry.
        </Hint>
      )}
      {/* Keep the form beside the records while the records column has room
          for a one-line table row; otherwise stack the records below the form
          at full width, so no row action needs horizontal scrolling. A
          stacked form column is wide enough to set its two cards side by
          side, so neither stretches across the page. */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--ss-section-gap)',
          alignItems: 'flex-start',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-start',
            gap: 'var(--ss-section-gap)',
            flex: `1 1 ${REGISTRY_FORM_WIDTH}px`,
            minWidth: 0,
          }}
        >
          <Card
            t={t}
            title={editing ? 'Edit subject' : 'New subject'}
            {...(editing ? { sub: editing.subjectId } : {})}
            style={formColumnCard}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void onSave()
              }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--ss-gap)',
              }}
            >
              <Field
                t={t}
                label="Subject ID"
                controlId={SUBJECT_ID_INPUT_ID}
                {...(touched && idError ? { error: idError } : {})}
              >
                <TextInput
                  t={t}
                  id={SUBJECT_ID_INPUT_ID}
                  value={subjectId}
                  onChange={(value) => {
                    setSubjectId(value)
                    setTouched(true)
                  }}
                  mono
                  // Suggest the first discovered subject still to register,
                  // in the project's own ID format.
                  placeholder={unregistered[0]?.id ?? 'sub-001'}
                  readOnly={editing !== null}
                  invalid={touched && idError !== null}
                />
              </Field>
              <Field
                t={t}
                label="Age (years, optional)"
                controlId={AGE_INPUT_ID}
                {...(touched && ageError ? { error: ageError } : {})}
              >
                <TextInput
                  t={t}
                  id={AGE_INPUT_ID}
                  value={age}
                  onChange={(value) => {
                    setAge(value)
                    setTouched(true)
                  }}
                  mono
                  placeholder="42"
                  invalid={touched && ageError !== null}
                />
              </Field>
              <Field
                t={t}
                label="Sex"
                info="The recorded sex; O means it is not recorded as M or F."
                {...(touched && sexError ? { error: sexError } : {})}
              >
                <Segments
                  t={t}
                  value={sex ?? ''}
                  options={SEX_OPTIONS}
                  onChange={(value) => {
                    setSex(value as Sex)
                    setTouched(true)
                  }}
                  ariaLabel="Sex"
                />
              </Field>
              <Field
                t={t}
                label="Cohort"
                info={`CTRL: ${COHORT_HELP.CTRL} SCI_nNP: ${COHORT_HELP.SCI_nNP} SCI_P: ${COHORT_HELP.SCI_P}`}
                {...(showCohortError ? { error: cohortError } : {})}
              >
                <Segments
                  t={t}
                  value={cohort}
                  options={COHORT_OPTIONS.map((value) => ({
                    value,
                    label: COHORT_SEGMENT_LABEL[value],
                  }))}
                  onChange={(value) => {
                    setCohort(value)
                    setTouched(true)
                  }}
                  ariaLabel="Cohort"
                />
                {cohortError && cohort !== '' && (
                  <Hint t={t}>
                    {`The stored label ${cohort} is not one of these options; the selected label replaces it.`}
                  </Hint>
                )}
              </Field>
              {sci && (
                <>
                  <Field
                    t={t}
                    label="AIS grade (optional)"
                    info={`${AIS_HELP.A} ${AIS_HELP.B} ${AIS_HELP.C} ${AIS_HELP.D} Unknown means the grade is unavailable.`}
                  >
                    <Segments
                      t={t}
                      value={ais ?? AIS_UNKNOWN}
                      options={AIS_OPTIONS}
                      onChange={(value) =>
                        setAis(
                          value === AIS_UNKNOWN ? null : (value as AisGrade),
                        )
                      }
                    />
                  </Field>
                  <Field
                    t={t}
                    label="Years since SCI (optional)"
                    info="Years from injury to scan, with decimals when needed. Blank means the value is unavailable."
                    {...(touched && tSinceError ? { error: tSinceError } : {})}
                  >
                    <TextInput
                      t={t}
                      value={tSinceSci}
                      onChange={(value) => {
                        setTSinceSci(value)
                        setTouched(true)
                      }}
                      mono
                      placeholder="3.5"
                      invalid={touched && tSinceError !== null}
                    />
                  </Field>
                </>
              )}
              <Field
                t={t}
                label="Site (optional)"
                controlId={SITE_INPUT_ID}
                info={SITE_HELP}
                {...(siteError ? { error: siteError } : {})}
              >
                <TextInput
                  t={t}
                  id={SITE_INPUT_ID}
                  value={site}
                  list={SITE_OPTIONS_ID}
                  onChange={(value) => {
                    setSite(value)
                    setTouched(true)
                  }}
                  placeholder={SITE_PLACEHOLDER}
                  invalid={siteError !== null}
                />
                <datalist id={SITE_OPTIONS_ID}>
                  {siteLabels(rows.map((record) => record.site)).map(
                    (label) => (
                      <option key={label} value={label} />
                    ),
                  )}
                </datalist>
              </Field>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Btn
                  t={t}
                  label={
                    saving
                      ? 'Saving...'
                      : editing
                        ? 'Save changes'
                        : 'Save subject'
                  }
                  icon={
                    <Ico
                      d={editing ? ICONS.check : ICONS.plus}
                      size={ICON_SIZE.nav}
                    />
                  }
                  primary
                  onClick={() => void onSave().catch(() => undefined)}
                  disabled={!canSave}
                  ariaLabel={editing ? 'Save changes' : 'Save subject'}
                />
                {editing && (
                  <Btn
                    t={t}
                    ghost
                    label="Cancel edit"
                    onClick={() => {
                      resetForm()
                      setSaveError(null)
                    }}
                    disabled={saving}
                    ariaLabel="Cancel edit"
                  />
                )}
              </div>
              {saveError && (
                <ErrorState
                  t={t}
                  title={
                    editing
                      ? 'Could not save the changed registry record.'
                      : 'Could not save the registry record.'
                  }
                  detail={saveError}
                  {...(editing
                    ? {
                        onRetry: () => void loadStoredRecord(),
                        retryLabel: 'Load saved values',
                      }
                    : {})}
                />
              )}
              {storedComparison && (
                <StoredValues
                  t={t}
                  subjectId={editing?.subjectId ?? subjectId}
                  record={storedComparison.record}
                />
              )}
            </form>
          </Card>
          <Card
            t={t}
            title="Not registered"
            style={formColumnCard}
            {...(records === null
              ? { sub: 'loading' }
              : { sub: String(unregistered.length) })}
          >
            <DiscoveredList
              t={t}
              rows={unregistered}
              loading={records === null}
              hasProject={projectRef !== null}
              onPrefill={prefillSubjectId}
            />
          </Card>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--ss-section-gap)',
            flex: '999 1 0',
            minWidth: `min(100%, ${REGISTRY_RECORDS_MIN_WIDTH}px)`,
          }}
        >
          <Card
            t={t}
            title="Registry summary"
            {...(records === null ? { sub: 'loading' } : {})}
          >
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '8px 24px',
              }}
            >
              <CohortBand t={t} tiles={tiles} loading={records === null} />
              {records !== null && projectRef && (
                <SiteBand
                  t={t}
                  rows={rows}
                  unregistered={unregistered.length}
                  held={
                    unregistered.filter((subject) => Boolean(subject.site))
                      .length
                  }
                  outcome={siteOutcome}
                  onSetSite={() => {
                    setSiteOutcome(null)
                    setSiteDialogOpen(true)
                  }}
                />
              )}
            </div>
            {siteDialogOpen && projectRef && (
              <SetSiteDialog
                t={t}
                project={projectRef}
                initialSelection={[]}
                discovered={subjects}
                onDismiss={() => setSiteDialogOpen(false)}
                onDone={(result, subjectIds) => {
                  setSiteDialogOpen(false)
                  setSiteOutcome(
                    siteOutcomeText(
                      result.site,
                      subjectIds.length,
                      result.updated,
                    ),
                  )
                  if (result.updated > 0) {
                    applySiteWrite(projectRef, subjectIds, result.site)
                    refresh?.()
                    void reconcile(projectRef)
                  }
                }}
              />
            )}
          </Card>
          <Card t={t} title="Recently registered">
            <RecentTable
              t={t}
              rows={rows.slice(0, RECENT_LIMIT)}
              loading={records === null}
              error={loadError}
              total={rows.length}
              hasProject={projectRef !== null}
              onOpen={openInQc}
              onEdit={beginEdit}
              onRemove={(record) => {
                setRemoveError(null)
                setRemoveTarget(record)
              }}
              editingSubjectId={editing?.subjectId ?? null}
              onViewAll={() => setRoute('subjects')}
            />
            {removeTarget && (
              <ConfirmDialog
                t={t}
                title="Remove registry record"
                message={
                  <span>
                    Remove{' '}
                    <span style={{ fontFamily: FONTS.mono }}>
                      {removeTarget.subjectId}
                    </span>{' '}
                    from the registry. The stored cohort label, age, sex, AIS
                    grade, years since SCI, and the registry's QC verdict, note,
                    and tags are deleted. QC review evidence, image files, and
                    pipeline outputs are not touched.
                  </span>
                }
                error={removeError}
                busy={removing}
                onDismiss={() => {
                  if (!removing) setRemoveTarget(null)
                }}
                actions={[
                  {
                    label: 'Cancel',
                    onSelect: () => setRemoveTarget(null),
                    disabled: removing,
                    initialFocus: true,
                  },
                  {
                    label: removing ? 'Removing...' : 'Remove record',
                    tone: 'danger',
                    onSelect: () => void confirmRemove(),
                    disabled: removing,
                  },
                ]}
              />
            )}
          </Card>
          <Card
            t={t}
            title="Import from CSV"
            action={
              <InfoTip
                t={t}
                text={CSV_IMPORT_HELP}
                label="About CSV import"
                style={{ marginRight: 4 }}
              />
            }
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--ss-gap)',
              }}
            >
              <Hint t={t}>Any error rejects the whole file.</Hint>
              <Field t={t} label="Registered subjects">
                <Segments
                  t={t}
                  value={onExisting}
                  options={[
                    {
                      value: 'skip',
                      label: 'Skip',
                      title:
                        'Rows whose subject is already registered are skipped and reported.',
                    },
                    {
                      value: 'update',
                      label: 'Update',
                      title:
                        'Rows whose subject is already registered replace the stored fields, keep the QC annotations, and raise the record revision. Without a site column, each stored site stays.',
                    },
                  ]}
                  onChange={(value) =>
                    setOnExisting(value as RegistryImportOnExisting)
                  }
                  ariaLabel="Registered subjects"
                />
              </Field>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <Btn
                  t={t}
                  label="Choose CSV file"
                  icon={<Ico d={ICONS.folder} size={ICON_SIZE.nav} />}
                  onClick={() => void chooseImportFile()}
                  disabled={!projectRef || importing}
                  ariaLabel="Choose CSV file"
                />
                <span
                  role="status"
                  title={importFile?.displayPath}
                  style={{
                    // A file name is code-like; the empty state is a sentence.
                    fontFamily: importFile ? FONTS.mono : FONTS.sans,
                    fontSize: 11,
                    color: importFile ? t.text : t.dim,
                  }}
                >
                  {importFile ? importFile.name : 'No file chosen.'}
                </span>
                <Btn
                  t={t}
                  primary
                  label={importing ? 'Importing...' : 'Import'}
                  icon={<Ico d={ICONS.plus} size={ICON_SIZE.nav} />}
                  onClick={() => void runImport()}
                  disabled={!projectRef || !importFile || importing}
                  ariaLabel="Import"
                />
              </div>
              {importFile && (
                <ImportSitePreview
                  t={t}
                  preview={previewRegistryImportSites(importFile.text)}
                  onExisting={onExisting}
                />
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Btn
                  t={t}
                  ghost
                  small
                  label="Example CSV"
                  ariaExpanded={exampleVisible}
                  ariaControls={exampleId}
                  onClick={() => setExampleVisible((value) => !value)}
                />
                <Btn
                  t={t}
                  ghost
                  small
                  label="Save example CSV"
                  onClick={() => void saveExample()}
                  disabled={!projectRef}
                  ariaLabel="Save example CSV"
                />
              </div>
              <div id={exampleId} hidden={!exampleVisible}>
                {exampleVisible && (
                  <div
                    role="group"
                    aria-label="Example CSV"
                    tabIndex={0}
                    style={{
                      padding: '8px 10px',
                      background: t.surface,
                      border: `1px solid ${t.borderSoft}`,
                      borderRadius: 4,
                      overflowX: 'auto',
                    }}
                  >
                    <pre
                      style={{
                        margin: 0,
                        fontFamily: FONTS.mono,
                        fontSize: 11,
                        color: t.text,
                      }}
                    >
                      {REGISTRY_IMPORT_EXAMPLE_CSV}
                    </pre>
                  </div>
                )}
              </div>
              {exampleSavedTo && (
                <Hint t={t}>
                  {'Saved the example to '}
                  <InlineCode>{exampleSavedTo}</InlineCode>
                  {'.'}
                </Hint>
              )}
              {exampleError && (
                <ErrorState
                  t={t}
                  title="Could not save the example CSV."
                  detail={exampleError}
                />
              )}
              {importError && (
                <ErrorState
                  t={t}
                  title="Could not import the CSV."
                  detail={importError}
                />
              )}
              {importResult && <ImportResultView t={t} result={importResult} />}
            </div>
          </Card>
        </div>
      </div>
    </Page>
  )
}

/** A stored registry value that is a number, such as a revision or an age. */
const NUMERIC_VALUE = /^\d+(?:\.\d+)?$/

function StoredValues({
  t,
  subjectId,
  record,
}: {
  t: Theme
  subjectId: string
  record: RegistryRecord | null
}): ReactNode {
  const rows: [string, string][] = record
    ? [
        ['Revision', String(record.revision)],
        ['Age (years)', record.age === null ? 'Unknown' : String(record.age)],
        ['Sex', record.sex],
        ['Source cohort label', record.sourceCohortLabel],
        ['AIS grade', record.ais ?? 'Unknown'],
        [
          'Years since SCI',
          record.tSinceSci === null ? 'Unknown' : String(record.tSinceSci),
        ],
        ['Site', record.site ?? 'None'],
      ]
    : []
  return (
    <div
      role="group"
      aria-label="Saved registry values"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        background: t.surface,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 4,
      }}
    >
      <Hint t={t}>
        {record
          ? `Another writer saved these values for ${subjectId}. Compare them with the draft above, then save the draft over them or cancel the edit.`
          : `${subjectId} is no longer registered. Saving the draft registers it again, or cancel the edit to leave the registry unchanged.`}
      </Hint>
      {record && (
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '3px 10px',
            margin: 0,
            fontFamily: FONTS.sans,
            fontSize: 11,
          }}
        >
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'contents' }}>
              <dt style={{ color: t.dim }}>{label}</dt>
              {/* Numbers stay mono beside the draft's mono inputs; words
                  such as Control or Unknown are prose. */}
              <dd
                style={{
                  margin: 0,
                  color: t.text,
                  ...(NUMERIC_VALUE.test(value)
                    ? { fontFamily: FONTS.mono }
                    : {}),
                }}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function DiscoveredList({
  t,
  rows,
  loading,
  hasProject,
  onPrefill,
}: {
  t: Theme
  rows: Subject[]
  loading: boolean
  hasProject: boolean
  onPrefill: (id: string) => void
}): ReactNode {
  if (loading) {
    return (
      <div
        role="status"
        style={{ fontFamily: FONTS.sans, fontSize: 12, color: t.dim }}
      >
        Loading the registry...
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <Hint t={t}>
        {hasProject
          ? 'Every discovered subject is registered. Refresh discovery after adding raw data.'
          : 'No discovered subjects.'}
      </Hint>
    )
  }
  return (
    <ul
      aria-label="Discovered subjects without registry records"
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        maxHeight: 280,
        overflowY: 'auto',
      }}
    >
      {rows.map((subject) => (
        <li
          key={subject.id}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span
            style={{
              fontFamily: FONTS.mono,
              fontSize: 11,
              color: t.text,
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {subject.id}
          </span>
          <span
            title="T1 input availability"
            style={{
              fontFamily: FONTS.sans,
              // The secondary size of the ID beside it, not caption size.
              fontSize: 11,
              color:
                subject.t1Availability === 'available' ? t.done : t.warning,
            }}
          >
            T1{' '}
            {T1_AVAILABILITY_LABEL[
              subject.t1Availability ?? 'missing'
            ].toLowerCase()}
          </span>
          <Btn
            t={t}
            ghost
            small
            label="Register"
            onClick={() => onPrefill(subject.id)}
            ariaLabel={`Register ${subject.id}`}
          />
        </li>
      ))}
    </ul>
  )
}

function ImportResultView({
  t,
  result,
}: {
  t: Theme
  result: RegistryImportResult
}): ReactNode {
  const summary = result.applied
    ? `Import complete: ${result.imported} added, ${result.updated} replaced, ${result.skipped} skipped.`
    : 'The import was rejected; no registry records were changed.'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        role="status"
        style={{
          fontFamily: FONTS.sans,
          fontSize: 12,
          fontWeight: 600,
          color: result.applied ? t.done : t.failed,
        }}
      >
        {summary}
      </div>
      <IssueTable
        t={t}
        label="Import errors"
        column="Error"
        issues={result.errors}
        total={result.errorTotal}
        tone={t.failed}
      />
      <IssueTable
        t={t}
        label="Import warnings"
        column="Warning"
        issues={result.warnings}
        total={result.warningTotal}
        tone={t.warning}
      />
    </div>
  )
}

function IssueTable({
  t,
  label,
  column,
  issues,
  total,
  tone,
}: {
  t: Theme
  label: string
  column: string
  issues: RegistryImportIssue[]
  total: number
  tone: string
}): ReactNode {
  if (issues.length === 0) return null
  const head: CSSProperties = {
    fontFamily: FONTS.sans,
    fontSize: 10,
    color: t.dimText,
    letterSpacing: 0.2,
    textAlign: 'left',
    padding: '5px 7px',
    borderBottom: `1px solid ${t.border}`,
  }
  const cell: CSSProperties = {
    fontFamily: FONTS.mono,
    fontSize: 11,
    color: t.text,
    padding: '6px 7px',
    borderBottom: `1px solid ${t.borderSoft}`,
    verticalAlign: 'top',
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        aria-label={label}
        style={{ width: '100%', borderCollapse: 'collapse' }}
      >
        <thead>
          <tr>
            <th scope="col" style={{ ...head, width: 52 }}>
              Row
            </th>
            <th scope="col" style={head}>
              {column}
            </th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, index) => (
            <tr key={`${String(issue.row ?? 'file')}-${String(index)}`}>
              <td
                style={{
                  ...cell,
                  color: tone,
                  // A row number is a code; the whole-file fallback is a word.
                  ...(issue.row === null ? { fontFamily: FONTS.sans } : {}),
                }}
              >
                {issue.row ?? 'File'}
              </td>
              <td
                style={{
                  ...cell,
                  whiteSpace: 'normal',
                  fontFamily: FONTS.sans,
                }}
              >
                {issue.message}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > issues.length && (
        <Hint t={t}>
          Showing the first {issues.length} of {total}.
        </Hint>
      )}
    </div>
  )
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * State what one bulk site write did.
 *
 * @param site - The label set, or null when the site was cleared.
 * @param selected - The subjects the operator selected.
 * @param updated - The records the sidecar wrote.
 */
function siteOutcomeText(
  site: string | null,
  selected: number,
  updated: number,
): string {
  const unchanged = selected - updated
  if (updated === 0) {
    return site === null
      ? 'The selected subjects have no site; nothing changed.'
      : `The selected subjects already have site ${site}; nothing changed.`
  }
  const done =
    site === null
      ? `Cleared the site of ${plural(updated, 'subject')}`
      : `Set site ${site} for ${plural(updated, 'subject')}`
  if (unchanged === 0) return `${done}.`
  return site === null
    ? `${done}; ${unchanged} had no site.`
    : `${done}; ${unchanged} already had it.`
}

function SiteBand({
  t,
  rows,
  unregistered,
  held,
  outcome,
  onSetSite,
}: {
  t: Theme
  rows: RegistryRecord[]
  /** The discovered subjects without a record, who can hold a site too. */
  unregistered: number
  /** The unregistered subjects whose site is held until registration. */
  held: number
  outcome: string | null
  onSetSite: () => void
}): ReactNode {
  const summary = summarizeSites(
    rows.map((row) => ({
      id: row.subjectId,
      site: row.site,
      role: row.cohortRole,
    })),
  )
  const mixed = siteMixedText(summary)
  const heldText = siteHeldText(held)
  const text: CSSProperties = {
    fontFamily: FONTS.sans,
    fontSize: 12,
    lineHeight: 1.4,
    color: t.textSoft,
  }
  const noSites =
    rows.length === 0
      ? heldText
        ? 'No subject is registered.'
        : 'No subject is registered, so no subject has a site.'
      : 'No subject has a site, so the project counts as one site.'
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          minWidth: 0,
        }}
      >
        {siteCountsText(summary) ? (
          <span style={text}>{siteCountsText(summary)}</span>
        ) : (
          <span style={text} title={noSites}>
            No sites set.
          </span>
        )}
        {heldText && <span style={text}>{heldText}</span>}
        {mixed && <span style={{ ...text, color: t.warning }}>{mixed}</span>}
        {siteConfoundFacts(summary).map((fact) => (
          <span key={fact} style={{ ...text, color: t.warning }}>
            {fact}
          </span>
        ))}
        {outcome && (
          <span role="status" style={{ ...text, color: t.done }}>
            {outcome}
          </span>
        )}
      </div>
      <Btn
        t={t}
        ghost
        small
        label="Set site..."
        onClick={onSetSite}
        disabled={rows.length === 0 && unregistered === 0}
        title="Set or clear the site of several subjects"
      />
    </div>
  )
}

function ImportSitePreview({
  t,
  preview,
  onExisting,
}: {
  t: Theme
  preview: RegistryImportSitePreview | null
  onExisting: RegistryImportOnExisting
}): ReactNode {
  if (preview === null || preview.rows === 0) return null
  const update = onExisting === 'update'
  if (!preview.siteColumn) {
    return (
      <Hint t={t}>
        {update
          ? 'The file has no site column: new subjects get no site, and updated subjects keep their stored site.'
          : 'The file has no site column: new subjects get no site.'}
      </Hint>
    )
  }
  const facts: string[] = []
  if (preview.sites.length > 0) {
    facts.push(
      `Sites in the file: ${preview.sites.map((entry) => `${entry.site} ${entry.rows}`).join(', ')}.`,
    )
  }
  if (preview.empty > 0) {
    const rows = plural(preview.empty, 'row')
    facts.push(
      update
        ? `${rows} ${preview.empty === 1 ? 'has' : 'have'} no site, which clears the stored site of a registered subject.`
        : `${rows} ${preview.empty === 1 ? 'has' : 'have'} no site.`,
    )
  }
  if (preview.invalid > 0) {
    facts.push(
      `${plural(preview.invalid, 'row')} ${preview.invalid === 1 ? 'has' : 'have'} a site outside the label rule, so the import will be rejected.`,
    )
  }
  return <Hint t={t}>{facts.join(' ')}</Hint>
}

/** One labeled count of the summary row. */
interface SummaryCount {
  label: string
  value: number
  /** Show the count even at zero. */
  always?: boolean
  /** Draw a nonzero count as a warning. */
  warn?: boolean
}

function CohortBand({
  t,
  tiles,
  loading,
}: {
  t: Theme
  tiles: SummaryCount[]
  loading: boolean
}): ReactNode {
  return (
    <dl
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: '4px 16px',
        margin: 0,
        fontFamily: FONTS.sans,
        fontSize: 12,
      }}
    >
      {tiles
        // A zero count of an optional group says nothing.
        .filter((tile) => tile.always || tile.value > 0)
        .map((tile) => {
          const warn = tile.warn === true && tile.value > 0
          return (
            <div
              key={tile.label}
              style={{
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: 6,
                color: warn ? t.warning : t.dim,
              }}
            >
              <dt
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                {warn && <ChipGlyph t={t} status="warn" />}
                {tile.label}
              </dt>
              <dd
                style={{
                  margin: 0,
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  color: warn
                    ? t.warning
                    : tile.value > 0
                      ? t.textStrong
                      : t.dimText,
                }}
              >
                {loading ? '--' : tile.value}
              </dd>
            </div>
          )
        })}
    </dl>
  )
}

function RecentTable({
  t,
  rows,
  loading,
  error,
  total,
  hasProject,
  onOpen,
  onEdit,
  onRemove,
  editingSubjectId,
  onViewAll,
}: {
  t: Theme
  rows: RegistryRecord[]
  loading: boolean
  error: string | null
  total: number
  hasProject: boolean
  onOpen: (record: RegistryRecord) => void
  onEdit: (record: RegistryRecord) => void
  onRemove: (record: RegistryRecord) => void
  editingSubjectId: string | null
  onViewAll: () => void
}): ReactNode {
  const head: CSSProperties = {
    fontFamily: FONTS.sans,
    fontSize: 10,
    color: t.dimText,
    letterSpacing: 0.2,
    textAlign: 'left',
    padding: '5px 7px',
    borderBottom: `1px solid ${t.border}`,
  }
  // Keep short values such as an ID or "54.7 / F" on one line; the role and
  // status cells opt back into wrapping.
  const cell: CSSProperties = {
    fontFamily: FONTS.mono,
    fontSize: 11,
    color: t.text,
    padding: '6px 7px',
    borderBottom: `1px solid ${t.borderSoft}`,
    verticalAlign: 'top',
    whiteSpace: 'nowrap',
  }

  if (error) {
    return (
      <ErrorState t={t} title="Could not load the registry." detail={error} />
    )
  }
  if (loading) {
    return (
      <div
        role="status"
        style={{ fontFamily: FONTS.sans, fontSize: 12, color: t.dim }}
      >
        Loading the registry...
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        t={t}
        icon="registry"
        message={
          hasProject
            ? 'This project has no registry records.'
            : 'No registry records.'
        }
        {...(hasProject ? { hint: 'Add one with the New subject form.' } : {})}
      />
    )
  }

  // Name the site under the ID once any record has one, as the role sits
  // under the source label, so the column adds no width.
  const showSite = rows.some((record) => record.site !== null)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        overflowX: 'auto',
      }}
    >
      <table
        style={{ width: '100%', borderCollapse: 'collapse' }}
        aria-label="Recently registered subjects"
      >
        <thead>
          <tr>
            <th style={head}>Subject</th>
            <th style={head}>Cohort</th>
            <th style={head}>Age (years), sex</th>
            <th style={head}>Clinical</th>
            <th style={head}>T1</th>
            <th style={head}>Status</th>
            <th style={{ ...head, width: 150 }}>
              <span style={VISUALLY_HIDDEN}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((record) => (
            <tr key={record.subjectId} data-runnable={String(record.runnable)}>
              <td style={cell}>
                <div>{record.subjectId}</div>
                {showSite && (
                  <div
                    title={record.site ?? 'No site'}
                    style={{
                      maxWidth: 120,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      color: record.site ? t.dim : t.dimText,
                      fontFamily: record.site ? FONTS.mono : FONTS.sans,
                    }}
                  >
                    {record.site ?? 'No site'}
                  </div>
                )}
              </td>
              <td
                style={{
                  ...cell,
                  whiteSpace: 'normal',
                  fontFamily: FONTS.sans,
                }}
              >
                <div>{record.sourceCohortLabel}</div>
                <div
                  style={{
                    color:
                      record.cohortRole === 'ambiguous' ? t.warning : t.dim,
                  }}
                >
                  {ROLE_LABEL[record.cohortRole]}
                </div>
              </td>
              <td style={cell}>
                {formatAgeYears(record.age)}, {record.sex}
              </td>
              <td style={cell}>
                {[
                  record.ais,
                  record.tSinceSci !== null ? `${record.tSinceSci} y` : null,
                ]
                  .filter((part) => part !== null)
                  .join(', ') || (
                  <span style={{ color: t.dim }}>{'\u2013'}</span>
                )}
              </td>
              <td
                style={{
                  ...cell,
                  fontFamily: FONTS.sans,
                  color:
                    record.t1Availability === 'available' ? t.done : t.warning,
                }}
              >
                {T1_AVAILABILITY_LABEL[record.t1Availability]}
              </td>
              <td
                style={{
                  ...cell,
                  whiteSpace: 'normal',
                  minWidth: 150,
                  fontFamily: FONTS.sans,
                }}
              >
                <strong style={{ color: record.runnable ? t.done : t.warning }}>
                  {record.runnable ? 'Runnable' : 'Unavailable'}
                </strong>
                {!record.runnable && record.unavailableReason && (
                  <div style={{ marginTop: 3, color: t.dim }}>
                    {registryUnavailableText(record.unavailableReason)}
                  </div>
                )}
              </td>
              <td
                style={{
                  ...cell,
                  // Keep the other cells' vertical padding so the outlined
                  // buttons stay clear of the row rules above and below.
                  padding: '6px 4px',
                  verticalAlign: 'middle',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Btn
                    t={t}
                    ghost
                    small
                    label="Edit"
                    onClick={() => onEdit(record)}
                    ariaPressed={editingSubjectId === record.subjectId}
                    ariaLabel={`Edit ${record.subjectId}`}
                    title={`Edit the registry record for ${record.subjectId}`}
                  />
                  <Btn
                    t={t}
                    danger
                    small
                    label="Remove"
                    onClick={() => onRemove(record)}
                    ariaLabel={`Remove ${record.subjectId}`}
                    title={`Remove the registry record for ${record.subjectId}`}
                  />
                  <IconButton
                    t={t}
                    d={ICONS.chevron}
                    ariaLabel={`Open ${record.subjectId} in QC review`}
                    title={
                      record.runnable
                        ? `Open ${record.subjectId} in QC review`
                        : record.unavailableReason
                          ? registryUnavailableText(record.unavailableReason)
                          : 'The backend reports this subject as unavailable.'
                    }
                    onClick={record.runnable ? () => onOpen(record) : undefined}
                    disabled={!record.runnable}
                    size={26}
                    iconSize={ICON_SIZE.inline}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > rows.length && (
        <Btn
          t={t}
          ghost
          small
          label={`View all ${total} subjects`}
          icon={<Ico d={ICONS.chevron} size={ICON_SIZE.nav} />}
          onClick={onViewAll}
          style={{ alignSelf: 'flex-start' }}
        />
      )}
    </div>
  )
}
