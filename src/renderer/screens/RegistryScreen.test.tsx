// @vitest-environment jsdom

import { useLayoutEffect, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { RegistryInput, RegistryRecord } from '../../shared/contract'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { Subject } from '../../shared/types'
import { createMockApi, makeMockCohort } from '../ipc/mock'
import { AppProvider, useApp } from '../state/context'
import { RegistryScreen } from './RegistryScreen'

const PROJECT = {
  projectId: 'registry-project',
  root: '/projects/registry',
  configPath: '/projects/registry/supraspina.project.json',
  epoch: 1,
}
const PROJECT_CONFIG = {
  ...DEFAULT_PROJECT_CONFIG,
  paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: PROJECT.root },
}

function Bootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  useLayoutEffect(() => {
    if (!app.projectRef) {
      app.markProjectCreated({
        project: PROJECT,
        cfg: PROJECT_CONFIG,
        configSha256: '0'.repeat(64),
      })
    }
  }, [app])
  return children
}

function renderScreen(
  api = createMockApi(),
  refresh?: () => void,
): ReturnType<typeof render> {
  window.supraspina = api
  return render(
    <AppProvider>
      <Bootstrap>
        <RegistryScreen {...(refresh ? { refresh } : {})} />
      </Bootstrap>
    </AppProvider>,
  )
}

function record(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  return {
    subjectId: 'sub-001',
    age: 41,
    sex: 'F',
    sourceCohortLabel: 'CTRL',
    cohortRole: 'healthy',
    ais: null,
    tSinceSci: null,
    t1Availability: 'available',
    runnable: true,
    unavailableReason: null,
    qc: null,
    qcNote: '',
    qcTags: [],
    revision: 1,
    updatedAt: '2026-07-22T12:00:00.000Z',
    site: null,
    ...overrides,
  }
}

function subject(id: string, overrides: Partial<Subject> = {}): Subject {
  return {
    id,
    age: 0,
    sex: 'O',
    cohort: 'UNKNOWN',
    ais: null,
    tSinceSci: null,
    cells: [],
    qc: null,
    notes: '',
    registered: true,
    analysisEligible: true,
    t1Availability: 'available',
    ...overrides,
  }
}

/** Store one record in the stateful mock, exactly as a prior save would. */
async function storeRecord(
  api: ReturnType<typeof createMockApi>,
  overrides: Partial<RegistryInput> = {},
): Promise<void> {
  await api.registry.upsert({
    project: PROJECT,
    record: {
      subjectId: 'sub-001',
      age: 41,
      sex: 'F',
      sourceCohortLabel: 'CTRL',
      ais: null,
      tSinceSci: null,
      ...overrides,
    },
  })
}

const IMPORT_HEADER = 'subjectId,age,sex,sourceCohortLabel,ais,tSinceSci'

afterEach(() => {
  vi.restoreAllMocks()
  delete window.supraspina
})

describe('RegistryScreen durable registry', () => {
  it('loads project-scoped durable records instead of seeding discovery rows', async () => {
    const api = createMockApi()
    const list = vi.spyOn(api.registry, 'list').mockResolvedValue([record()])
    const discover = vi.spyOn(api.subjects, 'discover')
    renderScreen(api)

    expect(await screen.findByText('sub-001')).toBeInTheDocument()
    expect(list).toHaveBeenCalledWith({ project: PROJECT })

    expect(discover).toHaveBeenCalledWith({
      project: PROJECT,
      cfg: PROJECT_CONFIG,
      configRevision: 0,
    })
    // The header is the title alone, named as in the navigation.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Registry' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Registry records persist in the active project/i),
    ).toBeNull()
  })

  it('persists a four-digit BIDS subject label and decimal age through registry.upsert', async () => {
    const api = createMockApi()
    const upsert = vi.spyOn(api.registry, 'upsert')
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)
    // Name the form rather than its side: a narrow window stacks it above.
    expect(
      screen.getByText('Add one with the New subject form.'),
    ).toBeInTheDocument()
    // The form names its fields and leaves the explanations to info tips.
    expect(screen.getByText('New subject')).toBeInTheDocument()
    expect(
      screen.getByRole('radiogroup', { name: 'Cohort' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/backend resolves this source label/i)).toBeNull()
    expect(screen.queryByText(/A BIDS subject label: letters/i)).toBeNull()
    // The placeholder suggests a discovered subject still to register.
    expect(
      screen.getByLabelText('Subject ID').getAttribute('placeholder'),
    ).toMatch(/^sub-/)
    expect(screen.getByLabelText('Subject ID')).not.toHaveAttribute(
      'placeholder',
      'sub-0001',
    )

    fireEvent.change(screen.getByLabelText('Subject ID'), {
      target: { value: 'sub-0004' },
    })
    fireEvent.change(screen.getByLabelText('Age (years, optional)'), {
      target: { value: '54.7' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'M' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Control' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save subject' }))

    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
    expect(upsert.mock.calls[0]?.[0]).toEqual({
      project: PROJECT,
      record: {
        subjectId: 'sub-0004',
        age: 54.7,
        sex: 'M',
        sourceCohortLabel: 'CTRL',
        ais: null,
        tSinceSci: null,
      },
    })
    const table = await screen.findByRole('table', {
      name: /recently registered subjects/i,
    })
    expect(within(table).getByText('Unavailable')).toBeInTheDocument()
    expect(
      within(table).getByText(/Add a configured T1 input/i),
    ).toBeInTheDocument()
    expect(
      within(table).getByRole('button', {
        name: /Open sub-0004 in QC review/i,
      }),
    ).toBeDisabled()
  })

  it('Keeps an ambiguous source label out of the control cohort.', async () => {
    const api = createMockApi()
    vi.spyOn(api.registry, 'list').mockResolvedValue([
      record({
        subjectId: 'sub-777',
        sourceCohortLabel: 'SCI-old',
        cohortRole: 'ambiguous',
        t1Availability: 'ambiguous',
        runnable: false,
        unavailableReason: 'Resolve the ambiguous cohort alias and T1 input.',
      }),
    ])
    renderScreen(api)

    expect(await screen.findByText('SCI-old')).toBeInTheDocument()
    expect(screen.getAllByText('Ambiguous').length).toBeGreaterThan(0)
    expect(
      within(
        screen.getByRole('table', { name: 'Recently registered subjects' }),
      ).queryByText('Control'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/Resolve the ambiguous cohort alias and T1 input\./i),
    ).toBeInTheDocument()
  })

  it('states the recorded unavailable reasons as facts', async () => {
    // RegistryStore.list joins one sentence per cause, each an order, and the
    // records enter the plan's registry digest, so the sidecar keeps the text
    // and the screen restates each exact sentence.
    const api = createMockApi()
    vi.spyOn(api.registry, 'list').mockResolvedValue([
      record({
        subjectId: 'sub-010',
        t1Availability: 'missing',
        runnable: false,
        unavailableReason:
          'Resolve the T1 input state: missing. Remove the subject because it is excluded by project configuration.',
        updatedAt: '2026-07-22T12:03:00.000Z',
      }),
      record({
        subjectId: 'sub-011',
        runnable: false,
        qc: 'fail',
        unavailableReason:
          'Add the subject because it is not in the configured include set. Resolve QC Fail before including the subject in analysis.',
        updatedAt: '2026-07-22T12:02:00.000Z',
      }),
      record({
        subjectId: 'sub-012',
        t1Availability: 'ambiguous',
        runnable: false,
        unavailableReason: 'Resolve the T1 input state: ambiguous.',
        updatedAt: '2026-07-22T12:01:00.000Z',
      }),
    ])
    renderScreen(api)

    const table = await screen.findByRole('table', {
      name: 'Recently registered subjects',
    })
    const facts = {
      'sub-010':
        'No readable T1 input matches the configured pattern. Excluded by project configuration.',
      'sub-011':
        'Not in the configured include set. Excluded from analysis: the QC verdict is Fail.',
      'sub-012': 'More than one T1 input matches the configured pattern.',
    }
    for (const [subjectId, fact] of Object.entries(facts)) {
      expect(await within(table).findByText(fact)).toBeInTheDocument()
      expect(
        within(table).getByRole('button', {
          name: `Open ${subjectId} in QC review`,
        }),
      ).toHaveAttribute('title', fact)
    }
    expect(
      within(table).queryByText(/Resolve|Remove the subject|Add the subject/),
    ).toBeNull()
    // IDs stay mono (the ID line inherits its cell's face, which also holds
    // the site line); word cells such as the T1 availability are prose.
    expect(
      within(table).getByText('sub-010').closest('td')?.style.fontFamily,
    ).toContain('WebCM Mono 10')
    expect(
      within(table).getAllByText('Missing')[0]?.style.fontFamily,
    ).toContain('WebCM Sans 10')
  })

  it('states a missing T1 without claiming that no input matches', async () => {
    // `resolve_t1` also records "missing" when the one input that matches the
    // pattern cannot be read, so the fact names a readable input.
    const api = createMockApi()
    vi.spyOn(api.registry, 'list').mockResolvedValue([
      record({
        subjectId: 'sub-013',
        t1Availability: 'missing',
        runnable: false,
        unavailableReason: 'Resolve the T1 input state: missing.',
      }),
    ])
    renderScreen(api)

    const table = await screen.findByRole('table', {
      name: 'Recently registered subjects',
    })
    const fact = 'No readable T1 input matches the configured pattern.'
    expect(await within(table).findByText(fact)).toBeInTheDocument()
    expect(
      within(table).getByRole('button', { name: 'Open sub-013 in QC review' }),
    ).toHaveAttribute('title', fact)
    expect(
      within(table).queryByText('No T1 input matches the configured pattern.'),
    ).toBeNull()
  })

  it('keeps a failed upsert visible and does not invent a local row', async () => {
    const api = createMockApi()
    vi.spyOn(api.registry, 'upsert').mockRejectedValue(
      new Error('revision conflict'),
    )
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)

    fireEvent.change(screen.getByLabelText('Subject ID'), {
      target: { value: 'sub-901' },
    })
    fireEvent.change(screen.getByLabelText('Age (years, optional)'), {
      target: { value: '45' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'M' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Control' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save subject' }))

    expect(await screen.findByText('revision conflict')).toBeInTheDocument()
    expect(screen.queryByText('sub-901')).not.toBeInTheDocument()
  })

  it('rejects unsafe subject IDs and out-of-range ages', async () => {
    const api = createMockApi()
    const originalDiscover = api.subjects.discover
    const originalToolStatus = api.env.toolStatus
    let releaseBootstrap!: () => void
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve
    })
    const discover = vi
      .spyOn(api.subjects, 'discover')
      .mockImplementation(async (request) => {
        await bootstrapGate
        return originalDiscover(request)
      })
    const toolStatus = vi
      .spyOn(api.env, 'toolStatus')
      .mockImplementation(async (request) => {
        await bootstrapGate
        return originalToolStatus(request)
      })
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)
    await waitFor(() => {
      expect(discover).toHaveBeenCalledTimes(1)
      expect(toolStatus).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      releaseBootstrap()
      await Promise.all([
        discover.mock.results[0]?.value,
        toolStatus.mock.results[0]?.value,
      ])
    })

    fireEvent.change(screen.getByLabelText('Subject ID'), {
      target: { value: 'sub-01/unsafe' },
    })
    expect(screen.getByText(/Use a BIDS subject label/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Age (years, optional)'), {
      target: { value: '130.1' },
    })
    expect(
      screen.getByText(/Enter an age from 0 to 130 years/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save subject' })).toBeDisabled()
  })

  it('persists unavailable optional SCI metadata as null', async () => {
    const api = createMockApi()
    const upsert = vi.spyOn(api.registry, 'upsert')
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)

    fireEvent.change(screen.getByLabelText('Subject ID'), {
      target: { value: 'sub-0012' },
    })
    fireEvent.change(screen.getByLabelText('Age (years, optional)'), {
      target: { value: '27' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'M' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Pain' }))

    expect(screen.getByRole('radio', { name: 'Unknown' })).toBeChecked()
    // The field explanations sit in info tips, not under the fields.
    expect(
      screen.getByRole('button', { name: 'About AIS grade (optional)' }),
    ).toHaveAccessibleDescription(/Unknown means the grade is unavailable\.$/)
    expect(
      screen.getByRole('button', { name: 'About Years since SCI (optional)' }),
    ).toHaveAccessibleDescription(/Blank means the value is unavailable\.$/)
    expect(screen.getByLabelText('Years since SCI (optional)')).toHaveAttribute(
      'placeholder',
      '3.5',
    )
    expect(screen.getByRole('button', { name: 'Save subject' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Save subject' }))

    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
    expect(upsert.mock.calls[0]?.[0]).toEqual({
      project: PROJECT,
      record: {
        subjectId: 'sub-0012',
        age: 27,
        sex: 'M',
        sourceCohortLabel: 'SCI_P',
        ais: null,
        tSinceSci: null,
      },
    })
  })

  it('registers a subject whose age at scan is not recorded', async () => {
    const api = createMockApi()
    const upsert = vi.spyOn(api.registry, 'upsert')
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)

    fireEvent.change(screen.getByLabelText('Subject ID'), {
      target: { value: 'sub-0031' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'F' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Control' }))

    // The label says the age may stay empty; no sentence repeats it.
    expect(screen.getByLabelText('Age (years, optional)')).toHaveValue('')
    expect(screen.queryByText(/Empty when the age at scan/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save subject' }))

    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
    expect(upsert.mock.calls[0]?.[0]).toEqual({
      project: PROJECT,
      record: {
        subjectId: 'sub-0031',
        age: null,
        sex: 'F',
        sourceCohortLabel: 'CTRL',
        ais: null,
        tSinceSci: null,
      },
    })
    const table = await screen.findByRole('table', {
      name: /recently registered subjects/i,
    })
    expect(within(table).getByText('-, F')).toBeInTheDocument()
  })

  it('requires a chosen sex before the record can be saved', async () => {
    const api = createMockApi()
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)

    fireEvent.change(screen.getByLabelText('Subject ID'), {
      target: { value: 'sub-0042' },
    })

    expect(
      screen.getByRole('button', { name: 'About Sex' }),
    ).toHaveAccessibleDescription(
      'The recorded sex; O means it is not recorded as M or F.',
    )
    for (const name of ['M', 'F', 'O']) {
      expect(screen.getByRole('radio', { name })).not.toBeChecked()
    }
    expect(screen.getByRole('button', { name: 'Save subject' })).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: 'O' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Control' }))

    expect(screen.getByRole('button', { name: 'Save subject' })).toBeEnabled()
  })
  it('starts with no source cohort label and requires one to save', async () => {
    // A preselected Control would let a subject be saved under a role nobody
    // chose.
    const api = createMockApi()
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)

    fireEvent.change(screen.getByLabelText('Subject ID'), {
      target: { value: 'sub-0042' },
    })
    fireEvent.change(screen.getByLabelText('Age (years, optional)'), {
      target: { value: '40' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'F' }))

    for (const name of ['Control', 'No pain', 'Pain']) {
      expect(screen.getByRole('radio', { name })).not.toBeChecked()
    }
    expect(screen.getByRole('button', { name: 'Save subject' })).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: 'Pain' }))

    expect(screen.getByRole('button', { name: 'Save subject' })).toBeEnabled()
  })
})

/** Read the summary row as label and count pairs, in order. */
function summaryCounts(): [string, string][] {
  const row = screen.getByText('Registered').closest('dl')!
  return within(row)
    .getAllByRole('term')
    .map((term) => [
      term.textContent ?? '',
      term.nextElementSibling?.textContent ?? '',
    ])
}

describe('RegistryScreen summary', () => {
  it('states the counts in one row and hides empty cohorts', async () => {
    const api = createMockApi()
    vi.spyOn(api.registry, 'list').mockResolvedValue([
      record({ subjectId: 'sub-001' }),
      record({ subjectId: 'sub-002', runnable: false }),
      record({
        subjectId: 'sub-101',
        sourceCohortLabel: 'SCI_P',
        cohortRole: 'sci-neuropathic-pain',
        ais: 'C',
        tSinceSci: 3.5,
      }),
    ])
    renderScreen(api)
    await screen.findByText('sub-101')

    await waitFor(() =>
      expect(summaryCounts()).toEqual([
        ['Registered', '3'],
        ['Runnable', '2'],
        ['Control', '2'],
        ['SCI, pain', '1'],
      ]),
    )
    const table = screen.getByRole('table', {
      name: 'Recently registered subjects',
    })
    // A clinical cell joins the values it has and shows one dim en dash for
    // none.
    expect(within(table).getByText('C, 3.5 y')).toBeInTheDocument()
    expect(within(table).getAllByText('\u2013')).toHaveLength(2)
    expect(screen.getByText('Recently registered')).toBeInTheDocument()
    expect(screen.queryByText(/^latest /)).toBeNull()
  })

  it('keeps the registered and runnable counts at zero', async () => {
    const api = createMockApi()
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)
    await waitFor(() =>
      expect(summaryCounts()).toEqual([
        ['Registered', '0'],
        ['Runnable', '0'],
      ]),
    )
  })

  it('shows an ambiguous count only above zero, as a warning', async () => {
    const api = createMockApi()
    vi.spyOn(api.registry, 'list').mockResolvedValue([
      record({ subjectId: 'sub-001' }),
      record({
        subjectId: 'sub-777',
        sourceCohortLabel: 'SCI-old',
        cohortRole: 'ambiguous',
        runnable: false,
      }),
    ])
    renderScreen(api)
    await screen.findByText('sub-777')

    await waitFor(() =>
      expect(summaryCounts()).toEqual([
        ['Registered', '2'],
        ['Runnable', '1'],
        ['Control', '1'],
        ['Ambiguous', '1'],
      ]),
    )
    const row = screen.getByText('Registered').closest('dl')!
    const ambiguous = within(row).getByText('Ambiguous')
    // The glyph carries the warning beside the color.
    expect(ambiguous.querySelector('svg')).not.toBeNull()
    expect(within(row).getByText('Control').querySelector('svg')).toBeNull()
  })
})

describe('RegistryScreen record editing', () => {
  it('opens a populated edit workflow and keeps the subject ID immutable', async () => {
    const api = createMockApi()
    await storeRecord(api, {
      subjectId: 'sub-004',
      sourceCohortLabel: 'SCI_P',
      ais: 'C',
      tSinceSci: 3.5,
    })
    renderScreen(api)
    const table = await screen.findByRole('table', {
      name: 'Recently registered subjects',
    })

    fireEvent.click(within(table).getByRole('button', { name: 'Edit sub-004' }))

    expect(screen.getByText('Edit subject')).toBeInTheDocument()
    const id = screen.getByLabelText('Subject ID')
    expect(id).toHaveValue('sub-004')
    expect(id).toHaveAttribute('readonly')
    const age = screen.getByLabelText('Age (years, optional)')
    expect(age).toHaveValue('41')
    expect(age).toHaveFocus()
    expect(screen.getByRole('radio', { name: 'F' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Pain' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'C' })).toBeChecked()
    expect(screen.getByLabelText('Years since SCI (optional)')).toHaveValue(
      '3.5',
    )
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Cancel edit' }),
    ).toBeInTheDocument()
  })

  it('lists a fractional age in whole years and edits the stored value', async () => {
    // A CSV import can store 54.67; the list reads it in whole years, as it
    // does every other subject.
    const api = createMockApi()
    await storeRecord(api, { age: 54.67 })
    renderScreen(api)
    const table = await screen.findByRole('table', {
      name: 'Recently registered subjects',
    })
    expect(within(table).getByText('54, F')).toBeInTheDocument()
    expect(within(table).queryByText(/54\.67/)).toBeNull()

    fireEvent.click(within(table).getByRole('button', { name: 'Edit sub-001' }))
    expect(screen.getByLabelText('Age (years, optional)')).toHaveValue('54.67')
  })

  it('saves an edit against the stored revision and shows the new values', async () => {
    const api = createMockApi()
    await storeRecord(api)
    const upsert = vi.spyOn(api.registry, 'upsert')
    const refresh = vi.fn()
    renderScreen(api, refresh)
    const table = await screen.findByRole('table', {
      name: 'Recently registered subjects',
    })

    fireEvent.click(within(table).getByRole('button', { name: 'Edit sub-001' }))
    fireEvent.change(screen.getByLabelText('Age (years, optional)'), {
      target: { value: '43' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
    // The stored QC annotations stay a backend concern: the payload carries
    // the operator-entered fields and the revision the draft started from.
    expect(upsert.mock.calls[0]?.[0]).toEqual({
      project: PROJECT,
      record: {
        subjectId: 'sub-001',
        age: 43,
        sex: 'F',
        sourceCohortLabel: 'CTRL',
        ais: null,
        tSinceSci: null,
        site: null,
      },
      expectedRevision: 1,
    })
    expect(await screen.findByText('New subject')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(table).getByText('43, F')).toBeInTheDocument(),
    )
    expect(refresh).toHaveBeenCalled()
  })

  it('removes a record after confirmation against its reviewed revision', async () => {
    const api = createMockApi()
    await storeRecord(api)
    const remove = vi.spyOn(api.registry, 'remove')
    renderScreen(api)
    const table = await screen.findByRole('table', {
      name: 'Recently registered subjects',
    })

    fireEvent.click(within(table).getByRole('button', { name: 'Edit sub-001' }))
    expect(screen.getByText('Edit subject')).toBeInTheDocument()
    // Remove is destructive, so it takes the fail-color outline.
    const removeButton = within(table).getByRole('button', {
      name: 'Remove sub-001',
    })
    expect(removeButton.style.borderColor).not.toBe('transparent')
    expect(removeButton.style.borderColor).not.toBe('')
    fireEvent.click(removeButton)
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove registry record',
    })
    expect(within(dialog).getByText(/QC review evidence/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(
      within(table).getByRole('button', { name: 'Remove sub-001' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove record' }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    expect(remove.mock.calls[0]?.[0]).toEqual({
      project: PROJECT,
      subjectId: 'sub-001',
      expectedRevision: 1,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(
        screen.queryByRole('table', { name: 'Recently registered subjects' }),
      ).toBeNull(),
    )
    expect(screen.getByText('New subject')).toBeInTheDocument()
    expect(await api.registry.list({ project: PROJECT })).toEqual([])
  })

  it('keeps the removal dialog open with the rejection reason', async () => {
    const api = createMockApi()
    await storeRecord(api)
    vi.spyOn(api.registry, 'remove').mockRejectedValue(
      new Error(
        'Resolve the registry revision conflict by refreshing the record.',
      ),
    )
    renderScreen(api)
    const table = await screen.findByRole('table', {
      name: 'Recently registered subjects',
    })
    fireEvent.click(
      within(table).getByRole('button', { name: 'Remove sub-001' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove record' }))
    expect(
      await screen.findByText(/Resolve the registry revision conflict/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('dialog', { name: 'Remove registry record' }),
    ).toBeInTheDocument()
    expect(within(table).getByText('sub-001')).toBeInTheDocument()
  })

  it('keeps the draft on a stale revision and reapplies it over the saved values', async () => {
    const api = createMockApi()
    await storeRecord(api)
    renderScreen(api)
    const table = await screen.findByRole('table', {
      name: 'Recently registered subjects',
    })

    fireEvent.click(within(table).getByRole('button', { name: 'Edit sub-001' }))
    fireEvent.change(screen.getByLabelText('Age (years, optional)'), {
      target: { value: '43' },
    })
    await act(async () => {
      await storeRecord(api, { age: 50 })
    })
    const upsert = vi.spyOn(api.registry, 'upsert')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Could not save the changed registry record.',
    )
    // The conflict names its own recovery, because retrying the same write
    // over the replaced record cannot succeed.
    expect(alert).toHaveTextContent(
      'Load saved values because another writer changed this record.',
    )
    expect(alert).not.toHaveTextContent(/Retry the scientific runtime request/)
    expect(screen.getByText('Edit subject')).toBeInTheDocument()
    expect(screen.getByLabelText('Age (years, optional)')).toHaveValue('43')

    fireEvent.click(screen.getByRole('button', { name: 'Load saved values' }))

    const saved = await screen.findByRole('group', {
      name: 'Saved registry values',
    })
    expect(within(saved).getByText('50')).toBeInTheDocument()
    expect(within(saved).getByText('2')).toBeInTheDocument()
    expect(screen.getByLabelText('Age (years, optional)')).toHaveValue('43')

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(2))
    expect(upsert.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 2 })
    expect(await screen.findByText('New subject')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(table).getByText('43, F')).toBeInTheDocument(),
    )
  })

  it('changes nothing on cancel and keeps the duplicate check on creation', async () => {
    const api = createMockApi()
    await storeRecord(api)
    const upsert = vi.spyOn(api.registry, 'upsert')
    renderScreen(api)
    const table = await screen.findByRole('table', {
      name: 'Recently registered subjects',
    })

    fireEvent.click(within(table).getByRole('button', { name: 'Edit sub-001' }))
    fireEvent.change(screen.getByLabelText('Age (years, optional)'), {
      target: { value: '43' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))

    expect(upsert).not.toHaveBeenCalled()
    expect(screen.getByText('New subject')).toBeInTheDocument()
    expect(within(table).getByText('41, F')).toBeInTheDocument()
    const id = screen.getByLabelText('Subject ID')
    expect(id).toHaveValue('')
    expect(id).not.toHaveAttribute('readonly')

    fireEvent.change(id, { target: { value: 'sub-001' } })
    expect(
      screen.getByText('Use a subject that is not already registered.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save subject' })).toBeDisabled()
  })

  it('requires a listed source cohort label when the stored label is not one', async () => {
    const api = createMockApi()
    await storeRecord(api, {
      subjectId: 'sub-777',
      sourceCohortLabel: 'SCI-old',
      ais: 'B',
      tSinceSci: 2,
    })
    renderScreen(api)
    const table = await screen.findByRole('table', {
      name: 'Recently registered subjects',
    })

    fireEvent.click(within(table).getByRole('button', { name: 'Edit sub-777' }))

    expect(screen.getByRole('radio', { name: 'Control' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'Pain' })).not.toBeChecked()
    expect(
      screen.getByText(/The stored label SCI-old is not one of these options/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: 'Pain' }))

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
    expect(screen.getByLabelText('Years since SCI (optional)')).toHaveValue('2')
    expect(screen.getByRole('radio', { name: 'B' })).toBeChecked()
  })
})

describe('RegistryScreen discovered-subject enrollment', () => {
  it('lists discovered unregistered subjects and prefills the form on Register', async () => {
    const api = createMockApi()
    vi.spyOn(api.registry, 'list').mockResolvedValue([record()])
    vi.spyOn(api.subjects, 'discover').mockResolvedValue([
      subject('sub-001'),
      subject('sub-777', { t1Availability: 'missing' }),
    ])
    renderScreen(api)

    const list = await screen.findByRole('list', {
      name: 'Discovered subjects without registry records',
    })
    expect(within(list).getByText('sub-777')).toBeInTheDocument()
    expect(within(list).queryByText('sub-001')).not.toBeInTheDocument()
    expect(within(list).getByText('T1 missing')).toBeInTheDocument()
    // The status word reads at the 11 px secondary size.
    expect(within(list).getByText('T1 missing')).toHaveStyle({
      fontSize: '11px',
    })
    expect(screen.getByText('Not registered')).toBeInTheDocument()
    expect(screen.queryByText('Discovered, not registered')).toBeNull()

    fireEvent.click(
      within(list).getByRole('button', { name: 'Register sub-777' }),
    )
    const input = screen.getByLabelText('Subject ID')
    expect(input).toHaveValue('sub-777')
    expect(input).toHaveFocus()
  })

  it('reports full enrollment instead of an empty discovered list', async () => {
    const api = createMockApi()
    vi.spyOn(api.registry, 'list').mockResolvedValue([record()])
    vi.spyOn(api.subjects, 'discover').mockResolvedValue([subject('sub-001')])
    renderScreen(api)

    expect(
      await screen.findByText(/Every discovered subject is registered/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('list', {
        name: 'Discovered subjects without registry records',
      }),
    ).not.toBeInTheDocument()
  })
})

describe('RegistryScreen CSV import', () => {
  it('states the deterministic policies before any write and imports the chosen file', async () => {
    const api = createMockApi()
    const choose = vi.spyOn(api.registry, 'chooseImportCsv').mockResolvedValue({
      name: 'cohort.csv',
      displayPath: '/data/cohort.csv',
      text: `${IMPORT_HEADER}\nsub-0009,41,F,CTRL,,\n`,
    })
    const importCsv = vi.spyOn(api.registry, 'importCsv')
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)

    expect(
      screen.getByRole('radiogroup', { name: 'Registered subjects' }),
    ).toBeInTheDocument()
    // One standing sentence; the full policy sits in the card's info tip and
    // each mode's effect in its option title.
    expect(
      screen.getByText('Any error rejects the whole file.'),
    ).toBeInTheDocument()
    const about = screen.getByRole('button', { name: 'About CSV import' })
    expect(about).toHaveAccessibleDescription(/all-or-nothing/i)
    expect(about).toHaveAccessibleDescription(
      /rows that repeat a subject ID are rejected/i,
    )
    expect(about).toHaveAccessibleDescription(
      /subjectId,age,sex,sourceCohortLabel,ais,tSinceSci,site/,
    )
    expect(screen.getByRole('radio', { name: 'Skip' })).toHaveAttribute(
      'title',
      'Rows whose subject is already registered are skipped and reported.',
    )
    expect(screen.getByRole('radio', { name: 'Update' })).toHaveAttribute(
      'title',
      expect.stringMatching(
        /^Rows whose subject is already registered replace/,
      ),
    )
    expect(screen.queryByText(/are skipped and reported/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Choose CSV file' }))
    expect(await screen.findByText('cohort.csv')).toBeInTheDocument()
    expect(choose).toHaveBeenCalledWith({ project: PROJECT })

    fireEvent.click(screen.getByRole('radio', { name: 'Update' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(importCsv).toHaveBeenCalledTimes(1))
    expect(importCsv.mock.calls[0]?.[0]).toEqual({
      project: PROJECT,
      csvText: `${IMPORT_HEADER}\nsub-0009,41,F,CTRL,,\n`,
      onExisting: 'update',
    })
    expect(
      await screen.findByText(
        'Import complete: 1 added, 0 replaced, 0 skipped.',
      ),
    ).toBeInTheDocument()
    const table = await screen.findByRole('table', {
      name: /recently registered subjects/i,
    })
    expect(within(table).getByText('sub-0009')).toBeInTheDocument()
  })

  it('reports per-row errors and warnings with row numbers on rejection', async () => {
    const api = createMockApi()
    vi.spyOn(api.registry, 'chooseImportCsv').mockResolvedValue({
      name: 'bad.csv',
      displayPath: '/data/bad.csv',
      text: 'not,a,valid,header\n',
    })
    vi.spyOn(api.registry, 'importCsv').mockResolvedValue({
      applied: false,
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: [
        { row: null, message: 'Add the required sourceCohortLabel column.' },
        { row: 3, message: 'Enter an age from 0 to 130 years.' },
      ],
      warnings: [
        {
          row: 2,
          message:
            'The cohort label "SCI-old" resolves to the ambiguous role; the clinical merge and R analysis stages block until the label maps to a known cohort.',
        },
      ],
      errorTotal: 12,
      warningTotal: 1,
    })
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)

    fireEvent.click(screen.getByRole('button', { name: 'Choose CSV file' }))
    await screen.findByText('bad.csv')
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(
      await screen.findByText(
        'The import was rejected; no registry records were changed.',
      ),
    ).toBeInTheDocument()
    const errors = screen.getByRole('table', { name: 'Import errors' })
    // A row number is a code in mono; the whole-file fallback is a word.
    expect(within(errors).getByText('File').style.fontFamily).toContain(
      'WebCM Sans 10',
    )
    expect(within(errors).getByText('3').style.fontFamily).toContain(
      'WebCM Mono 10',
    )
    expect(
      within(errors).getByText(/Enter an age from 0 to 130 years/),
    ).toBeInTheDocument()
    const warnings = screen.getByRole('table', { name: 'Import warnings' })
    expect(within(warnings).getByText('2')).toBeInTheDocument()
    expect(screen.getByText(/Showing the first 2 of 12\./)).toBeInTheDocument()
    // A rejected file must be edited and re-chosen, never retried stale.
    expect(screen.getByText('No file chosen.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('surfaces an import transport failure without inventing a result', async () => {
    const api = createMockApi()
    vi.spyOn(api.registry, 'chooseImportCsv').mockResolvedValue({
      name: 'cohort.csv',
      displayPath: '/data/cohort.csv',
      text: `${IMPORT_HEADER}\nsub-0009,41,F,CTRL,,\n`,
    })
    vi.spyOn(api.registry, 'importCsv').mockRejectedValue(
      new Error('Reopen the project because it changed on disk.'),
    )
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)

    fireEvent.click(screen.getByRole('button', { name: 'Choose CSV file' }))
    await screen.findByText('cohort.csv')
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(
      await screen.findByText(/Reopen the project because it changed on disk/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Import complete/)).not.toBeInTheDocument()
  })

  it('shows and saves the example CSV in one action each', async () => {
    const api = createMockApi()
    const choosePath = vi.spyOn(api.fs, 'chooseSavePath').mockResolvedValue({
      destinationId: 'destination-1',
      displayPath: '/tmp/registry-import-example.csv',
    })
    const saveExample = vi
      .spyOn(api.registry, 'saveExampleCsv')
      .mockResolvedValue(undefined)
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)

    const disclosure = screen.getByRole('button', { name: 'Example CSV' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(disclosure).not.toHaveAttribute('aria-pressed')
    const regionId = disclosure.getAttribute('aria-controls')
    expect(regionId).toBeTruthy()
    const region = document.getElementById(regionId ?? '')
    expect(region).not.toBeNull()
    expect(region).not.toBeVisible()

    fireEvent.click(disclosure)
    const example = screen.getByRole('group', { name: 'Example CSV' })
    expect(example).toHaveTextContent(
      'subjectId,age,sex,sourceCohortLabel,ais,tSinceSci',
    )
    expect(example).toHaveAttribute('tabindex', '0')
    // The label stays constant; only the expansion state changes.
    expect(disclosure).toHaveAccessibleName('Example CSV')
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(disclosure).not.toHaveAttribute('aria-pressed')
    expect(region).toBeVisible()
    expect(region).toContainElement(example)

    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('group', { name: 'Example CSV' }),
    ).not.toBeInTheDocument()
    expect(region).not.toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Save example CSV' }))
    await waitFor(() =>
      expect(saveExample).toHaveBeenCalledWith({
        project: PROJECT,
        destinationId: 'destination-1',
      }),
    )
    expect(choosePath).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'registry-import-example',
        project: PROJECT,
      }),
    )
    expect(await screen.findByText(/Saved the example to/)).toBeInTheDocument()
  })

  it('keeps the collision policy keyboard operable with correct roles', async () => {
    const api = createMockApi()
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)

    const skip = screen.getByRole('radio', { name: 'Skip' })
    expect(skip).toBeChecked()
    skip.focus()
    fireEvent.keyDown(skip, { key: 'ArrowRight' })
    const update = screen.getByRole('radio', { name: 'Update' })
    expect(update).toBeChecked()
    expect(update).toHaveAttribute(
      'title',
      expect.stringMatching(
        /replace the stored fields, keep the QC annotations/,
      ),
    )
  })
})

describe('RegistryScreen sites', () => {
  it('saves a typed site and suggests the labels in use', async () => {
    const api = createMockApi()
    await storeRecord(api, { site: 'Prisma' })
    const upsert = vi.spyOn(api.registry, 'upsert')
    renderScreen(api)
    await screen.findByRole('table', { name: 'Recently registered subjects' })

    const site = screen.getByLabelText('Site (optional)')
    const options = document.getElementById(site.getAttribute('list') ?? '')
    expect(
      [...(options?.querySelectorAll('option') ?? [])].map(
        (option) => option.value,
      ),
    ).toEqual(['Prisma'])
    // The empty field's hint stays neutral rather than showing a label in
    // use, which would read as a stored value.
    expect(site).toHaveAttribute('placeholder', 'Scanner or site, e.g. Prisma')
    fireEvent.change(screen.getByLabelText('Subject ID'), {
      target: { value: 'sub-002' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'F' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Control' }))
    fireEvent.change(site, { target: { value: ' Ingenia ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save subject' }))

    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
    expect(upsert.mock.calls[0]?.[0].record.site).toBe('Ingenia')
    const table = screen.getByRole('table', {
      name: 'Recently registered subjects',
    })
    // The Subject column holds the ID and, once any record has one, the site.
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Subject',
      'Cohort',
      'Age (years), sex',
      'Clinical',
      'T1',
      'Status',
      'Actions',
    ])
    expect(await within(table).findByText('Ingenia')).toBeInTheDocument()
    expect(within(table).getByText('Prisma')).toBeInTheDocument()
  })

  it('refuses a label outside the rule or differing only in case', async () => {
    const api = createMockApi()
    await storeRecord(api, { site: 'Prisma' })
    renderScreen(api)
    await screen.findByRole('table', { name: 'Recently registered subjects' })
    fireEvent.change(screen.getByLabelText('Subject ID'), {
      target: { value: 'sub-002' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'F' }))
    const site = screen.getByLabelText('Site (optional)')

    fireEvent.change(site, { target: { value: 'Prisma/3T' } })
    expect(screen.getByText(/^Use a site label of 1 to 64/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save subject' })).toBeDisabled()

    fireEvent.change(site, { target: { value: 'prisma' } })
    expect(
      screen.getByText(
        'Use the existing site label Prisma; the two labels differ only in letter case.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save subject' })).toBeDisabled()
  })

  it('loads the stored site into an edit and clears it', async () => {
    const api = createMockApi()
    await storeRecord(api, { site: 'Prisma' })
    const upsert = vi.spyOn(api.registry, 'upsert')
    renderScreen(api)
    const table = await screen.findByRole('table', {
      name: 'Recently registered subjects',
    })
    fireEvent.click(within(table).getByRole('button', { name: 'Edit sub-001' }))
    const site = screen.getByLabelText('Site (optional)')
    expect(site).toHaveValue('Prisma')

    // The record's own label may change spelling: no other record holds it.
    fireEvent.change(site, { target: { value: 'PRISMA' } })
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
    fireEvent.change(site, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
    expect(upsert.mock.calls[0]?.[0].record.site).toBeNull()
    // With no site left in the registry, the Subject column drops the site
    // line.
    await waitFor(() => expect(within(table).queryByText('Prisma')).toBeNull())
    expect(within(table).queryByText('No site')).toBeNull()
    expect(within(table).getByText('sub-001')).toBeInTheDocument()
  })

  it('states the site facts beside the registry summary', async () => {
    const api = createMockApi()
    vi.spyOn(api.registry, 'list').mockResolvedValue([
      record({ subjectId: 'sub-001' }),
      record({ subjectId: 'sub-002' }),
      record({
        subjectId: 'sub-101',
        sourceCohortLabel: 'SCI_P',
        cohortRole: 'sci-neuropathic-pain',
        site: 'Ingenia',
      }),
    ])
    renderScreen(api)
    expect(await screen.findByText('Site: Ingenia 1.')).toBeInTheDocument()
    expect(
      screen.getByText('2 subjects have no site, and 1 does.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Site Ingenia has no controls.'),
    ).toBeInTheDocument()
  })

  it('states that a project without sites counts as one site', async () => {
    const api = createMockApi()
    await storeRecord(api)
    renderScreen(api)
    // The short status keeps the consequence in its title, and the action
    // follows it on the same row.
    const status = await screen.findByText('No sites set.')
    expect(status).toHaveAttribute(
      'title',
      'No subject has a site, so the project counts as one site.',
    )
    expect(status.parentElement?.nextElementSibling).toBe(
      screen.getByRole('button', { name: 'Set site...' }),
    )
  })

  it('sets a site for a selection in one write and states the outcome', async () => {
    const api = createMockApi()
    await storeRecord(api, { subjectId: 'sub-001' })
    await storeRecord(api, { subjectId: 'sub-002' })
    await storeRecord(api, { subjectId: 'sub-003', site: 'Prisma' })
    const setSite = vi.spyOn(api.registry, 'setSite')
    const refresh = vi.fn()
    renderScreen(api, refresh)
    await screen.findByRole('table', { name: 'Recently registered subjects' })

    fireEvent.click(screen.getByRole('button', { name: 'Set site...' }))
    const dialog = await screen.findByRole('dialog', { name: 'Set site' })
    expect(
      within(dialog).getByText('Select at least one subject.'),
    ).toBeTruthy()
    expect(
      within(dialog).getByRole('button', { name: 'Set site' }),
    ).toBeDisabled()

    fireEvent.click(
      await within(dialog).findByRole('radio', { name: 'No site 2' }),
    )
    expect(within(dialog).queryByText('sub-003')).toBeNull()
    fireEvent.click(within(dialog).getByLabelText('Select all 2 shown'))
    expect(
      screen.getByRole('dialog', { name: 'Set site for 2 subjects' }),
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Site')).toHaveAttribute(
      'placeholder',
      'Scanner or site, e.g. Prisma',
    )
    fireEvent.change(within(dialog).getByLabelText('Site'), {
      target: { value: 'prisma' },
    })
    expect(
      within(dialog).getByRole('button', { name: 'Set site' }),
    ).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Site'), {
      target: { value: 'Prisma' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set site' }))

    await waitFor(() => expect(setSite).toHaveBeenCalledTimes(1))
    expect(setSite.mock.calls[0]?.[0]).toEqual({
      project: PROJECT,
      subjectIds: ['sub-001', 'sub-002'],
      site: 'Prisma',
      expectedRevisions: { 'sub-001': 1, 'sub-002': 1 },
    })
    expect(
      await screen.findByText('Set site Prisma for 2 subjects.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(refresh).toHaveBeenCalled()
    expect(await screen.findByText('Site: Prisma 3.')).toBeInTheDocument()
  })

  it('holds the site of a discovered subject and registers it with it', async () => {
    // A site is a scanner fact, so it can be set before the age, sex, and
    // cohort are registered, and registration then keeps it.
    const discovered: Subject = {
      ...makeMockCohort(1, 7)[0]!,
      id: 'sub-0050',
      registered: false,
      site: null,
    }
    const api = createMockApi([discovered])
    const upsert = vi.spyOn(api.registry, 'upsert')
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)
    const setSiteButton = await screen.findByRole('button', {
      name: 'Set site...',
    })
    await waitFor(() => expect(setSiteButton).toBeEnabled())

    fireEvent.click(setSiteButton)
    const dialog = await screen.findByRole('dialog', { name: 'Set site' })
    fireEvent.click(await within(dialog).findByLabelText('Select sub-0050'))
    expect(within(dialog).getByText('Not registered')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Site'), {
      target: { value: 'Ingenia' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set site' }))
    expect(
      await screen.findByText('Set site Ingenia for 1 subject.'),
    ).toBeInTheDocument()
    // The summary states the held site it leaves out of the counts.
    expect(
      await screen.findByText(
        'The site of 1 unregistered subject is held until registration.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('No sites set.')).toHaveAttribute(
      'title',
      'No subject is registered.',
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Register sub-0050' }),
    )
    expect(screen.getByLabelText('Site (optional)')).toHaveValue('Ingenia')
    fireEvent.click(screen.getByRole('radio', { name: 'F' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Control' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save subject' }))
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1))
    expect(upsert.mock.calls[0]?.[0].record).toMatchObject({
      subjectId: 'sub-0050',
      site: 'Ingenia',
    })
    await expect(upsert.mock.results[0]?.value).resolves.toMatchObject({
      site: 'Ingenia',
    })
  })

  it('clears the site of the selection', async () => {
    const api = createMockApi()
    await storeRecord(api, { subjectId: 'sub-001', site: 'Ingenia' })
    renderScreen(api)
    await screen.findByRole('table', { name: 'Recently registered subjects' })
    fireEvent.click(screen.getByRole('button', { name: 'Set site...' }))
    const dialog = await screen.findByRole('dialog', { name: 'Set site' })
    const clear = within(dialog).getByRole('button', { name: 'Clear site' })
    expect(clear).toBeDisabled()
    fireEvent.click(await within(dialog).findByLabelText('Select sub-001'))
    expect(
      within(dialog).getByText(
        '1 of the selected subjects has a site; Clear site removes it.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(clear)
    expect(
      await screen.findByText('Cleared the site of 1 subject.'),
    ).toBeInTheDocument()
  })

  it('keeps the dialog open with the refusal and reloads the revisions', async () => {
    const api = createMockApi()
    await storeRecord(api, { subjectId: 'sub-001' })
    const list = vi.spyOn(api.registry, 'list')
    vi.spyOn(api.registry, 'setSite').mockRejectedValueOnce(
      new Error(
        'Load saved values because another writer changed this record.',
      ),
    )
    renderScreen(api)
    await screen.findByRole('table', { name: 'Recently registered subjects' })
    fireEvent.click(screen.getByRole('button', { name: 'Set site...' }))
    const dialog = await screen.findByRole('dialog', { name: 'Set site' })
    fireEvent.click(await within(dialog).findByLabelText('Select sub-001'))
    fireEvent.change(within(dialog).getByLabelText('Site'), {
      target: { value: 'Prisma' },
    })
    const reads = list.mock.calls.length
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set site' }))

    expect(
      await within(dialog).findByText(
        'Load saved values because another writer changed this record.',
      ),
    ).toBeInTheDocument()
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(reads))
    expect(
      screen.getByRole('dialog', { name: 'Set site for 1 subject' }),
    ).toBeTruthy()
  })

  it('previews the sites a chosen import file sets', async () => {
    const api = createMockApi()
    vi.spyOn(api.registry, 'chooseImportCsv')
      .mockResolvedValueOnce({
        name: 'sites.csv',
        displayPath: '/data/sites.csv',
        text: `${IMPORT_HEADER},site\nsub-1,40,F,CTRL,,,Prisma\nsub-2,40,F,CTRL,,,Ingenia\nsub-3,40,F,CTRL,,,Prisma\nsub-4,40,F,CTRL,,,\n`,
      })
      .mockResolvedValueOnce({
        name: 'plain.csv',
        displayPath: '/data/plain.csv',
        text: `${IMPORT_HEADER}\nsub-1,40,F,CTRL,,\n`,
      })
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)

    fireEvent.click(screen.getByRole('button', { name: 'Choose CSV file' }))
    expect(
      await screen.findByText(
        'Sites in the file: Prisma 2, Ingenia 1. 1 row has no site.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Update' }))
    expect(
      screen.getByText(
        'Sites in the file: Prisma 2, Ingenia 1. 1 row has no site, which clears the stored site of a registered subject.',
      ),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Choose CSV file' }))
    expect(
      await screen.findByText(
        'The file has no site column: new subjects get no site, and updated subjects keep their stored site.',
      ),
    ).toBeInTheDocument()
  })

  it('imports a site column through the mock contract', async () => {
    const api = createMockApi()
    vi.spyOn(api.registry, 'chooseImportCsv').mockResolvedValue({
      name: 'sites.csv',
      displayPath: '/data/sites.csv',
      text: `${IMPORT_HEADER},site\nsub-0009,41,F,CTRL,,,Prisma\n`,
    })
    renderScreen(api)
    await screen.findByText(/This project has no registry records/i)
    fireEvent.click(screen.getByRole('button', { name: 'Choose CSV file' }))
    await screen.findByText('sites.csv')
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByText('Site: Prisma 1.')).toBeInTheDocument()
  })
})
