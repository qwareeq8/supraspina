/** Tests for deterministic synthetic documentation screenshot provenance. */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  checkScreenshotProvenance,
  formatScreenshotProvenanceFailure,
  formatScreenshotProvenanceSuccess,
  main,
  readBounded,
  validateManifestDeclaration,
  validateScreenshotBytes,
} from './check-screenshot-provenance.mjs'

const CAPTURE_COMMAND = 'npm run build && npm run screenshots:documentation'

function collectingStream() {
  const written = []
  return { written, write: (chunk) => written.push(chunk) }
}

function createValidManifest() {
  return {
    schemaVersion: 3,
    fixture: {
      id: 'supraspina-synthetic-documentation-v2',
      source: 'scripts/shot.cjs',
      seed: 17,
      clock: '2026-07-22T16:00:00.000Z',
      dataClass: 'deterministic-synthetic',
      theme: 'dark',
      density: 'Cozy',
      projectName: 'Synthetic documentation study',
      subjectCount: 12,
      subjectStateCoverage: ['done', 'running', 'failed', 'pending'],
      runStateCoverage: ['done', 'running', 'failed', 'blocked'],
      jobStateCoverage: ['done', 'running', 'queued', 'failed', 'blocked'],
      logLevelCoverage: ['INFO', 'WARN', 'ERROR'],
      qcVerdictCoverage: ['pass', 'fail', 'defer', 'unreviewed'],
      resultStateCoverage: [
        'produced',
        'partial',
        'expected',
        'absent',
        'unknown',
      ],
      diagnosticStateCoverage: [
        'found',
        'warning',
        'wrong version',
        'missing',
        'not checked',
      ],
      redactedDisplayFields: [
        'age and sex',
        'cohort',
        'AIS',
        'dates and times',
        'reviewer note',
      ],
      qcPanelPlaceholder: 'Synthetic QC panel',
      qcAnatomyIncluded: false,
      realParticipantDataIncluded: false,
    },
    reproduction: {
      command: CAPTURE_COMMAND,
      sourceIdentity: {
        algorithm: 'sha256-path-length-content-v1',
        fileCount: 100,
        sha256: 'b'.repeat(64),
      },
      runtimeIdentity: {
        engine: 'playwright-chromium',
        platform: 'linux-x86_64',
        playwright: '1.61.1',
        chromiumRevision: '1234',
        chromiumVersion: '141.0.7390.37',
      },
      viewport: {
        cssWidth: 1600,
        cssHeight: 1000,
        deviceScaleFactor: 2,
      },
    },
    images: {},
  }
}

describe('committed screenshot provenance', () => {
  it('checks every screenshot against its deterministic synthetic manifest', async () => {
    assert.equal(await checkScreenshotProvenance(), 9)
  })

  it('accepts the complete synthetic dark-theme declaration', () => {
    assert.doesNotThrow(() =>
      validateManifestDeclaration(createValidManifest()),
    )
  })

  it('rejects a changed screenshot even when the manifest dimensions match', async () => {
    const bytes = await readFile(
      new URL('../docs/screenshots/dashboard.png', import.meta.url),
    )
    const changed = Buffer.from(bytes)
    changed[changed.length - 1] ^= 1
    assert.throws(
      () =>
        validateScreenshotBytes(
          'dashboard.png',
          {
            width: 3200,
            height: 2000,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          changed,
        ),
      /committed SHA-256/,
    )
  })

  it('rejects PNG metadata even when the digest and dimensions match', async () => {
    const bytes = await readFile(
      new URL('../docs/screenshots/dashboard.png', import.meta.url),
    )
    const metadataChunk = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from('tEXt'),
      Buffer.alloc(4),
    ])
    const changed = Buffer.concat([
      bytes.subarray(0, bytes.length - 12),
      metadataChunk,
      bytes.subarray(bytes.length - 12),
    ])
    assert.throws(
      () =>
        validateScreenshotBytes(
          'dashboard.png',
          {
            width: 3200,
            height: 2000,
            sha256: createHash('sha256').update(changed).digest('hex'),
          },
          changed,
        ),
      /Remove PNG metadata \(tEXt\)\./,
    )
  })

  it('rejects any real-participant data declaration', () => {
    const manifest = createValidManifest()
    manifest.fixture.realParticipantDataIncluded = true
    assert.throws(
      () => validateManifestDeclaration(manifest),
      /deterministic synthetic dark-theme declaration/,
    )
  })

  it('rejects any QC anatomy declaration', () => {
    const manifest = createValidManifest()
    manifest.fixture.qcAnatomyIncluded = true
    assert.throws(
      () => validateManifestDeclaration(manifest),
      /deterministic synthetic dark-theme declaration/,
    )
  })

  it('rejects incomplete state and redaction coverage', () => {
    for (const field of [
      'subjectStateCoverage',
      'runStateCoverage',
      'jobStateCoverage',
      'logLevelCoverage',
      'qcVerdictCoverage',
      'resultStateCoverage',
      'diagnosticStateCoverage',
      'redactedDisplayFields',
    ]) {
      const manifest = createValidManifest()
      manifest.fixture[field] = manifest.fixture[field].slice(0, -1)
      assert.throws(
        () => validateManifestDeclaration(manifest),
        /deterministic synthetic dark-theme declaration/,
      )
    }
  })

  it('names each stale renderer source or browser identity field', () => {
    for (const { mutate, mismatch } of [
      {
        mutate: (manifest) => {
          manifest.reproduction.sourceIdentity.sha256 = 'c'.repeat(64)
        },
        mismatch:
          `reproduction.sourceIdentity.sha256 declares "${'c'.repeat(64)}" ` +
          `but this checkout computes "${'b'.repeat(64)}".`,
      },
      {
        mutate: (manifest) => {
          manifest.reproduction.sourceIdentity.fileCount = 101
        },
        mismatch:
          'reproduction.sourceIdentity.fileCount declares 101 but this ' +
          'checkout computes 100.',
      },
      {
        mutate: (manifest) => {
          manifest.reproduction.runtimeIdentity.chromiumRevision = '9999'
        },
        mismatch:
          'reproduction.runtimeIdentity.chromiumRevision declares "9999" but ' +
          'this checkout computes "1234".',
      },
      {
        mutate: (manifest) => {
          manifest.reproduction.runtimeIdentity.chromiumVersion =
            '141.0.7390.38'
        },
        mismatch:
          'reproduction.runtimeIdentity.chromiumVersion declares ' +
          '"141.0.7390.38" but this checkout computes "141.0.7390.37".',
      },
    ]) {
      const manifest = createValidManifest()
      const expected = structuredClone(manifest.reproduction)
      mutate(manifest)
      assert.throws(
        () => validateManifestDeclaration(manifest, expected),
        (error) => {
          assert.equal(
            error.message,
            `Recapture the documentation screenshots with \`${CAPTURE_COMMAND}\`: ${mismatch}`,
          )
          return true
        },
      )
    }
  })

  it('names each mismatched fixture, identity, and viewport declaration', () => {
    for (const { mutate, mismatch } of [
      {
        mutate: (manifest) => {
          manifest.fixture.theme = 'light'
        },
        mismatch: 'fixture.theme is "light" but must be "dark".',
      },
      {
        mutate: (manifest) => {
          delete manifest.fixture.density
        },
        mismatch: 'fixture.density is absent but must be "Cozy".',
      },
      {
        mutate: (manifest) => {
          manifest.fixture.realParticipantDataIncluded = true
        },
        mismatch:
          'fixture.realParticipantDataIncluded is true but must be false.',
      },
      {
        mutate: (manifest) => {
          manifest.reproduction.sourceIdentity.fileCount = 0
        },
        mismatch:
          'reproduction.sourceIdentity.fileCount is 0 but must be a positive ' +
          'integer.',
      },
      {
        mutate: (manifest) => {
          manifest.reproduction.sourceIdentity.sha256 = 'C'.repeat(64)
        },
        mismatch:
          `reproduction.sourceIdentity.sha256 is "${'C'.repeat(64)}" but ` +
          'must be a lowercase 64-character SHA-256 digest.',
      },
      {
        mutate: (manifest) => {
          manifest.reproduction.runtimeIdentity.chromiumVersion = '141.0.7390'
        },
        mismatch:
          'reproduction.runtimeIdentity.chromiumVersion is "141.0.7390" but ' +
          'must be a four-part version number.',
      },
      {
        mutate: (manifest) => {
          manifest.reproduction.viewport.cssWidth = 1440
        },
        mismatch: 'reproduction.viewport.cssWidth is 1440 but must be 1600.',
      },
    ]) {
      const manifest = createValidManifest()
      mutate(manifest)
      assert.throws(
        () => validateManifestDeclaration(manifest),
        (error) => {
          assert.equal(
            error.message,
            `Restore the deterministic synthetic dark-theme declaration: ${mismatch}`,
          )
          return true
        },
      )
    }
  })

  it('reports every mismatched declaration field in one line', () => {
    const manifest = createValidManifest()
    manifest.fixture.seed = 18
    manifest.reproduction.viewport.deviceScaleFactor = 1

    assert.throws(
      () => validateManifestDeclaration(manifest),
      (error) => {
        assert.equal(
          error.message,
          'Restore the deterministic synthetic dark-theme declaration: ' +
            'fixture.seed is 18 but must be 17. ' +
            'reproduction.viewport.deviceScaleFactor is 1 but must be 2.',
        )
        return true
      },
    )
  })

  it('enforces the screenshot verifier read ceiling', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'supraspina-shot-bound-test-'),
    )
    try {
      const file = join(directory, 'bounded.bin')
      await writeFile(file, Buffer.alloc(16))
      assert.equal((await readBounded(file, 16)).length, 16)
      await writeFile(file, Buffer.alloc(17))
      await assert.rejects(readBounded(file, 16), /within 16 bytes\./)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('the command-line entry point', () => {
  it('keeps the success sentence on the standard output stream', async () => {
    const stdout = collectingStream()
    const stderr = collectingStream()

    assert.equal(await main({ check: async () => 12, stdout, stderr }), 0)
    assert.deepEqual(stdout.written, [
      'Verified screenshot provenance: 12 deterministic synthetic dark-theme PNGs.\n',
    ])
    assert.deepEqual(stderr.written, [])
  })

  it('writes one failure line to the error stream and returns 1', async () => {
    const stdout = collectingStream()
    const stderr = collectingStream()
    const check = async () => {
      throw new Error('Recapture the documentation screenshots.')
    }

    assert.equal(await main({ check, stdout, stderr }), 1)
    assert.deepEqual(stderr.written, [
      'check-screenshot-provenance: Recapture the documentation screenshots.\n',
    ])
    assert.deepEqual(stdout.written, [])
  })

  it('names the gate when an error carries no message', () => {
    assert.equal(
      formatScreenshotProvenanceSuccess(3),
      'Verified screenshot provenance: 3 deterministic synthetic dark-theme PNGs.',
    )
    assert.equal(
      formatScreenshotProvenanceFailure(new Error('')),
      'check-screenshot-provenance: The screenshot-provenance check failed.',
    )
    assert.equal(
      formatScreenshotProvenanceFailure('rejected'),
      'check-screenshot-provenance: rejected',
    )
  })
})
