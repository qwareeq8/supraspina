/**
 * Reads the planner's receipt currency per pipeline stage from the newest
 * run's inventory, so the top bar, the Dashboard, Subjects, and Runs say the
 * same thing about which stages Run all would repeat and why.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { isAnalysisEligible } from '../../shared/analysis-cohort'
import type {
  ResultAnalysisCohortChange,
  ResultAnalysisCohortReason,
  ResultStageCurrency,
  RunSnapshot,
} from '../../shared/contract'
import {
  MATRIX_STEPS,
  PIPELINE_STEPS,
  PIPELINE_STEPS_IN_DISPLAY_ORDER,
  advancedColumns,
  pipelineStep,
  type MatrixStepKey,
  type StepKey,
} from '../../shared/steps'
import type { ProjectConfig } from '../../shared/project-schema'
import type { CellState, ProjectRef, Subject } from '../../shared/types'
import { getApi } from './api'

/** Rows to request; stage currency covers the whole inventory, not a page. */
const CURRENCY_PAGE_LIMIT = 1

/** One read of the newest run's stage currency. */
export interface StageCurrencySnapshot {
  /** Stages whose output the detector found anywhere in the inventory. */
  producedStepKeys: ReadonlySet<StepKey>
  /** Receipt currency per stage, judged the way the planner judges reuse. */
  stageCurrency: Partial<Record<StepKey, ResultStageCurrency>>
  /** How the analysis cohort changed since the newest run, or null. */
  analysisCohortChange: ResultAnalysisCohortChange | null
}

/** The stage currency a screen reads, with a way to read it again. */
export interface StageCurrencyRead extends StageCurrencySnapshot {
  /**
   * Whether a read for the open project has landed. Until then the currency
   * is unknown rather than current, so a count it can change, such as Done
   * against Out of date, is not settled. True without a project.
   */
  checked: boolean
  /** Read the inventory again, for example from a Refresh control. */
  reload: () => void
}

/** What the read depends on. */
export interface StageCurrencyOptions {
  project: ProjectRef | null
  /** Re-read when a subject's QC verdict or its revision changes. */
  subjects: readonly Subject[]
  /** Re-read when a run ends, so a rerun stage reads current again. */
  runs: readonly RunSnapshot[]
  /**
   * Re-read when this key changes, for example when a saved configuration
   * selects other subjects or discovers T1 files differently.
   */
  configKey?: string
  /** Hold the read until the screen's own data has loaded. */
  enabled?: boolean
}

/**
 * Key the saved settings that decide which subjects and T1 files the next
 * Run all resolves, so saving another selection reads the currency again.
 *
 * @param cfg - The configuration last saved to the project file.
 * @returns A key that changes exactly when those settings change.
 */
export function cohortConfigKey(cfg: ProjectConfig): string {
  return JSON.stringify([
    cfg.paths.projectRoot,
    cfg.paths.rawdataDir,
    cfg.patterns.subjectGlob,
    cfg.patterns.t1Pattern,
    cfg.subjects.include,
    cfg.subjects.exclude,
  ])
}

const EMPTY_SNAPSHOT: StageCurrencySnapshot = {
  producedStepKeys: new Set(),
  stageCurrency: {},
  analysisCohortChange: null,
}

/** One read and the project generation it was read for. */
interface TaggedSnapshot {
  projectKey: string | null
  snapshot: StageCurrencySnapshot
}

/** Identify one open project generation; a new epoch is a new project. */
function projectKey(project: ProjectRef | null): string | null {
  return project
    ? JSON.stringify([project.projectId, project.root, project.epoch])
    : null
}

/**
 * Read the newest run's stage currency and keep it current.
 *
 * The read runs again when a run ends, when a subject's QC verdict changes,
 * when {@link StageCurrencyOptions.configKey} changes, and on
 * {@link StageCurrencyRead.reload}. A failed read reports no currency
 * rather than a stale one. A read belongs to the project it was made for:
 * after a project switch the hook reports no currency until the new
 * project's read lands, and a late read for the old project is dropped.
 * {@link StageCurrencyRead.checked} stays false until the open project's
 * first read lands, successful or not; later reads keep the last one
 * showing while they run.
 *
 * @param options - The project, its subjects and runs, and whether the screen
 *   is ready for the read.
 */
export function useStageCurrency({
  project,
  subjects,
  runs,
  configKey = '',
  enabled = true,
}: StageCurrencyOptions): StageCurrencyRead {
  const [tagged, setTagged] = useState<TaggedSnapshot>({
    projectKey: null,
    snapshot: EMPTY_SNAPSHOT,
  })
  const [reloadKey, setReloadKey] = useState(0)
  const currentKey = projectKey(project)
  const endedRunsKey = useMemo(
    () =>
      runs
        .filter((run) => run.endedAt !== null)
        .map((run) => `${run.runId}:${String(run.endedAt)}`)
        .join('|'),
    [runs],
  )
  const qcKey = useMemo(
    () =>
      subjects
        .map(
          (subject) =>
            `${subject.id}:${subject.qc ?? ''}:${String(subject.qcRevision ?? '')}`,
        )
        .join('|'),
    [subjects],
  )

  useEffect(() => {
    if (!project || !enabled) return undefined
    let active = true
    const readKey = projectKey(project)
    void getApi()
      .results.list({ project, limit: CURRENCY_PAGE_LIMIT })
      .then((page) => {
        if (!active) return
        setTagged({
          projectKey: readKey,
          snapshot: {
            producedStepKeys: new Set(
              page.producedStepKeys ??
                page.items.flatMap((artifact) =>
                  artifact.presence === 'produced' ? [artifact.stepKey] : [],
                ),
            ),
            stageCurrency: page.stageCurrency ?? {},
            analysisCohortChange: page.analysisCohortChange ?? null,
          },
        })
      })
      .catch(() => {
        if (active) setTagged({ projectKey: readKey, snapshot: EMPTY_SNAPSHOT })
      })
    return () => {
      active = false
    }
  }, [project, enabled, endedRunsKey, qcKey, configKey, reloadKey])

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])
  const landed = tagged.projectKey === currentKey
  const snapshot = landed ? tagged.snapshot : EMPTY_SNAPSHOT
  const checked = currentKey === null || landed
  return useMemo(
    () => ({ ...snapshot, checked, reload }),
    [snapshot, checked, reload],
  )
}

/**
 * The app-level stage-currency read, shared so that one trigger causes one
 * inventory read rather than one per screen. Null when no provider is
 * mounted, as in a screen rendered on its own.
 */
export const StageCurrencyContext = createContext<StageCurrencyRead | null>(
  null,
)

/**
 * Use the shared stage-currency read when the app provides one, and read the
 * inventory locally otherwise.
 *
 * The options drive the local read only; the shared read follows the open
 * project, its subjects, and its runs.
 *
 * @returns The shared read, or the local one without a provider.
 */
export function useProjectStageCurrency(
  options: StageCurrencyOptions,
): StageCurrencyRead {
  const shared = useContext(StageCurrencyContext)
  const local = useStageCurrency({
    ...options,
    enabled: shared === null && (options.enabled ?? true),
  })
  return shared ?? local
}

/** The stage currency the matrix projection and its reasons read. */
type CurrencyView = Pick<
  StageCurrencySnapshot,
  'stageCurrency' | 'analysisCohortChange'
>

/**
 * Mark finished matrix cells whose stage the planner would run again.
 *
 * For each out-of-date stage, a cohort stage marks every analysis-eligible
 * subject whose stage state is done, and a subject stage marks the subjects
 * it lists as out of date. In each marked subject, every column the stage
 * advances turns from done to out of date; running, failed, and other cells
 * stay as they are. Per-stage states are left alone, so the Runs counts and
 * the notice's finished test read the detector's states.
 *
 * @returns A new array in which each marked subject is a copy; the input is
 *   never changed.
 */
export function applyStageCurrency(
  subjects: readonly Subject[],
  snapshot: Pick<StageCurrencySnapshot, 'stageCurrency'>,
): Subject[] {
  const marked = new Map<string, Set<MatrixStepKey>>()
  for (const step of PIPELINE_STEPS) {
    const currency = snapshot.stageCurrency[step.key]
    if (currency?.state !== 'outdated') continue
    const columns = advancedColumns(step.key)
    if (columns.length === 0) continue
    const listed =
      step.scope === 'subject' ? new Set(currency.outdatedSubjectIds) : null
    for (const subject of subjects) {
      const affected = listed
        ? listed.has(subject.id)
        : isAnalysisEligible(subject) &&
          subject.stepStates?.[step.key] === 'done'
      if (!affected) continue
      const own = marked.get(subject.id) ?? new Set<MatrixStepKey>()
      for (const column of columns) own.add(column)
      marked.set(subject.id, own)
    }
  }
  return subjects.map((subject) => {
    const columns = marked.get(subject.id)
    if (!columns) return subject
    return {
      ...subject,
      cells: subject.cells.map((cell, index) => {
        const column = MATRIX_STEPS[index]?.key
        return column && columns.has(column) && cell.st === 'done'
          ? { ...cell, st: 'outdated' as const }
          : cell
      }),
    }
  })
}

/**
 * Say why a matrix column's finished output is out of date.
 *
 * Name the analysis cohort as the cause only when every out-of-date stage
 * that advances the column is out of date for that reason alone.
 *
 * @returns Two sentences: the cause, then that Run all reruns it.
 * @example
 * outdatedColumnReason('qcsub', currency)
 * // 'The analysis cohort changed after this step ran. Run all reruns it.'
 */
export function outdatedColumnReason(
  column: MatrixStepKey,
  snapshot: CurrencyView,
): string {
  const stages = PIPELINE_STEPS.filter(
    (step) =>
      snapshot.stageCurrency[step.key]?.state === 'outdated' &&
      advancedColumns(step.key).includes(column),
  )
  const cohortCaused =
    stages.length > 0 &&
    stages.every(
      (step) => snapshot.stageCurrency[step.key]?.cause === 'analysis-cohort',
    )
  return cohortCaused
    ? `${analysisCohortCause(snapshot.analysisCohortChange, 'this step')} Run all reruns it.`
    : 'Its output no longer matches the current inputs. Run all reruns it.'
}

function analysisCohortClause(subject: string): string {
  return `the analysis cohort changed after ${subject} ran`
}

/** Join names as "A", "A and B", or "A, B, and C". */
function listPhrase(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/** Name up to this many subjects of one reason; past it, give the count. */
const MAX_NAMED_REASON_SUBJECTS = 3

/** Word one analysis-cohort reason as a clause that starts in lower case. */
function reasonClause(reason: ResultAnalysisCohortReason): string {
  const named =
    reason.count <= MAX_NAMED_REASON_SUBJECTS &&
    reason.subjectIds.length === reason.count
      ? listPhrase(reason.subjectIds)
      : null
  const one = reason.count === 1
  const counted = `${reason.count} subjects`
  switch (reason.kind) {
    case 'subjects-added':
      return one && named
        ? `a new subject, ${named}, is in the raw data`
        : `${named ? `new subjects ${named}` : `${reason.count} new subjects`} are in the raw data`
    case 'subjects-removed':
      return one && named
        ? `subject ${named} is no longer in the raw data`
        : `${named ? `subjects ${named}` : counted} are no longer in the raw data`
    case 'config-exclusion':
      return reason.count === 0
        ? 'the saved subject exclusions changed'
        : `the saved subject selection changed for ${named ?? counted}`
    case 't1-changed':
      return one && named
        ? `the T1 input of ${named} changed`
        : `the T1 inputs of ${named ?? counted} changed`
    case 'qc-exclusion':
      return one && named
        ? `the QC Fail verdict of ${named} changed`
        : `the QC Fail verdicts of ${named ?? counted} changed`
  }
}

/**
 * Say what changed the analysis membership, when the read names it.
 *
 * @param change - The page-level analysis-cohort change, if any.
 * @returns The reasons as clauses joined by semicolons, starting in lower case,
 *   or null when the read names none.
 * @example
 * analysisCohortReasons({
 *   cause: 'membership',
 *   reasons: [{ kind: 't1-changed', subjectIds: ['sub-003'], count: 1 }],
 * })
 * // 'the T1 input of sub-003 changed'
 */
export function analysisCohortReasons(
  change: ResultAnalysisCohortChange | null,
): string | null {
  const reasons = change?.cause === 'membership' ? (change.reasons ?? []) : []
  return reasons.length > 0 ? reasons.map(reasonClause).join('; ') : null
}

/**
 * Say what changed the analysis cohort after an out-of-date cohort stage ran.
 *
 * @param change - The page-level analysis-cohort change, if any.
 * @param subject - What ran, such as `this stage`.
 * @returns One sentence naming the cause and, when the read names them, what
 *   changed.
 * @example
 * analysisCohortCause({ cause: 'membership' }, 'this stage')
 * // 'The analysis cohort changed after this stage ran.'
 * analysisCohortCause(
 *   {
 *     cause: 'membership',
 *     reasons: [{ kind: 't1-changed', subjectIds: ['sub-003'], count: 1 }],
 *   },
 *   'this stage',
 * )
 * // 'The analysis cohort changed after this stage ran: the T1 input of
 * //   sub-003 changed.'
 */
export function analysisCohortCause(
  change: ResultAnalysisCohortChange | null,
  subject: string,
): string {
  const clause = capitalized(analysisCohortClause(subject))
  const reasons = analysisCohortReasons(change)
  return reasons ? `${clause}: ${reasons}.` : `${clause}.`
}

/** The two lines of a notice about out-of-date cohort stages. */
export interface CohortCurrencyNotice {
  headline: string
  detail: string
}

/**
 * Word a notice about cohort stages that Run all would repeat.
 *
 * Name the analysis cohort as the cause only when every listed stage is out
 * of date for that reason alone, and then say what changed it, when the read
 * names that.
 *
 * @param stages - The out-of-date cohort stages in pipeline order.
 * @param change - The page-level analysis-cohort change, if any.
 * @param subjectCount - How many subjects' finished results the stages hold, to
 *   name them; omit it to leave the subjects unnamed.
 * @returns The notice, or null when no stage is listed.
 * @example
 * cohortCurrencyNotice(['enigma'], currency, { cause: 'membership' }, 82)
 * // { headline: 'ENIGMA QC is out of date for 82 subjects: the analysis
 * //   cohort changed after it ran.',
 * //   detail: 'Run all reruns it.' }
 * cohortCurrencyNotice(['enigma'], currency, {
 *   cause: 'membership',
 *   reasons: [{ kind: 'subjects-added', subjectIds: ['sub-094'], count: 1 }],
 * })
 * // { headline: 'ENIGMA QC is out of date: the analysis cohort changed
 * //   after it ran.',
 * //   detail: 'A new subject, sub-094, is in the raw data. Run all reruns
 * //   it.' }
 */
export function cohortCurrencyNotice(
  stages: readonly StepKey[],
  currency: Partial<Record<StepKey, ResultStageCurrency>>,
  change: ResultAnalysisCohortChange | null,
  subjectCount?: number,
): CohortCurrencyNotice | null {
  if (stages.length === 0) return null
  const names = stages.map((key) => pipelineStep(key).name)
  const one = names.length === 1
  const forSubjects =
    subjectCount === undefined
      ? ''
      : ` for ${subjectCount} ${subjectCount === 1 ? 'subject' : 'subjects'}`
  const outdated = one
    ? `${names[0]} is out of date${forSubjects}`
    : `${names.length} cohort stages are out of date${forSubjects}`
  const cohortCaused = stages.every(
    (key) => currency[key]?.cause === 'analysis-cohort',
  )
  const reasons = cohortCaused ? analysisCohortReasons(change) : null
  const rerun = one
    ? 'Run all reruns it.'
    : `Run all reruns ${listPhrase(names)}.`
  return {
    headline: cohortCaused
      ? `${outdated}: ${analysisCohortClause(one ? 'it' : 'they')}.`
      : `${outdated}.`,
    detail: reasons ? `${capitalized(reasons)}. ${rerun}` : rerun,
  }
}

/**
 * List the cohort stages whose receipts the next Run all would not reuse.
 *
 * @param finished - Only stages with finished output, when supplied.
 * @returns The stage keys in display order.
 */
export function outdatedCohortStages(
  currency: Partial<Record<StepKey, ResultStageCurrency>>,
  finished?: (stepKey: StepKey) => boolean,
): StepKey[] {
  return PIPELINE_STEPS_IN_DISPLAY_ORDER.filter(
    (step) =>
      step.scope === 'cohort' &&
      currency[step.key]?.state === 'outdated' &&
      (finished?.(step.key) ?? true),
  ).map((step) => step.key)
}

/**
 * How the newest job of a cohort stage can end without finishing, as the
 * notice words it for one stage and for several, most severe first.
 */
const UNFINISHED_STAGE_OUTCOMES: readonly {
  state: CellState
  one: string
  many: string
}[] = [
  { state: 'failed', one: 'failed', many: 'failed' },
  { state: 'interrupted', one: 'was interrupted', many: 'were interrupted' },
  { state: 'cancelled', one: 'was canceled', many: 'were canceled' },
]

/**
 * Say which out-of-date cohort stages Run all also reruns because their
 * newest job ended without finishing.
 *
 * The runtime projection gives such a stage the state its job ended in
 * rather than the output found before the run, so the stage has no finished
 * subject; whether that output exists is unknown, so the stage is named by
 * how its job ended, not counted as out of date.
 *
 * @param stages - The out-of-date cohort stages with no finished subject, in
 *   pipeline order.
 * @returns The sentence, or null when no such stage ended unfinished.
 * @example
 * unfinishedStagesSentence(rows, ['enigma', 'features'])
 * // 'ENIGMA QC and FreeSurfer feature extraction were canceled; Run all
 * //   reruns them too.'
 */
function unfinishedStagesSentence(
  subjects: readonly Subject[],
  stages: readonly StepKey[],
): string | null {
  const claimed = new Set<StepKey>()
  const clauses = UNFINISHED_STAGE_OUTCOMES.flatMap(({ state, one, many }) => {
    const ended = stages.filter(
      (stepKey) =>
        !claimed.has(stepKey) &&
        subjects.some((subject) => subject.stepStates?.[stepKey] === state),
    )
    if (ended.length === 0) return []
    for (const stepKey of ended) claimed.add(stepKey)
    const names = ended.map((stepKey) => pipelineStep(stepKey).name)
    return [`${listPhrase(names)} ${names.length === 1 ? one : many}`]
  })
  if (clauses.length === 0) return null
  return `${listPhrase(clauses)}; Run all reruns ${claimed.size === 1 ? 'it' : 'them'} too.`
}

/** Tell whether any subject finished a stage. */
function finishedIn(
  subjects: readonly Subject[],
): (stepKey: StepKey) => boolean {
  return (stepKey) =>
    subjects.some((subject) => subject.stepStates?.[stepKey] === 'done')
}

/**
 * List the subjects the cohort currency notice counts: the analysis subjects
 * whose finished results an out-of-date cohort stage holds. A stage with no
 * Subjects matrix column, such as Histogram and outlier review, marks no
 * cell for them, so only this list names them.
 *
 * @param subjects - The subjects without the currency projection.
 */
export function cohortCurrencySubjectIds(
  subjects: readonly Subject[],
  snapshot: Pick<StageCurrencySnapshot, 'stageCurrency'>,
): Set<string> {
  const stages = outdatedCohortStages(
    snapshot.stageCurrency,
    finishedIn(subjects),
  )
  return new Set(
    subjects
      .filter(
        (subject) =>
          isAnalysisEligible(subject) &&
          stages.some((stepKey) => subject.stepStates?.[stepKey] === 'done'),
      )
      .map((subject) => subject.id),
  )
}

/**
 * Word the cohort notice the Dashboard and Subjects show when Run all would
 * repeat finished cohort stages.
 *
 * The notice names the analysis subjects whose finished results those stages
 * hold, the subjects {@link applyStageCurrency} marks for them. Its detail
 * also names the out-of-date cohort stages whose newest job failed, was
 * interrupted, or was canceled, which Run all reruns as well.
 *
 * @param subjects - The subjects without the currency projection; a stage
 *   counts as finished when any subject's stage state is done.
 * @returns The notice, or null when no finished stage is out of date.
 */
export function stageCurrencyNotice(
  subjects: readonly Subject[],
  snapshot: CurrencyView,
): CohortCurrencyNotice | null {
  const finished = finishedIn(subjects)
  const stages = outdatedCohortStages(snapshot.stageCurrency, finished)
  const notice = cohortCurrencyNotice(
    stages,
    snapshot.stageCurrency,
    snapshot.analysisCohortChange,
    cohortCurrencySubjectIds(subjects, snapshot).size,
  )
  if (!notice) return null
  // After a canceled, interrupted, or failed run, the stages its jobs left
  // unfinished drop out of the finished list, but Run all reruns them too.
  const unfinished = unfinishedStagesSentence(
    subjects,
    outdatedCohortStages(
      snapshot.stageCurrency,
      (stepKey) => !finished(stepKey),
    ),
  )
  return unfinished
    ? { ...notice, detail: `${notice.detail} ${unfinished}` }
    : notice
}
