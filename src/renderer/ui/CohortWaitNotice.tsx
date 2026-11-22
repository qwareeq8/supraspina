/**
 * States the cohort stage that Partly done subjects wait on. The Dashboard
 * and Subjects share it, so a failed cohort stage reads the same on both.
 */

import type { ReactNode } from 'react'
import { CohortNotice } from './CohortNotice'
import type { Theme } from '../theme/tokens'
import { pipelineStep } from '../../shared/steps'
import type { CellState } from '../../shared/types'
import type { CohortStageWait } from '../state/subject-runtime-status'

const COHORT_WAIT_ATTENTION: ReadonlySet<CellState> = new Set([
  'blocked',
  'withheld',
  'failed',
  'cancelled',
  'interrupted',
  'stale',
])

/** Describe a waiting cohort stage's newest outcome for the notice. */
function cohortWaitStatePhrase(
  state: CellState | null,
  subjectCount: number,
): string {
  switch (state) {
    case 'blocked':
      return 'blocked'
    case 'withheld':
      return 'withheld after an earlier failure'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'canceled'
    case 'interrupted':
      return 'interrupted'
    case 'stale':
      return 'status unknown'
    case 'planned':
    case 'waiting':
    case 'queued':
      return 'queued'
    case 'running':
    case 'cancelling':
      return 'running'
    default:
      return subjectCount === 1
        ? 'not yet run for this subject'
        : 'not yet run for these subjects'
  }
}

/** Say how a cohort stage ended when no subject count frames it. */
function cohortStageOutcomeClause(state: CellState | null): string {
  switch (state) {
    case 'cancelled':
      return 'was canceled'
    case 'interrupted':
      return 'was interrupted'
    default:
      return 'failed'
  }
}

/**
 * Build the notice headline, for example "82 subjects finished their own
 * stages; waiting on R analysis (blocked)." With no subject counted,
 * state the outcome alone: "R analysis failed in its latest run."
 */
function cohortWaitHeadline(wait: CohortStageWait): string {
  const stage = pipelineStep(wait.stepKey).name
  if (wait.subjectCount === 0) {
    return `${stage} ${cohortStageOutcomeClause(wait.state)} in its latest run.`
  }
  const finished =
    wait.subjectCount === 1
      ? '1 subject finished its own stages'
      : `${wait.subjectCount} subjects finished their own stages`
  const phrase = cohortWaitStatePhrase(wait.state, wait.subjectCount)
  return `${finished}; waiting on ${stage} (${phrase}).`
}

/**
 * Build the short visible headline, for example "6 subjects are waiting on
 * ENIGMA QC." A stage that ran, runs, or is queued keeps its state in
 * parentheses; a stage not yet run needs none.
 */
function cohortWaitShortHeadline(wait: CohortStageWait): string {
  const stage = pipelineStep(wait.stepKey).name
  if (wait.subjectCount === 0) return cohortWaitHeadline(wait)
  const waiting =
    wait.subjectCount === 1
      ? '1 subject is waiting'
      : `${wait.subjectCount} subjects are waiting`
  const state =
    wait.state === null || wait.state === 'pending'
      ? ''
      : ` (${cohortWaitStatePhrase(wait.state, wait.subjectCount)})`
  return `${waiting} on ${stage}${state}.`
}

/** Whether the waiting stage's newest outcome needs the operator. */
function cohortWaitNeedsAttention(wait: CohortStageWait): boolean {
  return wait.state !== null && COHORT_WAIT_ATTENTION.has(wait.state)
}

/** The waiting cohort stage and the way to Runs. */
export interface CohortWaitNoticeProps {
  t: Theme
  wait: CohortStageWait
  onOpenRuns: () => void
}

/**
 * Render which cohort stage the Partly done subjects wait on and why it has
 * not finished. The counts stay per definition: Done needs every matrix cell.
 *
 * @param props - The wait from `cohortStageWait` and the Runs action.
 * @returns The notice as a polite status region.
 */
export function CohortWaitNotice({
  t,
  wait,
  onOpenRuns,
}: CohortWaitNoticeProps): ReactNode {
  return (
    <CohortNotice
      t={t}
      attention={cohortWaitNeedsAttention(wait)}
      headline={cohortWaitShortHeadline(wait)}
      headlineTitle={cohortWaitHeadline(wait)}
      plain
      detail={wait.reason}
      actionTitle="Open Runs to resolve or run the waiting stage."
      onOpenRuns={onOpenRuns}
    />
  )
}
