import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowNode, WorkflowPlan } from '../../shared/contract'
import { THEMES } from '../theme/tokens'
import { WorkflowReviewProvider } from './workflow-review'
import { useWorkflowReview } from './workflow-review-state'

const appState = vi.hoisted(() => ({
  projectEpoch: 3,
  // The stages the project configuration turns off; every other stage is on.
  offSteps: [] as string[],
}))

vi.mock('./context', () => ({
  useApp: () => ({
    t: THEMES.dark,
    projectEpoch: appState.projectEpoch,
    cfg: {
      runtime: { dryRun: false },
      steps: new Proxy(
        {},
        {
          get: (_target, key) => ({
            enabled: !appState.offSteps.includes(String(key)),
          }),
        },
      ),
    },
  }),
}))

const PLAN: WorkflowPlan = {
  planId: 'run-abcdef123456',
  digest: 'a'.repeat(64),
  configDigest: 'b'.repeat(64),
  qcDigest: 'c'.repeat(64),
  registryDigest: 'd'.repeat(64),
  environmentDigest: 'e'.repeat(64),
  analysisCohort: {
    subjectIds: ['sub-001', 'sub-002'],
    sha256: 'analysis',
  },
  selectedSubset: { subjectIds: ['sub-001'], sha256: 'selected' },
  exclusions: {
    qcFailedSubjectIds: ['sub-003'],
    configExcludedSubjectIds: ['sub-004'],
  },
  selectionReconciliation: {
    sourceSubjectIds: ['sub-001', 'sub-005'],
    currentEligibleSubjectIds: ['sub-001', 'sub-006'],
    retainedSubjectIds: ['sub-001'],
    addedSubjectIds: ['sub-006'],
    removedSubjectIds: ['sub-005'],
  },
  resources: {
    queueSize: 2,
    availableMemoryGB: 8.25,
    memoryWarningGB: 10,
    lowMemory: true,
  },
  nodes: [
    {
      nodeId: '000-recon-sub-001',
      stepKey: 'recon',
      scope: 'subject',
      subjectId: 'sub-001',
      status: 'planned',
      dependencies: [],
      reason: 'No earlier run left a receipt for it.',
      command: 'recon-all -subject sub-001',
    },
  ],
  blockers: [
    {
      key: 'brainpad',
      reason: 'Restore the Brain-PAD environment.',
      kind: 'environment',
    },
  ],
  summary: {
    planned: 1,
    started: 0,
    waiting: 0,
    blocked: 1,
    skipped: 0,
    message: 'Review the ready plan.',
  },
}

function Probe({
  onResult,
  plan = PLAN,
}: {
  onResult: (approved: boolean | Error) => void
  plan?: WorkflowPlan
}): ReactNode {
  const review = useWorkflowReview()
  return (
    <button
      type="button"
      onClick={() => {
        void review
          .review(plan, 'resume')
          .then(onResult)
          .catch((cause: unknown) =>
            onResult(cause instanceof Error ? cause : new Error('failed')),
          )
      }}
    >
      Review
    </button>
  )
}

/** Open the plan read-only, as the execution service does while Allow live runs is off. */
function InspectProbe({
  onClosed,
  plan = PLAN,
  kind = 'run',
  relaunchLabel = 'Review plan',
}: {
  onClosed: (result: unknown) => void
  plan?: WorkflowPlan
  kind?: 'run' | 'resume' | 'retry'
  /** The action that starts the flow again, or null when none is known. */
  relaunchLabel?: string | null
}): ReactNode {
  const review = useWorkflowReview()
  return (
    <button
      type="button"
      onClick={() => {
        void review
          .inspect(plan, kind, 'safe-execution-off', relaunchLabel ?? undefined)
          .then(onClosed)
      }}
    >
      Inspect
    </button>
  )
}

const READ_ONLY_FOOTNOTE =
  'Authorize this plan is unavailable because Allow live runs is off. To run this plan, turn on Allow live runs in Runs > Execution controls or in Settings, save the project, then choose Review plan again.'

describe('authoritative workflow review', () => {
  it('shows exact scope, exclusions, reconciliation, effects and resources', async () => {
    const onResult = vi.fn()
    render(
      <WorkflowReviewProvider>
        <Probe onResult={onResult} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(
      screen.getByRole('dialog', { name: 'Review the exact resume plan.' }),
    ).toBeInTheDocument()
    // Counts take the singular or plural, never "subject(s)".
    expect(screen.getByText('Analysis cohort: 2 subjects')).toBeVisible()
    expect(
      screen.getByText('Selected execution subset: 1 subject'),
    ).toBeVisible()
    expect(screen.queryByText(/subject\(s\)/)).toBeNull()
    expect(screen.getByText(/QC Fail: sub-003/)).toBeVisible()
    expect(screen.getByText(/Newly eligible, not added: sub-006/)).toBeVisible()
    const effects = screen.getByRole('region', { name: 'Effects' })
    expect(effects).toHaveTextContent(
      'Reconstruction for sub-001: No earlier run left a receipt for it.',
    )
    // The command stays reachable behind the entry.
    const command = within(effects).getByText('recon-all -subject sub-001')
    expect(command).not.toBeVisible()
    fireEvent.click(within(effects).getByText(/^for sub-001:/))
    expect(command).toBeVisible()
    expect(screen.getByText(/Brain-PAD environment/)).toBeVisible()
    expect(screen.getByText(/Available memory: 8.3 GB/)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
  })

  it('refuses a plan without resources and states the fallback as a fact', async () => {
    const withoutResources: WorkflowPlan = { ...PLAN }
    delete withoutResources.resources
    const refused = vi.fn()
    const { unmount } = render(
      <WorkflowReviewProvider>
        <Probe onResult={refused} plan={withoutResources} />
      </WorkflowReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() =>
      expect(refused).toHaveBeenCalledWith(
        new Error('Request a bound plan before executing.'),
      ),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    unmount()

    // The guard above makes the review's no-resources line defensive. A
    // plan whose resources pass the guard and then read as absent reaches it.
    let reads = 0
    const vanishing: WorkflowPlan = { ...withoutResources }
    Object.defineProperty(vanishing, 'resources', {
      enumerable: true,
      get: () => (reads++ === 0 ? PLAN.resources : undefined),
    })
    render(
      <WorkflowReviewProvider>
        <Probe onResult={vi.fn()} plan={vanishing} />
      </WorkflowReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const resources = screen.getByRole('region', {
      name: 'Resources and environment',
    })
    expect(resources).toHaveTextContent(
      'The plan records no environment evidence.',
    )
    expect(resources).not.toHaveTextContent(/Provide environment evidence/)
  })

  it('states which subjects a stage with units computes and which it reuses', () => {
    const enigma: WorkflowNode = {
      nodeId: '090-enigma-cohort',
      stepKey: 'enigma',
      scope: 'cohort',
      subjectId: null,
      status: 'planned',
      dependencies: [],
      reason: 'The analysis cohort changed after it last ran.',
      command: 'bash enigma_fs_wrapper_script_compiled.sh',
    }
    render(
      <WorkflowReviewProvider>
        <Probe
          onResult={vi.fn()}
          plan={{
            ...PLAN,
            nodes: [...PLAN.nodes, enigma],
            unitReuse: [
              {
                nodeId: enigma.nodeId,
                stepKey: 'enigma',
                computedSubjectIds: ['sub-009', 'sub-010'],
                reusedSubjectIds: ['sub-001', 'sub-002'],
                sourceRunIds: ['run-8407b948c62b'],
              },
            ],
          }}
        />
      </WorkflowReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    const fact = screen.getByTestId('unit-reuse-fact')
    expect(fact).toHaveTextContent(
      'Computes 2 subjects and reuses the verified output of 2 subjects from run-8407b948c62b.',
    )
    expect(within(fact).getByText('Show the 2 computed subjects')).toBeVisible()
    expect(fact).toHaveTextContent('sub-009, sub-010')
    expect(screen.getAllByTestId('unit-reuse-fact')).toHaveLength(1)
  })

  it('lists the plan warnings once each and omits the section without any', () => {
    const advisory =
      'Brain-PAD statistics pool all sites; site Ingenia has no controls.'
    const braincharts =
      'BrainCharts adapts the model to 1 of 2 sites. Site Ingenia has no controls, so its 6 subjects get no z-scores.'
    const { unmount } = render(
      <WorkflowReviewProvider>
        <Probe
          onResult={vi.fn()}
          plan={{ ...PLAN, advisories: [advisory, braincharts, advisory] }}
        />
      </WorkflowReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const warnings = screen.getByRole('region', { name: 'Warnings' })
    expect(warnings).toHaveTextContent(
      'These facts block nothing; the plan runs as listed.',
    )
    expect(
      within(warnings)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([advisory, braincharts])
    unmount()

    for (const plan of [PLAN, { ...PLAN, advisories: [] }]) {
      const view = render(
        <WorkflowReviewProvider>
          <Probe onResult={vi.fn()} plan={plan} />
        </WorkflowReviewProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Review' }))
      expect(screen.queryByRole('region', { name: 'Warnings' })).toBeNull()
      view.unmount()
    }
  })

  it('names each runnable stage with its reason and summarizes the skipped stages', () => {
    const subjectIds = Array.from(
      { length: 82 },
      (_, index) => `sub-${String(index + 1).padStart(3, '0')}`,
    )
    const perSubject = (
      stepKey: 'brainfov' | 'deface' | 'recon',
      reason: string,
    ): WorkflowPlan['nodes'] =>
      subjectIds.map((subjectId) => ({
        nodeId: `${stepKey}-${subjectId}`,
        stepKey,
        scope: 'subject' as const,
        subjectId,
        status: 'skipped' as const,
        dependencies: [],
        reason,
      }))
    const cohortStage = (
      stepKey: 'enigma' | 'outliers',
      reason: string,
    ): WorkflowPlan['nodes'][number] => ({
      nodeId: `${stepKey}-cohort`,
      stepKey,
      scope: 'cohort',
      subjectId: null,
      status: 'waiting',
      dependencies: [],
      reason,
      command: `run ${stepKey} for the cohort`,
    })
    const reused = 'The current detector-backed receipt is reused.'
    const cohortChanged = 'The analysis cohort changed after it last ran.'
    const plan: WorkflowPlan = {
      ...PLAN,
      analysisCohort: { subjectIds, sha256: 'analysis-82' },
      selectedSubset: { subjectIds, sha256: 'selected-82' },
      exclusions: { qcFailedSubjectIds: [], configExcludedSubjectIds: [] },
      nodes: [
        ...perSubject('brainfov', reused),
        ...perSubject(
          'deface',
          'Optional defacing is off in project configuration.',
        ),
        ...perSubject('recon', reused),
        cohortStage('enigma', cohortChanged),
        cohortStage('outliers', cohortChanged),
      ],
      blockers: [],
    }
    render(
      <WorkflowReviewProvider>
        <InspectProbe onClosed={vi.fn()} plan={plan} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the exact workflow plan.',
    })
    expect(dialog).toHaveTextContent('2 of its 248 jobs would run.')

    // One entry per stage under its display name with the planner's reason;
    // the commands stay behind each entry.
    const effects = within(dialog).getByRole('region', { name: 'Effects' })
    expect(
      [...effects.querySelectorAll('summary')].map(
        (summary) => summary.textContent,
      ),
    ).toEqual([
      `ENIGMA QC for the cohort: ${cohortChanged}`,
      `Histogram and outlier review for the cohort: ${cohortChanged}`,
    ])
    expect(
      within(effects).getByText('run enigma for the cohort'),
    ).not.toBeVisible()

    // The skipped nodes read as a summary by reason, not one line per node.
    const skipped = within(dialog).getByRole('region', { name: 'Skipped' })
    expect(
      within(skipped)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      `Brain FOV preparation for 82 subjects and Reconstruction for 82 subjects: ${reused}`,
      'Optional defacing for 82 subjects: Off in project configuration.',
    ])

    // The subject list stays reachable behind its disclosure.
    const subjects = within(dialog).getByText(/^sub-001, sub-002, /)
    expect(subjects).not.toBeVisible()
    fireEvent.click(within(dialog).getByText('Show all 82 selected subjects'))
    expect(subjects).toBeVisible()
  })

  it('says a stage is off in a recovery plan and names the rest as outside the recovery', () => {
    const subjectIds = ['sub-101', 'sub-901', 'sub-902', 'sub-906']
    const outside =
      'This work is outside the invalid source-node recovery closure, so it is not scheduled.'
    const kept =
      'The current detector-backed success from the source run is kept.'
    const perSubject = (
      stepKey: 'brainfov' | 'deface' | 'recon',
      reason: string,
    ): WorkflowPlan['nodes'] =>
      subjectIds.map((subjectId) => ({
        nodeId: `${stepKey}-${subjectId}`,
        stepKey,
        scope: 'subject' as const,
        subjectId,
        status: 'skipped' as const,
        dependencies: [],
        reason,
      }))
    const cohortStage = (
      stepKey: 'enigma' | 'pybrainage' | 'features',
      status: 'skipped' | 'planned',
      reason: string,
    ): WorkflowPlan['nodes'][number] => ({
      nodeId: `${stepKey}-cohort`,
      stepKey,
      scope: 'cohort',
      subjectId: null,
      status,
      dependencies: [],
      reason,
    })
    const plan: WorkflowPlan = {
      ...PLAN,
      nodes: [
        // A Resume or Retry plan records its recovery wording on the nodes
        // of the stages that are off before the closure, as the sidecar does.
        ...perSubject('brainfov', outside),
        ...perSubject('deface', outside),
        ...perSubject('recon', kept),
        cohortStage('enigma', 'skipped', outside),
        cohortStage(
          'pybrainage',
          'skipped',
          'PyBrainAge prediction is off in project configuration.',
        ),
        cohortStage('features', 'planned', 'It is selected for retry.'),
      ],
      blockers: [],
    }
    appState.offSteps = ['brainfov', 'deface', 'pybrainage']
    try {
      render(
        <WorkflowReviewProvider>
          <InspectProbe onClosed={vi.fn()} plan={plan} />
        </WorkflowReviewProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
      const skipped = within(
        screen.getByRole('dialog', { name: 'Review the exact workflow plan.' }),
      ).getByRole('region', { name: 'Skipped' })
      expect(
        within(skipped)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        'Brain FOV preparation for 4 subjects, Optional defacing for 4 subjects, and PyBrainAge prediction for the cohort: Off in project configuration.',
        `Reconstruction for 4 subjects: ${kept}`,
        'ENIGMA QC for the cohort: Not part of this recovery.',
      ])
      expect(skipped).not.toHaveTextContent(/closure/)
    } finally {
      appState.offSteps = []
    }
  })

  it('lists each subject and command of a many-subject stage behind one entry', () => {
    const plan: WorkflowPlan = {
      ...PLAN,
      nodes: ['sub-001', 'sub-002', 'sub-003'].map((subjectId, index) => ({
        nodeId: `recon-${subjectId}`,
        stepKey: 'recon' as const,
        scope: 'subject' as const,
        subjectId,
        status: 'planned' as const,
        dependencies: [],
        ...(index < 2
          ? { reason: 'No earlier run left a receipt for it.' }
          : {}),
        command: `recon-all -subject ${subjectId}`,
      })),
      blockers: [],
    }
    render(
      <WorkflowReviewProvider>
        <Probe onResult={vi.fn()} plan={plan} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const effects = screen.getByRole('region', { name: 'Effects' })
    // A node without a planner reason still says why it runs.
    expect(
      [...effects.querySelectorAll('summary')].map(
        (summary) => summary.textContent,
      ),
    ).toEqual([
      'Reconstruction for 2 subjects: No earlier run left a receipt for it.',
      'Reconstruction for sub-003: No current receipt covers it.',
    ])
    fireEvent.click(within(effects).getByText(/^for 2 subjects:/))
    const [commands] = within(effects).getAllByRole('list', {
      name: 'Commands for Reconstruction',
    })
    if (!commands) throw new Error('Show the commands of the entry.')
    expect(commands).toBeVisible()
    expect(
      within(commands)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'sub-001recon-all -subject sub-001',
      'sub-002recon-all -subject sub-002',
    ])
  })

  it('partitions blockers between the selected pass and stages that will not run', () => {
    const plan: WorkflowPlan = {
      ...PLAN,
      blockers: [
        ...PLAN.blockers,
        {
          key: 'recon',
          reason: 'Acknowledge the memory advisory for reconstruction.',
          kind: 'safety',
        },
      ],
    }
    render(
      <WorkflowReviewProvider>
        <Probe onResult={vi.fn()} plan={plan} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const blocking = screen.getByRole('region', { name: 'Blockers' })
    expect(
      within(blocking).getByText(
        'Acknowledge the memory advisory for reconstruction.',
      ),
    ).toBeVisible()
    expect(
      within(blocking).queryByText('Restore the Brain-PAD environment.'),
    ).toBeNull()

    const deferred = screen.getByRole('region', { name: 'Not in this pass' })
    expect(
      within(deferred).getByText(/will not run in this pass/),
    ).toBeVisible()
    expect(
      within(deferred).getByText('Restore the Brain-PAD environment.'),
    ).toBeVisible()
  })

  it('keeps a blocked dependency gating the runnable work that waits on it', () => {
    const node = PLAN.nodes[0]
    if (!node) throw new Error('Provide the planned fixture node.')
    const plan: WorkflowPlan = {
      ...PLAN,
      nodes: [
        {
          ...node,
          status: 'blocked',
          reason: 'Enable rerun of incomplete reconstruction output.',
        },
        {
          nodeId: '001-enigma-cohort',
          stepKey: 'enigma',
          scope: 'cohort',
          subjectId: null,
          status: 'waiting',
          dependencies: [node.nodeId],
        },
      ],
      blockers: [
        {
          key: 'recon',
          reason: 'Enable rerun of incomplete reconstruction output.',
          kind: 'environment',
        },
      ],
    }
    render(
      <WorkflowReviewProvider>
        <Probe onResult={vi.fn()} plan={plan} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(
      screen.queryByRole('region', { name: 'Not in this pass' }),
    ).toBeNull()
    expect(
      within(screen.getByRole('region', { name: 'Blockers' })).getByText(
        'Enable rerun of incomplete reconstruction output.',
      ),
    ).toBeVisible()
  })

  it('states a stage that depends on a blocked stage as a fact', () => {
    // The real planner's plan when Registry roles are missing: Clinical merge
    // is blocked, and Brain-PAD statistics records that it depends on it.
    const cause =
      'Prepare Clinical merge. Assign registry roles to sub-missing. Resolve ambiguous registry roles for sub-ambiguous.'
    const wait = `Wait for Clinical merge, which is blocked: ${cause}`
    const plan: WorkflowPlan = {
      ...PLAN,
      nodes: [
        ...PLAN.nodes,
        {
          nodeId: '001-clinical-cohort',
          stepKey: 'clinical',
          scope: 'cohort',
          subjectId: null,
          status: 'blocked',
          dependencies: [],
          reason: cause,
        },
        {
          nodeId: '002-brainpad-cohort',
          stepKey: 'brainpad',
          scope: 'cohort',
          subjectId: null,
          status: 'blocked',
          dependencies: ['001-clinical-cohort'],
          reason: wait,
        },
      ],
      blockers: [
        {
          key: 'clinical',
          reason: cause,
          kind: 'cohort',
          subjects: ['sub-ambiguous', 'sub-missing'],
          subjectCount: 2,
          action: 'open-registry',
        },
        { key: 'brainpad', reason: wait, kind: 'dependency' },
      ],
    }
    render(
      <WorkflowReviewProvider>
        <InspectProbe onClosed={vi.fn()} plan={plan} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    const deferred = screen.getByRole('region', { name: 'Not in this pass' })
    const lines = within(deferred)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '')
    expect(lines).toContain(
      `Brain-PAD statistics Depends on Clinical merge, which is blocked: ${cause}`,
    )
    expect(lines.filter((line) => line.includes('Wait for'))).toEqual([])
  })

  it('collapses per-node blocker repeats into one cause with a count', () => {
    const node = PLAN.nodes[0]
    if (!node) throw new Error('Provide the planned fixture node.')
    const repeated = {
      key: 'recon',
      reason: 'Acknowledge the memory advisory for reconstruction.',
      kind: 'safety',
    } as const
    const plan: WorkflowPlan = {
      ...PLAN,
      blockers: [
        repeated,
        repeated,
        repeated,
        {
          key: 'recon',
          reason: 'Acknowledge the memory advisory for reconstruction.',
          kind: 'environment',
        },
      ],
    }
    render(
      <WorkflowReviewProvider>
        <Probe onResult={vi.fn()} plan={plan} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const blocking = screen.getByRole('region', { name: 'Blockers' })
    expect(
      within(blocking).getByText(
        'Acknowledge the memory advisory for reconstruction. (3 jobs)',
      ),
    ).toBeVisible()
    expect(
      within(blocking).getByText(
        'Acknowledge the memory advisory for reconstruction.',
      ),
    ).toBeVisible()
    expect(within(blocking).getAllByRole('listitem')).toHaveLength(2)
  })

  it('keeps every affected subject reachable behind the collapsed cause', () => {
    const reason =
      'Prepare Reconstruction. Assign registry roles to sub-101 (+1 more).'
    const plan: WorkflowPlan = {
      ...PLAN,
      blockers: [
        {
          key: 'recon',
          reason,
          kind: 'cohort',
          subjects: ['sub-101', 'sub-102'],
          subjectCount: 2,
        },
        {
          key: 'recon',
          reason,
          kind: 'cohort',
          subjects: ['sub-102', 'sub-103'],
          subjectCount: 2,
        },
      ],
    }
    render(
      <WorkflowReviewProvider>
        <Probe onResult={vi.fn()} plan={plan} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const blocking = screen.getByRole('region', { name: 'Blockers' })
    expect(within(blocking).getByText(`${reason} (2 jobs)`)).toBeVisible()
    const disclosure = within(blocking).getByText('Show all 3 subjects')
    expect(within(blocking).getByText('sub-103')).not.toBeVisible()

    fireEvent.click(disclosure)
    const subjects = within(blocking).getByRole('list', {
      name: 'Subjects blocked in Reconstruction',
    })
    expect(
      within(subjects)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['sub-101', 'sub-102', 'sub-103'])
  })

  it('names the blocked nodes of a blocker reported without subjects', () => {
    // The sidecar's blocker carries no subject, but the blocked node that
    // records the reason names sub-902.
    const conflict =
      'Choose a fresh derivatives namespace because detector-complete Reconstruction output has no matching current receipt; preserve the existing tree.'
    const node = PLAN.nodes[0]
    if (!node) throw new Error('Provide the planned fixture node.')
    const plan: WorkflowPlan = {
      ...PLAN,
      nodes: [
        { ...node, nodeId: '000-recon-sub-901', subjectId: 'sub-901' },
        {
          ...node,
          nodeId: '001-recon-sub-902',
          subjectId: 'sub-902',
          status: 'blocked',
          reason: conflict,
        },
        {
          ...node,
          nodeId: '002-recon-sub-903',
          subjectId: 'sub-903',
          status: 'blocked',
          reason: 'Another reason.',
        },
      ],
      blockers: [
        { key: 'recon', reason: conflict, kind: 'safety' },
        {
          key: 'recon',
          reason: 'Another reason.',
          kind: 'cohort',
          subjects: ['sub-909'],
          subjectCount: 1,
        },
      ],
    }
    render(
      <WorkflowReviewProvider>
        <Probe onResult={vi.fn()} plan={plan} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const blocking = screen.getByRole('region', { name: 'Blockers' })
    expect(within(blocking).getByText(conflict)).toBeVisible()
    const [conflictSubjects, reportedSubjects] = within(blocking).getAllByRole(
      'list',
      {
        name: 'Subjects blocked in Reconstruction',
        hidden: true,
      },
    )
    expect(
      within(conflictSubjects!)
        .getAllByRole('listitem', { hidden: true })
        .map((item) => item.textContent),
    ).toEqual(['sub-902'])
    // A blocker that names its subjects keeps them as reported.
    expect(
      within(reportedSubjects!)
        .getAllByRole('listitem', { hidden: true })
        .map((item) => item.textContent),
    ).toEqual(['sub-909'])
    // The plan the review was given is not changed.
    expect(plan.blockers[0]?.subjects).toBeUndefined()
  })

  it('qualifies an empty blocker list while later stages stay blocked', () => {
    render(
      <WorkflowReviewProvider>
        <Probe onResult={vi.fn()} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const blocking = screen.getByRole('region', { name: 'Blockers' })
    expect(
      within(blocking).getByText('No blockers gate this pass.'),
    ).toBeVisible()
    expect(
      within(
        screen.getByRole('region', { name: 'Not in this pass' }),
      ).getByText('Restore the Brain-PAD environment.'),
    ).toBeVisible()
  })

  it('keeps every blocker blocking when no node is runnable', () => {
    const node = PLAN.nodes[0]
    if (!node) throw new Error('Provide the planned fixture node.')
    const plan: WorkflowPlan = {
      ...PLAN,
      nodes: [
        {
          ...node,
          status: 'blocked',
          reason: 'Restore the Brain-PAD environment.',
        },
      ],
    }
    render(
      <WorkflowReviewProvider>
        <Probe onResult={vi.fn()} plan={plan} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(
      screen.queryByRole('region', { name: 'Not in this pass' }),
    ).toBeNull()
    expect(
      within(screen.getByRole('region', { name: 'Blockers' })).getByText(
        'Restore the Brain-PAD environment.',
      ),
    ).toBeVisible()
  })

  it('states authorization binding without the digest until disclosed', () => {
    render(
      <WorkflowReviewProvider>
        <Probe onResult={vi.fn()} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the exact resume plan.',
    })
    expect(
      within(dialog).getByText(
        /Approval binds one-use authorization to exactly this reviewed plan\./,
      ),
    ).toBeVisible()
    expect(within(dialog).queryByText(/digest/i)).not.toBeVisible()

    const digest = within(dialog).getByText('a'.repeat(64))
    expect(digest).not.toBeVisible()

    const summary = within(dialog).getByText('Technical details')
    summary.focus()
    expect(document.activeElement).toBe(summary)
    fireEvent.click(summary)
    expect(digest).toBeVisible()
    fireEvent.click(summary)
    expect(digest).not.toBeVisible()
  })

  it('scrolls a long plan inside the window-bounded dialog with its title and actions fixed', () => {
    const subjectIds = Array.from(
      { length: 82 },
      (_, index) => `sub-${String(index + 1).padStart(3, '0')}`,
    )
    render(
      <WorkflowReviewProvider>
        <Probe
          onResult={vi.fn()}
          plan={{
            ...PLAN,
            analysisCohort: { subjectIds, sha256: 'analysis-82' },
            selectedSubset: { subjectIds, sha256: 'selected-82' },
          }}
        />
      </WorkflowReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    const dialog = screen.getByRole('dialog', {
      name: 'Review the exact resume plan.',
    })
    expect(dialog.style.maxHeight).toBe(
      'calc(100vh / var(--ss-zoom, 1) - 64px)',
    )
    // The plan takes the height the card leaves rather than a share of the
    // viewport, which text zoom would inflate past the window.
    const plan = within(dialog).getByTestId('workflow-plan-review')
    expect(plan.style.maxHeight).toBe('')
    const body = plan.closest('[data-dialog-body]') as HTMLElement
    expect(body).not.toBeNull()
    expect(body.style.overflowY).toBe('auto')
    expect(body.style.minHeight).toBe('0px')
    expect(body.style.flex).toBe('1 1 auto')
    const title = within(dialog).getByRole('heading', {
      name: 'Review the exact resume plan.',
    })
    const actions = within(dialog).getByRole('button', {
      name: 'Authorize resume',
    }).parentElement as HTMLElement
    expect(title.style.flexShrink).toBe('0')
    expect(actions.style.flexShrink).toBe('0')
  })

  it('describes an approvable plan by its lead paragraph', () => {
    render(
      <WorkflowReviewProvider>
        <Probe onResult={vi.fn()} />
      </WorkflowReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))

    expect(
      screen.getByRole('dialog', { name: 'Review the exact resume plan.' }),
    ).toHaveAccessibleDescription(
      "The sidecar's authoritative, one-use plan. Approval binds one-use authorization to exactly this reviewed plan.",
    )
    expect(
      screen.getByRole('button', { name: 'Authorize resume' }),
    ).not.toHaveAttribute('aria-describedby')
  })

  it('returns approval only from the exact-plan action', async () => {
    const onResult = vi.fn()
    render(
      <WorkflowReviewProvider>
        <Probe onResult={onResult} />
      </WorkflowReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Authorize resume' }))

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a read-only plan with its content and a disabled Authorize explained beside it', async () => {
    const onClosed = vi.fn()
    render(
      <WorkflowReviewProvider>
        <InspectProbe
          onClosed={onClosed}
          plan={{
            ...PLAN,
            nodes: [
              ...PLAN.nodes,
              {
                nodeId: '001-enigma-cohort',
                stepKey: 'enigma',
                scope: 'cohort',
                subjectId: null,
                status: 'skipped',
                dependencies: [],
              },
            ],
          }}
        />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the exact workflow plan.',
    })
    // The same plan content as an approvable review.
    expect(within(dialog).getByText(/Analysis cohort: 2 subject/)).toBeVisible()
    expect(within(dialog).getByText(/QC Fail: sub-003/)).toBeVisible()
    expect(
      within(dialog).getByRole('region', { name: 'Effects' }),
    ).toHaveTextContent(
      'Reconstruction for sub-001: No earlier run left a receipt for it.',
    )
    expect(
      within(dialog).getByText('recon-all -subject sub-001'),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('region', { name: 'Skipped' }),
    ).toHaveTextContent('ENIGMA QC for the cohort: The plan skips it.')
    expect(within(dialog).getByText(/Brain-PAD environment/)).toBeVisible()
    expect(within(dialog).getByText(/Available memory: 8.3 GB/)).toBeVisible()
    expect(dialog).toHaveTextContent(
      "This is the sidecar's authoritative plan, shown read-only because Allow live runs is off. Nothing starts from this review. 1 of its 2 jobs would run.",
    )
    expect(dialog).not.toHaveTextContent(/Approval binds/)

    const authorize = within(dialog).getByRole('button', {
      name: 'Authorize this plan',
    })
    expect(authorize).toBeDisabled()
    expect(within(dialog).getByText(READ_ONLY_FOOTNOTE)).toBeVisible()
    // The lead paragraph describes the dialog, so opening it does not read
    // out the whole plan; the footnote describes the disabled action.
    expect(dialog).toHaveAccessibleDescription(
      "This is the sidecar's authoritative plan, shown read-only because Allow live runs is off. Nothing starts from this review. 1 of its 2 jobs would run.",
    )
    expect(authorize).toHaveAccessibleDescription(READ_ONLY_FOOTNOTE)
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull()
    const close = within(dialog).getByRole('button', { name: 'Close' })
    await waitFor(() => expect(close).toHaveFocus())

    fireEvent.click(authorize)
    expect(onClosed).not.toHaveBeenCalled()
    expect(dialog).toBeInTheDocument()

    fireEvent.click(close)
    await waitFor(() => expect(onClosed).toHaveBeenCalledWith(undefined))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it("names the flow's own action beside the disabled approval", () => {
    const view = render(
      <WorkflowReviewProvider>
        <InspectProbe
          onClosed={vi.fn()}
          kind="retry"
          relaunchLabel="Retry canceled jobs"
        />
      </WorkflowReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    expect(
      screen.getByRole('dialog', { name: 'Review the exact retry plan.' }),
    ).toHaveTextContent(
      'Authorize retry is unavailable because Allow live runs is off. To run this plan, turn on Allow live runs in Runs > Execution controls or in Settings, save the project, then choose Retry canceled jobs again.',
    )
    expect(screen.queryByText(/Review plan again/)).toBeNull()
    view.unmount()

    // A flow whose starting action is not known is named instead.
    render(
      <WorkflowReviewProvider>
        <InspectProbe onClosed={vi.fn()} kind="resume" relaunchLabel={null} />
      </WorkflowReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    expect(
      screen.getByRole('dialog', { name: 'Review the exact resume plan.' }),
    ).toHaveTextContent(
      'Authorize resume is unavailable because Allow live runs is off. To run this plan, turn on Allow live runs in Runs > Execution controls or in Settings, save the project, then start the resume again.',
    )
  })

  it('settles a read-only plan on Escape and when the project changes', async () => {
    const onClosed = vi.fn()
    const view = render(
      <WorkflowReviewProvider>
        <InspectProbe onClosed={onClosed} />
      </WorkflowReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(onClosed).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    appState.projectEpoch = 4
    try {
      view.rerender(
        <WorkflowReviewProvider>
          <InspectProbe onClosed={onClosed} />
        </WorkflowReviewProvider>,
      )
      await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(2))
      // The dialog closes with its project, not only on a keyed remount.
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      appState.projectEpoch = 3
    }
  })
})
