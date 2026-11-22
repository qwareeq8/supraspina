// @vitest-environment jsdom

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { ATLAS_SOURCES } from '../../../shared/atlas-labeling'
import { DEFAULT_PROJECT_CONFIG } from '../../../shared/project-schema'
import type { SupraspinaApi } from '../../../shared/contract'
import { createMockApi } from '../../ipc/mock'
import { MOCK_VARIABLE_TABLE } from '../../ipc/mock-analysis-v2'
import { createMockGroupAnalysis } from '../../ipc/mock-group-analysis'
import { AppProvider, useApp } from '../../state/context'
import { AnalysisScreen } from '../AnalysisScreen'
import { bytesText } from './rail-text'

// The Brain tab's NiiVue view does not run in jsdom.
vi.mock('./BrainView', () => ({
  BrainView: () => <output data-testid="brain-stub" />,
}))

const PROJECT = {
  projectId: 'rail-project',
  root: '/projects/rail',
  configPath: '/projects/rail/supraspina.project.json',
  epoch: 1,
}
const TABLE = MOCK_VARIABLE_TABLE.tableId

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

function RouteProbe(): ReactNode {
  return <output data-testid="route">{useApp().route}</output>
}

function renderScreen(api: SupraspinaApi = createMockApi()): SupraspinaApi {
  window.supraspina = api
  render(
    <AppProvider>
      <Bootstrap>
        <AnalysisScreen />
        <RouteProbe />
      </Bootstrap>
    </AppProvider>,
  )
  return api
}

async function ready(): Promise<HTMLElement> {
  await screen.findByRole('img', { name: /Forest plot/ })
  const rail = screen.getByRole('complementary', { name: 'Analysis settings' })
  // The summary names the group sizes once the sample resolves.
  await screen.findByText('SCI vs CTRL, n 34 / 48')
  return rail
}

function open(rail: HTMLElement, section: RegExp): void {
  fireEvent.click(within(rail).getByRole('button', { name: section }))
}

// Each test drives the whole panel through many resolves; under a full
// parallel run that takes longer than the defaults allow.
vi.setConfig({ testTimeout: 30_000 })
configure({ asyncUtilTimeout: 4000 })

afterEach(() => vi.restoreAllMocks())

describe('design', () => {
  it('switches between and within designs and edits the tests', async () => {
    renderScreen()
    const rail = await ready()
    fireEvent.click(within(rail).getByRole('radio', { name: 'Within a group' }))
    expect(within(rail).getByLabelText('Population from')).toHaveValue(
      'registry:sourceCohortLabel',
    )
    expect(
      within(rail).getByRole('checkbox', { name: 'Test within SCI' }),
    ).toBeChecked()
    // A clinical variable is tested first, not the age covariate.
    expect(within(rail).getByLabelText('Tested variable')).toHaveValue(
      `imported:${TABLE}:UEMS`,
    )
    expect(
      await screen.findByText('Within SCI, UEMS, n 34'),
    ).toBeInTheDocument()

    fireEvent.change(within(rail).getByLabelText('Add a test'), {
      target: { value: 'two-group' },
    })
    fireEvent.click(within(rail).getByRole('button', { name: 'Add test' }))
    // The subgroups come from a clinical column, not the cohort itself.
    expect(within(rail).getByLabelText('Groups from')).toHaveValue(
      `imported:${TABLE}:injury_level`,
    )
    expect(
      within(rail).getByRole('button', {
        name: 'Close thoracic-lumbar vs cervical',
      }),
    ).toBeInTheDocument()
    fireEvent.change(within(rail).getByLabelText('Groups from'), {
      target: { value: `imported:${TABLE}:neurological_level` },
    })
    fireEvent.click(
      within(rail).getByRole('button', {
        name: 'Group levels by first character',
      }),
    )
    expect(
      within(rail).getByRole('textbox', { name: 'Name of group 3' }),
    ).toHaveValue('L')
    expect(within(rail).getByLabelText('Group of T10')).toHaveValue('T')
    expect(within(rail).getByLabelText('Focal group')).toHaveValue('C')
    expect(within(rail).getByLabelText('Reference group')).toHaveValue('L')
    expect(
      await screen.findByText('Within SCI, 2 tests, n 34'),
    ).toBeInTheDocument()

    fireEvent.click(
      within(rail).getByRole('checkbox', { name: 'In the family' }),
    )
    expect(
      within(rail).getByText(
        'A sensitivity test outside the family: its rows have no corrected p.',
      ),
    ).toBeInTheDocument()
    fireEvent.change(within(rail).getByLabelText('Add a covariate to C vs L'), {
      target: { value: `imported:${TABLE}:LEMS` },
    })
    expect(
      within(rail).getByRole('button', {
        name: 'Stop adjusting C vs L for clinical-variables.csv: LEMS',
      }),
    ).toBeInTheDocument()
    fireEvent.click(within(rail).getByRole('button', { name: 'Remove C vs L' }))
    expect(within(rail).queryByLabelText('Focal group')).toBeNull()

    fireEvent.click(within(rail).getByRole('radio', { name: 'Between groups' }))
    expect(
      await screen.findByText(/^SCI vs CTRL, n 34 \/ 48$/),
    ).toBeInTheDocument()
    expect(within(rail).getByLabelText('Compare as')).toHaveValue('two-group')
  })

  it('shows a single test as its editor alone, with a select for the kind', async () => {
    renderScreen()
    const rail = await ready()
    // One test has no card, summary row, or Edit and Close toggle.
    expect(
      within(rail).queryByRole('button', { name: /^(Edit|Close) / }),
    ).toBeNull()
    expect(within(rail).queryByText('Comparison')).toBeNull()
    const kind = within(rail).getByRole('combobox', { name: 'Compare as' })
    expect(kind).toHaveValue('two-group')
    expect(kind).toHaveAttribute('title', 'Two groups')
    expect(
      within(kind).getByRole('option', { name: 'Three or more groups' }),
    ).toBeInTheDocument()
    // The design switch explains each option in its title, not a hint.
    expect(
      within(rail).getByRole('radio', { name: 'Between groups' }),
    ).toHaveAttribute(
      'title',
      'Compare adjusted measures between the groups of a variable.',
    )
    expect(
      within(rail).getByRole('radio', { name: 'Within a group' }),
    ).toHaveAttribute(
      'title',
      'Run tests inside one population, such as subgroups or clinical scores.',
    )
    expect(
      within(rail).queryByText(/^Compares adjusted measures between/),
    ).toBeNull()

    fireEvent.click(within(rail).getByRole('radio', { name: 'Within a group' }))
    expect(within(rail).getByText('Tests')).toBeInTheDocument()
    expect(within(rail).getByRole('combobox', { name: 'Test' })).toHaveValue(
      'association',
    )
    // The last group of the population cannot be cleared, and says why.
    const last = within(rail).getByRole('checkbox', {
      name: 'Test within SCI',
    })
    expect(last).toBeDisabled()
    expect(last.closest('label')).toHaveAttribute(
      'title',
      'The population needs at least one group.',
    )
    // The import button's title says where the variables come from.
    expect(
      within(rail).getByRole('button', { name: 'Import table...' }),
    ).toHaveAttribute(
      'title',
      'The registry and the metadata CSVs provide the variables. Import a table or derive a variable to add more.',
    )
  })

  it('compares three or more groups, a slope difference, or an association', async () => {
    renderScreen()
    const rail = await ready()
    open(rail, /Set inference/)
    fireEvent.click(within(rail).getByRole('radio', { name: 'Lower in SCI' }))
    fireEvent.change(within(rail).getByLabelText('Compare as'), {
      target: { value: 'omnibus' },
    })
    expect(
      await screen.findByText(/^CTRL, SCI_nNP, and SCI_P, n 82$/),
    ).toBeInTheDocument()
    // An F test has no direction, so the draft turns two-sided.
    expect(
      screen.getByText('max-T FWE, 5000 permutations, two-sided, alpha 0.05'),
    ).toBeInTheDocument()
    expect(within(rail).getByRole('radio', { name: 'Lower' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(
      within(rail).getByText(
        'CTRL, SCI_nNP, and SCI_P is an F test, which has no direction, so every test is two-sided.',
      ),
    ).toBeInTheDocument()
    expect(within(rail).getByLabelText('Pairwise comparisons')).toHaveValue(
      'all-pairs',
    )
    fireEvent.click(
      within(rail).getByRole('radio', { name: 'Each pair separately' }),
    )
    fireEvent.click(
      within(rail).getByRole('switch', {
        name: 'Show pairwise only after a significant omnibus',
      }),
    )
    expect(
      within(rail).getByRole('switch', {
        name: 'Show pairwise only after a significant omnibus',
      }),
    ).toHaveAttribute('aria-checked', 'true')
    fireEvent.change(within(rail).getByLabelText('Pairwise comparisons'), {
      target: { value: 'versus-reference' },
    })
    expect(
      within(rail).getByRole('option', { name: 'Each group versus CTRL' }),
    ).toBeInTheDocument()

    fireEvent.change(within(rail).getByLabelText('Compare as'), {
      target: { value: 'interaction' },
    })
    expect(within(rail).getByLabelText('Moderator')).toHaveValue(
      `imported:${TABLE}:UEMS`,
    )
    fireEvent.click(within(rail).getByRole('radio', { name: 'Per SD' }))
    expect(
      await screen.findByText(/^Slope of UEMS by group, n 82$/),
    ).toBeInTheDocument()
    fireEvent.change(within(rail).getByLabelText('Moderator'), {
      target: { value: `imported:${TABLE}:injury_level` },
    })
    expect(
      within(rail).getByText(
        'Tests whether the group difference differs between the moderator levels.',
      ),
    ).toBeInTheDocument()
    expect(within(rail).queryByRole('radio', { name: 'Per SD' })).toBeNull()

    fireEvent.change(within(rail).getByLabelText('Compare as'), {
      target: { value: 'association' },
    })
    // A categorical moderator is not carried over as the tested variable.
    expect(within(rail).getByLabelText('Tested variable')).toHaveValue(
      `imported:${TABLE}:UEMS`,
    )
    fireEvent.click(within(rail).getByRole('radio', { name: 'log(1 + x)' }))
    expect(
      await screen.findByText(/^UEMS, log\(1 \+ x\), n 82$/),
    ).toBeInTheDocument()
    expect(within(rail).queryByLabelText('Groups from')).toBeNull()
    fireEvent.click(
      within(rail).getByRole('switch', { name: 'Adjust for group' }),
    )
    expect(within(rail).getByLabelText('Groups from')).toHaveValue(
      'registry:sourceCohortLabel',
    )
    expect(
      await screen.findByText(
        'y ~ UEMS + group + age + sex (+ eTIV for volumes and areas)',
      ),
    ).toBeInTheDocument()
  })

  it('filters rows and stratifies', async () => {
    renderScreen()
    const rail = await ready()
    expect(
      await screen.findByText('SCI vs CTRL, n 34 / 48'),
    ).toBeInTheDocument()
    fireEvent.change(within(rail).getByLabelText('Add a subset filter'), {
      target: { value: 'registry:sex' },
    })
    const levels = within(rail).getByRole('group', {
      name: 'Levels of Registry: Sex to keep',
    })
    fireEvent.click(within(levels).getByRole('checkbox', { name: /^F/ }))
    await waitFor(() =>
      expect(screen.queryByText('SCI vs CTRL, n 34 / 48')).toBeNull(),
    )
    expect(within(levels).getByRole('checkbox', { name: /^M/ })).toBeDisabled()
    fireEvent.change(within(rail).getByLabelText('Add a subset filter'), {
      target: { value: 'registry:age' },
    })
    const least = within(rail).getByRole('textbox', {
      name: 'Registry: Age at least',
    })
    fireEvent.change(least, { target: { value: 'abc' } })
    expect(within(rail).getByText('Use a number.')).toBeInTheDocument()
    fireEvent.change(least, { target: { value: '30' } })
    expect(within(rail).queryByText('Use a number.')).toBeNull()
    fireEvent.click(
      within(rail).getByRole('button', {
        name: 'Remove the filter on Registry: Age',
      }),
    )
    expect(
      within(rail).queryByRole('textbox', { name: 'Registry: Age at least' }),
    ).toBeNull()

    fireEvent.change(within(rail).getByLabelText('Strata from'), {
      target: { value: 'registry:cohortRole' },
    })
    expect(
      within(rail).getByRole('switch', {
        name: 'Test whether effects differ between strata',
      }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      await screen.findByText(/^SCI vs CTRL, by 3 strata, n /),
    ).toBeInTheDocument()
    fireEvent.click(
      within(rail).getByRole('switch', {
        name: 'Test whether effects differ between strata',
      }),
    )
    expect(
      within(rail).getByText(
        'Every test runs in each stratum with its own centering.',
      ),
    ).toBeInTheDocument()
    fireEvent.change(within(rail).getByLabelText('Strata from'), {
      target: { value: '' },
    })
    expect(
      within(rail).queryByRole('switch', {
        name: 'Test whether effects differ between strata',
      }),
    ).toBeNull()
  })

  it('imports a variables table and derives variables', async () => {
    const api = renderScreen()
    const remove = vi.spyOn(api.groupAnalysis, 'removeVariables')
    const rail = await ready()
    fireEvent.click(
      within(rail).getByRole('button', { name: 'Import table...' }),
    )
    let dialog = await screen.findByRole('dialog', {
      name: 'Imported variables',
    })
    expect(
      within(dialog).getByText('clinical-variables.csv'),
    ).toBeInTheDocument()
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Remove clinical-variables.csv',
      }),
    )
    expect(
      await within(dialog).findByText('Removed clinical-variables.csv.'),
    ).toBeInTheDocument()
    expect(remove).toHaveBeenCalledWith({ project: PROJECT, tableId: TABLE })
    await waitFor(() =>
      expect(
        within(dialog).getByText('No table is imported.'),
      ).toBeInTheDocument(),
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Choose CSV...' }),
    )
    expect(
      await within(dialog).findByText(
        'Imported clinical-variables.csv: 34 rows, 7 variables.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(
      await within(rail).findByText('clinical-variables.csv'),
    ).toBeInTheDocument()

    fireEvent.click(within(rail).getByRole('button', { name: 'Derive...' }))
    dialog = await screen.findByRole('dialog', { name: 'Derive a variable' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Motor' },
    })
    expect(
      within(dialog).getByRole('button', { name: 'Add variable' }),
    ).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Input 1'), {
      target: { value: `imported:${TABLE}:UEMS` },
    })
    fireEvent.change(within(dialog).getByLabelText('Input 2'), {
      target: { value: `imported:${TABLE}:LEMS` },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add input' }))
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Remove input 3' }),
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Add variable' }),
    )
    expect(await within(rail).findByText('= UEMS + LEMS')).toBeInTheDocument()

    fireEvent.click(within(rail).getByRole('button', { name: 'Derive...' }))
    dialog = await screen.findByRole('dialog', { name: 'Derive a variable' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Age band' },
    })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Bins' }))
    fireEvent.change(within(dialog).getByLabelText('Variable'), {
      target: { value: 'registry:age' },
    })
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: 'Cut points' }),
      {
        target: { value: '45, 30' },
      },
    )
    expect(
      within(dialog).getByText('Give the cut points in increasing order.'),
    ).toBeInTheDocument()
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: 'Cut points' }),
      {
        target: { value: '30, 45' },
      },
    )
    expect(
      within(dialog).getByText('Bins: <30, 30 to <45, >=45.'),
    ).toBeInTheDocument()
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Add variable' }),
    )
    expect(await within(rail).findByText('= Age in 3 bins')).toBeInTheDocument()
    // A derived bins variable is categorical: it can form strata.
    fireEvent.change(within(rail).getByLabelText('Strata from'), {
      target: { value: 'derived:dv-age-band' },
    })
    expect(
      within(rail).getByRole('button', {
        name: 'Remove the derived variable Age band',
      }),
    ).toBeDisabled()
    fireEvent.click(
      within(rail).getByRole('button', {
        name: 'Remove the derived variable Motor',
      }),
    )
    expect(within(rail).queryByText('= UEMS + LEMS')).toBeNull()
  })
})

describe('design check', () => {
  it('names the site rule and applies its two fixes as draft edits', async () => {
    const api = createMockApi()
    api.groupAnalysis = createMockGroupAnalysis(() => PROJECT.root, {
      sites: true,
    }).groupAnalysis
    renderScreen(api)
    await screen.findByRole('img', { name: /Forest plot/ })
    const rail = screen.getByRole('complementary', {
      name: 'Analysis settings',
    })
    expect(
      await within(rail).findByText('The design check blocks Compute.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Compute' })).toBeDisabled()
    fireEvent.click(within(rail).getByRole('button', { name: 'Show' }))
    expect(
      within(rail).getByText('Design check: 1 finding blocks Compute.'),
    ).toBeInTheDocument()
    fireEvent.click(within(rail).getByRole('button', { name: 'Details' }))
    expect(
      within(rail).getByRole('region', {
        name: "SCI vs CTRL by site, Cramer's V 0.38",
      }),
    ).toBeInTheDocument()
    expect(
      within(rail).getByRole('region', { name: 'Cells' }),
    ).toHaveTextContent(/Female/)
    fireEvent.click(
      within(rail).getByRole('button', { name: 'Adjust for site' }),
    )
    expect(
      await within(rail).findByText('Design check: 1 warning.'),
    ).toBeInTheDocument()
    expect(
      within(rail).getByRole('checkbox', { name: /^Registry: Site/ }),
    ).toBeChecked()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Compute' })).toBeEnabled(),
    )
    fireEvent.click(
      within(rail).getByRole('checkbox', { name: /^Registry: Site/ }),
    )
    fireEvent.click(
      await within(rail).findByRole('button', { name: 'Leave out site B' }),
    )
    expect(
      await within(rail).findByText('Design check: no findings.'),
    ).toBeInTheDocument()
    const kept = within(rail).getByRole('group', {
      name: 'Levels of Registry: Site to keep',
    })
    expect(within(kept).getByRole('checkbox', { name: /^A/ })).toBeChecked()
    expect(within(kept).getByRole('checkbox', { name: /^B/ })).not.toBeChecked()
  })

  it('blocks a cell below the smallest cell and shows VIFs', async () => {
    renderScreen()
    const rail = await ready()
    fireEvent.change(within(rail).getByLabelText('Compare as'), {
      target: { value: 'omnibus' },
    })
    open(rail, /Include subjects/)
    fireEvent.change(within(rail).getByLabelText('Smallest cell'), {
      target: { value: '13' },
    })
    expect(
      await within(rail).findByText(
        'The smallest cell is SCI_nNP with 12 subjects; fewer than 13 blocks the test.',
      ),
    ).toBeInTheDocument()
    expect(
      within(rail).getByText('The design check blocks Compute.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Compute' })).toBeDisabled()
    fireEvent.change(within(rail).getByLabelText('Smallest cell'), {
      target: { value: '3' },
    })
    await waitFor(() =>
      expect(
        within(rail).queryByText('The design check blocks Compute.'),
      ).toBeNull(),
    )
    // A test's own covariate shows its variance inflation.
    fireEvent.change(within(rail).getByLabelText('Add a test'), {
      target: { value: 'association' },
    })
    fireEvent.click(within(rail).getByRole('button', { name: 'Add test' }))
    fireEvent.change(within(rail).getByLabelText('Add a covariate to UEMS'), {
      target: { value: `imported:${TABLE}:age_at_injury` },
    })
    open(rail, /Adjust for covariates/)
    fireEvent.click(
      await within(rail).findByRole('button', { name: 'Details' }),
    )
    await waitFor(() =>
      expect(
        within(rail).getByRole('region', { name: 'Variance inflation' }),
      ).toHaveTextContent('6.20'),
    )
  })
})

describe('covariates and inference', () => {
  it('chooses the head-size source and a measure covariate', async () => {
    renderScreen()
    const rail = await ready()
    open(rail, /Adjust for covariates/)
    expect(
      within(rail).getByRole('radio', { name: 'SynthSeg TIV' }),
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      within(rail).getByText('SynthSeg TIV: No subject has synthseg.tiv.dat.'),
    ).toBeInTheDocument()
    fireEvent.click(within(rail).getByRole('radio', { name: 'sTIV' }))
    expect(
      await screen.findByText(
        'y ~ group + age + sex (+ sTIV for volumes and areas)',
      ),
    ).toBeInTheDocument()
    fireEvent.change(within(rail).getByLabelText('Adjust for a measure'), {
      target: { value: 'measure:aseg:Brain-Stem' },
    })
    expect(
      await screen.findByText(
        'y ~ group + age + sex + Brainstem volume (+ sTIV for volumes and areas)',
      ),
    ).toBeInTheDocument()
    fireEvent.click(
      within(rail).getByRole('button', {
        name: 'Stop adjusting for Brainstem volume',
      }),
    )
    open(rail, /Include subjects/)
    expect(within(rail).getByLabelText('Smallest cell')).toHaveValue('2')
    expect(
      await within(rail).findByText(
        'The smallest cell is SCI with 34 subjects; fewer than 2 blocks the test.',
      ),
    ).toBeInTheDocument()
  })

  it('offers the correction families the design allows', async () => {
    renderScreen()
    const rail = await ready()
    fireEvent.change(within(rail).getByLabelText('Compare as'), {
      target: { value: 'omnibus' },
    })
    fireEvent.change(within(rail).getByLabelText('Add a test'), {
      target: { value: 'association' },
    })
    fireEvent.click(within(rail).getByRole('button', { name: 'Add test' }))
    open(rail, /Set inference/)
    const family = within(rail).getByLabelText('Correct over')
    expect(family).toHaveValue('per-test')
    expect(
      within(rail).getByRole('option', { name: 'All tests together' }),
    ).toBeDisabled()
    expect(
      within(rail).getByText(
        'Max-T cannot pool t and F tests; choose Holm, Bonferroni, or BH-FDR to correct them together.',
      ),
    ).toBeInTheDocument()
    fireEvent.change(within(rail).getByLabelText('Correction'), {
      target: { value: 'holm' },
    })
    fireEvent.change(family, { target: { value: 'all-tests' } })
    expect(
      await screen.findByText(
        'Holm, all tests together, two-sided, alpha 0.05',
      ),
    ).toBeInTheDocument()
  })
})

describe('atlases', () => {
  it('labels subjects with an atlas on demand', async () => {
    const api = createMockApi()
    const start = vi.spyOn(api.groupAnalysis, 'labelStart')
    const clear = vi.spyOn(api.groupAnalysis, 'clearLabels')
    const folder = vi.spyOn(api.groupAnalysis, 'chooseLabelsFolder')
    const atlases = vi.spyOn(api.groupAnalysis, 'atlases')
    renderScreen(api)
    const rail = await ready()
    expect(atlases).toHaveBeenCalledWith({
      project: PROJECT,
      reconOutdatedSubjectIds: [],
    })
    const source = within(rail).getByLabelText('Source')
    expect(
      within(source).getByRole('option', {
        name: 'Brainstem subfields (23 of 82)',
      }),
    ).toBeInTheDocument()
    expect(
      within(source).getByRole('group', { name: 'Labeled on demand' }),
    ).toBeInTheDocument()
    fireEvent.change(source, { target: { value: 'brainstem-ss' } })
    expect(
      within(rail).getByText(
        '20 of 82 subjects labeled, 2 out of date, 1 failed; 3 recons have the outputs already; 1 recon out of date.',
      ),
    ).toBeInTheDocument()
    const label = within(rail).getByRole('button', {
      name: 'Label 59 subjects with brainstem subfields',
    })
    expect(label).toBeDisabled()
    // Two facts share one fix, which is offered once.
    const choose = within(rail).getAllByRole('button', {
      name: 'Choose Python 3.12...',
    })
    expect(choose).toHaveLength(1)
    fireEvent.click(choose[0]!)
    expect(
      await within(rail).findByText('/opt/py312/bin/python'),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(rail).getByRole('button', {
          name: 'Label 59 subjects with brainstem subfields',
        }),
      ).toBeEnabled(),
    )
    fireEvent.change(within(rail).getByLabelText('In parallel'), {
      target: { value: '4' },
    })
    expect(
      within(rail).getByText(/^Takes about 3 h with 4 in parallel\./),
    ).toBeInTheDocument()
    fireEvent.click(
      within(rail).getByRole('button', {
        name: 'Label 59 subjects with brainstem subfields',
      }),
    )
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          atlasId: 'brainstem-ss',
          subjects: 'missing',
          jobs: 4,
          stageCurrency: expect.objectContaining({
            recon: { state: 'unknown', outdatedSubjectIds: [] },
          }),
        }),
      ),
    )
    // The progress shows in the panel and at the top of the rail.
    expect(
      await within(rail).findAllByText('Labeling brainstem subfields'),
    ).toHaveLength(2)
    expect(
      within(rail).getAllByText('0 of 59 subjects; about 12 h left.'),
    ).toHaveLength(2)
    fireEvent.click(
      within(rail).getAllByRole('button', { name: 'Cancel the labeling' })[0]!,
    )
    expect(
      await within(rail).findByText(
        'The brainstem subfields labeling was canceled: 0 labeled; labeled subjects keep their labels.',
      ),
    ).toBeInTheDocument()
    expect(
      within(rail).getByRole('button', { name: 'Relabel 2 out of date' }),
    ).toBeEnabled()

    fireEvent.click(
      within(rail).getByRole('button', { name: 'Subject states' }),
    )
    expect(
      await within(rail).findByText(
        'Labeled 20, Out of date 2, Failed 1, Not labeled 59; 4 imported',
      ),
    ).toBeInTheDocument()
    expect(
      within(rail).getByText(
        'Failed: segment_subregions stopped with exit code 1.',
      ),
    ).toBeInTheDocument()

    fireEvent.click(
      within(rail).getByRole('button', { name: 'Import outputs...' }),
    )
    await waitFor(() =>
      expect(folder).toHaveBeenCalledWith({
        project: PROJECT,
        atlasId: 'brainstem-ss',
      }),
    )
    fireEvent.click(
      within(rail).getByRole('button', { name: 'Clear labels...' }),
    )
    const confirm = await screen.findByRole('dialog', {
      name: 'Clear the brainstem subfields labels?',
    })
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Clear labels' }),
    )
    await waitFor(() =>
      expect(clear).toHaveBeenCalledWith({
        project: PROJECT,
        atlasId: 'brainstem-ss',
        subjects: 'all',
        expectedRevision: 3,
      }),
    )
    fireEvent.click(
      within(rail).getByRole('button', { name: 'Clear the subregions Python' }),
    )
    await waitFor(() =>
      expect(within(rail).queryByText('/opt/py312/bin/python')).toBeNull(),
    )
  })

  it('sends a missing FreeSurfer home to Diagnostics', async () => {
    const api = createMockApi()
    const atlases = api.groupAnalysis.atlases.bind(api.groupAnalysis)
    vi.spyOn(api.groupAnalysis, 'atlases').mockImplementation(
      async (request) => {
        const catalog = await atlases(request)
        return {
          ...catalog,
          tools: catalog.tools.map((fact) =>
            fact.toolId === 'freesurfer-home'
              ? {
                  ...fact,
                  state: 'missing' as const,
                  detail: 'FreeSurfer is not set for this project.',
                  fix: 'set-freesurfer-home' as const,
                }
              : fact,
          ),
        }
      },
    )
    renderScreen(api)
    const rail = await ready()
    fireEvent.change(within(rail).getByLabelText('Source'), {
      target: { value: 'brainstem-ss' },
    })
    fireEvent.click(
      await within(rail).findByRole('button', { name: 'Open Diagnostics' }),
    )
    expect(screen.getByTestId('route')).toHaveTextContent('diagnostics')
  })

  it('offers Import outputs only where the sidecar takes them', async () => {
    renderScreen()
    const rail = await ready()
    const source = within(rail).getByLabelText('Source')
    fireEvent.change(source, { target: { value: 'brainstem-ss' } })
    expect(
      within(rail).getByRole('button', { name: 'Import outputs...' }),
    ).toBeInTheDocument()
    // A surface atlas, built in or added, has no outputs to import.
    for (const atlasId of ['yeo7', 'user-0a1b2c3d']) {
      fireEvent.change(source, { target: { value: atlasId } })
      expect(
        within(rail).getByRole('button', { name: 'Subject states' }),
      ).toBeInTheDocument()
      expect(
        within(rail).queryByRole('button', { name: 'Import outputs...' }),
      ).toBeNull()
    }
  })

  it('labels the DKT template only and says so', async () => {
    const api = renderScreen()
    const start = vi.spyOn(api.groupAnalysis, 'labelStart')
    const rail = await ready()
    fireEvent.change(within(rail).getByLabelText('Source'), {
      target: { value: 'dkt' },
    })
    expect(
      within(rail).getByText(
        "Labeling DKT (aparc.DKTatlas) labels the fsaverage5 template only, for the brain view; the measures come from each subject's own stats.",
      ),
    ).toBeInTheDocument()
    expect(
      within(rail).getByText(
        'No subject has measures of DKT (aparc.DKTatlas) yet.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(
      within(rail).getByRole('button', { name: 'Label the template' }),
    )
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          atlasId: 'dkt',
          subjects: 'missing',
          jobs: 1,
        }),
      ),
    )
  })

  it('downloads Schaefer after its license and imports others with a confirmed license', async () => {
    const api = renderScreen()
    const openPage = vi.spyOn(api.atlasSources, 'openPage')
    const download = vi.spyOn(api.atlasSources, 'download')
    const files = vi.spyOn(api.groupAnalysis, 'chooseAtlasFiles')
    const rail = await ready()
    fireEvent.click(within(rail).getByRole('button', { name: 'Add atlas...' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add an atlas' })
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Download from GitHub (CBIG)',
      }),
    )
    const schaefer = ATLAS_SOURCES.find((s) => s.sourceId === 'schaefer2018')!
    const size = bytesText(schaefer.files.reduce((n, f) => n + f.bytes, 0))
    const go = within(dialog).getByRole('button', { name: `Download ${size}` })
    expect(go).toBeDisabled()
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'I have read the MIT license of Schaefer 2018 cortical parcellations.',
      }),
    )
    fireEvent.click(go)
    await waitFor(() =>
      expect(download).toHaveBeenCalledWith({
        sourceId: 'schaefer2018',
        licenseAcknowledged: true,
      }),
    )
    expect(
      await within(dialog).findByRole('button', {
        name: 'Cancel the download',
      }),
    ).toBeInTheDocument()
    expect(
      await within(dialog).findByText(
        new RegExp(`Downloaded 2026-09-30 \\(${size.replace('.', '\\.')}\\)`),
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument()

    fireEvent.click(
      within(dialog).getAllByRole('button', { name: 'Open NITRC' })[0]!,
    )
    expect(openPage).toHaveBeenCalledWith({
      sourceId: 'brainnetome',
      kind: 'page',
    })
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Open the MIT license of Schaefer 2018 cortical parcellations',
      }),
    )
    expect(openPage).toHaveBeenLastCalledWith({
      sourceId: 'schaefer2018',
      kind: 'license',
    })
    fireEvent.click(
      within(dialog).getAllByRole('button', {
        name: 'Import downloaded files...',
      })[0]!,
    )
    expect(
      within(dialog).getByRole('textbox', { name: 'Atlas name' }),
    ).toHaveValue('Brainnetome atlas')
    const choose = within(dialog).getByRole('button', {
      name: 'Choose files...',
    })
    expect(choose).toBeDisabled()
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: 'License link' }),
      {
        target: { value: 'http://example.org' },
      },
    )
    expect(
      within(dialog).getByText(
        'Give the license link as an https address, or leave it empty.',
      ),
    ).toBeInTheDocument()
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: 'License link' }),
      {
        target: { value: 'https://www.nitrc.org/projects/bn_atlas/' },
      },
    )
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'I confirm this license permits my use of the atlas.',
      }),
    )
    fireEvent.click(choose)
    await waitFor(() =>
      expect(files).toHaveBeenCalledWith({
        project: PROJECT,
        recipeId: 'user-gcs',
        label: 'Brainnetome atlas',
        license: {
          name: 'Brainnetome terms: non-commercial, attribution, share alike',
          url: 'https://www.nitrc.org/projects/bn_atlas/',
        },
        externalSourceId: 'brainnetome',
      }),
    )
    expect(
      await within(dialog).findByText(
        'Added Brainnetome atlas; it is listed under Added atlases.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    const source = within(rail).getByLabelText('Source')
    const added = within(source).getByRole('group', { name: 'Added atlases' })
    expect(
      within(added).getByRole('option', {
        name: 'Brainnetome atlas (0 of 82)',
      }),
    ).toBeInTheDocument()
    expect(
      added.querySelector('option[value="schaefer400-7"]'),
    ).toHaveTextContent('Schaefer 2018, 400 parcels, 7 networks (0 of 82)')
  })
})
