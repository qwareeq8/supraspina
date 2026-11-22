/** Declares the build-identity helpers that the electron-vite config imports. */

/** The source identity recorded for one Supraspina build. */
export interface BuildIdentityRecord {
  kind: 'release' | 'development' | 'unknown'
  commit: string
  dirty: boolean
}

/** The build record file that the frozen sidecar reads from its metadata. */
export const BUILD_IDENTITY_FILE: string

/** The identity of a build whose source commit could not be read. */
export const UNKNOWN_BUILD_IDENTITY: Readonly<BuildIdentityRecord>

/** Classify a build from the repository state it is built from. */
export function resolveBuildIdentity(options: {
  version: string
  git: (...args: string[]) => string
}): BuildIdentityRecord

/** Read the build identity of the repository that holds the script. */
export function readBuildIdentity(options?: {
  repository?: string
}): BuildIdentityRecord

/** Write the versioned build record that the frozen sidecar embeds. */
export function writeBuildIdentity(
  output: string,
  options?: { repository?: string },
): BuildIdentityRecord & { schemaVersion: number; version: string }
