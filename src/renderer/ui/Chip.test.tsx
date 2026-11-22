import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { ChipStatus } from '../../shared/types'
import { THEMES, statusColor } from '../theme/tokens'
import { Chip, NoticeGlyph, type NoticeTone } from './Chip'
import { CohortNotice } from './CohortNotice'

const t = THEMES.light

/** Render a chip and return the shape name its glyph declares. */
function glyphShapeOf(status: ChipStatus): string | null {
  const { container } = render(<Chip t={t} status={status} />)
  return (
    container
      .querySelector('[data-glyph-shape]')
      ?.getAttribute('data-glyph-shape') ?? null
  )
}

describe('Chip glyph', () => {
  it('draws the matrix glyph for a cell state', () => {
    expect(glyphShapeOf('done')).toBe('check-ring')
    expect(glyphShapeOf('failed')).toBe('cross-ring')
    expect(glyphShapeOf('queued')).toBe('clock')
    expect(glyphShapeOf('skipped')).toBe('minus-ring')
  })

  it('draws a ringed mark for every other status', () => {
    expect(glyphShapeOf('found')).toBe('circleCheck')
    expect(glyphShapeOf('missing')).toBe('circleX')
    expect(glyphShapeOf('warn')).toBe('circleAlert')
    expect(glyphShapeOf('wrong')).toBe('circleAlert')
    expect(glyphShapeOf('partial')).toBe('circleHalf')
    expect(glyphShapeOf('na')).toBe('ring')
  })

  it("draws the glyph in the chip's status tone", () => {
    const { container } = render(<Chip t={t} status="missing" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('stroke')).toBe(statusColor(t, 'missing'))
  })

  it('keeps a glyph the caller passes', () => {
    const { container } = render(
      <Chip t={t} status="na" glyph={<span data-testid="own" />} />,
    )
    expect(container.querySelector('[data-testid="own"]')).not.toBeNull()
    expect(container.querySelector('[data-glyph-shape]')).toBeNull()
  })
})

describe('NoticeGlyph', () => {
  const shapeOf = (tone: NoticeTone): string | null =>
    render(<NoticeGlyph t={t} tone={tone} />)
      .container.querySelector('[data-glyph-shape]')
      ?.getAttribute('data-glyph-shape') ?? null

  it('draws ringed marks, never the warning triangle', () => {
    expect(shapeOf('warn')).toBe('circleAlert')
    expect(shapeOf('info')).toBe('info')
    expect(shapeOf('failed')).toBe('cross-ring')
  })

  it('draws a notice banner with the ringed glyph of its tone', () => {
    const notice = (attention: boolean) =>
      render(
        <CohortNotice
          t={t}
          attention={attention}
          headline="2 subjects are waiting on ENIGMA QC."
          actionTitle="Open Runs to review ENIGMA QC."
          onOpenRuns={() => undefined}
        />,
      )
        .container.querySelector('[data-glyph-shape]')
        ?.getAttribute('data-glyph-shape')
    expect(notice(true)).toBe('circleAlert')
    expect(notice(false)).toBe('info')
  })
})
