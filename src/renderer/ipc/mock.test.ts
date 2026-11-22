import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { WorkflowRequest } from '../../shared/contract'
import type { StepKey } from '../../shared/steps'
import type { Subject } from '../../shared/types'
import { setupProgressText } from '../screens/env/pybrainage-setup'
import { createMockApi, makeMockCohort } from './mock'

const PROJECT = {
  projectId: 'mock-cohort-project',
  root: '/tmp/mock-cohort-project',
  configPath: '/tmp/mock-cohort-project/supraspina.project.json',
  epoch: 3,
}

function request(target: WorkflowRequest['intent']['target']): WorkflowRequest {
  return {
    project: PROJECT,
    cfg: DEFAULT_PROJECT_CONFIG,
    configRevision: 0,
    intent: { kind: 'workflow', target },
    acknowledgements: {
      includeDeferredAndUnreviewedQc: false,
      acknowledgeMemoryAdvisory: false,
    },
  }
}

describe('browser mock analysis cohort', () => {
  it('should trust explicit eligibility independently from cohort role', async () => {
    const rows = makeMockCohort(2, 91)
    rows[0] = {
      ...rows[0]!,
      id: 'sub-eligible-unknown-role',
      cohort: 'UNKNOWN',
      cohortRole: 'ambiguous',
      qc: 'pass',
      analysisEligible: true,
    }
    rows[1] = {
      ...rows[1]!,
      id: 'sub-failed',
      qc: 'fail',
      analysisEligible: false,
      unavailableReason: 'Excluded from analysis: the QC verdict is Fail.',
    }
    const api = createMockApi(rows)

    const result = await api.pipeline.planWorkflow(request({ mode: 'all' }))

    expect(result.plan.analysisCohort.subjectIds).toEqual([
      'sub-eligible-unknown-role',
    ])
  })

  it('should refuse failed and nonexistent explicit targets as the sidecar does', async () => {
    const rows = makeMockCohort(2, 92)
    rows[0] = {
      ...rows[0]!,
      id: 'sub-eligible',
      qc: 'pass',
      analysisEligible: true,
    }
    rows[1] = {
      ...rows[1]!,
      id: 'sub-failed',
      qc: 'fail',
      analysisEligible: false,
    }
    const api = createMockApi(rows)

    const result = await api.pipeline.planWorkflow(
      request({
        mode: 'explicit',
        subjectIds: ['sub-eligible', 'sub-failed', 'not-discovered'],
      }),
    )

    expect(result.disposition).toBe('blocked')
    expect(result.plan.nodes).toEqual([])
    expect(result.summary.message).toBe(
      'Remove 2 subject(s) outside the analysis cohort.',
    )
  })

  it('should update analysis eligibility with QC verdict changes', async () => {
    const row = {
      ...makeMockCohort(1, 93)[0]!,
      id: 'sub-qc',
      qc: 'pass' as const,
      analysisEligible: true,
    }
    const api = createMockApi([row])

    await api.subjects.markQc({
      project: PROJECT,
      subjectId: row.id,
      verdict: 'fail',
      note: '',
      tags: [],
    })
    await expect(
      api.subjects.refreshOne({
        project: PROJECT,
        cfg: DEFAULT_PROJECT_CONFIG,
        configRevision: 0,
        subjectId: row.id,
      }),
    ).resolves.toMatchObject({ qc: 'fail', analysisEligible: false })

    await api.subjects.markQc({
      project: PROJECT,
      subjectId: row.id,
      verdict: 'pass',
      note: '',
      tags: [],
    })
    await expect(
      api.subjects.refreshOne({
        project: PROJECT,
        cfg: DEFAULT_PROJECT_CONFIG,
        configRevision: 0,
        subjectId: row.id,
      }),
    ).resolves.toMatchObject({ qc: 'pass', analysisEligible: true })
  })
})

describe('browser mock run cancellation', () => {
  it('should report the settled cancellation and the canceled job reason as the sidecar does', async () => {
    const rows = makeMockCohort(2, 94).map((row) => ({
      ...row,
      qc: 'pass' as const,
      analysisEligible: true,
    }))
    const api = createMockApi(rows)
    const { plan } = await api.pipeline.planWorkflow(request({ mode: 'all' }))
    if (!plan.digest) throw new Error('The mock plan carries no digest.')
    const started = await api.pipeline.runWorkflow({
      ...request({ mode: 'all' }),
      approvedPlan: { planId: plan.planId, digest: plan.digest },
    })
    const runId = started.runId
    if (!runId) throw new Error('The mock run did not start.')

    const canceled = await api.pipeline.cancelRun({ project: PROJECT, runId })

    expect(canceled).toEqual({
      runId,
      accepted: true,
      terminal: true,
      pendingJobIds: [],
      message: 'Cancellation settled.',
    })
    const snapshot = await api.runtime.bootstrap({ project: PROJECT })
    const jobs = snapshot.jobs.filter((job) => job.runId === runId)
    expect(jobs.length).toBeGreaterThan(0)
    for (const job of jobs) {
      expect(job.terminalReason).toBe(
        "This work was canceled at the operator's request.",
      )
    }
  })
})

describe('browser mock start summaries', () => {
  // The sidecar's wording (workflow_manager.py start): the result says what
  // the launch did, and the run record keeps the run state's summary.
  const passingRows = (count: number, seed: number): Subject[] =>
    makeMockCohort(count, seed).map((row) => ({
      ...row,
      qc: 'pass',
      analysisEligible: true,
    }))
  const brainfov = (dryRun: boolean): WorkflowRequest => ({
    ...request({ mode: 'all' }),
    cfg: {
      ...DEFAULT_PROJECT_CONFIG,
      runtime: { ...DEFAULT_PROJECT_CONFIG.runtime, dryRun },
    },
    intent: { kind: 'stage', stepKey: 'brainfov', target: { mode: 'all' } },
  })
  const start = async (
    rows: Subject[],
    dryRun: boolean,
  ): Promise<{
    message: string
    runId: string | null
    recorded: string | undefined
  }> => {
    const api = createMockApi(rows)
    const { plan } = await api.pipeline.planWorkflow(brainfov(dryRun))
    if (!plan.digest) throw new Error('The mock plan carries no digest.')
    const started = await api.pipeline.runWorkflow({
      ...brainfov(dryRun),
      approvedPlan: { planId: plan.planId, digest: plan.digest },
    })
    const snapshot = await api.runtime.bootstrap({ project: PROJECT })
    return {
      message: started.summary.message,
      runId: started.runId,
      recorded: snapshot.runs.find((run) => run.runId === started.runId)
        ?.summary.message,
    }
  }

  it('should state a dry run as planned commands that executed nothing', async () => {
    expect(await start(passingRows(2, 110), true)).toMatchObject({
      message:
        'Dry run only: planned 2 commands and executed nothing. Turn off Dry run first to execute.',
      recorded: 'The run is planned.',
    })
    expect((await start(passingRows(1, 111), true)).message).toBe(
      'Dry run only: planned 1 command and executed nothing. Turn off Dry run first to execute.',
    )
  })

  it('should state a live start as queued jobs of the named run', async () => {
    const two = await start(passingRows(2, 112), false)
    expect(two.message).toBe(
      `Started run ${two.runId}: 2 jobs queued. Watch In flight here and the output in Logs.`,
    )
    expect(two.recorded).toBe('The run is queued.')
    const one = await start(passingRows(1, 113), false)
    expect(one.message).toBe(
      `Started run ${one.runId}: 1 job queued. Watch In flight here and the output in Logs.`,
    )
  })
})

describe('browser mock environment details', () => {
  // Each detail is the one the sidecar's check writes for the same state
  // (sidecar/supraspina_sidecar/env): a skipped or not-needed check states why.
  it.each([
    [
      'wsl',
      'Supraspina uses paths as they are, without translation, on this non-WSL host.',
    ],
    ['wslpath', 'wslpath is not needed outside WSL mode.'],
    [
      'matlabBoot',
      'Supraspina does not probe the MATLAB cold start because startup is slow; run MATLAB manually to check it.',
    ],
    [
      'mcr',
      'Select the installed R2019b (9.7) MATLAB Runtime root for the compiled ENIGMA QC backend. This backend is optional because source MATLAB is the selected ENIGMA QC backend. Use it as the license-free alternative by selecting the mcr backend in the ENIGMA QC step options; the compiled route requires the R2019b (9.7) MATLAB Runtime and the verified compiled ENIGMA assets.',
    ],
    ['fsl_deface', 'The default pipeline does not use this optional defacer.'],
    ['pydeface', 'The default pipeline does not use this optional defacer.'],
    ['rmarkdown', 'Install rmarkdown for /usr/bin/Rscript.'],
    ['knitr', 'Install knitr for /usr/bin/Rscript.'],
    [
      'pandoc',
      'Install Pandoc or add it to PATH. Get it opens the official Pandoc installation instructions.',
    ],
  ] as const)(
    'should word the %s check as the sidecar does',
    async (id, detail) => {
      const report = await createMockApi().env.check({})
      const check = report.groups
        .flatMap((group) => group.checks)
        .find((entry) => entry.id === id)
      expect(check?.detail).toBe(detail)
    },
  )

  it('should state every skipped check as a fact', async () => {
    const report = await createMockApi().env.check({})
    const skipped = report.groups
      .flatMap((group) => group.checks)
      .filter((check) => check.status === 'skipped' && check.detail)
    expect(skipped.length).toBeGreaterThan(0)
    for (const check of skipped) {
      expect(check.detail).not.toMatch(/^(Skip|Install this)\b/)
    }
  })
})

describe('browser mock debug bundle preview', () => {
  // The sidecar states its redaction policy as a fact (debug_bundle.py);
  // Logs shows it beside the bundle preview.
  it('should state the redaction policy as a fact as the sidecar does', async () => {
    const preview = await createMockApi().manifest.previewDebug({
      project: PROJECT,
      runId: 'run-preview',
    })
    expect(preview.redactionPolicy).toBe(
      'Paths and subject identifiers are redacted.',
    )
    expect(preview.redactionPolicy).not.toMatch(/^Redact\b/)
  })
})

describe('browser mock PyBrainAge setup', () => {
  // The adapter reports its steps as "Run <step>." (execute_provision), and
  // the sidecar streams each message as an output line and as progress.
  it('should stream the adapter step lines the setup states as facts', async () => {
    const api = createMockApi()
    const messages: string[] = []
    const lines: string[] = []
    api.provision.onProgress((ev) => messages.push(ev.message))
    api.provision.onLog((ev) => lines.push(ev.line))

    await api.provision.pybrainage({
      project: PROJECT,
      cfg: DEFAULT_PROJECT_CONFIG,
      configRevision: 0,
      authorization: {
        token: 'token',
        projectId: PROJECT.projectId,
        configRevision: 0,
        purpose: 'provision',
      },
    })

    expect(messages).toEqual([
      'Run create_env.',
      'Run install_pip_deps.',
      'Run fetch_model.',
      'Run validate_pickle.',
      'PyBrainAge provisioning is complete.',
    ])
    expect(messages.map(setupProgressText)).toEqual([
      'Creating the locked environment...',
      'Installing the pinned pip packages...',
      'Fetching the model archive...',
      'Validating the model and scaler...',
      'PyBrainAge provisioning is complete.',
    ])
    expect(lines.slice(0, 2)).toEqual([
      'Run create_env.',
      '$ micromamba create --yes --prefix envs/pybrainage --file conda-linux-64.lock',
    ])
    expect(lines.filter((line) => messages.includes(line))).toEqual(messages)
  })
})

describe('browser mock host consistency', () => {
  const finishedRows = (): Subject[] =>
    makeMockCohort(2, 96).map((row) => ({
      ...row,
      stepStates: { ...row.stepStates, pybrainage: 'done', final: 'done' },
    }))

  it('should report the tools of a finished stage as present', async () => {
    const api = createMockApi(finishedRows())

    const config = {
      project: PROJECT,
      cfg: DEFAULT_PROJECT_CONFIG,
      configRevision: 0,
    }
    const status = await api.env.toolStatus(config)
    const report = await api.env.check(config)

    expect(status.summary).toBe('ok')
    expect(status.items.filter((item) => item.status === 'missing')).toEqual([])
    const checks = report.groups.flatMap((group) => group.checks)
    for (const id of [
      'pybrainpython',
      'modelfile',
      'scalerfile',
      'rpkgs',
      'rmarkdown',
      'knitr',
      'pandoc',
    ]) {
      expect(checks.find((check) => check.id === id)?.status).toBe('found')
    }
  })

  it('should list the tools of stages that have not run as missing', async () => {
    const api = createMockApi()

    const status = await api.env.toolStatus({
      project: PROJECT,
      cfg: DEFAULT_PROJECT_CONFIG,
      configRevision: 0,
    })

    expect(
      status.items
        .filter((item) => item.status === 'missing')
        .map((item) => item.label),
    ).toEqual(['PyBrainAge', 'R packages'])
  })

  it('should give every mock cohort subject its T1 input', () => {
    expect(
      makeMockCohort(12).every(
        (subject) => subject.t1Availability === 'available',
      ),
    ).toBe(true)
  })

  it('should keep the T1 input of a discovered subject on registration', async () => {
    const api = createMockApi(makeMockCohort(1, 97))

    const row = await api.registry.upsert({
      project: PROJECT,
      record: {
        subjectId: 'sub-001',
        age: 40,
        sex: 'F',
        sourceCohortLabel: 'CTRL',
        ais: null,
        tSinceSci: null,
      },
    })

    expect(row).toMatchObject({
      t1Availability: 'available',
      runnable: true,
      unavailableReason: null,
    })
  })
})

describe('browser mock disabled stages', () => {
  const passingApi = () =>
    createMockApi(
      makeMockCohort(3, 95).map((row) => ({
        ...row,
        qc: 'pass' as const,
        analysisEligible: true,
      })),
    )

  it('should skip a stage that is off as the sidecar does', async () => {
    expect(DEFAULT_PROJECT_CONFIG.steps.deface.enabled).toBe(false)
    const api = passingApi()

    const result = await api.pipeline.planWorkflow(request({ mode: 'all' }))

    const deface = result.plan.nodes.filter((node) => node.stepKey === 'deface')
    expect(deface).toHaveLength(3)
    for (const node of deface) {
      expect(node).toMatchObject({
        scope: 'subject',
        status: 'skipped',
        reason: 'Optional defacing is off in project configuration.',
      })
      expect(node.subjectId).not.toBeNull()
    }
    expect(result.plan.nodes.some((node) => node.status === 'blocked')).toBe(
      false,
    )
    // BrainCharts and the z-score comparisons, appended after R analysis in
    // that order, are off by default too.
    for (const key of ['braincharts', 'zstats'] as const) {
      expect(result.plan.nodes.filter((node) => node.stepKey === key)).toEqual([
        expect.objectContaining({
          scope: 'cohort',
          status: 'skipped',
          subjectId: null,
        }),
      ])
    }
    expect(result.plan.nodes.slice(-2).map((node) => node.stepKey)).toEqual([
      'braincharts',
      'zstats',
    ])
    expect(result.disposition).toBe('planned')
    expect(result.summary).toMatchObject({
      blocked: 0,
      skipped: 5,
      planned: result.plan.nodes.length - 5,
    })
  })

  it('should schedule no work for a stage run of a stage that is off', async () => {
    const api = passingApi()

    const result = await api.pipeline.planWorkflow({
      ...request({ mode: 'all' }),
      intent: { kind: 'stage', stepKey: 'deface', target: { mode: 'all' } },
    })

    expect(result.disposition).toBe('noop')
    expect(result.plan.nodes).toHaveLength(3)
    expect(result.summary).toMatchObject({
      planned: 0,
      blocked: 0,
      skipped: 3,
      message: 'No work is scheduled: all 3 nodes are current.',
    })
  })
})

// Each expectation below is the sidecar's answer to the same request, read
// from pipeline.planWorkflow (build_dispatcher) on a fixture project.
describe('browser mock plan outcomes', () => {
  const passingRows = (count: number, seed: number): Subject[] =>
    makeMockCohort(count, seed).map((row) => ({
      ...row,
      qc: 'pass',
      analysisEligible: true,
    }))
  const stage = (
    stepKey: StepKey,
    target: WorkflowRequest['intent']['target'] = { mode: 'all' },
  ): WorkflowRequest => ({
    ...request(target),
    intent: { kind: 'stage', stepKey, target },
  })
  const refusal = (message: string) => ({
    planned: 0,
    started: 0,
    waiting: 0,
    blocked: 0,
    skipped: 0,
    message,
  })

  it('should refuse deferred and unreviewed subjects without acknowledgement', async () => {
    const rows = passingRows(3, 97)
    rows[0] = { ...rows[0]!, qc: 'defer' }
    rows[1] = { ...rows[1]!, qc: null }
    const api = createMockApi(rows)

    const result = await api.pipeline.planWorkflow(request({ mode: 'all' }))

    const reason =
      'Review 2 deferred or unreviewed analysis subject(s); provide explicit acknowledgment.'
    expect(result.disposition).toBe('blocked')
    expect(result.runId).toBeNull()
    expect(result.plan.nodes).toEqual([])
    expect(result.summary).toEqual(refusal(reason))
    expect(result.plan.summary).toEqual(result.summary)
    expect(result.plan.blockers).toEqual([
      { key: 'recon', kind: 'cohort', reason },
    ])
    expect(result.plan.analysisCohort.subjectIds).toEqual([])
    expect(result.plan.selectedSubset.subjectIds).toEqual([])
  })

  it('should refuse an unsafe subject ID in the selection', async () => {
    const api = createMockApi(passingRows(2, 98))

    const result = await api.pipeline.planWorkflow(
      request({ mode: 'explicit', subjectIds: ['../escape'] }),
    )

    expect(result.disposition).toBe('blocked')
    expect(result.summary.message).toBe(
      'Provide only safe subject IDs in the selection.',
    )
  })

  it('should state a runnable dry-run plan as a planned run', async () => {
    expect(DEFAULT_PROJECT_CONFIG.runtime.dryRun).toBe(true)
    const api = createMockApi(passingRows(2, 99))

    const result = await api.pipeline.planWorkflow(stage('brainfov'))

    expect(result.disposition).toBe('planned')
    expect(result.plan.nodes.map((node) => node.status)).toEqual([
      'planned',
      'planned',
    ])
    expect(result.summary).toEqual({
      planned: 2,
      started: 0,
      waiting: 0,
      blocked: 0,
      skipped: 0,
      message: 'The run is planned.',
    })
  })

  it('should state a runnable live plan as a queued run', async () => {
    const api = createMockApi(passingRows(2, 100))

    const result = await api.pipeline.planWorkflow({
      ...stage('brainfov'),
      cfg: {
        ...DEFAULT_PROJECT_CONFIG,
        runtime: { ...DEFAULT_PROJECT_CONFIG.runtime, dryRun: false },
      },
    })

    expect(result.disposition).toBe('planned')
    expect(result.summary.message).toBe('The run is queued.')
  })

  it('should plan nothing for a subject-scope stage with an empty selection', async () => {
    const api = createMockApi(passingRows(2, 101))

    const result = await api.pipeline.planWorkflow(
      stage('recon', { mode: 'explicit', subjectIds: [] }),
    )

    expect(result.disposition).toBe('noop')
    expect(result.plan.nodes).toEqual([])
    expect(result.plan.analysisCohort.subjectIds).toHaveLength(2)
    expect(result.plan.selectedSubset.subjectIds).toEqual([])
    expect(result.summary).toEqual(
      refusal(
        'Review plan totals: planned 0; waiting 0; blocked 0; skipped 0.',
      ),
    )
  })

  it('should keep an explicit empty workflow target as a no-op', async () => {
    const api = createMockApi(passingRows(2, 102))

    const result = await api.pipeline.planWorkflow(
      request({ mode: 'explicit', subjectIds: [] }),
    )

    expect(result.disposition).toBe('noop')
    expect(result.plan.nodes).toEqual([])
    expect(result.summary.message).toBe(
      'Keep the explicit empty workflow target as a no-op.',
    )
  })

  it('should plan a cohort-scope stage over the whole analysis cohort', async () => {
    const api = createMockApi(passingRows(2, 103))

    const result = await api.pipeline.planWorkflow(
      stage('enigma', { mode: 'explicit', subjectIds: [] }),
    )

    expect(result.disposition).toBe('planned')
    expect(result.plan.selectedSubset.subjectIds).toEqual(
      result.plan.analysisCohort.subjectIds,
    )
    expect(
      result.plan.nodes.map(({ stepKey, scope, subjectId }) => ({
        stepKey,
        scope,
        subjectId,
      })),
    ).toEqual([{ stepKey: 'enigma', scope: 'cohort', subjectId: null }])
    expect(result.summary.message).toBe('The run is planned.')
  })

  const failedRows = (count: number, seed: number): Subject[] =>
    makeMockCohort(count, seed).map((row) => ({
      ...row,
      qc: 'fail',
      analysisEligible: false,
    }))
  it.each([
    ['a subject-scope stage', stage('recon'), 'recon'],
    ['a cohort-scope stage', stage('enigma'), 'enigma'],
    ['the workflow', request({ mode: 'all' }), 'recon'],
    [
      'an explicit empty workflow target',
      request({ mode: 'explicit', subjectIds: [] }),
      'recon',
    ],
    [
      'a subject-scope stage with an empty selection',
      stage('recon', { mode: 'explicit', subjectIds: [] }),
      'recon',
    ],
  ] as const)(
    'should refuse %s when every subject failed QC',
    async (_label, planRequest, blockerKey) => {
      const api = createMockApi(failedRows(2, 104))

      const result = await api.pipeline.planWorkflow({
        ...planRequest,
        acknowledgements: {
          ...planRequest.acknowledgements,
          includeDeferredAndUnreviewedQc: true,
        },
      })

      const reason = 'Add subjects to the analysis cohort.'
      expect(result.disposition).toBe('blocked')
      expect(result.runId).toBeNull()
      expect(result.plan.nodes).toEqual([])
      expect(result.summary).toEqual(refusal(reason))
      expect(result.plan.blockers).toEqual([
        { key: blockerKey, kind: 'cohort', reason },
      ])
    },
  )
})

describe('browser mock registry sites', () => {
  const input = (subjectId: string) => ({
    subjectId,
    age: 40,
    sex: 'F' as const,
    sourceCohortLabel: 'CTRL',
    ais: null,
    tSinceSci: null,
  })

  it('sets sites like the sidecar contract and keeps them across edits', async () => {
    const api = createMockApi()
    await api.registry.upsert({ project: PROJECT, record: input('sub-101') })
    await api.registry.upsert({ project: PROJECT, record: input('sub-102') })
    expect((await api.registry.list({ project: PROJECT }))[0]?.site).toBeNull()

    await expect(
      api.registry.setSite({
        project: PROJECT,
        subjectIds: ['sub-101', 'sub-102'],
        site: ' Ingenia ',
        expectedRevisions: { 'sub-101': 1, 'sub-102': 1 },
      }),
    ).resolves.toEqual({ site: 'Ingenia', updated: 2 })
    const rows = await api.registry.list({ project: PROJECT })
    expect(rows.map((row) => [row.site, row.revision])).toEqual([
      ['Ingenia', 2],
      ['Ingenia', 2],
    ])

    // An upsert without the key keeps the stored site; null clears it.
    const kept = await api.registry.upsert({
      project: PROJECT,
      record: input('sub-101'),
      expectedRevision: 2,
    })
    expect(kept.site).toBe('Ingenia')
    const cleared = await api.registry.upsert({
      project: PROJECT,
      record: { ...input('sub-101'), site: null },
    })
    expect(cleared.site).toBeNull()

    await expect(
      api.registry.setSite({
        project: PROJECT,
        subjectIds: ['sub-102'],
        site: 'Prisma',
        expectedRevisions: { 'sub-102': 1 },
      }),
    ).rejects.toThrow(/another writer/)
    await expect(
      api.registry.setSite({
        project: PROJECT,
        subjectIds: ['sub-101'],
        site: 'ingenia',
        expectedRevisions: { 'sub-101': 4 },
      }),
    ).rejects.toThrow(/existing site label Ingenia/)
    await expect(
      api.registry.setSite({
        project: PROJECT,
        subjectIds: ['sub-999'],
        site: 'Prisma',
        expectedRevisions: { 'sub-999': 1 },
      }),
    ).rejects.toThrow(/another writer/)
    // An unregistered subject's site is held until it is registered.
    await expect(
      api.registry.setSite({
        project: PROJECT,
        subjectIds: ['sub-999'],
        site: 'Prisma',
        expectedRevisions: { 'sub-999': 0 },
      }),
    ).resolves.toEqual({ site: 'Prisma', updated: 1 })
    expect(
      (await api.registry.list({ project: PROJECT })).some(
        (row) => row.subjectId === 'sub-999',
      ),
    ).toBe(false)
    await expect(
      api.registry.upsert({
        project: PROJECT,
        record: {
          subjectId: 'sub-999',
          age: null,
          sex: 'F',
          sourceCohortLabel: 'CTRL',
          ais: null,
          tSinceSci: null,
        },
      }),
    ).resolves.toMatchObject({ site: 'Prisma', revision: 1 })
  })
})
