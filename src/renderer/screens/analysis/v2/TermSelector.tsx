/**
 * The term selector of a v2 result: a native select whose option groups are
 * the tests, each listing its terms (the omnibus test and its pairs, the
 * pooled term and each stratum, the heterogeneity test). A test with one
 * term is one plain option. Beside it, one line says what the term tests
 * and how its p values are corrected.
 */

import { useId, type ReactNode } from 'react'
import type {
  GroupAnalysisResultV2,
  GroupAnalysisTerm,
} from '../../../../shared/group-analysis'
import { useApp } from '../../../state/context'
import { FONTS, TEXT_GAP } from '../../../ui'
import { correctionText, termGroups, termShortLabel, termTest } from './terms'

/** The kind of test a term belongs to, for the facts line. */
function termKindText(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
): string {
  const test = termTest(result, term)
  if (term.role === 'heterogeneity') {
    return `${term.kind === 'F' ? `F test, ${term.rank} df` : 't test'} of the strata`
  }
  if (term.role === 'pairwise') return 'Pairwise t test'
  switch (test?.kind) {
    case 'omnibus':
      return `Omnibus F test, ${term.rank} df`
    case 'two-group':
      return 'Two-group t test'
    case 'association':
      return 'Association t test'
    case 'interaction':
      return term.kind === 'F'
        ? `Slope difference F test, ${term.rank} df`
        : 'Slope difference t test'
    default:
      return term.kind === 'F' ? 'F test' : 't test'
  }
}

/** The term selector's inputs. */
export interface TermSelectorProps {
  result: GroupAnalysisResultV2
  termId: string
  onTerm: (termId: string) => void
  /** A control for the shown tab, at the end of the row. */
  trailing?: ReactNode
}

/** Render the term selector and the selected term's facts. */
export function TermSelector({
  result,
  termId,
  onTerm,
  trailing,
}: TermSelectorProps): ReactNode {
  const { t } = useApp()
  const id = `term-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const term = result.terms.find((item) => item.termId === termId)
  const groups = termGroups(result)
  const facts = term
    ? [
        termKindText(result, term),
        correctionText(result, term),
        `${term.rowCount.toLocaleString('en-US')} ${term.rowCount === 1 ? 'measure' : 'measures'}`,
      ]
    : []
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        columnGap: 12,
        rowGap: 4,
        minWidth: 0,
      }}
    >
      <label
        htmlFor={id}
        style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.dim }}
      >
        Term
      </label>
      <select
        id={id}
        value={termId}
        aria-describedby={`${id}-facts`}
        onChange={(event) => onTerm(event.target.value)}
        style={{
          height: 'var(--ss-input-h)',
          maxWidth: 'min(420px, 100%)',
          minWidth: 0,
          padding: '0 6px',
          border: `1px solid ${t.dim}`,
          borderRadius: 4,
          background: t.bg,
          color: t.text,
          fontFamily: FONTS.sans,
          fontSize: 11.5,
        }}
      >
        {groups.map((group) =>
          group.label === null ? (
            group.terms.map((item) => (
              <option key={item.termId} value={item.termId}>
                {termShortLabel(result, item)}
              </option>
            ))
          ) : (
            <optgroup key={group.testId} label={group.label}>
              {group.terms.map((item) => (
                <option key={item.termId} value={item.termId}>
                  {termShortLabel(result, item)}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </select>
      <span
        id={`${id}-facts`}
        style={{
          fontFamily: FONTS.sans,
          fontSize: 11.5,
          color: t.dimText,
          minWidth: 0,
        }}
      >
        {facts.join(TEXT_GAP)}
      </span>
      {trailing ? <div style={{ marginLeft: 'auto' }}>{trailing}</div> : null}
    </div>
  )
}
