#!/usr/bin/env node
/** Read-only preflight for the GitHub release authority under the mutable-release policy. */

import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const EXPECTED_REPOSITORY = 'qwareeq8/supraspina'
const MAIN_REF = 'refs/heads/main'
const STABLE_TAG_REF = 'refs/tags/v*'

/** Rule types that ordinary `main` history protection must provide. */
export const REQUIRED_MAIN_RULES = Object.freeze([
  'deletion',
  'non_fast_forward',
])

/**
 * Rule types that must not apply to `main`.
 *
 * `update` freezes the branch outright. The remaining types would impose a
 * universal pull-request, review, signature, naming, or hosted-status-check
 * requirement that no repository-specific contract asks for.
 */
export const FORBIDDEN_MAIN_RULES = Object.freeze([
  'update',
  'pull_request',
  'required_signatures',
  'required_status_checks',
  'branch_name_pattern',
  'required_deployments',
])

/**
 * Rule types that must not apply to stable version tags.
 *
 * The current policy keeps published tags technically mutable. Tag creation
 * may still be restricted, because restricting creation does not prohibit
 * updating or deleting an existing tag.
 */
export const FORBIDDEN_TAG_RULES = Object.freeze([
  'deletion',
  'non_fast_forward',
  'update',
])

/** Ref-name tokens that select every branch or the default branch. */
const BRANCH_WILDCARDS = Object.freeze(['~ALL', '~DEFAULT_BRANCH'])

function ruleTypes(ruleset) {
  if (!Array.isArray(ruleset?.rules)) return new Set()
  return new Set(
    ruleset.rules
      .map((rule) => rule?.type)
      .filter((type) => typeof type === 'string'),
  )
}

function includedRefs(ruleset) {
  const includes = ruleset?.conditions?.ref_name?.include
  return Array.isArray(includes) ? includes : []
}

function excludedRefs(ruleset) {
  const excludes = ruleset?.conditions?.ref_name?.exclude
  return Array.isArray(excludes) ? excludes : []
}

function isActive(ruleset) {
  return ruleset?.enforcement === 'active'
}

/**
 * Report whether one active ruleset governs the `main` branch.
 *
 * @param {object} ruleset - A complete GitHub ruleset record.
 * @returns {boolean}
 */
export function appliesToMain(ruleset) {
  if (!isActive(ruleset) || ruleset.target !== 'branch') return false
  if (excludedRefs(ruleset).includes(MAIN_REF)) return false
  return includedRefs(ruleset).some(
    (ref) => ref === MAIN_REF || BRANCH_WILDCARDS.includes(ref),
  )
}

/**
 * Report whether one active ruleset governs stable `v*` version tags.
 *
 * @param {object} ruleset - A complete GitHub ruleset record.
 * @returns {boolean}
 */
export function appliesToStableTags(ruleset) {
  if (!isActive(ruleset) || ruleset.target !== 'tag') return false
  return includedRefs(ruleset).some(
    (ref) => ref === STABLE_TAG_REF || ref === '~ALL',
  )
}

function protectsMain(ruleset, ruleType) {
  const includes = includedRefs(ruleset)
  return (
    isActive(ruleset) &&
    ruleset.target === 'branch' &&
    includes.length === 1 &&
    includes[0] === MAIN_REF &&
    excludedRefs(ruleset).length === 0 &&
    Array.isArray(ruleset.bypass_actors) &&
    ruleset.bypass_actors.length === 0 &&
    ruleTypes(ruleset).has(ruleType)
  )
}

/**
 * Verify repository identity, mutable releases, and ordinary main protection.
 *
 * The repository owner has chosen to keep GitHub immutable tags and releases
 * off. This check therefore requires that the platform-level immutability
 * setting stays disabled, that no ruleset prohibits updating or deleting a
 * stable version tag, and that `main` keeps ordinary deletion and
 * force-push protection without a bypass actor or a permanent freeze.
 *
 * @param {object} input - Read-only GitHub API observations.
 * @param {object} input.repository
 * @param {object} input.immutableReleases
 * @param {object[]} input.rulesets
 * @throws {Error} On the wrong repository or an incorrect release policy.
 */
export function validateGitHubReleaseSettings({
  repository,
  immutableReleases,
  rulesets,
}) {
  if (
    repository === null ||
    typeof repository !== 'object' ||
    Array.isArray(repository) ||
    repository.full_name !== EXPECTED_REPOSITORY ||
    repository.default_branch !== 'main'
  ) {
    throw new Error(
      `Use ${EXPECTED_REPOSITORY} with main as its explicit default branch.`,
    )
  }
  // The in-app updater reads releases without credentials.
  if (repository.private !== false) {
    throw new Error(
      `Make ${EXPECTED_REPOSITORY} public so packaged builds can read its releases.`,
    )
  }
  if (immutableReleases?.enabled !== false) {
    throw new Error(
      'Keep GitHub immutable releases disabled under the current release policy.',
    )
  }
  if (immutableReleases?.enforced_by_owner === true) {
    throw new Error(
      'Keep organization-level release immutability off for this repository.',
    )
  }
  if (!Array.isArray(rulesets)) {
    throw new Error('Inspect the complete GitHub repository rulesets.')
  }

  for (const type of REQUIRED_MAIN_RULES) {
    if (!rulesets.some((ruleset) => protectsMain(ruleset, type))) {
      throw new Error(
        `Protect main branch with an active, no-bypass ${type} rule targeting ${MAIN_REF}.`,
      )
    }
  }

  for (const ruleset of rulesets) {
    if (!appliesToMain(ruleset)) continue
    if (
      Array.isArray(ruleset.bypass_actors) &&
      ruleset.bypass_actors.length > 0
    ) {
      throw new Error(
        `Remove every bypass actor from the main ruleset: ${ruleset.name}.`,
      )
    }
    const types = ruleTypes(ruleset)
    for (const forbidden of FORBIDDEN_MAIN_RULES) {
      if (types.has(forbidden)) {
        throw new Error(
          `Remove the ${forbidden} rule from the main ruleset: ${ruleset.name}. Ordinary fast-forward history must stay permitted.`,
        )
      }
    }
  }

  for (const ruleset of rulesets) {
    if (!appliesToStableTags(ruleset)) continue
    const types = ruleTypes(ruleset)
    for (const forbidden of FORBIDDEN_TAG_RULES) {
      if (types.has(forbidden)) {
        throw new Error(
          `Remove the ${forbidden} rule from the stable-tag ruleset: ${ruleset.name}. The current policy keeps published tags mutable and relies on newly stamped versions for corrections.`,
        )
      }
    }
  }
}

function ghJson(args) {
  const output = execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    return JSON.parse(output)
  } catch {
    throw new Error(`Require JSON from: gh ${args.join(' ')}.`)
  }
}

/**
 * Read the current GitHub settings without changing repository state.
 *
 * @param {string} [repository] - The canonical repository name.
 * @returns {object} Repository, immutable-release, and full ruleset data.
 */
export function inspectGitHubReleaseSettings(repository = EXPECTED_REPOSITORY) {
  if (repository !== EXPECTED_REPOSITORY) {
    throw new Error(`Inspect only ${EXPECTED_REPOSITORY}.`)
  }
  const repositoryState = ghJson(['api', `repos/${repository}`])
  const immutableReleases = ghJson([
    'api',
    `repos/${repository}/immutable-releases`,
  ])
  const summaries = ghJson([
    'api',
    `repos/${repository}/rulesets?includes_parents=true&per_page=100`,
  ])
  if (!Array.isArray(summaries)) {
    throw new Error('Require the GitHub ruleset inventory as an array.')
  }
  const ids = [...new Set(summaries.map((ruleset) => ruleset?.id))]
  if (
    ids.length !== summaries.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new Error('Require unique numeric GitHub ruleset IDs.')
  }
  const rulesets = ids.map((id) =>
    ghJson(['api', `repos/${repository}/rulesets/${id}`]),
  )
  return { repository: repositoryState, immutableReleases, rulesets }
}

function main() {
  if (process.argv.length !== 2) {
    throw new Error('Run node scripts/check-github-release-settings.mjs.')
  }
  const settings = inspectGitHubReleaseSettings()
  validateGitHubReleaseSettings(settings)
  console.log(
    'Verified public main, disabled immutable releases, mutable release tags, and no-bypass main history protection.',
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
