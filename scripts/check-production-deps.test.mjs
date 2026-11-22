import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  formatProductionDependencySuccess,
  isAtLeast,
  parseVersion,
} from './check-production-deps.mjs'

describe('production dependency version floor', () => {
  it('compares versions by the first differing component', () => {
    assert.equal(isAtLeast([4, 2, 999], [4, 3, 0]), false)
    assert.equal(isAtLeast([4, 3, 0], [4, 3, 1]), false)
    assert.equal(isAtLeast([4, 3, 1], [4, 3, 1]), true)
    assert.equal(isAtLeast([5, 0, 0], [4, 3, 1]), true)
  })

  it('rejects non-semantic lockfile versions', () => {
    assert.throws(
      () => parseVersion('4.3', 'js-yaml'),
      /Provide a valid lockfile version/,
    )
  })

  it('reports success as a past-tense sentence', () => {
    assert.equal(
      formatProductionDependencySuccess({
        updaterVersion: '6.8.9',
        yamlVersions: ['4.3.1'],
      }),
      'Verified production dependencies using electron-updater 6.8.9 and js-yaml 4.3.1.',
    )
  })
})
