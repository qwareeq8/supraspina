// @vitest-environment jsdom

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ResultArtifact, ResultPage } from '../../shared/contract'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { RunManifest } from '../../shared/types'
import { createMockApi } from '../ipc/mock'
import { AppProvider, useApp } from '../state/context'
import {
  manifestRunLabel,
  manifestRunPhrase,
  runTimestampLabel,
} from '../state/run-label'
import { TEXT_GAP } from '../ui/text-gap'
import { ResultsScreen, type ResultsScreenProps } from './ResultsScreen'

const PROJECT = {
  projectId: 'results-project',
  root: '/projects/results',
  configPath: '/projects/results/supraspina.project.json',
  epoch: 1,
}
const PROJECT_CONFIG = {
  ...DEFAULT_PROJECT_CONFIG,
  paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: PROJECT.root },
}
// Busy label of the manual Load more button. One test pins it while a page
// loads and another asserts its absence, so a rename breaks the first
// instead of silently disarming the second.
const LOADING_MORE_LABEL = 'Loading more artifacts...'

function Bootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  const booted = useRef(false)
  useLayoutEffect(() => {
    if (!booted.current) {
      booted.current = true
      app.markProjectCreated({
        project: PROJECT,
        cfg: PROJECT_CONFIG,
        configSha256: '0'.repeat(64),
      })
    }
  }, [app])
  return children
}

function RouteProbe(): ReactNode {
  const { route } = useApp()
  return <output data-testid="route-probe">{route}</output>
}

function renderScreen(
  api = createMockApi(),
  props: ResultsScreenProps = {},
  sibling?: ReactNode,
): ReturnType<typeof render> {
  window.supraspina = api
  return render(
    <AppProvider>
      <Bootstrap>
        <ResultsScreen {...props} />
        {sibling}
      </Bootstrap>
    </AppProvider>,
  )
}

function artifact(overrides: Partial<ResultArtifact> = {}): ResultArtifact {
  return {
    artifactId: 'artifact:features:sub-001',
    label: 'Subject features',
    stepKey: 'features',
    subjectId: 'sub-001',
    kind: 'csv',
    presence: 'produced',
    displayPath: 'outputs/features/sub-001.csv',
    exists: true,
    openable: true,
    revealable: true,
    runId: 'run-1',
    producerNodeId: 'node-1',
    receiptSha256: 'a'.repeat(64),
    provenance: 'current',
    ...overrides,
  }
}

/** Build one contiguous slice of a larger detector inventory. */
function inventory(
  offset: number,
  count: number,
  { missing = 0, stale = 0 }: { missing?: number; stale?: number } = {},
): ResultArtifact[] {
  return Array.from({ length: count }, (_unused, index) =>
    artifact({
      artifactId: `artifact:row-${offset + index}`,
      label: `Artifact ${offset + index + 1}`,
      ...(index < missing
        ? { presence: 'absent' as const, exists: false }
        : {}),
      ...(index < stale ? { provenance: 'stale' as const } : {}),
    }),
  )
}

function manifest(
  runId: string,
  startedAt = '2026-07-31T12:00:00.000Z',
): RunManifest {
  return {
    runId,
    startedAt,
    endedAt: '2026-07-31T12:05:00.000Z',
    user: '[REDACTED]',
    host: '[REDACTED]',
    git: { repo: '', sha: '', dirty: false },
    configSha256: '0'.repeat(64),
    steps: [],
    tools: {},
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete window.supraspina
})

describe('ResultsScreen detector inventory', () => {
  it('renders an honest empty state when the detector returns no artifacts', async () => {
    renderScreen(createMockApi(), {}, <RouteProbe />)
    // The title states the fact; the hint and Open Runs carry the remedy.
    expect(await screen.findByText('No output files yet.')).toBeInTheDocument()
    expect(
      screen.getByText('Run the workflow from Runs to produce them.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/CSV tables/i)).not.toBeInTheDocument()
    // The filter row carries no card title and no standing hints.
    expect(screen.queryByText('Inventory scope')).toBeNull()
    expect(
      screen.queryByText(/Shows the latest durable run|Limits the list/),
    ).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open Runs' }))
    expect(screen.getByTestId('route-probe')).toHaveTextContent('runs')
  })

  it('selects an explicit historical run and reloads that detector inventory', async () => {
    const api = createMockApi()
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: [manifest('run-latest'), manifest('run-historical', '2026-07-01')],
      nextCursor: null,
    })
    const list = vi.spyOn(api.results, 'list').mockImplementation((request) =>
      Promise.resolve({
        items: [
          artifact({
            artifactId: `artifact:${request.runId ?? 'latest'}`,
            label:
              request.runId === 'run-historical'
                ? 'Historical artifact'
                : 'Latest artifact',
          }),
        ],
        nextCursor: null,
        truncated: false,
        runId: request.runId ?? 'run-latest',
        total: 1,
      }),
    )
    renderScreen(api)

    expect(await screen.findByText('Latest artifact')).toBeVisible()
    const runPicker = screen.getByLabelText('Run')
    // The default latest run needs no tooltip naming it.
    expect(
      within(runPicker).getByRole('option', { name: 'Latest run' }),
    ).toBeInTheDocument()
    expect(runPicker).not.toHaveAttribute('title')
    fireEvent.change(runPicker, {
      target: { value: 'run-historical' },
    })

    expect(await screen.findByText('Historical artifact')).toBeVisible()
    expect(list).toHaveBeenLastCalledWith({
      project: PROJECT,
      runId: 'run-historical',
      limit: 500,
    })
    const historicalManifest = manifest('run-historical', '2026-07-01')
    // A chosen run is named only in the picker's tooltip.
    await waitFor(() =>
      expect(runPicker).toHaveAttribute(
        'title',
        `Shows the ${manifestRunPhrase(historicalManifest)}.`,
      ),
    )
    expect(
      screen.queryByText(`Shows the ${manifestRunPhrase(historicalManifest)}.`),
    ).toBeNull()
    expect(
      within(runPicker).getByRole('option', {
        name: manifestRunLabel(historicalManifest),
      }),
    ).toBeInTheDocument()
    expect(within(runPicker).queryByText(/run-historical/)).toBeNull()
    expect(runPicker.getAttribute('title')).not.toContain('run-historical')
  })

  it('passes stage and artifact search filters to the bounded inventory', async () => {
    const api = createMockApi()
    const list = vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      total: 0,
    })
    renderScreen(api)
    await screen.findByText('No output files yet.')

    const search = screen.getByLabelText('Search')
    expect(search).toHaveAttribute('placeholder', 'Subject, stage, or label')
    // The matching rule sits in the input's tooltip, not in a standing hint.
    expect(search.closest('[title]')).toHaveAttribute(
      'title',
      'Each search term must match the label, stage, subject, path, type, state, run, or producer.',
    )
    expect(screen.queryByText(/Each search term must match/)).toBeNull()

    fireEvent.change(screen.getByLabelText('Stage'), {
      target: { value: 'enigma' },
    })
    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'sub-0049 cortical QC' },
    })

    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        project: PROJECT,
        limit: 500,
        stepKey: 'enigma',
        query: 'sub-0049 cortical QC',
      }),
    )
    // The title names both filters as a fact, and the remedy stays in the
    // hint and the Clear filters action.
    expect(
      screen.getByText(
        'No artifacts match the stage "ENIGMA QC" and the search "sub-0049 cortical QC".',
      ),
    ).toBeVisible()
    expect(screen.getByText('Change the stage or search terms.')).toBeVisible()
    expect(screen.queryByText(/^Change the filters/)).toBeNull()

    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: '' },
    })
    expect(
      await screen.findByText('No artifacts match the stage "ENIGMA QC".'),
    ).toBeVisible()

    fireEvent.change(screen.getByLabelText('Stage'), {
      target: { value: 'all' },
    })
    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'zz99x' },
    })
    expect(
      await screen.findByText('No artifacts match the search "zz99x".'),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByText('No output files yet.')).toBeVisible()
    expect(screen.getByLabelText('Search')).toHaveValue('')
  })

  it('preserves produced and absent detector states without filesystem probing', async () => {
    const api = createMockApi()
    const list = vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact(),
        artifact({
          artifactId: 'artifact:missing',
          label: 'Missing report',
          kind: 'html',
          presence: 'absent',
          exists: false,
          openable: false,
          revealable: false,
          provenance: 'unknown',
          receiptSha256: null,
        }),
      ],
      nextCursor: null,
      truncated: false,
    })
    renderScreen(api)

    expect(await screen.findByText('Subject features')).toBeInTheDocument()
    expect(screen.getByText('Missing report')).toBeInTheDocument()
    // One page holds the whole inventory, so the summary omits the range.
    expect(screen.getByText('1 produced, 1 missing')).toBeInTheDocument()
    expect(screen.queryByText(/showing|1-2 of 2/)).toBeNull()
    expect(list).toHaveBeenCalledWith({ project: PROJECT, limit: 500 })
    // The header stamps the load with the shared freshness stamp.
    expect(screen.getByText(/^Last updated /)).toHaveAttribute(
      'aria-live',
      'polite',
    )
    expect(screen.getByText('No file is selected.')).toBeVisible()
    expect(screen.getByText('Select a file to preview it.')).toBeVisible()

    fireEvent.click(screen.getByText('Missing report'))
    expect(
      screen.getByText(/detector reports this artifact as absent/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled()
  })

  it('names the cohort stages new QC verdicts put out of date and keeps row provenance', async () => {
    // After new QC verdicts the ENIGMA QC artifacts state that they were
    // computed under the old QC state.
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({
          artifactId: 'artifact:enigma:gallery',
          label: 'Subcortical QC gallery',
          stepKey: 'enigma',
          subjectId: null,
          kind: 'html',
        }),
      ],
      nextCursor: null,
      truncated: false,
      stageCurrency: {
        enigma: {
          state: 'outdated',
          outdatedSubjectIds: [],
          cause: 'analysis-cohort',
        },
        brainpad: {
          state: 'outdated',
          outdatedSubjectIds: [],
          cause: 'analysis-cohort',
        },
        final: { state: 'outdated', outdatedSubjectIds: [] },
        recon: { state: 'current', outdatedSubjectIds: [] },
      },
      analysisCohortChange: { cause: 'membership' },
    })
    renderScreen(api)

    const headline = await screen.findByText(
      '2 cohort stages are out of date: the analysis cohort changed after they ran.',
    )
    expect(headline.closest('[role="status"]')).toHaveTextContent(
      'Run all reruns ENIGMA QC and Brain-PAD statistics. Provenance below still describes the cohort this run recorded.',
    )
    fireEvent.click(screen.getByText('Subcortical QC gallery'))
    expect(
      await screen.findByLabelText('Provenance: Current'),
    ).toBeInTheDocument()
  })

  it('shows no cohort notice without an analysis-cohort change', async () => {
    const api = createMockApi()
    const list = vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [artifact()],
      nextCursor: null,
      truncated: false,
      stageCurrency: {
        final: { state: 'outdated', outdatedSubjectIds: [] },
      },
      analysisCohortChange: null,
    })
    renderScreen(api)

    expect(await screen.findByText('Subject features')).toBeInTheDocument()
    expect(list).toHaveBeenCalled()
    expect(screen.queryByText(/out of date/)).toBeNull()
  })

  it('names every presence bucket so the summary adds up to the total', async () => {
    // Optional defacing is off in the default configuration.
    expect(PROJECT_CONFIG.steps.deface.enabled).toBe(false)
    const notProduced = {
      presence: 'expected' as const,
      exists: false,
      openable: false,
      revealable: false,
      runId: null,
      producerNodeId: null,
      receiptSha256: null,
      provenance: 'unknown' as const,
    }
    const defaced = (subjectId: string): ResultArtifact =>
      artifact({
        ...notProduced,
        artifactId: `artifact:deface:${subjectId}`,
        label: `Defaced T1w ${subjectId}`,
        stepKey: 'deface',
        subjectId,
        kind: 'nii',
        displayPath: `derivatives/defaced/${subjectId}/anat/${subjectId}_T1w.nii.gz`,
      })
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact(),
        artifact({
          artifactId: 'artifact:stale',
          label: 'Stale features',
          provenance: 'stale',
        }),
        artifact({
          ...notProduced,
          artifactId: 'artifact:expected',
          label: 'Queued features',
        }),
        defaced('sub-001'),
        defaced('sub-002'),
      ],
      nextCursor: null,
      truncated: false,
      total: 5,
    })
    renderScreen(api)

    const summary = await screen.findByText(
      '2 produced, 1 expected, 2 not produced (stage off) 1 with stale provenance',
    )
    // The presence buckets partition the rows; stale provenance overlaps them.
    const buckets = (summary.textContent ?? '').split(TEXT_GAP)[0] ?? ''
    const named = [...buckets.matchAll(/(\d+) /g)].map((match) =>
      Number(match[1]),
    )
    expect(named.reduce((sum, count) => sum + count, 0)).toBe(5)

    const artifacts = screen.getByRole('region', { name: 'Output files' })
    expect(within(artifacts).getAllByText('Stage off')).toHaveLength(2)
    expect(within(artifacts).getAllByText('Expected')).toHaveLength(1)

    fireEvent.click(screen.getByText('Defaced T1w sub-001'))
    expect(
      screen.getByText(
        'Optional defacing is off in the project configuration, so this artifact is not produced. Turn the stage on to produce it.',
      ),
    ).toBeVisible()
    expect(screen.queryByText(/detector reports this artifact/)).toBeNull()

    fireEvent.click(screen.getByText('Queued features'))
    expect(
      screen.getByText(/detector reports this artifact as expected/),
    ).toBeVisible()
  })

  it('explains unknown provenance from the receipt the inspected run holds', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({ artifactId: 'artifact:current', label: 'Current table' }),
        artifact({
          artifactId: 'artifact:enigma:gallery',
          label: 'Subcortical gallery',
          stepKey: 'enigma',
          subjectId: null,
          kind: 'dir',
          runId: null,
          producerNodeId: null,
          receiptSha256: null,
          provenance: 'unknown',
        }),
        artifact({
          artifactId: 'artifact:unjudged',
          label: 'Unjudged table',
          provenance: 'unknown',
        }),
        artifact({
          artifactId: 'artifact:recon:sub-001',
          label: 'Running surfaces',
          stepKey: 'recon',
          kind: 'dir',
          presence: 'partial',
          receiptSha256: null,
          provenance: 'unknown',
        }),
        artifact({
          artifactId: 'artifact:expected',
          label: 'Queued table',
          presence: 'expected',
          exists: false,
          openable: false,
          revealable: false,
          runId: null,
          producerNodeId: null,
          receiptSha256: null,
          provenance: 'unknown',
        }),
      ],
      nextCursor: null,
      truncated: false,
    })
    renderScreen(api)

    fireEvent.click(await screen.findByText('Current table'))
    expect(screen.queryByText(/provenance receipt for this output/)).toBeNull()

    fireEvent.click(screen.getByText('Subcortical gallery'))
    expect(screen.getByLabelText('Provenance: Unknown')).toBeVisible()
    expect(
      screen.getByText(
        'This run holds no provenance receipt for this output, so another run or a process outside Supraspina produced it. Choose the producing run in Run to see its receipt.',
      ),
    ).toBeVisible()

    fireEvent.click(screen.getByText('Unjudged table'))
    expect(
      screen.getByText(
        "This run holds a provenance receipt for this output, but its currentness could not be judged against this run's configuration and cohort.",
      ),
    ).toBeVisible()

    // A job in this run names it as the producer before its receipt exists.
    fireEvent.click(screen.getByText('Running surfaces'))
    expect(
      screen.getByText(
        'This run holds no provenance receipt for this output yet. The receipt is recorded when its job finishes successfully.',
      ),
    ).toBeVisible()

    fireEvent.click(screen.getByText('Queued table'))
    expect(
      screen.getByText(
        'This run holds no provenance receipt for this output because the run did not produce it.',
      ),
    ).toBeVisible()
  })

  it('renders malicious HTML only as inert source text', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({
          artifactId: 'artifact:html',
          label: 'QC report',
          kind: 'html',
        }),
      ],
      nextCursor: null,
      truncated: false,
    })
    const payload =
      '<script>window.pwned=true</script><img src="file:///secret">'
    const readText = vi
      .spyOn(api.artifact, 'readText')
      .mockResolvedValue({ text: payload, truncated: false })
    renderScreen(api)

    fireEvent.click(await screen.findByText('QC report'))
    const preview = await screen.findByLabelText('Inert HTML source preview')
    expect(preview).toHaveTextContent(payload)
    expect(document.querySelector('iframe')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    expect((window as typeof window & { pwned?: boolean }).pwned).not.toBe(true)
    expect(readText).toHaveBeenCalledWith({
      project: PROJECT,
      artifactId: 'artifact:html',
      maxBytes: 512 * 1024,
    })
  })

  it('previews images only through an opaque artifact identity and data URL', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({
          artifactId: 'artifact:image',
          label: 'QC montage',
          kind: 'png',
        }),
      ],
      nextCursor: null,
      truncated: false,
    })
    const previewImage = vi
      .spyOn(api.artifact, 'previewImage')
      .mockResolvedValue({
        dataUrl: 'data:image/png;base64,AA==',
        mimeType: 'image/png',
        truncated: true,
      })
    renderScreen(api)

    fireEvent.click(await screen.findByText('QC montage'))
    const image = await screen.findByRole('img', {
      name: /Preview of QC montage/i,
    })
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AA==')
    expect(
      screen.getByText(/The host downsampled or truncated this preview\./),
    ).toBeInTheDocument()
    expect(previewImage).toHaveBeenCalledWith({
      project: PROJECT,
      artifactId: 'artifact:image',
      maxBytes: 8 * 1024 * 1024,
    })
  })

  it('follows detector cursors on its own and de-duplicates artifact IDs', async () => {
    const api = createMockApi()
    const list = vi
      .spyOn(api.results, 'list')
      .mockResolvedValueOnce({
        items: [artifact()],
        nextCursor: 'next',
        truncated: true,
        total: 2,
      })
      .mockResolvedValueOnce({
        items: [
          artifact(),
          artifact({ artifactId: 'artifact:second', label: 'Second artifact' }),
        ],
        nextCursor: null,
        truncated: false,
        total: 2,
      })
    renderScreen(api)

    expect(await screen.findByText('Second artifact')).toBeInTheDocument()
    expect(screen.getAllByText('Subject features')).toHaveLength(1)
    expect(list).toHaveBeenLastCalledWith({
      project: PROJECT,
      limit: 500,
      cursor: 'next',
    })
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('shows a busy skeleton and inventory progress while results load', async () => {
    const api = createMockApi()
    let resolvePage!: (page: ResultPage) => void
    // Hold the continuation open so the sweep stays in its counting state.
    const list = vi
      .spyOn(api.results, 'list')
      .mockReturnValueOnce(
        new Promise<ResultPage>((resolve) => {
          resolvePage = resolve
        }),
      )
      .mockReturnValue(new Promise<ResultPage>(() => undefined))
    renderScreen(api)

    const region = await screen.findByRole('region', { name: 'Output files' })
    expect(region).toHaveAttribute('aria-busy', 'true')
    expect(within(region).getByText('Loading results...')).toBeVisible()
    const indeterminate = within(region).getByRole('progressbar')
    expect(indeterminate).not.toHaveAttribute('aria-valuenow')

    resolvePage({
      items: [artifact()],
      nextCursor: 'next',
      truncated: false,
      total: 3,
    })

    expect(await screen.findByText('Subject features')).toBeVisible()
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '1',
      ),
    )
    // Read as in progress while the detector cursor is still set.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(
      screen.getByText(
        'Counting the rest of the inventory: 1 of 3 artifacts so far...',
      ),
    ).toBeVisible()
    expect(
      screen.getByText('1 of 3 counted so far: 1 produced 1-1 of 3'),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(
      screen.queryByRole('button', { name: LOADING_MORE_LABEL }),
    ).toBeNull()
  })

  it('labels each run by its window, terminal status, intent, and scope', async () => {
    const api = createMockApi()
    const blocked: RunManifest = {
      ...manifest('run-blocked'),
      intent: 'workflow',
      selectedSubset: { subjectIds: ['sub-001'], sha256: '0'.repeat(64) },
      steps: [
        {
          id: 1,
          key: 'recon',
          status: 'blocked',
          subjects: 1,
          failed: 0,
          durationSec: 0,
        },
      ],
    }
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: [blocked],
      nextCursor: null,
    })
    renderScreen(api)

    const picker = await screen.findByLabelText('Run')
    const option = within(picker).getByRole('option', {
      name: manifestRunLabel(blocked),
    })
    const label = option.textContent ?? ''
    expect(label).toBe(
      `${runTimestampLabel('2026-07-31T12:00:00.000Z')} to ${runTimestampLabel(
        '2026-07-31T12:05:00.000Z',
      )}${TEXT_GAP}blocked${TEXT_GAP}workflow${TEXT_GAP}1 subject`,
    )
    expect(label).not.toContain('run-blocked')
  })

  it('counts the whole filtered inventory and renders one bounded page', async () => {
    const api = createMockApi()
    const first = inventory(0, 150, { missing: 10, stale: 3 })
    let resolveRest!: (page: ResultPage) => void
    const list = vi
      .spyOn(api.results, 'list')
      .mockResolvedValueOnce({
        items: first,
        nextCursor: 'next',
        truncated: false,
        total: 250,
      })
      .mockReturnValueOnce(
        new Promise<ResultPage>((resolve) => {
          resolveRest = resolve
        }),
      )
    renderScreen(api)

    // Report the counted share honestly while the sweep is still running.
    expect(
      await screen.findByText(
        '150 of 250 counted so far: 140 produced, 10 missing 3 with stale provenance 1-100 of 250',
      ),
    ).toBeVisible()
    const artifacts = screen.getByRole('region', { name: 'Output files' })
    // Count the rendered rows without a role query: resolving the role and
    // visibility of 100 buttons costs more than rendering them.
    expect(artifacts.querySelectorAll('button')).toHaveLength(100)
    expect(screen.queryByText('Artifact 101')).toBeNull()

    resolveRest({
      items: inventory(150, 100, { missing: 5, stale: 1 }),
      nextCursor: null,
      truncated: false,
      total: 250,
    })

    expect(
      await screen.findByText(
        '235 produced, 15 missing 4 with stale provenance 1-100 of 250',
      ),
    ).toBeVisible()
    expect(list).toHaveBeenCalledTimes(2)
    const pageStatus = screen.getByText('Page 1 of 3')
    expect(pageStatus).toBeVisible()
    // Counts and page states are prose, so they read in sans.
    expect(pageStatus.style.fontFamily).toContain('WebCM Sans 10')
    expect(
      screen.getByText(
        '235 produced, 15 missing 4 with stale provenance 1-100 of 250',
      ).style.fontFamily,
    ).toContain('WebCM Sans 10')
    // Find the page buttons inside the pager: a screen-wide query names every
    // artifact button first.
    const pager = within(pageStatus.parentElement as HTMLElement)

    fireEvent.click(pager.getByRole('button', { name: 'Next page' }))
    expect(screen.getByText('Artifact 101')).toBeVisible()
    expect(screen.queryByText('Artifact 100')).toBeNull()
    expect(
      screen.getByText(
        '235 produced, 15 missing 4 with stale provenance 101-200 of 250',
      ),
    ).toBeVisible()
    expect(artifacts.querySelectorAll('button')).toHaveLength(100)

    fireEvent.click(pager.getByRole('button', { name: 'Previous page' }))
    expect(screen.getByText('Artifact 1')).toBeVisible()
  })

  it('bounds the automatic sweep and offers the rest through Load more', async () => {
    const api = createMockApi()
    const list = vi.spyOn(api.results, 'list').mockImplementation((request) =>
      // Hold the manual page open so the busy button label stays on screen.
      request.cursor === '11'
        ? new Promise<ResultPage>(() => undefined)
        : Promise.resolve({
            items: [
              artifact({
                artifactId: `artifact:${request.cursor ?? 'first'}`,
                label: `Artifact ${request.cursor ?? 'first'}`,
              }),
            ],
            nextCursor: String(Number(request.cursor ?? 0) + 1),
            truncated: false,
            total: 9_999,
          }),
    )
    renderScreen(api)

    // Stop after the initial page plus the ten continuations the budget allows.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(11))
    const loadMore = await screen.findByRole('button', { name: 'Load more' })
    expect(list).toHaveBeenCalledTimes(11)
    expect(
      screen.getByText(
        'Counting paused at 11 of 9999 artifacts to limit detector load. Load more counts up to 500 more.',
      ),
    ).toBeVisible()
    expect(
      screen.getByText('11 of 9999 counted: 11 produced 1-11 of 9999'),
    ).toBeVisible()

    fireEvent.click(loadMore)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(12))
    expect(
      await screen.findByRole('button', { name: LOADING_MORE_LABEL }),
    ).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('drops a late detector response after the project is closed', async () => {
    const api = createMockApi()
    let resolvePage!: (page: ResultPage) => void
    vi.spyOn(api.results, 'list').mockReturnValue(
      new Promise<ResultPage>((resolve) => {
        resolvePage = resolve
      }),
    )
    function CloseProbe(): ReactNode {
      const app = useApp()
      return (
        <button onClick={() => void app.newProject()}>close project</button>
      )
    }
    window.supraspina = api
    render(
      <AppProvider>
        <Bootstrap>
          <CloseProbe />
          <ResultsScreen />
        </Bootstrap>
      </AppProvider>,
    )
    await waitFor(() => expect(api.results.list).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'close project' }))
    await screen.findByText('No project is open.')
    expect(
      screen.getByText('Open a project to see its output files.'),
    ).toBeInTheDocument()
    resolvePage({
      items: [artifact({ label: 'Late artifact' })],
      nextCursor: null,
      truncated: false,
    })
    await Promise.resolve()
    expect(screen.queryByText('Late artifact')).not.toBeInTheDocument()
  })

  it('surfaces detector failures, retries, and uses the safe fallback for non-Error failures', async () => {
    const api = createMockApi()
    const refresh = vi.fn()
    const list = vi
      .spyOn(api.results, 'list')
      .mockRejectedValueOnce(new Error('detector service unavailable'))
      .mockResolvedValueOnce({ items: [], nextCursor: null, truncated: false })
      .mockRejectedValueOnce('transport rejected')
    renderScreen(api, { refresh })

    expect(
      await screen.findByText('detector service unavailable'),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'detector service unavailable',
    )
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(await screen.findByText('No output files yet.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh results' }))
    expect(refresh).toHaveBeenCalledOnce()
    expect(await screen.findByText('Retry loading artifacts.')).toBeVisible()
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('renders every detector presence and auto-focuses an unsupported cohort artifact', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({
          artifactId: 'artifact:partial',
          label: 'Partial output',
          presence: 'partial',
        }),
        artifact({
          artifactId: 'artifact:expected',
          label: 'Expected output',
          presence: 'expected',
        }),
        artifact({
          artifactId: 'artifact:unknown',
          label: 'Unknown output',
          presence: 'unknown',
        }),
        artifact({
          artifactId: 'artifact:cohort-folder',
          label: 'Final cohort folder',
          stepKey: 'final',
          subjectId: null,
          kind: 'dir',
          runId: null,
          receiptSha256: null,
          detail: 'Use the authoritative cohort to generate this artifact.',
        }),
      ],
      nextCursor: null,
      truncated: false,
    })
    const open = vi.spyOn(api.artifact, 'open')
    const reveal = vi.spyOn(api.artifact, 'reveal')
    renderScreen(api, { focusStepKey: 'final' })

    expect(await screen.findAllByText('Final cohort folder')).toHaveLength(2)
    expect(api.results.list).toHaveBeenCalledWith({
      project: PROJECT,
      limit: 500,
      stepKey: 'final',
    })
    expect(screen.getAllByText('Partial').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Expected').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0)
    expect(
      screen.getByText('1 produced, 1 partial, 1 expected, 1 unknown'),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Use the authoritative cohort to generate this artifact.',
      ),
    ).toBeVisible()
    expect(screen.getAllByText('cohort').length).toBeGreaterThan(0)
    const identifiersSummary = screen.getByText('Producer identifiers')
    expect(identifiersSummary).toBeVisible()
    for (const hidden of screen.getAllByText('not recorded')) {
      expect(hidden).not.toBeVisible()
    }
    expect(screen.getByText('node-1')).not.toBeVisible()
    fireEvent.click(identifiersSummary)
    expect(screen.getAllByText('not recorded')).toHaveLength(2)
    for (const shown of screen.getAllByText('not recorded')) {
      expect(shown).toBeVisible()
    }
    expect(screen.getByText('node-1')).toBeVisible()
    expect(
      await screen.findByText(/has no embedded preview/i),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(open).toHaveBeenCalledWith({
      project: PROJECT,
      artifactId: 'artifact:cohort-folder',
    })
    expect(reveal).toHaveBeenCalledWith({
      project: PROJECT,
      artifactId: 'artifact:cohort-folder',
    })
  })

  it('states which subjects a cohort stage computed and reused', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({
          artifactId: 'artifact:enigma-gallery',
          label: 'ENIGMA subcortical gallery',
          stepKey: 'enigma',
          subjectId: null,
          provenanceDetails: {
            receipt: {
              receiptVersion: 1,
              signature: 'receipt-digest',
              signatureValid: true,
              committedAtMs: 1_754_000_000_000,
              jobId: 'job-enigma',
              analysisCohortDigest: null,
              selectedSubsetDigest: null,
              inputT1Fingerprint: null,
              stepParamsDigest: null,
              adapterIdentity: null,
              adapterImplementationSha256: null,
              toolEvidenceDigest: null,
              externalInputsDigest: null,
              outputSchemaIdentity: null,
              upstreamSignatures: [],
              baselineDigest: null,
              unitReuse: {
                computedSubjectIds: ['sub-009'],
                reusedSubjectIds: ['sub-001'],
                sourceRunIds: ['run-8407b948c62b'],
              },
            },
            runBinding: null,
          },
        }),
      ],
      nextCursor: null,
      truncated: false,
    })
    renderScreen(api)

    fireEvent.click(await screen.findByText('ENIGMA subcortical gallery'))

    expect(screen.getByText('Subjects').tagName).toBe('DT')
    expect(
      screen.getByText(
        'Computed 1 subject and reused the verified output of 1 subject from run-8407b948c62b.',
      ),
    ).toBeVisible()
  })

  it('states a Reconstruction rerun in the inventory row and the artifact facts', async () => {
    // The rerun must show outside the receipt JSON.
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({
          artifactId: 'artifact:recon-sub-102',
          label: 'FreeSurfer subject directory',
          stepKey: 'recon',
          subjectId: 'sub-102',
          provenanceDetails: {
            receipt: {
              receiptVersion: 1,
              signature: 'receipt-digest',
              signatureValid: true,
              committedAtMs: 1_754_000_000_000,
              jobId: 'job-recon',
              analysisCohortDigest: null,
              selectedSubsetDigest: null,
              inputT1Fingerprint: null,
              stepParamsDigest: null,
              adapterIdentity: null,
              adapterImplementationSha256: null,
              toolEvidenceDigest: null,
              externalInputsDigest: null,
              outputSchemaIdentity: null,
              upstreamSignatures: [],
              baselineDigest: null,
              executionFallback: {
                kind: 'freesurfer-no-fix-with-ga',
                addedArguments: ['-no-fix-with-ga'],
                reason:
                  'mris_fix_topology crashed in the genetic surface topology fix (-ga).',
                firstAttemptExitCode: 134,
              },
            },
            runBinding: null,
          },
        }),
      ],
      nextCursor: null,
      truncated: false,
    })
    renderScreen(api)

    const row = (await screen.findByText('FreeSurfer subject directory'))
      .parentElement as HTMLElement
    expect(row.textContent).toContain(
      `sub-102${TEXT_GAP}Reran with -no-fix-with-ga`,
    )
    fireEvent.click(row)

    const term = screen.getByText('Rerun')
    expect(term.tagName).toBe('DT')
    expect(screen.getByText('Reran with -no-fix-with-ga.')).toBeVisible()
    expect(
      screen.getByText(
        'mris_fix_topology crashed in the genetic surface topology fix (-ga). The first attempt exited with code 134.',
      ),
    ).toBeVisible()
  })

  it('discloses producer attribution, receipt digests, and reviewed run bindings', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({
          producerNodeId: 'enigma:cohort',
          provenanceDetails: {
            receipt: {
              receiptVersion: 1,
              signature: 'receipt-digest',
              signatureValid: true,
              committedAtMs: 1_754_000_000_000,
              jobId: 'job-enigma',
              analysisCohortDigest: 'analysis-digest',
              selectedSubsetDigest: null,
              inputT1Fingerprint: 'input-digest',
              stepParamsDigest: 'params-digest',
              adapterIdentity:
                'supraspina_sidecar.adapters.enigma.EnigmaAdapter',
              adapterImplementationSha256: 'adapter-digest',
              toolEvidenceDigest: 'tools-digest',
              externalInputsDigest: 'external-inputs-digest',
              outputSchemaIdentity: 'enigma:measures-galleries:v1',
              upstreamSignatures: ['recon-receipt-a', 'recon-receipt-b'],
              baselineDigest: 'baseline-digest',
            },
            runBinding: {
              planDigest: 'plan-digest',
              configDigest: 'config-digest',
              qcDigest: 'qc-digest',
              registryDigest: 'registry-digest',
              environmentDigest: 'environment-digest',
            },
          },
        }),
      ],
      nextCursor: null,
      truncated: false,
    })
    renderScreen(api)

    fireEvent.click(await screen.findByText('Subject features'))

    expect(screen.getByText('enigma:cohort')).not.toBeVisible()
    const producerSummary = screen.getByText('Producer identifiers')
    producerSummary.focus()
    expect(document.activeElement).toBe(producerSummary)
    fireEvent.click(producerSummary)
    expect(screen.getByText('enigma:cohort')).toBeVisible()
    expect(screen.getByText('a'.repeat(64))).toBeVisible()
    fireEvent.click(producerSummary)
    expect(screen.getByText('enigma:cohort')).not.toBeVisible()

    const receiptSummary = screen.getByText('SHA-256 receipt provenance')
    expect(receiptSummary).toBeVisible()
    expect(screen.getByText('receipt-digest')).not.toBeVisible()
    receiptSummary.focus()
    expect(document.activeElement).toBe(receiptSummary)
    fireEvent.click(receiptSummary)
    expect(screen.getByText('receipt-digest')).toBeVisible()
    expect(
      screen.getByText(
        /The digest check shows whether the stored payload matches its recorded SHA-256\./,
      ),
    ).toBeVisible()
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'DD' &&
          element.textContent === 'recon-receipt-a\nrecon-receipt-b',
      ),
    ).toBeVisible()
    fireEvent.click(receiptSummary)
    expect(screen.getByText('receipt-digest')).not.toBeVisible()

    const bindingSummary = screen.getByText('Reviewed run binding')
    expect(bindingSummary).toBeVisible()
    expect(screen.getByText('config-digest')).not.toBeVisible()
    bindingSummary.focus()
    expect(document.activeElement).toBe(bindingSummary)
    fireEvent.click(bindingSummary)
    expect(
      screen.getByText(
        /which is separate from the artifact receipt digest above\./,
      ),
    ).toBeVisible()
    expect(screen.getByText('config-digest')).toBeVisible()
    expect(screen.getByText('qc-digest')).toBeVisible()
    expect(screen.getByText('registry-digest')).toBeVisible()
    expect(screen.getByText('environment-digest')).toBeVisible()
    fireEvent.click(bindingSummary)
    expect(screen.getByText('config-digest')).not.toBeVisible()
  })

  it('reports empty and truncated bounded text previews', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [artifact({ label: 'Empty table' })],
      nextCursor: null,
      truncated: false,
    })
    vi.spyOn(api.artifact, 'readText').mockResolvedValue({
      text: '',
      truncated: true,
    })
    renderScreen(api)

    fireEvent.click(await screen.findByText('Empty table'))
    expect(await screen.findByText('This artifact is empty.')).toBeVisible()
    expect(
      screen.getByText(
        'The preview ends at its bounded limit. Open shows the whole artifact externally.',
      ),
    ).toBeVisible()
  })

  it('reports Error and non-Error preview failures without leaking stale preview data', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({ artifactId: 'artifact:first', label: 'First table' }),
        artifact({ artifactId: 'artifact:second', label: 'Second table' }),
      ],
      nextCursor: null,
      truncated: false,
    })
    const readText = vi
      .spyOn(api.artifact, 'readText')
      .mockRejectedValueOnce(new Error('Read the bounded preview again.'))
      .mockRejectedValueOnce('Retry the transport.')
    renderScreen(api)

    fireEvent.click(await screen.findByText('First table'))
    expect(
      await screen.findByText('Read the bounded preview again.'),
    ).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not load the preview.',
    )
    fireEvent.click(screen.getByText('Second table'))
    expect(
      await screen.findByText('The preview failed without an error detail.'),
    ).toBeVisible()
    expect(readText).toHaveBeenCalledTimes(2)
  })

  it('announces image-preview failures as an accessible alert', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({
          artifactId: 'artifact:image-failure',
          label: 'Unreadable montage',
          kind: 'png',
        }),
      ],
      nextCursor: null,
      truncated: false,
    })
    vi.spyOn(api.artifact, 'previewImage').mockRejectedValue(
      new Error('Refresh the changed image lease.'),
    )
    renderScreen(api)

    fireEvent.click(await screen.findByText('Unreadable montage'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load the preview.')
    expect(alert).toHaveTextContent('Refresh the changed image lease.')
  })

  it('announces Open and Reveal failures without losing artifact context', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({
          artifactId: 'artifact:workbook',
          label: 'Analysis workbook',
          kind: 'xlsx',
        }),
      ],
      nextCursor: null,
      truncated: false,
    })
    vi.spyOn(api.artifact, 'open').mockRejectedValue(
      new Error('Install or register a workbook viewer.'),
    )
    vi.spyOn(api.artifact, 'reveal').mockRejectedValue('Retry the transport.')
    renderScreen(api)

    fireEvent.click(await screen.findByText('Analysis workbook'))
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    let alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Retry opening the artifact.')
    expect(alert).toHaveTextContent('Install or register a workbook viewer.')
    expect(screen.getAllByText('Analysis workbook')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Retry revealing the artifact.')
    expect(screen.getAllByText('Analysis workbook')).toHaveLength(2)
  })

  it('offers Refresh when Open or Reveal meets an expired artifact identity', async () => {
    // The host keeps a bounded set of listed identities; a re-listing gives
    // the same file a new one.
    const api = createMockApi()
    const expired = artifact({
      artifactId: 'artifact:expired',
      label: 'Analysis workbook',
      kind: 'xlsx',
      displayPath: 'outputs/analysis.xlsx',
    })
    const relisted = { ...expired, artifactId: 'artifact:relisted' }
    const list = vi
      .spyOn(api.results, 'list')
      .mockResolvedValueOnce({
        items: [artifact(), expired],
        nextCursor: null,
        truncated: false,
      })
      .mockResolvedValue({
        items: [artifact(), relisted],
        nextCursor: null,
        truncated: false,
      })
    const open = vi
      .spyOn(api.artifact, 'open')
      .mockImplementation(async ({ artifactId }) => {
        if (artifactId === 'artifact:expired') {
          throw new Error('Select a known artifact identity.')
        }
        return { openedAt: '2026-09-25T00:00:00.000Z', reviewGrant: null }
      })
    vi.spyOn(api.artifact, 'reveal').mockRejectedValue(
      new Error('Select a known artifact identity.'),
    )
    renderScreen(api)

    fireEvent.click(await screen.findByText('Analysis workbook'))
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    let alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'The artifact list expired before this artifact was revealed.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'The artifact list expired before this artifact opened.',
    )
    expect(alert).toHaveTextContent(
      'Refresh lists the artifacts again and selects this one if it is still listed.',
    )
    expect(alert).not.toHaveTextContent('Select a known artifact identity.')
    const calls = list.mock.calls.length

    fireEvent.click(within(alert).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(list.mock.calls.length).toBe(calls + 1))
    // The same file is selected again under its new identity.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Analysis workbook/ }),
      ).toHaveAttribute('aria-current', 'true'),
    )
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() =>
      expect(open).toHaveBeenLastCalledWith({
        project: expect.objectContaining({ projectId: PROJECT.projectId }),
        artifactId: 'artifact:relisted',
      }),
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops a late text preview after the user selects a newer artifact', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [
        artifact({ artifactId: 'artifact:first', label: 'First table' }),
        artifact({ artifactId: 'artifact:second', label: 'Second table' }),
      ],
      nextCursor: null,
      truncated: false,
    })
    let resolveFirst!: (value: { text: string; truncated: boolean }) => void
    vi.spyOn(api.artifact, 'readText')
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
      )
      .mockResolvedValueOnce({ text: 'new preview', truncated: false })
    renderScreen(api)

    fireEvent.click(await screen.findByText('First table'))
    await waitFor(() => expect(api.artifact.readText).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByText('Second table'))
    expect(await screen.findByText('new preview')).toBeVisible()
    resolveFirst({ text: 'stale preview', truncated: false })
    await Promise.resolve()
    expect(screen.queryByText('stale preview')).not.toBeInTheDocument()
  })

  it('explains detector truncation when no continuation cursor is available', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [artifact()],
      nextCursor: null,
      truncated: true,
    })
    renderScreen(api)

    expect(
      await screen.findByText(
        'This list is cut short. Narrow the stage or search to list the rest.',
      ),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })
})
