/**
 * Shares identical environment grouping behavior across Diagnostics and Setup.
 *
 * Every rollup, count, plan, and tally here reads the pipeline-aware
 * requirement projection from `state/env-applicability`, so only a check the
 * configured pipeline requires can raise attention. Optional and
 * not-applicable checks stay visible with their own verdict and remediation.
 */

import { STATUS_MEANING } from '../../../shared/help'
import type {
  ChipStatus,
  EnvCheck,
  EnvCheckAction,
  EnvGroup,
  EnvReport,
} from '../../../shared/types'
import type {
  CheckRequirementState,
  EnvApplicability,
} from '../../state/env-applicability'
import { requirementFor } from '../../state/env-applicability'

/** The in-progress button label for each typed action kind. */
export const ACTION_BUSY_LABEL: Record<EnvCheckAction['kind'], string> = {
  'create-directory': 'Creating the directory...',
  'setup-pybrainage': 'Setting up PyBrainAge...',
}

/** The operation phrase each typed action kind names in its refusal. */
export const ACTION_GATE_PHRASE: Record<EnvCheckAction['kind'], string> = {
  'create-directory': 'create this directory',
  'setup-pybrainage': 'set up PyBrainAge',
}

/** An environment-group rollup classification. */
export type GroupRollup = 'found' | 'warn' | 'missing'

/**
 * Map one environment check to its chip status. A missing check that the
 * configured pipeline does not require blocks nothing, so it reads as the
 * neutral not-installed state rather than as a failure.
 */
export function checkChipStatus(
  check: EnvCheck,
  requirement: CheckRequirementState = 'required',
): ChipStatus {
  return requirement !== 'required' && check.status === 'missing'
    ? 'skipped'
    : check.status
}

/** The chip label of a missing check that no stage requires. */
export const NOT_INSTALLED_LABEL = 'Not installed'

/** The meaning of a missing check that no stage requires. */
export const NOT_INSTALLED_MEANING =
  'This dependency is not installed. No configured stage requires it, so it blocks no run.'

/** Identify an unsatisfied environment check, whether or not it is required. */
export function isFailing(check: EnvCheck): boolean {
  return (
    check.status === 'missing' ||
    check.status === 'wrong' ||
    check.status === 'warn'
  )
}

/**
 * Identify an environment check that needs attention: an unsatisfied check the
 * configured pipeline requires.
 */
export function needsAttention(
  check: EnvCheck,
  applicability: EnvApplicability,
): boolean {
  return (
    requirementFor(applicability, check.id).state === 'required' &&
    isFailing(check)
  )
}

/**
 * Collect the checks in a group that the configured pipeline requires.
 *
 * @returns The required checks in display order.
 */
export function requiredChecks(
  group: EnvGroup,
  applicability: EnvApplicability,
): EnvCheck[] {
  return group.checks.filter(
    (check) => requirementFor(applicability, check.id).state === 'required',
  )
}

/**
 * Prefer missing, then wrong or warn, when rolling up the required checks in a
 * group. Ignore optional and not-applicable checks.
 */
export function rollupGroup(
  group: EnvGroup,
  applicability: EnvApplicability,
): GroupRollup {
  let warn = false
  for (const check of requiredChecks(group, applicability)) {
    if (check.status === 'missing') return 'missing'
    if (check.status === 'wrong' || check.status === 'warn') warn = true
  }
  return warn ? 'warn' : 'found'
}

/**
 * Roll every environment group into one report status.
 *
 * @param report - The environment report, or null when unavailable.
 */
export function rollupReport(
  report: EnvReport | null,
  applicability: EnvApplicability,
): GroupRollup {
  if (!report) return 'warn'
  let warn = false
  for (const group of report.groups) {
    const r = rollupGroup(group, applicability)
    if (r === 'missing') return 'missing'
    if (r === 'warn') warn = true
  }
  return warn ? 'warn' : 'found'
}

/** Describe an environment rollup in plain language. */
export function rollupLabel(r: GroupRollup): string {
  if (r === 'found') return 'All required dependencies satisfied'
  if (r === 'warn') return 'Attention needed'
  return 'Missing dependencies'
}

/** The tone and label of a whole report's status chip. */
export interface ReportSummary {
  /** The chip tone: a rollup, or neutral when the report holds no check. */
  status: ChipStatus
  /** The plain-language label. */
  label: string
}

/**
 * Summarize a whole environment report for its status chip. A report that
 * holds no check states that fact in a neutral tone, because a rollup over
 * nothing would otherwise claim that every required dependency is satisfied.
 *
 * @param report - The environment report, or null when unavailable.
 */
export function reportSummary(
  report: EnvReport | null,
  applicability: EnvApplicability,
): ReportSummary {
  if (report && report.groups.every((group) => group.checks.length === 0)) {
    return { status: 'skipped', label: 'No checks reported' }
  }
  const overall = rollupReport(report, applicability)
  return { status: overall, label: rollupLabel(overall) }
}

/** The check totals every group count label is written from. */
export interface GroupCounts {
  /** Every check in the group. */
  total: number
  /** The checks the configured pipeline requires. */
  required: number
  /** The required checks that are unsatisfied. */
  issues: number
}

/**
 * Count the checks in a group once, so that no two panels can present
 * different totals for the same group.
 */
export function groupCounts(
  group: EnvGroup,
  applicability: EnvApplicability,
): GroupCounts {
  const required = requiredChecks(group, applicability)
  return {
    total: group.checks.length,
    required: required.length,
    issues: required.filter(isFailing).length,
  }
}

/**
 * State how many checks a group holds and how many of them the configured
 * pipeline requires. Name only the total when it requires none of them.
 */
export function groupCountSummary(
  group: EnvGroup,
  applicability: EnvApplicability,
): string {
  const { total, required } = groupCounts(group, applicability)
  const checks = `${total} ${total === 1 ? 'check' : 'checks'}`
  return required === 0
    ? `${checks}, none required`
    : `${checks}, ${required} required`
}

/**
 * Add the required-check verdict to the shared count summary, so that one
 * label carries both the counts and their outcome.
 */
export function groupCountLabel(
  group: EnvGroup,
  applicability: EnvApplicability,
): string {
  const { required, issues } = groupCounts(group, applicability)
  const summary = groupCountSummary(group, applicability)
  if (required === 0) return summary
  if (issues > 0)
    return `${summary}, ${issues} ${issues === 1 ? 'issue' : 'issues'}`
  return `${summary}, all found`
}

/** A MATLAB Runtime installation the environment probe found on its own. */
export interface DetectedRuntime {
  /** The runtime root, or an empty string when the detail names none. */
  path: string
  /** The release token, or an empty string when the detail names none. */
  version: string
}

/**
 * The first absolute path in a detail sentence, with the parenthetical that
 * follows it. The probe writes the root it used and the release it inferred in
 * that order.
 */
const DETAIL_LOCATION =
  /(?:^|\s)((?:[A-Za-z]:[\\/]|\/)[^\s()]*)(?:\s+\(([^)]*)\))?/

/**
 * Read the MATLAB Runtime installation the environment probe resolved on its
 * own, so a runtime found in a default location or on PATH is not reported as
 * unconfigured.
 *
 * The environment contract carries no structured path field, so read the
 * location out of the detail sentence the probe writes. Report a detected
 * runtime with an empty path when the sentence names none, which still
 * separates a detected runtime from an absent one.
 *
 * @param check - The runtime check, or undefined before it runs.
 * @returns The detected runtime, or null when none was detected.
 */
export function detectedRuntime(
  check: EnvCheck | undefined,
): DetectedRuntime | null {
  if (!check || check.status !== 'found') return null
  const match = DETAIL_LOCATION.exec(check.detail ?? '')
  if (!match) return { path: '', version: '' }
  // The probe names an inferred release as `<release> == <version>` and an
  // unrecognized one as `runtime`; keep only a real release token.
  const release = (match[2] ?? '').split('==')[0]?.trim() ?? ''
  return {
    path: match[1] ?? '',
    version: release === 'runtime' ? '' : release,
  }
}

/** Prefix stable disclosure IDs to prevent collisions between screens. */
export function groupSlug(group: EnvGroup, prefix = 'diag'): string {
  return `${prefix}-group-${group.name.replace(/\s+/g, '-').toLowerCase()}`
}

/** Expand groups with required failures and collapse the rest initially. */
export function seedExpansion(
  groups: EnvGroup[],
  applicability: EnvApplicability,
): Record<string, boolean> {
  const next: Record<string, boolean> = {}
  for (const group of groups) {
    next[group.name] = rollupGroup(group, applicability) !== 'found'
  }
  return next
}

/** Re-seed disclosure state when any group name or verdict changes. */
export function groupSignature(
  groups: EnvGroup[],
  applicability: EnvApplicability,
): string {
  return groups
    .map((g) => `${g.name}:${rollupGroup(g, applicability)}`)
    .join('|')
}

/** Return the shared plain-language meaning for a check verdict. */
export function statusMeaning(status: string): string {
  return STATUS_MEANING[status] ?? ''
}

/** Environment verdicts ordered from satisfied through skipped. */
export const VERDICT_ORDER: readonly EnvCheck['status'][] = [
  'found',
  'warn',
  'wrong',
  'missing',
  'skipped',
]

/**
 * Aggregate the commands of every required failing check into one strict shell
 * script. Leave optional and not-applicable remediations to their own rows.
 * Return an empty string when no remediation applies, so a plan with nothing
 * to run is never offered as a copyable script.
 *
 * @param report - The environment report, or null when unavailable.
 * @returns The strict installation script, or an empty string.
 */
export function buildInstallPlan(
  report: EnvReport | null,
  applicability: EnvApplicability,
): string {
  if (!report) return ''
  const header: string[] = ['#!/usr/bin/env bash', 'set -euo pipefail', '']
  const lines: string[] = []
  for (const group of report.groups) {
    const failing = group.checks.filter(
      (c) => needsAttention(c, applicability) && Boolean(c.recommendedCmd),
    )
    if (failing.length === 0) continue
    lines.push(`# ${group.name}`)
    for (const check of failing) {
      if (check.recommendedCmd) {
        lines.push(`# ${check.label}`)
        lines.push(check.recommendedCmd)
      }
    }
    lines.push('')
  }
  if (lines.length === 0) return ''
  return [...header, ...lines].join('\n').trimEnd()
}

/** The rank placing missing above wrong and warn when choosing the top fix. */
export const STATUS_RANK: Record<EnvCheck['status'], number> = {
  missing: 0,
  wrong: 1,
  warn: 2,
  found: 3,
  skipped: 4,
}

/**
 * Pick the first highest-priority failing check across the report.
 *
 * @param report - The environment report, or null when unavailable.
 * @param allowedIds - Restrict candidates to these check IDs when supplied.
 * @returns The highest-priority allowed failure when one exists.
 */
export function pickTopFix(
  report: EnvReport | null,
  allowedIds?: ReadonlySet<string>,
): EnvCheck | undefined {
  if (!report) return undefined
  let best: EnvCheck | undefined
  let bestRank = STATUS_RANK.found
  for (const group of report.groups) {
    for (const check of group.checks) {
      if (allowedIds && !allowedIds.has(check.id)) continue
      const rank = STATUS_RANK[check.status]
      if (rank < bestRank && rank <= STATUS_RANK.warn) {
        best = check
        bestRank = rank
      }
    }
  }
  return best
}

/**
 * Missing and wrong checks, treated as advisory in Setup. Defer hard blocking
 * to per-stage runtime gates.
 */
export const CRITICAL_STATUSES: ReadonlyArray<EnvCheck['status']> = [
  'missing',
  'wrong',
]

/**
 * Count satisfied, advisory, and missing checks among the checks the
 * configured pipeline requires. Match the Diagnostics rollups exactly.
 */
export function tallyEnv(
  report: EnvReport,
  applicability: EnvApplicability,
): {
  found: number
  warn: number
  missing: number
  criticals: EnvCheck[]
} {
  let found = 0
  let warn = 0
  let missing = 0
  const criticals: EnvCheck[] = []
  for (const g of report.groups) {
    for (const c of requiredChecks(g, applicability)) {
      if (c.status === 'found') found += 1
      else if (c.status === 'warn') warn += 1
      else if (c.status === 'missing' || c.status === 'wrong') missing += 1
      if (CRITICAL_STATUSES.includes(c.status)) criticals.push(c)
    }
  }
  return { found, warn, missing, criticals }
}
