// @vitest-environment jsdom

import { createRef, useLayoutEffect, useRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { BrainAssetId } from '../../../shared/brain-atlas'
import type { GroupAnalysisResult } from '../../../shared/group-analysis'
import { DEFAULT_PROJECT_CONFIG } from '../../../shared/project-schema'
import { createMockApi } from '../../ipc/mock'
import { MOCK_ANALYSIS_RESULT } from '../../ipc/mock-group-analysis'
import { AppProvider, useApp } from '../../state/context'
import { THEMES } from '../../theme/tokens'
import { MOCK_BATTERY_RESULT } from '../../ipc/mock-analysis-v2'
import { brainViewCaption, brainViewStem } from './brain/presets'
import type { ViewState, ViewerCallbacks } from './brain/viewer'
import {
  BrainView,
  NO_WEBGL2_MESSAGE,
  type BrainViewHandle,
  type BrainViewProps,
} from './BrainView'

const support = vi.hoisted(() => ({ webgl2: true }))
vi.mock('./brain/support', () => ({
  supportsWebGl2: () => support.webgl2,
  appZoom: () => 1,
}))

interface FakeViewer {
  callbacks: ViewerCallbacks
  canvas: HTMLCanvasElement
  apply: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  setTemplate: ReturnType<typeof vi.fn>
  setVolumes: ReturnType<typeof vi.fn>
  rotate: ReturnType<typeof vi.fn>
  moveCrosshair: ReturnType<typeof vi.fn>
  setCrosshairMm: ReturnType<typeof vi.fn>
  setSurfaceAtlas: ReturnType<typeof vi.fn>
  setLabelMap: ReturnType<typeof vi.fn>
  closeUp: ReturnType<typeof vi.fn>
  cutThrough: ReturnType<typeof vi.fn>
  renderFrames: ReturnType<typeof vi.fn>
}

// The surface atlas files parse into fsaverage5-sized stand-ins.
vi.mock('./brain/freesurfer', () => ({
  readAnnotation: vi.fn(() => ({
    vertexEntry: new Int32Array(10242),
    entries: [{ name: 'G_precentral', value: 1, rgb: [1, 0, 0] }],
  })),
  readLabel: vi.fn(() => ({
    vertices: Int32Array.of(0),
    values: Float32Array.of(1),
  })),
  annotationFromLabels: vi.fn((labels: { name: string }[], count: number) => ({
    vertexEntry: new Int32Array(count),
    entries: labels.map((label, i) => ({
      name: label.name,
      value: i + 1,
      rgb: [i + 1, 0, 0],
    })),
  })),
}))

const viewers = vi.hoisted(() => ({ created: [] as unknown[] }))
// The export figure draws its first frame and reports what it was asked for.
const figures = vi.hoisted(() => ({ requests: [] as unknown[] }))
vi.mock('./brain/brain-export', () => ({
  brainFigurePng: vi.fn(
    async (
      renderFrames: (
        draw: (render: (request: { scale: number }) => unknown) => unknown,
      ) => unknown,
      request: unknown,
    ) => {
      renderFrames((render) => render({ scale: 1 }))
      figures.requests.push(request)
      return Uint8Array.from([1, 2, 3])
    },
  ),
}))

const SIZE = { widthMm: 174, dpi: 300 } as const
vi.mock('./brain/viewer', () => ({
  createBrainViewer: vi.fn(
    async (canvas: HTMLCanvasElement, callbacks: ViewerCallbacks) => {
      let volumes = false
      let labelMap = 'aseg'
      const atlases = new Set<string>()
      const viewer = {
        callbacks,
        canvas,
        setTemplate: vi.fn(),
        setVolumes: vi.fn(async () => {
          volumes = true
        }),
        hasVolumes: () => volumes,
        apply: vi.fn(),
        rotate: vi.fn(),
        moveCrosshair: vi.fn(),
        setCrosshairMm: vi.fn(),
        setSurfaceAtlas: vi.fn((atlasId: string) => atlases.add(atlasId)),
        hasSurfaceAtlas: (atlasId: string) => atlases.has(atlasId),
        setLabelMap: vi.fn(async (sourceId: string) => {
          labelMap = sourceId
        }),
        labelMap: () => labelMap,
        closeUp: vi.fn((preset: string, hemisphere: string) => ({
          preset,
          hemisphere: preset === 'hippocampus' ? hemisphere : null,
          centerMm: [3, -30, -20],
          crosshairMm: [3, -32, -28],
          plane: 'sagittal',
          zoom: 2.5,
          hideCerebrum: preset === 'brainstem',
        })),
        cutThrough: vi.fn(
          (cut: { depthMm: number; azimuth: number; elevation: number }) => ({
            ...cut,
            depthMm: 3,
          }),
        ),
        renderFrames: vi.fn(
          (
            _background: unknown,
            draw: (
              render: (request: { scale: number }) => {
                canvas: HTMLCanvasElement
                tiles: null
              },
            ) => unknown,
          ) =>
            draw(() => ({
              canvas: document.createElement('canvas'),
              tiles: null,
            })),
        ),
        dispose: vi.fn(),
      }
      viewers.created.push(viewer)
      return viewer
    },
  ),
}))

const PROJECT = {
  projectId: 'brain-project',
  root: '/projects/brain',
  configPath: '/projects/brain/supraspina.project.json',
  epoch: 1,
}

function Bootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  const booted = useRef(false)
  useLayoutEffect(() => {
    if (!booted.current) {
      booted.current = true
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
  return app.projectRef ? children : null
}

function RouteProbe(): ReactNode {
  const { route, setTweaks } = useApp()
  return (
    <>
      <output data-testid="route">{route}</output>
      <button type="button" onClick={() => setTweaks({ theme: 'light' })}>
        Use light
      </button>
      <button type="button" onClick={() => setTweaks({ theme: 'dark' })}>
        Use dark
      </button>
    </>
  )
}

/** The 0-1 RGB of a `#rrggbb` color. */
function unit(hex: string): number[] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
}

function withTemplate(
  api = createMockApi(),
  subjectAssets = true,
): ReturnType<typeof createMockApi> {
  api.brainViewer = {
    assets: vi.fn(async (request) => ({
      available: true,
      unavailableReason: null,
      subjectId: request.subjectId ?? null,
      assets:
        request.subjectId && !subjectAssets
          ? []
          : [
              { assetId: 'fsaverage/mri/brain.mgz' as BrainAssetId, bytes: 1 },
              ...(request.subjectId
                ? [
                    {
                      assetId: 'subject/mri/brain.mgz' as BrainAssetId,
                      bytes: 1,
                    },
                    {
                      assetId: 'subject/mri/aparc+aseg.mgz' as BrainAssetId,
                      bytes: 1,
                    },
                  ]
                : []),
            ],
    })),
    readAsset: vi.fn(async (request) => ({
      assetId: request.assetId,
      sha256: '0'.repeat(64),
      data: new Uint8Array(4),
    })),
  }
  return api
}

function renderView(
  api = withTemplate(),
  props: Partial<BrainViewProps> = {},
): ReturnType<typeof render> & { onSelect: ReturnType<typeof vi.fn> } {
  window.supraspina = api
  const onSelect = vi.fn()
  const view = render(
    <AppProvider>
      <Bootstrap>
        <BrainView
          result={MOCK_ANALYSIS_RESULT}
          selection={null}
          onSelect={onSelect}
          {...props}
        />
        <RouteProbe />
      </Bootstrap>
    </AppProvider>,
  )
  return { ...view, onSelect }
}

function lastViewer(): FakeViewer {
  return viewers.created.at(-1) as FakeViewer
}

function lastState(): ViewState {
  return lastViewer().apply.mock.calls.at(-1)![0] as ViewState
}

async function ready(): Promise<FakeViewer> {
  await waitFor(() => expect(lastViewer()?.apply).toHaveBeenCalled())
  return lastViewer()
}

describe('BrainView', () => {
  beforeEach(() => {
    support.webgl2 = true
    viewers.created.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('states that WebGL2 is missing without reading the template', () => {
    support.webgl2 = false
    const api = withTemplate()
    renderView(api)
    expect(screen.getByText(NO_WEBGL2_MESSAGE)).toHaveAttribute(
      'role',
      'status',
    )
    expect(api.brainViewer.assets).not.toHaveBeenCalled()
  })

  it('shows the asset report reason with a way to Diagnostics', async () => {
    renderView(createMockApi())
    expect(
      await screen.findByText('FreeSurfer home is not set.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Diagnostics' }))
    expect(screen.getByTestId('route')).toHaveTextContent('diagnostics')
    expect(viewers.created).toHaveLength(0)
  })

  it('offers a retry when the template cannot be read', async () => {
    const api = withTemplate()
    api.brainViewer.readAsset = vi
      .fn()
      .mockRejectedValueOnce(new Error('The asset is too large.'))
      .mockResolvedValue({
        assetId: 'fsaverage5/surf/lh.pial',
        sha256: '0'.repeat(64),
        data: new Uint8Array(4),
      })
    renderView(api)
    expect(await screen.findByText('The asset is too large.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await ready()
  })

  it('draws the surface map and selects what a click picks', async () => {
    const { onSelect } = renderView()
    const viewer = await ready()
    expect(viewer.setTemplate).toHaveBeenCalledTimes(1)
    const files = viewer.setTemplate.mock.calls[0]![0]
    expect(Object.keys(files.surfaces)).toEqual(['lh', 'rh'])
    expect(lastState()).toMatchObject({
      mode: 'surface',
      surface: 'inflated',
      hemisphere: 'lh',
      view: 'lateral',
    })
    const [, map, selection] = viewer.apply.mock.calls.at(-1)!
    expect(map.stat).toBe('d')
    expect(map.cortex.lh.get('precentral').measureId).toBe(
      'dk:bi:precentral:ThickAvg',
    )
    expect(selection).toBeNull()
    expect(
      screen.getByRole('application', { name: 'Brain map of d by region' }),
    ).toBe(viewer.canvas)

    act(() => viewer.callbacks.onPick('aseg:Brain-Stem'))
    expect(onSelect).toHaveBeenCalledWith('aseg:Brain-Stem')
    act(() => viewer.callbacks.onPick(null))
    expect(onSelect).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('radio', { name: 'Right' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Medial' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Pial' }))
    expect(lastState()).toMatchObject({
      surface: 'pial',
      hemisphere: 'rh',
      view: 'medial',
    })
    fireEvent.click(screen.getByRole('radio', { name: 't' }))
    expect(viewer.apply.mock.calls.at(-1)![1].stat).toBe('t')
    expect(
      screen.getByText('Not on the map: Mean cortical thickness.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: /Color scale of t from/ }),
    ).toHaveAccessibleName(/smaller in SCI.*larger in SCI/)
  })

  it('follows the shared selection into its cortical layer', async () => {
    const { rerender } = renderView()
    await ready()
    const layer = screen.getByRole('combobox', { name: 'Cortical measure' })
    expect(layer).toHaveValue('ThickAvg:bi')
    rerender(
      <AppProvider>
        <Bootstrap>
          <BrainView
            result={MOCK_ANALYSIS_RESULT}
            selection="dk:lh:precentral:ThickAvg"
            onSelect={vi.fn()}
          />
        </Bootstrap>
      </AppProvider>,
    )
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Cortical measure' }),
      ).toHaveValue('ThickAvg:hemi'),
    )
    expect(
      screen.getByText(
        /^Left precentral thickness: d \u2212?\d\.\d\d, (?:not )?significant\.$/,
      ),
    ).toBeInTheDocument()
  })

  it('reads the volumes for the cut and applies the cut controls', async () => {
    const api = withTemplate()
    renderView(api)
    const viewer = await ready()
    fireEvent.click(screen.getByRole('radio', { name: 'Cut' }))
    await waitFor(() => expect(viewer.setVolumes).toHaveBeenCalledTimes(1))
    expect(api.brainViewer.readAsset).toHaveBeenCalledWith({
      project: expect.objectContaining({ projectId: PROJECT.projectId }),
      assetId: 'fsaverage/mri/aparc+aseg.mgz',
    })
    await waitFor(() => expect(lastState().mode).toBe('cut'))
    fireEvent.change(screen.getByLabelText(/Cut depth/), {
      target: { value: '-20' },
    })
    expect(lastState().cut.depthMm).toBe(-20)
    fireEvent.change(screen.getByLabelText(/View elevation/), {
      target: { value: '30' },
    })
    expect(lastState().cut.elevation).toBe(30)
    // The brainstem close-up cuts sagittally through the brainstem.
    fireEvent.change(screen.getByRole('combobox', { name: 'Close-up' }), {
      target: { value: 'brainstem' },
    })
    await waitFor(() =>
      expect(lastState().closeUp).toMatchObject({
        preset: 'brainstem',
        hideCerebrum: true,
      }),
    )
    expect(viewer.closeUp).toHaveBeenCalledWith('brainstem', 'lh')
    expect(viewer.cutThrough).toHaveBeenLastCalledWith(
      { depthMm: 0, azimuth: 90, elevation: 0 },
      [3, -30, -20],
    )
    expect(lastState().cut).toEqual({ depthMm: 3, azimuth: 90, elevation: 0 })

    fireEvent.click(screen.getByRole('radio', { name: 'Slices' }))
    await waitFor(() => expect(lastState().mode).toBe('slices'))
    expect(viewer.setVolumes).toHaveBeenCalledTimes(1)
    expect(lastState().closeUp).toMatchObject({ plane: 'sagittal' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Close-up' }), {
      target: { value: '' },
    })
    await waitFor(() => expect(lastState().closeUp).toBeNull())
  })

  it('reads an inspected subject and reports missing volumes', async () => {
    const api = withTemplate(createMockApi(), false)
    renderView(api, { subjectId: 'sub-007' })
    const viewer = await ready()
    fireEvent.click(screen.getByRole('radio', { name: 'Slices' }))
    expect(
      await screen.findByText(
        'The FreeSurfer volumes of sub-007 are missing; run reconstruction for this subject.',
      ),
    ).toBeInTheDocument()
    expect(viewer.setVolumes).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox', { name: 'Volume source' }), {
      target: { value: 'template' },
    })
    await waitFor(() => expect(viewer.setVolumes).toHaveBeenCalledTimes(1))
  })

  it('opens on the hemisphere that has measures and says when one has none', async () => {
    const template = MOCK_ANALYSIS_RESULT.rows[0]!
    const rightOnly: GroupAnalysisResult = {
      ...MOCK_ANALYSIS_RESULT,
      rows: ['precentral', 'insula'].map((region) => ({
        ...template,
        measureId: `dk:rh:${region}:ThickAvg`,
        family: 'dk:ThickAvg',
      })),
    }
    renderView(withTemplate(), { result: rightOnly })
    await ready()
    await waitFor(() => expect(lastState().hemisphere).toBe('rh'))
    expect(screen.queryByText(/hemisphere measure is/)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Left' }))
    await waitFor(() => expect(lastState().hemisphere).toBe('lh'))
    expect(
      screen.getByText(/No left-hemisphere measure is in this result\./),
    ).toBeInTheDocument()
  })

  it('draws the slices on a black panel and the 3D views on the theme', async () => {
    renderView()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Use dark' }))
    await waitFor(() =>
      expect(lastState().background).toEqual(unit(THEMES.dark.surface)),
    )
    const paper = lastState().background
    fireEvent.click(screen.getByRole('radio', { name: 'Slices' }))
    await waitFor(() => expect(lastState().mode).toBe('slices'))
    expect(lastState().background).toEqual([0, 0, 0])
    const canvas = screen.getByRole('application')
    expect(canvas.parentElement!.style.background).toBe('rgb(0, 0, 0)')
    expect(canvas.parentElement!.parentElement!.style.background).toBe(
      'rgb(0, 0, 0)',
    )
    // The caption sits inside the canvas frame, over its free corner.
    const caption = screen
      .getAllByText(/^Click a region to select its measure/)
      .find((el) => el.getAttribute('aria-live') === 'polite')!
    expect(caption.parentElement).toBe(canvas.parentElement!.parentElement)
    fireEvent.click(screen.getByRole('radio', { name: 'Cut' }))
    await waitFor(() => expect(lastState().mode).toBe('cut'))
    expect(lastState().background).toEqual(paper)
    expect(canvas.parentElement!.style.background).toBe('rgb(21, 23, 28)')
  })

  it('follows a theme change without reloading the viewer', async () => {
    renderView()
    const viewer = await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Use light' }))
    await waitFor(() =>
      expect(lastState().background).toEqual(unit(THEMES.light.surface)),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use dark' }))
    await waitFor(() =>
      expect(lastState().background).toEqual(unit(THEMES.dark.surface)),
    )
    expect(viewers.created).toHaveLength(1)
    expect(lastViewer()).toBe(viewer)
    expect(viewer.setTemplate).toHaveBeenCalledTimes(1)
  })

  it("opens an inspected subject's brain on its slices", async () => {
    const api = withTemplate()
    renderView(api, { subjectId: 'sub-003', openVolumes: true })
    const viewer = await ready()
    await waitFor(() => expect(viewer.setVolumes).toHaveBeenCalledTimes(1))
    expect(api.brainViewer.readAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'subject/mri/aparc+aseg.mgz',
        subjectId: 'sub-003',
      }),
    )
    await waitFor(() => expect(lastState().mode).toBe('slices'))
    expect(screen.getByRole('radio', { name: 'Slices' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('switches to the slices when a subject is inspected later', async () => {
    window.supraspina = withTemplate()
    const props = {
      result: MOCK_ANALYSIS_RESULT,
      selection: null,
      onSelect: vi.fn(),
      openVolumes: true,
    }
    const view = render(
      <AppProvider>
        <Bootstrap>
          <BrainView {...props} />
        </Bootstrap>
      </AppProvider>,
    )
    await ready()
    expect(lastState().mode).toBe('surface')
    view.rerender(
      <AppProvider>
        <Bootstrap>
          <BrainView {...props} subjectId="sub-005" />
        </Bootstrap>
      </AppProvider>,
    )
    await waitFor(() => expect(lastState().mode).toBe('slices'))
  })

  it('reads the volumes of a subject with them', async () => {
    const api = withTemplate()
    const onCapture = vi.fn()
    renderView(api, { subjectId: 'sub-003', onCapture })
    const viewer = await ready()
    fireEvent.click(screen.getByRole('radio', { name: 'Cut' }))
    await waitFor(() => expect(viewer.setVolumes).toHaveBeenCalledTimes(1))
    expect(api.brainViewer.readAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'subject/mri/brain.mgz',
        subjectId: 'sub-003',
      }),
    )
    const source = screen.getByRole('combobox', { name: 'Volume source' })
    expect(source).toHaveValue('sub-003')
    await waitFor(() =>
      expect(within(source).getAllByRole('option').length).toBeGreaterThan(2),
    )
    // The volumes are a subject's, so the canvas names it; the exported
    // figure and its file name never do.
    expect(
      screen.getByText('Labels drawn on sub-003; colors are group statistics.'),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(onCapture).toHaveBeenLastCalledWith(
        expect.objectContaining({ stem: expect.stringMatching(/-subject$/) }),
      ),
    )
    const exported = onCapture.mock.calls.at(-1)![0] as {
      stem: string
      capture: (size: typeof SIZE) => Promise<Uint8Array>
    }
    await exported.capture(SIZE)
    const request = figures.requests.at(-1) as { lines: unknown[] }
    expect(request.lines[1]).toEqual([
      expect.stringMatching(/through a subject's volumes$/),
    ])
    expect(JSON.stringify(request)).not.toContain('sub-003')
    expect(exported.stem).not.toContain('sub-003')
    // A hippocampus close-up follows the shown hemisphere and is cut from
    // its side.
    await waitFor(() => expect(lastState().mode).toBe('cut'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Close-up' }), {
      target: { value: 'hippocampus' },
    })
    await waitFor(() =>
      expect(viewer.closeUp).toHaveBeenLastCalledWith('hippocampus', 'lh'),
    )
    expect(viewer.cutThrough).toHaveBeenLastCalledWith(
      { depthMm: 0, azimuth: 90, elevation: 0 },
      [3, -30, -20],
    )
  })

  it('keeps keys from NiiVue and turns arrows into rotation or slice moves', async () => {
    renderView()
    const viewer = await ready()
    const canvas = viewer.canvas
    const native = vi.fn()
    canvas.addEventListener('keydown', native)
    fireEvent.keyDown(canvas, { key: 'ArrowRight' })
    expect(viewer.rotate).toHaveBeenLastCalledWith(15, 0)
    fireEvent.keyDown(canvas, { key: 'ArrowUp', shiftKey: true })
    expect(viewer.rotate).toHaveBeenLastCalledWith(0, 45)
    fireEvent.keyDown(canvas, { key: 'v' })
    expect(native).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('radio', { name: 'Slices' }))
    await waitFor(() => expect(lastState().mode).toBe('slices'))
    fireEvent.keyDown(canvas, { key: 'PageUp' })
    expect(viewer.moveCrosshair).toHaveBeenLastCalledWith(0, 1, 0)
    fireEvent.keyDown(canvas, { key: 'ArrowLeft' })
    expect(viewer.moveCrosshair).toHaveBeenLastCalledWith(-1, 0, 0)
  })

  it('recovers from a lost context with a new viewer', async () => {
    renderView()
    const first = await ready()
    act(() => first.callbacks.onContextLost())
    expect(
      await screen.findByText('The 3D view lost its graphics context.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reload the view' }))
    await waitFor(() => expect(viewers.created).toHaveLength(2))
    expect(first.dispose).toHaveBeenCalledTimes(1)
    const second = await ready()
    expect(second.canvas).not.toBe(first.canvas)
  })

  it('disposes the viewer on unmount and captures through its handle', async () => {
    const handle = createRef<BrainViewHandle>()
    window.supraspina = withTemplate()
    const view = render(
      <AppProvider>
        <Bootstrap>
          <BrainView
            ref={handle}
            result={MOCK_ANALYSIS_RESULT}
            selection={null}
            onSelect={vi.fn()}
          />
        </Bootstrap>
      </AppProvider>,
    )
    const viewer = await ready()
    await expect(handle.current!.capturePng(SIZE)).resolves.toEqual(
      Uint8Array.from([1, 2, 3]),
    )
    view.unmount()
    expect(viewer.dispose).toHaveBeenCalledTimes(1)
  })

  it('offers the drawn view for export under a name of the view', async () => {
    const onCapture = vi.fn()
    const view = renderView(withTemplate(), { onCapture })
    await ready()
    await waitFor(() =>
      expect(onCapture).toHaveBeenLastCalledWith(
        expect.objectContaining({
          stem: expect.stringMatching(/^brain-d-[a-z-]+-lateral-inflated$/),
        }),
      ),
    )
    const capture = onCapture.mock.calls.at(-1)![0] as {
      capture: (size: typeof SIZE) => Promise<Uint8Array>
    }
    await expect(capture.capture(SIZE)).resolves.toEqual(
      Uint8Array.from([1, 2, 3]),
    )
    // An export keeps the print paper whatever the theme; slices stay black.
    expect(lastViewer().renderFrames).toHaveBeenLastCalledWith(
      [1, 1, 1],
      expect.any(Function),
    )
    expect(figures.requests.at(-1)).toMatchObject({
      background: [1, 1, 1],
      widthMm: 174,
      dpi: 300,
      lines: [
        [
          'SCI (',
          { i: 'n' },
          expect.any(String),
          { i: 'n' },
          expect.any(String),
        ],
        [expect.stringMatching(/ hemisphere, lateral view, inflated surface$/)],
        [
          'outlined: ',
          'FWE ',
          { i: 'p' },
          expect.stringMatching(/^ < 0.05 over/),
        ],
      ],
      scale: {
        stat: 'd',
        negative: 'Smaller in SCI',
        positive: 'Larger in SCI',
      },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Slices' }))
    await waitFor(() => expect(lastState().mode).toBe('slices'))
    await (
      onCapture.mock.calls.at(-1)![0] as {
        capture: (size: typeof SIZE) => Promise<Uint8Array>
      }
    ).capture(SIZE)
    expect(lastViewer().renderFrames).toHaveBeenLastCalledWith(
      [0, 0, 0],
      expect.any(Function),
    )
    expect(figures.requests.at(-1)).toMatchObject({
      lines: [
        expect.anything(),
        [
          expect.stringMatching(
            /slices through the fsaverage template, left hemisphere on the left$/,
          ),
        ],
        expect.anything(),
      ],
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Cut' }))
    await waitFor(() =>
      expect(onCapture).toHaveBeenLastCalledWith(
        expect.objectContaining({
          stem: 'brain-d-cut-az180-el0-depth16-fsaverage',
        }),
      ),
    )
    view.unmount()
    expect(onCapture).toHaveBeenLastCalledWith(null)
  })

  it('names a view without any subject ID', () => {
    const base = {
      mode: 'slices' as const,
      stat: 't' as const,
      layerKey: 'ThickAvg:hemi',
      surface: 'pial' as const,
      hemisphere: 'rh' as const,
      view: 'dorsal' as const,
      cut: { depthMm: -8, azimuth: 90, elevation: -15 },
      subject: true,
    }
    expect(brainViewStem(base)).toBe('brain-t-slices-subject')
    expect(brainViewStem({ ...base, mode: 'cut' })).toBe(
      'brain-t-cut-az90-elm15-depthm8-subject',
    )
    expect(brainViewStem({ ...base, mode: 'surface' })).toBe(
      'brain-t-thickavg-both-dorsal-pial',
    )
    expect(
      brainViewStem({
        ...base,
        mode: 'surface',
        view: 'medial',
        layerKey: 'SurfArea:bi',
      }),
    ).toBe('brain-t-surfarea-bi-rh-medial-pial')
  })

  it('describes a view in words for the export caption', () => {
    const base = {
      mode: 'surface' as const,
      stat: 'd' as const,
      layerKey: 'ThickAvg:hemi',
      surface: 'pial' as const,
      hemisphere: 'rh' as const,
      view: 'medial' as const,
      cut: { depthMm: -8, azimuth: 90, elevation: -15 },
      subject: true,
    }
    const layer = 'Thickness, per hemisphere'
    expect(brainViewCaption(base, layer)).toBe(
      'Thickness, per hemisphere; right hemisphere, medial view, pial surface',
    )
    expect(brainViewCaption({ ...base, view: 'ventral' }, layer)).toBe(
      'Thickness, per hemisphere; both hemispheres, ventral view, pial surface',
    )
    // A subject's volumes are named without the subject's ID.
    expect(brainViewCaption({ ...base, mode: 'cut' }, null)).toBe(
      "Subcortical volumes; cut at \u22128 mm, azimuth 90\u00b0, elevation \u221215\u00b0, through a subject's volumes",
    )
    expect(
      brainViewCaption({ ...base, mode: 'slices', subject: false }, layer),
    ).toBe(
      'Thickness, per hemisphere; axial, coronal, and sagittal slices through the fsaverage template, left hemisphere on the left',
    )
    // An atlas label map and a close-up are named; the subject is not.
    expect(
      brainViewCaption(
        { ...base, mode: 'slices', closeUp: 'brainstem' },
        layer,
        'Brainstem subfields',
      ),
    ).toBe(
      "Brainstem subfields; brainstem close-up, one slice through one subject's brain (labels drawn on it; colors are group statistics), left hemisphere on the left",
    )
    expect(
      brainViewStem({
        ...base,
        mode: 'cut',
        labelMap: 'brainstem-ss',
        closeUp: 'brainstem',
      }),
    ).toBe('brain-d-cut-brainstem-ss-brainstem-az90-elm15-depthm8-subject')
  })

  it('rejects a capture before anything is drawn', async () => {
    const handle = createRef<BrainViewHandle>()
    window.supraspina = createMockApi()
    render(
      <AppProvider>
        <Bootstrap>
          <BrainView
            ref={handle}
            result={MOCK_ANALYSIS_RESULT}
            selection={null}
            onSelect={vi.fn()}
          />
        </Bootstrap>
      </AppProvider>,
    )
    await screen.findByText('FreeSurfer home is not set.')
    await expect(handle.current!.capturePng(SIZE)).rejects.toThrow(
      /not drawing/,
    )
  })

  it('colors an association by t and names its direction', async () => {
    const association: GroupAnalysisResult = {
      ...MOCK_ANALYSIS_RESULT,
      spec: {
        ...MOCK_ANALYSIS_RESULT.spec,
        analysis: 'association',
        contrast: {
          type: 'association',
          variable: { source: 'registry', column: 'age' },
          grouping: null,
          includedGroups: [],
          adjustForGroup: false,
        },
      },
      rows: MOCK_ANALYSIS_RESULT.rows.map((row) => ({
        ...row,
        d: null,
        dLow: null,
        dHigh: null,
      })),
    }
    renderView(withTemplate(), { result: association })
    const viewer = await ready()
    expect(viewer.apply.mock.calls.at(-1)![1].stat).toBe('t')
    expect(screen.getByRole('radio', { name: 'd' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByText('Negative association')).toBeInTheDocument()
  })
})

describe('BrainView atlases', () => {
  beforeEach(() => {
    support.webgl2 = true
    viewers.created.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  /** The battery result's first term with some atlas rows added. */
  function atlasRows(measureIds: string[]): BrainViewProps['rows'] {
    const template = MOCK_BATTERY_RESULT.rows[0]!
    return [
      ...MOCK_BATTERY_RESULT.rows,
      ...measureIds.map((measureId, index) => ({
        ...template,
        measureId,
        t: -2 - index,
        d: -0.5 - index / 10,
        significant: index === 0,
      })),
    ]
  }

  /** An API whose template lists these extra assets, and subjects these. */
  function atlasApi(
    extra: string[],
    subjects: Record<string, string[]> = {},
  ): ReturnType<typeof createMockApi> {
    const api = createMockApi()
    api.brainViewer = {
      assets: vi.fn(async (request) => ({
        available: true,
        unavailableReason: null,
        subjectId: request.subjectId ?? null,
        assets: (request.subjectId
          ? (subjects[request.subjectId] ?? [])
          : ['fsaverage/mri/brain.mgz', ...extra]
        ).map((assetId) => ({ assetId: assetId as BrainAssetId, bytes: 1 })),
      })),
      readAsset: vi.fn(async (request) => ({
        assetId: request.assetId,
        sha256: '0'.repeat(64),
        data:
          request.assetId === 'FreeSurferColorLUT.txt'
            ? new TextEncoder().encode(
                '16 Brain-Stem 119 159 176 0\n175 Medulla 119 159 176 0\n11124 ctx_lh_G_precentral 1 1 1 0\n',
              )
            : new Uint8Array(4),
      })),
    }
    api.groupAnalysis.measureDetail = vi.fn(async () => ({
      subjects: Object.keys(subjects).map((subjectId) => ({ subjectId })),
    })) as never
    return api
  }

  it('draws a v2 term on a Destrieux layer read from FreeSurfer', async () => {
    const api = atlasApi([
      'fsaverage5/label/lh.aparc.a2009s.annot',
      'fsaverage5/label/rh.aparc.a2009s.annot',
    ])
    renderView(api, {
      result: MOCK_BATTERY_RESULT,
      rows: atlasRows(['parc:a2009s:lh:G_precentral:ThickAvg']),
    })
    const viewer = await ready()
    // The first term is an association.
    expect(
      screen.getByRole('img', { name: /Color scale of d from/ }),
    ).toHaveAccessibleName(/negative association.*positive association/)
    const layer = screen.getByRole('combobox', { name: 'Cortical measure' })
    fireEvent.change(layer, { target: { value: 'a2009s:ThickAvg:hemi' } })
    await waitFor(() =>
      expect(viewer.setSurfaceAtlas).toHaveBeenCalledWith(
        'a2009s',
        ['none'],
        expect.objectContaining({ lh: expect.anything() }),
      ),
    )
    expect(api.brainViewer.readAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'fsaverage5/label/lh.aparc.a2009s.annot',
      }),
    )
    await waitFor(() =>
      expect(viewer.apply.mock.calls.at(-1)![1].surfaceAtlas).toBe('a2009s'),
    )
    const map = viewer.apply.mock.calls.at(-1)![1]
    expect(map.cortex.lh.get('G_precentral').measureId).toBe(
      'parc:a2009s:lh:G_precentral:ThickAvg',
    )
    expect(
      within(layer).getByRole('option', {
        name: 'Destrieux (aparc.a2009s): thickness, per hemisphere',
      }),
    ).toBeInTheDocument()
    // The narrow select names its whole layer in its title.
    expect(layer).toHaveAttribute(
      'title',
      'Destrieux (aparc.a2009s): thickness, per hemisphere',
    )
    expect(layer.style.maxWidth).toBe('260px')
  })

  it('builds the Brodmann areas from fsaverage label files', async () => {
    const ids = (['lh', 'rh'] as const).flatMap((hemi) =>
      [
        'BA1',
        'BA2',
        'BA3a',
        'BA3b',
        'BA4a',
        'BA4p',
        'BA6',
        'BA44',
        'BA45',
        'V1',
        'V2',
        'MT',
        'entorhinal',
        'perirhinal',
      ].map((name) => `fsaverage/label/${hemi}.${name}_exvivo.label`),
    )
    const api = atlasApi(ids)
    renderView(api, {
      result: MOCK_BATTERY_RESULT,
      rows: atlasRows(['parc:ba:lh:BA1_exvivo:ThickAvg']),
    })
    const viewer = await ready()
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Cortical measure' }),
      { target: { value: 'ba:ThickAvg:hemi' } },
    )
    await waitFor(() =>
      expect(viewer.setSurfaceAtlas).toHaveBeenCalledWith(
        'ba',
        ['none'],
        expect.anything(),
      ),
    )
    const annotations = viewer.setSurfaceAtlas.mock.calls[0]![2] as {
      lh: { vertexEntry: Int32Array; entries: { name: string }[] }
    }
    expect(annotations.lh.vertexEntry).toHaveLength(10242)
    expect(annotations.lh.entries[0]!.name).toBe('BA1_exvivo')
    expect(api.brainViewer.readAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'fsaverage/label/rh.perirhinal_exvivo.label',
      }),
    )
  })

  it('says when an atlas has no fsaverage5 template labels yet', async () => {
    renderView(atlasApi([]), {
      result: MOCK_BATTERY_RESULT,
      rows: atlasRows(['parc:dkt:lh:precentral:ThickAvg']),
    })
    const viewer = await ready()
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Cortical measure' }),
      { target: { value: 'dkt:ThickAvg:hemi' } },
    )
    expect(
      await screen.findByText(
        'DKT (aparc.DKTatlas) has no fsaverage5 template labels yet; label the template in Choose measures to draw it.',
      ),
    ).toBeInTheDocument()
    expect(viewer.setSurfaceAtlas).not.toHaveBeenCalled()
  })

  it('draws a subject-space atlas on the first labeled subject', async () => {
    const base = ['subject/mri/brain.mgz', 'subject/mri/aparc+aseg.mgz']
    const api = atlasApi(['FreeSurferColorLUT.txt'], {
      'sub-001': base,
      'sub-002': [
        ...base,
        'atlas/brainstem-ss/subject/brainstemSsLabels.FSvoxelSpace.mgz',
      ],
    })
    renderView(api, {
      result: MOCK_BATTERY_RESULT,
      rows: MOCK_BATTERY_RESULT.rows,
      selection: 'vol:brainstem-ss:mid:Medulla',
    })
    const viewer = await ready()
    fireEvent.click(screen.getByRole('radio', { name: 'Slices' }))
    expect(
      await screen.findByText(
        'Labels drawn on sub-002; colors are group statistics.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Label map' })).toHaveValue(
      'brainstem-ss',
    )
    const source = screen.getByRole('combobox', { name: 'Display subject' })
    expect(source).toHaveValue('sub-002')
    expect(
      within(source).getByRole('option', { name: 'fsaverage template' }),
    ).toBeDisabled()
    expect(viewer.setLabelMap).toHaveBeenLastCalledWith('brainstem-ss', [
      { bytes: expect.any(Uint8Array), hemisphere: null },
    ])
    await waitFor(() =>
      expect(
        viewer.apply.mock.calls.at(-1)![1].labels.get(175)?.measureId,
      ).toBe('vol:brainstem-ss:mid:Medulla'),
    )
    // Back on aparc+aseg, the template can show again.
    fireEvent.change(screen.getByRole('combobox', { name: 'Label map' }), {
      target: { value: 'aseg' },
    })
    await waitFor(() =>
      expect(viewer.setLabelMap).toHaveBeenLastCalledWith('aseg', null),
    )
  })

  it("names an added label map's labels from its own color table", async () => {
    const base = ['subject/mri/brain.mgz', 'subject/mri/aparc+aseg.mgz']
    const map = 'atlas/user-0a1b2c3d/subject/user-0a1b2c3d.mgz'
    const table = 'atlas/user-0a1b2c3d/subject/user-0a1b2c3d.ctab'
    // FreeSurfer's table is absent: the added map needs only its own.
    const api = atlasApi([], {
      'sub-001': [...base, map],
      'sub-002': [...base, map, table],
    })
    const read = api.brainViewer.readAsset
    api.brainViewer.readAsset = vi.fn(async (request) =>
      request.assetId === table
        ? {
            assetId: request.assetId,
            sha256: '0'.repeat(64),
            data: new TextEncoder().encode(
              '1001 Nucleus_L 1 2 3 0\n1002 Nucleus_R 1 2 3 0\n',
            ),
          }
        : read(request),
    )
    const rows = atlasRows(['vol:user-0a1b2c3d:lh:Nucleus'])
    renderView(api, {
      result: MOCK_BATTERY_RESULT,
      rows,
      selection: 'vol:user-0a1b2c3d:lh:Nucleus',
    })
    const viewer = await ready()
    fireEvent.click(screen.getByRole('radio', { name: 'Slices' }))
    // Subject sub-001 has the map but no table, so the first labeled subject
    // is sub-002.
    expect(
      await screen.findByText(
        'Labels drawn on sub-002; colors are group statistics.',
      ),
    ).toBeInTheDocument()
    expect(api.brainViewer.readAsset).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: table, subjectId: 'sub-002' }),
    )
    expect(api.brainViewer.readAsset).not.toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'FreeSurferColorLUT.txt' }),
    )
    await waitFor(() =>
      expect(
        viewer.apply.mock.calls.at(-1)![1].labels.get(1001)?.measureId,
      ).toBe('vol:user-0a1b2c3d:lh:Nucleus'),
    )
  })

  it('says when no analyzed subject has an atlas yet', async () => {
    const base = ['subject/mri/brain.mgz', 'subject/mri/aparc+aseg.mgz']
    renderView(atlasApi(['FreeSurferColorLUT.txt'], { 'sub-001': base }), {
      result: MOCK_BATTERY_RESULT,
      rows: MOCK_BATTERY_RESULT.rows,
      selection: 'vol:brainstem-ss:mid:Medulla',
    })
    await ready()
    fireEvent.click(screen.getByRole('radio', { name: 'Cut' }))
    expect(
      await screen.findByText(
        'No analyzed subject has Brainstem subfields labels yet; label subjects in Choose measures to draw them.',
      ),
    ).toBeInTheDocument()
  })

  it('colors a Destrieux label map with its own cortical layer', async () => {
    const base = ['subject/mri/brain.mgz', 'subject/mri/aparc+aseg.mgz']
    const api = atlasApi(['FreeSurferColorLUT.txt'], {
      'sub-001': [...base, 'subject/mri/aparc.a2009s+aseg.mgz'],
    })
    renderView(api, {
      result: MOCK_BATTERY_RESULT,
      rows: atlasRows([
        'parc:a2009s:lh:G_precentral:ThickAvg',
        'dk:lh:precentral:ThickAvg',
      ]),
      selection: 'parc:a2009s:lh:G_precentral:ThickAvg',
    })
    const viewer = await ready()
    fireEvent.click(screen.getByRole('radio', { name: 'Slices' }))
    await waitFor(() =>
      expect(viewer.setLabelMap).toHaveBeenLastCalledWith('a2009s', [
        { bytes: expect.any(Uint8Array), hemisphere: null },
      ]),
    )
    // Only the Destrieux layers color this map.
    const layer = screen.getByRole('combobox', { name: 'Cortical measure' })
    expect(
      within(layer)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Destrieux (aparc.a2009s): thickness, per hemisphere'])
    await waitFor(() =>
      expect(
        viewer.apply.mock.calls.at(-1)![1].labels.get(11124)?.measureId,
      ).toBe('parc:a2009s:lh:G_precentral:ThickAvg'),
    )
    expect(
      screen.getByText('Labels drawn on sub-001; colors are group statistics.'),
    ).toBeInTheDocument()
  })
})
