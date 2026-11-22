import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLayoutEffect, type ReactNode } from 'react'

import {
  BrainChartsFacts,
  OutlierSiteFact,
  ParamField,
  PipelineScreen,
} from './PipelineScreen'
import { AppProvider, useApp } from '../state/context'
import { getApi } from '../state/api'
import { THEMES } from '../theme/tokens'
import type { ParamSpec } from '../../shared/steps'
import { emptyCell, type Subject, type ToolStatus } from '../../shared/types'
import {
  DEFAULT_PROJECT_CONFIG,
  type ProjectConfig,
} from '../../shared/project-schema'

const RESOLVED_CFG: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
  paths: {
    ...DEFAULT_PROJECT_CONFIG.paths,
    projectRoot: '/tmp/supraspina-pipeline',
  },
}

function renderScreen(extra?: { onDirtyChange?: (d: boolean) => void }): void {
  render(
    <AppProvider>
      <PipelineScreen
        {...(extra?.onDirtyChange
          ? { onDirtyChange: extra.onDirtyChange }
          : {})}
      />
    </AppProvider>,
  )
}

function RouteProbe(): ReactNode {
  const { route } = useApp()
  return <output data-testid="route-probe">{route}</output>
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

function ParamHarness({
  spec,
  value,
  onChange,
  onBrowseDir = vi.fn(),
  onBrowseFile = vi.fn(),
  disabledOptions,
  help,
}: {
  spec: ParamSpec
  value: ParamSpec['default']
  onChange: (value: ParamSpec['default']) => void
  onBrowseDir?: () => void
  onBrowseFile?: () => void
  disabledOptions?: readonly string[]
  help?: string
}): ReactNode {
  return (
    <ParamField
      t={THEMES.dark}
      name="parameter"
      spec={spec}
      value={value}
      onChange={onChange}
      onBrowseDir={onBrowseDir}
      onBrowseFile={onBrowseFile}
      {...(disabledOptions ? { disabledOptions } : {})}
      {...(help ? { help } : {})}
    />
  )
}

function renderParam(
  spec: ParamSpec,
  value: ParamSpec['default'],
  options: {
    disabledOptions?: readonly string[]
    help?: string
  } = {},
) {
  const onChange = vi.fn<(value: ParamSpec['default']) => void>()
  const onBrowseDir = vi.fn<() => void>()
  const onBrowseFile = vi.fn<() => void>()
  const view = render(
    <ParamHarness
      spec={spec}
      value={value}
      onChange={onChange}
      onBrowseDir={onBrowseDir}
      onBrowseFile={onBrowseFile}
      {...(options.disabledOptions
        ? { disabledOptions: options.disabledOptions }
        : {})}
      {...(options.help ? { help: options.help } : {})}
    />,
  )
  return { ...view, onChange, onBrowseDir, onBrowseFile }
}

function ProjectBootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  useLayoutEffect(() => {
    if (app.projectRef) return
    app.markProjectCreated({
      project: {
        projectId: 'pipeline-project',
        root: '/tmp/supraspina-pipeline',
        configPath: '/tmp/supraspina-pipeline/supraspina.project.json',
        epoch: app.projectEpoch,
      },
      cfg: RESOLVED_CFG,
      configSha256: '0'.repeat(64),
    })
  }, [app])
  if (!app.projectRef) return null
  return children
}

describe('PipelineScreen', () => {
  beforeEach(() => localStorage.clear())

  it('should list the pipeline stages when it mounts', async () => {
    renderScreen()
    await waitFor(() => {
      expect(screen.getAllByText('Reconstruction').length).toBeGreaterThan(0)
    })
    expect(screen.getByText('Brain FOV preparation')).toBeTruthy()
    expect(screen.getByText('Optional defacing')).toBeTruthy()
    expect(screen.getByText('ENIGMA QC')).toBeTruthy()
    expect(screen.getByText('R analysis')).toBeTruthy()
    // A stage name with an abbreviation spells it out in its tooltip.
    expect(
      screen.getByRole('button', { name: 'Brain FOV preparation' }),
    ).toHaveAttribute('title', 'Brain FOV (field of view) preparation')
    expect(
      screen.getByRole('button', { name: 'Brain-PAD statistics' }),
    ).toHaveAttribute(
      'title',
      'Brain-PAD (brain predicted age difference) statistics',
    )
    const recon = screen.getByRole('button', { name: 'Reconstruction' })
    expect(recon).not.toHaveAttribute('title')
  })

  it('lists BrainCharts after PyBrainAge and the z-score comparisons after R analysis', async () => {
    renderScreen()
    const stages = await screen.findByRole('list')
    const names = Array.from(stages.querySelectorAll('li')).map(
      (item) => item.textContent,
    )
    expect(names.slice(7, 10)).toEqual([
      'PyBrainAge prediction',
      'BrainCharts normative modeling',
      'Clinical merge',
    ])
    expect(names.slice(-2)).toEqual(['R analysis', 'Z-score group comparisons'])
  })

  it('edits the BrainCharts seed and the z-score report switch, both off by default', async () => {
    renderScreen()
    fireEvent.click(await screen.findByText('BrainCharts normative modeling'))
    expect(
      await screen.findByText(
        'Adapts the lifespan BrainCharts model to the controls of each site and writes per-region z-scores.',
      ),
    ).toBeVisible()
    expect(screen.getByLabelText('This stage is off.')).toBeTruthy()
    expect(
      screen.getByLabelText('Adaptation split seed (upstream 117)'),
    ).toHaveValue(117)

    fireEvent.click(screen.getByText('Z-score group comparisons'))
    expect(
      await screen.findByRole('switch', { name: 'Render HTML report' }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('This stage is off.')).toBeTruthy()
  })

  it('describes the selected stage under its name as a fact', async () => {
    renderScreen()
    expect(
      await screen.findByText(
        'Runs cortical reconstruction and compatible parcellation for every subject.',
      ),
    ).toBeVisible()
  })

  it('should render a command preview region when a stage is loaded', async () => {
    renderScreen()
    await waitFor(() => {
      expect(screen.getByText('Command preview')).toBeTruthy()
    })
  })

  it('collapses Pipeline commands when previews are off and keeps an explicit reveal', async () => {
    localStorage.setItem(
      'supraspinaMockMachinePreferences',
      JSON.stringify({ showCommandHints: false }),
    )
    renderScreen()

    expect(
      await screen.findByText(/Reveal command shows it for this stage/),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal command' }))
    await waitFor(() => {
      expect(
        screen.queryByText(/Reveal command shows it for this stage/),
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Hide command' }),
      ).toBeInTheDocument()
    })
  })

  it('should name each stage switch by its stage, with state in aria-checked, not a visible filler word', async () => {
    renderScreen()
    await waitFor(() => {
      expect(screen.getByText('Optional defacing')).toBeTruthy()
    })

    const switches = screen.getAllByRole('switch')
    const stageSwitches = switches.filter((el) =>
      (el.getAttribute('aria-label') ?? '').endsWith(' stage'),
    )
    expect(stageSwitches.length).toBeGreaterThan(0)

    const off = stageSwitches.filter(
      (el) => el.getAttribute('aria-checked') === 'false',
    )
    expect(off.length).toBeGreaterThan(0)

    for (const el of stageSwitches) {
      const wrapper = el.parentElement
      expect(wrapper?.textContent ?? '').not.toMatch(/enabled|disabled/)
    }
  })

  it('should mark a blocking error advisory with the ringed failed glyph, not the alert ring', async () => {
    const broken = JSON.parse(JSON.stringify(RESOLVED_CFG)) as ProjectConfig
    ;(broken.runtime as { threads: number }).threads = 9999
    render(
      <AppProvider>
        <PipelineScreen cfg={broken} />
      </AppProvider>,
    )

    const advisory = await screen.findByText(/^runtime\.threads:/i)
    const row = advisory.closest('div')
    expect(row).not.toBeNull()
    const svg = row?.querySelector('svg path')

    expect(svg?.getAttribute('d')).toBe('m15 9-6 6')
  })

  it('shows no state pill for an enabled stage, only for an off one', async () => {
    renderScreen()

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Stages' })).toBeTruthy()
    })
    expect(screen.queryByLabelText('This stage is off.')).toBeNull()
    expect(screen.queryByLabelText('This stage is enabled.')).toBeNull()
  })

  it('should show the parcellation advisory when features uses a non-a2009s atlas', async () => {
    renderScreen()

    await waitFor(() => {
      expect(screen.getByText('FreeSurfer feature extraction')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('FreeSurfer feature extraction'))

    await waitFor(() => {
      expect(screen.getByText('aparc.DKTatlas')).toBeTruthy()
    })
    expect(
      screen.queryByText(/PyBrainAge feature extraction needs aparc\.a2009s:/),
    ).toBeNull()

    fireEvent.click(screen.getByText('aparc.DKTatlas'))
    await waitFor(() => {
      expect(
        screen.getByText(/PyBrainAge feature extraction needs aparc\.a2009s:/),
      ).toBeTruthy()
    })
  })

  it('lets one parcellation advisory own the cause on each stage it concerns', async () => {
    const cfg: ProjectConfig = {
      ...RESOLVED_CFG,
      steps: {
        ...RESOLVED_CFG.steps,
        features: {
          enabled: true,
          params: {
            ...RESOLVED_CFG.steps.features.params,
            parcellation: 'aparc.DKTatlas',
          },
        },
      },
    }
    render(
      <AppProvider>
        <PipelineScreen cfg={cfg} />
      </AppProvider>,
    )

    // The Reconstruction stage is selected first, and the parcellation
    // concerns neither its inputs nor its outputs.
    await screen.findAllByText('Reconstruction')
    await waitFor(() =>
      expect(
        screen.queryByText(/Set features\.parcellation to aparc\.a2009s/),
      ).toBeNull(),
    )
    expect(
      screen.queryByText(/PyBrainAge feature extraction needs aparc\.a2009s:/),
    ).toBeNull()

    // Aggregation reads the same region map, so the validator's wording owns
    // the cause there.
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Structural data aggregation',
      }),
    )
    await screen.findByText(/Set features\.parcellation to aparc\.a2009s/)
    expect(
      screen.queryByText(/PyBrainAge feature extraction needs aparc\.a2009s:/),
    ).toBeNull()

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'FreeSurfer feature extraction',
      }),
    )
    await screen.findByText(
      /PyBrainAge feature extraction needs aparc\.a2009s:/,
    )
    await waitFor(() =>
      expect(
        screen.queryByText(/Set features\.parcellation to aparc\.a2009s/),
      ).toBeNull(),
    )
  })

  it('should keep Save disabled until a parameter changes', async () => {
    renderScreen()
    const save = (await screen.findByRole('button', {
      name: /save/i,
    })) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    const directives = (await screen.findByLabelText(
      'recon-all directives',
    )) as HTMLInputElement
    // A text parameter takes a code-like value, such as a command flag.
    expect(directives.style.fontFamily).toContain('WebCM Mono 10')
    fireEvent.change(directives, { target: { value: '-autorecon1' } })

    await waitFor(() => {
      expect(save.disabled).toBe(false)
    })
  })

  it('should drive the dirty flag through onDirtyChange when provided', async () => {
    const seen: boolean[] = []
    renderScreen({ onDirtyChange: (d) => seen.push(d) })

    const directives = (await screen.findByLabelText(
      'recon-all directives',
    )) as HTMLInputElement
    fireEvent.change(directives, { target: { value: '-autorecon2' } })

    await waitFor(() => {
      expect(seen.includes(true)).toBe(true)
    })
  })

  it('should gate the ENIGMA backend selector to host-viable options', async () => {
    render(
      <AppProvider>
        <PipelineScreen
          disabledChoiceOptions={{ 'enigma.backend': ['matlab'] }}
        />
      </AppProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('ENIGMA QC')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('ENIGMA QC'))

    const matlab = await screen.findByText('matlab')
    const mcr = screen.getByText('mcr')

    expect(matlab.getAttribute('role')).toBe('radio')
    expect(matlab.getAttribute('aria-disabled')).toBe('true')
    expect(mcr.getAttribute('aria-disabled')).toBeNull()
    // Choice values read as words: the schema value auto shows as Automatic.
    expect(
      screen.getByText('Automatic').getAttribute('aria-disabled'),
    ).toBeNull()
    expect(screen.queryByRole('radio', { name: 'octave' })).toBeNull()
  })

  it('should show a plain-language explanation under each parameter', async () => {
    renderScreen()

    await waitFor(() => {
      expect(screen.getByText(/The recon-all run preset/i)).toBeTruthy()
    })
  })

  it('should explain that a turned-off stage will be skipped', async () => {
    renderScreen()

    await waitFor(() => {
      expect(screen.getByText('Optional defacing')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('Optional defacing'))
    await waitFor(() => {
      expect(
        screen.getByText('This stage is off and runs skip it.'),
      ).toBeTruthy()
    })

    expect(screen.getByLabelText('This stage is off.')).toBeTruthy()
    expect(screen.getByLabelText('Defacing tool')).toBeTruthy()
  })

  it('should flag the ENIGMA backend field when the selected backend is unviable', async () => {
    // The default `auto` choice is unavailable only when no backend is.
    render(
      <AppProvider>
        <PipelineScreen
          disabledChoiceOptions={{
            'enigma.backend': ['auto', 'matlab', 'mcr'],
          }}
        />
      </AppProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('ENIGMA QC')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('ENIGMA QC'))

    await waitFor(() => {
      expect(
        screen.getByText(/Install this choice from Environment/),
      ).toBeTruthy()
    })
  })

  it('validates integer parameters and normalizes interactive values', () => {
    const spec: ParamSpec = {
      kind: 'int',
      default: 2,
      min: 1,
      max: 4,
      label: 'Worker count',
    }
    let view = renderParam(spec, 'invalid' as unknown as number)
    const invalidInput = screen.getByLabelText('Worker count')
    const invalidAlert = screen.getByRole('alert')
    const workerLabel = screen.getByText('Worker count')
    expect(invalidAlert).toHaveTextContent('Enter an integer')
    expect(workerLabel).toHaveAttribute('for', invalidInput.id)
    expect(invalidInput).toHaveAttribute('aria-errormessage', invalidAlert.id)
    expect(
      invalidInput.getAttribute('aria-describedby')?.split(/\s+/),
    ).toContain(invalidAlert.id)
    view.unmount()

    view = renderParam(spec, 2.5)
    expect(
      screen.getByText('Enter a whole number without decimals.'),
    ).toBeInTheDocument()
    view.unmount()

    view = renderParam(spec, 9)
    expect(screen.getByText('Enter a value from 1 to 4.')).toBeInTheDocument()
    view.unmount()

    view = renderParam(spec, 2)
    const input = screen.getByLabelText('Worker count')
    expect(input).toHaveAttribute('aria-invalid', 'false')
    fireEvent.change(input, { target: { value: '' } })
    expect(Number.isNaN(view.onChange.mock.calls[0]?.[0])).toBe(true)
    fireEvent.change(input, { target: { value: '3.8' } })
    expect(view.onChange).toHaveBeenLastCalledWith(3)
  })

  it('edits boolean, float, and text parameters with their native controls', () => {
    let view = renderParam(
      { kind: 'bool', default: false, label: 'Validate output' },
      false,
      { help: 'Check the generated artifact.' },
    )
    // The explanation and default sit in the info tip; the value matches the
    // default, so no standing default line shows.
    expect(
      screen.getByText('Check the generated artifact. Default: off.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Default: off.')).toBeNull()
    // The label sits above the switch, as it does above every other control.
    const toggle = screen.getByRole('switch', { name: 'Validate output' })
    const label = screen.getByText('Validate output')
    const line = toggle.closest('span[style*="min-height"]') as HTMLElement
    expect(line.style.minHeight).toBe('var(--ss-input-h)')
    const column = line.parentElement as HTMLElement
    expect(column.style.flexDirection).toBe('column')
    expect(column.firstElementChild).toContainElement(label)
    fireEvent.click(toggle)
    expect(view.onChange).toHaveBeenCalledWith(true)
    view.unmount()

    view = renderParam(
      { kind: 'float', default: 0.5, step: 0.1, label: 'Threshold' },
      'invalid' as unknown as number,
    )
    expect(screen.getByText('Enter a number.')).toBeInTheDocument()
    const number = screen.getByLabelText('Threshold')
    fireEvent.change(number, { target: { value: '1.25' } })
    expect(view.onChange).toHaveBeenCalledWith(1.25)
    view.unmount()

    view = renderParam(
      { kind: 'float', default: 0.5, step: 0.1, label: 'Threshold' },
      0.5,
    )
    const populatedNumber = screen.getByLabelText('Threshold')
    fireEvent.change(populatedNumber, { target: { value: '' } })
    expect(Number.isNaN(view.onChange.mock.calls.at(-1)?.[0])).toBe(true)
    view.unmount()

    view = renderParam(
      {
        kind: 'text',
        default: '',
        placeholder: 'optional value',
        label: 'Run directives',
      },
      '',
    )
    expect(screen.getByText('Default: (empty).')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Run directives'), {
      target: { value: '-autorecon2' },
    })
    expect(view.onChange).toHaveBeenCalledWith('-autorecon2')
  })

  it('routes required and writable path browsing to the correct picker', () => {
    let view = renderParam(
      {
        kind: 'path',
        default: '',
        must: 'exist',
        label: 'Model file',
      },
      '',
    )
    expect(screen.getByText('Enter a path.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Browse...' }))
    expect(view.onBrowseFile).toHaveBeenCalledOnce()
    expect(view.onBrowseDir).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Model file'), {
      target: { value: '/models/model.pkl' },
    })
    expect(view.onChange).toHaveBeenCalledWith('/models/model.pkl')
    view.unmount()

    view = renderParam(
      {
        kind: 'path',
        default: '/output',
        must: 'writable',
        label: 'Output directory',
      },
      '/output',
    )
    expect(screen.queryByText('Enter a path.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Browse...' }))
    expect(view.onBrowseDir).toHaveBeenCalledOnce()
    expect(view.onBrowseFile).not.toHaveBeenCalled()
  })

  it('falls back to the first choice and refuses disabled options', () => {
    const view = renderParam(
      {
        kind: 'choice',
        default: 'matlab',
        options: ['matlab', 'mcr'],
        label: 'Backend',
      },
      7 as unknown as string,
      { disabledOptions: ['matlab'] },
    )
    const matlab = screen.getByRole('radio', { name: /matlab$/ })
    const mcr = screen.getByRole('radio', { name: 'mcr' })
    expect(matlab).toHaveAttribute('aria-checked', 'true')
    expect(matlab).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(matlab)
    expect(view.onChange).not.toHaveBeenCalled()
    fireEvent.click(mcr)
    expect(view.onChange).toHaveBeenCalledWith('mcr')
  })

  it('commits stage toggles and resets every parameter to its default', async () => {
    const onCfgChange = vi.fn()
    const cfg = structuredClone(RESOLVED_CFG)
    cfg.steps.recon.params['directives'] = '-autorecon1'
    render(
      <AppProvider>
        <PipelineScreen cfg={cfg} onCfgChange={onCfgChange} />
      </AppProvider>,
    )
    const reconSwitch = await screen.findByRole('switch', {
      name: 'Reconstruction stage',
    })
    fireEvent.click(reconSwitch)
    expect(onCfgChange.mock.calls[0]?.[0].steps.recon.enabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    const reset = onCfgChange.mock.calls.at(-1)?.[0] as ProjectConfig
    expect(reset.steps.recon.params['directives']).toBe(
      DEFAULT_PROJECT_CONFIG.steps.recon.params['directives'],
    )
    expect(reset.steps.recon.params).not.toHaveProperty('threads')
    // The shell's toolbar Save is the one save path for its configuration.
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull()
  })

  it('uses directory and file pickers only when they return a path', async () => {
    const api = getApi()
    const chooseDir = vi
      .spyOn(api.fs, 'chooseDir')
      .mockResolvedValue('/usr/local/MATLAB/MATLAB_Runtime/v97')
    const chooseFile = vi
      .spyOn(api.fs, 'chooseFile')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('/opt/matlab/bin/matlab')
      .mockResolvedValue('/models/ExtraTreesModel')
    const onCfgChange = vi.fn()
    const view = render(
      <AppProvider>
        <PipelineScreen cfg={RESOLVED_CFG} onCfgChange={onCfgChange} />
      </AppProvider>,
    )
    fireEvent.click(await screen.findByText('ENIGMA QC'))
    // The MATLAB executable is a file, so its Browse action opens the native
    // file picker even though a blank PATH-detected value is allowed.
    const matlab = await screen.findByLabelText(
      'MATLAB executable (matlab backend)',
    )
    const browseFile = matlab.parentElement?.querySelector('button')
    if (!browseFile) throw new Error('Render the file picker button.')
    fireEvent.click(browseFile)
    await waitFor(() => expect(chooseFile).toHaveBeenCalledOnce())
    expect(onCfgChange).not.toHaveBeenCalled()
    fireEvent.click(browseFile)
    await waitFor(() => expect(onCfgChange).toHaveBeenCalledOnce())
    expect(onCfgChange.mock.calls[0]?.[0].steps.enigma.params).toMatchObject({
      matlabExecutable: '/opt/matlab/bin/matlab',
    })

    const mcrRoot = screen.getByLabelText(
      'MATLAB Runtime root (mcr backend, R2019b/v9.7)',
    )
    const browseDir = mcrRoot.parentElement?.querySelector('button')
    if (!browseDir) throw new Error('Render the directory picker button.')
    fireEvent.click(browseDir)
    await waitFor(() => expect(chooseDir).toHaveBeenCalledOnce())
    expect(
      onCfgChange.mock.calls.at(-1)?.[0].steps.enigma.params,
    ).toMatchObject({ mcrRoot: '/usr/local/MATLAB/MATLAB_Runtime/v97' })
    view.unmount()

    render(
      <AppProvider>
        <PipelineScreen cfg={RESOLVED_CFG} onCfgChange={onCfgChange} />
      </AppProvider>,
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'PyBrainAge prediction' }),
    )
    const model = await screen.findByLabelText('ExtraTreesModel path')
    const browseModel = model.parentElement?.querySelector('button')
    if (!browseModel) throw new Error('Render the file picker button.')
    fireEvent.click(browseModel)
    await waitFor(() => expect(chooseFile).toHaveBeenCalledTimes(3))
    expect(
      onCfgChange.mock.calls.at(-1)?.[0].steps.pybrainage.params,
    ).toMatchObject({ modelPath: '/models/ExtraTreesModel' })
  })

  it('says which file the reconstruction preview input stands for', async () => {
    const api = getApi()
    vi.spyOn(api.pipeline, 'previewCommand').mockResolvedValue(
      "recon-all -subject '${subject}' -i '<T1 input for ${subject}>' -sd /d/freesurfer -all",
    )
    vi.spyOn(api.project, 'validate').mockResolvedValue({
      errors: [],
      warnings: [],
    })
    const cfg: ProjectConfig = {
      ...RESOLVED_CFG,
      patterns: { ...RESOLVED_CFG.patterns, t1Pattern: '*t1*.nii*' },
    }
    const view = render(
      <AppProvider>
        <PipelineScreen cfg={cfg} />
      </AppProvider>,
    )
    expect(
      await screen.findByText(
        `<T1 input for \${subject}> stands for each subject's reviewed Brain FOV crop, or the T1 that subject discovery matched with the T1 pattern "*t1*.nii*" when no crop is needed. Review plan lists each subject's exact path.`,
      ),
    ).toBeVisible()
    view.unmount()

    render(
      <AppProvider>
        <PipelineScreen
          cfg={{
            ...cfg,
            steps: {
              ...cfg.steps,
              brainfov: { ...cfg.steps.brainfov, enabled: false },
            },
          }}
        />
      </AppProvider>,
    )
    expect(
      await screen.findByText(
        /stands for each subject's T1 that subject discovery matched with the T1 pattern "\*t1\*\.nii\*"\./,
      ),
    ).toBeVisible()
  })

  it('renders placeholder, empty, warning, and bounded preview-unavailable outcomes', async () => {
    const api = getApi()
    const preview = vi
      .spyOn(api.pipeline, 'previewCommand')
      .mockResolvedValue('placeholder command')
    const validate = vi.spyOn(api.project, 'validate').mockResolvedValue({
      errors: [],
      warnings: [
        'Review memory because it is below the recommended threshold.',
      ],
    })
    let view = render(
      <AppProvider>
        <PipelineScreen />
      </AppProvider>,
    )
    expect(
      await screen.findByText(
        /Supraspina resolves this placeholder against the installed/,
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Review memory because it is below the recommended threshold.',
      ),
    ).toBeTruthy()
    view.unmount()

    preview.mockResolvedValue('')
    validate.mockResolvedValue({ errors: [], warnings: [] })
    view = render(
      <AppProvider>
        <PipelineScreen />
      </AppProvider>,
    )
    expect(
      await screen.findByText(/Turn the stage on in the Stages list and fill/),
    ).toBeTruthy()
    view.unmount()

    preview.mockRejectedValue(
      new Error(
        "Error invoking remote method 'supraspina:invoke': Error: Scientific runtime request failed (pipeline.previewCommand).",
      ),
    )
    validate.mockResolvedValue({
      errors: ['Set runtime.threads to a value from 1 to 32.'],
      warnings: ['Review the current draft again.'],
    })
    render(
      <AppProvider>
        <PipelineScreen />
      </AppProvider>,
    )
    expect(
      await screen.findByRole('status', {
        name: 'Command preview unavailable',
      }),
    ).toHaveTextContent(
      /Runtime resources and automatic choices appear during exact plan review/,
    )
    expect(
      screen.getByText('Set runtime.threads to a value from 1 to 32.'),
    ).toBeVisible()
    expect(screen.getByText('Review the current draft again.')).toBeVisible()
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull()
    expect(screen.queryByText(/Scientific runtime request failed/)).toBeNull()
  })

  it('shows a stage-scoped advisory only on the stage it concerns', async () => {
    const api = getApi()
    vi.spyOn(api.pipeline, 'previewCommand').mockResolvedValue('command')
    const reconAdvisory =
      'Set the FreeSurfer folder in Diagnostics before running reconstruction.'
    const pybrainAdvisory =
      'Provision the PyBrainAge model and set pybrain.modelPath.'
    const wholeConfigAdvisory = 'Review the whole configuration.'
    vi.spyOn(api.project, 'validate').mockResolvedValue({
      errors: [],
      warnings: [reconAdvisory, pybrainAdvisory, wholeConfigAdvisory],
    })

    render(
      <AppProvider>
        <PipelineScreen />
        <RouteProbe />
      </AppProvider>,
    )

    expect(await screen.findByText(reconAdvisory)).toBeVisible()
    expect(screen.getByText(wholeConfigAdvisory)).toBeVisible()
    expect(screen.queryByText(pybrainAdvisory)).toBeNull()
    // Only the advisory Diagnostics resolves carries the way there.
    const openDiagnostics = screen.getAllByRole('button', {
      name: 'Open Diagnostics',
    })
    expect(openDiagnostics).toHaveLength(1)
    fireEvent.click(openDiagnostics[0]!)
    expect(screen.getByTestId('route-probe')).toHaveTextContent('diagnostics')

    fireEvent.click(
      screen.getByRole('button', { name: 'PyBrainAge prediction' }),
    )

    expect(await screen.findByText(pybrainAdvisory)).toBeVisible()
    expect(screen.getByText(wholeConfigAdvisory)).toBeVisible()
    expect(screen.queryByText(reconAdvisory)).toBeNull()
  })

  it('clears the prior stage command while a new preview resolves', async () => {
    const api = getApi()
    const brainFov = deferred<string>()
    const preview = vi
      .spyOn(api.pipeline, 'previewCommand')
      .mockImplementation(async (_cfg, key) => {
        if (key === 'brainfov') return brainFov.promise
        return `${key} command`
      })
    vi.spyOn(api.project, 'validate').mockResolvedValue({
      errors: [],
      warnings: [],
    })

    render(
      <AppProvider>
        <PipelineScreen />
      </AppProvider>,
    )
    expect(await screen.findByText('recon command')).toBeVisible()

    fireEvent.click(
      screen.getByRole('button', { name: 'Brain FOV preparation' }),
    )
    await waitFor(() =>
      expect(preview).toHaveBeenCalledWith(expect.anything(), 'brainfov'),
    )
    expect(screen.getByText('Resolving the command...')).toBeVisible()
    expect(screen.queryByText('recon command')).toBeNull()

    brainFov.resolve('brainfov command')
    expect(await screen.findByText('brainfov command')).toBeVisible()
  })

  it('ignores an older overlapping preview response after the stage changes', async () => {
    const api = getApi()
    const recon = deferred<string>()
    const brainFov = deferred<string>()
    vi.spyOn(api.pipeline, 'previewCommand').mockImplementation(
      async (_cfg, key) => {
        if (key === 'recon') return recon.promise
        if (key === 'brainfov') return brainFov.promise
        return `${key} command`
      },
    )
    vi.spyOn(api.project, 'validate').mockResolvedValue({
      errors: [],
      warnings: [],
    })

    render(
      <AppProvider>
        <PipelineScreen />
      </AppProvider>,
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Brain FOV preparation' }),
    )
    brainFov.resolve('current brainfov command')
    expect(await screen.findByText('current brainfov command')).toBeVisible()

    recon.resolve('stale recon command')
    await waitFor(() => {
      expect(screen.queryByText('stale recon command')).toBeNull()
    })
    expect(screen.getByText('current brainfov command')).toBeVisible()
  })

  it('surfaces a project-less save failure and clears the saving state', async () => {
    renderScreen()
    fireEvent.change(await screen.findByLabelText('recon-all directives'), {
      target: { value: '-autorecon2' },
    })
    const save = screen.getByRole('button', { name: /Save/ })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)
    expect(
      await screen.findByText('Open or create a project before saving.'),
    ).toBeInTheDocument()
    await waitFor(() => expect(save).toBeEnabled())
  })

  it('saves through the project context and clears a shell-owned dirty flag', async () => {
    const onDirtyChange = vi.fn()
    const save = vi.spyOn(getApi().project, 'save')
    render(
      <AppProvider>
        <ProjectBootstrap>
          <PipelineScreen
            cfg={RESOLVED_CFG}
            dirty={true}
            onDirtyChange={onDirtyChange}
          />
        </ProjectBootstrap>
      </AppProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Save/ }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(false))
  })

  it('keeps the save-error card from repeating a shown advisory', async () => {
    // Earlier tests stub api.project.validate; use the real validator here.
    vi.restoreAllMocks()
    const collidingCfg: ProjectConfig = {
      ...RESOLVED_CFG,
      paths: { ...RESOLVED_CFG.paths, rawdataDir: '/tmp/supraspina-pipeline' },
    }
    render(
      <AppProvider>
        <ProjectBootstrap>
          <PipelineScreen cfg={collidingCfg} dirty={true} />
        </ProjectBootstrap>
      </AppProvider>,
    )
    const cause =
      'Keep paths.rawdataDir separate from paths.projectRoot: they resolve to the same directory, so every writable path inside the project lands in the raw data.'
    await screen.findByText(cause)

    fireEvent.click(screen.getByRole('button', { name: /Save/ }))

    expect(
      await screen.findByText(
        'Resolve the failed validation finding below, then save again.',
      ),
    ).toBeVisible()
    expect(screen.getAllByText(cause)).toHaveLength(1)
  })

  it('shows hover feedback without changing the selected stage', async () => {
    renderScreen()
    const deface = await screen.findByRole('button', {
      name: 'Optional defacing',
    })
    const recon = screen.getByRole('button', {
      name: 'Reconstruction',
    })
    const row = deface.parentElement
    const selectedRow = recon.parentElement
    if (!row || !selectedRow) throw new Error('Render both stage rows.')
    fireEvent.mouseEnter(row)
    expect(deface).not.toHaveAttribute('aria-current')
    fireEvent.mouseLeave(selectedRow)
    expect(deface).not.toHaveAttribute('aria-current')
    fireEvent.mouseLeave(row)
  })
})

describe('BrainChartsFacts', () => {
  const subject = (
    id: string,
    site: string,
    cohortRole: NonNullable<Subject['cohortRole']>,
  ): Subject => ({
    id,
    age: 40,
    sex: 'F',
    cohort: cohortRole === 'healthy' ? 'CTRL' : 'SCI_P',
    ais: null,
    tSinceSci: null,
    cells: [emptyCell()],
    qc: null,
    notes: '',
    registered: true,
    analysisEligible: true,
    cohortRole,
    site,
  })
  const cohort: Subject[] = [
    subject('sub-001', 'Prisma', 'healthy'),
    subject('sub-002', 'Prisma', 'healthy'),
    subject('sub-003', 'Prisma', 'sci-neuropathic-pain'),
    subject('sub-004', 'Ingenia', 'sci-neuropathic-pain'),
    // A QC-failed control is outside the analysis cohort.
    { ...subject('sub-005', 'Ingenia', 'healthy'), qc: 'fail' },
  ]
  const status = (braincharts: 'ok' | 'missing'): ToolStatus => ({
    capturedAt: '2026-09-30T00:00:00.000Z',
    summary: braincharts,
    items: [{ id: 'braincharts', label: 'BrainCharts', status: braincharts }],
  })

  it('states the refused site and offers Diagnostics while BrainCharts is not set up', () => {
    const onOpenDiagnostics = vi.fn()
    render(
      <BrainChartsFacts
        t={THEMES.dark}
        gap={8}
        subjects={cohort}
        toolStatus={status('missing')}
        onOpenDiagnostics={onOpenDiagnostics}
      />,
    )
    expect(
      screen.getByText(
        'Adapts the model to 1 of 2 sites. Site Ingenia has no controls, so its 1 subject gets no z-scores.',
      ),
    ).toBeVisible()
    expect(
      screen.getByText(
        'The BrainCharts model and runtime are not set up. Diagnostics sets them up under Scientific resources.',
      ),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Open Diagnostics' }))
    expect(onOpenDiagnostics).toHaveBeenCalledTimes(1)
  })

  it('states that outlier review pools the sites of the analysis cohort', () => {
    render(<OutlierSiteFact t={THEMES.dark} gap={8} subjects={cohort} />)
    expect(screen.getByTestId('outlier-site-fact')).toHaveTextContent(
      "Outliers are judged against the whole cohort, so a site's scanner offset can flag its subjects.",
    )
  })

  it('says nothing about outliers for one site in the analysis cohort', () => {
    // The QC-failed Ingenia control and the Prisma subjects leave one site
    // once sub-004 is out.
    const { container } = render(
      <OutlierSiteFact
        t={THEMES.dark}
        gap={8}
        subjects={[...cohort.slice(0, 3), cohort[4]!]}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('says nothing for one adaptable site with BrainCharts set up or unlisted', () => {
    const oneSite = cohort.slice(0, 3)
    for (const toolStatus of [status('ok'), null]) {
      const { container, unmount } = render(
        <BrainChartsFacts
          t={THEMES.dark}
          gap={8}
          subjects={oneSite}
          toolStatus={toolStatus}
          onOpenDiagnostics={vi.fn()}
        />,
      )
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })
})
