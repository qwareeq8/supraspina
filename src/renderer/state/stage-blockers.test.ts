import { describe, expect, it } from 'vitest'
import type { EnvCheck, EnvReport } from '../../shared/types'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import {
  computeStageBlockers,
  effectiveEnigmaBackend,
  isScientificAssetCheck,
  missingAssetCheckIds,
  requiredEnvCheckIds,
  requiredEnvCheckIdsForStep,
  unavailableEnigmaBackends,
} from './stage-blockers'

const ALL_IDS = [
  'reconall',
  'fshome',
  'bash',
  'awk',
  'grep',
  'cat',
  'mkdir',
  'display',
  'xvfb-run',
  'license',
  'featurepython',
  'aparcstats',
  'asegstats',
  'enigma_assets',
  'features_assets',
  'outliers_assets',
  'pybrainage_assets',
  'brainpad_assets',
  'aggregate_assets',
  'final_assets',
  'final_report_assets',
  'mri_deface',
  'mri_deface_templates',
  'fsl_deface',
  'pydeface',
  'rscript',
  'finalrscript',
  'rmarkdown',
  'knitr',
  'pandoc',
  'bcenv',
  'bcmodel',
  'agepython',
  'clinicalpython',
  'brainpadpython',
  'aggregatepython',
  'pyenv',
  'pybrainpython',
  'modelfile',
  'scalerfile',
  'matlab',
  'mcr',
] as const

/**
 * Build an env report where every gated check is `found` by default, then apply
 * status overrides and optionally omit ids entirely (to model an absent check).
 */
function report(
  overrides: Record<string, EnvCheck['status']> = {},
  omit: readonly string[] = [],
): EnvReport {
  const dropped = new Set(omit)
  const checks: EnvCheck[] = ALL_IDS.filter((id) => !dropped.has(id)).map(
    (id) => ({ id, label: id, status: overrides[id] ?? 'found' }),
  )
  return {
    capturedAt: 't',
    availableMemoryGB: 24,
    groups: [{ name: 'Tools', checks }],
  }
}

const blockedKeys = (env: EnvReport, cfg = DEFAULT_PROJECT_CONFIG): string[] =>
  computeStageBlockers(env, cfg)
    .map((b) => b.key)
    .sort()

const enigmaReason = (env: EnvReport): string | undefined =>
  computeStageBlockers(env, DEFAULT_PROJECT_CONFIG).find(
    (blocker) => blocker.key === 'enigma',
  )?.reason

/** The display labels the sidecar reports for the asset checks under test. */
const ASSET_LABELS: Record<string, string> = {
  enigma_assets: 'ENIGMA QC assets',
  outliers_assets: 'Outlier review assets',
  final_assets: 'R analysis assets',
  final_report_assets: 'R report assets',
}

/** Give the asset checks their sidecar display labels. */
function labelled(env: EnvReport): EnvReport {
  return {
    ...env,
    groups: env.groups.map((group) => ({
      ...group,
      checks: group.checks.map((check) => ({
        ...check,
        label: ASSET_LABELS[check.id] ?? check.label,
      })),
    })),
  }
}

/** Add the scientific-asset acquisition check the sidecar reports. */
function withAcquisition(
  env: EnvReport,
  status: EnvCheck['status'],
  offlineInstall: boolean,
): EnvReport {
  const acquisition: EnvCheck = {
    id: 'scientific_assets',
    label: 'Reviewed scientific assets',
    status,
    ...(offlineInstall ? { offlineInstall: true } : {}),
  }
  return {
    ...env,
    groups: env.groups.map((group, index) =>
      index === 0
        ? { ...group, checks: [...group.checks, acquisition] }
        : group,
    ),
  }
}

describe('computeStageBlockers', () => {
  it('returns no blockers before the environment report is fetched', () => {
    expect(computeStageBlockers(null)).toEqual([])
  })

  it('returns no blockers when every required check is found', () => {
    expect(computeStageBlockers(report())).toEqual([])
  })

  it('requires the BrainCharts setup only while BrainCharts is on', () => {
    const missing = report({ bcenv: 'missing', bcmodel: 'missing' })
    expect(DEFAULT_PROJECT_CONFIG.steps.braincharts.enabled).toBe(false)
    expect(blockedKeys(missing)).toEqual([])
    const enabled = {
      ...DEFAULT_PROJECT_CONFIG,
      steps: {
        ...DEFAULT_PROJECT_CONFIG.steps,
        braincharts: { enabled: true, params: { seed: 117 } },
      },
    }
    expect(computeStageBlockers(missing, enabled)).toEqual([
      expect.objectContaining({ key: 'braincharts', kind: 'environment' }),
    ])
  })

  it('requires the report tools for the z-score report only while it renders', () => {
    const missing = report({ pandoc: 'missing' })
    expect(DEFAULT_PROJECT_CONFIG.steps.zstats.enabled).toBe(false)
    const zstats = (renderReport: boolean) => ({
      ...DEFAULT_PROJECT_CONFIG,
      steps: {
        ...DEFAULT_PROJECT_CONFIG.steps,
        final: {
          ...DEFAULT_PROJECT_CONFIG.steps.final,
          params: {
            ...DEFAULT_PROJECT_CONFIG.steps.final.params,
            renderReport: false,
          },
        },
        zstats: { enabled: true, params: { renderReport } },
      },
    })
    expect(computeStageBlockers(missing, zstats(true))).toEqual([
      expect.objectContaining({ key: 'zstats', kind: 'environment' }),
    ])
    expect(computeStageBlockers(missing, zstats(false))).toEqual([])
  })

  it('blocks only Recon when recon-all is missing', () => {
    expect(blockedKeys(report({ reconall: 'missing' }))).toEqual(['recon'])
  })

  it('leaves managed FastSurfer readiness to plan-time resource verification', () => {
    const fastsurfer = structuredClone(DEFAULT_PROJECT_CONFIG)
    fastsurfer.steps.recon.params.backend = 'fastsurfer'
    const hostFreesurferMissing = report({
      reconall: 'missing',
      fshome: 'missing',
      featurepython: 'missing',
      aparcstats: 'missing',
      asegstats: 'missing',
    })

    expect(blockedKeys(hostFreesurferMissing, fastsurfer)).not.toContain(
      'recon',
    )
    expect(blockedKeys(hostFreesurferMissing, fastsurfer)).not.toContain(
      'features',
    )
    expect(blockedKeys(report({ license: 'missing' }), fastsurfer)).toEqual([
      'features',
      'recon',
    ])
  })

  it('treats an absent required check as blocking', () => {
    expect(blockedKeys(report({}, ['reconall']))).toEqual(['recon'])
  })

  it('blocks each R stage through the interpreter it actually runs', () => {
    expect(blockedKeys(report({ rscript: 'missing' }))).toEqual(['outliers'])
    expect(blockedKeys(report({ finalrscript: 'missing' }))).toEqual(['final'])
    expect(
      blockedKeys(report({ rscript: 'missing', finalrscript: 'missing' })),
    ).toEqual(['final', 'outliers'])
  })

  it('blocks ENIGMA when the configured backend is unavailable', () => {
    expect(
      blockedKeys(report({ matlab: 'missing', mcr: 'missing' })),
    ).toContain('enigma')
    // Treat a warning backend as unavailable, matching `viable_enigma_backends`.
    expect(blockedKeys(report({ matlab: 'warn', mcr: 'missing' }))).toContain(
      'enigma',
    )
    // Keep the configured MATLAB backend runnable when it is found.
    expect(blockedKeys(report({ mcr: 'missing' }))).not.toContain('enigma')

    // Do not let an unselected viable fallback satisfy an explicitly
    // configured backend.
    const matlabCfg = structuredClone(DEFAULT_PROJECT_CONFIG)
    matlabCfg.steps.enigma.params['backend'] = 'matlab'
    expect(
      blockedKeys(report({ matlab: 'missing', mcr: 'found' }), matlabCfg),
    ).toContain('enigma')
    // Under automatic selection the installed Runtime is enough.
    expect(
      blockedKeys(report({ matlab: 'missing', mcr: 'found' })),
    ).not.toContain('enigma')
    expect(
      effectiveEnigmaBackend(
        DEFAULT_PROJECT_CONFIG,
        report({ matlab: 'missing', mcr: 'found' }),
      ),
    ).toBe('mcr')
    expect(
      effectiveEnigmaBackend(matlabCfg, report({ matlab: 'missing' })),
    ).toBe('matlab')
  })

  it('disables automatic selection only when no backend is available', () => {
    expect(
      unavailableEnigmaBackends(report({ matlab: 'missing', mcr: 'found' })),
    ).toEqual(['matlab'])
    expect(
      unavailableEnigmaBackends(report({ matlab: 'missing', mcr: 'missing' })),
    ).toEqual(['auto', 'matlab', 'mcr'])
  })

  it('keeps a skipped alternative backend optional even when it carries remediation', () => {
    // The sidecar keeps the unselected backend's command, link, and installer
    // on its skipped row; the remediation must not turn it into a requirement.
    const env = report({ matlab: 'missing', mcr: 'skipped' })
    const mcr = env.groups[0]?.checks.find((check) => check.id === 'mcr')
    if (!mcr) throw new Error('Seed the mcr check.')
    mcr.recommendedCmd = 'curl -fsSLO https://example.test/mcr.zip'
    mcr.downloadUrl =
      'https://www.mathworks.com/products/compiler/matlab-runtime.html'
    mcr.installable = false

    const required = requiredEnvCheckIdsForStep(
      'enigma',
      env,
      DEFAULT_PROJECT_CONFIG,
    )
    expect(required).toContain('matlab')
    expect(required).not.toContain('mcr')
    expect(requiredEnvCheckIds(env, DEFAULT_PROJECT_CONFIG)).not.toContain(
      'mcr',
    )
    // The selected backend still blocks; the skipped alternative stays unavailable.
    expect(blockedKeys(env)).toContain('enigma')
    expect(unavailableEnigmaBackends(env)).toContain('mcr')
  })

  it('requires mri_deface templates only for the configured mri_deface tool', () => {
    const mriDefaceCfg = structuredClone(DEFAULT_PROJECT_CONFIG)
    mriDefaceCfg.steps.deface.enabled = true
    expect(
      blockedKeys(report({ mri_deface_templates: 'missing' }), mriDefaceCfg),
    ).toContain('deface')

    const pydefaceCfg = structuredClone(DEFAULT_PROJECT_CONFIG)
    pydefaceCfg.steps.deface.enabled = true
    pydefaceCfg.steps.deface.params['tool'] = 'pydeface'
    expect(
      blockedKeys(report({ mri_deface_templates: 'missing' }), pydefaceCfg),
    ).not.toContain('deface')
  })

  it('ignores every requirement owned only by a disabled stage', () => {
    expect(
      blockedKeys(
        report({ mri_deface: 'missing', mri_deface_templates: 'missing' }),
      ),
    ).not.toContain('deface')
  })

  it('requires report tooling only when Final report rendering is enabled', () => {
    const noReport = structuredClone(DEFAULT_PROJECT_CONFIG)
    noReport.steps.final.params['renderReport'] = false
    const missingReportTools = report({
      rmarkdown: 'missing',
      knitr: 'missing',
      pandoc: 'missing',
      final_report_assets: 'missing',
    })

    expect(blockedKeys(missingReportTools, noReport)).not.toContain('final')
    expect(requiredEnvCheckIds(missingReportTools, noReport)).not.toContain(
      'rmarkdown',
    )
    expect(blockedKeys(missingReportTools)).toContain('final')
  })

  it('requires report tooling when the render parameter is absent', () => {
    // The schema defaults renderReport to true and the sidecar reads it the
    // same way, so a saved project that omits the parameter still renders.
    const absentReport = structuredClone(DEFAULT_PROJECT_CONFIG)
    absentReport.steps.final.params = {}
    const explicitReport = structuredClone(DEFAULT_PROJECT_CONFIG)
    explicitReport.steps.final.params['renderReport'] = true
    const missingReportTools = report({
      rmarkdown: 'missing',
      knitr: 'missing',
      pandoc: 'missing',
      final_report_assets: 'missing',
    })

    expect(blockedKeys(missingReportTools, absentReport)).toContain('final')
    expect(requiredEnvCheckIds(missingReportTools, absentReport)).toContain(
      'rmarkdown',
    )
    expect(blockedKeys(missingReportTools, explicitReport)).toContain('final')
  })

  it('resolves the Final checks the sidecar gate requires for every value', () => {
    // FinalAdapter.required_check_ids reads renderReport with default True, so
    // an absent value and true require the report tooling and its assets.
    const withReport = [
      'finalrscript',
      'final_assets',
      'rmarkdown',
      'knitr',
      'pandoc',
      'final_report_assets',
    ]
    const cases: [Record<string, unknown>, string[]][] = [
      [{}, withReport],
      [{ renderReport: true }, withReport],
      [{ renderReport: false }, ['finalrscript', 'final_assets']],
    ]
    for (const [params, expected] of cases) {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.steps.final.params = params
      expect(requiredEnvCheckIdsForStep('final', report(), cfg)).toEqual(
        expected,
      )
    }
  })

  it('blocks only the configured defacer and treats skip as tool-free', () => {
    const fslCfg = {
      ...DEFAULT_PROJECT_CONFIG,
      steps: {
        ...DEFAULT_PROJECT_CONFIG.steps,
        deface: {
          ...DEFAULT_PROJECT_CONFIG.steps.deface,
          enabled: true,
          params: {
            ...DEFAULT_PROJECT_CONFIG.steps.deface.params,
            tool: 'fsl_deface',
          },
        },
      },
    }
    expect(
      blockedKeys(report({ fsl_deface: 'missing', pydeface: 'found' }), fslCfg),
    ).toContain('deface')

    const skipCfg = {
      ...fslCfg,
      steps: {
        ...fslCfg.steps,
        deface: {
          ...fslCfg.steps.deface,
          params: { ...fslCfg.steps.deface.params, tool: 'skip' },
        },
      },
    }
    expect(
      blockedKeys(report({ fsl_deface: 'missing' }), skipCfg),
    ).not.toContain('deface')

    const unknownCfg = structuredClone(fslCfg)
    unknownCfg.steps.deface.params['tool'] = 'site-specific-defacer'
    expect(
      requiredEnvCheckIdsForStep('deface', report(), unknownCfg),
    ).toContain('site-specific-defacer')
  })

  it('blocks exactly the stage whose bundled command asset is absent', () => {
    expect(blockedKeys(report({ brainpad_assets: 'missing' }))).toEqual([
      'brainpad',
    ])
    expect(blockedKeys(report({ enigma_assets: 'missing' }))).toEqual([
      'enigma',
    ])
  })

  it('names the missing ENIGMA QC assets, not the backend, when the backend is found', () => {
    const reason = enigmaReason(
      withAcquisition(
        labelled(report({ enigma_assets: 'missing' })),
        'missing',
        true,
      ),
    )

    expect(reason).toBe(
      'Rebuild the scientific assets to restore the ENIGMA QC assets.',
    )
    expect(reason).not.toMatch(/backend/)
  })

  it('still names the backend when the backend check is missing', () => {
    expect(
      enigmaReason(labelled(report({ matlab: 'missing', mcr: 'missing' }))),
    ).toBe(
      'Provide the required environment check for the ENIGMA QC backend, matlab.',
    )
    expect(
      enigmaReason(
        withAcquisition(
          labelled(
            report({
              matlab: 'missing',
              mcr: 'missing',
              enigma_assets: 'missing',
            }),
          ),
          'missing',
          true,
        ),
      ),
    ).toBe(
      'Provide the required environment check for the ENIGMA QC backend, matlab. Rebuild the scientific assets to restore the ENIGMA QC assets.',
    )
  })

  it('words the asset fix by the acquisition the sidecar reports', () => {
    const missingAssets = labelled(report({ enigma_assets: 'missing' }))

    expect(enigmaReason(withAcquisition(missingAssets, 'missing', false))).toBe(
      'Acquire the scientific assets to install the ENIGMA QC assets.',
    )
    expect(
      enigmaReason(
        withAcquisition(
          labelled(report({ enigma_assets: 'wrong' })),
          'found',
          false,
        ),
      ),
    ).toBe(
      'Repair the ENIGMA QC assets; Diagnostics lists the files that fail verification.',
    )
  })

  it('names other missing ENIGMA tools by check without blaming the backend', () => {
    expect(
      enigmaReason(report({ display: 'warn', 'xvfb-run': 'missing' })),
    ).toBe('Install in Diagnostics: xvfb-run.')
  })

  it('names missing tools by their display labels', () => {
    const env = report({ rscript: 'missing' })
    const named: EnvReport = {
      ...env,
      groups: env.groups.map((group) => ({
        ...group,
        checks: group.checks.map((check) =>
          check.id === 'rscript' ? { ...check, label: 'R (Rscript)' } : check,
        ),
      })),
    }
    const outliers = computeStageBlockers(named, DEFAULT_PROJECT_CONFIG).find(
      (blocker) => blocker.key === 'outliers',
    )
    expect(outliers?.reason).toBe(
      'Add Rscript to PATH for histogram and outlier review. Install in Diagnostics: R (Rscript).',
    )
  })

  it('labels the stage asset checks of every stage beside its tool checks', () => {
    const env = withAcquisition(
      labelled(
        report({
          final_assets: 'missing',
          final_report_assets: 'missing',
          rscript: 'missing',
          outliers_assets: 'missing',
        }),
      ),
      'missing',
      true,
    )
    const reasons = new Map(
      computeStageBlockers(env, DEFAULT_PROJECT_CONFIG).map((blocker) => [
        blocker.key,
        blocker.reason,
      ]),
    )

    expect(reasons.get('final')).toBe(
      'Rebuild the scientific assets to restore the R analysis assets and R report assets.',
    )
    expect(reasons.get('outliers')).toBe(
      'Add Rscript to PATH for histogram and outlier review. Install in Diagnostics: rscript. Rebuild the scientific assets to restore the Outlier review assets.',
    )
  })

  it('lists only the unsatisfied asset checks a stage requires', () => {
    const env = report({ enigma_assets: 'missing', 'xvfb-run': 'missing' })

    expect(missingAssetCheckIds('enigma', env, DEFAULT_PROJECT_CONFIG)).toEqual(
      ['enigma_assets'],
    )
    expect(missingAssetCheckIds('recon', env, DEFAULT_PROJECT_CONFIG)).toEqual(
      [],
    )
    expect(isScientificAssetCheck('scientific_assets')).toBe(true)
    expect(isScientificAssetCheck('mri_deface_templates')).toBe(false)
  })

  it('requires xvfb-run only when the host has no X display', () => {
    expect(
      blockedKeys(report({ display: 'warn', 'xvfb-run': 'missing' })),
    ).toContain('enigma')
    expect(
      blockedKeys(report({ display: 'found', 'xvfb-run': 'missing' })),
    ).not.toContain('enigma')
  })

  it('blocks ENIGMA when any wrapper shell utility is unavailable', () => {
    // Mirror EnigmaAdapter.required_check_ids: the wrapper runs bash, awk,
    // grep, cat, and mkdir before it reaches its backend.
    for (const id of ['bash', 'awk', 'grep', 'cat', 'mkdir']) {
      expect(blockedKeys(report({ [id]: 'missing' }))).toEqual(['enigma'])
    }
  })

  it('requires wslpath only while the sidecar reports it outside skipped', () => {
    const withWslpath = (status: EnvCheck['status']): EnvReport => {
      const base = report()
      return {
        ...base,
        groups: [
          {
            name: 'Tools',
            checks: [
              ...(base.groups[0]?.checks ?? []),
              { id: 'wslpath', label: 'wslpath', status },
            ],
          },
        ],
      }
    }

    expect(
      requiredEnvCheckIdsForStep(
        'enigma',
        withWslpath('found'),
        DEFAULT_PROJECT_CONFIG,
      ),
    ).toContain('wslpath')
    expect(blockedKeys(withWslpath('missing'))).toContain('enigma')
    expect(blockedKeys(withWslpath('skipped'))).not.toContain('enigma')
    expect(
      requiredEnvCheckIdsForStep('enigma', report(), DEFAULT_PROJECT_CONFIG),
    ).not.toContain('wslpath')
  })

  it('uses default configured-tool names when no config is supplied', () => {
    const missingDefaults = report({
      matlab: 'missing',
      mcr: 'missing',
      mri_deface: 'missing',
      mri_deface_templates: 'missing',
    })
    const blockers = computeStageBlockers(missingDefaults)
    expect(
      blockers.find((blocker) => blocker.key === 'enigma')?.reason,
    ).toMatch(/matlab/)
    expect(
      blockers.find((blocker) => blocker.key === 'deface')?.reason,
    ).toMatch(/mri_deface/)
  })

  it('blocks PyBrainAge descendants for an incompatible parcellation', () => {
    const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
    cfg.steps.features.params['parcellation'] = 'aparc'

    const blockers = computeStageBlockers(report(), cfg)
    expect(blockers.filter((blocker) => blocker.kind === 'config')).toEqual([
      expect.objectContaining({
        key: 'pybrainage',
        action: expect.any(String),
      }),
      expect.objectContaining({ key: 'clinical', action: expect.any(String) }),
      expect.objectContaining({ key: 'brainpad', action: expect.any(String) }),
    ])
    // Each row leads with its own stage name, so the reason states the
    // requirement as a fact that reads beside every one of them.
    for (const blocker of blockers.filter((b) => b.kind === 'config')) {
      expect(blocker.reason).toBe(
        'PyBrainAge prediction and every stage after it need validated Destrieux thickness features (aparc.a2009s).',
      )
      // The action names the stage by its display name.
      expect(blocker.action).toBe(
        'Set FreeSurfer feature extraction to aparc.a2009s thickness with feature-order validation enabled.',
      )
    }
  })

  it.each([
    ['measure', 'area'],
    ['validateFeatureOrder', false],
  ])(
    'blocks PyBrainAge descendants for incompatible feature %s',
    (key, value) => {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.steps.features.params[key] = value

      const blockers = computeStageBlockers(report(), cfg)
      expect(
        blockers
          .filter((blocker) => blocker.kind === 'config')
          .map(({ key }) => key),
      ).toEqual(['pybrainage', 'clinical', 'brainpad'])
    },
  )
})

describe('unavailableEnigmaBackends', () => {
  it('offers all backends before the environment report is fetched', () => {
    expect(unavailableEnigmaBackends(null)).toEqual([])
  })

  it('disables a backend when its check is not found or warns', () => {
    expect(
      unavailableEnigmaBackends(report({ matlab: 'warn', mcr: 'missing' })),
    ).toEqual(['auto', 'matlab', 'mcr'])
  })
})
