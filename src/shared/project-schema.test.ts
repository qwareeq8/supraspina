import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  advisoryStages,
  DEFAULT_PROJECT_CONFIG,
  validateProjectConfig,
  type ProjectConfig,
} from './project-schema'

interface OverlapCase {
  readonly name: string
  readonly pathStyle: ProjectConfig['platform']['pathStyle']
  readonly paths: Record<string, string>
  readonly outputs: Record<string, string>
  readonly blockedFields: readonly string[]
  readonly overlappingFields: readonly string[]
}

const overlapCases: readonly OverlapCase[] = (
  JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'fixtures', 'template-resolution', 'cases.json'),
      'utf8',
    ),
  ) as { rawdataOverlap: OverlapCase[] }
).rawdataOverlap

function rootedConfig(): ProjectConfig {
  const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
  cfg.paths.projectRoot = '/data/projects/example'
  return cfg
}

describe('project config schema', () => {
  it('validates a structurally complete configuration', () => {
    const result = validateProjectConfig(rootedConfig())
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.data).not.toBeNull()
  })

  it('rejects unknown keys, including retired settings', () => {
    const retired = structuredClone(rootedConfig()) as unknown as Record<
      string,
      unknown
    >
    retired['qa'] = { iqiLow: 0.5, iqiHigh: 4, zThreshold: 2.698 }
    expect(validateProjectConfig(retired).ok).toBe(false)
    const subjects = structuredClone(rootedConfig()) as unknown as Record<
      string,
      unknown
    >
    ;(subjects['subjects'] as Record<string, unknown>)['strictBids'] = false
    expect(validateProjectConfig(subjects).ok).toBe(false)

    expect(
      validateProjectConfig({ ...rootedConfig(), unexpected: true }).ok,
    ).toBe(false)
    expect(
      validateProjectConfig({
        ...rootedConfig(),
        subjects: { ...rootedConfig().subjects, unexpected: true },
      }).ok,
    ).toBe(false)
  })

  it('enables Brain FOV for new projects', () => {
    expect(DEFAULT_PROJECT_CONFIG.steps.brainfov).toEqual({
      enabled: true,
      params: { marginMm: 30 },
    })
  })

  it('defaults new projects to the FreeSurfer Recon backend', () => {
    expect(DEFAULT_PROJECT_CONFIG.steps.recon.params).toMatchObject({
      backend: 'freesurfer',
      fastsurferDevice: 'auto',
    })
  })

  it('rejects a prototype-named step parameter', () => {
    // `in` reaches Object.prototype, so these names must be checked as own
    // keys to mirror the sidecar's dict membership test.
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      const cfg = structuredClone(rootedConfig())
      cfg.steps.brainfov.params[name] = 'injected'

      const result = validateProjectConfig(cfg)

      expect(result.ok).toBe(false)
      expect(result.errors.join(' ')).toContain(
        `Remove undefined parameter steps.brainfov.params.${name}.`,
      )
    }
  })

  it('rejects an unsupported ENIGMA backend', () => {
    const cfg = structuredClone(rootedConfig())
    cfg.steps.enigma.params['backend'] = 'octave'

    const result = validateProjectConfig(cfg)

    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(
      /Choose one of auto, matlab, mcr for steps\.enigma\.params\.backend/,
    )
  })

  it('advises when freesurferHome and the model path are empty', () => {
    const result = validateProjectConfig(rootedConfig())
    expect(result.warnings.join(' ')).toMatch(/FreeSurfer folder/)
    expect(result.warnings.join(' ')).toMatch(/modelPath/)
  })

  it('maps each stage-scoped advisory back to the stages it concerns', () => {
    const cfg = rootedConfig()
    cfg.steps.features = {
      enabled: true,
      params: { parcellation: 'aparc.DKTatlas' },
    }
    const result = validateProjectConfig(cfg)
    const stagesFor = (pattern: RegExp): readonly string[] | null => {
      const message = result.warnings.find((warning) => pattern.test(warning))
      expect(message).toBeDefined()
      return advisoryStages(message as string)
    }

    expect(stagesFor(/FreeSurfer folder/)).toEqual(['recon'])
    expect(stagesFor(/modelPath/)).toEqual(['pybrainage'])
    expect(stagesFor(/aparc\.a2009s/)).toEqual(['features', 'aggregate'])
  })

  it('leaves an advisory that names no stage unscoped', () => {
    expect(advisoryStages('Review the whole configuration.')).toBeNull()
  })

  it('rejects a project file that lacks a pipeline stage', () => {
    const saved = structuredClone(rootedConfig()) as unknown as Record<
      string,
      unknown
    >
    delete (saved['steps'] as Record<string, unknown>)['zstats']

    const result = validateProjectConfig(saved)

    expect(result.ok).toBe(false)
    expect(result.data).toBeNull()
    expect(result.errors.join(' ')).toMatch(/zstats/)
    expect(result.warnings).toEqual([])
  })

  it('turns the trailing stages off in new projects', () => {
    expect(DEFAULT_PROJECT_CONFIG.steps.braincharts).toEqual({
      enabled: false,
      params: { seed: 117 },
    })
    expect(DEFAULT_PROJECT_CONFIG.steps.zstats).toEqual({
      enabled: false,
      params: { renderReport: true },
    })
    expect(Object.keys(DEFAULT_PROJECT_CONFIG.steps).slice(-2)).toEqual([
      'braincharts',
      'zstats',
    ])
  })

  it('rejects a configuration missing required sections', () => {
    const result = validateProjectConfig({
      project: { name: 'x', createdAt: '' },
    })
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('requires the exact complete pipeline-step map', () => {
    const missing = structuredClone(rootedConfig()) as unknown as {
      steps: Record<string, unknown>
    }
    delete missing.steps['outliers']
    const missingResult = validateProjectConfig(missing)
    expect(missingResult.ok).toBe(false)

    const unknown = structuredClone(rootedConfig()) as unknown as {
      steps: Record<string, unknown>
    }
    unknown.steps['invented'] = { enabled: true, params: {} }
    const unknownResult = validateProjectConfig(unknown)
    expect(unknownResult.ok).toBe(false)
  })

  it('rejects a negative outlier threshold', () => {
    const cfg = rootedConfig()
    cfg.steps.outliers.params['zThreshold'] = -0.001

    const result = validateProjectConfig(cfg)

    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/greater than or equal to 0/)
  })

  it('flags a non-Destrieux parcellation as a downstream-breaking advisory', () => {
    const cfg = rootedConfig()
    cfg.steps.features = {
      enabled: true,
      params: { parcellation: 'aparc.DKTatlas' },
    }
    const result = validateProjectConfig(cfg)
    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/aparc\.a2009s/)
  })

  it('rejects an out-of-range thread count', () => {
    const cfg = rootedConfig() as ProjectConfig & {
      runtime: { threads: number }
    }
    cfg.runtime.threads = 999
    expect(validateProjectConfig(cfg).ok).toBe(false)
  })

  it.each([
    ['patterns.subjectGlob', '../sub-*'],
    ['patterns.subjectGlob', '/absolute'],
    ['patterns.t1Pattern', 'anat/*_T1w.nii.gz'],
    ['patterns.t1Pattern', '..\\*_T1w.nii.gz'],
  ])('rejects unsafe single-segment glob %s=%s', (path, value) => {
    const cfg = rootedConfig()
    const [, name] = path.split('.') as [
      'patterns',
      keyof ProjectConfig['patterns'],
    ]
    cfg.patterns[name] = value
    expect(validateProjectConfig(cfg).errors.join(' ')).toContain(path)
  })

  it('rejects unsafe and duplicate subject IDs while preserving exclude-wins overlap', () => {
    const unsafe = rootedConfig()
    unsafe.subjects.include = ['sub-01', '../sub-02', 'sub-01']
    const result = validateProjectConfig(unsafe)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/safe single-segment subject ID/)
    expect(result.errors.join(' ')).toMatch(
      /Remove duplicate subject IDs from subjects\.include: sub-01/,
    )

    const overlap = rootedConfig()
    overlap.subjects.include = ['sub-01']
    overlap.subjects.exclude = ['sub-01']
    expect(validateProjectConfig(overlap).ok).toBe(true)
  })

  it('rejects unresolved and cyclic required path templates', () => {
    const unresolved = rootedConfig()
    unresolved.paths.outputDir = '${paths.notConfigured}/outputs'
    expect(validateProjectConfig(unresolved).errors.join(' ')).toMatch(
      /Resolve every template reference in paths\.outputDir/,
    )

    const cyclic = rootedConfig()
    cyclic.outputs.rootDir = '${outputs.runDir}'
    cyclic.outputs.runDir = '${outputs.rootDir}'
    expect(validateProjectConfig(cyclic).errors.join(' ')).toMatch(
      /Resolve every template reference in outputs\.(rootDir|runDir)/,
    )
  })

  it.each([
    [
      'derivatives nested in raw data',
      '/data/BIDS/study',
      '/data/BIDS/study/derivatives',
      '/data/projects/example/outputs/run',
    ],
    [
      'raw data nested in derivatives',
      '/data/projects/example/derivatives/rawdata',
      '/data/projects/example/derivatives',
      '/data/projects/example/outputs/run',
    ],
    [
      'output nested in raw data',
      '/data/BIDS/study',
      '/data/projects/example/derivatives',
      '/data/BIDS/study/outputs/run',
    ],
  ])(
    'rejects writable roots that overlap raw BIDS: %s',
    (_label, rawdataDir, derivativesDir, outputDir) => {
      const cfg = rootedConfig()
      cfg.paths.rawdataDir = rawdataDir
      cfg.paths.derivativesDir = derivativesDir
      cfg.paths.outputDir = outputDir

      const result = validateProjectConfig(cfg)

      expect(result.ok).toBe(false)
      expect(result.errors.join(' ')).toMatch(
        /Keep .* separate from paths\.rawdataDir/,
      )
    },
  )

  it('compares Windows output roots case-insensitively without rejecting siblings', () => {
    const overlap = rootedConfig()
    overlap.platform.pathStyle = 'windows'
    overlap.paths.rawdataDir = 'D:\\BIDS\\Study'
    overlap.paths.derivativesDir = 'd:/bids/study/DERIVATIVES'
    expect(validateProjectConfig(overlap).errors.join(' ')).toMatch(
      /Keep paths\.derivativesDir separate from paths\.rawdataDir/,
    )

    const sibling = rootedConfig()
    sibling.paths.rawdataDir = '/data/BIDS/study'
    sibling.paths.derivativesDir = '/data/BIDS/study-derivatives'
    sibling.paths.outputDir = '/data/BIDS/study-outputs'
    expect(validateProjectConfig(sibling).ok).toBe(true)
  })

  it('refuses a Windows-rooted path under the POSIX path style', () => {
    for (const root of ['C:\\data\\proj', '\\\\server\\share\\proj']) {
      const cfg = rootedConfig()
      cfg.paths.projectRoot = root
      expect(validateProjectConfig(cfg).errors).toContain(
        'Set paths.projectRoot to an absolute path.',
      )
    }
  })

  it('accepts a Windows-rooted path under the Windows path style', () => {
    for (const root of ['C:\\data\\proj', '\\\\server\\share\\proj']) {
      const cfg = rootedConfig()
      cfg.platform.pathStyle = 'windows'
      cfg.paths.projectRoot = root
      const result = validateProjectConfig(cfg)
      expect(result.errors).toHaveLength(0)
      expect(result.ok).toBe(true)
    }
  })

  it('reports one cause-level message when raw data equals the project root', () => {
    const cfg = rootedConfig()
    cfg.paths.rawdataDir = '/data/projects/example'

    const result = validateProjectConfig(cfg)

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      'Keep paths.rawdataDir separate from paths.projectRoot: they resolve to the same directory, so every writable path inside the project lands in the raw data.',
    ])
  })

  it('reports one cause-level message when raw data contains the project root', () => {
    const cfg = rootedConfig()
    cfg.paths.rawdataDir = '/data/projects'

    const result = validateProjectConfig(cfg)

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      'Keep paths.rawdataDir separate from paths.projectRoot: the project directory is inside the raw data directory, so every writable path inside the project lands in the raw data.',
    ])
  })

  it('collapses aliased and nested output collisions into the owning path', () => {
    const cfg = rootedConfig()
    cfg.paths.rawdataDir = '/data/BIDS/study'
    cfg.paths.outputDir = '/data/BIDS/study/outputs/run'

    const result = validateProjectConfig(cfg)

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      'Keep paths.outputDir separate from paths.rawdataDir.',
    ])
  })

  it('allows missing host tools and model files in a structurally valid draft', () => {
    const cfg = rootedConfig()
    cfg.tools.freesurferHome = ''
    cfg.tools.pythonExecutable = ''
    cfg.pybrain.modelPath = ''
    cfg.pybrain.scalerPath = ''
    const result = validateProjectConfig(cfg)
    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/FreeSurfer folder/)
    expect(result.warnings.join(' ')).toMatch(/modelPath/)
  })

  it('rejects control characters, empty required paths, and non-absolute paths', () => {
    const controlled = rootedConfig()
    controlled.paths.metadataDir = '/data/metadata\nsecond-line'
    expect(validateProjectConfig(controlled).errors.join(' ')).toMatch(
      /Remove NUL characters and line breaks from paths\.metadataDir/,
    )

    const empty = rootedConfig()
    empty.paths.rawdataDir = ''
    expect(validateProjectConfig(empty).errors.join(' ')).toMatch(
      /Set paths\.rawdataDir to a non-empty path/,
    )

    const relative = rootedConfig()
    relative.outputs.manifestPath = 'relative/manifest.json'
    expect(validateProjectConfig(relative).errors.join(' ')).toMatch(
      /Set outputs\.manifestPath to an absolute path/,
    )
  })

  it('validates every pipeline parameter kind with actionable field paths', () => {
    const cfg = rootedConfig()
    cfg.steps.recon!.params['parallel'] = 'yes'
    cfg.steps.outliers!.params['zThreshold'] = Number.NaN
    cfg.steps.recon!.params['directives'] = 8
    cfg.steps.enigma!.params['matlabExecutable'] = 7
    cfg.steps.enigma!.params['backend'] = 'unsupported'
    cfg.steps.brainfov!.params['marginMm'] = 14
    cfg.steps.recon!.params['backend'] = 'unsupported'
    cfg.steps.recon!.params['fastsurferDevice'] = 'metal'

    const result = validateProjectConfig(cfg)
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /Set steps\.recon\.params\.parallel to a boolean/,
        ),
        expect.stringMatching(
          /Set steps\.outliers\.params\.zThreshold to a finite number/,
        ),
        expect.stringMatching(/Set steps\.recon\.params\.directives to text/),
        expect.stringMatching(
          /Set steps\.enigma\.params\.matlabExecutable to a path string/,
        ),
        expect.stringMatching(
          /Choose one of .* for steps\.enigma\.params\.backend/,
        ),
        expect.stringMatching(
          /Set steps\.brainfov\.params\.marginMm to an integer/,
        ),
        expect.stringMatching(
          /Choose one of .* for steps\.recon\.params\.backend/,
        ),
        expect.stringMatching(
          /Choose one of .* for steps\.recon\.params\.fastsurferDevice/,
        ),
      ]),
    )
  })
})

describe('the shared cross-language raw data overlap table', () => {
  // The sidecar validator runs this same table from pytest. A path that still
  // carries a token cannot be compared against the raw data directory, so the
  // check must refuse it instead of clearing a configuration it never
  // inspected.
  function fixtureConfig(entry: OverlapCase): ProjectConfig {
    const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
    cfg.platform.pathStyle = entry.pathStyle
    cfg.paths = { ...cfg.paths, ...entry.paths }
    cfg.outputs = { ...cfg.outputs, ...entry.outputs }
    return cfg
  }

  function blockedMessage(field: string): string {
    return field === 'paths.rawdataDir'
      ? 'Resolve every template reference in paths.rawdataDir so the writable paths can be checked against it.'
      : `Resolve every template reference in ${field} so it can be checked against paths.rawdataDir.`
  }

  it('covers every raw data overlap outcome the two validators must share', () => {
    expect(overlapCases.length).toBeGreaterThan(0)
  })

  it.each(overlapCases.map((entry) => [entry.name, entry] as const))(
    'reports the case: %s',
    (_name, entry) => {
      const result = validateProjectConfig(fixtureConfig(entry))
      // Keep the generic unresolved-template message out of this comparison:
      // only the raw data overlap check's own messages belong here.
      const overlapErrors = result.errors.filter(
        (error) =>
          error.endsWith('so the writable paths can be checked against it.') ||
          error.endsWith('so it can be checked against paths.rawdataDir.') ||
          /^Keep \S+ separate from paths\.rawdataDir\.$/.test(error) ||
          error.startsWith(
            'Keep paths.rawdataDir separate from paths.projectRoot',
          ),
      )

      expect(overlapErrors).toEqual(
        expect.arrayContaining([
          ...entry.blockedFields.map(blockedMessage),
          ...entry.overlappingFields.map(
            (field) => `Keep ${field} separate from paths.rawdataDir.`,
          ),
        ]),
      )
      expect(overlapErrors).toHaveLength(
        entry.blockedFields.length + entry.overlappingFields.length,
      )
      if (overlapErrors.length > 0) expect(result.ok).toBe(false)
    },
  )
})
