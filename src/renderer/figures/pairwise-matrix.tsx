/**
 * The k x k pairwise matrix of one measure after an omnibus test: the
 * groups on both axes, the adjusted standardized difference d (row group
 * minus column group, with its 95% CI) above the diagonal, the pair's
 * corrected p below it, and each group's n on the diagonal. The d cells
 * are tinted on the RdBu hues; a pair that survives the correction is bold
 * with an asterisk in both of its cells, and the forest's marks repeat, so
 * nothing relies on color alone.
 */

import { useId, type ReactNode } from 'react'
import { cellAlpha, cellFill } from './grid-model'
import { matrixHeight, type PairwiseMatrixModel } from './pairwise-matrix-model'
import { richText } from './rich'
import {
  FIGURE_FONT_PT,
  PRINT_PALETTE,
  figureFont,
  fitText,
  textWidth,
  type FigureMode,
  type FigurePalette,
} from './style'
import { RichText } from './text'

/** The drawing of a matrix model. */
export interface PairwiseMatrixProps {
  model: PairwiseMatrixModel
  width: number
  mode: FigureMode
  widthMm?: number
  title?: string
  palette?: FigurePalette
}

/** Draw the pairwise matrix. */
export function PairwiseMatrix({
  model,
  width,
  mode,
  widthMm,
  title = 'Pairwise matrix',
  palette = PRINT_PALETTE,
}: PairwiseMatrixProps): ReactNode {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const fs = FIGURE_FONT_PT
  const pad = 4
  const k = model.groups.length
  const height = matrixHeight(model)
  const labelW = Math.min(
    width * 0.28,
    Math.max(36, ...model.groups.map((g) => textWidth(g.label, fs) + 8)),
  )
  const cellW = (width - 2 * pad - labelW) / Math.max(1, k)
  const cellH = fs * 3.2
  const titleY = pad + fs * 1.3
  const subtitleTop = titleY + fs * 0.3
  const headerTop = subtitleTop + model.subtitle.length * fs * 1.35 + fs * 0.4
  const gridTop = headerTop + fs * 1.8
  const alpha = cellAlpha(palette.paper)
  const items: ReactNode[] = []
  model.groups.forEach((group, j) => {
    items.push(
      <text
        key={`col-${group.label}`}
        x={pad + labelW + cellW * j + cellW / 2}
        y={headerTop + fs * 1.1}
        textAnchor="middle"
        fill={palette.ink}
        fontWeight={700}
      >
        {fitText(group.label, fs, cellW - 4)}
      </text>,
    )
  })
  model.cells.forEach((row, i) => {
    const y = gridTop + i * cellH
    items.push(
      <text
        key={`row-${model.groups[i]!.label}`}
        x={pad + labelW - 4}
        y={y + cellH / 2 + fs * 0.35}
        textAnchor="end"
        fill={palette.ink}
        fontWeight={700}
      >
        {fitText(model.groups[i]!.label, fs, labelW - 6)}
      </text>,
    )
    row.forEach((cell, j) => {
      const x = pad + labelW + cellW * j
      const cx = x + cellW / 2
      const fill =
        cell.kind === 'd'
          ? cellFill(cell.tone, palette.paper, alpha)
          : palette.paper
      const ink = cell.kind === 'untested' ? palette.muted : palette.ink
      items.push(
        <g key={`cell-${i}-${j}`}>
          <rect
            x={x + 0.5}
            y={y + 0.5}
            width={cellW - 1}
            height={cellH - 1}
            fill={fill}
            stroke={palette.rule}
            strokeWidth={cell.kind === 'group' ? 0 : 0.4}
          />
          <RichText
            rich={
              cell.kind === 'group'
                ? [fitText(richText(cell.text), fs, cellW - 4)]
                : cell.text
            }
            x={cx}
            y={y + (cell.sub.length > 0 ? fs * 1.35 : cellH / 2 + fs * 0.35)}
            textAnchor="middle"
            fill={ink}
            fontWeight={cell.significant ? 700 : 400}
            fontStyle={cell.kind === 'group' ? 'italic' : undefined}
          />
          {cell.sub.length > 0 && (
            <RichText
              rich={cell.sub}
              x={cx}
              y={y + fs * 2.55}
              textAnchor="middle"
              fill={cell.kind === 'group' ? palette.muted : ink}
              fontWeight={cell.significant ? 700 : 400}
            />
          )}
        </g>,
      )
    })
  })
  const notesTop = gridTop + k * cellH + fs * 1.4
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
      <RichText
        rich={model.title}
        x={pad}
        y={titleY}
        fontSize={fs * 1.25}
        fill={palette.ink}
      />
      {model.subtitle.map((line, index) => (
        <RichText
          key={index}
          rich={line}
          x={pad}
          y={subtitleTop + fs * 1.35 * (index + 1) - fs * 0.3}
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
      {items}
      {model.notes.map((note, index) => (
        <RichText
          key={index}
          rich={note}
          x={pad}
          y={notesTop + index * fs * 1.3}
          fill={palette.muted}
        />
      ))}
    </svg>
  )
}
