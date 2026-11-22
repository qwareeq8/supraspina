/** Tests for deterministic synthetic documentation screenshot capture. */

import assert from 'node:assert/strict'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  CAPTURE_COMMAND,
  DOCUMENTATION_ROUTES,
  captureArguments,
  createManifest,
  publishCapturedSet,
} from './capture-documentation-screenshots.cjs'

const CAPTURE_IDENTITY = Object.freeze({
  source: Object.freeze({
    algorithm: 'sha256-path-length-content-v1',
    fileCount: 100,
    sha256: 'b'.repeat(64),
  }),
  runtime: Object.freeze({
    engine: 'playwright-chromium',
    platform: 'linux-x86_64',
    playwright: '1.61.1',
    chromiumRevision: '1234',
    chromiumVersion: '141.0.7390.37',
  }),
})

describe('deterministic synthetic documentation screenshot capture', () => {
  it('captures every approved screen, including mixed logs', () => {
    assert.deepEqual(
      DOCUMENTATION_ROUTES.map(({ label, slug, state }) => ({
        label,
        slug,
        state,
      })),
      [
        { label: 'Dashboard', slug: 'dashboard', state: 'populated' },
        { label: 'Subjects', slug: 'subjects', state: 'populated' },
        { label: 'Runs', slug: 'runs', state: 'populated' },
        { label: 'Logs', slug: 'logs', state: 'populated' },
        { label: 'QC review', slug: 'qc-review', state: 'populated' },
        { label: 'Results', slug: 'results', state: 'populated' },
        { label: 'Analysis', slug: 'analysis', state: 'populated' },
        { label: 'Analysis', slug: 'analysis-grid', state: 'analysis-grid' },
        { label: 'Diagnostics', slug: 'diagnostics', state: 'populated' },
      ],
    )
  })

  it('requests the dark redacted fixture at the canonical viewport', () => {
    const route = DOCUMENTATION_ROUTES.find(({ slug }) => slug === 'qc-review')
    assert.ok(route)
    assert.deepEqual(captureArguments(route), [
      'scripts/shot.cjs',
      'QC review',
      'qc-review',
      '--documentation',
      '--dark',
      '--density',
      'Cozy',
      '--reduced-motion',
      '--state',
      'populated',
      '--w',
      '1600',
      '--h',
      '1000',
      '--dsf',
      '2',
      '--wait',
      '900',
    ])
  })

  it('declares every requested synthetic state and redacted display field', () => {
    const records = Object.fromEntries(
      DOCUMENTATION_ROUTES.map((route) => [
        `${route.slug}.png`,
        {
          route: route.label,
          state: route.state,
          width: 3200,
          height: 2000,
          sha256: 'a'.repeat(64),
        },
      ]),
    )
    const manifest = createManifest(records, CAPTURE_IDENTITY)

    assert.equal(manifest.schemaVersion, 3)
    assert.deepEqual(manifest.fixture.subjectStateCoverage, [
      'done',
      'running',
      'failed',
      'pending',
    ])
    assert.deepEqual(manifest.fixture.runStateCoverage, [
      'done',
      'running',
      'failed',
      'blocked',
    ])
    assert.deepEqual(manifest.fixture.jobStateCoverage, [
      'done',
      'running',
      'queued',
      'failed',
      'blocked',
    ])
    assert.deepEqual(manifest.fixture.logLevelCoverage, [
      'INFO',
      'WARN',
      'ERROR',
    ])
    assert.deepEqual(manifest.fixture.qcVerdictCoverage, [
      'pass',
      'fail',
      'defer',
      'unreviewed',
    ])
    assert.deepEqual(manifest.fixture.resultStateCoverage, [
      'produced',
      'partial',
      'expected',
      'absent',
      'unknown',
    ])
    assert.deepEqual(manifest.fixture.diagnosticStateCoverage, [
      'found',
      'warning',
      'wrong version',
      'missing',
      'not checked',
    ])
    assert.deepEqual(manifest.fixture.redactedDisplayFields, [
      'age and sex',
      'cohort',
      'AIS',
      'dates and times',
      'reviewer note',
    ])
    assert.equal(manifest.fixture.qcPanelPlaceholder, 'Synthetic QC panel')
    assert.equal(manifest.fixture.qcAnatomyIncluded, false)
    assert.equal(manifest.fixture.realParticipantDataIncluded, false)
    assert.equal(manifest.reproduction.command, CAPTURE_COMMAND)
    assert.deepEqual(
      manifest.reproduction.sourceIdentity,
      CAPTURE_IDENTITY.source,
    )
    assert.deepEqual(
      manifest.reproduction.runtimeIdentity,
      CAPTURE_IDENTITY.runtime,
    )
  })

  it('publishes only one complete staged screenshot set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-synthetic-capture-'))
    try {
      const captureDirectory = join(root, 'capture')
      const outputDirectory = join(root, 'output')
      await Promise.all([
        mkdir(captureDirectory, { recursive: true }),
        mkdir(outputDirectory, { recursive: true }),
      ])
      const names = [
        ...DOCUMENTATION_ROUTES.map(({ slug }) => `${slug}.png`),
        'MANIFEST.json',
      ]
      for (const name of names) {
        await writeFile(join(captureDirectory, name), `new ${name}`)
        await writeFile(join(outputDirectory, name), `old ${name}`)
      }

      await publishCapturedSet(captureDirectory, outputDirectory)

      for (const name of names) {
        assert.equal(
          await readFile(join(outputDirectory, name), 'utf8'),
          `new ${name}`,
        )
      }
      await writeFile(join(outputDirectory, 'retired.png'), 'retired')
      await publishCapturedSet(captureDirectory, outputDirectory)
      await assert.rejects(access(join(outputDirectory, 'retired.png')))

      await rm(join(captureDirectory, names[0]))
      await assert.rejects(
        publishCapturedSet(captureDirectory, outputDirectory),
        /Provide the complete staged synthetic screenshot set\./,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
