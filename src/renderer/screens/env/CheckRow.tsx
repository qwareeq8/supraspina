/** Renders environment checks and install outcomes identically across screens. */

import type { ReactNode } from 'react'
import {
  Btn,
  Chip,
  ChipGlyph,
  Code,
  CodeText,
  FONTS,
  Hint,
  Ico,
  ICONS,
  ICON_SIZE,
  InfoTip,
  statusColor,
  STATUS_LABEL,
  type Theme,
} from '../../ui'
import { ENV_CHECK_HELP, neededForStep } from '../../../shared/help'
import type { EnvInstallState } from '../../../shared/contract'
import type {
  ChipStatus,
  EnvCheck,
  EnvCreateDirResult,
} from '../../../shared/types'
import {
  REQUIREMENT_BADGE,
  REQUIREMENT_MEANING,
  type CheckRequirementState,
} from '../../state/env-applicability'
import { isInstallSettled } from './env-install'
import { GateNotice } from './GateNotice'
import { installGate } from './install-gate'
import { EnvInstallView } from './InstallState'
import {
  ACTION_BUSY_LABEL,
  ACTION_GATE_PHRASE,
  checkChipStatus,
  NOT_INSTALLED_LABEL,
  NOT_INSTALLED_MEANING,
  isFailing,
  statusMeaning,
} from './helpers'

/** One environment check and its repair actions. */
export interface CheckRowProps {
  t: Theme
  check: EnvCheck
  /** How the configured pipeline relates to this check. */
  requirement: CheckRequirementState
  first: boolean
  safeExecution: boolean
  /** Whether a project is open; every gated operation needs one. */
  projectOpen?: boolean
  /**
   * Whether unsaved project edits refuse the opt-in install and the typed
   * action, because both run against the saved configuration alone.
   */
  dirty?: boolean
  /** Whether any installation on this screen is unsettled. */
  installBusy: boolean
  copied: boolean
  /** This check's latest installation, running or settled. */
  install?: EnvInstallState
  /** Whether the check's typed action is currently running. */
  actionRunning?: boolean
  /** The last outcome of the check's typed create-directory action. */
  createOutcome?: EnvCreateDirResult
  onCopyFix: () => void
  onGetIt: () => void
  onInstall: () => void
  /** Run the check's typed action; omit where the screen offers no wiring. */
  onAction?: () => void
  /** Turn on Allow live runs from the refusal; omit where the screen has none. */
  onEnableSafeExecution?: (() => void) | undefined
  /** Save the project from the refusal; omit where the screen has no save. */
  onSaveProject?: (() => Promise<unknown>) | undefined
}

/** Show one environment check with its status, details, and fix actions. */
export function CheckRow({
  t,
  check,
  requirement,
  first,
  safeExecution,
  projectOpen = true,
  dirty = false,
  installBusy,
  copied,
  install,
  actionRunning = false,
  createOutcome,
  onCopyFix,
  onGetIt,
  onInstall,
  onAction,
  onEnableSafeExecution,
  onSaveProject,
}: CheckRowProps): ReactNode {
  const status = checkChipStatus(check, requirement)
  const notInstalled = status === 'skipped' && check.status === 'missing'
  const statusLabel = notInstalled ? NOT_INSTALLED_LABEL : STATUS_LABEL[status]
  const statusText = notInstalled
    ? NOT_INSTALLED_MEANING
    : statusMeaning(status)
  const failing = isFailing(check)
  const installing = install !== undefined && !isInstallSettled(install)
  const canInstall =
    failing && Boolean(check.recommendedCmd) && check.installable !== false
  const action = failing && onAction ? check.action : undefined
  const whatIs = ENV_CHECK_HELP[check.id]
  const needsSafeExec = canInstall && !safeExecution
  const needsSavedProject = canInstall && safeExecution && dirty
  // A rebuild re-creates verified files already on this machine, so name it
  // as such instead of as a package installation.
  const installVerb = check.offlineInstall ? 'Rebuild' : 'Install'
  // Name the refusal on the control and beside it, because an install the
  // screen would refuse must never look authorizable, and the operator must
  // see what enables it. The row running its own installation states that
  // through its busy label instead.
  const installRefusal =
    canInstall && !installing
      ? installGate({
          action: `${installVerb.toLowerCase()} ${check.label}`,
          projectOpen,
          safeExecution,
          dirty,
          busy: installBusy,
        })
      : null
  const actionRefusal =
    action && !actionRunning
      ? installGate({
          action: ACTION_GATE_PHRASE[action.kind],
          projectOpen,
          safeExecution,
          dirty,
          busy: false,
        })
      : null
  const refusal = installRefusal ?? actionRefusal
  // Name the stage blocked by a failing check beside the check itself. Claim no
  // blocked stage for a check the configured pipeline does not require.
  const step =
    failing && requirement === 'required' ? neededForStep(check) : undefined
  const badge =
    requirement === 'required' ? undefined : REQUIREMENT_BADGE[requirement]
  const badgeMeaning =
    requirement === 'required' ? '' : REQUIREMENT_MEANING[requirement]

  return (
    <div
      role="listitem"
      id={`env-check-${check.id}`}
      // Allow the Recommended-fix callout to move focus onto the owning row.
      tabIndex={-1}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        borderTop: first ? 'none' : `1px solid ${t.borderSoft}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <CheckIcon t={t} status={status} />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            minWidth: 200,
            flex: 1,
          }}
        >
          <span
            style={{ fontFamily: FONTS.sans, fontSize: 12.5, color: t.text }}
          >
            {check.label}
          </span>
          {whatIs && (
            <Hint t={t} style={{ marginTop: 2 }}>
              {whatIs}
            </Hint>
          )}
          {check.detail && (
            <span
              style={{
                fontFamily: FONTS.sans,
                fontSize: 11,
                color: t.dim,
                marginTop: 2,
              }}
            >
              <CodeText text={check.detail} />
            </span>
          )}
          {step && (
            <span
              style={{
                fontFamily: FONTS.sans,
                fontSize: 10.5,
                color: t.dimText,
                marginTop: 2,
              }}
            >
              Needed for: {step}
            </span>
          )}
        </div>
        {badge && (
          <Chip t={t} status="na" label={badge} small title={badgeMeaning} />
        )}
        <Chip
          t={t}
          status={status}
          label={statusLabel}
          small
          title={statusText}
        />
        <InfoTip
          t={t}
          text={statusText}
          label={`About ${check.label} status`}
        />
        {check.recommendedCmd && (
          <Btn
            t={t}
            small
            label={copied ? 'Copied' : 'Copy fix'}
            icon={<Ico d={ICONS.copy} size={ICON_SIZE.nav} />}
            onClick={onCopyFix}
            ariaLabel={`Copy fix for ${check.label}`}
          />
        )}
        {check.downloadUrl && (
          <Btn
            t={t}
            small
            label="Get it"
            icon={<Ico d={ICONS.external} size={ICON_SIZE.nav} />}
            onClick={onGetIt}
            ariaLabel={`Get it: open the download page for ${check.label}`}
          />
        )}
        {action && (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {!safeExecution && (
              <Chip
                t={t}
                status="warn"
                label="Needs live runs"
                small
                title="Turn on Allow live runs in the actions bar above to allow this action."
              />
            )}
            <span
              title={
                actionRefusal?.reason ?? `${action.label} for ${check.label}`
              }
              style={{ display: 'inline-flex' }}
            >
              <Btn
                t={t}
                small
                primary={actionRefusal === null}
                label={
                  actionRunning ? ACTION_BUSY_LABEL[action.kind] : action.label
                }
                icon={<Ico d={ICONS.play} size={ICON_SIZE.nav} />}
                onClick={() => onAction?.()}
                disabled={actionRunning || actionRefusal !== null}
                ariaLabel={`${action.label} for ${check.label}`}
              />
            </span>
          </span>
        )}
        {canInstall && (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {needsSafeExec && (
              <Chip
                t={t}
                status="warn"
                label="Needs live runs"
                small
                title="Turn on Allow live runs in the actions bar above to allow opt-in installs."
              />
            )}
            {needsSavedProject && (
              <Chip
                t={t}
                status="warn"
                label="Needs a saved project"
                small
                title="Save the project to allow opt-in installs."
              />
            )}
            <span
              title={installRefusal?.reason ?? `${installVerb} ${check.label}`}
              style={{ display: 'inline-flex' }}
            >
              <Btn
                t={t}
                small
                primary={installRefusal === null && !installBusy}
                label={
                  installing
                    ? check.offlineInstall
                      ? 'Rebuilding...'
                      : 'Installing...'
                    : installVerb
                }
                icon={<Ico d={ICONS.play} size={ICON_SIZE.nav} />}
                onClick={onInstall}
                disabled={installRefusal !== null || installBusy}
                ariaLabel={`${installVerb} ${check.label}`}
              />
            </span>
          </span>
        )}
      </div>

      {refusal && (
        <div style={{ paddingLeft: 42 }}>
          <GateNotice
            t={t}
            gate={refusal}
            onEnableSafeExecution={onEnableSafeExecution}
            onSave={onSaveProject}
          />
        </div>
      )}

      {/* Show the command on failing rows and on skipped alternative-backend
          rows that keep their remediation, so Copy fix never copies unseen text. */}
      {check.recommendedCmd && (failing || check.status === 'skipped') && (
        <div style={{ paddingLeft: 42 }}>
          <Code
            t={t}
            value={check.recommendedCmd}
            kind="command"
            maxHeight={120}
          />
          {check.installable === false && !action && (
            <Hint t={t} style={{ marginTop: 6 }}>
              This reviewed command runs in a terminal, outside Supraspina,
              because Supraspina does not run privilege-escalating or system
              installers.
            </Hint>
          )}
        </div>
      )}

      {install && (
        <div style={{ paddingLeft: 42 }}>
          <EnvInstallView
            t={t}
            label={check.label}
            state={install}
            rebuild={check.offlineInstall === true}
          />
        </div>
      )}

      {createOutcome && (
        <div style={{ paddingLeft: 42 }}>
          <span
            role="status"
            style={{
              fontFamily: FONTS.sans,
              fontSize: 12,
              fontWeight: 700,
              color: createOutcome.ok
                ? statusColor(t, 'done')
                : statusColor(t, 'failed'),
            }}
          >
            {createOutcome.detail}
          </span>
        </div>
      )}
    </div>
  )
}

/** One environment-check status glyph. */
export interface CheckIconProps {
  t: Theme
  status: ChipStatus
}

/**
 * Reinforce each check status with the ringed glyph its status chip draws,
 * in a fixed slot so check rows align.
 */
export function CheckIcon({ t, status }: CheckIconProps): ReactNode {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 32,
        height: 32,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        color: statusColor(t, status),
      }}
    >
      <ChipGlyph t={t} status={status} />
    </span>
  )
}
