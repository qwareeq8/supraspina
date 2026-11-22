import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { load as loadYaml } from 'js-yaml'

import { appVersionDate, parseAppVersion } from './app-version.mjs'
import { expectedAssetNames } from './release-assets.mjs'

import {
  BRAND_ASSET_DIGESTS,
  GENERATED_RELEASE_METADATA_NAMES,
  RELEASE_CONTRACT,
  REQUIRED_DEB_DEPENDENCIES,
  formatReleaseConsistencyFailure,
  formatReleaseConsistencySuccess,
  main,
  validateAppImageLaunchSafety,
  validateLinuxOnlyRelease,
  validatePackagingContract,
  validatePackagingLayout,
  validateProductIdentity,
  validateReleaseMetadataPackaging,
  validateStrictRelease,
  validateVersionAgreement,
} from './check-release.mjs'

const runNode = promisify(execFile)

function collectingStream() {
  const written = []
  return { written, write: (chunk) => written.push(chunk) }
}

const VERSION = '20261121.1830.0'
const PREVIOUS_VERSION = '20261120.905.0'
const HEAD = 'a'.repeat(40)

const TAG_OBJECT = 'b'.repeat(40)
const PREVIOUS_HEAD = 'c'.repeat(40)
const PREVIOUS_TAG_OBJECT = 'd'.repeat(40)

it('reports completed release consistency as a past-tense sentence', () => {
  assert.equal(
    formatReleaseConsistencySuccess('metadata', VERSION),
    'Verified release consistency in metadata mode for 20261121.1830.0.',
  )
})

describe('the packaging contract', () => {
  const sources = {
    buildSidecar:
      'readonly owned_output_paths=("${sidecar_dir}/build" "${sidecar_dir}/dist" "${out_dir}")\n' +
      'SUPRASPINA_PYINSTALLER_STAGING="${staging_dir}" "${python_bin}" -m PyInstaller "${sidecar_dir}/supraspina-sidecar.spec"\n' +
      'mkdir "${out_dir}"\n' +
      'find "${out_dir}" -mindepth 1 -maxdepth 1',
    sidecarSpec:
      'SUPRASPINA_PYINSTALLER_STAGING collect_submodules("supraspina_sidecar") "numpy" "openpyxl" "pydantic" excludes=["tkinter"] contents_directory="supraspina-runtime" upx=False upx=False',
    smokeAppImage:
      'node scripts/inspect-linux-packages.mjs --appimage "${appimage}"\n' +
      '--executable "${appimage}" --type appimage',
    smokeDebian:
      'if sudo apt-get install --yes "${deb}"; then\n' +
      'dpkg-query --listfiles "${package_name}"\n' +
      'sudo apt-get check\n' +
      'ldd "${path}"\n' +
      'sudo apt-get purge --yes "${package_name}"\n' +
      'Purge left the package-owned path\n' +
      'node scripts/inspect-linux-packages.mjs --deb "${deb}"\n' +
      '--executable /usr/bin/supraspina --type deb --native-science',
  }

  it('accepts the reviewed packaging sources', () => {
    assert.doesNotThrow(() => validatePackagingContract(sources))
  })

  it('rejects a long PyInstaller command', () => {
    assert.throws(
      () =>
        validatePackagingContract({
          ...sources,
          buildSidecar: `${sources.buildSidecar} --add-data resources:resources`,
        }),
      /Build the frozen sidecar from its committed PyInstaller spec/,
    )
  })

  it('keeps ambient UPX out of frozen sidecar bytes', () => {
    assert.throws(
      () =>
        validatePackagingContract({
          ...sources,
          sidecarSpec: sources.sidecarSpec.replaceAll('upx=False', 'upx=True'),
        }),
      /disabled UPX state/,
    )
  })

  it('rejects reusable or inexact ignored sidecar staging', () => {
    assert.throws(
      () =>
        validatePackagingContract({
          ...sources,
          buildSidecar: sources.buildSidecar
            .replace('readonly owned_output_paths=(', 'owned_output_paths=(')
            .replace('mkdir "${out_dir}"', 'mkdir -p "${out_dir}"'),
        }),
      /Require absent, exact ignored staging/,
    )
  })

  it('rejects a weakened local sandbox', () => {
    const escapes = [
      '--no-sandbox',
      'SUPRASPINA_SMOKE_NO_SANDBOX=1',
      'SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX=1',
    ]
    for (const escape of escapes) {
      for (const key of ['smokeAppImage', 'smokeDebian']) {
        assert.throws(
          () =>
            validatePackagingContract({
              ...sources,
              [key]: `${sources[key]} ${escape}`,
            }),
          /Keep the Chromium sandbox enabled/,
          `Reject the ${key} sandbox escape: ${escape}.`,
        )
      }
    }
  })

  it('requires final-package inspection in both smoke scripts', () => {
    for (const key of ['smokeAppImage', 'smokeDebian']) {
      assert.throws(
        () => validatePackagingContract({ ...sources, [key]: '--type deb' }),
        /Inspect the final launcher metadata and sandbox policy/,
        `Require inspection from ${key}.`,
      )
    }
  })

  it('requires isolated Debian installation, ELF checks, and verified purge', () => {
    assert.throws(
      () =>
        validatePackagingContract({
          ...sources,
          smokeDebian:
            'sudo apt-get install --yes xvfb "${deb}"\n' +
            'node scripts/inspect-linux-packages.mjs --deb "${deb}"',
        }),
      /Install the Debian artifact alone, verify dependencies and ELFs/,
    )
  })

  it('the committed smoke scripts inspect the exact bytes they exercise', async () => {
    const [appImage, debian] = await Promise.all([
      readFile(new URL('./smoke-appimage.sh', import.meta.url), 'utf8'),
      readFile(new URL('./smoke-installed-deb.sh', import.meta.url), 'utf8'),
    ])

    assert.match(appImage, /inspect-linux-packages\.mjs["']? --appimage/)
    assert.match(debian, /inspect-linux-packages\.mjs["']? --deb/)
    assert.match(debian, /^if sudo apt-get install --yes "\$\{deb\}"; then$/m)
    assert.match(debian, /sudo apt-get check/)
    assert.match(debian, /ldd "\$\{path\}"/)
    assert.match(debian, /--native-science/)
    assert.match(debian, /sudo apt-get purge --yes "\$\{package_name\}"/)
  })
})

describe('the embedded release-metadata contract', () => {
  const fixture = () => ({
    extraResources: [
      {
        from: 'build/release-metadata/dependency-manifests',
        to: 'dependency-manifests',
        filter: [...GENERATED_RELEASE_METADATA_NAMES],
      },
      {
        from: 'package-lock.json',
        to: 'dependency-manifests/package-lock.json',
      },
      {
        from: 'sidecar/requirements',
        to: 'dependency-manifests/python-locks',
        filter: ['release-linux-x86_64.txt', 'release-toolchain.json'],
      },
    ],
  })

  it('accepts the exact generated manifests and locks', () => {
    assert.doesNotThrow(() => validateReleaseMetadataPackaging(fixture()))
  })

  it('rejects a wildcard or missing source-identity manifest', () => {
    for (const filter of [
      ['**/*'],
      GENERATED_RELEASE_METADATA_NAMES.filter(
        (name) => name !== 'release-package-manifest.json',
      ),
    ]) {
      const builder = fixture()
      builder.extraResources[0].filter = filter
      assert.throws(
        () => validateReleaseMetadataPackaging(builder),
        /Embed exactly the reviewed release metadata/,
      )
    }
  })
})

describe('the release procedure', () => {
  it('records the date-time version scheme and the release topology', async () => {
    const source = await readFile(
      new URL('../docs/releasing.md', import.meta.url),
      'utf8',
    )
    const prose = source.replace(/\s+/g, ' ')
    assert.match(prose, /The machine form is `YYYYMMDD\.HHMM\.0`/)
    assert.match(prose, /display form, `2026-11-21 18:30 UTC`/)
    assert.match(source, /npm run version:stamp/)
    assert.match(
      source,
      /git tag --annotate "v\$\{version\}" --message "Supraspina \$\{version\}"/,
    )
    assert.doesNotMatch(source, /1\.0\.0|1\.2\.0|1\.3\.0|parentless/)
    assert.match(
      source,
      /git tag --list 'v\[1-9\](\[0-9\]){7}\.\*\.0' \\\n {2}--sort=-version:refname/,
    )
    assert.match(
      source,
      /git merge-base --is-ancestor "\$\{previous_tag\}\^\{commit\}" HEAD/,
    )
    assert.match(source, /test "\$\{highest_version\}" = "\$\{version\}"/)
    assert.doesNotMatch(source, /cannot be\s+published as `v1\.0\.0`/)
    assert.doesNotMatch(
      source,
      /push --force|--force-with-lease|push origin \+/,
    )
    assert.doesNotMatch(source, /allow-unrelated-histories/)
    assert.doesNotMatch(
      prose,
      /private repository|canonical private|recreating|canonical remote/i,
    )
    assert.match(
      source,
      /--jq '\[\.nameWithOwner, \.isPrivate, \.defaultBranchRef\.name\] \| @tsv'\)" = \\\n {2}\$'qwareeq8\/supraspina\\tfalse\\tmain'/,
    )
  })

  it('publishes the accepted first release under the mutable release policy', async () => {
    const source = await readFile(
      new URL('../docs/releasing.md', import.meta.url),
      'utf8',
    )
    const prose = source.replace(/\s+/g, ' ')
    assert.match(
      source,
      /GitHub immutable tags and releases are deliberately disabled/,
    )
    assert.match(source, /check-github-release-settings\.mjs/)
    assert.match(
      prose,
      /Do not create any ruleset that restricts deletion, updates, or force pushes on `refs\/tags\/v\*`/,
    )
    assert.match(source, /Do not add an `update` rule/)
    assert.match(source, /git push origin "refs\/tags\/\$\{tag\}"/)
    assert.match(source, /gh release create "\$\{tag\}"/)
    assert.match(source, /gh release edit "\$\{tag\}"/)
    assert.match(
      source,
      /gh api repos\/qwareeq8\/supraspina\/immutable-releases \\\n {2}--jq \.enabled\)" = "false"/,
    )
    assert.doesNotMatch(source, /isImmutable/)
    assert.doesNotMatch(source, /gh release verify/)
    assert.match(
      prose,
      /separate explicit owner authorization before changing an already published tag or release/,
    )
  })

  it('records the native build and waits for observed normal launches', async () => {
    const source = await readFile(
      new URL('../docs/releasing.md', import.meta.url),
      'utf8',
    )
    assert.match(source, /test ! -e release\nnpm run metadata:node/)
    assert.match(source, /release-acceptance\.mjs record-build/)
    assert.match(source, /--command-result package-linux=0/)
    assert.match(source, /release-acceptance\.mjs verify-transfer/)
    assert.match(source, /--build-record "\$\{build_record\}"/)
    assert.ok(
      source.indexOf('release-acceptance.mjs verify-transfer') <
        source.indexOf('\nnpm ci\nsource /etc/os-release'),
    )
    assert.match(source, /--pybrainage-provisioning passed/)
    assert.match(source, /--pybrainage-readiness passed/)
    assert.match(source, /--synthetic-output-reopen passed/)
    assert.equal(
      source.match(
        /apt-get install --yes "\.\/\$\{acceptance_assets\}\/\$\{deb_name\}"/g,
      )?.length,
      2,
    )
    assert.match(source, /\/usr\/bin\/supraspina \|\| normal_deb_status=\$\?/)
    assert.match(source, /operator must observe the Supraspina window/)
    assert.doesNotMatch(source, /gtk-launch supraspina/)
  })

  it('carries the unpublished candidate to each host as one verified bundle', async () => {
    const source = await readFile(
      new URL('../docs/releasing.md', import.meta.url),
      'utf8',
    )
    assert.match(source, /git bundle create/)
    assert.match(source, /sha256sum --check SHA256SUMS/)
    assert.match(source, /git bundle verify/)
    // Git before 2.38 cannot verify a bundle outside a repository.
    assert.match(
      source,
      /git -C "\$\{verify_repo\}" init --quiet\ngit -C "\$\{verify_repo\}" bundle verify/,
    )
    assert.match(source, /git clone --branch main/)
    assert.match(source, /git remote set-url --add --push origin DISABLED/)
    assert.match(source, /refs\/heads\/main '--glob=refs\/tags\/v\*'/)
    assert.match(
      source,
      /git merge-base --is-ancestor "\$\{previous_tag\}\^\{commit\}" HEAD/,
    )
    assert.match(source, /SUPRASPINA_RELEASE_VERSION/)
    assert.match(source, /git fsck --full --strict/)
  })
})

function fixture(overrides = {}) {
  const version = overrides.version ?? VERSION
  const tag = `v${version}`
  const state = {
    head: HEAD,
    originMain: HEAD,
    originUrl: 'https://github.com/qwareeq8/supraspina.git',
    changedPaths: [],
    tagType: () => 'tag',
    tagObject: (candidate) =>
      candidate === tag ? TAG_OBJECT : PREVIOUS_TAG_OBJECT,
    tagTarget: (candidate) => (candidate === tag ? HEAD : PREVIOUS_HEAD),
    tagMessage: () => `Supraspina ${version}`,
    tags: [tag],
    isAncestor: () => true,
    ...overrides.gitState,
  }
  return {
    version,
    env: {
      GITHUB_REPOSITORY: 'qwareeq8/supraspina',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: tag,
      GITHUB_REF: `refs/tags/${tag}`,
      GITHUB_SHA: HEAD,
      ...overrides.env,
    },
    gitState: state,
    authenticatedRefs: {
      main: { type: 'commit', sha: HEAD },
      tag: { type: 'tag', sha: TAG_OBJECT },
      previousTag: { type: 'tag', sha: PREVIOUS_TAG_OBJECT },
      ...overrides.authenticatedRefs,
    },
  }
}

describe('strict release authority', () => {
  it('accepts one annotated tag at authenticated origin/main and HEAD', () => {
    assert.doesNotThrow(() => validateStrictRelease(fixture()))
  })

  it('accepts a later release whose prior release is an ancestor', () => {
    assert.doesNotThrow(() =>
      validateStrictRelease(
        fixture({
          gitState: { tags: [`v${PREVIOUS_VERSION}`, `v${VERSION}`] },
        }),
      ),
    )
  })

  it('orders same-day releases by time, not by text', () => {
    // 905 sorts after 1830 as text but names the earlier minute.
    assert.doesNotThrow(() =>
      validateStrictRelease(
        fixture({ gitState: { tags: ['v20261121.905.0', `v${VERSION}`] } }),
      ),
    )
    assert.throws(
      () =>
        validateStrictRelease(
          fixture({
            version: '20261121.905.0',
            gitState: { tags: ['v20261121.905.0', `v${VERSION}`] },
          }),
        ),
      /later than 20261121\.1830\.0/,
    )
  })

  it('ignores tags that do not name a date-time release', () => {
    const input = fixture({
      gitState: { tags: ['v1.2.0', 'v20261121', `v${VERSION}`] },
      authenticatedRefs: { previousTag: undefined },
    })
    assert.doesNotThrow(() => validateStrictRelease(input))
  })

  it('rejects a version that is not a UTC date-time version', () => {
    for (const version of [
      '1.3.0',
      '20261121.0905.0',
      '20261121.2460.0',
      '20261131.1830.0',
      '20261121.1830.1',
    ]) {
      assert.throws(
        () => validateStrictRelease(fixture({ version })),
        /YYYYMMDD\.HHMM\.0 UTC date-time version/,
      )
    }
  })

  it('rejects an unexpected annotated tag message', () => {
    const input = fixture({ gitState: { tagMessage: () => 'Release 1.0.0' } })
    assert.throws(() => validateStrictRelease(input), /annotated tag message/)
  })

  it('rejects a version that does not follow the prior release tag', () => {
    const input = fixture({
      gitState: { tags: ['v20261122.0.0', `v${VERSION}`] },
    })
    assert.throws(
      () => validateStrictRelease(input),
      /later than 20261122\.0\.0/,
    )
  })

  it('rejects a later release that omits the prior release history', () => {
    const input = fixture({
      gitState: {
        tags: [`v${PREVIOUS_VERSION}`, `v${VERSION}`],
        isAncestor: () => false,
      },
    })
    assert.throws(() => validateStrictRelease(input), /tagged commit history/)
  })

  it('rejects a moved authenticated prior release tag', () => {
    const input = fixture({
      gitState: { tags: [`v${PREVIOUS_VERSION}`, `v${VERSION}`] },
      authenticatedRefs: {
        previousTag: { type: 'tag', sha: 'e'.repeat(40) },
      },
    })
    assert.throws(
      () => validateStrictRelease(input),
      /authenticated prior release tag/,
    )
  })

  it('rejects a lightweight tag', () => {
    const input = fixture({ gitState: { tagType: () => 'commit' } })
    assert.throws(
      () => validateStrictRelease(input),
      /Use v20261121\.1830\.0 as an annotated tag/,
    )
  })

  it('rejects an off-main tag', () => {
    const input = fixture({ gitState: { originMain: 'c'.repeat(40) } })
    assert.throws(
      () => validateStrictRelease(input),
      /Match origin\/main to the tagged workflow HEAD/,
    )
  })

  it('rejects a wrong tag or version ref', () => {
    const input = fixture({ env: { GITHUB_REF_NAME: 'v9.9.9' } })
    assert.throws(() => validateStrictRelease(input), /expected workflow ref/)
  })

  it('rejects a moved authenticated tag ref', () => {
    const input = fixture({
      authenticatedRefs: {
        tag: { type: 'tag', sha: 'd'.repeat(40) },
      },
    })
    assert.throws(() => validateStrictRelease(input), /authenticated tag ref/)
  })

  it('rejects the wrong repository and origin', () => {
    assert.throws(
      () =>
        validateStrictRelease(
          fixture({ env: { GITHUB_REPOSITORY: 'someone/fork' } }),
        ),
      /expected repository/,
    )
    assert.throws(
      () =>
        validateStrictRelease(
          fixture({
            gitState: {
              originUrl: 'git@github.com:someone/fork.git',
            },
          }),
        ),
      /Point origin to the expected GitHub repository/,
    )
  })

  it('lets a rehearsal repository stand in for the release authority', () => {
    const env = {
      GITHUB_REPOSITORY: 'someone/rehearsal',
      SUPRASPINA_RELEASE_REPOSITORY: 'someone/rehearsal',
    }
    const gitState = { originUrl: 'https://github.com/someone/rehearsal.git' }
    assert.doesNotThrow(() => validateStrictRelease(fixture({ env, gitState })))
    assert.throws(
      () =>
        validateStrictRelease(
          fixture({
            env,
            gitState: { originUrl: fixture().gitState.originUrl },
          }),
        ),
      /Point origin to the expected GitHub repository/,
    )
    assert.throws(
      () =>
        validateStrictRelease(
          fixture({ env: { SUPRASPINA_RELEASE_REPOSITORY: 'not a repo' } }),
        ),
      /owner\/name pair/,
    )
  })

  it('rejects a workflow SHA that is not HEAD', () => {
    const input = fixture({ env: { GITHUB_SHA: 'e'.repeat(40) } })
    assert.throws(() => validateStrictRelease(input), /workflow SHA/)
  })

  it('rejects dirty tracked and untracked source files', () => {
    const input = fixture({
      gitState: { changedPaths: ['src/main/index.ts', 'untracked.txt'] },
    })
    assert.throws(
      () => validateStrictRelease(input),
      /Clean the release worktree/,
    )
  })

  it('allows only the explicit downloaded artifact directory to be untracked', () => {
    const input = fixture({
      gitState: {
        changedPaths: [
          'release-assets/SHA256SUMS',
          `release-assets/supraspina-${VERSION}-x86_64.AppImage`,
        ],
      },
    })
    assert.doesNotThrow(() =>
      validateStrictRelease({
        ...input,
        artifactsDirectory: new URL('../release-assets', import.meta.url)
          .pathname,
      }),
    )
  })
})

function versionFields(overrides = {}) {
  return [
    { path: 'package.json', kind: 'version', value: VERSION },
    { path: 'package-lock.json', kind: 'version', value: VERSION },
    { path: 'CITATION.cff', kind: 'version', value: VERSION },
    { path: 'CITATION.cff', kind: 'date', value: '2026-11-21' },
    { path: 'electron-builder.yml', kind: 'date', value: '2026-11-21' },
    { path: 'sidecar/uv.lock', kind: 'version', value: VERSION },
  ].map((field) => ({
    ...field,
    ...(overrides[`${field.path}:${field.kind}`] ?? {}),
  }))
}

describe('version agreement', () => {
  it('accepts one date-time version and the date it names', () => {
    assert.equal(validateVersionAgreement(versionFields()), VERSION)
  })

  it('rejects a semantic version', () => {
    const fields = versionFields({
      'package.json:version': { value: '1.3.0' },
    })
    assert.throws(
      () => validateVersionAgreement(fields),
      /YYYYMMDD\.HHMM\.0 UTC date-time version.*version:stamp/,
    )
  })

  it('names the first file that disagrees', () => {
    const fields = versionFields({
      'sidecar/uv.lock:version': { value: PREVIOUS_VERSION },
    })
    assert.throws(
      () => validateVersionAgreement(fields),
      /Match the version in sidecar\/uv\.lock to 20261121\.1830\.0/,
    )
  })

  it('requires the release date that the version names', () => {
    const fields = versionFields({
      'electron-builder.yml:date': { value: '2026-09-20' },
    })
    assert.throws(
      () => validateVersionAgreement(fields),
      /release date in electron-builder\.yml to 2026-11-21/,
    )
  })
})

describe('installer metadata', () => {
  it('keeps package.json private so npm never publishes the app', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    )
    assert.equal(packageJson.private, true)
  })

  it('uses the canonical absolute project homepage', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    )
    assert.equal(packageJson.homepage, RELEASE_CONTRACT.homepage)
    assert.equal(
      packageJson.repository.url,
      `git+${RELEASE_CONTRACT.repositoryUrl}.git`,
    )
  })

  it('keeps the Linux desktop filename aligned with the Electron app ID', async () => {
    const [packageSource, builderSource] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'),
    ])
    const packageJson = JSON.parse(packageSource)
    const builder = loadYaml(builderSource)

    assert.equal(packageJson.desktopName, 'supraspina.desktop')
    assert.equal(builder.linux.syncDesktopName, true)
  })

  it('requires the complete reviewed Debian runtime dependency set', async () => {
    const builderSource = await readFile(
      new URL('../electron-builder.yml', import.meta.url),
      'utf8',
    )
    const builder = loadYaml(builderSource)

    assert.deepEqual(builder.deb.depends, REQUIRED_DEB_DEPENDENCIES)
  })
})

async function builderConfiguration() {
  return loadYaml(
    await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'),
  )
}

async function packageManifest() {
  return JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
}

function linuxOnlyFixture(overrides = {}) {
  return {
    packageJson: {
      scripts: {
        build: 'electron-vite build',
        'package:linux': 'electron-builder --linux --publish never',
      },
    },
    builder: { linux: { target: ['AppImage', 'deb'] } },
    pythonToolchain: {
      targets: { 'linux-x86_64': 'release-linux-x86_64.txt' },
    },
    requirementNames: ['release-linux-x86_64.txt', 'release-toolchain.json'],
    scriptNames: ['smoke-appimage.sh', 'smoke-installed-deb.sh'],
    version: VERSION,
    ...overrides,
  }
}

describe('the Linux-only release contract', () => {
  it('accepts the reviewed Linux release surface', () => {
    assert.doesNotThrow(() => validateLinuxOnlyRelease(linuxOnlyFixture()))
  })

  it('rejects a packaging command that can publish implicitly', () => {
    assert.throws(
      () =>
        validateLinuxOnlyRelease(
          linuxOnlyFixture({
            packageJson: {
              scripts: { 'package:linux': 'electron-builder --linux' },
            },
          }),
        ),
      /publication-inert/,
    )
  })

  it('rejects a Mac package script', () => {
    assert.throws(
      () =>
        validateLinuxOnlyRelease(
          linuxOnlyFixture({
            packageJson: {
              scripts: { 'package:mac': 'electron-builder --mac' },
            },
          }),
        ),
      /Remove the non-Linux package script: package:mac/,
    )
  })

  it('rejects Mac and Windows electron-builder sections', () => {
    for (const key of ['mac', 'dmg', 'win', 'nsis']) {
      assert.throws(
        () =>
          validateLinuxOnlyRelease(
            linuxOnlyFixture({
              builder: { linux: { target: ['AppImage', 'deb'] }, [key]: {} },
            }),
          ),
        new RegExp(`Remove the non-Linux electron-builder section: ${key}`),
      )
    }
  })

  it('rejects a non-Linux packaging target', () => {
    assert.throws(
      () =>
        validateLinuxOnlyRelease(
          linuxOnlyFixture({
            builder: { linux: { target: ['AppImage', 'deb', 'dmg'] } },
          }),
        ),
      /Build exactly the AppImage and Debian Linux targets/,
    )
  })

  it('rejects a Mac Python release lock and target', () => {
    assert.throws(
      () =>
        validateLinuxOnlyRelease(
          linuxOnlyFixture({
            requirementNames: [
              'release-linux-x86_64.txt',
              'release-macos-arm64.txt',
            ],
          }),
        ),
      /Remove the non-Linux Python release lock: release-macos-arm64\.txt/,
    )
    assert.throws(
      () =>
        validateLinuxOnlyRelease(
          linuxOnlyFixture({
            pythonToolchain: {
              targets: {
                'linux-x86_64': 'release-linux-x86_64.txt',
                'macos-arm64': 'release-macos-arm64.txt',
              },
            },
          }),
        ),
      /Declare only the linux-x86_64 Python release target/,
    )
  })

  it('rejects a Mac smoke script', () => {
    assert.throws(
      () =>
        validateLinuxOnlyRelease(
          linuxOnlyFixture({
            scriptNames: ['smoke-appimage.sh', 'smoke-macos-dmg.sh'],
          }),
        ),
      /Remove the non-Linux release script: smoke-macos-dmg\.sh/,
    )
  })

  it('publishes no DMG release asset', () => {
    assert.doesNotThrow(() => validateLinuxOnlyRelease(linuxOnlyFixture()))
    assert.deepEqual(expectedAssetNames(VERSION), [
      'latest-linux.yml',
      `supraspina-${VERSION}-amd64.deb`,
      `supraspina-${VERSION}-x86_64.AppImage`,
      'release-acceptance.json',
    ])
  })

  it('the committed release surface stays Linux-only', async () => {
    const builder = await builderConfiguration()
    assert.deepEqual(builder.linux.target, ['AppImage', 'deb'])
    for (const key of ['mac', 'dmg', 'win', 'nsis', 'msi']) {
      assert.equal(key in builder, false)
    }
  })
})

describe('the product identity and brand contract', () => {
  it('the committed manifests carry the reviewed identity', async () => {
    const [packageJson, builder] = await Promise.all([
      packageManifest(),
      builderConfiguration(),
    ])
    assert.equal(builder.appId, 'io.github.qwareeq8.supraspina')
    assert.equal(builder.productName, 'Supraspina')
    assert.equal(packageJson.description, RELEASE_CONTRACT.researchDescription)
    assert.equal(builder.linux.synopsis, RELEASE_CONTRACT.linuxSynopsis)
    assert.notEqual(parseAppVersion(packageJson.version), null)
    assert.equal(packageJson.author.name, 'Yusuf Qwareeq')
    assert.equal(packageJson.author.email, 'yusuf@qwareeq.com')
    assert.equal(builder.linux.maintainer, 'Yusuf Qwareeq <yusuf@qwareeq.com>')
    assert.equal(builder.linux.vendor, 'Yusuf Qwareeq')
    assert.equal(builder.linux.category, 'Science')
    assert.equal(builder.deb.packageCategory, 'science')
    assert.equal(builder.deb.priority, 'optional')
    assert.equal(
      builder.releaseInfo.releaseDate,
      appVersionDate(packageJson.version),
    )
  })

  it('rejects stale, missing, or extended user-facing package descriptions', async () => {
    const [packageJson, builder] = await Promise.all([
      packageManifest(),
      builderConfiguration(),
    ])
    for (const description of [
      'Supraspina is an operator console.',
      undefined,
      `${RELEASE_CONTRACT.researchDescription} Additional text.`,
    ]) {
      assert.throws(
        () =>
          validateProductIdentity({
            packageJson: { ...packageJson, description },
            builder,
            brandDigests: BRAND_ASSET_DIGESTS,
          }),
        /Use the reviewed first-party package identity/,
      )
    }
    for (const synopsis of [
      'Operator console for Supraspina',
      undefined,
      `${RELEASE_CONTRACT.linuxSynopsis} with extra text`,
    ]) {
      assert.throws(
        () =>
          validateProductIdentity({
            packageJson,
            builder: { ...builder, linux: { ...builder.linux, synopsis } },
            brandDigests: BRAND_ASSET_DIGESTS,
          }),
        /Use the reviewed packaged product identity/,
      )
    }
  })

  it('rejects a stale brand asset digest', async () => {
    const [packageJson, builder] = await Promise.all([
      packageManifest(),
      builderConfiguration(),
    ])
    const brandDigests = {
      ...BRAND_ASSET_DIGESTS,
      'packaging/icon.png': 'f'.repeat(64),
    }
    assert.throws(
      () =>
        validateProductIdentity({
          packageJson,
          builder,
          brandDigests,
        }),
      /Match the reviewed brand asset digest: packaging\/icon\.png/,
    )
  })

  it('Every committed brand asset matches its reviewed digest.', async () => {
    for (const [name, expected] of Object.entries(BRAND_ASSET_DIGESTS)) {
      const value = await readFile(new URL(`../${name}`, import.meta.url))
      assert.equal(
        createHash('sha256').update(value).digest('hex'),
        expected,
        `Match the reviewed digest for ${name}.`,
      )
    }
  })

  it('The canonical mark renders a square 512-pixel transparent icon.', async () => {
    const png = await readFile(
      new URL('../packaging/icon.png', import.meta.url),
    )
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG')
    assert.equal(png.readUInt32BE(16), 512)
    assert.equal(png.readUInt32BE(20), 512)
    // Require an RGBA color type so the launcher icon keeps its transparency.
    assert.equal(png[25], 6)
  })

  it('Every brand variant has its approved accessible name.', async () => {
    for (const name of Object.keys(BRAND_ASSET_DIGESTS)) {
      if (!name.endsWith('.svg')) continue
      const svg = await readFile(new URL(`../${name}`, import.meta.url), 'utf8')
      assert.match(svg, /aria-label="Supraspina icon"/)
      assert.match(svg, /role="img"/)
    }
  })
})

describe('the AppImage launch contract', () => {
  it('the committed configuration keeps the sandbox enabled', async () => {
    const builder = await builderConfiguration()
    assert.doesNotThrow(() => validateAppImageLaunchSafety(builder))
    assert.equal(builder.toolsets.appimage, '1.0.3')
    assert.deepEqual(builder.appImage.executableArgs, [])
  })

  it('rejects the legacy AppImage toolset', () => {
    assert.throws(
      () =>
        validateAppImageLaunchSafety({
          toolsets: { appimage: '0.0.0' },
          appImage: { executableArgs: [] },
        }),
      /Build the AppImage with toolset 1\.0\.3/,
    )
    assert.throws(
      () => validateAppImageLaunchSafety({ appImage: { executableArgs: [] } }),
      /Build the AppImage with toolset 1\.0\.3/,
    )
  })

  it('rejects implicit or sandbox-disabling launcher arguments', () => {
    assert.throws(
      () => validateAppImageLaunchSafety({ toolsets: { appimage: '1.0.3' } }),
      /Declare an explicitly empty AppImage executableArgs list/,
    )
    assert.throws(
      () =>
        validateAppImageLaunchSafety({
          toolsets: { appimage: '1.0.3' },
          appImage: { executableArgs: ['--no-sandbox'] },
        }),
      /Declare an explicitly empty AppImage executableArgs list/,
    )
    assert.throws(
      () =>
        validateAppImageLaunchSafety({
          toolsets: { appimage: '1.0.3' },
          appImage: { executableArgs: [] },
          linux: { executableArgs: ['--no-sandbox'] },
        }),
      /Keep the Chromium sandbox enabled in every launcher/,
    )
  })
})

describe('the packaging layout and publish coordinates', () => {
  const reviewedLayout = () => ({
    asar: true,
    files: ['out/**/*', '!**/*.map'],
    directories: { output: 'release', buildResources: 'packaging' },
    publish: { provider: 'github', owner: 'qwareeq8', repo: 'supraspina' },
  })

  it('accepts the reviewed electron-builder layout', () => {
    assert.doesNotThrow(() => validatePackagingLayout(reviewedLayout()))
  })

  it('rejects an unpacked application bundle', () => {
    assert.throws(
      () => validatePackagingLayout({ ...reviewedLayout(), asar: false }),
      /Pack the built application into an asar archive\./,
    )
  })

  it('rejects an unreviewed packaged file list', () => {
    assert.throws(
      () =>
        validatePackagingLayout({
          ...reviewedLayout(),
          files: ['out/**/*'],
        }),
      /Package exactly the reviewed build output and no source maps\./,
    )
    assert.throws(
      () =>
        validatePackagingLayout({
          ...reviewedLayout(),
          files: ['out/**/*', '!**/*.map', 'src/**/*'],
        }),
      /Package exactly the reviewed build output and no source maps\./,
    )
  })

  it('rejects a moved artifact output directory', () => {
    assert.throws(
      () =>
        validatePackagingLayout({
          ...reviewedLayout(),
          directories: { output: 'dist', buildResources: 'packaging' },
        }),
      /Write packaged artifacts to release\/, where the release procedure reads them\./,
    )
  })

  it('rejects foreign or incomplete publish coordinates', () => {
    for (const publish of [
      { provider: 'generic', owner: 'qwareeq8', repo: 'supraspina' },
      { provider: 'github', owner: 'someone-else', repo: 'supraspina' },
      { provider: 'github', owner: 'qwareeq8', repo: 'other-project' },
      { provider: 'github', owner: 'qwareeq8' },
      {
        provider: 'github',
        owner: 'qwareeq8',
        repo: 'supraspina',
        releaseType: 'release',
      },
    ]) {
      assert.throws(
        () => validatePackagingLayout({ ...reviewedLayout(), publish }),
        /Publish to qwareeq8\/supraspina through the github provider\./,
      )
    }
  })

  it('binds the checked contract to the committed configuration', async () => {
    const builder = loadYaml(
      await readFile(
        new URL('../electron-builder.yml', import.meta.url),
        'utf8',
      ),
    )

    assert.deepEqual(builder.publish, RELEASE_CONTRACT.publish)
    assert.deepEqual(builder.files, [...RELEASE_CONTRACT.packagedFiles])
    assert.equal(builder.asar, true)
    assert.equal(builder.directories.output, RELEASE_CONTRACT.outputDirectory)
    assert.doesNotThrow(() => validatePackagingLayout(builder))
  })
})

describe('the command-line entry point', () => {
  it('reports a failed check as one actionable line', () => {
    assert.equal(
      formatReleaseConsistencyFailure(
        new Error('Set --mode to metadata or strict.'),
      ),
      'check-release: Set --mode to metadata or strict.',
    )
    assert.equal(
      formatReleaseConsistencyFailure('rejected'),
      'check-release: rejected',
    )
    assert.equal(
      formatReleaseConsistencyFailure(new Error('')),
      'check-release: The release-consistency check failed.',
    )
  })

  it('keeps the success sentence on the standard output stream', async () => {
    const stdout = collectingStream()
    const stderr = collectingStream()
    const { version } = await packageManifest()

    assert.equal(
      await main({ argv: ['--mode', 'metadata'], stdout, stderr }),
      0,
    )
    assert.deepEqual(stdout.written, [
      `${formatReleaseConsistencySuccess('metadata', version)}\n`,
    ])
    assert.deepEqual(stderr.written, [])
  })

  it('writes one failure line to the error stream and returns 1', async () => {
    const stdout = collectingStream()
    const stderr = collectingStream()

    assert.equal(await main({ argv: ['--mode', 'bogus'], stdout, stderr }), 1)
    assert.deepEqual(stderr.written, [
      'check-release: Set --mode to metadata or strict.\n',
    ])
    assert.deepEqual(stdout.written, [])
  })

  it('exits 1 without a stack trace when the check fails', async () => {
    const script = fileURLToPath(
      new URL('./check-release.mjs', import.meta.url),
    )
    const failure = await runNode(process.execPath, [script, '--mode', 'bogus'])
      .then(() => null)
      .catch((error) => error)

    assert.equal(failure.code, 1)
    assert.equal(failure.stdout, '')
    assert.equal(
      failure.stderr,
      'check-release: Set --mode to metadata or strict.\n',
    )
  })
})
