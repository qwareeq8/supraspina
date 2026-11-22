import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { load as loadYaml } from 'js-yaml'

const workflowsDirectory = new URL('../.github/workflows/', import.meta.url)
const workflowPath = new URL(
  '../.github/workflows/quality-gates.yml',
  import.meta.url,
)

async function workflowSource() {
  return readFile(workflowPath, 'utf8')
}

async function workflow() {
  return loadYaml(await workflowSource())
}

describe('Release source-verification workflow contract', () => {
  it('keeps exactly one read-only workflow with matching identity', async () => {
    const files = (await readdir(workflowsDirectory)).sort()
    const parsed = await workflow()

    assert.deepEqual(files, ['quality-gates.yml'])
    assert.equal(parsed.name, 'CI')
    assert.deepEqual(parsed.permissions, { contents: 'read' })
    assert.deepEqual(Object.keys(parsed.jobs), ['release', 'verify'])
    assert.equal(parsed.jobs.verify.needs, 'release')
  })

  it('makes version-tag pushes the only trigger and never cancels a release tag', async () => {
    const parsed = await workflow()
    // `on` parses as the boolean true under the YAML 1.1 core schema.
    const triggers = parsed.on ?? parsed[true]

    assert.deepEqual(Object.keys(triggers), ['push'])
    assert.deepEqual(Object.keys(triggers.push), ['tags'])
    assert.deepEqual(triggers.push.tags, ['v[0-9]+.[0-9]+.0'])
    assert.equal(parsed.concurrency['cancel-in-progress'], false)
  })

  it('enforces the release identity contract before any other gate', async () => {
    const source = await workflowSource()
    for (const command of [
      'test "${GITHUB_REF_TYPE}" = "tag"',
      'test "${GITHUB_REF_NAME}" = "v${version}"',
      'test "$(git cat-file -t "refs/tags/${GITHUB_REF_NAME}")" = "tag"',
      'test "$(git rev-parse "${GITHUB_REF_NAME}^{}")" = "${GITHUB_SHA}"',
      'test "$(git rev-parse refs/remotes/origin/main)" = "${GITHUB_SHA}"',
      'npm run check:release:strict',
    ]) {
      assert.ok(
        source.includes(command),
        `Include this release-contract assertion: ${command}.`,
      )
    }
    assert.doesNotMatch(source, /1\.0\.0|rev-list --count HEAD/)
    const identity = source.indexOf('Refuse the wrong source or tag identity')
    const install = source.indexOf('Install locked desktop dependencies')
    assert.ok(identity >= 0 && identity < install)
  })

  it('runs every source, coverage, provenance, visual, and shell gate', async () => {
    const source = await workflowSource()
    for (const command of [
      'npm run check:release',
      'npm run check:prod-deps',
      'npm run check:provenance',
      'npm run check:python-locks',
      'npm run check:screenshots',
      'npm run format:check',
      'npm run typecheck',
      'npm run lint',
      'npm run test:scripts',
      'npm run test:cov',
      'npm run test:cov:critical',
      'npm run visual:test',
      'ruff format --check .',
      'ruff check .',
      'python -m supraspina_sidecar.scientific_assets --acquire',
      'pytest',
      '--cov=supraspina_sidecar',
      'python scripts/check_coverage.py coverage.json',
      'shellcheck scripts/*.sh',
      'git diff --check',
    ]) {
      assert.ok(
        source.includes(command),
        `Include this workflow command: ${command}.`,
      )
    }
    // The suite reads the acquired upstream files and runs the R resources,
    // so acquire the files and install R first.
    const suite = source.indexOf('Run the Python suite')
    assert.ok(source.indexOf('scientific_assets --acquire') < suite)
    assert.ok(source.indexOf('Install R and Pandoc') < suite)
  })

  it('authenticates refs against the configured release repository', async () => {
    const parsed = await workflow()
    const source = await workflowSource()

    assert.equal(
      parsed.env.SUPRASPINA_RELEASE_REPOSITORY,
      "${{ vars.SUPRASPINA_RELEASE_REPOSITORY || 'qwareeq8/supraspina' }}",
    )
    assert.ok(
      source.includes(
        'gh api "repos/${SUPRASPINA_RELEASE_REPOSITORY}/git/ref/heads/main"',
      ),
    )
    assert.doesNotMatch(source, /gh api "?repos\/qwareeq8/)
  })

  it('does not package, publish, sign, or upload artifacts', async () => {
    const source = await workflowSource()
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    )

    assert.equal(
      packageJson.scripts['visual:test'],
      'node scripts/visual-matrix.cjs --source',
    )
    assert.doesNotMatch(source, /npm run build|electron-vite build/)
    assert.doesNotMatch(source, /electron-builder|npm run package/)
    assert.doesNotMatch(source, /upload-artifact|download-artifact/)
    assert.doesNotMatch(source, /gh release|contents:\s*write/)
    assert.doesNotMatch(source, /codesign|notar/)
  })

  it('pins actions and disables checkout credential persistence', async () => {
    const { jobs } = await workflow()
    for (const job of Object.values(jobs)) {
      for (const step of job.steps) {
        if (!step.uses) continue
        assert.match(step.uses, /@[a-f0-9]{40}$/)
        if (step.uses.startsWith('actions/checkout@')) {
          assert.equal(step.with?.['persist-credentials'], false)
        }
      }
    }
  })
})
