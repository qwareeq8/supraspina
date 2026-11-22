import { describe, expect, it } from 'vitest'
import {
  UNKNOWN_BUILD_IDENTITY,
  describeProductVersion,
  parseBuildIdentity,
  shortBuildCommit,
} from './build-identity'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

describe('parseBuildIdentity', () => {
  it('keeps a development build and a clean release', () => {
    expect(
      parseBuildIdentity({ kind: 'development', commit: COMMIT, dirty: true }),
    ).toEqual({ kind: 'development', commit: COMMIT, dirty: true })
    expect(
      parseBuildIdentity({ kind: 'release', commit: COMMIT, dirty: false }),
    ).toEqual({ kind: 'release', commit: COMMIT, dirty: false })
    expect(
      parseBuildIdentity({
        kind: 'development',
        commit: 'c'.repeat(64),
        dirty: false,
      }).commit,
    ).toBe('c'.repeat(64))
  })

  it.each([
    ['no record', undefined],
    ['a string', 'development'],
    ['a modified release', { kind: 'release', commit: COMMIT, dirty: true }],
    ['an unknown kind', { kind: 'nightly', commit: COMMIT, dirty: false }],
    [
      'an abbreviated commit',
      { kind: 'development', commit: COMMIT.slice(0, 7), dirty: false },
    ],
    [
      'an uppercase commit',
      { kind: 'development', commit: COMMIT.toUpperCase(), dirty: false },
    ],
    ['a missing dirty state', { kind: 'development', commit: COMMIT }],
  ])('reports an unknown build for %s', (_label, value) => {
    expect(parseBuildIdentity(value)).toEqual(UNKNOWN_BUILD_IDENTITY)
  })
})

describe('describeProductVersion', () => {
  it('names the version alone for the release build', () => {
    expect(
      describeProductVersion('20261121.1830.0', {
        kind: 'release',
        commit: COMMIT,
        dirty: false,
      }),
    ).toBe('2026-11-21 18:30 UTC')
  })

  it('names the short commit of a development build', () => {
    expect(
      describeProductVersion('20261121.1830.0', {
        kind: 'development',
        commit: COMMIT,
        dirty: false,
      }),
    ).toBe('2026-11-21 18:30 UTC, development build 0123456')
    expect(
      describeProductVersion('20261121.1830.0', {
        kind: 'development',
        commit: COMMIT,
        dirty: true,
      }),
    ).toBe('2026-11-21 18:30 UTC, development build 0123456 (modified)')
  })

  it('shows a recorded version of an earlier form unchanged', () => {
    expect(
      describeProductVersion('1.2.0', {
        kind: 'release',
        commit: COMMIT,
        dirty: false,
      }),
    ).toBe('1.2.0')
  })

  it('states an unknown source commit', () => {
    expect(
      describeProductVersion('20261121.1830.0', UNKNOWN_BUILD_IDENTITY),
    ).toBe('2026-11-21 18:30 UTC, source commit unknown')
  })
})

describe('shortBuildCommit', () => {
  it('returns the hash the description names, and null without one', () => {
    expect(
      shortBuildCommit({ kind: 'development', commit: COMMIT, dirty: true }),
    ).toBe('0123456')
    expect(
      shortBuildCommit({ kind: 'release', commit: COMMIT, dirty: false }),
    ).toBeNull()
    expect(shortBuildCommit(UNKNOWN_BUILD_IDENTITY)).toBeNull()
  })
})
