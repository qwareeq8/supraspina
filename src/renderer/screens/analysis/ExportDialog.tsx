/**
 * Export a result: results.csv and spec.json always, figures as SVG, PDF,
 * or PNG at a journal column width, and, only when asked, subjects.csv with
 * participant IDs. Main creates a new dated folder and never overwrites.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { measureLabel } from '../../../shared/brain-atlas'
import type {
  GroupAnalysisExportResult,
  GroupAnalysisMeasureDetail,
  GroupAnalysisResult,
} from '../../../shared/group-analysis'
import type { ProjectRef } from '../../../shared/types'
import {
  MAX_EXPORT_FIGURES,
  assertExportFits,
  buildExportFigures,
  exportFigureCount,
  forestPages,
  type ForestRows,
} from '../../figures/figure-export'
import { FOREST_ROWS_PER_PAGE } from '../../figures/forest-model'
import {
  FIGURE_DPIS,
  FIGURE_WIDTHS_MM,
  type FigureDpi,
  type FigureWidthMm,
} from '../../figures/style'
import { getApi } from '../../state/api'
import type { Load } from '../../state/group-analysis'
import { useApp } from '../../state/context'
import {
  Btn,
  FONTS,
  Field,
  Modal,
  PathRow,
  Segments,
  TextInput,
} from '../../ui'
import type { BrainCapture } from './BrainView'
import { CheckRow } from './controls'
import { Notice } from './CurrencyNotice'
import { exportFolderError, exportFolderName } from './describe'

/** The export dialog's inputs. */
export interface ExportDialogProps {
  project: ProjectRef
  result: GroupAnalysisResult
  measureId: string | null
  detail: Load<GroupAnalysisMeasureDetail> | null
  requestDetail: (measureId: string) => void
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

export function ExportDialog({
  project,
  result,
  measureId,
  detail,
  requestDetail,
  brain = null,
  onClose,
}: ExportDialogProps): ReactNode {
  const { t } = useApp()
  const titleId = `export-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [forest, setForest] = useState(true)
  const [forestRows, setForestRows] = useState<ForestRows>('all')
  const [measure, setMeasure] = useState(measureId !== null)
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
    if (measureId) requestDetail(measureId)
  }, [measureId, requestDetail])

  const anyFigure = forest || (measure && measureId !== null)
  const anyFormat = svg || pdf || png
  const detailReady = detail?.phase === 'ready'
  const wantsDetail = measure && measureId !== null
  const detailFailed = wantsDetail && detail?.phase === 'error'
  const waitingDetail = wantsDetail && !detailReady && !detailFailed
  const working = state.phase === 'working'
  // A long forest exports as numbered pages of 60 rows; main takes at most
  // MAX_EXPORT_FIGURES figures per export.
  const longForest = result.rows.length > FOREST_ROWS_PER_PAGE
  const pageCount = useMemo(
    () => (forest ? forestPages(result, forestRows).length : 0),
    [forest, result, forestRows],
  )
  const figureCount = exportFigureCount(
    anyFormat ? pageCount + (wantsDetail ? 1 : 0) : 0,
    { svg, pdf, png },
    withBrain,
  )
  const tooManyFigures = figureCount > MAX_EXPORT_FIGURES

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
        anyFigure && anyFormat
          ? await buildExportFigures(result, {
              forest,
              forestRows,
              measure:
                measure && detail?.phase === 'ready' ? detail.value : null,
              formats: { svg, pdf, png },
              widthMm,
              dpi,
            })
          : []
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

  return (
    <Modal
      t={t}
      labelledBy={titleId}
      onDismiss={working ? () => undefined : onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !working) onClose()
      }}
      cardStyle={{
        width: 'min(520px, 100%)',
        padding: 20,
        gap: 14,
        // Rows keep their content height and the card scrolls; a flex
        // column would shrink a row that clips its content (a path, a
        // list) to a sliver on a short window.
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
          {(() => {
            const used = state.written.folderName
            return used !== state.requested ? (
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 12,
                  color: t.textSoft,
                }}
              >
                A folder named {state.requested} already existed, so the export
                went to {used}.
              </span>
            ) : null
          })()}
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
                <span style={{ color: t.dimText }}>
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
            Every export holds results.csv and spec.json. It goes into a new
            folder inside the one you choose; an existing folder is never
            overwritten, and a taken name gets a -2 or -3 suffix.
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
              detail="Its region tables were out of date when it was computed; the export records that."
            />
          )}
          <div style={{ display: 'grid', gap: 2 }}>
            <Label>Figures</Label>
            <CheckRow
              checked={forest}
              onChange={setForest}
              label="Forest plot"
            />
            {forest && longForest && (
              <div
                style={{
                  display: 'grid',
                  gap: 4,
                  padding: '2px 0 6px 26px',
                }}
              >
                <Segments
                  t={t}
                  small
                  ariaLabel="Forest rows"
                  value={forestRows}
                  options={[
                    {
                      value: 'all',
                      label: `All ${result.rows.length} measures`,
                    },
                    { value: 'top', label: 'Significant and largest' },
                  ]}
                  onChange={(value) => setForestRows(value as ForestRows)}
                />
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 10.5,
                    color: t.dimText,
                  }}
                >
                  {forestRows === 'all'
                    ? `${pageCount} pages of up to ${FOREST_ROWS_PER_PAGE} rows, one file each.`
                    : `Every significant measure and the ${FOREST_ROWS_PER_PAGE} largest effects${pageCount > 1 ? `, on ${pageCount} pages` : ''}.`}
                </span>
              </div>
            )}
            <CheckRow
              checked={measure && measureId !== null}
              disabled={measureId === null}
              onChange={setMeasure}
              label={
                measureId
                  ? `Measure figure: ${measureLabel(measureId)}`
                  : 'Measure figure (select a measure first)'
              }
            />
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
            {brain === null && (
              <span
                style={{
                  paddingLeft: 26,
                  fontFamily: FONTS.sans,
                  fontSize: 10.5,
                  color: t.dimText,
                }}
              >
                Open the Brain tab and let it draw to include its current view.
              </span>
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
            {pdf && !svg && anyFigure && (
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 10.5,
                  color: t.dimText,
                }}
              >
                The PDF is drawn from an SVG, which the folder also keeps.
              </span>
            )}
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
                onClick: () => requestDetail(measureId),
                title: 'Read the measure values again.',
              }}
            />
          )}
          {tooManyFigures && (
            <Notice
              tone="attention"
              headline={`This export needs ${figureCount} figure files; one export holds at most ${MAX_EXPORT_FIGURES}.`}
              detail="Choose the significant and largest forest rows, or fewer formats."
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
