/**
 * Tests the shell-owned environment recheck.
 *
 * The shell re-issues `env.check` whenever the project configuration changes,
 * so Diagnostics, the stage blockers and the top-bar tool chips never describe
 * a configuration the operator has already replaced.
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
import { createMockApi } from './ipc/mock'
import { DEFAULT_PROJECT_CONFIG } from '../shared/project-schema'
import type { ProjectConfig } from '../shared/project-schema'
import type { ProjectOpenResult, SupraspinaApi } from '../shared/contract'

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
async function renderWithProject(api: SupraspinaApi): Promise<void> {
  installLoadableBridge(api)
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

describe('shell environment recheck', () => {
  it('re-issues the environment check with the revised configuration', async () => {
    const api = createMockApi()
    const check = vi.spyOn(api.env, 'check')
    await renderWithProject(api)

    await waitFor(() => expect(check).toHaveBeenCalled())
    const first = check.mock.calls.length
    const openedWith = check.mock.calls[first - 1]?.[0] as {
      cfg?: ProjectConfig
    }
    expect(openedWith.cfg?.steps.deface.enabled).toBe(false)

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    fireEvent.click(within(rail).getByRole('button', { name: 'Pipeline' }))
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Optional defacing stage' }),
    )

    await waitFor(() => expect(check.mock.calls.length).toBeGreaterThan(first))
    const revised = check.mock.calls[check.mock.calls.length - 1]?.[0] as {
      cfg?: ProjectConfig
    }
    expect(revised.cfg?.steps.deface.enabled).toBe(true)
  })
})
