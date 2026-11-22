import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_CONFIG } from '../../../shared/project-schema'
import type { EnvCheck, EnvGroup, EnvReport } from '../../../shared/types'
import { envApplicability } from '../../state/env-applicability'
import { checkChipStatus, reportSummary } from './helpers'

function report(groups: EnvGroup[]): EnvReport {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    availableMemoryGB: 24,
    groups,
  }
}

function check(id: string, status: EnvCheck['status']): EnvCheck {
  return { id, label: id, status }
}

/** Summarize a report under the default configuration. */
function summarize(env: EnvReport | null): ReturnType<typeof reportSummary> {
  const applicability = envApplicability(
    env ?? report([]),
    DEFAULT_PROJECT_CONFIG,
  )
  return reportSummary(env, applicability)
}

describe('reportSummary', () => {
  it('states that an empty report holds no checks, in a neutral tone', () => {
    // A rollup over no checks must not claim every dependency satisfied.
    expect(summarize(report([]))).toEqual({
      status: 'skipped',
      label: 'No checks reported',
    })
    expect(
      summarize(
        report([
          { name: 'FreeSurfer', checks: [] },
          { name: 'R', checks: [] },
        ]),
      ),
    ).toEqual({ status: 'skipped', label: 'No checks reported' })
  })

  it('reports every required dependency satisfied when all are found', () => {
    expect(
      summarize(
        report([
          {
            name: 'FreeSurfer',
            checks: [
              check('fshome', 'found'),
              check('reconall', 'found'),
              check('license', 'found'),
            ],
          },
        ]),
      ),
    ).toEqual({ status: 'found', label: 'All required dependencies satisfied' })
  })

  it('reports missing dependencies when a required check is missing', () => {
    expect(
      summarize(
        report([
          {
            name: 'FreeSurfer',
            checks: [check('fshome', 'found'), check('reconall', 'missing')],
          },
        ]),
      ),
    ).toEqual({ status: 'missing', label: 'Missing dependencies' })
  })

  it('keeps asking for attention while no report is available', () => {
    expect(summarize(null)).toEqual({
      status: 'warn',
      label: 'Attention needed',
    })
  })
})

describe('checkChipStatus', () => {
  const missing: EnvCheck = {
    id: 'writexl',
    label: 'writexl',
    status: 'missing',
  }

  it('keeps a required missing check a failure', () => {
    expect(checkChipStatus(missing, 'required')).toBe('missing')
    expect(checkChipStatus(missing)).toBe('missing')
  })

  it('draws a missing check no stage requires in the neutral tone', () => {
    expect(checkChipStatus(missing, 'optional')).toBe('skipped')
    expect(checkChipStatus(missing, 'not-applicable')).toBe('skipped')
    expect(checkChipStatus({ ...missing, status: 'warn' }, 'optional')).toBe(
      'warn',
    )
  })
})
