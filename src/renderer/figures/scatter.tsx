/**
 * The adjusted per-subject figure of one measure: a beeswarm of
 * covariate-adjusted values per group (Okabe-Ito blue for the reference,
 * vermillion for the focal group), one marker shape per source label, the
 * model-based adjusted mean with its 95% CI beside each swarm, a title such as
 * "Brainstem 5.7% smaller", and the effect and corrected p under it. An
 * association draws the adjusted values against the tested variable instead.
 *
 * Participant IDs never enter an exported drawing; on screen, hovering a
 * marker reports its subject through `onHover`.
 */

import { useId, type ReactNode } from 'react'
import { formatTick, niceTicks } from './format'
import { Marker } from './marker'
import { scatterHeight, type ScatterModel } from './scatter-model'
import { beeswarm, swarmUnit } from './swarm'
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

/** The drawing of a scatter model at one size. */
export interface AdjustedScatterProps {
  model: ScatterModel
  /** The figure width in points. */
  width: number
  mode: FigureMode
  widthMm?: number
  hoveredId?: string | null
  onHover?: (subjectId: string | null) => void
  onPick?: (subjectId: string) => void
  title?: string
  /** The colors to draw with; exports keep the print palette. */
  palette?: FigurePalette
}

function Cross({
  x,
  mean,
  low,
  high,
  sy,
  size,
  ink,
}: {
  x: number
  mean: number
  low: number
  high: number
  sy: (v: number) => number
  size: number
  ink: string
}): ReactNode {
  return (
    <g stroke={ink} strokeWidth={1.3}>
      <line x1={x} x2={x} y1={sy(low)} y2={sy(high)} />
      <line x1={x - size} x2={x + size} y1={sy(mean)} y2={sy(mean)} />
    </g>
  )
}

/** Draw the adjusted per-subject figure. */
export function AdjustedScatter({
  model,
  width,
  mode,
  widthMm,
  hoveredId = null,
  onHover,
  onPick,
  title = 'Adjusted values per subject',
  palette = PRINT_PALETTE,
}: AdjustedScatterProps): ReactNode {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const fs = FIGURE_FONT_PT
  const height = scatterHeight(width)
  const pad = 4
  const titleSize = fs * 1.25

  // Legend rows, wrapped to the width.
  const legendItems = model.legend.map((entry) => ({
    ...entry,
    w: fs * 1.6 + textWidth(entry.label, fs) + fs * 1.6,
  }))
  const legendRows: (typeof legendItems)[] = [[]]
  let rowW = 0
  for (const item of legendItems) {
    if (rowW + item.w > width - 2 * pad && legendRows.at(-1)!.length > 0) {
      legendRows.push([])
      rowW = 0
    }
    legendRows.at(-1)!.push(item)
    rowW += item.w
  }
  const legendH = legendRows.length * fs * 1.7

  const headerH =
    pad + titleSize * 1.3 + model.stats.length * fs * 1.4 + fs * 0.8
  const fits = model.kind === 'association' ? (model.fits ?? []) : []
  const values = [
    ...model.groups.flatMap((g) => [
      ...g.points.map((p) => p.value),
      ...(g.low !== null && g.high !== null ? [g.low, g.high] : []),
    ]),
    ...fits.flatMap((fit) => [...fit.low, ...fit.high]),
  ]
  const ticks = niceTicks(Math.min(...values), Math.max(...values), 4)
  const tickW = Math.max(
    ...ticks.ticks.map((v) => textWidth(formatTick(v, ticks.step), fs)),
  )
  // Keep swarms close together, as a printed panel does, and center the
  // plot in a wide figure.
  const axisLeft = pad + fs * 2.2 + tickW + fs * 0.8
  const available = width - axisLeft - pad - fs
  const plotW =
    model.kind === 'groups'
      ? Math.min(available, model.groups.length * 125)
      : available
  const shift = (available - plotW) / 2
  const plotX = axisLeft + shift
  const bottomH =
    (model.kind === 'groups' ? fs * 3.4 : fs * 3.2) + legendH + fs * 0.6
  const plotY = headerH
  const plotH = Math.max(60, height - headerH - bottomH)
  // The domain is the data range with a small margin; ticks stay inside it.
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const margin = (hi - lo || Math.abs(hi) || 1) * 0.04
  const vMin = lo - margin
  const vMax = hi + margin
  const sy = (v: number): number =>
    plotY + plotH - ((v - vMin) / (vMax - vMin || 1)) * plotH

  const points: ReactNode[] = []
  const crosses: ReactNode[] = []
  const groupLabels: ReactNode[] = []
  if (model.kind === 'groups') {
    const slot = plotW / model.groups.length
    const crossHalf = fs * 0.9
    const barGap = fs * 0.7
    let size = fs * 0.72
    // Shrink the markers until every swarm and its bar fit the slot.
    let layouts = model.groups.map((g) =>
      beeswarm(
        g.points.map((p) => sy(p.value)),
        size,
      ),
    )
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const widest = Math.max(0, ...layouts.flat().map((p) => Math.abs(p.dx)))
      if (2 * (widest + size / 2) + barGap + 2 * crossHalf <= slot * 0.9) break
      size *= 0.85
      layouts = model.groups.map((g) =>
        beeswarm(
          g.points.map((p) => sy(p.value)),
          size,
        ),
      )
    }
    model.groups.forEach((group, gi) => {
      const layout = layouts[gi]!
      const slotCenter = plotX + slot * gi + slot / 2
      const hasMean =
        group.mean !== null && group.low !== null && group.high !== null
      const halfWidth =
        Math.max(0, ...layout.map((p) => Math.abs(p.dx))) + size / 2
      const unit = swarmUnit(slotCenter, halfWidth, crossHalf, barGap, hasMean)
      const center = unit.swarm
      group.points.forEach((point, pi) => {
        const placed = layout[pi]!
        const cx = center + placed.dx
        const hovered = mode === 'screen' && point.subjectId === hoveredId
        points.push(
          <g
            key={`${group.label}-${point.subjectId}`}
            onMouseEnter={onHover ? () => onHover(point.subjectId) : undefined}
            onMouseLeave={onHover ? () => onHover(null) : undefined}
            onClick={onPick ? () => onPick(point.subjectId) : undefined}
            style={
              mode === 'screen' && onPick ? { cursor: 'pointer' } : undefined
            }
          >
            {hovered && (
              <circle
                cx={cx}
                cy={placed.y}
                r={size * 0.95}
                fill="none"
                stroke={palette.ink}
                strokeWidth={0.8}
              />
            )}
            <Marker
              paper={palette.paper}
              shape={point.shape}
              x={cx}
              y={placed.y}
              size={size}
              color={palette.series(point.color)}
            />
          </g>,
        )
      })
      if (
        unit.cross !== null &&
        group.mean !== null &&
        group.low !== null &&
        group.high !== null
      ) {
        crosses.push(
          <Cross
            key={`c-${group.label}`}
            x={unit.cross}
            mean={group.mean}
            low={group.low}
            high={group.high}
            sy={sy}
            size={crossHalf}
            ink={palette.ink}
          />,
        )
      }
      // The label and n center under the swarm and its bar together.
      groupLabels.push(
        <g key={`l-${group.label}`}>
          <text
            x={slotCenter}
            y={plotY + plotH + fs * 1.9}
            textAnchor="middle"
            fill={palette.ink}
          >
            {fitText(group.label, fs, slot * 0.9)}
          </text>
          <RichText
            rich={[{ i: 'n' }, ` = ${group.n}`]}
            x={slotCenter}
            y={plotY + plotH + fs * 3.1}
            textAnchor="middle"
            fill={palette.ink}
          />
        </g>,
      )
    })
  } else {
    const xs = [
      ...model.groups.flatMap((g) => g.points.map((p) => p.x ?? 0)),
      ...fits.flatMap((fit) => fit.x),
    ]
    const t = niceTicks(Math.min(...xs), Math.max(...xs), 4)
    const sx = (v: number): number =>
      plotX + ((v - t.min) / (t.max - t.min || 1)) * plotW
    const size = fs * 0.62
    // The bands first, then the lines, then the markers above them.
    for (const fit of fits) {
      const color = palette.series(fit.color)
      const upper = fit.x.map(
        (x, i) => `${sx(x).toFixed(2)},${sy(fit.high[i]!).toFixed(2)}`,
      )
      const lower = fit.x
        .map((x, i) => `${sx(x).toFixed(2)},${sy(fit.low[i]!).toFixed(2)}`)
        .reverse()
      points.push(
        <polygon
          key={`band-${fit.group ?? 'all'}`}
          points={[...upper, ...lower].join(' ')}
          fill={color}
          fillOpacity={0.14}
          stroke="none"
        />,
      )
    }
    for (const fit of fits) {
      points.push(
        <polyline
          key={`line-${fit.group ?? 'all'}`}
          points={fit.x
            .map((x, i) => `${sx(x).toFixed(2)},${sy(fit.y[i]!).toFixed(2)}`)
            .join(' ')}
          fill="none"
          stroke={palette.series(fit.color)}
          strokeWidth={1.3}
        />,
      )
    }
    for (const group of model.groups) {
      for (const point of group.points) {
        const hovered = mode === 'screen' && point.subjectId === hoveredId
        points.push(
          <g
            key={point.subjectId}
            onMouseEnter={onHover ? () => onHover(point.subjectId) : undefined}
            onMouseLeave={onHover ? () => onHover(null) : undefined}
            onClick={onPick ? () => onPick(point.subjectId) : undefined}
          >
            {hovered && (
              <circle
                cx={sx(point.x ?? 0)}
                cy={sy(point.value)}
                r={size * 0.95}
                fill="none"
                stroke={palette.ink}
                strokeWidth={0.8}
              />
            )}
            <Marker
              paper={palette.paper}
              shape={point.shape}
              x={sx(point.x ?? 0)}
              y={sy(point.value)}
              size={size}
              color={palette.series(point.color)}
            />
          </g>,
        )
      }
    }
    groupLabels.push(
      ...t.ticks.map((v) => (
        <g key={`xt${v}`}>
          <line
            x1={sx(v)}
            x2={sx(v)}
            y1={plotY + plotH}
            y2={plotY + plotH + fs * 0.5}
            stroke={palette.ink}
            strokeWidth={0.7}
          />
          <text
            x={sx(v)}
            y={plotY + plotH + fs * 1.7}
            textAnchor="middle"
            fill={palette.ink}
          >
            {formatTick(v, t.step)}
          </text>
        </g>
      )),
      <text
        key="xl"
        x={plotX + plotW / 2}
        y={plotY + plotH + fs * 3}
        textAnchor="middle"
        fill={palette.ink}
      >
        {model.xLabel}
      </text>,
      <line
        key="xa"
        x1={plotX}
        x2={plotX + plotW}
        y1={plotY + plotH}
        y2={plotY + plotH}
        stroke={palette.ink}
        strokeWidth={0.7}
      />,
    )
  }

  const legendTop = height - legendH - pad + fs * 0.4
  const yLabelX = pad + fs * 0.9 + shift
  const yLabelY = plotY + plotH / 2

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
        x={plotX + plotW / 2}
        y={pad + titleSize}
        textAnchor="middle"
        fontSize={titleSize}
        fill={palette.ink}
      />
      {model.stats.map((line, index) => (
        <RichText
          key={index}
          rich={line}
          x={plotX + plotW / 2}
          y={pad + titleSize * 1.3 + fs * 1.4 * (index + 1) - fs * 0.2}
          textAnchor="middle"
          fill={palette.ink}
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
        x1={plotX}
        x2={plotX}
        y1={plotY}
        y2={plotY + plotH}
        stroke={palette.ink}
        strokeWidth={0.7}
      />
      {ticks.ticks
        .filter((v) => v >= vMin - 1e-9 && v <= vMax + 1e-9)
        .map((v) => (
          <g key={`yt${v}`}>
            <line
              x1={plotX - fs * 0.5}
              x2={plotX}
              y1={sy(v)}
              y2={sy(v)}
              stroke={palette.ink}
              strokeWidth={0.7}
            />
            <text
              x={plotX - fs * 0.8}
              y={sy(v) + fs * 0.35}
              textAnchor="end"
              fill={palette.ink}
            >
              {formatTick(v, ticks.step)}
            </text>
          </g>
        ))}
      <text
        x={yLabelX}
        y={yLabelY}
        textAnchor="middle"
        transform={`rotate(-90 ${yLabelX.toFixed(2)} ${yLabelY.toFixed(2)})`}
        fill={palette.ink}
      >
        {fitText(model.yLabel, fs, plotH + headerH * 0.6)}
      </text>
      {points}
      {crosses}
      {groupLabels}
      {legendRows.map((rowItems, ri) => {
        const total = rowItems.reduce((sum, item) => sum + item.w, 0)
        let x = (width - total) / 2
        return rowItems.map((item) => {
          const mx = x + fs * 0.8
          const my = legendTop + ri * fs * 1.7 + fs * 0.6
          x += item.w
          return (
            <g key={`lg-${item.label}`}>
              {item.shape === 'cross' ? (
                <g stroke={palette.ink} strokeWidth={1.3}>
                  <line x1={mx} x2={mx} y1={my - fs * 0.6} y2={my + fs * 0.6} />
                  <line x1={mx - fs * 0.6} x2={mx + fs * 0.6} y1={my} y2={my} />
                </g>
              ) : item.shape === 'line' ? (
                <line
                  x1={mx - fs * 0.7}
                  x2={mx + fs * 0.7}
                  y1={my}
                  y2={my}
                  stroke={palette.series(item.color)}
                  strokeWidth={1.3}
                />
              ) : (
                <Marker
                  paper={palette.paper}
                  shape={item.shape}
                  x={mx}
                  y={my}
                  size={fs * 0.72}
                  color={palette.series(item.color)}
                />
              )}
              <text x={mx + fs * 1.1} y={my + fs * 0.35} fill={palette.ink}>
                {item.label}
              </text>
            </g>
          )
        })
      })}
    </svg>
  )
}
