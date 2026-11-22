/**
 * Records the source commit and release state of one Supraspina build.
 *
 * The electron-vite config imports this module, and its loader cannot parse a
 * shebang, so run the command-line entry point as `node build-identity.mjs`.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
// Accept SHA-1 and SHA-256 object IDs in full; never an abbreviation.
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** The build record file that the frozen sidecar reads from its metadata. */
export const BUILD_IDENTITY_FILE = 'build-identity.json'

/** The identity of a build whose source commit could not be read. */
export const UNKNOWN_BUILD_IDENTITY = Object.freeze({
  kind: 'unknown',
  commit: '',
  dirty: false,
})

function repositoryGit(cwd) {
  return (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
}

function packageVersion(repository) {
  const { version } = JSON.parse(
    readFileSync(join(repository, 'package.json'), 'utf8'),
  )
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('Set the package version before recording a build.')
  }
  return version
}

function isExactReleaseTag(git, version, commit) {
  const ref = `refs/tags/v${version}`
  try {
    return (
      git('cat-file', '-t', ref) === 'tag' &&
      git('rev-parse', '--verify', `${ref}^{commit}`) === commit
    )
  } catch {
    return false
  }
}

/**
 * Classify a build from the repository state it is built from.
 *
 * A release build is a clean tree whose HEAD is the annotated `v<version>`
 * tag. Any other readable commit is a development build, and a repository
 * that cannot be read yields the unknown identity.
 *
 * @param {object} options
 * @param {string} options.version
 * @param {(...args: string[]) => string} options.git - Runs one Git command
 *   and returns its trimmed standard output, or throws on failure.
 * @returns {{kind: 'release' | 'development' | 'unknown', commit: string,
 *   dirty: boolean}}
 */
export function resolveBuildIdentity({ version, git }) {
  let commit
  let dirty
  try {
    commit = git('rev-parse', '--verify', 'HEAD^{commit}')
    // Count tracked changes only, as `git describe --dirty` does, so ignored
    // build output and untracked local files never mark a build modified.
    dirty = git('status', '--porcelain=v1', '--untracked-files=no') !== ''
  } catch {
    return { ...UNKNOWN_BUILD_IDENTITY }
  }
  if (!OBJECT_ID.test(commit)) return { ...UNKNOWN_BUILD_IDENTITY }
  const release = !dirty && isExactReleaseTag(git, version, commit)
  return { kind: release ? 'release' : 'development', commit, dirty }
}

/**
 * Read the build identity of a repository checkout.
 *
 * @param {object} [options]
 * @param {string} [options.repository]
 * @returns {{kind: 'release' | 'development' | 'unknown', commit: string,
 *   dirty: boolean}} The build identity, or the unknown identity when the
 *   package manifest cannot be read.
 */
export function readBuildIdentity({ repository = root } = {}) {
  let version
  try {
    version = packageVersion(repository)
  } catch {
    return { ...UNKNOWN_BUILD_IDENTITY }
  }
  return resolveBuildIdentity({ version, git: repositoryGit(repository) })
}

/**
 * Write the versioned build record that the frozen sidecar embeds.
 *
 * @param {string} output - A file path that does not exist yet.
 * @param {object} [options]
 * @param {string} [options.repository]
 * @returns {{schemaVersion: number, version: string, kind: string, commit:
 *   string, dirty: boolean}}
 * @throws {Error} On an existing output file or an unreadable version.
 */
export function writeBuildIdentity(output, { repository = root } = {}) {
  const version = packageVersion(repository)
  const record = {
    schemaVersion: 1,
    version,
    ...resolveBuildIdentity({ version, git: repositoryGit(repository) }),
  }
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
  return record
}

function parseOutput(argv) {
  const index = argv.indexOf('--output')
  if (index < 0 || !argv[index + 1]) {
    throw new Error('Use build-identity.mjs --output <new-file>.')
  }
  return resolve(argv[index + 1])
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const record = writeBuildIdentity(parseOutput(process.argv.slice(2)))
  const commit = record.commit ? ` at ${record.commit.slice(0, 12)}` : ''
  const modified = record.dirty ? ' with modified tracked files' : ''
  console.log(
    `Recorded the ${record.kind} build identity of ${record.version}${commit}${modified}.`,
  )
}
