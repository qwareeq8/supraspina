/**
 * The result tabs, Table | Forest | Measure | Brain, sharing one selection.
 * The tab list follows the WAI-ARIA tabs pattern: arrow keys, Home, and End
 * move between tabs, and each panel is focusable. Figures preview in the
 * theme's screen palette; exports keep the print palette.
 */

import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type {
  GroupAnalysisMeasureDetail,
  GroupAnalysisResult,
} from '../../../shared/group-analysis'
import { measureLabel } from '../../../shared/brain-atlas'
import { ForestPlot } from '../../figures/forest'
import { forestModel } from '../../figures/forest-model'
import { formatValue, measureUnitText } from '../../figures/format'
import { AdjustedScatter } from '../../figures/scatter'
import { scatterModel } from '../../figures/scatter-model'
import { SCREEN_PX_PER_PT, screenPalette } from '../../figures/style'
import type { Load } from '../../state/group-analysis'
import { useApp } from '../../state/context'
import {
  Btn,
  EmptyState,
  ErrorState,
  FONTS,
  LoadingState,
  TEXT_GAP,
} from '../../ui'
import { measureFigureSize, useFitHeight, useFrameWidth } from './fit'
import { SelectField } from './controls'
import { tableHemisphere, tableMeasureName } from './describe'
import { ResultsTable } from './ResultsTable'
import type { AnalysisSelection } from './selection'
import type { BrainCapture } from './BrainView'

const BrainView = lazy(() =>
  import('./BrainView').then((module) => ({ default: module.BrainView })),
)

/** The result tabs; `grid` belongs to v2 results only. */
export type ResultTab = 'table' | 'grid' | 'forest' | 'measure' | 'brain'

const TABS: readonly { id: ResultTab; label: string }[] = [
  { id: 'table', label: 'Table' },
  { id: 'forest', label: 'Forest' },
  { id: 'measure', label: 'Measure' },
  { id: 'brain', label: 'Brain' },
]

/** A figure preview on the theme surface. */
export function Paper({
  children,
  frameRef,
}: {
  children: ReactNode
  frameRef: (el: HTMLDivElement | null) => void
}): ReactNode {
  const { t } = useApp()
  return (
    <div
      style={{
        background: t.surface,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 6,
        padding: '14px 16px',
      }}
    >
      <div ref={frameRef} style={{ maxWidth: 900, margin: '0 auto' }}>
        {children}
      </div>
    </div>
  )
}

function ForestView({
  result,
  selection,
  onSelect,
}: {
  result: GroupAnalysisResult
  selection: AnalysisSelection
  onSelect: (measureId: string) => void
}): ReactNode {
  const { t, resolvedTheme } = useApp()
  const [width, frameRef] = useFrameWidth()
  return (
    <Paper frameRef={frameRef}>
      <ForestPlot
        model={forestModel(result)}
        width={width / SCREEN_PX_PER_PT}
        mode="screen"
        palette={screenPalette(t, resolvedTheme)}
        selectedId={selection.measureId}
        onSelect={onSelect}
        title={`Forest plot: ${result.name}`}
      />
    </Paper>
  )
}

/** The panel width, in CSS pixels, from which the measure controls sit beside the figure. */
const MEASURE_SIDE_WIDTH = 700

function MeasureView({
  result,
  selection,
  detail,
  onSelect,
  onInspect,
  onRetry,
}: {
  result: GroupAnalysisResult
  selection: AnalysisSelection
  detail: Load<GroupAnalysisMeasureDetail> | null
  onSelect: (next: AnalysisSelection) => void
  onInspect: (subjectId: string) => void
  onRetry: (measureId: string) => void
}): ReactNode {
  const { t, resolvedTheme } = useApp()
  const [panelWidth, panelRef] = useFrameWidth()
  const [width, frameRef] = useFrameWidth()
  const side = panelWidth >= MEASURE_SIDE_WIDTH
  const [available, fitRef] = useFitHeight(side ? 200 : 240)
  const [hovered, setHovered] = useState<string | null>(null)
  const measureId = selection.measureId
  const chooser = (
    <div style={{ maxWidth: side ? undefined : 420, minWidth: 0 }}>
      <SelectField
        label="Measure"
        value={measureId ?? ''}
        options={[
          ...(measureId ? [] : [{ value: '', label: 'Choose a measure' }]),
          ...result.rows.map((row) => ({
            value: row.measureId,
            label: `${tableMeasureName(row.measureId)}${tableHemisphere(row.measureId) && tableHemisphere(row.measureId) !== 'Both' ? `, ${tableHemisphere(row.measureId)}` : ''}${row.significant ? ' (significant)' : ''}`,
          })),
        ]}
        onChange={(value) =>
          onSelect({ measureId: value || null, subjectId: null })
        }
      />
    </div>
  )
  if (!measureId) {
    return (
      <div ref={panelRef} style={{ display: 'grid', gap: 10 }}>
        {chooser}
        <EmptyState
          t={t}
          message="No measure is selected."
          hint="Choose one here, in the table, or in the forest plot."
        />
      </div>
    )
  }
  const focus = hovered ?? selection.subjectId
  const subject =
    detail?.phase === 'ready'
      ? detail.value.subjects.find((s) => s.subjectId === focus)
      : undefined
  const unit = measureUnitText(measureId)
  // Stacked, the subject line under the paper takes its share of the height.
  const size = measureFigureSize(
    width,
    available === null ? null : available - (side ? 0 : 38),
  )
  const info =
    detail?.phase === 'ready' ? (
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
  const figure =
    detail === null || detail.phase === 'loading' ? (
      <LoadingState
        t={t}
        label={`Reading the values of ${measureLabel(measureId)}`}
      />
    ) : detail.phase === 'error' ? (
      <ErrorState
        t={t}
        title={detail.message}
        onRetry={() => onRetry(measureId)}
      />
    ) : (
      <Paper frameRef={frameRef}>
        <div style={{ maxWidth: size.cssWidth, margin: '0 auto' }}>
          <AdjustedScatter
            model={scatterModel(detail.value, result)}
            width={size.widthPt}
            mode="screen"
            palette={screenPalette(t, resolvedTheme)}
            hoveredId={focus}
            onHover={setHovered}
            onPick={(subjectId) => onSelect({ measureId, subjectId })}
            title={`Adjusted values: ${measureLabel(measureId)}`}
          />
        </div>
      </Paper>
    )
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
          <div ref={fitRef} style={{ minWidth: 0 }}>
            {figure}
          </div>
        </>
      ) : (
        <>
          {chooser}
          <div ref={fitRef} style={{ minWidth: 0 }}>
            {figure}
          </div>
          {info}
        </>
      )}
    </div>
  )
}

/** The tab strip's inputs. */
export interface TabStripProps {
  tabs: readonly { id: ResultTab; label: string }[]
  tab: ResultTab
  onTab: (tab: ResultTab) => void
  /** The result's name and stamp, shown at the end of the tab row. */
  header?: ReactNode
}

/**
 * Render the result tab list (the WAI-ARIA tabs pattern: arrow keys, Home,
 * and End move between tabs) with the header at the end of its row.
 */
export function TabStrip({
  tabs,
  tab,
  onTab,
  header,
}: TabStripProps): ReactNode {
  const { t } = useApp()
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const move = (delta: number | 'first' | 'last'): void => {
    const index = tabs.findIndex((x) => x.id === tab)
    const next =
      delta === 'first'
        ? 0
        : delta === 'last'
          ? tabs.length - 1
          : (index + delta + tabs.length) % tabs.length
    const target = tabs[next]!
    onTab(target.id)
    refs.current[target.id]?.focus()
  }
  return (
    <div
      style={{
        display: 'flex',
        // A narrow row puts the header above the tabs, which keep the rule.
        flexWrap: 'wrap-reverse',
        alignItems: 'flex-end',
        columnGap: 16,
        rowGap: 6,
        borderBottom: `1px solid ${t.borderSoft}`,
        minWidth: 0,
      }}
    >
      <div
        role="tablist"
        aria-label="Result views"
        style={{ display: 'flex', gap: 2 }}
      >
        {tabs.map((item) => {
          const active = item.id === tab
          return (
            <button
              key={item.id}
              ref={(el) => {
                refs.current[item.id] = el
              }}
              type="button"
              role="tab"
              id={`analysis-tab-${item.id}`}
              aria-selected={active}
              aria-controls={`analysis-panel-${item.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => onTab(item.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') move(1)
                else if (event.key === 'ArrowLeft') move(-1)
                else if (event.key === 'Home') move('first')
                else if (event.key === 'End') move('last')
                else return
                event.preventDefault()
              }}
              style={{
                minHeight: 30,
                padding: '0 12px',
                marginBottom: -1,
                border: 'none',
                borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
                background: 'transparent',
                color: active ? t.text : t.dim,
                fontFamily: FONTS.sans,
                fontSize: 12,
                fontWeight: active ? 700 : 500,
                cursor: 'pointer',
              }}
            >
              {item.label}
            </button>
          )
        })}
      </div>
      {header ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            columnGap: 10,
            rowGap: 4,
            marginLeft: 'auto',
            paddingBottom: 6,
            minWidth: 0,
          }}
        >
          {header}
        </div>
      ) : null}
    </div>
  )
}

/** The result tabs' inputs. */
export interface ResultTabsProps {
  result: GroupAnalysisResult
  tab: ResultTab
  onTab: (tab: ResultTab) => void
  selection: AnalysisSelection
  onSelection: (next: AnalysisSelection) => void
  detail: Load<GroupAnalysisMeasureDetail> | null
  requestDetail: (measureId: string) => void
  /** Receive the Brain tab's drawn view for export, or null. */
  onBrainCapture?: ((capture: BrainCapture | null) => void) | undefined
  /** The result's name and stamp, shown at the end of the tab row. */
  header?: ReactNode
}

/** Render the result tabs and the shown panel. */
export function ResultTabs({
  result,
  tab,
  onTab,
  selection,
  onSelection,
  detail,
  requestDetail,
  onBrainCapture,
  header,
}: ResultTabsProps): ReactNode {
  const { t } = useApp()
  const measureId = selection.measureId
  // The subject whose brain was asked for; the Brain tab opens its volumes.
  const [inspected, setInspected] = useState<string | null>(null)
  useEffect(() => {
    if (tab === 'measure' && measureId) requestDetail(measureId)
  }, [tab, measureId, requestDetail])

  const selectMeasure = (id: string): void =>
    onSelection({ measureId: id, subjectId: null })
  // A v2 tab such as Grid shows the table of a v1 result.
  const shown = TABS.some((item) => item.id === tab) ? tab : 'table'

  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <TabStrip tabs={TABS} tab={shown} onTab={onTab} header={header} />
      <div
        role="tabpanel"
        id={`analysis-panel-${shown}`}
        aria-labelledby={`analysis-tab-${shown}`}
        tabIndex={0}
        style={{ minWidth: 0 }}
      >
        {shown === 'table' && (
          <ResultsTable
            result={result}
            selectedId={measureId}
            onSelect={selectMeasure}
            onOpen={(id) => {
              selectMeasure(id)
              onTab('measure')
            }}
          />
        )}
        {shown === 'forest' && (
          <ForestView
            result={result}
            selection={selection}
            onSelect={selectMeasure}
          />
        )}
        {shown === 'measure' && (
          <MeasureView
            result={result}
            selection={selection}
            detail={detail}
            onSelect={onSelection}
            onRetry={requestDetail}
            onInspect={(subjectId) => {
              setInspected(subjectId)
              onSelection({ measureId, subjectId })
              onTab('brain')
            }}
          />
        )}
        {shown === 'brain' && (
          <Suspense
            fallback={<LoadingState t={t} label="Loading the brain view" />}
          >
            <BrainView
              result={result}
              selection={selection.measureId}
              subjectId={selection.subjectId}
              onSelect={(measureId) => onSelection({ ...selection, measureId })}
              onCapture={onBrainCapture}
              openVolumes={
                selection.subjectId !== null &&
                inspected === selection.subjectId
              }
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}
