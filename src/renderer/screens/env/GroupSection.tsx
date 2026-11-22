/** Shares collapsible environment groups without colliding disclosure IDs. */

import type { ReactNode } from 'react'
import { Card, Chip, Collapsible, FONTS, type Theme } from '../../ui'
import type { EnvInstallState } from '../../../shared/contract'
import type {
  EnvCheck,
  EnvCheckAction,
  EnvCreateDirResult,
  EnvGroup,
} from '../../../shared/types'
import type { EnvApplicability } from '../../state/env-applicability'
import { requirementFor } from '../../state/env-applicability'
import { groupCountLabel, groupSlug, rollupGroup } from './helpers'
import { CheckRow } from './CheckRow'

/** One environment group and its controlled disclosure actions. */
export interface GroupSectionProps {
  t: Theme
  group: EnvGroup
  /** The pipeline-aware requirement state of every check. */
  applicability: EnvApplicability
  open: boolean
  onToggle: () => void
  safeExecution: boolean
  /** Whether a project is open; every gated operation needs one. */
  projectOpen?: boolean
  /** Whether unsaved project edits refuse this group's opt-in installs. */
  dirty?: boolean
  /** The check id of the unsettled installation, or null when none runs. */
  installing: string | null
  copiedToken: string | null
  /** The latest installation per check id, running or settled. */
  installs: Record<string, EnvInstallState>
  /** The check id whose typed action is currently running. */
  actionRunning?: string | null
  /** Whether the shared PyBrainAge setup flow is currently running. */
  setupRunning?: boolean
  /** The last create-directory outcome per check id. */
  createOutcomes?: Record<string, EnvCreateDirResult>
  onCopyFix: (check: EnvCheck) => void
  onGetIt: (check: EnvCheck) => void
  onInstall: (check: EnvCheck) => void
  /** Run a check's typed action; omit where the screen offers no wiring. */
  onAction?: (check: EnvCheck) => void
  /** The action kinds the screen wires; omit to wire every kind. */
  actionKinds?: ReadonlySet<EnvCheckAction['kind']>
  /** Turn on Allow live runs from a row refusal; omit where the screen has none. */
  onEnableSafeExecution?: (() => void) | undefined
  /** Save the project from a row refusal; omit where the screen has no save. */
  onSaveProject?: (() => Promise<unknown>) | undefined
  idPrefix?: string
}

/**
 * Show one environment group with a rollup, count, and controlled disclosure.
 */
export function GroupSection({
  t,
  group,
  applicability,
  open,
  onToggle,
  safeExecution,
  projectOpen = true,
  dirty = false,
  installing,
  copiedToken,
  installs,
  actionRunning = null,
  setupRunning = false,
  createOutcomes = {},
  onCopyFix,
  onGetIt,
  onInstall,
  onAction,
  actionKinds,
  onEnableSafeExecution,
  onSaveProject,
  idPrefix = 'diag',
}: GroupSectionProps): ReactNode {
  const roll = rollupGroup(group, applicability)
  const header = (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          fontFamily: FONTS.sans,
          fontSize: 12.5,
          fontWeight: 700,
          color: t.text,
        }}
      >
        {group.name}
      </span>
      <Chip t={t} status={roll} small />
      <span
        style={{
          fontFamily: FONTS.sans,
          fontSize: 11,
          color: t.dim,
        }}
      >
        {groupCountLabel(group, applicability)}
      </span>
    </span>
  )
  return (
    <Card t={t} padded={false}>
      <Collapsible
        t={t}
        id={groupSlug(group, idPrefix)}
        open={open}
        onToggle={onToggle}
        header={header}
      >
        <div role="list" style={{ borderTop: `1px solid ${t.borderSoft}` }}>
          {group.checks.map((check, i) => {
            const install = installs[check.id]
            const createOutcome = createOutcomes[check.id]
            // Wire only the action kinds the screen handles, and treat the
            // shared setup flow as running for every row it owns.
            const wired =
              onAction !== undefined &&
              check.action !== undefined &&
              (actionKinds?.has(check.action.kind) ?? true)
            const rowActionRunning =
              actionRunning === check.id ||
              (setupRunning && check.action?.kind === 'setup-pybrainage')
            return (
              <CheckRow
                key={check.id}
                t={t}
                check={check}
                requirement={requirementFor(applicability, check.id).state}
                first={i === 0}
                safeExecution={safeExecution}
                projectOpen={projectOpen}
                dirty={dirty}
                installBusy={installing !== null}
                copied={copiedToken === check.id}
                actionRunning={rowActionRunning}
                {...(install ? { install } : {})}
                {...(createOutcome ? { createOutcome } : {})}
                onCopyFix={() => onCopyFix(check)}
                onGetIt={() => onGetIt(check)}
                onInstall={() => onInstall(check)}
                {...(wired && onAction
                  ? { onAction: () => onAction(check) }
                  : {})}
                onEnableSafeExecution={onEnableSafeExecution}
                onSaveProject={onSaveProject}
              />
            )
          })}
        </div>
      </Collapsible>
    </Card>
  )
}
