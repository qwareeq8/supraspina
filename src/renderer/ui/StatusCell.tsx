/**
 * Encodes status through both color and shape. Animation and horizontal
 * progress are reserved for running work.
 */

import type { ReactNode } from 'react'
import type { Cell, CellState } from '../../shared/types'
import { type Density, type Theme } from '../theme/tokens'
import { ICONS } from './icon-set'
import { Ico } from './icons'
import {
  cellStateLabel,
  statusGlyphColor,
  statusGlyphShape,
  type StatusGlyphShape,
} from './status'

/**
 * The icon each ringed shape draws. The running progress ring is drawn
 * separately.
 */
const SHAPE_ICON: Record<Exclude<StatusGlyphShape, 'progress-ring'>, string> = {
  // An empty ring: the step has not started.
  ring: 'ring',
  // A dashed ring: the step holds a place in the current run's plan.
  'dashed-ring': 'circleDashed',
  // An ellipsis: the step waits on an earlier step.
  'ellipsis-ring': 'circleEllipsis',
  // A clock: the step is next in line to start.
  clock: 'clock',
  // A dashed ring around a stop square: the stop is under way.
  'dashed-stop-ring': 'circleDashedStop',
  'check-ring': 'circleCheck',
  'cross-ring': 'circleX',
  // A ringed stop square: the step stopped before it finished.
  'stop-ring': 'stop',
  // A circle with a bar: the step cannot run.
  prohibited: 'ban',
  // Pause bars: the run holds the step back after another job failed.
  pause: 'circlePause',
  // A bolt: the step stopped partway.
  bolt: 'circleBolt',
  // A question mark: the step's run state is unknown.
  question: 'circleQuestion',
  'minus-ring': 'circleMinus',
  // A rerun arrow: the output exists, and Run all repeats it.
  rerun: 'circleRerun',
}

/** One status glyph and the width it draws within. */
export interface StatusGlyphProps {
  st: CellState
  t: Theme
  progress?: number | null | undefined
  /** Whether the running ring pulses; a legend sample passes false. */
  animate?: boolean
  /**
   * The color to draw the shape in instead of the state's own tone, such as
   * the neutral ring of a Recent runs dry-run plan, in which nothing ran.
   */
  color?: string | undefined
}

/**
 * Render the shape for one matrix status. Share it between matrix cells and
 * the status legend, so each legend sample is the glyph its cell draws.
 *
 * @returns The status glyph without its cell frame.
 */
export function StatusGlyph({
  st,
  t,
  progress,
  animate = true,
  color: tone,
}: StatusGlyphProps): ReactNode {
  const color = tone ?? statusGlyphColor(t, st)
  const shape = statusGlyphShape(st)
  if (shape === 'progress-ring') {
    // A faint ring with an arc that fills clockwise as the step progresses.
    // An unknown progress draws a short arc rather than none.
    const filled = Math.min(100, Math.max(5, progress ?? 25))
    return (
      <Ico
        d={
          <>
            <circle cx="12" cy="12" r="10" opacity={0.28} />
            <circle
              cx="12"
              cy="12"
              r="10"
              pathLength={100}
              strokeDasharray={`${filled} 100`}
              transform="rotate(-90 12 12)"
              style={{ transition: 'stroke-dasharray .3s linear' }}
            />
          </>
        }
        stroke={color}
        glyphShape={shape}
        {...(animate ? { style: { animation: 'ssPulse 1.4s infinite' } } : {})}
      />
    )
  }
  return <Ico d={ICONS[SHAPE_ICON[shape]]} stroke={color} glyphShape={shape} />
}

/** One matrix status cell and its display context. */
export interface StatusCellProps {
  cell: Cell
  density: Density
  t: Theme
  stepLabel?: string | undefined
}

/** Render one matrix status with redundant visual cues. */
export function StatusCell({
  cell,
  density,
  t,
  stepLabel,
}: StatusCellProps): ReactNode {
  const { st, progress } = cell
  // Keep the compact hit area at the 24 px WCAG 2.2 minimum.
  const width = density.cell
  const height = density.cell
  const label = cellStateLabel(st)
  const title = stepLabel ? `${stepLabel}: ${label}` : label

  return (
    <div
      role="img"
      title={title}
      aria-label={title}
      // Every state draws a glyph, so every cell carries the 3:1 check.
      data-nontext-contrast="status-glyph"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width,
        height,
        color: statusGlyphColor(t, st),
      }}
    >
      <StatusGlyph st={st} t={t} progress={progress} />
    </div>
  )
}
