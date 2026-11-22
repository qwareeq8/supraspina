/**
 * Export a v2 result: results.csv (one row per term and measure),
 * spec.json, and the term, grid, and atlas-license tables always; the
 * figures the view shows (the forest, the grid, the selected measure's
 * pairwise matrix and measure figure, the brain view) as SVG, PDF, or PNG
 * at a journal column width; and, only when asked, subjects.csv with
 * participant IDs. Main creates a new dated folder and never overwrites.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { measureLabel } from '../../../../shared/brain-atlas'
import type {
  GroupAnalysisExportResult,
  GroupAnalysisMeasureDetailV2,
  GroupAnalysisResultV2,
  GroupAnalysisRowV2,
  GroupAnalysisTerm,
} from '../../../../shared/group-analysis'
import type { ProjectRef } from '../../../../shared/types'
import {
  MAX_EXPORT_FIGURES,
  assertExportFits,
} from '../../../figures/figure-export'
import {
  buildExportFiguresV2,
  exportFigureCountV2,
  type FigureExportRequestV2,
} from '../../../figures/figure-export-v2'
import { fileSlug } from '../../../figures/format'
import type { ForestModel } from '../../../figures/forest-model'
import { gridTransposed } from '../../../figures/grid-layout'
import { gridModel } from '../../../figures/grid-model'
import { pairwiseMatrixModel } from '../../../figures/pairwise-matrix-model'
import { scatterModelV2 } from '../../../figures/scatter-model-v2'
import {
  FIGURE_DPIS,
  FIGURE_WIDTHS_MM,
  type FigureDpi,
  type FigureWidthMm,
} from '../../../figures/style'
import { getApi } from '../../../state/api'
import type { Load } from '../../../state/group-analysis'
import { useApp } from '../../../state/context'
import {
  Btn,
  FONTS,
  Field,
  Modal,
  PathRow,
  Segments,
  TextInput,
} from '../../../ui'
import type { BrainCapture } from '../BrainView'
import { CheckRow } from '../controls'
import { Notice } from '../CurrencyNotice'
import { exportFolderError, exportFolderName } from '../describe'
import { termTitle } from './terms'

/** The export dialog's inputs. */
export interface ExportDialogV2Props {
  project: ProjectRef
  result: GroupAnalysisResultV2
  term: GroupAnalysisTerm
  rowsOf: (termId: string) => readonly GroupAnalysisRowV2[]
  /** True when every row of a term has been read. */
  complete: (termId: string) => boolean
  /** The forest the Forest tab draws, or null. */
  forest: ForestModel | null
  forestTitle: string
  gridTerms: readonly GroupAnalysisTerm[]
  gridMeasures: readonly string[]
  measureId: string | null
  detail: Load<GroupAnalysisMeasureDetailV2> | null
  requestDetail: (termId: string, measureId: string) => void
  /** The Brain tab's drawn view, or null while none is drawn. */
  brain?: BrainCapture | null | undefined
  onClose: () => void
}

type Phase =
  | { phase: 'idle' }
  | { phase: 'working' }
  | { phase: 'done'; written: GroupAnalysisExportResult; requested: string }
  | { phase: 'error'; message: string }

function Label({ children }: { children: ReactNode }): ReactNode {
  const { t } = useApp()
  return (
    <span
      style={{
        fontFamily: FONTS.sans,
        fontSize: 11,
        color: t.dim,
        letterSpacing: 0.2,
      }}
    >
      {children}
    </span>
  )
}

export function ExportDialogV2({
  project,
  result,
  term,
  rowsOf,
  complete,
  forest,
  forestTitle,
  gridTerms,
  gridMeasures,
  measureId,
  detail,
  requestDetail,
  brain = null,
  onClose,
}: ExportDialogV2Props): ReactNode {
  const { t } = useApp()
  const titleId = `export-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const matrix = useMemo(
    () =>
      measureId ? pairwiseMatrixModel(result, term, rowsOf, measureId) : null,
    [result, term, rowsOf, measureId],
  )
  const grid = useMemo(
    () =>
      gridTerms.length > 0 && gridMeasures.length > 0
        ? gridModel(result, gridTerms, rowsOf, gridMeasures)
        : null,
    [result, gridTerms, rowsOf, gridMeasures],
  )
  const [withForest, setForest] = useState(forest !== null)
  const [withGrid, setGrid] = useState(grid !== null && gridTerms.length > 1)
  const [withMatrix, setMatrix] = useState(matrix !== null)
  const [withMeasure, setMeasure] = useState(measureId !== null)
  const [svg, setSvg] = useState(true)
  const [pdf, setPdf] = useState(true)
  const [png, setPng] = useState(false)
  const [widthMm, setWidthMm] = useState<FigureWidthMm>(174)
  const [dpi, setDpi] = useState<FigureDpi>(300)
  const [subjectCsv, setSubjectCsv] = useState(false)
  const [brainImage, setBrainImage] = useState(false)
  const withBrain = brainImage && brain !== null
  const [state, setState] = useState<Phase>({ phase: 'idle' })
  const [folderName, setFolderName] = useState(() =>
    exportFolderName(result.name),
  )
  const folderError = exportFolderError(folderName)

  useEffect(() => {
    if (measureId) requestDetail(term.termId, measureId)
  }, [measureId, term.termId, requestDetail])

  const wantsMeasure = withMeasure && measureId !== null
  const detailFailed = wantsMeasure && detail?.phase === 'error'
  const waitingDetail =
    wantsMeasure && detail?.phase !== 'ready' && !detailFailed
  const measureModel =
    wantsMeasure &&
    detail?.phase === 'ready' &&
    detail.value.subjects.length > 0
      ? scatterModelV2(detail.value, result, term)
      : null
  const anyFigure =
    (withForest && forest !== null) ||
    (withGrid && grid !== null) ||
    (withMatrix && matrix !== null) ||
    wantsMeasure
  const anyFormat = svg || pdf || png
  const working = state.phase === 'working'
  const request: FigureExportRequestV2 = {
    forest: withForest && forest ? { model: forest, title: forestTitle } : null,
    grid:
      withGrid && grid
        ? {
            model: grid,
            transposed: gridTransposed(grid),
            title: `Grid: ${result.name}`,
          }
        : null,
    matrix:
      withMatrix && matrix && measureId
        ? {
            model: matrix,
            measureId,
            title: `Pairwise matrix: ${measureLabel(measureId)}`,
          }
        : null,
    measure:
      measureModel && measureId
        ? {
            model: measureModel,
            measureId,
            stem: `measure-${fileSlug(measureId)}-${term.termId}`,
          }
        : null,
    formats: { svg, pdf, png },
    widthMm,
    dpi,
  }
  // The measure figure counts while its values are still being read.
  const figureCount = exportFigureCountV2(
    {
      forest: anyFormat ? request.forest : null,
      grid: anyFormat ? request.grid : null,
      matrix: anyFormat && request.matrix !== null,
      measure: anyFormat && wantsMeasure,
      widthMm,
    },
    request.formats,
    withBrain,
  )
  const tooManyFigures = figureCount > MAX_EXPORT_FIGURES
  const partial = gridTerms.some((item) => !complete(item.termId))

  const run = async (): Promise<void> => {
    setState({ phase: 'working' })
    try {
      const api = getApi().groupAnalysis
      const destination = await api.chooseExportFolder({
        project,
        defaultName: folderName,
      })
      if (!destination) {
        setState({ phase: 'idle' })
        return
      }
      const figures =
        anyFigure && anyFormat ? await buildExportFiguresV2(request) : []
      if (withBrain) {
        figures.push({
          kind: 'png',
          stem: brain.stem,
          png: await brain.capture({ widthMm, dpi }),
        })
      }
      assertExportFits(figures)
      const written = await api.writeExport({
        project,
        destinationId: destination.destinationId,
        resultId: result.resultId,
        folderName,
        subjectCsv,
        figures,
      })
      setState({ phase: 'done', written, requested: folderName })
    } catch (error) {
      setState({
        phase: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'The export could not be written.',
      })
    }
  }

  const hint = (text: string): ReactNode => (
    <span
      style={{
        paddingLeft: 26,
        fontFamily: FONTS.sans,
        fontSize: 10.5,
        color: t.dimText,
      }}
    >
      {text}
    </span>
  )

  return (
    <Modal
      t={t}
      labelledBy={titleId}
      onDismiss={working ? () => undefined : onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !working) onClose()
      }}
      cardStyle={{
        width: 'min(540px, 100%)',
        padding: 20,
        gap: 14,
        display: 'grid',
        alignContent: 'start',
      }}
    >
      <h2
        id={titleId}
        style={{
          margin: 0,
          fontFamily: FONTS.serif,
          fontWeight: 400,
          fontSize: 18,
          color: t.textStrong,
        }}
      >
        Export the analysis
      </h2>
      {state.phase === 'done' ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <span
            role="status"
            style={{ fontFamily: FONTS.sans, fontSize: 12.5, color: t.text }}
          >
            {state.written.files.length} files written
            {state.written.provisional ? ', stamped Provisional' : ''}.
          </span>
          {state.written.folderName !== state.requested && (
            <span
              style={{
                fontFamily: FONTS.sans,
                fontSize: 12,
                color: t.textSoft,
              }}
            >
              A folder named {state.requested} already existed, so the export
              went to {state.written.folderName}.
            </span>
          )}
          <PathRow t={t} value={state.written.displayPath} copyable={false} />
          <ul
            style={{
              margin: 0,
              padding: '6px 10px',
              listStyle: 'none',
              border: `1px solid ${t.borderSoft}`,
              borderRadius: 4,
              background: t.bg,
              fontFamily: FONTS.mono,
              fontSize: 11.5,
              color: t.text,
              maxHeight: 180,
              overflowY: 'auto',
            }}
          >
            {state.written.files.map((file) => (
              <li
                key={file.name}
                style={{ display: 'flex', gap: 10, padding: '2px 0' }}
              >
                <span style={{ flex: 1 }}>{file.name}</span>
                <span style={{ color: t.dimText, fontFamily: FONTS.sans }}>
                  {file.bytes.toLocaleString('en-US')} B
                </span>
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Btn t={t} primary label="Done" onClick={onClose} />
          </div>
        </div>
      ) : (
        <>
          <p
            style={{
              margin: 0,
              fontFamily: FONTS.sans,
              fontSize: 12,
              color: t.textSoft,
            }}
          >
            Every export holds results.csv (one row per term and measure),
            spec.json, terms.csv, grid.csv, and atlas-licenses.csv. It goes into
            a new folder inside the one you choose; an existing folder is never
            overwritten.
          </p>
          <Field
            t={t}
            label="Folder name"
            {...(folderError ? { error: folderError } : {})}
          >
            <TextInput
              t={t}
              mono
              value={folderName}
              invalid={folderError !== null}
              onChange={(value) => setFolderName(value.trim())}
            />
          </Field>
          {result.provisional && (
            <Notice
              tone="attention"
              headline="This result is provisional."
              detail="Its inputs were out of date when it was computed; the export records that."
            />
          )}
          <div style={{ display: 'grid', gap: 2 }}>
            <Label>Figures</Label>
            <CheckRow
              checked={withForest && forest !== null}
              disabled={forest === null}
              onChange={setForest}
              label={`Forest plot: ${forest ? forestTitle.replace(/^Forest plot: /, '') : 'none drawn'}`}
            />
            <CheckRow
              checked={withGrid && grid !== null}
              disabled={grid === null}
              onChange={setGrid}
              label={
                grid
                  ? `Grid: ${grid.terms.length} by ${grid.measures.length}`
                  : 'Grid'
              }
            />
            {withGrid &&
              grid &&
              partial &&
              hint(
                'The grid draws the rows read so far; grid.csv holds every row.',
              )}
            <CheckRow
              checked={withMatrix && matrix !== null}
              disabled={matrix === null}
              onChange={setMatrix}
              label={
                matrix && measureId
                  ? `Pairwise matrix: ${measureLabel(measureId)}`
                  : 'Pairwise matrix (an omnibus test with pairs)'
              }
            />
            <CheckRow
              checked={wantsMeasure}
              disabled={measureId === null}
              onChange={setMeasure}
              label={
                measureId
                  ? `Measure figure: ${measureLabel(measureId)}, ${termTitle(result, term)}`
                  : 'Measure figure (select a measure first)'
              }
            />
            {wantsMeasure &&
              detail?.phase === 'ready' &&
              detail.value.subjects.length === 0 &&
              hint(
                'This result keeps no subject values, so the figure is left out.',
              )}
            <CheckRow
              checked={withBrain}
              disabled={brain === null}
              onChange={setBrainImage}
              label={
                brain
                  ? `Brain view image: ${brain.stem}.png`
                  : 'Brain view image (PNG)'
              }
            />
            {brain === null &&
              hint(
                'Open the Brain tab and let it draw to include its current view.',
              )}
          </div>
          <div style={{ display: 'grid', gap: 2 }}>
            <Label>Formats</Label>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <CheckRow
                checked={svg}
                onChange={setSvg}
                label="SVG"
                disabled={!anyFigure}
              />
              <CheckRow
                checked={pdf}
                onChange={setPdf}
                label="PDF"
                disabled={!anyFigure}
              />
              <CheckRow
                checked={png}
                onChange={setPng}
                label="PNG"
                disabled={!anyFigure}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <div style={{ display: 'grid', gap: 4 }}>
              <Label>Width</Label>
              <Segments
                t={t}
                small
                ariaLabel="Figure width"
                value={String(widthMm)}
                options={FIGURE_WIDTHS_MM.map((mm) => ({
                  value: String(mm),
                  label: `${mm} mm`,
                }))}
                onChange={(value) => setWidthMm(Number(value) as FigureWidthMm)}
              />
            </div>
            {(png || withBrain) && (
              <div style={{ display: 'grid', gap: 4 }}>
                <Label>PNG resolution</Label>
                <Segments
                  t={t}
                  small
                  ariaLabel="PNG resolution"
                  value={String(dpi)}
                  options={FIGURE_DPIS.map((d) => ({
                    value: String(d),
                    label: `${d} dpi`,
                  }))}
                  onChange={(value) => setDpi(Number(value) as FigureDpi)}
                />
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gap: 2 }}>
            <Label>Participant data</Label>
            <CheckRow
              checked={subjectCsv}
              onChange={setSubjectCsv}
              label="Include subjects.csv, which contains participant IDs"
            />
          </div>
          {detailFailed && measureId && detail?.phase === 'error' && (
            <Notice
              tone="error"
              headline={detail.message}
              detail="The measure figure needs these values; clear it to export without it."
              action={{
                label: 'Retry',
                onClick: () => requestDetail(term.termId, measureId),
                title: 'Read the measure values again.',
              }}
            />
          )}
          {tooManyFigures && (
            <Notice
              tone="attention"
              headline={`This export needs ${figureCount} figure files; one export holds at most ${MAX_EXPORT_FIGURES}.`}
              detail="Clear some figures, or choose fewer formats."
            />
          )}
          {state.phase === 'error' && (
            <Notice tone="error" headline={state.message} />
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
            }}
          >
            {waitingDetail && (
              <span
                style={{
                  marginRight: 'auto',
                  fontFamily: FONTS.sans,
                  fontSize: 11,
                  color: t.dimText,
                }}
              >
                Reading the measure values...
              </span>
            )}
            <Btn
              t={t}
              ghost
              label="Cancel"
              disabled={working}
              onClick={onClose}
            />
            <Btn
              t={t}
              primary
              label={working ? 'Exporting...' : 'Choose folder and export'}
              disabled={
                working ||
                folderError !== null ||
                waitingDetail ||
                detailFailed ||
                tooManyFigures ||
                (anyFigure && !anyFormat)
              }
              onClick={() => void run()}
            />
          </div>
        </>
      )}
    </Modal>
  )
}
