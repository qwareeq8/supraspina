import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  REQUIRED_SIDECAR_CAPABILITIES,
  type ExecutionAuthorization,
  type HostState,
  type ResumeWorkflowRequest,
  type RetryWorkflowRequest,
  type WorkflowAcknowledgements,
  type WorkflowIntent,
  type WorkflowResult,
  type WorkflowTarget,
} from '../../shared/contract'
import type { ProjectConfig } from '../../shared/project-schema'
import type { ProjectRef } from '../../shared/types'
import type { StepKey } from '../../shared/steps'
import { getApi } from './api'
import { useApp } from './context'
import { ExecutionCanceled, REVIEW_PLAN_LABEL } from './execution-feedback'
import { noWorkSummaryText } from './plan-node-facts'
import { useRecoveryReview } from './recovery-review-state'
import { useWorkflowReview } from './workflow-review-state'

/**
 * The pending callback of the planning line a launch published, as
 * `trackPlan` returns it: true holds launches under the line and false
 * releases it. The service releases the line while the plan is on screen and
 * holds it again from approval until the launch settles. A launch that
 * published no line passes none, so it never releases another launch's line.
 */
export type PlanningLine = (pending: boolean) => void

/** One execution policy for every renderer workflow action. */
export interface ExecutionService {
  plan(
    intent: WorkflowIntent,
    acknowledgements?: WorkflowAcknowledgements,
  ): Promise<WorkflowResult>
  run(
    intent: WorkflowIntent,
    acknowledgements?: WorkflowAcknowledgements,
    planning?: PlanningLine,
    /**
     * The action that starts this run again, such as the notice's
     * normalization, which a read-only plan's disabled approval names.
     */
    relaunchLabel?: string,
  ): Promise<WorkflowResult>
  runAll(
    acknowledgements?: WorkflowAcknowledgements,
    planning?: PlanningLine,
  ): Promise<WorkflowResult>
  runStage(
    stepKey: StepKey,
    acknowledgements?: WorkflowAcknowledgements,
    planning?: PlanningLine,
  ): Promise<WorkflowResult>
  resume(
    runId: string,
    acknowledgements?: WorkflowAcknowledgements,
    planning?: PlanningLine,
  ): Promise<WorkflowResult>
  retry(
    runId: string,
    options?: {
      nodeIds?: string[]
      includeCancelled?: boolean
      cleanIncomplete?: boolean
      acknowledgements?: WorkflowAcknowledgements
      planning?: PlanningLine
      /**
       * The action that starts this retry again, such as the Logs retry of
       * the selected job, which a read-only plan's disabled approval names.
       */
      relaunchLabel?: string
    },
  ): Promise<WorkflowResult>
  cancel(runId: string): Promise<void>
}

/** The Runs action that retries every canceled node of a canceled run. */
export const RETRY_CANCELED_NODES_LABEL = 'Retry canceled jobs'

/**
 * Why Clean up and retry cannot run while Allow live runs is off: the Runs
 * card's disabled reason and the service's refusal, in the same words.
 */
export const SAFE_EXECUTION_OFF_CLEANUP =
  'Allow live runs is off. Turn it on in Execution controls to clean up.'

/**
 * The refusal of live work while Allow live runs is off. It guards
 * authorization after an approved review, which every launch surface
 * reaches, so it names where Allow live runs is turned on.
 */
export const SAFE_EXECUTION_OFF_LIVE_WORK =
  'Allow live runs is off. Turn it on in Runs > Execution controls or in Settings to start live work.'

/**
 * Name the action that starts a retry with these options again, for the text
 * beside a read-only plan's disabled approval. A retry of chosen nodes names
 * the caller's own action, since only the caller knows it: Logs names the
 * selected job's retry by that job's outcome. Without one, the text names the
 * flow. Runs retries every canceled node of a run. Clean up and retry needs
 * Allow live runs before it plans, so it never shows a read-only plan.
 */
function retryRelaunchLabel(options: {
  nodeIds?: string[]
  includeCancelled?: boolean
  relaunchLabel?: string
}): string | undefined {
  if (options.relaunchLabel !== undefined) return options.relaunchLabel
  if (options.nodeIds) return undefined
  return options.includeCancelled ? RETRY_CANCELED_NODES_LABEL : undefined
}

const DEFAULT_ACKNOWLEDGEMENTS: WorkflowAcknowledgements = {
  includeDeferredAndUnreviewedQc: false,
  acknowledgeMemoryAdvisory: false,
}

/** An approved plan, and the release of the launch hold its approval took. */
interface PlanApproval {
  plan: { planId: string; digest: string }
  release: () => void
}

interface ExecutionSnapshot {
  project: ProjectRef
  cfg: ProjectConfig
  configRevision: number
  configSha256: string
  safeExecution: boolean
  hostState: HostState | null
  executionTarget: WorkflowTarget
  /** Keep a started run's plan records for the captured project generation. */
  recordRunPlan: (result: WorkflowResult) => void
  releaseLaunchSelection: (launchedSubjectIds: readonly string[]) => void
}

/** Route every renderer run entry point through this policy facade. */
export function useExecutionService(): ExecutionService {
  const app = useApp()
  const recoveryReview = useRecoveryReview()
  const workflowReview = useWorkflowReview()
  const latestRef = useRef(app)
  const recoveryReviewRef = useRef(recoveryReview)
  const reviewRef = useRef(workflowReview)

  // Publish only committed context state to the stable imperative service.
  useLayoutEffect(() => {
    latestRef.current = app
    recoveryReviewRef.current = recoveryReview
    reviewRef.current = workflowReview
  }, [app, recoveryReview, workflowReview])

  return useMemo<ExecutionService>(() => {
    const capture = (): ExecutionSnapshot => {
      const current = latestRef.current
      if (!current.projectRef) {
        throw new Error('Open or create a project before running.')
      }
      if (current.dirty) {
        throw new Error('Save project changes before running.')
      }
      return {
        project: current.projectRef,
        cfg: current.cfg,
        configRevision: current.configRevision,
        configSha256: current.configSha256,
        safeExecution: current.safeExecution,
        hostState: current.hostState,
        executionTarget: current.executionTarget,
        recordRunPlan: current.recordRunPlan,
        releaseLaunchSelection: current.releaseLaunchSelection,
      }
    }

    const assertCurrent = (captured: ExecutionSnapshot): void => {
      const current = latestRef.current
      if (
        current.dirty ||
        current.projectRef?.projectId !== captured.project.projectId ||
        current.projectRef.epoch !== captured.project.epoch ||
        current.configRevision !== captured.configRevision ||
        current.configSha256 !== captured.configSha256
      ) {
        throw new Error(
          'Review the active project and configuration again because they changed while preparing this action.',
        )
      }
    }

    const assertSidecarReady = (captured: ExecutionSnapshot): void => {
      const sidecar = captured.hostState?.sidecar
      if (sidecar?.state !== 'ready') {
        throw new Error(
          sidecar?.detail ??
            `Restore the workflow service from ${sidecar?.state ?? 'unavailable'}.`,
        )
      }
      if (!sidecar.projectAttached) {
        throw new Error(
          'Attach the active project to the ready workflow service.',
        )
      }
      const missing = REQUIRED_SIDECAR_CAPABILITIES.filter(
        (capability) => !sidecar.capabilities.includes(capability),
      )
      if (missing.length > 0) {
        throw new Error(
          `Restart or update the application because the workflow service lacks ${missing.join(', ')}.`,
        )
      }
    }

    const validate = async (
      captured: ExecutionSnapshot,
      willSpawn: boolean,
    ): Promise<void> => {
      assertCurrent(captured)
      assertSidecarReady(captured)
      const report = await getApi().project.validate(captured.cfg)
      assertCurrent(captured)
      assertSidecarReady(captured)
      if (report.errors.length > 0) {
        throw new Error(
          report.errors[0] ??
            'Resolve the project configuration before continuing.',
        )
      }
      if (
        willSpawn &&
        !captured.cfg.runtime.dryRun &&
        !captured.safeExecution
      ) {
        throw new Error(SAFE_EXECUTION_OFF_LIVE_WORK)
      }
    }

    const authorize = async (
      captured: ExecutionSnapshot,
      purpose: ExecutionAuthorization['purpose'],
      planDigest: string,
    ): Promise<ExecutionAuthorization | undefined> => {
      if (captured.cfg.runtime.dryRun) return undefined
      assertCurrent(captured)
      const authorization = await getApi().execution.authorize({
        project: captured.project,
        configRevision: captured.configRevision,
        purpose,
        planDigest,
      })
      assertCurrent(captured)
      if (
        authorization.projectId !== captured.project.projectId ||
        authorization.configRevision !== captured.configRevision ||
        authorization.purpose !== purpose ||
        authorization.planDigest !== planDigest
      ) {
        throw new Error('Request a valid execution authorization.')
      }
      return authorization
    }

    const request = (
      captured: ExecutionSnapshot,
      intent: WorkflowIntent,
      acknowledgements = DEFAULT_ACKNOWLEDGEMENTS,
      liveExecutionAuthorization?: ExecutionAuthorization,
      approvedPlan?: { planId: string; digest: string },
    ) => ({
      project: captured.project,
      cfg: captured.cfg,
      configRevision: captured.configRevision,
      intent,
      acknowledgements,
      ...(approvedPlan ? { approvedPlan } : {}),
      ...(liveExecutionAuthorization ? { liveExecutionAuthorization } : {}),
    })

    const requireBoundPlan = (
      result: WorkflowResult,
    ): { planId: string; digest: string } => {
      const { plan } = result
      if (
        !/^run-[a-f0-9]{12}$/.test(plan.planId) ||
        !plan.digest ||
        !/^[a-f0-9]{64}$/.test(plan.digest) ||
        !plan.configDigest ||
        !plan.qcDigest ||
        !plan.registryDigest ||
        !plan.environmentDigest ||
        !plan.resources
      ) {
        throw new Error('Request a complete plan binding before executing.')
      }
      return { planId: plan.planId, digest: plan.digest }
    }

    const approvePlan = async (
      captured: ExecutionSnapshot,
      result: WorkflowResult,
      kind: 'run' | 'resume' | 'retry',
      planning: PlanningLine | undefined,
      relaunchLabel?: string,
    ): Promise<PlanApproval | null> => {
      assertCurrent(captured)
      if (result.disposition === 'blocked' || result.disposition === 'noop') {
        return null
      }
      const approvedPlan = requireBoundPlan(result)
      // The line says Supraspina is planning, which stops being true once the
      // plan is on screen, so the launch releases its own line; the review's
      // modal holds every other launch while it is open. The review opens
      // in the same render that clears the line, so no launch control is
      // ever free while neither holds it. Only this launch's line is
      // released: a line another launch published stays until that launch
      // settles.
      planning?.(false)
      if (!captured.cfg.runtime.dryRun && !captured.safeExecution) {
        // Show a live plan that would spawn work read-only while Allow
        // live runs is off: the review cannot approve it, so no path from
        // here requests authorization or sends the plan for execution.
        await reviewRef.current.inspect(
          result.plan,
          kind,
          'safe-execution-off',
          relaunchLabel,
        )
        throw new ExecutionCanceled(
          'Plan review closed. Allow live runs is off, so nothing started.',
        )
      }
      const approved = await reviewRef.current.review(result.plan, kind)
      // A project change cancels an open review, so honor the cancel before
      // checking that the project is still current.
      if (!approved) {
        throw new ExecutionCanceled('Plan review canceled. Nothing started.')
      }
      assertCurrent(captured)
      // Hold launches again through authorization and the start, until the
      // launch settles.
      planning?.(true)
      return { plan: approvedPlan, release: () => planning?.(false) }
    }

    // The sidecar's summary of a plan in which nothing runs counts the nodes
    // of stages that are off as current. It enters the plan digest, so the
    // renderer's copy is restated here, where the configuration the plan was
    // made with is at hand; every surface that shows the outcome reads it.
    const stated = (
      captured: ExecutionSnapshot,
      result: WorkflowResult,
    ): WorkflowResult => {
      const message = noWorkSummaryText(
        result.summary.message,
        result.plan.nodes,
        captured.cfg,
      )
      return message === result.summary.message
        ? result
        : { ...result, summary: { ...result.summary, message } }
    }

    const plan = async (
      intent: WorkflowIntent,
      acknowledgements?: WorkflowAcknowledgements,
    ): Promise<WorkflowResult> => {
      const captured = capture()
      await validate(captured, false)
      assertCurrent(captured)
      const result = await getApi().pipeline.planWorkflow(
        request(captured, intent, acknowledgements),
      )
      assertCurrent(captured)
      return stated(captured, result)
    }

    const runCaptured = async (
      captured: ExecutionSnapshot,
      intent: WorkflowIntent,
      acknowledgements: WorkflowAcknowledgements | undefined,
      planning: PlanningLine | undefined,
      relaunchLabel?: string,
    ): Promise<WorkflowResult> => {
      await validate(captured, false)
      const planned = await getApi().pipeline.planWorkflow(
        request(captured, intent, acknowledgements),
      )
      assertCurrent(captured)
      const approval = await approvePlan(
        captured,
        planned,
        'run',
        planning,
        relaunchLabel,
      )
      if (!approval) return stated(captured, planned)
      try {
        const approvedPlan = approval.plan
        let authorization: ExecutionAuthorization | undefined
        if (!captured.cfg.runtime.dryRun) {
          await validate(captured, true)
          authorization = await authorize(
            captured,
            'live-workflow',
            approvedPlan.digest,
          )
        }
        assertCurrent(captured)
        const result = await getApi().pipeline.runWorkflow(
          request(
            captured,
            intent,
            acknowledgements,
            authorization,
            approvedPlan,
          ),
        )
        // The run started whatever changed meanwhile, so its plan records are
        // kept before the check.
        captured.recordRunPlan(result)
        releaseStartedSelection(captured, intent, result)
        assertCurrent(captured)
        return result
      } finally {
        approval.release()
      }
    }

    // A live run started from a Subjects selection consumes that selection,
    // so the next plan does not silently carry the launched subjects again.
    // A dry run keeps it: it rehearses the live run of the same scope.
    const releaseStartedSelection = (
      captured: ExecutionSnapshot,
      intent: WorkflowIntent,
      result: WorkflowResult,
    ): void => {
      if (result.runId === null || captured.cfg.runtime.dryRun) return
      const { target } = intent
      if (target.mode !== 'explicit' || target.subjectIds.length === 0) return
      captured.releaseLaunchSelection(target.subjectIds)
    }

    const run = async (
      intent: WorkflowIntent,
      acknowledgements?: WorkflowAcknowledgements,
      planning?: PlanningLine,
      relaunchLabel?: string,
    ): Promise<WorkflowResult> =>
      runCaptured(capture(), intent, acknowledgements, planning, relaunchLabel)

    const strictRecoveryAcknowledgements = (
      acknowledgements: WorkflowAcknowledgements,
    ): WorkflowAcknowledgements => ({
      ...acknowledgements,
      includeDeferredAndUnreviewedQc: false,
    })

    const resolveRecoveryAcknowledgements = async <
      TRequest extends ResumeWorkflowRequest | RetryWorkflowRequest,
    >(
      captured: ExecutionSnapshot,
      baseRequest: TRequest,
      preview: (request: TRequest) => Promise<WorkflowResult>,
    ): Promise<{
      acknowledgements: WorkflowAcknowledgements
      planned: WorkflowResult
    }> => {
      let acknowledgements = strictRecoveryAcknowledgements(
        baseRequest.acknowledgements,
      )
      let planned = await preview({
        ...baseRequest,
        acknowledgements,
        previewOnly: true,
      })
      assertCurrent(captured)
      const reconciliation = planned.plan.selectionReconciliation
      const subjectIds = reconciliation?.deferredAndUnreviewedSubjectIds ?? []
      if (subjectIds.length === 0) return { acknowledgements, planned }

      // The strict preview keeps only reviewed Pass subjects, so what it
      // retains is what an exclusion would continue with.
      const choice = await recoveryReviewRef.current.choose(
        subjectIds,
        reconciliation?.retainedSubjectIds.length ?? 0,
      )
      if (choice === 'cancel') {
        throw new ExecutionCanceled('Recovery canceled. Nothing started.')
      }
      assertCurrent(captured)
      if (choice === 'include') {
        acknowledgements = {
          ...acknowledgements,
          includeDeferredAndUnreviewedQc: true,
        }
        planned = await preview({
          ...baseRequest,
          acknowledgements,
          previewOnly: true,
        })
        assertCurrent(captured)
      }
      return { acknowledgements, planned }
    }

    return {
      plan,
      run,
      runAll: (acknowledgements, planning) => {
        const captured = capture()
        // Every Run all and stage confirmation ends in Review plan.
        return runCaptured(
          captured,
          { kind: 'workflow', target: captured.executionTarget },
          acknowledgements,
          planning,
          REVIEW_PLAN_LABEL,
        )
      },
      runStage: (stepKey, acknowledgements, planning) => {
        const captured = capture()
        if (!captured.cfg.steps[stepKey]?.enabled) {
          return Promise.reject(
            new Error(`${stepKey} is disabled in project configuration.`),
          )
        }
        return runCaptured(
          captured,
          {
            kind: 'stage',
            stepKey,
            target: captured.executionTarget,
          },
          acknowledgements,
          planning,
          REVIEW_PLAN_LABEL,
        )
      },
      resume: async (
        runId,
        acknowledgements = DEFAULT_ACKNOWLEDGEMENTS,
        planning,
      ) => {
        const captured = capture()
        await validate(captured, false)
        const baseRequest: ResumeWorkflowRequest = {
          project: captured.project,
          cfg: captured.cfg,
          configRevision: captured.configRevision,
          runId,
          acknowledgements,
        }
        const recovery = await resolveRecoveryAcknowledgements(
          captured,
          baseRequest,
          (request) => getApi().pipeline.resumeWorkflow(request),
        )
        const { planned } = recovery
        const approval = await approvePlan(
          captured,
          planned,
          'resume',
          planning,
        )
        if (!approval) return stated(captured, planned)
        try {
          const approvedPlan = approval.plan
          let authorization: ExecutionAuthorization | undefined
          if (!captured.cfg.runtime.dryRun) {
            await validate(captured, true)
            authorization = await authorize(
              captured,
              'live-workflow',
              approvedPlan.digest,
            )
          }
          assertCurrent(captured)
          const resumeRequest: ResumeWorkflowRequest = {
            ...baseRequest,
            acknowledgements: recovery.acknowledgements,
            approvedPlan,
            ...(authorization
              ? { liveExecutionAuthorization: authorization }
              : {}),
          }
          const result = await getApi().pipeline.resumeWorkflow(resumeRequest)
          captured.recordRunPlan(result)
          assertCurrent(captured)
          return result
        } finally {
          approval.release()
        }
      },
      retry: async (runId, options = {}) => {
        const captured = capture()
        await validate(captured, false)
        if (options.cleanIncomplete && !captured.safeExecution) {
          throw new Error(SAFE_EXECUTION_OFF_CLEANUP)
        }
        const baseRequest: RetryWorkflowRequest = {
          project: captured.project,
          cfg: captured.cfg,
          configRevision: captured.configRevision,
          runId,
          acknowledgements:
            options.acknowledgements ?? DEFAULT_ACKNOWLEDGEMENTS,
          includeCancelled: options.includeCancelled ?? false,
          cleanIncomplete: options.cleanIncomplete ?? false,
          ...(options.nodeIds ? { nodeIds: options.nodeIds } : {}),
        }
        const recovery = await resolveRecoveryAcknowledgements(
          captured,
          baseRequest,
          (request) => getApi().pipeline.retryWorkflow(request),
        )
        const { planned } = recovery
        const approval = await approvePlan(
          captured,
          planned,
          'retry',
          options.planning,
          retryRelaunchLabel(options),
        )
        if (!approval) return stated(captured, planned)
        try {
          const approvedPlan = approval.plan
          let authorization: ExecutionAuthorization | undefined
          if (!captured.cfg.runtime.dryRun) {
            await validate(captured, true)
            authorization = await authorize(
              captured,
              options.cleanIncomplete ? 'cleanup' : 'live-workflow',
              approvedPlan.digest,
            )
          }
          assertCurrent(captured)
          const retryRequest: RetryWorkflowRequest = {
            ...baseRequest,
            acknowledgements: recovery.acknowledgements,
            approvedPlan,
            ...(authorization
              ? { liveExecutionAuthorization: authorization }
              : {}),
          }
          const result = await getApi().pipeline.retryWorkflow(retryRequest)
          captured.recordRunPlan(result)
          assertCurrent(captured)
          return result
        } finally {
          approval.release()
        }
      },
      cancel: async (runId) => {
        // Treat cancellation as containment. Keep it available while configuration is
        // dirty or the sidecar is degraded.
        const project = latestRef.current.projectRef
        if (!project) throw new Error('Open a project before continuing.')
        const result = await getApi().pipeline.cancelRun({
          project,
          runId,
        })
        if (!result.accepted && !result.terminal)
          throw new Error(result.message)
      },
    }
  }, [])
}
