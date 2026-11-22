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
import {
  upgradeGroupAnalysisSpecV1,
  type GroupAnalysisResult,
} from '../../../shared/group-analysis'
import { DEFAULT_PROJECT_CONFIG } from '../../../shared/project-schema'
import { createMockApi } from '../../ipc/mock'
import { MOCK_BATTERY_SPEC } from '../../ipc/mock-analysis-v2'
import {
  MOCK_ANALYSIS_RESULT,
  MOCK_ANALYSIS_SPEC,
  mockAnalysisCatalog,
} from '../../ipc/mock-group-analysis'
import { AppProvider, useApp } from '../../state/context'
import { AnalysisScreen } from '../AnalysisScreen'
import {
  computeEstimate,
  designText,
  exportFolderName,
  inferenceTextV2,
  inputSourceText,
  inputsCurrencyText,
  missingOutputText,
  modelFormulaV2,
  sigCellColor,
  skippedText,
  specSummary,
  staleReasonText,
  tableHemisphere,
  tableMeasureName,
  variableLabel,
} from './describe'
import { variableChoices } from './variables'
import { CheckRow } from './controls'
import { initialMeasure } from './selection'
import { measureFigureSize } from './fit'
import { scatterHeight } from '../../figures/scatter-model'
import { THEMES, highContrastTheme } from '../../theme/tokens'
import type { AnalysisInputSource } from '../../../shared/group-analysis'

// The Brain tab's NiiVue view does not run in jsdom; a stub shows what
// the tabs ask of it.
vi.mock('./BrainView', () => ({
  BrainView: (props: { subjectId?: string | null; openVolumes?: boolean }) => (
    <output data-testid="brain-stub">
      {`${props.openVolumes ? 'volumes' : 'surface'} ${props.subjectId ?? 'none'}`}
    </output>
  ),
}))

const PROJECT = {
  projectId: 'controls-project',
  root: '/projects/controls',
  configPath: '/projects/controls/supraspina.project.json',
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
  return children
}

function renderScreen(api = createMockApi()) {
  window.supraspina = api
  render(
    <AppProvider>
      <Bootstrap>
        <AnalysisScreen />
      </Bootstrap>
    </AppProvider>,
  )
  return api
}

async function ready(): Promise<HTMLElement> {
  await screen.findByRole('img', { name: /Forest plot/ })
  return screen.getByRole('complementary', { name: 'Analysis settings' })
}

afterEach(() => vi.restoreAllMocks())

describe('describe', () => {
  it('words the model, inference, and summary', () => {
    const draft = upgradeGroupAnalysisSpecV1(MOCK_ANALYSIS_SPEC)
    const choices = variableChoices(mockAnalysisCatalog(), [])
    expect(modelFormulaV2(draft, choices)).toBe(
      'y ~ group + age + sex (+ eTIV for volumes and areas)',
    )
    expect(inferenceTextV2(draft)).toBe(
      'max-T FWE, 5000 permutations, two-sided, alpha 0.05',
    )
    expect(
      inferenceTextV2({
        ...draft,
        inference: {
          ...draft.inference,
          correction: 'bh-fdr',
          sidedness: 'lower',
        },
      }),
    ).toBe('BH-FDR, one-sided (lower), alpha 0.05')
    expect(
      specSummary(
        draft,
        null,
        { aggregate: 'outdated', pybrainage: 'current' },
        choices,
      ),
    ).toEqual([
      'SCI vs CTRL',
      '20 measures',
      'y ~ group + age + sex (+ eTIV for volumes and areas)',
      'max-T FWE, 5000 permutations, two-sided, alpha 0.05',
      'Draft inputs out of date',
    ])
    // Current inputs are the normal state, so the strip omits them.
    expect(
      specSummary(
        draft,
        null,
        { aggregate: 'current', pybrainage: 'current' },
        choices,
      ),
    ).toEqual([
      'SCI vs CTRL',
      '20 measures',
      'y ~ group + age + sex (+ eTIV for volumes and areas)',
      'max-T FWE, 5000 permutations, two-sided, alpha 0.05',
    ])
    const battery = variableChoices(
      mockAnalysisCatalog(),
      MOCK_BATTERY_SPEC.variables.derived,
    )
    expect(designText(MOCK_BATTERY_SPEC)).toBe('Within SCI, 5 tests')
    expect(modelFormulaV2(MOCK_BATTERY_SPEC, battery)).toBe(
      'y ~ test + age + sex + eTIV',
    )
    expect(inferenceTextV2(MOCK_BATTERY_SPEC)).toBe(
      'BH-FDR, all tests together, two-sided, alpha 0.05',
    )
    // A labeled volume follows each subject's recon.
    expect(
      inputsCurrencyText(MOCK_BATTERY_SPEC, {
        aggregate: 'current',
        pybrainage: 'current',
        recon: { state: 'outdated', outdatedSubjectIds: ['sub-002'] },
      }),
    ).toBe('Inputs out of date')
    expect(
      inputsCurrencyText(
        { ...MOCK_BATTERY_SPEC, measures: ['dk:bi:precentral:ThickAvg'] },
        {
          aggregate: 'current',
          pybrainage: 'current',
          recon: { state: 'outdated', outdatedSubjectIds: [] },
        },
      ),
    ).toBe('Inputs current')
    expect(
      variableLabel({ source: 'registry', column: 'sourceCohortLabel' }),
    ).toBe('Registry: Source cohort label')
    expect(variableLabel({ source: 'metadata-csv', column: 'group' })).toBe(
      'metadata.csv: group',
    )
  })

  it('names each stale reason as one sentence', () => {
    expect(
      staleReasonText({
        code: 'qc-changed-sample',
        added: 1,
        removed: 2,
        sources: [],
      }),
    ).toBe(
      'QC verdicts changed the included subjects since this result: 1 added, 2 removed.',
    )
    expect(
      staleReasonText({
        code: 'inputs-changed',
        added: 0,
        removed: 0,
        sources: ['dk-all-stats', 'icv'],
      }),
    ).toBe(
      'The input tables changed since this result (dk_all_stats.csv, icv_data.csv).',
    )
    expect(
      staleReasonText({
        code: 'inputs-changed',
        added: 0,
        removed: 0,
        sources: ['stats:a2009s'],
      }),
    ).toBe('The input tables changed since this result (stats:a2009s).')
    expect(
      staleReasonText({
        code: 'labels-changed',
        added: 0,
        removed: 0,
        sources: [],
      }),
    ).toBe('Atlas labels changed since this result.')
    expect(
      staleReasonText({
        code: 'registry-changed',
        added: 0,
        removed: 0,
        sources: [],
      }),
    ).toBe('The registry changed the included subjects since this result.')
    expect(
      staleReasonText({
        code: 'registration-changed',
        added: 0,
        removed: 1,
        sources: [],
      }),
    ).toBe('Surface-registration flags changed since this result: 1 removed.')
    expect(
      staleReasonText({
        code: 'engine-changed',
        added: 0,
        removed: 0,
        sources: [],
      }),
    ).toBe('An earlier version of the analysis engine computed this result.')
    expect(
      staleReasonText({
        code: 'sample-too-small',
        added: 0,
        removed: 3,
        sources: [],
      }),
    ).toBe('Too few subjects remain to fit since this result: 3 removed.')
  })

  it('lists skipped measures', () => {
    expect(skippedText([])).toBeNull()
    expect(
      skippedText(
        [
          { measureId: 'aseg:Brain-Stem', reason: 'Too few values.' },
          { measureId: 'global:eTIV', reason: 'Too few values.' },
        ],
        1,
      ),
    ).toBe('Skipped: Brainstem volume: Too few values; and 1 more.')
  })

  it('names the stage whose table does not exist yet', () => {
    const inputs = mockAnalysisCatalog().inputs
    expect(missingOutputText(['aggregate', 'pybrainage'], inputs)).toBeNull()
    const none = inputs.map((i) => ({ ...i, present: false }))
    expect(missingOutputText(['aggregate'], none)).toBe(
      'Structural aggregation has no output yet. Run all produces it.',
    )
    expect(missingOutputText(['pybrainage'], none)).toBe(
      'PyBrainAge prediction has no output yet. Run all produces it.',
    )
  })

  it('names table rows, export folders, and compute time', () => {
    expect(tableMeasureName('dk:lh:precentral:ThickAvg')).toBe(
      'Precentral thickness',
    )
    expect(tableHemisphere('dk:lh:precentral:ThickAvg')).toBe('L')
    expect(tableMeasureName('aseg:Left-Thalamus')).toBe('Thalamus volume')
    expect(tableHemisphere('aseg:Right-Thalamus')).toBe('R')
    expect(tableHemisphere('aseg:bi:Thalamus')).toBe('Both')
    expect(tableHemisphere('aseg:Brain-Stem')).toBe('')
    expect(tableMeasureName('brainage:BrainPAD')).toBe('Brain-PAD')
    expect(exportFolderName('SCI vs controls', new Date(2026, 8, 3))).toBe(
      '2026-09-03-sci-vs-controls',
    )
    expect(computeEstimate(20, 5000)).toBe('a few seconds')
    expect(computeEstimate(646, 10000)).toBe('a few seconds')
    expect(computeEstimate(2000, 100_000)).toBe('about 64 s')
    expect(computeEstimate(20_000, 20_000)).toBe('about 2 min')
  })

  it('names a v1 table by file and any other source by its own key', () => {
    expect(inputSourceText('dk-all-stats')).toBe('dk_all_stats.csv')
    expect(inputSourceText('stats:aseg')).toBe('stats:aseg')
    // An inherited property name is not a v1 table.
    expect(inputSourceText('toString' as AnalysisInputSource)).toBe('toString')
  })

  it('opens a result on its first significant measure', () => {
    const result: GroupAnalysisResult = MOCK_ANALYSIS_RESULT
    expect(initialMeasure(result, null)).toBe(
      result.rows.find((row) => row.significant)!.measureId,
    )
    expect(initialMeasure(result, 'aseg:bi:Thalamus')).toBe('aseg:bi:Thalamus')
    expect(initialMeasure(result, 'aseg:Left-Pallidum')).not.toBe(
      'aseg:Left-Pallidum',
    )
    expect(initialMeasure({ ...result, rows: [] }, null)).toBeNull()
  })
})

describe('controls rail', () => {
  it('copies a locked ROI set that the selection changed', async () => {
    const api = renderScreen()
    const saveSet = vi.spyOn(api.groupAnalysis, 'saveSet')
    const rail = await ready()
    const sets = within(rail).getByLabelText('ROI set')
    const list = await api.groupAnalysis.list({ project: PROJECT })
    fireEvent.change(sets, { target: { value: list.sets[0]!.setId } })
    expect(within(rail).getByText('10 selected')).toBeInTheDocument()
    expect(
      within(rail).getByText(/^Locked 2026-09-23, SHA-256/),
    ).toBeInTheDocument()
    expect(
      within(rail).getByRole('button', { name: 'Save as set' }),
    ).toBeDisabled()
    fireEvent.click(
      within(rail).getByRole('checkbox', { name: 'Superior frontal' }),
    )
    expect(
      within(rail).getByText(
        'Changed from the locked set; saving makes a copy.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(within(rail).getByRole('button', { name: 'Save as set' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save the selection as a set',
    })
    expect(within(dialog).getByRole('textbox')).toHaveValue(
      'A priori regions (copy)',
    )
    // Dialog titles share the serif 18/400 display treatment.
    const title = within(dialog).getByRole('heading', {
      name: 'Save the selection as a set',
    })
    expect(title.style.fontSize).toBe('18px')
    expect(title.style.fontFamily).toContain('WebCM Serif 10')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save set' }))
    await waitFor(() => expect(saveSet).toHaveBeenCalled())
    expect(saveSet.mock.calls[0]![0]).toMatchObject({
      setId: null,
      name: 'A priori regions (copy)',
    })
    expect(saveSet.mock.calls[0]![0].measures).toHaveLength(11)
  })

  it('imports a set from a CSV through the native chooser', async () => {
    const api = createMockApi()
    api.groupAnalysis.chooseSetCsv = async () => ({
      name: 'brainstem.csv',
      displayPath: '/tmp/brainstem.csv',
      text: 'measure\naseg:Brain-Stem\nbogus\n',
    })
    renderScreen(api)
    const rail = await ready()
    fireEvent.click(within(rail).getByRole('button', { name: 'Import CSV' }))
    expect(
      await within(rail).findByText(
        'Imported 1 measure as brainstem; 1 value was not a measure ID.',
      ),
    ).toBeInTheDocument()
    expect(within(rail).getByText('1 selected')).toBeInTheDocument()
  })

  it('moves a level out of a group and updates the live group counts', async () => {
    renderScreen()
    const rail = await ready()
    expect(
      await screen.findByText('SCI vs CTRL, n 34 / 48'),
    ).toBeInTheDocument()
    fireEvent.change(within(rail).getByLabelText('Group of SCI_nNP'), {
      target: { value: '\u0000not-used' },
    })
    expect(
      await screen.findByText('SCI vs CTRL, n 22 / 48'),
    ).toBeInTheDocument()
    // The level can join the other group.
    fireEvent.change(within(rail).getByLabelText('Group of SCI_nNP'), {
      target: { value: 'CTRL' },
    })
    expect(
      await screen.findByText('SCI vs CTRL, n 22 / 60'),
    ).toBeInTheDocument()
  })

  it('blocks Compute while the draft is invalid and names why', async () => {
    renderScreen()
    const rail = await ready()
    fireEvent.change(
      within(rail).getByRole('textbox', { name: 'Name of group 1' }),
      {
        target: { value: 'CTRL' },
      },
    )
    expect(
      await screen.findByText('The analysis cannot compute yet.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Give each group a different label\./),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Compute' })).toBeDisabled()
  })

  it('keeps an out-of-range alpha out of the draft', async () => {
    renderScreen()
    const rail = await ready()
    fireEvent.click(within(rail).getByRole('button', { name: /Set inference/ }))
    const alpha = within(rail).getByRole('textbox', { name: 'Alpha' })
    fireEvent.change(alpha, { target: { value: '0.5' } })
    expect(
      within(rail).getByText('Use an alpha from 0.001 to 0.2.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('max-T FWE, 5000 permutations, two-sided, alpha 0.05'),
    ).toBeInTheDocument()
    fireEvent.change(alpha, { target: { value: '0.01' } })
    expect(
      await screen.findByText(
        'max-T FWE, 5000 permutations, two-sided, alpha 0.01',
      ),
    ).toBeInTheDocument()
    fireEvent.click(
      within(rail).getByRole('button', { name: 'Draw a new seed' }),
    )
    expect(within(rail).getByRole('textbox', { name: 'Seed' })).not.toHaveValue(
      '20260923',
    )
  })

  it('saves the draft as a named analysis in spec v2', async () => {
    const api = renderScreen()
    const saveSpec = vi.spyOn(api.groupAnalysis, 'saveSpec')
    const rail = await ready()
    fireEvent.click(within(rail).getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save the analysis',
    })
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Second look' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(saveSpec).toHaveBeenCalledWith(
        expect.objectContaining({
          specId: null,
          name: 'Second look',
          spec: expect.objectContaining({ schemaVersion: 2 }),
        }),
      ),
    )
    expect(
      await within(rail).findByRole('option', { name: 'Second look' }),
    ).toBeInTheDocument()
  })

  it('edits the covariates and shows them in the model formula', async () => {
    renderScreen()
    const rail = await ready()
    fireEvent.click(
      within(rail).getByRole('button', { name: /Adjust for covariates/ }),
    )
    fireEvent.change(within(rail).getByLabelText('Age'), {
      target: { value: '' },
    })
    fireEvent.click(within(rail).getByRole('radio', { name: 'All measures' }))
    expect(
      await screen.findByText('y ~ group + sex + eTIV'),
    ).toBeInTheDocument()
    fireEvent.change(within(rail).getByLabelText('Sex'), {
      target: { value: '' },
    })
    fireEvent.click(within(rail).getByRole('radio', { name: 'None' }))
    expect(await screen.findByText('y ~ group')).toBeInTheDocument()
    expect(
      within(rail).queryByRole('radio', { name: 'All measures' }),
    ).toBeNull()
    expect(
      within(rail).getByText('Covariates are centered on the sample mean.'),
    ).toBeInTheDocument()
  })

  it('edits the inference settings', async () => {
    renderScreen()
    const rail = await ready()
    fireEvent.click(within(rail).getByRole('button', { name: /Set inference/ }))
    fireEvent.click(within(rail).getByRole('radio', { name: 'Lower in SCI' }))
    fireEvent.change(within(rail).getByLabelText('Correction'), {
      target: { value: 'holm' },
    })
    expect(
      await screen.findByText('Holm, one-sided (lower), alpha 0.05'),
    ).toBeInTheDocument()
    fireEvent.click(
      within(rail).getByRole('radio', { name: 'Each measure family' }),
    )
    fireEvent.click(within(rail).getByRole('radio', { name: 'None' }))
    fireEvent.change(within(rail).getByLabelText('Correction'), {
      target: { value: 'maxt-fwe' },
    })
    // Max-T needs permutations, so choosing it restores 5000.
    expect(
      await screen.findByText(
        'max-T FWE, 5000 permutations, one-sided (lower), alpha 0.05',
      ),
    ).toBeInTheDocument()
    expect(within(rail).getByRole('radio', { name: 'None' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    fireEvent.change(within(rail).getByRole('textbox', { name: 'Seed' }), {
      target: { value: '42' },
    })
    fireEvent.change(within(rail).getByRole('textbox', { name: 'Seed' }), {
      target: { value: '-1' },
    })
    expect(
      within(rail).getByText('Use a whole number from 0 to 4294967295.'),
    ).toBeInTheDocument()
  })

  it('filters the catalog by source, metric, hemisphere, and name', async () => {
    renderScreen()
    const rail = await ready()
    fireEvent.click(within(rail).getByRole('button', { name: 'Clear all' }))
    expect(within(rail).getByText('0 selected')).toBeInTheDocument()
    const source = within(rail).getByLabelText('Source')
    fireEvent.change(source, { target: { value: 'aseg' } })
    fireEvent.change(
      within(rail).getByRole('textbox', { name: 'Filter measures by name' }),
      {
        target: { value: 'thal' },
      },
    )
    expect(
      within(rail).getByRole('checkbox', { name: 'Thalamus' }),
    ).toBeInTheDocument()
    fireEvent.click(within(rail).getByRole('button', { name: 'Select shown' }))
    expect(within(rail).getByText('1 selected')).toBeInTheDocument()
    expect(
      within(rail).getByText(/selected: 1 subcortical/),
    ).toBeInTheDocument()
    fireEvent.click(within(rail).getByRole('radio', { name: 'Left' }))
    expect(
      within(rail).getByRole('checkbox', { name: 'Left thalamus' }),
    ).toBeInTheDocument()
    fireEvent.change(
      within(rail).getByRole('textbox', { name: 'Filter measures by name' }),
      {
        target: { value: 'zzz' },
      },
    )
    expect(within(rail).getByText('No measure matches.')).toBeInTheDocument()
    fireEvent.change(source, { target: { value: 'dk' } })
    fireEvent.click(within(rail).getByRole('radio', { name: 'More' }))
    fireEvent.change(within(rail).getByLabelText('Other metric'), {
      target: { value: 'MeanCurv' },
    })
    fireEvent.click(within(rail).getByRole('button', { name: 'Select shown' }))
    expect(within(rail).getByText('35 selected')).toBeInTheDocument()
    fireEvent.click(within(rail).getByRole('button', { name: 'Clear shown' }))
    fireEvent.change(source, { target: { value: 'global' } })
    fireEvent.click(
      within(rail).getByRole('checkbox', { name: 'Mean cortical thickness' }),
    )
    expect(
      within(rail).getByText(/selected: 1 subcortical, 1 whole-brain/),
    ).toBeInTheDocument()
    // A tier A atlas states its reach, metrics, and hemispheres.
    fireEvent.change(source, { target: { value: 'a2009s' } })
    expect(
      within(rail).getByText(
        '82 of 82 subjects have the stats files; 1 recon out of date.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(within(rail).getByRole('radio', { name: 'Area' }))
    fireEvent.click(within(rail).getByRole('radio', { name: 'Right' }))
    fireEvent.click(
      within(rail).getByRole('checkbox', { name: 'G_precentral' }),
    )
    expect(
      within(rail).getByText(/1 Destrieux \(aparc\.a2009s\)/),
    ).toBeInTheDocument()
  })
})

function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('check row', () => {
  it('sets the trailing count as a sans state line', () => {
    render(
      <AppProvider>
        <CheckRow
          checked={false}
          onChange={() => {}}
          label="Age"
          trailing="n 12"
        />
      </AppProvider>,
    )
    expect(screen.getByText('n 12').style.fontFamily).toContain('WebCM Sans 10')
  })
})

describe('results table significance cell', () => {
  it('keeps 4.5:1 on the selected row and the plain row in every theme', () => {
    const themes = [
      THEMES.light,
      THEMES.dark,
      highContrastTheme(THEMES.light),
      highContrastTheme(THEMES.dark),
    ]
    for (const t of themes) {
      for (const significant of [true, false]) {
        expect(
          contrastRatio(sigCellColor(t, significant, true), t.accentSoft),
        ).toBeGreaterThanOrEqual(4.5)
        expect(
          contrastRatio(sigCellColor(t, significant, false), t.surface),
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('inspecting a subject', () => {
  it("opens the Brain tab on the subject's volumes", async () => {
    renderScreen()
    await ready()
    fireEvent.click(screen.getByRole('tab', { name: 'Measure' }))
    const figure = await screen.findByRole('img', {
      name: /^Adjusted values: /,
    })
    const marker = figure.querySelector('g[style*="cursor: pointer"]')!
    fireEvent.click(marker)
    fireEvent.click(
      await screen.findByRole('button', {
        name: "Inspect this subject's brain",
      }),
    )
    expect(await screen.findByTestId('brain-stub')).toHaveTextContent(
      /^volumes sub-\d+$/,
    )
    const inspected = screen.getByTestId('brain-stub').textContent
    // Another subject picked without Inspect opens on the surfaces.
    fireEvent.click(screen.getByRole('tab', { name: 'Measure' }))
    const again = await screen.findByRole('img', {
      name: /^Adjusted values: /,
    })
    const other = [...again.querySelectorAll('g[style*="cursor: pointer"]')].at(
      -1,
    )!
    fireEvent.click(other)
    fireEvent.click(screen.getByRole('tab', { name: 'Brain' }))
    const stub = await screen.findByTestId('brain-stub')
    expect(stub).toHaveTextContent(/^surface sub-\d+$/)
    expect(stub.textContent).not.toBe(inspected?.replace('volumes', 'surface'))
  })
})

describe('measure figure size', () => {
  it('fits the figure to a short page and keeps it whole on a tall one', () => {
    expect(measureFigureSize(900, null)).toEqual({
      widthPt: 300,
      cssWidth: 480,
    })
    expect(measureFigureSize(900, 900)).toEqual({ widthPt: 300, cssWidth: 480 })
    const short = measureFigureSize(900, 260)
    expect(short.widthPt).toBe(257)
    // The drawn height, scaled to the CSS width, fits inside the paper.
    const height = (short.cssWidth / short.widthPt) * scatterHeight(257)
    expect(height).toBeLessThanOrEqual(260 - 30 + 0.01)
    expect(height).toBeGreaterThan(200)
  })
})
