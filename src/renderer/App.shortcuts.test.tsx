/**
 * Tests for the global keyboard-shortcut guards in the application shell.
 *
 * Cover the two shortcuts that stay live while the operator types, the
 * suppression of every other shortcut inside an editable field, the modifier
 * guard that leaves browser and window chords alone, and the routes that own
 * their own local keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import App from './App'
import { createMockApi, makeMockCohort } from './ipc/mock'
import { DEFAULT_PROJECT_CONFIG } from '../shared/project-schema'
import type { ProjectConfig } from '../shared/project-schema'
import type { ProjectOpenResult, SupraspinaApi } from '../shared/contract'
import type { Subject } from '../shared/types'

const LOADED_PROJECT: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
  project: { ...DEFAULT_PROJECT_CONFIG.project, name: 'Loaded study' },
  paths: {
    ...DEFAULT_PROJECT_CONFIG.paths,
    projectRoot: '/data/projects/demo',
  },
}

const LOADED_PROJECT_RESULT: ProjectOpenResult = {
  project: {
    projectId: 'loaded-study',
    root: '/data/projects/demo',
    configPath: '/data/projects/demo/supraspina.project.json',
    epoch: 1,
  },
  cfg: LOADED_PROJECT,
  configSha256: '0'.repeat(64),
}

/** A runnable cohort, so the run verbs have work to confirm. */
function runnableCohort(): Subject[] {
  return makeMockCohort(2, 733).map((subject) => ({
    ...subject,
    qc: 'pass' as const,
    analysisEligible: true,
    unavailableReason: null,
  }))
}

/** Install a mock bridge that opens a rooted project through the toolbar. */
function installLoadableBridge(api: SupraspinaApi): SupraspinaApi {
  const attachProject = api.project.open
  api.project.open = async ({ path, epoch }) => {
    const host = await api.host.getState()
    if (!host.sidecar.projectAttached) {
      await attachProject({ path, epoch })
    }
    return {
      ...LOADED_PROJECT_RESULT,
      project: { ...LOADED_PROJECT_RESULT.project, epoch },
    }
  }
  api.fs.chooseFile = async () => '/data/projects/demo/supraspina.project.json'
  ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
  return api
}

/** Render the shell with a loaded project, revealing the gated navigation. */
async function renderWithProject(
  api: SupraspinaApi = createMockApi(),
): Promise<SupraspinaApi> {
  const installed = installLoadableBridge(api)
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Open a saved project' }))
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Open project file...' }),
  )
  await waitFor(() =>
    expect(
      screen.getByLabelText('Current project: Loaded study'),
    ).toBeInTheDocument(),
  )
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  })
  return installed
}

/** Add a focused editable field outside any dialog. */
function editableField(): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  document.body.append(input)
  input.focus()
  return input
}

/** Read the rail button that marks the current route. */
function currentRoute(): string {
  const rail = screen.getByRole('navigation', { name: 'Primary' })
  const current = within(rail)
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-current') === 'page')
  return current?.textContent ?? 'none'
}

beforeEach(() => {
  // Complete first-run setup before testing the shell chrome.
  localStorage.setItem('supraspinaFirstRunDone', '1')
})

afterEach(() => {
  delete (globalThis as { supraspina?: SupraspinaApi }).supraspina
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('global keyboard shortcuts', () => {
  it('closes the command palette on Escape typed inside its query field', async () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const dialog = screen.getByRole('dialog', { name: 'Command palette' })
    const query = within(dialog).getByRole('combobox')

    fireEvent.keyDown(query, { key: 'Escape' })

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Command palette' }),
      ).not.toBeInTheDocument(),
    )
  })

  it('toggles the command palette on Ctrl+K typed inside its query field', async () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const query = within(
      screen.getByRole('dialog', { name: 'Command palette' }),
    ).getByRole('combobox')

    fireEvent.keyDown(query, { key: 'K', ctrlKey: true })

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Command palette' }),
      ).not.toBeInTheDocument(),
    )
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(
      screen.getByRole('dialog', { name: 'Command palette' }),
    ).toBeInTheDocument()
  })

  it('ignores run and route keys typed into an editable field', async () => {
    await renderWithProject(createMockApi(runnableCohort()))
    const before = currentRoute()
    const input = editableField()

    fireEvent.keyDown(input, { key: 'r' })
    fireEvent.keyDown(input, { key: 'R' })
    fireEvent.keyDown(input, { key: 'c' })
    fireEvent.keyDown(input, { key: '5' })
    fireEvent.keyDown(input, { key: '/' })

    expect(
      screen.queryByRole('dialog', {
        name: 'Review the run plan?',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('dialog', { name: 'Command palette' }),
    ).not.toBeInTheDocument()
    expect(currentRoute()).toBe(before)
    input.remove()
  })

  it('leaves modified chords to the browser and the window manager', async () => {
    await renderWithProject(createMockApi(runnableCohort()))
    const before = currentRoute()

    fireEvent.keyDown(window, { key: 'r', altKey: true })
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true })
    fireEvent.keyDown(window, { key: '5', altKey: true })
    fireEvent.keyDown(window, { key: '5', ctrlKey: true })
    fireEvent.keyDown(window, { key: '/', metaKey: true })

    expect(
      screen.queryByRole('dialog', {
        name: 'Review the run plan?',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('dialog', { name: 'Command palette' }),
    ).not.toBeInTheDocument()
    expect(currentRoute()).toBe(before)
  })

  it('lets the Runs screen own the run keys without a second global dispatch', async () => {
    await renderWithProject(createMockApi(runnableCohort()))

    fireEvent.keyDown(window, { key: '2' })
    await waitFor(() => expect(currentRoute()).toBe('Runs'))

    fireEvent.keyDown(window, { key: 'r' })

    // The Runs screen answers with its own confirmation, and the shell's
    // confirmation, which has the same title, never opens behind it.
    expect(
      await screen.findByRole('heading', {
        name: 'Review the run plan?',
      }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('lets the QC screen own the digit keys and keeps the run keys global', async () => {
    await renderWithProject(createMockApi(runnableCohort()))

    fireEvent.keyDown(window, { key: '4' })
    await waitFor(() => expect(currentRoute()).toBe('QC review'))

    fireEvent.keyDown(window, { key: '5' })
    expect(currentRoute()).toBe('QC review')

    // QC claims only the digits, so the shell still owns the run verbs.
    fireEvent.keyDown(window, { key: 'r' })
    expect(
      await screen.findByRole('dialog', {
        name: 'Review the run plan?',
      }),
    ).toBeInTheDocument()
  })
})
