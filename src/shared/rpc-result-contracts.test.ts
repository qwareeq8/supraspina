import { describe, expect, it } from 'vitest'
import surface from './ipc-surface.json'
import {
  parseSidecarRpcResult,
  SIDECAR_RPC_RESULT_METHODS,
} from './rpc-result-contracts'
import { MAX_LOG_REPLAY_ENTRIES } from './runtime-contracts'
import { STEP_KEYS, STEP_SCOPES } from './steps'

const STEP_IDS = [-1, 0, 1, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 5.5, 9.5] as const

function stepDescriptors() {
  return STEP_KEYS.map((key, index) => ({
    id: STEP_IDS[index],
    key,
    name: `Stage ${key}`,
    goal: `Validate ${key}.`,
    scope: STEP_SCOPES[key],
    dependencies: [],
  }))
}

function summary() {
  return {
    planned: 1,
    started: 0,
    waiting: 0,
    blocked: 0,
    skipped: 0,
    message: 'Review one planned node.',
  }
}

function workflowResult() {
  const workflowSummary = summary()
  return {
    runId: null,
    disposition: 'planned',
    plan: {
      planId: 'run-012345abcdef',
      digest: 'd'.repeat(64),
      analysisCohort: {
        subjectIds: ['sub-001'],
        sha256: 'a'.repeat(64),
      },
      selectedSubset: {
        subjectIds: ['sub-001'],
        sha256: 'b'.repeat(64),
      },
      nodes: [
        {
          nodeId: 'node-1',
          stepKey: 'recon',
          scope: 'subject',
          subjectId: 'sub-001',
          status: 'planned',
          dependencies: [],
          command: 'recon --subject sub-001',
        },
      ],
      blockers: [
        {
          key: 'recon',
          kind: 'input-qc',
          reason: 'Approve the current Brain FOV crop.',
        },
      ],
      summary: workflowSummary,
      scientificEvidence: { privatePath: '/private/input.nii.gz' },
    },
    summary: workflowSummary,
    privateState: true,
  }
}

function manifest() {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: null,
    user: '[REDACTED]',
    host: '[REDACTED]',
    git: { repo: '', sha: '', dirty: false },
    configSha256: 'c'.repeat(64),
    recovery: { state: 'unknown', detail: 'Review prior process ownership.' },
    steps: [
      {
        id: 2.5,
        key: 'outliers',
        status: 'done',
        subjects: 1,
        failed: 0,
        durationSec: 2,
      },
    ],
    tools: {},
    scientificEvidence: { resourcePath: '/private/resource' },
  }
}

function runtimeSnapshot() {
  return {
    project: {
      projectId: 'project-1',
      root: '/project',
      configPath: '/project/supraspina.project.json',
      epoch: 2,
    },
    sidecarGeneration: 3,
    sequence: 7,
    runs: [
      {
        runId: 'run-1',
        projectId: 'project-1',
        projectEpoch: 2,
        status: 'running',
        startedAt: 1,
        endedAt: null,
        dryRun: false,
        durable: true,
        acknowledgements: {
          includeDeferredAndUnreviewedQc: false,
          acknowledgeMemoryAdvisory: false,
        },
        summary: summary(),
      },
    ],
    jobs: [
      {
        id: 'job-1',
        runId: 'run-1',
        nodeId: 'node-1',
        projectId: 'project-1',
        projectEpoch: 2,
        sidecarGeneration: 3,
        stepKey: 'recon',
        subjectId: 'sub-001',
        startedAt: 1,
        endedAt: null,
        exitCode: null,
        cmd: 'recon --subject sub-001',
        stdoutPath: '/project/logs/job-1.log',
        stderrPath: '/project/logs/job-1.log',
        envSnapshotPath: '',
        configSnapshotPath: '/project/state.json',
        status: 'running',
        privateProcessState: { pid: 100 },
      },
    ],
    logTail: [
      {
        id: 'log-1',
        runId: 'run-1',
        jobId: 'job-1',
        at: 2,
        level: 'INFO',
        line: 'Synthetic progress.',
      },
    ],
    provision: null,
  }
}

function resultPage() {
  return {
    items: [
      {
        artifactId: 'artifact-1',
        label: 'Synthetic table',
        stepKey: 'outliers',
        subjectId: null,
        kind: 'csv',
        presence: 'produced',
        displayPath: 'results/outliers.csv',
        exists: true,
        openable: true,
        revealable: true,
        runId: 'run-1',
        producerNodeId: 'node-1',
        receiptSha256: 'e'.repeat(64),
        provenance: 'current',
        provenanceDetails: {
          receipt: {
            receiptVersion: 1,
            signature: 'f'.repeat(64),
            signatureValid: true,
            committedAtMs: 10,
            jobId: 'job-1',
            analysisCohortDigest: 'a'.repeat(64),
            selectedSubsetDigest: 'b'.repeat(64),
            inputT1Fingerprint: null,
            stepParamsDigest: 'c'.repeat(64),
            adapterIdentity: 'outliers@1',
            adapterImplementationSha256: 'd'.repeat(64),
            toolEvidenceDigest: 'e'.repeat(64),
            externalInputsDigest: 'f'.repeat(64),
            outputSchemaIdentity: 'outliers-v1',
            upstreamSignatures: ['0'.repeat(64)],
            baselineDigest: '1'.repeat(64),
          },
          runBinding: {
            planDigest: '2'.repeat(64),
            configDigest: '3'.repeat(64),
            qcDigest: '4'.repeat(64),
            registryDigest: '5'.repeat(64),
            environmentDigest: '6'.repeat(64),
          },
        },
        detail: 'Detector complete.',
        privatePath: '/private/result.csv',
      },
    ],
    nextCursor: null,
    truncated: false,
    runId: 'run-1',
    configSha256: 'c'.repeat(64),
    total: 1,
    producedStepKeys: ['outliers'],
    stageCurrency: {
      aggregate: { state: 'outdated', outdatedSubjectIds: [] },
      recon: { state: 'outdated', outdatedSubjectIds: ['sub-01'] },
    },
  }
}

function envInstallOperation() {
  return {
    operationId: 'install-012345abcdef',
    checkId: 'rscript',
    projectId: 'project-1',
    projectEpoch: 2,
    phase: 'running',
    startedAt: 1,
    updatedAt: 2,
    output: 'Collecting the requested package\n',
    rc: null,
    stdout: '',
    stderr: '',
  }
}

function toolStatus() {
  return {
    items: [{ id: 'freesurfer', label: 'FreeSurfer', status: 'ok' }],
    summary: 'ok',
    capturedAt: '2026-08-01T00:00:00Z',
  }
}

function provisionStatus() {
  return {
    envReady: true,
    modelReady: true,
    pythonExecutable: '/opt/pybrainage/bin/python',
    modelPath: '/opt/pybrainage/model.dat',
    scalerPath: '/opt/pybrainage/scaler.dat',
    projectId: 'project-1',
    projectEpoch: 2,
    configRevision: 4,
    operationId: 'provision-012345abcdef',
    phase: 'done',
    cancellable: false,
    error: null,
  }
}

function cancelResult() {
  return {
    operationId: 'provision-012345abcdef',
    accepted: true,
    terminal: false,
  }
}

function cancelRun() {
  return {
    runId: 'run-1',
    accepted: true,
    terminal: false,
    pendingJobIds: ['job-1'],
    message: 'Wait for terminal acknowledgment.',
  }
}

function debugPreview() {
  return {
    runId: 'run-1',
    categories: [
      {
        id: 'logs',
        label: 'Job logs',
        fileCount: 3,
        estimatedBytes: 4_096,
        redactions: ['Removed the operator home directory.'],
        truncated: false,
      },
    ],
    totalFiles: 3,
    estimatedBytes: 4_096,
    redactionPolicy: 'Redact absolute paths and identifiers.',
    truncated: false,
  }
}

function registryRecord() {
  return {
    subjectId: 'sub-001',
    age: 42,
    sex: 'F',
    sourceCohortLabel: 'SCI cohort',
    cohortRole: 'sci-neuropathic-pain',
    ais: 'C',
    tSinceSci: 18,
    t1Availability: 'available',
    runnable: true,
    unavailableReason: null,
    qc: 'pass',
    qcNote: '',
    qcTags: ['motion'],
    revision: 7,
    updatedAt: '2026-08-01T00:00:00Z',
  }
}

describe('sidecar RPC result contracts', () => {
  it('covers every renderer-exposed sidecar method', () => {
    expect([...SIDECAR_RPC_RESULT_METHODS].sort()).toEqual(
      [...surface.sidecar].sort(),
    )
  })

  it('bounds generic JSON methods and rejects nonfinite or oversized data', () => {
    expect(
      parseSidecarRpcResult('subjects.discover', {
        subjects: [],
        marker: true,
      }),
    ).toEqual({ subjects: [], marker: true })
    expect(() =>
      parseSidecarRpcResult('subjects.discover', { age: Number.NaN }),
    ).toThrow(/finite/)
    expect(() =>
      parseSidecarRpcResult('subjects.discover', 'x'.repeat(65_537)),
    ).toThrow(/bounded/)
    const recursive: Record<string, unknown> = {}
    recursive.self = recursive
    expect(() => parseSidecarRpcResult('subjects.discover', recursive)).toThrow(
      /nesting limit/,
    )
  })

  it('accepts every payload inside the declared result bounds', () => {
    const maximalArray = Array.from(
      { length: 20_000 },
      (_value, index) => index,
    )
    expect(parseSidecarRpcResult('subjects.discover', maximalArray)).toEqual(
      maximalArray,
    )

    // Five maximal arrays inside one object satisfy every declared
    // per-container limit, so the total budget must admit them.
    const nestedArrays = Object.fromEntries(
      Array.from({ length: 5 }, (_value, index) => [`a${index}`, maximalArray]),
    )
    expect(parseSidecarRpcResult('subjects.discover', nestedArrays)).toEqual(
      nestedArrays,
    )

    // A maximal table of rows likewise fits the coherent policy.
    const table = Array.from({ length: 5_000 }, (_value, index) => ({
      id: `sub-${index}`,
      value: index,
    }))
    expect(parseSidecarRpcResult('subjects.discover', table)).toEqual(table)

    const maximalObject = Object.fromEntries(
      Array.from({ length: 2_048 }, (_value, index) => [`f${index}`, index]),
    )
    expect(parseSidecarRpcResult('subjects.discover', maximalObject)).toEqual(
      maximalObject,
    )

    let deepest: unknown = 1
    for (let level = 0; level < 20; level += 1) deepest = { nested: deepest }
    expect(parseSidecarRpcResult('subjects.discover', deepest)).toEqual(deepest)

    const longest = 'x'.repeat(65_536)
    expect(parseSidecarRpcResult('subjects.discover', longest)).toBe(longest)
  })

  it('rejects each result bound with its own message', () => {
    let tooDeep: unknown = 1
    for (let level = 0; level < 21; level += 1) tooDeep = { nested: tooDeep }
    expect(() => parseSidecarRpcResult('subjects.discover', tooDeep)).toThrow(
      /nesting limit/,
    )

    expect(() =>
      parseSidecarRpcResult(
        'subjects.discover',
        Array.from({ length: 20_001 }, () => 0),
      ),
    ).toThrow(/arrays within the item limit/)

    expect(() =>
      parseSidecarRpcResult(
        'subjects.discover',
        Object.fromEntries(
          Array.from({ length: 2_049 }, (_value, index) => [`f${index}`, 0]),
        ),
      ),
    ).toThrow(/objects within the field limit/)

    expect(() =>
      parseSidecarRpcResult('subjects.discover', 'x'.repeat(65_537)),
    ).toThrow(/bounded sidecar result string/)

    // 250 fields at 20,000 items each satisfy every per-container limit and
    // still exceed the total value budget.
    const wide = Object.fromEntries(
      Array.from({ length: 250 }, (_value, index) => [
        `f${index}`,
        Array.from({ length: 20_000 }, () => 0),
      ]),
    )
    expect(() => parseSidecarRpcResult('subjects.discover', wide)).toThrow(
      /structural bounds/,
    )

    const text = 'y'.repeat(65_536)
    const oversizedText = Array.from({ length: 129 }, () => text)
    expect(() =>
      parseSidecarRpcResult('subjects.discover', oversizedText),
    ).toThrow(/total text limit/)
  })

  it('projects environment results and drops unknown fields', () => {
    const parsed = parseSidecarRpcResult('env.check', {
      groups: [
        {
          name: 'Python',
          checks: [
            {
              id: 'python',
              label: 'Python',
              status: 'found',
              detail: '3.12.10',
              privateProbe: '/usr/bin/python',
            },
          ],
        },
      ],
      availableMemoryGB: 16,
      capturedAt: '2026-08-01T00:00:00Z',
      privateEnvironment: true,
    })
    expect(parsed).toEqual({
      groups: [
        {
          name: 'Python',
          checks: [
            {
              id: 'python',
              label: 'Python',
              status: 'found',
              detail: '3.12.10',
            },
          ],
        },
      ],
      availableMemoryGB: 16,
      capturedAt: '2026-08-01T00:00:00Z',
    })
    expect(() =>
      parseSidecarRpcResult('env.check', {
        groups: [],
        availableMemoryGB: Number.POSITIVE_INFINITY,
        capturedAt: 'now',
      }),
    ).toThrow(/finite/)
  })

  it('keeps the offline-install mark only as a boolean', () => {
    const withMark = (offlineInstall: unknown) => ({
      groups: [
        {
          name: 'Pipeline assets',
          checks: [
            {
              id: 'scientific_assets',
              label: 'Reviewed scientific assets',
              status: 'missing',
              recommendedCmd: 'supraspina-sidecar --acquire-scientific-assets',
              installable: true,
              offlineInstall,
            },
          ],
        },
      ],
      availableMemoryGB: null,
      capturedAt: '2026-09-23T00:00:00Z',
    })
    const parsed = parseSidecarRpcResult('env.check', withMark(true)) as {
      groups: { checks: { offlineInstall?: unknown }[] }[]
    }
    expect(parsed.groups[0]?.checks[0]?.offlineInstall).toBe(true)
    expect(() => parseSidecarRpcResult('env.check', withMark('yes'))).toThrow(
      /offline-install state/,
    )
  })

  it('projects typed check actions and directory-creation results', () => {
    const withAction = (action: unknown) => ({
      groups: [
        {
          name: 'FreeSurfer',
          checks: [
            {
              id: 'subjdir',
              label: 'SUBJECTS_DIR',
              status: 'warn',
              recommendedCmd: "mkdir -p '/data/deri vatives/freesurfer'",
              installable: false,
              action,
            },
          ],
        },
      ],
      availableMemoryGB: null,
      capturedAt: '2026-08-01T00:00:00Z',
    })
    const parsed = parseSidecarRpcResult(
      'env.check',
      withAction({ kind: 'create-directory', label: 'Create directory' }),
    ) as { groups: { checks: { action?: unknown }[] }[] }
    expect(parsed.groups[0]?.checks[0]?.action).toEqual({
      kind: 'create-directory',
      label: 'Create directory',
    })
    const setupParsed = parseSidecarRpcResult(
      'env.check',
      withAction({ kind: 'setup-pybrainage', label: 'Set up PyBrainAge' }),
    ) as { groups: { checks: { action?: unknown }[] }[] }
    expect(setupParsed.groups[0]?.checks[0]?.action).toEqual({
      kind: 'setup-pybrainage',
      label: 'Set up PyBrainAge',
    })
    expect(() =>
      parseSidecarRpcResult(
        'env.check',
        withAction({ kind: 'run-anything', label: 'Run' }),
      ),
    ).toThrow(/action kind/)
    expect(() =>
      parseSidecarRpcResult('env.check', withAction('create-directory')),
    ).toThrow(/valid environment check action/)

    expect(
      parseSidecarRpcResult('env.createOutputDir', {
        ok: true,
        detail: 'Created /data/derivatives/freesurfer.',
        privateState: true,
      }),
    ).toEqual({ ok: true, detail: 'Created /data/derivatives/freesurfer.' })
    expect(() =>
      parseSidecarRpcResult('env.createOutputDir', { ok: 'yes', detail: 'x' }),
    ).toThrow(/directory-creation outcome/)
    expect(() =>
      parseSidecarRpcResult('env.createOutputDir', { ok: false, detail: '' }),
    ).toThrow(/directory-creation detail/)
  })

  it('requires the exact step identities', () => {
    expect(
      parseSidecarRpcResult('pipeline.listSteps', stepDescriptors()),
    ).toEqual(stepDescriptors())
    const mismatched = stepDescriptors()
    mismatched[4] = { ...mismatched[4]!, id: 3 }
    expect(() =>
      parseSidecarRpcResult('pipeline.listSteps', mismatched),
    ).toThrow(/aligned/)
    expect(() =>
      parseSidecarRpcResult('pipeline.listSteps', stepDescriptors().slice(1)),
    ).toThrow(/every pipeline step/)
  })

  it('validates workflow plans including Input QC blockers', () => {
    const parsed = parseSidecarRpcResult(
      'pipeline.planWorkflow',
      workflowResult(),
    ) as Record<string, unknown>
    expect(parsed).not.toHaveProperty('privateState')
    expect(parsed.plan).not.toHaveProperty('scientificEvidence')
    expect(parsed).toMatchObject({
      disposition: 'planned',
      plan: { blockers: [{ kind: 'input-qc' }] },
    })
    const invalid = workflowResult()
    invalid.plan.nodes[0]!.status = 'invented'
    expect(() =>
      parseSidecarRpcResult('pipeline.runWorkflow', invalid),
    ).toThrow(/workflow node status/)
  })

  it('accepts the runtime and integrity blocker kinds the sidecar adds while planning', () => {
    // The sidecar's _sync_runtime_blockers labels a blocked node's reason
    // with these two kinds; rejecting them drops the whole plan.
    for (const kind of ['runtime', 'integrity']) {
      const result = workflowResult()
      result.plan.blockers = [{ key: 'recon', reason: 'blocked', kind }]
      expect(
        parseSidecarRpcResult('pipeline.planWorkflow', result),
      ).toMatchObject({ plan: { blockers: [{ kind }] } })
    }
    const invalid = workflowResult()
    invalid.plan.blockers = [{ key: 'recon', reason: 'x', kind: 'invented' }]
    expect(() =>
      parseSidecarRpcResult('pipeline.planWorkflow', invalid),
    ).toThrow(/stage blocker kind/)
  })

  it('keeps the plan advisories and refuses unbounded ones', () => {
    const advised = workflowResult() as ReturnType<typeof workflowResult> & {
      plan: { advisories?: unknown }
    }
    advised.plan.advisories = [
      'Brain-PAD statistics pool all sites; site Ingenia has no controls.',
    ]
    expect(
      parseSidecarRpcResult('pipeline.planWorkflow', advised),
    ).toMatchObject({
      plan: {
        advisories: [
          'Brain-PAD statistics pool all sites; site Ingenia has no controls.',
        ],
      },
    })
    expect(
      (
        parseSidecarRpcResult('pipeline.planWorkflow', workflowResult()) as {
          plan: Record<string, unknown>
        }
      ).plan,
    ).not.toHaveProperty('advisories')
    for (const invalid of ['text', [''], [7], Array(65).fill('fact')]) {
      advised.plan.advisories = invalid
      expect(() =>
        parseSidecarRpcResult('pipeline.planWorkflow', advised),
      ).toThrow(/workflow advisor/)
    }
  })

  it('keeps the per-subject reuse forecast and refuses a malformed one', () => {
    const forecast = {
      nodeId: '090-enigma-cohort',
      stepKey: 'enigma',
      computedSubjectIds: ['sub-009'],
      reusedSubjectIds: ['sub-001'],
      sourceRunIds: ['run-8407b948c62b'],
    }
    const planned = workflowResult() as ReturnType<typeof workflowResult> & {
      plan: { unitReuse?: unknown }
    }
    planned.plan.unitReuse = [forecast]
    expect(
      parseSidecarRpcResult('pipeline.planWorkflow', planned),
    ).toMatchObject({ plan: { unitReuse: [forecast] } })
    expect(
      (
        parseSidecarRpcResult('pipeline.planWorkflow', workflowResult()) as {
          plan: Record<string, unknown>
        }
      ).plan,
    ).not.toHaveProperty('unitReuse')
    for (const invalid of [
      'text',
      [{ ...forecast, stepKey: 'Enigma' }],
      [{ ...forecast, reusedSubjectIds: ['sub-009'] }],
      Array(65).fill(forecast),
    ]) {
      planned.plan.unitReuse = invalid
      expect(() =>
        parseSidecarRpcResult('pipeline.planWorkflow', planned),
      ).toThrow(/per-subject reuse/)
    }
  })

  it('keeps the affected subjects of a blocker that reports them', () => {
    const withSubjects = workflowResult()
    withSubjects.plan.blockers = [
      {
        key: 'clinical',
        kind: 'cohort',
        reason: 'Prepare Clinical merge. Assign registry roles to sub-001.',
        action: 'open-registry',
        subjects: ['sub-001', 'sub-002'],
        subjectCount: 2,
      },
    ] as never
    expect(
      parseSidecarRpcResult('pipeline.planWorkflow', withSubjects),
    ).toMatchObject({
      plan: {
        blockers: [
          {
            action: 'open-registry',
            subjects: ['sub-001', 'sub-002'],
            subjectCount: 2,
          },
        ],
      },
    })

    const duplicated = workflowResult()
    duplicated.plan.blockers = [
      { ...withSubjects.plan.blockers[0]!, subjects: ['sub-001', 'sub-001'] },
    ] as never
    expect(() =>
      parseSidecarRpcResult('pipeline.planWorkflow', duplicated),
    ).toThrow(/unique entries in stage blocker subjects/)

    const fractional = workflowResult()
    fractional.plan.blockers = [
      { ...withSubjects.plan.blockers[0]!, subjectCount: 1.5 },
    ] as never
    expect(() =>
      parseSidecarRpcResult('pipeline.planWorkflow', fractional),
    ).toThrow(/stage blocker subject count/)
  })

  it('binds complete runtime snapshots to one project generation', () => {
    const parsed = parseSidecarRpcResult(
      'runtime.bootstrap',
      runtimeSnapshot(),
    ) as { jobs: Array<Record<string, unknown>> }
    expect(parsed.jobs[0]).not.toHaveProperty('privateProcessState')
    const invalid = runtimeSnapshot()
    invalid.jobs[0]!.sidecarGeneration = 4
    expect(() => parseSidecarRpcResult('runtime.bootstrap', invalid)).toThrow(
      /identity/,
    )
    const missingAcknowledgements = runtimeSnapshot()
    missingAcknowledgements.runs[0]!.acknowledgements = {} as never
    expect(() =>
      parseSidecarRpcResult('runtime.bootstrap', missingAcknowledgements),
    ).toThrow(/true or false/)
  })

  it('parses the nodes behind a run summary quoted reason and treats an absent field as none', () => {
    const node = {
      stepKey: 'recon',
      subjectId: 'sub-902',
      status: 'blocked',
      reason: 'Choose a fresh derivatives namespace.',
    }
    const listed = runtimeSnapshot() as ReturnType<typeof runtimeSnapshot> & {
      runs: Array<{ quotedReasonNodes?: unknown }>
    }
    listed.runs[0]!.quotedReasonNodes = [
      { ...node, privateField: 'dropped' },
      { ...node, subjectId: null, status: 'withheld' },
    ]
    const parsed = parseSidecarRpcResult('runtime.bootstrap', listed) as {
      runs: Array<Record<string, unknown>>
    }
    expect(parsed.runs[0]!.quotedReasonNodes).toEqual([
      node,
      { ...node, subjectId: null, status: 'withheld' },
    ])
    // A run whose reason quotes no node carries no nodes.
    expect(
      (
        parseSidecarRpcResult('runtime.bootstrap', runtimeSnapshot()) as {
          runs: Array<Record<string, unknown>>
        }
      ).runs[0],
    ).not.toHaveProperty('quotedReasonNodes')

    const malformed: unknown[] = [
      [{ ...node, stepKey: 'unknown-step' }],
      [{ ...node, subjectId: '' }],
      [{ ...node, status: 'done' }],
      [{ ...node, reason: '' }],
      [{ ...node, reason: 'x'.repeat(8_193) }],
      ['sub-902'],
      node,
      null,
      Array.from({ length: 257 }, () => node),
    ]
    for (const quotedReasonNodes of malformed) {
      const invalid = runtimeSnapshot() as ReturnType<
        typeof runtimeSnapshot
      > & { runs: Array<{ quotedReasonNodes?: unknown }> }
      invalid.runs[0]!.quotedReasonNodes = quotedReasonNodes
      expect(() => parseSidecarRpcResult('runtime.bootstrap', invalid)).toThrow(
        TypeError,
      )
    }
  })

  it('parses bounded log replay coverage and treats an absent field as none', () => {
    const covered = runtimeSnapshot() as ReturnType<typeof runtimeSnapshot> & {
      logReplay?: unknown
    }
    covered.logReplay = [
      { runId: 'run-1', jobId: 'job-empty', lines: 0, complete: true },
      { runId: 'run-1', jobId: 'job-long', lines: 200, complete: false },
    ]
    expect(parseSidecarRpcResult('runtime.bootstrap', covered)).toMatchObject({
      logReplay: [
        { runId: 'run-1', jobId: 'job-empty', lines: 0, complete: true },
        { runId: 'run-1', jobId: 'job-long', lines: 200, complete: false },
      ],
    })
    // A snapshot without coverage reads no job log as empty.
    expect(
      parseSidecarRpcResult('runtime.bootstrap', runtimeSnapshot()),
    ).not.toHaveProperty('logReplay')

    const malformed: unknown[] = [
      [{ runId: 'run-1', jobId: 'job-1', lines: -1, complete: true }],
      [{ runId: 'run-1', jobId: 'job-1', lines: 1.5, complete: true }],
      [{ runId: 'run-1', jobId: 'job-1', lines: 0, complete: 'yes' }],
      [{ runId: '', jobId: 'job-1', lines: 0, complete: true }],
      [{ runId: 'run-1', lines: 0, complete: true }],
      ['job-1'],
      { runId: 'run-1', jobId: 'job-1', lines: 0, complete: true },
      null,
    ]
    for (const logReplay of malformed) {
      const invalid = runtimeSnapshot() as ReturnType<
        typeof runtimeSnapshot
      > & { logReplay?: unknown }
      invalid.logReplay = logReplay
      expect(() => parseSidecarRpcResult('runtime.bootstrap', invalid)).toThrow(
        TypeError,
      )
    }

    const unbounded = runtimeSnapshot() as ReturnType<
      typeof runtimeSnapshot
    > & { logReplay?: unknown }
    unbounded.logReplay = Array.from(
      { length: MAX_LOG_REPLAY_ENTRIES + 1 },
      (_, index) => ({
        runId: 'run-1',
        jobId: `job-${index}`,
        lines: 0,
        complete: true,
      }),
    )
    expect(() => parseSidecarRpcResult('runtime.bootstrap', unbounded)).toThrow(
      /bounded runtime log replay/,
    )
  })

  it('accepts canonical fractional manifest IDs and unknown recovery state', () => {
    const parsed = parseSidecarRpcResult(
      'manifest.forRun',
      manifest(),
    ) as Record<string, unknown>
    expect(parsed).not.toHaveProperty('scientificEvidence')
    expect(parsed).toMatchObject({
      recovery: { state: 'unknown' },
      steps: [{ id: 2.5, key: 'outliers' }],
    })
    const invalid = manifest()
    invalid.steps[0]!.id = 2
    expect(() => parseSidecarRpcResult('manifest.forRun', invalid)).toThrow(
      /aligned/,
    )
  })

  it('accepts a manifest that records every pipeline step', () => {
    // A run of all stages records 14 steps.
    const steps = STEP_KEYS.map((key, index) => ({
      id: STEP_IDS[index],
      key,
      status: 'done',
      subjects: 1,
      failed: 0,
      durationSec: 2,
    }))
    const parsed = parseSidecarRpcResult('manifest.forRun', {
      ...manifest(),
      steps,
    }) as { steps: unknown[] }
    expect(parsed.steps).toHaveLength(STEP_KEYS.length)
    expect(() =>
      parseSidecarRpcResult('manifest.forRun', {
        ...manifest(),
        steps: [...steps, steps[0]],
      }),
    ).toThrow('Provide a bounded run manifest.')
  })

  it('keeps the manifest product identity optional', () => {
    expect(
      parseSidecarRpcResult('manifest.forRun', manifest()),
    ).not.toHaveProperty('product')
    expect(
      parseSidecarRpcResult('manifest.forRun', {
        ...manifest(),
        product: { name: 'Supraspina', version: '20260920.1200.0' },
      }),
    ).toMatchObject({
      product: { name: 'Supraspina', version: '20260920.1200.0' },
    })
    expect(() =>
      parseSidecarRpcResult('manifest.forRun', {
        ...manifest(),
        product: { name: 'Supraspina', version: '' },
      }),
    ).toThrow('Provide a bounded manifest product version.')
  })

  it('keeps the build kind and the commit of the build that wrote a manifest', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567'
    expect(
      parseSidecarRpcResult('manifest.forRun', {
        ...manifest(),
        product: {
          name: 'Supraspina',
          version: '20261121.1830.0',
          build: 'development',
        },
        git: { repo: '', sha: commit, dirty: true },
      }),
    ).toMatchObject({
      product: {
        name: 'Supraspina',
        version: '20261121.1830.0',
        build: 'development',
      },
      git: { repo: '', sha: commit, dirty: true },
    })
    expect(
      parseSidecarRpcResult('manifest.forRun', {
        ...manifest(),
        product: { name: 'Supraspina', version: '20261121.1830.0' },
      }),
    ).not.toHaveProperty('product.build')
    expect(() =>
      parseSidecarRpcResult('manifest.forRun', {
        ...manifest(),
        product: {
          name: 'Supraspina',
          version: '20261121.1830.0',
          build: 'nightly',
        },
      }),
    ).toThrow('Provide a supported manifest build kind.')
  })

  it('accepts a skipped manifest stage and rejects unknown stage states', () => {
    const skipped = manifest()
    skipped.steps[0]!.status = 'skipped'
    expect(parseSidecarRpcResult('manifest.forRun', skipped)).toMatchObject({
      steps: [{ key: 'outliers', status: 'skipped' }],
    })
    const invalid = manifest()
    invalid.steps[0]!.status = 'partial'
    expect(() => parseSidecarRpcResult('manifest.forRun', invalid)).toThrow(
      'Provide a supported manifest step status.',
    )
  })

  it('validates result receipt provenance and removes private artifact fields', () => {
    const parsed = parseSidecarRpcResult('results.list', resultPage()) as {
      items: Array<Record<string, unknown>>
    }
    expect(parsed.items[0]).not.toHaveProperty('privatePath')
    const invalid = resultPage()
    invalid.items[0]!.provenanceDetails.receipt.signatureValid = 'yes' as never
    expect(() => parseSidecarRpcResult('results.list', invalid)).toThrow(
      /true or false/,
    )
  })

  it("keeps a receipt's Reconstruction rerun and rejects a malformed one", () => {
    // The rerun must reach the renderer, not stay in the receipt JSON.
    const fallback = {
      kind: 'freesurfer-no-fix-ga',
      addedArguments: ['-no-fix-ga'],
      reason: 'label-cortex found no voxels matching id 1.',
      firstAttemptExitCode: 1,
    }
    const page = resultPage()
    const receipt = page.items[0]!.provenanceDetails.receipt as Record<
      string,
      unknown
    >
    receipt.executionFallback = fallback
    const parsed = parseSidecarRpcResult('results.list', page) as {
      items: Array<{
        provenanceDetails: { receipt: Record<string, unknown> }
      }>
    }
    expect(
      parsed.items[0]!.provenanceDetails.receipt.executionFallback,
    ).toEqual(fallback)
    receipt.executionFallback = null
    const none = parseSidecarRpcResult('results.list', page) as typeof parsed
    expect(
      none.items[0]!.provenanceDetails.receipt.executionFallback,
    ).toBeNull()
    receipt.executionFallback = { ...fallback, addedArguments: [] }
    expect(() => parseSidecarRpcResult('results.list', page)).toThrow(
      'Provide a valid receipt execution fallback.',
    )
  })

  it("keeps a receipt's per-subject reuse and rejects a malformed one", () => {
    const summary = {
      computedSubjectIds: ['sub-009'],
      reusedSubjectIds: ['sub-001'],
      sourceRunIds: ['run-8407b948c62b'],
    }
    const page = resultPage()
    const receipt = page.items[0]!.provenanceDetails.receipt as Record<
      string,
      unknown
    >
    receipt.unitReuse = summary
    const parsed = parseSidecarRpcResult('results.list', page) as {
      items: Array<{
        provenanceDetails: { receipt: Record<string, unknown> }
      }>
    }
    expect(parsed.items[0]!.provenanceDetails.receipt.unitReuse).toEqual(
      summary,
    )
    receipt.unitReuse = { ...summary, sourceRunIds: [] }
    expect(() => parseSidecarRpcResult('results.list', page)).toThrow(
      'Provide a valid receipt per-subject reuse.',
    )
  })

  it('keeps stage receipt currency and rejects a malformed stage entry', () => {
    const parsed = parseSidecarRpcResult('results.list', resultPage()) as {
      stageCurrency: Record<string, unknown>
    }
    expect(parsed.stageCurrency).toEqual({
      aggregate: { state: 'outdated', outdatedSubjectIds: [] },
      recon: { state: 'outdated', outdatedSubjectIds: ['sub-01'] },
    })
    const badState = resultPage()
    badState.stageCurrency.aggregate.state = 'fresh'
    expect(() => parseSidecarRpcResult('results.list', badState)).toThrow(
      /stage currency state/,
    )
    const badStep = resultPage() as Record<string, unknown>
    badStep.stageCurrency = {
      notAStep: { state: 'current', outdatedSubjectIds: [] },
    }
    expect(() => parseSidecarRpcResult('results.list', badStep)).toThrow(
      /pipeline step key/,
    )
  })

  it('keeps the analysis-cohort cause and change, and parses a page without them', () => {
    const page = resultPage() as Record<string, unknown>
    page.stageCurrency = {
      enigma: {
        state: 'outdated',
        outdatedSubjectIds: [],
        cause: 'analysis-cohort',
      },
      recon: { state: 'current', outdatedSubjectIds: [] },
    }
    page.analysisCohortChange = { cause: 'membership' }
    const parsed = parseSidecarRpcResult('results.list', page) as {
      stageCurrency: Record<string, unknown>
      analysisCohortChange: unknown
    }
    expect(parsed.stageCurrency).toEqual({
      enigma: {
        state: 'outdated',
        outdatedSubjectIds: [],
        cause: 'analysis-cohort',
      },
      recon: { state: 'current', outdatedSubjectIds: [] },
    })
    expect(parsed.stageCurrency.recon).not.toHaveProperty('cause')
    expect(parsed.analysisCohortChange).toEqual({ cause: 'membership' })
    page.analysisCohortChange = null
    expect(parseSidecarRpcResult('results.list', page)).toMatchObject({
      analysisCohortChange: null,
    })

    const without = parseSidecarRpcResult('results.list', resultPage())
    expect(without).not.toHaveProperty('analysisCohortChange')
  })

  it('keeps the reasons that changed the analysis membership', () => {
    const page = resultPage() as Record<string, unknown>
    const reasons = [
      { kind: 'subjects-added', subjectIds: ['sub-004'], count: 1 },
      { kind: 'config-exclusion', subjectIds: [], count: 0 },
      {
        kind: 't1-changed',
        subjectIds: Array.from({ length: 20 }, (_, i) => `sub-${i + 100}`),
        count: 31,
      },
    ]
    page.analysisCohortChange = { cause: 'membership', reasons }
    expect(parseSidecarRpcResult('results.list', page)).toMatchObject({
      analysisCohortChange: { cause: 'membership', reasons },
    })

    const reject = (value: unknown, message: RegExp): void => {
      page.analysisCohortChange = { cause: 'membership', reasons: value }
      expect(() => parseSidecarRpcResult('results.list', page)).toThrow(message)
    }
    reject([{ kind: 'renamed', subjectIds: [], count: 0 }], /reason/)
    reject(
      [
        { kind: 't1-changed', subjectIds: ['sub-001'], count: 1 },
        { kind: 't1-changed', subjectIds: ['sub-002'], count: 1 },
      ],
      /each analysis-cohort reason once/,
    )
    reject(
      [{ kind: 't1-changed', subjectIds: ['sub-001', 'sub-002'], count: 1 }],
      /bounded analysis-cohort reason/,
    )
    reject(
      [
        {
          kind: 't1-changed',
          subjectIds: Array.from({ length: 21 }, (_, i) => `sub-${i}`),
          count: 21,
        },
      ],
      /bounded analysis-cohort reason/,
    )
    reject(
      [{ kind: 'subjects-added', subjectIds: [], count: 2 }],
      /bounded analysis-cohort reason/,
    )
    reject([{ kind: 't1-changed', subjectIds: [], count: -1 }], /count/)
    reject('t1-changed', /analysis-cohort change reasons/)
  })

  it('rejects an unknown stage cause or analysis-cohort change', () => {
    const badCause = resultPage() as Record<string, unknown>
    badCause.stageCurrency = {
      enigma: { state: 'outdated', outdatedSubjectIds: [], cause: 'config' },
    }
    expect(() => parseSidecarRpcResult('results.list', badCause)).toThrow(
      /stage currency cause/,
    )
    const badChange = resultPage() as Record<string, unknown>
    for (const cause of ['verdicts', 'qc-verdicts']) {
      badChange.analysisCohortChange = { cause }
      expect(() => parseSidecarRpcResult('results.list', badChange)).toThrow(
        /analysis-cohort change cause/,
      )
    }
    badChange.analysisCohortChange = 'membership'
    expect(() => parseSidecarRpcResult('results.list', badChange)).toThrow(
      /analysis-cohort change/,
    )
  })

  it('validates registry import results and rejects malformed issues', () => {
    const result = {
      applied: false,
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: [{ row: 2, message: 'Enter an age from 0 to 130 years.' }],
      warnings: [{ row: null, message: 'Review the ambiguous cohort label.' }],
      errorTotal: 1,
      warningTotal: 1,
    }
    expect(parseSidecarRpcResult('registry.importCsv', result)).toEqual(result)
    expect(() =>
      parseSidecarRpcResult('registry.importCsv', {
        ...result,
        errors: [{ row: 0, message: 'Provide a subjectId.' }],
      }),
    ).toThrow(/1-based/)
    expect(() =>
      parseSidecarRpcResult('registry.importCsv', {
        ...result,
        applied: 'yes',
      }),
    ).toThrow(/true or false/)
    expect(() =>
      parseSidecarRpcResult('registry.importCsv', {
        ...result,
        errorTotal: -1,
      }),
    ).toThrow(/non-negative/)
  })

  it('requires method-specific terminal shapes', () => {
    expect(
      parseSidecarRpcResult('provision.pybrainage', {
        operationId: 'provision-012345abcdef',
      }),
    ).toEqual({ operationId: 'provision-012345abcdef' })
    expect(parseSidecarRpcResult('registry.remove', null)).toBeNull()
    expect(() =>
      parseSidecarRpcResult('registry.remove', { removed: true }),
    ).toThrow(/null/)
    expect(() => parseSidecarRpcResult('results.list', null)).toThrow(
      /result page/,
    )
  })

  it('rejects a malformed operation identity from every operation start', () => {
    const started = { operationId: 'install-012345abcdef' }
    expect(parseSidecarRpcResult('env.optInInstall', started)).toEqual(started)
    for (const method of [
      'env.optInInstall',
      'provision.pybrainage',
      'provision.synthstrip',
      'provision.fastsurfer',
      'managedResource.importOffline',
    ]) {
      expect(() =>
        parseSidecarRpcResult(method, { operationId: 'install-1' }),
      ).toThrow('Provide a canonical operation ID.')
      expect(() =>
        parseSidecarRpcResult(method, 'install-012345abcdef'),
      ).toThrow('Provide a valid operation result.')
    }
  })

  it('rejects an installation status whose phase and exit code disagree', () => {
    const status = { operations: [envInstallOperation()] }
    expect(parseSidecarRpcResult('env.installStatus', status)).toEqual(status)
    expect(() =>
      parseSidecarRpcResult('env.installStatus', { operations: null }),
    ).toThrow('Provide a bounded installation status.')
    expect(() =>
      parseSidecarRpcResult('env.installStatus', {
        operations: [{ ...envInstallOperation(), phase: 'done' }],
      }),
    ).toThrow('Provide an installation exit code that matches its phase.')
  })

  it('rejects an unsupported tool status value', () => {
    expect(parseSidecarRpcResult('env.toolStatus', toolStatus())).toEqual(
      toolStatus(),
    )
    expect(() =>
      parseSidecarRpcResult('env.toolStatus', {
        ...toolStatus(),
        items: 'freesurfer',
      }),
    ).toThrow('Provide a bounded tool status.')
    expect(() =>
      parseSidecarRpcResult('env.toolStatus', {
        ...toolStatus(),
        items: [{ id: 'freesurfer', label: 'FreeSurfer', status: 'unknown' }],
      }),
    ).toThrow('Provide a supported tool status value.')
    expect(() =>
      parseSidecarRpcResult('env.toolStatus', {
        ...toolStatus(),
        items: ['freesurfer'],
      }),
    ).toThrow('Provide a valid tool status item.')
  })

  it('rejects a provisioning status with a nonboolean readiness flag', () => {
    expect(
      parseSidecarRpcResult('provision.status', provisionStatus()),
    ).toEqual(provisionStatus())
    expect(() => parseSidecarRpcResult('provision.status', null)).toThrow(
      'Provide a valid provisioning status event.',
    )
    expect(() =>
      parseSidecarRpcResult('provision.status', {
        ...provisionStatus(),
        envReady: 'yes',
      }),
    ).toThrow('Set environment readiness to true or false.')
  })

  it('rejects a cancellation result that omits its terminal state', () => {
    for (const method of ['provision.cancel', 'managedResource.cancel']) {
      expect(parseSidecarRpcResult(method, cancelResult())).toEqual(
        cancelResult(),
      )
      expect(() =>
        parseSidecarRpcResult(method, { ...cancelResult(), terminal: 'no' }),
      ).toThrow('Set cancellation terminal state to true or false.')
      expect(() => parseSidecarRpcResult(method, 'accepted')).toThrow(
        'Provide a valid cancellation result.',
      )
    }
  })

  it('rejects a run cancellation with unbounded pending job identifiers', () => {
    expect(parseSidecarRpcResult('pipeline.cancelRun', cancelRun())).toEqual(
      cancelRun(),
    )
    expect(() =>
      parseSidecarRpcResult('pipeline.cancelRun', {
        ...cancelRun(),
        pendingJobIds: null,
      }),
    ).toThrow('Provide a valid run cancellation result.')
    expect(() =>
      parseSidecarRpcResult('pipeline.cancelRun', {
        ...cancelRun(),
        pendingJobIds: [''],
      }),
    ).toThrow('Provide a bounded pending job ID.')
  })

  it('rejects a manifest page that is not a bounded item list', () => {
    const page = { items: [manifest()], nextCursor: null }
    const parsed = parseSidecarRpcResult('manifest.list', page) as {
      items: Array<Record<string, unknown>>
      nextCursor: string | null
    }
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]).not.toHaveProperty('scientificEvidence')
    expect(parsed.nextCursor).toBeNull()
    expect(() =>
      parseSidecarRpcResult('manifest.list', { items: null, nextCursor: null }),
    ).toThrow('Provide a bounded manifest page.')
    expect(() =>
      parseSidecarRpcResult('manifest.list', {
        items: Array.from({ length: 501 }, () => manifest()),
        nextCursor: null,
      }),
    ).toThrow('Provide a bounded manifest page.')
  })

  it('rejects a debug preview whose category is malformed', () => {
    expect(
      parseSidecarRpcResult('manifest.previewDebug', debugPreview()),
    ).toEqual(debugPreview())
    expect(() =>
      parseSidecarRpcResult('manifest.previewDebug', {
        ...debugPreview(),
        categories: null,
      }),
    ).toThrow('Provide a bounded debug-bundle preview.')
    expect(() =>
      parseSidecarRpcResult('manifest.previewDebug', {
        ...debugPreview(),
        categories: ['logs'],
      }),
    ).toThrow('Provide a valid debug-bundle category.')
    expect(() =>
      parseSidecarRpcResult('manifest.previewDebug', {
        ...debugPreview(),
        categories: [
          {
            ...debugPreview().categories[0],
            redactions: Array.from({ length: 65 }, () => 'Removed a path.'),
          },
        ],
      }),
    ).toThrow('Keep debug redactions bounded.')
  })

  it('rejects a debug bundle result without a canonical artifact identity', () => {
    const bundle = {
      artifactId: 'debug-bundle-1',
      displayPath: 'debug/run-1.zip',
    }
    expect(parseSidecarRpcResult('manifest.bundleDebug', bundle)).toEqual(
      bundle,
    )
    expect(() =>
      parseSidecarRpcResult('manifest.bundleDebug', 'debug/run-1.zip'),
    ).toThrow('Provide a valid debug-bundle result.')
    expect(() =>
      parseSidecarRpcResult('manifest.bundleDebug', {
        ...bundle,
        artifactId: '',
      }),
    ).toThrow('Provide a bounded debug artifact ID.')
  })

  it('rejects a registry record carrying an unsupported QC verdict', () => {
    expect(parseSidecarRpcResult('registry.upsert', registryRecord())).toEqual({
      ...registryRecord(),
      site: null,
    })
    expect(parseSidecarRpcResult('registry.list', [registryRecord()])).toEqual([
      { ...registryRecord(), site: null },
    ])
    expect(() =>
      parseSidecarRpcResult('registry.upsert', {
        ...registryRecord(),
        qc: 'unreviewed',
      }),
    ).toThrow('Provide a supported QC verdict.')
    expect(() =>
      parseSidecarRpcResult('registry.upsert', {
        ...registryRecord(),
        qcTags: 'motion',
      }),
    ).toThrow('Provide a valid registry record.')
    expect(() =>
      parseSidecarRpcResult('registry.list', { rows: [registryRecord()] }),
    ).toThrow('Provide a bounded registry list.')
  })

  it('reads a registry site, and a missing or null one as unset', () => {
    const [unset, cleared, prisma] = parseSidecarRpcResult('registry.list', [
      registryRecord(),
      { ...registryRecord(), subjectId: 'sub-002', site: null },
      { ...registryRecord(), subjectId: 'sub-003', site: 'Prisma 3T' },
    ]) as Array<{ site: string | null }>
    expect(unset?.site).toBeNull()
    expect(cleared?.site).toBeNull()
    expect(prisma?.site).toBe('Prisma 3T')
    for (const site of ['', ' Prisma', 'Prisma!', 'x'.repeat(65), 7]) {
      expect(() =>
        parseSidecarRpcResult('registry.upsert', { ...registryRecord(), site }),
      ).toThrow('Provide a valid registry site.')
    }
  })

  it('validates the registry.setSite result', () => {
    expect(
      parseSidecarRpcResult('registry.setSite', {
        site: 'Ingenia',
        updated: 6,
      }),
    ).toEqual({ site: 'Ingenia', updated: 6 })
    expect(
      parseSidecarRpcResult('registry.setSite', { site: null, updated: 0 }),
    ).toEqual({ site: null, updated: 0 })
    expect(() =>
      parseSidecarRpcResult('registry.setSite', { site: 'bad!', updated: 1 }),
    ).toThrow('Provide a valid site result.')
    expect(() =>
      parseSidecarRpcResult('registry.setSite', { site: null, updated: -1 }),
    ).toThrow('non-negative safe integer')
    expect(() =>
      parseSidecarRpcResult('registry.setSite', {
        site: null,
        updated: 20_001,
      }),
    ).toThrow('Provide a bounded site update count.')
    expect(() => parseSidecarRpcResult('registry.setSite', [])).toThrow(
      'Provide a valid site result.',
    )
  })

  it('validates the BrainCharts provisioning operation result', () => {
    expect(
      parseSidecarRpcResult('provision.braincharts', {
        operationId: 'provision-012345abcdef',
      }),
    ).toEqual({ operationId: 'provision-012345abcdef' })
    expect(() =>
      parseSidecarRpcResult('provision.braincharts', { operationId: 'x' }),
    ).toThrow('Provide a canonical operation ID.')
  })
})
