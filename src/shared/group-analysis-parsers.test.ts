import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GROUP_ANALYSIS_ENGINE_ID,
  GROUP_ANALYSIS_RESULT_SCHEMA,
  GROUP_ANALYSIS_RNG_ID,
  parseGroupAnalysisInputs,
  parseGroupAnalysisList,
  parseGroupAnalysisResult,
  parseGroupAnalysisStatus,
  type GroupAnalysisSpec,
} from './group-analysis'

const SHA = 'a'.repeat(64)
const FIXTURE = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../sidecar/tests/fixtures/group_analysis/spec-v1-example.json',
    ),
    'utf8',
  ),
) as { spec: GroupAnalysisSpec; specDigest: string }

/** A stored result as the sidecar sends it, without the sample issues field. */
const RESULT = {
  schema: GROUP_ANALYSIS_RESULT_SCHEMA,
  schemaVersion: 1,
  resultId: 'gar-0123456789abcdef',
  specId: null,
  name: 'SCI vs CTRL',
  spec: FIXTURE.spec,
  specDigest: FIXTURE.specDigest,
  createdAt: '2026-09-30T12:00:00.000Z',
  engine: {
    id: GROUP_ANALYSIS_ENGINE_ID,
    rng: GROUP_ANALYSIS_RNG_ID,
    productVersion: '20261121.1830.0',
    build: null,
  },
  provisional: true,
  stageCurrency: { aggregate: 'current', pybrainage: 'current' },
  inputs: [],
  sample: { groups: [], included: 0, excluded: [] },
  rows: [],
  skipped: [],
  resultSha256: SHA,
}

function list(code: string): unknown {
  return {
    revision: 0,
    specs: [],
    sets: [],
    results: [
      {
        resultId: 'gar-0123456789abcdef',
        schemaVersion: 1,
        specId: null,
        name: 'SCI vs CTRL',
        analysis: 'group-comparison',
        specDigest: SHA,
        createdAt: '2026-09-30T12:00:00.000Z',
        measureCount: 1,
        significantCount: 0,
        groups: [],
        provisional: false,
        pinned: false,
        currency: 'stale',
        staleReasons: [{ code, added: 0, removed: 6, sources: [] }],
      },
    ],
  }
}

describe('stored result list', () => {
  it('accepts every stale reason the sidecar sends, and only those', () => {
    for (const code of [
      'inputs-changed',
      'qc-changed-sample',
      'registry-changed',
      'registration-changed',
      'engine-changed',
      'sample-too-small',
      'labels-changed',
    ]) {
      expect(
        parseGroupAnalysisList(list(code)).results[0]!.staleReasons[0]!.code,
      ).toBe(code)
    }
    expect(() => parseGroupAnalysisList(list('subjects-dropped'))).toThrow(
      /group-analysis list/,
    )
  })
})

describe('sample issues', () => {
  const ISSUE =
    'The ENIGMA outlier table is missing, so the outlier rule was not applied.'

  it('requires the issues of a resolved sample', () => {
    const inputs = {
      configRevision: 0,
      specDigest: SHA,
      subjects: [],
      groups: [],
      included: 0,
      registrationProvisional: false,
      inputs: [],
      skippedMeasures: [],
      issues: [ISSUE],
      designCheck: null,
    }
    expect(parseGroupAnalysisInputs(inputs).issues).toEqual([ISSUE])
    const { issues, ...without } = inputs
    void issues
    expect(() => parseGroupAnalysisInputs(without)).toThrow(
      /group-analysis sample/,
    )
  })

  it('reads a stored result without issues as none', () => {
    expect(parseGroupAnalysisResult(RESULT).sample.issues).toEqual([])
    expect(
      parseGroupAnalysisResult({
        ...RESULT,
        sample: { ...RESULT.sample, issues: [ISSUE] },
      }).sample.issues,
    ).toEqual([ISSUE])
  })
})

describe('compute status', () => {
  const operation = {
    operationId: 'gan-0123456789abcdef',
    state: 'failed',
    phase: null,
    completed: 0,
    total: 0,
    startedAt: '2026-09-30T12:00:00.000Z',
    finishedAt: '2026-09-30T12:00:01.000Z',
    message:
      'No selected measure could be fit: the measure was skipped because the values do not vary across subjects.',
    specDigest: SHA,
    resultId: null,
  }

  it('carries the skip reasons of a compute that fit nothing', () => {
    const skipped = [
      {
        measureId: 'aseg:5th-Ventricle',
        reason: 'The values do not vary across subjects.',
      },
    ]
    expect(
      parseGroupAnalysisStatus({ operation: { ...operation, skipped } })
        .operation?.skipped,
    ).toEqual(skipped)
    expect(
      parseGroupAnalysisStatus({ operation }).operation,
    ).not.toHaveProperty('skipped')
    expect(() =>
      parseGroupAnalysisStatus({
        operation: { ...operation, skipped: [{ measureId: 'x' }] },
      }),
    ).toThrow(/group-analysis status/)
  })
})
