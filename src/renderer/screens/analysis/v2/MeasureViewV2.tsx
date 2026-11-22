/**
 * The Measure tab of a v2 result: the chosen measure's figure for the
 * selected term (a k-group beeswarm, an association scatter with its fitted
 * line and band, or one line per group for a slope difference), the k x k
 * pairwise matrix after an omnibus test, and, in a stratified result, the
 * same figure per stratum as small multiples.
 */

import { useState, type ReactNode } from 'react'
import { measureLabel } from '../../../../shared/brain-atlas'
import type {
  GroupAnalysisMeasureDetailV2,
  GroupAnalysisResultV2,
  GroupAnalysisRowV2,
  GroupAnalysisTerm,
} from '../../../../shared/group-analysis'
import { formatValue, measureUnitText } from '../../../figures/format'
import { PairwiseMatrix } from '../../../figures/pairwise-matrix'
import { pairwiseMatrixModel } from '../../../figures/pairwise-matrix-model'
import { AdjustedScatter } from '../../../figures/scatter'
import { scatterModelV2 } from '../../../figures/scatter-model-v2'
import { SCREEN_PX_PER_PT, screenPalette } from '../../../figures/style'
import type { Load } from '../../../state/group-analysis'
import { useApp } from '../../../state/context'
import {
  Btn,
  EmptyState,
  ErrorState,
  FONTS,
  LoadingState,
  Segments,
  TEXT_GAP,
} from '../../../ui'
import { SelectField } from '../controls'
import { tableHemisphere, tableMeasureName } from '../describe'
import { measureFigureSize, useFitHeight, useFrameWidth } from '../fit'
import { Paper } from '../ResultTabs'
import type { AnalysisSelection } from '../selection'
import { strataTerms, termShortLabel } from './terms'

/** The panel width, in CSS pixels, from which the controls sit beside the figure. */
const MEASURE_SIDE_WIDTH = 700
/** The narrowest small multiple, in CSS pixels. */
const MULTIPLE_MIN_WIDTH = 260

/** How a stratified result's measure figure is laid out. */
export type MeasureLayout = 'term' | 'strata'

/** The measure view's inputs. */
export interface MeasureViewV2Props {
  result: GroupAnalysisResultV2
  term: GroupAnalysisTerm
  rows: readonly GroupAnalysisRowV2[]
  rowsOf: (termId: string) => readonly GroupAnalysisRowV2[]
  selection: AnalysisSelection
  onSelect: (next: AnalysisSelection) => void
  detail: (
    termId: string,
    measureId: string,
  ) => Load<GroupAnalysisMeasureDetailV2> | null
  onRetry: (termId: string, measureId: string) => void
  onInspect: (subjectId: string) => void
  layout: MeasureLayout
  onLayout: (layout: MeasureLayout) => void
}

function Figure({
  result,
  term,
  load,
  width,
  termLine,
  hovered,
  onHover,
  onPick,
  onRetry,
}: {
  result: GroupAnalysisResultV2
  term: GroupAnalysisTerm
  load: Load<GroupAnalysisMeasureDetailV2> | null
  width: number
  /** Name the term in the figure, as small multiples need. */
  termLine: boolean
  hovered: string | null
  onHover: (subjectId: string | null) => void
  onPick: (subjectId: string) => void
  onRetry: () => void
}): ReactNode {
  const { t, resolvedTheme } = useApp()
  if (load === null || load.phase === 'loading') {
    return <LoadingState t={t} label="Reading the measure values" />
  }
  if (load.phase === 'error') {
    return <ErrorState t={t} title={load.message} onRetry={onRetry} />
  }
  if (load.value.subjects.length === 0) {
    return (
      <EmptyState
        t={t}
        message="This result keeps no subject values for this measure."
        hint="A result over its size limit stores the model rows without per-subject values."
      />
    )
  }
  return (
    <AdjustedScatter
      model={scatterModelV2(load.value, result, term, { termLine })}
      width={width}
      mode="screen"
      palette={screenPalette(t, resolvedTheme)}
      hoveredId={hovered}
      onHover={onHover}
      onPick={onPick}
      title={`Adjusted values: ${measureLabel(load.value.measureId)}, ${termShortLabel(result, term)}`}
    />
  )
}

export function MeasureViewV2({
  result,
  term,
  rows,
  rowsOf,
  selection,
  onSelect,
  detail,
  onRetry,
  onInspect,
  layout,
  onLayout,
}: MeasureViewV2Props): ReactNode {
  const { t, resolvedTheme } = useApp()
  const [panelWidth, panelRef] = useFrameWidth()
  const [width, frameRef] = useFrameWidth()
  const side = panelWidth >= MEASURE_SIDE_WIDTH
  const [available, fitRef] = useFitHeight(side ? 200 : 240)
  const [hovered, setHovered] = useState<string | null>(null)
  const measureId = selection.measureId
  const strata = strataTerms(result, term)
  const multiples =
    layout === 'strata' && strata.strata.length > 0
      ? [...(strata.pooled ? [strata.pooled] : []), ...strata.strata]
      : null
  const chooser = (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <div style={{ maxWidth: side ? undefined : 420, minWidth: 0 }}>
        <SelectField
          label="Measure"
          value={measureId ?? ''}
          options={[
            ...(measureId && rows.some((row) => row.measureId === measureId)
              ? []
              : [{ value: measureId ?? '', label: 'Choose a measure' }]),
            ...rows.map((row) => ({
              value: row.measureId,
              label: `${tableMeasureName(row.measureId)}${tableHemisphere(row.measureId) && tableHemisphere(row.measureId) !== 'Both' ? `, ${tableHemisphere(row.measureId)}` : ''}${row.significant ? ' (significant)' : ''}`,
            })),
          ]}
          onChange={(value) =>
            onSelect({ measureId: value || null, subjectId: null })
          }
        />
      </div>
      {strata.strata.length > 0 && (
        <Segments
          t={t}
          small
          ariaLabel="Measure figure layout"
          value={layout}
          options={[
            { value: 'term', label: 'This term' },
            { value: 'strata', label: 'Each stratum' },
          ]}
          onChange={(value) => onLayout(value as MeasureLayout)}
        />
      )}
    </div>
  )
  if (!measureId) {
    return (
      <div ref={panelRef} style={{ display: 'grid', gap: 10 }}>
        {chooser}
        <EmptyState
          t={t}
          message="No measure is selected."
          hint="Choose one here, in the table, grid, or forest plot."
        />
      </div>
    )
  }
  const load = detail(term.termId, measureId)
  const focus = hovered ?? selection.subjectId
  const subject =
    load?.phase === 'ready'
      ? load.value.subjects.find((s) => s.subjectId === focus)
      : undefined
  const unit = measureUnitText(measureId)
  const size = measureFigureSize(
    width,
    available === null ? null : available - (side ? 0 : 38),
  )
  const matrix = pairwiseMatrixModel(result, term, rowsOf, measureId)
  const info =
    load?.phase === 'ready' && load.value.subjects.length > 0 ? (
      <div
        aria-live="polite"
        style={{
          display: 'flex',
          flexDirection: side ? 'column' : 'row',
          alignItems: side ? 'flex-start' : 'center',
          gap: side ? 8 : 10,
          minHeight: 28,
          fontFamily: FONTS.sans,
          fontSize: 12,
          lineHeight: 1.45,
          color: t.textSoft,
        }}
      >
        {subject ? (
          <>
            <span>
              <span style={{ fontFamily: FONTS.mono, color: t.text }}>
                {subject.subjectId}
              </span>
              {TEXT_GAP}
              {subject.sourceLabel ?? subject.group ?? ''}
              {TEXT_GAP}
              {formatValue(subject.adjusted)}
              {unit ? ` ${unit}` : ''} adjusted, {formatValue(subject.value)}{' '}
              measured
            </span>
            {selection.subjectId === subject.subjectId && (
              <Btn
                t={t}
                small
                label="Inspect this subject's brain"
                onClick={() => onInspect(subject.subjectId)}
              />
            )}
          </>
        ) : (
          <span style={{ color: t.dimText }}>
            Point at a marker to see its subject; click it to select.
          </span>
        )}
      </div>
    ) : null
  const pick = (subjectId: string): void => onSelect({ measureId, subjectId })
  const figure = multiples ? (
    <div
      style={{
        display: 'grid',
        gap: 10,
        gridTemplateColumns: `repeat(auto-fill, minmax(${MULTIPLE_MIN_WIDTH}px, 1fr))`,
      }}
    >
      {multiples.map((item) => (
        <MultiplePanel
          key={item.termId}
          result={result}
          term={item}
          load={detail(item.termId, measureId)}
          hovered={focus}
          onHover={setHovered}
          onPick={pick}
          onRetry={() => onRetry(item.termId, measureId)}
        />
      ))}
    </div>
  ) : (
    <Paper frameRef={frameRef}>
      <div style={{ maxWidth: size.cssWidth, margin: '0 auto' }}>
        <Figure
          result={result}
          term={term}
          load={load}
          width={size.widthPt}
          termLine={false}
          hovered={focus}
          onHover={setHovered}
          onPick={pick}
          onRetry={() => onRetry(term.termId, measureId)}
        />
      </div>
    </Paper>
  )
  const matrixFigure = matrix ? (
    <MatrixPaper
      title={`Pairwise matrix: ${measureLabel(measureId)}`}
      render={(widthPt) => (
        <PairwiseMatrix
          model={matrix}
          width={widthPt}
          mode="screen"
          palette={screenPalette(t, resolvedTheme)}
          title={`Pairwise matrix: ${measureLabel(measureId)}`}
        />
      )}
    />
  ) : null
  return (
    <div
      ref={panelRef}
      style={{
        display: 'grid',
        gap: side ? 16 : 10,
        gridTemplateColumns: side
          ? 'minmax(240px, 300px) minmax(0, 1fr)'
          : 'minmax(0, 1fr)',
        alignItems: 'start',
      }}
    >
      {side ? (
        <>
          <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
            {chooser}
            {info}
          </div>
          <div ref={fitRef} style={{ display: 'grid', gap: 10, minWidth: 0 }}>
            {figure}
            {matrixFigure}
          </div>
        </>
      ) : (
        <>
          {chooser}
          <div ref={fitRef} style={{ display: 'grid', gap: 10, minWidth: 0 }}>
            {figure}
          </div>
          {info}
          {matrixFigure}
        </>
      )}
    </div>
  )
}

function MultiplePanel({
  result,
  term,
  load,
  hovered,
  onHover,
  onPick,
  onRetry,
}: {
  result: GroupAnalysisResultV2
  term: GroupAnalysisTerm
  load: Load<GroupAnalysisMeasureDetailV2> | null
  hovered: string | null
  onHover: (subjectId: string | null) => void
  onPick: (subjectId: string) => void
  onRetry: () => void
}): ReactNode {
  const [width, frameRef] = useFrameWidth()
  return (
    <Paper frameRef={frameRef}>
      <Figure
        result={result}
        term={term}
        load={load}
        width={Math.max(200, width / SCREEN_PX_PER_PT)}
        termLine
        hovered={hovered}
        onHover={onHover}
        onPick={onPick}
        onRetry={onRetry}
      />
    </Paper>
  )
}

function MatrixPaper({
  render,
}: {
  title: string
  render: (widthPt: number) => ReactNode
}): ReactNode {
  const [width, frameRef] = useFrameWidth()
  return (
    <Paper frameRef={frameRef}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        {render(Math.min(width, 560) / SCREEN_PX_PER_PT)}
      </div>
    </Paper>
  )
}
