import type { WorkflowNode } from '../../shared/contract'
import type { ProjectConfig } from '../../shared/project-schema'
import { PIPELINE_STEPS } from '../../shared/steps'

/**
 * The reason a Resume or Retry plan records on every node outside its
 * recovery closure, including the nodes of a stage that is off. It enters
 * the plan digest, so the sidecar keeps it and the review restates it.
 */
const OUTSIDE_RECOVERY_REASON =
  'This work is outside the invalid source-node recovery closure, so it is not scheduled.'

/**
 * Why a skipped node of a stage that is off does not run, as the plan review
 * words it after the stage name, which it does not repeat. It is capitalized
 * like every other reason the review shows after a stage name.
 */
export const STAGE_OFF_SKIP_REASON = 'Off in project configuration.'

/** Why a skipped node outside a Resume or Retry plan's recovery does not run. */
export const NOT_IN_RECOVERY_SKIP_REASON = 'Not part of this recovery.'

/** The part of the project configuration that turns stages on and off. */
export type StageSwitches = Pick<ProjectConfig, 'steps'>

/** The reason the planner records on a node of a stage that is off. */
function stageOffReason(stepKey: WorkflowNode['stepKey']): string | null {
  const step = PIPELINE_STEPS.find((candidate) => candidate.key === stepKey)
  return step ? `${step.name} is off in project configuration.` : null
}

/**
 * Tell whether a skipped plan node belongs to a stage that is off.
 *
 * A Run all plan records "<stage> is off in project configuration." on such
 * a node. A Resume or Retry plan can replace that reason with its recovery
 * wording, so a node with the recovery wording counts as off when the
 * project configuration turns its stage off.
 *
 * @param switches - The project configuration the plan was made with.
 * @example
 * belongsToStageThatIsOff(defaceNode, cfg) // true while defacing is off
 */
export function belongsToStageThatIsOff(
  node: WorkflowNode,
  switches: StageSwitches,
): boolean {
  if (node.status !== 'skipped' || node.reason === undefined) return false
  if (node.reason === stageOffReason(node.stepKey)) return true
  return (
    node.reason === OUTSIDE_RECOVERY_REASON &&
    switches.steps[node.stepKey]?.enabled === false
  )
}

/** The sidecar's summary of a plan in which every node is skipped. */
const ALL_NODES_CURRENT =
  /^No work is scheduled: (?:the 1 node is|all (\d+) nodes are) current\.$/

/**
 * State a plan in which nothing runs without calling the nodes of stages
 * that are off current.
 *
 * The sidecar counts every skipped node as current ("No work is scheduled:
 * all 21 nodes are current."), and its summary enters the plan digest, so it
 * is restated here in jobs, with the jobs of stages that are off counted
 * apart; `restateRecordedReasons` states the other summaries in jobs. A
 * summary in any other form, or one whose count the nodes do not match,
 * passes through unchanged.
 *
 * @param message - The plan's summary as the sidecar wrote it.
 * @param switches - The project configuration the plan was made with.
 * @example
 * noWorkSummaryText('No work is scheduled: all 21 nodes are current.', nodes, cfg)
 * // 'No work is scheduled: 9 jobs are current and 12 belong to stages that are off.'
 */
export function noWorkSummaryText(
  message: string,
  nodes: readonly WorkflowNode[],
  switches: StageSwitches,
): string {
  const match = ALL_NODES_CURRENT.exec(message)
  if (!match) return message
  const total = match[1] === undefined ? 1 : Number(match[1])
  if (
    nodes.length !== total ||
    nodes.some((node) => node.status !== 'skipped')
  ) {
    return message
  }
  const off = nodes.filter((node) => belongsToStageThatIsOff(node, switches))
  if (off.length === 0) return message
  const stages =
    new Set(off.map((node) => node.stepKey)).size === 1
      ? 'a stage that is off'
      : 'stages that are off'
  const current = total - off.length
  if (current === 0) {
    return total === 1
      ? `No work is scheduled: the 1 job belongs to ${stages}.`
      : `No work is scheduled: all ${total} jobs belong to ${stages}.`
  }
  const currentPart =
    current === 1 ? '1 job is current' : `${current} jobs are current`
  const offPart = off.length === 1 ? '1 belongs' : `${off.length} belong`
  return `No work is scheduled: ${currentPart} and ${offPart} to ${stages}.`
}

/**
 * State why a skipped plan node does not run, for the plan review.
 *
 * The review names the stage before the reason, so a stage that is off reads
 * "Off in project configuration." rather than repeating the stage name, and
 * the recovery wording reads "Not part of this recovery." for a stage that is
 * on. Any other reason, and a missing one, passes through unchanged.
 *
 * @param switches - The project configuration the plan was made with.
 * @returns The reason to show after the stage name, or undefined when the
 *   plan names none.
 * @example
 * skippedReasonText(defaceNode, cfg) // 'Off in project configuration.'
 */
export function skippedReasonText(
  node: WorkflowNode,
  switches: StageSwitches,
): string | undefined {
  if (belongsToStageThatIsOff(node, switches)) return STAGE_OFF_SKIP_REASON
  if (node.reason === OUTSIDE_RECOVERY_REASON) {
    return NOT_IN_RECOVERY_SKIP_REASON
  }
  return node.reason
}
