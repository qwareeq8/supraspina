import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AppProvider, useApp } from '../state/context'
import { DurableMutationsProvider } from '../state/durable-mutations'
import { getApi } from '../state/api'
import { manifestRunLabel, manifestRunPhrase } from '../state/run-label'
import { QcReviewScreen } from './QcReviewScreen'
import { makeMockCohort } from '../ipc/mock'
import { THEMES, highContrastTheme } from '../theme/tokens'
import { TEXT_GAP } from '../ui/text-gap'
import {
  DEFAULT_PROJECT_CONFIG,
  type ProjectConfig,
} from '../../shared/project-schema'
import type { ResultArtifact } from '../../shared/contract'
import type { QcReviewEvidence, QcReviewOpenGrant } from '../../shared/contract'
import type { ManifestStep, RunManifest, Subject } from '../../shared/types'
import type {
  RegistrationSubjectResult,
  SurfaceRegistrationStatus,
} from '../../shared/surface-registration'

const RESOLVED_CFG: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
  paths: {
    ...DEFAULT_PROJECT_CONFIG.paths,
    projectRoot: '/tmp/sci',
    qcOutputDir: '/tmp/sci/qc',
  },
}

const QC_PROJECT = {
  projectId: 'qc-project',
  root: '/tmp/sci',
  configPath: '/tmp/sci/supraspina.project.json',
  epoch: 1,
}

const SAMPLE_COHORT = makeMockCohort(4, 17)
const QC_ARTIFACTS: ResultArtifact[] = [
  ['Subcortical QC gallery', 'subcortical'],
  ['Cortical-internal QC gallery', 'internal'],
  ['Cortical-external QC gallery', 'external'],
].map(([label, suffix]) => ({
  artifactId: `gallery-${suffix}`,
  label: label!,
  stepKey: 'enigma',
  subjectId: null,
  kind: 'html',
  presence: 'produced',
  displayPath: `/tmp/sci/qc/${suffix}.html`,
  exists: true,
  openable: true,
  revealable: true,
  runId: 'run-12345678',
  producerNodeId: 'enigma:cohort',
  receiptSha256: '1'.repeat(64),
  provenance: 'current',
}))

function reviewGrant(
  tab: QcReviewOpenGrant['tab'],
  subjectId = 'sub-001',
  inventoryRunId = 'run-12345678',
  runId = inventoryRunId,
): QcReviewOpenGrant {
  const openedAt = new Date().toISOString()
  return {
    grantId: `${tab.charCodeAt(0).toString(16)}`.repeat(64).slice(0, 64),
    tab,
    subjectId,
    inventoryRunId,
    runId,
    receiptSha256: '1'.repeat(64),
    openedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function manifestStep(
  key: ManifestStep['key'],
  status: ManifestStep['status'],
): ManifestStep {
  return { id: 1, key, status, subjects: 4, failed: 0, durationSec: 60 }
}

function runManifest(
  runId: string,
  startedAt: string,
  overrides: Partial<RunManifest> = {},
): RunManifest {
  return {
    runId,
    startedAt,
    endedAt: startedAt,
    user: 'reviewer',
    host: 'workstation',
    git: { repo: 'supraspina', sha: 'a'.repeat(40), dirty: false },
    configSha256: '0'.repeat(64),
    steps: [manifestStep('enigma', 'done')],
    tools: {},
    ...overrides,
  }
}

function Bootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  const booted = useRef(false)
  useLayoutEffect(() => {
    if (booted.current) return
    booted.current = true
    app.markProjectCreated({
      project: QC_PROJECT,
      cfg: RESOLVED_CFG,
      configSha256: '0'.repeat(64),
    })
  }, [app])
  return children
}

function SharedQcReview(): ReactNode {
  const app = useApp()
  return (
    <QcReviewScreen
      subjects={app.subjects}
      activeSubjectId={app.activeSubjectId}
      onActiveSubjectChange={app.setActiveSubjectId}
    />
  )
}

/** List the shared subject rows as `id:qc:recorded:eligible:notes:revision`. */
function SubjectRowsProbe(): ReactNode {
  const { subjects } = useApp()
  return (
    <output data-testid="subject-rows">
      {subjects
        .map(
          (subject) =>
            `${subject.id}:${subject.qc ?? 'unreviewed'}:${subject.recordedQcVerdict ?? 'none'}:${String(subject.analysisEligible)}:${subject.notes}:${subject.qcRevision ?? 0}`,
        )
        .join(';')}
    </output>
  )
}

const REVIEW_EVIDENCE: QcReviewEvidence = {
  evidenceVersion: 1,
  reviewer: 'fixture-reviewer',
  reviewedAt: '2026-09-24T12:00:00.000Z',
  galleries: [],
}

function renderScreen(
  cfg?: ProjectConfig,
  artifacts: ResultArtifact[] = QC_ARTIFACTS,
): void {
  vi.spyOn(getApi().results, 'list').mockResolvedValue({
    items: artifacts,
    nextCursor: null,
    truncated: false,
    runId: 'run-12345678',
  })
  render(
    <AppProvider>
      <DurableMutationsProvider>
        <Bootstrap>
          <QcReviewScreen subjects={SAMPLE_COHORT} {...(cfg ? { cfg } : {})} />
        </Bootstrap>
      </DurableMutationsProvider>
    </AppProvider>,
  )
}

async function openAllGalleries(subjectId = 'sub-001'): Promise<void> {
  for (const name of [
    'Subcortical',
    'Internal cortical',
    'External cortical',
  ]) {
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(name) }))
    await screen.findByRole('group', {
      name: new RegExp(`montage for ${subjectId}`),
    })
    // Wait for this gallery's own review attestation before leaving its tab.
    // Leaving earlier unmounts the montage, which abandons its panel loads and
    // the attestation that follows them, so the verdict controls never unlock.
    await screen.findByText('Reviewed in app')
  }
  // The third attestation unlocks the verdict controls in the same commit that
  // shows its chip, so no further waiting is warranted.
  expect(
    screen.getByRole('button', {
      name: /^Pass(?: \(current verdict\))?$/,
    }),
  ).toBeEnabled()
}

function renderEmptyScreen(): void {
  render(
    <AppProvider>
      <DurableMutationsProvider>
        <Bootstrap>
          <QcReviewScreen subjects={[]} />
        </Bootstrap>
      </DurableMutationsProvider>
    </AppProvider>,
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

/**
 * Render QC review on the shell's cohort while the shell's subject discovery
 * waits for the returned `discovery` to resolve.
 */
function renderWithHeldShellDiscovery() {
  const api = getApi()
  const discovery = deferred<Subject[]>()
  const discover = vi
    .spyOn(api.subjects, 'discover')
    .mockReturnValue(discovery.promise)
  vi.spyOn(api.results, 'list').mockResolvedValue({
    items: QC_ARTIFACTS,
    nextCursor: null,
    truncated: false,
    runId: 'run-12345678',
  })
  render(
    <AppProvider>
      <DurableMutationsProvider>
        <Bootstrap>
          <SharedQcReview />
        </Bootstrap>
      </DurableMutationsProvider>
    </AppProvider>,
  )
  return { discovery, discover }
}

/**
 * List the Last updated stamps a reader sees, leaving out the hidden stamps
 * that hold the header slot's width.
 */
function shownStamps(): HTMLElement[] {
  return screen
    .queryAllByText(/^Last updated /)
    .filter((stamp) => stamp.closest('[aria-hidden="true"]') === null)
}

afterEach(() => vi.restoreAllMocks())

describe('QcReviewScreen', () => {
  it('keeps the subject meta separators clear of the cohort label', async () => {
    // The meta line is an inline-flex row, so collapsible separator spaces are
    // dropped at the edge of the text item and the label touches the dot.
    // A CSV import can store a fractional age; the line reads whole years.
    const subjects = SAMPLE_COHORT.slice(0, 1).map((subject) => ({
      ...subject,
      age: 40.58,
      sex: 'M' as const,
      cohort: 'CTRL' as const,
    }))
    vi.spyOn(getApi().results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      runId: 'run-12345678',
    })
    const { container } = render(
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            <QcReviewScreen subjects={subjects} />
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>,
    )
    await screen.findByText(/Age 40/)
    expect(container.textContent).toContain(
      `Age 40${TEXT_GAP}M${TEXT_GAP}Control`,
    )
  })

  it('should show an empty queue by default', async () => {
    renderEmptyScreen()
    expect(
      await screen.findByText('No subjects are in this cohort.'),
    ).toBeTruthy()
  })

  it('should show the first subject header when the cohort loads', async () => {
    renderScreen()
    const heading = await screen.findByRole('heading', { name: /Subject 001/ })
    expect(heading).toBeTruthy()
  })

  it('should advance to the next subject when J is pressed', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    fireEvent.keyDown(window, { key: 'j' })
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Subject 002/ })).toBeTruthy()
    })
  })

  it('keeps the page in place and scrolls only the queue to the selected subject', async () => {
    // `scrollIntoView` on the active queue row would also scroll the page's
    // main container 140 px, hiding the subject header and Pass/Fail.
    const cohort = makeMockCohort(40, 17)
    const HEADER = 60
    const ROW = 30
    const QUEUE_HEIGHT = 300
    // Lay the queue out as its rows' offset parent: the sticky header first,
    // then one fixed-height row per subject.
    const queueIndex = (el: Element): number => {
      const queue = el.parentElement
      return queue?.matches('nav[aria-label="Subject queue"]')
        ? [...queue.children].indexOf(el)
        : -1
    }
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
      function (this: HTMLElement): number {
        const index = queueIndex(this)
        return index > 0 ? HEADER + (index - 1) * ROW : 0
      },
    )
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement): number {
        const index = queueIndex(this)
        return index === 0 ? HEADER : index > 0 ? ROW : 0
      },
    )
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(
      function (this: Element): number {
        return this.matches('nav[aria-label="Subject queue"]')
          ? QUEUE_HEIGHT
          : 0
      },
    )
    const scrollIntoView = vi.fn()
    const original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView',
    )
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    })
    function Controlled(): ReactNode {
      const [active, setActive] = useState(cohort[30]!.id)
      return (
        <main data-testid="page" style={{ overflow: 'auto', height: 400 }}>
          <QcReviewScreen
            subjects={cohort}
            activeSubjectId={active}
            onActiveSubjectChange={setActive}
          />
        </main>
      )
    }
    try {
      vi.spyOn(getApi().results, 'list').mockResolvedValue({
        items: QC_ARTIFACTS,
        nextCursor: null,
        truncated: false,
        runId: 'run-12345678',
      })
      render(
        <AppProvider>
          <DurableMutationsProvider>
            <Bootstrap>
              <Controlled />
            </Bootstrap>
          </DurableMutationsProvider>
        </AppProvider>,
      )
      const page = screen.getByTestId('page')
      const queue = screen.getByRole('navigation', { name: 'Subject queue' })
      const heading = (id: string) =>
        screen.findByRole('heading', {
          name: `Subject ${id.replace(/^sub-/, '')}`,
        })

      await heading(cohort[30]!.id)
      // Row 31 ends at 60 + 31 * 30 = 990 px; the queue shows 300 px.
      await waitFor(() => expect(queue.scrollTop).toBe(690))
      expect(page.scrollTop).toBe(0)
      expect(scrollIntoView).not.toHaveBeenCalled()

      fireEvent.keyDown(window, { key: 'j' })
      await heading(cohort[31]!.id)
      await waitFor(() => expect(queue.scrollTop).toBe(720))
      expect(page.scrollTop).toBe(0)

      // Moving back above the visible rows scrolls the queue up to the row,
      // just below its sticky header.
      queue.scrollTop = 960
      fireEvent.keyDown(window, { key: 'k' })
      await heading(cohort[30]!.id)
      await waitFor(() => expect(queue.scrollTop).toBe(900))
      expect(page.scrollTop).toBe(0)
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      if (original) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', original)
      } else {
        delete (Element.prototype as { scrollIntoView?: unknown })
          .scrollIntoView
      }
    }
  })

  it('should expose the ENIGMA protocol radiogroup when loaded', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    expect(
      screen.getByRole('radiogroup', { name: /ENIGMA QC protocol/ }),
    ).toBeTruthy()
  })

  it('should request only the authoritative ENIGMA run for the review', async () => {
    renderScreen()

    await waitFor(() =>
      expect(getApi().results.list).toHaveBeenCalledWith({
        project: QC_PROJECT,
        stepKey: 'enigma',
        limit: 50,
        runId: 'run-12345678',
      }),
    )
    await screen.findByRole('group', { name: /montage for sub-001/ })
    // The select already names the current run, so no sentence repeats it.
    expect(screen.getByLabelText('Run')).toHaveDisplayValue(
      'Current ENIGMA run',
    )
    const hint = document.querySelector(
      '[data-reserve="run-hint"]',
    )!.nextElementSibling
    expect(hint).toBeEmptyDOMElement()
    expect(screen.queryByText(/run-12345678/)).toBeNull()
    // The hint states which run the review uses as a fact, not an order.
    expect(screen.queryByText(/^Use the /)).toBeNull()
  })

  it('holds the resolved run sentence room while the ENIGMA run resolves', async () => {
    // At 135% text the one-line "Resolving the current ENIGMA run..." gives way
    // to a two-line resolved sentence after the cohort loads, which would grow
    // the header under the tabs and the gallery. jsdom lays nothing out, so pin
    // the structure that keeps the height: the hint shares one grid cell with a
    // hidden reserve of the widest resolved sentences from the first frame on.
    let resolveAuthority!: (
      value: Awaited<
        ReturnType<ReturnType<typeof getApi>['qc']['authoritativeRun']>
      >,
    ) => void
    vi.spyOn(getApi().qc, 'authoritativeRun').mockReturnValue(
      new Promise((resolve) => {
        resolveAuthority = resolve
      }),
    )
    renderScreen()
    const pending = await screen.findByText(
      'Resolving the current ENIGMA run...',
    )
    const slot = pending.parentElement!
    const reserve = slot.querySelector('[data-reserve="run-hint"]')!
    expect(reserve).toHaveAttribute('aria-hidden', 'true')
    expect(reserve).toHaveStyle({ visibility: 'hidden', gridArea: '1 / 1' })
    expect(pending).toHaveStyle({ gridArea: '1 / 1' })
    expect(slot).toHaveStyle({ display: 'grid' })
    const samples = [...reserve.querySelectorAll('p')].map(
      (sample) => sample.textContent,
    )
    expect(samples).toHaveLength(12)
    for (const sample of samples) {
      expect(sample).toMatch(
        /^The galleries come from the current ENIGMA run, the run started .+\.$/,
      )
    }

    await act(async () =>
      resolveAuthority({
        runId: 'run-12345678',
        unavailable: null,
        inventoryKey: null,
      }),
    )
    await waitFor(() =>
      expect(
        screen.queryByText('Resolving the current ENIGMA run...'),
      ).toBeNull(),
    )
    // A run without a phrase leaves the placeholder's cell empty; the reserve
    // stays, so the header keeps its height.
    const resolved = reserve.nextElementSibling!
    expect(resolved.parentElement).toBe(slot)
    expect(resolved).toBeEmptyDOMElement()
    expect(slot.querySelector('[data-reserve="run-hint"]')).toBe(reserve)
  })

  it('reuses the authoritative gallery inventory while the host reports it unchanged', async () => {
    // Reopening QC review must not re-read the ENIGMA inventory of an 82-subject
    // run while nothing about the authoritative run has changed.
    const api = getApi()
    const authority = vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
      runId: 'run-12345678',
      unavailable: null,
      inventoryKey: 'a'.repeat(64),
    })
    const list = vi.spyOn(api.results, 'list').mockResolvedValue({
      items: QC_ARTIFACTS,
      nextCursor: null,
      truncated: false,
      runId: 'run-12345678',
    })
    // Keep the project mounted and leave and reopen only the screen.
    const Shell = ({ open }: { open: boolean }): ReactNode => (
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            {open ? <QcReviewScreen subjects={SAMPLE_COHORT} /> : null}
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>
    )
    // A montage draws only from the resolved authoritative run's inventory.
    const resolved = () =>
      screen.findByRole('group', { name: /montage for sub-001/ })

    const view = render(<Shell open />)
    await resolved()
    expect(list).toHaveBeenCalledTimes(1)
    view.rerender(<Shell open={false} />)

    view.rerender(<Shell open />)
    await resolved()
    expect(authority).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledTimes(1)
    view.rerender(<Shell open={false} />)

    // A changed key means the inventory may have changed.
    authority.mockResolvedValue({
      runId: 'run-12345678',
      unavailable: null,
      inventoryKey: 'b'.repeat(64),
    })
    view.rerender(<Shell open />)
    await resolved()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('lists the galleries again once when the host no longer holds a reused gallery identity', async () => {
    // Results listings can evict the identities in the reused inventory, and
    // the host then answers "Select a known artifact identity."; QC review
    // lists the inventory again rather than show no panels.
    const api = getApi()
    vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
      runId: 'run-12345678',
      unavailable: null,
      inventoryKey: 'c'.repeat(64),
    })
    const relisted = QC_ARTIFACTS.map((artifact) => ({
      ...artifact,
      artifactId: `${artifact.artifactId}-relisted`,
    }))
    const list = vi
      .spyOn(api.results, 'list')
      .mockResolvedValueOnce({
        items: QC_ARTIFACTS,
        nextCursor: null,
        truncated: false,
        runId: 'run-12345678',
      })
      .mockResolvedValue({
        items: relisted,
        nextCursor: null,
        truncated: false,
        runId: 'run-12345678',
      })
    const describeGallery = api.qc.galleryImages.bind(api.qc)
    let evicted = false
    const gallery = vi
      .spyOn(api.qc, 'galleryImages')
      .mockImplementation(async (request) => {
        if (evicted && !request.artifactId.endsWith('-relisted')) {
          throw new Error('Select a known artifact identity.')
        }
        return describeGallery(request)
      })
    const Shell = ({ open }: { open: boolean }): ReactNode => (
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            {open ? <QcReviewScreen subjects={SAMPLE_COHORT} /> : null}
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>
    )
    const drawn = /12\/12 panels verified and drawn\./

    const view = render(<Shell open />)
    expect(await screen.findByText(drawn)).toBeVisible()
    expect(list).toHaveBeenCalledTimes(1)
    view.rerender(<Shell open={false} />)

    // Reopening reuses the inventory whose identities the host has dropped.
    evicted = true
    view.rerender(<Shell open />)
    expect(await screen.findByText(drawn)).toBeVisible()
    expect(list).toHaveBeenCalledTimes(2)
    expect(gallery).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: 'gallery-subcortical' }),
    )
    expect(gallery).toHaveBeenLastCalledWith(
      expect.objectContaining({ artifactId: 'gallery-subcortical-relisted' }),
    )
    expect(screen.queryByText(/known artifact identity/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    view.rerender(<Shell open={false} />)

    // The fresh inventory replaced the reused one.
    view.rerender(<Shell open />)
    expect(await screen.findByText(drawn)).toBeVisible()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('states when the shown images replaced those a verdict was recorded on', async () => {
    const api = getApi()
    vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
      runId: 'run-12345678',
      unavailable: null,
      inventoryKey: 'c'.repeat(64),
    })
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: QC_ARTIFACTS,
      nextCursor: null,
      truncated: false,
      runId: 'run-12345678',
    })
    const describeGallery = api.qc.galleryImages.bind(api.qc)
    vi.spyOn(api.qc, 'galleryImages').mockImplementation(async (request) => ({
      ...(await describeGallery(request)),
      imagesChangedSinceVerdict: {
        renderedRunId: 'run-12345678',
        reason: 'inputs-changed',
      },
    }))
    render(
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            <QcReviewScreen subjects={SAMPLE_COHORT} />
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>,
    )

    const note = await screen.findByRole('note', {
      name: 'Images changed since the verdict',
    })
    expect(note).toHaveTextContent(
      "These images were rendered again in run-12345678 after the recorded verdict because this subject's inputs changed. Review them again before relying on the verdict.",
    )
  })

  it('offers Retry when a gallery identity is refused again after listing the galleries again', async () => {
    const api = getApi()
    let listing = 0
    const list = vi.spyOn(api.results, 'list').mockImplementation(async () => {
      listing += 1
      return {
        items: QC_ARTIFACTS.map((artifact) => ({
          ...artifact,
          artifactId: `${artifact.artifactId}-${listing}`,
        })),
        nextCursor: null,
        truncated: false,
        runId: 'run-12345678',
      }
    })
    const describeGallery = api.qc.galleryImages.bind(api.qc)
    let refused = true
    const gallery = vi
      .spyOn(api.qc, 'galleryImages')
      .mockImplementation(async (request) => {
        if (refused) throw new Error('Select a known artifact identity.')
        return describeGallery(request)
      })
    render(
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            <QcReviewScreen subjects={SAMPLE_COHORT} />
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>,
    )

    expect(
      await screen.findByText(
        'The Subcortical gallery list expired before the montage loaded.',
      ),
    ).toBeVisible()
    expect(
      screen.getByText('The Subcortical montage could not be shown.'),
    ).toBeVisible()
    expect(screen.queryByText(/known artifact identity/)).toBeNull()
    // The first listing and one transparent re-list, then no loop.
    expect(list).toHaveBeenCalledTimes(2)
    expect(gallery).toHaveBeenCalledTimes(2)

    // A Retry that is refused again lists once and stops.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(gallery).toHaveBeenCalledTimes(3))
    expect(
      await screen.findByText(
        'The Subcortical gallery list expired before the montage loaded.',
      ),
    ).toBeVisible()
    expect(list).toHaveBeenCalledTimes(3)

    refused = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByText(/12\/12 panels verified and drawn\./),
    ).toBeVisible()
    expect(list).toHaveBeenCalledTimes(4)
    expect(gallery).toHaveBeenLastCalledWith(
      expect.objectContaining({ artifactId: 'gallery-subcortical-4' }),
    )
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('should present an absent current gallery set as a bounded expected state', async () => {
    const api = getApi()
    const message =
      'Run ENIGMA QC under the saved project configuration to review galleries.'
    const authority = vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
      runId: null,
      unavailable: { reason: 'noCurrentGallery', message },
      inventoryKey: null,
    })
    renderScreen()

    expect(await screen.findByText(message)).toBeVisible()
    expect(authority).toHaveBeenCalled()
    // One state: the gallery pane states the answer, and neither the header
    // nor a generic empty state repeats it.
    expect(screen.getAllByText(message)).toHaveLength(1)
    expect(
      screen.getByText('No current Subcortical gallery exists.'),
    ).toBeVisible()
    expect(screen.getByTestId('qc-montage-notice').style.minHeight).toBe('')
    expect(screen.queryByText(/No .+ gallery is produced yet/)).toBeNull()
  })

  it('should state a failed authority lookup once instead of asking for a new run', async () => {
    vi.spyOn(getApi().qc, 'authoritativeRun').mockRejectedValue(
      new Error('Restart the scientific runtime and retry.'),
    )
    renderScreen()

    expect(
      await screen.findByText('Could not resolve the current ENIGMA run.'),
    ).toBeVisible()
    expect(
      screen.getAllByText('Restart the scientific runtime and retry.'),
    ).toHaveLength(1)
    expect(screen.queryByText(/No .+ gallery is produced yet/)).toBeNull()
  })

  it('should offer galleries of an earlier cohort without treating them as authoritative', async () => {
    const api = getApi()
    const earlierRunId = 'run-11111111'
    const earlierManifest = runManifest(
      earlierRunId,
      '2026-07-31T14:00:00.000Z',
    )
    const message =
      'The newest ENIGMA QC galleries were produced under an earlier project configuration. ' +
      'They cover 48 subjects, and the newest run analyzed 82 subjects. ' +
      'Run ENIGMA QC under the saved configuration to review galleries.'
    vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
      runId: null,
      unavailable: { reason: 'earlierGallery', message, earlierRunId },
      inventoryKey: null,
    })
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: [
        runManifest('run-22222222', '2026-07-31T15:00:00.000Z'),
        earlierManifest,
      ],
      nextCursor: null,
    })
    vi.spyOn(api.results, 'list').mockImplementation(async ({ runId }) => ({
      items: QC_ARTIFACTS.map((artifact) => ({ ...artifact, runId: runId! })),
      nextCursor: null,
      truncated: false,
      runId: runId ?? null,
    }))
    render(
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            <QcReviewScreen subjects={SAMPLE_COHORT} />
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>,
    )

    expect(await screen.findByText(message)).toBeVisible()
    expect(screen.queryByText('Resolving the current ENIGMA run...')).toBeNull()
    // The generic "Run ENIGMA QC to produce the ... gallery" empty state under
    // this message would read as though QC never ran.
    expect(screen.getAllByText(message)).toHaveLength(1)
    expect(
      screen.getByText('No current Subcortical gallery exists.'),
    ).toBeVisible()
    expect(screen.queryByText(/No .+ gallery is produced yet/)).toBeNull()
    const runPicker = screen.getByLabelText('Run')
    const option = await within(runPicker).findByRole('option', {
      name: `${manifestRunLabel(earlierManifest)}${TEXT_GAP}earlier ENIGMA galleries`,
    })
    fireEvent.change(runPicker, {
      target: { value: (option as HTMLOptionElement).value },
    })
    expect(
      await screen.findByText(
        `The ${manifestRunPhrase(earlierManifest)} is shown for inspection only. New verdicts use the current ENIGMA run.`,
      ),
    ).toBeVisible()
    // With the earlier run selected, the header keeps saying it is not
    // current while the pane shows its galleries.
    expect(screen.getAllByText(message)).toHaveLength(1)
  })

  it('should select the earlier-cohort run from the gallery pane', async () => {
    const api = getApi()
    const earlierRunId = 'run-11111111'
    const earlierManifest = runManifest(
      earlierRunId,
      '2026-07-31T14:00:00.000Z',
    )
    vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
      runId: null,
      unavailable: {
        reason: 'earlierGallery',
        message: 'The existing ENIGMA QC galleries were produced earlier.',
        earlierRunId,
      },
      inventoryKey: null,
    })
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: [earlierManifest],
      nextCursor: null,
    })
    const results = vi
      .spyOn(api.results, 'list')
      .mockImplementation(async ({ runId }) => ({
        items: QC_ARTIFACTS.map((artifact) => ({
          ...artifact,
          runId: runId!,
        })),
        nextCursor: null,
        truncated: false,
        runId: runId ?? null,
      }))
    render(
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            <QcReviewScreen subjects={SAMPLE_COHORT} />
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>,
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Inspect earlier galleries' }),
    )

    expect(screen.getByLabelText('Run')).toHaveValue(earlierRunId)
    expect(
      await screen.findByText(
        `The ${manifestRunPhrase(earlierManifest)} is shown for inspection only. New verdicts use the current ENIGMA run.`,
      ),
    ).toBeVisible()
    expect(results).toHaveBeenCalledWith(
      expect.objectContaining({ runId: earlierRunId }),
    )
  })

  it('should not ask for a new ENIGMA run while the gallery inventory is still loading', async () => {
    // The inventory of the authoritative run can take over a minute on a large
    // cohort; until it answers the screen must not say to run ENIGMA QC, since
    // the galleries exist.
    const api = getApi()
    vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
      runId: 'run-11111111',
      unavailable: null,
      inventoryKey: null,
    })
    vi.spyOn(api.results, 'list').mockImplementation(
      () => new Promise(() => undefined),
    )
    renderScreen()

    expect(
      await screen.findByText(/Loading the .* gallery inventory\.\.\./),
    ).toBeVisible()
    expect(
      screen.queryByText(/No .+ gallery is produced yet/),
    ).not.toBeInTheDocument()
  })

  it('should default to an older authoritative ENIGMA run across a newer unrelated run', async () => {
    const api = getApi()
    const latestRunId = 'run-22222222'
    const enigmaRunId = 'run-11111111'
    const olderArtifacts = QC_ARTIFACTS.map((artifact) => ({
      ...artifact,
      runId: enigmaRunId,
    }))
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: [
        runManifest(latestRunId, '2026-07-31T15:00:00.000Z'),
        runManifest(enigmaRunId, '2026-07-31T14:00:00.000Z'),
      ],
      nextCursor: null,
    })
    vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
      runId: enigmaRunId,
      unavailable: null,
      inventoryKey: null,
    })
    const list = vi
      .spyOn(api.results, 'list')
      .mockImplementation(async (request) =>
        request.runId === enigmaRunId
          ? {
              items: olderArtifacts,
              nextCursor: null,
              truncated: false,
              runId: enigmaRunId,
            }
          : {
              items: [],
              nextCursor: null,
              truncated: false,
              runId: latestRunId,
            },
      )
    const galleryTab = (artifactId: string): QcReviewOpenGrant['tab'] =>
      artifactId.includes('external')
        ? 'external'
        : artifactId.includes('internal')
          ? 'internal'
          : 'subcortical'
    vi.spyOn(api.artifact, 'open').mockImplementation(
      async ({ artifactId, focusText }) => {
        const grant = reviewGrant(
          galleryTab(artifactId),
          focusText ?? 'sub-001',
          enigmaRunId,
        )
        return { openedAt: grant.openedAt, reviewGrant: grant }
      },
    )
    vi.spyOn(api.qc, 'attestGalleryView').mockImplementation(
      async ({ artifactId, subjectId }) => ({
        reviewGrant: reviewGrant(
          galleryTab(artifactId),
          subjectId,
          enigmaRunId,
        ),
      }),
    )
    const markQc = vi.spyOn(api.subjects, 'markQc')
    render(
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            <QcReviewScreen subjects={SAMPLE_COHORT} />
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>,
    )

    await waitFor(() =>
      expect(list).toHaveBeenCalledWith({
        project: QC_PROJECT,
        stepKey: 'enigma',
        limit: 50,
        runId: enigmaRunId,
      }),
    )
    expect(
      await screen.findByText(
        `The galleries come from the current ENIGMA run, the ${manifestRunPhrase(
          runManifest(enigmaRunId, '2026-07-31T14:00:00.000Z'),
        )}.`,
      ),
    ).toBeVisible()
    expect(screen.getByLabelText('Run')).toHaveValue('')
    await openAllGalleries()
    fireEvent.click(screen.getByRole('button', { name: /^Pass$/ }))
    await waitFor(() => expect(markQc).toHaveBeenCalled())
    expect(markQc).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reviewGrantIds: expect.arrayContaining([
          expect.stringMatching(/^[a-f0-9]{64}$/),
        ]),
      }),
    )
  })

  it('should label historical inspection and surface Open and Reveal failures', async () => {
    const api = getApi()
    const authoritativeRunId = 'run-22222222'
    const historicalRunId = 'run-11111111'
    vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
      runId: authoritativeRunId,
      unavailable: null,
      inventoryKey: null,
    })
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: [
        runManifest(authoritativeRunId, '2026-07-31T15:00:00.000Z'),
        runManifest(historicalRunId, '2026-07-31T14:00:00.000Z'),
      ],
      nextCursor: null,
    })
    vi.spyOn(api.results, 'list').mockImplementation(async ({ runId }) => ({
      items: QC_ARTIFACTS.map((artifact) => ({ ...artifact, runId: runId! })),
      nextCursor: null,
      truncated: false,
      runId: runId ?? null,
    }))
    vi.spyOn(api.artifact, 'open').mockRejectedValue(
      new Error(
        'Use only the authoritative current ENIGMA run to attest review.',
      ),
    )
    vi.spyOn(api.artifact, 'reveal').mockRejectedValue(
      new Error('Retry revealing the gallery through the operating system.'),
    )
    render(
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            <QcReviewScreen subjects={SAMPLE_COHORT} />
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>,
    )

    const authoritativeManifest = runManifest(
      authoritativeRunId,
      '2026-07-31T15:00:00.000Z',
    )
    const historicalManifest = runManifest(
      historicalRunId,
      '2026-07-31T14:00:00.000Z',
    )
    expect(
      await screen.findByText(
        `The galleries come from the current ENIGMA run, the ${manifestRunPhrase(authoritativeManifest)}.`,
      ),
    ).toBeVisible()
    const runPicker = screen.getByLabelText('Run')
    expect(
      within(runPicker).getByRole('option', {
        name: manifestRunLabel(historicalManifest),
      }),
    ).toBeInTheDocument()
    expect(within(runPicker).queryByText(/run-11111111/)).toBeNull()
    fireEvent.change(runPicker, {
      target: { value: historicalRunId },
    })
    expect(
      await screen.findByText(
        `The ${manifestRunPhrase(historicalManifest)} is shown for inspection only. New verdicts use the current ENIGMA run.`,
      ),
    ).toBeVisible()
    expect(screen.queryByText(/run-11111111|run-22222222/)).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    const openAlert = await screen.findByText(
      /Use only the authoritative current ENIGMA run to attest review/i,
    )
    expect(openAlert.closest('[role="alert"]')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    const revealAlert = await screen.findByText(
      /Retry revealing the gallery through the operating system/i,
    )
    expect(revealAlert.closest('[role="alert"]')).toBeVisible()
  })

  it('lists only runs that started ENIGMA QC in the run selector', async () => {
    // Stage runs of other steps and dry runs hold no galleries, so the selector
    // leaves them out.
    const api = getApi()
    const authoritative = runManifest('run-22222222', '2026-07-31T15:00:00Z')
    const enigmaDone = runManifest('run-11111111', '2026-07-31T14:00:00Z')
    const failedEnigma = runManifest('run-66666666', '2026-07-31T13:30:00Z', {
      steps: [manifestStep('enigma', 'failed')],
    })
    const brainfovStage = runManifest('run-33333333', '2026-07-31T13:00:00Z', {
      intent: 'stage',
      steps: [manifestStep('brainfov', 'done')],
    })
    const dryRun = runManifest('run-44444444', '2026-07-31T12:00:00Z', {
      intent: 'workflow',
      dryRun: true,
    })
    const skippedEnigma = runManifest('run-55555555', '2026-07-31T11:00:00Z', {
      intent: 'workflow',
      steps: [manifestStep('recon', 'done'), manifestStep('enigma', 'skipped')],
    })
    vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
      runId: authoritative.runId,
      unavailable: null,
      inventoryKey: null,
    })
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: [
        authoritative,
        enigmaDone,
        failedEnigma,
        brainfovStage,
        dryRun,
        skippedEnigma,
      ],
      nextCursor: null,
    })
    renderScreen()

    const runPicker = screen.getByLabelText('Run')
    await within(runPicker).findByRole('option', {
      name: manifestRunLabel(enigmaDone),
    })
    expect(
      within(runPicker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Current ENIGMA run',
      manifestRunLabel(authoritative),
      manifestRunLabel(enigmaDone),
      manifestRunLabel(failedEnigma),
    ])
  })

  it('keeps the earlier-gallery run in the selector whatever its steps say', async () => {
    const api = getApi()
    const earlierRunId = 'run-11111111'
    const earlierManifest = runManifest(earlierRunId, '2026-07-31T14:00:00Z', {
      steps: [],
    })
    const brainfovStage = runManifest('run-33333333', '2026-07-31T15:00:00Z', {
      intent: 'stage',
      steps: [manifestStep('brainfov', 'done')],
    })
    vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
      runId: null,
      unavailable: {
        reason: 'earlierGallery',
        message: 'The existing ENIGMA QC galleries were produced earlier.',
        earlierRunId,
      },
      inventoryKey: null,
    })
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: [brainfovStage, earlierManifest],
      nextCursor: null,
    })
    renderScreen()

    const runPicker = screen.getByLabelText('Run')
    await within(runPicker).findByRole('option', {
      name: `${manifestRunLabel(earlierManifest)}${TEXT_GAP}earlier ENIGMA galleries`,
    })
    expect(within(runPicker).getAllByRole('option')).toHaveLength(2)
  })

  it.each([
    ['a stale receipt of the selected run', 'run-11111111', 'stale'],
    ["another run's receipt", 'run-22222222', 'unknown'],
  ] as const)(
    'states why a historical run shows no gallery (%s) and returns to the current run',
    async (_case, subcorticalRunId, subcorticalProvenance) => {
      // A historical run without a gallery states why and points to the current
      // run, not to a rerun of several hours.
      const api = getApi()
      const authoritative = runManifest('run-22222222', '2026-07-31T15:00:00Z')
      const historical = runManifest('run-11111111', '2026-07-31T14:00:00Z')
      vi.spyOn(api.qc, 'authoritativeRun').mockResolvedValue({
        runId: authoritative.runId,
        unavailable: null,
        inventoryKey: null,
      })
      vi.spyOn(api.manifest, 'list').mockResolvedValue({
        items: [authoritative, historical],
        nextCursor: null,
      })
      vi.spyOn(api.results, 'list').mockImplementation(async ({ runId }) => ({
        // In the historical inventory a later run rewrote the Subcortical
        // gallery, no Internal cortical gallery exists, and the External
        // cortical gallery holds the run's receipt but could not be judged.
        items:
          runId === historical.runId
            ? [
                {
                  ...QC_ARTIFACTS[0]!,
                  runId: subcorticalRunId,
                  provenance: subcorticalProvenance,
                  detail:
                    'The three ENIGMA measure tables and galleries are verified.',
                },
                {
                  ...QC_ARTIFACTS[2]!,
                  runId: historical.runId,
                  provenance: 'unknown' as const,
                },
              ]
            : QC_ARTIFACTS.map((artifact) => ({
                ...artifact,
                runId: authoritative.runId,
              })),
        nextCursor: null,
        truncated: false,
        runId: runId ?? null,
      }))
      render(
        <AppProvider>
          <DurableMutationsProvider>
            <Bootstrap>
              <QcReviewScreen subjects={SAMPLE_COHORT} />
            </Bootstrap>
          </DurableMutationsProvider>
        </AppProvider>,
      )

      const authoritativeHint = `The galleries come from the current ENIGMA run, the ${manifestRunPhrase(authoritative)}.`
      expect(await screen.findByText(authoritativeHint)).toBeVisible()
      const runPicker = screen.getByLabelText('Run')
      await within(runPicker).findByRole('option', {
        name: manifestRunLabel(historical),
      })
      fireEvent.change(runPicker, { target: { value: historical.runId } })

      expect(
        await screen.findByText(
          'A later run replaced the Subcortical gallery of the selected run.',
        ),
      ).toBeVisible()
      // The fact and its action sit at the top of the pane; no tall centered
      // box pushes the action below the fold.
      const notice = screen.getByTestId('qc-montage-notice')
      expect(notice.style.minHeight).toBe('')
      expect(notice.style.placeItems).toBe('')
      expect(notice.style.justifyContent).toBe('')
      expect(notice.style.alignItems).toBe('flex-start')
      expect(
        within(notice).getByRole('button', { name: 'Show current ENIGMA run' }),
      ).toBeVisible()
      expect(screen.queryByText(/No .+ gallery is produced yet/)).toBeNull()
      expect(screen.queryByText(/measure tables and galleries/)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull()

      fireEvent.click(screen.getByRole('radio', { name: /Internal cortical/ }))
      expect(
        await screen.findByText(
          'The selected run produced no Internal cortical gallery.',
        ),
      ).toBeVisible()
      expect(screen.queryByText(/No .+ gallery is produced yet/)).toBeNull()

      fireEvent.click(screen.getByRole('radio', { name: /External cortical/ }))
      expect(
        await screen.findByText(
          'Supraspina could not verify the External cortical gallery of the selected run.',
        ),
      ).toBeVisible()

      fireEvent.click(
        screen.getByRole('button', { name: 'Show current ENIGMA run' }),
      )
      expect(runPicker).toHaveValue('')
      expect(await screen.findByText(authoritativeHint)).toBeVisible()
      await screen.findByRole('group', { name: /montage for sub-001/ })
      expect(
        screen.queryByRole('button', { name: 'Show current ENIGMA run' }),
      ).toBeNull()
    },
  )

  it('should record a Pass verdict when the P key is pressed', async () => {
    const markQc = vi.spyOn(getApi().subjects, 'markQc')
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    await openAllGalleries()
    fireEvent.keyDown(window, { key: 'p' })
    await waitFor(() => {
      const btn = screen.getByRole('button', {
        name: /Pass \(current verdict\)/,
      })
      expect(btn).toHaveAttribute('aria-pressed', 'true')
    })
    expect(markQc).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: 'sub-001',
        verdict: 'pass',
        reviewGrantIds: expect.arrayContaining([
          expect.stringMatching(/^[a-f0-9]{64}$/),
        ]),
      }),
    )
  })

  it('updates the subject row from verdict and note saves without detecting it again', async () => {
    const api = getApi()
    const first: Subject = {
      ...SAMPLE_COHORT[0]!,
      qc: null,
      recordedQcVerdict: null,
      qcReviewEvidencePresent: false,
      notes: '',
      qcTags: [],
      qcRevision: 0,
      t1Availability: 'available',
      analysisEligible: true,
      unavailableReason: null,
    }
    vi.spyOn(api.subjects, 'discover').mockResolvedValue([first])
    let revision = 0
    const markQc = vi
      .spyOn(api.subjects, 'markQc')
      .mockImplementation(async ({ subjectId, verdict, note, tags }) => {
        revision += 1
        return {
          subjectId,
          verdict,
          note,
          tags,
          // The store keeps gallery evidence with every Pass or Fail.
          reviewEvidence:
            verdict === 'pass' || verdict === 'fail' ? REVIEW_EVIDENCE : null,
          revision,
          updatedAt: new Date().toISOString(),
        }
      })
    // A save that waited for detection would never report success.
    const refreshOne = vi
      .spyOn(api.subjects, 'refreshOne')
      .mockReturnValue(new Promise<Subject>(() => undefined))
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: QC_ARTIFACTS,
      nextCursor: null,
      truncated: false,
      runId: 'run-12345678',
    })
    render(
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            <SharedQcReview />
            <SubjectRowsProbe />
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>,
    )
    await screen.findByRole('heading', { name: /Subject 001/ })
    await openAllGalleries()
    const rows = screen.getByTestId('subject-rows')

    fireEvent.click(screen.getByRole('button', { name: /^Fail$/ }))
    expect(
      await screen.findByText('The QC change is saved.'),
    ).toBeInTheDocument()
    expect(rows).toHaveTextContent('sub-001:fail:fail:false::1')
    expect(
      screen.getByRole('button', { name: 'Fail (current verdict)' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('button', {
        name: `sub-001, ${first.cohort}, QC Fail`,
      }),
    ).toBeInTheDocument()

    const note = screen.getByRole('textbox', { name: 'Reviewer note' })
    // The placeholder states when the note saves.
    expect(note).toHaveAttribute(
      'placeholder',
      'Saved when you leave the field.',
    )
    fireEvent.change(note, { target: { value: 'Reviewed note' } })
    fireEvent.blur(note)
    await waitFor(() => expect(markQc).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(rows).toHaveTextContent('sub-001:fail:fail:false:Reviewed note:2'),
    )
    expect(
      await screen.findByText('The QC change is saved.'),
    ).toBeInTheDocument()

    // Pass restores the subject to the analysis cohort.
    fireEvent.click(screen.getByRole('button', { name: /^Pass$/ }))
    await waitFor(() =>
      expect(rows).toHaveTextContent('sub-001:pass:pass:true:Reviewed note:3'),
    )
    expect(
      await screen.findByText('The QC change is saved.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Pass (current verdict)' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('button', {
        name: `sub-001, ${first.cohort}, QC Pass`,
      }),
    ).toBeInTheDocument()
    expect(refreshOne).not.toHaveBeenCalled()
  })

  it('should not execute a gallery when no detector-issued artifact exists', async () => {
    renderScreen(undefined, [])
    await screen.findByRole('heading', { name: /Subject 001/ })
    expect(screen.queryByTitle(/QC gallery/)).toBeNull()
    // The instruction appears once the gallery inventory has resolved.
    expect(
      await screen.findByText(/No Subcortical gallery is produced yet\./),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Pass$/ })).toBeDisabled()
    expect(
      screen.getByText('Open all three galleries first.'),
    ).toBeInTheDocument()
  })

  it('should hand off a detector-verified gallery without embedding its HTML', async () => {
    const artifact: ResultArtifact = {
      artifactId: 'gallery-subcortical',
      label: 'Subcortical QC gallery',
      stepKey: 'enigma',
      subjectId: null,
      kind: 'html',
      presence: 'produced',
      displayPath: '/tmp/sci/qc/ENIGMA_Subcortical_QC.html',
      exists: true,
      openable: true,
      revealable: true,
      runId: 'run-qc',
      producerNodeId: 'node-qc',
      receiptSha256: '1'.repeat(64),
      provenance: 'current',
    }
    const api = getApi()
    const open = vi
      .spyOn(api.artifact, 'open')
      .mockImplementation(async ({ focusText }) => {
        const grant = reviewGrant(
          'subcortical',
          focusText ?? 'sub-001',
          'run-qc',
        )
        return { openedAt: grant.openedAt, reviewGrant: grant }
      })
    const reveal = vi.spyOn(api.artifact, 'reveal').mockResolvedValue(undefined)
    renderScreen(RESOLVED_CFG, [artifact])
    await screen.findByRole('heading', { name: /Subject 001/ })
    const grid = await screen.findByRole('group', {
      name: /Subcortical montage for sub-001/,
    })
    const count = await screen.findByText(/12\/12 panels verified and drawn\./)
    // With every panel drawn the count adds nothing to the picture, so it
    // stays for assistive technology only.
    expect(count).toHaveStyle({
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
    })
    expect(screen.queryByText(/receipt 1{12}/)).toBeNull()
    expect(within(grid).getAllByRole('img').length).toBe(12)
    expect(screen.queryByRole('iframe')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(open).toHaveBeenCalledWith({
      project: QC_PROJECT,
      artifactId: artifact.artifactId,
      focusText: 'sub-001',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(reveal).toHaveBeenCalledWith({
      project: QC_PROJECT,
      artifactId: artifact.artifactId,
    })
  })

  it('should label every montage panel by axis and slice and open one full size', async () => {
    const api = getApi()
    const preview = vi.spyOn(api.artifact, 'previewImage')
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    const grid = await screen.findByRole('group', {
      name: /Subcortical montage for sub-001/,
    })
    await waitFor(() =>
      expect(within(grid).getAllByRole('button')).toHaveLength(12),
    )
    for (const axis of ['Axial', 'Coronal', 'Sagittal']) {
      expect(
        within(grid).getByRole('heading', { name: axis, level: 2 }),
      ).toBeVisible()
    }
    const panels = within(grid).getAllByRole('button')
    expect(panels).toHaveLength(12)
    expect(panels[0]).toHaveAccessibleName('Axial 20%, sub-001, panel 1 of 12')

    await waitFor(() => expect(panels[0]).toBeEnabled())
    preview.mockClear()
    fireEvent.click(panels[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName(
      'Axial 20%, sub-001, Subcortical montage',
    )
    // The title sits inside the standard dialog padding.
    expect(dialog.style.padding).toBe('18px')
    expect(await within(dialog).findByText(/Panel 1 of 12\./)).toBeVisible()
    await waitFor(() => expect(preview).toHaveBeenCalled())
    expect(preview.mock.calls[0]?.[0].artifactId).toMatch(
      /Subcortical_set_Axial_20\.png$/,
    )

    fireEvent.keyDown(dialog, { key: 'ArrowRight' })
    expect(await within(dialog).findByText(/Panel 2 of 12\./)).toBeVisible()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
  })

  it('should draw the exact protocol panel count for every gallery', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    for (const [name, panels] of [
      ['Subcortical', 12],
      ['Internal cortical', 16],
      ['External cortical', 4],
    ] as const) {
      fireEvent.click(screen.getByRole('radio', { name: new RegExp(name) }))
      const grid = await screen.findByRole('group', {
        name: new RegExp(`montage for sub-001`),
      })
      await waitFor(() =>
        expect(within(grid).getAllByRole('button')).toHaveLength(panels),
      )
      expect(
        await screen.findByText(
          new RegExp(`${panels}/${panels} panels verified and drawn`),
        ),
      ).toBeVisible()
    }
  })

  it('should refuse a verdict and name the reason when a montage panel cannot be read', async () => {
    const api = getApi()
    vi.spyOn(api.artifact, 'previewImage').mockRejectedValue(
      new Error(
        'Review the QC montage again because its image changed after detector verification.',
      ),
    )
    const attest = vi.spyOn(api.qc, 'attestGalleryView')
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    expect(
      (
        await screen.findAllByText(
          /Review the QC montage again because its image changed after detector verification\./,
        )
      ).length,
    ).toBeGreaterThan(0)
    // Fewer panels drew than the protocol shows, so the count stays visible.
    const count = await screen.findByText(
      /^\d+\/12 panels verified and drawn\.$/,
    )
    expect(count.textContent).not.toBe('12/12 panels verified and drawn.')
    expect(count).not.toHaveStyle({ position: 'absolute' })
    expect(attest).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^Pass$/ })).toBeDisabled()
  })

  it('should name the reason when the detector will not describe a montage', async () => {
    vi.spyOn(getApi().qc, 'galleryImages').mockRejectedValue(
      new Error(
        'Reload the QC gallery because it no longer matches the authoritative current ENIGMA run.',
      ),
    )
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    expect(
      await screen.findByText(/The Subcortical montage could not be shown\./),
    ).toBeVisible()
    expect(
      screen.getByText(
        /Reload the QC gallery because it no longer matches the authoritative current ENIGMA run\./,
      ),
    ).toBeVisible()
  })

  it('should honor the complete keyboard map without leaking through note or protocol controls', async () => {
    const api = getApi()
    const markQc = vi.spyOn(api.subjects, 'markQc')
    const onActiveSubjectChange = vi.fn()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: QC_ARTIFACTS,
      nextCursor: null,
      truncated: false,
      runId: 'run-12345678',
    })
    render(
      <AppProvider>
        <Bootstrap>
          <QcReviewScreen
            subjects={SAMPLE_COHORT}
            onActiveSubjectChange={onActiveSubjectChange}
          />
        </Bootstrap>
      </AppProvider>,
    )
    await screen.findByRole('heading', { name: /Subject 001/ })
    await openAllGalleries()

    const note = screen.getByRole('textbox', { name: 'Reviewer note' })
    fireEvent.focus(note)
    fireEvent.keyDown(window, { key: 'f' })
    expect(markQc).not.toHaveBeenCalled()
    fireEvent.blur(note)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(markQc).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'F' })
    await waitFor(() =>
      expect(markQc).toHaveBeenLastCalledWith(
        expect.objectContaining({ verdict: 'fail' }),
      ),
    )
    fireEvent.keyDown(window, { key: 'D' })
    await waitFor(() =>
      expect(markQc).toHaveBeenLastCalledWith(
        expect.objectContaining({ verdict: 'defer' }),
      ),
    )

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Subject 002/ })).toBeTruthy(),
    )
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Subject 001/ })).toBeTruthy(),
    )

    const internal = screen.getByRole('radio', {
      name: /Internal cortical/,
    })
    internal.focus()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(
      screen.getByRole('heading', { name: /Subject 001/ }),
    ).toBeInTheDocument()

    fireEvent.keyDown(window, { key: '3' })
    expect(
      screen.getByRole('radio', { name: /External cortical/ }),
    ).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(window, { key: 'unmapped' })
    expect(onActiveSubjectChange).toHaveBeenCalled()
  })

  it('should suppress QC shortcuts while the command palette dialog owns focus', async () => {
    const api = getApi()
    const markQc = vi.spyOn(api.subjects, 'markQc')
    const onActiveSubjectChange = vi.fn()
    render(
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            <QcReviewScreen
              subjects={SAMPLE_COHORT}
              onActiveSubjectChange={onActiveSubjectChange}
            />
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>,
    )
    await screen.findByRole('heading', { name: /Subject 001/ })
    render(
      <div role="dialog" aria-label="Command palette">
        <input aria-label="Command palette query" />
      </div>,
    )
    const query = screen.getByRole('textbox', {
      name: 'Command palette query',
    })
    query.focus()

    fireEvent.keyDown(query, { key: 'p' })
    fireEvent.keyDown(query, { key: 'j' })
    fireEvent.keyDown(query, { key: '3' })

    expect(markQc).not.toHaveBeenCalled()
    expect(onActiveSubjectChange).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: /Subcortical/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('should expose backend verdict failures and reject a mismatched write response', async () => {
    const api = getApi()
    const markQc = vi.spyOn(api.subjects, 'markQc')
    markQc.mockRejectedValueOnce('backend unavailable')
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    await openAllGalleries()

    fireEvent.click(screen.getByRole('button', { name: /^Fail$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Retry saving the QC verdict.',
    )

    markQc.mockResolvedValueOnce({
      subjectId: 'sub-wrong',
      verdict: 'pass',
      note: '',
      tags: [],
      revision: 2,
      updatedAt: new Date().toISOString(),
    })
    fireEvent.click(screen.getByRole('button', { name: /^Pass$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The QC write response identified another subject than the selected one.',
    )
  })

  it('coalesces rapid verdicts and binds the latest write to the committed revision', async () => {
    const api = getApi()
    const first = deferred<Awaited<ReturnType<typeof api.subjects.markQc>>>()
    const markQc = vi
      .spyOn(api.subjects, 'markQc')
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        subjectId: 'sub-001',
        verdict: 'defer',
        note: '',
        tags: [],
        revision: 12,
        updatedAt: new Date().toISOString(),
      })
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    await openAllGalleries()

    fireEvent.click(screen.getByRole('button', { name: /^Fail$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Defer$/ }))
    expect(markQc).toHaveBeenCalledTimes(1)

    first.resolve({
      subjectId: 'sub-001',
      verdict: 'fail',
      note: '',
      tags: [],
      revision: 11,
      updatedAt: new Date().toISOString(),
    })
    await waitFor(() => expect(markQc).toHaveBeenCalledTimes(2))
    expect(markQc).toHaveBeenLastCalledWith(
      expect.objectContaining({
        subjectId: 'sub-001',
        verdict: 'defer',
        expectedRevision: 11,
      }),
    )
    expect(
      await screen.findByRole('button', {
        name: /Defer \(current verdict\)/,
      }),
    ).toBeInTheDocument()
  })

  it('should save note errors distinctly and skip an unchanged blur', async () => {
    const api = getApi()
    const markQc = vi.spyOn(api.subjects, 'markQc')
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    const note = screen.getByRole('textbox', { name: 'Reviewer note' })

    fireEvent.focus(note)
    fireEvent.blur(note)
    expect(markQc).not.toHaveBeenCalled()

    markQc.mockRejectedValueOnce(new Error('note store unavailable'))
    fireEvent.change(note, { target: { value: 'Needs adjudication' } })
    fireEvent.blur(note)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'note store unavailable',
    )
  })

  it('should retain queue navigation through pointer hover and selection', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    const second = screen.getByRole('button', {
      name: /^sub-002,.*, QC (Pass|Fail|Defer|Unreviewed)$/,
    })
    fireEvent.mouseEnter(second)
    fireEvent.click(second)
    fireEvent.mouseLeave(second)
    expect(screen.getByRole('heading', { name: /Subject 002/ })).toBeTruthy()
  })

  it('should explain an unavailable requested subject', async () => {
    render(
      <AppProvider>
        <Bootstrap>
          <QcReviewScreen
            subjects={SAMPLE_COHORT}
            activeSubjectId="sub-unavailable"
          />
        </Bootstrap>
      </AppProvider>,
    )
    expect(
      await screen.findByText(
        'sub-unavailable is unavailable in this project.',
      ),
    ).toBeInTheDocument()
  })

  it('should announce each queue row verdict in its accessible name', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    const row = screen.getByRole('button', {
      name: /^sub-001,.*, QC (Pass|Fail|Defer|Unreviewed)$/,
    })
    expect(row).toBeTruthy()
  })

  it('draws each verdict with the ringed status glyph beside its word', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    const shapes = (root: Element): (string | null)[] =>
      [...root.querySelectorAll('svg[data-glyph-shape]')].map((glyph) =>
        glyph.getAttribute('data-glyph-shape'),
      )
    const queue = screen.getByRole('navigation', { name: 'Subject queue' })
    const legend = new Map(
      [...queue.querySelectorAll('svg[data-glyph-shape]')].map((glyph) => [
        glyph.parentElement?.textContent,
        glyph.getAttribute('data-glyph-shape'),
      ]),
    )
    expect(legend.get('Pass')).toBe('circleCheck')
    expect(legend.get('Fail')).toBe('circleX')
    expect(legend.get('Defer')).toBe('circlePause')
    expect(legend.get('Unreviewed')).toBe('ring')
    const progress = screen.getByText(/^Cohort progress/).parentElement!
    expect(shapes(progress)).toEqual([
      'circleCheck',
      'circleX',
      'circlePause',
      'ring',
    ])
  })

  it('should pair a Last updated time with a re-discover control', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    expect(shownStamps()).toHaveLength(1)
    const refresh = screen.getByRole('button', { name: /Re-discover cohort/ })
    fireEvent.click(refresh)
    expect(shownStamps()).toHaveLength(1)
    expect(screen.getByRole('heading', { name: /Subject 001/ })).toBeTruthy()
  })

  it('titles the Last updated time with the sentence Subjects uses', async () => {
    // Subjects titles the same stamp "The cohort was last updated at <time>.",
    // not with the raw ISO time.
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    const [stamp] = shownStamps()
    const shownTime = stamp!.textContent!.replace(/^Last updated /, '')
    expect(stamp).toHaveAttribute(
      'title',
      `The cohort was last updated at ${shownTime}.`,
    )
  })

  it('states no Last updated time until the shell cohort answers', async () => {
    const { discovery, discover } = renderWithHeldShellDiscovery()
    await waitFor(() => expect(discover).toHaveBeenCalled())
    expect(screen.getAllByText('Loading the cohort...').length).toBeGreaterThan(
      0,
    )
    // Nothing has been read yet, so no time can be stated for it.
    expect(shownStamps()).toHaveLength(0)

    await act(async () => {
      discovery.resolve(SAMPLE_COHORT)
      await discovery.promise
    })
    await screen.findByRole('heading', { name: /Subject 001/ })
    expect(shownStamps()).toHaveLength(1)
  })

  it('holds the room of the Last updated stamp in the header while the cohort loads', async () => {
    // If the stamp shared the title's row only while the title, the meta line,
    // and the time left it room, at 1214x768 and 135% text it would wrap to a
    // row of its own for a longer time or beside the pane's scrollbar. The
    // stamp waits for the cohort, so each load would end with a 62 px jump.
    const { discovery, discover } = renderWithHeldShellDiscovery()
    await waitFor(() => expect(discover).toHaveBeenCalled())
    const refresh = screen.getByRole('button', { name: 'Re-discover cohort' })
    const group = refresh.parentElement!

    // Before the cohort answers, the slot holds hidden stamps of the widest
    // times, which neither show nor announce anything.
    const reserved = within(group).getAllByText(/^Last updated /)
    expect(reserved.length).toBeGreaterThan(0)
    const hidden = reserved[0]!.closest('[aria-hidden="true"]')!
    expect(hidden).toHaveStyle({ visibility: 'hidden' })
    for (const stamp of reserved) {
      expect(hidden.contains(stamp)).toBe(true)
      expect(stamp).not.toHaveAttribute('aria-live')
    }
    // The title block claims a fixed share of the row, so whether the stamp
    // shares the title's row follows the pane's width alone, not the title,
    // the meta line or the time.
    const title = screen.getByRole('heading', { level: 1 }).parentElement!
    expect(title).toHaveStyle({ flexBasis: '280px' })

    await act(async () => {
      discovery.resolve(SAMPLE_COHORT)
      await discovery.promise
    })
    await screen.findByRole('heading', { name: /Subject 001/ })

    // The stamp takes the same slot; the reserved width stays with it.
    const shown = shownStamps()
    expect(shown).toHaveLength(1)
    expect(shown[0]).toHaveAttribute('aria-live', 'polite')
    expect(hidden.parentElement!.contains(shown[0]!)).toBe(true)
    expect(within(group).getAllByText(/^Last updated /)).toHaveLength(
      reserved.length + 1,
    )
  })

  it('keeps the queue gutter on the loading row while the cohort loads', async () => {
    // The loading row keeps the 12 px gutter of the queue title and rows.
    const { discover } = renderWithHeldShellDiscovery()
    await waitFor(() => expect(discover).toHaveBeenCalled())
    const queue = screen.getByRole('navigation', { name: 'Subject queue' })
    expect(within(queue).getByText(/^Queue /)).toHaveStyle({
      paddingLeft: '12px',
      paddingRight: '12px',
    })
    const loadingRow = within(queue).getByText('Loading the cohort...')
    expect(loadingRow).toHaveAttribute('role', 'status')
    expect(loadingRow.parentElement).toHaveStyle({
      paddingLeft: '12px',
      paddingRight: '12px',
    })
  })

  it('should not style the Pass verdict with the running color (blue)', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    await openAllGalleries()
    fireEvent.keyDown(window, { key: 'p' })
    const btn = await screen.findByRole('button', {
      name: /Pass \(current verdict\)/,
    })
    const bg = btn.style.background
    expect(bg).not.toBe('')
    expect(bg).not.toContain('91, 141, 239') // Running #5b8def in dark theme RGB.
    expect(bg).not.toContain('#5b8def')
  })

  it('draws the current Pass verdict apart from an unpressed Pass in every theme', async () => {
    // A caller style that pins the Pass fill can cancel the shared pressed
    // look, so measure the drawn verdict rather than the button atom alone.
    const themes = [
      ['dark', false],
      ['dark', true],
      ['light', false],
      ['light', true],
    ] as const
    let app: ReturnType<typeof useApp> | null = null
    function AppHandle(): ReactNode {
      const current = useApp()
      useLayoutEffect(() => {
        app = current
      }, [current])
      return null
    }
    type Rgb = [number, number, number]
    const channels = (color: string): Rgb => {
      const parts = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/)
      if (!parts) throw new Error(`Supply an opaque rgb() color, not ${color}.`)
      return [Number(parts[1]), Number(parts[2]), Number(parts[3])]
    }
    const contrast = (a: string, b: string): number => {
      const lum = (color: string): number => {
        const [r, g, bl] = channels(color).map((c) => {
          const s = c / 255
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }) as Rgb
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl
      }
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [
        number,
        number,
      ]
      return (hi + 0.05) / (lo + 0.05)
    }
    interface Look {
      fill: string
      label: string
      keyline: string
    }
    /** Read the Pass verdict's fill, label, and keyline in each theme. */
    const passLooks = async (): Promise<Look[]> => {
      const looks: Look[] = []
      for (const [theme, highContrast] of themes) {
        act(() => app?.setTweaks({ theme, highContrast }))
        const base = THEMES[theme]
        const expected = highContrast ? highContrastTheme(base) : base
        await waitFor(() => expect(app?.t).toEqual(expected))
        const pass = screen.getByRole('button', {
          name: /^Pass(?: \(current verdict\))?$/,
        })
        looks.push({
          fill: pass.style.backgroundColor,
          label: pass.style.color,
          keyline: pass.style.boxShadow,
        })
      }
      return looks
    }

    vi.spyOn(getApi().results, 'list').mockResolvedValue({
      items: QC_ARTIFACTS,
      nextCursor: null,
      truncated: false,
      runId: 'run-12345678',
    })
    render(
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            <AppHandle />
            <QcReviewScreen subjects={SAMPLE_COHORT} />
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>,
    )
    await screen.findByRole('heading', { name: /Subject 001/ })
    await openAllGalleries()
    expect(screen.getByRole('button', { name: /^Pass$/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    const off = await passLooks()
    fireEvent.keyDown(window, { key: 'p' })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Pass (current verdict)' }),
      ).toHaveAttribute('aria-pressed', 'true'),
    )
    const on = await passLooks()

    themes.forEach(([theme, highContrast], i) => {
      const name = `${theme}${highContrast ? ' high-contrast' : ''}`
      const was = off[i]!
      const now = on[i]!
      // WCAG 2.2 SC 1.4.11: the state change itself reaches 3:1.
      expect(
        contrast(now.fill, was.fill),
        `${name} fill change`,
      ).toBeGreaterThanOrEqual(3)
      // WCAG 2.2 SC 1.4.3: the label holds 4.5:1 in both states.
      expect(
        contrast(was.label, was.fill),
        `${name} unpressed label`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(now.label, now.fill),
        `${name} pressed label`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(was.keyline, `${name} unpressed keyline`).toBe('')
      expect(now.keyline, `${name} pressed keyline`).toMatch(
        /^inset 0 0 0 1px currentcolor$/i,
      )
    })
  })

  it('Explains what each verdict does to the current analysis.', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    // Each title states what the verdict means rather than giving an order;
    // the rail draws no paragraph between the buttons.
    for (const [name, help] of [
      [
        'Pass',
        'Pass means the reviewer accepts the subject, and it stays in the current analysis.',
      ],
      [
        'Fail',
        'Fail means the reviewer rejects the subject, and downstream cohort analysis excludes it.',
      ],
      [
        'Defer',
        'Defer means the subject needs another review before it gets a current-analysis verdict.',
      ],
    ] as const) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveAttribute('title', help)
      expect(button).toHaveAccessibleDescription(help)
      expect(screen.queryByText(help)).toBeNull()
    }
  })

  it('counts the reviewed galleries in the verdict gate', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    await screen.findByText('Reviewed in app')
    expect(
      screen.getByText('Review all three galleries first (1/3).'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Internal cortical' }))
    await screen.findByRole('group', { name: /montage for sub-001/ })
    await screen.findByText('Reviewed in app')
    expect(
      await screen.findByText('Review all three galleries first (2/3).'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'External cortical' }))
    await screen.findByRole('group', { name: /montage for sub-001/ })
    await screen.findByText('Reviewed in app')
    expect(screen.queryByText(/^Review all three galleries first/)).toBeNull()
    expect(screen.getByRole('button', { name: /^Pass/ })).toBeEnabled()
  })

  it('should explain why the verdict controls are disabled with no subject', async () => {
    renderEmptyScreen()
    await screen.findByText('No subjects are in this cohort.')
    expect(
      screen.getByText(/Select a subject from the queue to record a verdict/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Pass$/ })).toBeDisabled()
  })

  it('should describe the active ENIGMA gallery in plain language', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    // Each tab is named by its gallery alone and carries its help and its
    // shortcut in the title; no sentence sits under the tabs.
    const tabs = within(
      screen.getByRole('radiogroup', { name: /ENIGMA QC protocol/ }),
    ).getAllByRole('radio')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Subcortical',
      'Internal cortical',
      'External cortical',
    ])
    expect(tabs[0]).toHaveAttribute(
      'title',
      expect.stringMatching(/deep structures.* Shortcut: 1\.$/i),
    )
    expect(tabs[1]).toHaveAttribute(
      'title',
      expect.stringMatching(/surface-reconstruction errors.* Shortcut: 2\.$/i),
    )
    expect(tabs[2]).toHaveAttribute(
      'title',
      expect.stringMatching(/ Shortcut: 3\.$/),
    )
    expect(screen.queryByText(/deep structures/i)).toBeNull()
    expect(screen.queryByText(/ENIGMA QC protocol/i)).toBeNull()
    fireEvent.keyDown(window, { key: '2' })
    await waitFor(() => {
      expect(tabs[1]).toHaveAttribute('aria-checked', 'true')
    })
    expect(screen.queryByText(/surface-reconstruction errors/i)).toBeNull()
  })

  it('sets only the display heading in the notebook serif', async () => {
    renderScreen()
    const heading = await screen.findByRole('heading', { name: /Subject 001/ })
    expect(heading.style.fontFamily).toContain('WebCM Serif 10')
    expect(heading.style.fontSize).toBe('20px')
    // Labels, the note, and statuses stay sans in both tones.
    const note = screen.getByRole('textbox', { name: 'Reviewer note' })
    expect(note.style.fontFamily).toContain('WebCM Sans 10')
    expect(note.parentElement?.style.fontFamily).toContain('WebCM Sans 10')
  })

  it('should toggle the keyboard shortcuts from an always-present control', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    // The keys are set in mono as keyboard input; the action reads in sans.
    const keys = screen.getByText('J, K')
    expect(keys.tagName).toBe('KBD')
    expect(keys.parentElement).toHaveTextContent('J, K Next, previous')
    expect(keys.parentElement?.style.fontFamily).toContain('WebCM Sans 10')
    fireEvent.click(
      screen.getByRole('button', { name: /Hide keyboard shortcuts/ }),
    )
    expect(screen.queryByText('J, K')).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: /Show keyboard shortcuts/ }),
    )
    expect(screen.getByText('J, K')).toBeInTheDocument()
    expect(screen.getByText('P, F, D').parentElement).toHaveTextContent(
      'P, F, D Verdict',
    )
    expect(screen.getByText('1, 2, 3').parentElement).toHaveTextContent(
      '1, 2, 3 Gallery',
    )
  })

  it('keeps the header height independent of the subject meta line', async () => {
    // At 135% text an SCI subject's meta line wraps and a control's does not,
    // so without a reserve J/K between them would move the gallery. jsdom lays
    // nothing out, so pin the structure: the line shares one grid cell with a
    // hidden reserve that is the same for every subject and, in the monospace
    // meta font, at least as long as any subject's line.
    const cohort = makeMockCohort(12, 17)
    expect(new Set(cohort.map((subject) => subject.cohort))).toEqual(
      new Set(['CTRL', 'SCI_nNP', 'SCI_P']),
    )
    vi.spyOn(getApi().results, 'list').mockResolvedValue({
      items: QC_ARTIFACTS,
      nextCursor: null,
      truncated: false,
      runId: 'run-12345678',
    })
    render(
      <AppProvider>
        <DurableMutationsProvider>
          <Bootstrap>
            <QcReviewScreen subjects={cohort} />
          </Bootstrap>
        </DurableMutationsProvider>
      </AppProvider>,
    )
    const reserves = new Set<string>()
    for (const [index, subject] of cohort.entries()) {
      const heading = await screen.findByRole('heading', {
        name: `Subject ${String(index + 1).padStart(3, '0')}`,
      })
      const slot = heading.nextElementSibling as HTMLElement
      const reserve = slot.querySelector('[data-reserve="meta-line"]')!
      expect(slot).toHaveStyle({ display: 'grid' })
      expect(reserve).toHaveAttribute('aria-hidden', 'true')
      expect(reserve).toHaveStyle({ visibility: 'hidden', gridArea: '1 / 1' })
      const line = [...slot.children].find((child) => child !== reserve)!
      expect(line).toHaveStyle({ gridArea: '1 / 1' })
      expect(line.textContent).toContain(`Age ${subject.age ?? '-'}`)
      if (subject.tSinceSci != null) {
        expect(line.textContent).toContain(
          `${subject.tSinceSci} ${subject.tSinceSci === 1 ? 'year' : 'years'} after SCI`,
        )
      }
      expect(reserve.textContent!.length).toBeGreaterThanOrEqual(
        line.textContent!.length,
      )
      reserves.add(reserve.textContent!)
      fireEvent.keyDown(window, { key: 'j' })
    }
    expect(reserves.size).toBe(1)
    // The reserve's tips are neither shown nor reachable: every tip button a
    // user can reach belongs to the shown line.
    const reserveTips = document.querySelectorAll(
      '[data-reserve="meta-line"] button',
    )
    expect(reserveTips.length).toBeGreaterThan(0)
    for (const button of screen.queryAllByRole('button', {
      name: /^About (AIS grade|years after SCI)/,
    })) {
      expect(button.closest('[data-reserve]')).toBeNull()
    }
  })

  it('Expands the AIS abbreviation for a SCI subject.', async () => {
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    for (let i = 0; i < SAMPLE_COHORT.length; i++) {
      const ais = screen.queryByRole('button', { name: /About AIS grade/i })
      if (ais) {
        expect(ais).toHaveAccessibleDescription(/ASIA Impairment Scale/i)
        expect(
          screen.getByRole('button', { name: 'About years after SCI' }),
        ).toHaveAccessibleDescription(
          'Years from the spinal cord injury (SCI) to the scan.',
        )
        return
      }
      fireEvent.keyDown(window, { key: 'j' })
    }
    throw new Error('Include an SCI subject with an AIS grade in the cohort.')
  })
})

function registrationRow(
  subjectId: string,
  flaggedRight = false,
): RegistrationSubjectResult {
  const normal = {
    state: 'checked' as const,
    rCortex: 0.84,
    rDfp: 0.86,
    flagged: false,
    measure: 'dfp' as const,
    z: 0.2,
    message: null,
  }
  return {
    subjectId,
    flagged: flaggedRight,
    hemispheres: [
      { hemisphere: 'lh', ...normal },
      flaggedRight
        ? {
            hemisphere: 'rh',
            ...normal,
            rCortex: 0.7269,
            rDfp: 0.6691,
            flagged: true,
            z: -7.93,
          }
        : { hemisphere: 'rh', ...normal },
    ],
  }
}

function registrationStatus(
  patch: Partial<SurfaceRegistrationStatus> = {},
): SurfaceRegistrationStatus {
  const subjects = SAMPLE_COHORT.map((subject) =>
    registrationRow(subject.id, subject.id === 'sub-003'),
  )
  return {
    configRevision: 0,
    method: 'sulc-fsaverage-pearson-v1',
    available: true,
    unavailableReason: null,
    rule: { zLimit: -3, floor: 0.7, minCohortHemispheres: 20 },
    reference: {
      source: 'builtin',
      hemispheres: 8,
      cortex: { median: 0.8342, scale: 0.0198 },
      dfp: { median: 0.8556, scale: 0.0235 },
    },
    operation: null,
    subjects,
    counts: {
      subjects: subjects.length,
      checked: 8,
      pending: 0,
      failed: 0,
      missing: 0,
      flaggedSubjects: 1,
      flaggedHemispheres: 1,
    },
    ...patch,
  }
}

const REGISTRATION_COUNTS = registrationStatus().counts

const REGISTRATION_OPERATION = {
  operationId: 'srg-0123456789abcdef',
  state: 'running' as const,
  total: 8,
  completed: 3,
  failed: 0,
  startedAt: '2026-09-25T06:00:00.000Z',
  finishedAt: null,
  message: null,
}

describe('QcReviewScreen surface registration check', () => {
  it('flags a subject, states the advisory, and filters the queue to it', async () => {
    const api = getApi()
    vi.spyOn(api.surfaceRegistration, 'status').mockResolvedValue(
      registrationStatus(),
    )
    const check = vi.spyOn(api.surfaceRegistration, 'check')
    renderScreen()
    await screen.findByRole('heading', { name: /Subject 001/ })
    const section = screen.getByRole('region', { name: 'Surface registration' })
    await within(section).findByText('1 subject fits the atlas poorly.')
    // Every hemisphere has a current result, so nothing starts on its own.
    expect(check).not.toHaveBeenCalled()
    const queue = screen.getByRole('navigation', { name: 'Subject queue' })
    expect(
      within(queue).getByRole('button', {
        name: /^sub-003, .*, surface registration flagged$/,
      }),
    ).toBeInTheDocument()
    expect(
      within(queue).getByRole('button', { name: /^sub-001, / }),
    ).not.toHaveAccessibleName(/flagged/)
    expect(
      screen.queryByRole('note', { name: 'Surface registration advisory' }),
    ).toBeNull()

    const filter = within(section).getByRole('button', {
      name: 'Show flagged (1)',
    })
    expect(filter).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(filter)

    expect(filter).toHaveAttribute('aria-pressed', 'true')
    expect(within(queue).getByText(/Queue/)).toHaveTextContent(
      'Queue 1 of 4, flagged only',
    )
    expect(
      within(queue).getAllByRole('button', { name: /^sub-/ }),
    ).toHaveLength(1)
    await screen.findByRole('heading', { name: /Subject 003/ })
    const advisory = screen.getByRole('note', {
      name: 'Surface registration advisory',
    })
    expect(advisory).toHaveTextContent(
      'Right hemisphere: the surface registration fits the atlas poorly (dorsal frontoparietal sulcal correlation 0.67; reference median 0.86). The parcel labels may be shifted; check the External cortical gallery.',
    )
    // The advisory sets no verdict and the verdict controls keep their state.
    expect(screen.getByRole('button', { name: /^Pass/ })).toBeDisabled()
    // J and K move through the filtered queue only.
    fireEvent.keyDown(window, { key: 'j' })
    expect(
      screen.getByRole('heading', { name: /Subject 003/ }),
    ).toBeInTheDocument()

    fireEvent.click(filter)
    expect(
      within(queue).getAllByRole('button', { name: /^sub-/ }),
    ).toHaveLength(4)
    fireEvent.keyDown(window, { key: 'j' })
    await screen.findByRole('heading', { name: /Subject 004/ })
    expect(
      screen.queryByRole('note', { name: 'Surface registration advisory' }),
    ).toBeNull()
  })

  it('starts the check once for unchecked hemispheres and can stop it', async () => {
    const api = getApi()
    const status = vi
      .spyOn(api.surfaceRegistration, 'status')
      .mockResolvedValueOnce(
        registrationStatus({
          subjects: [],
          counts: {
            subjects: 0,
            checked: 0,
            pending: 8,
            failed: 0,
            missing: 0,
            flaggedSubjects: 0,
            flaggedHemispheres: 0,
          },
        }),
      )
      .mockResolvedValue(
        registrationStatus({
          operation: REGISTRATION_OPERATION,
          counts: { ...REGISTRATION_COUNTS, checked: 3, pending: 5 },
        }),
      )
    const check = vi
      .spyOn(api.surfaceRegistration, 'check')
      .mockResolvedValue({ operation: REGISTRATION_OPERATION, started: true })
    const cancel = vi
      .spyOn(api.surfaceRegistration, 'cancel')
      .mockResolvedValue({
        operationId: REGISTRATION_OPERATION.operationId,
        stopped: true,
      })
    renderScreen()
    const section = await screen.findByRole('region', {
      name: 'Surface registration',
    })
    await within(section).findByText(
      '3 of 8 hemispheres checked. 1 subject is flagged so far. Flags are provisional until every hemisphere is checked.',
    )
    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledWith({ project: QC_PROJECT })
    expect(status).toHaveBeenCalledWith({ project: QC_PROJECT })
    // The queue header states the running check without scrolling the rail.
    const queue = screen.getByRole('navigation', { name: 'Subject queue' })
    expect(
      within(queue).getByRole('button', {
        name: 'Surface registration: 3 of 8 checked, 1 subject flagged',
      }),
    ).toBeInTheDocument()

    fireEvent.click(
      within(section).getByRole('button', { name: 'Stop the check' }),
    )
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith({
        project: QC_PROJECT,
        operationId: REGISTRATION_OPERATION.operationId,
      }),
    )
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('states the flags in the queue header and leads to the section', async () => {
    const api = getApi()
    vi.spyOn(api.surfaceRegistration, 'status').mockResolvedValue(
      registrationStatus(),
    )
    renderScreen()
    const queue = screen.getByRole('navigation', { name: 'Subject queue' })
    const line = await within(queue).findByRole('button', {
      name: 'Surface registration: 1 subject flagged',
    })
    const section = screen.getByRole('region', { name: 'Surface registration' })
    const rail = section.parentElement!
    // The jsdom environment lays nothing out: give the section an offset and
    // watch the rail's scroll position.
    Object.defineProperty(section, 'offsetTop', { value: 640 })
    let railScroll = 0
    Object.defineProperty(rail, 'scrollTop', {
      get: () => railScroll,
      set: (value: number) => {
        railScroll = value
      },
    })

    fireEvent.click(line)

    expect(railScroll).toBe(632)
    expect(section).toHaveFocus()
    // The line leads to the section; it neither filters nor selects.
    expect(
      within(queue).getAllByRole('button', { name: /^sub-/ }),
    ).toHaveLength(4)
    expect(
      screen.getByRole('heading', { name: /Subject 001/ }),
    ).toBeInTheDocument()
  })

  it('holds the queue line from the first frame so the status moves no row', async () => {
    // The status can arrive many seconds into a launch. The line states the
    // read from the first frame in the same element, which holds two rows of
    // room, so its arrival pushes no queue row down.
    const api = getApi()
    let resolveStatus!: (value: SurfaceRegistrationStatus) => void
    vi.spyOn(api.surfaceRegistration, 'status').mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve
      }),
    )
    renderScreen()
    const queue = screen.getByRole('navigation', { name: 'Subject queue' })
    const line = within(queue).getByRole('button', {
      name: 'Surface registration: reading...',
    })
    expect(line).toHaveStyle({ minHeight: `${2 * 11 * 1.4 + 8}px` })
    await within(queue).findAllByRole('button', { name: /^sub-/ })

    await act(async () => resolveStatus(registrationStatus()))
    expect(
      within(queue).getByRole('button', {
        name: 'Surface registration: 1 subject flagged',
      }),
    ).toBe(line)
  })

  it.each([
    [
      'no hemisphere is flagged',
      {
        subjects: [],
        counts: { ...REGISTRATION_COUNTS, flaggedSubjects: 0 },
      },
      'Surface registration: no subject flagged',
    ],
    [
      'the operator stopped the check',
      {
        subjects: [],
        operation: {
          ...REGISTRATION_OPERATION,
          state: 'cancelled' as const,
          finishedAt: '2026-09-25T06:01:00.000Z',
        },
        counts: {
          ...REGISTRATION_COUNTS,
          checked: 3,
          pending: 5,
          flaggedSubjects: 0,
        },
      },
      'Surface registration: 3 of 8 checked',
    ],
    [
      'no subject has reconstructed surfaces',
      {
        subjects: [],
        counts: {
          ...REGISTRATION_COUNTS,
          subjects: 0,
          checked: 0,
          flaggedSubjects: 0,
          flaggedHemispheres: 0,
        },
      },
      'Surface registration: no reconstructed surfaces yet',
    ],
  ])(
    'states the check as a fact in the queue when %s',
    async (_case, patch, name) => {
      const api = getApi()
      vi.spyOn(api.surfaceRegistration, 'status').mockResolvedValue(
        registrationStatus(patch),
      )
      vi.spyOn(api.surfaceRegistration, 'check').mockResolvedValue({
        operation: REGISTRATION_OPERATION,
        started: false,
      })
      renderScreen()
      const queue = screen.getByRole('navigation', { name: 'Subject queue' })
      expect(
        await within(queue).findByRole('button', { name }),
      ).toBeInTheDocument()
    },
  )

  it('states in the queue that the check status could not be read', async () => {
    vi.spyOn(getApi().surfaceRegistration, 'status').mockRejectedValue(
      new Error('The sidecar is not ready.'),
    )
    renderScreen()
    const queue = screen.getByRole('navigation', { name: 'Subject queue' })
    expect(
      await within(queue).findByRole('button', {
        name: 'Surface registration: the status could not be read',
      }),
    ).toBeInTheDocument()
  })

  it('counts a check that continues after a stop against the whole cohort', async () => {
    const api = getApi()
    // Stopped at 3 of 8; the continuing check covers only the 5 left.
    vi.spyOn(api.surfaceRegistration, 'status').mockResolvedValue(
      registrationStatus({
        operation: { ...REGISTRATION_OPERATION, total: 5, completed: 1 },
        counts: { ...REGISTRATION_COUNTS, checked: 4, pending: 4 },
      }),
    )
    const check = vi.spyOn(api.surfaceRegistration, 'check')
    renderScreen()
    const section = await screen.findByRole('region', {
      name: 'Surface registration',
    })
    await within(section).findByText(
      '4 of 8 hemispheres checked. 1 subject is flagged so far. Flags are provisional until every hemisphere is checked.',
    )
    const queue = screen.getByRole('navigation', { name: 'Subject queue' })
    expect(
      within(queue).getByRole('button', {
        name: 'Surface registration: 4 of 8 checked, 1 subject flagged',
      }),
    ).toBeInTheDocument()
    // A running check is followed, not started again.
    expect(check).not.toHaveBeenCalled()
  })

  it('states a flag shown during a running check as provisional', async () => {
    const api = getApi()
    vi.spyOn(api.surfaceRegistration, 'status').mockResolvedValue(
      registrationStatus({ operation: REGISTRATION_OPERATION }),
    )
    renderScreen()
    const queue = screen.getByRole('navigation', { name: 'Subject queue' })
    fireEvent.click(
      await within(queue).findByRole('button', {
        name: /^sub-003, .*, surface registration flagged$/,
      }),
    )
    const advisory = await screen.findByRole('note', {
      name: 'Surface registration advisory',
    })
    expect(advisory).toHaveTextContent(
      'Right hemisphere: the surface registration fits the atlas poorly (dorsal frontoparietal sulcal correlation 0.67; reference median 0.86). The parcel labels may be shifted; check the External cortical gallery. Flags are provisional until every hemisphere is checked.',
    )
  })

  it.each([
    [
      'The check needs FreeSurfer, and no FreeSurfer install root is set.',
      'Surface registration: not checked (FreeSurfer install root not set)',
    ],
    [
      'The check needs the FreeSurfer license, and the license file was not found; choose it in Diagnostics.',
      'Surface registration: not checked (FreeSurfer license not found)',
    ],
  ])(
    'says why the check cannot run and offers no check: %s',
    async (reason, queueLine) => {
      const api = getApi()
      vi.spyOn(api.surfaceRegistration, 'status').mockResolvedValue(
        registrationStatus({
          available: false,
          unavailableReason: reason,
          counts: {
            subjects: 4,
            checked: 0,
            pending: 8,
            failed: 0,
            missing: 0,
            flaggedSubjects: 0,
            flaggedHemispheres: 0,
          },
          subjects: SAMPLE_COHORT.map((subject) => ({
            subjectId: subject.id,
            flagged: false,
            hemispheres: (['lh', 'rh'] as const).map((hemisphere) => ({
              hemisphere,
              state: 'pending' as const,
              rCortex: null,
              rDfp: null,
              flagged: false,
              measure: null,
              z: null,
              message: null,
            })),
          })),
        }),
      )
      const check = vi.spyOn(api.surfaceRegistration, 'check')
      renderScreen()
      const section = await screen.findByRole('region', {
        name: 'Surface registration',
      })
      await within(section).findByText(
        `8 hemispheres are not checked. ${reason}`,
      )
      const action = within(section).getByRole('button', {
        name: 'Check surface registration',
      })
      expect(action).toBeDisabled()
      expect(action).toHaveAttribute('title', reason)
      expect(
        within(section).queryByRole('button', { name: /flagged subjects/ }),
      ).toBeNull()
      // The rail's reason sits below its fold at 1214x768 with 135% text, so
      // the queue header states it in short and leads to the section.
      expect(
        within(
          screen.getByRole('navigation', { name: 'Subject queue' }),
        ).getByRole('button', { name: queueLine }),
      ).toBeInTheDocument()
      expect(check).not.toHaveBeenCalled()
    },
  )

  it('states why the last check stopped when FreeSurfer rejects its license', async () => {
    const api = getApi()
    const pending = SAMPLE_COHORT.map((subject) => ({
      subjectId: subject.id,
      flagged: false,
      hemispheres: (['lh', 'rh'] as const).map((hemisphere) => ({
        hemisphere,
        state: 'pending' as const,
        rCortex: null,
        rDfp: null,
        flagged: false,
        measure: null,
        z: null,
        message: null,
      })),
    }))
    vi.spyOn(api.surfaceRegistration, 'status').mockResolvedValue(
      registrationStatus({
        operation: {
          ...REGISTRATION_OPERATION,
          state: 'failed',
          completed: 0,
          finishedAt: '2026-09-25T06:00:01.000Z',
          message:
            'FreeSurfer did not accept its license file, so mri_surf2surf could not run; choose a valid license in Diagnostics.',
        },
        subjects: pending,
        counts: {
          subjects: pending.length,
          checked: 0,
          pending: 8,
          failed: 0,
          missing: 0,
          flaggedSubjects: 0,
          flaggedHemispheres: 0,
        },
      }),
    )
    const check = vi.spyOn(api.surfaceRegistration, 'check').mockResolvedValue({
      operation: { ...REGISTRATION_OPERATION, state: 'failed' },
      started: true,
    })
    renderScreen()
    const section = await screen.findByRole('region', {
      name: 'Surface registration',
    })
    await within(section).findByText(
      '8 hemispheres are not checked. The last check stopped: FreeSurfer did not accept its license file, so mri_surf2surf could not run; choose a valid license in Diagnostics.',
    )
    expect(
      within(section).getByRole('button', {
        name: 'Check surface registration',
      }),
    ).toBeEnabled()
    // The same setup would stop another check the same way, so QC review
    // starts none on its own.
    expect(check).not.toHaveBeenCalled()
    expect(
      within(
        screen.getByRole('navigation', { name: 'Subject queue' }),
      ).getByRole('button', {
        name: 'Surface registration: not checked (the last check stopped: FreeSurfer did not accept its license)',
      }),
    ).toBeInTheDocument()
  })

  it('retries failed hemispheres from the explicit action', async () => {
    const api = getApi()
    vi.spyOn(api.surfaceRegistration, 'status').mockResolvedValue(
      registrationStatus(),
    )
    const check = vi.spyOn(api.surfaceRegistration, 'check').mockResolvedValue({
      operation: { ...REGISTRATION_OPERATION, state: 'done', completed: 8 },
      started: true,
    })
    renderScreen()
    const section = await screen.findByRole('region', {
      name: 'Surface registration',
    })
    fireEvent.click(
      await within(section).findByRole('button', {
        name: 'Check surface registration',
      }),
    )
    await waitFor(() =>
      expect(check).toHaveBeenCalledWith({
        project: QC_PROJECT,
        retryFailed: true,
      }),
    )
  })

  describe('after FreeSurfer stops a check', () => {
    const LICENSE_REJECTED =
      'FreeSurfer did not accept its license file, so mri_surf2surf could not run; choose a valid license in Diagnostics.'
    const STOPPED_SUMMARY = `8 hemispheres are not checked. The last check stopped: ${LICENSE_REJECTED}`

    function uncheckedStatus(
      operation: SurfaceRegistrationStatus['operation'],
    ): SurfaceRegistrationStatus {
      const subjects = SAMPLE_COHORT.map((subject) => ({
        subjectId: subject.id,
        flagged: false,
        hemispheres: (['lh', 'rh'] as const).map((hemisphere) => ({
          hemisphere,
          state: 'pending' as const,
          rCortex: null,
          rDfp: null,
          flagged: false,
          measure: null,
          z: null,
          message: null,
        })),
      }))
      return registrationStatus({
        operation,
        subjects,
        counts: {
          subjects: subjects.length,
          checked: 0,
          pending: 8,
          failed: 0,
          missing: 0,
          flaggedSubjects: 0,
          flaggedHemispheres: 0,
        },
      })
    }

    /** Mock a first check that FreeSurfer stops at once over its license. */
    function mockRejectedLicense(operationId: string) {
      const api = getApi()
      const started = {
        ...REGISTRATION_OPERATION,
        operationId,
        completed: 0,
      }
      const stopped = {
        ...started,
        state: 'failed' as const,
        finishedAt: '2026-09-25T06:00:01.000Z',
        message: LICENSE_REJECTED,
      }
      vi.spyOn(api.surfaceRegistration, 'status')
        .mockResolvedValueOnce(uncheckedStatus(null))
        .mockResolvedValue(uncheckedStatus(stopped))
      return vi
        .spyOn(api.surfaceRegistration, 'check')
        .mockResolvedValue({ operation: started, started: true })
    }

    /**
     * Keep the shell mounted and open or leave QC review, as the navigation
     * does, with a save of a new license setting between visits.
     */
    function Visits(): ReactNode {
      const app = useApp()
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setOpen((shown) => !shown)}>
            {open ? 'Leave QC review' : 'Open QC review'}
          </button>
          <button
            type="button"
            onClick={() =>
              void app.saveProject({
                ...app.cfg,
                tools: {
                  ...app.cfg.tools,
                  freesurferLicense: '/opt/freesurfer/license.txt',
                },
              })
            }
          >
            Save a new license setting
          </button>
          {open && <QcReviewScreen subjects={SAMPLE_COHORT} />}
        </>
      )
    }

    function renderVisits(): void {
      vi.spyOn(getApi().results, 'list').mockResolvedValue({
        items: QC_ARTIFACTS,
        nextCursor: null,
        truncated: false,
        runId: 'run-12345678',
      })
      render(
        <AppProvider>
          <DurableMutationsProvider>
            <Bootstrap>
              <Visits />
            </Bootstrap>
          </DurableMutationsProvider>
        </AppProvider>,
      )
    }

    async function stoppedSection(): Promise<HTMLElement> {
      const section = await screen.findByRole('region', {
        name: 'Surface registration',
      })
      await within(section).findByText(STOPPED_SUMMARY)
      return section
    }

    /** Leave QC review and open it again once the status was read. */
    async function revisit(): Promise<HTMLElement> {
      fireEvent.click(screen.getByRole('button', { name: 'Leave QC review' }))
      expect(
        screen.queryByRole('region', { name: 'Surface registration' }),
      ).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Open QC review' }))
      const section = await stoppedSection()
      await act(async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      })
      return section
    }

    it('starts no check on its own at the next visit; the action still retries', async () => {
      const check = mockRejectedLicense('srg-00000000000000a1')
      renderVisits()
      await stoppedSection()
      expect(check).toHaveBeenCalledTimes(1)

      // The same license would stop another check the same way.
      const section = await revisit()
      expect(check).toHaveBeenCalledTimes(1)

      fireEvent.click(
        within(section).getByRole('button', {
          name: 'Check surface registration',
        }),
      )
      await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
      expect(check).toHaveBeenLastCalledWith({
        project: QC_PROJECT,
        retryFailed: true,
      })
    })

    it('starts a check on its own again once the saved license setting changes', async () => {
      const check = mockRejectedLicense('srg-00000000000000b2')
      renderVisits()
      await stoppedSection()
      expect(check).toHaveBeenCalledTimes(1)
      await revisit()
      expect(check).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: 'Leave QC review' }))
      const save = vi.spyOn(getApi().project, 'save')
      fireEvent.click(
        screen.getByRole('button', { name: 'Save a new license setting' }),
      )
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
      await act(async () => {
        await save.mock.results[0]!.value
      })
      fireEvent.click(screen.getByRole('button', { name: 'Open QC review' }))
      await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
      expect(check).toHaveBeenLastCalledWith({ project: QC_PROJECT })
    })
  })
})
