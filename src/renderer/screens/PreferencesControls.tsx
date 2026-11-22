/**
 * Shares preference controls across Settings and onboarding. Switch names stay
 * constant, and state is encoded through ARIA, position, and color without
 * layout shifts.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  Bar,
  Btn,
  FONTS,
  Hint,
  ICONS,
  Ico,
  InfoTip,
  Segments,
  Toggle,
  type Theme,
} from '../ui'
import { getApi } from '../state/api'
import { useUpdateStatus } from '../state/use-update-status'
import {
  updateIsPending,
  updateStatusLine,
  useUpdateCheck,
} from './update-status'
import { releasePageUrl } from '../../shared/releases'
import type { Tweaks } from '../state/context'
import type {
  WindowPlacementPreference,
  WindowPlacementState,
} from '../../shared/contract'

/**
 * Pair one preference control with its label on one row. An explanation sits
 * behind an info tip after the label.
 */
export function AxisRow({
  t,
  label,
  desc,
  children,
}: {
  t: Theme
  label: string
  /** Explanation shown in the info tip after the label. */
  desc?: string
  children: ReactNode | ((descriptionId?: string) => ReactNode)
}): ReactNode {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const labelId = `preference-axis-${generatedId}-label`
  const descriptionId = desc
    ? `preference-axis-${generatedId}-description`
    : undefined
  const control =
    typeof children === 'function' ? children(descriptionId) : children

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, 200px) auto',
        justifyContent: 'start',
        alignItems: 'center',
        columnGap: 16,
        minHeight: 28,
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: t.text,
          fontFamily: FONTS.sans,
        }}
      >
        <span id={labelId}>{label}</span>
        {desc && (
          <InfoTip
            t={t}
            text={desc}
            label={`About ${label}`}
            {...(descriptionId ? { tooltipId: descriptionId } : {})}
          />
        )}
      </span>
      {control}
    </div>
  )
}

interface TweakControlsProps {
  t: Theme
  tweaks: Tweaks
  onChange: (patch: Partial<Tweaks>) => void
}

/** Render machine-local display and behavior preferences. */
export function DisplayBehaviorControls({
  t,
  tweaks,
  onChange,
}: TweakControlsProps): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <AxisRow t={t} label="Theme">
        {(descriptionId) => (
          <Segments
            t={t}
            small
            ariaLabel="Theme"
            ariaDescribedBy={descriptionId}
            value={tweaks.theme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={(v) => onChange({ theme: v as Tweaks['theme'] })}
          />
        )}
      </AxisRow>
      <AxisRow t={t} label="Density">
        {(descriptionId) => (
          <Segments
            t={t}
            small
            ariaLabel="Density"
            ariaDescribedBy={descriptionId}
            value={tweaks.density}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'cozy', label: 'Cozy' },
              { value: 'comfortable', label: 'Comfortable' },
            ]}
            onChange={(v) => onChange({ density: v as Tweaks['density'] })}
          />
        )}
      </AxisRow>
      <AxisRow
        t={t}
        label="Failure emphasis"
        desc="Whisper keeps failures quiet, Notice adds an alert, and Triage lists failed subjects first."
      >
        {(descriptionId) => (
          <Segments
            t={t}
            small
            ariaLabel="Failure emphasis"
            ariaDescribedBy={descriptionId}
            value={tweaks.failureEmphasis}
            options={[
              { value: 'whisper', label: 'Whisper' },
              { value: 'notice', label: 'Notice' },
              { value: 'triage', label: 'Triage' },
            ]}
            onChange={(v) =>
              onChange({ failureEmphasis: v as Tweaks['failureEmphasis'] })
            }
          />
        )}
      </AxisRow>
      <AxisRow
        t={t}
        label="QC tone"
        desc="Shell is a terminal-style QC view, and Notebook is a lab-notebook layout. Both show the same data."
      >
        {(descriptionId) => (
          <Segments
            t={t}
            small
            ariaLabel="QC tone"
            ariaDescribedBy={descriptionId}
            value={tweaks.qcTone}
            options={[
              { value: 'shell', label: 'Shell' },
              { value: 'notebook', label: 'Notebook' },
            ]}
            onChange={(v) => onChange({ qcTone: v as Tweaks['qcTone'] })}
          />
        )}
      </AxisRow>
      <AxisRow
        t={t}
        label="Pipeline command previews"
        desc="Shows the exact command for each Pipeline step by default."
      >
        {(descriptionId) => (
          <Toggle
            t={t}
            checked={tweaks.showCommandHints}
            onChange={(v) => onChange({ showCommandHints: v })}
            ariaLabel="Pipeline command previews"
            ariaDescribedBy={descriptionId}
          />
        )}
      </AxisRow>
    </div>
  )
}

/**
 * Name the select option that stands for a stored preference. With one
 * display connected the list offers no numbered display, because that
 * display is the primary one, so a stored display choice shows as Primary
 * display, which is where the window opens. The stored value is unchanged.
 */
function placementValue(
  preference: WindowPlacementPreference,
  singleDisplay: boolean,
): string {
  if (preference.mode !== 'display') return preference.mode
  return singleDisplay ? 'primary' : preference.displayId
}

/** Control main-process window placement with safe display descriptors. */
export function WindowPlacementControls({ t }: { t: Theme }): ReactNode {
  const [state, setState] = useState<WindowPlacementState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    const api = getApi().windowPlacement
    const unsubscribe = api.onTopologyChanged((next) => {
      if (live) {
        setState(next)
        setError('')
      }
    })
    void api
      .getState()
      .then((next) => {
        if (live) setState(next)
      })
      .catch((reason: unknown) => {
        if (live) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  const setPreference = (value: string): void => {
    const preference: WindowPlacementPreference =
      value === 'remember' || value === 'primary'
        ? { mode: value }
        : { mode: 'display', displayId: value }
    setBusy(true)
    setError('')
    void getApi()
      .windowPlacement.setPreference(preference)
      .then(setState)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false))
  }

  const act = (action: () => Promise<WindowPlacementState | void>): void => {
    setBusy(true)
    setError('')
    void action()
      .then((next) => {
        if (next) setState(next)
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false))
  }

  // One connected display is the primary display, so a numbered option
  // for it would repeat Primary display.
  const singleDisplay = state !== null && state.displays.length <= 1
  const options = [
    { value: 'remember', label: 'Remember last position' },
    { value: 'primary', label: 'Primary display' },
    ...(singleDisplay
      ? []
      : (state?.displays.map((display) => ({
          value: display.id,
          label: `Display ${display.number}`,
        })) ?? [])),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AxisRow
        t={t}
        label="Startup placement"
        desc="Where the window opens at launch."
      >
        {(descriptionId) => (
          // A select holds one option per connected display on one line at
          // any card width.
          <select
            aria-label="Startup window placement"
            aria-describedby={descriptionId}
            value={
              state
                ? placementValue(state.preference, singleDisplay)
                : 'remember'
            }
            onChange={(event) => setPreference(event.target.value)}
            style={{
              height: 28,
              maxWidth: '100%',
              padding: '0 6px',
              border: `1px solid ${t.dim}`,
              borderRadius: 4,
              background: t.bg,
              color: t.text,
              fontFamily: FONTS.sans,
              fontSize: 12,
            }}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </AxisRow>

      {state && state.displays.length > 1 && (
        <ul
          aria-label="Connected displays"
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 260px))',
            gap: 8,
          }}
        >
          {state.displays.map((display) => (
            <li
              key={display.id}
              title={`Work area ${display.workArea.width} x ${display.workArea.height} px${
                display.label ? `, ${display.label}` : ''
              }`}
              style={{
                border: `1px solid ${
                  display.id === state.resolvedDisplayId
                    ? t.accentLine
                    : t.border
                }`,
                borderRadius: 5,
                background: t.surface2,
                padding: 8,
                fontFamily: FONTS.sans,
                fontSize: 11,
                color: t.textSoft,
              }}
            >
              <strong style={{ color: t.text }}>
                Display {display.number}
                {display.primary ? ' (primary)' : ''}
              </strong>
              <div>
                {display.resolution.width} x {display.resolution.height} px,{' '}
                {display.scaleFactor}x scale
              </div>
            </li>
          ))}
        </ul>
      )}

      {state?.fallbackReason === 'selected-display-unavailable' && (
        <div role="status" style={{ color: t.warning, fontSize: 12 }}>
          Reconnect {state.unavailableDisplayLabel ?? 'the selected display'} to
          use it again. Supraspina uses the primary display until it returns.
        </div>
      )}
      {error && (
        <div role="alert" style={{ color: t.failed, fontSize: 12 }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Btn
          t={t}
          small
          label="Identify displays"
          disabled={busy || !state}
          onClick={() => act(() => getApi().windowPlacement.identifyDisplays())}
        />
        <Btn
          t={t}
          small
          label="Move window now"
          disabled={busy || !state}
          onClick={() => act(() => getApi().windowPlacement.moveNow())}
        />
      </div>
    </div>
  )
}

/** Render machine-local accessibility preferences. */
export function AccessibilityControls({
  t,
  tweaks,
  onChange,
}: TweakControlsProps): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <AxisRow t={t} label="Larger text">
        {(descriptionId) => (
          <Segments
            t={t}
            small
            ariaLabel="Larger text"
            ariaDescribedBy={descriptionId}
            value={tweaks.textScale}
            options={[
              { value: '100', label: '100%' },
              { value: '115', label: '115%' },
              { value: '135', label: '135%' },
            ]}
            onChange={(v) => onChange({ textScale: v as Tweaks['textScale'] })}
          />
        )}
      </AxisRow>
      <AxisRow
        t={t}
        label="Reduced motion"
        desc="When off, Supraspina follows the system setting."
      >
        {(descriptionId) => (
          <Toggle
            t={t}
            checked={tweaks.reducedMotion}
            onChange={(v) => onChange({ reducedMotion: v })}
            ariaLabel="Reduced motion"
            ariaDescribedBy={descriptionId}
          />
        )}
      </AxisRow>
      <AxisRow
        t={t}
        label="High contrast"
        desc="Raises text and border contrast."
      >
        {(descriptionId) => (
          <Toggle
            t={t}
            checked={tweaks.highContrast}
            onChange={(v) => onChange({ highContrast: v })}
            ariaLabel="High contrast"
            ariaDescribedBy={descriptionId}
          />
        )}
      </AxisRow>
    </div>
  )
}

/** Render the Allow live runs switch as a labeled preference row. */
export function SafeExecutionControls({
  t,
  value,
  onChange,
}: {
  t: Theme
  value: boolean
  onChange: (next: boolean) => void
}): ReactNode {
  return (
    <AxisRow
      t={t}
      label="Allow live runs"
      desc="Off keeps runs as dry runs and blocks installs. Each live action still asks first."
    >
      {(descriptionId) => (
        <Toggle
          t={t}
          checked={value}
          onChange={onChange}
          ariaLabel="Allow live runs"
          ariaDescribedBy={descriptionId}
        />
      )}
    </AxisRow>
  )
}

const SKIPPED_VERSION_KEY = 'supraspinaSkippedVersion'

/**
 * Match update controls to packaging capability. Development stays inert, an
 * AppImage downloads and installs a confirmed update, and every other package
 * links the release page of a newer version.
 */
export function UpdatesControls({
  t,
  tweaks,
  onChange,
}: TweakControlsProps): ReactNode {
  const api = useMemo(() => getApi(), [])
  const status = useUpdateStatus()
  const { checking, check } = useUpdateCheck()
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [skipped, setSkipped] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SKIPPED_VERSION_KEY)
    } catch {
      return null
    }
  })

  const runUpdateAction = (action: () => Promise<unknown>): void => {
    setActionBusy(true)
    setActionError(null)
    void Promise.resolve()
      .then(action)
      .catch((cause: unknown) => {
        const raw = cause instanceof Error ? cause.message : String(cause)
        setActionError(
          raw
            .replace(/^Error invoking remote method '[^']*':\s*/, '')
            .replace(/^Error:\s*/, ''),
        )
      })
      .finally(() => setActionBusy(false))
  }

  const capability = status?.capability ?? 'noop'
  if (capability === 'noop') {
    return <Hint t={t}>Development builds get updates outside the app.</Hint>
  }

  const skipVersion = (): void => {
    if (!status?.version) return
    try {
      localStorage.setItem(SKIPPED_VERSION_KEY, status.version)
    } catch {
      // Keep the skip for this session when local storage is unavailable.
    }
    setSkipped(status.version)
  }

  const pending = updateIsPending(status) && status?.version !== skipped
  // The notes stay through the download, so the card keeps one height across
  // the pending phases.
  const notesShown = pending && Boolean(status?.releaseNotes)
  const updateFailed = status?.phase === 'error'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AxisRow
        t={t}
        label="Check automatically"
        desc="Checks GitHub Releases once a day at startup."
      >
        {(descriptionId) => (
          <Toggle
            t={t}
            checked={tweaks.autoUpdateCheck}
            onChange={(v) => onChange({ autoUpdateCheck: v })}
            ariaLabel="Check for updates automatically"
            ariaDescribedBy={descriptionId}
          />
        )}
      </AxisRow>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <Btn
          t={t}
          small
          label="Check for updates"
          onClick={check}
          disabled={
            checking ||
            actionBusy ||
            status?.phase === 'checking' ||
            status?.phase === 'downloading'
          }
        />
        {/* A failure is marked with the fail glyph and color, and announced
            at once; every other phase is a quiet status. */}
        <span
          role={updateFailed ? 'alert' : 'status'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: updateFailed ? t.failed : t.dim,
            fontFamily: FONTS.sans,
          }}
        >
          {updateFailed && <Ico d={ICONS.circleX} stroke={t.failed} />}
          {status ? updateStatusLine(status) : 'Loading the update status...'}
        </span>
      </div>
      {pending && status && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {notesShown && (
            <Hint t={t} style={{ whiteSpace: 'pre-wrap' }}>
              {status.releaseNotes}
            </Hint>
          )}
          {status.phase === 'downloading' ? (
            // Hold the action row's height so the card does not jump.
            <div
              style={{ minHeight: 28, display: 'flex', alignItems: 'center' }}
            >
              <Bar t={t} value={status.percent ?? 0} />
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {capability === 'full' && status.phase === 'available' && (
                <Btn
                  t={t}
                  small
                  secondary
                  label="Download update"
                  title="Downloads the AppImage from GitHub Releases and verifies its SHA-512 checksum."
                  onClick={() => runUpdateAction(() => api.update.download())}
                  disabled={actionBusy}
                />
              )}
              {capability === 'full' && status.phase === 'downloaded' && (
                <Btn
                  t={t}
                  small
                  secondary
                  label="Restart and install"
                  onClick={() => runUpdateAction(() => api.update.installNow())}
                  disabled={actionBusy}
                />
              )}
              {capability === 'notify' && (
                <Btn
                  t={t}
                  small
                  secondary
                  label="Open release page"
                  title="This package cannot update itself. Download the new version from its release page."
                  onClick={() =>
                    void api.external.openWeb({
                      url: releasePageUrl(status.version),
                      purpose: 'releases',
                    })
                  }
                />
              )}
              {status.phase === 'available' && (
                <Btn
                  t={t}
                  small
                  label="Skip this version"
                  onClick={skipVersion}
                />
              )}
            </div>
          )}
        </div>
      )}
      {actionError && (
        <span
          role="alert"
          style={{ color: t.failed, fontFamily: FONTS.sans, fontSize: 12 }}
        >
          {actionError}
        </span>
      )}
    </div>
  )
}
