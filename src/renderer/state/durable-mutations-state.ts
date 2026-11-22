import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import type { ProjectRef } from '../../shared/types'

/** A summary of pending and failed durable renderer mutations. */
export interface DurableMutationSnapshot {
  pendingCount: number
  failedCount: number
}

/** One project-scoped durable draft registered with the boundary coordinator. */
export interface DurableDraftRegistration {
  project: ProjectRef
  id: string
  /**
   * Change this revision whenever the draft payload changes, even while `dirty`
   * remains true. Prevent a completed save from clearing a newer edit.
   */
  revision: string
  dirty: boolean
  save: () => Promise<void>
  discard: () => void
}

/** Project-scoped durable mutation coordination. */
export interface DurableMutationsValue {
  /** Increment this notification token for reactive snapshot consumers. */
  revision: number
  registerDraft(registration: DurableDraftRegistration): () => void
  updateDraft(registration: DurableDraftRegistration): void
  enqueue(
    project: ProjectRef,
    id: string,
    operation: () => Promise<void>,
  ): Promise<void>
  snapshot(project: ProjectRef | null): DurableMutationSnapshot
  flush(project: ProjectRef): Promise<void>
  discard(project: ProjectRef): Promise<void>
}

const CLEAN_SNAPSHOT: DurableMutationSnapshot = {
  pendingCount: 0,
  failedCount: 0,
}

const FALLBACK: DurableMutationsValue = {
  revision: 0,
  registerDraft: () => () => undefined,
  updateDraft: () => undefined,
  enqueue: async (_project, _id, operation) => operation(),
  snapshot: () => CLEAN_SNAPSHOT,
  flush: async () => undefined,
  discard: async () => undefined,
}

/** Durable mutation coordination shared with renderer consumers. */
export const DurableMutationsContext =
  createContext<DurableMutationsValue | null>(null)

/** Use durable mutation coordination. */
export function useDurableMutations(): DurableMutationsValue {
  return useContext(DurableMutationsContext) ?? FALLBACK
}

/**
 * Register renderer-owned draft state with the project boundary coordinator.
 *
 * Read callbacks through a ref so a pending boundary saves the latest payload
 * instead of the render that first registered the draft.
 *
 * @param registration - The draft to register, or null to unregister the
 *   current one.
 */
export function useDurableDraft(
  registration: DurableDraftRegistration | null,
): void {
  const mutations = useDurableMutations()
  const registerDraft = mutations.registerDraft
  const updateDraft = mutations.updateDraft
  const latest = useRef(registration)
  useLayoutEffect(() => {
    latest.current = registration
  }, [registration])
  const projectKey = registration
    ? `${registration.project.projectId}\u0000${registration.project.root}\u0000${registration.project.configPath}\u0000${registration.project.epoch}`
    : ''
  const id = registration?.id ?? ''
  const dirty = registration?.dirty ?? false
  const revision = registration?.revision ?? ''

  const stable = useMemo<DurableDraftRegistration | null>(() => {
    if (!registration) return null
    return {
      ...registration,
      save: async () => {
        const current = latest.current
        if (!current) return
        await current.save()
      },
      discard: () => latest.current?.discard(),
    }
    // Define registration lifetime with project identity and ID. Read mutable
    // payload state from `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, id])

  useLayoutEffect(() => {
    if (!stable) return undefined
    return registerDraft(stable)
  }, [registerDraft, stable])

  useLayoutEffect(() => {
    const current = latest.current
    if (!current) return
    updateDraft({
      ...current,
      save: stable?.save ?? current.save,
      discard: stable?.discard ?? current.discard,
    })
  }, [updateDraft, projectKey, id, dirty, revision, stable])
}
