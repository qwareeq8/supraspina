import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { version as APP_VERSION } from '../../../package.json'
import {
  REQUIRED_SIDECAR_CAPABILITIES,
  type ExecutionAuthorization,
  type WorkflowResult,
} from '../../shared/contract'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { ProjectRef } from '../../shared/types'
import { ExecutionCanceled, runExecutionAction } from './execution-feedback'
import type { PendingPlan } from './context'
import {
  SAFE_EXECUTION_OFF_CLEANUP,
  SAFE_EXECUTION_OFF_LIVE_WORK,
  useExecutionService,
  type ExecutionService,
} from './execution-service'

const mocks = vi.hoisted(() => ({
  app: null as unknown,
  validate: vi.fn(),
  authorize: vi.fn(),
  planWorkflow: vi.fn(),
  runWorkflow: vi.fn(),
  resumeWorkflow: vi.fn(),
  retryWorkflow: vi.fn(),
  cancelRun: vi.fn(),
  chooseRecovery: vi.fn(),
  review: vi.fn(),
  inspect: vi.fn(),
  recordRunPlan: vi.fn(),
  releaseLaunchSelection: vi.fn(),
}))

vi.mock('./context', () => ({ useApp: () => mocks.app }))
vi.mock('./workflow-review-state', () => ({
  useWorkflowReview: () => ({
    review: mocks.review,
    inspect: mocks.inspect,
  }),
}))
vi.mock('./recovery-review-state', () => ({
  useRecoveryReview: () => ({ choose: mocks.chooseRecovery }),
}))
vi.mock('./api', () => ({
  getApi: () => ({
    project: { validate: mocks.validate },
    execution: { authorize: mocks.authorize },
    pipeline: {
      planWorkflow: mocks.planWorkflow,
      runWorkflow: mocks.runWorkflow,
      resumeWorkflow: mocks.resumeWorkflow,
      retryWorkflow: mocks.retryWorkflow,
      cancelRun: mocks.cancelRun,
    },
  }),
}))

const PROJECT: ProjectRef = {
  projectId: 'project-a',
  root: '/project-a',
  configPath: '/project-a/supraspina.project.json',
  epoch: 7,
}

const RESULT: WorkflowResult = {
  runId: null,
  disposition: 'noop',
  plan: {
    planId: 'plan-1',
    analysisCohort: { subjectIds: [], sha256: 'analysis' },
    selectedSubset: { subjectIds: [], sha256: 'selected' },
    nodes: [],
    blockers: [],
    summary: {
      planned: 0,
      started: 0,
      waiting: 0,
      blocked: 0,
      skipped: 0,
      message: 'Request no work with the explicit empty selection.',
    },
  },
  summary: {
    planned: 0,
    started: 0,
    waiting: 0,
    blocked: 0,
    skipped: 0,
    message: 'Request no work with the explicit empty selection.',
  },
}

const PLAN_DIGEST = 'a'.repeat(64)
const BOUND_RESULT: WorkflowResult = {
  runId: null,
  disposition: 'planned',
  plan: {
    planId: 'run-abcdef123456',
    digest: PLAN_DIGEST,
    configDigest: 'b'.repeat(64),
    qcDigest: 'c'.repeat(64),
    registryDigest: 'd'.repeat(64),
    environmentDigest: 'e'.repeat(64),
    analysisCohort: { subjectIds: ['sub-001'], sha256: 'analysis' },
    selectedSubset: { subjectIds: ['sub-001'], sha256: 'selected' },
    nodes: [
      {
        nodeId: '000-recon-sub-001',
        stepKey: 'recon',
        scope: 'subject',
        subjectId: 'sub-001',
        status: 'planned',
        dependencies: [],
        command: 'recon-all',
      },
    ],
    blockers: [],
    resources: {
      queueSize: 2,
      availableMemoryGB: 16,
      memoryWarningGB: 10,
      lowMemory: false,
    },
    summary: {
      planned: 1,
      started: 0,
      waiting: 0,
      blocked: 0,
      skipped: 0,
      message: 'Review the one planned node.',
    },
  },
  summary: {
    planned: 1,
    started: 0,
    waiting: 0,
    blocked: 0,
    skipped: 0,
    message: 'Review the one planned node.',
  },
}

function appState(
  options: {
    dryRun?: boolean
    safeExecution?: boolean
    dirty?: boolean
    target?: { mode: 'all' } | { mode: 'explicit'; subjectIds: string[] }
  } = {},
) {
  const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
  cfg.paths.projectRoot = PROJECT.root
  cfg.runtime.dryRun = options.dryRun ?? true
  return {
    projectRef: PROJECT,
    dirty: options.dirty ?? false,
    cfg,
    configRevision: 3,
    configSha256: 'saved-sha',
    safeExecution: options.safeExecution ?? false,
    executionTarget: options.target ?? { mode: 'all' as const },
    recordRunPlan: mocks.recordRunPlan,
    releaseLaunchSelection: mocks.releaseLaunchSelection,
    hostState: {
      mode: 'electron' as const,
      platform: 'linux' as const,
      captionMode: 'custom' as const,
      sidecar: {
        state: 'ready' as const,
        generation: 4,
        productVersion: APP_VERSION,
        protocolVersion: '1',
        persistenceVersions: {
          project: 1,
          runState: 1,
          manifest: 1,
          receipt: 1,
        },
        capabilities: [...REQUIRED_SIDECAR_CAPABILITIES],
        runtimeId: 'runtime-4',
        projectAttached: true,
        retryable: false,
        detail: null,
      },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.app = appState()
  mocks.validate.mockResolvedValue({
    ok: true,
    data: (mocks.app as ReturnType<typeof appState>).cfg,
    errors: [],
    warnings: [],
  })
  mocks.planWorkflow.mockResolvedValue(BOUND_RESULT)
  mocks.runWorkflow.mockResolvedValue(BOUND_RESULT)
  mocks.resumeWorkflow.mockResolvedValue(BOUND_RESULT)
  mocks.retryWorkflow.mockResolvedValue(BOUND_RESULT)
  mocks.cancelRun.mockResolvedValue({
    runId: 'run-1',
    accepted: true,
    terminal: true,
    pendingJobIds: [],
    message: 'already terminal',
  })
  mocks.review.mockResolvedValue(true)
  mocks.inspect.mockResolvedValue(undefined)
  mocks.chooseRecovery.mockResolvedValue('exclude')
})

describe('unified workflow execution policy', () => {
  it('routes an explicit-empty workflow through authoritative planning without live authorization', async () => {
    mocks.planWorkflow.mockResolvedValue(RESULT)
    mocks.app = appState({
      dryRun: false,
      safeExecution: false,
      target: { mode: 'explicit', subjectIds: [] },
    })
    const { result } = renderHook(() => useExecutionService())

    await expect(
      result.current.plan({
        kind: 'workflow',
        target: { mode: 'explicit', subjectIds: [] },
      }),
    ).resolves.toMatchObject({ disposition: 'noop' })
    await expect(result.current.runAll()).resolves.toMatchObject({
      disposition: 'noop',
    })
    await expect(
      result.current.run({
        kind: 'workflow',
        target: { mode: 'explicit', subjectIds: [] },
      }),
    ).resolves.toMatchObject({ disposition: 'noop' })

    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.planWorkflow).toHaveBeenCalledTimes(3)
    expect(mocks.planWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: {
          kind: 'workflow',
          target: { mode: 'explicit', subjectIds: [] },
        },
      }),
    )
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
    expect(mocks.validate).toHaveBeenCalledTimes(3)
  })

  it('routes an explicit-empty per-subject stage through authoritative no-op planning', async () => {
    mocks.planWorkflow.mockResolvedValue(RESULT)
    mocks.app = appState({
      dryRun: false,
      safeExecution: false,
      target: { mode: 'explicit', subjectIds: [] },
    })
    const { result } = renderHook(() => useExecutionService())

    await expect(result.current.runStage('recon')).resolves.toBe(RESULT)

    expect(mocks.planWorkflow).toHaveBeenCalledOnce()
    expect(mocks.planWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: {
          kind: 'stage',
          stepKey: 'recon',
          target: { mode: 'explicit', subjectIds: [] },
        },
      }),
    )
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
    expect(mocks.authorize).not.toHaveBeenCalled()
  })

  it('runs an explicit-empty cohort stage once over the analysis cohort', async () => {
    mocks.app = appState({
      dryRun: false,
      safeExecution: true,
      target: { mode: 'explicit', subjectIds: [] },
    })
    mocks.authorize.mockResolvedValue({
      token: 'live-token',
      projectId: PROJECT.projectId,
      configRevision: 3,
      purpose: 'live-workflow',
      planDigest: PLAN_DIGEST,
    })
    const { result } = renderHook(() => useExecutionService())

    await expect(result.current.runStage('enigma')).resolves.toBe(BOUND_RESULT)

    expect(mocks.authorize).toHaveBeenCalledOnce()
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: {
          kind: 'stage',
          stepKey: 'enigma',
          target: { mode: 'explicit', subjectIds: [] },
        },
        liveExecutionAuthorization: expect.objectContaining({
          token: 'live-token',
        }),
      }),
    )
    expect(mocks.planWorkflow).toHaveBeenCalledOnce()
  })

  it('commits approved dry-run plans without authorization', async () => {
    mocks.app = appState({ dryRun: true, safeExecution: false })
    const { result } = renderHook(() => useExecutionService())

    await result.current.runAll()
    await result.current.resume('run-preview')
    await result.current.retry('run-preview', {
      nodeIds: [],
      includeCancelled: true,
    })

    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.planWorkflow).toHaveBeenCalledOnce()
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedPlan: {
          planId: BOUND_RESULT.plan.planId,
          digest: PLAN_DIGEST,
        },
      }),
    )
    expect(mocks.runWorkflow.mock.calls[0]?.[0]).not.toHaveProperty(
      'liveExecutionAuthorization',
    )
    expect(mocks.resumeWorkflow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        previewOnly: true,
      }),
    )
    expect(mocks.resumeWorkflow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        approvedPlan: {
          planId: BOUND_RESULT.plan.planId,
          digest: PLAN_DIGEST,
        },
      }),
    )
    expect(mocks.retryWorkflow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        previewOnly: true,
        nodeIds: [],
        includeCancelled: true,
        cleanIncomplete: false,
      }),
    )
    expect(mocks.retryWorkflow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        approvedPlan: {
          planId: BOUND_RESULT.plan.planId,
          digest: PLAN_DIGEST,
        },
        nodeIds: [],
        includeCancelled: true,
        cleanIncomplete: false,
      }),
    )
    expect(mocks.resumeWorkflow.mock.calls[1]?.[0]).not.toHaveProperty(
      'liveExecutionAuthorization',
    )
    expect(mocks.retryWorkflow.mock.calls[1]?.[0]).not.toHaveProperty(
      'liveExecutionAuthorization',
    )
  })

  it('previews recovery strictly and re-plans after including exact pending subjects', async () => {
    const strictResult: WorkflowResult = {
      ...BOUND_RESULT,
      plan: {
        ...BOUND_RESULT.plan,
        selectionReconciliation: {
          sourceSubjectIds: ['sub-001', 'sub-012'],
          currentEligibleSubjectIds: ['sub-001'],
          retainedSubjectIds: ['sub-001'],
          addedSubjectIds: [],
          removedSubjectIds: ['sub-012'],
          deferredAndUnreviewedSubjectIds: ['sub-012'],
        },
      },
    }
    mocks.app = appState({ dryRun: true })
    mocks.resumeWorkflow
      .mockResolvedValueOnce(strictResult)
      .mockResolvedValueOnce(BOUND_RESULT)
      .mockResolvedValueOnce(BOUND_RESULT)
    mocks.chooseRecovery.mockResolvedValueOnce('include')
    const { result } = renderHook(() => useExecutionService())

    await result.current.resume('run-source', {
      includeDeferredAndUnreviewedQc: true,
      acknowledgeMemoryAdvisory: false,
    })

    expect(mocks.chooseRecovery).toHaveBeenCalledWith(['sub-012'], 1)
    expect(mocks.resumeWorkflow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        previewOnly: true,
        acknowledgements: expect.objectContaining({
          includeDeferredAndUnreviewedQc: false,
        }),
      }),
    )
    expect(mocks.resumeWorkflow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        previewOnly: true,
        acknowledgements: expect.objectContaining({
          includeDeferredAndUnreviewedQc: true,
        }),
      }),
    )
    expect(mocks.resumeWorkflow).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        approvedPlan: expect.any(Object),
        acknowledgements: expect.objectContaining({
          includeDeferredAndUnreviewedQc: true,
        }),
      }),
    )
  })

  it('preserves an explicit retry node through fresh QC inclusion and exact-plan review', async () => {
    const strictResult: WorkflowResult = {
      ...BOUND_RESULT,
      plan: {
        ...BOUND_RESULT.plan,
        selectedSubset: { subjectIds: [], sha256: 'strict-selected' },
        nodes: [],
        selectionReconciliation: {
          sourceSubjectIds: [
            'sub-001',
            'sub-012',
            'sub-019',
            'sub-049',
            'sub-053',
          ],
          currentEligibleSubjectIds: [],
          retainedSubjectIds: [],
          addedSubjectIds: [],
          removedSubjectIds: [
            'sub-001',
            'sub-012',
            'sub-019',
            'sub-049',
            'sub-053',
          ],
          deferredAndUnreviewedSubjectIds: ['sub-049'],
        },
      },
    }
    const scopedResult: WorkflowResult = {
      ...BOUND_RESULT,
      plan: {
        ...BOUND_RESULT.plan,
        analysisCohort: {
          subjectIds: ['sub-001', 'sub-012', 'sub-019', 'sub-049', 'sub-053'],
          sha256: 'analysis-five',
        },
        selectedSubset: {
          subjectIds: ['sub-049'],
          sha256: 'selected-sub-049',
        },
        nodes: [
          {
            nodeId: 'recon:sub-049',
            stepKey: 'recon',
            scope: 'subject',
            subjectId: 'sub-049',
            status: 'planned',
            dependencies: [],
            command: 'recon-all -s sub-049 -all',
          },
          {
            nodeId: 'features:cohort',
            stepKey: 'features',
            scope: 'cohort',
            subjectId: null,
            status: 'waiting',
            dependencies: ['recon:sub-049'],
            command: 'features',
          },
        ],
      },
    }
    mocks.app = appState({ dryRun: true })
    mocks.retryWorkflow
      .mockResolvedValueOnce(strictResult)
      .mockResolvedValueOnce(scopedResult)
      .mockResolvedValueOnce(scopedResult)
    mocks.chooseRecovery.mockResolvedValueOnce('include')
    const { result } = renderHook(() => useExecutionService())

    await result.current.retry('run-source', {
      nodeIds: ['source-recon-sub-049'],
    })

    expect(mocks.chooseRecovery).toHaveBeenCalledWith(['sub-049'], 0)
    expect(mocks.review).toHaveBeenCalledWith(scopedResult.plan, 'retry')
    expect(mocks.retryWorkflow).toHaveBeenCalledTimes(3)
    for (const [request] of mocks.retryWorkflow.mock.calls) {
      expect(request).toEqual(
        expect.objectContaining({
          runId: 'run-source',
          nodeIds: ['source-recon-sub-049'],
        }),
      )
    }
    expect(mocks.retryWorkflow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        previewOnly: true,
        acknowledgements: expect.objectContaining({
          includeDeferredAndUnreviewedQc: true,
        }),
      }),
    )
    expect(mocks.retryWorkflow).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        approvedPlan: {
          planId: scopedResult.plan.planId,
          digest: scopedResult.plan.digest,
        },
        acknowledgements: expect.objectContaining({
          includeDeferredAndUnreviewedQc: true,
        }),
      }),
    )
  })

  it('cancels recovery before exact-plan review or authorization', async () => {
    const strictResult: WorkflowResult = {
      ...BOUND_RESULT,
      plan: {
        ...BOUND_RESULT.plan,
        selectionReconciliation: {
          sourceSubjectIds: ['sub-001'],
          currentEligibleSubjectIds: [],
          retainedSubjectIds: [],
          addedSubjectIds: [],
          removedSubjectIds: ['sub-001'],
          deferredAndUnreviewedSubjectIds: ['sub-001'],
        },
      },
    }
    mocks.resumeWorkflow.mockResolvedValueOnce(strictResult)
    mocks.chooseRecovery.mockResolvedValueOnce('cancel')
    const { result } = renderHook(() => useExecutionService())

    const canceled = result.current.resume('run-source')
    await expect(canceled).rejects.toBeInstanceOf(ExecutionCanceled)
    await expect(canceled).rejects.toThrow(
      'Recovery canceled. Nothing started.',
    )
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.resumeWorkflow).toHaveBeenCalledOnce()
  })

  it('allows planning but holds live work behind Allow live runs and authorization', async () => {
    mocks.app = appState({ dryRun: false, safeExecution: false })
    const hook = renderHook(() => useExecutionService())

    await expect(
      hook.result.current.plan({
        kind: 'workflow',
        target: { mode: 'all' },
      }),
    ).resolves.toBe(BOUND_RESULT)
    // The plan opens read-only and closing it ends the launch neutrally:
    // approval is never offered for a plan Allow live runs would refuse.
    const readOnly = hook.result.current.runAll()
    await expect(readOnly).rejects.toBeInstanceOf(ExecutionCanceled)
    await expect(readOnly).rejects.toThrow(
      'Plan review closed. Allow live runs is off, so nothing started.',
    )
    expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(
      BOUND_RESULT.plan,
      'run',
      'safe-execution-off',
      'Review plan',
    )
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.runWorkflow).not.toHaveBeenCalled()

    mocks.app = appState({ dryRun: false, safeExecution: true })
    hook.rerender()
    let releaseAuthorization!: (value: ExecutionAuthorization) => void
    mocks.authorize.mockImplementationOnce(
      () =>
        new Promise<ExecutionAuthorization>((resolve) => {
          releaseAuthorization = resolve
        }),
    )
    const pending = hook.result.current.runAll()
    await vi.waitFor(() => expect(mocks.authorize).toHaveBeenCalledOnce())
    expect(mocks.review).toHaveBeenLastCalledWith(BOUND_RESULT.plan, 'run')
    // Only the earlier Safe-off launch opened the read-only plan.
    expect(mocks.inspect).toHaveBeenCalledOnce()
    expect(mocks.authorize).toHaveBeenCalledWith({
      project: PROJECT,
      configRevision: 3,
      purpose: 'live-workflow',
      planDigest: PLAN_DIGEST,
    })
    expect(mocks.runWorkflow).not.toHaveBeenCalled()

    await act(async () => {
      releaseAuthorization({
        token: 'live-token',
        projectId: PROJECT.projectId,
        configRevision: 3,
        purpose: 'live-workflow',
        planDigest: PLAN_DIGEST,
      })
      await pending
    })
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        liveExecutionAuthorization: expect.objectContaining({
          token: 'live-token',
          purpose: 'live-workflow',
          planDigest: PLAN_DIGEST,
        }),
        approvedPlan: {
          planId: BOUND_RESULT.plan.planId,
          digest: PLAN_DIGEST,
        },
      }),
    )
    expect(mocks.planWorkflow).toHaveBeenCalledTimes(3)
  })

  it('shows every live entry point read-only while Allow live runs is off and never executes', async () => {
    mocks.app = appState({ dryRun: false, safeExecution: false })
    const { result } = renderHook(() => useExecutionService())

    const launches = [
      result.current.runStage('recon'),
      result.current.run({ kind: 'workflow', target: { mode: 'all' } }),
      result.current.resume('run-live'),
      result.current.retry('run-live', { includeCancelled: true }),
    ]
    for (const launch of launches) {
      await expect(launch).rejects.toBeInstanceOf(ExecutionCanceled)
    }

    // Each read-only review names the action that starts its flow again
    // where one action does: a stage's confirmation ends in Review plan and
    // Runs retries canceled work with Retry canceled nodes.
    expect(mocks.inspect.mock.calls).toEqual([
      [BOUND_RESULT.plan, 'run', 'safe-execution-off', 'Review plan'],
      [BOUND_RESULT.plan, 'run', 'safe-execution-off', undefined],
      [BOUND_RESULT.plan, 'resume', 'safe-execution-off', undefined],
      [BOUND_RESULT.plan, 'retry', 'safe-execution-off', 'Retry canceled jobs'],
    ])
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
    // Recovery only previews: no request carries an approved plan or grant.
    for (const [request] of [
      ...mocks.resumeWorkflow.mock.calls,
      ...mocks.retryWorkflow.mock.calls,
    ]) {
      expect(request).toMatchObject({ previewOnly: true })
      expect(request).not.toHaveProperty('approvedPlan')
      expect(request).not.toHaveProperty('liveExecutionAuthorization')
    }
    expect(mocks.resumeWorkflow).toHaveBeenCalledOnce()
    expect(mocks.retryWorkflow).toHaveBeenCalledOnce()
  })

  it("names the caller's own action for a read-only retry of one node", async () => {
    // The Logs retry passes its own button label, so the review names it;
    // without one, the review names the flow.
    mocks.app = appState({ dryRun: false, safeExecution: false })
    const { result } = renderHook(() => useExecutionService())

    await expect(result.current.runAll()).rejects.toBeInstanceOf(
      ExecutionCanceled,
    )
    await expect(
      result.current.retry('run-live', {
        nodeIds: ['000-recon-sub-001'],
        relaunchLabel: 'Retry job',
      }),
    ).rejects.toBeInstanceOf(ExecutionCanceled)
    await expect(
      result.current.retry('run-live', {
        nodeIds: ['000-recon-sub-001'],
        includeCancelled: true,
        relaunchLabel: 'Retry job',
      }),
    ).rejects.toBeInstanceOf(ExecutionCanceled)
    await expect(
      result.current.retry('run-live', { nodeIds: ['000-recon-sub-001'] }),
    ).rejects.toBeInstanceOf(ExecutionCanceled)
    await expect(
      result.current.retry('run-live', {
        nodeIds: ['000-recon-sub-001'],
        includeCancelled: true,
      }),
    ).rejects.toBeInstanceOf(ExecutionCanceled)

    expect(mocks.inspect.mock.calls.map((call) => call[3])).toEqual([
      'Review plan',
      'Retry job',
      'Retry job',
      undefined,
      undefined,
    ])
  })

  it('reports an empty or blocked live plan without a review while Allow live runs is off', async () => {
    mocks.app = appState({ dryRun: false, safeExecution: false })
    const blocked: WorkflowResult = {
      ...BOUND_RESULT,
      disposition: 'blocked',
    }
    mocks.planWorkflow
      .mockResolvedValueOnce(RESULT)
      .mockResolvedValueOnce(blocked)
    const { result } = renderHook(() => useExecutionService())

    await expect(result.current.runAll()).resolves.toBe(RESULT)
    await expect(result.current.runAll()).resolves.toBe(blocked)

    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it('counts the nodes of stages that are off apart in a plan in which nothing runs', async () => {
    const node = (
      stepKey: 'brainfov' | 'deface' | 'recon',
      subjectId: string,
      reason: string,
    ): WorkflowResult['plan']['nodes'][number] => ({
      nodeId: `${stepKey}-${subjectId}`,
      stepKey,
      scope: 'subject',
      subjectId,
      status: 'skipped',
      dependencies: [],
      reason,
    })
    const summary = {
      ...RESULT.summary,
      skipped: 4,
      message: 'No work is scheduled: all 4 nodes are current.',
    }
    const noop: WorkflowResult = {
      ...RESULT,
      plan: {
        ...RESULT.plan,
        nodes: [
          node(
            'recon',
            'sub-001',
            'The current detector-backed receipt is reused.',
          ),
          node(
            'recon',
            'sub-002',
            'The current detector-backed receipt is reused.',
          ),
          node(
            'deface',
            'sub-001',
            'Optional defacing is off in project configuration.',
          ),
          node(
            'deface',
            'sub-002',
            'Optional defacing is off in project configuration.',
          ),
        ],
        summary,
      },
      summary,
    }
    const recovery: WorkflowResult = {
      ...noop,
      plan: {
        ...noop.plan,
        // A recovery records its own wording on the nodes of a stage that is
        // off; the configuration the plan was made with says the stage is off.
        nodes: noop.plan.nodes.map((entry) =>
          entry.stepKey === 'deface'
            ? {
                ...entry,
                reason:
                  'This work is outside the invalid source-node recovery closure, so it is not scheduled.',
              }
            : entry,
        ),
      },
    }
    mocks.app = appState({ dryRun: false, safeExecution: false })
    mocks.planWorkflow.mockResolvedValue(noop)
    mocks.resumeWorkflow.mockResolvedValue(recovery)
    const { result } = renderHook(() => useExecutionService())
    const stated =
      'No work is scheduled: 2 jobs are current and 2 belong to a stage that is off.'

    await expect(result.current.runAll()).resolves.toMatchObject({
      summary: { message: stated },
    })
    await expect(result.current.resume('run-source')).resolves.toMatchObject({
      summary: { message: stated },
    })
    const feedback = await settleAction(() => result.current.runAll())
    expect(feedback.setNotice).toHaveBeenLastCalledWith(stated)
    // The sidecar's own summary, which entered the plan digest, is unchanged.
    expect(noop.summary.message).toBe(
      'No work is scheduled: all 4 nodes are current.',
    )
    expect(mocks.inspect).not.toHaveBeenCalled()
  })

  it('clears the planning line while the plan is shown and holds launches again after approval', async () => {
    // Record the shared pending plan the way the app state does: a pending
    // callback publishes its plan and clears it only while it is current.
    let current: PendingPlan | null = null
    const events: string[] = []
    const trackPlan = (plan: PendingPlan) => (pending: boolean) => {
      events.push(`${pending ? 'hold' : 'release'} ${plan.label}`)
      if (pending) current = plan
      else if (current === plan) current = null
    }
    const planning: PendingPlan = {
      label: 'Planning and starting the workflow...',
      waitReason: 'Supraspina is planning the workflow.',
      card: null,
    }
    const line = vi.fn(trackPlan(planning))
    mocks.app = appState({ dryRun: false, safeExecution: true })
    current = planning
    mocks.authorize.mockImplementation(async () => {
      events.push(`authorize while ${current?.label ?? 'nothing'} holds`)
      return {
        token: 'live-token',
        projectId: PROJECT.projectId,
        configRevision: 3,
        purpose: 'live-workflow',
        planDigest: PLAN_DIGEST,
      }
    })
    mocks.review.mockImplementation(async () => {
      events.push(`review while ${current?.label ?? 'nothing'} holds`)
      return true
    })
    const hook = renderHook(() => useExecutionService())

    await expect(hook.result.current.runAll(undefined, line)).resolves.toBe(
      BOUND_RESULT,
    )

    // The launch releases and holds again only the line it published.
    expect(events).toEqual([
      'release Planning and starting the workflow...',
      'review while nothing holds',
      'hold Planning and starting the workflow...',
      'authorize while Planning and starting the workflow... holds',
      'release Planning and starting the workflow...',
    ])
    expect(line.mock.calls).toEqual([[false], [true], [false]])
    expect(current).toBeNull()

    // A read-only plan releases the line and holds nothing afterwards.
    events.length = 0
    line.mockClear()
    current = planning
    mocks.app = appState({ dryRun: false, safeExecution: false })
    hook.rerender()
    mocks.inspect.mockImplementation(async () => {
      events.push(`inspect while ${current?.label ?? 'nothing'} holds`)
    })
    await expect(
      hook.result.current.runAll(undefined, line),
    ).rejects.toBeInstanceOf(ExecutionCanceled)
    expect(events).toEqual([
      'release Planning and starting the workflow...',
      'inspect while nothing holds',
    ])
    expect(line.mock.calls).toEqual([[false]])
    expect(current).toBeNull()
  })

  it("leaves another launch's planning line in place for a launch without one", async () => {
    // The dock published its line and its plan is still being prepared; a
    // Logs retry, which publishes no line, reviews and starts its own plan.
    let current: PendingPlan | null = null
    const events: string[] = []
    const trackPlan = (plan: PendingPlan) => (pending: boolean) => {
      events.push(`${pending ? 'hold' : 'release'} ${plan.label}`)
      if (pending) current = plan
      else if (current === plan) current = null
    }
    const dock: PendingPlan = {
      label: 'Planning the workflow...',
      waitReason: 'Supraspina is planning the workflow.',
      card: null,
    }
    mocks.app = {
      ...appState({ dryRun: false, safeExecution: true }),
      pendingPlan: dock,
      trackPlan,
    }
    current = dock
    mocks.review.mockImplementation(async () => {
      events.push(`review while ${current?.label ?? 'nothing'} holds`)
      return true
    })
    mocks.authorize.mockImplementation(async () => ({
      token: 'live-token',
      projectId: PROJECT.projectId,
      configRevision: 3,
      purpose: 'live-workflow',
      planDigest: PLAN_DIGEST,
    }))
    const { result } = renderHook(() => useExecutionService())

    await expect(
      result.current.retry('run-failed', { nodeIds: ['node-1'] }),
    ).resolves.toBe(BOUND_RESULT)
    // Nothing released or held the dock's line, which stays until the dock's
    // own launch settles.
    expect(events).toEqual(['review while Planning the workflow... holds'])
    expect(current).toBe(dock)

    // A read-only plan of a launch without a line leaves it in place too.
    events.length = 0
    mocks.app = {
      ...appState({ dryRun: false, safeExecution: false }),
      pendingPlan: dock,
      trackPlan,
    }
    mocks.inspect.mockImplementation(async () => {
      events.push(`inspect while ${current?.label ?? 'nothing'} holds`)
    })
    const readOnly = renderHook(() => useExecutionService())
    await expect(
      readOnly.result.current.retry('run-failed', { nodeIds: ['node-1'] }),
    ).rejects.toBeInstanceOf(ExecutionCanceled)
    expect(events).toEqual(['inspect while Planning the workflow... holds'])
    expect(current).toBe(dock)
  })

  it('refuses destructive cleanup before planning while Allow live runs is off', async () => {
    mocks.app = appState({ dryRun: false, safeExecution: false })
    const { result } = renderHook(() => useExecutionService())

    // The refusal states the fact and the remedy in the words of the Clean
    // up card's disabled reason for the same state.
    await expect(
      result.current.retry('run-live', { cleanIncomplete: true }),
    ).rejects.toThrow(
      'Allow live runs is off. Turn it on in Execution controls to clean up.',
    )
    expect(SAFE_EXECUTION_OFF_CLEANUP).toBe(
      'Allow live runs is off. Turn it on in Execution controls to clean up.',
    )

    expect(mocks.retryWorkflow).not.toHaveBeenCalled()
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.authorize).not.toHaveBeenCalled()
  })

  it('states the live-work refusal as the fact and where to turn it on', () => {
    // The refusal guards authorization after an approved review, which any
    // launch surface reaches, so it names where Allow live runs is turned on
    // as the read-only review does.
    expect(SAFE_EXECUTION_OFF_LIVE_WORK).toBe(
      'Allow live runs is off. Turn it on in Runs > Execution controls or in Settings to start live work.',
    )
  })

  it('keeps the plan of every run it starts for Recent runs', async () => {
    // The plan is the only record of the subjects a plan-time blocked
    // reason belongs to, and the Runs outcome that held it is cleared by the
    // next plan, so each started run's plan goes to the shell.
    mocks.app = appState({ dryRun: true, safeExecution: false })
    const started = (runId: string): WorkflowResult => ({
      ...BOUND_RESULT,
      runId,
      disposition: 'started',
    })
    mocks.runWorkflow.mockResolvedValue(started('run-all'))
    mocks.resumeWorkflow.mockImplementation(
      async (request: { previewOnly?: boolean }) =>
        request.previewOnly ? BOUND_RESULT : started('run-resumed'),
    )
    mocks.retryWorkflow.mockImplementation(
      async (request: { previewOnly?: boolean }) =>
        request.previewOnly ? BOUND_RESULT : started('run-retried'),
    )
    const { result } = renderHook(() => useExecutionService())

    await result.current.runAll()
    await result.current.resume('run-preview')
    await result.current.retry('run-preview', { includeCancelled: true })

    expect(
      mocks.recordRunPlan.mock.calls.map(
        ([recorded]) => (recorded as WorkflowResult).runId,
      ),
    ).toEqual(['run-all', 'run-resumed', 'run-retried'])
  })

  it('releases the launch selection once a live run starts, and only then', async () => {
    // A selection kept after its launch would go into the next plan
    // unseen, so a live start hands it back to the full cohort.
    const target = { mode: 'explicit' as const, subjectIds: ['sub-001'] }
    const started: WorkflowResult = {
      ...BOUND_RESULT,
      runId: 'run-live',
      disposition: 'started',
    }
    mocks.authorize.mockResolvedValue({
      token: 'live-token',
      projectId: PROJECT.projectId,
      configRevision: 3,
      purpose: 'live-workflow',
      planDigest: PLAN_DIGEST,
    })
    mocks.runWorkflow.mockResolvedValue(started)
    mocks.app = appState({ dryRun: false, safeExecution: true, target })
    const hook = renderHook(() => useExecutionService())

    await hook.result.current.runAll()
    expect(mocks.releaseLaunchSelection).toHaveBeenCalledExactlyOnceWith([
      'sub-001',
    ])
    mocks.releaseLaunchSelection.mockClear()
    await hook.result.current.runStage('recon')
    expect(mocks.releaseLaunchSelection).toHaveBeenCalledExactlyOnceWith([
      'sub-001',
    ])
    mocks.releaseLaunchSelection.mockClear()

    // A declined review starts nothing and keeps the selection.
    mocks.review.mockResolvedValueOnce(false)
    await hook.result.current.runAll().catch(() => undefined)
    // A dry run rehearses the live run of the same scope.
    mocks.app = appState({ dryRun: true, target })
    hook.rerender()
    await hook.result.current.runAll()
    // The full cohort has no selection to release.
    mocks.app = appState({ dryRun: false, safeExecution: true })
    hook.rerender()
    await hook.result.current.runAll()
    expect(mocks.releaseLaunchSelection).not.toHaveBeenCalled()
  })

  it('keeps the plan of a started run whose project changed while it started', async () => {
    mocks.app = appState({ dryRun: true, safeExecution: false })
    let startRun!: (result: WorkflowResult) => void
    mocks.runWorkflow.mockImplementationOnce(
      () =>
        new Promise<WorkflowResult>((resolve) => {
          startRun = resolve
        }),
    )
    const hook = renderHook(() => useExecutionService())

    const launched = hook.result.current.runAll()
    await vi.waitFor(() => expect(mocks.runWorkflow).toHaveBeenCalledOnce())
    mocks.app = { ...appState({ dryRun: true }), configRevision: 4 }
    hook.rerender()
    startRun({ ...BOUND_RESULT, runId: 'run-moved', disposition: 'started' })

    await expect(launched).rejects.toThrow(/changed while preparing/)
    expect(mocks.recordRunPlan).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-moved' }),
    )
  })

  it('uses the same live grant for resume and a distinct cleanup grant for destructive retry', async () => {
    mocks.app = appState({ dryRun: false, safeExecution: true })
    mocks.authorize.mockImplementation(
      async (request: { purpose: ExecutionAuthorization['purpose'] }) => ({
        token: `${request.purpose}-token`,
        projectId: PROJECT.projectId,
        configRevision: 3,
        purpose: request.purpose,
        planDigest: PLAN_DIGEST,
      }),
    )
    const { result } = renderHook(() => useExecutionService())

    await result.current.resume('run-live')
    await result.current.retry('run-live', {
      nodeIds: ['node-2'],
      cleanIncomplete: true,
    })

    expect(mocks.authorize).toHaveBeenNthCalledWith(1, {
      project: PROJECT,
      configRevision: 3,
      purpose: 'live-workflow',
      planDigest: PLAN_DIGEST,
    })
    expect(mocks.authorize).toHaveBeenNthCalledWith(2, {
      project: PROJECT,
      configRevision: 3,
      purpose: 'cleanup',
      planDigest: PLAN_DIGEST,
    })
    expect(mocks.resumeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-live',
        liveExecutionAuthorization: expect.objectContaining({
          purpose: 'live-workflow',
        }),
      }),
    )
    expect(mocks.retryWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-live',
        nodeIds: ['node-2'],
        cleanIncomplete: true,
        liveExecutionAuthorization: expect.objectContaining({
          purpose: 'cleanup',
        }),
      }),
    )
  })

  it('refuses authorization when project authority changes during plan review', async () => {
    mocks.app = appState({ dryRun: false, safeExecution: true })
    let resolveReview!: (approved: boolean) => void
    mocks.review.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveReview = resolve
        }),
    )
    const hook = renderHook(() => useExecutionService())

    const pending = hook.result.current.runAll()
    await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledOnce())
    mocks.app = {
      ...appState({ dryRun: false, safeExecution: true }),
      configRevision: 4,
      configSha256: 'changed-sha',
    }
    hook.rerender()
    resolveReview(true)

    await expect(pending).rejects.toThrow(/changed while preparing this action/)
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })

  it('rejects disabled stages before validation and keeps cancellation available while dirty', async () => {
    const app = appState({ dryRun: false, safeExecution: true })
    app.cfg.steps.recon.enabled = false
    const degradedApp = {
      ...app,
      hostState: {
        ...app.hostState,
        sidecar: {
          ...app.hostState.sidecar,
          state: 'degraded' as const,
          projectAttached: false,
        },
      },
    }
    mocks.app = degradedApp
    mocks.cancelRun.mockResolvedValue({
      runId: 'run-1',
      accepted: false,
      terminal: true,
      pendingJobIds: [],
      message: 'already terminal',
    })
    const hook = renderHook(() => useExecutionService())

    await expect(hook.result.current.runStage('recon')).rejects.toThrow(
      /disabled/,
    )
    expect(mocks.validate).not.toHaveBeenCalled()
    mocks.app = { ...degradedApp, dirty: true }
    hook.rerender()
    await expect(hook.result.current.cancel('run-1')).resolves.toBeUndefined()
    expect(mocks.cancelRun).toHaveBeenCalledWith({
      project: PROJECT,
      runId: 'run-1',
    })
  })
})

const PENDING_QC_RESULT: WorkflowResult = {
  ...BOUND_RESULT,
  plan: {
    ...BOUND_RESULT.plan,
    selectionReconciliation: {
      sourceSubjectIds: ['sub-001', 'sub-002'],
      currentEligibleSubjectIds: ['sub-001'],
      retainedSubjectIds: ['sub-001'],
      addedSubjectIds: [],
      removedSubjectIds: ['sub-002'],
      deferredAndUnreviewedSubjectIds: ['sub-002'],
    },
  },
}

const ENTRY_POINTS: [
  string,
  (service: ExecutionService) => Promise<WorkflowResult>,
][] = [
  [
    'run',
    (service) => service.run({ kind: 'workflow', target: { mode: 'all' } }),
  ],
  ['runAll', (service) => service.runAll()],
  ['runStage', (service) => service.runStage('recon')],
  ['resume', (service) => service.resume('run-source')],
  [
    'retry',
    (service) => service.retry('run-source', { includeCancelled: true }),
  ],
  [
    'clean retry',
    (service) => service.retry('run-source', { cleanIncomplete: true }),
  ],
]

const RECOVERY_ENTRY_POINTS = ENTRY_POINTS.filter(([name]) =>
  ['resume', 'retry', 'clean retry'].includes(name),
)

/** Run one action through the shared feedback path and wait for it to end. */
async function settleAction(operation: () => Promise<WorkflowResult>) {
  const setFailure = vi.fn()
  const setNotice = vi.fn()
  const setResult = vi.fn()
  const setPending = vi.fn()
  runExecutionAction(
    operation,
    'Retry the action.',
    setFailure,
    setNotice,
    setResult,
    setPending,
  )
  await vi.waitFor(() => expect(setPending).toHaveBeenLastCalledWith(false))
  return { setFailure, setNotice, setResult }
}

function expectNeutralEnd(feedback: Awaited<ReturnType<typeof settleAction>>) {
  expect(
    feedback.setFailure.mock.calls.every(([value]) => value === null),
  ).toBe(true)
  expect(feedback.setNotice.mock.calls.every(([value]) => value === null)).toBe(
    true,
  )
  expect(feedback.setResult.mock.calls.every(([value]) => value === null)).toBe(
    true,
  )
}

describe('canceled workflow reviews', () => {
  beforeEach(() => {
    mocks.app = appState({ safeExecution: true })
  })

  it.each(ENTRY_POINTS)(
    'ends %s neutrally when the plan review is canceled',
    async (_name, start) => {
      mocks.review.mockResolvedValue(false)
      const { result } = renderHook(() => useExecutionService())

      await expect(start(result.current)).rejects.toBeInstanceOf(
        ExecutionCanceled,
      )
      expectNeutralEnd(await settleAction(() => start(result.current)))
      expect(mocks.authorize).not.toHaveBeenCalled()
      expect(mocks.runWorkflow).not.toHaveBeenCalled()
    },
  )

  it.each(RECOVERY_ENTRY_POINTS)(
    'ends %s neutrally when the recovery dialog is canceled',
    async (_name, start) => {
      mocks.resumeWorkflow.mockResolvedValue(PENDING_QC_RESULT)
      mocks.retryWorkflow.mockResolvedValue(PENDING_QC_RESULT)
      mocks.chooseRecovery.mockResolvedValue('cancel')
      const { result } = renderHook(() => useExecutionService())

      expectNeutralEnd(await settleAction(() => start(result.current)))
      expect(mocks.chooseRecovery).toHaveBeenCalledWith(['sub-002'], 1)
      expect(mocks.review).not.toHaveBeenCalled()
    },
  )

  it('ends neutrally when a project change cancels the open dialogs', async () => {
    const hook = renderHook(() => useExecutionService())
    const switchProject = (): void => {
      mocks.app = {
        ...appState({ safeExecution: true }),
        projectRef: { ...PROJECT, epoch: PROJECT.epoch + 1 },
      }
      hook.rerender()
    }
    mocks.review.mockImplementationOnce(async () => {
      switchProject()
      return false
    })
    expectNeutralEnd(await settleAction(() => hook.result.current.runAll()))

    mocks.app = appState({ safeExecution: true })
    hook.rerender()
    mocks.resumeWorkflow.mockResolvedValueOnce(PENDING_QC_RESULT)
    mocks.chooseRecovery.mockImplementationOnce(async () => {
      switchProject()
      return 'cancel'
    })
    expectNeutralEnd(
      await settleAction(() => hook.result.current.resume('run-source')),
    )
  })

  it('still reports a real failure through the same path', async () => {
    mocks.review.mockRejectedValue(new Error('Restore the review surface.'))
    const { result } = renderHook(() => useExecutionService())

    const feedback = await settleAction(() => result.current.runAll())

    expect(feedback.setFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Restore the review surface.',
        }),
      }),
    )
  })
})
