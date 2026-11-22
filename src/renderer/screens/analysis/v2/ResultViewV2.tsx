/**
 * The results view of a v2 result: the term selector, then Table | Grid |
 * Forest | Measure | Brain sharing one measure selection. The selected term
 * drives the table, the measure figure, the term forest, and the brain map;
 * the grid lays every test (or pair, or stratum) beside the measures; the
 * forest can also draw the battery (every test on the partial r scale) or
 * the strata (per stratum and pooled, with the heterogeneity p).
 *
 * Rows are read page by page as the views need them; the export dialog of a
 * v2 result lives here, since it draws the figures this view shows.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type {
  GroupAnalysisResultV2,
  GroupAnalysisRowV2,
} from '../../../../shared/group-analysis'
import type { ProjectRef } from '../../../../shared/types'
import { ForestPlot } from '../../../figures/forest'
import {
  FOREST_ROWS_PER_PAGE,
  type ForestModel,
} from '../../../figures/forest-model'
import {
  batteryForestModel,
  strataForestModel,
  termForestModel,
  topTermRows,
} from '../../../figures/forest-model-v2'
import { gridTermChoices, type GridTerms } from '../../../figures/grid-model'
import { SCREEN_PX_PER_PT, screenPalette } from '../../../figures/style'
import { useAnalysisTerms } from '../../../state/analysis-terms'
import { useApp } from '../../../state/context'
import { EmptyState, LoadingState, Segments } from '../../../ui'
import type { BrainCapture } from '../BrainView'
import { Notice } from '../CurrencyNotice'
import { useFrameWidth } from '../fit'
import { Paper, TabStrip, type ResultTab } from '../ResultTabs'
import type { AnalysisSelection } from '../selection'
import { ExportDialogV2 } from './ExportDialogV2'
import { GridView } from './GridView'
import { MeasureViewV2, type MeasureLayout } from './MeasureViewV2'
import { TermSelector } from './TermSelector'
import { TermTable } from './TermTable'
import { initialTerm, pairTerms, strataTerms, termTitle } from './terms'

const BrainView = lazy(() =>
  import('../BrainView').then((module) => ({ default: module.BrainView })),
)

const TABS: readonly { id: ResultTab; label: string }[] = [
  { id: 'table', label: 'Table' },
  { id: 'grid', label: 'Grid' },
  { id: 'forest', label: 'Forest' },
  { id: 'measure', label: 'Measure' },
  { id: 'brain', label: 'Brain' },
]

/** Which forest the Forest tab draws. */
export type ForestKind = 'term' | 'battery' | 'strata'

const EMPTY: readonly GroupAnalysisRowV2[] = []

/** The results view's inputs. */
export interface ResultViewV2Props {
  project: ProjectRef
  result: GroupAnalysisResultV2
  tab: ResultTab
  onTab: (tab: ResultTab) => void
  selection: AnalysisSelection
  onSelection: (next: AnalysisSelection) => void
  /** The result's name and stamp, shown at the end of the tab row. */
  header?: ReactNode
  /** Show the export dialog. */
  exporting: boolean
  onExportClose: () => void
}

export function ResultViewV2({
  project,
  result,
  tab,
  onTab,
  selection,
  onSelection,
  header,
  exporting,
  onExportClose,
}: ResultViewV2Props): ReactNode {
  const { t } = useApp()
  const terms = useAnalysisTerms(project, result)
  const [picked, setPicked] = useState<{
    resultId: string
    termId: string
  } | null>(null)
  const termId = initialTerm(
    result,
    picked?.resultId === result.resultId ? picked.termId : null,
  )
  const term = result.terms.find((item) => item.termId === termId) ?? null
  const [gridChoice, setGridChoice] = useState<GridTerms>('tests')
  const [forestKind, setForestKind] = useState<ForestKind>('term')
  const [layout, setLayout] = useState<MeasureLayout>('term')
  const [brainCapture, setBrainCapture] = useState<BrainCapture | null>(null)
  const [inspected, setInspected] = useState<string | null>(null)

  const choices = useMemo(() => gridTermChoices(result), [result])
  const availableChoices = (['tests', 'pairs', 'strata'] as const).filter(
    (choice) => choices[choice].length > 0,
  )
  const grid = availableChoices.includes(gridChoice)
    ? gridChoice
    : (availableChoices[0] ?? 'tests')
  const gridTerms = choices[grid]

  const termRows = terms.termRows
  const rowsOf = useCallback(
    (id: string): readonly GroupAnalysisRowV2[] => termRows(id)?.rows ?? EMPTY,
    [termRows],
  )
  const rows = term ? rowsOf(term.termId) : EMPTY
  const strata = term ? strataTerms(result, term) : null
  const battery = useMemo(
    () => batteryForestModel(result, rowsOf, result.spec.measures),
    [result, rowsOf],
  )
  const forestKinds: ForestKind[] = [
    'term',
    ...(battery ? (['battery'] as const) : []),
    ...(strata && strata.strata.length > 0 ? (['strata'] as const) : []),
  ]
  const forest = forestKinds.includes(forestKind) ? forestKind : 'term'

  // The terms each view needs, read a page at a time.
  const { ensure, requestDetail } = terms
  const needed = useMemo((): string[] => {
    if (!term) return []
    const ids = new Set([term.termId])
    if (tab === 'grid') for (const item of gridTerms) ids.add(item.termId)
    if (tab === 'forest' && forest === 'battery') {
      for (const item of result.terms) {
        if (item.role === 'effect' && item.kind === 't' && !item.stratum)
          ids.add(item.termId)
      }
    }
    const stratified = strata
      ? [strata.pooled, ...strata.strata, strata.heterogeneity]
      : []
    if ((tab === 'forest' && forest === 'strata') || tab === 'measure') {
      for (const item of stratified) if (item) ids.add(item.termId)
    }
    if (tab === 'measure') {
      for (const item of pairTerms(result, term)) ids.add(item.termId)
    }
    return [...ids]
  }, [term, tab, gridTerms, forest, result, strata])
  useEffect(() => {
    ensure(needed)
  }, [ensure, needed])

  const measureId = selection.measureId
  useEffect(() => {
    if (!term || !measureId || tab !== 'measure') return
    requestDetail(term.termId, measureId)
    if (layout === 'strata' && strata) {
      for (const item of [strata.pooled, ...strata.strata]) {
        if (item) requestDetail(item.termId, measureId)
      }
    }
  }, [term, measureId, tab, layout, strata, requestDetail])

  const selectTerm = (id: string): void =>
    setPicked({ resultId: result.resultId, termId: id })
  const selectMeasure = (id: string): void =>
    onSelection({ measureId: id, subjectId: null })

  // The measures in the spec's order that the shown terms have rows for.
  const gridMeasures = useMemo(() => {
    const present = new Set(
      gridTerms.flatMap((item) =>
        rowsOf(item.termId).map((row) => row.measureId),
      ),
    )
    return result.spec.measures.filter((id) => present.has(id))
  }, [gridTerms, rowsOf, result.spec.measures])
  const forestMeasures = useMemo(
    () => topTermRows(rows).map((row) => row.measureId),
    [rows],
  )

  const forestModel = useMemo((): ForestModel | null => {
    if (!term) return null
    if (forest === 'battery' && battery) {
      return batteryForestModel(result, rowsOf, forestMeasures)
    }
    if (forest === 'strata' && strata && strata.strata.length > 0) {
      return strataForestModel(
        result,
        strata.pooled,
        strata.strata,
        strata.heterogeneity,
        rowsOf,
        forestMeasures,
      )
    }
    const shown = rows.length > FOREST_ROWS_PER_PAGE ? topTermRows(rows) : rows
    return termForestModel(result, term, shown, term.rowCount)
  }, [term, forest, battery, strata, result, rowsOf, forestMeasures, rows])

  if (!term) {
    return <EmptyState t={t} message="This result has no terms." />
  }
  const state = termRows(term.termId)
  const loadingGrid = gridTerms.some((item) => {
    const entry = termRows(item.termId)
    return entry?.loading ?? false
  })

  return (
    <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <TabStrip tabs={TABS} tab={tab} onTab={onTab} header={header} />
      {tab !== 'grid' && (
        <TermSelector
          result={result}
          termId={term.termId}
          onTerm={selectTerm}
          trailing={
            tab === 'forest' && forestKinds.length > 1 ? (
              <Segments
                t={t}
                small
                ariaLabel="Forest"
                value={forest}
                options={forestKinds.map((value) => ({
                  value,
                  label: FOREST_KIND_LABEL[value],
                }))}
                onChange={(value) => setForestKind(value as ForestKind)}
              />
            ) : undefined
          }
        />
      )}
      <div
        role="tabpanel"
        id={`analysis-panel-${tab}`}
        aria-labelledby={`analysis-tab-${tab}`}
        tabIndex={0}
        style={{ minWidth: 0 }}
      >
        {tab === 'table' &&
          (state ? (
            <TermTable
              result={result}
              term={term}
              rows={state}
              selectedId={measureId}
              onSelect={selectMeasure}
              onOpen={(id) => {
                selectMeasure(id)
                onTab('measure')
              }}
              onReadMore={() => terms.readMore([term.termId])}
            />
          ) : null)}
        {tab === 'grid' && (
          <GridView
            result={result}
            choice={grid}
            choices={availableChoices}
            onChoice={setGridChoice}
            terms={gridTerms}
            rowsOf={rowsOf}
            measureIds={gridMeasures}
            loading={loadingGrid}
            selectedMeasure={measureId}
            selectedTerm={term.termId}
            onSelect={(id, cellTerm) => {
              selectMeasure(id)
              if (cellTerm) selectTerm(cellTerm)
            }}
            onOpen={(id, cellTerm) => {
              selectMeasure(id)
              selectTerm(cellTerm)
              onTab('measure')
            }}
          />
        )}
        {tab === 'forest' && forestModel && (
          <ForestPanel
            model={forestModel}
            title={`Forest plot: ${result.name}, ${forest === 'battery' ? 'all tests' : termTitle(result, term)}`}
            selectedId={measureId}
            onSelect={selectMeasure}
            loading={state?.loading ?? false}
          />
        )}
        {tab === 'measure' && (
          <MeasureViewV2
            result={result}
            term={term}
            rows={rows}
            rowsOf={rowsOf}
            selection={selection}
            onSelect={onSelection}
            detail={terms.detail}
            onRetry={requestDetail}
            onInspect={(subjectId) => {
              setInspected(subjectId)
              onSelection({ measureId, subjectId })
              onTab('brain')
            }}
            layout={layout}
            onLayout={setLayout}
          />
        )}
        {tab === 'brain' &&
          (term.kind === 't' ? (
            <Suspense
              fallback={<LoadingState t={t} label="Loading the brain view" />}
            >
              <BrainView
                result={result}
                term={term}
                rows={rows}
                selection={measureId}
                subjectId={selection.subjectId}
                onSelect={(id) => onSelection({ ...selection, measureId: id })}
                onCapture={setBrainCapture}
                openVolumes={
                  selection.subjectId !== null &&
                  inspected === selection.subjectId
                }
              />
            </Suspense>
          ) : (
            <Notice
              tone="info"
              headline="The brain map draws signed effects; an F test has none."
              detail="Choose one of its pairs, or a t test, in Term to map it."
            />
          ))}
      </div>
      {exporting && (
        <ExportDialogV2
          project={project}
          result={result}
          term={term}
          rowsOf={rowsOf}
          complete={(id) => termRows(id)?.nextOffset === null}
          forest={forestModel}
          forestTitle={`Forest plot: ${result.name}, ${forest === 'battery' ? 'all tests' : termTitle(result, term)}`}
          gridTerms={gridTerms}
          gridMeasures={gridMeasures}
          measureId={measureId}
          detail={measureId ? terms.detail(term.termId, measureId) : null}
          requestDetail={requestDetail}
          brain={tab === 'brain' ? brainCapture : null}
          onClose={onExportClose}
        />
      )}
    </div>
  )
}

const FOREST_KIND_LABEL: Readonly<Record<ForestKind, string>> = {
  term: 'This term',
  battery: 'All tests',
  strata: 'Strata',
}

function ForestPanel({
  model,
  title,
  selectedId,
  onSelect,
  loading,
}: {
  model: ForestModel
  title: string
  selectedId: string | null
  onSelect: (measureId: string) => void
  loading: boolean
}): ReactNode {
  const { t, resolvedTheme } = useApp()
  const [width, frameRef] = useFrameWidth()
  const rows = model.groups.reduce((sum, group) => sum + group.rows.length, 0)
  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      {rows === 0 ? (
        loading ? (
          <LoadingState t={t} label="Reading the rows of this term" />
        ) : (
          <EmptyState t={t} message="No measure has a value to draw." />
        )
      ) : (
        <Paper frameRef={frameRef}>
          <ForestPlot
            model={model}
            width={width / SCREEN_PX_PER_PT}
            mode="screen"
            palette={screenPalette(t, resolvedTheme)}
            selectedId={selectedId}
            onSelect={onSelect}
            title={title}
          />
        </Paper>
      )}
    </div>
  )
}
