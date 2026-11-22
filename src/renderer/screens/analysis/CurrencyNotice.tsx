/**
 * The Analysis panel's notices: out-of-date pipeline tables (worded as the
 * Dashboard words them), a stored result that no longer matches its inputs,
 * a live run, a stopped or failed compute, and a missing input table.
 */

import type { ReactNode } from 'react'
import type {
  ResultAnalysisCohortChange,
  ResultStageCurrency,
} from '../../../shared/contract'
import type { StepKey } from '../../../shared/steps'
import type {
  AnalysisStageCurrency,
  GroupAnalysisResultSummary,
} from '../../../shared/group-analysis'
import { useApp } from '../../state/context'
import { cohortCurrencyNotice } from '../../state/stage-currency'
import { Btn, CohortNotice, FONTS, NoticeGlyph } from '../../ui'
import { staleReasonText } from './describe'

/** One notice line with an optional action. */
export interface NoticeProps {
  tone: 'attention' | 'info' | 'error'
  headline: string
  detail?: string | null | undefined
  action?: { label: string; onClick: () => void; title?: string } | undefined
}

/**
 * Render one notice in the style of the cohort notices.
 *
 * @returns The notice as a polite status region.
 */
export function Notice({
  tone,
  headline,
  detail,
  action,
}: NoticeProps): ReactNode {
  const { t } = useApp()
  const color =
    tone === 'error' ? t.failed : tone === 'attention' ? t.warning : t.dimText
  const soft =
    tone === 'error'
      ? t.failedSoft
      : tone === 'attention'
        ? t.warningSoft
        : t.surface
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 6,
        border:
          tone === 'info'
            ? `1px solid ${t.borderSoft}`
            : `1px solid color-mix(in srgb, ${color} 27%, transparent)`,
        background: soft,
      }}
    >
      <span style={{ display: 'inline-flex', paddingTop: 1, flexShrink: 0 }}>
        <NoticeGlyph
          t={t}
          tone={
            tone === 'error' ? 'failed' : tone === 'attention' ? 'warn' : 'info'
          }
        />
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 3 }}>
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 12,
            fontWeight: 600,
            color: t.text,
          }}
        >
          {headline}
        </span>
        {detail && (
          <span
            style={{
              fontFamily: FONTS.sans,
              fontSize: 11.5,
              color: t.textSoft,
              overflowWrap: 'anywhere',
            }}
          >
            {detail}
          </span>
        )}
      </div>
      {action && (
        <Btn
          t={t}
          small
          ghost
          label={action.label}
          onClick={action.onClick}
          title={action.title}
        />
      )}
    </div>
  )
}

/** The pipeline-layer notice's inputs. */
export interface PipelineCurrencyNoticeProps {
  stages: readonly ('aggregate' | 'pybrainage')[]
  currency: AnalysisStageCurrency
  stageCurrency: Partial<Record<StepKey, ResultStageCurrency>>
  change: ResultAnalysisCohortChange | null
  onOpenRuns: () => void
}

/**
 * Say which of the tables the draft reads are out of date, as the Dashboard
 * says it, and that a result computed now is provisional.
 *
 * @returns The notice, or null when every table is current.
 */
export function PipelineCurrencyNotice({
  stages,
  currency,
  stageCurrency,
  change,
  onOpenRuns,
}: PipelineCurrencyNoticeProps): ReactNode {
  const { t } = useApp()
  const outdated = stages.filter((stage) => currency[stage] === 'outdated')
  const notice = cohortCurrencyNotice(outdated, stageCurrency, change)
  if (!notice) return null
  return (
    <CohortNotice
      t={t}
      attention
      headline={notice.headline}
      detail={`${notice.detail} A result computed now is stamped Provisional.`}
      actionTitle="Open Runs to bring the region tables up to date."
      onOpenRuns={onOpenRuns}
    />
  )
}

/**
 * Say why the shown result no longer matches its inputs.
 *
 * @returns The notice, or null for a current result.
 */
export function StaleResultNotice({
  summary,
  onCompute,
  computeDisabled,
}: {
  summary: GroupAnalysisResultSummary | null
  onCompute: () => void
  computeDisabled: boolean
}): ReactNode {
  if (!summary || summary.currency !== 'stale') return null
  const reasons = summary.staleReasons.map(staleReasonText)
  return (
    <Notice
      tone="attention"
      headline="This result is out of date."
      detail={`${reasons.join(' ')}${reasons.length > 0 ? ' ' : ''}Compute again to update it.`}
      action={
        computeDisabled ? undefined : { label: 'Compute', onClick: onCompute }
      }
    />
  )
}

/** Say that a region table is missing, with a way to Runs. */
export function MissingInputNotice({
  message,
  onOpenRuns,
}: {
  message: string
  onOpenRuns: () => void
}): ReactNode {
  return (
    <Notice
      tone="attention"
      headline="These measures are not available."
      detail={message}
      action={{
        label: 'Open Runs',
        onClick: onOpenRuns,
        title: 'Open Runs to produce the missing table.',
      }}
    />
  )
}
