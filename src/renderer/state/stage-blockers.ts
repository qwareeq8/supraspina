/**
 * Derives stage blockers from required tools in the environment report. Only the
 * report is read; the sidecar owns tool-byte inspection. This map is the proactive
 * Run-button gate, and sidecar preflight is the authoritative backstop. Every
 * required check counts as unavailable unless its status is exactly `found` so both
 * gates agree.
 */

import type { EnvCheck, EnvReport, StageBlocker } from '../../shared/types'
import type { ProjectConfig } from '../../shared/project-schema'
import type { StepKey } from '../../shared/steps'
import { defaultParams, STEP_CHECK_REQUIREMENTS } from '../../shared/steps'

/** Index every environment check by ID and status across all groups. */
export function envStatusIndex(env: EnvReport): Map<string, string> {
  const status = new Map<string, string>()
  for (const group of env.groups) {
    for (const check of group.checks) status.set(check.id, check.status)
  }
  return status
}

/**
 * Index every environment check by ID across all groups.
 *
 * @returns Each check indexed by its ID; a later group wins a duplicate ID, as
 *   in {@link envStatusIndex}.
 */
function envCheckIndex(env: EnvReport): Map<string, EnvCheck> {
  const checks = new Map<string, EnvCheck>()
  for (const group of env.groups) {
    for (const check of group.checks) checks.set(check.id, check)
  }
  return checks
}

/** The check that owns the acquisition of the reviewed scientific assets. */
const SCIENTIFIC_ASSETS_CHECK_ID = 'scientific_assets'

/**
 * Return whether a check verifies acquired scientific assets rather than a
 * host tool or backend: the acquisition itself or a stage asset check.
 *
 * @example
 * isScientificAssetCheck('enigma_assets') // true
 */
export function isScientificAssetCheck(id: string): boolean {
  return id === SCIENTIFIC_ASSETS_CHECK_ID || id.endsWith('_assets')
}

/** Each supported ENIGMA QC backend ID with its environment-check ID. */
const ENIGMA_BACKEND_CHECKS: ReadonlyArray<readonly [string, string]> = [
  ['matlab', 'matlab'],
  ['mcr', 'mcr'],
]

/**
 * Resolve the ENIGMA QC backend the step will run with.
 *
 * Mirror the sidecar `effective_enigma_backend` rule: keep an explicit
 * `matlab` or `mcr` choice, and resolve `auto` to the first backend whose
 * check is `found`, preferring source MATLAB, or to `matlab` when neither is.
 *
 * @param cfg - The project configuration, or null or undefined before a project
 *   opens.
 * @param env - The environment report, or null before the first probe.
 * @returns `matlab` or `mcr`.
 */
export function effectiveEnigmaBackend(
  cfg: ProjectConfig | null | undefined,
  env: EnvReport | null,
): 'matlab' | 'mcr' {
  const configured = String(cfg?.steps.enigma?.params['backend'] ?? 'auto')
  if (configured === 'matlab' || configured === 'mcr') return configured
  const status = env ? envStatusIndex(env) : new Map<string, string>()
  for (const [backend, checkId] of ENIGMA_BACKEND_CHECKS) {
    if (status.get(checkId) === 'found') return backend as 'matlab' | 'mcr'
  }
  return 'matlab'
}

/**
 * Derive the ENIGMA QC backends that the host cannot run. Offer a backend only when
 * its backing check is `found`, matching the sidecar `viable_enigma_backends` rule.
 * Disable the matching option when the host lacks licensed MATLAB or the supported
 * MATLAB Runtime.
 *
 * @param env - The latest environment report, or null before the first report.
 * @returns Disabled backend IDs; none before the first report.
 */
export function unavailableEnigmaBackends(env: EnvReport | null): string[] {
  if (!env) return []
  const status = envStatusIndex(env)
  const unavailable = ENIGMA_BACKEND_CHECKS.filter(
    ([, checkId]) => status.get(checkId) !== 'found',
  ).map(([backend]) => backend)
  // Automatic selection is usable while any backend is.
  return unavailable.length === ENIGMA_BACKEND_CHECKS.length
    ? ['auto', ...unavailable]
    : unavailable
}

/** An actionable reason when missing tools block a step. */
export const STEP_BLOCK_REASON: Partial<Record<StepKey, string>> = {
  recon: 'Install or configure the selected reconstruction backend.',
  features:
    'Install the feature-extraction tools required by the reconstruction backend.',
  outliers: 'Add Rscript to PATH for histogram and outlier review.',
  pybrainage: 'Provision the pinned PyBrainAge model and scaler.',
  final:
    'Install the R and report-rendering tools required for the R analysis.',
  braincharts:
    'Set up the BrainCharts model and runtime in Scientific resources.',
  zstats:
    'Install the R and report-rendering tools required for the z-score comparisons.',
}

/**
 * Resolve the exact environment checks one configured, enabled stage requires.
 * Share this resolution between proactive run gating and Diagnostics triage. Do not
 * present an optional alternative or disabled stage as a run blocker.
 */
export function requiredEnvCheckIdsForStep(
  key: StepKey,
  env: EnvReport,
  cfg?: ProjectConfig,
): string[] {
  if (cfg?.steps[key]?.enabled === false) return []

  const status = envStatusIndex(env)
  const resolved: string[] = []
  for (const requirement of STEP_CHECK_REQUIREMENTS[key] ?? []) {
    if (requirement.kind === 'all') {
      resolved.push(...requirement.ids)
      continue
    }
    if (requirement.kind === 'configured-choice') {
      const selected =
        requirement.configPath === 'steps.enigma.params.backend'
          ? effectiveEnigmaBackend(cfg, env)
          : requirement.configPath === 'steps.deface.params.tool'
            ? String(cfg?.steps.deface?.params['tool'] ?? 'mri_deface')
            : String(cfg?.steps.recon?.params['backend'] ?? 'freesurfer')
      const selectedChecks = requirement.choices[selected]
      resolved.push(...(selectedChecks ?? [selected]))
      continue
    }
    const reportStep =
      requirement.when === 'steps.final.params.renderReport !== false'
        ? 'final'
        : requirement.when === 'steps.zstats.params.renderReport !== false'
          ? 'zstats'
          : null
    if (reportStep) {
      // Resolve the parameter against its declared schema default, because a
      // saved project may omit it entirely. The sidecar reads the same default,
      // so only an explicit false drops the report-rendering requirements.
      const renderReport =
        cfg?.steps[reportStep]?.params['renderReport'] ??
        defaultParams(reportStep)['renderReport']
      if (renderReport !== false) resolved.push(...requirement.ids)
      continue
    }
    if (
      requirement.when === 'env.display !== found' &&
      status.get('display') !== 'found'
    ) {
      resolved.push(...requirement.ids)
      continue
    }
    // The sidecar decides its WSL-only requirements from the live host, and it
    // reports the same decision by skipping the WSL-only checks off WSL.
    if (
      requirement.when === 'env.wslpath !== skipped' &&
      status.get('wslpath') !== undefined &&
      status.get('wslpath') !== 'skipped'
    ) {
      resolved.push(...requirement.ids)
    }
  }
  return [...new Set(resolved)]
}

/** Collect exact check IDs for every enabled configured stage. */
export function requiredEnvCheckIds(
  env: EnvReport,
  cfg?: ProjectConfig,
): Set<string> {
  const ids = new Set<string>()
  for (const rawKey of Object.keys(STEP_CHECK_REQUIREMENTS)) {
    const key = rawKey as StepKey
    for (const id of requiredEnvCheckIdsForStep(key, env, cfg)) ids.add(id)
  }
  return ids
}

/**
 * List the scientific-asset checks that one configured, enabled stage requires
 * and the report does not show as `found`.
 *
 * @returns The stage's unsatisfied asset-check IDs.
 */
export function missingAssetCheckIds(
  key: StepKey,
  env: EnvReport,
  cfg?: ProjectConfig,
): string[] {
  const status = envStatusIndex(env)
  return requiredEnvCheckIdsForStep(key, env, cfg).filter(
    (id) => isScientificAssetCheck(id) && status.get(id) !== 'found',
  )
}

/** Join names as "A", "A and B", or "A, B, and C". */
function listPhrase(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/**
 * Word the fix for unsatisfied scientific-asset checks by the acquisition the
 * sidecar reports: an offline rebuild from the verified files on this host, an
 * acquisition of the pinned archive, or a repair of an acquired set whose
 * files no longer verify.
 */
function assetBlockReason(ids: readonly string[], env: EnvReport): string {
  const checks = envCheckIndex(env)
  const acquisition = checks.get(SCIENTIFIC_ASSETS_CHECK_ID)
  const restored = listPhrase(
    ids
      .filter((id) => id !== SCIENTIFIC_ASSETS_CHECK_ID)
      .map((id) => checks.get(id)?.label ?? id),
  )
  if (acquisition && acquisition.status !== 'found') {
    if (acquisition.offlineInstall === true) {
      return restored
        ? `Rebuild the scientific assets to restore the ${restored}.`
        : 'Rebuild the scientific assets.'
    }
    return restored
      ? `Acquire the scientific assets to install the ${restored}.`
      : 'Acquire the scientific assets.'
  }
  return `Repair the ${restored || 'scientific assets'}; Diagnostics lists the files that fail verification.`
}

/**
 * Name what blocks one stage. The ENIGMA QC backend is named only when its own
 * check is missing, scientific-asset checks are named by their display labels
 * with the fix the acquisition allows, and every other tool is named by its
 * display label with Diagnostics as the place to install it.
 */
function environmentBlockReason(
  key: StepKey,
  missing: readonly string[],
  env: EnvReport,
  cfg?: ProjectConfig,
): string {
  if (key === 'deface') {
    return `Provide every required executable and asset check for the configured defacing tool, ${String(cfg?.steps.deface?.params['tool'] ?? 'mri_deface')}.`
  }
  const assets = missing.filter(isScientificAssetCheck)
  const tools = missing.filter((id) => !isScientificAssetCheck(id))
  const checks = envCheckIndex(env)
  const install = (ids: readonly string[]): string =>
    `Install in Diagnostics: ${listPhrase(ids.map((id) => checks.get(id)?.label ?? id))}.`
  const parts: string[] = []
  if (key === 'enigma') {
    const backend = effectiveEnigmaBackend(cfg, env)
    const backendCheck =
      ENIGMA_BACKEND_CHECKS.find(([id]) => id === backend)?.[1] ?? backend
    if (tools.includes(backendCheck)) {
      parts.push(
        `Provide the required environment check for the ENIGMA QC backend, ${backend}.`,
      )
    }
    const others = tools.filter((id) => id !== backendCheck)
    if (others.length > 0) {
      parts.push(install(others))
    }
  } else if (tools.length > 0) {
    parts.push(
      `${STEP_BLOCK_REASON[key] ?? `Resolve the ${key} stage block.`} ${install(tools)}`,
    )
  }
  if (assets.length > 0) parts.push(assetBlockReason(assets, env))
  return parts.join(' ')
}

/**
 * Compute which pipeline stages are blocked by missing environment pieces.
 *
 * Require FreeSurfer for reconstruction and features, R for outliers and final
 * analysis, model assets for PyBrainAge, and one viable ENIGMA QC backend. Check
 * only for FreeSurfer license presence here.
 *
 * @param env - The latest environment report, or null before the first report.
 * @returns Blocked stages with reasons; none before the first report.
 */
export function computeStageBlockers(
  env: EnvReport | null,
  cfg?: ProjectConfig,
): StageBlocker[] {
  const blockers: StageBlocker[] = []
  if (!env) return blockers
  const status = envStatusIndex(env)
  // Treat a required check as bad unless it is explicitly `found`, matching the
  // sidecar `missing_required_checks` rule. Include absent, `missing`, `wrong`,
  // `warn`, and `skipped` states so the proactive and authoritative gates agree.
  const isBad = (id: string): boolean => status.get(id) !== 'found'
  for (const rawKey of Object.keys(STEP_CHECK_REQUIREMENTS)) {
    const key = rawKey as StepKey
    const missing = requiredEnvCheckIdsForStep(key, env, cfg).filter(isBad)
    if (missing.length > 0) {
      blockers.push({
        key,
        kind: 'environment',
        reason: environmentBlockReason(key, missing, env, cfg),
      })
    }
  }

  const featureParams = cfg?.steps.features?.params
  const featureContractInvalid =
    featureParams !== undefined &&
    (featureParams['parcellation'] !== 'aparc.a2009s' ||
      featureParams['measure'] !== 'thickness' ||
      featureParams['validateFeatureOrder'] !== true)
  if (featureContractInvalid) {
    for (const key of ['pybrainage', 'clinical', 'brainpad'] as const) {
      blockers.push({
        key,
        kind: 'config',
        reason:
          'PyBrainAge prediction and every stage after it need validated Destrieux thickness features (aparc.a2009s).',
        action:
          'Set FreeSurfer feature extraction to aparc.a2009s thickness with feature-order validation enabled.',
      })
    }
  }
  return blockers
}
