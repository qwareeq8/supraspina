/**
 * The subject-matrix columns a screen shows.
 *
 * A column that only an optional stage advances, such as the BrainCharts
 * column, stays out of the Subjects and Dashboard matrices while its stage is
 * off and no subject holds a result in it, so a project that never uses the
 * stage sees the matrix it had before the column existed. Cells stay indexed
 * by {@link MATRIX_STEPS}, which each column carries as `index`.
 */

import type { ProjectConfig } from '../../shared/project-schema'
import {
  MATRIX_STEPS,
  type MatrixStep,
  type MatrixStepKey,
  type StepKey,
} from '../../shared/steps'
import type { Subject } from '../../shared/types'

/** One shown matrix column and its position in a subject's cells. */
export interface MatrixColumn {
  readonly step: MatrixStep
  readonly index: number
}

/** The optional columns and the stage, off by default, that owns each. */
const OPTIONAL_COLUMNS: Readonly<Partial<Record<MatrixStepKey, StepKey>>> = {
  norm: 'braincharts',
}

/**
 * List the matrix columns to show for a project and its subjects.
 *
 * @param subjects - The displayed subjects, after stage skipping.
 * @returns Every column except an optional column whose stage is off and whose
 *   cells are all pending or skipped.
 */
export function shownMatrixColumns(
  cfg: Pick<ProjectConfig, 'steps'>,
  subjects: readonly Subject[],
): MatrixColumn[] {
  return MATRIX_STEPS.flatMap((step, index) => {
    const owner = OPTIONAL_COLUMNS[step.key]
    if (owner === undefined || cfg.steps[owner]?.enabled === true) {
      return [{ step, index }]
    }
    const holdsResult = subjects.some((subject) => {
      const state = subject.cells[index]?.st
      return state !== undefined && state !== 'pending' && state !== 'skipped'
    })
    return holdsResult ? [{ step, index }] : []
  })
}
