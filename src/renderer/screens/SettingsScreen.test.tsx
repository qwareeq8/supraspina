import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, it, expect } from 'vitest'
import { AppProvider } from '../state/context'
import { SettingsScreen } from './SettingsScreen'

function renderWithProvider(ui: ReturnType<typeof SettingsScreen>) {
  return render(<AppProvider>{ui}</AppProvider>)
}

describe('SettingsScreen', () => {
  beforeEach(() => localStorage.clear())

  it('should render the settings heading when mounted', async () => {
    renderWithProvider(<SettingsScreen />)
    expect(
      await screen.findByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument()
  })

  it('should not show the raw config JSON by default', async () => {
    renderWithProvider(
      <SettingsScreen cfg={{ project: { name: 'X' } } as never} />,
    )

    expect(
      await screen.findByText('Edit these values in Setup and Pipeline.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/"project"/)).not.toBeInTheDocument()
  })

  it('should reveal the config JSON as a disclosure named by its action', async () => {
    renderWithProvider(<SettingsScreen />)
    const toggle = await screen.findByRole('button', {
      name: 'Show JSON',
    })
    await waitFor(() => expect(toggle).not.toBeDisabled())

    // A disclosure reports expansion, never a pressed state.
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).not.toHaveAttribute('aria-pressed')
    const regionId = toggle.getAttribute('aria-controls')
    expect(regionId).toBeTruthy()
    const region = document.getElementById(regionId ?? '')
    expect(region).not.toBeNull()
    expect(region).not.toBeVisible()
    expect(screen.queryByText(/"project"/)).not.toBeInTheDocument()

    fireEvent.click(toggle)

    const json = await screen.findByText(/"project"/)
    // The block is a configuration file, not a command.
    const block = screen.getByRole('group', { name: 'JSON configuration' })
    expect(block).toContainElement(json)
    expect(screen.queryByRole('group', { name: 'json command' })).toBeNull()
    expect(toggle).toHaveAccessibleName('Hide JSON')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).not.toHaveAttribute('aria-pressed')
    expect(document.getElementById(regionId ?? '')).toBe(region)
    expect(region).toBeVisible()
    expect(region).toContainElement(json)
  })

  it('should hide the JSON again when the disclosure is clicked twice', async () => {
    renderWithProvider(<SettingsScreen />)
    const toggle = await screen.findByRole('button', {
      name: 'Show JSON',
    })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    fireEvent.click(toggle)
    expect(await screen.findByText(/"project"/)).toBeInTheDocument()
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(screen.queryByText(/"project"/)).not.toBeInTheDocument(),
    )
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      document.getElementById(toggle.getAttribute('aria-controls') ?? ''),
    ).not.toBeVisible()
  })

  it('should reveal the injected cfg as JSON when revealed', async () => {
    const cfg = { project: { name: 'Injected Project' } } as never
    renderWithProvider(<SettingsScreen cfg={cfg} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show JSON' }))
    expect(
      await screen.findByText(/"name": "Injected Project"/),
    ).toBeInTheDocument()
  })

  it('should disable the JSON toggle until the config is ready', async () => {
    renderWithProvider(<SettingsScreen />)

    const toggle = await screen.findByRole('button', {
      name: 'Show JSON',
    })
    await waitFor(() => expect(toggle).not.toBeDisabled())
  })

  it('should not render the detected environment (moved to Diagnostics)', async () => {
    renderWithProvider(<SettingsScreen />)

    await screen.findByRole('heading', { name: 'Settings' })

    expect(screen.queryByText('Detected')).not.toBeInTheDocument()
    expect(screen.queryByText('Platform')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Fix in Doctor' }),
    ).not.toBeInTheDocument()
  })

  it('should not show a Last updated timestamp', async () => {
    renderWithProvider(<SettingsScreen />)
    await screen.findByRole('heading', { name: 'Settings' })
    expect(screen.queryByText(/^Last updated/)).not.toBeInTheDocument()
  })

  it('should keep the header to the title and the reset action', async () => {
    renderWithProvider(<SettingsScreen />)
    const reset = await screen.findByRole('button', {
      name: 'Reset preferences',
    })
    expect(reset).toHaveAttribute(
      'title',
      'Restores the default preferences on this computer.',
    )
    expect(screen.queryByText('Machine-local')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Diagnostics screen' }),
    ).toBeNull()
  })

  it('should group general settings before the Diagnostics section', async () => {
    renderWithProvider(<SettingsScreen />)
    await screen.findByText('Display and behavior')
    const general = screen.getByText('Display and behavior')
    const accessibility = screen.getByText('Accessibility')
    const safe = screen.getByRole('heading', {
      level: 2,
      name: 'Execution',
    })

    const order = (a: Element, b: Element): boolean =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(order(general, accessibility)).toBe(true)
    expect(order(accessibility, safe)).toBe(true)
  })

  it('uses real section headings for every major settings card', async () => {
    renderWithProvider(<SettingsScreen />)
    await screen.findByRole('heading', { name: 'Settings' })

    for (const name of [
      'Display and behavior',
      'Window placement',
      'Accessibility',
      'Updates',
      'Execution',
      'Configuration',
    ]) {
      expect(
        screen.getByRole('heading', { level: 2, name }),
      ).toBeInTheDocument()
    }
  })

  it('should lift safe-execution changes when the toggle is clicked', async () => {
    let lifted: boolean | undefined
    renderWithProvider(
      <SettingsScreen
        safeExecution={false}
        onSafeExecutionChange={(next) => {
          lifted = next
        }}
      />,
    )
    const toggle = await screen.findByRole('switch', {
      name: 'Allow live runs',
    })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    // The card names the category, so the setting's name shows once.
    expect(screen.getAllByText('Allow live runs')).toHaveLength(1)
    fireEvent.click(toggle)
    await waitFor(() => expect(lifted).toBe(true))
  })

  it('should keep the Theme axis present after switching to Light', async () => {
    renderWithProvider(<SettingsScreen />)
    const lightBtn = await screen.findByRole('radio', { name: 'Light' })
    fireEvent.click(lightBtn)
    expect(screen.getByText('Theme')).toBeInTheDocument()
  })

  it('should expose the accessibility controls and toggle high contrast', async () => {
    renderWithProvider(<SettingsScreen />)
    expect(await screen.findByText('Accessibility')).toBeInTheDocument()
    expect(screen.getByText('Larger text')).toBeInTheDocument()
    expect(screen.getByText('Reduced motion')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '135%' })).toBeInTheDocument()

    const hc = screen.getByRole('switch', { name: 'High contrast' })
    expect(hc).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(hc)
    await waitFor(() => expect(hc).toHaveAttribute('aria-checked', 'true'))
  })

  it('should explain each display & behavior axis in plain language', async () => {
    renderWithProvider(<SettingsScreen />)

    expect(
      await screen.findByText(
        'Whisper keeps failures quiet, Notice adds an alert, and Triage lists failed subjects first.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Shell is a terminal-style QC view, and Notebook is a lab-notebook layout. Both show the same data.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Shows the exact command for each Pipeline step by default.',
      ),
    ).toBeInTheDocument()
    // Self-evident axes carry no explanation and no info tip.
    expect(screen.queryByRole('button', { name: 'About Theme' })).toBeNull()
  })

  it('should explain each accessibility axis in plain language', async () => {
    renderWithProvider(<SettingsScreen />)
    expect(
      await screen.findByText(
        'When off, Supraspina follows the system setting.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Raises text and border contrast.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'About Larger text' }),
    ).toBeNull()
  })

  it('programmatically associates each axis control with its description', async () => {
    renderWithProvider(<SettingsScreen />)
    const theme = await screen.findByRole('radiogroup', { name: 'Theme' })
    const emphasis = screen.getByRole('radiogroup', {
      name: 'Failure emphasis',
    })
    const emphasisDescriptionId = emphasis.getAttribute('aria-describedby')
    expect(emphasisDescriptionId).not.toBeNull()
    expect(
      document.getElementById(emphasisDescriptionId ?? ''),
    ).toHaveTextContent(/Whisper keeps failures quiet/)

    const highContrast = screen.getByRole('switch', {
      name: 'High contrast',
    })
    const contrastDescriptionId = highContrast.getAttribute('aria-describedby')
    expect(contrastDescriptionId).not.toBeNull()
    expect(
      document.getElementById(contrastDescriptionId ?? ''),
    ).toHaveTextContent(/Raises text and border contrast/)

    const axis = theme.closest('[role="group"]')
    const axisLabelId = axis?.getAttribute('aria-labelledby')
    expect(axisLabelId).not.toBeNull()
    expect(document.getElementById(axisLabelId ?? '')).toHaveTextContent(
      'Theme',
    )
  })

  it('should orient a fresh project toward the Setup wizard', async () => {
    const cfg = {
      project: { name: 'Fresh' },
      paths: { rawdataDir: '', derivativesDir: '' },
    } as never
    renderWithProvider(<SettingsScreen cfg={cfg} />)
    expect(
      await screen.findByText(/The input and derivatives data paths are empty/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Open Setup wizard' }),
    ).toBeInTheDocument()
  })

  it('should persist tweaks across remounts through machine preferences', async () => {
    const first = renderWithProvider(<SettingsScreen />)
    const hc = await screen.findByRole('switch', { name: 'High contrast' })
    expect(hc).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(hc)
    await waitFor(() => expect(hc).toHaveAttribute('aria-checked', 'true'))
    first.unmount()

    renderWithProvider(<SettingsScreen />)
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'High contrast' }),
      ).toHaveAttribute('aria-checked', 'true'),
    )
  })

  it('offers System theme, automatic saving copy, and no duplicate config actions', async () => {
    renderWithProvider(<SettingsScreen />)
    expect(
      await screen.findByRole('radio', { name: 'System' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Reload config' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Save config' }),
    ).not.toBeInTheDocument()
  })

  it('shows placement actions and no display tile for a single display', async () => {
    renderWithProvider(<SettingsScreen />)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Identify displays' }),
      ).toBeEnabled(),
    )
    expect(
      screen.getByRole('button', { name: 'Move window now' }),
    ).toBeEnabled()
    // One display needs no picture of itself.
    expect(
      screen.queryByRole('list', { name: 'Connected displays' }),
    ).toBeNull()
    expect(screen.queryByText(/1920 x 1080 px/)).toBeNull()
  })

  it('resets appearance and window placement to accessible factory defaults', async () => {
    renderWithProvider(<SettingsScreen />)
    const dark = await screen.findByRole('radio', { name: 'Dark' })
    const highContrast = screen.getByRole('switch', { name: 'High contrast' })
    const placement = screen.getByRole('combobox', {
      name: 'Startup window placement',
    })
    // The mock host has one display, so Primary display stands for it.
    const display = await screen.findByRole<HTMLOptionElement>('option', {
      name: 'Primary display',
    })
    expect(screen.queryByRole('option', { name: 'Display 1' })).toBeNull()

    fireEvent.click(dark)
    fireEvent.click(highContrast)
    fireEvent.change(placement, { target: { value: display.value } })
    await waitFor(() => {
      expect(dark).toHaveAttribute('aria-checked', 'true')
      expect(highContrast).toHaveAttribute('aria-checked', 'true')
      expect(placement).toHaveValue(display.value)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Reset preferences' }))
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      expect(highContrast).toHaveAttribute('aria-checked', 'false')
      expect(placement).toHaveValue('remember')
    })
  })
})
