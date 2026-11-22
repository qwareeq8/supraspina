/**
 * The Input QC crop inventory that the Runs Reconstruction card reads, and
 * which of its subjects the planner still holds for a crop approval.
 */

import { useSyncExternalStore } from 'react'
import type { InputFovItem } from '../../shared/scientific-contracts'

/** One inventory read and the key it answers for. */
interface InventoryRead {
  key: string
  items: Promise<readonly InputFovItem[]>
}

/**
 * The newest read. inputFov.list hashes every publication's T1, crop and
 * montage on the sidecar's RPC thread, so one read serves every Runs visit
 * until its key changes (the project, the saved revision, or an ended run).
 */
let latest: InventoryRead | null = null

/**
 * Return the inventory for a key, reading it only when no read for that key
 * exists. A failed read is forgotten, so the next visit reads again.
 *
 * @param key - The project, saved revision, and ended runs.
 * @param read - The inventory from the sidecar.
 */
export function cropInventory(
  key: string,
  read: () => Promise<readonly InputFovItem[]>,
): Promise<readonly InputFovItem[]> {
  if (latest?.key === key) return latest.items
  const items = read()
  const entry = { key, items }
  latest = entry
  items.catch(() => {
    if (latest === entry) latest = null
  })
  return items
}

/** Count of forgotten reads, so a mounted reader can read again. */
let generation = 0
const listeners = new Set<() => void>()

/**
 * Forget the shared read. A crop review changes the inventory without
 * changing its key, so Input QC calls this after each recorded decision.
 */
export function forgetCropInventory(): void {
  latest = null
  generation += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Return the number of forgotten reads. Runs puts it in its read key, so a
 * review that lands while Runs is open, or after its read began, reads again.
 */
export function useCropInventoryGeneration(): number {
  return useSyncExternalStore(subscribe, () => generation)
}

/**
 * Name the subjects the planner holds for a crop approval. The planner reads
 * only the publication that matches a subject's current T1 and preflight
 * signature, while the inventory also keeps superseded publications, such as
 * those of an earlier margin. A subject counts only when none of its items is
 * pass-through or a current approval, so a stale item never holds Run; the
 * plan still names any blocker this misses.
 *
 * @returns The subject IDs whose crops wait for approval.
 */
export function cropsAwaitingApproval(
  items: readonly InputFovItem[],
): Set<string> {
  const cleared = new Set<string>()
  const reviewed = new Set<string>()
  for (const item of items) {
    if (
      item.passThrough ||
      !item.requiresReview ||
      (item.review?.current === true && item.review.decision === 'approved')
    ) {
      cleared.add(item.subjectId)
    } else {
      reviewed.add(item.subjectId)
    }
  }
  return new Set([...reviewed].filter((subjectId) => !cleared.has(subjectId)))
}
