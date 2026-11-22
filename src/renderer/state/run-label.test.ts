import { describe, expect, it } from 'vitest'
import type { RunSnapshot } from '../../shared/contract'
import type { ManifestStep, RunManifest } from '../../shared/types'
import { TEXT_GAP } from '../ui/text-gap'
import {
  manifestRunLabel,
  manifestRunPhrase,
  manifestRunStatus,
  runTimestampLabel,
  snapshotRunLabel,
} from './run-label'

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-aaaaaaaa',
    startedAt: '2026-07-22T16:05:30.000Z',
    endedAt: null,
    user: 'operator',
    host: 'workstation',
    git: { repo: 'supraspina', sha: 'a'.repeat(40), dirty: false },
    configSha256: '0'.repeat(64),
    steps: [],
    tools: {},
    ...overrides,
  }
}

function step(overrides: Partial<ManifestStep> = {}): ManifestStep {
  return {
    id: 1,
    key: 'recon',
    status: 'running',
    subjects: 1,
    failed: 0,
    durationSec: 12,
    ...overrides,
  }
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'run-bbbbbbbb',
    projectId: 'project-1',
    projectEpoch: 1,
    status: 'cancelled',
    startedAt: Date.UTC(2026, 6, 22, 16, 5, 30),
    endedAt: null,
    dryRun: false,
    durable: true,
    acknowledgements: {
      includeDeferredAndUnreviewedQc: false,
      acknowledgeMemoryAdvisory: false,
    },
    summary: {
      planned: 2,
      started: 2,
      waiting: 0,
      blocked: 0,
      skipped: 0,
      message: 'Review the run.',
    },
    ...overrides,
  }
}

describe('runTimestampLabel', () => {
  it('should format ISO strings and epoch milliseconds identically', () => {
    const iso = runTimestampLabel('2026-07-22T16:05:30.000Z')
    const epoch = runTimestampLabel(Date.UTC(2026, 6, 22, 16, 5, 30))
    expect(iso).toBe(epoch)
  })

  it('should keep two same-minute timestamps distinguishable', () => {
    const first = runTimestampLabel('2026-07-22T16:05:10.000Z')
    const second = runTimestampLabel('2026-07-22T16:05:40.000Z')
    expect(first).not.toBe(second)
  })

  it('should report missing or invalid timestamps as unrecorded', () => {
    expect(runTimestampLabel(null)).toBe('an unrecorded time')
    expect(runTimestampLabel(undefined)).toBe('an unrecorded time')
    expect(runTimestampLabel('not-a-date')).toBe('an unrecorded time')
  })
})

describe('manifestRunStatus', () => {
  it('should keep blocked and withheld stages out of the completed state', () => {
    expect(
      manifestRunStatus(
        manifest({
          endedAt: '2026-07-22T17:05:30.000Z',
          steps: [step({ status: 'blocked' })],
        }),
      ),
    ).toBe('blocked')
    expect(
      manifestRunStatus(manifest({ steps: [step({ status: 'withheld' })] })),
    ).toBe('withheld')
  })

  it('should report interruption, cancellation, and failure before completion', () => {
    expect(
      manifestRunStatus(
        manifest({
          endedAt: '2026-07-22T17:05:30.000Z',
          recovery: { state: 'interrupted' },
          steps: [step({ status: 'done' })],
        }),
      ),
    ).toBe('interrupted')
    expect(
      manifestRunStatus(manifest({ steps: [step({ status: 'cancelled' })] })),
    ).toBe('canceled')
    expect(
      manifestRunStatus(
        manifest({
          endedAt: '2026-07-22T17:05:30.000Z',
          steps: [step({ status: 'done', failed: 2 })],
        }),
      ),
    ).toBe('failed')
  })

  it('should separate an unfinished run from a completed one', () => {
    expect(manifestRunStatus(manifest({ steps: [step()] }))).toBe('running')
    expect(
      manifestRunStatus(
        manifest({
          endedAt: '2026-07-22T17:05:30.000Z',
          steps: [step({ status: 'done' })],
        }),
      ),
    ).toBe('completed')
  })
})

describe('manifestRunLabel', () => {
  it('should compose the run window, status, intent, scope, and dry run', () => {
    const label = manifestRunLabel(
      manifest({
        endedAt: '2026-07-22T17:05:30.000Z',
        intent: 'workflow',
        dryRun: true,
        selectedSubset: { subjectIds: ['sub-001'], sha256: '0'.repeat(64) },
        steps: [step({ status: 'blocked' })],
      }),
    )
    expect(label).toBe(
      `${runTimestampLabel('2026-07-22T16:05:30.000Z')} to ${runTimestampLabel(
        '2026-07-22T17:05:30.000Z',
      )}${TEXT_GAP}blocked${TEXT_GAP}workflow${TEXT_GAP}1 subject${TEXT_GAP}dry run`,
    )
    expect(label).not.toContain('run-aaaaaaaa')
  })

  it('should omit the end time and the parts that are not recorded', () => {
    expect(manifestRunLabel(manifest())).toBe(
      `${runTimestampLabel('2026-07-22T16:05:30.000Z')}${TEXT_GAP}running`,
    )
  })

  it('should keep two same-minute manifests distinguishable', () => {
    const first = manifestRunLabel(
      manifest({ startedAt: '2026-07-22T16:05:10.000Z' }),
    )
    const second = manifestRunLabel(
      manifest({ startedAt: '2026-07-22T16:05:40.000Z' }),
    )
    expect(first).not.toBe(second)
  })
})

describe('manifestRunPhrase', () => {
  it('should name the run by start time and dry-run state only', () => {
    expect(manifestRunPhrase(manifest({ dryRun: true }))).toBe(
      `run started ${runTimestampLabel('2026-07-22T16:05:30.000Z')} (dry run)`,
    )
    expect(manifestRunPhrase(manifest())).not.toContain('run-aaaaaaaa')
  })
})

describe('snapshotRunLabel', () => {
  it('should name the run by status, start time, and scope without the id', () => {
    const label = snapshotRunLabel(
      snapshot({ selectedSubjectIds: ['sub-001', 'sub-002'] }),
    )
    expect(label).toBe(
      `canceled run started ${runTimestampLabel(
        Date.UTC(2026, 6, 22, 16, 5, 30),
      )} (2 subjects)`,
    )
    expect(label).not.toContain('run-bbbbbbbb')
  })

  it('should fall back to the analysis cohort and mark dry runs', () => {
    const label = snapshotRunLabel(
      snapshot({
        status: 'failed',
        dryRun: true,
        analysisSubjectIds: ['sub-001'],
      }),
    )
    expect(label).toBe(
      `failed run started ${runTimestampLabel(
        Date.UTC(2026, 6, 22, 16, 5, 30),
      )} (1 subject, dry run)`,
    )
  })

  it('should omit the scope suffix when no cohort is recorded', () => {
    const label = snapshotRunLabel(
      snapshot({ status: 'interrupted', startedAt: null }),
    )
    expect(label).toBe('interrupted run started an unrecorded time')
  })
})
