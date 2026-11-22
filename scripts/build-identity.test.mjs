import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, it } from 'node:test'

import {
  UNKNOWN_BUILD_IDENTITY,
  readBuildIdentity,
  resolveBuildIdentity,
  writeBuildIdentity,
} from './build-identity.mjs'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

/** Answer Git commands from a table; an absent command fails like Git. */
function fakeGit(answers) {
  return (...args) => {
    const key = args.join(' ')
    if (!(key in answers)) throw new Error(`git ${key} failed`)
    return answers[key]
  }
}

function tagged({ status = '', tagType = 'tag', target = COMMIT } = {}) {
  return fakeGit({
    'rev-parse --verify HEAD^{commit}': COMMIT,
    'status --porcelain=v1 --untracked-files=no': status,
    'cat-file -t refs/tags/v20261121.1830.0': tagType,
    'rev-parse --verify refs/tags/v20261121.1830.0^{commit}': target,
  })
}

describe('resolveBuildIdentity', () => {
  it('names a clean tree at the annotated version tag a release', () => {
    assert.deepEqual(
      resolveBuildIdentity({ version: '20261121.1830.0', git: tagged() }),
      { kind: 'release', commit: COMMIT, dirty: false },
    )
  })

  it('names a modified tree at the tag a development build', () => {
    assert.deepEqual(
      resolveBuildIdentity({
        version: '20261121.1830.0',
        git: tagged({ status: ' M src/main/index.ts' }),
      }),
      { kind: 'development', commit: COMMIT, dirty: true },
    )
  })

  it('names a lightweight or moved tag a development build', () => {
    for (const git of [
      tagged({ tagType: 'commit' }),
      tagged({ target: 'f'.repeat(40) }),
    ]) {
      assert.deepEqual(
        resolveBuildIdentity({ version: '20261121.1830.0', git }),
        {
          kind: 'development',
          commit: COMMIT,
          dirty: false,
        },
      )
    }
  })

  it('names a commit without a version tag a development build', () => {
    const git = fakeGit({
      'rev-parse --verify HEAD^{commit}': COMMIT,
      'status --porcelain=v1 --untracked-files=no': '',
    })
    assert.equal(
      resolveBuildIdentity({ version: '20261121.1830.0', git }).kind,
      'development',
    )
  })

  it('reports an unknown build when Git cannot name a full commit', () => {
    assert.deepEqual(
      resolveBuildIdentity({ version: '20261121.1830.0', git: fakeGit({}) }),
      UNKNOWN_BUILD_IDENTITY,
    )
    const abbreviated = fakeGit({
      'rev-parse --verify HEAD^{commit}': COMMIT.slice(0, 7),
      'status --porcelain=v1 --untracked-files=no': '',
    })
    assert.deepEqual(
      resolveBuildIdentity({ version: '20261121.1830.0', git: abbreviated }),
      UNKNOWN_BUILD_IDENTITY,
    )
  })
})

function git(repository, ...args) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Supraspina Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      ...args,
    ],
    { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

describe('writeBuildIdentity', () => {
  it('records the release, development, and modified states of a real repository', async () => {
    const repository = await mkdtemp(
      join(tmpdir(), 'supraspina-build-identity-'),
    )
    git(repository, 'init', '--quiet')
    await writeFile(
      join(repository, 'package.json'),
      `${JSON.stringify({ version: '20261121.1830.0' })}\n`,
    )
    git(repository, 'add', 'package.json')
    git(repository, 'commit', '--quiet', '-m', 'first')
    git(
      repository,
      'tag',
      '-a',
      'v20261121.1830.0',
      '-m',
      'Supraspina 20261121.1830.0',
    )
    const commit = git(repository, 'rev-parse', 'HEAD')

    const output = join(repository, 'release.json')
    assert.deepEqual(writeBuildIdentity(output, { repository }), {
      schemaVersion: 1,
      version: '20261121.1830.0',
      kind: 'release',
      commit,
      dirty: false,
    })
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {
      schemaVersion: 1,
      version: '20261121.1830.0',
      kind: 'release',
      commit,
      dirty: false,
    })
    // The untracked record itself leaves the tree clean.
    assert.equal(readBuildIdentity({ repository }).kind, 'release')
    assert.throws(() => writeBuildIdentity(output, { repository }), /EEXIST/)

    await writeFile(
      join(repository, 'package.json'),
      `${JSON.stringify({ version: '20261121.1830.0', private: true })}\n`,
    )
    assert.deepEqual(readBuildIdentity({ repository }), {
      kind: 'development',
      commit,
      dirty: true,
    })

    git(repository, 'commit', '--quiet', '-am', 'second')
    assert.deepEqual(readBuildIdentity({ repository }), {
      kind: 'development',
      commit: git(repository, 'rev-parse', 'HEAD'),
      dirty: false,
    })
  })

  it('reports an unknown build outside a repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'supraspina-no-repository-'))
    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify({ version: '20261121.1830.0' })}\n`,
    )
    // Stop Git from finding an enclosing repository above the temporary one.
    const ceiling = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = tmpdir()
    try {
      assert.deepEqual(
        readBuildIdentity({ repository: directory }),
        UNKNOWN_BUILD_IDENTITY,
      )
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = ceiling
    }
    assert.deepEqual(
      readBuildIdentity({ repository: join(directory, 'missing') }),
      UNKNOWN_BUILD_IDENTITY,
    )
  })
})
