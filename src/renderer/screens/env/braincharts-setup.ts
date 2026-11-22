/** The BrainCharts setup facts and readiness shared by its Diagnostics card. */

import type { EnvCheck } from '../../../shared/types'

/** The checks that report the BrainCharts runtime and model. */
export const BRAINCHARTS_CHECK_IDS = ['bcenv', 'bcmodel'] as const

/** The braincharts repository NOTICE at the pinned commit, verbatim. */
export const BRAINCHARTS_NOTICE = [
  'braincharts',
  'Copyright 2021 The braincharts Developers.',
  '',
  'This product includes software developed by',
  'Saige Rutherford and Andre Marquand.',
  '',
  'This software redistributes pretrained normative models',
  'and code for applying them to new data, which is Public',
  'domain source code.',
].join('\n')

/** The publication the model's users cite. */
export const BRAINCHARTS_CITATION =
  'Rutherford S, Fraza C, Dinga R, et al. Charting brain growth and aging at high spatial precision. eLife. 2022;11:e72904. doi:10.7554/eLife.72904'

/** The readiness the card shows, derived from the two checks. */
export interface BrainChartsReadiness {
  chip: 'done' | 'pending' | 'warn' | 'failed'
  label: string
  detail: string | null
  unavailable: boolean
}

/**
 * Derive the card's readiness from the `bcenv` and `bcmodel` checks.
 *
 * @param checks - The two checks, or null before the first check.
 * @returns The chip state, its label, and the first problem stated.
 */
export function brainChartsReadiness(
  checks: readonly EnvCheck[] | null,
): BrainChartsReadiness {
  if (checks === null) {
    return {
      chip: 'pending',
      label: 'Not checked',
      detail: null,
      unavailable: false,
    }
  }
  const relevant = checks.filter((check) =>
    (BRAINCHARTS_CHECK_IDS as readonly string[]).includes(check.id),
  )
  const skipped = relevant.find((check) => check.status === 'skipped')
  if (skipped) {
    return {
      chip: 'warn',
      label: 'Unavailable',
      detail: skipped.detail ?? null,
      unavailable: true,
    }
  }
  if (
    relevant.length === BRAINCHARTS_CHECK_IDS.length &&
    relevant.every((check) => check.status === 'found')
  ) {
    return { chip: 'done', label: 'Ready', detail: null, unavailable: false }
  }
  const wrong = relevant.find(
    (check) => check.status === 'wrong' || check.status === 'warn',
  )
  if (wrong) {
    return {
      chip: 'failed',
      label: 'Check failed',
      detail: wrong.detail ?? null,
      unavailable: false,
    }
  }
  return {
    chip: 'pending',
    label: 'Not set up',
    detail: null,
    unavailable: false,
  }
}
