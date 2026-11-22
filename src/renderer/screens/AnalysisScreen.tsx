/**
 * The Analysis panel: group comparisons and associations over the
 * pipeline's region tables, in the manner of CONN's second-level results
 * explorer. A controls rail edits the analysis specification; Compute runs
 * it in the workflow service; the result shows as a table, a forest plot,
 * a per-subject measure figure, and a brain map, sharing one selection.
 *
 * The panel follows the app's lifecycle: its state belongs to the open
 * project generation, stored results are judged again when a run ends or QC
 * or the saved cohort changes, and a result computed from out-of-date tables
 * is stamped Provisional.
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  analysisProjectKey,
  analysisRejudgeKey,
  analysisStageCurrency,
  useGroupAnalysis,
} from '../state/group-analysis'
import { useAtlasLabeling } from '../state/atlas-labeling'
import { useApp } from '../state/context'
import { useRuntime } from '../state/runtime-state'
import {
  cohortConfigKey,
  useProjectStageCurrency,
} from '../state/stage-currency'
import {
  Bar,
  Btn,
  Chip,
  EmptyState,
  ErrorState,
  FONTS,
  Ico,
  ICONS,
  ICON_SIZE,
  LoadingState,
  Modal,
  Page,
  TEXT_GAP,
  TextPill,
} from '../ui'
import { useAvailableHeight } from '../ui/useAvailableHeight'
import type { ChipStatus } from '../../shared/types'
import { ControlsRail } from './analysis/ControlsRail'
import {
  Notice,
  PipelineCurrencyNotice,
  StaleResultNotice,
} from './analysis/CurrencyNotice'
import {
  draftStages,
  missingOutputText,
  skippedText,
  specSummary,
} from './analysis/describe'
import type { BrainCapture } from './analysis/BrainView'
import { ExportDialog } from './analysis/ExportDialog'
import { ResultTabs, type ResultTab } from './analysis/ResultTabs'
import { initialMeasure, type AnalysisSelection } from './analysis/selection'
import { ResultViewV2 } from './analysis/v2/ResultViewV2'
import { variableChoices } from './analysis/variables'

/** Below this content width, in CSS pixels, the rail becomes a side sheet. */
export const ANALYSIS_NARROW_WIDTH = 900

const PHASE_TEXT = {
  preparing: 'Preparing the sample',
  fitting: 'Fitting the models',
  permuting: 'Permuting',
  writing: 'Writing the result',
} as const

/** Format a result's compute time as a medium date and a short time. */
function formatComputed(createdAt: string | number): string {
  return new Date(createdAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** Track an element's content width in CSS pixels. */
function useContentWidth(): [
  number | null,
  (el: HTMLDivElement | null) => void,
] {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!el) return undefined
    const update = (): void =>
      setWidth(el.clientWidth > 0 ? el.clientWidth : null)
    update()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return [width, setEl]
}

function RailFrame({ children }: { children: ReactNode }): ReactNode {
  const { t } = useApp()
  const fit = useAvailableHeight<HTMLDivElement>({
    minHeight: 320,
    trailing: 2,
  })
  return (
    <aside
      ref={fit}
      aria-label="Analysis settings"
      style={{
        // Contain absolutely positioned descendants (visually hidden
        // legends), which would otherwise escape the clip and scroll the page.
        position: 'relative',
        overflowY: 'auto',
        background: t.surface,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 6,
        minWidth: 0,
      }}
    >
      {children}
    </aside>
  )
}

/** Render the Analysis panel. */
export function AnalysisScreen(): ReactNode {
  const { t, projectRef, setRoute, subjects, savedCfg } = useApp()
  const runtime = useRuntime()
  const currencyRead = useProjectStageCurrency({
    project: projectRef,
    subjects,
    runs: runtime.runs,
    configKey: cohortConfigKey(savedCfg),
  })
  const stageCurrency = analysisStageCurrency(currencyRead)
  const rejudgeKey = useMemo(
    () => analysisRejudgeKey(subjects, runtime.runs, savedCfg),
    [subjects, runtime.runs, savedCfg],
  )
  const state = useGroupAnalysis(projectRef, { rejudgeKey })
  const labeling = useAtlasLabeling(projectRef, {
    stageCurrency,
    onChanged: state.rereadCatalog,
  })
  const [width, bodyRef] = useContentWidth()
  const narrow = width !== null && width < ANALYSIS_NARROW_WIDTH
  const [sheet, setSheet] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [tab, setTab] = useState<ResultTab>('forest')
  const [brainCapture, setBrainCapture] = useState<BrainCapture | null>(null)
  const projectKey = analysisProjectKey(projectRef)
  const [tagged, setTagged] = useState<{
    key: string | null
    selection: AnalysisSelection
  }>({
    key: projectKey,
    selection: { measureId: null, subjectId: null },
  })
  const stored =
    tagged.key === projectKey
      ? tagged.selection
      : { measureId: null, subjectId: null }
  const setSelection = useCallback(
    (next: AnalysisSelection) =>
      setTagged({ key: projectKey, selection: next }),
    [projectKey],
  )
  const openRuns = useCallback(() => setRoute('runs'), [setRoute])
  const openDiagnostics = useCallback(() => setRoute('diagnostics'), [setRoute])

  const result = state.result?.phase === 'ready' ? state.result.value : null
  const list = state.list.phase === 'ready' ? state.list.value : null
  const summary =
    list?.results.find((r) => r.resultId === state.resultId) ?? null

  // Open a result on its first significant measure, or keep the selection
  // when the result has that measure.
  const measureId = result
    ? initialMeasure(result, stored.measureId)
    : stored.measureId
  const selection: AnalysisSelection = {
    measureId,
    subjectId: measureId === stored.measureId ? stored.subjectId : null,
  }

  const draft = state.draft
  const catalog = state.catalog.phase === 'ready' ? state.catalog.value : null
  // Before the first Run all, the tables the draft reads do not exist yet.
  const missingOutput =
    draft && catalog
      ? missingOutputText(draftStages(draft), catalog.inputs)
      : null
  const inputs =
    state.inputs?.phase === 'ready' && !missingOutput
      ? state.inputs.value
      : null
  const runLive = runtime.activeCount > 0
  // A blocking design-check finding stops Compute, as the sidecar would.
  const designBlocked = inputs?.designCheck?.ok === false
  const computeBlocked =
    !projectRef ||
    !draft ||
    state.running ||
    state.draftErrors.length > 0 ||
    !catalog ||
    missingOutput !== null ||
    designBlocked

  // A failed compute's notice belongs to the input tables it failed on; it
  // clears once they change, as when a run writes them.
  const inputsKey = catalog
    ? catalog.inputs
        .map((i) => `${i.source}:${String(i.present)}:${i.sha256 ?? ''}`)
        .join('|')
    : null
  const [failure, setFailure] = useState<{
    operationId: string
    inputsKey: string | null
  } | null>(null)
  const failedId =
    state.operation?.state === 'failed' ? state.operation.operationId : null
  if (
    failedId &&
    (failure?.operationId !== failedId ||
      (failure.inputsKey === null && inputsKey !== null))
  ) {
    setFailure({ operationId: failedId, inputsKey })
  }
  const failureCurrent =
    failedId !== null &&
    failure?.operationId === failedId &&
    (failure.inputsKey === null || failure.inputsKey === inputsKey)
  const compute = (): void => {
    if (!computeBlocked) void state.compute(stageCurrency)
  }

  // "Current" needs both layers judged: the result against its inputs, and
  // the pipeline stages whose tables it reads.
  const resultStages = result
    ? draftStages(result.spec)
    : draft
      ? draftStages(draft)
      : (['aggregate', 'pybrainage'] as const)
  const stageStates = resultStages.map((stage) => stageCurrency[stage])
  // A result without a fitted measure is never Current.
  const noFit =
    result !== null &&
    (result.schemaVersion === 1
      ? result.rows.length === 0
      : result.terms.every((term) => term.rowCount === 0))
  const chip: { status: ChipStatus; label: string } = state.running
    ? { status: 'running', label: 'Computing' }
    : noFit
      ? { status: 'failed', label: 'No measure fit' }
      : !summary
        ? { status: 'pending', label: 'Not computed' }
        : summary.currency === 'stale'
          ? { status: 'outdated', label: 'Out of date' }
          : summary.provisional || stageStates.includes('outdated')
            ? { status: 'warn', label: 'Provisional' }
            : summary.currency === 'unknown' || stageStates.includes('unknown')
              ? { status: 'pending', label: 'Not yet judged' }
              : { status: 'done', label: 'Current' }

  const header = (
    <>
      <Chip t={t} status={chip.status} label={chip.label} />
      {state.running ? (
        <Btn
          t={t}
          label="Cancel"
          ariaLabel="Cancel the compute"
          icon={<Ico d={ICONS.stop} size={ICON_SIZE.nav} />}
          onClick={() => void state.cancel()}
        />
      ) : (
        // The run dock holds the view's one accent button, so Compute stays
        // neutral.
        <Btn
          t={t}
          label="Compute"
          icon={<Ico d={ICONS.play} size={ICON_SIZE.nav} />}
          disabled={computeBlocked}
          title={
            missingOutput ??
            state.draftErrors[0] ??
            (designBlocked ? 'The design check blocks Compute.' : undefined)
          }
          onClick={compute}
        />
      )}
      <Btn
        t={t}
        label="Export..."
        disabled={!result || noFit || !projectRef}
        onClick={() => setExporting(true)}
      />
    </>
  )

  if (!projectRef) {
    return (
      <Page t={t} title="Analysis">
        <EmptyState t={t} message="No project is open." />
      </Page>
    )
  }

  const rail =
    draft && state.catalog.phase === 'ready' ? (
      <ControlsRail
        state={state}
        draft={draft}
        catalog={state.catalog.value}
        labeling={labeling}
        onOpenRuns={openRuns}
        onOpenDiagnostics={openDiagnostics}
      />
    ) : null

  const operation = state.operation
  const progress =
    operation && operation.state === 'running' ? (
      <div
        role="status"
        style={{
          display: 'grid',
          gap: 6,
          padding: '10px 12px',
          border: `1px solid ${t.borderSoft}`,
          borderRadius: 6,
          background: t.surface,
        }}
      >
        <span style={{ fontFamily: FONTS.sans, fontSize: 12, color: t.text }}>
          {operation.phase ? PHASE_TEXT[operation.phase] : 'Computing'}
          {operation.phase === 'permuting' && operation.total > 1
            ? `: ${operation.completed.toLocaleString('en-US')} of ${operation.total.toLocaleString('en-US')}`
            : ''}
        </span>
        {operation.phase === 'permuting' && (
          <Bar
            t={t}
            value={operation.completed}
            max={Math.max(1, operation.total)}
            color={t.running}
          />
        )}
      </div>
    ) : null

  const stopped = state.interrupted ? (
    <Notice
      tone="error"
      headline="The analysis stopped because the workflow service restarted."
      detail="Compute again."
    />
  ) : operation &&
    ((operation.state === 'failed' && failureCurrent) ||
      operation.state === 'cancelled') ? (
    <Notice
      tone={operation.state === 'failed' ? 'error' : 'info'}
      headline={
        operation.state === 'failed'
          ? (operation.message ?? 'The analysis failed.')
          : 'The compute was canceled; the shown result is unchanged.'
      }
      detail={
        operation.state === 'failed'
          ? [
              // The compute's own skip reasons, else the draft's.
              skippedText(
                operation.skipped ??
                  (state.inputs?.phase === 'ready'
                    ? state.inputs.value.skippedMeasures
                    : []),
              ),
              'Compute again to retry.',
            ]
              .filter(Boolean)
              .join(' ')
          : null
      }
    />
  ) : null

  let results: ReactNode
  if (state.list.phase === 'error') {
    results = (
      <ErrorState t={t} title={state.list.message} onRetry={state.reload} />
    )
  } else if (
    state.list.phase === 'loading' ||
    (state.resultId !== null && state.result?.phase !== 'error' && !result)
  ) {
    results = <LoadingState t={t} label="Reading the stored analyses" />
  } else if (state.result?.phase === 'error') {
    results = (
      <ErrorState t={t} title={state.result.message} onRetry={state.reload} />
    )
  } else if (!result) {
    results = (
      <EmptyState
        t={t}
        icon="chart"
        message="No analysis has been computed for this project."
        hint="Choose the measures and the contrast, then select Compute."
      />
    )
  } else if (noFit) {
    results = (
      <Notice
        tone="attention"
        headline="No measure could be fit in this result."
        detail={[
          skippedText(result.skipped),
          'Change the measures, covariates, or inclusion rules and compute again.',
        ]
          .filter(Boolean)
          .join(' ')}
      />
    )
  } else {
    // The result's name and stamp share the tab row, which leaves the
    // figures the height of a short window.
    const resultHeader = (
      <>
        {list && list.results.length > 1 ? (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: FONTS.sans,
              fontSize: 11,
              color: t.dim,
            }}
          >
            Result
            <select
              value={state.resultId ?? ''}
              onChange={(event) => state.selectResult(event.target.value)}
              title={`${result.name}, ${formatComputed(result.createdAt)}`}
              style={{
                height: 'var(--ss-input-h)',
                maxWidth: 360,
                padding: '0 6px',
                border: `1px solid ${t.dim}`,
                borderRadius: 4,
                background: t.bg,
                color: t.text,
                fontFamily: FONTS.sans,
                fontSize: 11.5,
              }}
            >
              {list.results.map((r) => (
                <option key={r.resultId} value={r.resultId}>
                  {r.name}, {formatComputed(r.createdAt)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span
            style={{
              fontFamily: FONTS.serif,
              fontSize: 14,
              color: t.textStrong,
            }}
          >
            {result.name}
          </span>
        )}
        {/* The Result select already states each result's time. */}
        {!(list && list.results.length > 1) && (
          <span
            style={{ fontFamily: FONTS.sans, fontSize: 11, color: t.dimText }}
          >
            Computed {formatComputed(result.createdAt)}
          </span>
        )}
        {result.provisional && (
          <TextPill t={t} label="Provisional" color={t.warning} />
        )}
        {state.draftChanged && (
          <span
            style={{
              fontFamily: FONTS.sans,
              fontSize: 11,
              color: t.dimText,
            }}
          >
            The settings differ from this result.
          </span>
        )}
      </>
    )
    results = (
      <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
        {result.sample.issues.length > 0 && (
          <Notice
            tone="attention"
            headline={result.sample.issues[0]!}
            detail={result.sample.issues.slice(1).join(' ') || null}
          />
        )}
        {result.schemaVersion === 1 ? (
          <ResultTabs
            header={resultHeader}
            result={result}
            tab={tab}
            onTab={setTab}
            selection={selection}
            onSelection={setSelection}
            detail={
              selection.measureId ? state.detail(selection.measureId) : null
            }
            requestDetail={state.requestDetail}
            onBrainCapture={setBrainCapture}
          />
        ) : (
          <ResultViewV2
            project={projectRef}
            result={result}
            header={resultHeader}
            tab={tab}
            onTab={setTab}
            selection={selection}
            onSelection={setSelection}
            exporting={exporting}
            onExportClose={() => setExporting(false)}
          />
        )}
      </div>
    )
  }

  const summaryParts =
    draft && catalog
      ? specSummary(
          draft,
          inputs,
          stageCurrency,
          variableChoices(catalog, draft.variables.derived),
        )
      : []

  return (
    <Page t={t} title="Analysis" right={header}>
      <div
        ref={bodyRef}
        style={{ display: 'grid', gap: 'var(--ss-section-gap)', minWidth: 0 }}
      >
        {state.catalog.phase === 'error' && (
          <ErrorState
            t={t}
            title={state.catalog.message}
            onRetry={state.reload}
          />
        )}
        {state.actionError && (
          <ErrorState
            t={t}
            title={state.actionError}
            onDismiss={state.dismissError}
          />
        )}
        {missingOutput && (
          <Notice
            tone="attention"
            headline={missingOutput}
            detail="Compute becomes available once the table exists."
            action={{
              label: 'Open Runs',
              onClick: openRuns,
              title: 'Open Runs to start the pipeline.',
            }}
          />
        )}
        {runLive && (
          <Notice
            tone="info"
            headline="A run is live."
            detail="A compute now reads the tables on disk as they are; the result is judged again when the run ends."
          />
        )}
        {draft && (
          <PipelineCurrencyNotice
            stages={draftStages(draft)}
            currency={stageCurrency}
            stageCurrency={currencyRead.stageCurrency}
            change={currencyRead.analysisCohortChange}
            onOpenRuns={openRuns}
          />
        )}
        <StaleResultNotice
          summary={summary}
          onCompute={compute}
          computeDisabled={computeBlocked}
        />
        {stopped}
        {summaryParts.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              minWidth: 0,
            }}
          >
            <p
              style={{
                margin: 0,
                flex: '1 1 auto',
                minWidth: 0,
                fontFamily: FONTS.sans,
                fontSize: 11.5,
                lineHeight: 1.5,
                color: t.textSoft,
              }}
            >
              {summaryParts.map((part, index) => (
                <span
                  key={index}
                  style={{ whiteSpace: 'nowrap', display: 'inline-block' }}
                >
                  {part}
                  {index < summaryParts.length - 1 && TEXT_GAP}
                </span>
              ))}
            </p>
            {narrow && rail && (
              <Btn
                t={t}
                small
                label="Edit analysis"
                icon={<Ico d={ICONS.sliders} size={ICON_SIZE.nav} />}
                onClick={() => setSheet(true)}
              />
            )}
          </div>
        )}
        {state.draftErrors.length > 0 && (
          <Notice
            tone="attention"
            headline="The analysis cannot compute yet."
            detail={state.draftErrors.join(' ')}
          />
        )}
        {state.catalog.phase === 'loading' ? (
          <LoadingState t={t} label="Reading the analysis catalog" />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                narrow || !rail
                  ? 'minmax(0, 1fr)'
                  : 'clamp(260px, 26vw, 320px) minmax(0, 1fr)',
              gap: 16,
              alignItems: 'start',
              minWidth: 0,
            }}
          >
            {!narrow && rail && <RailFrame>{rail}</RailFrame>}
            <section
              aria-label="Results"
              style={{ display: 'grid', gap: 10, minWidth: 0 }}
            >
              {progress}
              {results}
            </section>
          </div>
        )}
      </div>
      {narrow && sheet && rail && (
        <Modal
          t={t}
          label="Analysis settings"
          align="start"
          onDismiss={() => setSheet(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSheet(false)
          }}
          cardStyle={{
            width: 'min(360px, 100%)',
            marginLeft: 'auto',
            borderRadius: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '10px 12px',
              borderBottom: `1px solid ${t.borderSoft}`,
            }}
          >
            <h2
              style={{
                margin: 0,
                fontFamily: FONTS.serif,
                fontWeight: 400,
                fontSize: 18,
                color: t.textStrong,
              }}
            >
              Analysis settings
            </h2>
            <span style={{ flex: 1 }} />
            <Btn t={t} small label="Done" onClick={() => setSheet(false)} />
          </div>
          {rail}
        </Modal>
      )}
      {exporting && result?.schemaVersion === 1 && (
        <ExportDialog
          project={projectRef}
          result={result}
          measureId={selection.measureId}
          detail={
            selection.measureId ? state.detail(selection.measureId) : null
          }
          requestDetail={state.requestDetail}
          brain={tab === 'brain' ? brainCapture : null}
          onClose={() => setExporting(false)}
        />
      )}
    </Page>
  )
}
