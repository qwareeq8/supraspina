/**
 * Announces one cohort-level fact, such as out-of-date cohort stages, with a
 * way to Runs. The Dashboard and Subjects share it so both word and style the
 * same fact alike.
 */

import type { ReactNode } from 'react'
import { Btn } from './Button'
import { NoticeGlyph } from './Chip'
import { FONTS, type Theme } from '../theme/tokens'

/** One cohort-level fact and the Runs action beside it. */
export interface CohortNoticeProps {
  t: Theme
  /** Use the warning tone for a state that needs the operator. */
  attention: boolean
  headline: string
  /** The full sentence behind a shortened headline, shown as its tooltip. */
  headlineTitle?: string | undefined
  /** Set the headline in regular weight, for a routine fact. */
  plain?: boolean
  detail?: string | null | undefined
  /** Say what Open Runs is for. */
  actionTitle: string
  onOpenRuns: () => void
}

/**
 * Render one cohort-level notice with an Open Runs action.
 *
 * @returns The notice as a polite status region.
 */
export function CohortNotice({
  t,
  attention,
  headline,
  headlineTitle,
  plain = false,
  detail,
  actionTitle,
  onOpenRuns,
}: CohortNoticeProps): ReactNode {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 6,
        border: attention
          ? `1px solid color-mix(in srgb, ${t.warning} 27%, transparent)`
          : `1px solid ${t.borderSoft}`,
        background: attention ? t.warningSoft : t.surface,
      }}
    >
      <span style={{ display: 'inline-flex', paddingTop: 1, flexShrink: 0 }}>
        <NoticeGlyph t={t} tone={attention ? 'warn' : 'info'} />
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 3 }}>
        <span
          title={headlineTitle}
          style={{
            fontFamily: FONTS.sans,
            fontSize: 12,
            fontWeight: plain ? 400 : 600,
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
      <Btn
        t={t}
        small
        ghost
        label="Open Runs"
        onClick={onOpenRuns}
        title={actionTitle}
      />
    </div>
  )
}
