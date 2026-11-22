import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkPythonReleaseLocks,
  parseHashedLock,
} from './check-python-release-locks.mjs'

test('the reviewed Linux Python release locks are exact and hash complete', async () => {
  const result = await checkPythonReleaseLocks()
  assert.deepEqual(result, {
    python: '3.12.10',
    linuxPackages: 13,
    qualityPackages: 35,
    toolchainPackages: 12,
  })
})

test('lock parser rejects ranges, unhashed and duplicate requirements', () => {
  assert.throws(
    () => parseHashedLock('openpyxl>=3.1\n', 'fixture'),
    /Provide an exact requirement pin/,
  )
  assert.throws(
    () => parseHashedLock('openpyxl==3.1.5\n', 'fixture'),
    /Provide an exact requirement pin/,
  )
  assert.throws(
    () =>
      parseHashedLock(
        'openpyxl==3.1.5 --hash=sha256:' +
          `${'a'.repeat(64)}\n` +
          'openpyxl==3.1.5 --hash=sha256:' +
          `${'b'.repeat(64)}\n`,
        'fixture',
      ),
    /Remove duplicate package/,
  )
})
