/**
 * The Analysis panel's state: the open project's measure catalog, stored
 * results and library, the draft specification with its live resolved
 * sample, and the running compute.
 *
 * Every answer is tagged with the project generation that asked for it
 * (`[projectId, root, epoch]`), so a project switch drops the old project's
 * state at once and a late answer for it never lands. The status of a running
 * compute is polled every 500 ms, and only while it runs. Stored results are
 * judged again when a run ends, a QC verdict changes, the saved cohort
 * selection changes, or the panel regains focus.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GROUP_ANALYSIS_SPEC_SCHEMA,
  canonicalSpecJson,
  parseMeasureId,
  upgradeGroupAnalysisSpecV1,
  validateGroupAnalysisSpecV2,
  type AnalysisStageCurrency,
  type AnalysisVariable,
  type AnalysisVariableTable,
  type AnyGroupAnalysisSpec,
  type GroupAnalysisCatalog,
  type GroupAnalysisInputs,
  type GroupAnalysisLibrary,
  type GroupAnalysisList,
  type GroupAnalysisMeasureDetail,
  type GroupAnalysisOperation,
  type AnyGroupAnalysisResult,
  type GroupAnalysisSpec,
  type GroupAnalysisSpecV2,
  type GroupDefinition,
  type RoiSet,
  type VariableRef,
} from '../../shared/group-analysis'
import type { RunSnapshot } from '../../shared/contract'
import type { ProjectConfig } from '../../shared/project-schema'
import type { ProjectRef, Subject } from '../../shared/types'
import { getApi } from './api'
import { cohortConfigKey, type StageCurrencySnapshot } from './stage-currency'

/** The polling interval of a running compute, in milliseconds. */
export const ANALYSIS_POLL_MS = 500
/** The pause after a draft edit before its sample is resolved, in milliseconds. */
export const ANALYSIS_INPUTS_DEBOUNCE_MS = 250

/** One asynchronous read. */
export type Load<T> =
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; message: string }

const LOADING = { phase: 'loading' } as const

/** Where the draft came from: a saved specification, or none. */
export interface DraftSource {
  specId: string | null
  name: string | null
}

interface Core {
  key: string | null
  catalog: Load<GroupAnalysisCatalog>
  list: Load<GroupAnalysisList>
  operation: GroupAnalysisOperation | null
  resultId: string | null
  /** Bumped to read the shown result again, as after a compute. */
  resultEpoch: number
  result: Load<AnyGroupAnalysisResult> | null
  details: Record<string, Load<GroupAnalysisMeasureDetail>>
  draft: GroupAnalysisSpecV2 | null
  source: DraftSource
  inputs: { json: string; load: Load<GroupAnalysisInputs> } | null
  actionError: string | null
  /** The running compute vanished from the workflow service, as on a restart. */
  interrupted: boolean
  busy: boolean
}

function initial(key: string | null): Core {
  return {
    key,
    catalog: LOADING,
    list: LOADING,
    operation: null,
    resultId: null,
    resultEpoch: 0,
    result: null,
    details: {},
    draft: null,
    source: { specId: null, name: null },
    inputs: null,
    actionError: null,
    interrupted: false,
    busy: false,
  }
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * Identify one open project generation.
 *
 * @param project - The open project, or null.
 * @returns The tag, or null without a project.
 */
export function analysisProjectKey(project: ProjectRef | null): string | null {
  return project
    ? JSON.stringify([project.projectId, project.root, project.epoch])
    : null
}

/**
 * Key the events that can change a stored result's currency: an ended run,
 * a QC verdict or its revision, and the saved cohort selection.
 *
 * @returns A key that changes exactly when one of them does.
 */
export function analysisRejudgeKey(
  subjects: readonly Subject[],
  runs: readonly RunSnapshot[],
  savedCfg: ProjectConfig,
): string {
  return JSON.stringify([
    runs
      .filter((run) => run.endedAt !== null)
      .map((run) => `${run.runId}:${String(run.endedAt)}`),
    subjects.map((s) => `${s.id}:${s.qc ?? ''}:${String(s.qcRevision ?? '')}`),
    cohortConfigKey(savedCfg),
  ])
}

/** The most out-of-date recon subjects a stage currency carries. */
const MAX_OUTDATED_RECONS = 5_000

/**
 * Give the currency of the stages whose outputs feed the analysis, as the
 * app-wide stage-currency read judges them: the aggregate tables,
 * Brain-PAD, and each subject's reconstruction (tier A stats files and
 * labeled atlases), with the subjects whose recon is out of date.
 *
 * @param read - The stage-currency read and whether it has landed.
 * @returns `unknown` for a stage the read has not judged.
 */
export function analysisStageCurrency(
  read: Pick<StageCurrencySnapshot, 'stageCurrency'> & { checked: boolean },
): AnalysisStageCurrency {
  const state = (key: 'aggregate' | 'pybrainage' | 'recon') =>
    read.checked ? (read.stageCurrency[key]?.state ?? 'unknown') : 'unknown'
  return {
    aggregate: state('aggregate'),
    pybrainage: state('pybrainage'),
    recon: {
      state: state('recon'),
      outdatedSubjectIds: read.checked
        ? (read.stageCurrency.recon?.outdatedSubjectIds ?? []).slice(
            0,
            MAX_OUTDATED_RECONS,
          )
        : [],
    },
  }
}

/**
 * Draw a random permutation seed for a new specification.
 *
 * @returns An unsigned 32-bit integer.
 */
export function randomSeed(): number {
  const buffer = new Uint32Array(1)
  crypto.getRandomValues(buffer)
  return buffer[0]!
}

const REFERENCE_LEVEL =
  /^(ctrl|control|controls|hc|healthy|healthy[-_ ]?controls?)$/i

const SEPARATOR = /[-_ .]/

/**
 * Give the longest whole-token prefix the values share: it ends where every
 * value ends or continues with a separator, so sci-neuropathic-pain and
 * sci-no-neuropathic-pain share sci, never the truncated sci-n.
 */
function sharedToken(values: readonly string[]): string {
  if (values.length === 0) return ''
  let raw = values[0]!
  for (const value of values) {
    while (!value.startsWith(raw)) raw = raw.slice(0, -1)
  }
  for (let k = raw.length; k > 0; k -= 1) {
    const prefix = raw.slice(0, k)
    if (SEPARATOR.test(prefix.charAt(k - 1))) continue
    if (
      values.every(
        (value) => value.length === k || SEPARATOR.test(value.charAt(k)),
      )
    ) {
      return prefix
    }
  }
  return ''
}

/**
 * Make a group label readable: a short lowercase token reads as an
 * acronym (sci makes SCI), a longer lowercase word is capitalized.
 */
function readableLabel(token: string): string {
  if (/^[a-z]{2,4}$/.test(token)) return token.toUpperCase()
  if (/^[a-z]/.test(token))
    return `${token.charAt(0).toUpperCase()}${token.slice(1)}`
  return token
}

/**
 * Propose groups from a categorical variable's levels: a control-like level
 * as the reference (labeled CTRL unless it is an uppercase code already),
 * and the other levels merged into one focal group named by their shared
 * whole token (SCI_P and SCI_nNP make SCI; the cohort roles
 * sci-neuropathic-pain and sci-no-neuropathic-pain make SCI).
 *
 * @returns The groups and the focal and reference labels.
 */
export function proposeGroups(variable: Pick<AnalysisVariable, 'levels'>): {
  groups: GroupDefinition[]
  focal: string
  reference: string
} {
  const levels = variable.levels.map((level) => level.value)
  const control = levels.find((level) => REFERENCE_LEVEL.test(level))
  const referenceLevel = control ?? levels[0] ?? 'A'
  const reference =
    control && control !== control.toUpperCase() ? 'CTRL' : referenceLevel
  const others = levels.filter((level) => level !== referenceLevel)
  if (others.length === 0) {
    return {
      groups: [{ label: reference, levels: [referenceLevel] }],
      focal: reference,
      reference,
    }
  }
  const token = readableLabel(sharedToken(others))
  const focal =
    others.length === 1
      ? others[0]!
      : token.length >= 2 && token !== reference
        ? token
        : `${others[0]!.slice(0, 50)} and others`
  return {
    groups: [
      { label: focal, levels: others },
      { label: reference, levels: [referenceLevel] },
    ],
    focal,
    reference,
  }
}

function findVariable(
  variables: readonly AnalysisVariable[],
  kind: AnalysisVariable['kind'],
  preferred: readonly VariableRef[],
  pattern?: RegExp,
): AnalysisVariable | null {
  for (const ref of preferred) {
    const found = variables.find(
      (v) =>
        v.kind === kind &&
        v.ref.source === ref.source &&
        v.ref.column === ref.column,
    )
    if (found) return found
  }
  return pattern
    ? (variables.find((v) => v.kind === kind && pattern.test(v.ref.column)) ??
        null)
    : null
}

/**
 * Build the default specification of a project: SCI-style group comparison
 * of bilateral DK thickness adjusted for age and sex (eTIV for extensive
 * measures only), QC non-failed, max-T FWE with 5000 permutations and a new
 * random seed.
 *
 * @returns The specification; it may still need a grouping.
 */
export function defaultAnalysisSpec(
  catalog: GroupAnalysisCatalog,
  seed: number,
): GroupAnalysisSpec {
  const variables = catalog.variables
  const grouping =
    findVariable(variables, 'categorical', [
      { source: 'registry', column: 'sourceCohortLabel' },
      { source: 'registry', column: 'cohortRole' },
    ]) ??
    variables.find((v) => v.kind === 'categorical' && v.levels.length >= 2) ??
    null
  const proposal = grouping
    ? proposeGroups(grouping)
    : {
        groups: [{ label: 'All', levels: ['all'] }],
        focal: 'All',
        reference: 'All',
      }
  const age = findVariable(
    variables,
    'numeric',
    [{ source: 'registry', column: 'age' }],
    /^age$/i,
  )
  const sex = findVariable(
    variables,
    'categorical',
    [{ source: 'registry', column: 'sex' }],
    /^sex$/i,
  )
  const available = catalog.measures.filter((m) => m.available)
  const thickness = available
    .map((m) => m.measureId)
    .filter((id) => /^dk:bi:[a-z]+:ThickAvg$/.test(id))
  const measures =
    thickness.length > 0
      ? thickness
      : available.slice(0, 1).map((m) => m.measureId)
  return {
    schema: GROUP_ANALYSIS_SPEC_SCHEMA,
    schemaVersion: 1,
    analysis: 'group-comparison',
    measures: measures.length > 0 ? measures : ['global:meanThickness'],
    contrast: {
      type: 'groups',
      grouping: {
        variable: grouping?.ref ?? {
          source: 'registry',
          column: 'sourceCohortLabel',
        },
        groups: proposal.groups,
      },
      focal: proposal.focal,
      reference: proposal.reference,
      model: 'all-groups',
    },
    covariates: {
      age: age?.ref ?? null,
      sex: sex?.ref ?? null,
      etiv: 'extensive',
      extra: [],
      centering: 'sample-mean',
    },
    inclusion: {
      qc: 'non-failed',
      registration: 'set-missing',
      outliers: 'keep',
    },
    inference: {
      sidedness: 'two-sided',
      correction: 'maxt-fwe',
      family: 'selected',
      alpha: 0.05,
      permutations: 5000,
      seed,
    },
  }
}

/**
 * Build the default spec v2 of a project: the v1 default (a between-groups
 * comparison of bilateral DK thickness) in v2 form, with the smallest cell
 * at its v2 default of 3.
 */
export function defaultAnalysisSpecV2(
  catalog: GroupAnalysisCatalog,
  seed: number,
): GroupAnalysisSpecV2 {
  const spec = upgradeGroupAnalysisSpecV1(defaultAnalysisSpec(catalog, seed))
  return { ...spec, inclusion: { ...spec.inclusion, minCellN: 3 } }
}

/**
 * Turn a stored or saved specification into a v2 draft: a spec v1 takes its
 * v2 form (`upgradeGroupAnalysisSpecV1`), which the v2 engine computes to
 * the same rows; a spec v2 is kept.
 *
 * @param spec - A valid specification of either version.
 */
export function analysisDraft(spec: AnyGroupAnalysisSpec): GroupAnalysisSpecV2 {
  return spec.schemaVersion === 2 ? spec : upgradeGroupAnalysisSpecV1(spec)
}

/** A parsed ROI-set CSV. */
export interface ParsedSetCsv {
  measures: string[]
  /** Values that are not measure IDs, header cells aside. */
  invalid: string[]
}

/**
 * Read measure IDs from a CSV: the first column of each row, quotes and
 * spaces trimmed, a header row skipped, duplicates dropped.
 *
 * @returns The valid IDs in file order and the invalid values.
 */
export function parseSetCsv(text: string): ParsedSetCsv {
  const measures: string[] = []
  const invalid: string[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    const cell = (line.split(/[,;\t]/)[0] ?? '')
      .trim()
      .replace(/^"|"$/g, '')
      .trim()
    if (!cell) return
    if (parseMeasureId(cell)) {
      if (!measures.includes(cell)) measures.push(cell)
    } else if (!(index === 0 && /^[A-Za-z _-]+$/.test(cell))) {
      invalid.push(cell)
    }
  })
  return { measures, invalid }
}

/**
 * Name an imported set after its file: the base name without `.csv`, kept
 * printable and at most 120 characters.
 */
export function setNameFromFile(fileName: string): string {
  const base = fileName
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
  return (base || 'Imported set').slice(0, 120).trim()
}

/** Options of {@link useGroupAnalysis}. */
export interface GroupAnalysisOptions {
  /** A key that changes when stored results should be judged again. */
  rejudgeKey: string
}

/** The Analysis panel state and its actions. */
export interface GroupAnalysisState {
  catalog: Load<GroupAnalysisCatalog>
  list: Load<GroupAnalysisList>
  operation: GroupAnalysisOperation | null
  running: boolean
  resultId: string | null
  result: Load<AnyGroupAnalysisResult> | null
  draft: GroupAnalysisSpecV2 | null
  draftSource: DraftSource
  /** Validation errors of the draft; empty when it can compute. */
  draftErrors: string[]
  /** True when the draft differs from the shown result's specification. */
  draftChanged: boolean
  /** The draft's resolved sample, or null before the first resolution. */
  inputs: Load<GroupAnalysisInputs> | null
  actionError: string | null
  /** True when the running compute vanished, as on a workflow-service restart. */
  interrupted: boolean
  busy: boolean
  setDraft: (next: GroupAnalysisSpecV2) => void
  selectResult: (resultId: string) => void
  loadSavedSpec: (specId: string) => void
  resetDraft: () => void
  detail: (measureId: string) => Load<GroupAnalysisMeasureDetail> | null
  requestDetail: (measureId: string) => void
  compute: (stageCurrency: AnalysisStageCurrency) => Promise<void>
  cancel: () => Promise<void>
  saveSpec: (name: string) => Promise<boolean>
  deleteSpec: (specId: string) => Promise<boolean>
  saveSet: (
    setId: string | null,
    name: string,
    measures: string[],
  ) => Promise<RoiSet | null>
  lockSet: (setId: string) => Promise<boolean>
  deleteSet: (setId: string) => Promise<boolean>
  importSet: () => Promise<{ set: RoiSet; invalid: string[] } | null>
  dismissError: () => void
  reload: () => void
  /** Read the catalog again, as after labeling or a variables import. */
  rereadCatalog: () => void
  /** Import a variables table through main's chooser; null on cancel. */
  importVariables: () => Promise<AnalysisVariableTable | null>
  /** Remove an imported variables table after main's confirmation. */
  removeVariables: (tableId: string) => Promise<boolean>
}

/**
 * Hold the Analysis panel's state for the open project.
 *
 * @param project - The open project, or null.
 */
export function useGroupAnalysis(
  project: ProjectRef | null,
  { rejudgeKey }: GroupAnalysisOptions,
): GroupAnalysisState {
  const key = analysisProjectKey(project)
  const [core, setCore] = useState<Core>(() => initial(key))
  const [openTick, setOpenTick] = useState(0)
  const [judgeTick, setJudgeTick] = useState(0)
  const live = core.key === key ? core : initial(key)
  const projectRef = useRef(project)
  const keyRef = useRef(key)
  const coreRef = useRef(live)
  useEffect(() => {
    projectRef.current = project
    keyRef.current = key
    coreRef.current = live
  })

  const patch = useCallback(
    (tag: string | null, change: (current: Core) => Core) =>
      setCore((current) => (current.key === tag ? change(current) : current)),
    [],
  )

  // A new project generation starts from nothing.
  useEffect(() => {
    setCore((current) => (current.key === key ? current : initial(key)))
  }, [key])

  // The list and the catalog, read on open and whenever results should be
  // judged again: a finished run can add the tables the catalog lists. Only
  // the latest answer of each lands, so a slow earlier read never rolls the
  // library revision back.
  const judgeKey = `${rejudgeKey}\u0000${judgeTick}\u0000${openTick}`
  const catalogSeq = useRef(0)
  const listSeq = useRef(0)
  useEffect(() => {
    if (!project || key === null) return
    const api = getApi().groupAnalysis
    const tag = key
    const catalogAsked = ++catalogSeq.current
    api.catalog({ project }).then(
      (catalog) =>
        patch(tag, (c) =>
          catalogAsked === catalogSeq.current
            ? { ...c, catalog: { phase: 'ready', value: catalog } }
            : c,
        ),
      (error: unknown) =>
        patch(tag, (c) =>
          // A failed reread keeps the catalog already shown.
          catalogAsked !== catalogSeq.current || c.catalog.phase === 'ready'
            ? c
            : {
                ...c,
                catalog: {
                  phase: 'error',
                  message: message(
                    error,
                    'The analysis catalog could not be read.',
                  ),
                },
              },
        ),
    )
    const listAsked = ++listSeq.current
    api.list({ project }).then(
      (list) =>
        patch(tag, (c) =>
          listAsked !== listSeq.current ||
          (c.list.phase === 'ready' && list.revision < c.list.value.revision)
            ? c
            : {
                ...c,
                list: { phase: 'ready', value: list },
                resultId:
                  c.resultId &&
                  list.results.some((r) => r.resultId === c.resultId)
                    ? c.resultId
                    : (list.results[0]?.resultId ?? null),
              },
        ),
      (error: unknown) =>
        patch(tag, (c) =>
          listAsked !== listSeq.current
            ? c
            : {
                ...c,
                list: {
                  phase: 'error',
                  message: message(
                    error,
                    'The stored analyses could not be read.',
                  ),
                },
              },
        ),
    )
  }, [project, key, judgeKey, patch])

  // Any running or finished compute, read on open.
  useEffect(() => {
    if (!project || key === null) return undefined
    const tag = key
    getApi()
      .groupAnalysis.status({ project })
      .then(
        ({ operation }) => patch(tag, (c) => ({ ...c, operation })),
        () => undefined,
      )
    return undefined
  }, [project, key, openTick, patch])

  // Judge again when the window regains focus.
  useEffect(() => {
    const judge = (): void => {
      if (document.visibilityState !== 'hidden') setJudgeTick((n) => n + 1)
    }
    window.addEventListener('focus', judge)
    document.addEventListener('visibilitychange', judge)
    return () => {
      window.removeEventListener('focus', judge)
      document.removeEventListener('visibilitychange', judge)
    }
  }, [])

  const resultId = live.resultId
  const resultEpoch = live.resultEpoch
  useEffect(() => {
    if (!project || key === null || resultId === null) return
    const tag = key
    patch(tag, (c) =>
      c.resultId === resultId ? { ...c, result: LOADING, details: {} } : c,
    )
    getApi()
      .groupAnalysis.result({ project, resultId })
      .then(
        (result) =>
          patch(tag, (c) =>
            c.resultId !== resultId
              ? c
              : { ...c, result: { phase: 'ready', value: result } },
          ),
        (error: unknown) =>
          patch(tag, (c) =>
            c.resultId === resultId
              ? {
                  ...c,
                  result: {
                    phase: 'error',
                    message: message(
                      error,
                      'The analysis result could not be read.',
                    ),
                  },
                }
              : c,
          ),
      )
  }, [project, key, resultId, resultEpoch, patch])

  // The first draft: the shown result's specification, else the first saved
  // one, else the project default.
  const needsDraft =
    live.draft === null &&
    live.catalog.phase === 'ready' &&
    live.list.phase !== 'loading' &&
    (live.resultId === null ||
      (live.result !== null && live.result.phase !== 'loading'))
  useEffect(() => {
    if (!needsDraft) return
    const tag = key
    patch(tag, (c) => {
      if (c.draft !== null || c.catalog.phase !== 'ready') return c
      // The rail edits a v2 draft; a v1 result or spec is upgraded.
      const fromResult = c.result?.phase === 'ready' ? c.result.value : null
      const saved = c.list.phase === 'ready' ? c.list.value.specs[0] : undefined
      if (fromResult) {
        const specName =
          c.list.phase === 'ready'
            ? c.list.value.specs.find((s) => s.specId === fromResult.specId)
            : undefined
        return {
          ...c,
          draft: analysisDraft(fromResult.spec),
          source: {
            specId: specName?.specId ?? null,
            name: specName?.name ?? null,
          },
        }
      }
      if (saved)
        return {
          ...c,
          draft: analysisDraft(saved.spec),
          source: { specId: saved.specId, name: saved.name },
        }
      return {
        ...c,
        draft: defaultAnalysisSpecV2(c.catalog.value, randomSeed()),
      }
    })
  }, [needsDraft, key, patch])

  // The draft's resolved sample, a moment after the last edit.
  const draftJson = live.draft ? JSON.stringify(live.draft) : null
  const validation = useMemo(
    () => (live.draft ? validateGroupAnalysisSpecV2(live.draft) : null),
    [live.draft],
  )
  const valid = validation?.ok === true
  useEffect(() => {
    if (!project || key === null || draftJson === null || !valid)
      return undefined
    const tag = key
    const spec = JSON.parse(draftJson) as GroupAnalysisSpecV2
    const timer = window.setTimeout(() => {
      patch(tag, (c) => ({
        ...c,
        inputs:
          c.inputs && c.inputs.load.phase === 'ready'
            ? { json: draftJson, load: c.inputs.load }
            : { json: draftJson, load: LOADING },
      }))
      getApi()
        .groupAnalysis.inputs({ project, spec })
        .then(
          (inputs) =>
            patch(tag, (c) =>
              c.draft && JSON.stringify(c.draft) === draftJson
                ? {
                    ...c,
                    inputs: {
                      json: draftJson,
                      load: { phase: 'ready', value: inputs },
                    },
                  }
                : c,
            ),
          (error: unknown) =>
            patch(tag, (c) =>
              c.draft && JSON.stringify(c.draft) === draftJson
                ? {
                    ...c,
                    inputs: {
                      json: draftJson,
                      load: {
                        phase: 'error',
                        message: message(
                          error,
                          'The sample could not be resolved.',
                        ),
                      },
                    },
                  }
                : c,
            ),
        )
    }, ANALYSIS_INPUTS_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [project, key, draftJson, valid, judgeKey, patch])

  // Poll the compute while it runs.
  const running = live.operation?.state === 'running'
  const operationId = live.operation?.operationId ?? null
  useEffect(() => {
    if (!project || key === null || !running) return undefined
    const tag = key
    const watched = operationId
    let inFlight = false
    let settled = false
    const timer = window.setInterval(() => {
      if (inFlight || settled) return
      inFlight = true
      getApi()
        .groupAnalysis.status({ project })
        .then(
          ({ operation }) => {
            // A poll answered after cancel or cleanup would undo newer state.
            if (settled) return
            // A restarted workflow service knows no operation, or another.
            if (!operation || operation.operationId !== watched) {
              settled = true
              window.clearInterval(timer)
              patch(tag, (c) => ({ ...c, operation: null, interrupted: true }))
              setJudgeTick((n) => n + 1)
              return
            }
            patch(tag, (c) => ({ ...c, operation }))
            if (operation.state !== 'running') {
              settled = true
              window.clearInterval(timer)
            }
            if (operation && operation.state !== 'running') {
              if (operation.state === 'done' && operation.resultId) {
                const finished = operation.resultId
                patch(tag, (c) => ({
                  ...c,
                  resultId: finished,
                  resultEpoch: c.resultEpoch + 1,
                  result: null,
                }))
              }
              setJudgeTick((n) => n + 1)
            }
          },
          () => undefined,
        )
        .finally(() => {
          inFlight = false
        })
    }, ANALYSIS_POLL_MS)
    return () => {
      settled = true
      window.clearInterval(timer)
    }
  }, [project, key, running, operationId, patch])

  const selectResult = useCallback(
    (id: string) =>
      // Choosing the shown result again keeps it; clearing it would wait
      // for a read that never starts.
      patch(keyRef.current, (c) =>
        c.resultId === id ? c : { ...c, resultId: id, result: null },
      ),
    [patch],
  )

  const setDraft = useCallback(
    (next: GroupAnalysisSpecV2) =>
      patch(keyRef.current, (c) => ({ ...c, draft: next })),
    [patch],
  )

  const loadSavedSpec = useCallback(
    (specId: string) =>
      patch(keyRef.current, (c) => {
        const saved =
          c.list.phase === 'ready'
            ? c.list.value.specs.find((s) => s.specId === specId)
            : undefined
        return saved
          ? {
              ...c,
              draft: analysisDraft(saved.spec),
              source: { specId: saved.specId, name: saved.name },
            }
          : c
      }),
    [patch],
  )

  const resetDraft = useCallback(
    () =>
      patch(keyRef.current, (c) =>
        c.catalog.phase === 'ready'
          ? {
              ...c,
              draft: defaultAnalysisSpecV2(c.catalog.value, randomSeed()),
              source: { specId: null, name: null },
            }
          : c,
      ),
    [patch],
  )

  const detailsFor = live.details
  const shownResultId =
    live.result?.phase === 'ready' ? live.result.value.resultId : null
  const detail = useCallback(
    (measureId: string) =>
      shownResultId
        ? (detailsFor[`${shownResultId}\u0000${measureId}`] ?? null)
        : null,
    [detailsFor, shownResultId],
  )
  const requestDetail = useCallback(
    (measureId: string) => {
      const current = coreRef.current
      const project = projectRef.current
      const tag = keyRef.current
      if (!project || current.result?.phase !== 'ready') return
      const id = current.result.value.resultId
      const cacheKey = `${id}\u0000${measureId}`
      // A failed read is asked again; a loading or ready one is kept.
      const cached = current.details[cacheKey]
      if (cached && cached.phase !== 'error') return
      patch(tag, (c) => ({
        ...c,
        details: { ...c.details, [cacheKey]: LOADING },
      }))
      getApi()
        .groupAnalysis.measureDetail({ project, resultId: id, measureId })
        .then(
          (value) =>
            patch(tag, (c) => ({
              ...c,
              details: { ...c.details, [cacheKey]: { phase: 'ready', value } },
            })),
          (error: unknown) =>
            patch(tag, (c) => ({
              ...c,
              details: {
                ...c.details,
                [cacheKey]: {
                  phase: 'error',
                  message: message(
                    error,
                    'The measure values could not be read.',
                  ),
                },
              },
            })),
        )
    },
    [patch],
  )

  const compute = useCallback(
    async (stageCurrency: AnalysisStageCurrency) => {
      const project = projectRef.current
      const tag = keyRef.current
      const spec = coreRef.current.draft
      if (!project || !spec) return
      patch(tag, (c) => ({ ...c, actionError: null, interrupted: false }))
      try {
        const started = await getApi().groupAnalysis.start({
          project,
          spec,
          stageCurrency,
        })
        const operation = started.operation
        patch(tag, (c) => ({
          ...c,
          operation,
          ...(operation.state === 'done' && operation.resultId
            ? {
                resultId: operation.resultId,
                resultEpoch: c.resultEpoch + 1,
                result: null,
              }
            : {}),
        }))
        if (operation.state !== 'running') setJudgeTick((n) => n + 1)
      } catch (error) {
        patch(tag, (c) => ({
          ...c,
          actionError: message(error, 'The analysis could not start.'),
        }))
      }
    },
    [patch],
  )

  const cancel = useCallback(async () => {
    const project = projectRef.current
    const tag = keyRef.current
    const operation = coreRef.current.operation
    if (!project || !operation || operation.state !== 'running') return
    try {
      await getApi().groupAnalysis.cancel({
        project,
        operationId: operation.operationId,
      })
      const { operation: after } = await getApi().groupAnalysis.status({
        project,
      })
      // A compute that committed its result before the cancel took effect
      // finished: its result is shown, as when a poll sees it done.
      const finished =
        after?.state === 'done' && after.resultId ? after.resultId : null
      patch(tag, (c) => ({
        ...c,
        operation: after,
        ...(finished
          ? { resultId: finished, resultEpoch: c.resultEpoch + 1, result: null }
          : {}),
      }))
      if (after && after.state !== 'running') setJudgeTick((n) => n + 1)
    } catch (error) {
      patch(tag, (c) => ({
        ...c,
        actionError: message(error, 'The analysis could not be stopped.'),
      }))
    }
  }, [patch])

  const library = useCallback(
    async (
      write: (
        project: ProjectRef,
        revision: number,
      ) => Promise<GroupAnalysisLibrary>,
      fallback: string,
    ): Promise<GroupAnalysisLibrary | null> => {
      const project = projectRef.current
      const tag = keyRef.current
      const list = coreRef.current.list
      if (!project || list.phase !== 'ready') return null
      patch(tag, (c) => ({ ...c, busy: true, actionError: null }))
      try {
        const next = await write(project, list.value.revision)
        patch(tag, (c) => ({
          ...c,
          busy: false,
          list:
            c.list.phase === 'ready'
              ? { phase: 'ready', value: { ...c.list.value, ...next } }
              : c.list,
        }))
        return next
      } catch (error) {
        patch(tag, (c) => ({
          ...c,
          busy: false,
          actionError: message(error, fallback),
        }))
        setJudgeTick((n) => n + 1)
        return null
      }
    },
    [patch],
  )

  const saveSpec = useCallback(
    async (name: string) => {
      const { draft, source } = coreRef.current
      if (!draft) return false
      const specId = source.name === name ? source.specId : null
      const next = await library(
        (project, expectedRevision) =>
          getApi().groupAnalysis.saveSpec({
            project,
            specId,
            name,
            spec: draft,
            expectedRevision,
          }),
        'The analysis could not be saved.',
      )
      if (!next) return false
      const saved = next.specs.find((s) => s.name === name)
      patch(keyRef.current, (c) => ({
        ...c,
        source: { specId: saved?.specId ?? null, name },
      }))
      return true
    },
    [library, patch],
  )

  const deleteSpec = useCallback(
    async (specId: string) => {
      const next = await library(
        (project, expectedRevision) =>
          getApi().groupAnalysis.deleteSpec({
            project,
            specId,
            expectedRevision,
          }),
        'The saved analysis could not be deleted.',
      )
      if (next) {
        patch(keyRef.current, (c) =>
          c.source.specId === specId
            ? { ...c, source: { specId: null, name: null } }
            : c,
        )
      }
      return next !== null
    },
    [library, patch],
  )

  const saveSet = useCallback(
    async (setId: string | null, name: string, measures: string[]) => {
      const next = await library(
        (project, expectedRevision) =>
          getApi().groupAnalysis.saveSet({
            project,
            setId,
            name,
            measures,
            expectedRevision,
          }),
        'The ROI set could not be saved.',
      )
      return (
        next?.sets.find((s) => (setId ? s.setId === setId : s.name === name)) ??
        null
      )
    },
    [library],
  )

  const lockSet = useCallback(
    async (setId: string) =>
      (await library(
        (project, expectedRevision) =>
          getApi().groupAnalysis.lockSet({ project, setId, expectedRevision }),
        'The ROI set could not be locked.',
      )) !== null,
    [library],
  )

  const deleteSet = useCallback(
    async (setId: string) =>
      (await library(
        (project, expectedRevision) =>
          getApi().groupAnalysis.deleteSet({
            project,
            setId,
            expectedRevision,
          }),
        'The ROI set could not be deleted.',
      )) !== null,
    [library],
  )

  const importSet = useCallback(async () => {
    const project = projectRef.current
    const tag = keyRef.current
    if (!project) return null
    let file
    try {
      file = await getApi().groupAnalysis.chooseSetCsv({ project })
    } catch (error) {
      patch(tag, (c) => ({
        ...c,
        actionError: message(error, 'The CSV could not be read.'),
      }))
      return null
    }
    if (!file || keyRef.current !== tag) return null
    const parsed = parseSetCsv(file.text)
    if (parsed.measures.length === 0) {
      patch(tag, (c) => ({
        ...c,
        actionError: `Choose a CSV whose first column lists measure IDs; ${file.name} has none.`,
      }))
      return null
    }
    const set = await saveSet(null, setNameFromFile(file.name), parsed.measures)
    return set ? { set, invalid: parsed.invalid } : null
  }, [patch, saveSet])

  const dismissError = useCallback(
    () => patch(keyRef.current, (c) => ({ ...c, actionError: null })),
    [patch],
  )
  const rereadCatalog = useCallback(() => setJudgeTick((n) => n + 1), [])

  const importVariables = useCallback(async () => {
    const project = projectRef.current
    const tag = keyRef.current
    if (!project) return null
    try {
      const table = await getApi().groupAnalysis.chooseVariablesCsv({
        project,
      })
      if (table) setJudgeTick((n) => n + 1)
      return table
    } catch (error) {
      patch(tag, (c) => ({
        ...c,
        actionError: message(error, 'The variables table could not be read.'),
      }))
      return null
    }
  }, [patch])

  const removeVariables = useCallback(
    async (tableId: string) => {
      const project = projectRef.current
      const tag = keyRef.current
      if (!project) return false
      try {
        const removed = await getApi().groupAnalysis.removeVariables({
          project,
          tableId,
        })
        if (removed) setJudgeTick((n) => n + 1)
        return removed
      } catch (error) {
        patch(tag, (c) => ({
          ...c,
          actionError: message(
            error,
            'The variables table could not be removed.',
          ),
        }))
        return false
      }
    },
    [patch],
  )

  const reload = useCallback(() => {
    patch(keyRef.current, (c) => ({
      ...initial(c.key),
      draft: c.draft,
      source: c.source,
    }))
    setOpenTick((n) => n + 1)
  }, [patch])

  const shown = live.result?.phase === 'ready' ? live.result.value : null
  const draftChanged = Boolean(
    shown &&
    live.draft &&
    valid &&
    canonicalSpecJson(analysisDraft(shown.spec)) !==
      canonicalSpecJson(live.draft),
  )
  return {
    catalog: live.catalog,
    list: live.list,
    operation: live.operation,
    running,
    resultId: live.resultId,
    result: live.result,
    draft: live.draft,
    draftSource: live.source,
    draftErrors: validation && !validation.ok ? validation.errors : [],
    draftChanged,
    // The last resolved sample stays shown while a newer draft resolves.
    inputs: live.inputs?.load ?? null,
    actionError: live.actionError,
    interrupted: live.interrupted,
    busy: live.busy,
    setDraft,
    selectResult,
    loadSavedSpec,
    resetDraft,
    detail,
    requestDetail,
    compute,
    cancel,
    saveSpec,
    deleteSpec,
    saveSet,
    lockSet,
    deleteSet,
    importSet,
    dismissError,
    reload,
    rereadCatalog,
    importVariables,
    removeVariables,
  }
}
