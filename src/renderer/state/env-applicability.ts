/**
 * Projects the environment report onto the pipeline configuration so every
 * environment surface agrees about which checks the configured pipeline
 * actually requires.
 *
 * The requirement table in `shared/steps.ts` is the single source of truth. A
 * check is `required` exactly when {@link requiredEnvCheckIdsForStep} resolves
 * it for an enabled stage, so this projection and the run gate in
 * `computeStageBlockers` can never disagree. A check that a stage requirement
 * names only through a disabled stage, an unselected configured choice, or an
 * unmet condition is `not-applicable`. A check that no stage requirement names
 * at all is `optional`: it stays visible and inspectable, but it gates nothing.
 *
 * Optional and not-applicable checks never contribute to attention, rollups,
 * counts, installation plans, or Setup readiness.
 */

import type { EnvReport } from '../../shared/types'
import type { ProjectConfig } from '../../shared/project-schema'
import type { CheckRequirement, StepKey } from '../../shared/steps'
import { STEP_CHECK_REQUIREMENTS } from '../../shared/steps'
import { requiredEnvCheckIdsForStep } from './stage-blockers'

/** How the configured pipeline relates to one environment check. */
export type CheckRequirementState = 'required' | 'optional' | 'not-applicable'

/** One environment check's requirement state and the stages that name it. */
export interface EnvCheckRequirement {
  readonly state: CheckRequirementState
  /**
   * The stages that require the check, or, for a not-applicable check, the
   * stages that would require it under another configuration.
   */
  readonly owningSteps: readonly StepKey[]
}

/** The requirement state of every check any pipeline stage can name. */
export type EnvApplicability = ReadonlyMap<string, EnvCheckRequirement>

/** The state of a check that no pipeline stage requirement names. */
const OPTIONAL: EnvCheckRequirement = { state: 'optional', owningSteps: [] }

/**
 * Collect every check ID a stage requirement can name under any configuration.
 *
 * @returns The union of check IDs across all requirement branches.
 */
function declaredCheckIds(requirements: readonly CheckRequirement[]): string[] {
  const ids: string[] = []
  for (const requirement of requirements) {
    if (requirement.kind === 'configured-choice') {
      for (const choice of Object.values(requirement.choices)) {
        ids.push(...choice)
      }
      continue
    }
    ids.push(...requirement.ids)
  }
  return ids
}

/**
 * Derive the requirement state of every check the pipeline stages can name.
 *
 * @returns The requirement state indexed by check ID.
 */
export function envApplicability(
  env: EnvReport,
  cfg?: ProjectConfig,
): EnvApplicability {
  const states = new Map<
    string,
    { state: CheckRequirementState; owningSteps: StepKey[] }
  >()
  for (const rawKey of Object.keys(STEP_CHECK_REQUIREMENTS)) {
    const key = rawKey as StepKey
    const required = new Set(requiredEnvCheckIdsForStep(key, env, cfg))
    for (const id of declaredCheckIds(STEP_CHECK_REQUIREMENTS[key] ?? [])) {
      const state: CheckRequirementState = required.has(id)
        ? 'required'
        : 'not-applicable'
      const prior = states.get(id)
      if (!prior) {
        states.set(id, { state, owningSteps: [key] })
        continue
      }
      // Let one requiring stage outrank every stage that excludes the check,
      // and list each stage exactly once per resolved state.
      if (prior.state === state) {
        if (!prior.owningSteps.includes(key)) prior.owningSteps.push(key)
        continue
      }
      if (state === 'required') {
        states.set(id, { state, owningSteps: [key] })
      }
    }
  }
  return states
}

/**
 * Resolve one check's requirement state, defaulting to optional.
 *
 * @returns The check's requirement state and owning stages.
 */
export function requirementFor(
  applicability: EnvApplicability,
  id: string,
): EnvCheckRequirement {
  return applicability.get(id) ?? OPTIONAL
}

/** Collect every check ID the configured pipeline requires. */
export function requiredCheckIds(
  applicability: EnvApplicability,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const [id, entry] of applicability) {
    if (entry.state === 'required') ids.add(id)
  }
  return ids
}

/** The badge shown beside a check that the configured pipeline does not need. */
export const REQUIREMENT_BADGE: Readonly<
  Record<Exclude<CheckRequirementState, 'required'>, string>
> = {
  optional: 'Optional',
  'not-applicable': 'Not needed for this pipeline',
}

/** The plain-language meaning of each non-required requirement state. */
export const REQUIREMENT_MEANING: Readonly<
  Record<Exclude<CheckRequirementState, 'required'>, string>
> = {
  optional:
    'No pipeline stage requires this check, so it never blocks a run. It matters only when you use the tool yourself.',
  'not-applicable':
    'The current pipeline configuration does not use this check. Another stage, backend, or tool choice would require it.',
}
