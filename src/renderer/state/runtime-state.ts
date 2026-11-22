import { createContext, useContext } from 'react'
import type {
  ProvisionStatus,
  RunSnapshot,
  RuntimeLogLine,
  RuntimeLogReplay,
  RuntimeSnapshot,
  WorkflowSummary,
} from '../../shared/contract'
import type { Job } from '../../shared/types'

/**
 * What the last bootstrap replay read of each job log. It holds until the
 * next bootstrap; live log lines do not change it.
 */
export interface LogReplayCoverage {
  /** The replay's record per job log it opened, by {@link logReplayKey}. */
  entries: ReadonlyMap<string, RuntimeLogReplay>
  /**
   * The jobs the bootstrap snapshot listed, by {@link logReplayKey}: true
   * when the job had already finished then, so any line it wrote could
   * reach the tail only through the replay.
   */
  snapshotJobs: ReadonlyMap<string, boolean>
}

/**
 * Key one job for {@link LogReplayCoverage}.
 *
 * @param runId - The job's run ID, or null when it has none.
 */
export function logReplayKey(
  runId: string | null | undefined,
  jobId: string,
): string {
  return `${runId ?? ''}\u0000${jobId}`
}

/**
 * Project a bootstrap snapshot's replay coverage. A snapshot without it
 * carries no coverage, so no job log reads as empty.
 */
export function logReplayCoverage(
  snapshot: RuntimeSnapshot | null,
): LogReplayCoverage {
  if (!snapshot) return EMPTY_LOG_REPLAY
  return {
    entries: new Map(
      (snapshot.logReplay ?? []).map((entry) => [
        logReplayKey(entry.runId, entry.jobId),
        entry,
      ]),
    ),
    snapshotJobs: new Map(
      snapshot.jobs.map((job) => [
        logReplayKey(job.runId, job.id),
        job.endedAt !== null,
      ]),
    ),
  }
}

const EMPTY_LOG_REPLAY: LogReplayCoverage = {
  entries: new Map(),
  snapshotJobs: new Map(),
}

/** The durable scientific runtime state projected into the renderer. */
export interface RuntimeState {
  runs: RunSnapshot[]
  jobs: Job[]
  logs: RuntimeLogLine[]
  /** The last bootstrap's log replay coverage; see {@link LogReplayCoverage}. */
  logReplay: LogReplayCoverage
  provision: ProvisionStatus | null
  summary: WorkflowSummary | null
  hydrating: boolean
  error: string | null
  /**
   * Set this only after accepting a current-generation snapshot for the exact open
   * project. Keep project boundaries closed while this value is false.
   */
  authoritativeRuntimeKnown: boolean
  authorityState:
    | 'not-applicable'
    | 'pending'
    | 'known'
    | 'rejected'
    | 'unavailable'
  /** Request another bounded bootstrap without changing project authority. */
  retryHydration: () => void
  activeRuns: RunSnapshot[]
  activeJobs: Job[]
  activeCount: number
}

const EMPTY_RUNTIME: RuntimeState = {
  runs: [],
  jobs: [],
  logs: [],
  logReplay: EMPTY_LOG_REPLAY,
  provision: null,
  summary: null,
  hydrating: false,
  error: null,
  authoritativeRuntimeKnown: true,
  authorityState: 'not-applicable',
  retryHydration: () => undefined,
  activeRuns: [],
  activeJobs: [],
  activeCount: 0,
}

/** The durable scientific runtime projection shared with renderer consumers. */
export const RuntimeContext = createContext<RuntimeState | null>(null)

/**
 * Use the runtime projection, and return an inert snapshot in isolated screen tests.
 */
export function useRuntime(): RuntimeState {
  return useContext(RuntimeContext) ?? EMPTY_RUNTIME
}
