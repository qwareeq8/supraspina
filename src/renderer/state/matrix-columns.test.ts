import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROJECT_CONFIG,
  type ProjectConfig,
} from '../../shared/project-schema'
import { MATRIX_STEPS } from '../../shared/steps'
import {
  emptyCell,
  type Cell,
  type CellState,
  type Subject,
} from '../../shared/types'
import { shownMatrixColumns } from './matrix-columns'

const NORM = MATRIX_STEPS.findIndex((step) => step.key === 'norm')

function subject(norm: CellState): Subject {
  const cells = MATRIX_STEPS.map((): Cell => ({ ...emptyCell(), st: 'done' }))
  cells[NORM] = { ...emptyCell(), st: norm }
  return {
    id: 'sub-001',
    age: 40,
    sex: 'F',
    cohort: 'CTRL',
    ais: null,
    tSinceSci: null,
    cells,
    qc: null,
    notes: '',
    registered: true,
    analysisEligible: true,
  }
}

function braincharts(enabled: boolean): ProjectConfig {
  const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
  cfg.steps.braincharts = { ...cfg.steps.braincharts, enabled }
  return cfg
}

const keys = (cfg: ProjectConfig, subjects: Subject[]): string[] =>
  shownMatrixColumns(cfg, subjects).map((column) => column.step.key)

describe('shownMatrixColumns', () => {
  it('leaves out the BrainCharts column while the stage is off and unused', () => {
    expect(DEFAULT_PROJECT_CONFIG.steps.braincharts?.enabled).toBe(false)
    for (const state of ['pending', 'skipped'] as const) {
      expect(keys(braincharts(false), [subject(state)])).toEqual(
        MATRIX_STEPS.filter((step) => step.key !== 'norm').map(
          (step) => step.key,
        ),
      )
    }
    expect(keys(braincharts(false), [])).not.toContain('norm')
  })

  it('shows the column while the stage is on or a subject holds a result', () => {
    expect(keys(braincharts(true), [subject('pending')])).toContain('norm')
    expect(keys(braincharts(false), [subject('done')])).toContain('norm')
    expect(keys(braincharts(false), [subject('outdated')])).toContain('norm')
  })

  it('keeps each column at its cell index', () => {
    const columns = shownMatrixColumns(braincharts(false), [subject('pending')])
    for (const column of columns) {
      expect(MATRIX_STEPS[column.index]).toBe(column.step)
    }
    expect(columns.find((column) => column.step.key === 'stats')?.index).toBe(
      NORM + 1,
    )
  })
})
