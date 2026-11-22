import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  appVersionDate,
  appVersionFromDate,
  compareAppVersions,
  formatAppVersion,
  parseAppVersion,
} from './app-version.mjs'

describe('parseAppVersion', () => {
  it('reads the UTC date and time of a machine-form version', () => {
    assert.deepEqual(parseAppVersion('20261121.1830.0'), {
      year: 2026,
      month: 11,
      day: 21,
      hour: 18,
      minute: 30,
    })
    assert.deepEqual(parseAppVersion('20260101.0.0'), {
      year: 2026,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
    })
  })

  it('rejects other forms, leading zeros, and impossible instants', () => {
    for (const value of [
      '1.3.0',
      '20261121.0905.0',
      '20261121.1830.1',
      '20261121.1830',
      '20261121.2400.0',
      '20261121.1860.0',
      '20261131.1830.0',
      '20260229.1200.0',
      '20261300.1200.0',
      '02026112.1200.0',
      'v20261121.1830.0',
      '',
      null,
    ]) {
      assert.equal(parseAppVersion(value), null, String(value))
    }
    assert.notEqual(parseAppVersion('20280229.1200.0'), null)
  })
})

describe('formatAppVersion', () => {
  it('formats a machine-form version for people', () => {
    assert.equal(formatAppVersion('20261121.1830.0'), '2026-11-21 18:30 UTC')
    assert.equal(formatAppVersion('20261121.905.0'), '2026-11-21 09:05 UTC')
    assert.equal(formatAppVersion('20261121.0.0'), '2026-11-21 00:00 UTC')
  })

  it('returns a version of any other form unchanged', () => {
    assert.equal(formatAppVersion('1.2.0'), '1.2.0')
  })
})

describe('appVersionFromDate', () => {
  it('stamps the UTC minute without leading zeros in HHMM', () => {
    assert.equal(
      appVersionFromDate(new Date('2026-11-21T09:05:59.999Z')),
      '20261121.905.0',
    )
    assert.equal(
      appVersionFromDate(new Date('2026-11-21T00:00:00Z')),
      '20261121.0.0',
    )
    assert.equal(
      appVersionFromDate(new Date('2026-11-21T23:59:00-05:00')),
      '20261122.459.0',
    )
  })

  it('round-trips through the parser and the formatter', () => {
    const version = appVersionFromDate(new Date('2026-03-04T05:06:00Z'))
    assert.equal(formatAppVersion(version), '2026-03-04 05:06 UTC')
    assert.equal(appVersionDate(version), '2026-03-04')
  })
})

describe('compareAppVersions', () => {
  it('orders versions by instant, not by text', () => {
    assert.ok(compareAppVersions('20261121.905.0', '20261121.1830.0') < 0)
    assert.ok(compareAppVersions('20261122.0.0', '20261121.2359.0') > 0)
    assert.equal(compareAppVersions('20261121.1830.0', '20261121.1830.0'), 0)
  })

  it('rejects a value that is not a machine-form version', () => {
    assert.throws(
      () => compareAppVersions('1.3.0', '20261121.1830.0'),
      /YYYYMMDD\.HHMM\.0 UTC date-time version/,
    )
    assert.throws(() => appVersionDate('1.3.0'), /date-time version/)
  })
})
