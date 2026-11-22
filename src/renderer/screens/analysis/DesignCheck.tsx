/**
 * The design check of a spec v2 draft: one line of facts (what blocks the
 * compute and what warns), with a disclosure of every finding and its
 * fixes, each test's sample, the cell counts with sex per cell, the
 * variance inflation factors, and the crosstabs of confounded factors.
 */

import { useState, type ReactNode } from 'react'
import type {
  DesignCheck,
  DesignFix,
  DesignIssueSeverity,
  GroupAnalysisSpecV2,
} from '../../../shared/group-analysis'
import { useApp } from '../../state/context'
import { Btn, FONTS, Ico, ICONS, TEXT_GAP } from '../../ui'
import type { VariableChoice } from './variables'
import { designCheckSummary, designFixLabel } from './rail-text'

const SEVERITY_TEXT: Readonly<Record<DesignIssueSeverity, string>> = {
  blocking: 'Blocks',
  'strong-warning': 'Strong warning',
  warning: 'Warning',
}

/** The design check's inputs. */
export interface DesignCheckViewProps {
  draft: GroupAnalysisSpecV2
  check: DesignCheck | null
  /** A fact to show while no check is available, such as a draft error. */
  pending: string
  choices: readonly VariableChoice[]
  onFix: (fix: DesignFix) => void
}

const cellStyle = {
  padding: '2px 6px',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  fontWeight: 400,
} as const

export function DesignCheckView({
  draft,
  check,
  pending,
  choices,
  onFix,
}: DesignCheckViewProps): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const testLabel = (id: string | null): string =>
    id === null
      ? 'Design'
      : (draft.tests.find((test) => test.id === id)?.label ?? id)
  const severityColor = (severity: DesignIssueSeverity): string =>
    severity === 'blocking'
      ? t.failed
      : severity === 'strong-warning'
        ? t.warning
        : t.dimText
  if (!check) {
    return (
      <p
        style={{
          margin: 0,
          fontFamily: FONTS.sans,
          fontSize: 12,
          color: t.dimText,
        }}
      >
        {pending}
      </p>
    )
  }
  const blocking = check.issues.some((issue) => issue.severity === 'blocking')
  const tone = blocking
    ? t.failed
    : check.issues.length > 0
      ? t.warning
      : t.done
  const tableStyle = {
    borderCollapse: 'collapse',
    fontFamily: FONTS.sans,
    fontSize: 11,
    color: t.text,
  } as const
  const head = { ...cellStyle, color: t.dimText }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ display: 'inline-flex', paddingTop: 2, flexShrink: 0 }}>
          <Ico
            d={check.issues.length > 0 ? ICONS.circleAlert : ICONS.circleCheck}
            stroke={tone}
          />
        </span>
        <span
          role="status"
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: FONTS.sans,
            fontSize: 12,
            color: t.text,
          }}
        >
          {designCheckSummary(check)}
        </span>
        <Btn
          t={t}
          small
          ghost
          label="Details"
          ariaExpanded={open}
          ariaControls="analysis-design-check"
          onClick={() => setOpen((value) => !value)}
        />
      </div>
      {open && (
        <div
          id="analysis-design-check"
          style={{
            display: 'grid',
            gap: 10,
            padding: '8px 10px',
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 5,
            background: t.bg,
            minWidth: 0,
          }}
        >
          {check.issues.length > 0 && (
            <ul
              aria-label="Findings"
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: 8,
              }}
            >
              {check.issues.map((issue, index) => (
                <li key={index} style={{ display: 'grid', gap: 4 }}>
                  <span
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 11,
                      fontWeight: 700,
                      color: severityColor(issue.severity),
                    }}
                  >
                    {SEVERITY_TEXT[issue.severity]}
                    <span style={{ fontWeight: 400, color: t.dimText }}>
                      {TEXT_GAP}
                      {testLabel(issue.testId)}
                    </span>
                  </span>
                  <span
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 12,
                      color: t.text,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {issue.message}
                  </span>
                  {issue.fixes && issue.fixes.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {issue.fixes.map((fix, fixIndex) => (
                        <Btn
                          key={fixIndex}
                          t={t}
                          small
                          secondary
                          label={designFixLabel(fix, choices)}
                          onClick={() => onFix(fix)}
                        />
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Block title="Samples">
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={head}>Test</th>
                  <th style={head}>n</th>
                  <th style={head}>Residual df</th>
                  <th style={head}>Left out</th>
                </tr>
              </thead>
              <tbody>
                {check.tests.map((sample) => (
                  <tr key={sample.testId}>
                    <td style={cellStyle}>{testLabel(sample.testId)}</td>
                    <td style={cellStyle}>{sample.n}</td>
                    <td style={cellStyle}>{sample.residualDf ?? '\u2013'}</td>
                    <td style={cellStyle}>{sample.missing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Block>
          {check.cells.length > 0 && (
            <Block title="Cells">
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={head}>Test</th>
                    {check.cells.some((cell) => cell.stratum !== null) && (
                      <th style={head}>Stratum</th>
                    )}
                    <th style={head}>Cell</th>
                    <th style={head}>n</th>
                    <th style={head}>Female</th>
                    <th style={head}>Male</th>
                  </tr>
                </thead>
                <tbody>
                  {check.cells.map((cell, index) => (
                    <tr key={index}>
                      <td style={cellStyle}>{testLabel(cell.testId)}</td>
                      {check.cells.some((item) => item.stratum !== null) && (
                        <td style={cellStyle}>{cell.stratum ?? ''}</td>
                      )}
                      <td style={cellStyle}>{cell.label}</td>
                      <td style={cellStyle}>{cell.n}</td>
                      <td style={cellStyle}>{cell.female ?? '\u2013'}</td>
                      <td style={cellStyle}>{cell.male ?? '\u2013'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Block>
          )}
          {check.vif.length > 0 && (
            <Block title="Variance inflation">
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={head}>Test</th>
                    <th style={head}>Term</th>
                    <th style={head}>VIF</th>
                  </tr>
                </thead>
                <tbody>
                  {check.vif.map((row, index) => (
                    <tr key={index}>
                      <td style={cellStyle}>{testLabel(row.testId)}</td>
                      <td style={cellStyle}>{row.term}</td>
                      <td
                        style={{
                          ...cellStyle,
                          color: row.vif >= 5 ? t.warning : t.text,
                          fontWeight: row.vif >= 10 ? 700 : 400,
                        }}
                      >
                        {row.vif.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Block>
          )}
          {check.crosstabs.map((crosstab, index) => (
            <Block
              key={index}
              title={`${crosstab.rowVariable} by ${crosstab.columnVariable}${
                crosstab.cramersV === null
                  ? ''
                  : `, Cramer's V ${crosstab.cramersV.toFixed(2)}`
              }`}
            >
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={head} />
                    {crosstab.columns.map((column) => (
                      <th key={column} style={head}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {crosstab.rows.map((row, r) => (
                    <tr key={row}>
                      <th style={{ ...cellStyle, color: t.dimText }}>{row}</th>
                      {crosstab.columns.map((column, c) => (
                        <td key={column} style={cellStyle}>
                          {crosstab.counts[r]?.[c] ?? 0}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Block>
          ))}
        </div>
      )}
    </div>
  )
}

function Block({
  title,
  children,
}: {
  title: string
  children: ReactNode
}): ReactNode {
  const { t } = useApp()
  return (
    <section
      aria-label={title}
      style={{ display: 'grid', gap: 3, minWidth: 0 }}
    >
      <span
        style={{
          fontFamily: FONTS.sans,
          fontSize: 11,
          fontWeight: 600,
          color: t.textSoft,
        }}
      >
        {title}
      </span>
      <div style={{ overflowX: 'auto', minWidth: 0 }}>{children}</div>
    </section>
  )
}
