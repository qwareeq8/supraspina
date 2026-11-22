import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'
import { act, useLayoutEffect, type ReactNode } from 'react'
import { AppProvider, useApp, type SubjectFilter } from '../state/context'
import {
  RuntimeContext,
  logReplayCoverage,
  type RuntimeState,
} from '../state/runtime-state'
import { SubjectsScreen, type SubjectsScreenProps } from './SubjectsScreen'
import { createMockApi, makeMockCohort } from '../ipc/mock'
import type { RunSnapshot, SupraspinaApi } from '../../shared/contract'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import { MATRIX_STEPS } from '../../shared/steps'
import type { Subject } from '../../shared/types'
import { THEMES } from '../theme/tokens'
import { formatRunTime } from '../ui'

function allDone(s: Subject): Subject {
  return {
    ...s,
    cells: s.cells.map((c) => ({
      ...c,
      st: 'done',
      rc: 0,
      err: null,
      finishedAt: c.finishedAt ?? c.startedAt ?? Date.now(),
      progress: null,
    })),
  }
}

function failureEmphasisCohort(): Subject[] {
  const [healthy, failed] = makeMockCohort(2, 71)
  if (!healthy || !failed) throw new Error('Provide two mock subjects.')
  return [
    {
      ...healthy,
      id: 'sub-001',
      qc: 'pass',
      analysisEligible: true,
      unavailableReason: null,
      cells: healthy.cells.map((cell) => ({
        ...cell,
        st: 'pending',
        rc: null,
        err: null,
      })),
    },
    {
      ...failed,
      id: 'sub-002',
      qc: 'pass',
      analysisEligible: true,
      unavailableReason: null,
      cells: failed.cells.map((cell, index) =>
        index === 0
          ? { ...cell, st: 'failed', rc: 1, err: 'fixture failure' }
          : cell,
      ),
    },
  ]
}

/** Build a settled runtime whose newest run ended with this status. */
function runtimeWithNewestRun(status: RunSnapshot['status']): RuntimeState {
  const run: RunSnapshot = {
    runId: 'run-newest',
    projectId: 'subjects-project',
    projectEpoch: 1,
    status,
    startedAt: Date.parse('2026-09-25T18:15:00.000Z'),
    endedAt: Date.parse('2026-09-25T18:16:00.000Z'),
    dryRun: false,
    durable: true,
    selectedSubjectIds: [],
    acknowledgements: {
      includeDeferredAndUnreviewedQc: false,
      acknowledgeMemoryAdvisory: false,
    },
    summary: {
      planned: 2,
      started: 2,
      waiting: 0,
      blocked: 0,
      skipped: 0,
      message: status,
    },
  }
  return {
    runs: [run],
    jobs: [],
    logs: [],
    logReplay: logReplayCoverage(null),
    provision: null,
    summary: null,
    hydrating: false,
    error: null,
    authoritativeRuntimeKnown: true,
    authorityState: 'known',
    retryHydration: () => undefined,
    activeRuns: [],
    activeJobs: [],
    activeCount: 0,
  }
}

function renderScreen(
  props: SubjectsScreenProps = {},
): ReturnType<typeof render> {
  return render(
    <AppProvider>
      <SubjectsScreen {...props} />
    </AppProvider>,
  )
}

const PROJECT = {
  projectId: 'subjects-project',
  root: '/projects/subjects',
  configPath: '/projects/subjects/supraspina.project.json',
  epoch: 1,
}

function ProjectBootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  useLayoutEffect(() => {
    if (!app.projectRef) {
      app.markProjectCreated({
        project: PROJECT,
        cfg: {
          ...DEFAULT_PROJECT_CONFIG,
          paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: PROJECT.root },
        },
        configSha256: '0'.repeat(64),
      })
    }
  }, [app])
  return (
    <>
      <output data-testid="subject-glob">{app.cfg.patterns.subjectGlob}</output>
      <output data-testid="dirty">{String(app.dirty)}</output>
      {children}
    </>
  )
}

function renderProjectScreen(api = createMockApi()): ReturnType<typeof render> {
  window.supraspina = api
  return render(
    <AppProvider>
      <ProjectBootstrap>
        <SubjectsScreen />
      </ProjectBootstrap>
    </AppProvider>,
  )
}

function EmphasisBootstrap({
  emphasis,
  children,
}: {
  emphasis: 'whisper' | 'notice' | 'triage'
  children: ReactNode
}): ReactNode {
  const { tweaks, setTweaks } = useApp()
  useLayoutEffect(() => {
    if (tweaks.failureEmphasis !== emphasis) {
      setTweaks({ failureEmphasis: emphasis })
    }
  }, [emphasis, setTweaks, tweaks.failureEmphasis])
  return (
    <>
      <output data-testid="failure-emphasis">{tweaks.failureEmphasis}</output>
      {children}
    </>
  )
}

function renderEmphasisScreen(
  emphasis: 'whisper' | 'notice' | 'triage',
): ReturnType<typeof render> {
  return render(
    <AppProvider>
      <EmphasisBootstrap emphasis={emphasis}>
        <SubjectsScreen subjects={failureEmphasisCohort()} />
      </EmphasisBootstrap>
    </AppProvider>,
  )
}

describe('SubjectsScreen', () => {
  afterEach(() => localStorage.clear())

  it('should render the matrix when subjects are discovered', async () => {
    renderScreen({ subjects: makeMockCohort(4, 17) })
    expect(await screen.findByText('Subjects')).toBeTruthy()
    const table = await screen.findByRole('table', {
      name: 'Subjects matrix',
    })
    expect(table).toBeTruthy()
    expect(table).toHaveAttribute('tabindex', '0')
    expect(table).toHaveStyle({ overflow: 'auto', maxWidth: '100%' })
    expect(within(table).getAllByRole('row')[0]).toHaveStyle({
      position: 'sticky',
    })
  })

  it('pins the Subject column and marks the sides with hidden columns', async () => {
    // Match the measured 1214 px window: 1044 px of columns in 843 px.
    const isMatrix = (el: Element): boolean =>
      el.getAttribute('aria-label') === 'Subjects matrix'
    const scrollWidth = vi
      .spyOn(Element.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: Element) {
        return isMatrix(this) ? 1044 : 0
      })
    const clientWidth = vi
      .spyOn(Element.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: Element) {
        return isMatrix(this) ? 843 : 0
      })
    try {
      const { container } = renderScreen({ subjects: makeMockCohort(4, 17) })
      const table = await screen.findByRole('table', {
        name: 'Subjects matrix',
      })
      const [header, firstRow] = within(table).getAllByRole('row')
      expect(
        within(header!).getByRole('columnheader', { name: 'Subject' }),
      ).toHaveStyle({ position: 'sticky' })
      expect(within(firstRow!).getByRole('rowheader')).toHaveStyle({
        position: 'sticky',
      })
      // The column of exclusion and integrity notes has a noun header.
      expect(
        within(header!).getByRole('columnheader', { name: 'Notes' }),
      ).toHaveTextContent('Notes')
      expect(
        container.querySelector('[data-scroll-edge="right"]'),
      ).not.toBeNull()
      expect(container.querySelector('[data-scroll-edge="left"]')).toBeNull()
      // The chevron sits in a gutter beside the matrix, not over Notes.
      expect(
        container.querySelector('[data-scroll-edge="right"] svg'),
      ).toBeNull()
      expect(
        container.querySelector('[data-scroll-edge="right-chevron"] svg'),
      ).not.toBeNull()
      expect(table.parentElement).toHaveStyle({ paddingRight: '16px' })

      table.scrollLeft = 201
      fireEvent.scroll(table)
      expect(
        container.querySelector('[data-scroll-edge="left"]'),
      ).not.toBeNull()
      expect(container.querySelector('[data-scroll-edge="right"]')).toBeNull()
    } finally {
      scrollWidth.mockRestore()
      clientWidth.mockRestore()
    }
  })

  it('shows no scroll edge when every column fits', async () => {
    const { container } = renderScreen({ subjects: makeMockCohort(4, 17) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    expect(container.querySelector('[data-scroll-edge]')).toBeNull()
  })

  it('paints pinned cells with the solid row color in every row state', async () => {
    // Pinned cells paint these tokens as they are, so a translucent token
    // would let scrolled columns show through without compositing.
    for (const [name, theme] of Object.entries(THEMES)) {
      for (const token of ['bg', 'surface2', 'accentSoft'] as const) {
        expect(theme[token], `${name}.${token}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
    const t = THEMES.light
    renderScreen({ subjects: makeMockCohort(4, 17) })
    const table = await screen.findByRole('table', {
      name: 'Subjects matrix',
    })
    const [even, odd, other] = within(table).getAllByRole('row').slice(1)
    const expectPinnedColor = (row: HTMLElement, color: string): void => {
      const pinned = [
        within(row).getAllByRole('cell')[0]!,
        within(row).getByRole('rowheader'),
      ]
      for (const cell of pinned) {
        expect(cell).toHaveStyle({ position: 'sticky' })
        expect(cell.style.backgroundImage).toBe('')
        expect(cell).toHaveStyle({ backgroundColor: color })
      }
    }

    expectPinnedColor(even!, t.bg)
    expectPinnedColor(odd!, t.surface2)

    fireEvent.mouseEnter(other!)
    expectPinnedColor(other!, t.surface2)
    fireEvent.mouseLeave(other!)
    expectPinnedColor(other!, t.bg)

    act(() =>
      within(other!)
        .getByRole('button', { name: /QC review/ })
        .focus(),
    )
    expectPinnedColor(other!, t.surface2)
    act(() =>
      within(other!)
        .getByRole('button', { name: /QC review/ })
        .blur(),
    )
    expectPinnedColor(other!, t.bg)

    const checkbox = within(odd!).getByRole('checkbox')
    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox).toBeChecked())
    expectPinnedColor(odd!, t.accentSoft)
  })

  it('names an unregistered row instead of printing placeholder metadata', async () => {
    const [known, unknownAge, unregistered] = makeMockCohort(3, 31)
    if (!known || !unknownAge || !unregistered) {
      throw new Error('Provide three mock subjects.')
    }
    renderScreen({
      subjects: [
        // A CSV import can store a fractional age; the matrix reads whole
        // years, as for every other subject.
        { ...known, id: 'sub-001', age: 42.67, sex: 'F', cohort: 'CTRL' },
        { ...unknownAge, id: 'sub-002', age: null, sex: 'M', cohort: 'CTRL' },
        {
          ...unregistered,
          id: 'sub-003',
          age: null,
          sex: 'O',
          cohort: 'UNKNOWN',
          registered: false,
        },
      ],
    })
    const table = await screen.findByRole('table', { name: 'Subjects matrix' })

    expect(within(table).getByText('42 / F')).toBeInTheDocument()
    expect(within(table).getByText('- / M')).toBeInTheDocument()
    expect(within(table).queryByText('0 / O')).not.toBeInTheDocument()

    const row = within(table)
      .getAllByRole('row')
      .find((candidate) => within(candidate).queryByText('sub-003') !== null)
    expect(row).toBeDefined()
    const cells = within(row!).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('-')
    expect(cells[1]).not.toHaveTextContent('O')
    expect(cells[2]).toHaveTextContent('Not registered')
    expect(cells[2]).toHaveAttribute(
      'title',
      'No registry record holds the age, sex, and cohort of this subject yet. The Registry tab registers it.',
    )
    expect(within(table).queryByText('Unresolved cohort')).toBeNull()
  })

  it('should count a QC Fail subject as excluded, not partly done', async () => {
    const cohort: Subject[] = makeMockCohort(2, 117).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      cells: subject.cells.map((cell) => ({ ...cell, st: 'pending' as const })),
    }))
    const excluded = cohort[0]!
    excluded.qc = 'fail'
    excluded.cells[0] = { ...excluded.cells[0]!, st: 'done' }

    renderScreen({ subjects: cohort })

    const radios = within(
      await screen.findByRole('radiogroup', {
        name: 'Filter subjects by state',
      }),
    ).getAllByRole('radio')
    const labels = radios.map((radio) => radio.textContent)
    expect(labels).toContain('Excluded 1')
    expect(labels).toContain('Partly done 0')
  })

  it('should expose mutually exclusive live status counts and filters', async () => {
    const cohort: Subject[] = makeMockCohort(6, 117).map((subject) => ({
      ...subject,
      // The seeded mock cohort may hold a QC Fail subject, which counts as
      // Excluded rather than by its stages.
      qc: 'pass' as const,
      cells: subject.cells.map((cell) => ({
        ...cell,
        st: 'pending' as const,
        startedAt: null,
        finishedAt: null,
        rc: null,
        err: null,
      })),
    }))
    const failed = cohort[0]!
    failed.cells[0] = {
      ...failed.cells[0]!,
      st: 'failed',
      rc: 1,
      err: 'fixture failure',
    }

    failed.cells[1] = { ...failed.cells[1]!, st: 'running' }
    const running = cohort[1]!
    running.cells[0] = { ...running.cells[0]!, st: 'cancelling' }
    const pending = cohort[2]!
    pending.cells[0] = { ...pending.cells[0]!, st: 'queued' }
    cohort[3] = allDone(cohort[3]!)
    const inProgress = cohort[4]!
    inProgress.cells[0] = { ...inProgress.cells[0]!, st: 'done' }
    const outdated = allDone(cohort[5]!)
    outdated.cells[1] = { ...outdated.cells[1]!, st: 'outdated' }
    cohort[5] = outdated

    renderScreen({ subjects: cohort })

    // One name and one count per bucket, as on the Dashboard tiles.
    const radios = within(
      await screen.findByRole('radiogroup', {
        name: 'Filter subjects by state',
      }),
    ).getAllByRole('radio')
    expect(radios.map((radio) => radio.textContent)).toEqual([
      'All 6',
      'Done 1',
      'Out of date 1',
      'Partly done 1',
      'Running 1',
      'Failed 1',
      'Pending 1',
    ])

    const counts = screen.getByText(
      '1 done, 1 out of date, 1 partly done, 1 running, 1 failed, and 1 pending subjects.',
    )
    expect(counts).toHaveAttribute('aria-live', 'polite')
    expect(counts).not.toHaveAttribute('aria-label')

    for (const [filter, subject] of [
      ['Running 1', running],
      ['Partly done 1', inProgress],
      ['Out of date 1', outdated],
      ['Pending 1', pending],
    ] as const) {
      fireEvent.click(screen.getByRole('radio', { name: filter }))
      expect(
        screen.getAllByRole('button', { name: /^Open .* in QC review$/ }),
      ).toHaveLength(1)
      expect(
        screen.getByRole('button', {
          name: `Open ${subject.id} in QC review`,
        }),
      ).toBeInTheDocument()
    }
  })

  it('should count and label precise Brain FOV runtime states', async () => {
    const cohort: Subject[] = makeMockCohort(3, 217).map((subject) => ({
      ...subject,
      cells: subject.cells.map((cell) => ({
        ...cell,
        st: 'pending' as const,
        startedAt: null,
        finishedAt: null,
        rc: null,
        err: null,
      })),
    }))
    cohort[0]!.stepStates = { brainfov: 'queued' }
    cohort[1]!.stepStates = { brainfov: 'running' }
    cohort[2]!.stepStates = { brainfov: 'failed' }

    renderScreen({ subjects: cohort })

    expect(
      await screen.findByRole('radio', { name: 'Failed 1' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Running 1' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Pending 1' })).toBeInTheDocument()
    expect(
      screen.getByTitle('Brain FOV (field of view) preparation: Queued'),
    ).toHaveTextContent('Brain FOV preparation: Queued')
    expect(
      screen.getByTitle('Brain FOV (field of view) preparation: Running'),
    ).toHaveTextContent('Brain FOV preparation: Running')
    expect(
      screen.getByTitle('Brain FOV (field of view) preparation: Failed'),
    ).toHaveTextContent('Brain FOV preparation: Failed')
  })

  it('should fit comfortable-density status cells inside their buttons', async () => {
    localStorage.setItem(
      'supraspinaMockMachinePreferences',
      JSON.stringify({ density: 'comfortable' }),
    )
    renderScreen({ subjects: makeMockCohort(1, 18) })
    await screen.findByRole('table', { name: 'Subjects matrix' })

    const cellButton = screen.getAllByRole('button', {
      name: /for sub-\d+:/,
    })[0]
    if (!cellButton) throw new Error('Render a status-cell button.')
    expect(cellButton).toHaveStyle({ width: '30px', height: '30px' })
  })

  it('should contain a long subject id while preserving its accessible name', async () => {
    const longId = 'sub-participant-with-an-intentionally-long-identifier-001'
    const subject = makeMockCohort(1, 19)[0]!
    renderScreen({ subjects: [{ ...subject, id: longId }] })

    const open = await screen.findByRole('button', {
      name: `Open ${longId} in QC review`,
    })
    expect(open).toHaveAttribute('title', `Open ${longId} in QC review`)
    expect(open).toHaveStyle({ overflow: 'hidden' })
    const visibleId = within(open).getByText(longId)
    expect(visibleId).toHaveStyle({
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    })
  })

  it('should toggle global selection when a row checkbox is clicked', async () => {
    renderScreen({ subjects: makeMockCohort(4, 17) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const boxes = await screen.findAllByRole('checkbox')
    const rowBox = boxes[1]
    if (!rowBox) throw new Error('Render a selectable row checkbox.')
    expect((rowBox as HTMLInputElement).checked).toBe(false)
    fireEvent.click(rowBox)
    await waitFor(() => expect((rowBox as HTMLInputElement).checked).toBe(true))
  })

  it('should retain ineligible rows and select only eligible visible subjects', async () => {
    const cohort = makeMockCohort(3, 31).map((subject, index) => ({
      ...subject,
      qc: index === 1 ? ('fail' as const) : ('pass' as const),
      analysisEligible: index === 0,
      unavailableReason:
        index === 1
          ? 'Excluded from analysis: the QC verdict is Fail.'
          : index === 2
            ? "Resolve this subject's ambiguous T1 input."
            : null,
      integrityErrors:
        index === 2
          ? ['The Reconstruction detector failed (PermissionError).']
          : [],
    }))
    const onSelectionChange = vi.fn()
    renderScreen({ subjects: cohort, onSelectionChange })
    await screen.findByRole('table', { name: 'Subjects matrix' })

    expect(
      screen.getAllByRole('button', { name: /^Open .* in QC review$/ }),
    ).toHaveLength(3)
    expect(
      screen.getByRole('checkbox', {
        name: 'Select sub-002. Excluded from analysis: the QC verdict is Fail.',
      }),
    ).toBeDisabled()
    expect(
      screen.getByRole('checkbox', {
        name: "Select sub-003. Resolve this subject's ambiguous T1 input.",
      }),
    ).toBeDisabled()
    // An ineligible row shows a short Excluded tag; its tooltip states the
    // reason and any detector error.
    const tags = screen.getAllByText('Excluded', { selector: 'span' })
    expect(tags.map((tag) => tag.getAttribute('title'))).toEqual(
      expect.arrayContaining([
        'Excluded from analysis: the QC verdict is Fail.',
        "Resolve this subject's ambiguous T1 input. The Reconstruction detector failed (PermissionError).",
      ]),
    )
    // The tag keeps its whole word: it never shrinks, and the Notes column
    // keeps room for it beside Updated.
    expect(tags[0]).toHaveStyle({ flexShrink: '0', whiteSpace: 'nowrap' })
    const row = tags[0]!.closest<HTMLElement>('[role="row"]')!
    expect(row.style.gridTemplateColumns).toMatch(
      / minmax\(72px, 120px\) 64px$/,
    )

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Select all visible eligible subjects.',
      }),
    )
    const selected = onSelectionChange.mock.calls[0]?.[0] as Set<string>
    expect([...selected]).toEqual([cohort[0]!.id])
  })

  it('should disable select-all when every visible subject is ineligible', async () => {
    const cohort = makeMockCohort(2, 33).map((subject) => ({
      ...subject,
      qc: 'fail' as const,
      analysisEligible: false,
      unavailableReason: 'Excluded from analysis: the QC verdict is Fail.',
    }))
    renderScreen({ subjects: cohort })

    const selectAll = await screen.findByRole('checkbox', {
      name: 'Resolve eligibility before selecting visible subjects.',
    })
    expect(selectAll).toBeDisabled()
    expect(selectAll).toHaveAttribute(
      'title',
      'Resolve subject eligibility before selecting all visible subjects.',
    )
  })

  it('should select and then clear all visible eligible subjects locally', async () => {
    renderScreen({ subjects: makeMockCohort(2, 35) })
    const selectAll = await screen.findByRole('checkbox', {
      name: 'Select all visible eligible subjects.',
    })

    fireEvent.click(selectAll)
    await waitFor(() => expect(selectAll).toBeChecked())
    expect(
      screen.getByRole('checkbox', { name: 'Select sub-001' }),
    ).toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: 'Select sub-002' }),
    ).toBeChecked()

    fireEvent.click(selectAll)
    await waitFor(() => expect(selectAll).not.toBeChecked())
    expect(
      screen.getByRole('checkbox', { name: 'Select sub-001' }),
    ).not.toBeChecked()
  })

  it('should count only eligible pipeline failures in the failure banner', async () => {
    const failedCell = {
      ...makeMockCohort(1, 41)[0]!.cells[0]!,
      st: 'failed' as const,
      rc: 1,
      err: 'test failure',
    }
    // One included subject, one QC Fail subject, and one left out of the
    // analysis by its ambiguous T1 input, each with a failed step.
    const reasons = [
      null,
      'Excluded from analysis: the QC verdict is Fail.',
      "Resolve this subject's ambiguous T1 input.",
    ]
    const cohort = makeMockCohort(3, 42).map((subject, index) => ({
      ...subject,
      cells: [failedCell, ...subject.cells.slice(1)],
      qc: index === 1 ? ('fail' as const) : ('pass' as const),
      analysisEligible: index === 0,
      unavailableReason: reasons[index] ?? null,
    }))
    renderScreen({ subjects: cohort })

    const banner = await screen.findByRole('status')
    // Exclusion outranks the failure, so the QC Fail subject counts under
    // Excluded. The Failed filter still counts the subject left out for its
    // T1 input; the banner counts the one that Resume and Runs act on, and
    // names that population.
    expect(banner).toHaveTextContent('1 included subject has a failed step.')
    expect(within(banner).getByText(/included subject has/)).toHaveAttribute(
      'title',
      '1 subject excluded from analysis also has a step that did not finish. The filters count every subject.',
    )
    expect(screen.getByRole('radio', { name: 'Failed 2' })).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: 'Excluded 1' }),
    ).toBeInTheDocument()
  })

  it('names no excluded population when only QC Fail subjects failed', async () => {
    const failedCell = {
      ...makeMockCohort(1, 41)[0]!.cells[0]!,
      st: 'failed' as const,
      rc: 1,
      err: 'test failure',
    }
    const cohort = makeMockCohort(2, 42).map((subject, index) => ({
      ...subject,
      cells: [failedCell, ...subject.cells.slice(1)],
      qc: index === 0 ? ('pass' as const) : ('fail' as const),
      analysisEligible: index === 0,
      unavailableReason:
        index === 0 ? null : 'Excluded from analysis: the QC verdict is Fail.',
    }))
    renderScreen({ subjects: cohort })

    const banner = await screen.findByRole('status')
    // The filters and the banner count the same failed subject.
    expect(banner).toHaveTextContent('1 subject has a failed step.')
    expect(within(banner).getByText(/subject has/)).not.toHaveAttribute('title')
    expect(screen.getByRole('radio', { name: 'Failed 1' })).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: 'Excluded 1' }),
    ).toBeInTheDocument()
  })

  it('should state a plural failure count as a fact', async () => {
    const cohort = makeMockCohort(2, 42).map((subject) => ({
      ...subject,
      cells: subject.cells.map((cell, index) =>
        index < 2
          ? { ...cell, st: 'failed' as const, rc: 1, err: 'fixture failure' }
          : cell,
      ),
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    renderScreen({ subjects: cohort })

    expect(await screen.findByRole('status')).toHaveTextContent(
      '2 subjects have a failed step.',
    )
  })

  it('should select the failed subjects from the failure banner', async () => {
    const cohort = makeMockCohort(3, 17)
    const failedSubject = cohort[1]!
    cohort[1] = {
      ...failedSubject,
      cells: failedSubject.cells.map((cell, index) =>
        index === 0
          ? {
              ...cell,
              st: 'failed',
              rc: 1,
              err: 'fixture failure',
            }
          : cell,
      ),
    }
    const onSelectionChange = vi.fn()
    render(
      <AppProvider>
        <RuntimeContext.Provider value={runtimeWithNewestRun('failed')}>
          <SubjectsScreen
            subjects={cohort}
            onSelectionChange={onSelectionChange}
          />
        </RuntimeContext.Provider>
      </AppProvider>,
    )
    const resumeBtn = await screen.findByRole('button', {
      name: 'Resume failed work',
    })
    expect(resumeBtn).toBeEnabled()
    fireEvent.click(resumeBtn)
    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    const next = onSelectionChange.mock.calls[0]?.[0] as Set<string>
    expect([...next]).toEqual([failedSubject.id])
  })

  it('states canceled and interrupted steps apart and offers Resume only for a resumable run', async () => {
    // After a Cancel all no step failed, and the run dock and Runs say "Nothing
    // to resume", so Subjects offers no Resume failed work.
    const cohort: Subject[] = makeMockCohort(3, 42).map((subject) => ({
      ...subject,
      cells: subject.cells.map((cell) => ({
        ...cell,
        st: 'pending' as const,
        rc: null,
        err: null,
      })),
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    cohort[0]!.cells[0] = { ...cohort[0]!.cells[0]!, st: 'done' }
    cohort[1]!.cells[0] = { ...cohort[1]!.cells[0]!, st: 'cancelled' }
    const onSelectionChange = vi.fn()
    const view = render(
      <AppProvider>
        <RuntimeContext.Provider value={runtimeWithNewestRun('cancelled')}>
          <SubjectsScreen
            subjects={cohort}
            onSelectionChange={onSelectionChange}
          />
        </RuntimeContext.Provider>
      </AppProvider>,
    )

    // The cohort wait notice is a second status region beside the banner.
    const banner = (await screen.findAllByRole('status')).find((region) =>
      region.textContent?.includes('has a canceled step'),
    )!
    expect(banner).not.toHaveTextContent('failed step')
    // A disabled Resume failed work would be the banner's only action; Runs
    // retries the canceled run.
    expect(
      within(banner).queryByRole('button', { name: 'Resume failed work' }),
    ).toBeNull()
    expect(
      within(banner).getByRole('button', { name: 'Retry in Runs' }),
    ).toHaveAttribute('title', 'Open Runs to retry the canceled run.')
    // The out-of-date notice beside the banner keeps its own "Open Runs", so
    // the banner names what it leads to instead of showing a second button with
    // the same name.
    expect(
      within(banner).queryByRole('button', { name: 'Open Runs' }),
    ).toBeNull()
    // Canceled gets a filter while a subject is in it; Interrupted does not.
    const radios = within(
      screen.getByRole('radiogroup', { name: 'Filter subjects by state' }),
    ).getAllByRole('radio')
    expect(radios.map((radio) => radio.textContent)).toContain('Canceled 1')
    expect(radios.map((radio) => radio.textContent)).not.toContain(
      'Interrupted 0',
    )

    // After an app crash interrupted the next run, Resume continues it and
    // selects the interrupted subject; the canceled one waits for Retry
    // canceled.
    cohort[2]!.cells[0] = { ...cohort[2]!.cells[0]!, st: 'interrupted' }
    view.rerender(
      <AppProvider>
        <RuntimeContext.Provider value={runtimeWithNewestRun('interrupted')}>
          <SubjectsScreen
            subjects={[...cohort]}
            onSelectionChange={onSelectionChange}
          />
        </RuntimeContext.Provider>
      </AppProvider>,
    )
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .some((region) =>
            region.textContent?.includes(
              '2 subjects have a step that did not finish: 1 interrupted and 1 canceled.',
            ),
          ),
      ).toBe(true),
    )
    const enabled = screen.getByRole('button', { name: 'Resume failed work' })
    expect(enabled).toBeEnabled()
    expect(screen.queryByRole('button', { name: /in Runs$/ })).toBeNull()
    fireEvent.click(enabled)
    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect([...(onSelectionChange.mock.calls[0]?.[0] as Set<string>)]).toEqual([
      cohort[2]!.id,
    ])
  })

  describe('cohort stage wait notice', () => {
    const FINAL_REASON = 'R analysis exited with status 1.'

    /** Build a runtime whose newest run failed only at R analysis. */
    function finalFailedRuntime(): RuntimeState {
      const runtime = runtimeWithNewestRun('failed')
      return {
        ...runtime,
        jobs: [
          {
            id: 'job-final',
            runId: 'run-newest',
            stepKey: 'final',
            subjectId: null,
            startedAt: Date.parse('2026-09-25T18:15:30.000Z'),
            endedAt: Date.parse('2026-09-25T18:16:00.000Z'),
            exitCode: 1,
            cmd: '',
            stdoutPath: '',
            stderrPath: '',
            envSnapshotPath: '',
            configSnapshotPath: '',
            status: 'failed',
            terminalReason: FINAL_REASON,
          },
        ],
      }
    }

    /** Build eligible subjects whose cells are done but a failed Report. */
    function finishedButReport(count: number): Subject[] {
      return makeMockCohort(count, 42).map((subject) => ({
        ...subject,
        qc: 'pass' as const,
        analysisEligible: true,
        unavailableReason: null,
        cells: MATRIX_STEPS.map((step, index) => ({
          ...subject.cells[index]!,
          st: step.key === 'rep' ? ('failed' as const) : ('done' as const),
          rc: null,
          err: null,
          progress: null,
        })),
      }))
    }

    function renderWithRuntime(subjects: Subject[]): void {
      function RouteProbe(): ReactNode {
        return <span data-testid="route-probe">{useApp().route}</span>
      }
      render(
        <AppProvider>
          <RuntimeContext.Provider value={finalFailedRuntime()}>
            <SubjectsScreen subjects={subjects} />
            <RouteProbe />
          </RuntimeContext.Provider>
        </AppProvider>,
      )
    }

    it('keeps the cohort wait on its own row beside the failure banner', async () => {
      const failed = { st: 'failed' as const, rc: 1, err: 'fixture failure' }
      const subjects = finishedButReport(3).map((subject, index) =>
        index === 0
          ? {
              ...subject,
              cells: subject.cells.map((cell, position) =>
                position === 0 ? { ...cell, ...failed } : cell,
              ),
            }
          : subject,
      )
      renderWithRuntime(subjects)

      const banner = await screen.findByText(/has a failed step/)
      const row = banner.closest<HTMLElement>('[role="status"]')!
      // Every subject is included, so the banner names no population.
      expect(row).toHaveTextContent('1 subject has a failed step.')
      expect(banner).not.toHaveAttribute('title')
      // The banner holds only its own actions; the wait is a separate notice.
      expect(row).not.toHaveTextContent(/waiting on/)
      expect(
        within(row).getByRole('button', { name: 'Resume failed work' }),
      ).toBeInTheDocument()
      const headline = await screen.findByText(
        '2 subjects are waiting on R analysis (failed).',
      )
      const notice = headline.closest<HTMLElement>('[role="status"]')!
      expect(notice).not.toBe(row)
      expect(notice).toHaveTextContent(FINAL_REASON)
      fireEvent.click(within(notice).getByRole('button', { name: 'Open Runs' }))
      expect(screen.getByTestId('route-probe')).toHaveTextContent('runs')
    })

    it('keeps the cohort wait once the banner is dismissed', async () => {
      const subjects = finishedButReport(3).map((subject, index) =>
        index === 0
          ? {
              ...subject,
              cells: subject.cells.map((cell, position) =>
                position === 0
                  ? { ...cell, st: 'failed' as const, rc: 1, err: 'failure' }
                  : cell,
              ),
            }
          : subject,
      )
      renderWithRuntime(subjects)

      fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByText(/has a failed step/)).toBeNull()
      const notice = await screen.findByRole('status')
      expect(notice).toHaveTextContent(/waiting on R analysis/)
      expect(
        within(notice).getByRole('button', { name: 'Open Runs' }),
      ).toBeInTheDocument()
    })

    it('names an R analysis failure after a Run all when no subject failed', async () => {
      // Subject buckets count only a subject's own stages, so without a notice
      // a Run all that failed at R analysis would show only red Report cells
      // beside Partly done rows.
      renderWithRuntime(finishedButReport(2))

      const headline = await screen.findByText(
        '2 subjects are waiting on R analysis (failed).',
      )
      // The tooltip keeps the full sentence behind the short headline.
      expect(headline).toHaveAttribute(
        'title',
        '2 subjects finished their own stages; waiting on R analysis (failed).',
      )
      const notice = headline.closest<HTMLElement>('[role="status"]')!
      expect(notice).toHaveTextContent(FINAL_REASON)
      expect(screen.queryByText(/has a failed step/)).toBeNull()
      fireEvent.click(within(notice).getByRole('button', { name: 'Open Runs' }))
      expect(screen.getByTestId('route-probe')).toHaveTextContent('runs')
    })

    it('reads an R analysis stage blocked at planning from the run manifests', async () => {
      // A node blocked at planning never becomes a job; only the manifest
      // records it, so the notice waits for the manifest read.
      const api = createMockApi()
      const subjects = finishedButReport(1).map((subject) => ({
        ...subject,
        cells: subject.cells.map((cell, index) =>
          MATRIX_STEPS[index]?.key === 'rep'
            ? { ...cell, st: 'pending' as const }
            : cell,
        ),
      }))
      vi.spyOn(api.subjects, 'discover').mockResolvedValue(subjects)
      const list = vi.spyOn(api.manifest, 'list').mockResolvedValue({
        items: [
          {
            runId: 'run-final',
            startedAt: '2026-09-25T18:15:00.000Z',
            endedAt: '2026-09-25T18:16:00.000Z',
            user: 'operator',
            host: 'fixture-host',
            git: { repo: 'supraspina', sha: '', dirty: false },
            configSha256: '0'.repeat(64),
            steps: [
              {
                id: 1,
                key: 'final',
                status: 'blocked',
                subjects: 1,
                failed: 0,
                durationSec: 0,
              },
            ],
            tools: {},
          },
        ],
        nextCursor: null,
      })
      renderProjectScreen(api)

      expect(
        await screen.findByText(
          '1 subject is waiting on R analysis (blocked).',
        ),
      ).toHaveAttribute(
        'title',
        '1 subject finished its own stages; waiting on R analysis (blocked).',
      )
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }))
    })

    it('states a failed cohort stage when no subject finished its own stages', async () => {
      const subjects = finishedButReport(1)
      // A subject whose own reconstruction has not run is not counted as
      // waiting on R analysis, yet the failed stage is still stated.
      subjects[0]!.cells[0] = { ...subjects[0]!.cells[0]!, st: 'pending' }
      renderWithRuntime(subjects)

      const headline = await screen.findByText(
        'R analysis failed in its latest run.',
      )
      expect(headline.closest('[role="status"]')).toHaveTextContent(
        FINAL_REASON,
      )
      expect(screen.queryByText(/finished (its|their) own stages/)).toBeNull()
    })
  })

  it('offers Open Runs, not Resume, once a later run superseded the failure', async () => {
    // Subjects' Resume failed work follows the rule Runs applies: a failed
    // run that a later run superseded is not resumed, so the banner offers
    // the rerun on Runs instead of a disabled Resume.
    const cohort = makeMockCohort(1, 42).map((subject) => ({
      ...subject,
      cells: subject.cells.map((cell, index) =>
        index === 0
          ? { ...cell, st: 'failed' as const, rc: 1, err: 'fixture failure' }
          : cell,
      ),
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const subjectId = cohort[0]!.id
    const later = runtimeWithNewestRun('done')
    const failedRun: RunSnapshot = {
      ...later.runs[0]!,
      runId: 'run-failed',
      status: 'failed',
      startedAt: Date.parse('2026-09-25T17:00:00.000Z'),
      endedAt: Date.parse('2026-09-25T17:05:00.000Z'),
      summary: { ...later.runs[0]!.summary!, planned: 1, started: 1 },
    }
    const reconJob = (runId: string, status: 'failed' | 'done') => ({
      id: `${runId}-recon`,
      runId,
      stepKey: 'recon' as const,
      subjectId,
      startedAt: 1,
      endedAt: 2,
      exitCode: status === 'done' ? 0 : 1,
      cmd: 'recon-all',
      stdoutPath: '',
      stderrPath: '',
      envSnapshotPath: '',
      configSnapshotPath: '',
      status,
    })
    const runtime: RuntimeState = {
      ...later,
      runs: [failedRun, ...later.runs],
      jobs: [reconJob('run-failed', 'failed'), reconJob('run-newest', 'done')],
    }
    render(
      <AppProvider>
        <RuntimeContext.Provider value={runtime}>
          <SubjectsScreen subjects={cohort} />
        </RuntimeContext.Provider>
      </AppProvider>,
    )

    const openRuns = await screen.findByRole('button', {
      name: 'Rerun in Runs',
    })
    expect(openRuns).toBeEnabled()
    expect(openRuns).toHaveAttribute(
      'title',
      'Open Runs to rerun the steps that did not finish.',
    )
    expect(
      screen.queryByRole('button', { name: 'Resume failed work' }),
    ).toBeNull()
  })

  it('offers the path that applies to canceled work, with Resume only while a run is resumable', async () => {
    // After Cancel all, and after a failed run that a canceled run superseded,
    // nothing resumes and the banner leads to Retry canceled on Runs.
    const cohort: Subject[] = makeMockCohort(3, 43).map((subject) => ({
      ...subject,
      cells: subject.cells.map((cell) => ({
        ...cell,
        st: 'done' as const,
        rc: 0,
        err: null,
      })),
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    cohort[0]!.cells[0] = {
      ...cohort[0]!.cells[0]!,
      st: 'failed',
      rc: 1,
      err: 'fixture failure',
    }
    cohort[1]!.cells[0] = { ...cohort[1]!.cells[0]!, st: 'cancelled' }
    const newest = runtimeWithNewestRun('cancelled')
    const olderRun = (status: RunSnapshot['status']): RunSnapshot => ({
      ...newest.runs[0]!,
      runId: 'run-older',
      status,
      startedAt: Date.parse('2026-09-25T17:00:00.000Z'),
      endedAt: Date.parse('2026-09-25T17:05:00.000Z'),
    })
    // A span, not an output: an output is a second status region.
    function RouteProbe(): ReactNode {
      return <span data-testid="route-probe">{useApp().route}</span>
    }
    const view = (runtime: RuntimeState): ReactNode => (
      <AppProvider>
        <RuntimeContext.Provider value={runtime}>
          <SubjectsScreen subjects={[...cohort]} />
          <RouteProbe />
        </RuntimeContext.Provider>
      </AppProvider>
    )

    // A canceled run superseded the failed one: nothing resumes, and Runs
    // retries the canceled run.
    const { rerender } = render(
      view({ ...newest, runs: [olderRun('failed'), ...newest.runs] }),
    )
    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent(
      '2 subjects have a step that did not finish: 1 failed and 1 canceled.',
    )
    expect(
      within(banner).queryByRole('button', { name: 'Resume failed work' }),
    ).toBeNull()
    const openRuns = within(banner).getByRole('button', {
      name: 'Retry in Runs',
    })
    expect(openRuns).toHaveAttribute(
      'title',
      'Open Runs to retry the canceled run.',
    )
    fireEvent.click(openRuns)
    expect(screen.getByTestId('route-probe')).toHaveTextContent('runs')

    // The newest run failed after an older cancellation: Resume applies,
    // and the banner offers it alone.
    const failed = runtimeWithNewestRun('failed')
    rerender(view({ ...failed, runs: [olderRun('cancelled'), ...failed.runs] }))
    const resume = await screen.findByRole('button', {
      name: 'Resume failed work',
    })
    expect(resume).toBeEnabled()
    expect(screen.queryByRole('button', { name: /in Runs$/ })).toBeNull()
  })

  it('reads a stage turned off as skipped and its subjects as Done', async () => {
    // With PyBrainAge and the stages after it off, those cells read skipped,
    // not pending, so subjects can reach Done.
    const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
    for (const key of [
      'pybrainage',
      'clinical',
      'brainpad',
      'final',
    ] as const) {
      cfg.steps[key] = { ...cfg.steps[key], enabled: false }
    }
    const off = new Set(
      (['pba', 'norm', 'stats', 'rep'] as const).map((key) =>
        MATRIX_STEPS.findIndex((step) => step.key === key),
      ),
    )
    const cohort: Subject[] = makeMockCohort(2, 42).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
      cells: subject.cells.map((cell, index) => ({
        ...cell,
        st: off.has(index) ? ('pending' as const) : ('done' as const),
        rc: off.has(index) ? null : 0,
        err: null,
        progress: null,
      })),
      stepStates: {},
    }))
    renderScreen({ subjects: cohort, cfg })

    const radios = within(
      await screen.findByRole('radiogroup', {
        name: 'Filter subjects by state',
      }),
    ).getAllByRole('radio')
    expect(radios.map((radio) => radio.textContent)).toContain('Done 2')
    expect(radios.map((radio) => radio.textContent)).toContain('Partly done 0')
    expect(
      screen.getAllByRole('button', {
        name: /^PyBrainAge for sub-\d+: skipped, This step is off in the project configuration, so it does not run for this subject\.$/,
      }),
    ).toHaveLength(2)
  })

  it('keeps Whisper quiet and leaves the operator-selected subject order intact', async () => {
    renderEmphasisScreen('whisper')
    await screen.findByRole('table', { name: 'Subjects matrix' })

    expect(
      screen.queryByRole('button', {
        name: /^(Resume failed work|Retry in Runs|Rerun in Runs)$/,
      }),
    ).toBeNull()
    expect(
      screen
        .getAllByRole('button', { name: /^Open .* in QC review$/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Open sub-001 in QC review', 'Open sub-002 in QC review'])
  })

  it('makes Notice visible in context without silently changing list order', async () => {
    renderEmphasisScreen('notice')
    await screen.findByRole('button', { name: 'Rerun in Runs' })

    expect(
      screen
        .getAllByRole('button', { name: /^Open .* in QC review$/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Open sub-001 in QC review', 'Open sub-002 in QC review'])
  })

  it('makes Triage visible and prioritizes failed subjects ahead of the chosen sort', async () => {
    renderEmphasisScreen('triage')
    await screen.findByRole('button', { name: 'Rerun in Runs' })
    await waitFor(() =>
      expect(screen.getByTestId('failure-emphasis')).toHaveTextContent(
        'triage',
      ),
    )

    await waitFor(() =>
      expect(
        screen
          .getAllByRole('button', { name: /^Open .* in QC review$/ })
          .map((button) => button.getAttribute('aria-label')),
      ).toEqual(['Open sub-002 in QC review', 'Open sub-001 in QC review']),
    )
  })

  it('should dismiss the failure banner without removing its subject row', async () => {
    const subject = makeMockCohort(1, 37)[0]!
    const cohort = [
      {
        ...subject,
        qc: 'pass' as const,
        analysisEligible: true,
        unavailableReason: null,
        cells: subject.cells.map((cell, index) =>
          index === 0
            ? { ...cell, st: 'failed' as const, rc: 1, err: 'fixture failure' }
            : cell,
        ),
      },
    ]
    renderScreen({ subjects: cohort })

    expect(await screen.findByRole('status')).toHaveTextContent(
      '1 subject has a failed step.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Open sub-001 in QC review' }),
    ).toBeInTheDocument()
  })

  it('should render a Done filter chip and scope to fully-done subjects', async () => {
    const cohort = makeMockCohort(6, 17).map((s, i) => (i < 2 ? allDone(s) : s))
    renderScreen({ subjects: cohort })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const doneChip = await screen.findByRole('radio', { name: /^Done/ })
    fireEvent.click(doneChip)
    await waitFor(() => {
      const openButtons = screen.getAllByRole('button', {
        name: /^Open .* in QC review$/,
      })
      expect(openButtons).toHaveLength(2)
    })
  })

  it('should filter running and pending states and sort by updated time', async () => {
    const cohort = makeMockCohort(3, 39)
    const now = Date.now()
    cohort[0] = {
      ...allDone(cohort[0]!),
      cells: allDone(cohort[0]!).cells.map((cell) => ({
        ...cell,
        finishedAt: now - 2 * 24 * 60 * 60 * 1000,
      })),
    }
    cohort[1] = {
      ...cohort[1]!,
      cells: cohort[1]!.cells.map((cell, index) =>
        index === 0
          ? { ...cell, st: 'running' as const, startedAt: now - 2_000 }
          : { ...cell, st: 'done' as const, finishedAt: now - 4_000 },
      ),
    }
    cohort[2] = {
      ...cohort[2]!,
      cells: cohort[2]!.cells.map((cell) => ({
        ...cell,
        st: 'pending' as const,
        startedAt: null,
        finishedAt: null,
      })),
    }
    renderScreen({ subjects: cohort })
    await screen.findByRole('table', { name: 'Subjects matrix' })

    fireEvent.click(screen.getByRole('radio', { name: /^Running/ }))
    expect(
      screen.getAllByRole('button', { name: /^Open .* in QC review$/ }),
    ).toHaveLength(1)
    expect(screen.getByText('sub-002')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /^Pending/ }))
    expect(screen.getByText('sub-003')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /^All/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Updated' }))
    const rows = screen.getAllByRole('row').slice(1)
    expect(within(rows[0]!).getByText('sub-002')).toBeInTheDocument()
    // Updated states a unit after a space, and "now" under a minute.
    expect(within(rows[0]!).getByText('now')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('sub-001')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('2 d')).toBeInTheDocument()
    expect(within(rows.at(-1)!).getByText('sub-003')).toBeInTheDocument()
  })

  it('should open a subject in QC review from the row open button', async () => {
    const onActiveSubjectChange = vi.fn()
    renderScreen({
      subjects: makeMockCohort(4, 17),
      onActiveSubjectChange,
    })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const openButtons = screen.getAllByRole('button', {
      name: /^Open .* in QC review$/,
    })
    const first = openButtons[0]
    if (!first) throw new Error('Render an openable row button.')
    fireEvent.click(first)
    expect(onActiveSubjectChange).toHaveBeenCalledTimes(1)
  })

  it('should open a subject on row double-click without checkbox propagation', async () => {
    const onActiveSubjectChange = vi.fn()
    renderScreen({
      subjects: makeMockCohort(1, 43),
      onActiveSubjectChange,
    })
    const row = (await screen.findAllByRole('row'))[1]!

    fireEvent.mouseEnter(row)
    fireEvent.focus(row)
    fireEvent.doubleClick(row)
    expect(onActiveSubjectChange).toHaveBeenCalledWith('sub-001')
    fireEvent.blur(row)
    fireEvent.mouseLeave(row)
  })

  it('states a Reconstruction rerun in the status cell and its popover', async () => {
    // The rerun must show outside the receipt JSON.
    const rerun = {
      fact: 'Reran with -no-fix-ga',
      detail: 'Label reason. The first attempt exited with code 1.',
    }
    const [subject] = makeMockCohort(1, 45)
    if (!subject) throw new Error('Build the rerun fixture.')
    const cells = subject.cells.map((cell) => ({ ...cell, rerun }))
    renderScreen({ subjects: [{ ...subject, cells }] })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const trigger = screen.getAllByRole('button', {
      name: /for sub-001:/,
    })[0]!
    expect(trigger.getAttribute('aria-label')).toMatch(
      /\. Reran with -no-fix-ga\.$/,
    )
    expect(trigger.getAttribute('title')).toContain(
      '\nReran with -no-fix-ga.\n',
    )

    fireEvent.click(trigger)
    const actions = screen.getByRole('group', { name: /actions for sub-001/ })
    expect(
      within(actions).getByText('Reran with -no-fix-ga.').parentElement
        ?.textContent,
    ).toBe(
      'Reran with -no-fix-ga. Label reason. The first attempt exited with code 1.',
    )
  })

  it('Operates and dismisses a status-cell action popover accessibly.', async () => {
    renderScreen({ subjects: makeMockCohort(1, 45) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const trigger = screen.getAllByRole('button', {
      name: /for sub-001:/,
    })[0]!

    fireEvent.click(trigger)
    let actions = screen.getByRole('group', {
      name: /actions for sub-001/,
    })
    expect(trigger).toHaveAttribute('aria-controls', actions.id)
    fireEvent.keyDown(actions, { key: 'Escape' })
    expect(
      screen.queryByRole('group', { name: /actions for sub-001/ }),
    ).toBeNull()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'View log' }))
    expect(
      screen.queryByRole('group', { name: /actions for sub-001/ }),
    ).toBeNull()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(
      screen.queryByRole('group', { name: /actions for sub-001/ }),
    ).toBeNull()

    fireEvent.click(trigger)
    fireEvent.click(
      screen.getByRole('button', { name: 'Re-check this subject' }),
    )
    expect(
      screen.queryByRole('group', { name: /actions for sub-001/ }),
    ).toBeNull()

    fireEvent.click(trigger)
    actions = screen.getByRole('group', { name: /actions for sub-001/ })
    fireEvent.mouseDown(actions)
    expect(actions).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(
      screen.queryByRole('group', { name: /actions for sub-001/ }),
    ).toBeNull()
  })

  it('should keep trigger focus and close the cell popover with Escape from either focus region', async () => {
    renderScreen({ subjects: makeMockCohort(1, 46) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const trigger = screen.getAllByRole('button', {
      name: /for sub-001:/,
    })[0]!

    act(() => trigger.focus())
    fireEvent.click(trigger)
    expect(trigger).toHaveFocus()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(
      screen.queryByRole('group', { name: /actions for sub-001/ }),
    ).toBeNull()
    expect(trigger).toHaveFocus()

    fireEvent.click(trigger)
    const action = screen.getByRole('button', {
      name: 'Re-check this subject',
    })
    act(() => action.focus())
    fireEvent.keyDown(action, { key: 'Escape' })
    expect(
      screen.queryByRole('group', { name: /actions for sub-001/ }),
    ).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('Dismisses the cell popover when focus leaves without stealing destination focus.', async () => {
    renderScreen({ subjects: makeMockCohort(1, 47) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const trigger = screen.getAllByRole('button', {
      name: /for sub-001:/,
    })[0]!
    const destination = screen.getByRole('button', {
      name: 'Explain these columns',
    })

    act(() => trigger.focus())
    fireEvent.click(trigger)
    const lastAction = screen.getByRole('button', { name: 'Open folder' })
    act(() => lastAction.focus())
    expect(
      screen.getByRole('group', { name: /actions for sub-001/ }),
    ).toBeInTheDocument()

    fireEvent.keyDown(lastAction, { key: 'Tab' })
    act(() => destination.focus())
    expect(
      screen.queryByRole('group', { name: /actions for sub-001/ }),
    ).toBeNull()
    expect(destination).toHaveFocus()
  })

  it('should restore trigger focus after a cell-popover action closes it', async () => {
    renderScreen({ subjects: makeMockCohort(1, 48) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const trigger = screen.getAllByRole('button', {
      name: /for sub-001:/,
    })[0]!

    act(() => trigger.focus())
    fireEvent.click(trigger)
    const action = screen.getByRole('button', { name: 'View log' })
    act(() => action.focus())
    fireEvent.click(action)

    expect(
      screen.queryByRole('group', { name: /actions for sub-001/ }),
    ).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('should keep a late-column bottom-row popover inside the viewport', async () => {
    renderScreen({ subjects: makeMockCohort(1, 49) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const trigger = screen
      .getAllByRole('button', { name: /for sub-001:/ })
      .at(-1)!
    const rect = (
      left: number,
      top: number,
      width: number,
      height: number,
    ): DOMRect =>
      ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect
    const geometry = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this === trigger) return rect(995, 730, 24, 24)
        if (this.getAttribute('role') === 'group') {
          return rect(0, 0, 240, 200)
        }
        return rect(0, 0, 0, 0)
      })

    fireEvent.click(trigger)
    const actions = screen.getByRole('group', {
      name: /actions for sub-001/,
    })
    await waitFor(() => expect(actions).toHaveStyle({ position: 'fixed' }))

    const left = Number.parseFloat(actions.style.left)
    const top = Number.parseFloat(actions.style.top)
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + 240).toBeLessThanOrEqual(window.innerWidth - 8)
    expect(top).toBeGreaterThanOrEqual(8)
    expect(top + 200).toBeLessThanOrEqual(window.innerHeight - 8)
    expect(top).toBeLessThan(730)
    geometry.mockRestore()
  })

  it('should expose a refresh control and a status legend', async () => {
    renderScreen({ subjects: makeMockCohort(4, 17) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    expect(
      screen.getByRole('button', { name: 'Re-discover the cohort' }),
    ).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getByText('Pending')).toBeTruthy()
  })

  it('Adds a run state to the legend while a visible cell shows it.', async () => {
    const cohort = makeMockCohort(2, 17)
    cohort[0]!.cells[0] = { ...cohort[0]!.cells[0]!, st: 'blocked' }
    const { container } = renderScreen({ subjects: cohort })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const sample = container.querySelector('[data-legend-glyph="blocked"]')
    expect(sample?.parentElement).toHaveTextContent('Blocked')
    expect(sample?.querySelector('[data-glyph-shape]')).toHaveAttribute(
      'data-glyph-shape',
      'prohibited',
    )
    expect(container.querySelector('[data-legend-glyph="waiting"]')).toBeNull()
  })

  it('Disables the matching rules editor without an open project.', async () => {
    renderScreen({ subjects: makeMockCohort(1, 17) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    expect(
      screen.getByRole('button', {
        name: 'Edit the subject and T1 matching rules',
      }),
    ).toBeDisabled()
  })

  it('holds the room of the Last updated stamp in the header while the cohort loads', async () => {
    // At 1214x768 and 135% text the header would fit one row while the cohort
    // loads and wrap to two once "Last updated ..." appears, shifting the page
    // at the end of the load.
    const api = createMockApi(makeMockCohort(2, 42))
    const answers: ((rows: Subject[]) => void)[] = []
    vi.spyOn(api.subjects, 'discover').mockImplementation(
      () =>
        new Promise<Subject[]>((resolve) => {
          answers.push(resolve)
        }),
    )
    renderProjectScreen(api)
    const refresh = await screen.findByRole('button', {
      name: 'Re-discover the cohort',
    })
    const header = refresh.parentElement!

    // Before the cohort answers, the slot holds hidden stamps of the widest
    // times, which neither show nor announce anything. No single month is the
    // widest at every scale ("May 28" measures wider than "Sep 28" at 135%), so
    // the slot holds one sample per month, as QC review's header does.
    const reserved = within(header).getAllByText(/^Last updated /)
    expect(reserved.map((stamp) => stamp.textContent)).toEqual(
      Array.from(
        { length: 12 },
        (_, month) =>
          `Last updated ${formatRunTime(new Date(2026, month, 28, 12, 58).toISOString())}`,
      ),
    )
    const hidden = reserved[0]!.closest('[aria-hidden="true"]')!
    expect(hidden).toHaveStyle({ visibility: 'hidden' })
    for (const stamp of reserved) {
      expect(hidden.contains(stamp)).toBe(true)
      expect(stamp).not.toHaveAttribute('aria-live')
    }

    await act(async () => {
      for (const answer of answers) answer(makeMockCohort(2, 42))
    })

    // The stamp takes the same slot; the reserved width stays with it.
    await waitFor(() =>
      expect(within(header).getAllByText(/^Last updated /)).toHaveLength(
        reserved.length + 1,
      ),
    )
    const shown = within(header)
      .getAllByText(/^Last updated /)
      .find((stamp) => !hidden.contains(stamp))!
    expect(shown).toHaveAttribute('aria-live', 'polite')
    expect(hidden.parentElement!.contains(shown)).toBe(true)
  })

  it('shows the shell rediscovery as busy and stamps the time it answers', async () => {
    // With shell-owned subjects the stamp follows the shell's discovery, not
    // the latest subject activity, and the control shows a rediscovery that can
    // run for about 18 s.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 9, 2, 9, 0))
      const api = createMockApi(makeMockCohort(2, 42))
      const answers: ((rows: Subject[]) => void)[] = []
      vi.spyOn(api.subjects, 'discover').mockImplementation(
        () =>
          new Promise<Subject[]>((resolve) => {
            answers.push(resolve)
          }),
      )
      window.supraspina = api
      function ShellSubjects(): ReactNode {
        const app = useApp()
        return (
          <SubjectsScreen
            subjects={app.subjects}
            refresh={app.refreshSubjects}
          />
        )
      }
      render(
        <AppProvider>
          <ProjectBootstrap>
            <ShellSubjects />
          </ProjectBootstrap>
        </AppProvider>,
      )
      const refresh = await screen.findByRole('button', {
        name: 'Re-discover the cohort',
      })
      await waitFor(() => expect(answers).toHaveLength(1))
      expect(refresh).toHaveAttribute('aria-busy', 'true')
      expect(refresh).toBeDisabled()
      // The open and the sidecar attachment may each discover once.
      await act(async () => {
        for (const answer of answers) answer(makeMockCohort(2, 42))
      })
      const stamp = (at: Date): string =>
        `Last updated ${formatRunTime(at.toISOString())}`
      await waitFor(() =>
        expect(
          screen.getByText(stamp(new Date(2026, 9, 2, 9, 0))),
        ).toBeTruthy(),
      )
      expect(refresh).not.toHaveAttribute('aria-busy')

      vi.setSystemTime(new Date(2026, 9, 2, 9, 7))
      const settled = answers.length
      fireEvent.click(refresh)
      await waitFor(() => expect(answers).toHaveLength(settled + 1))
      expect(refresh).toHaveAttribute('aria-busy', 'true')
      expect(refresh).toHaveAttribute('title', 'Re-discovering the cohort...')
      await act(async () => answers[settled]?.(makeMockCohort(2, 42)))
      await waitFor(() =>
        expect(
          screen.getByText(stamp(new Date(2026, 9, 2, 9, 7))),
        ).toBeTruthy(),
      )
      expect(refresh).not.toHaveAttribute('aria-busy')
    } finally {
      vi.useRealTimers()
    }
  })

  it('Saves edited matching rules and re-discovers without opening Setup.', async () => {
    const api = createMockApi()
    const save = vi.spyOn(api.project, 'save')
    const discover = vi.spyOn(api.subjects, 'discover')
    renderProjectScreen(api)
    await waitFor(() => expect(discover).toHaveBeenCalled())
    const discoveriesBefore = discover.mock.calls.length

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit the subject and T1 matching rules',
      }),
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Edit the subject and T1 matching rules',
    })
    const saveButton = within(dialog).getByRole('button', {
      name: 'Save and re-discover',
    })
    expect(saveButton).toBeDisabled()

    const subjectField = within(dialog).getByLabelText(
      'Subject folder name pattern',
    )
    fireEvent.change(subjectField, { target: { value: '../escape' } })
    expect(within(dialog).getByText(/without slashes/)).toBeInTheDocument()
    expect(saveButton).toBeDisabled()

    fireEvent.change(subjectField, { target: { value: 'participant-*' } })
    fireEvent.change(within(dialog).getByLabelText('T1 file name pattern'), {
      target: { value: '*_T1w.nii' },
    })
    expect(saveButton).toBeEnabled()
    fireEvent.click(saveButton)

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]?.[0].cfg.patterns).toEqual({
      subjectGlob: 'participant-*',
      t1Pattern: '*_T1w.nii',
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('subject-glob')).toHaveTextContent(
      'participant-*',
    )
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')
    await waitFor(() =>
      expect(discover.mock.calls.length).toBeGreaterThan(discoveriesBefore),
    )
    expect(discover.mock.calls.at(-1)?.[0].cfg.patterns.subjectGlob).toBe(
      'participant-*',
    )
  })

  it('Keeps the matching rules editor open with the save rejection.', async () => {
    const api = createMockApi()
    vi.spyOn(api.project, 'save').mockRejectedValue(
      new Error('Choose writable project storage.'),
    )
    renderProjectScreen(api)
    await screen.findByRole('button', {
      name: 'Edit the subject and T1 matching rules',
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit the subject and T1 matching rules',
      }),
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Edit the subject and T1 matching rules',
    })
    fireEvent.change(
      within(dialog).getByLabelText('Subject folder name pattern'),
      { target: { value: 'participant-*' } },
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Save and re-discover' }),
    )
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Choose writable project storage.',
    )
  })

  it('shows the BrainCharts column only while the stage is on or holds a result', async () => {
    const norm = MATRIX_STEPS.findIndex((step) => step.key === 'norm')
    const cohort = makeMockCohort(3, 17)
    const off = structuredClone(DEFAULT_PROJECT_CONFIG)
    const view = renderScreen({ subjects: cohort, cfg: off })
    const matrix = await screen.findByRole('table', { name: 'Subjects matrix' })
    const headers = (): string[] =>
      within(matrix)
        .getAllByRole('columnheader')
        .map((header) => header.getAttribute('aria-label') ?? '')
    expect(headers()).toContain('PyBrainAge')
    expect(headers()).not.toContain('BrainCharts')
    fireEvent.click(
      screen.getByRole('button', { name: 'Explain these columns' }),
    )
    expect(
      await screen.findByText('The 9 status columns are workflow milestones.'),
    ).toBeTruthy()
    view.unmount()

    const on = structuredClone(DEFAULT_PROJECT_CONFIG)
    on.steps.braincharts = { ...on.steps.braincharts!, enabled: true }
    const scored = cohort.map((subject) => ({
      ...subject,
      cells: subject.cells.map((cell, index) =>
        index === norm ? { ...cell, st: 'done' as const, rc: 0 } : cell,
      ),
    }))
    for (const [cfg, subjects] of [
      [on, cohort],
      [off, scored],
    ] as const) {
      const shown = renderScreen({ subjects: [...subjects], cfg })
      const table = await screen.findByRole('table', {
        name: 'Subjects matrix',
      })
      const labels = within(table)
        .getAllByRole('columnheader')
        .map((header) => header.getAttribute('aria-label') ?? '')
      expect(labels.indexOf('BrainCharts')).toBe(
        labels.indexOf('PyBrainAge') + 1,
      )
      shown.unmount()
    }
  })

  it('Opens a plain-language key for the ten step columns.', async () => {
    renderScreen({ subjects: makeMockCohort(4, 17) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const help = screen.getByRole('button', {
      name: 'Explain these columns',
    })
    fireEvent.click(help)
    const dialog = await screen.findByRole('dialog', {
      name: 'Workflow status columns',
    })
    expect(dialog).toBeTruthy()
    expect(within(dialog).getByText(/Predicts each subject/i)).toBeTruthy()
    expect(within(dialog).getByText('pybrainage.predict')).toBeTruthy()
    expect(
      within(dialog).getByRole('button', { name: 'Close columns help' }),
    ).toHaveStyle({ width: '24px', height: '24px' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(
      screen.queryByRole('dialog', {
        name: 'Workflow status columns',
      }),
    ).toBeNull()
  })

  it('should explain a truly empty discovery without offering a filter reset', async () => {
    renderScreen({ subjects: [] })
    expect(
      await screen.findByText('No subjects are discovered in this project.'),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Add subjects to the configured data root, then re-discover the cohort.',
      ),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Show all subjects' }),
    ).toBeNull()
  })

  it('Explains the AIS and cohort identity columns without replacing their names.', async () => {
    renderScreen({ subjects: makeMockCohort(4, 17) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    // The closed tooltip stays in the accessibility tree, so a computed name
    // would read the whole InfoTip text ("Cohort About cohort Cohort is the
    // configured study group. ..."). The name is the visible label; the tip
    // stays reachable inside the header.
    const ais = screen.getByRole('columnheader', { name: 'AIS' })
    const cohort = screen.getByRole('columnheader', { name: 'Cohort' })
    expect(ais).toHaveAccessibleName('AIS')
    expect(cohort).toHaveAccessibleName('Cohort')
    expect(
      within(ais).getByRole('button', { name: 'About AIS' }),
    ).toBeInTheDocument()
    expect(
      within(cohort).getByRole('button', { name: 'About cohort' }),
    ).toBeInTheDocument()
    // The glossary entry already names the term, so the tip does not
    // prefix it with "Interpret AIS as".
    expect(
      screen.getByRole('button', { name: 'About AIS' }),
    ).toHaveAccessibleDescription(/^AIS means ASIA Impairment Scale\. /)
    expect(
      screen.getByRole('button', { name: 'About cohort' }),
    ).toHaveAccessibleDescription(/configured study group/i)
  })

  it('shows the subject count only while a filter narrows the list', async () => {
    renderScreen({ subjects: makeMockCohort(4, 17) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    expect(screen.queryByText('4 of 4')).toBeNull()
    // The sort control is named for assistive technology, with no visible
    // label.
    expect(screen.getByRole('radiogroup', { name: 'Sort' })).toBeInTheDocument()
    expect(screen.queryByText('Sort')).toBeNull()
    const search = screen.getByRole('textbox', {
      name: 'Filter subjects by ID',
    })
    expect(search).toHaveAttribute('placeholder', 'Filter subjects')

    fireEvent.change(search, { target: { value: 'sub-001' } })
    expect(await screen.findByText('1 of 4')).toBeInTheDocument()
  })

  it('should name the active filter and offer a reset when it hides every row', async () => {
    renderScreen({ subjects: makeMockCohort(4, 17) })
    await screen.findByRole('table', { name: 'Subjects matrix' })
    const search = screen.getByLabelText('Filter subjects by ID')
    fireEvent.change(search, { target: { value: 'no-such-subject' } })
    const reset = await screen.findByRole('button', {
      name: 'Show all subjects',
    })
    expect(reset).toBeTruthy()
    fireEvent.click(reset)
    await waitFor(() =>
      expect(
        screen.getByRole('table', { name: 'Subjects matrix' }),
      ).toBeTruthy(),
    )
  })

  it('should state filter and search empty results as facts beside the show-all action', async () => {
    renderScreen({ subjects: makeMockCohort(3, 17).map(allDone) })
    fireEvent.click(await screen.findByRole('radio', { name: 'Failed 0' }))

    expect(
      await screen.findByText('No subjects have a failed step.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Change the search/)).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Show all subjects' }),
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter subjects by ID'), {
      target: { value: 'sub-9' },
    })
    expect(
      await screen.findByText(
        'No subjects match the "Failed" filter and the ID search "sub-9".',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/because/)).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Show all subjects' }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /^All \d+$/ }))
    expect(
      await screen.findByText('No subjects match the ID search "sub-9".'),
    ).toBeInTheDocument()
  })

  it('should name an empty bucket filter in lowercase inside its sentence', async () => {
    renderScreen({ subjects: makeMockCohort(3, 17).map(allDone) })
    const facts: readonly (readonly [string, string])[] = [
      ['Out of date 0', 'No subjects are out of date.'],
      ['Partly done 0', 'No subjects are partly done.'],
      ['Running 0', 'No subjects are running.'],
      ['Failed 0', 'No subjects have a failed step.'],
      ['Pending 0', 'No subjects are pending.'],
    ]
    for (const [filter, fact] of facts) {
      fireEvent.click(await screen.findByRole('radio', { name: filter }))
      expect(await screen.findByText(fact)).toBeInTheDocument()
    }
    expect(screen.queryByText(/^No subjects are [A-Z]/)).toBeNull()
  })

  it('should state an empty Done filter in lowercase', async () => {
    const unstarted = makeMockCohort(2, 17).map((subject) => ({
      ...subject,
      cells: subject.cells.map((cell) => ({
        ...cell,
        st: 'pending' as const,
        rc: null,
        err: null,
      })),
    }))
    renderScreen({ subjects: unstarted })
    fireEvent.click(await screen.findByRole('radio', { name: 'Done 0' }))

    expect(await screen.findByText('No subjects are done.')).toBeInTheDocument()
  })

  describe('matrix state meanings and exclusions as facts', () => {
    function oneSubject(
      states: Subject['cells'][number]['st'][],
      overrides: Partial<Subject> = {},
    ): Subject[] {
      const base = makeMockCohort(1, 51)[0]!
      return [
        {
          ...base,
          id: 'sub-001',
          qc: 'pass',
          analysisEligible: true,
          unavailableReason: null,
          cells: base.cells.map((cell, index) => ({
            ...cell,
            st: states[index] ?? 'pending',
            rc: null,
            err: null,
          })),
          ...overrides,
        },
      ]
    }

    it('names cells and column headers by the visible column names', async () => {
      // A cell named "QC Sub (enigma.qc.subcort) for sub-101: done, ..." under
      // the visible header "Subcortical QC" would not contain its visible label
      // (WCAG 2.5.3).
      renderScreen({ subjects: oneSubject(['done', 'done']) })
      const table = await screen.findByRole('table', {
        name: 'Subjects matrix',
      })
      const headers = within(table).getAllByRole('columnheader')
      for (const [key, visible, machine] of [
        ['recon', 'Reconstruction', 'recon-all'],
        ['qcsub', 'Subcortical QC', 'enigma.qc.subcort'],
        ['qcic', 'Internal cortical QC', 'enigma.qc.intCort'],
        ['qcec', 'External cortical QC', 'enigma.qc.extCort'],
        ['feat', 'Feature extraction', 'features.extract'],
        ['pba', 'PyBrainAge', 'pybrainage.predict'],
        ['stats', 'Statistics', 'stats.glm'],
        ['agg', 'Aggregation', 'aggregate.cohort'],
        ['rep', 'Report', 'report.html'],
      ] as const) {
        const header = headers.find(
          (candidate) => candidate.getAttribute('aria-label') === visible,
        )
        if (!header) throw new Error(`Name the ${key} column ${visible}.`)
        // The visible header lines, read in order, are the name.
        expect(
          [...header.querySelectorAll('span')]
            .map((line) => line.textContent)
            .join(' '),
        ).toBe(visible)
        // The machine step stays in the tooltip, the header's description.
        expect(header.getAttribute('title')).toMatch(
          new RegExp(`^${visible}: .+\\nMachine step: ${machine}$`, 's'),
        )
      }

      const cell = screen.getByRole('button', {
        name: 'Subcortical QC for sub-001: done, This step finished successfully for this subject.',
      })
      expect(cell.getAttribute('title')).toContain(
        'Machine step: enigma.qc.subcort',
      )
      // The status glyph reads as it does in the Dashboard matrix.
      expect(
        within(cell).getByRole('img', { name: 'Subcortical QC: done' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', {
          name: 'Reconstruction for sub-001: done, This step finished successfully for this subject.',
        }),
      ).toBeInTheDocument()
      for (const code of ['QC Sub', 'enigma.qc.subcort']) {
        expect(
          screen.queryAllByRole('button', { name: new RegExp(code) }),
        ).toHaveLength(0)
      }

      fireEvent.click(cell)
      const actions = screen.getByRole('group', {
        name: 'Subcortical QC actions for sub-001',
      })
      expect(within(actions).getByText('Subcortical QC')).toBeInTheDocument()
      expect(within(actions).getByText('enigma.qc.subcort')).toBeInTheDocument()
    })

    it('states a done cell as a finished fact', async () => {
      renderScreen({ subjects: oneSubject(['done']) })
      const cell = await screen.findByRole('button', {
        name: /^Reconstruction for sub-001:/,
      })
      expect(cell.getAttribute('aria-label')).toMatch(
        /done, This step finished successfully for this subject\.$/,
      )
    })

    it('states a skipped cell without the dependency-check sentence', async () => {
      renderScreen({ subjects: oneSubject(['skipped']) })
      const cell = await screen.findByRole('button', {
        name: /^Reconstruction for sub-001:/,
      })
      const name = cell.getAttribute('aria-label') ?? ''
      // Only a stage turned off in the configuration leaves a skipped cell.
      expect(name).toContain(
        'This step is off in the project configuration, so it does not run for this subject.',
      )
      expect(name).not.toMatch(/dependency/i)
    })

    it('states a QC Fail exclusion in the row note and the checkbox name', async () => {
      renderScreen({
        subjects: oneSubject([], { qc: 'fail', analysisEligible: false }),
      })
      // The note is a short tag; its tooltip states the full reason.
      const tag = await screen.findByText('Excluded')
      expect(tag).toBeVisible()
      expect(tag).toHaveAttribute(
        'title',
        'Excluded from analysis: the QC verdict is Fail.',
      )
      expect(
        screen.queryByText('Excluded from analysis: the QC verdict is Fail.'),
      ).toBeNull()
      expect(
        screen.getByRole('checkbox', {
          name: 'Select sub-001. Excluded from analysis: the QC verdict is Fail.',
        }),
      ).toBeDisabled()
    })

    it('states a blocked cell tooltip as its fact, not the raw token', async () => {
      renderScreen({ subjects: oneSubject(['blocked']) })
      const cell = await screen.findByRole('button', {
        name: /^Reconstruction for sub-001:/,
      })
      const title = cell.getAttribute('title') ?? ''
      expect(title).toContain(
        'This step is blocked for this subject; Runs gives the reason.',
      )
      expect(title).not.toContain('Status blocked: blocked')
    })
  })

  describe('out-of-date cohort stages', () => {
    const COHORT_STAGES = [
      'enigma',
      'outliers',
      'features',
      'age',
      'pybrainage',
      'clinical',
      'brainpad',
      'aggregate',
      'final',
    ] as const
    const COHORT_COLUMNS = [
      'Subcortical QC',
      'Internal cortical QC',
      'External cortical QC',
      'Feature extraction',
      'PyBrainAge',
      'Statistics',
      'Aggregation',
      'Report',
    ]

    /** A subject whose every matrix cell and pipeline stage finished. */
    function finishedSubjects(count: number): Subject[] {
      return makeMockCohort(count, 61).map((subject) => ({
        ...subject,
        qc: 'pass' as const,
        analysisEligible: true,
        unavailableReason: null,
        cells: subject.cells.map((cell) => ({
          ...cell,
          st: 'done' as const,
          rc: 0,
          err: null,
        })),
        stepStates: {
          recon: 'done' as const,
          ...Object.fromEntries(COHORT_STAGES.map((key) => [key, 'done'])),
        },
      }))
    }

    function mockCurrency(state: 'current' | 'outdated'): SupraspinaApi {
      const api = createMockApi()
      vi.spyOn(api.results, 'list').mockResolvedValue({
        items: [],
        nextCursor: null,
        truncated: false,
        stageCurrency: {
          recon: { state: 'current', outdatedSubjectIds: [] },
          ...Object.fromEntries(
            COHORT_STAGES.map((key) => [
              key,
              {
                state,
                outdatedSubjectIds: [],
                cause: 'analysis-cohort' as const,
              },
            ]),
          ),
        },
        analysisCohortChange: { cause: 'membership' },
      })
      return api
    }

    function RouteProbe(): ReactNode {
      return <output data-testid="route-probe">{useApp().route}</output>
    }

    /**
     * Open Subjects on a filter, as a Dashboard count does. Opening the
     * project resets the filter, so set it once the project is open.
     */
    function FilterPreset({ filter }: { filter: SubjectFilter }): ReactNode {
      const { projectRef, setSubjectsFilter } = useApp()
      useLayoutEffect(() => {
        if (projectRef) setSubjectsFilter(filter)
      }, [filter, projectRef, setSubjectsFilter])
      return null
    }

    function renderWithCurrency(
      api: SupraspinaApi,
      subjects: Subject[],
      filter?: SubjectFilter,
    ): ReturnType<typeof render> {
      window.supraspina = api
      return render(
        <AppProvider>
          <ProjectBootstrap>
            {filter && <FilterPreset filter={filter} />}
            <SubjectsScreen subjects={subjects} />
            <RouteProbe />
          </ProjectBootstrap>
        </AppProvider>,
      )
    }

    /** Hold the next currency read until the returned function lands it. */
    function deferCurrency(api: SupraspinaApi): () => void {
      const landed = api.results.list({
        project: PROJECT,
        limit: 1,
      }) as ReturnType<SupraspinaApi['results']['list']>
      let land: () => void = () => undefined
      vi.mocked(api.results.list).mockReturnValueOnce(
        new Promise((resolve) => {
          land = () => resolve(landed)
        }),
      )
      return () => land()
    }

    const CHECKING_FACT =
      'Supraspina is checking which finished stages are out of date.'

    it('holds the Done and Out of date rows behind the checking fact until the read lands', async () => {
      const api = mockCurrency('outdated')
      const land = deferCurrency(api)
      renderWithCurrency(api, finishedSubjects(2))

      fireEvent.click(await screen.findByRole('radio', { name: 'Out of date' }))
      // The read may still move both subjects, so no row and no empty
      // fact shows, and the visible count waits as the filter count does.
      const held = screen.getByText(CHECKING_FACT)
      expect(held).not.toHaveAttribute('role')
      expect(held).not.toHaveAttribute('aria-live')
      expect(
        screen.queryByRole('table', { name: 'Subjects matrix' }),
      ).toBeNull()
      expect(screen.queryByText('No subjects are out of date.')).toBeNull()
      expect(screen.getByText('-- of 2')).toHaveAttribute(
        'title',
        CHECKING_FACT,
      )

      fireEvent.click(screen.getByRole('radio', { name: 'Done' }))
      expect(screen.getByText(CHECKING_FACT)).toBeInTheDocument()
      expect(
        screen.queryByRole('table', { name: 'Subjects matrix' }),
      ).toBeNull()
      expect(screen.queryByText('No subjects are done.')).toBeNull()

      // Every other filter lists its rows or states its fact as before.
      fireEvent.click(screen.getByRole('radio', { name: 'Pending 0' }))
      expect(screen.getByText('No subjects are pending.')).toBeInTheDocument()
      expect(screen.queryByText(CHECKING_FACT)).toBeNull()
      fireEvent.click(screen.getByRole('radio', { name: 'All 2' }))
      expect(
        screen.getByRole('table', { name: 'Subjects matrix' }),
      ).toHaveAttribute('aria-rowcount', '3')

      fireEvent.click(screen.getByRole('radio', { name: 'Out of date' }))
      expect(screen.getByText(CHECKING_FACT)).toBeInTheDocument()
      await act(async () => land())

      // The read lands: both subjects are out of date and none is done.
      expect(
        await screen.findByRole('table', { name: 'Subjects matrix' }),
      ).toHaveAttribute('aria-rowcount', '3')
      expect(screen.queryByText(CHECKING_FACT)).toBeNull()
      // Both subjects pass the filter, so no count shows.
      expect(screen.queryByText('2 of 2')).toBeNull()
      expect(screen.queryByText('-- of 2')).toBeNull()
      fireEvent.click(screen.getByRole('radio', { name: 'Done 0' }))
      expect(screen.getByText('No subjects are done.')).toBeInTheDocument()
    })

    it('states an empty Out of date filter opened from the Dashboard only after the read lands', async () => {
      const api = mockCurrency('current')
      const land = deferCurrency(api)
      renderWithCurrency(api, finishedSubjects(2), 'outdated')

      expect(await screen.findByText(CHECKING_FACT)).toBeInTheDocument()
      expect(
        screen.getByRole('radio', { name: 'Out of date', checked: true }),
      ).toBeInTheDocument()
      expect(screen.queryByText('No subjects are out of date.')).toBeNull()

      await act(async () => land())

      expect(
        await screen.findByText('No subjects are out of date.'),
      ).toBeInTheDocument()
      expect(screen.queryByText(CHECKING_FACT)).toBeNull()
      expect(screen.getByText('0 of 2')).toBeInTheDocument()
    })

    it('marks cohort cells out of date, counts no subject Done, and shows the notice', async () => {
      const api = mockCurrency('outdated')
      renderWithCurrency(api, finishedSubjects(2))

      const headline = await screen.findByText(
        '9 cohort stages are out of date for 2 subjects: the analysis cohort changed after they ran.',
      )
      for (const column of COHORT_COLUMNS) {
        const cell = screen.getByRole('button', {
          name: new RegExp(`^${column.replace(/[().]/g, '\\$&')} for sub-001:`),
        })
        expect(cell.getAttribute('aria-label')).toMatch(
          /: out of date, The analysis cohort changed after this step ran\. Run all reruns it\.$/,
        )
        expect(cell.getAttribute('title')).toContain(
          'Status out of date: The analysis cohort changed after this step ran.',
        )
      }
      expect(
        screen
          .getByRole('button', {
            name: /^Reconstruction for sub-001:/,
          })
          .getAttribute('aria-label'),
      ).toMatch(/: done, This step finished successfully for this subject\.$/)
      // The Dashboard counts these subjects Out of date; Subjects does not fold
      // them into Pending.
      expect(screen.getByRole('radio', { name: 'Done 0' })).toBeInTheDocument()
      expect(
        screen.getByRole('radio', { name: 'Out of date 2' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('radio', { name: 'Partly done 0' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('radio', { name: 'Pending 0' }),
      ).toBeInTheDocument()

      const notice = headline.closest('[role="status"]') as HTMLElement
      fireEvent.click(within(notice).getByRole('button', { name: 'Open Runs' }))
      expect(screen.getByTestId('route-probe')).toHaveTextContent('runs')
    })

    it('shows no Done or Out of date count until the currency read lands', async () => {
      const api = mockCurrency('outdated')
      const landed = api.results.list({
        project: PROJECT,
        limit: 1,
      }) as ReturnType<SupraspinaApi['results']['list']>
      let land: () => void = () => undefined
      vi.mocked(api.results.list).mockReturnValueOnce(
        new Promise((resolve) => {
          land = () => resolve(landed)
        }),
      )
      renderWithCurrency(api, finishedSubjects(2))

      // As on the Dashboard tiles, the two counts the read can change wait.
      expect(
        await screen.findByRole('radio', { name: 'Done' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('radio', { name: 'Out of date' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('radio', { name: 'Pending 0' }),
      ).toBeInTheDocument()
      expect(
        screen.getByText(
          '2 done or out of date, 0 partly done, 0 running, 0 failed, and 0 pending subjects. Supraspina is checking which finished stages are out of date.',
        ),
      ).toBeInTheDocument()

      await act(async () => land())
      expect(
        await screen.findByRole('radio', { name: 'Out of date 2' }),
      ).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: 'Done 0' })).toBeInTheDocument()
    })

    it('counts finished subjects Done and shows no notice while stages are current', async () => {
      const api = mockCurrency('current')
      renderWithCurrency(api, finishedSubjects(2))

      await waitFor(() => expect(api.results.list).toHaveBeenCalled())
      expect(
        await screen.findByRole('radio', { name: 'Done 2' }),
      ).toBeInTheDocument()
      // No notice and no out-of-date subject; the summary still lists the
      // empty Out of date bucket.
      expect(screen.queryByText(/(is|are) out of date/)).toBeNull()
      expect(
        screen.getByRole('radio', { name: 'Out of date 0' }),
      ).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Open Runs' })).toBeNull()
    })
  })
})

describe('SubjectsScreen sites', () => {
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    delete window.supraspina
  })

  /** A settled cohort: two controls without a site and SCI at Ingenia. */
  function siteCohort(sites: (string | null)[]): Subject[] {
    return makeMockCohort(sites.length, 23).map((subject, index) => ({
      ...allDone(subject),
      id: `sub-${String(index + 1).padStart(3, '0')}`,
      registered: true,
      analysisEligible: true,
      qc: 'pass',
      unavailableReason: null,
      cohort: index < 2 ? 'CTRL' : 'SCI_P',
      cohortRole: index < 2 ? 'healthy' : 'sci-neuropathic-pain',
      site: sites[index] ?? null,
    }))
  }

  async function renderSites(
    sites: (string | null)[],
  ): Promise<ReturnType<typeof createMockApi>> {
    const api = createMockApi()
    const cohort = siteCohort(sites)
    vi.spyOn(api.subjects, 'discover').mockResolvedValue(cohort)
    for (const subject of cohort) {
      await api.registry.upsert({
        project: PROJECT,
        record: {
          subjectId: subject.id,
          age: 40,
          sex: 'F',
          sourceCohortLabel: subject.cohort,
          ais: null,
          tSinceSci: null,
          site: subject.site ?? null,
        },
      })
    }
    renderProjectScreen(api)
    await screen.findByRole('table', { name: 'Subjects matrix' })
    return api
  }

  it('keeps the matrix without a Site column while no subject has a site', async () => {
    await renderSites([null, null, null])
    const table = screen.getByRole('table', { name: 'Subjects matrix' })
    expect(
      within(table).queryByRole('columnheader', { name: 'Site' }),
    ).toBeNull()
    expect(screen.queryByRole('group', { name: 'Sites' })).toBeNull()
  })

  it('shows the Site column and states the mixed and confound facts', async () => {
    await renderSites([null, null, 'Ingenia', 'Ingenia'])
    const table = screen.getByRole('table', { name: 'Subjects matrix' })
    expect(
      within(table).getByRole('columnheader', { name: 'Site' }),
    ).toBeInTheDocument()
    expect(table.querySelectorAll('[data-site="Ingenia"]')).toHaveLength(2)
    const sites = screen.getByRole('group', { name: 'Sites' })
    expect(sites).toHaveTextContent(
      'Site: Ingenia 2. 2 subjects have no site, and 2 do. Site Ingenia has no controls.',
    )
  })

  it('filters the rows by site and resets the filter with Show all', async () => {
    await renderSites([null, null, 'Ingenia', 'Prisma'])
    const table = screen.getByRole('table', { name: 'Subjects matrix' })
    const filter = screen.getByRole('radiogroup', {
      name: 'Filter subjects by site',
    })
    fireEvent.click(within(filter).getByRole('radio', { name: 'Ingenia' }))
    expect(within(table).getAllByRole('rowheader')).toHaveLength(1)
    expect(within(table).getByText('sub-003')).toBeInTheDocument()

    fireEvent.click(within(filter).getByRole('radio', { name: 'No site' }))
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['sub-001', 'sub-002'])

    fireEvent.change(
      screen.getByRole('textbox', { name: 'Filter subjects by ID' }),
      {
        target: { value: 'sub-004' },
      },
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Show all subjects' }),
    )
    expect(
      within(
        screen.getByRole('table', { name: 'Subjects matrix' }),
      ).getAllByRole('rowheader'),
    ).toHaveLength(4)
  })

  it('opens Set site with the subjects that have no site', async () => {
    await renderSites([null, null, 'Ingenia'])
    fireEvent.click(screen.getByRole('button', { name: 'Set site...' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Set site for 2 subjects',
    })
    expect(within(dialog).getByLabelText('Select sub-001')).toBeChecked()
    expect(within(dialog).getByLabelText('Select sub-003')).not.toBeChecked()
  })

  it('sets the site of a discovered subject that is not registered', async () => {
    // Set site lists discovered subjects too, so a new scan can get its site
    // before its demographics are registered.
    const api = createMockApi()
    const cohort = [
      ...siteCohort(['Prisma', 'Prisma']),
      {
        ...siteCohort([null])[0]!,
        id: 'sub-new',
        registered: false,
        cohort: 'UNKNOWN' as const,
        cohortRole: 'ambiguous' as const,
      },
    ]
    const discover = vi.spyOn(api.subjects, 'discover')
    discover.mockResolvedValue(cohort)
    for (const subject of cohort.slice(0, 2)) {
      await api.registry.upsert({
        project: PROJECT,
        record: {
          subjectId: subject.id,
          age: 40,
          sex: 'F',
          sourceCohortLabel: 'CTRL',
          ais: null,
          tSinceSci: null,
          site: subject.site ?? null,
        },
      })
    }
    const setSite = vi.spyOn(api.registry, 'setSite')
    renderProjectScreen(api)
    await screen.findByRole('table', { name: 'Subjects matrix' })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select sub-new' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set site...' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Set site for 1 subject',
    })
    expect(within(dialog).getByText('Not registered')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        '1 of the selected subjects is not registered; the site is held until registration.',
      ),
    ).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Site'), {
      target: { value: 'Ingenia' },
    })
    discover.mockResolvedValue(
      cohort.map((subject) =>
        subject.id === 'sub-new' ? { ...subject, site: 'Ingenia' } : subject,
      ),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set site' }))

    await waitFor(() => expect(setSite).toHaveBeenCalledTimes(1))
    expect(setSite.mock.calls[0]?.[0]).toEqual({
      project: PROJECT,
      subjectIds: ['sub-new'],
      site: 'Ingenia',
      expectedRevisions: { 'sub-new': 0 },
    })
    await waitFor(() =>
      expect(
        screen
          .getByRole('table', { name: 'Subjects matrix' })
          .querySelector('[data-site="Ingenia"]'),
      ).toHaveAttribute(
        'title',
        'Site: Ingenia, held until the subject is registered.',
      ),
    )
    // The summary counts registered subjects, as planning does, and states the
    // held site apart.
    expect(screen.getByRole('group', { name: 'Sites' })).toHaveTextContent(
      'Site: Prisma 2. The site of 1 unregistered subject is held until registration.',
    )
  })

  // A cohort whose subjects from the third on are discovered, not
  // registered, and hold the site Ingenia.
  function heldCohort(sites: (string | null)[]): Subject[] {
    return siteCohort(sites).map((subject, index) =>
      index < 2 ? subject : { ...subject, registered: false, site: 'Ingenia' },
    )
  }

  it('states held sites beside the site counts', async () => {
    // The summary mentions the held sites the rows show, not only registered
    // sites.
    const api = createMockApi()
    vi.spyOn(api.subjects, 'discover').mockResolvedValue(
      heldCohort(['Prisma', 'Prisma', null, null]),
    )
    renderProjectScreen(api)
    await screen.findByRole('table', { name: 'Subjects matrix' })
    expect(screen.getByRole('group', { name: 'Sites' })).toHaveTextContent(
      'Site: Prisma 2. The sites of 2 unregistered subjects are held until registration.',
    )
  })

  it('shows held sites while no registered subject has a site', async () => {
    // A held site shows the strip and the Site column even when no registered
    // subject has a site.
    const api = createMockApi()
    vi.spyOn(api.subjects, 'discover').mockResolvedValue(
      heldCohort([null, null, null, null]),
    )
    renderProjectScreen(api)
    const table = await screen.findByRole('table', { name: 'Subjects matrix' })
    expect(
      within(table).getByRole('columnheader', { name: 'Site' }),
    ).toBeInTheDocument()
    expect(table.querySelectorAll('[data-site="Ingenia"]')).toHaveLength(2)
    const sites = screen.getByRole('group', { name: 'Sites' })
    expect(sites).toHaveTextContent(
      'The sites of 2 unregistered subjects are held until registration.',
    )
    expect(sites).not.toHaveTextContent('Site:')
  })

  it('opens Set site with the selected subjects and rediscovers after it', async () => {
    const api = await renderSites(['Prisma', 'Prisma', 'Ingenia'])
    const discover = vi.mocked(api.subjects.discover)
    const reads = discover.mock.calls.length
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select sub-003' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set site...' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Set site for 1 subject',
    })
    fireEvent.change(within(dialog).getByLabelText('Site'), {
      target: { value: 'Prisma' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set site' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(discover.mock.calls.length).toBeGreaterThan(reads),
    )
  })
  it('updates the site summary from the write before rediscovery answers', async () => {
    // The rediscovery that follows the write can take about 18 s, so the Sites
    // summary counts the written site at once.
    const api = createMockApi()
    const cohort = siteCohort(['Prisma', 'Prisma', 'Ingenia'])
    for (const subject of cohort) {
      await api.registry.upsert({
        project: PROJECT,
        record: {
          subjectId: subject.id,
          age: 40,
          sex: 'F',
          sourceCohortLabel: subject.cohort,
          ais: null,
          tSinceSci: null,
          site: subject.site ?? null,
        },
      })
    }
    let held = false
    const discover = vi
      .spyOn(api.subjects, 'discover')
      .mockImplementation(() =>
        held
          ? new Promise<Subject[]>(() => undefined)
          : Promise.resolve(cohort),
      )
    window.supraspina = api
    function ShellSubjects(): ReactNode {
      const app = useApp()
      return (
        <SubjectsScreen subjects={app.subjects} refresh={app.refreshSubjects} />
      )
    }
    render(
      <AppProvider>
        <ProjectBootstrap>
          <ShellSubjects />
        </ProjectBootstrap>
      </AppProvider>,
    )
    const sites = await screen.findByRole('group', { name: 'Sites' })
    expect(sites).toHaveTextContent('Ingenia 1')
    held = true
    const reads = discover.mock.calls.length

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select sub-003' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set site...' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Set site for 1 subject',
    })
    fireEvent.change(within(dialog).getByLabelText('Site'), {
      target: { value: 'Prisma' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set site' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(discover.mock.calls.length).toBeGreaterThan(reads),
    )

    // The rediscovery is still in flight; the summary already counts the
    // written site.
    const table = screen.getByRole('table', { name: 'Subjects matrix' })
    expect(table.querySelectorAll('[data-site="Prisma"]')).toHaveLength(3)
    expect(table.querySelectorAll('[data-site="Ingenia"]')).toHaveLength(0)
    expect(screen.getByRole('group', { name: 'Sites' })).not.toHaveTextContent(
      'Ingenia',
    )
  })
})
