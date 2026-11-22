import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkStagedReleaseMetadata,
  createReleasePackageManifest,
  releasePackageInputPaths,
  releasePackageManifestName,
} from './release-package-manifest.mjs'

const cleanGitState = Object.freeze({
  repositoryUrl: 'git@github.com:qwareeq8/supraspina.git',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  changedPaths: [],
})
const packageVersion = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version

test('creates a clean full-commit package identity with exact input hashes', async () => {
  const manifest = await createReleasePackageManifest({
    gitState: cleanGitState,
  })

  assert.equal(manifest.package.name, 'supraspina')
  assert.equal(manifest.package.version, packageVersion)
  assert.equal(manifest.package.tag, `v${packageVersion}`)
  assert.equal(manifest.package.target, 'linux-x86_64')
  assert.equal(manifest.build.python, '3.12.10')
  assert.equal(manifest.build.pip, '26.2.1')
  assert.equal(manifest.build.electronVite, '5.0.0')
  assert.equal(manifest.build.pyinstaller, '6.21.0')
  assert.deepEqual(manifest.source, {
    repository: 'https://github.com/qwareeq8/supraspina',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    clean: true,
  })
  assert.deepEqual(manifest.signing, {
    decision: 'unsigned',
    reasonCode: 'no-linux-package-signing-identity',
    artifacts: { AppImage: 'unsigned', deb: 'unsigned' },
  })
  assert.deepEqual(Object.keys(manifest.inputs), releasePackageInputPaths)
  const packageLock = await readFile(
    new URL('../package-lock.json', import.meta.url),
  )
  assert.deepEqual(manifest.inputs['package-lock.json'], {
    bytes: packageLock.length,
    sha256: createHash('sha256').update(packageLock).digest('hex'),
  })
})

test('rejects dirty source, another repository, and abbreviated identities', async () => {
  await assert.rejects(
    createReleasePackageManifest({
      gitState: { ...cleanGitState, changedPaths: ['package.json'] },
    }),
    /clean source tree: package\.json/,
  )
  await assert.rejects(
    createReleasePackageManifest({
      gitState: {
        ...cleanGitState,
        repositoryUrl: 'https://github.com/example/supraspina.git',
      },
    }),
    /full object IDs from https:\/\/github\.com\/qwareeq8\/supraspina/,
  )
  await assert.rejects(
    createReleasePackageManifest({
      gitState: { ...cleanGitState, commit: 'a'.repeat(12) },
    }),
    /full object IDs/,
  )
  const { changedPaths: _changedPaths, ...uncheckedGitState } = cleanGitState
  await assert.rejects(
    createReleasePackageManifest({ gitState: uncheckedGitState }),
    /Inspect every changed source path/,
  )
})

async function stagedMetadata(t, manifest) {
  const directory = await mkdtemp(join(tmpdir(), 'supraspina-staged-metadata-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  if (manifest !== undefined) {
    await writeFile(
      join(directory, releasePackageManifestName),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
  }
  return directory
}

test('accepts no staged metadata or metadata generated from this source', async (t) => {
  const absent = join(await stagedMetadata(t), 'dependency-manifests')
  assert.deepEqual(
    await checkStagedReleaseMetadata({
      directory: absent,
      gitState: cleanGitState,
    }),
    { staged: false },
  )

  const current = await createReleasePackageManifest({
    gitState: cleanGitState,
  })
  assert.deepEqual(
    await checkStagedReleaseMetadata({
      directory: await stagedMetadata(t, current),
      gitState: cleanGitState,
    }),
    { staged: true },
  )
})

test('refuses staged metadata of another release, a missing manifest, or changed source', async (t) => {
  const current = await createReleasePackageManifest({
    gitState: cleanGitState,
  })
  const released = {
    ...current,
    package: { ...current.package, version: '1.2.0', tag: 'v1.2.0' },
    source: { ...current.source, commit: `f27581ea0c7e${'0'.repeat(28)}` },
  }
  await assert.rejects(
    checkStagedReleaseMetadata({
      directory: await stagedMetadata(t, released),
      gitState: cleanGitState,
    }),
    {
      message: `Remove the stale release metadata before packaging: build/release-metadata/dependency-manifests holds the release package manifest of 1.2.0 at f27581ea0c7e, and this source is ${packageVersion} at aaaaaaaaaaaa.`,
    },
  )
  await assert.rejects(
    checkStagedReleaseMetadata({
      directory: await stagedMetadata(t),
      gitState: cleanGitState,
    }),
    /holds no readable release package manifest, and this source/,
  )
  // Release metadata never matches a source with uncommitted changes.
  await assert.rejects(
    checkStagedReleaseMetadata({
      directory: await stagedMetadata(t, current),
      gitState: { ...cleanGitState, changedPaths: ['package.json'] },
    }),
    /this source is \S+ at aaaaaaaaaaaa with uncommitted changes\.$/,
  )

  const file = join(await stagedMetadata(t), 'dependency-manifests')
  await writeFile(file, '{}\n')
  await assert.rejects(
    checkStagedReleaseMetadata({ directory: file, gitState: cleanGitState }),
    /Provide the staged release metadata as a real directory/,
  )
})

test('package:linux checks the staged metadata before it builds anything', async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const steps = scripts['package:linux'].split(' && ')
  const buildSidecar = await readFile(
    new URL('./build-sidecar.sh', import.meta.url),
    'utf8',
  )
  const check = buildSidecar.indexOf(
    'node "${app_dir}/scripts/release-package-manifest.mjs" check-staged',
  )

  assert.ok(steps.indexOf('npm run build:sidecar') >= 0)
  assert.ok(
    steps.indexOf('npm run build:sidecar') <
      steps.indexOf('electron-vite build'),
  )
  assert.ok(check >= 0)
  assert.ok(check < buildSidecar.indexOf('stage-sidecar-resources.mjs'))
  assert.ok(check < buildSidecar.indexOf('-m PyInstaller'))
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('./release-package-manifest.mjs', import.meta.url),
          ),
        ],
        { stdio: 'pipe' },
      ),
    ({ stderr }) =>
      String(stderr).includes('Use release-package-manifest.mjs check-staged.'),
  )
})
