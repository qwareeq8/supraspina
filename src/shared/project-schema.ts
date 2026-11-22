/**
 * Defines the persisted `supraspina.project.json` source of truth with this Zod
 * schema.
 *
 * The TypeScript {@link ProjectConfig} type derives from the schema with
 * `z.infer` to prevent renderer and main-process drift. The Python sidecar's
 * pydantic model mirrors this shape, and either side can emit a JSON Schema
 * when cross-checking the contract. Validate before saving in the renderer and
 * after loading in the main process.
 */

import { z } from 'zod'
import { STEP_KEYS, PIPELINE_STEPS, type StepKey } from './steps'
import {
  flattenConfig,
  hasPlaceholder,
  isAbsoluteProjectRoot,
  resolveTemplate,
} from './template'

const platformModeSchema = z.enum(['linux', 'wsl'])
const pathStyleSchema = z.enum(['posix', 'windows'])

const projectPathsSchema = z
  .object({
    projectRoot: z.string(),
    rawdataDir: z.string(),
    derivativesDir: z.string(),
    outputDir: z.string(),
    metadataDir: z.string(),
    clinicalMetadataFile: z.string().optional(),
    ageMetadataFile: z.string().optional(),
    qcOutputDir: z.string().optional(),
  })
  .strict()

const toolPathsSchema = z
  .object({
    freesurferHome: z.string(),
    freesurferLicense: z.string(),
    matlabExecutable: z.string().optional(),
    mcrRoot: z.string().optional(),
    pythonExecutable: z.string(),
    rscriptExecutable: z.string(),
  })
  .strict()

const runtimeSettingsSchema = z
  .object({
    threads: z.number().int().min(1).max(64),
    queueSize: z.number().int().min(1).max(32),
    memoryWarningGB: z.number().min(1),
    dryRun: z.boolean(),
    resumeCompleted: z.boolean(),
    rerunIncomplete: z.boolean(),
    stopOnError: z.boolean(),
    continueIndependentAfterError: z.boolean(),
  })
  .strict()

const stepOverrideSchema = z
  .object({
    enabled: z.boolean(),
    params: z.record(z.string(), z.unknown()),
  })
  .strict()

const stepsSchema = z.record(z.enum([...STEP_KEYS]), stepOverrideSchema)

/** The complete persisted project configuration contract. */
const projectConfigSchema = z
  .object({
    project: z.object({ name: z.string(), createdAt: z.string() }).strict(),
    platform: z
      .object({ mode: platformModeSchema, pathStyle: pathStyleSchema })
      .strict(),
    paths: projectPathsSchema,
    tools: toolPathsSchema,
    patterns: z
      .object({ subjectGlob: z.string(), t1Pattern: z.string() })
      .strict(),
    runtime: runtimeSettingsSchema,
    subjects: z
      .object({
        include: z.array(z.string()),
        exclude: z.array(z.string()),
      })
      .strict(),
    steps: stepsSchema,
    pybrain: z
      .object({ modelPath: z.string(), scalerPath: z.string() })
      .strict(),
    outputs: z
      .object({
        rootDir: z.string(),
        runDir: z.string(),
        manifestPath: z.string(),
      })
      .strict(),
    provenance: z
      .object({
        configSha256: z.string(),
        runId: z.string(),
        gitSha: z.string().optional(),
      })
      .strict(),
  })
  .strict()

/** One validated persisted project configuration. */
export type ProjectConfig = z.infer<typeof projectConfigSchema>

export { projectConfigSchema }

function defaultStepsMap(): ProjectConfig['steps'] {
  const out: Partial<
    Record<StepKey, { enabled: boolean; params: Record<string, unknown> }>
  > = {}
  for (const step of PIPELINE_STEPS) {
    const params: Record<string, unknown> = {}
    for (const [name, spec] of Object.entries(step.params)) {
      params[name] = spec.default
    }
    out[step.key] = { enabled: step.enabledByDefault, params }
  }
  return out as ProjectConfig['steps']
}

/**
 * The complete default configuration used as the setup seed. Resolve its
 * `${...}` path placeholders in the setup wizard. Keep the project unavailable
 * for execution until the wizard supplies concrete paths and the environment
 * checker verifies them.
 */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  project: { name: '', createdAt: '' },
  platform: { mode: 'linux', pathStyle: 'posix' },
  paths: {
    projectRoot: '',
    rawdataDir: '${projectRoot}/rawdata',
    derivativesDir: '${projectRoot}/derivatives',
    outputDir: '${projectRoot}/outputs/run',
    metadataDir: '${projectRoot}/metadata',
    clinicalMetadataFile: '${metadataDir}/clinical.csv',
    ageMetadataFile: '${metadataDir}/age.csv',
    qcOutputDir: '${outputDir}/qc_review',
  },
  tools: {
    freesurferHome: '',
    freesurferLicense: '',
    pythonExecutable: '',
    rscriptExecutable: '',
  },
  patterns: { subjectGlob: 'sub-*', t1Pattern: '*_T1w.nii.gz' },
  runtime: {
    threads: 6,
    queueSize: 2,
    memoryWarningGB: 10,
    dryRun: true,
    resumeCompleted: true,
    rerunIncomplete: false,
    stopOnError: false,
    continueIndependentAfterError: true,
  },
  subjects: {
    include: [],
    exclude: [],
  },
  steps: defaultStepsMap(),
  pybrain: { modelPath: '', scalerPath: '' },
  outputs: {
    rootDir: '${paths.outputDir}',
    runDir: '${rootDir}',
    manifestPath: '${rootDir}/manifest.json',
  },
  provenance: { configSha256: '', runId: '' },
}

/** Parsed project data together with validation findings. */
export interface ConfigValidation {
  ok: boolean
  data: ProjectConfig | null
  errors: string[]
  warnings: string[]
}

/** Validate one candidate and return parsed data, errors, and advisories. */
export function validateProjectConfig(input: unknown): ConfigValidation {
  const result = projectConfigSchema.safeParse(input)
  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    )
    return { ok: false, data: null, errors, warnings: [] }
  }
  const errors = structuralErrors(result.data)
  if (errors.length > 0) {
    return { ok: false, data: null, errors, warnings: [] }
  }
  return {
    ok: true,
    data: result.data,
    errors: [],
    warnings: advisories(result.data),
  }
}

const UNSAFE_CONTROL = /[\0\r\n]/

/**
 * Report whether a value is a safe single path segment or glob.
 *
 * Reject empty values, the current-directory segment, separators, traversal,
 * and control characters so a pattern can never leave its parent folder.
 */
export function safeRelativeSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    !UNSAFE_CONTROL.test(value)
  )
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort()
}

/**
 * Normalize an already-resolved absolute path for a lexical containment check.
 *
 * Avoid touching the host filesystem because structural validation also runs in
 * the sandboxed renderer. Keep the normal main-process and sidecar filesystem
 * checks before execution.
 */
function lexicalPathParts(
  value: string,
  pathStyle: ProjectConfig['platform']['pathStyle'],
): string[] {
  const normalized =
    pathStyle === 'windows'
      ? value.trim().replaceAll('\\', '/').toLowerCase()
      : value.trim()
  const parts: string[] = []
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts
}

/** Return true when either resolved path is the other path or its descendant. */
function pathsOverlap(
  left: string,
  right: string,
  pathStyle: ProjectConfig['platform']['pathStyle'],
): boolean {
  const leftParts = lexicalPathParts(left, pathStyle)
  const rightParts = lexicalPathParts(right, pathStyle)
  const prefix = (
    parent: readonly string[],
    child: readonly string[],
  ): boolean =>
    parent.length <= child.length &&
    parent.every((part, index) => child[index] === part)
  return prefix(leftParts, rightParts) || prefix(rightParts, leftParts)
}

function isPartsPrefix(
  parent: readonly string[],
  child: readonly string[],
): boolean {
  return (
    parent.length <= child.length &&
    parent.every((part, index) => child[index] === part)
  )
}

/**
 * Report writable paths that overlap the raw data, once per cause.
 *
 * A raw data directory that holds the whole project explains every collision
 * inside the project root, and one colliding directory explains its own
 * descendants, so those duplicates collapse into the owning message. The
 * refusal condition itself is unchanged: the result is non-empty exactly when
 * at least one writable path overlaps the raw data directory.
 *
 * A path that still carries a `${...}` token cannot be compared, so report it
 * rather than skipping it. Skipping would clear a configuration this check
 * never inspected.
 */
function rawdataOverlapErrors(
  cfg: ProjectConfig,
  flat: Record<string, string>,
): string[] {
  const pathStyle = cfg.platform.pathStyle
  const rawdataDir = resolveTemplate(cfg.paths.rawdataDir, flat)
  if (hasPlaceholder(rawdataDir)) {
    return [
      'Resolve every template reference in paths.rawdataDir so the writable paths can be checked against it.',
    ]
  }
  if (
    rawdataDir.length === 0 ||
    !isAbsoluteProjectRoot(rawdataDir, pathStyle)
  ) {
    return []
  }
  const writablePaths: Array<[string, string | undefined]> = [
    ['paths.derivativesDir', cfg.paths.derivativesDir],
    ['paths.outputDir', cfg.paths.outputDir],
    ['paths.qcOutputDir', cfg.paths.qcOutputDir],
    ['outputs.rootDir', cfg.outputs.rootDir],
    ['outputs.runDir', cfg.outputs.runDir],
    ['outputs.manifestPath', cfg.outputs.manifestPath],
  ]
  const collisions: Array<{ path: string; parts: string[] }> = []
  const unresolved: string[] = []
  for (const [path, raw] of writablePaths) {
    if (raw === undefined) continue
    const resolved = resolveTemplate(raw, flat)
    if (hasPlaceholder(resolved)) {
      unresolved.push(
        `Resolve every template reference in ${path} so it can be checked against paths.rawdataDir.`,
      )
      continue
    }
    if (
      resolved.length > 0 &&
      isAbsoluteProjectRoot(resolved, pathStyle) &&
      pathsOverlap(rawdataDir, resolved, pathStyle)
    ) {
      collisions.push({ path, parts: lexicalPathParts(resolved, pathStyle) })
    }
  }
  if (collisions.length === 0) return unresolved
  const errors: string[] = [...unresolved]
  const rawdataParts = lexicalPathParts(rawdataDir, pathStyle)
  const projectRoot = resolveTemplate(cfg.paths.projectRoot, flat)
  const projectParts = lexicalPathParts(projectRoot, pathStyle)
  const projectInsideRawdata =
    projectRoot.length > 0 &&
    !hasPlaceholder(projectRoot) &&
    isAbsoluteProjectRoot(projectRoot, pathStyle) &&
    isPartsPrefix(rawdataParts, projectParts)
  if (projectInsideRawdata) {
    errors.push(
      isPartsPrefix(projectParts, rawdataParts)
        ? 'Keep paths.rawdataDir separate from paths.projectRoot: they resolve to the same directory, so every writable path inside the project lands in the raw data.'
        : 'Keep paths.rawdataDir separate from paths.projectRoot: the project directory is inside the raw data directory, so every writable path inside the project lands in the raw data.',
    )
  }
  const reported: string[][] = []
  for (const collision of collisions) {
    if (projectInsideRawdata && isPartsPrefix(projectParts, collision.parts)) {
      continue
    }
    const explainedByAncestor = collisions.some(
      (other) =>
        other.parts.length < collision.parts.length &&
        isPartsPrefix(other.parts, collision.parts),
    )
    if (
      explainedByAncestor ||
      reported.some((parts) => isPartsPrefix(parts, collision.parts))
    ) {
      continue
    }
    reported.push(collision.parts)
    errors.push(`Keep ${collision.path} separate from paths.rawdataDir.`)
  }
  return errors
}

/** Return structural errors without inspecting the host filesystem or tools. */
function structuralErrors(cfg: ProjectConfig): string[] {
  const errors: string[] = []
  const actualSteps = new Set(Object.keys(cfg.steps))
  const missingSteps = STEP_KEYS.filter((key) => !actualSteps.has(key))
  const unknownSteps = [...actualSteps].filter(
    (key) => !STEP_KEYS.includes(key as StepKey),
  )
  if (missingSteps.length > 0) {
    errors.push(`Add the missing pipeline steps: ${missingSteps.join(', ')}.`)
  }
  if (unknownSteps.length > 0) {
    errors.push(`Remove unknown pipeline steps: ${unknownSteps.join(', ')}.`)
  }
  for (const [name, pattern] of Object.entries(cfg.patterns)) {
    if (!safeRelativeSegment(pattern)) {
      errors.push(
        `Use a non-empty relative single-segment glob without traversal or control characters for patterns.${name}.`,
      )
    }
  }

  for (const name of ['include', 'exclude'] as const) {
    const values = cfg.subjects[name]
    values.forEach((subjectId, index) => {
      if (!safeRelativeSegment(subjectId)) {
        errors.push(
          `Use a safe single-segment subject ID for subjects.${name}.${index}.`,
        )
      }
    })
    const duplicates = duplicateValues(values)
    if (duplicates.length > 0) {
      errors.push(
        `Remove duplicate subject IDs from subjects.${name}: ${duplicates.join(', ')}.`,
      )
    }
  }

  const flat = flattenConfig(cfg)
  const checkTemplate = (
    path: string,
    raw: string,
    options: { required?: boolean; absolute?: boolean } = {},
  ): void => {
    if (UNSAFE_CONTROL.test(raw)) {
      errors.push(`Remove NUL characters and line breaks from ${path}.`)
      return
    }
    const resolved = resolveTemplate(raw, flat)
    if (hasPlaceholder(resolved)) {
      errors.push(`Resolve every template reference in ${path}.`)
      return
    }
    if (options.required && resolved.length === 0) {
      errors.push(`Set ${path} to a non-empty path.`)
      return
    }
    if (
      resolved &&
      options.absolute &&
      !isAbsoluteProjectRoot(resolved, cfg.platform.pathStyle)
    ) {
      errors.push(`Set ${path} to an absolute path.`)
    }
  }

  const requiredProjectPaths = new Set([
    'projectRoot',
    'rawdataDir',
    'derivativesDir',
    'outputDir',
    'metadataDir',
  ])
  for (const [name, value] of Object.entries(cfg.paths)) {
    if (value === undefined) continue
    checkTemplate(`paths.${name}`, value, {
      required: requiredProjectPaths.has(name),
      absolute: true,
    })
  }
  for (const [name, value] of Object.entries(cfg.outputs)) {
    checkTemplate(`outputs.${name}`, value, { required: true, absolute: true })
  }

  errors.push(...rawdataOverlapErrors(cfg, flat))

  for (const [name, value] of Object.entries(cfg.tools)) {
    if (value !== undefined) checkTemplate(`tools.${name}`, value)
  }
  for (const [name, value] of Object.entries(cfg.pybrain)) {
    checkTemplate(`pybrain.${name}`, value)
  }

  for (const step of PIPELINE_STEPS) {
    const values = cfg.steps[step.key]?.params ?? {}
    for (const name of Object.keys(values)) {
      if (!Object.hasOwn(step.params, name)) {
        errors.push(
          `Remove undefined parameter steps.${step.key}.params.${name}.`,
        )
      }
    }
    for (const [name, spec] of Object.entries(step.params)) {
      const value = values[name]
      if (value === undefined) continue
      const path = `steps.${step.key}.params.${name}`
      switch (spec.kind) {
        case 'bool':
          if (typeof value !== 'boolean')
            errors.push(`Set ${path} to a boolean.`)
          break
        case 'int':
          if (
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < spec.min ||
            value > spec.max
          ) {
            errors.push(
              `Set ${path} to an integer from ${spec.min} through ${spec.max}.`,
            )
          }
          break
        case 'float':
          if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            (spec.min !== undefined && value < spec.min) ||
            (spec.max !== undefined && value > spec.max)
          ) {
            const bound =
              spec.min !== undefined && spec.max === undefined
                ? ` greater than or equal to ${spec.min}`
                : ''
            errors.push(`Set ${path} to a finite number${bound}.`)
          }
          break
        case 'text':
          if (typeof value !== 'string') errors.push(`Set ${path} to text.`)
          break
        case 'path':
          if (typeof value !== 'string') {
            errors.push(`Set ${path} to a path string.`)
          } else {
            checkTemplate(path, value)
          }
          break
        case 'choice':
          if (typeof value !== 'string' || !spec.options.includes(value)) {
            errors.push(`Choose one of ${spec.options.join(', ')} for ${path}.`)
          }
          break
      }
    }
  }
  return errors
}

/** One non-blocking advisory together with the stages it concerns. */
interface AdvisoryRule {
  /** The pipeline stages the advisory concerns. */
  readonly stages: readonly StepKey[]
  /** The stable message prefix that identifies the advisory in a report. */
  readonly prefix: string
  /** Builder of the message, returning null when the configuration passes. */
  readonly message: (cfg: ProjectConfig) => string | null
}

/** The prefix of the advisory that Diagnostics resolves. */
export const FREESURFER_FOLDER_ADVISORY_PREFIX = 'Set the FreeSurfer folder'

const ADVISORY_RULES: readonly AdvisoryRule[] = [
  {
    stages: ['recon'],
    prefix: FREESURFER_FOLDER_ADVISORY_PREFIX,
    message: (cfg) =>
      cfg.tools.freesurferHome
        ? null
        : 'Set the FreeSurfer folder in Diagnostics before running reconstruction.',
  },
  {
    stages: ['pybrainage'],
    prefix: 'Provision the PyBrainAge model',
    message: (cfg) =>
      cfg.pybrain.modelPath
        ? null
        : 'Provision the PyBrainAge model and set pybrain.modelPath.',
  },
  {
    stages: ['features', 'aggregate'],
    prefix: 'Set features.parcellation to aparc.a2009s',
    message: (cfg) => {
      const features = cfg.steps.features?.params['parcellation']
      if (!features || features === 'aparc.a2009s') return null
      return `Set features.parcellation to aparc.a2009s (Destrieux) before feature extraction or aggregation; replace "${String(features)}".`
    },
  },
]

/**
 * Report which pipeline stages an advisory concerns.
 *
 * A validation report carries advisories as plain strings, so callers that
 * present them per stage match a message back to its rule here.
 *
 * @param message - One message from a validation report's warnings.
 * @returns The stages it concerns, or null when it concerns them all.
 */
export function advisoryStages(message: string): readonly StepKey[] | null {
  for (const rule of ADVISORY_RULES) {
    if (message.startsWith(rule.prefix)) return rule.stages
  }
  return null
}

/** Collect non-blocking advisories about a parsed configuration. */
function advisories(cfg: ProjectConfig): string[] {
  const warnings: string[] = []
  for (const rule of ADVISORY_RULES) {
    const message = rule.message(cfg)
    if (message !== null) warnings.push(message)
  }
  return warnings
}
