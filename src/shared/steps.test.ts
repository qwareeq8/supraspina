import { describe, expect, it } from 'vitest'
import {
  MATRIX_STEPS,
  MATRIX_STEP_COUNT,
  PIPELINE_STEPS,
  PIPELINE_STEPS_IN_DISPLAY_ORDER,
  STEP_CHECK_REQUIREMENTS,
  STEP_DEPENDENCIES,
  STEP_KEYS,
  advancedColumns,
  defaultParams,
  dependenciesForStep,
  pipelineStep,
} from './steps'

describe('step model', () => {
  it('exposes exactly ten matrix columns in load-bearing order', () => {
    expect(MATRIX_STEP_COUNT).toBe(10)
    expect(MATRIX_STEPS.map((s) => s.key)).toEqual([
      'recon',
      'qcsub',
      'qcic',
      'qcec',
      'feat',
      'pba',
      'norm',
      'stats',
      'agg',
      'rep',
    ])
  })

  it('defines one pipeline step per configurable key', () => {
    expect(STEP_KEYS).toHaveLength(14)
    for (const key of STEP_KEYS) {
      expect(pipelineStep(key).key).toBe(key)
    }
  })

  it('appends BrainCharts after R analysis, off by default', () => {
    // A node ID carries its plan position, so a new stage never moves one.
    expect(STEP_KEYS.slice(-3)).toEqual(['final', 'braincharts', 'zstats'])
    expect(pipelineStep('braincharts')).toMatchObject({
      id: 5.5,
      enabledByDefault: false,
      scope: 'cohort',
      advances: 'norm',
    })
    expect(MATRIX_STEPS.find((step) => step.key === 'norm')).toMatchObject({
      label: 'Norm',
      long: 'braincharts.zscores',
    })
    expect(defaultParams('braincharts')).toEqual({ seed: 117 })
    expect(STEP_CHECK_REQUIREMENTS.braincharts).toEqual([
      { kind: 'all', ids: ['bcenv', 'bcmodel'] },
    ])
  })

  it('lists the appended stages beside the stages they extend', () => {
    const order = PIPELINE_STEPS_IN_DISPLAY_ORDER.map((step) => step.key)
    expect(order).toEqual([
      'brainfov',
      'deface',
      'recon',
      'enigma',
      'outliers',
      'features',
      'age',
      'pybrainage',
      'braincharts',
      'clinical',
      'brainpad',
      'aggregate',
      'final',
      'zstats',
    ])
    // Plan and node order stay the append order.
    expect(PIPELINE_STEPS.map((step) => step.key)).toEqual([...STEP_KEYS])
  })

  it('appends the z-score comparisons after BrainCharts, off by default', () => {
    expect(STEP_KEYS.at(-1)).toBe('zstats')
    expect(pipelineStep('zstats')).toMatchObject({
      id: 9.5,
      enabledByDefault: false,
      scope: 'cohort',
      advances: null,
    })
    expect(defaultParams('zstats')).toEqual({ renderReport: true })
    expect(STEP_DEPENDENCIES.zstats).toEqual(['braincharts'])
    // It runs on the R analysis interpreter and, for its report, the same tools.
    expect(STEP_CHECK_REQUIREMENTS.zstats).toEqual([
      { kind: 'all', ids: ['finalrscript', 'final_assets'] },
      {
        kind: 'conditional',
        when: 'steps.zstats.params.renderReport !== false',
        ids: ['rmarkdown', 'knitr', 'pandoc', 'final_report_assets'],
      },
    ])
  })

  it('describes every stage as a fact, not an order', () => {
    // The goal is the Pipeline card subtitle and the expanded Runs stage
    // card body: it says what the stage does ("Runs ...", "Optionally
    // runs ..."), where an order ("Run ...") reads as an instruction.
    for (const step of PIPELINE_STEPS) {
      expect(step.goal, step.key).toMatch(
        /^(?:Optionally [a-z]|[A-Z])[a-z]*[a-rt-z]s /,
      )
    }
  })

  it('places Brain FOV preparation before existing subject stages', () => {
    expect(STEP_KEYS.slice(0, 3)).toEqual(['brainfov', 'deface', 'recon'])
    expect(pipelineStep('brainfov')).toMatchObject({
      id: -1,
      enabledByDefault: true,
      name: 'Brain FOV preparation',
    })
    expect(defaultParams('brainfov')).toEqual({ marginMm: 30 })
  })

  it('defaults Recon to FreeSurfer with automatic FastSurfer device selection', () => {
    expect(defaultParams('recon')).toMatchObject({
      backend: 'freesurfer',
      fastsurferDevice: 'auto',
    })
  })

  it('maps the enigma stage to the three QC matrix columns', () => {
    expect(pipelineStep('enigma').advances).toEqual(['qcsub', 'qcic', 'qcec'])
  })

  it('defaults the feature atlas to Destrieux a2009s (required downstream)', () => {
    expect(defaultParams('features')['parcellation']).toBe('aparc.a2009s')
  })

  it('keeps unavailable time-since-SCI metadata optional by default', () => {
    expect(defaultParams('clinical')['requiredColumns']).toBe('Cohort,AIS')
  })

  it('defaults the QC backend to auto and FreeSurfer version to 7', () => {
    const params = defaultParams('enigma')
    expect(params['backend']).toBe('auto')
    expect(params['fsVersion']).toBe('7')
  })

  it('offers automatic, MATLAB, and MATLAB Runtime for ENIGMA QC', () => {
    expect(pipelineStep('enigma').params['backend']).toMatchObject({
      options: ['auto', 'matlab', 'mcr'],
    })
  })

  it('mirrors the sidecar ENIGMA required checks branch by branch', () => {
    // Mirror EnigmaAdapter.required_check_ids in
    // sidecar/supraspina_sidecar/adapters/enigma.py: bash, awk, grep, cat, mkdir,
    // the selected backend and enigma_assets always; wslpath on a WSL host;
    // xvfb-run without a display.
    expect(STEP_CHECK_REQUIREMENTS.enigma).toEqual([
      {
        kind: 'all',
        ids: ['bash', 'awk', 'grep', 'cat', 'mkdir', 'enigma_assets'],
      },
      {
        kind: 'configured-choice',
        configPath: 'steps.enigma.params.backend',
        choices: { auto: [], matlab: ['matlab'], mcr: ['mcr'] },
      },
      {
        kind: 'conditional',
        when: 'env.wslpath !== skipped',
        ids: ['wslpath'],
      },
      { kind: 'conditional', when: 'env.display !== found', ids: ['xvfb-run'] },
    ])
  })

  it('mirrors the sidecar Final required checks and its report default', () => {
    // Mirror FinalAdapter.required_check_ids in
    // sidecar/supraspina_sidecar/adapters/final.py: finalrscript and final_assets
    // always; the report tooling unless renderReport is explicitly false, an
    // absent value reading as the declared default (true) on both sides.
    expect(STEP_CHECK_REQUIREMENTS.final).toEqual([
      { kind: 'all', ids: ['finalrscript', 'final_assets'] },
      {
        kind: 'conditional',
        when: 'steps.final.params.renderReport !== false',
        ids: ['rmarkdown', 'knitr', 'pandoc', 'final_report_assets'],
      },
    ])
    expect(defaultParams('final')['renderReport']).toBe(true)
  })

  it('never lists the informational dos2unix check as a stage requirement', () => {
    for (const requirements of Object.values(STEP_CHECK_REQUIREMENTS)) {
      for (const requirement of requirements) {
        const ids =
          requirement.kind === 'configured-choice'
            ? Object.values(requirement.choices).flat()
            : requirement.ids
        expect(ids).not.toContain('dos2unix')
      }
    }
  })

  it('throws for an unknown step key', () => {
    // @ts-expect-error - exercising the runtime guard
    expect(() => pipelineStep('nope')).toThrow()
  })

  it('gives every pipeline step at least one declared output', () => {
    for (const step of PIPELINE_STEPS) {
      expect(step.outputs.length).toBeGreaterThan(0)
    }
  })

  it('Declares the three Step 9 result-table families, the site and summary CSVs, and the report.', () => {
    expect(pipelineStep('final').outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathTemplate: '${paths.outputDir}/final/SCI_*_results.*',
          kind: 'glob',
        }),
        expect.objectContaining({
          pathTemplate: '${paths.outputDir}/final/SUB_*_results.*',
          kind: 'glob',
        }),
        expect.objectContaining({
          pathTemplate: '${paths.outputDir}/final/WM_*_results.*',
          kind: 'glob',
        }),
        ...['site_exclusions', 'summary_icv', 'summary_thickness'].map((name) =>
          expect.objectContaining({
            pathTemplate: `\${paths.outputDir}/final/${name}.csv`,
            kind: 'csv',
          }),
        ),
        expect.objectContaining({
          pathTemplate: '${paths.outputDir}/final/report.html',
          kind: 'html',
        }),
      ]),
    )
  })
})

describe('cross-step dependencies', () => {
  it('declares the data DAG as a forest rooted at recon', () => {
    expect(STEP_DEPENDENCIES).toEqual({
      enigma: ['recon'],
      outliers: ['enigma'],
      features: ['recon'],
      age: ['features'],
      pybrainage: ['age'],
      clinical: ['pybrainage'],
      brainpad: ['clinical'],
      aggregate: ['recon'],
      final: ['aggregate'],
      braincharts: ['features'],
      zstats: ['braincharts'],
    })
  })

  it('references only known step keys and never depends on deface', () => {
    const keys = new Set<string>(STEP_KEYS)
    for (const [step, prereqs] of Object.entries(STEP_DEPENDENCIES)) {
      expect(keys.has(step)).toBe(true)
      for (const prereq of prereqs ?? []) {
        expect(keys.has(prereq)).toBe(true)
        expect(prereq).not.toBe('deface')
      }
    }
  })

  it('does not list a root or auxiliary source node as having prerequisites', () => {
    expect(STEP_DEPENDENCIES['recon']).toBeUndefined()
    expect(STEP_DEPENDENCIES['deface']).toBeUndefined()
    expect(STEP_DEPENDENCIES['brainfov']).toBeUndefined()
  })

  it('resolves the Brain FOV and defacing subject-input chain', () => {
    expect(dependenciesForStep('brainfov', false, true)).toEqual([])
    expect(dependenciesForStep('deface', false, true)).toEqual(['brainfov'])
    expect(dependenciesForStep('recon', false, true)).toEqual(['brainfov'])
    expect(dependenciesForStep('recon', true, true)).toEqual(['deface'])
    expect(dependenciesForStep('recon', true, false)).toEqual(['deface'])
    expect(dependenciesForStep('recon', false, false)).toEqual([])
  })

  it('normalizes advances to the matrix columns a step owns', () => {
    expect(advancedColumns('recon')).toEqual(['recon'])
    expect(advancedColumns('enigma')).toEqual(['qcsub', 'qcic', 'qcec'])
    expect(advancedColumns('deface')).toEqual([])
    expect(advancedColumns('brainfov')).toEqual([])
    expect(advancedColumns('outliers')).toEqual([])
    expect(advancedColumns('braincharts')).toEqual(['norm'])
    expect(advancedColumns('zstats')).toEqual([])
  })
})
