/**
 * Per-subject reuse inside a cohort stage, such as ENIGMA QC rendering only
 * new or changed subjects. The sidecar decides each subject's units from
 * content digests at launch (sidecar/supraspina_sidecar/unit_reuse.py) and keeps
 * this subject-level summary on the job (`unitReuse`) and, from the receipt
 * record, on a Results row. A plan carries a forecast per runnable stage.
 */

import { isValidQcSubjectId } from './qc-store'

/** Which subjects a cohort stage computes and which keep verified output. */
export interface UnitReuseSummary {
  /** Subjects with at least one unit computed in this run. */
  computedSubjectIds: string[]
  /** Subjects whose every unit keeps a verified earlier result. */
  reusedSubjectIds: string[]
  /** The runs that produced the reused results. */
  sourceRunIds: string[]
}

/** The plan's forecast for one runnable cohort stage with per-subject units. */
export interface UnitReuseForecast extends UnitReuseSummary {
  nodeId: string
  stepKey: string
}

const MAX_SUBJECTS = 5_000
const RUN_ID = /^run-[a-f0-9]{8,32}$/
const SUMMARY_KEYS = [
  'computedSubjectIds',
  'reusedSubjectIds',
  'sourceRunIds',
] as const

function invalid(label: string): TypeError {
  return new TypeError(`Provide a valid ${label}.`)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(label)
  }
  return value as Record<string, unknown>
}

function ids(
  value: unknown,
  valid: (item: string) => boolean,
  label: string,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_SUBJECTS ||
    !value.every((item) => typeof item === 'string' && valid(item)) ||
    new Set(value).size !== value.length
  ) {
    throw invalid(label)
  }
  return [...(value as string[])]
}

/**
 * Parse one untrusted subject-level reuse summary.
 *
 * @param value - The summary from a job, a receipt projection, or a plan.
 * @param label - What the summary belongs to, for the error message.
 * @returns The summary, copied.
 * @throws TypeError when a list is missing, unbounded, or names a subject as
 *   both computed and reused.
 */
export function parseUnitReuseSummary(
  value: unknown,
  label = 'per-subject reuse summary',
): UnitReuseSummary {
  const source = record(value, label)
  const own = Object.keys(source).filter(
    (key) => key !== 'nodeId' && key !== 'stepKey',
  )
  if (
    own.length !== SUMMARY_KEYS.length ||
    !SUMMARY_KEYS.every((key) => own.includes(key))
  ) {
    throw invalid(label)
  }
  const parsed: UnitReuseSummary = {
    // Any cohort subject ID, by the QC store's rule (Python
    // qc_store.valid_subject_id); a subject whose ID a unit record cannot
    // name is still listed, as computed.
    computedSubjectIds: ids(
      source.computedSubjectIds,
      isValidQcSubjectId,
      label,
    ),
    reusedSubjectIds: ids(source.reusedSubjectIds, isValidQcSubjectId, label),
    sourceRunIds: ids(source.sourceRunIds, (item) => RUN_ID.test(item), label),
  }
  const computed = new Set(parsed.computedSubjectIds)
  if (parsed.reusedSubjectIds.some((id) => computed.has(id))) {
    throw invalid(label)
  }
  if (parsed.reusedSubjectIds.length > 0 !== parsed.sourceRunIds.length > 0) {
    throw invalid(label)
  }
  return parsed
}

/** Parse one untrusted plan forecast entry. */
export function parseUnitReuseForecast(
  value: unknown,
  label = 'per-subject reuse forecast',
): UnitReuseForecast {
  const source = record(value, label)
  if (
    Object.keys(source).length !== SUMMARY_KEYS.length + 2 ||
    typeof source.nodeId !== 'string' ||
    source.nodeId.length === 0 ||
    source.nodeId.length > 256 ||
    typeof source.stepKey !== 'string' ||
    !/^[a-z][a-z0-9]{0,63}$/.test(source.stepKey)
  ) {
    throw invalid(label)
  }
  return {
    nodeId: source.nodeId,
    stepKey: source.stepKey,
    ...parseUnitReuseSummary(source, label),
  }
}

function subjects(count: number): string {
  return `${count} ${count === 1 ? 'subject' : 'subjects'}`
}

function runs(ids: readonly string[]): string {
  if (ids.length <= 1) return ids.join('')
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`
}

/**
 * State which subjects a stage computes and which keep verified output.
 *
 * @example
 * unitReuseFact({ computedSubjectIds: ['sub-9'], reusedSubjectIds: [...92],
 *   sourceRunIds: ['run-8407b948c62b'] })
 * // 'Computes 1 subject and reuses the verified output of 92 subjects from
 * //  run-8407b948c62b.'
 */
export function unitReuseFact(
  summary: UnitReuseSummary,
  tense: 'present' | 'past' = 'present',
): string {
  const past = tense === 'past'
  const computed = summary.computedSubjectIds.length
  const reused = summary.reusedSubjectIds.length
  const compute = past ? 'Computed' : 'Computes'
  if (reused === 0) {
    const matches = past ? 'matched' : 'matches'
    return `${compute} ${subjects(computed)}; no verified earlier output ${matches}.`
  }
  const from = runs(summary.sourceRunIds)
  const computes = computed === 0 ? 'no subjects' : subjects(computed)
  const reuse = past ? 'reused' : 'reuses'
  return `${compute} ${computes} and ${reuse} the verified output of ${subjects(reused)} from ${from}.`
}

/**
 * The render that replaced the images a subject's recorded QC verdict was
 * reviewed on, because the subject's inputs or the rendering method changed.
 * Display evidence only: the verdict and every digest stay as recorded.
 */
export interface ImagesChangedSinceVerdict {
  renderedRunId: string
  reason: 'inputs-changed' | 'method-changed'
}

/**
 * Parse the sidecar's optional replaced-images evidence for one gallery.
 *
 * @param value - The `imagesChangedSinceVerdict` member, or undefined.
 * @returns The evidence, or null when absent.
 * @throws TypeError when present but malformed.
 */
export function parseImagesChangedSinceVerdict(
  value: unknown,
): ImagesChangedSinceVerdict | null {
  if (value === undefined || value === null) return null
  const source = record(value, 'replaced-images evidence')
  if (
    Object.keys(source).length !== 2 ||
    typeof source.renderedRunId !== 'string' ||
    !RUN_ID.test(source.renderedRunId) ||
    (source.reason !== 'inputs-changed' && source.reason !== 'method-changed')
  ) {
    throw invalid('replaced-images evidence')
  }
  return { renderedRunId: source.renderedRunId, reason: source.reason }
}

/** State why the shown images replaced those a verdict was recorded on. */
export function imagesChangedText(change: ImagesChangedSinceVerdict): string {
  const cause =
    change.reason === 'inputs-changed'
      ? "this subject's inputs changed"
      : 'the rendering method changed'
  return `These images were rendered again in ${change.renderedRunId} after the recorded verdict because ${cause}. Review them again before relying on the verdict.`
}
