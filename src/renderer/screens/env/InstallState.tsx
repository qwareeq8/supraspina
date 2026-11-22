/** Shows one gated installation identically in Diagnostics and Setup. */

import { useEffect, useState, type ReactNode } from 'react'
import { Chip, Code, FONTS, statusColor, type Theme } from '../../ui'
import { useReducedMotion } from '../../state/reduced-motion'
import type { EnvInstallState } from '../../../shared/contract'
import { isInstallSettled } from './env-install'

/** Format an elapsed millisecond span as mm:ss. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * Track wall-clock time for an installation that is still running.
 *
 * Tick once per second so the elapsed clock stays honest, and tick only once
 * under the shared reduced-motion policy, which either the OS preference or
 * the in-app tweak sets.
 */
function useElapsed(startedAt: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  const reduced = useReducedMotion()
  useEffect(() => {
    if (!active) return undefined
    if (reduced) {
      const once = window.setTimeout(() => setNow(Date.now()), 0)
      return () => window.clearTimeout(once)
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, reduced])
  return Math.max(0, now - startedAt)
}

/** One installation and the check that owns it. */
export interface EnvInstallViewProps {
  t: Theme
  /** The label of the check whose installer this operation runs. */
  label: string
  state: EnvInstallState
  /**
   * Word the operation as a rebuild of verified files already on this
   * machine instead of a package installation.
   */
  rebuild?: boolean
}

/**
 * Show one installation: its phase, the check that owns it, how long it has
 * run, and the output an operator needs to judge the outcome.
 */
export function EnvInstallView({
  t,
  label,
  state,
  rebuild = false,
}: EnvInstallViewProps): ReactNode {
  const settled = isInstallSettled(state)
  const elapsed = useElapsed(state.startedAt, !settled)
  if (!settled) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <Chip
            t={t}
            status={state.phase === 'queued' ? 'queued' : 'running'}
            label={state.phase === 'queued' ? 'Starting' : 'Running'}
            small
          />
          <span
            role="status"
            aria-live="polite"
            style={{
              fontFamily: FONTS.sans,
              fontSize: 12,
              fontWeight: 700,
              color: statusColor(t, 'running'),
            }}
          >
            {rebuild
              ? `Rebuilding ${label} from the verified files on this machine.`
              : `Running package installation for ${label}.`}
          </span>
          {/* Keep the per-second clock out of the live region so assistive
              technology announces the installation, not every tick. */}
          <span
            aria-hidden="true"
            style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.dim }}
          >
            {formatElapsed(elapsed)}
          </span>
        </div>
        {state.output && (
          <Code t={t} value={state.output} kind="output" maxHeight={140} />
        )}
      </div>
    )
  }
  const failed = state.phase === 'error'
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
          flexWrap: 'wrap',
        }}
      >
        {/* Announce a failed installation assertively, as ErrorState and
            ConfirmDialog do, and leave success on the polite channel. */}
        <span
          role={failed ? 'alert' : 'status'}
          style={{
            fontFamily: FONTS.sans,
            fontSize: 12,
            fontWeight: 700,
            color: failed ? statusColor(t, 'failed') : statusColor(t, 'done'),
          }}
        >
          {failed
            ? `The ${rebuild ? 'rebuild' : 'installation'} of ${label} failed.`
            : `${rebuild ? 'Rebuilt' : 'Installed'} ${label}.`}
        </span>
        <Chip
          t={t}
          status={failed ? 'failed' : 'done'}
          label={`rc=${state.rc ?? -1}`}
          mono
          small
          title="Return code 0 means success; any other value is an error."
        />
        <span
          style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.dim }}
          title="Time the installation ran on this host."
        >
          {formatElapsed(Math.max(0, state.updatedAt - state.startedAt))}
        </span>
      </div>
      {state.stdout && (
        <Code t={t} value={state.stdout} kind="stdout" maxHeight={140} />
      )}
      {state.stderr && (
        <div style={{ marginTop: 6 }}>
          <Code t={t} value={state.stderr} kind="stderr" maxHeight={140} />
        </div>
      )}
    </>
  )
}
