/** Renders the shared PyBrainAge setup confirmation and progress views. */

import { useEffect, useRef, type ReactNode } from 'react'
import { Code, ConfirmDialog, FONTS, statusColor, type Theme } from '../../ui'
import type { ProjectConfig } from '../../../shared/project-schema'
import type { PybrainageSetupState } from './pybrainage-setup'

/** The confirmation dialog for one authorized PyBrainAge setup. */
export interface PybrainageSetupDialogProps {
  t: Theme
  /** The configuration naming the output directory shown in the dialog. */
  cfg: ProjectConfig
  /** Disable authorization without Allow live runs and an open project. */
  authorizeDisabled: boolean
  onCancel: () => void
  onAuthorize: () => void
}

/** Confirm the pinned PyBrainAge setup before it is authorized. */
export function PybrainageSetupDialog({
  t,
  cfg,
  authorizeDisabled,
  onCancel,
  onAuthorize,
}: PybrainageSetupDialogProps): ReactNode {
  return (
    <ConfirmDialog
      t={t}
      title="Confirm PyBrainAge setup"
      message={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span>
            Setup requires Allow live runs. It creates or updates the pinned
            micromamba environment, downloads 108,063,062 bytes from the pinned
            Zenodo record, verifies the download&apos;s SHA-256, and extracts
            the model and scaler.
          </span>
          <Code
            t={t}
            kind="paths"
            value={`Environment: ${cfg.paths.outputDir}/.pybrainage/current/envs/pybrainage\nModel cache: ${cfg.paths.outputDir}/.pybrainage/current/pybrainage/v3`}
          />
          <span>
            Setup replaces or reuses files only inside those dedicated cache
            locations, and pipeline outputs outside the cache stay untouched. If
            you cancel setup, Supraspina requests cancellation immediately, and
            setup stops once the current bounded subprocess or extraction step
            reaches its cancellation boundary.
          </span>
          <span>
            After setup succeeds, Supraspina applies the exact verified Python,
            model, and scaler paths as unsaved project changes. Save the project
            to keep them.
          </span>
        </div>
      }
      onDismiss={onCancel}
      actions={[
        {
          label: 'Cancel',
          initialFocus: true,
          onSelect: onCancel,
        },
        {
          label: 'Authorize setup',
          tone: 'primary',
          disabled: authorizeDisabled,
          onSelect: onAuthorize,
        },
      ]}
    />
  )
}

/** One live PyBrainAge setup progress line. */
export interface PybrainageSetupProgressProps {
  t: Theme
  state: PybrainageSetupState
}

/**
 * Announce the live PyBrainAge setup progress.
 *
 * @returns The setup status line with the streamed output beneath it.
 */
export function PybrainageSetupProgress({
  t,
  state,
}: PybrainageSetupProgressProps): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        role="status"
        aria-live="polite"
        style={{
          fontFamily: FONTS.sans,
          fontSize: 11,
          // A canceled setup did not fail, so it takes the canceled tone.
          color:
            state.status === 'error'
              ? t.failed
              : state.status === 'cancelled'
                ? statusColor(t, 'cancelled')
                : state.status === 'done'
                  ? t.done
                  : t.running,
        }}
      >
        {state.percent !== null ? `${state.percent}% ` : ''}
        {state.message}
      </span>
      <PybrainageSetupLog t={t} lines={state.lines} />
    </div>
  )
}

/** The streamed output panel beneath the setup status line. */
export interface PybrainageSetupLogProps {
  t: Theme
  /** The bounded streamed lines in arrival order. */
  lines: string[]
}

/**
 * Show the streamed PyBrainAge setup output and follow its tail.
 *
 * Keep the panel scrolled to the newest line while the reader has not
 * scrolled up; stop following once they have, so a long install stays
 * readable.
 *
 * @returns The scrollable log panel, or null before the first line.
 */
export function PybrainageSetupLog({
  t,
  lines,
}: PybrainageSetupLogProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(true)
  useEffect(() => {
    const panel = panelRef.current
    if (panel && followRef.current) panel.scrollTop = panel.scrollHeight
  }, [lines])
  if (lines.length === 0) return null
  return (
    <div
      ref={panelRef}
      role="log"
      aria-label="PyBrainAge setup output"
      tabIndex={0}
      onScroll={(event) => {
        const panel = event.currentTarget
        followRef.current =
          panel.scrollHeight - panel.scrollTop - panel.clientHeight < 8
      }}
      style={{
        maxHeight: 220,
        overflow: 'auto',
        padding: '6px 8px',
        borderRadius: 6,
        border: `1px solid ${t.border}`,
        background: t.surface,
        fontFamily: FONTS.mono,
        fontSize: 11,
        lineHeight: 1.5,
        color: t.text,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {lines.map((line, index) => (
        <div key={index}>{line}</div>
      ))}
    </div>
  )
}
