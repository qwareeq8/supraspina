// @vitest-environment jsdom
/** Tests for the v2 results view: terms, columns, grid, matrix, and export. */

import axe from 'axe-core'
import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type {
  GroupAnalysisResultV2,
  GroupAnalysisTermRows,
} from '../../../../shared/group-analysis'
import type { ProjectRef } from '../../../../shared/types'
import { createMockApi } from '../../../ipc/mock'
import {
  MOCK_BATTERY_RESULT,
  MOCK_OMNIBUS_RESULT,
  MOCK_STRATIFIED_RESULT,
  mockTermRows,
} from '../../../ipc/mock-analysis-v2'
import { AppProvider } from '../../../state/context'
import type { ResultTab } from '../ResultTabs'
import type { AnalysisSelection } from '../selection'
import { ResultViewV2 } from './ResultViewV2'

// The brain view needs WebGL2; record what the v2 view hands it instead.
const brainProps = vi.hoisted(
  () => [] as { result: unknown; term: unknown; rows: unknown }[],
)
vi.mock('../BrainView', () => ({
  BrainView: (props: { result: unknown; term: unknown; rows: unknown }) => {
    brainProps.push(props)
    return <p>Brain view</p>
  },
}))

const PROJECT: ProjectRef = {
  projectId: 'analysis-project',
  root: '/projects/analysis',
  configPath: '/projects/analysis/supraspina.project.json',
  epoch: 1,
}

function Harness({
  result,
  initialTab = 'table',
  measureId = 'aseg:Brain-Stem',
  exporting = false,
}: {
  result: GroupAnalysisResultV2
  initialTab?: ResultTab
  measureId?: string | null
  exporting?: boolean
}): ReactNode {
  const [tab, setTab] = useState<ResultTab>(initialTab)
  const [selection, setSelection] = useState<AnalysisSelection>({
    measureId,
    subjectId: null,
  })
  const [open, setOpen] = useState(exporting)
  return (
    <>
      <output data-testid="selection">{selection.measureId ?? ''}</output>
      <ResultViewV2
        project={PROJECT}
        result={result}
        tab={tab}
        onTab={setTab}
        selection={selection}
        onSelection={setSelection}
        exporting={open}
        onExportClose={() => setOpen(false)}
      />
    </>
  )
}

function renderView(
  result: GroupAnalysisResultV2,
  props: Partial<Parameters<typeof Harness>[0]> = {},
  api = createMockApi(),
) {
  window.supraspina = api
  const view = render(
    <AppProvider>
      <Harness result={result} {...props} />
    </AppProvider>,
  )
  return { api, ...view }
}

function columnNames(): string[] {
  return screen
    .getAllByRole('columnheader')
    .map(
      (cell) => cell.textContent?.replace(/[\u2191\u2193]/g, '').trim() ?? '',
    )
}

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const report = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
  })
  return report.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ResultViewV2', () => {
  it('groups the terms by test and follows the chosen term', async () => {
    renderView(MOCK_OMNIBUS_RESULT)
    const select = screen.getByLabelText('Term')
    const group = within(select).getByRole('group', {
      name: 'SCI_P, SCI_nNP, and CTRL',
    })
    expect(
      within(group)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Omnibus',
      'SCI_P vs CTRL',
      'SCI_nNP vs CTRL',
      'SCI_nNP vs SCI_P',
    ])
    expect(
      screen.getByText('Omnibus F test, 2 df FWE, within each test 3 measures'),
    ).toBeInTheDocument()
    // The F term shows F with both df and partial eta squared.
    expect(columnNames()).toEqual([
      'Measure',
      'Hemi',
      'n',
      'F (df)',
      'Partial \u03b7\u00b2',
      'p',
      'FWE p',
      'Sig.',
    ])
    fireEvent.change(select, { target: { value: 'term-2' } })
    // A pair shows the two groups, d, t, and the gate.
    await waitFor(() =>
      expect(columnNames()).toEqual([
        'Measure',
        'Hemi',
        'n',
        'Diff %',
        'd [95% CI]',
        't (df)',
        'p',
        'FWE p',
        'Omnibus',
        'Sig.',
      ]),
    )
    expect(screen.getAllByText('22/48').length).toBeGreaterThan(0)
  })

  it('shows the slope, slope per SD, and partial r of an association', async () => {
    renderView(MOCK_BATTERY_RESULT)
    fireEvent.change(screen.getByLabelText('Term'), {
      target: { value: 'term-2' },
    })
    await waitFor(() =>
      expect(columnNames()).toEqual([
        'Measure',
        'Hemi',
        'n',
        'Slope',
        'Per SD',
        'Partial r [95% CI]',
        't (df)',
        'p',
        'FDR p',
        'Sig.',
      ]),
    )
  })

  it('states a sensitivity test outside the family and drops its corrected p', () => {
    renderView(MOCK_BATTERY_RESULT)
    expect(
      screen.getByText('Sensitivity, outside the family.'),
    ).toBeInTheDocument()
    expect(columnNames()).not.toContain('FDR p')
  })

  it('pages a term the header carries only in part', async () => {
    const result: GroupAnalysisResultV2 = {
      ...MOCK_OMNIBUS_RESULT,
      rows: MOCK_OMNIBUS_RESULT.rows.slice(0, 1),
    }
    const api = createMockApi()
    const pages: GroupAnalysisTermRows[] = []
    api.groupAnalysis.termRows = vi.fn(async ({ resultId, termId, offset }) => {
      const page = mockTermRows(resultId, termId, offset)
      pages.push(page)
      return page
    })
    renderView(result, {}, api)
    expect(screen.getAllByRole('row')).toHaveLength(2)
    expect(
      screen.getByText(
        '1 of 1 significant after FWE correction; 1 of 3 rows read',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Read 2 more rows' }))
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4))
    expect(pages.map((page) => [page.termId, page.offset])).toEqual([
      ['term-1', 1],
    ])
    expect(screen.queryByRole('button', { name: /more rows/ })).toBeNull()
  })

  it('lays out the grid with bold survivors and selects from a cell', async () => {
    const { container } = renderView(MOCK_BATTERY_RESULT, {
      initialTab: 'grid',
    })
    const table = await screen.findByRole('table', {
      name: 'Grid of Within SCI, clinical battery',
    })
    // Four measures are columns, after the Term heading.
    expect(within(table).getAllByRole('columnheader')).toHaveLength(5)
    expect(within(table).getAllByRole('rowheader')).toHaveLength(5)
    await waitFor(() =>
      expect(within(table).getAllByText(/^\u2212?\+?\d\.\d\d \(/).length).toBe(
        20,
      ),
    )
    // The line above the grid states the count alone, not the figure summary.
    expect(
      screen.getByText(/^\d+ of 20 cells significant after correction\.$/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^Grid of \d+ terms by/)).toBeNull()
    const bold = [...table.querySelectorAll('td')].filter(
      (cell) => cell.style.fontWeight === '700',
    )
    expect(bold.length).toBeGreaterThan(0)
    expect(
      screen.getByText('Bold: significant after correction.'),
    ).toBeInTheDocument()
    fireEvent.click(within(table).getByRole('button', { name: /Thalamus/ }))
    expect(screen.getByTestId('selection').textContent).toBe('aseg:bi:Thalamus')
    fireEvent.doubleClick(bold[0]!)
    expect(
      screen.getByRole('tab', { name: 'Measure', selected: true }),
    ).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
  })

  it('offers the pairs of an omnibus test in the grid', async () => {
    renderView(MOCK_OMNIBUS_RESULT, { initialTab: 'grid' })
    const choice = screen.getByRole('radio', { name: 'Pairs' })
    fireEvent.click(choice)
    const table = await screen.findByRole('table', { name: /^Grid of / })
    await waitFor(() =>
      expect(within(table).getAllByRole('rowheader')).toHaveLength(3),
    )
    expect(within(table).getByText('SCI_nNP vs SCI_P')).toBeInTheDocument()
  })

  it('draws the term forest, the battery, and the strata', async () => {
    renderView(MOCK_BATTERY_RESULT, { initialTab: 'forest' })
    expect(
      await screen.findByRole('img', {
        name: 'Forest plot: Within SCI, clinical battery, Time since injury',
      }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'All tests' }))
    expect(
      await screen.findByRole('img', {
        name: 'Forest plot: Within SCI, clinical battery, all tests',
      }),
    ).toBeInTheDocument()
    renderView(MOCK_STRATIFIED_RESULT, { initialTab: 'forest' })
    const strata = screen.getAllByRole('radio', { name: 'Strata' })
    fireEvent.click(strata.at(-1)!)
    await waitFor(() =>
      expect(
        document.body.textContent?.includes('Brainstem, heterogeneity p'),
      ).toBe(true),
    )
  })

  it('draws the measure figure with the pairwise matrix', async () => {
    const api = createMockApi()
    const detail = vi.spyOn(api.groupAnalysis, 'measureDetail')
    renderView(MOCK_OMNIBUS_RESULT, { initialTab: 'measure' }, api)
    expect(
      await screen.findByRole('img', { name: /^Adjusted values: Brainstem/ }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('img', { name: /^Pairwise matrix: Brainstem/ }),
    ).toBeInTheDocument()
    expect(detail).toHaveBeenCalledWith(
      expect.objectContaining({
        termId: 'term-1',
        measureId: 'aseg:Brain-Stem',
      }),
    )
  })

  it('draws one figure per stratum as small multiples', async () => {
    const api = createMockApi()
    const detail = vi.spyOn(api.groupAnalysis, 'measureDetail')
    renderView(MOCK_STRATIFIED_RESULT, { initialTab: 'measure' }, api)
    await screen.findByRole('img', { name: /^Adjusted values: Brainstem/ })
    fireEvent.click(screen.getByRole('radio', { name: 'Each stratum' }))
    await waitFor(() =>
      expect(
        screen.getAllByRole('img', { name: /^Adjusted values: Brainstem/ }),
      ).toHaveLength(3),
    )
    const terms = detail.mock.calls.map(
      ([request]) => (request as { termId: string }).termId,
    )
    expect(new Set(terms)).toEqual(new Set(['term-1', 'term-2', 'term-3']))
  })

  it('says an F term has no brain map', () => {
    renderView(MOCK_OMNIBUS_RESULT, { initialTab: 'brain' })
    expect(
      screen.getByText(
        'The brain map draws signed effects; an F test has none.',
      ),
    ).toBeInTheDocument()
  })

  it('hands the brain view the v2 result and its drawn t term', async () => {
    brainProps.length = 0
    renderView(MOCK_OMNIBUS_RESULT, { initialTab: 'brain' })
    fireEvent.change(screen.getByLabelText('Term'), {
      target: { value: 'term-2' },
    })
    expect(await screen.findByText('Brain view')).toBeInTheDocument()
    // The term's rows arrive by page; the last hand-off carries them.
    await waitFor(() =>
      expect(brainProps.at(-1)!.rows).toEqual(
        mockTermRows(MOCK_OMNIBUS_RESULT.resultId, 'term-2', 0).rows,
      ),
    )
    const props = brainProps.at(-1)!
    expect(props.result).toBe(MOCK_OMNIBUS_RESULT)
    expect(props.term).toMatchObject({ termId: 'term-2', kind: 't' })
  })

  it('exports the forest, matrix, and measure figure of the shown term', async () => {
    const api = createMockApi()
    const write = vi.spyOn(api.groupAnalysis, 'writeExport')
    renderView(
      MOCK_OMNIBUS_RESULT,
      { initialTab: 'measure', exporting: true },
      api,
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Export the analysis',
    })
    expect(
      within(dialog).getByText(/one row per term and measure/),
    ).toBeInTheDocument()
    const button = within(dialog).getByRole('button', {
      name: 'Choose folder and export',
    })
    await waitFor(() => expect(button).toBeEnabled())
    await act(async () => {
      fireEvent.click(button)
    })
    await waitFor(() => expect(write).toHaveBeenCalled())
    const request = write.mock.calls[0]![0]
    expect(request.resultId).toBe(MOCK_OMNIBUS_RESULT.resultId)
    expect(request.figures.map((figure) => figure.stem)).toEqual([
      'forest',
      'pairs-aseg-brain-stem',
      'measure-aseg-brain-stem-term-1',
    ])
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      /files written/,
    )
  })
})
