import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InputFovItem } from '../../shared/scientific-contracts'
import {
  cropInventory,
  cropsAwaitingApproval,
  forgetCropInventory,
  useCropInventoryGeneration,
} from './crop-inventory'

function crop(
  subjectId: string,
  decision: 'approved' | 'rejected' | null,
  options: { current?: boolean; passThrough?: boolean } = {},
): InputFovItem {
  const passThrough = options.passThrough ?? false
  return {
    subjectId,
    sessionId: null,
    acquisitionId: null,
    preflightSignature: `sig-${subjectId}-${String(decision)}`,
    sourceSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    passThrough,
    requiresReview: !passThrough,
    qcArtifactId: `qc-${subjectId}`,
    qcDisplayPath: `/p/${subjectId}.png`,
    review:
      decision === null
        ? null
        : {
            decision,
            revision: 1,
            configRevision: 0,
            reviewedAt: '2026-09-30T00:00:00Z',
            decisionSignature: 'c'.repeat(64),
            current: options.current ?? true,
          },
  }
}

afterEach(() => {
  forgetCropInventory()
})

describe('cropsAwaitingApproval', () => {
  it('counts a subject only when none of its crops clears it', () => {
    // A superseded publication stays in the inventory, but the planner
    // reads only the current one.
    const waiting = cropsAwaitingApproval([
      crop('sub-001', 'rejected'),
      crop('sub-001', 'approved'),
      crop('sub-002', null),
      crop('sub-003', 'approved', { current: false }),
      crop('sub-004', null),
      crop('sub-004', null, { passThrough: true }),
    ])
    expect([...waiting].sort()).toEqual(['sub-002', 'sub-003'])
  })
})

describe('cropInventory', () => {
  it('reads once per key and again after a failed read', async () => {
    const read = vi
      .fn<() => Promise<readonly InputFovItem[]>>()
      .mockRejectedValueOnce(new Error('The read failed.'))
      .mockResolvedValue([crop('sub-001', null)])

    await expect(cropInventory('a', read)).rejects.toThrow('The read failed.')
    await expect(cropInventory('a', read)).resolves.toHaveLength(1)
    await expect(cropInventory('a', read)).resolves.toHaveLength(1)
    expect(read).toHaveBeenCalledTimes(2)
    await cropInventory('b', read)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('reads the same key again once a review forgets the read', async () => {
    // Approving a crop changes the inventory but not its key.
    const read = vi
      .fn<() => Promise<readonly InputFovItem[]>>()
      .mockResolvedValueOnce([crop('sub-001', null)])
      .mockResolvedValue([crop('sub-001', 'approved')])

    expect(cropsAwaitingApproval(await cropInventory('a', read)).size).toBe(1)
    forgetCropInventory()
    expect(cropsAwaitingApproval(await cropInventory('a', read)).size).toBe(0)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('moves the key of a mounted reader when a review forgets the read', () => {
    // A decision that lands while Runs is open must read again.
    const { result } = renderHook(() => useCropInventoryGeneration())
    const before = result.current
    act(() => {
      forgetCropInventory()
    })
    expect(result.current).toBe(before + 1)
  })
})
