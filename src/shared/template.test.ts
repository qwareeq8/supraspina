import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig } from './project-schema'
import {
  flattenConfig,
  hasPlaceholder,
  isAbsoluteProjectRoot,
  resolveTemplate,
  unresolvedPaths,
} from './template'

interface ResolutionCase {
  readonly name: string
  readonly config: Record<string, unknown>
  readonly template: string
  readonly expected: string
}

const resolutionCases: readonly ResolutionCase[] = (
  JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'fixtures', 'template-resolution', 'cases.json'),
      'utf8',
    ),
  ) as { resolution: ResolutionCase[] }
).resolution

function rootedConfig(): ProjectConfig {
  return {
    ...DEFAULT_PROJECT_CONFIG,
    paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '/data/study' },
  }
}

describe('flattenConfig', () => {
  it('exposes both the dotted key and the bare leaf', () => {
    const flat = flattenConfig(rootedConfig())
    expect(flat['paths.projectRoot']).toBe('/data/study')
    expect(flat['projectRoot']).toBe('/data/study')
  })
})

describe('resolveTemplate', () => {
  it('resolves a bare ${projectRoot} via the leaf fallback', () => {
    const flat = flattenConfig(rootedConfig())
    expect(resolveTemplate('${projectRoot}/rawdata', flat)).toBe(
      '/data/study/rawdata',
    )
  })

  it('resolves a dotted ${paths.projectRoot} via the exact key', () => {
    const flat = flattenConfig(rootedConfig())
    expect(resolveTemplate('${paths.projectRoot}/x', flat)).toBe(
      '/data/study/x',
    )
  })

  it('collapses nested placeholders iteratively', () => {
    const flat = flattenConfig(rootedConfig())
    expect(resolveTemplate('${clinicalMetadataFile}', flat)).toBe(
      '/data/study/metadata/clinical.csv',
    )
  })

  it('leaves a prototype-named token intact like the Python interpolate', () => {
    // Object.prototype members must not resolve, or the TypeScript and Python
    // path resolvers disagree about the same template.
    expect(resolveTemplate('/data/out${toString}', {})).toBe(
      '/data/out${toString}',
    )
    expect(resolveTemplate('/data/out${constructor}', {})).toBe(
      '/data/out${constructor}',
    )
    expect(resolveTemplate('/data/out${hasOwnProperty}', {})).toBe(
      '/data/out${hasOwnProperty}',
    )
  })

  it('leaves an unknown token intact', () => {
    const flat = flattenConfig(rootedConfig())
    expect(resolveTemplate('${nope}/x', flat)).toBe('${nope}/x')
  })
})

describe('the shared cross-language resolution table', () => {
  // The sidecar's schema validator and its execution-side path resolver run
  // this same table. A resolver that drifts from the other two fails here and
  // in pytest, because a path one resolver accepts and another leaves as a
  // token would execute somewhere validation never inspected.
  it('covers every behavior the three resolvers must agree on', () => {
    expect(resolutionCases.length).toBeGreaterThan(0)
  })

  it.each(resolutionCases.map((entry) => [entry.name, entry] as const))(
    'resolves the case: %s',
    (_name, entry) => {
      expect(resolveTemplate(entry.template, flattenConfig(entry.config))).toBe(
        entry.expected,
      )
    },
  )
})

describe('hasPlaceholder', () => {
  it('detects a residual token', () => {
    expect(hasPlaceholder('${x}/y')).toBe(true)
    expect(hasPlaceholder('/concrete/path')).toBe(false)
  })
})

describe('isAbsoluteProjectRoot', () => {
  it('accepts a POSIX absolute path under either path style', () => {
    expect(isAbsoluteProjectRoot('/data/projects/study', 'posix')).toBe(true)
    expect(isAbsoluteProjectRoot('  /data/study  ', 'posix')).toBe(true)
    expect(isAbsoluteProjectRoot('/data/projects/study', 'windows')).toBe(true)
  })

  it('accepts Windows drive and UNC roots under the Windows path style', () => {
    expect(isAbsoluteProjectRoot('C:\\Users\\me\\study', 'windows')).toBe(true)
    expect(isAbsoluteProjectRoot('C:/Users/me/study', 'windows')).toBe(true)
    expect(isAbsoluteProjectRoot('\\\\server\\share\\study', 'windows')).toBe(
      true,
    )
  })

  it('rejects Windows drive and UNC roots under the POSIX path style', () => {
    expect(isAbsoluteProjectRoot('C:\\Users\\me\\study', 'posix')).toBe(false)
    expect(isAbsoluteProjectRoot('C:/Users/me/study', 'posix')).toBe(false)
    expect(isAbsoluteProjectRoot('\\\\server\\share\\study', 'posix')).toBe(
      false,
    )
  })

  it('rejects a tilde, relative, or empty root (~ is not expanded)', () => {
    for (const style of ['posix', 'windows'] as const) {
      expect(isAbsoluteProjectRoot('~/example', style)).toBe(false)
      expect(isAbsoluteProjectRoot('example', style)).toBe(false)
      expect(isAbsoluteProjectRoot('./study', style)).toBe(false)
      expect(isAbsoluteProjectRoot('../study', style)).toBe(false)
      expect(isAbsoluteProjectRoot('', style)).toBe(false)
      expect(isAbsoluteProjectRoot('   ', style)).toBe(false)
    }
  })
})

describe('unresolvedPaths', () => {
  it('reports no unresolved paths once projectRoot is concrete', () => {
    expect(unresolvedPaths(rootedConfig())).toHaveLength(0)
  })

  it('flags a path field carrying an unknown token', () => {
    const cfg = rootedConfig()
    const broken: ProjectConfig = {
      ...cfg,
      paths: { ...cfg.paths, derivativesDir: '${typo}/derivatives' },
    }
    const residual = unresolvedPaths(broken)
    expect(residual.map((r) => r.field)).toContain('derivativesDir')
  })

  it('flags every path when projectRoot is left as a token', () => {
    const cfg: ProjectConfig = {
      ...DEFAULT_PROJECT_CONFIG,
      paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '${root}' },
    }
    const residual = unresolvedPaths(cfg)
    expect(residual.length).toBeGreaterThan(0)
    expect(residual.map((r) => r.field)).toContain('projectRoot')
  })
})
