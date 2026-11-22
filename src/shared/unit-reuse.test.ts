import { describe, expect, it } from 'vitest'
import {
  imagesChangedText,
  parseImagesChangedSinceVerdict,
  parseUnitReuseForecast,
  parseUnitReuseSummary,
  unitReuseFact,
  type UnitReuseSummary,
} from './unit-reuse'

const SUMMARY: UnitReuseSummary = {
  computedSubjectIds: ['sub-909'],
  reusedSubjectIds: ['sub-901', 'sub-902'],
  sourceRunIds: ['run-8407b948c62b'],
}

describe('replaced-images evidence', () => {
  it('parses present evidence and treats absence as none', () => {
    expect(
      parseImagesChangedSinceVerdict({
        renderedRunId: 'run-8407b948c62b',
        reason: 'method-changed',
      }),
    ).toEqual({ renderedRunId: 'run-8407b948c62b', reason: 'method-changed' })
    expect(parseImagesChangedSinceVerdict(undefined)).toBeNull()
    expect(parseImagesChangedSinceVerdict(null)).toBeNull()
  })

  it.each([
    [{ renderedRunId: 'run-8407b948c62b', reason: 'no-record' }],
    [{ renderedRunId: 'elsewhere', reason: 'inputs-changed' }],
    [{ renderedRunId: 'run-8407b948c62b', reason: 'inputs-changed', x: 1 }],
    ['inputs-changed'],
  ])('rejects malformed evidence %#', (value) => {
    expect(() => parseImagesChangedSinceVerdict(value)).toThrow(TypeError)
  })

  it('states the cause as a fact and the review as an action', () => {
    expect(
      imagesChangedText({
        renderedRunId: 'run-8407b948c62b',
        reason: 'method-changed',
      }),
    ).toBe(
      'These images were rendered again in run-8407b948c62b after the recorded verdict because the rendering method changed. Review them again before relying on the verdict.',
    )
  })
})

describe('per-subject reuse summaries', () => {
  it('parses a job or receipt summary and copies it', () => {
    const parsed = parseUnitReuseSummary(SUMMARY)

    expect(parsed).toEqual(SUMMARY)
    expect(parsed.reusedSubjectIds).not.toBe(SUMMARY.reusedSubjectIds)
  })

  it('accepts any cohort subject ID, including one a unit record cannot name', () => {
    // The sidecar computes such a subject every run and lists it as computed.
    const summary = { ...SUMMARY, computedSubjectIds: ['sub-\u00e91'] }

    expect(parseUnitReuseSummary(summary).computedSubjectIds).toEqual([
      'sub-\u00e91',
    ])
  })

  it('parses a plan forecast with its node and stage', () => {
    expect(
      parseUnitReuseForecast({
        nodeId: '090-enigma-cohort',
        stepKey: 'enigma',
        ...SUMMARY,
      }),
    ).toEqual({ nodeId: '090-enigma-cohort', stepKey: 'enigma', ...SUMMARY })
  })

  it.each([
    ['a missing list', { computedSubjectIds: [], reusedSubjectIds: [] }],
    ['an extra key', { ...SUMMARY, units: {} }],
    ['an unsafe subject id', { ...SUMMARY, computedSubjectIds: ['../x'] }],
    ['a repeated subject', { ...SUMMARY, reusedSubjectIds: ['a', 'a'] }],
    [
      'a subject both computed and reused',
      { ...SUMMARY, computedSubjectIds: ['sub-901'] },
    ],
    ['a malformed run id', { ...SUMMARY, sourceRunIds: ['run-XYZ'] }],
    ['reused subjects without a source', { ...SUMMARY, sourceRunIds: [] }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseUnitReuseSummary(value)).toThrow(TypeError)
  })

  it('rejects a forecast without a stage', () => {
    expect(() =>
      parseUnitReuseForecast({ nodeId: 'n', stepKey: 'Enigma', ...SUMMARY }),
    ).toThrow(TypeError)
  })

  it('states what a finished stage did in the past tense', () => {
    expect(unitReuseFact(SUMMARY, 'past')).toBe(
      'Computed 1 subject and reused the verified output of 2 subjects from run-8407b948c62b.',
    )
    expect(
      unitReuseFact(
        { computedSubjectIds: ['a'], reusedSubjectIds: [], sourceRunIds: [] },
        'past',
      ),
    ).toBe('Computed 1 subject; no verified earlier output matched.')
  })

  it('states the computed and reused subjects as a fact', () => {
    expect(unitReuseFact(SUMMARY)).toBe(
      'Computes 1 subject and reuses the verified output of 2 subjects from run-8407b948c62b.',
    )
    expect(
      unitReuseFact({
        computedSubjectIds: ['a', 'b'],
        reusedSubjectIds: [],
        sourceRunIds: [],
      }),
    ).toBe('Computes 2 subjects; no verified earlier output matches.')
    expect(
      unitReuseFact({
        computedSubjectIds: [],
        reusedSubjectIds: ['a'],
        sourceRunIds: ['run-11111111', 'run-22222222'],
      }),
    ).toBe(
      'Computes no subjects and reuses the verified output of 1 subject from run-11111111 and run-22222222.',
    )
  })
})
