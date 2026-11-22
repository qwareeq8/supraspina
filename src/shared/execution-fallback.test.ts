import { describe, expect, it } from 'vitest'
import {
  executionFallbackDetail,
  executionFallbackFact,
  parseExecutionFallback,
} from './execution-fallback'

const TOPOLOGY_REASON =
  'mris_fix_topology crashed in the genetic surface topology fix (-ga), so ' +
  'recon-all reran with -no-fix-with-ga, which uses the non-genetic ' +
  'topology fixer.'
const GYRUS_REASON =
  'label-cortex found no voxels matching id 1 while filling the gyrus ' +
  'ambiens (--fix-ga), so recon-all reran with -no-fix-ga, as FreeSurfer ' +
  'advises.'

/** A single rerun as recon_fallback.fallback_record writes it. */
function singleFallback(): Record<string, unknown> {
  return {
    kind: 'freesurfer-no-fix-with-ga',
    addedArguments: ['-no-fix-with-ga'],
    reason: TOPOLOGY_REASON,
    firstAttemptExitCode: 134,
  }
}

/** Two composed reruns, in order. */
function composedFallback(): Record<string, unknown> {
  return {
    kind: 'freesurfer-no-fix-ga+freesurfer-no-fix-with-ga',
    addedArguments: ['-no-fix-ga', '-no-fix-with-ga'],
    reason: `${GYRUS_REASON} ${TOPOLOGY_REASON}`,
    firstAttemptExitCode: 1,
    reruns: [
      {
        kind: 'freesurfer-no-fix-ga',
        addedArguments: ['-no-fix-ga'],
        reason: GYRUS_REASON,
        attemptExitCode: 1,
      },
      {
        kind: 'freesurfer-no-fix-with-ga',
        addedArguments: ['-no-fix-with-ga'],
        reason: TOPOLOGY_REASON,
        attemptExitCode: 134,
      },
    ],
  }
}

describe('parseExecutionFallback', () => {
  it('keeps a single rerun and composed reruns exactly', () => {
    expect(parseExecutionFallback(singleFallback())).toEqual(singleFallback())
    expect(parseExecutionFallback(composedFallback())).toEqual(
      composedFallback(),
    )
  })

  it.each([
    ['a missing field', { ...singleFallback(), reason: undefined }],
    ['an extra field', { ...singleFallback(), note: 'x' }],
    ['an empty kind', { ...singleFallback(), kind: '' }],
    ['no flag', { ...singleFallback(), addedArguments: [] }],
    ['a flag that is not one', { ...singleFallback(), addedArguments: ['rm'] }],
    [
      'a fractional exit code',
      { ...singleFallback(), firstAttemptExitCode: 1.5 },
    ],
    [
      'a boolean exit code',
      { ...singleFallback(), firstAttemptExitCode: true },
    ],
    ['an unbounded reason', { ...singleFallback(), reason: 'x'.repeat(8_193) }],
    [
      'one composed rerun',
      {
        ...singleFallback(),
        reruns: [
          {
            kind: 'freesurfer-no-fix-with-ga',
            addedArguments: ['-no-fix-with-ga'],
            reason: TOPOLOGY_REASON,
            attemptExitCode: 134,
          },
        ],
      },
    ],
    [
      'a summary that does not restate its reruns',
      { ...composedFallback(), firstAttemptExitCode: 134 },
    ],
    [
      'reordered summary flags',
      {
        ...composedFallback(),
        addedArguments: ['-no-fix-with-ga', '-no-fix-ga'],
      },
    ],
    [
      'a repeated flag',
      {
        ...composedFallback(),
        kind: 'freesurfer-no-fix-ga+freesurfer-no-fix-ga',
        addedArguments: ['-no-fix-ga', '-no-fix-ga'],
        reason: `${GYRUS_REASON} ${GYRUS_REASON}`,
        reruns: [
          (composedFallback().reruns as unknown[])[0],
          (composedFallback().reruns as unknown[])[0],
        ],
      },
    ],
    ['an array', [singleFallback()]],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(() => parseExecutionFallback(value, 'job fallback')).toThrow(
      'Provide a valid job fallback.',
    )
  })
})

describe('execution fallback text', () => {
  it('states the flags as a fact and the reason with the first exit code', () => {
    const single = parseExecutionFallback(singleFallback())
    const composed = parseExecutionFallback(composedFallback())

    expect(executionFallbackFact(single)).toBe('Reran with -no-fix-with-ga')
    expect(executionFallbackFact(composed)).toBe(
      'Reran with -no-fix-ga and -no-fix-with-ga',
    )
    expect(executionFallbackDetail(single)).toBe(
      `${TOPOLOGY_REASON} The first attempt exited with code 134.`,
    )
    expect(executionFallbackDetail({ ...single, reason: 'No period' })).toBe(
      'No period. The first attempt exited with code 134.',
    )
    expect(executionFallbackFact({ addedArguments: ['-a', '-b', '-c'] })).toBe(
      'Reran with -a, -b and -c',
    )
  })
})
