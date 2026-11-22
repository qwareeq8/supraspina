import { createContext, useContext } from 'react'
import type { WorkflowNode, WorkflowPlan } from '../../shared/contract'
import type { StageBlocker } from '../../shared/types'

/** The workflow operation that requires authoritative plan review. */
export type WorkflowReviewKind = 'run' | 'resume' | 'retry'

/** One deduplicated review-dialog blocker line with its occurrence count. */
export interface ReviewBlockerLine {
  key: StageBlocker['key']
  reason: string
  count: number
  /** Every subject the collapsed occurrences name, in reported order. */
  subjects: string[]
  action?: string
}

/**
 * Collapse repeated blocker entries by key, kind, and reason for display.
 *
 * The sidecar reports one blocker per affected node, so one cohort-wide cause
 * repeats once per subject. This display-level dedupe keeps every distinct
 * cause together with how many nodes it blocks; it never changes which nodes
 * are blocked. Collapsed occurrences merge their affected-subject lists, so
 * no subject identity disappears behind the count.
 */
export function dedupeStageBlockers(
  blockers: readonly StageBlocker[],
): ReviewBlockerLine[] {
  const lines = new Map<string, ReviewBlockerLine>()
  for (const blocker of blockers) {
    const id = `${blocker.key}|${blocker.kind ?? ''}|${blocker.reason}`
    const line = lines.get(id)
    if (line) {
      line.count += 1
      for (const subject of blocker.subjects ?? []) {
        if (!line.subjects.includes(subject)) line.subjects.push(subject)
      }
      if (line.action === undefined && blocker.action !== undefined) {
        line.action = blocker.action
      }
    } else {
      lines.set(id, {
        key: blocker.key,
        reason: blocker.reason,
        count: 1,
        subjects: [...(blocker.subjects ?? [])],
        ...(blocker.action === undefined ? {} : { action: blocker.action }),
      })
    }
  }
  return [...lines.values()]
}

/**
 * Name the subjects of the blockers that the sidecar reported without any.
 *
 * A plan-time remedy such as the Reconstruction output conflict reaches the
 * plan's blockers with no subjects, although the blocked nodes that record it
 * name them. A blocker without subjects takes the subjects of its stage's
 * blocked nodes that record its reason, in plan order; a blocker that names
 * subjects, or whose reason no subject node records, is kept as reported.
 * This is for display only: the plan's blockers are not changed.
 *
 * @returns The blockers, each without subjects filled from the plan nodes.
 */
export function withBlockedNodeSubjects(
  blockers: readonly StageBlocker[],
  nodes: readonly WorkflowNode[],
): StageBlocker[] {
  return blockers.map((blocker) => {
    if ((blocker.subjects ?? []).length > 0) return blocker
    const subjects = [
      ...new Set(
        nodes.flatMap((node) =>
          node.status === 'blocked' &&
          node.stepKey === blocker.key &&
          node.reason === blocker.reason &&
          node.subjectId !== null
            ? [node.subjectId]
            : [],
        ),
      ),
    ]
    return subjects.length === 0
      ? blocker
      : { ...blocker, subjects, subjectCount: subjects.length }
  })
}

/** Why a plan opens read-only instead of for approval. */
export type WorkflowReadOnlyReason = 'safe-execution-off'

/** The authoritative workflow-plan review operations. */
export interface WorkflowReviewValue {
  /** Show the plan for approval; resolve whether the operator approved it. */
  review(plan: WorkflowPlan, kind: WorkflowReviewKind): Promise<boolean>
  /**
   * Show the plan read-only with its approval action disabled for `reason`;
   * resolve when the operator closes it. It never yields an approval.
   * `relaunchLabel` names the action that starts this flow again, which the
   * text beside the disabled approval names; without it, the text names the
   * flow.
   */
  inspect(
    plan: WorkflowPlan,
    kind: WorkflowReviewKind,
    reason: WorkflowReadOnlyReason,
    relaunchLabel?: string,
  ): Promise<void>
}

/** Authoritative workflow-plan review shared with renderer consumers. */
export const WorkflowReviewContext = createContext<WorkflowReviewValue | null>(
  null,
)

/** Use the authoritative workflow-plan review operation. */
export function useWorkflowReview(): WorkflowReviewValue {
  const value = useContext(WorkflowReviewContext)
  if (value) return value
  const unavailable = async (): Promise<never> => {
    throw new Error(
      'Restore the authoritative workflow review surface before execution.',
    )
  }
  return { review: unavailable, inspect: unavailable }
}
