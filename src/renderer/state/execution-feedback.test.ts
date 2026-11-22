import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PROJECT_CONFIG,
  type ProjectConfig,
} from '../../shared/project-schema'
import type { WorkflowResult } from '../../shared/contract'
import { STEP_KEYS, type StepKey } from '../../shared/steps'
import type { Job } from '../../shared/types'
import { createMockApi, makeMockCohort } from '../ipc/mock'
import {
  CANCELLATION_REQUESTED_NOTICE,
  canceledRunNotice,
  planOutcomeText,
  qcScopeAcknowledgementHint,
  reviewNextSentence,
  runExecutionAction,
  safeExecutionNoticeState,
  stagePlanLine,
  stageScopeSentence,
  statesCanceledRun,
  canceledRunId,
  withoutNoWorkOutcome,
  withoutPlanOutcome,
  workflowScopeSentence,
} from './execution-feedback'

/** A plan result reduced to the fields the Runs feedback reads. */
function planResult(
  disposition: WorkflowResult['disposition'],
  message: string,
  nodes: WorkflowResult['plan']['nodes'] = [],
): WorkflowResult {
  return {
    runId: null,
    disposition,
    plan: { nodes },
    summary: { message },
  } as unknown as WorkflowResult
}

describe('stage plan page line', () => {
  it.each([
    [
      'No work is scheduled: the 1 job is current.',
      'ENIGMA QC: no work is scheduled; the 1 job is current.',
    ],
    ['No work is scheduled.', 'ENIGMA QC: no work is scheduled.'],
    [
      'Dry run only: planned 1 command and executed nothing',
      'ENIGMA QC: dry run only; planned 1 command and executed nothing',
    ],
    [
      'No work is scheduled: 1 job is blocked. Reconstruction failed, so this step did not run.',
      'ENIGMA QC: no work is scheduled; 1 job is blocked. Reconstruction failed, so this step did not run.',
    ],
    [
      'Resolve 1 blocked node. ENIGMA QC: wait for Reconstruction.',
      'ENIGMA QC: resolve 1 blocked node. ENIGMA QC: wait for Reconstruction.',
    ],
    ['QC Fail rows stay excluded.', 'ENIGMA QC: QC Fail rows stay excluded.'],
  ] as const)('names the stage before "%s"', (message, line) => {
    expect(stagePlanLine('ENIGMA QC', message)).toBe(line)
  })
})

describe('plan outcome text', () => {
  const blocked =
    'Resolve 2 blocked nodes. Reconstruction failed, so this step did not run. 1 more reason applies.'
  const stated =
    'No work is scheduled: 2 jobs are blocked. Reconstruction failed, so this step did not run. 1 more reason applies.'

  it('states a pass in which nothing runs as a fact and keeps the result', () => {
    const result = planResult('blocked', blocked)
    expect(planOutcomeText(result)).toBe(stated)
    // The plan's digest covers the summary, so the result keeps its text.
    expect(result.summary.message).toBe(blocked)
  })

  it('counts the work of a plan in which everything is current in jobs', () => {
    expect(
      planOutcomeText(
        planResult('noop', 'No work is scheduled: all 288 nodes are current.'),
      ),
    ).toBe('No work is scheduled: all 288 jobs are current.')
  })

  it('reads any other outcome as written', () => {
    const message = 'Dry run only: planned 2 commands and executed nothing.'
    expect(planOutcomeText(planResult('noop', message))).toBe(message)
  })

  it('names the subjects of a blocked reason from the plan nodes', () => {
    // The sidecar's blocker names no subject, so the stage line takes the
    // subjects from the blocked plan nodes.
    const conflict =
      'Choose a fresh derivatives namespace because detector-complete Reconstruction output has no matching current receipt; preserve the existing tree.'
    const nodes: WorkflowResult['plan']['nodes'] = [
      {
        nodeId: 'recon:sub-901',
        stepKey: 'recon',
        scope: 'subject',
        subjectId: 'sub-901',
        status: 'planned',
        dependencies: [],
        reason: 'No earlier run left a receipt for it.',
      },
      {
        nodeId: 'recon:sub-902',
        stepKey: 'recon',
        scope: 'subject',
        subjectId: 'sub-902',
        status: 'blocked',
        dependencies: [],
        reason: conflict,
      },
    ]
    const message = `Resolve 1 blocked node. ${conflict}`
    const result = planResult('blocked', message, nodes)
    const text = planOutcomeText(result)
    expect(text).toBe(
      `No work is scheduled: 1 job is blocked. Reconstruction for sub-902: ${conflict}`,
    )
    expect(stagePlanLine('Reconstruction', text)).toBe(
      `Reconstruction: no work is scheduled; 1 job is blocked. Reconstruction for sub-902: ${conflict}`,
    )
    expect(result.summary.message).toBe(message)
  })

  it('sets the notice to the outcome text and the result as returned', async () => {
    const result = planResult('blocked', blocked)
    const setFailure = vi.fn()
    const setNotice = vi.fn()
    const setResult = vi.fn()
    runExecutionAction(
      () => Promise.resolve(result),
      'Retry the workflow.',
      setFailure,
      setNotice,
      setResult,
    )
    await vi.waitFor(() => expect(setResult).toHaveBeenLastCalledWith(result))
    expect(setNotice).toHaveBeenLastCalledWith(stated)
    expect(setFailure).toHaveBeenLastCalledWith(null)
  })
})

describe('run-start outcome text', () => {
  /** Plan nodes of one stage: `runnable` to run, then one current node. */
  function stageNodes(runnable: number): WorkflowResult['plan']['nodes'] {
    const nodes: WorkflowResult['plan']['nodes'] = Array.from(
      { length: runnable },
      (_, index) => ({
        nodeId: `recon:sub-${index + 1}`,
        stepKey: 'recon',
        scope: 'subject',
        subjectId: `sub-${index + 1}`,
        status: index === 0 ? 'planned' : 'waiting',
        dependencies: [],
      }),
    )
    nodes.push({
      nodeId: 'recon:sub-current',
      stepKey: 'recon',
      scope: 'subject',
      subjectId: 'sub-current',
      status: 'skipped',
      dependencies: [],
      reason: 'Its current receipt is reused.',
    })
    return nodes
  }

  /** The sidecar's start summary (workflow_manager.py `run`). */
  function startedMessage(runId: string, queued: number): string {
    return `Started run ${runId}: ${queued} job${queued === 1 ? '' : 's'} queued. Watch In flight here and the output in Logs.`
  }

  // The sidecar counts the nodes still planned or waiting after it wakes
  // the scheduler, so that count understates the jobs a run started.
  it.each([
    [
      0,
      1,
      'Run run-d9a0cce08613 started with 1 job; In flight and Logs show its progress.',
    ],
    [
      1,
      2,
      'Run run-d9a0cce08613 started with 2 jobs; In flight and Logs show their progress.',
    ],
    [
      5,
      6,
      'Run run-d9a0cce08613 started with 6 jobs; In flight and Logs show their progress.',
    ],
  ] as const)(
    'states a start that counted %i queued by the %i jobs of the approved plan',
    (queued, runnable, fact) => {
      const message = startedMessage('run-d9a0cce08613', queued)
      const result = planResult('started', message, stageNodes(runnable))
      expect(planOutcomeText(result)).toBe(fact)
      // The result keeps the summary as the sidecar wrote it.
      expect(result.summary.message).toBe(message)
    },
  )

  it('names the stage on the Runs line of a stage launch', () => {
    const result = planResult(
      'started',
      startedMessage('run-af76d30e46dd', 5),
      stageNodes(6),
    )
    expect(stagePlanLine('Reconstruction', planOutcomeText(result))).toBe(
      'Reconstruction: run run-af76d30e46dd started with 6 jobs; In flight and Logs show their progress.',
    )
  })

  it('reads any other start text, or a plan with nothing to run, as written', () => {
    for (const message of [
      'Started run run-1: 3 jobs queued.',
      'Started run run-1: 3 jobs queued. Watch In flight here and the output in Logs. 1 more reason applies.',
      ' Started run run-1: 3 jobs queued. Watch In flight here and the output in Logs.',
      'Started run run-1: three jobs queued. Watch In flight here and the output in Logs.',
    ]) {
      expect(
        planOutcomeText(planResult('started', message, stageNodes(3))),
      ).toBe(message)
    }
    // Without a runnable node the plan does not say how many jobs started.
    const message = startedMessage('run-1', 0)
    expect(planOutcomeText(planResult('started', message, stageNodes(0)))).toBe(
      message,
    )
  })

  it('states the start of a mock run by its jobs', async () => {
    const subjects = makeMockCohort(2, 101).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = createMockApi(subjects)
    const request = {
      project: {
        projectId: 'run-start',
        root: '/data/run-start',
        configPath: '/data/run-start/supraspina.project.json',
        epoch: 1,
      },
      cfg: {
        ...DEFAULT_PROJECT_CONFIG,
        runtime: { ...DEFAULT_PROJECT_CONFIG.runtime, dryRun: false },
      },
      configRevision: 0,
      acknowledgements: {
        includeDeferredAndUnreviewedQc: false,
        acknowledgeMemoryAdvisory: false,
      },
      intent: {
        kind: 'stage' as const,
        stepKey: 'recon' as const,
        target: { mode: 'all' as const },
      },
    }
    const plan = await api.pipeline.planWorkflow(request)
    const started = await api.pipeline.runWorkflow({
      ...request,
      approvedPlan: {
        planId: plan.plan.planId,
        digest: plan.plan.digest ?? '',
      },
    })

    expect(started.disposition).toBe('started')
    expect(planOutcomeText(started)).toBe(
      `Run ${started.runId} started with 2 jobs; In flight and Logs show their progress.`,
    )
  })
})

describe('zero-node plan outcome text', () => {
  // The sidecar's summary of a plan with no nodes is worded as an order.
  // The summary enters the plan digest, so it is restated for display and
  // the result keeps it.
  it.each([
    [
      'Keep the explicit empty workflow target as a no-op.',
      'No work is scheduled: the selection is empty.',
    ],
    [
      'Review plan totals: planned 0; waiting 0; blocked 0; skipped 0.',
      'No work is scheduled: the plan has no jobs.',
    ],
  ] as const)('states "%s" as a fact', (message, fact) => {
    const result = planResult('noop', message)
    expect(planOutcomeText(result)).toBe(fact)
    expect(result.summary.message).toBe(message)
  })

  it.each([
    'Review plan totals: planned 2; waiting 0; blocked 0; skipped 0.',
    'Keep the explicit empty workflow target as a no-op. 1 more reason applies.',
    ' Keep the explicit empty workflow target as a no-op.',
  ])('reads "%s" as written, matching only the exact text', (message) => {
    expect(planOutcomeText(planResult('noop', message))).toBe(message)
  })

  it('states the zero-node plans of an empty selection as facts', async () => {
    const subjects = makeMockCohort(2, 101).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = createMockApi(subjects)
    const request = {
      project: {
        projectId: 'zero-node',
        root: '/data/zero-node',
        configPath: '/data/zero-node/supraspina.project.json',
        epoch: 1,
      },
      cfg: DEFAULT_PROJECT_CONFIG,
      configRevision: 0,
      acknowledgements: {
        includeDeferredAndUnreviewedQc: false,
        acknowledgeMemoryAdvisory: false,
      },
    }
    const workflow = await api.pipeline.planWorkflow({
      ...request,
      intent: {
        kind: 'workflow',
        target: { mode: 'explicit', subjectIds: [] },
      },
    })
    const stage = await api.pipeline.planWorkflow({
      ...request,
      intent: {
        kind: 'stage',
        stepKey: 'recon',
        target: { mode: 'explicit', subjectIds: [] },
      },
    })

    expect(workflow.disposition).toBe('noop')
    expect(planOutcomeText(workflow)).toBe(
      'No work is scheduled: the selection is empty.',
    )
    expect(stage.disposition).toBe('noop')
    expect(stagePlanLine('Reconstruction', planOutcomeText(stage))).toBe(
      'Reconstruction: no work is scheduled; the plan has no jobs.',
    )
  })
})

describe('Runs plan outcome clearing', () => {
  const card = { stepKey: 'enigma' as const }

  it('drops a no-work outcome and its card copy, and keeps an error', () => {
    const message = 'No work is scheduled: the 1 node is current.'
    // The card holds the outcome as its notice states it.
    const stated = 'No work is scheduled: the 1 job is current.'
    const error = {
      error: new Error('Retry stopping the run.'),
      reviewAgain: null,
    }
    expect(
      withoutNoWorkOutcome({
        error,
        notice: stagePlanLine('ENIGMA QC', stated),
        outcome: planResult('noop', message),
        stageOutcome: { ...card, message: stated },
      }),
    ).toEqual({ error, notice: null, outcome: null, stageOutcome: null })
  })

  it('keeps a blocked outcome for Dismiss or a later plan', () => {
    // The card holds the outcome as its notice states it.
    const feedback = {
      error: null,
      notice: 'ENIGMA QC: no work is scheduled; 1 job is blocked.',
      outcome: planResult('blocked', 'Resolve 1 blocked node.'),
      stageOutcome: {
        ...card,
        message: 'No work is scheduled: 1 job is blocked.',
      },
    }
    expect(withoutNoWorkOutcome(feedback)).toBe(feedback)
    expect(withoutPlanOutcome(feedback)).toEqual({
      error: null,
      notice: null,
      outcome: null,
      stageOutcome: null,
    })
  })

  it('keeps a card refusal that is not the outcome', () => {
    const refusal = {
      ...card,
      message: 'Save the project before starting a run.',
    }
    expect(
      withoutPlanOutcome({
        error: null,
        notice: 'No work is scheduled.',
        outcome: planResult('noop', 'No work is scheduled.'),
        stageOutcome: refusal,
      }).stageOutcome,
    ).toBe(refusal)
  })
})

/** The default stage configuration with only `enabled` stages switched on. */
function stepsWith(enabled: readonly StepKey[]): ProjectConfig['steps'] {
  const steps = { ...DEFAULT_PROJECT_CONFIG.steps }
  for (const key of STEP_KEYS) {
    const step = steps[key]
    if (step) steps[key] = { ...step, enabled: enabled.includes(key) }
  }
  return steps
}

describe('launch scope sentence', () => {
  it('names the enabled per-subject stages by display name only', () => {
    // Optional defacing is off by default, so the sentence leaves it out.
    expect(
      workflowScopeSentence(DEFAULT_PROJECT_CONFIG.steps, { mode: 'all' }, 82),
    ).toBe(
      'Brain FOV preparation and Reconstruction run for all 82 subjects in the analysis cohort; cohort-wide stages run once after them.',
    )
  })

  it('names Optional defacing once it is on, and a selection by its size', () => {
    expect(
      workflowScopeSentence(
        stepsWith(['brainfov', 'deface', 'recon', 'enigma']),
        { mode: 'explicit', subjectIds: ['sub-001', 'sub-002', 'sub-003'] },
        82,
      ),
    ).toBe(
      'Brain FOV preparation, Optional defacing, and Reconstruction run for the 3 selected subjects; cohort-wide stages run once after them.',
    )
  })

  it.each([
    [
      'one per-subject stage',
      ['recon', 'enigma'],
      'Reconstruction runs for the 1 subject in the analysis cohort; cohort-wide stages run once after them.',
    ],
    [
      'no cohort-wide stage',
      ['recon'],
      'Reconstruction runs for the 1 subject in the analysis cohort.',
    ],
    [
      'no per-subject stage',
      ['enigma'],
      'Each enabled cohort-wide stage runs once over the analysis cohort.',
    ],
    ['no stage', [], 'No stage is enabled, so the plan has nothing to run.'],
  ] as const)('states the scope with %s', (_case, enabled, sentence) => {
    expect(workflowScopeSentence(stepsWith(enabled), { mode: 'all' }, 1)).toBe(
      sentence,
    )
  })

  it('states a stage launch by the stage name and its scope', () => {
    const selection = { mode: 'explicit' as const, subjectIds: ['sub-001'] }
    expect(stageScopeSentence('enigma', selection, 82)).toBe(
      'ENIGMA QC runs once over the full analysis cohort.',
    )
    expect(stageScopeSentence('recon', selection, 82)).toBe(
      'Reconstruction runs for the 1 selected subject.',
    )
    expect(stageScopeSentence('brainfov', { mode: 'all' }, 82)).toBe(
      'Brain FOV preparation runs for all 82 subjects in the analysis cohort.',
    )
  })
})

describe('launch confirmation sentence', () => {
  it.each([
    [
      'Dry run',
      true,
      false,
      'If anything would run, the plan opens for review. Dry run is on, so nothing executes.',
    ],
    [
      'Allow live runs on',
      false,
      true,
      'If anything would run, the plan opens for review; nothing starts until you authorize it.',
    ],
    [
      'Allow live runs off',
      false,
      false,
      'If anything would run, the plan opens read-only, because Allow live runs is off.',
    ],
  ] as const)(
    'promises a review only for a plan with work, with %s',
    (_mode, dryRun, safeExecution, sentence) => {
      // A plan with nothing to run reports its outcome without a review.
      expect(reviewNextSentence(dryRun, safeExecution)).toBe(sentence)
    },
  )
})

describe('QC scope acknowledgement hint', () => {
  it.each([
    [
      'Defer and unreviewed rows',
      { defer: 14, unreviewed: 7 },
      '14 Defer and 7 unreviewed subjects are in the analysis cohort. Check the box to continue.',
    ],
    [
      'unreviewed rows only',
      { defer: 0, unreviewed: 9 },
      '9 unreviewed subjects are in the analysis cohort. Check the box to continue.',
    ],
    [
      'one Defer row',
      { defer: 1, unreviewed: 0 },
      '1 Defer subject is in the analysis cohort. Check the box to continue.',
    ],
  ] as const)('states the rows for %s', (_case, rows, hint) => {
    expect(qcScopeAcknowledgementHint(rows)).toBe(hint)
  })
})

describe('launch Allow live runs notice', () => {
  it.each([
    ['a dry run', true, false, true, null],
    ['Allow live runs off', false, false, false, 'off'],
    ['Allow live runs on and unsaved', false, true, true, 'unsaved'],
    ['Allow live runs on and saved', false, true, false, null],
  ] as const)(
    'returns the notice for %s',
    (_case, dryRun, safeExecution, dirty, state) => {
      expect(safeExecutionNoticeState(dryRun, safeExecution, dirty)).toBe(state)
    },
  )
})

describe('canceled run notice', () => {
  /** One job of a run, reduced to the fields the notice reads. */
  function job(runId: string, status: Job['status']): Job {
    return { id: `${runId}:${status}`, runId, status } as Job
  }

  it('states the canceled run and how its jobs ended', () => {
    // A run in which sub-101 finished and the hung sub-901 job was
    // canceled.
    expect(
      canceledRunNotice('run-19ac40eacf50', [
        job('run-19ac40eacf50', 'done'),
        job('run-19ac40eacf50', 'cancelled'),
        job('run-older', 'failed'),
      ]),
    ).toBe('Run run-19ac40eacf50 was canceled: 1 job finished, 1 canceled.')
  })

  it('names the first outcome with the job noun and counts the rest', () => {
    expect(
      canceledRunNotice('run-1', [
        job('run-1', 'cancelled'),
        job('run-1', 'cancelled'),
        job('run-1', 'cancelled'),
        job('run-1', 'persistence-error'),
        job('run-1', 'blocked'),
        job('run-1', 'stale'),
      ]),
    ).toBe(
      'Run run-1 was canceled: 3 jobs canceled, 1 failed, 1 did not run, 1 with an unknown status.',
    )
  })

  it('states a cancellation that came before any job', () => {
    expect(canceledRunNotice('run-1', [])).toBe(
      'Run run-1 was canceled before any job started.',
    )
  })

  it('recognizes a notice that states a canceled run, alone or after another run', () => {
    expect(statesCanceledRun(canceledRunNotice('run-1', []))).toBe(true)
    expect(
      statesCanceledRun(
        `Run run-2 finished. ${canceledRunNotice('run-1', [job('run-1', 'cancelled')])}`,
      ),
    ).toBe(true)
    expect(statesCanceledRun('Run run-1 finished.')).toBe(false)
    expect(statesCanceledRun(CANCELLATION_REQUESTED_NOTICE)).toBe(false)
  })

  it('reads the run a canceled-run notice names, for its Open Logs', () => {
    expect(canceledRunId(canceledRunNotice('run-1', []))).toBe('run-1')
    // A notice that names another run first still hands over the canceled
    // one.
    expect(
      canceledRunId(
        `Run run-2 finished. ${canceledRunNotice('run-1', [job('run-1', 'cancelled')])}`,
      ),
    ).toBe('run-1')
    expect(canceledRunId('Run run-1 finished.')).toBeNull()
  })
})
