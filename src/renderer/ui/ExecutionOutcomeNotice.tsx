import { useMemo, useState, type ReactNode } from 'react'
import type { WorkflowNode } from '../../shared/contract'
import type { StageBlocker } from '../../shared/types'
import {
  dedupeStageBlockers,
  withBlockedNodeSubjects,
} from '../state/workflow-review-state'
import { FONTS, type Theme } from '../theme/tokens'
import { Btn } from './Button'
import { ConfirmDialog } from './ConfirmDialog'
import { StageBlockerList } from './StageBlockerList'

/**
 * The notice's action that plans Reconstruction for the whole cohort, which a
 * read-only review of that plan names as the way to start it again.
 */
export const NORMALIZE_RECONSTRUCTION_COHORT_LABEL =
  'Normalize full reconstruction cohort'

/** A workflow outcome, its retained blockers, and its recovery actions. */
export interface ExecutionOutcomeNoticeProps {
  t: Theme
  message: string
  /** The blockers of the retained result, kept for the detail dialog. */
  blockers?: readonly StageBlocker[]
  /**
   * The nodes of the retained result's plan, which name the subjects of a
   * blocker the plan reports without them.
   */
  nodes?: readonly WorkflowNode[]
  /** Open the Registry from a blocker that names affected subjects. */
  onOpenRegistry?: () => void
  onNormalizeReconstructionCohort?: () => void
  /**
   * Offer an Open Logs control for an outcome whose jobs Logs lists, such as
   * a canceled run; omitted, none shows.
   */
  onOpenLogs?: () => void
  /** Offer a Dismiss control that removes the outcome; omitted, none shows. */
  onDismiss?: () => void
}

/**
 * Render a workflow outcome with its blocker detail and recovery actions.
 *
 * The outcome sentence reports totals only, so the blocker dialog keeps the
 * per-stage causes and the subjects behind them reachable after the run. The
 * message and its actions share one wrapping row, so a one-sentence outcome
 * stays one control high.
 */
export function ExecutionOutcomeNotice({
  t,
  message,
  blockers,
  nodes,
  onOpenRegistry,
  onNormalizeReconstructionCohort,
  onOpenLogs,
  onDismiss,
}: ExecutionOutcomeNoticeProps): ReactNode {
  const [detailOpen, setDetailOpen] = useState(false)
  const lines = useMemo(
    () =>
      dedupeStageBlockers(withBlockedNodeSubjects(blockers ?? [], nodes ?? [])),
    [blockers, nodes],
  )
  const openDetail = lines.length > 0 ? () => setDetailOpen(true) : null
  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        padding: '4px 6px 4px 10px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 10,
        rowGap: 6,
        fontFamily: FONTS.sans,
        fontSize: 12,
        lineHeight: 1.4,
        color: t.textSoft,
        background: t.surface,
      }}
    >
      <div
        role="status"
        aria-live="polite"
        style={{ flex: '1 1 16em', minWidth: 0, padding: '3px 0' }}
      >
        {message}
      </div>
      {(openDetail || onNormalizeReconstructionCohort) && (
        <div
          role="group"
          aria-label="Blocked workflow actions"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
        >
          {openDetail && (
            <Btn
              t={t}
              small
              secondary
              label="View blockers"
              onClick={openDetail}
            />
          )}
          {onNormalizeReconstructionCohort && (
            <Btn
              t={t}
              small
              secondary
              label={NORMALIZE_RECONSTRUCTION_COHORT_LABEL}
              onClick={onNormalizeReconstructionCohort}
            />
          )}
        </div>
      )}
      {onOpenLogs && (
        <Btn t={t} small secondary label="Open Logs" onClick={onOpenLogs} />
      )}
      {onDismiss && (
        <Btn
          t={t}
          small
          ghost
          label="Dismiss"
          ariaLabel="Dismiss the workflow outcome"
          onClick={onDismiss}
        />
      )}
      {detailOpen && (
        <ConfirmDialog
          t={t}
          title="Review the blockers of this result."
          message={
            <div
              style={{
                maxHeight: 'min(62vh, 560px)',
                overflow: 'auto',
                paddingRight: 4,
              }}
            >
              <StageBlockerList
                t={t}
                lines={lines}
                {...(onOpenRegistry
                  ? {
                      onOpenRegistry: () => {
                        setDetailOpen(false)
                        onOpenRegistry()
                      },
                    }
                  : {})}
              />
            </div>
          }
          onDismiss={() => setDetailOpen(false)}
          actions={[
            {
              label: 'Close',
              onSelect: () => setDetailOpen(false),
              initialFocus: true,
            },
          ]}
        />
      )}
    </div>
  )
}
