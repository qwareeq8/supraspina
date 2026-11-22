import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { THEMES } from '../theme/tokens'
import { InfoTip } from './Help'

const t = THEMES.dark
const explanation = 'Review the AIS impairment grade recorded at admission.'

describe('InfoTip', () => {
  it('Uses a short button name and a separate tooltip description.', () => {
    render(<InfoTip t={t} text={explanation} />)

    const button = screen.getByRole('button', { name: 'More information' })
    const tooltip = screen.getByRole('tooltip')
    expect(button).toHaveAttribute('aria-describedby', tooltip.id)
    expect(button).not.toHaveAttribute('title')
    expect(button).toHaveStyle({ width: '24px', height: '24px' })
    expect(screen.queryByRole('img', { name: explanation })).toBeNull()
  })

  it('Reveals help on focus and dismisses it on blur or Escape.', () => {
    render(<InfoTip t={t} text={explanation} />)
    const button = screen.getByRole('button', { name: 'More information' })
    const tooltip = screen.getByRole('tooltip')

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(tooltip).toHaveStyle({ width: '1px' })

    fireEvent.focus(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(tooltip).toHaveStyle({ width: 'max-content' })

    fireEvent.keyDown(button, { key: 'Escape' })
    expect(button).toHaveAttribute('aria-expanded', 'false')

    fireEvent.focus(button)
    fireEvent.blur(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('Reveals help on pointer hover and supports explicit activation.', () => {
    render(<InfoTip t={t} text={explanation} />)
    const button = screen.getByRole('button', { name: 'More information' })
    const wrapper = button.parentElement
    if (!wrapper) throw new Error('Find the InfoTip wrapper before testing.')

    fireEvent.mouseEnter(wrapper)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('tooltip')).toHaveStyle({
      pointerEvents: 'auto',
      userSelect: 'text',
    })
    fireEvent.mouseLeave(wrapper)
    expect(button).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('Opens toward the window near an edge and below near the top.', () => {
    const rectAt = (left: number, top: number): DOMRect =>
      ({
        left,
        top,
        width: 14,
        height: 14,
        right: left + 14,
        bottom: top + 14,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect
    const { unmount } = render(<InfoTip t={t} text={explanation} />)
    let button = screen.getByRole('button', { name: 'More information' })
    let wrapper = button.parentElement
    if (!wrapper) throw new Error('Find the InfoTip wrapper before testing.')

    // Mid-window with room above: centered above the glyph.
    wrapper.getBoundingClientRect = () => rectAt(500, 400)
    fireEvent.focus(button)
    let tooltip = screen.getByRole('tooltip')
    expect(tooltip.style.left).toBe('50%')
    expect(tooltip.style.bottom).toBe('calc(100% + 7px)')
    expect(tooltip.style.top).toBe('')
    unmount()

    // At the right edge and the top: aligned to the glyph's end, below it.
    render(<InfoTip t={t} text={explanation} />)
    button = screen.getByRole('button', { name: 'More information' })
    wrapper = button.parentElement
    if (!wrapper) throw new Error('Find the InfoTip wrapper before testing.')
    wrapper.getBoundingClientRect = () => rectAt(window.innerWidth - 20, 4)
    fireEvent.focus(button)
    tooltip = screen.getByRole('tooltip')
    expect(tooltip.style.right).toBe('-6px')
    expect(tooltip.style.left).toBe('')
    expect(tooltip.style.top).toBe('calc(100% + 7px)')
    expect(tooltip.style.bottom).toBe('')
  })
})
