/**
 * Derives dependency blockers from the discovered cohort's per-step completion.
 * This proactive cross-step gate composes with {@link computeStageBlockers} so every
 * launch surface inherits one blocked set.
 *
 * `Subject.stepStates[stepKey] === 'done'` is the completion signal. Do not use
 * matrix cells because columns shared by two steps reflect only the later producer
 * and can mask an earlier prerequisite. Read the same per-step detector during
 * sidecar submit-time preflight so the UI gate and authoritative backstop agree.
 *
 * Every analysis-cohort subject needs current evidence before a cohort-wide
 * consumer runs, and per-subject consumers are checked against that exact
 * subject, so partially processed cohorts cannot silently enter statistics.
 */

import type { WorkflowTarget } from '../../shared/contract'
import type { ProjectConfig } from '../../shared/project-schema'
import type { StageBlocker, Subject } from '../../shared/types'
import type { StepKey } from '../../shared/steps'
import {
  PIPELINE_STEPS,
  dependenciesForStep,
  pipelineStep,
} from '../../shared/steps'

/**
 * Track whether a prerequisite step has current evidence for every subject in scope.
 *
 * Read the precise per-step `stepStates` map. Treat a missing entry as not done so a
 * hand-built subject never silently unblocks. Treat an empty scope as satisfied so
 * this gate never masks the separate empty-cohort gate.
 *
 * @returns True when this prerequisite needs no further gating.
 */
function prerequisiteSatisfied(
  prereq: StepKey,
  scope: readonly Subject[],
): boolean {
  if (scope.length === 0) return true
  return scope.every((s) => s.stepStates?.[prereq] === 'done')
}

/** An actionable reason when a stage prerequisite is unmet. */
export const STEP_PREREQ_REASON: Partial<Record<StepKey, string>> = {
  enigma: 'Finish reconstruction before ENIGMA QC.',
  outliers: 'Finish ENIGMA QC before outlier review.',
  features: 'Finish reconstruction before feature extraction.',
  age: 'Finish feature extraction before age integration.',
  pybrainage: 'Finish age integration before PyBrainAge.',
  clinical: 'Finish PyBrainAge before the clinical merge.',
  brainpad: 'Finish the clinical workbook before Brain-PAD statistics.',
  aggregate: 'Finish reconstruction before structural aggregation.',
  final: 'Finish structural aggregation before the R analysis.',
  braincharts:
    'Finish feature extraction before BrainCharts normative modeling.',
  zstats:
    'Finish BrainCharts normative modeling before the z-score comparisons.',
}

/**
 * Compute which stages are blocked because an upstream step has produced nothing
 * for the subjects in scope.
 *
 * @param subjects - The discovered cohort and its per-step completion.
 * @param target - The explicit or whole-cohort workflow target.
 * @returns Dependency blockers; none for an empty cohort.
 */
export function computeDependencyBlockers(
  subjects: readonly Subject[],
  target: WorkflowTarget = { mode: 'all' },
  cfg?: ProjectConfig,
): StageBlocker[] {
  if (subjects.length === 0) return []
  const selectedScope =
    target.mode === 'all'
      ? subjects
      : subjects.filter((s) => target.subjectIds.includes(s.id))
  const blockers: StageBlocker[] = []
  for (const step of PIPELINE_STEPS) {
    const prereqs = dependenciesForStep(
      step.key,
      cfg?.steps.deface?.enabled === true,
      cfg?.steps.brainfov?.enabled === true,
    )
    if (!prereqs || prereqs.length === 0) continue
    const scope = step.scope === 'cohort' ? subjects : selectedScope
    const unmet = prereqs.find((p) => !prerequisiteSatisfied(p, scope))
    if (unmet !== undefined) {
      blockers.push({
        key: step.key,
        kind: 'dependency',
        reason:
          STEP_PREREQ_REASON[step.key] ??
          `Finish ${pipelineStep(unmet).name} before running ${pipelineStep(step.key).name}.`,
      })
    }
  }
  return blockers
}

/**
 * Merge tool blockers and dependency blockers into one step-to-reason map. Report a
 * missing tool before an unmet prerequisite because the missing tool prevents the
 * upstream output. Mirror the reason precedence used in the Runs UI.
 *
 * @param toolBlockers - Blockers from the tool gate.
 * @param depBlockers - Blockers from the dependency gate.
 * @returns One visible reason for each blocked step.
 */
export function mergeBlockedByStep(
  toolBlockers: readonly StageBlocker[],
  depBlockers: readonly StageBlocker[],
): Map<StepKey, string> {
  const map = new Map<StepKey, string>()
  for (const b of depBlockers) map.set(b.key, b.reason)
  for (const b of toolBlockers) map.set(b.key, b.reason)
  return map
}
