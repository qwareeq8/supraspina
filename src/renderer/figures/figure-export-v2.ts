/**
 * Draw the chosen figures of a v2 result for an export: the forest shown
 * (a term's, the battery's, or the strata's, in pages of 60 rows), the grid
 * (in pages that fit the width), the selected measure's pairwise matrix,
 * and its measure figure, each as SVG (with a PDF rendered by main) and
 * PNG, on the print palette.
 */

import { createElement } from 'react'
import type { AnalysisExportFigure } from '../../shared/group-analysis'
import {
  exportFigureCount,
  forestPageStem,
  measureFigureStem,
  renderFigureDrawings,
  type FigureDrawing,
  type FigureFormats,
} from './figure-export'
import { fileSlug } from './format'
import { ForestPlot } from './forest'
import { forestHeight, paginateForest, type ForestModel } from './forest-model'
import { GridFigure } from './grid'
import { gridHeight, paginateGrid } from './grid-layout'
import type { GridModel } from './grid-model'
import { PairwiseMatrix } from './pairwise-matrix'
import { matrixHeight, type PairwiseMatrixModel } from './pairwise-matrix-model'
import { AdjustedScatter } from './scatter'
import { scatterHeight, type ScatterModel } from './scatter-model'
import { mmToPt, type FigureDpi, type FigureWidthMm } from './style'
import { figureSvg } from './svg-export'

/** What to draw for a v2 export; null leaves a figure out. */
export interface FigureExportRequestV2 {
  /** The forest to draw, whole; it is split into pages of 60 rows. */
  forest: { model: ForestModel; title: string } | null
  /** The grid to draw, whole; it is split into pages that fit the width. */
  grid: { model: GridModel; transposed: boolean; title: string } | null
  matrix: {
    model: PairwiseMatrixModel
    measureId: string
    title: string
  } | null
  measure: { model: ScatterModel; measureId: string; stem: string } | null
  formats: FigureFormats
  widthMm: FigureWidthMm
  dpi: FigureDpi
}

/**
 * Name a numbered page stem: the base alone for one page, else `-p01`...
 *
 * @param base - The stem, such as `grid`.
 * @param index - The page, from 1.
 */
export function pageStem(base: string, index: number, count: number): string {
  if (count <= 1) return base
  const digits = Math.max(2, String(count).length)
  return `${base}-p${String(index).padStart(digits, '0')}`
}

/**
 * Name the file stem of a pairwise matrix.
 *
 * @returns A stem such as `pairs-aseg-brain-stem`.
 */
export function matrixStem(measureId: string): string {
  return `pairs-${fileSlug(measureId)}`
}

/** What the figure count reads: the forest and grid, and the others' presence. */
export interface DrawingCountRequest {
  forest: FigureExportRequestV2['forest']
  grid: FigureExportRequestV2['grid']
  matrix: boolean
  measure: boolean
  widthMm: FigureWidthMm
}

/**
 * Count the drawings an export makes (each forest and grid page, the
 * matrix, and the measure figure).
 */
export function drawingCountV2(request: DrawingCountRequest): number {
  const width = mmToPt(request.widthMm)
  return (
    (request.forest ? paginateForest(request.forest.model).length : 0) +
    (request.grid ? paginateGrid(request.grid.model, width).length : 0) +
    (request.matrix ? 1 : 0) +
    (request.measure ? 1 : 0)
  )
}

/** Count the figure files an export sends to main. */
export function exportFigureCountV2(
  request: DrawingCountRequest,
  formats: FigureFormats,
  brain: boolean,
): number {
  return exportFigureCount(drawingCountV2(request), formats, brain)
}

/**
 * Draw the requested figures.
 *
 * @returns The figures for `groupAnalysis.writeExport`.
 */
export async function buildExportFiguresV2(
  request: FigureExportRequestV2,
): Promise<AnalysisExportFigure[]> {
  const width = mmToPt(request.widthMm)
  const drawings: FigureDrawing[] = []
  if (request.forest) {
    const pages = paginateForest(request.forest.model)
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
              ? `${request.forest.title}, page ${page.index} of ${page.count}`
              : request.forest.title,
          }),
        ),
      })
    }
  }
  if (request.grid) {
    const { transposed, title } = request.grid
    const pages = paginateGrid(request.grid.model, width)
    for (const page of pages) {
      drawings.push({
        stem: pageStem('grid', page.index, page.count),
        heightPt: gridHeight(page.model, transposed),
        svg: figureSvg(
          createElement(GridFigure, {
            model: page.model,
            width,
            mode: 'export',
            widthMm: request.widthMm,
            transposed,
            title:
              page.count > 1
                ? `${title}, page ${page.index} of ${page.count}`
                : title,
          }),
        ),
      })
    }
  }
  if (request.matrix) {
    drawings.push({
      stem: matrixStem(request.matrix.measureId),
      heightPt: matrixHeight(request.matrix.model),
      svg: figureSvg(
        createElement(PairwiseMatrix, {
          model: request.matrix.model,
          width,
          mode: 'export',
          widthMm: request.widthMm,
          title: request.matrix.title,
        }),
      ),
    })
  }
  if (request.measure) {
    drawings.push({
      stem:
        request.measure.stem || measureFigureStem(request.measure.measureId),
      heightPt: scatterHeight(width),
      svg: figureSvg(
        createElement(AdjustedScatter, {
          model: request.measure.model,
          width,
          mode: 'export',
          widthMm: request.widthMm,
        }),
      ),
    })
  }
  return renderFigureDrawings(drawings, request)
}
