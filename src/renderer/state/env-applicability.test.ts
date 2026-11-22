import { describe, expect, it } from 'vitest'
import {
  envApplicability,
  requiredCheckIds,
  requirementFor,
} from './env-applicability'
import {
  computeStageBlockers,
  requiredEnvCheckIdsForStep,
} from './stage-blockers'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { ProjectConfig } from '../../shared/project-schema'
import { STEP_CHECK_REQUIREMENTS, STEP_KEYS } from '../../shared/steps'
import type { StepKey } from '../../shared/steps'
import type { EnvCheck, EnvReport } from '../../shared/types'
import {
  buildInstallPlan,
  groupCountLabel,
  groupCountSummary,
  needsAttention,
  rollupGroup,
  rollupReport,
  seedExpansion,
  tallyEnv,
} from '../screens/env/helpers'

function config(
  mutate: (cfg: ProjectConfig) => void = () => {},
): ProjectConfig {
  const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
  mutate(cfg)
  return cfg
}

function report(checks: EnvCheck[], name = 'Tools'): EnvReport {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    availableMemoryGB: 24,
    groups: [{ name, checks }],
  }
}

function check(id: string, status: EnvCheck['status'] = 'missing'): EnvCheck {
  return { id, label: id, status }
}

/** Disable every stage except the named ones. */
function onlyStages(keys: readonly StepKey[]): ProjectConfig {
  return config((cfg) => {
    for (const key of STEP_KEYS) {
      cfg.steps[key].enabled = keys.includes(key)
    }
  })
}

describe('envApplicability', () => {
  it('marks a check the configured stage gate names as required', () => {
    const env = report([check('reconall'), check('license')])
    const applicability = envApplicability(env, config())
    expect(requirementFor(applicability, 'reconall').state).toBe('required')
    expect(requirementFor(applicability, 'reconall').owningSteps).toContain(
      'recon',
    )
  })

  it('marks a check no stage requirement names as optional', () => {
    const env = report([check('os'), check('rpkgs')])
    const applicability = envApplicability(env, config())
    expect(requirementFor(applicability, 'os').state).toBe('optional')
    expect(requirementFor(applicability, 'os').owningSteps).toEqual([])
    // The R package stack is advisory: no stage gate names it.
    expect(requirementFor(applicability, 'rpkgs').state).toBe('optional')
  })

  it('marks a disabled stage owner as not applicable', () => {
    const env = report([check('pandoc'), check('finalrscript')])
    const applicability = envApplicability(env, onlyStages(['recon']))
    expect(requirementFor(applicability, 'pandoc').state).toBe('not-applicable')
    expect(requirementFor(applicability, 'finalrscript').state).toBe(
      'not-applicable',
    )
    expect(requirementFor(applicability, 'pandoc').owningSteps).toContain(
      'final',
    )
  })

  it('follows the configured reconstruction backend', () => {
    const env = report([check('reconall'), check('license')])
    const fastsurfer = envApplicability(
      env,
      config((cfg) => {
        cfg.steps.recon.params['backend'] = 'fastsurfer'
      }),
    )
    expect(requirementFor(fastsurfer, 'reconall').state).toBe('not-applicable')
    expect(requirementFor(fastsurfer, 'license').state).toBe('required')

    const freesurfer = envApplicability(env, config())
    expect(requirementFor(freesurfer, 'reconall').state).toBe('required')
  })

  it('follows the configured defacing tool', () => {
    const env = report([check('pydeface'), check('mri_deface')])
    const selected = envApplicability(
      env,
      config((cfg) => {
        cfg.steps.deface.enabled = true
        cfg.steps.deface.params['tool'] = 'pydeface'
      }),
    )
    expect(requirementFor(selected, 'pydeface').state).toBe('required')

    for (const tool of ['mri_deface', 'skip']) {
      const other = envApplicability(
        env,
        config((cfg) => {
          cfg.steps.deface.enabled = true
          cfg.steps.deface.params['tool'] = tool
        }),
      )
      expect(requirementFor(other, 'pydeface').state).toBe('not-applicable')
    }
  })

  it('follows the report-rendering condition of the Final stage', () => {
    const env = report([check('pandoc'), check('rmarkdown')])
    const rendering = envApplicability(env, config())
    expect(requirementFor(rendering, 'pandoc').state).toBe('required')

    const plain = envApplicability(
      env,
      config((cfg) => {
        cfg.steps.final.params['renderReport'] = false
      }),
    )
    expect(requirementFor(plain, 'pandoc').state).toBe('not-applicable')
    expect(requirementFor(plain, 'rmarkdown').state).toBe('not-applicable')
  })

  it('treats an absent report-rendering parameter as the schema default', () => {
    // The step schema declares renderReport with default true, so a saved
    // project that omits the parameter still needs the report tooling.
    const env = report([check('pandoc'), check('rmarkdown')])
    const absent = envApplicability(
      env,
      config((cfg) => {
        cfg.steps.final.params = {}
      }),
    )
    expect(requirementFor(absent, 'pandoc').state).toBe('required')
    expect(requirementFor(absent, 'rmarkdown').state).toBe('required')
  })

  it('follows the display condition of the ENIGMA QC stage', () => {
    const withDisplay = report([
      { id: 'display', label: 'X display', status: 'found' },
      check('xvfb-run'),
    ])
    expect(
      requirementFor(envApplicability(withDisplay, config()), 'xvfb-run').state,
    ).toBe('not-applicable')

    const headless = report([
      { id: 'display', label: 'X display', status: 'missing' },
      check('xvfb-run'),
    ])
    expect(
      requirementFor(envApplicability(headless, config()), 'xvfb-run').state,
    ).toBe('required')
  })

  it('lets one requiring stage outrank every stage that excludes a check', () => {
    // Reconstruction is disabled, so only feature extraction still needs the
    // FreeSurfer license.
    const env = report([check('license')])
    const cfg = config((cfg) => {
      cfg.steps.recon.enabled = false
    })
    const entry = requirementFor(envApplicability(env, cfg), 'license')
    expect(entry.state).toBe('required')
    expect(entry.owningSteps).toEqual(['features'])
  })

  it('never disagrees with the run gate about the required checks', () => {
    const configurations = [
      config(),
      onlyStages(['recon']),
      config((cfg) => {
        cfg.steps.recon.params['backend'] = 'fastsurfer'
      }),
      config((cfg) => {
        cfg.steps.final.params['renderReport'] = false
        cfg.steps.enigma.params['backend'] = 'mcr'
        cfg.steps.deface.enabled = true
        cfg.steps.deface.params['tool'] = 'fsl_deface'
      }),
    ]
    const env = report([
      { id: 'display', label: 'X display', status: 'missing' },
      check('reconall'),
    ])
    for (const cfg of configurations) {
      const gate = new Set(
        STEP_KEYS.flatMap((key) =>
          key in STEP_CHECK_REQUIREMENTS
            ? requiredEnvCheckIdsForStep(key, env, cfg)
            : [],
        ),
      )
      expect([...requiredCheckIds(envApplicability(env, cfg))].sort()).toEqual(
        [...gate].sort(),
      )
    }
  })

  it('reports no environment blocker for a check it treats as not required', () => {
    // Only the FreeSurfer reconstruction stage stays enabled, so every other
    // missing tool must leave the run gate alone.
    const cfg = onlyStages(['recon'])
    const env = report([
      check('reconall', 'found'),
      check('fshome', 'found'),
      check('license', 'found'),
      check('pandoc'),
      check('rpkgs'),
      check('pyenv'),
      check('matlab'),
    ])
    const applicability = envApplicability(env, cfg)
    expect(computeStageBlockers(env, cfg)).toEqual([])
    for (const id of ['pandoc', 'rpkgs', 'pyenv', 'matlab']) {
      expect(requirementFor(applicability, id).state).not.toBe('required')
    }
  })
})

describe('pipeline-aware environment helpers', () => {
  const RECON_ONLY = onlyStages(['recon'])
  const RECON_ONLY_REPORT = report([
    check('reconall', 'found'),
    check('fshome', 'found'),
    check('license', 'found'),
    { ...check('pandoc'), recommendedCmd: 'apt-get install pandoc' },
    { ...check('rpkgs'), recommendedCmd: 'Rscript -e "install.packages()"' },
    check('pyenv'),
  ])

  it('raises attention only for a required failure', () => {
    const applicability = envApplicability(RECON_ONLY_REPORT, RECON_ONLY)
    expect(needsAttention(check('pandoc'), applicability)).toBe(false)
    expect(needsAttention(check('rpkgs'), applicability)).toBe(false)
    expect(needsAttention(check('reconall'), applicability)).toBe(true)
  })

  it('keeps rollups, counts, and disclosure on the required checks', () => {
    const applicability = envApplicability(RECON_ONLY_REPORT, RECON_ONLY)
    const group = RECON_ONLY_REPORT.groups[0]!
    expect(rollupGroup(group, applicability)).toBe('found')
    expect(rollupReport(RECON_ONLY_REPORT, applicability)).toBe('found')
    expect(groupCountSummary(group, applicability)).toBe('6 checks, 3 required')
    expect(groupCountLabel(group, applicability)).toBe(
      '6 checks, 3 required, all found',
    )
    expect(seedExpansion(RECON_ONLY_REPORT.groups, applicability)).toEqual({
      Tools: false,
    })
  })

  it('names the whole group when it requires nothing', () => {
    const env = report([check('os', 'found'), check('rpkgs')])
    const applicability = envApplicability(env, config())
    expect(groupCountLabel(env.groups[0]!, applicability)).toBe(
      '2 checks, none required',
    )
  })

  it('builds an install plan from the required remediations only', () => {
    const applicability = envApplicability(RECON_ONLY_REPORT, RECON_ONLY)
    // Nothing this configuration requires is failing, so the plan carries no
    // script at all rather than a runnable preamble with no commands.
    expect(buildInstallPlan(RECON_ONLY_REPORT, applicability)).toBe('')

    const full = envApplicability(RECON_ONLY_REPORT, config())
    const plan = buildInstallPlan(RECON_ONLY_REPORT, full)
    expect(plan.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(plan).toContain('apt-get install pandoc')
  })

  it('agrees between the Setup tally and the Diagnostics rollup', () => {
    const applicability = envApplicability(RECON_ONLY_REPORT, RECON_ONLY)
    const tally = tallyEnv(RECON_ONLY_REPORT, applicability)
    expect(tally).toEqual({ found: 3, warn: 0, missing: 0, criticals: [] })
    expect(rollupReport(RECON_ONLY_REPORT, applicability)).toBe('found')

    const full = envApplicability(RECON_ONLY_REPORT, config())
    const fullTally = tallyEnv(RECON_ONLY_REPORT, full)
    expect(fullTally.missing).toBeGreaterThan(0)
    expect(rollupReport(RECON_ONLY_REPORT, full)).toBe('missing')
  })

  it('leaves a skipped required check out of the attention count', () => {
    // A skipped verdict is neutral: the row states it, and the counts ignore it.
    const env = report([check('pandoc', 'skipped')])
    const applicability = envApplicability(env, config())
    expect(requirementFor(applicability, 'pandoc').state).toBe('required')
    expect(needsAttention(env.groups[0]!.checks[0]!, applicability)).toBe(false)
    expect(tallyEnv(env, applicability)).toEqual({
      found: 0,
      warn: 0,
      missing: 0,
      criticals: [],
    })
  })
})
