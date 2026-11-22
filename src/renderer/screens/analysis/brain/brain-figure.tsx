/**
 * The exported figure of the Brain tab, in the print palette: the cropped
 * render with the color scale, the significance key, and caption lines
 * naming the contrast, the view, and the correction.
 */

import { useId, type ReactNode } from 'react'
import {
  CORTEX_GRAY,
  DIVERGING_STOPS,
  MUTED_MIX,
  SIGNIFICANT_OUTLINE,
  type Rgb,
} from './brain-map'
import {
  BAR_HEIGHT,
  BAR_WIDTH,
  PAD,
  SWATCH,
  brainFigureLayout,
  type BrainFigureScale,
} from './brain-figure-layout'
import type { Rich } from '../../../figures/rich'
import {
  FIGURE_FONT_PT,
  PRINT_PALETTE,
  figureFont,
} from '../../../figures/style'
import { RichText } from '../../../figures/text'

/** The drawing of a brain figure at one width. */
export interface BrainFigureProps {
  /** The cropped render as a PNG data URL, with its pixel size. */
  image: { href: string; width: number; height: number }
  /** The figure width in points. */
  width: number
  /** The export's physical width, which sets the SVG width attribute. */
  widthMm: number
  /** The caption lines above the render. */
  lines: readonly Rich[]
  scale: BrainFigureScale
  title: string
  summary: string
}

function rgb(color: Rgb): string {
  return `rgb(${color[0]},${color[1]},${color[2]})`
}

/** Draw the exported brain figure in the print palette. */
export function BrainFigure({
  image,
  width,
  widthMm,
  lines,
  scale,
  title,
  summary,
}: BrainFigureProps): ReactNode {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const fs = FIGURE_FONT_PT
  const ink = PRINT_PALETTE.ink
  const muted = PRINT_PALETTE.muted
  const layout = brainFigureLayout(width, image, lines, scale)
  const box = layout.image
  const mutedStop = DIVERGING_STOPS[1]!.map((c) =>
    Math.round(c + (CORTEX_GRAY - c) * MUTED_MIX),
  ) as unknown as Rgb
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-desc`}
      viewBox={`0 0 ${width.toFixed(2)} ${layout.height}`}
      width={`${widthMm}mm`}
      height={`${((layout.height / width) * widthMm).toFixed(2)}mm`}
      fontFamily={figureFont('export')}
      fontSize={fs}
      textRendering="geometricPrecision"
    >
      <title id={`${id}-title`}>{title}</title>
      <desc id={`${id}-desc`}>{summary}</desc>
      <defs>
        <linearGradient id={`${id}-scale`} x1="0" x2="1" y1="0" y2="0">
          {DIVERGING_STOPS.map((stop, index) => (
            <stop
              key={index}
              offset={(index / (DIVERGING_STOPS.length - 1)).toFixed(3)}
              stopColor={rgb(stop)}
            />
          ))}
        </linearGradient>
      </defs>
      <rect
        x={0}
        y={0}
        width={width}
        height={layout.height}
        fill={PRINT_PALETTE.paper}
      />
      {layout.lines.map((line, index) => (
        <RichText
          key={index}
          rich={line.rich}
          x={PAD}
          y={line.y}
          fill={muted}
          fontStyle="italic"
        />
      ))}
      <image
        href={image.href}
        x={box.x.toFixed(2)}
        y={box.y.toFixed(2)}
        width={box.w.toFixed(2)}
        height={box.h.toFixed(2)}
        preserveAspectRatio="xMidYMid meet"
      />
      <rect
        x={layout.bar.x}
        y={layout.bar.y}
        width={BAR_WIDTH}
        height={BAR_HEIGHT}
        fill={`url(#${id}-scale)`}
        stroke={PRINT_PALETTE.rule}
        strokeWidth={0.4}
      />
      {layout.texts.map((placed, index) => (
        <text
          key={index}
          x={placed.x}
          y={placed.y}
          textAnchor={placed.anchor}
          fill={ink}
        >
          {placed.text}
        </text>
      ))}
      <text x={layout.stat.x} y={layout.stat.y} fill={muted}>
        (<tspan fontStyle="italic">{scale.stat}</tspan>)
      </text>
      {layout.key.map((item, index) => (
        <g key={item.label}>
          <rect
            x={item.x}
            y={item.y - fs * 0.75}
            width={SWATCH}
            height={fs * 0.9}
            rx={0.6}
            fill={index === 0 ? rgb(DIVERGING_STOPS[1]!) : rgb(mutedStop)}
            stroke={index === 0 ? rgb(SIGNIFICANT_OUTLINE) : undefined}
            strokeWidth={index === 0 ? 1 : undefined}
          />
          <text x={item.x + SWATCH + fs * 0.4} y={item.y} fill={ink}>
            {item.label}
          </text>
        </g>
      ))}
    </svg>
  )
}
