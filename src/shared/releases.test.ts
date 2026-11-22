import { describe, expect, it } from 'vitest'
import { RELEASES_URL, releasePageUrl } from './releases'

describe('release pages', () => {
  it('links the release page of a date-time version', () => {
    expect(releasePageUrl('20261121.1830.0')).toBe(
      'https://github.com/qwareeq8/supraspina/releases/tag/v20261121.1830.0',
    )
  })

  it('falls back to the Releases page without a valid version', () => {
    expect(releasePageUrl(null)).toBe(RELEASES_URL)
    expect(releasePageUrl('1.3.0')).toBe(RELEASES_URL)
    expect(releasePageUrl('../../evil')).toBe(RELEASES_URL)
  })
})
