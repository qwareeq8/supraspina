import { describe, expect, it } from 'vitest'
import {
  parseInputFovListResult,
  parseInputFovReviewRequest,
  parseManagedResourceRequest,
  parseManagedResourceStatus,
} from './scientific-contracts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

describe('scientific IPC contract validation', () => {
  it('accepts a revision-bound brain-FOV review and rejects stale shapes', () => {
    const request = {
      subjectId: 'sub-0001',
      sessionId: 'ses-baseline',
      acquisitionId: 'acq-prisma',
      preflightSignature: HASH_A,
      sourceSha256: HASH_A,
      outputSha256: HASH_B,
      expectedRevision: 2,
      decision: 'approved',
    }

    expect(parseInputFovReviewRequest(request)).toEqual(request)
    expect(() =>
      parseInputFovReviewRequest({
        ...request,
        sourceSha256: 'not-a-hash',
      }),
    ).toThrow(/source SHA-256/)
    expect(() =>
      parseInputFovReviewRequest({ ...request, extra: true }),
    ).toThrow(/fields/)
    expect(() =>
      parseInputFovReviewRequest({ ...request, subjectId: '0001' }),
    ).toThrow(/subject ID/)
    expect(() =>
      parseInputFovReviewRequest({
        ...request,
        sessionId: `ses-${'a'.repeat(125)}`,
      }),
    ).toThrow(/session ID/)
    expect(() =>
      parseInputFovReviewRequest({
        ...request,
        acquisitionId: `acq-${'a'.repeat(125)}`,
      }),
    ).toThrow(/acquisition ID/)
    expect(
      parseInputFovReviewRequest({
        ...request,
        acquisitionId: null,
      }).acquisitionId,
    ).toBeNull()
    const missingIdentity: Record<string, unknown> = { ...request }
    delete missingIdentity.acquisitionId
    expect(() => parseInputFovReviewRequest(missingIdentity)).toThrow(/fields/)
    delete missingIdentity.sessionId
    expect(() => parseInputFovReviewRequest(missingIdentity)).toThrow(/fields/)
  })

  it('accepts only bounded brain-FOV list rows with opaque montage identities', () => {
    const value = {
      configRevision: 7,
      items: [
        {
          subjectId: 'sub-0001',
          sessionId: 'ses-01',
          acquisitionId: 'acq-prisma',
          preflightSignature: HASH_A,
          sourceSha256: HASH_A,
          outputSha256: HASH_B,
          passThrough: false,
          requiresReview: true,
          qcArtifactId: `input-fov-qc:${HASH_A}`,
          qcDisplayPath:
            'supraspina-brainfov/sub-0001/ses-01/anat/sub-0001_qc.png',
          review: {
            decision: 'approved',
            revision: 3,
            configRevision: 7,
            reviewedAt: '2026-07-30T12:00:00.000Z',
            decisionSignature: HASH_B,
            current: true,
          },
        },
      ],
    }

    expect(parseInputFovListResult(value)).toEqual(value)
    const incompleteItem = { ...value.items[0] } as Record<string, unknown>
    delete incompleteItem.sessionId
    expect(() =>
      parseInputFovListResult({ ...value, items: [incompleteItem] }),
    ).toThrow(/fields/)
    expect(() =>
      parseInputFovListResult({
        ...value,
        items: Array.from({ length: 5001 }, () => value.items[0]),
      }),
    ).toThrow(/within its item limit/)
    expect(() =>
      parseInputFovListResult({
        ...value,
        items: [{ ...value.items[0], qcDisplayPath: '/private/qc.png' }],
      }),
    ).toThrow(/display path/)
    expect(() =>
      parseInputFovListResult({
        ...value,
        items: [{ ...value.items[0], acquisitionId: 'prisma' }],
      }),
    ).toThrow(/acquisition ID/)
  })

  it('enforces valid managed-resource and variant pairs', () => {
    expect(
      parseManagedResourceRequest({
        resource: 'synthstrip',
        variant: 'cpu',
      }),
    ).toEqual({ resource: 'synthstrip', variant: 'cpu' })
    expect(
      parseManagedResourceRequest({
        resource: 'fastsurfer',
        variant: 'cuda',
      }),
    ).toEqual({ resource: 'fastsurfer', variant: 'cuda' })
    expect(() =>
      parseManagedResourceRequest({
        resource: 'synthstrip',
        variant: 'cuda',
      }),
    ).toThrow(/variant/)
  })

  it('rejects unbounded or internally inconsistent resource status', () => {
    const status = {
      resource: 'fastsurfer',
      variant: 'cpu',
      version: '2.5.4',
      state: 'ready',
      phase: 'idle',
      operationId: null,
      percent: null,
      cancellable: false,
      error: null,
    }

    expect(parseManagedResourceStatus(status)).toEqual(status)
    expect(() =>
      parseManagedResourceStatus({
        ...status,
        phase: 'pulling',
        operationId: null,
      }),
    ).toThrow(/operation/)
  })
})
