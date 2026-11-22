import { createContext, useContext } from 'react'
import type { BoundaryIntent } from '../../shared/contract'

/** A native or renderer-owned project lifecycle boundary. */
export type RendererBoundaryIntent =
  | BoundaryIntent
  | 'new-project'
  | 'open-project'
  | 'open-recent'

/** Guarded project lifecycle transitions. */
export interface ProjectLifecycleValue {
  requestBoundary(
    intent: RendererBoundaryIntent,
    proceed: () => Promise<void> | void,
  ): void
}

/** Guarded project lifecycle transitions shared with renderer consumers. */
export const ProjectLifecycleContext =
  createContext<ProjectLifecycleValue | null>(null)

/** Use guarded project lifecycle transitions. */
export function useProjectLifecycle(): ProjectLifecycleValue {
  const value = useContext(ProjectLifecycleContext)
  if (!value) {
    return {
      requestBoundary: (_intent, proceed) => void Promise.resolve(proceed()),
    }
  }
  return value
}
