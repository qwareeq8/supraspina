/** Shares the authorized PyBrainAge setup flow across Diagnostics and Setup. */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useApp } from '../../state/context'
import { getApi } from '../../state/api'
import type { ProjectConfig } from '../../../shared/project-schema'
import type { ProjectRef } from '../../../shared/types'
import type { ProvisionProgress } from '../../../shared/contract'

/** Live progress of one PyBrainAge setup run. */
export interface PybrainageSetupState {
  message: string
  percent: number | null
  status: 'running' | 'done' | 'error' | 'cancelled'
  /**
   * The streamed setup output, bounded to the most recent lines, with the
   * adapter's step lines stated as {@link setupProgressText} states them.
   */
  lines: string[]
}

/** Keep only this many streamed setup lines in renderer memory. */
export const SETUP_LOG_LINE_LIMIT = 2000

/**
 * What each PyBrainAge setup step does, by the step key the adapter reports.
 * The adapter (`execute_provision` in
 * `sidecar/supraspina_sidecar/adapters/pybrainage.py`) reports each step it
 * starts as an order that names the key, such as "Run create_env.", and a
 * failed step as "Fix create_env after this failure: <message>". Its file is
 * bound into every receipt, so the text is restated here for display rather
 * than changed there.
 */
const SETUP_STEP_FACTS: ReadonlyMap<string, string> = new Map([
  ['check_micromamba', 'Checking micromamba'],
  ['create_env', 'Creating the locked environment'],
  ['install_pip_deps', 'Installing the pinned pip packages'],
  ['probe_runtime', 'Checking the runtime versions'],
  ['fetch_model', 'Fetching the model archive'],
  ['verify_model', 'Verifying the model archive'],
  ['extract_model', 'Extracting the model'],
  ['validate_pickle', 'Validating the model and scaler'],
  ['publish_generation', 'Publishing the verified setup'],
  ['record_state', 'Recording the setup state'],
])

/** The adapter's whole line for a step it starts. */
const SETUP_STEP_STARTED = /^Run (\w+)\.$/

/** The adapter's whole line for a failed step, with the failure's detail. */
const SETUP_STEP_FAILED = /^Fix (\w+) after this failure(?::\s*([\s\S]*)|\.)$/

/**
 * State a PyBrainAge setup message for display. The adapter's line for a step
 * it starts reads as what the step does, and its line for a failed step reads
 * as that step's failure with the adapter's detail after it. Any other
 * message, including a step key the adapter does not run, reads as written.
 *
 * @param message - A setup progress message or streamed output line.
 * @example
 * setupProgressText('Run create_env.') // "Creating the locked environment..."
 * setupProgressText('Fix fetch_model after this failure: HTTP 503')
 * // "Fetching the model archive failed: HTTP 503"
 */
export function setupProgressText(message: string): string {
  const started = SETUP_STEP_STARTED.exec(message)
  const startedFact = started && SETUP_STEP_FACTS.get(started[1] ?? '')
  if (startedFact) return `${startedFact}...`
  const failed = SETUP_STEP_FAILED.exec(message)
  const failedFact = failed && SETUP_STEP_FACTS.get(failed[1] ?? '')
  if (!failed || !failedFact) return message
  const detail = failed[2]?.trim() ?? ''
  return detail ? `${failedFact} failed: ${detail}` : `${failedFact} failed.`
}

/**
 * The sidecar's whole message for a setup the operator canceled. It reports
 * the cancellation in the error phase (`provisioning.py`), so the message is
 * what tells a cancellation from a failure.
 */
const SETUP_CANCELED_MESSAGE = 'PyBrainAge setup was canceled.'

/**
 * State the outcome of one setup progress event: a canceled setup reads as
 * canceled, not failed, and any other error as a failure.
 *
 * @example
 * setupProgressStatus({ phase: 'error', message: 'PyBrainAge setup was canceled.' })
 * // 'cancelled'
 */
export function setupProgressStatus(
  ev: Pick<ProvisionProgress, 'phase' | 'message'>,
): PybrainageSetupState['status'] {
  if (ev.phase === 'done') return 'done'
  if (ev.phase === 'error') {
    return ev.message === SETUP_CANCELED_MESSAGE ? 'cancelled' : 'error'
  }
  return 'running'
}

/**
 * Append one streamed line to a bounded setup log.
 *
 * @returns A new array holding at most SETUP_LOG_LINE_LIMIT lines.
 */
export function appendSetupLine(lines: string[], line: string): string[] {
  const next = lines.length >= SETUP_LOG_LINE_LIMIT ? lines.slice(1) : lines
  return [...next, line]
}

/** The verified paths a completed setup applies to the configuration. */
export interface ProvisionedPaths {
  pythonExecutable: string
  modelPath: string
  scalerPath: string
}

/** Apply verified provisioned PyBrainAge paths to a configuration. */
export function applyProvisionedPaths(
  cfg: ProjectConfig,
  paths: ProvisionedPaths,
): ProjectConfig {
  const step = cfg.steps.pybrainage
  return {
    ...cfg,
    pybrain: {
      modelPath: paths.modelPath,
      scalerPath: paths.scalerPath,
    },
    steps: {
      ...cfg.steps,
      pybrainage: {
        ...step,
        params: {
          ...step.params,
          pythonExecutable: paths.pythonExecutable,
          modelPath: '${pybrain.modelPath}',
          scalerPath: '${pybrain.scalerPath}',
        },
      },
    },
  }
}

/** Callbacks a screen supplies to host the PyBrainAge setup flow. */
export interface UsePybrainageSetupOptions {
  safeExecution: boolean
  /** Apply the verified provisioned paths after a completed setup. */
  onApplyProvisioned: (
    capturedCfg: ProjectConfig,
    paths: ProvisionedPaths,
  ) => void
  /** Run after a verified setup completes, for example refresh or reprobe. */
  onFinalized?: (() => void) | undefined
}

/** The setup flow state and actions the hook returns. */
export interface PybrainageSetup {
  /** Whether the confirmation dialog is open. */
  pending: boolean
  setPending: (open: boolean) => void
  /** The live setup progress, or null before the first run. */
  state: PybrainageSetupState | null
  /** Authorize and start the setup against the saved configuration. */
  run: () => void
}

/**
 * Host the authorized PyBrainAge setup flow for one screen.
 *
 * Preserve the authorize, confirm, progress, and reprobe sequence and the
 * saved-config gate: `run` refuses without Allow live runs, an open project,
 * and an unmodified saved configuration, and every request carries the saved
 * configuration and revision captured when the run starts.
 */
export function usePybrainageSetup(
  options: UsePybrainageSetupOptions,
): PybrainageSetup {
  const { projectRef, savedRevision, savedCfg, dirty } = useApp()
  const [pending, setPending] = useState(false)
  const [state, setState] = useState<PybrainageSetupState | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })

  const identityRef = useRef<{
    projectRef: ProjectRef | null
    savedRevision: number
  } | null>(null)
  useLayoutEffect(() => {
    identityRef.current = { projectRef, savedRevision }
    return () => {
      identityRef.current = null
    }
  }, [projectRef, savedRevision])

  // Tear down live provisioning subscriptions on unmount.
  useEffect(() => () => unsubRef.current?.(), [])

  const finalize = useCallback(
    async (
      captured: ProjectRef,
      capturedCfg: ProjectConfig,
      capturedRevision: number,
    ): Promise<void> => {
      try {
        const status = await getApi().provision.status({ project: captured })
        const latest = identityRef.current
        if (
          latest?.savedRevision !== capturedRevision ||
          latest.projectRef?.projectId !== captured.projectId ||
          latest.projectRef.epoch !== captured.epoch
        ) {
          return
        }
        if (
          status.projectId !== captured.projectId ||
          status.projectEpoch !== captured.epoch ||
          status.configRevision !== capturedRevision ||
          status.phase !== 'done' ||
          !status.envReady ||
          !status.modelReady ||
          !status.pythonExecutable ||
          !status.modelPath ||
          !status.scalerPath
        ) {
          throw new Error(
            'Retry provisioning until it returns a complete, revision-matched pinned runtime status.',
          )
        }
        optionsRef.current.onApplyProvisioned(capturedCfg, {
          pythonExecutable: status.pythonExecutable,
          modelPath: status.modelPath,
          scalerPath: status.scalerPath,
        })
        setState((prev) => ({
          message:
            'The PyBrainAge paths are applied as unsaved project changes; saving the project keeps them. The shared analysis Python is unchanged.',
          percent: 100,
          status: 'done',
          lines: prev?.lines ?? [],
        }))
        optionsRef.current.onFinalized?.()
      } catch (cause) {
        const latest = identityRef.current
        if (
          latest?.savedRevision === capturedRevision &&
          latest.projectRef?.projectId === captured.projectId &&
          latest.projectRef.epoch === captured.epoch
        ) {
          setState((prev) => ({
            message:
              cause instanceof Error
                ? cause.message
                : 'Apply the provisioned paths again.',
            percent: null,
            status: 'error',
            lines: prev?.lines ?? [],
          }))
        }
      }
    },
    [],
  )

  const run = useCallback((): void => {
    if (!optionsRef.current.safeExecution || !projectRef || dirty) return
    const captured = projectRef
    const capturedCfg = savedCfg
    const capturedRevision = savedRevision
    unsubRef.current?.()
    const api = getApi()
    setState({
      message: 'Starting PyBrainAge setup...',
      percent: 0,
      status: 'running',
      lines: [],
    })
    const subscriptions: Array<() => void> = []
    const off = (): void => {
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
    }
    unsubRef.current = off
    subscriptions.push(
      api.provision.onLog((ev) => {
        const latest = identityRef.current
        if (
          latest?.savedRevision !== capturedRevision ||
          latest.projectRef?.projectId !== captured.projectId ||
          latest.projectRef.epoch !== captured.epoch ||
          ev.projectId !== captured.projectId ||
          ev.projectEpoch !== captured.epoch
        )
          return
        setState((prev) =>
          prev
            ? {
                ...prev,
                lines: appendSetupLine(prev.lines, setupProgressText(ev.line)),
              }
            : prev,
        )
      }),
    )
    subscriptions.push(
      api.provision.onProgress((ev) => {
        const latest = identityRef.current
        if (
          latest?.savedRevision !== capturedRevision ||
          latest.projectRef?.projectId !== captured.projectId ||
          latest.projectRef.epoch !== captured.epoch ||
          ev.projectId !== captured.projectId ||
          ev.projectEpoch !== captured.epoch
        )
          return
        const status = setupProgressStatus(ev)
        setState((prev) => ({
          message: setupProgressText(ev.message),
          percent: ev.percent,
          status,
          lines: prev?.lines ?? [],
        }))
        if (ev.phase === 'done' || ev.phase === 'error') {
          off()
          unsubRef.current = null
          if (ev.phase === 'done') {
            void finalize(captured, capturedCfg, capturedRevision)
          }
        }
      }),
    )
    void api.execution
      .authorize({
        project: captured,
        configRevision: capturedRevision,
        purpose: 'provision',
      })
      .then((authorization) =>
        api.provision.pybrainage({
          project: captured,
          cfg: capturedCfg,
          configRevision: capturedRevision,
          authorization,
        }),
      )
      .catch((err: unknown) => {
        off()
        unsubRef.current = null
        const latest = identityRef.current
        if (
          latest?.savedRevision === capturedRevision &&
          latest.projectRef?.projectId === captured.projectId &&
          latest.projectRef.epoch === captured.epoch
        ) {
          setState((prev) => ({
            message: err instanceof Error ? err.message : String(err),
            percent: null,
            status: 'error',
            lines: prev?.lines ?? [],
          }))
        }
      })
  }, [projectRef, dirty, savedCfg, savedRevision, finalize])

  return { pending, setPending, state, run }
}
