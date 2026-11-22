/** One figure marker drawn at a point. */

import type { ReactNode } from 'react'
import type { MarkerShape } from './style'

/** Where and how to draw a marker. */
export interface MarkerProps {
  shape: MarkerShape
  x: number
  y: number
  /** The marker's width in points. */
  size: number
  color: string
  /** The fill of an open shape, the paper under it. */
  paper?: string
  strokeWidth?: number
}

/** Draw a marker centered on (x, y). */
export function Marker({
  shape,
  x,
  y,
  size,
  color,
  paper = '#ffffff',
  strokeWidth = 0.9,
}: MarkerProps): ReactNode {
  const r = size / 2
  const open = shape.endsWith('-open')
  const fill = open ? paper : color
  const common = {
    fill,
    stroke: color,
    strokeWidth: open ? strokeWidth : 0,
  }
  if (shape.startsWith('circle')) {
    const radius = open ? r - strokeWidth / 2 : r
    return <circle cx={x} cy={y} r={radius} {...common} />
  }
  if (shape.startsWith('square')) {
    const side = size * 0.84 - (open ? strokeWidth : 0)
    return (
      <rect
        x={x - side / 2}
        y={y - side / 2}
        width={side}
        height={side}
        {...common}
      />
    )
  }
  if (shape.startsWith('triangle')) {
    const h = size * 1.05
    const w = size * 1.12
    const points = [
      [x, y - h * 0.6],
      [x + w / 2, y + h * 0.4],
      [x - w / 2, y + h * 0.4],
    ]
      .map(([px, py]) => `${px!.toFixed(2)},${py!.toFixed(2)}`)
      .join(' ')
    return <polygon points={points} {...common} />
  }
  const d = r * 1.2
  const points = [
    [x, y - d],
    [x + d, y],
    [x, y + d],
    [x - d, y],
  ]
    .map(([px, py]) => `${px!.toFixed(2)},${py!.toFixed(2)}`)
    .join(' ')
  return <polygon points={points} {...common} />
}
