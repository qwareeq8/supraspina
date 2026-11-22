import { randomUUID } from 'node:crypto'
import type { BoundaryIntent, BoundaryRequest } from '../shared/contract'
import { BoundaryExpiredError } from '../shared/rpc-errors'

/** One renderer decision for a lifecycle boundary. */
export interface BoundaryResponse {
  requestId: string
  decision: 'proceed' | 'cancel'
  reason?: string
}

/** Boundary publication, crossing, and timeout behavior. */
export interface BoundaryCoordinatorOptions {
  emit(request: BoundaryRequest): void
  cross(intent: BoundaryIntent): Promise<void>
  timeoutMs?: number
}

interface PendingBoundary {
  request: BoundaryRequest
  promise: Promise<void>
  resolve: () => void
  reject: (reason: Error) => void
}

interface ActiveBoundary extends PendingBoundary {
  timer: ReturnType<typeof setTimeout>
  responding: boolean
}

const DEFAULT_BOUNDARY_TIMEOUT_MS = 30_000

/** An expired lifecycle boundary. */
export class BoundaryTimeoutError extends Error {
  readonly code = 'BOUNDARY_TIMEOUT'

  constructor() {
    super(
      'Retry because the boundary confirmation timed out; no changes were discarded.',
    )
    this.name = 'BoundaryTimeoutError'
  }
}

/** A serializer for lifecycle boundaries enforcing bounded renderer approval. */
export class BoundaryCoordinator {
  private active: ActiveBoundary | null = null
  private readonly queued: PendingBoundary[] = []
  private disposed = false
  private readonly timeoutMs: number

  constructor(private readonly options: BoundaryCoordinatorOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BOUNDARY_TIMEOUT_MS
  }

  request(intent: BoundaryIntent): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new Error(
          'Start the lifecycle coordinator before requesting a boundary.',
        ),
      )
    }
    if (this.active?.request.intent === intent) return this.active.promise
    const duplicate = this.queued.find((item) => item.request.intent === intent)
    if (duplicate) return duplicate.promise

    const request: BoundaryRequest = { requestId: randomUUID(), intent }
    let resolvePromise!: () => void
    let rejectPromise!: (reason: Error) => void
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const pending: PendingBoundary = {
      request,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    }
    if (this.active) this.queued.push(pending)
    else this.activate(pending)
    return promise
  }

  private activate(pending: PendingBoundary): void {
    if (this.disposed) {
      pending.reject(
        new Error(
          'Start the lifecycle coordinator before requesting a boundary.',
        ),
      )
      return
    }
    const timer = setTimeout(() => {
      const active = this.active
      if (!active || active.request.requestId !== pending.request.requestId)
        return
      this.finish(active, new BoundaryTimeoutError())
    }, this.timeoutMs)
    const active: ActiveBoundary = {
      ...pending,
      timer,
      responding: false,
    }
    this.active = active
    try {
      this.options.emit(active.request)
    } catch {
      this.finish(
        active,
        new Error('Present the boundary confirmation in the renderer.'),
      )
    }
  }

  private finish(active: ActiveBoundary, error?: Error): void {
    if (this.active !== active) return
    clearTimeout(active.timer)
    this.active = null
    if (error) active.reject(error)
    else active.resolve()
    const next = this.queued.shift()
    if (next) this.activate(next)
  }

  async respond(response: BoundaryResponse): Promise<void> {
    const active = this.active
    if (!active || active.request.requestId !== response.requestId) {
      // Report missing, stale, and already-used tokens as the same operator
      // fact. Treat this confirmation as no longer awaited.
      throw new BoundaryExpiredError()
    }
    if (active.responding)
      throw new Error('Wait for the current boundary response to settle.')
    active.responding = true
    clearTimeout(active.timer)

    if (response.decision === 'cancel') {
      this.finish(active)
      return
    }

    try {
      await this.options.cross(active.request.intent)
      this.finish(active)
    } catch (error) {
      const safeError =
        error instanceof Error
          ? error
          : new Error('Complete the requested boundary before continuing.')
      this.finish(active, safeError)
      throw safeError
    }
  }

  dispose(): void {
    this.disposed = true
    const active = this.active
    this.active = null
    const error = new Error(
      'Keep the lifecycle coordinator running until the boundary completes.',
    )
    if (active) {
      clearTimeout(active.timer)
      active.reject(error)
    }
    for (const pending of this.queued.splice(0)) pending.reject(error)
  }
}
