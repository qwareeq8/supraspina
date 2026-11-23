import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  ACCEPTANCE_FILE,
  BUILD_COMMAND_IDS,
  RELEASE_COMMAND_INPUTS,
  coreReleaseAssetNames,
  createMergedReleaseAcceptance,
  createNativeBuildRecord,
  createNativeHostRecord,
} from './release-acceptance.mjs'
import {
  CHECKSUM_FILE,
  createChecksums,
  expectedAssetNames,
  verifyChecksums,
} from './release-assets.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'supraspina-assets-'))
  temporaryDirectories.push(root)
  const directory = join(root, 'release-assets')
  await mkdir(directory)
  const appImage = 'supraspina-20261121.1830.0-x86_64.AppImage'
  const debianPackage = 'supraspina-20261121.1830.0-amd64.deb'
  const appImageContent = Buffer.from(`fixture:${appImage}`)
  const debianContent = Buffer.from(`fixture:${debianPackage}`)
  const appImageSha512 = createHash('sha512')
    .update(appImageContent)
    .digest('base64')
  const debianSha512 = createHash('sha512')
    .update(debianContent)
    .digest('base64')
  for (const name of coreReleaseAssetNames('20261121.1830.0')) {
    const content =
      name === 'latest-linux.yml'
        ? [
            'version: 20261121.1830.0',
            'files:',
            '  - url: supraspina-20261121.1830.0-x86_64.AppImage',
            `    sha512: ${appImageSha512}`,
            `    size: ${appImageContent.length}`,
            `  - url: ${debianPackage}`,
            `    sha512: ${debianSha512}`,
            `    size: ${debianContent.length}`,
            'path: supraspina-20261121.1830.0-x86_64.AppImage',
            `sha512: ${appImageSha512}`,
            '',
          ].join('\n')
        : name === appImage
          ? appImageContent
          : name === debianPackage
            ? debianContent
            : `fixture:${name}`
    await writeFile(join(directory, name), content)
  }
  const sourceIdentity = async (path) => {
    const source = await readFile(new URL(`../${path}`, import.meta.url))
    return {
      bytes: source.length,
      sha256: createHash('sha256').update(source).digest('hex'),
    }
  }
  const packageManifest = {
    schemaVersion: 1,
    package: {
      name: 'supraspina',
      productName: 'Supraspina',
      version: '20261121.1830.0',
      tag: 'v20261121.1830.0',
      target: 'linux-x86_64',
    },
    source: {
      repository: 'https://github.com/qwareeq8/supraspina',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      clean: true,
    },
    build: {
      nodeEngine: '^22.13.0 || >=24.0.0',
      python: '3.12.10',
      pip: '26.2.1',
      electron: '42.11.18',
      electronBuilder: '26.15.3',
      electronVite: '5.0.0',
      pyinstaller: '6.21.0',
      micromambaRelease: '2.7.0-0',
      micromambaSha256: 'c'.repeat(64),
    },
    signing: {
      decision: 'unsigned',
      reasonCode: 'no-linux-package-signing-identity',
      artifacts: { AppImage: 'unsigned', deb: 'unsigned' },
    },
    inputs: Object.fromEntries(
      await Promise.all(
        RELEASE_COMMAND_INPUTS.map(async (path) => [
          path,
          await sourceIdentity(path),
        ]),
      ),
    ),
  }
  const packageManifestPath = join(root, 'release-package-manifest.json')
  await writeFile(
    packageManifestPath,
    `${JSON.stringify(packageManifest, null, 2)}\n`,
  )
  const results = {
    debSmoke: 'passed',
    appImageSmoke: 'passed',
    packageInspection: 'passed',
    debNormalLaunch: 'passed',
    appImageNormalLaunch: 'passed',
    pybrainageProvisioning: 'passed',
    pybrainageReadiness: 'passed',
    syntheticOutputReopen: 'passed',
  }
  const tools = {
    node: 'v22.13.1',
    npm: '10.9.2',
    bash: 'GNU bash 5.2.21',
    dpkg: 'dpkg 1.22.6',
    apt: 'apt 2.7.14',
    file: 'file-5.45',
    xvfbPackage: '2:21.1.12-1ubuntu1',
    fusePackage: '1:2.9.9-6build1',
  }
  const buildRecord = await createNativeBuildRecord({
    assetsDirectory: directory,
    packageManifestPath,
    commandResults: Object.fromEntries(
      BUILD_COMMAND_IDS.map((id) => [id, { status: 'passed', exitCode: 0 }]),
    ),
    host: {
      distribution: 'ubuntu',
      version: '22.04',
      architecture: 'x86_64',
      kernelRelease: '5.15.0-130-generic',
      wsl: false,
    },
    tools: {
      node: 'v22.13.1',
      npm: '10.9.2',
      python: '3.12.10',
      pip: '26.2.1',
      bash: 'GNU bash 5.2.21',
      curl: 'curl 8.5.0',
      sha256sum: 'sha256sum 9.4',
      file: 'file-5.45',
      dpkgDeb: 'dpkg-deb 1.22.6',
      glibc: 'ldd 2.39',
      electron: '42.11.18',
      electronBuilder: '26.15.3',
      electronVite: '5.0.0',
      pyinstaller: '6.21.0',
      micromamba: '2.7.0',
    },
    sourceState: {
      repositoryUrl: 'git@github.com:qwareeq8/supraspina.git',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      changedPaths: [],
    },
  })
  const records = await Promise.all(
    ['22.04', '24.04'].map((hostVersion) =>
      createNativeHostRecord({
        assetsDirectory: directory,
        packageManifestPath,
        buildRecord,
        results,
        host: {
          distribution: 'ubuntu',
          version: hostVersion,
          architecture: 'x86_64',
          kernelRelease:
            hostVersion === '22.04' ? '5.15.0-130-generic' : '6.8.0-52-generic',
          wsl: false,
        },
        tools,
        sourceState: {
          repositoryUrl: 'git@github.com:qwareeq8/supraspina.git',
          commit: 'a'.repeat(40),
          tree: 'b'.repeat(40),
          changedPaths: [],
        },
      }),
    ),
  )
  const acceptance = await createMergedReleaseAcceptance({
    assetsDirectory: directory,
    packageManifestPath,
    buildRecord,
    hostRecords: records,
  })
  await writeFile(
    join(directory, ACCEPTANCE_FILE),
    `${JSON.stringify(acceptance, null, 2)}\n`,
  )
  return directory
}

describe('release asset integrity', () => {
  it('creates sorted checksums and verifies every expected asset', async () => {
    const directory = await fixture()

    await createChecksums(directory, '20261121.1830.0')
    const verified = await verifyChecksums(directory, '20261121.1830.0')

    assert.deepEqual(
      verified.map(({ name }) => name),
      expectedAssetNames('20261121.1830.0').sort(),
    )
    assert.match(
      await readFile(join(directory, CHECKSUM_FILE), 'utf8'),
      / {2}latest-linux\.yml/,
    )
    assert.match(
      await readFile(join(directory, CHECKSUM_FILE), 'utf8'),
      / {2}release-acceptance\.json/,
    )
  })

  it('rejects a modified asset', async () => {
    const directory = await fixture()
    await createChecksums(directory, '20261121.1830.0')
    await writeFile(
      join(directory, 'supraspina-20261121.1830.0-x86_64.AppImage'),
      'tampered',
    )

    await assert.rejects(
      verifyChecksums(directory, '20261121.1830.0'),
      /(?:SHA-512 integrity|checksum mismatch)/,
    )
  })

  it('rejects a modified Debian payload against channel metadata', async () => {
    const directory = await fixture()
    await createChecksums(directory, '20261121.1830.0')
    await writeFile(
      join(directory, 'supraspina-20261121.1830.0-amd64.deb'),
      'tampered',
    )

    await assert.rejects(
      verifyChecksums(directory, '20261121.1830.0'),
      /exact size and SHA-512 integrity/,
    )
  })

  it('rejects missing or unexpected downloadable assets', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'unexpected.txt'), 'unexpected')

    await assert.rejects(
      createChecksums(directory, '20261121.1830.0'),
      /Match the release assets/,
    )
  })

  it('rejects directories in the release staging directory', async () => {
    const directory = await fixture()
    await mkdir(join(directory, 'not-an-asset'))

    await assert.rejects(
      createChecksums(directory, '20261121.1830.0'),
      /Remove non-regular release asset entries: not-an-asset/,
    )
  })

  it('rejects symlinks even when they point at an approved asset', async () => {
    const directory = await fixture()
    await symlink(
      'supraspina-20261121.1830.0-x86_64.AppImage',
      join(directory, 'linked-asset'),
    )

    await assert.rejects(
      createChecksums(directory, '20261121.1830.0'),
      /Remove non-regular release asset entries: linked-asset/,
    )
  })

  it('rejects update metadata that points at another version or artifact', async () => {
    const directory = await fixture()
    await writeFile(
      join(directory, 'latest-linux.yml'),
      [
        'version: 20261120.1830.0',
        'files:',
        '  - url: supraspina-20261120.1830.0-x86_64.AppImage',
        '    sha512: fixture-sha512',
        '    size: 1',
        'path: supraspina-20261120.1830.0-x86_64.AppImage',
        'sha512: fixture-sha512',
        '',
      ].join('\n'),
    )

    await assert.rejects(
      createChecksums(directory, '20261121.1830.0'),
      /Identify the expected asset in latest-linux\.yml: 20261121.1830.0/,
    )
  })

  it('rejects stale AppImage size or SHA-512 channel integrity', async () => {
    const directory = await fixture()
    const channelPath = join(directory, 'latest-linux.yml')
    const channel = await readFile(channelPath, 'utf8')
    await writeFile(
      channelPath,
      channel.replace(/^ {4}size: \d+$/m, '    size: 999999'),
    )

    await assert.rejects(
      createChecksums(directory, '20261121.1830.0'),
      /exact size and SHA-512 integrity/,
    )
  })
})
