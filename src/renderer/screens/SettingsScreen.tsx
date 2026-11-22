/**
 * Leads with frequently edited machine preferences. About and read-only
 * project configuration are demoted, and project data ownership stays in the
 * shell.
 */

import { useCallback, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useApp } from '../state/context'
import type { Tweaks } from '../state/context'
import {
  Btn,
  Card,
  Chip,
  Code,
  ErrorState,
  Hint,
  Ico,
  ICONS,
  ICON_SIZE,
  LoadingState,
  Page,
  statusColor,
  type Theme,
} from '../ui'
import type { ProjectConfig } from '../../shared/project-schema'
import { AboutCard } from './AboutCard'
import {
  AccessibilityControls,
  DisplayBehaviorControls,
  SafeExecutionControls,
  UpdatesControls,
  WindowPlacementControls,
} from './PreferencesControls'

/** Project configuration and navigation actions for Settings. */
export interface SettingsScreenProps {
  cfg?: ProjectConfig
  safeExecution?: boolean
  onSafeExecutionChange?: (next: boolean) => void
  dirty?: boolean
}

type LoadState = 'loading' | 'ready' | 'error'

/** Render machine preferences and project reference information. */
export function SettingsScreen(props: SettingsScreenProps = {}): ReactNode {
  const { t, tweaks, setTweaks, resetTweaks, setRoute, cfg: appCfg } = useApp()

  // Prefer the shell-supplied configuration over provider state.
  const cfg = props.cfg ?? appCfg
  const cfgState: LoadState = cfg ? 'ready' : 'loading'

  // Let the shell control Allow live runs when it supplies a value.
  const isControlled = props.safeExecution !== undefined
  const [localSafe, setLocalSafe] = useState<boolean>(
    props.safeExecution ?? false,
  )
  const safeExecution = isControlled
    ? (props.safeExecution ?? false)
    : localSafe

  // Hide raw JSON initially so that the plain-language summary appears first.
  const [showJson, setShowJson] = useState(false)

  const handleSafeChange = useCallback(
    (next: boolean): void => {
      if (!isControlled) setLocalSafe(next)
      props.onSafeExecutionChange?.(next)
    },
    [isControlled, props],
  )

  const cfgJson = cfg ? JSON.stringify(cfg, null, 2) : ''

  return (
    <Page
      t={t}
      title="Settings"
      right={
        <Btn
          t={t}
          ghost
          small
          label="Reset preferences"
          title="Restores the default preferences on this computer."
          onClick={resetTweaks}
        />
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* Lead with the settings that operators change most often. One
            grid of two stacks keeps a card's growth, such as Updates with
            release notes, inside its own column. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <TweaksPane t={t} tweaks={tweaks} onChange={setTweaks} />
            <WindowPlacementPane t={t} />
            <AboutCard t={t} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <AccessibilityPane t={t} tweaks={tweaks} onChange={setTweaks} />
            <SafeExecutionPane
              t={t}
              value={safeExecution}
              onChange={handleSafeChange}
            />
            <UpdatesPane t={t} tweaks={tweaks} onChange={setTweaks} />
            <ConfigPane
              t={t}
              state={cfgState}
              error=""
              json={cfgJson}
              showJson={showJson}
              pathsBlank={pathsLookBlank(cfg)}
              onRetry={() => setRoute('wizard')}
              onOpenSetup={() => setRoute('wizard')}
              onToggleJson={() => setShowJson((v) => !v)}
            />
          </div>
        </div>
      </div>
    </Page>
  )
}

/** Reveal raw project JSON only from its read-only configuration card. */
function ConfigPane({
  t,
  state,
  error,
  json,
  showJson,
  pathsBlank,
  onRetry,
  onOpenSetup,
  onToggleJson,
}: {
  t: Theme
  state: LoadState
  error: string
  json: string
  showJson: boolean
  pathsBlank: boolean
  onRetry: () => void
  onOpenSetup: () => void
  onToggleJson: () => void
}): ReactNode {
  const jsonId = useId()
  const jsonShown = state === 'ready' && showJson
  return (
    <Card
      t={t}
      title="Configuration"
      action={
        <Btn
          t={t}
          small
          ghost
          label={showJson ? 'Hide JSON' : 'Show JSON'}
          onClick={onToggleJson}
          disabled={state !== 'ready'}
          ariaExpanded={jsonShown}
          ariaControls={jsonId}
        />
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Hint t={t} style={{ color: t.dim }}>
          Edit these values in Setup and Pipeline.
        </Hint>
        {state === 'ready' && pathsBlank && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              border: `1px solid ${t.border}`,
              background: t.surface2,
              borderRadius: 5,
              padding: 10,
            }}
          >
            <Hint t={t} style={{ color: t.dim }}>
              The input and derivatives data paths are empty, so no step can run
              yet.
            </Hint>
            <Btn
              t={t}
              small
              ghost
              icon={<Ico d={ICONS.sliders} size={ICON_SIZE.nav} />}
              label="Open Setup wizard"
              onClick={onOpenSetup}
            />
          </div>
        )}
        {state === 'loading' && (
          <LoadingState t={t} label="Loading the configuration..." />
        )}
        {state === 'error' && (
          <ErrorState
            t={t}
            title="Could not load the configuration."
            detail={error}
            onRetry={onRetry}
          />
        )}
        <div id={jsonId} hidden={!jsonShown}>
          {jsonShown && (
            <Code t={t} value={json} kind="json-config" maxHeight={420} />
          )}
        </div>
      </div>
    </Card>
  )
}

function pathLooksBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === ''
}

function pathsLookBlank(cfg: ProjectConfig | undefined): boolean {
  if (!cfg) return false
  const paths = cfg.paths
  if (!paths) return false
  return (
    pathLooksBlank(paths.rawdataDir) && pathLooksBlank(paths.derivativesDir)
  )
}

function SafeExecutionPane({
  t,
  value,
  onChange,
}: {
  t: Theme
  value: boolean
  onChange: (next: boolean) => void
}): ReactNode {
  return (
    <Card
      t={t}
      title="Execution"
      action={
        <Chip
          t={t}
          status={value ? 'warn' : 'skipped'}
          label={value ? 'On' : 'Off'}
          small
        />
      }
      style={{
        border: `1px solid ${value ? statusColor(t, 'warn') : t.borderSoft}`,
      }}
    >
      <SafeExecutionControls t={t} value={value} onChange={onChange} />
    </Card>
  )
}

function TweaksPane({
  t,
  tweaks,
  onChange,
}: {
  t: Theme
  tweaks: Tweaks
  onChange: (patch: Partial<Tweaks>) => void
}): ReactNode {
  return (
    <Card t={t} title="Display and behavior">
      <DisplayBehaviorControls t={t} tweaks={tweaks} onChange={onChange} />
    </Card>
  )
}

function WindowPlacementPane({ t }: { t: Theme }): ReactNode {
  return (
    <Card t={t} title="Window placement">
      <WindowPlacementControls t={t} />
    </Card>
  )
}

function AccessibilityPane({
  t,
  tweaks,
  onChange,
}: {
  t: Theme
  tweaks: Tweaks
  onChange: (patch: Partial<Tweaks>) => void
}): ReactNode {
  return (
    <Card t={t} title="Accessibility">
      <AccessibilityControls t={t} tweaks={tweaks} onChange={onChange} />
    </Card>
  )
}

function UpdatesPane({
  t,
  tweaks,
  onChange,
}: {
  t: Theme
  tweaks: Tweaks
  onChange: (patch: Partial<Tweaks>) => void
}): ReactNode {
  return (
    <Card t={t} title="Updates">
      <UpdatesControls t={t} tweaks={tweaks} onChange={onChange} />
    </Card>
  )
}
