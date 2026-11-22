/**
 * The forest plot of an analysis result, drawn as a publication effect-size
 * figure: measures grouped by family under italic headings, a square per
 * measure filled when it survives correction, the 95% CI as a whisker, a
 * dashed zero line with "<- smaller in <focal>", and right-hand columns of
 * the effect with its CI and the corrected p.
 */

import { useId, type ReactNode } from 'react'
import { formatTick, niceTicks, signAlignedParts } from './format'
import {
  FOREST_HEADING,
  FOREST_ROW,
  forestHeight,
  type ForestModel,
} from './forest-model'
import { richWidth } from './rich'
import {
  FIGURE_FONT_PT,
  PRINT_PALETTE,
  figureFont,
  fitText,
  type FigureMode,
  type FigurePalette,
} from './style'
import { RichText } from './text'

/** The drawing of a forest model at one width. */
export interface ForestPlotProps {
  model: ForestModel
  /** The figure width in points. */
  width: number
  mode: FigureMode
  /** The export's physical width, which sets the SVG width attribute. */
  widthMm?: number
  selectedId?: string | null
  onSelect?: (measureId: string) => void
  title?: string
  /** The colors to draw with; exports keep the print palette. */
  palette?: FigurePalette
}

/** Draw a forest plot. */
export function ForestPlot({
  model,
  width,
  mode,
  widthMm,
  selectedId = null,
  onSelect,
  title = 'Forest plot',
  palette = PRINT_PALETTE,
}: ForestPlotProps): ReactNode {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const fs = FIGURE_FONT_PT
  const pad = 4
  const gap = fs * 1.3
  const indent = fs * 0.9
  const height = forestHeight(model)
  const rows = model.groups.flatMap((g) => g.rows)
  // A page of a split forest lays out its columns and axis for every row.
  const scaleRows = model.scaleRows ?? rows

  const labelNeed = Math.max(
    ...model.groups.map((g) => richWidth([{ i: g.heading }], fs)),
    ...scaleRows.map((r) => indent + richWidth([r.label], fs)),
    40,
  )
  // Plus and minus share one width, so an unsigned number takes one's space.
  const signW = richWidth(['+'], fs)
  let effectW = Math.max(
    richWidth(model.effectHeader, fs),
    ...scaleRows.map(
      (r) =>
        richWidth([r.effect], fs) +
        signAlignedParts(r.effect).reduce((n, part) => n + part.shift, 0) *
          signW,
    ),
  )
  const pW = Math.max(
    richWidth(model.pHeader, fs),
    ...scaleRows.map((r) => richWidth([r.p], fs)),
  )
  let labelW = Math.min(labelNeed, width * 0.42)
  let plotW = width - 2 * pad - labelW - effectW - pW - 3 * gap
  if (plotW < width * 0.24) {
    effectW = 0
    plotW = width - 2 * pad - labelW - pW - 2 * gap
  }
  if (plotW < width * 0.3) {
    labelW = Math.max(40, width - 2 * pad - pW - 2 * gap - width * 0.3)
    plotW = width - 2 * pad - labelW - pW - 2 * gap
  }
  const plotX = pad + labelW + gap
  const effectX = plotX + plotW + gap
  const pX = effectX + (effectW > 0 ? effectW + gap : 0)

  const values = scaleRows.flatMap((r) => [
    r.estimate,
    r.low ?? r.estimate,
    r.high ?? r.estimate,
  ])
  const ticks = niceTicks(
    Math.min(0, ...values),
    Math.max(0, ...values),
    plotW > 160 ? 5 : 3,
  )
  const sx = (v: number): number =>
    plotX + ((v - ticks.min) / (ticks.max - ticks.min)) * plotW

  const subtitleLines = model.subtitle.map((line, index) => ({
    line,
    y: pad + fs * 1.35 * (index + 1) - fs * 0.3,
  }))
  let y = pad + fs * 1.35 * model.subtitle.length + fs * 0.9
  const headerY = y + fs
  y += fs * 1.8
  const bodyTop = y
  const items: ReactNode[] = []
  for (const group of model.groups) {
    items.push(
      <RichText
        key={`h-${group.heading}`}
        rich={[{ i: fitText(group.heading, fs, labelW + plotW) }]}
        x={pad}
        y={y + fs * FOREST_HEADING * 0.62}
        fill={palette.muted}
      />,
    )
    y += fs * FOREST_HEADING
    for (const row of group.rows) {
      const cy = y + (fs * FOREST_ROW) / 2
      const selected = row.measureId === selectedId && mode === 'screen'
      const side = fs * 0.78
      items.push(
        <g
          key={row.rowKey ?? row.measureId}
          data-measure-id={mode === 'screen' ? row.measureId : undefined}
          style={
            onSelect && mode === 'screen' ? { cursor: 'pointer' } : undefined
          }
        >
          {mode === 'screen' && (
            <rect
              x={0}
              y={y}
              width={width}
              height={fs * FOREST_ROW}
              fill={selected ? palette.selection : 'transparent'}
            />
          )}
          <text x={pad + indent} y={cy + fs * 0.35} fill={palette.ink}>
            {fitText(row.label, fs, labelW - indent)}
          </text>
          {row.low !== null && row.high !== null && (
            <line
              x1={sx(row.low)}
              x2={sx(row.high)}
              y1={cy}
              y2={cy}
              stroke={palette.ink}
              strokeWidth={row.significant ? 1.1 : 0.9}
            />
          )}
          <rect
            x={sx(row.estimate) - side / 2}
            y={cy - side / 2}
            width={side}
            height={side}
            fill={row.significant ? palette.ink : palette.paper}
            stroke={palette.ink}
            strokeWidth={0.9}
          />
          {effectW > 0 && (
            // A number that rounds to zero has no sign; shift it by a sign's
            // width, so the interval lines up with the signed rows and the
            // text keeps its own characters.
            <text x={effectX} y={cy + fs * 0.35} fill={palette.ink}>
              {signAlignedParts(row.effect).map((part, index) => (
                <tspan
                  key={index}
                  {...(part.shift > 0 ? { dx: part.shift * signW } : {})}
                >
                  {part.text}
                </tspan>
              ))}
            </text>
          )}
          <text
            x={pX}
            y={cy + fs * 0.35}
            fill={palette.ink}
            fontWeight={row.significant ? 700 : 400}
          >
            {row.p}
          </text>
        </g>,
      )
      y += fs * FOREST_ROW
    }
  }
  const bodyBottom = y
  const axisY = bodyBottom + fs * 0.6
  const zeroX = sx(0)

  const handleClick = (event: { target: EventTarget }): void => {
    if (!onSelect) return
    let node = event.target as Element | null
    while (node && node.getAttribute) {
      const measureId = node.getAttribute('data-measure-id')
      if (measureId) {
        onSelect(measureId)
        return
      }
      node = node.parentNode as Element | null
    }
  }

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
      onClick={mode === 'screen' ? handleClick : undefined}
    >
      <title id={`${id}-title`}>{title}</title>
      <desc id={`${id}-desc`}>{model.summary}</desc>
      <rect x={0} y={0} width={width} height={height} fill={palette.paper} />
      {subtitleLines.map(({ line, y: ly }, index) => (
        <RichText
          key={index}
          rich={line}
          x={pad}
          y={ly}
          fill={palette.muted}
          fontStyle="italic"
        />
      ))}
      {model.provisional && (
        <g>
          <rect
            x={width - pad - fs * 7.4}
            y={pad}
            width={fs * 7.4}
            height={fs * 1.7}
            rx={1.5}
            fill="none"
            stroke={palette.provisional}
            strokeWidth={0.7}
          />
          <text
            x={width - pad - fs * 3.7}
            y={pad + fs * 1.18}
            textAnchor="middle"
            fill={palette.provisional}
            fontSize={fs * 0.9}
            letterSpacing={0.6}
          >
            PROVISIONAL
          </text>
        </g>
      )}
      {effectW > 0 && (
        <RichText
          rich={model.effectHeader}
          x={effectX}
          y={headerY}
          fontWeight={700}
          fill={palette.ink}
        />
      )}
      <RichText
        rich={model.pHeader}
        x={pX}
        y={headerY}
        fontWeight={700}
        fill={palette.ink}
      />
      {model.direction &&
        zeroX - plotX > richWidth([model.direction], fs * 0.95) && (
          <text
            x={zeroX - fs * 0.4}
            y={headerY}
            textAnchor="end"
            fill={palette.muted}
            fontSize={fs * 0.95}
          >
            {model.direction}
          </text>
        )}
      <line
        x1={zeroX}
        x2={zeroX}
        y1={bodyTop - fs * 0.6}
        y2={axisY}
        stroke={palette.rule}
        strokeWidth={0.7}
        strokeDasharray="2.2 1.6"
      />
      {items}
      <line
        x1={plotX}
        x2={plotX + plotW}
        y1={axisY}
        y2={axisY}
        stroke={palette.ink}
        strokeWidth={0.7}
      />
      {ticks.minor.map((v) => (
        <line
          key={`m${v}`}
          x1={sx(v)}
          x2={sx(v)}
          y1={axisY}
          y2={axisY + fs * 0.3}
          stroke={palette.ink}
          strokeWidth={0.5}
        />
      ))}
      {ticks.ticks.map((v) => (
        <g key={`t${v}`}>
          <line
            x1={sx(v)}
            x2={sx(v)}
            y1={axisY}
            y2={axisY + fs * 0.5}
            stroke={palette.ink}
            strokeWidth={0.7}
          />
          <text
            x={sx(v)}
            y={axisY + fs * 1.75}
            textAnchor="middle"
            fill={palette.ink}
          >
            {formatTick(v, ticks.step)}
          </text>
        </g>
      ))}
      <RichText
        rich={model.xLabel}
        x={plotX + plotW / 2}
        y={axisY + fs * 3.6}
        textAnchor="middle"
        fill={palette.ink}
      />
    </svg>
  )
}
