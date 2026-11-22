/**
 * Draw the chosen Analysis figures for an export: SVG (with a PDF rendered
 * from it by main) and PNG at the chosen width and resolution.
 */

import { createElement } from 'react'
import type {
  AnalysisExportFigure,
  GroupAnalysisMeasureDetail,
  GroupAnalysisResult,
} from '../../shared/group-analysis'
import { fileSlug } from './format'
import { ForestPlot } from './forest'
import {
  forestHeight,
  forestModel,
  paginateForest,
  topForestRows,
  type ForestModel,
} from './forest-model'
import { rasterizeSvg, pngPixelSize } from './png-export'
import { AdjustedScatter } from './scatter'
import { scatterHeight, scatterModel } from './scatter-model'
import { mmToPt, type FigureDpi, type FigureWidthMm } from './style'
import { MAX_PDF_SVG_BYTES, figureSvg } from './svg-export'

/** The formats of an export's figures. */
export interface FigureFormats {
  svg: boolean
  pdf: boolean
  png: boolean
}

/**
 * The most figures one export may carry; mirrors `MAX_EXPORT_FIGURES` in
 * main, which refuses a longer request.
 */
export const MAX_EXPORT_FIGURES = 16

/**
 * The largest `groupAnalysis.writeExport` request; mirrors
 * `MAX_EXPORT_REQUEST_BYTES` in main, which refuses a larger one.
 */
export const MAX_EXPORT_REQUEST_BYTES = 32 * 1024 * 1024
/** Room kept for the request's other fields. */
const REQUEST_OVERHEAD_BYTES = 64 * 1024

/**
 * Measure the figures of an export as main does: each SVG's UTF-8 text and
 * each PNG's whole backing buffer.
 */
export function exportFigureBytes(
  figures: readonly AnalysisExportFigure[],
): number {
  const encoder = new TextEncoder()
  return figures.reduce(
    (total, figure) =>
      total +
      (figure.kind === 'svg'
        ? encoder.encode(figure.svg).length
        : Math.max(figure.png.byteLength, figure.png.buffer.byteLength)),
    0,
  )
}

/**
 * Refuse an export main would refuse for its size, with what to change.
 *
 * @throws Error when the figures do not fit one export request.
 */
export function assertExportFits(
  figures: readonly AnalysisExportFigure[],
): void {
  const bytes = exportFigureBytes(figures)
  if (bytes + REQUEST_OVERHEAD_BYTES <= MAX_EXPORT_REQUEST_BYTES) return
  const mb = (value: number): string => (value / (1024 * 1024)).toFixed(1)
  throw new Error(
    `The figures take ${mb(bytes)} MB, more than the ${mb(MAX_EXPORT_REQUEST_BYTES - REQUEST_OVERHEAD_BYTES)} MB one export can write. Export fewer figures or formats, or choose 300 dpi or a narrower width.`,
  )
}

/** Which rows an exported forest draws: all, or the significant and largest. */
export type ForestRows = 'all' | 'top'

/** What to draw for an export. */
export interface FigureExportRequest {
  forest: boolean
  /** The forest's rows; all by default. */
  forestRows?: ForestRows
  /** The measure figure's detail, or null to leave it out. */
  measure: GroupAnalysisMeasureDetail | null
  formats: FigureFormats
  widthMm: FigureWidthMm
  dpi: FigureDpi
}

/**
 * Name the file stem of a measure figure.
 *
 * @returns A `[a-z0-9-]` stem such as `measure-aseg-brain-stem`.
 */
export function measureFigureStem(measureId: string): string {
  return `measure-${fileSlug(measureId)}`
}

/**
 * Give the pages an exported forest takes.
 *
 * @param rows - All rows or the significant and largest.
 */
export function forestPages(
  result: GroupAnalysisResult,
  rows: ForestRows = 'all',
): ForestModel[] {
  return paginateForest(
    forestModel(result, rows === 'top' ? topForestRows(result) : result.rows),
  )
}

/**
 * Name the file stem of one forest page: `forest` alone, else numbered
 * from `forest-p01`.
 *
 * @param index - The page, from 1.
 */
export function forestPageStem(index: number, count: number): string {
  if (count <= 1) return 'forest'
  const digits = Math.max(2, String(count).length)
  return `forest-p${String(index).padStart(digits, '0')}`
}

/**
 * Count the figures an export sends to main: each drawing once as SVG
 * (which also carries the PDF) and once as PNG, and the brain PNG.
 *
 * @param drawings - The forest pages plus the measure figure.
 */
export function exportFigureCount(
  drawings: number,
  formats: FigureFormats,
  brain = false,
): number {
  const perDrawing =
    (formats.svg || formats.pdf ? 1 : 0) + (formats.png ? 1 : 0)
  return drawings * perDrawing + (brain ? 1 : 0)
}

/**
 * Draw the requested figures.
 *
 * @returns The figures for `groupAnalysis.writeExport`.
 */
export async function buildExportFigures(
  result: GroupAnalysisResult,
  request: FigureExportRequest,
): Promise<AnalysisExportFigure[]> {
  const width = mmToPt(request.widthMm)
  const drawings: FigureDrawing[] = []
  if (request.forest) {
    const pages = forestPages(result, request.forestRows)
    for (const model of pages) {
      const page = model.page
      drawings.push({
        stem: forestPageStem(page?.index ?? 1, page?.count ?? 1),
        heightPt: forestHeight(model),
        svg: figureSvg(
          createElement(ForestPlot, {
            model,
            width,
            mode: 'export',
            widthMm: request.widthMm,
            title: page
              ? `Forest plot: ${result.name}, page ${page.index} of ${page.count}`
              : `Forest plot: ${result.name}`,
          }),
        ),
      })
    }
  }
  if (request.measure) {
    drawings.push({
      stem: measureFigureStem(request.measure.measureId),
      heightPt: scatterHeight(width),
      svg: figureSvg(
        createElement(AdjustedScatter, {
          model: scatterModel(request.measure, result),
          width,
          mode: 'export',
          widthMm: request.widthMm,
        }),
      ),
    })
  }
  return renderFigureDrawings(drawings, request)
}

/** One figure to draw: its file stem, SVG text, and height in points. */
export interface FigureDrawing {
  stem: string
  svg: Promise<string>
  heightPt: number
}

/**
 * Render drawings in the requested formats: each as SVG (which also carries
 * the PDF) and as PNG at the chosen width and resolution.
 *
 * @param drawings - The drawings, drawn at the export width.
 * @returns The figures for `groupAnalysis.writeExport`.
 * @throws Error when an SVG is too large for a PDF.
 */
export async function renderFigureDrawings(
  drawings: readonly FigureDrawing[],
  request: Pick<FigureExportRequest, 'formats' | 'widthMm' | 'dpi'>,
): Promise<AnalysisExportFigure[]> {
  const width = mmToPt(request.widthMm)
  const figures: AnalysisExportFigure[] = []
  for (const drawing of drawings) {
    const svg = await drawing.svg
    if (
      request.formats.pdf &&
      new TextEncoder().encode(svg).length > MAX_PDF_SVG_BYTES
    ) {
      throw new Error(
        `The ${drawing.stem} figure is too large for PDF; export it as SVG or PNG.`,
      )
    }
    if (request.formats.svg || request.formats.pdf) {
      figures.push({
        kind: 'svg',
        stem: drawing.stem,
        svg,
        pdf: request.formats.pdf,
      })
    }
    if (request.formats.png) {
      const heightMm = (drawing.heightPt / width) * request.widthMm
      const png = await rasterizeSvg(
        svg,
        pngPixelSize(request.widthMm, heightMm, request.dpi),
        request.dpi,
      )
      figures.push({ kind: 'png', stem: drawing.stem, png })
    }
  }
  return figures
}
