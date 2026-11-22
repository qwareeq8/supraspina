import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  InputFovItem,
  InputFovReview,
} from '../../shared/scientific-contracts'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import { AppProvider, useApp } from '../state/context'
import { getApi } from '../state/api'
import { cropInventory, forgetCropInventory } from '../state/crop-inventory'
import { THEMES } from '../theme/tokens'
import { InputQcScreen } from './InputQcScreen'

const PROJECT = {
  projectId: 'input-qc-project',
  root: '/projects/input-qc',
  configPath: '/projects/input-qc/supraspina.project.json',
  epoch: 1,
}
const SAVED_CFG = {
  ...DEFAULT_PROJECT_CONFIG,
  paths: {
    ...DEFAULT_PROJECT_CONFIG.paths,
    projectRoot: PROJECT.root,
  },
}
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)
const HASH_E = 'e'.repeat(64)

function luminance(color: string): number {
  const channels = color
    .replace('#', '')
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)
  if (!channels || channels.length !== 3) {
    throw new Error(`Provide a six-digit hex color; received ${color}.`)
  }
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground)
  const backgroundLuminance = luminance(background)
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  )
}

function review(
  decision: InputFovReview['decision'],
  current: boolean,
  revision: number,
): InputFovReview {
  return {
    decision,
    current,
    revision,
    configRevision: 0,
    reviewedAt: '2026-07-30T12:00:00.000Z',
    decisionSignature: HASH_C,
  }
}

function item(
  subjectId: string,
  options: {
    sessionId?: string | null
    acquisitionId?: string | null
    passThrough?: boolean
    review?: InputFovReview | null
  } = {},
): InputFovItem {
  const passThrough = options.passThrough ?? false
  return {
    subjectId,
    sessionId: options.sessionId ?? null,
    acquisitionId: options.acquisitionId ?? null,
    preflightSignature: HASH_A,
    sourceSha256: HASH_B,
    outputSha256: passThrough ? HASH_B : HASH_C,
    passThrough,
    requiresReview: !passThrough,
    qcArtifactId: `input-fov-qc:${HASH_A}`,
    qcDisplayPath: `sub-${subjectId}_desc-brainfov_qc.png`,
    review: options.review ?? null,
  }
}

const ITEMS: InputFovItem[] = [
  item('sub-pass', { passThrough: true }),
  item('sub-approved', { review: review('approved', true, 3) }),
  item('sub-stale', { review: review('approved', false, 4) }),
  item('sub-unreviewed'),
  item('sub-rejected', { review: review('rejected', true, 2) }),
]

function Bootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  const booted = useRef(false)
  useLayoutEffect(() => {
    if (booted.current) return
    booted.current = true
    app.markProjectCreated({
      project: PROJECT,
      cfg: SAVED_CFG,
      configSha256: '0'.repeat(64),
    })
  }, [app])
  return children
}

function renderScreen(): ReturnType<typeof render> {
  return render(
    <AppProvider>
      <Bootstrap>
        <InputQcScreen />
      </Bootstrap>
    </AppProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InputQcScreen', () => {
  it('holds the prepared-input listing until the project is saved', async () => {
    const api = getApi()
    const list = vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: ITEMS,
    })
    vi.spyOn(api.artifact, 'previewImage').mockResolvedValue({
      dataUrl: 'data:image/png;base64,cWM=',
      mimeType: 'image/png',
      truncated: false,
    })
    const handle: { app: ReturnType<typeof useApp> | null } = { app: null }
    function DirtyBootstrap({ children }: { children: ReactNode }): ReactNode {
      const app = useApp()
      const booted = useRef(false)
      useLayoutEffect(() => {
        handle.app = app
        if (booted.current) return
        booted.current = true
        app.markProjectCreated({
          project: PROJECT,
          cfg: SAVED_CFG,
          configSha256: '0'.repeat(64),
        })
        app.setCfg({
          ...SAVED_CFG,
          paths: { ...SAVED_CFG.paths, rawdataDir: `${PROJECT.root}/edited` },
        })
      }, [app])
      return children
    }

    render(
      <AppProvider>
        <DirtyBootstrap>
          <InputQcScreen />
        </DirtyBootstrap>
      </AppProvider>,
    )

    expect(
      await screen.findByText(
        'Save the project before reviewing prepared inputs.',
      ),
    ).toBeInTheDocument()
    expect(list).not.toHaveBeenCalled()

    await act(async () => {
      await handle.app?.discardChanges()
    })

    expect((await screen.findAllByText('Pass-through')).length).toBeGreaterThan(
      0,
    )
    expect(list).toHaveBeenCalledTimes(1)
  })
  it('states that no brain-FOV reports exist and names the stage that creates them', async () => {
    const api = getApi()
    vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: [],
    })

    renderScreen()

    expect(
      await screen.findByText('No field of view reports are available.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Run Brain FOV preparation to create them.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/because/)).toBeNull()
  })
  it('shows every crop-review state and previews only by opaque artifact ID', async () => {
    const api = getApi()
    vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: ITEMS,
    })
    const preview = vi.spyOn(api.artifact, 'previewImage').mockResolvedValue({
      dataUrl: 'data:image/png;base64,cWM=',
      mimeType: 'image/png',
      truncated: false,
    })

    renderScreen()

    expect((await screen.findAllByText('Pass-through')).length).toBeGreaterThan(
      0,
    )
    // The page has no standing description; the montage speaks for itself.
    expect(
      screen.queryByText(/Shows the generated brain-FOV montage/),
    ).toBeNull()
    expect(screen.getByText('Current approval')).toBeInTheDocument()
    expect(screen.getByText('Stale review')).toBeInTheDocument()
    expect(screen.getByText('Unreviewed')).toBeInTheDocument()
    expect(screen.getByText('Rejected')).toBeInTheDocument()
    // Each state word leads with the ringed glyph the status matrix draws.
    const glyphOf = (word: string): string | null | undefined =>
      screen
        .getByText(word)
        .querySelector('svg[aria-hidden="true"]')
        ?.getAttribute('data-glyph-shape')
    expect(glyphOf('Current approval')).toBe('circleCheck')
    expect(glyphOf('Stale review')).toBe('circleRerun')
    expect(glyphOf('Unreviewed')).toBe('ring')
    expect(glyphOf('Rejected')).toBe('circleX')
    expect(
      await screen.findByRole('img', {
        name: 'Brain FOV QC montage for sub-pass',
      }),
    ).toBeInTheDocument()
    expect(preview).toHaveBeenCalledWith({
      project: PROJECT,
      artifactId: `input-fov-qc:${HASH_A}`,
      maxBytes: 8 * 1024 * 1024,
    })
    expect(JSON.stringify(preview.mock.calls)).not.toContain(
      'desc-brainfov_qc.png',
    )
  })

  it('titles the montage by its subject and keeps its hashed path out of view', async () => {
    // The production file name carries the desc-brainfov hash, so only the
    // image tooltip names the path.
    const path =
      '/data/study/derivatives/brainfov/sub-143/anat/sub-143_desc-brainfov0123456789abcdef_qc.png'
    const api = getApi()
    vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: [{ ...item('sub-143'), qcDisplayPath: path }],
    })
    vi.spyOn(api.artifact, 'previewImage').mockResolvedValue({
      dataUrl: 'data:image/png;base64,cWM=',
      mimeType: 'image/png',
      truncated: false,
    })

    renderScreen()

    await screen.findByRole('heading', { name: 'sub-143' })
    const montage = await screen.findByRole('img', {
      name: /^Brain FOV QC montage for /,
    })
    expect(montage).toHaveAttribute('title', path)
    expect(screen.queryByText(/desc-brainfov/)).toBeNull()
  })

  it('uses an AA-safe accent token for the active prepared-input identity', async () => {
    const api = getApi()
    vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: [
        item('sub-active', {
          sessionId: 'ses-baseline',
          acquisitionId: 'acq-t1w',
        }),
      ],
    })
    vi.spyOn(api.artifact, 'previewImage').mockResolvedValue({
      dataUrl: 'data:image/png;base64,cWM=',
      mimeType: 'image/png',
      truncated: false,
    })

    renderScreen()

    const active = await screen.findByRole('button', {
      name: 'Review sub-active, ses-baseline, acq-t1w, unreviewed',
    })
    const detail = within(active).getByText('ses-baseline / acq-t1w')
    expect(active).toHaveStyle({ background: THEMES.light.accentSoft })
    expect(detail).toHaveStyle({ color: THEMES.light.accentDim })
    for (const theme of Object.values(THEMES)) {
      expect(
        contrastRatio(theme.accentDim, theme.accentSoft),
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('writes a revision-bound decision with the selected crop identities', async () => {
    const api = getApi()
    vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: ITEMS,
    })
    vi.spyOn(api.artifact, 'previewImage').mockResolvedValue({
      dataUrl: 'data:image/png;base64,cWM=',
      mimeType: 'image/png',
      truncated: false,
    })
    const reviewCrop = vi
      .spyOn(api.inputFov, 'review')
      .mockResolvedValue(review('rejected', true, 4))
    // Runs keeps one inventory read per key; a decision must drop it.
    await cropInventory('runs-key', () => Promise.resolve(ITEMS))

    renderScreen()
    const subject = await screen.findByRole('button', {
      name: 'Review sub-approved, current approval',
    })
    fireEvent.click(subject)
    const reject = await screen.findByRole('button', {
      name: 'Reject crop for sub-approved',
    })
    reject.focus()
    expect(reject).toHaveFocus()
    fireEvent.click(reject)

    await waitFor(() =>
      expect(reviewCrop).toHaveBeenCalledWith({
        project: PROJECT,
        cfg: expect.objectContaining({
          paths: expect.objectContaining({ projectRoot: PROJECT.root }),
        }),
        configRevision: 0,
        subjectId: 'sub-approved',
        sessionId: null,
        acquisitionId: null,
        preflightSignature: HASH_A,
        sourceSha256: HASH_B,
        outputSha256: HASH_C,
        expectedRevision: 3,
        decision: 'rejected',
      }),
    )
    expect(
      await screen.findByRole('status', { name: 'Input QC update' }),
    ).toHaveTextContent(
      'The crop for sub-approved is rejected and stays out of reconstruction.',
    )
    expect(within(subject).getByText('Rejected')).toBeInTheDocument()
    const reread = vi.fn(() => Promise.resolve(ITEMS))
    await cropInventory('runs-key', reread)
    expect(reread).toHaveBeenCalledOnce()
    forgetCropInventory()
  })

  it('keeps the montage in place and shows the approval notice in the decision row', async () => {
    const api = getApi()
    vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: [item('sub-stable')],
    })
    const preview = vi.spyOn(api.artifact, 'previewImage').mockResolvedValue({
      dataUrl: 'data:image/png;base64,cWM=',
      mimeType: 'image/png',
      truncated: false,
    })
    vi.spyOn(api.inputFov, 'review').mockResolvedValue(
      review('approved', true, 1),
    )

    renderScreen()
    const montage = await screen.findByRole('img', {
      name: 'Brain FOV QC montage for sub-stable',
    })
    // Nothing is held open above the grid for a notice that may never come.
    const grid = screen.getByRole('complementary', {
      name: 'Prepared inputs',
    }).parentElement
    expect(grid?.previousElementSibling).toBeNull()
    expect(screen.queryByTestId('input-qc-notice-slot')).toBeNull()
    const statusSlot = screen.getByTestId('input-qc-selected-status-slot')
    const decision = screen.getByRole('group', {
      name: 'Crop decision for sub-stable',
    })
    expect(screen.queryByRole('status', { name: 'Input QC update' })).toBeNull()
    const reject = within(decision).getByRole('button', {
      name: 'Reject crop for sub-stable',
    })
    const approve = within(decision).getByRole('button', {
      name: 'Approve crop for sub-stable',
    })
    // The state chip keeps its width beside the path.
    expect(statusSlot).toHaveStyle({ flexShrink: '0' })
    expect(reject).toHaveStyle({ width: '88px' })
    expect(approve).toHaveStyle({ width: '88px' })

    fireEvent.click(approve)

    const notice = await screen.findByRole('status', {
      name: 'Input QC update',
    })
    expect(notice).toHaveTextContent('The crop for sub-stable is approved.')
    // One line no taller than the buttons, with the full text on hover.
    expect(notice).toHaveAttribute(
      'title',
      'The crop for sub-stable is approved.',
    )
    expect(notice).toHaveAttribute('aria-live', 'polite')
    expect(notice).toHaveStyle({
      height: '28px',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
    })
    expect(preview).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('img', {
        name: 'Brain FOV QC montage for sub-stable',
      }),
    ).toBe(montage)
    expect(grid?.previousElementSibling).toBeNull()
    expect(screen.getByTestId('input-qc-selected-status-slot')).toBe(statusSlot)
    expect(statusSlot).toHaveStyle({ flexShrink: '0' })
  })

  it('fits the prepared inputs list to the page scroll area', async () => {
    // A fixed calc(100vh - 240px) height runs the list about 94 px past the run
    // dock at 1214x768 and nests a scroll.
    const api = getApi()
    vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: ITEMS,
    })
    vi.spyOn(api.artifact, 'previewImage').mockResolvedValue({
      dataUrl: 'data:image/png;base64,cWM=',
      mimeType: 'image/png',
      truncated: false,
    })
    renderScreen()
    const list = await screen.findByTestId('prepared-inputs-list')
    expect(list.style.maxHeight).not.toContain('vh')
    let scroller = list.parentElement
    while (scroller && scroller.style.overflow !== 'auto') {
      scroller = scroller.parentElement
    }
    expect(scroller).not.toBeNull()
    const area = { height: 434 }
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this === scroller ? area.height : 0
      },
    )
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this === scroller ? area.height : 0
      },
    )
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        const top = this === scroller ? 272 : 308
        const height = this === scroller ? area.height : 100
        return {
          x: 0,
          y: top,
          top,
          left: 0,
          right: 320,
          bottom: top + height,
          width: 320,
          height,
          toJSON: () => ({}),
        }
      },
    )
    const padding = Number.parseFloat(getComputedStyle(scroller!).paddingBottom)
    const expected = (height: number): string =>
      `${Math.max(200, Math.floor(height - 36 - (padding || 0) - 1))}px`

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(list.style.maxHeight).toBe(expected(434))

    // A very short window keeps the 200 px minimum.
    area.height = 120
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(list.style.maxHeight).toBe('200px')
  })

  it('disables review actions for pass-through inputs and reports preview errors', async () => {
    const api = getApi()
    vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: [ITEMS[0]!],
    })
    vi.spyOn(api.artifact, 'previewImage').mockRejectedValue(
      new Error('The preview transport closed.'),
    )

    renderScreen()

    expect(
      await screen.findByRole('alert', {
        name: 'The montage preview could not load',
      }),
    ).toHaveTextContent(
      'The montage preview could not load. The preview transport closed.',
    )
    expect(
      screen.queryByRole('button', { name: /^Approve crop/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Reject crop/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/This input needs no approval: every physical axis/),
    ).toBeInTheDocument()
  })

  it('keeps immutable publications for one subject independently selectable', async () => {
    const api = getApi()
    const older = item('sub-repeat', {
      review: review('approved', false, 1),
    })
    const current: InputFovItem = {
      ...item('sub-repeat'),
      preflightSignature: HASH_D,
      outputSha256: HASH_E,
      qcArtifactId: `input-fov-qc:${HASH_D}`,
    }
    vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: [older, current],
    })
    vi.spyOn(api.artifact, 'previewImage').mockResolvedValue({
      dataUrl: 'data:image/png;base64,cWM=',
      mimeType: 'image/png',
      truncated: false,
    })
    const reviewCrop = vi
      .spyOn(api.inputFov, 'review')
      .mockResolvedValue(review('approved', true, 1))

    renderScreen()
    const unreviewedDuplicate = await screen.findByRole('button', {
      name: 'Review sub-repeat, unreviewed, duplicate 2 of 2',
    })
    expect(screen.getByText('duplicate 1 of 2')).toBeVisible()
    expect(screen.getByText('duplicate 2 of 2')).toBeVisible()
    expect(screen.queryByText(/digest dddddddd|digest aaaaaaaa/)).toBeNull()
    expect(unreviewedDuplicate).toHaveAttribute(
      'title',
      'sub-sub-repeat_desc-brainfov_qc.png',
    )
    fireEvent.click(unreviewedDuplicate)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Approve crop for sub-repeat',
      }),
    )

    await waitFor(() =>
      expect(reviewCrop).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectId: 'sub-repeat',
          preflightSignature: HASH_D,
          outputSha256: HASH_E,
          expectedRevision: 0,
        }),
      ),
    )
  })

  it('keeps same-digest acquisitions independently selectable and reviewed', async () => {
    const api = getApi()
    const prisma = item('sub-repeat', { acquisitionId: 'acq-prisma' })
    const ingenia: InputFovItem = {
      ...item('sub-repeat', { acquisitionId: 'acq-ingenia' }),
      qcArtifactId: `input-fov-qc:${HASH_D}`,
    }
    vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: [prisma, ingenia],
    })
    vi.spyOn(api.artifact, 'previewImage').mockResolvedValue({
      dataUrl: 'data:image/png;base64,cWM=',
      mimeType: 'image/png',
      truncated: false,
    })
    const reviewCrop = vi
      .spyOn(api.inputFov, 'review')
      .mockResolvedValue(review('approved', true, 1))

    renderScreen()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Review sub-repeat, acq-ingenia, unreviewed',
      }),
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Approve crop for sub-repeat / acq-ingenia',
      }),
    )

    await waitFor(() =>
      expect(reviewCrop).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectId: 'sub-repeat',
          acquisitionId: 'acq-ingenia',
          preflightSignature: HASH_A,
          expectedRevision: 0,
        }),
      ),
    )
    expect(
      screen.getByRole('button', {
        name: 'Review sub-repeat, acq-prisma, unreviewed',
      }),
    ).toBeInTheDocument()
  })

  it('distinguishes sessions in review identity and accessible control names', async () => {
    const api = getApi()
    const baseline = item('sub-repeat', {
      sessionId: 'ses-baseline',
      acquisitionId: 'acq-prisma',
    })
    const followup: InputFovItem = {
      ...item('sub-repeat', {
        sessionId: 'ses-followup',
        acquisitionId: 'acq-prisma',
      }),
      qcArtifactId: `input-fov-qc:${HASH_D}`,
    }
    vi.spyOn(api.inputFov, 'list').mockResolvedValue({
      configRevision: 0,
      items: [baseline, followup],
    })
    vi.spyOn(api.artifact, 'previewImage').mockResolvedValue({
      dataUrl: 'data:image/png;base64,cWM=',
      mimeType: 'image/png',
      truncated: false,
    })
    const reviewCrop = vi
      .spyOn(api.inputFov, 'review')
      .mockResolvedValue(review('approved', true, 1))

    renderScreen()
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Review sub-repeat, ses-followup, acq-prisma, unreviewed',
      }),
    )

    expect(
      await screen.findByRole('img', {
        name: 'Brain FOV QC montage for sub-repeat / ses-followup / acq-prisma',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('group', {
        name: 'Crop decision for sub-repeat / ses-followup / acq-prisma',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Reject crop for sub-repeat / ses-followup / acq-prisma',
      }),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Approve crop for sub-repeat / ses-followup / acq-prisma',
      }),
    )

    await waitFor(() =>
      expect(reviewCrop).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectId: 'sub-repeat',
          sessionId: 'ses-followup',
          acquisitionId: 'acq-prisma',
          preflightSignature: HASH_A,
          expectedRevision: 0,
        }),
      ),
    )
    expect(
      screen.getByRole('button', {
        name: 'Review sub-repeat, ses-baseline, acq-prisma, unreviewed',
      }),
    ).toBeInTheDocument()
  })

  it('drops a late list result after the project config revision changes', async () => {
    const resolvers: Array<
      (value: { configRevision: number; items: InputFovItem[] }) => void
    > = []
    const list = vi.spyOn(getApi().inputFov, 'list').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )
    vi.spyOn(getApi().project, 'validate').mockResolvedValue({
      errors: [],
      warnings: [],
    })
    vi.spyOn(getApi().project, 'save').mockResolvedValue({
      project: PROJECT,
      configRevision: 1,
      sha256: '1'.repeat(64),
    })

    function RevisionHarness(): ReactNode {
      const app = useApp()
      return (
        <>
          <button
            type="button"
            // The inventory is bound to the saved revision, so land the edit on
            // a saved revision; an unsaved edit issues no list request at all.
            onClick={() => {
              app.setCfg({
                ...app.cfg,
                project: { ...app.cfg.project, name: 'Revised input QC' },
              })
              void app.saveProject()
            }}
          >
            Revise config
          </button>
          <InputQcScreen />
        </>
      )
    }

    render(
      <AppProvider>
        <Bootstrap>
          <RevisionHarness />
        </Bootstrap>
      </AppProvider>,
    )
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Revise config' }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await act(async () => {
      resolvers[1]?.({ configRevision: 1, items: [] })
      await Promise.resolve()
      resolvers[0]?.({ configRevision: 0, items: ITEMS })
      await Promise.resolve()
    })
    expect(screen.queryByText('sub-approved')).not.toBeInTheDocument()
  })
})
