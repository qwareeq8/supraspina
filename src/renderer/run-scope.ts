/** Shares canonical scope labels between the run dock and Runs screen. */

/** Return the scope-indicator text shown beside the Run controls. */
export function scopePillLabel(selectionSize: number, total: number): string {
  if (total === 0) return 'No subjects'
  if (selectionSize === 0) {
    return `All ${total} subject${total === 1 ? '' : 's'}`
  }
  return `${selectionSize} of ${total} selected`
}

/** Return a primary Run label that matches the exact launch scope. */
export function runButtonLabel(selectionSize: number, total: number): string {
  if (selectionSize > 0) return `Run ${selectionSize} selected`
  return total > 0 ? `Run all ${total}` : 'Run all'
}
import type { WorkflowTarget } from '../shared/contract'

/**
 * The analysis-cohort size a scope label counts, or null while subject
 * discovery has not yet answered for the open project. Zero is an answer:
 * the project has no analysis-cohort subject.
 */
export type CohortSize = number | null

/**
 * The scope value shown while the cohort loads: the placeholder the
 * Dashboard tiles and the header's "--/N" use for a count not yet known.
 */
export const COHORT_LOADING_VALUE = '--'

/** The tooltip that says what {@link COHORT_LOADING_VALUE} stands for. */
export const COHORT_LOADING_TITLE = 'The analysis cohort is still loading.'

/**
 * Return the analysis-cohort size once discovery has answered, and null
 * before, so a count of zero never stands for a cohort that is still loading.
 *
 * @returns The cohort size, or null while it is unknown.
 * @example
 * knownCohortSize(false, 0) // null
 */
export function knownCohortSize(
  discoveryAnswered: boolean,
  total: number,
): CohortSize {
  return discoveryAnswered ? total : null
}

/**
 * Keep all-subject and explicit-empty scope labels distinct.
 *
 * @param total - The eligible subject count, or null while the cohort loads.
 */
export function targetScopePillLabel(
  target: WorkflowTarget,
  total: CohortSize,
): string {
  if (total === null) return COHORT_LOADING_VALUE
  if (total === 0) return 'No analysis-cohort subjects'
  if (target.mode === 'all') {
    return `All ${total} subject${total === 1 ? '' : 's'}`
  }
  if (target.subjectIds.length === 0) return 'No subjects selected'
  return `${target.subjectIds.length} of ${total} selected`
}

/**
 * Return a Run label that matches explicit target semantics.
 *
 * @param total - The eligible subject count, or null while the cohort loads.
 */
export function targetRunButtonLabel(
  target: WorkflowTarget,
  total: CohortSize,
): string {
  if (target.mode === 'explicit') {
    return target.subjectIds.length > 0
      ? `Run ${target.subjectIds.length} selected`
      : 'Run selection'
  }
  return total !== null && total > 0 ? `Run all ${total}` : 'Run all'
}

/**
 * Name the cut between the discovered subjects and the analysis cohort, so a
 * cohort count shown beside the all-subject count is explained.
 *
 * @param cohort - The analysis-cohort size, or null while it loads.
 * @param discovered - The count of every discovered subject.
 * @param qcFailed - How many discovered subjects have a QC Fail verdict.
 * @returns A sentence such as `20 of 24 subjects are in the analysis cohort;
 *   4 failed QC.`, or null when the two counts agree or are unknown.
 */
export function cohortCutTitle(
  cohort: CohortSize,
  discovered: number,
  qcFailed: number,
): string | null {
  if (cohort === null || cohort >= discovered) return null
  const lead = `${cohort} of ${discovered} subject${discovered === 1 ? ' is' : 's are'} in the analysis cohort`
  const failed = Math.min(qcFailed, discovered - cohort)
  const other = discovered - cohort - failed
  const reasons = [
    failed > 0 ? `${failed} failed QC` : null,
    other > 0
      ? `${other} ${other === 1 ? 'is' : 'are'} otherwise excluded`
      : null,
  ].filter((part): part is string => part !== null)
  return `${lead}; ${reasons.join(' and ')}.`
}
