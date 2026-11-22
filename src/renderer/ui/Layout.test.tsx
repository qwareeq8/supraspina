import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Card, Divider, Page, Segments } from './Layout'
import { THEMES } from '../theme/tokens'

describe('Page', () => {
  it('renders one header row with the title and the actions', () => {
    const { container } = render(
      <Page
        t={THEMES.light}
        title="Registry"
        right={<button type="button">Refresh registry</button>}
      >
        <p>Registry body</p>
      </Page>,
    )
    const [header, body] = Array.from(
      container.firstElementChild?.children ?? [],
    )
    if (!(header instanceof HTMLElement) || !body) {
      throw new Error('Render the header and body.')
    }
    expect(header.style.alignItems).toBe('center')
    expect(header.style.flexWrap).toBe('wrap')
    // The header holds only the title and the actions.
    expect(header.children).toHaveLength(2)
    expect(header).toContainElement(
      screen.getByRole('heading', { name: 'Registry' }),
    )
    expect(header).toContainElement(
      screen.getByRole('button', { name: 'Refresh registry' }),
    )
    expect(body).toContainElement(screen.getByText('Registry body'))
  })

  it('keeps the header height of a page without actions', () => {
    render(
      <Page t={THEMES.light} title="Settings">
        <p>Body</p>
      </Page>,
    )
    const title = screen.getByRole('heading', { name: 'Settings' })
    expect(title.parentElement?.style.minHeight).toBe('var(--ss-input-h)')
  })

  it('omits the header on request', () => {
    render(
      <Page t={THEMES.light} title="Hidden" hideHeader>
        <p>Body</p>
      </Page>,
    )
    expect(screen.queryByRole('heading', { name: 'Hidden' })).toBeNull()
  })
})

describe('Segments', () => {
  it('hugs its options and sets each option tooltip', () => {
    render(
      <Segments
        t={THEMES.light}
        value="a"
        ariaLabel="Mode"
        options={[
          { value: 'a', label: 'Alpha', title: 'The first mode.' },
          { value: 'b', label: 'Beta' },
          'c',
        ]}
      />,
    )
    const group = screen.getByRole('radiogroup', { name: 'Mode' })
    expect(group.style.width).toBe('fit-content')
    expect(group.style.maxWidth).toBe('100%')
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute(
      'title',
      'The first mode.',
    )
    expect(screen.getByRole('radio', { name: 'Beta' })).not.toHaveAttribute(
      'title',
    )
    expect(screen.getByRole('radio', { name: 'c' })).toBeInTheDocument()
  })
})

describe('Divider', () => {
  it('renders a label as a heading without a rule', () => {
    const { container } = render(<Divider t={THEMES.light} label="Stages" />)
    const heading = screen.getByRole('heading', { name: 'Stages' })
    expect(container.firstElementChild).toBe(heading)
    expect(heading.style.margin).toBe('16px 0px 4px')
  })

  it('renders a plain rule without a label', () => {
    const { container } = render(<Divider t={THEMES.light} />)
    expect((container.firstElementChild as HTMLElement).style.height).toBe(
      '1px',
    )
  })
})

describe('Card', () => {
  /** Render a titled card and return its title row, title, and sub tag. */
  function renderCard(wrapHeader?: boolean): {
    header: HTMLElement
    title: HTMLElement
    sub: HTMLElement
  } {
    render(
      <Card
        t={THEMES.light}
        title="Recent subjects"
        sub="loading"
        action={<span>Status legend</span>}
        {...(wrapHeader === undefined ? {} : { wrapHeader })}
      >
        <p>Card body</p>
      </Card>,
    )
    const title = screen.getByRole('heading', { name: 'Recent subjects' })
    const header = title.parentElement
    if (!header) throw new Error('Render the title row.')
    return { header, title, sub: screen.getByText('loading') }
  }

  it('keeps the fixed card-header height by default', () => {
    const { header, title, sub } = renderCard()
    expect(header.style.height).toBe('var(--ss-card-header)')
    expect(header.style.minHeight).toBe('')
    expect(header.style.flexWrap).toBe('')
    expect(title.style.whiteSpace).toBe('')
    expect(sub.style.whiteSpace).toBe('')
  })

  it('grows the title row and wraps the action below a one-line title', () => {
    const { header, title, sub } = renderCard(true)
    // A minimum height, not a fixed one, lets wrapped rows push the header
    // rule down instead of spilling over the card border and the rule.
    expect(header.style.height).toBe('')
    expect(header.style.minHeight).toBe('var(--ss-card-header)')
    expect(header.style.flexWrap).toBe('wrap')
    expect(header.style.paddingTop).toBe('4px')
    expect(header.style.paddingBottom).toBe('4px')
    expect(title.style.whiteSpace).toBe('nowrap')
    expect(sub.style.whiteSpace).toBe('nowrap')
    expect(header).toContainElement(screen.getByText('Status legend'))
  })

  it('breaks a long title and sub and keeps the action at the right edge', () => {
    render(
      <Card
        t={THEMES.light}
        title="Synthetic cohort features"
        sub="outputs/features/concatenated_results.csv"
        action={<button type="button">Reveal</button>}
        wrapTitle
      >
        <p>Card body</p>
      </Card>,
    )
    const title = screen.getByRole('heading', {
      name: 'Synthetic cohort features',
    })
    const sub = screen.getByText('outputs/features/concatenated_results.csv')
    const group = title.parentElement
    const header = group?.parentElement
    if (!group || !header) throw new Error('Render the title row.')
    // The row grows like wrapHeader, so wrapped rows push the rule down.
    expect(header.style.height).toBe('')
    expect(header.style.minHeight).toBe('var(--ss-card-header)')
    expect(header.style.flexWrap).toBe('wrap')
    // The title and sub share one group that may break a path anywhere.
    expect(group).toContainElement(sub)
    expect(group.style.flexWrap).toBe('wrap')
    expect(group.style.minWidth).toBe('0px')
    for (const text of [title, sub]) {
      expect(text.style.whiteSpace).toBe('')
      expect(text.style.overflowWrap).toBe('anywhere')
    }
    // The action sits in its own right-aligned slot, not after a spacer.
    const action = screen.getByRole('button', { name: 'Reveal' }).parentElement
    expect(action?.parentElement).toBe(header)
    expect(action?.style.marginLeft).toBe('auto')
    expect(header.children).toHaveLength(2)
  })

  it('sets a sub in sans unless it is marked as a code-like value', () => {
    const { sub } = renderCard()
    expect(sub.style.fontFamily).toContain('WebCM Sans 10')
    render(
      <Card t={THEMES.light} title="Artifact" sub="outputs/a.csv" subMono>
        <p>Card body</p>
      </Card>,
    )
    expect(screen.getByText('outputs/a.csv').style.fontFamily).toContain(
      'WebCM Mono 10',
    )
  })
})
