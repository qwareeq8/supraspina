import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ProjectRef } from '../../shared/types'
import {
  DurableMutationsContext,
  type DurableDraftRegistration,
  type DurableMutationsValue,
} from './durable-mutations-state'

interface DraftEntry extends DurableDraftRegistration {
  registered: boolean
}

interface QueuedOperation {
  revision: number
  run: () => Promise<void>
}

interface Waiter {
  revision: number
  resolve: () => void
  reject: (cause: unknown) => void
}

interface MutationSlot {
  project: ProjectRef
  id: string
  nextRevision: number
  latest: QueuedOperation | null
  running: Promise<void> | null
  failed: unknown | null
  waiters: Waiter[]
}

function projectKey(project: ProjectRef): string {
  return [
    project.projectId,
    project.root,
    project.configPath,
    String(project.epoch),
  ].join('\u0000')
}

function scopedKey(project: ProjectRef, id: string): string {
  return `${projectKey(project)}\u0000${id}`
}

function sameProject(left: ProjectRef, right: ProjectRef): boolean {
  return projectKey(left) === projectKey(right)
}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The persistent write failed.'
}

/** Coordinate project-scoped durable drafts and queued writes. */
export function DurableMutationsProvider({
  children,
}: {
  children: ReactNode
}): ReactNode {
  const draftsRef = useRef(new Map<string, DraftEntry>())
  const slotsRef = useRef(new Map<string, MutationSlot>())
  const [revision, setRevision] = useState(0)

  const publish = useCallback(() => {
    setRevision((value) => value + 1)
  }, [])

  const startSlot = useCallback(
    (slot: MutationSlot): Promise<void> => {
      if (slot.running) return slot.running
      slot.running = (async () => {
        while (slot.latest) {
          const current = slot.latest
          slot.latest = null
          slot.failed = null
          publish()
          try {
            await current.run()
          } catch (cause: unknown) {
            // Preserve the newest desired operation for explicit retry. Retry the failed
            // operation only when no newer operation arrived.
            if (!slot.latest) slot.latest = current
            slot.failed = new Error(messageFor(cause))
            const waiters = slot.waiters.splice(0)
            for (const waiter of waiters) waiter.reject(slot.failed)
            break
          }
          const completed = slot.waiters.filter(
            (waiter) => waiter.revision <= current.revision,
          )
          slot.waiters = slot.waiters.filter(
            (waiter) => waiter.revision > current.revision,
          )
          for (const waiter of completed) waiter.resolve()
        }
      })().finally(() => {
        slot.running = null
        if (!slot.latest && !slot.failed && slot.waiters.length === 0) {
          slotsRef.current.delete(scopedKey(slot.project, slot.id))
        }
        publish()
      })
      publish()
      return slot.running
    },
    [publish],
  )

  const registerDraft = useCallback<DurableMutationsValue['registerDraft']>(
    (registration) => {
      const key = scopedKey(registration.project, registration.id)
      draftsRef.current.set(key, { ...registration, registered: true })
      publish()
      return () => {
        const current = draftsRef.current.get(key)
        if (!current) return
        if (current.dirty) {
          draftsRef.current.set(key, { ...current, registered: false })
        } else {
          draftsRef.current.delete(key)
        }
        publish()
      }
    },
    [publish],
  )

  const updateDraft = useCallback<DurableMutationsValue['updateDraft']>(
    (registration) => {
      const key = scopedKey(registration.project, registration.id)
      const current = draftsRef.current.get(key)
      draftsRef.current.set(key, {
        ...registration,
        registered: current?.registered ?? true,
      })
      publish()
    },
    [publish],
  )

  const enqueue = useCallback<DurableMutationsValue['enqueue']>(
    (project, id, operation) => {
      const key = scopedKey(project, id)
      let slot = slotsRef.current.get(key)
      if (!slot) {
        slot = {
          project,
          id,
          nextRevision: 0,
          latest: null,
          running: null,
          failed: null,
          waiters: [],
        }
        slotsRef.current.set(key, slot)
      }
      const revision = ++slot.nextRevision
      slot.latest = { revision, run: operation }
      slot.failed = null
      const completion = new Promise<void>((resolve, reject) => {
        slot?.waiters.push({ revision, resolve, reject })
      })
      void startSlot(slot)
      publish()
      return completion
    },
    [publish, startSlot],
  )

  const snapshot = useCallback<DurableMutationsValue['snapshot']>((project) => {
    if (!project) return { pendingCount: 0, failedCount: 0 }
    let pendingCount = 0
    let failedCount = 0
    for (const draft of draftsRef.current.values()) {
      if (sameProject(draft.project, project) && draft.dirty) pendingCount += 1
    }
    for (const slot of slotsRef.current.values()) {
      if (!sameProject(slot.project, project)) continue
      if (slot.running || slot.latest || slot.failed) pendingCount += 1
      if (slot.failed) failedCount += 1
    }
    return { pendingCount, failedCount }
  }, [])

  const flush = useCallback<DurableMutationsValue['flush']>(
    async (project) => {
      const drafts = [...draftsRef.current.entries()].filter(
        ([, draft]) => sameProject(draft.project, project) && draft.dirty,
      )
      for (const [key, draft] of drafts) {
        const revision = draft.revision
        await draft.save()
        const current = draftsRef.current.get(key)
        if (current?.revision === revision) {
          if (current.registered) {
            draftsRef.current.set(key, { ...current, dirty: false })
          } else {
            draftsRef.current.delete(key)
          }
        }
      }

      while (true) {
        const slots = [...slotsRef.current.values()].filter((slot) =>
          sameProject(slot.project, project),
        )
        if (slots.length === 0) break
        for (const slot of slots) {
          if (slot.failed) slot.failed = null
          await startSlot(slot)
          if (slot.failed) throw slot.failed
        }
        const remaining = [...slotsRef.current.values()].filter(
          (slot) =>
            sameProject(slot.project, project) &&
            (slot.running || slot.latest || slot.failed),
        )
        if (remaining.length === 0) break
      }

      const unresolved = snapshot(project)
      if (unresolved.pendingCount > 0) {
        throw new Error(
          'Review the newer persistent edit before retrying the save.',
        )
      }
      publish()
    },
    [publish, snapshot, startSlot],
  )

  const discard = useCallback<DurableMutationsValue['discard']>(
    async (project) => {
      const running = [...slotsRef.current.values()]
        .filter(
          (slot) => sameProject(slot.project, project) && slot.running !== null,
        )
        .map((slot) => slot.running as Promise<void>)
      await Promise.all(running)

      for (const [key, draft] of draftsRef.current) {
        if (!sameProject(draft.project, project)) continue
        draft.discard()
        draftsRef.current.delete(key)
      }
      for (const [key, slot] of slotsRef.current) {
        if (!sameProject(slot.project, project)) continue
        const cause = new Error(
          'The operator discarded the persistent edit, so saving stopped.',
        )
        for (const waiter of slot.waiters.splice(0)) waiter.reject(cause)
        slotsRef.current.delete(key)
      }
      publish()
    },
    [publish],
  )

  const value = useMemo<DurableMutationsValue>(
    () => ({
      revision,
      registerDraft,
      updateDraft,
      enqueue,
      snapshot,
      flush,
      discard,
    }),
    [discard, enqueue, flush, registerDraft, revision, snapshot, updateDraft],
  )

  return (
    <DurableMutationsContext value={value}>{children}</DurableMutationsContext>
  )
}
