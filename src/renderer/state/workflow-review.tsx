import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { WorkflowNode, WorkflowPlan } from '../../shared/contract'
import { pipelineStep, type StepKey } from '../../shared/steps'
import { unitReuseFact, type UnitReuseForecast } from '../../shared/unit-reuse'
import { ConfirmDialog, FONTS, StageBlockerList, type Theme } from '../ui'
import { useApp } from './context'
import { skippedReasonText, type StageSwitches } from './plan-node-facts'
import {
  WorkflowReviewContext,
  dedupeStageBlockers,
  withBlockedNodeSubjects,
  type WorkflowReadOnlyReason,
  type WorkflowReviewKind,
  type WorkflowReviewValue,
} from './workflow-review-state'

interface PendingReview {
  plan: WorkflowPlan
  kind: WorkflowReviewKind
  /** Set when the plan is shown without its approval action. */
  readOnly: WorkflowReadOnlyReason | null
  /** The action that starts a read-only plan's flow again, when known. */
  relaunchLabel: string | undefined
  resolve: (approved: boolean) => void
}

function reviewTitle(kind: WorkflowReviewKind): string {
  if (kind === 'resume') return 'Review the exact resume plan.'
  if (kind === 'retry') return 'Review the exact retry plan.'
  return 'Review the exact workflow plan.'
}

/** The live approval action, which grants one-use execution authorization. */
function authorizeLabel(kind: WorkflowReviewKind): string {
  return kind === 'run' ? 'Authorize this plan' : `Authorize ${kind}`
}

/**
 * Why the approval action of a read-only plan is disabled, and the fix. The
 * fix ends in the action that started this flow, such as Review plan or
 * Retry canceled nodes, or names the flow when that action is not known.
 */
function readOnlyFootnote(
  reason: WorkflowReadOnlyReason,
  kind: WorkflowReviewKind,
  relaunchLabel: string | undefined,
): string {
  const again =
    relaunchLabel === undefined
      ? `start the ${kind} again`
      : `choose ${relaunchLabel} again`
  switch (reason) {
    case 'safe-execution-off':
      return `${authorizeLabel(kind)} is unavailable because Allow live runs is off. To run this plan, turn on Allow live runs in Runs > Execution controls or in Settings, save the project, then ${again}.`
  }
}

/** The node states a plan runs. */
const RUNNABLE_STATUSES: ReadonlySet<WorkflowNode['status']> = new Set([
  'planned',
  'waiting',
  'queued',
])

/**
 * Why a runnable node runs when the plan names no reason: the planner runs a
 * node only when no current receipt matched it.
 */
const UNNAMED_RUN_REASON = 'No current receipt covers it.'

/** Why a skipped node is skipped when the plan names no reason. */
const UNNAMED_SKIP_REASON = 'The plan skips it.'

/** One stage's nodes that share one reason, in plan order. */
interface StageReasonGroup {
  stepKey: StepKey
  reason: string
  nodes: WorkflowNode[]
}

/**
 * Group nodes by stage and reason, keeping the plan's order. `reasonOf` states
 * a node's recorded reason for display, so nodes whose reasons read the same
 * share one group.
 */
function groupByStageAndReason(
  nodes: readonly WorkflowNode[],
  fallbackReason: string,
  reasonOf: (node: WorkflowNode) => string | undefined = (node) => node.reason,
): StageReasonGroup[] {
  const groups = new Map<string, StageReasonGroup>()
  for (const node of nodes) {
    const reason = reasonOf(node) ?? fallbackReason
    const id = JSON.stringify([node.stepKey, reason])
    const group = groups.get(id)
    if (group) group.nodes.push(node)
    else groups.set(id, { stepKey: node.stepKey, reason, nodes: [node] })
  }
  return [...groups.values()]
}

/** Say whom a group of one stage's nodes covers. */
function scopePhrase(nodes: readonly WorkflowNode[]): string {
  const subjects = nodes.flatMap((node) =>
    node.subjectId === null ? [] : [node.subjectId],
  )
  if (subjects.length === 0) return 'for the cohort'
  if (subjects.length === 1) return `for ${subjects[0]}`
  return `for ${subjects.length} subjects`
}

/**
 * Count subjects for the Scope lines, singular for one.
 *
 * @example
 * subjectCount(4) // '4 subjects'
 */
function subjectCount(count: number): string {
  return `${count} ${count === 1 ? 'subject' : 'subjects'}`
}

/** Join items as "A", "A and B", or "A, B, and C". */
function joinPhrases(items: readonly ReactNode[]): ReactNode[] {
  return items.flatMap((item, index) => {
    if (index === 0) return [item]
    const last = index === items.length - 1
    const separator = last ? (items.length === 2 ? ' and ' : ', and ') : ', '
    return [separator, item]
  })
}

/**
 * One stage's runnable nodes and why they run. The commands and the subjects
 * open from the entry, so a large cohort does not flood the review.
 */
function RunGroupEntry({
  group,
  reuse,
}: {
  group: StageReasonGroup
  /** The stage's per-subject reuse forecast, when it has units. */
  reuse?: UnitReuseForecast | undefined
}): ReactNode {
  const heading = (
    <>
      <strong style={{ fontWeight: 600 }}>
        {pipelineStep(group.stepKey).name}
      </strong>{' '}
      {scopePhrase(group.nodes)}: {group.reason}
    </>
  )
  const reuseFact = reuse && <UnitReuseFact forecast={reuse} />
  const commands = group.nodes.filter((node) => node.command)
  const listsSubjects = group.nodes.length > 1
  if (commands.length === 0 && !listsSubjects) {
    return (
      <li style={{ marginBottom: 4 }}>
        {heading}
        {reuseFact}
      </li>
    )
  }
  return (
    <li style={{ marginBottom: 4 }}>
      <details>
        <summary style={{ cursor: 'pointer' }}>{heading}</summary>
        <ul
          aria-label={`Commands for ${pipelineStep(group.stepKey).name}`}
          // Reach the overflowing list by keyboard as well as by pointer.
          tabIndex={0}
          style={{
            margin: '4px 0 0',
            paddingLeft: 18,
            maxHeight: 220,
            overflowY: 'auto',
            listStyle: listsSubjects ? 'disc' : 'none',
          }}
        >
          {group.nodes.map((node) => (
            <li key={node.nodeId} style={{ marginBottom: 3 }}>
              {node.subjectId !== null && (
                <span style={{ fontFamily: FONTS.mono }}>{node.subjectId}</span>
              )}
              {node.command && (
                <div
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 11,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {node.command}
                </div>
              )}
            </li>
          ))}
        </ul>
      </details>
      {reuseFact}
    </li>
  )
}

/**
 * State which subjects a cohort stage computes and which keep their verified
 * earlier output, naming the computed subjects when only some are.
 */
function UnitReuseFact({
  forecast,
}: {
  forecast: UnitReuseForecast
}): ReactNode {
  const computed = forecast.computedSubjectIds
  const partial = computed.length > 0 && forecast.reusedSubjectIds.length > 0
  return (
    <div data-testid="unit-reuse-fact" style={{ marginTop: 2 }}>
      {unitReuseFact(forecast)}
      {partial && (
        <details>
          <summary style={{ cursor: 'pointer' }}>
            {computed.length === 1
              ? 'Show the computed subject'
              : `Show the ${computed.length} computed subjects`}
          </summary>
          <div style={{ fontFamily: FONTS.mono, overflowWrap: 'anywhere' }}>
            {computed.join(', ')}
          </div>
        </details>
      )}
    </div>
  )
}

/**
 * Summarize the skipped nodes by reason, naming each stage with how many
 * nodes it skips for that reason.
 */
function SkippedSummary({
  groups,
}: {
  groups: readonly StageReasonGroup[]
}): ReactNode {
  const byReason = new Map<string, StageReasonGroup[]>()
  for (const group of groups) {
    const same = byReason.get(group.reason)
    if (same) same.push(group)
    else byReason.set(group.reason, [group])
  }
  return (
    <ul style={{ margin: 0, paddingLeft: 22 }}>
      {[...byReason.entries()].map(([reason, stages]) => (
        <li key={reason} style={{ marginBottom: 4 }}>
          {joinPhrases(
            stages.map((stage) => (
              <span key={stage.stepKey}>
                <strong style={{ fontWeight: 600 }}>
                  {pipelineStep(stage.stepKey).name}
                </strong>{' '}
                {scopePhrase(stage.nodes)}
              </span>
            )),
          )}
          : {reason}
        </li>
      ))}
    </ul>
  )
}

function WorkflowPlanReview({
  plan,
  readOnly,
  switches,
  leadId,
  t,
}: {
  plan: WorkflowPlan
  readOnly: WorkflowReadOnlyReason | null
  /** The project configuration, which says which stages are off. */
  switches: StageSwitches
  /** The id of the lead paragraph, which describes the dialog. */
  leadId: string
  t: Theme
}): ReactNode {
  const runnable = plan.nodes.filter((node) =>
    RUNNABLE_STATUSES.has(node.status),
  )
  const runGroups = groupByStageAndReason(runnable, UNNAMED_RUN_REASON)
  // The recorded skip reasons enter the plan digest, so they are restated
  // here: a stage that is off says so even where a Resume or Retry plan
  // recorded its recovery wording, and no reason repeats the stage name.
  const skippedGroups = groupByStageAndReason(
    plan.nodes.filter((node) => node.status === 'skipped'),
    UNNAMED_SKIP_REASON,
    (node) => skippedReasonText(node, switches),
  )
  const selectedSubjectIds = plan.selectedSubset.subjectIds
  // Partition and dedupe for display only; every distinct blocker cause still
  // renders, with a count when it blocks several nodes. A stage gates this
  // pass when it keeps a runnable node or when a runnable node transitively
  // depends on one of its nodes; a runtime policy can block a dependency
  // after planning without re-propagating dependents.
  const nodesById = new Map(plan.nodes.map((node) => [node.nodeId, node]))
  const gatingStepKeys = new Set<string>(runnable.map((node) => node.stepKey))
  const visited = new Set<string>()
  const pending = runnable.flatMap((node) => node.dependencies)
  while (pending.length > 0) {
    const nodeId = pending.pop()
    if (nodeId === undefined || visited.has(nodeId)) continue
    visited.add(nodeId)
    const dependency = nodesById.get(nodeId)
    if (!dependency) continue
    gatingStepKeys.add(dependency.stepKey)
    pending.push(...dependency.dependencies)
  }
  // A blocker the sidecar reported without subjects names those of the
  // blocked nodes that record its reason, such as the output conflict.
  const blockers = withBlockedNodeSubjects(plan.blockers, plan.nodes)
  const blocking = dedupeStageBlockers(
    runnable.length === 0
      ? blockers
      : blockers.filter((blocker) => gatingStepKeys.has(blocker.key)),
  )
  const deferred = dedupeStageBlockers(
    runnable.length === 0
      ? []
      : blockers.filter((blocker) => !gatingStepKeys.has(blocker.key)),
  )
  const excluded = plan.exclusions
  const reconciliation = plan.selectionReconciliation
  // Each fact once, in the order the planner states them.
  const advisories = [...new Set(plan.advisories ?? [])]
  const reuseByStep = new Map(
    (plan.unitReuse ?? []).map((forecast) => [forecast.stepKey, forecast]),
  )
  return (
    // The dialog body scrolls within the window-bounded card, so the plan
    // takes whatever height the title and actions leave instead of a fixed
    // share of the viewport that text zoom inflates.
    <div
      data-testid="workflow-plan-review"
      style={{ display: 'grid', gap: 10, paddingRight: 4 }}
    >
      {readOnly === null ? (
        <p id={leadId} style={{ margin: 0 }}>
          The sidecar&apos;s authoritative, one-use plan. Approval binds one-use
          authorization to exactly this reviewed plan.
        </p>
      ) : (
        <p id={leadId} style={{ margin: 0 }}>
          This is the sidecar&apos;s authoritative plan, shown read-only because
          Allow live runs is off. Nothing starts from this review.{' '}
          {runnable.length} of its {plan.nodes.length}{' '}
          {plan.nodes.length === 1 ? 'job' : 'jobs'} would run.
        </p>
      )}
      <details>
        <summary style={{ cursor: 'pointer' }}>Technical details</summary>
        <div style={{ marginTop: 4 }}>
          Authorization binds to plan digest{' '}
          <code style={{ fontFamily: FONTS.mono, overflowWrap: 'anywhere' }}>
            {plan.digest ?? 'unavailable'}
          </code>
          .
        </div>
      </details>
      <section aria-labelledby="workflow-review-scope">
        <h3 id="workflow-review-scope" style={{ margin: '0 0 4px' }}>
          Scope
        </h3>
        <div>
          Analysis cohort: {subjectCount(plan.analysisCohort.subjectIds.length)}
        </div>
        <div>
          Selected execution subset: {subjectCount(selectedSubjectIds.length)}
        </div>
        {selectedSubjectIds.length === 0 ? (
          <div>No selected subjects</div>
        ) : (
          <details>
            <summary style={{ cursor: 'pointer' }}>
              {selectedSubjectIds.length === 1
                ? 'Show the selected subject'
                : `Show all ${selectedSubjectIds.length} selected subjects`}
            </summary>
            <div
              style={{
                marginTop: 4,
                fontFamily: FONTS.mono,
                overflowWrap: 'anywhere',
              }}
            >
              {selectedSubjectIds.join(', ')}
            </div>
          </details>
        )}
      </section>
      {excluded &&
        Boolean(
          excluded.qcFailedSubjectIds.length ||
          excluded.configExcludedSubjectIds.length,
        ) && (
          <section aria-labelledby="workflow-review-exclusions">
            <h3 id="workflow-review-exclusions" style={{ margin: '0 0 4px' }}>
              Exclusions
            </h3>
            <div>
              QC Fail: {excluded.qcFailedSubjectIds.join(', ') || 'None'}
            </div>
            <div>
              Project configuration:{' '}
              {excluded.configExcludedSubjectIds.join(', ') || 'None'}
            </div>
          </section>
        )}
      {reconciliation && (
        <section aria-labelledby="workflow-review-reconciliation">
          <h3 id="workflow-review-reconciliation" style={{ margin: '0 0 4px' }}>
            Recovery reconciliation
          </h3>
          <div>
            Retained: {reconciliation.retainedSubjectIds.join(', ') || 'None'}
          </div>
          <div>
            Removed: {reconciliation.removedSubjectIds.join(', ') || 'None'}
          </div>
          <div>
            Newly eligible, not added:{' '}
            {reconciliation.addedSubjectIds.join(', ') || 'None'}
          </div>
        </section>
      )}
      <section aria-labelledby="workflow-review-effects">
        <h3 id="workflow-review-effects" style={{ margin: '0 0 4px' }}>
          Effects
        </h3>
        {runnable.length === 0 ? (
          <div>Every scientific process stays stopped.</div>
        ) : (
          <ol style={{ margin: 0, paddingLeft: 22 }}>
            {runGroups.map((group) => (
              <RunGroupEntry
                key={`${group.stepKey}:${group.reason}`}
                group={group}
                reuse={reuseByStep.get(group.stepKey)}
              />
            ))}
          </ol>
        )}
      </section>
      {skippedGroups.length > 0 && (
        <section aria-labelledby="workflow-review-skipped">
          <h3 id="workflow-review-skipped" style={{ margin: '0 0 4px' }}>
            Skipped
          </h3>
          <SkippedSummary groups={skippedGroups} />
        </section>
      )}
      <section aria-labelledby="workflow-review-blockers">
        <h3 id="workflow-review-blockers" style={{ margin: '0 0 4px' }}>
          Blockers
        </h3>
        {blocking.length === 0 ? (
          <div>
            {deferred.length > 0 ? 'No blockers gate this pass.' : 'None'}
          </div>
        ) : (
          <StageBlockerList t={t} lines={blocking} />
        )}
      </section>
      {deferred.length > 0 && (
        <section aria-labelledby="workflow-review-deferred">
          <h3 id="workflow-review-deferred" style={{ margin: '0 0 4px' }}>
            Not in this pass
          </h3>
          <div>These blocked stages will not run in this pass:</div>
          <StageBlockerList t={t} lines={deferred} />
        </section>
      )}
      {advisories.length > 0 && (
        <section aria-labelledby="workflow-review-warnings">
          <h3 id="workflow-review-warnings" style={{ margin: '0 0 4px' }}>
            Warnings
          </h3>
          <div>These facts block nothing; the plan runs as listed.</div>
          <ul style={{ margin: '2px 0 0', paddingLeft: 22 }}>
            {advisories.map((advisory) => (
              <li key={advisory} style={{ marginBottom: 4 }}>
                {advisory}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="workflow-review-resources">
        <h3 id="workflow-review-resources" style={{ margin: '0 0 4px' }}>
          Resources and environment
        </h3>
        {plan.resources ? (
          <>
            <div>Queue size: {plan.resources.queueSize}</div>
            <div>
              Available memory:{' '}
              {plan.resources.availableMemoryGB === null
                ? 'unknown'
                : `${plan.resources.availableMemoryGB.toFixed(1)} GB`}
            </div>
            <div>
              Memory advisory threshold: {plan.resources.memoryWarningGB} GB
              {plan.resources.lowMemory ? ' - acknowledgment required' : ''}
            </div>
          </>
        ) : (
          <div>The plan records no environment evidence.</div>
        )}
      </section>
    </div>
  )
}

/** Require authoritative plan review before workflow execution. */
export function WorkflowReviewProvider({
  children,
}: {
  children: ReactNode
}): ReactNode {
  const app = useApp()
  const [pending, setPending] = useState<PendingReview | null>(null)
  const pendingRef = useRef<PendingReview | null>(null)
  // The lead paragraph describes the dialog: the whole plan is too long to
  // read out when it opens, and stays reachable in the dialog body.
  const leadId = useId()

  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  useEffect(
    () => () => {
      pendingRef.current?.resolve(false)
      pendingRef.current = null
      // Close the dialog too, so a settled plan never outlives its project.
      setPending(null)
    },
    [app.projectEpoch],
  )

  const settle = useCallback((approved: boolean) => {
    const current = pendingRef.current
    if (!current) return
    pendingRef.current = null
    setPending(null)
    current.resolve(approved)
  }, [])

  const open = useCallback(
    (
      plan: WorkflowPlan,
      kind: WorkflowReviewKind,
      readOnly: WorkflowReadOnlyReason | null,
      relaunchLabel?: string,
    ): Promise<boolean> => {
      if (pendingRef.current) {
        return Promise.reject(
          new Error(
            'Finish the current authoritative workflow plan before opening another.',
          ),
        )
      }
      if (!plan.digest || !plan.resources) {
        return Promise.reject(
          new Error('Request a bound plan before executing.'),
        )
      }
      return new Promise<boolean>((resolve) => {
        const next = { plan, kind, readOnly, relaunchLabel, resolve }
        pendingRef.current = next
        setPending(next)
      })
    },
    [],
  )

  const value = useMemo<WorkflowReviewValue>(
    () => ({
      review: (plan, kind) => open(plan, kind, null),
      // Discard the settled flag: a read-only plan has no approval to report.
      inspect: async (plan, kind, reason, relaunchLabel) => {
        await open(plan, kind, reason, relaunchLabel)
      },
    }),
    [open],
  )

  return (
    <WorkflowReviewContext value={value}>
      {children}
      {pending && (
        <ConfirmDialog
          t={app.t}
          title={reviewTitle(pending.kind)}
          message={
            <WorkflowPlanReview
              plan={pending.plan}
              readOnly={pending.readOnly}
              switches={app.cfg}
              leadId={leadId}
              t={app.t}
            />
          }
          descriptionId={leadId}
          onDismiss={() => settle(false)}
          {...(pending.readOnly === null
            ? {}
            : {
                footnote: readOnlyFootnote(
                  pending.readOnly,
                  pending.kind,
                  pending.relaunchLabel,
                ),
              })}
          actions={
            pending.readOnly === null
              ? [
                  {
                    label: 'Cancel',
                    onSelect: () => settle(false),
                    initialFocus: true,
                  },
                  {
                    label: app.cfg.runtime.dryRun
                      ? 'Accept plan'
                      : authorizeLabel(pending.kind),
                    onSelect: () => settle(true),
                    tone: 'primary',
                  },
                ]
              : [
                  {
                    label: 'Close',
                    onSelect: () => settle(false),
                    initialFocus: true,
                  },
                  {
                    // Shown disabled so the operator sees which action the
                    // footnote explains; it can never settle an approval.
                    label: authorizeLabel(pending.kind),
                    onSelect: () => settle(false),
                    tone: 'primary',
                    disabled: true,
                    // The footnote says why it is off and how to turn on
                    // what it needs.
                    describedByFootnote: true,
                  },
                ]
          }
        />
      )}
    </WorkflowReviewContext>
  )
}
