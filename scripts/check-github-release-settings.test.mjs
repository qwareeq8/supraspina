import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  appliesToMain,
  appliesToStableTags,
  FORBIDDEN_MAIN_RULES,
  FORBIDDEN_TAG_RULES,
  REQUIRED_MAIN_RULES,
  validateGitHubReleaseSettings,
} from './check-github-release-settings.mjs'

function ruleset(target, include, types, overrides = {}) {
  return {
    id: target === 'branch' ? 101 : 102,
    name: `Rules for ${include}`,
    target,
    enforcement: 'active',
    bypass_actors: [],
    conditions: {
      ref_name: { include: [include], exclude: [] },
    },
    rules: types.map((type) => ({ type })),
    ...overrides,
  }
}

function fixture() {
  return {
    repository: {
      full_name: 'qwareeq8/supraspina',
      private: false,
      default_branch: 'main',
    },
    immutableReleases: { enabled: false, enforced_by_owner: false },
    rulesets: [
      ruleset('branch', 'refs/heads/main', ['deletion', 'non_fast_forward']),
      ruleset('tag', 'refs/tags/v*', ['creation']),
    ],
  }
}

describe('GitHub release settings', () => {
  it('accepts public main, mutable releases, and ordinary history protection', () => {
    assert.doesNotThrow(() => validateGitHubReleaseSettings(fixture()))
  })

  it('accepts a repository with no stable-tag ruleset at all', () => {
    const input = fixture()
    input.rulesets = input.rulesets.filter((entry) => entry.target !== 'tag')

    assert.doesNotThrow(() => validateGitHubReleaseSettings(input))
  })

  it('rejects an unexpected repository, visibility, or default branch', () => {
    for (const repository of [
      { ...fixture().repository, full_name: 'someone/supraspina' },
      { ...fixture().repository, private: true },
      { ...fixture().repository, private: undefined },
      { ...fixture().repository, default_branch: 'master' },
    ]) {
      assert.throws(
        () => validateGitHubReleaseSettings({ ...fixture(), repository }),
        /qwareeq8\/supraspina|Make qwareeq8\/supraspina public/,
      )
    }
  })

  it('rejects enabled immutable releases', () => {
    assert.throws(
      () =>
        validateGitHubReleaseSettings({
          ...fixture(),
          immutableReleases: { enabled: true, enforced_by_owner: false },
        }),
      /Keep GitHub immutable releases disabled/,
    )
  })

  it('rejects a missing or unreadable immutable-release setting', () => {
    for (const immutableReleases of [
      undefined,
      null,
      {},
      { enabled: 'false' },
    ]) {
      assert.throws(
        () =>
          validateGitHubReleaseSettings({ ...fixture(), immutableReleases }),
        /Keep GitHub immutable releases disabled/,
      )
    }
  })

  it('rejects owner-enforced organization immutability', () => {
    assert.throws(
      () =>
        validateGitHubReleaseSettings({
          ...fixture(),
          immutableReleases: { enabled: false, enforced_by_owner: true },
        }),
      /Keep organization-level release immutability off/,
    )
  })

  it('rejects evaluate mode, bypass actors, exclusions, and missing protections', () => {
    const mutations = [
      (entry) => ({ ...entry, enforcement: 'evaluate' }),
      (entry) => ({
        ...entry,
        bypass_actors: [
          { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
        ],
      }),
      (entry) => ({
        ...entry,
        conditions: {
          ref_name: {
            ...entry.conditions.ref_name,
            exclude: ['refs/heads/main'],
          },
        },
      }),
      (entry) => ({
        ...entry,
        rules: entry.rules.filter(({ type }) => type !== 'non_fast_forward'),
      }),
    ]
    for (const mutate of mutations) {
      const input = fixture()
      input.rulesets[0] = mutate(input.rulesets[0])
      assert.throws(
        () => validateGitHubReleaseSettings(input),
        /Protect main branch with an active, no-bypass/,
      )
    }
  })

  it('rejects a bypass actor on an additional main ruleset', () => {
    const input = fixture()
    input.rulesets.push(
      ruleset('branch', 'refs/heads/main', ['deletion'], {
        id: 103,
        name: 'legacy bypass',
        bypass_actors: [
          { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
        ],
      }),
    )

    assert.throws(
      () => validateGitHubReleaseSettings(input),
      /Remove every bypass actor from the main ruleset: legacy bypass/,
    )
  })

  it('rejects any rule that freezes main or adds a universal requirement', () => {
    for (const forbidden of FORBIDDEN_MAIN_RULES) {
      const input = fixture()
      input.rulesets.push(
        ruleset('branch', 'refs/heads/main', [forbidden], {
          id: 104,
          name: 'main frozen release branch',
        }),
      )
      assert.throws(
        () => validateGitHubReleaseSettings(input),
        new RegExp(
          `Remove the ${forbidden} rule from the main ruleset: main frozen release branch`,
        ),
      )
    }
  })

  it('rejects a wildcard branch ruleset that freezes main indirectly', () => {
    const input = fixture()
    input.rulesets.push(
      ruleset('branch', '~ALL', ['update'], { id: 105, name: 'freeze all' }),
    )

    assert.throws(
      () => validateGitHubReleaseSettings(input),
      /Remove the update rule from the main ruleset: freeze all/,
    )
  })

  it('rejects any ruleset that makes published stable tags permanent', () => {
    for (const forbidden of FORBIDDEN_TAG_RULES) {
      const input = fixture()
      input.rulesets.push(
        ruleset('tag', 'refs/tags/v*', [forbidden], {
          id: 106,
          name: 'v tags permanent',
        }),
      )
      assert.throws(
        () => validateGitHubReleaseSettings(input),
        new RegExp(
          `Remove the ${forbidden} rule from the stable-tag ruleset: v tags permanent`,
        ),
      )
    }
  })

  it('keeps a tag-creation restriction permitted', () => {
    const input = fixture()
    input.rulesets[1] = ruleset('tag', 'refs/tags/v*', ['creation'], {
      bypass_actors: [
        { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
      ],
    })

    assert.doesNotThrow(() => validateGitHubReleaseSettings(input))
  })

  it('allows protections to be layered across active no-bypass rulesets', () => {
    const input = fixture()
    input.rulesets.splice(
      0,
      1,
      ruleset('branch', 'refs/heads/main', ['deletion']),
      ruleset('branch', 'refs/heads/main', ['non_fast_forward']),
    )

    assert.doesNotThrow(() => validateGitHubReleaseSettings(input))
  })

  it('rejects an absent ruleset inventory', () => {
    assert.throws(
      () => validateGitHubReleaseSettings({ ...fixture(), rulesets: null }),
      /Inspect the complete GitHub repository rulesets/,
    )
  })

  it('classifies ruleset scope by target, enforcement, and ref conditions', () => {
    assert.equal(appliesToMain(fixture().rulesets[0]), true)
    assert.equal(appliesToStableTags(fixture().rulesets[0]), false)
    assert.equal(appliesToStableTags(fixture().rulesets[1]), true)
    assert.equal(
      appliesToMain({
        ...fixture().rulesets[0],
        enforcement: 'disabled',
      }),
      false,
    )
    assert.equal(
      appliesToMain(
        ruleset('branch', '~DEFAULT_BRANCH', REQUIRED_MAIN_RULES.slice()),
      ),
      true,
    )
  })
})
