import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { THEMES } from '../theme/tokens'
import { Field, PathInput, TextInput } from './Forms'
import { Segments } from './Layout'

const t = THEMES.dark

describe('shared form semantics', () => {
  it('wires a stable visible label and hint to its text input', () => {
    const view = render(
      <Field t={t} label="Subject identifier" hint="Use the sub-NNN pattern.">
        <TextInput t={t} value="sub-001" />
      </Field>,
    )

    const input = screen.getByRole('textbox', { name: 'Subject identifier' })
    const label = screen.getByText('Subject identifier')
    const initialId = input.id
    const descriptionId = input.getAttribute('aria-describedby')

    expect(initialId).not.toBe('')
    expect(label).toHaveAttribute('for', initialId)
    expect(descriptionId).not.toBeNull()
    expect(document.getElementById(descriptionId ?? '')).toHaveTextContent(
      'Use the sub-NNN pattern.',
    )

    view.rerender(
      <Field t={t} label="Subject identifier" hint="Use the sub-NNN pattern.">
        <TextInput t={t} value="sub-002" />
      </Field>,
    )
    expect(
      screen.getByRole('textbox', { name: 'Subject identifier' }),
    ).toHaveAttribute('id', initialId)
  })

  it('sets the hint in sans beside a mono code-like input', () => {
    render(
      // Mono belongs to the input; Field has no family prop of its own.
      // @ts-expect-error Field takes no mono prop.
      <Field t={t} label="Subject ID" hint="Empty when the ID is unknown." mono>
        <TextInput t={t} value="sub-001" mono />
      </Field>,
    )

    expect(
      screen.getByText('Empty when the ID is unknown.').style.fontFamily,
    ).toContain('WebCM Sans 10')
    expect(
      screen.getByRole('textbox', { name: 'Subject ID' }).style.fontFamily,
    ).toContain('WebCM Mono 10')
  })

  it('announces validation errors and points aria-errormessage at the alert', () => {
    render(
      <Field t={t} label="Age" error="Enter an age in years.">
        <TextInput t={t} value="" />
      </Field>,
    )

    const input = screen.getByRole('textbox', { name: 'Age' })
    const alert = screen.getByRole('alert')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-errormessage', alert.id)
    expect(input.getAttribute('aria-describedby')?.split(/\s+/)).toContain(
      alert.id,
    )
  })

  it('keeps PathInput Browse outside the input label', () => {
    const onBrowse = vi.fn()
    render(
      <Field t={t} label="Project root" hint="Choose an absolute directory.">
        <PathInput t={t} value="/data/projects/example" onBrowse={onBrowse} />
      </Field>,
    )

    const input = screen.getByRole('textbox', { name: 'Project root' })
    const browse = screen.getByRole('button', { name: 'Browse...' })
    const label = screen.getByText('Project root')

    expect(label.tagName).toBe('LABEL')
    expect(label).toHaveAttribute('for', input.id)
    expect(label.contains(browse)).toBe(false)
    fireEvent.click(browse)
    expect(onBrowse).toHaveBeenCalledOnce()
  })

  it('uses the Field label and hint for grouped controls', () => {
    render(
      <Field t={t} label="Sex" hint="Select the registry value.">
        <Segments
          t={t}
          value="F"
          options={['F', 'M']}
          onChange={() => undefined}
        />
      </Field>,
    )

    const group = screen.getByRole('radiogroup', { name: 'Sex' })
    const descriptionId = group.getAttribute('aria-describedby')
    expect(group).toHaveAttribute('id')
    expect(descriptionId).not.toBeNull()
    expect(document.getElementById(descriptionId ?? '')).toHaveTextContent(
      'Select the registry value.',
    )
  })
})
