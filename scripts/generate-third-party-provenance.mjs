#!/usr/bin/env node
/** Generates or checks the reviewed file-level redistribution provenance inventory. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const repositoryRoot = resolve(new URL('../', import.meta.url).pathname)
const upstreamArchive = {
  byteSize: 6_149_418,
  commit: '8a8c2d3586a37bb896bd8bdc3743b43e602827e3',
  repository: 'https://github.com/ortizo-117/SCI_Map',
  sha256: 'd6f0c28a19bc71af119774f20d6b82be5d047d21ac78cbc168456c984c28dee7',
  url: 'https://codeload.github.com/ortizo-117/SCI_Map/tar.gz/8a8c2d3586a37bb896bd8bdc3743b43e602827e3',
}
const latinModernFonts = Object.freeze({
  'resources/fonts/lmroman10-bold.otf': Object.freeze({
    face: 'bold',
    sourceByteSize: 111240,
    sourceSha256:
      '102fe06c430a8b681b2bf6876b7cd967ae4d47b4b6b41d915eb7913b726d9fb1',
  }),
  'resources/fonts/lmroman10-bolditalic.otf': Object.freeze({
    face: 'bolditalic',
    sourceByteSize: 118204,
    sourceSha256:
      'c37a28eed7a6e03f792b98b5e5f637b2fcda378bb4855f99284f1a88fe35f124',
  }),
  'resources/fonts/lmroman10-italic.otf': Object.freeze({
    face: 'italic',
    sourceByteSize: 118828,
    sourceSha256:
      'c1fce25075567bb8dbf2151658c3b442690041db17a2d49fc9e55905ea5b7169',
  }),
  'resources/fonts/lmroman10-regular.otf': Object.freeze({
    face: 'regular',
    sourceByteSize: 111536,
    sourceSha256:
      '1aa18cfefa58132c52ce5de70db1fd1154201c19cd2b2cdaffba4906a33e6852',
  }),
})
const brainChartsRaw =
  'https://raw.githubusercontent.com/predictive-clinical-neuroscience/braincharts/5a1a7822e6f54405b0a826cf137d584240af307c'
const executableResources = new Set([
  'resources/enigma/compiled/FS_external_QC',
  'resources/enigma/compiled/func_make_corticalpngs_ENIGMA_QC',
  'resources/enigma/compiled/func_make_subcorticalFS_ENIGMA_QC',
])

function trackedResources(root) {
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      'resources',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
    .split('\0')
    .filter(Boolean)
  const deleted = new Set(
    execFileSync('git', ['ls-files', '--deleted', '-z', 'resources'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\0')
      .filter(Boolean),
  )
  return paths
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .filter((path) => !deleted.has(path))
    .sort()
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function regularFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile())
    throw new Error(`Provide a regular provenance input: ${path}.`)
}

function resourceLicense(path, delivery) {
  if (path.startsWith('resources/fonts/')) return 'GUST-1.0-or-later'
  if (delivery !== 'bundled') return 'NOASSERTION'
  return 'MIT-First-Party'
}

function resourceKind(path) {
  if (path.startsWith('resources/enigma/compiled/')) return 'compiled-qc'
  if (path.startsWith('resources/enigma/ENIGMA_QC/')) return 'scientific-source'
  if (path.endsWith('.xlsx')) return 'scientific-template'
  if (path.startsWith('resources/fonts/')) return 'scientific-figure-font'
  return 'pipeline-support'
}

function resourceMode(path) {
  return executableResources.has(path) ? '0700' : '0600'
}

async function fontInventory(root) {
  const directory = join(root, 'src/renderer/assets/fonts')
  return Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith('.woff2'))
      .sort()
      .map(async (name) => {
        const path = join(directory, name)
        await regularFile(path)
        return {
          path: relative(root, path),
          sha256: await sha256(path),
          family: name.split(' 10 ')[0],
          license: 'GUST-1.0-or-later',
          delivery: 'bundled',
        }
      }),
  )
}

/**
 * Build the record of one file the sidecar acquires from the pinned archive.
 *
 * @param {string} path - The installed resource path.
 * @param {{sha256?: string}} item - The reviewed fixture entry.
 * @param {string} delivery - The acquisition delivery mode.
 * @param {object} provenance - The upstream identity of the file.
 * @returns {object}
 * @throws {Error} On an entry without a reviewed installed SHA-256.
 */
function acquiredRecord(path, item, delivery, provenance) {
  if (!/^[0-9a-f]{64}$/.test(item.sha256 ?? '')) {
    throw new Error(
      `Record the installed SHA-256 of this upstream file: ${path}.`,
    )
  }
  return {
    delivery,
    kind: resourceKind(path),
    license: resourceLicense(path, delivery),
    mode: resourceMode(path),
    provenance,
    sha256: item.sha256,
  }
}

/**
 * Require the ENIGMA checksum manifest, when present, to list exactly the
 * reviewed digests.
 *
 * @param {string} root
 * @param {Record<string, {sha256: string}>} resourceFiles
 * @throws {Error} On a manifest line that differs from the inventory.
 */
async function checkEnigmaManifest(root, resourceFiles) {
  const manifest = 'resources/enigma/CHECKSUMS.sha256'
  if (!resourceFiles[manifest]) return
  const listed = (await readFile(join(root, manifest), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha256, relative] = line.split('  ')
      return `${sha256}  resources/enigma/${relative}`
    })
    .sort()
  const expected = Object.entries(resourceFiles)
    .filter(
      ([path]) => path.startsWith('resources/enigma/') && path !== manifest,
    )
    .map(([path, record]) => `${record.sha256}  ${path}`)
    .sort()
  if (listed.join('\n') !== expected.join('\n')) {
    throw new Error(`Match ${manifest} to the reviewed ENIGMA digests.`)
  }
}

function inventoryPath(root) {
  return join(root, 'THIRD_PARTY_PROVENANCE.json')
}

/**
 * Build the reviewed file-level redistribution provenance inventory.
 *
 * @param {{root?: string}} [options] - `root` replaces the repository that
 *   contains this script.
 * @returns {Promise<object>}
 * @throws {Error} On unclassified, missing, or malformed resource evidence.
 */
export async function buildProvenanceInventory({ root = repositoryRoot } = {}) {
  const fixturePath = join(
    root,
    'sidecar/tests/fixtures/upstream-resource-blobs.json',
  )
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
  const exact = fixture.exactLocalToUpstreamBlobs
  const adapted = fixture.wrapperAdaptations
  const local = fixture.localOnlyOrReimplemented
  const added = fixture.addedAfterLocalStart ?? {}
  const records = new Map(
    Object.entries(exact)
      .map(([path, item]) => [
        path,
        acquiredRecord(path, item, 'checksum-pinned-user-acquisition', {
          classification: 'byte-identical-upstream',
          upstreamBlob: item.blob,
          upstreamPath: item.upstreamPath,
        }),
      ])
      .concat(
        Object.entries(adapted).map(([path, item]) => [
          path,
          acquiredRecord(
            path,
            item,
            'checksum-pinned-user-acquisition-plus-compatibility-transform',
            {
              classification: item.allowedCompatibilityDiffClassification,
              localStartBlob: item.localStartBlob,
              upstreamBlob: item.upstreamBlob,
              upstreamPath: item.upstreamPath,
            },
          ),
        ]),
      ),
  )
  for (const path of trackedResources(root)) {
    // Upstream files without a license come only from the pinned archive.
    if (records.has(path)) {
      throw new Error(
        `Remove this upstream file, which Supraspina acquires at run time: ${path}.`,
      )
    }
    const absolute = join(root, path)
    await regularFile(absolute)
    const font = latinModernFonts[path]
    const delivery = 'bundled'
    let provenance
    if (font) {
      provenance = {
        classification: 'byte-identical-reviewed-upstream',
        upstreamPath: `fonts/lm/fonts/opentype/public/lm/lmroman10-${font.face}.otf`,
        upstreamSha256: font.sourceSha256,
      }
    } else if (local[path]) {
      provenance = {
        classification: local[path].classification,
        localStartBlob: local[path].localStartBlob,
      }
    } else if (added[path]) {
      provenance = {
        classification: added[path].classification,
        upstreamCommit: added[path].upstreamCommit,
      }
    } else {
      throw new Error(`Add fidelity provenance for this resource: ${path}.`)
    }
    const fileSha256 = await sha256(absolute)
    if (font && fileSha256 !== font.sourceSha256) {
      throw new Error(`Match the reviewed Latin Modern source face: ${path}.`)
    }
    records.set(path, {
      delivery,
      kind: resourceKind(path),
      license: resourceLicense(path, delivery),
      mode: resourceMode(path),
      provenance,
      sha256: fileSha256,
      ...(font
        ? {
            fontEvidence: {
              productName: 'Latin Modern Roman 10',
              embeddedFamily: 'LM Roman 10',
              version: '2.004',
              format: 'OpenType/CFF',
              copyright:
                'Copyright 2003, 2009 B. Jackowski and J. M. Nowacki (on behalf of TeX users groups).',
              sourceUrl: `https://mirrors.ctan.org/fonts/lm/fonts/opentype/public/lm/lmroman10-${font.face}.otf`,
              sourceByteSize: font.sourceByteSize,
              sourceSha256: font.sourceSha256,
              glyphCount: 821,
              byteIdentity: 'source-equals-bundled',
              sourceManifest: 'licenses/MANIFEST-LM-Roman-Supraspina.txt',
            },
          }
        : {}),
    })
  }
  const resourceFiles = Object.fromEntries(
    [...records].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  )
  await checkEnigmaManifest(root, resourceFiles)

  return {
    schemaVersion: 1,
    reviewedAt: '2026-08-09',
    policy: {
      firstPartyLicense: 'LICENSE',
      firstPartyScope:
        'Apply the first-party license only to the original Supraspina desktop, sidecar, scripts, tests, documentation, analyses/ paper code, and explicitly classified reimplementations.',
      privateActivationLicense:
        'Treat a user-supplied FreeSurfer license.txt as activation material, not a redistribution license; never read, copy, hash, inventory, or bundle its contents.',
      unresolvedUpstreamRule:
        'Exclude files from upstream repositories with no explicit license from distributable staging, and require the user to acquire them from the pinned authoritative source.',
    },
    authoritativeEvidence: {
      braincharts: {
        licenseFile: 'licenses/GPL-3.0.txt',
        licenseSha256:
          '6323e4f7949aece19b6ae14e62f0e42a1de8d66e6ace79133e1dfa06ccf9994f',
        source:
          'https://github.com/predictive-clinical-neuroscience/braincharts/blob/5a1a7822e6f54405b0a826cf137d584240af307c/LICENSE',
        notice:
          'https://github.com/predictive-clinical-neuroscience/braincharts/blob/5a1a7822e6f54405b0a826cf137d584240af307c/NOTICE',
        noticeSha256:
          'f6e61c8e51e96c7841ea7008b888cfb96dbf22980d7d31107da6ed7ee82cb78e',
      },
      freeSurfer: {
        licenseFile: 'licenses/FreeSurfer-Software-License-1.0.txt',
        licenseSha256:
          '632d404ea17b9101d9ac87cf8f09e651d18eb20d2cc0ba8dbee77e85b8516307',
        sourceCommit: 'a553a3c0b720e06f2c0747c480a784c2c013cbdb',
        source:
          'https://github.com/freesurfer/freesurfer/blob/a553a3c0b720e06f2c0747c480a784c2c013cbdb/LICENSE.txt',
      },
      gustFonts: {
        licenseFile: 'licenses/GUST-FONT-LICENSE.txt',
        licenseSha256:
          '49ea6cb9257bbee0a3979c48a774cd221550ac1c20c95549efe45fc99cc18050',
        source: 'https://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt',
        latinModernDerivativeManifest:
          'licenses/MANIFEST-LM-Roman-Supraspina.txt',
        latinModernDerivativeManifestSha256: await sha256(
          join(root, 'licenses/MANIFEST-LM-Roman-Supraspina.txt'),
        ),
      },
      lucide: {
        licenseFile: 'licenses/Lucide-ISC.txt',
        licenseSha256:
          'b495047bd93a9b06913511076f504daba17d5bbeb3e0650f3bb53a4220329c57',
        version: '1.77.0',
        source: 'https://github.com/lucide-icons/lucide/blob/1.77.0/LICENSE',
      },
      micromamba: {
        licenseFile: 'licenses/micromamba-BSD-3-Clause.txt',
        licenseSha256:
          '41fd98a468e39d319911bd94f4e65d6ad6a7ea66559dd5aa4112f138ff9b629a',
        source: 'https://github.com/mamba-org/mamba/blob/2.7.0/LICENSE',
      },
      upstreamEnigmaProtocol: {
        licenseStatus: 'NOASSERTION',
        observedAt: '2026-08-09',
        observedCommit: 'e04beefc956f4fc782260b0a87cba29097505cd1',
        evidence:
          'At the observed commit, GitHub repository metadata reports license=null and the root tree contains no LICENSE or COPYING file.',
        repository: 'https://github.com/ENIGMA-git/ENIGMA-FreeSurfer-protocol',
      },
      upstreamBaseline: {
        licenseStatus: 'NOASSERTION',
        evidence:
          'The pinned tree contains no root LICENSE, LICENSE.md, or COPYING file and no scoped Step_2_QA_ENIGMA license file.',
        ...upstreamArchive,
      },
    },
    acquiredResources: {
      brainChartsModel: {
        title: 'BrainCharts lifespan normative model (lifespan_57K_82sites)',
        repository:
          'https://github.com/predictive-clinical-neuroscience/braincharts',
        commit: '5a1a7822e6f54405b0a826cf137d584240af307c',
        license: 'GPL-3.0',
        licenseEvidence: 'authoritativeEvidence.braincharts',
        citation:
          'Rutherford S, Fraza C, Dinga R, et al. Charting brain growth and aging at high spatial precision. eLife. 2022;11:e72904. doi:10.7554/eLife.72904',
        doi: '10.7554/eLife.72904',
        asset: {
          name: 'lifespan_57K_82sites.zip',
          path: 'models/lifespan_57K_82sites.zip',
          blob: 'e3a6c546a1fe689be70925a2bc71f0011fbecc7c',
          url: `${brainChartsRaw}/models/lifespan_57K_82sites.zip`,
          byteSize: 2796655,
          sha256:
            '60457279debb787ea2ce4175191bd2ac16214e84bd260c7dab3d8bf2f1095cc4',
        },
        lists: [
          {
            path: 'docs/site_ids_ct_82sites.txt',
            byteSize: 675,
            sha256:
              '854132b6c44adec3cab6d371179c3a9336800fa257e615907c95c49643d6005c',
          },
          {
            path: 'docs/phenotypes_ct_lh.txt',
            byteSize: 2294,
            sha256:
              '01f5aaaec1b5a0fa28f955c38e59b20e0b7495423f9f110e2b0552f413f5ba96',
          },
          {
            path: 'docs/phenotypes_ct_rh.txt',
            byteSize: 2294,
            sha256:
              '169718a054cbc6ef4d132fefbf4bc40413ae1f2b7c3732b0a2d9996df64c2959',
          },
          {
            path: 'docs/phenotypes_sc.txt',
            byteSize: 662,
            sha256:
              '6859e76a49231a1b3d2b47d424e65e01f164bddc05981d18d2145240f2f155f5',
          },
        ].map((entry) => ({
          ...entry,
          url: `${brainChartsRaw}/${entry.path}`,
        })),
        runtime: {
          packages:
            'pcntoolkit 0.35.0 (GPL-3.0) and its hashed dependency lock',
          locks: [
            'sidecar/supraspina_sidecar/braincharts_locks/braincharts-linux-64.lock',
            'sidecar/supraspina_sidecar/braincharts_locks/braincharts-requirements.txt',
          ],
          bundled: false,
        },
        delivery: 'explicit-operator-authorized-runtime-acquisition',
        bundled: false,
        cache: '${paths.outputDir}/.braincharts/current',
      },
      managedContainers: {
        inventory: 'SCIENTIFIC_RESOURCE_PINS.json',
        inventorySha256: await sha256(
          join(root, 'SCIENTIFIC_RESOURCE_PINS.json'),
        ),
        delivery: 'explicit-operator-authorized-runtime-acquisition',
        bundled: false,
        cache: 'Electron userData/scientific-resources',
      },
      pyBrainAgeModel: {
        title: 'PyBrainAge',
        version: 'v3',
        creator: {
          name: 'James Cole',
          affiliation: 'University College London',
          orcid: '0000-0003-1908-5588',
        },
        publicationDate: '2023-12-19',
        doi: '10.5281/zenodo.10406573',
        conceptDoi: '10.5281/zenodo.10405585',
        recordUrl: 'https://zenodo.org/records/10406573',
        license: 'CC-BY-4.0',
        relatedRelease:
          'https://github.com/james-cole/PyBrainAge/releases/tag/beta',
        asset: {
          name: 'PyBrainAge.zip',
          url: 'https://zenodo.org/records/10406573/files/PyBrainAge.zip',
          byteSize: 108063062,
          publishedMd5: 'a0c7589b762e1b10925e0ee6118d40cc',
          sha256:
            'c9e2ba3899b8005fba4b9b0991292c6e76de112595473c3e9e0e5b11e0308a95',
        },
        delivery: 'explicit-operator-authorized-runtime-acquisition',
        bundled: false,
        cache: '${paths.outputDir}/.pybrainage/pybrainage/v3',
      },
    },
    resourceFiles,
    rendererFonts: await fontInventory(root),
    generatedBinaryInputs: {
      micromambaLinuxX64: {
        asset: 'micromamba-linux-64',
        delivery: 'bundled-after-verified-maintainer-download',
        license: 'BSD-3-Clause',
        release: '2.7.0-0',
        sha256:
          'fb4554d61a1c567726890169e39c41aa8495dbba56f50957ee7356572b6c5726',
      },
    },
    distributableClosures: {
      node: {
        lock: 'package-lock.json',
        manifest: 'dependency-manifests/node-distributable.json',
        notices: 'dependency-manifests/node-third-party-notices.txt',
      },
      pythonLinuxX64: {
        lock: 'sidecar/requirements/release-linux-x86_64.txt',
        manifest:
          'dependency-manifests/python-release-linux-x86_64.cyclonedx.json',
        notices: 'dependency-manifests/python-release-linux-x86_64-notices.txt',
      },
    },
  }
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Write the reviewed provenance inventory over the committed one.
 *
 * @param {{root?: string}} [options] - `root` replaces the repository that
 *   contains this script.
 * @returns {Promise<object>}
 * @throws {Error} On unclassified, missing, or malformed resource evidence.
 */
export async function writeProvenanceInventory({ root = repositoryRoot } = {}) {
  const inventory = await buildProvenanceInventory({ root })
  await writeFile(inventoryPath(root), serialize(inventory), 'utf8')
  return inventory
}

/**
 * Verify the committed provenance inventory against current tracked resources.
 *
 * @param {{root?: string}} [options] - `root` replaces the repository that
 *   contains this script.
 * @returns {Promise<object>}
 * @throws {Error} On a stale or inconsistent provenance inventory.
 */
export async function checkProvenanceInventory({ root = repositoryRoot } = {}) {
  const expected = serialize(await buildProvenanceInventory({ root }))
  const actual = await readFile(inventoryPath(root), 'utf8')
  if (actual !== expected) {
    throw new Error(
      'Regenerate THIRD_PARTY_PROVENANCE.json by running npm run provenance:write.',
    )
  }
  return JSON.parse(actual)
}

async function main() {
  if (process.argv.includes('--write')) {
    const inventory = await writeProvenanceInventory()
    console.log(
      `Wrote third-party provenance for ${Object.keys(inventory.resourceFiles).length} resource files.`,
    )
    return
  }
  const inventory = await checkProvenanceInventory()
  console.log(
    `Verified third-party provenance for ${Object.keys(inventory.resourceFiles).length} resource files.`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
