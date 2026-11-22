import { describe, expect, it } from 'vitest'
import {
  hemisphereAdvisory,
  parseSurfaceRegistrationCancelResult,
  parseSurfaceRegistrationCheckResult,
  parseSurfaceRegistrationStatus,
  registrationProvisional,
  registrationQueueLine,
  registrationSummary,
  type RegistrationHemisphereResult,
  type SurfaceRegistrationStatus,
} from './surface-registration'
import { parseSidecarRpcResult } from './rpc-result-contracts'

function hemi(
  hemisphere: 'lh' | 'rh',
  patch: Partial<RegistrationHemisphereResult> = {},
): RegistrationHemisphereResult {
  return {
    hemisphere,
    state: 'checked',
    rCortex: 0.84,
    rDfp: 0.86,
    flagged: false,
    measure: 'dfp',
    z: 0.2,
    message: null,
    ...patch,
  }
}

function operation(patch: Record<string, unknown> = {}) {
  return {
    operationId: 'srg-0123456789abcdef',
    state: 'done',
    total: 4,
    completed: 4,
    failed: 0,
    startedAt: '2026-09-25T06:00:00.000Z',
    finishedAt: '2026-09-25T06:00:09.000Z',
    message: null,
    ...patch,
  }
}

function status(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configRevision: 4,
    method: 'sulc-fsaverage-pearson-v1',
    available: true,
    unavailableReason: null,
    rule: { zLimit: -3, floor: 0.7, minCohortHemispheres: 20 },
    reference: {
      source: 'cohort',
      hemispheres: 186,
      cortex: { median: 0.8342, scale: 0.0198 },
      dfp: { median: 0.8556, scale: 0.0235 },
    },
    operation: operation(),
    subjects: [
      {
        subjectId: 'sub-101',
        flagged: false,
        hemispheres: [hemi('lh'), hemi('rh')],
      },
      {
        subjectId: 'sub-149',
        flagged: true,
        hemispheres: [
          hemi('lh'),
          hemi('rh', {
            rCortex: 0.7269,
            rDfp: 0.6691,
            flagged: true,
            z: -7.93,
          }),
        ],
      },
    ],
    counts: {
      subjects: 2,
      checked: 4,
      pending: 0,
      failed: 0,
      missing: 0,
      flaggedSubjects: 1,
      flaggedHemispheres: 1,
    },
    ...patch,
  }
}

describe('surface registration contracts', () => {
  it('parses a status through the sidecar result dispatch', () => {
    const parsed = parseSidecarRpcResult(
      'surfaceRegistration.status',
      status(),
    ) as SurfaceRegistrationStatus

    expect(parsed.counts.flaggedSubjects).toBe(1)
    expect(parsed.subjects[1]?.hemispheres[1]).toMatchObject({
      hemisphere: 'rh',
      flagged: true,
      rDfp: 0.6691,
    })
    expect(parsed.reference.source).toBe('cohort')
  })

  it.each([
    ['an extra field', { extra: true }],
    [
      'a flag count that disagrees',
      { counts: { ...(status().counts as object), flaggedSubjects: 0 } },
    ],
    ['an unavailable status without a reason', { available: false }],
    ['a reason on an available status', { unavailableReason: 'x' }],
    [
      'a reference source it does not know',
      { reference: { ...(status().reference as object), source: 'other' } },
    ],
    ['progress past the total', { operation: operation({ completed: 5 }) }],
    [
      'an operation ID it does not issue',
      { operation: operation({ operationId: 'run-1' }) },
    ],
    [
      'a pending hemisphere with values',
      {
        subjects: [
          {
            subjectId: 'sub-101',
            flagged: false,
            hemispheres: [hemi('lh', { state: 'pending' }), hemi('rh')],
          },
        ],
        counts: {
          ...(status().counts as object),
          subjects: 1,
          flaggedSubjects: 0,
        },
      },
    ],
    [
      'hemispheres out of order',
      {
        subjects: [
          {
            subjectId: 'sub-101',
            flagged: false,
            hemispheres: [hemi('rh'), hemi('lh')],
          },
        ],
        counts: {
          ...(status().counts as object),
          subjects: 1,
          flaggedSubjects: 0,
        },
      },
    ],
    [
      'an unsafe subject ID',
      {
        subjects: [
          {
            subjectId: '../x',
            flagged: false,
            hemispheres: [hemi('lh'), hemi('rh')],
          },
        ],
        counts: {
          ...(status().counts as object),
          subjects: 1,
          flaggedSubjects: 0,
        },
      },
    ],
    [
      'a correlation above one',
      {
        subjects: [
          {
            subjectId: 'sub-101',
            flagged: false,
            hemispheres: [hemi('lh', { rDfp: 1.2 }), hemi('rh')],
          },
        ],
        counts: {
          ...(status().counts as object),
          subjects: 1,
          flaggedSubjects: 0,
        },
      },
    ],
  ])('rejects a status with %s', (_label, patch) => {
    expect(() => parseSurfaceRegistrationStatus(status(patch))).toThrow(
      TypeError,
    )
  })

  it('parses the check and cancel results', () => {
    expect(
      parseSurfaceRegistrationCheckResult({
        operation: operation({
          state: 'running',
          completed: 1,
          finishedAt: null,
        }),
        started: true,
      }),
    ).toMatchObject({ started: true, operation: { state: 'running' } })
    expect(
      parseSurfaceRegistrationCancelResult({
        operationId: 'srg-0123456789abcdef',
        stopped: true,
      }),
    ).toEqual({ operationId: 'srg-0123456789abcdef', stopped: true })
    expect(() =>
      parseSurfaceRegistrationCancelResult({ operationId: 'x', stopped: true }),
    ).toThrow(TypeError)
    expect(() =>
      parseSurfaceRegistrationCheckResult({
        operation: operation(),
        started: 1,
      }),
    ).toThrow(TypeError)
  })
})

describe('surface registration wording', () => {
  const reference = parseSurfaceRegistrationStatus(status()).reference

  it('states a flagged hemisphere and what to look at', () => {
    expect(
      hemisphereAdvisory(
        hemi('rh', { rDfp: 0.6691, flagged: true, z: -7.9 }),
        reference,
      ),
    ).toBe(
      'Right hemisphere: the surface registration fits the atlas poorly (dorsal frontoparietal sulcal correlation 0.67; cohort median 0.86). The parcel labels may be shifted; check the External cortical gallery.',
    )
    expect(
      hemisphereAdvisory(
        hemi('lh', {
          rCortex: 0.7347,
          measure: 'cortex',
          flagged: true,
          z: -5,
        }),
        { ...reference, source: 'builtin' },
      ),
    ).toBe(
      'Left hemisphere: the surface registration fits the atlas poorly (whole-cortex sulcal correlation 0.73; reference median 0.83). The parcel labels may be shifted; check the External cortical gallery.',
    )
  })

  it('marks flags provisional while a check runs or hemispheres are unchecked', () => {
    const parsed = parseSurfaceRegistrationStatus(status())
    const running = {
      ...parsed,
      operation: { ...parsed.operation!, state: 'running' as const },
    }
    const unchecked = {
      ...parsed,
      counts: { ...parsed.counts, pending: 2 },
    }

    expect(registrationProvisional(parsed)).toBe(false)
    expect(registrationProvisional(running)).toBe(true)
    expect(registrationProvisional(unchecked)).toBe(true)
    expect(
      hemisphereAdvisory(
        hemi('rh', { rDfp: 0.6691, flagged: true, z: -7.9 }),
        { ...reference, source: 'builtin' },
        true,
      ),
    ).toBe(
      'Right hemisphere: the surface registration fits the atlas poorly (dorsal frontoparietal sulcal correlation 0.67; reference median 0.86). The parcel labels may be shifted; check the External cortical gallery. Flags are provisional until every hemisphere is checked.',
    )
    expect(
      registrationSummary({
        ...running,
        operation: { ...running.operation, completed: 70, total: 186 },
        counts: { ...running.counts, checked: 70, pending: 116 },
      }),
    ).toBe(
      '70 of 186 hemispheres checked. 1 subject is flagged so far. Flags are provisional until every hemisphere is checked.',
    )
    expect(registrationSummary(unchecked)).toBe(
      '1 subject fits the atlas poorly. 2 hemispheres are not checked. Flags are provisional until every hemisphere is checked.',
    )
  })

  it('states the check in one queue-header line while it runs or flags exist', () => {
    const parsed = parseSurfaceRegistrationStatus(status())
    const running = {
      ...parsed,
      operation: {
        ...parsed.operation!,
        state: 'running' as const,
        completed: 70,
        total: 186,
      },
      counts: { ...parsed.counts, checked: 70, pending: 116 },
    }

    expect(registrationQueueLine(running, 0)).toBe(
      'Surface registration: 70 of 186 checked',
    )
    expect(registrationQueueLine(running, 3)).toBe(
      'Surface registration: 70 of 186 checked, 3 subjects flagged',
    )
    expect(registrationQueueLine(parsed, 14)).toBe(
      'Surface registration: 14 subjects flagged',
    )
    expect(
      registrationQueueLine(
        { ...parsed, counts: { ...parsed.counts, pending: 2 } },
        1,
      ),
    ).toBe('Surface registration: 1 subject flagged (provisional)')
    expect(registrationQueueLine(parsed, 0)).toBeNull()
  })

  it('states in the queue header why hemispheres are not checked', () => {
    const parsed = parseSurfaceRegistrationStatus(status())
    const unchecked = {
      ...parsed,
      operation: null,
      counts: {
        ...parsed.counts,
        checked: 0,
        pending: 8,
        flaggedSubjects: 0,
        flaggedHemispheres: 0,
      },
    }
    const unavailable = (reason: string) => ({
      ...unchecked,
      available: false,
      unavailableReason: reason,
    })

    expect(
      registrationQueueLine(
        unavailable(
          'The check needs the FreeSurfer license, and the license file was not found; choose it in Diagnostics.',
        ),
        0,
      ),
    ).toBe('Surface registration: not checked (FreeSurfer license not found)')
    expect(
      registrationQueueLine(
        unavailable(
          'The check needs the FreeSurfer license, and the license file is empty or not readable; choose a readable one in Diagnostics.',
        ),
        0,
      ),
    ).toBe(
      'Surface registration: not checked (FreeSurfer license not readable)',
    )
    expect(
      registrationQueueLine(
        unavailable(
          'The check needs FreeSurfer, and no FreeSurfer install root is set.',
        ),
        0,
      ),
    ).toBe(
      'Surface registration: not checked (FreeSurfer install root not set)',
    )
    expect(
      registrationQueueLine(
        unavailable(
          'The check needs mri_surf2surf, which FreeSurfer did not provide.',
        ),
        0,
      ),
    ).toBe('Surface registration: not checked (mri_surf2surf not found)')
    expect(
      registrationQueueLine(
        unavailable(
          'The check needs fsaverage, which the FreeSurfer install lacks.',
        ),
        0,
      ),
    ).toBe('Surface registration: not checked (fsaverage not found)')
    // A reason Supraspina does not know stays in the rail; the line says only
    // that the check cannot run.
    expect(registrationQueueLine(unavailable('Some other reason.'), 0)).toBe(
      'Surface registration: not checked (the check cannot run)',
    )

    const stopped = (message: string | null) => ({
      ...unchecked,
      operation: {
        ...parsed.operation!,
        state: 'failed' as const,
        completed: 0,
        message,
      },
    })
    expect(
      registrationQueueLine(
        stopped(
          'FreeSurfer did not accept its license file, so mri_surf2surf could not run; choose a valid license in Diagnostics.',
        ),
        0,
      ),
    ).toBe(
      'Surface registration: not checked (the last check stopped: FreeSurfer did not accept its license)',
    )
    expect(
      registrationQueueLine(
        stopped('mri_surf2surf could not load its shared libraries.'),
        0,
      ),
    ).toBe(
      'Surface registration: not checked (the last check stopped: mri_surf2surf could not load its libraries)',
    )
    expect(
      registrationQueueLine(
        stopped(
          'mri_surf2surf also failed to resample fsaverage onto itself, so the FreeSurfer setup is the likely cause, and the hemispheres it failed on stay unchecked. mri_surf2surf ended with exit code 1.',
        ),
        0,
      ),
    ).toBe(
      'Surface registration: not checked (the last check stopped: mri_surf2surf also failed on fsaverage)',
    )
    expect(
      registrationQueueLine(
        stopped('mri_surf2surf could not start (Permission denied).'),
        0,
      ),
    ).toBe(
      'Surface registration: not checked (the last check stopped: mri_surf2surf could not start)',
    )
    expect(
      registrationQueueLine(stopped('The check stopped with KeyError.'), 0),
    ).toBe('Surface registration: not checked (the last check stopped)')

    // Some hemispheres keep results: the line counts them and any flag.
    const partial = {
      ...unavailable(
        'The check needs the FreeSurfer license, and the license file was not found; choose it in Diagnostics.',
      ),
      counts: {
        ...parsed.counts,
        checked: 6,
        pending: 2,
        flaggedSubjects: 1,
        flaggedHemispheres: 1,
      },
    }
    expect(registrationQueueLine(partial, 1)).toBe(
      'Surface registration: 6 of 8 checked (FreeSurfer license not found), 1 subject flagged',
    )
    expect(registrationQueueLine(partial, 0)).toBe(
      'Surface registration: 6 of 8 checked (FreeSurfer license not found)',
    )
  })

  it('adds no line when nothing is flagged, running, or wrong', () => {
    const parsed = parseSurfaceRegistrationStatus(status())
    const counts = {
      ...parsed.counts,
      checked: 0,
      pending: 8,
      flaggedSubjects: 0,
      flaggedHemispheres: 0,
    }
    // Every hemisphere has a result, so a missing license changes nothing
    // the line would state.
    expect(
      registrationQueueLine(
        {
          ...parsed,
          available: false,
          unavailableReason:
            'The check needs the FreeSurfer license, and the license file was not found; choose it in Diagnostics.',
        },
        0,
      ),
    ).toBeNull()
    // Unchecked hemispheres before the automatic start, and after a stop the
    // operator chose, are not a problem to state.
    expect(
      registrationQueueLine({ ...parsed, operation: null, counts }, 0),
    ).toBeNull()
    expect(
      registrationQueueLine(
        {
          ...parsed,
          operation: { ...parsed.operation!, state: 'cancelled' },
          counts,
        },
        0,
      ),
    ).toBeNull()
  })

  it('counts a check that continues after a stop against every hemisphere', () => {
    const parsed = parseSurfaceRegistrationStatus(status())
    // Stopped at 60 of 186; the new operation covers only the 126 left.
    const restarted = {
      ...parsed,
      operation: {
        ...parsed.operation!,
        state: 'running' as const,
        completed: 4,
        total: 126,
      },
      counts: { ...parsed.counts, checked: 64, pending: 122 },
    }

    expect(registrationQueueLine(restarted, 1)).toBe(
      'Surface registration: 64 of 186 checked, 1 subject flagged',
    )
    expect(registrationSummary(restarted)).toBe(
      '64 of 186 hemispheres checked. 1 subject is flagged so far. Flags are provisional until every hemisphere is checked.',
    )
    // A hemisphere that could not be checked stays in the total.
    const failedOne = {
      ...restarted,
      counts: { ...restarted.counts, checked: 63, failed: 1 },
    }
    expect(registrationQueueLine(failedOne, 0)).toBe(
      'Surface registration: 63 of 186 checked',
    )
  })

  it('states a failed check and says nothing for a normal hemisphere', () => {
    expect(
      hemisphereAdvisory(
        hemi('lh', {
          state: 'failed',
          rCortex: null,
          rDfp: null,
          measure: null,
          z: null,
          message: 'mri_surf2surf ended with exit code 1.',
        }),
        reference,
      ),
    ).toBe(
      'Left hemisphere: the surface registration check could not run. mri_surf2surf ended with exit code 1.',
    )
    expect(hemisphereAdvisory(hemi('lh'), reference)).toBeNull()
    expect(
      hemisphereAdvisory(
        hemi('rh', {
          state: 'pending',
          rCortex: null,
          rDfp: null,
          measure: null,
          z: null,
        }),
        reference,
      ),
    ).toBeNull()
  })

  it('summarizes the cohort as facts', () => {
    const parsed = parseSurfaceRegistrationStatus(status())
    expect(registrationSummary(parsed)).toBe('1 subject fits the atlas poorly.')
    expect(
      registrationSummary({
        ...parsed,
        counts: { ...parsed.counts, flaggedSubjects: 2 },
      }),
    ).toBe('2 subjects fit the atlas poorly.')
    expect(
      registrationSummary({
        ...parsed,
        operation: {
          ...parsed.operation!,
          state: 'running',
          completed: 40,
          total: 186,
        },
        counts: {
          ...parsed.counts,
          checked: 40,
          pending: 146,
          flaggedSubjects: 0,
        },
      }),
    ).toBe('40 of 186 hemispheres checked.')
    expect(
      registrationSummary({
        ...parsed,
        subjects: [],
        counts: {
          ...parsed.counts,
          subjects: 0,
          checked: 0,
          flaggedSubjects: 0,
        },
      }),
    ).toBe('No subject has reconstructed surfaces yet.')
    expect(
      registrationSummary({
        ...parsed,
        available: false,
        unavailableReason:
          'The check needs FreeSurfer, and no FreeSurfer install root is set.',
        operation: null,
        counts: {
          ...parsed.counts,
          checked: 0,
          pending: 3,
          failed: 1,
          flaggedSubjects: 0,
        },
      }),
    ).toBe(
      '3 hemispheres are not checked. 1 hemisphere could not be checked. The check needs FreeSurfer, and no FreeSurfer install root is set.',
    )
    expect(
      registrationSummary({
        ...parsed,
        counts: { ...parsed.counts, flaggedSubjects: 0 },
      }),
    ).toBe('No checked hemisphere is flagged (4 hemispheres checked).')
  })
})
