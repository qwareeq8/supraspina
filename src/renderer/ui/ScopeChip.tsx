/**
 * The run-target chip shared by the run dock and the Runs header, so the
 * scope text and its clear control are one atom wherever a target shows.
 */

import type { ReactNode } from 'react'
import type { WorkflowTarget } from '../../shared/contract'
import type { Theme } from '../theme/tokens'
import { IconButton } from './IconButton'
import { ICONS, ICON_SIZE } from './icon-set'
import { stateLineStyle } from './state-line'

/** The target, its label, and the selection actions for {@link ScopeChip}. */
export interface ScopeChipProps {
  t: Theme
  target: WorkflowTarget
  label: string
  title?: string
  onClearSelection: () => void
  onSelectAll: () => void
}

/**
 * Render the run-target label with a keyboard-operable control that clears
 * an explicit selection, or returns an empty one to the full cohort.
 */
export function ScopeChip({
  t,
  target,
  label,
  title,
  onClearSelection,
  onSelectAll,
}: ScopeChipProps): ReactNode {
  const explicit = target.mode === 'explicit'
  const hasSelection = explicit && target.subjectIds.length > 0
  return (
    <span
      title={title}
      style={{
        ...stateLineStyle(t, { color: t.dim }),
        height: 'var(--ss-input-h)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: explicit ? '0 2px 0 8px' : '0 8px',
        border: `1px solid ${t.border}`,
        borderRadius: 5,
        background: t.surface2,
      }}
    >
      {label}
      {explicit && (
        <IconButton
          t={t}
          d={hasSelection ? ICONS.x : ICONS.subjects}
          ariaLabel={
            hasSelection
              ? 'Clear selected subjects'
              : 'Use the full analysis cohort'
          }
          title={
            hasSelection
              ? 'Clear selection'
              : 'Use all analysis-cohort subjects'
          }
          onClick={hasSelection ? onClearSelection : onSelectAll}
          size={24}
          iconSize={ICON_SIZE.inline}
          style={{ height: 'calc(var(--ss-input-h) - 6px)', borderRadius: 4 }}
        />
      )}
    </span>
  )
}
