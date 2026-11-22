/**
 * The Grid tab of a v2 result: the tests (or an omnibus test's pairs, or
 * the strata) by the measures, as a table whose cells hold the effect with
 * its 95% CI, then the uncorrected and corrected p. Cells are tinted on the
 * theme surface (blue negative, red positive, deeper for larger effects)
 * with the theme's text, so they read in light and dark; significant cells
 * are bold and the marks of the forest repeat. Up to eight measures are
 * columns; more turn into rows, shown a hundred at a time.
 *
 * Selecting a measure heading selects the measure; selecting a cell also
 * selects its term, and a double click opens its measure figure.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { measureLabel } from '../../../../shared/brain-atlas'
import type {
  GroupAnalysisResultV2,
  GroupAnalysisRowV2,
  GroupAnalysisTerm,
} from '../../../../shared/group-analysis'
import {
  cellAlpha,
  cellFill,
  gridModel,
  type GridCell,
  type GridTerms,
} from '../../../figures/grid-model'
import { GRID_MAX_MEASURE_COLUMNS } from '../../../figures/grid-layout'
import { richText } from '../../../figures/rich'
import { figureFont } from '../../../figures/style'
import { useApp } from '../../../state/context'
import { Btn, FONTS, Segments, TEXT_GAP } from '../../../ui'
import { tableHemisphere } from '../describe'

/** The measures the transposed grid shows at a time. */
export const GRID_PAGE_MEASURES = 100

const CHOICE_LABEL: Readonly<Record<GridTerms, string>> = {
  tests: 'Tests',
  pairs: 'Pairs',
  strata: 'Strata',
}

/** The grid view's inputs. */
export interface GridViewProps {
  result: GroupAnalysisResultV2
  choice: GridTerms
  choices: readonly GridTerms[]
  onChoice: (choice: GridTerms) => void
  terms: readonly GroupAnalysisTerm[]
  rowsOf: (termId: string) => readonly GroupAnalysisRowV2[]
  measureIds: readonly string[]
  /** True while a term's rows are still being read. */
  loading: boolean
  selectedMeasure: string | null
  selectedTerm: string | null
  onSelect: (measureId: string, termId: string | null) => void
  onOpen: (measureId: string, termId: string) => void
}

export function GridView({
  result,
  choice,
  choices,
  onChoice,
  terms,
  rowsOf,
  measureIds,
  loading,
  selectedMeasure,
  selectedTerm,
  onSelect,
  onOpen,
}: GridViewProps): ReactNode {
  const { t, density } = useApp()
  const [shown, setShown] = useState(GRID_PAGE_MEASURES)
  const transposed = measureIds.length > GRID_MAX_MEASURE_COLUMNS
  const visible = transposed ? measureIds.slice(0, shown) : measureIds
  const model = useMemo(
    () => gridModel(result, terms, rowsOf, visible),
    [result, terms, rowsOf, visible],
  )
  const alpha = cellAlpha(t.surface)
  const lineHeight = 1.35

  const measureHeading = (index: number): ReactNode => {
    const line = model.measures[index]!
    const selected = line.id === selectedMeasure
    const hemi = tableHemisphere(line.id)
    return (
      <button
        type="button"
        aria-pressed={selected}
        title={measureLabel(line.id)}
        onClick={() => onSelect(line.id, null)}
        style={{
          display: 'block',
          width: '100%',
          // Keep a single-line heading at the 24 px minimum target size.
          minHeight: 24,
          padding: '4px 8px',
          border: 'none',
          background: 'transparent',
          color: selected ? t.text : t.textSoft,
          font: 'inherit',
          fontWeight: 600,
          textAlign: transposed ? 'left' : 'center',
          cursor: 'pointer',
          whiteSpace: transposed ? 'nowrap' : 'normal',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {line.label}
        {hemi && hemi !== 'Both' && !line.label.match(/^(Left|Right) /) ? (
          <span style={{ color: t.dimText, fontWeight: 400 }}> {hemi}</span>
        ) : null}
      </button>
    )
  }
  const termHeading = (index: number): ReactNode => {
    const line = model.terms[index]!
    return (
      <span style={{ display: 'block', padding: '4px 8px' }}>
        <span style={{ fontWeight: 600, color: t.text }}>{line.label}</span>
        <span style={{ display: 'block', color: t.dimText, fontWeight: 400 }}>
          <i>{line.detail}</i>
        </span>
      </span>
    )
  }
  const renderCell = (
    cell: GridCell | null,
    key: string,
    termId: string,
    measureId: string,
  ): ReactNode => {
    const selected =
      measureId === selectedMeasure &&
      (selectedTerm === null || selectedTerm === termId)
    return (
      <td
        key={key}
        onClick={() => onSelect(measureId, termId)}
        onDoubleClick={() => onOpen(measureId, termId)}
        style={{
          padding: '5px 8px',
          minWidth: 112,
          textAlign: 'center',
          verticalAlign: 'middle',
          lineHeight,
          background: cell ? cellFill(cell.tone, t.surface, alpha) : undefined,
          // A surface-colored border clipped out of the tint leaves one
          // density cell gap between tiles. Spacing the table instead would
          // let scrolled cells show between the sticky headings.
          border: `${density.cellGap / 2}px solid ${t.surface}`,
          backgroundClip: 'padding-box',
          color: t.text,
          fontWeight: cell?.significant ? 700 : 400,
          boxShadow: selected ? `inset 0 0 0 2px ${t.accent}` : undefined,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {cell ? (
          <>
            <span style={{ display: 'block' }}>
              {cell.value}
              {cell.ci ? ` ${cell.ci}` : ''}
            </span>
            <span style={{ display: 'block', fontSize: 11 }}>
              <i>p</i> {cell.p}
              {cell.pCorrected !== null
                ? `${TEXT_GAP}${model.correctedLabel} ${cell.pCorrected}`
                : ''}
            </span>
          </>
        ) : (
          <span style={{ color: t.dimText }} aria-label="No row">
            {'\u2212'}
          </span>
        )}
      </td>
    )
  }

  const head = {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    background: t.surface2,
    borderBottom: `1px solid ${t.border}`,
    verticalAlign: 'bottom',
    fontWeight: 600,
    padding: 0,
  } as const
  const side = {
    position: 'sticky',
    left: 0,
    zIndex: 1,
    background: t.surface2,
    borderBottom: `1px solid ${t.borderSoft}`,
    borderRight: `1px solid ${t.border}`,
    textAlign: 'left',
    fontWeight: 400,
    padding: 0,
    maxWidth: 260,
  } as const

  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        {choices.length > 1 && (
          <Segments
            t={t}
            small
            ariaLabel="Grid lines"
            value={choice}
            options={choices.map((value) => ({
              value,
              label: CHOICE_LABEL[value],
            }))}
            onChange={(value) => onChoice(value as GridTerms)}
          />
        )}
        <span
          style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.dimText }}
        >
          {model.significantText}
          {loading ? ' Reading more rows.' : ''}
        </span>
      </div>
      <div
        style={{
          overflow: 'auto',
          // Hug the grid's columns instead of spanning the pane.
          width: 'fit-content',
          maxWidth: '100%',
          maxHeight: 'max(320px, calc(100vh - 330px))',
          border: `1px solid ${t.borderSoft}`,
          borderRadius: 6,
          background: t.surface,
        }}
      >
        <table
          aria-label={`Grid of ${result.name}`}
          style={{
            borderCollapse: 'separate',
            borderSpacing: 0,
            // The grid is the on-screen twin of the exported figure, so its
            // headings and cells take the figure serif.
            fontFamily: figureFont('screen'),
            fontSize: 11.5,
            color: t.text,
          }}
        >
          <thead>
            <tr>
              <th
                scope="col"
                style={{
                  ...head,
                  ...{ left: 0, zIndex: 3 },
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    padding: '4px 8px',
                    color: t.dim,
                  }}
                >
                  {transposed ? 'Measure' : 'Term'}
                </span>
              </th>
              {transposed
                ? model.terms.map((line, index) => (
                    <th key={line.id} scope="col" style={head}>
                      {termHeading(index)}
                    </th>
                  ))
                : model.measures.map((line, index) => (
                    <th key={line.id} scope="col" style={head}>
                      {measureHeading(index)}
                    </th>
                  ))}
            </tr>
          </thead>
          <tbody>
            {transposed
              ? model.measures.map((line, m) => (
                  <tr key={line.id}>
                    <th scope="row" style={side}>
                      {measureHeading(m)}
                    </th>
                    {model.terms.map((term, k) =>
                      renderCell(
                        model.cells[k]![m]!,
                        term.id,
                        term.id,
                        line.id,
                      ),
                    )}
                  </tr>
                ))
              : model.terms.map((line, k) => (
                  <tr key={line.id}>
                    <th scope="row" style={side}>
                      {termHeading(k)}
                    </th>
                    {model.measures.map((measure, m) =>
                      renderCell(
                        model.cells[k]![m]!,
                        measure.id,
                        line.id,
                        measure.id,
                      ),
                    )}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {transposed && shown < measureIds.length && (
        <div>
          <Btn
            t={t}
            small
            label={`Show ${Math.min(GRID_PAGE_MEASURES, measureIds.length - shown)} more measures`}
            onClick={() => setShown((n) => n + GRID_PAGE_MEASURES)}
          />
        </div>
      )}
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'grid',
          gap: 2,
          // The export draws these lines inside the figure.
          fontFamily: figureFont('screen'),
          fontSize: 11,
          color: t.dimText,
        }}
      >
        {model.subtitle.slice(1).map((line, index) => (
          <li key={`s${index}`}>{richText(line)}</li>
        ))}
        {model.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  )
}
