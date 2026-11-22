/** Describes the source identity recorded when Supraspina was built. */

import { formatAppVersion } from '../../scripts/app-version.mjs'

/** Every relation a build can have to the release tag of its version. */
export const BUILD_KINDS = ['release', 'development', 'unknown'] as const

/**
 * How a build relates to its version's release: `release` for a clean tree at
 * the annotated `v<version>` tag, `development` for any other commit, and
 * `unknown` when no build record names a commit.
 */
export type BuildKind = (typeof BUILD_KINDS)[number]

/** The source identity of one build. */
export interface BuildIdentity {
  kind: BuildKind
  /** The full source commit, or an empty string for an unknown build. */
  commit: string
  /** Whether tracked files differed from the commit when it was built. */
  dirty: boolean
}

/** The identity of a build that records no source commit. */
export const UNKNOWN_BUILD_IDENTITY: Readonly<BuildIdentity> = Object.freeze({
  kind: 'unknown',
  commit: '',
  dirty: false,
})

// Accept SHA-1 and SHA-256 object IDs in full; never an abbreviation.
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const SHORT_COMMIT_LENGTH = 7

/**
 * Validate a recorded build identity, falling back to the unknown identity.
 *
 * A release must be clean, and every known build must name a full commit, so
 * a malformed or contradictory record never claims to be a release.
 *
 * @returns The validated identity, or the unknown identity.
 */
export function parseBuildIdentity(value: unknown): BuildIdentity {
  if (typeof value !== 'object' || value === null) {
    return { ...UNKNOWN_BUILD_IDENTITY }
  }
  const { kind, commit, dirty } = value as Record<string, unknown>
  if (
    typeof commit !== 'string' ||
    !OBJECT_ID.test(commit) ||
    typeof dirty !== 'boolean'
  ) {
    return { ...UNKNOWN_BUILD_IDENTITY }
  }
  if (kind === 'development' || (kind === 'release' && !dirty)) {
    return { kind, commit, dirty }
  }
  return { ...UNKNOWN_BUILD_IDENTITY }
}

/**
 * Describe a product version together with the build that carries it.
 *
 * @param version - The machine-form product version, such as `20261121.1830.0`.
 * @returns `2026-11-21 18:30 UTC` for the release build,
 *   `2026-11-21 18:30 UTC, development build 1a2b3c4` for another commit (with
 *   ` (modified)` when it was built with changed tracked files), or
 *   `2026-11-21 18:30 UTC, source commit unknown`.
 */
export function describeProductVersion(
  version: string,
  build: BuildIdentity,
): string {
  const shown = formatAppVersion(version)
  switch (build.kind) {
    case 'release':
      return shown
    case 'development':
      return `${shown}, development build ${shortBuildCommit(build)}${
        build.dirty ? ' (modified)' : ''
      }`
    case 'unknown':
      return `${shown}, source commit unknown`
  }
}

/**
 * Return the abbreviated commit that {@link describeProductVersion} names for
 * a development build, so a view can set that hash apart as code.
 *
 * @returns The short commit, or null when the description names none.
 * @example
 * shortBuildCommit({ kind: 'development', commit: 'a'.repeat(40), dirty: false })
 * // 'aaaaaaa'
 */
export function shortBuildCommit(build: BuildIdentity): string | null {
  return build.kind === 'development'
    ? build.commit.slice(0, SHORT_COMMIT_LENGTH)
    : null
}
