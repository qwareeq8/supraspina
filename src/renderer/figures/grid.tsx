/**
 * The grid of a v2 result drawn as an SVG table for an export: a header
 * line per column, a label column, and two-line cells (the effect with its
 * CI, then the uncorrected and corrected p), tinted on the print paper and
 * bold where significant. A grid wider or longer than one page is split
 * into pages that repeat the labels.
 */

import { useId, type ReactNode } from 'react'
import { cellAlpha, cellFill, type GridModel } from './grid-model'
import { CELL_PAD, gridHeight, gridTransposed, labelWidth } from './grid-layout'
import {
  FIGURE_FONT_PT,
  PRINT_PALETTE,
  figureFont,
  fitText,
  type FigureMode,
  type FigurePalette,
} from './style'
import { RichText } from './text'

/** The drawing of a grid model. */
export interface GridFigureProps {
  model: GridModel
  width: number
  mode: FigureMode
  widthMm?: number
  /** Lay measures out as rows; by default when there are more than eight. */
  transposed?: boolean
  title?: string
  palette?: FigurePalette
}

/** Draw a grid as an SVG table. */
export function GridFigure({
  model,
  width,
  mode,
  widthMm,
  transposed = gridTransposed(model),
  title = 'Grid of terms by measures',
  palette = PRINT_PALETTE,
}: GridFigureProps): ReactNode {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const fs = FIGURE_FONT_PT
  const pad = 4
  const height = gridHeight(model, transposed)
  const lineItems = transposed ? model.measures : model.terms
  const columnItems = transposed ? model.terms : model.measures
  const cellAt = (line: number, column: number) =>
    transposed ? model.cells[column]?.[line] : model.cells[line]?.[column]
  const labelW = labelWidth(model, transposed, width)
  const columnW = (width - 2 * pad - labelW) / Math.max(1, columnItems.length)
  const top = pad + model.subtitle.length * fs * 1.35 + fs * 0.8
  const headerH = fs * 3
  const lineH = fs * 2.9
  const items: ReactNode[] = []
  columnItems.forEach((item, column) => {
    const x = pad + labelW + column * columnW + columnW / 2
    items.push(
      <g key={`h-${item.id}`}>
        <text
          x={x}
          y={top + fs * 1.2}
          textAnchor="middle"
          fill={palette.ink}
          fontWeight={700}
        >
          {fitText(item.label, fs, columnW - 2 * CELL_PAD)}
        </text>
        {item.detail && (
          <text
            x={x}
            y={top + fs * 2.3}
            textAnchor="middle"
            fill={palette.muted}
            fontStyle="italic"
          >
            {item.detail}
          </text>
        )}
      </g>,
    )
  })
  lineItems.forEach((item, line) => {
    const y = top + headerH + line * lineH
    items.push(
      <g key={`l-${item.id}`}>
        <text x={pad + CELL_PAD} y={y + fs * 1.15} fill={palette.ink}>
          {fitText(item.label, fs, labelW - 2 * CELL_PAD)}
        </text>
        {item.detail && (
          <text
            x={pad + CELL_PAD}
            y={y + fs * 2.3}
            fill={palette.muted}
            fontStyle="italic"
          >
            {item.detail}
          </text>
        )}
      </g>,
    )
    columnItems.forEach((column, index) => {
      const cell = cellAt(line, index)
      const x = pad + labelW + index * columnW
      const cx = x + columnW / 2
      const weight = cell?.significant ? 700 : 400
      items.push(
        <g key={`c-${item.id}-${column.id}`}>
          <rect
            x={x + 0.5}
            y={y + 0.5}
            width={columnW - 1}
            height={lineH - 1}
            fill={
              cell
                ? cellFill(cell.tone, palette.paper, cellAlpha(palette.paper))
                : palette.paper
            }
          />
          {cell ? (
            <>
              <text
                x={cx}
                y={y + fs * 1.15}
                textAnchor="middle"
                fill={palette.ink}
                fontWeight={weight}
              >
                {fitText(
                  cell.ci ? `${cell.value} ${cell.ci}` : cell.value,
                  fs,
                  columnW - 2 * CELL_PAD,
                )}
              </text>
              <text
                x={cx}
                y={y + fs * 2.3}
                textAnchor="middle"
                fill={palette.ink}
                fontWeight={weight}
              >
                {fitText(
                  `p ${cell.p}${cell.pCorrected ? `  ${model.correctedLabel} ${cell.pCorrected}` : ''}`,
                  fs,
                  columnW - 2 * CELL_PAD,
                )}
              </text>
            </>
          ) : (
            <text
              x={cx}
              y={y + fs * 1.75}
              textAnchor="middle"
              fill={palette.muted}
            >
              {'\u2212'}
            </text>
          )}
        </g>,
      )
    })
  })
  const bodyBottom = top + headerH + lineItems.length * lineH
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-desc`}
      viewBox={`0 0 ${width.toFixed(2)} ${height}`}
      width={widthMm ? `${widthMm}mm` : undefined}
      height={
        widthMm ? `${((height / width) * widthMm).toFixed(2)}mm` : undefined
      }
      style={
        mode === 'screen'
          ? { width: '100%', height: 'auto', display: 'block' }
          : undefined
      }
      fontFamily={figureFont(mode)}
      fontSize={fs}
      textRendering="geometricPrecision"
    >
      <title id={`${id}-title`}>{title}</title>
      <desc id={`${id}-desc`}>{model.summary}</desc>
      <rect x={0} y={0} width={width} height={height} fill={palette.paper} />
      {model.subtitle.map((line, index) => (
        <RichText
          key={index}
          rich={line}
          x={pad}
          y={pad + fs * 1.35 * (index + 1) - fs * 0.3}
          fill={palette.muted}
          fontStyle="italic"
        />
      ))}
      {model.provisional && (
        <text
          x={width - pad}
          y={pad + fs}
          textAnchor="end"
          fill={palette.provisional}
          fontSize={fs * 0.9}
          letterSpacing={0.6}
        >
          PROVISIONAL
        </text>
      )}
      <line
        x1={pad}
        x2={width - pad}
        y1={top + headerH - 0.5}
        y2={top + headerH - 0.5}
        stroke={palette.ink}
        strokeWidth={0.7}
      />
      {items}
      <line
        x1={pad}
        x2={width - pad}
        y1={bodyBottom}
        y2={bodyBottom}
        stroke={palette.ink}
        strokeWidth={0.7}
      />
      {model.notes.map((note, index) => (
        <text
          key={note}
          x={pad}
          y={bodyBottom + fs * 1.4 + index * fs * 1.3}
          fill={palette.muted}
        >
          {fitText(note, fs, width - 2 * pad)}
        </text>
      ))}
    </svg>
  )
}
