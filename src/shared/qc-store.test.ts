import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyQcStore, isValidQcSubjectId, parseQcStore } from './qc-store'

const timestamp = '2026-07-23T12:00:00.000Z'
const reviewEvidence = {
  evidenceVersion: 1,
  reviewer: 'fixture-reviewer',
  reviewedAt: '2026-07-23T11:59:00.000Z',
  galleries: [
    {
      tab: 'subcortical',
      label: 'Subcortical QC gallery',
      displayPath: 'outputs/qc/subcortical.html',
      runId: 'run-1234abcd',
      receiptSha256: 'a'.repeat(64),
      openedAt: '2026-07-23T11:58:00.000Z',
    },
    {
      tab: 'internal',
      label: 'Cortical-internal QC gallery',
      displayPath: 'outputs/qc/internal.html',
      runId: 'run-1234abcd',
      receiptSha256: 'a'.repeat(64),
      openedAt: '2026-07-23T11:58:10.000Z',
    },
    {
      tab: 'external',
      label: 'Cortical-external QC gallery',
      displayPath: 'outputs/qc/external.html',
      runId: 'run-1234abcd',
      receiptSha256: 'a'.repeat(64),
      openedAt: '2026-07-23T11:58:20.000Z',
    },
  ],
} as const
const record = {
  verdict: 'fail',
  note: 'Retain this failure across every edit and restart.',
  tags: ['motion'],
  reviewEvidence,
  revision: 4,
  updatedAt: timestamp,
} as const

function fixture(name: string): unknown {
  const bytes = readFileSync(
    resolve(process.cwd(), 'fixtures', 'qc-store', name),
    'utf8',
  )
  return JSON.parse(bytes) as unknown
}

describe('QC store schema', () => {
  it('parses the exact canonical schema', () => {
    const parsed = parseQcStore(fixture('canonical.json'))

    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.verdicts['sub-01']).toEqual(record)
  })

  it.each([
    null,
    [],
    { schemaVersion: 3, verdicts: {} },
    { schemaVersion: 1, verdicts: {} },
    { schemaVersion: 2, verdicts: {}, extra: true },
    { verdicts: {}, 'sub-01': record },
    { schemaVersion: 2, verdicts: { 'sub-01': { ...record, revision: '3' } } },
    {
      schemaVersion: 2,
      verdicts: { 'sub-01': { ...record, verdict: 'unreviewed' } },
    },
    { schemaVersion: 2, verdicts: { 'sub-01': { ...record, tags: 'motion' } } },
    {
      schemaVersion: 2,
      verdicts: { 'sub-01': { ...record, updatedAt: 'yesterday' } },
    },
    { schemaVersion: 2, verdicts: { '../escape': record } },
    {
      schemaVersion: 2,
      verdicts: { 'sub-01': { ...record, reviewEvidence: null } },
    },
    fixture('unversioned.json'),
    fixture('invalid-revision.json'),
    fixture('wrong-shape.json'),
  ])(
    'rejects unversioned, malformed, and semantically invalid data',
    (value) => {
      expect(() => parseQcStore(value)).toThrow()
    },
  )

  it('creates an empty canonical document without a prototype map', () => {
    const empty = emptyQcStore()

    expect(empty.schemaVersion).toBe(2)
    expect(Object.keys(empty.verdicts)).toEqual([])
    expect(Object.getPrototypeOf(empty.verdicts)).toBeNull()
  })

  it.each(['', '.', '..', '../sub-01', 'sub/01', 'sub\\01', 'sub..01'])(
    'rejects unsafe subject ID %s',
    (value) => {
      expect(isValidQcSubjectId(value)).toBe(false)
    },
  )

  it('applies every text limit by Unicode code point like Python', () => {
    const astral = String.fromCodePoint(0x1f600)
    const bounded = parseQcStore({
      schemaVersion: 2,
      verdicts: {
        [astral.repeat(128)]: {
          ...record,
          note: astral.repeat(4_096),
          tags: [astral.repeat(64)],
        },
      },
    })

    expect(Object.keys(bounded.verdicts)).toHaveLength(1)
    expect(isValidQcSubjectId(astral.repeat(129))).toBe(false)
    expect(() =>
      parseQcStore({
        schemaVersion: 2,
        verdicts: {
          'sub-01': { ...record, note: astral.repeat(4_097) },
        },
      }),
    ).toThrow()
  })

  it('rejects ISO-shaped year zero timestamps like Python', () => {
    expect(() =>
      parseQcStore({
        schemaVersion: 1,
        verdicts: {
          'sub-01': {
            ...record,
            updatedAt: '0000-01-01T00:00:00.000Z',
          },
        },
      }),
    ).toThrow()
  })
})
