/**
 * The layout of the grid figure, shared by the Grid tab and the export:
 * when measures turn into rows, the label column, the page split, and the
 * height of a page.
 */

import type { GridModel } from './grid-model'
import { FIGURE_FONT_PT, textWidth } from './style'

/** The measures a grid shows as columns before it turns them into rows. */
export const GRID_MAX_MEASURE_COLUMNS = 8
/** The data lines one exported grid page holds. */
export const GRID_LINES_PER_PAGE = 28

/** True when the grid lays measures out as rows (more than 8). */
export function gridTransposed(model: GridModel): boolean {
  return model.measures.length > GRID_MAX_MEASURE_COLUMNS
}

/** The parts of one grid page: line and column index ranges. */
interface GridSlice {
  lines: [number, number]
  columns: [number, number]
}

/** One exported grid page: the model cut to its lines and columns. */
export interface GridPage {
  model: GridModel
  /** True when the page lays measures out as rows, as its whole grid does. */
  transposed: boolean
  index: number
  count: number
}

function cut(model: GridModel, slice: GridSlice, transposed: boolean) {
  const [l0, l1] = slice.lines
  const [c0, c1] = slice.columns
  const [t0, t1] = transposed ? [c0, c1] : [l0, l1]
  const [m0, m1] = transposed ? [l0, l1] : [c0, c1]
  return {
    ...model,
    terms: model.terms.slice(t0, t1),
    measures: model.measures.slice(m0, m1),
    cells: model.cells.slice(t0, t1).map((row) => row.slice(m0, m1)),
  }
}

const LABEL_SHARE = 0.3
/** The padding inside a grid cell, in points. */
export const CELL_PAD = 3

/**
 * Give the label column's width: its longest label, at most 30% of the
 * page.
 *
 * @param transposed - Whether measures are the lines.
 * @param width - The page width in points.
 * @returns The width in points.
 */
export function labelWidth(
  model: GridModel,
  transposed: boolean,
  width: number,
): number {
  const lines = transposed ? model.measures : model.terms
  return Math.min(
    width * LABEL_SHARE,
    Math.max(
      40,
      ...lines.map(
        (item) => textWidth(item.label, FIGURE_FONT_PT) + 2 * CELL_PAD,
      ),
    ),
  )
}

function columnNeed(model: GridModel, fs: number): number {
  const texts = model.cells
    .flat()
    .flatMap((cell) =>
      cell
        ? [
            `${cell.value} ${cell.ci ?? ''}`,
            `p ${cell.p}${cell.pCorrected ? `  ${model.correctedLabel} ${cell.pCorrected}` : ''}`,
          ]
        : [],
    )
  return (
    Math.max(40, ...texts.map((text) => textWidth(text, fs))) + 2 * CELL_PAD
  )
}

/**
 * Split a grid into export pages that fit a width: at most
 * `GRID_LINES_PER_PAGE` lines, and as many columns as fit beside the label
 * column.
 *
 * @param width - The page width in points.
 * @returns The pages, each with the labels it needs.
 */
export function paginateGrid(model: GridModel, width: number): GridPage[] {
  const transposed = gridTransposed(model)
  const lines = transposed ? model.measures.length : model.terms.length
  const columns = transposed ? model.terms.length : model.measures.length
  const fs = FIGURE_FONT_PT
  const room = width - 8 - labelWidth(model, transposed, width)
  const perPage = Math.max(1, Math.floor(room / columnNeed(model, fs)))
  const slices: GridSlice[] = []
  for (let c = 0; c < Math.max(1, columns); c += perPage) {
    for (let l = 0; l < Math.max(1, lines); l += GRID_LINES_PER_PAGE) {
      slices.push({
        lines: [l, Math.min(lines, l + GRID_LINES_PER_PAGE)],
        columns: [c, Math.min(columns, c + perPage)],
      })
    }
  }
  return slices.map((slice, index) => ({
    model: cut(model, slice, transposed),
    transposed,
    index: index + 1,
    count: slices.length,
  }))
}

/**
 * Compute the height of a grid figure.
 *
 * @param transposed - Whether measures are rows; by default, when the model has
 *   more than eight.
 * @returns The height in points.
 */
export function gridHeight(
  model: GridModel,
  transposed: boolean = gridTransposed(model),
): number {
  const fs = FIGURE_FONT_PT
  const lines = transposed ? model.measures.length : model.terms.length
  const top = 4 + model.subtitle.length * fs * 1.35 + fs * 0.8
  const header = fs * 3
  const body = lines * fs * 2.9
  const notes = model.notes.length * fs * 1.3 + fs
  return Math.ceil(top + header + body + notes)
}
