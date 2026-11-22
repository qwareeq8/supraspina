import { describe, expect, it, vi } from 'vitest'
import {
  UPDATE_HOSTS,
  UPDATER_PARTITION,
  guardUpdateNetwork,
  isAllowedUpdateRequest,
} from './update-network'

const RELEASES = 'https://github.com/qwareeq8/supraspina/releases'

describe('the updater network allowlist', () => {
  it('names exactly the GitHub hosts the updater needs', () => {
    expect(UPDATE_HOSTS).toEqual([
      'github.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
    ])
    expect(UPDATER_PARTITION).toBe('electron-updater')
  })

  it('allows the feed, latest release, release pages, and assets', () => {
    for (const url of [
      `${RELEASES}.atom`,
      `${RELEASES}/latest`,
      `${RELEASES}/tag/v20261121.1830.0`,
      `${RELEASES}/download/v20261121.1830.0/latest-linux.yml`,
      `${RELEASES}/download/v20261121.1830.0/supraspina-20261121.1830.0-x86_64.AppImage`,
      'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sp=r&sig=x',
      'https://objects.githubusercontent.com/github-production-release-asset-2e65be/1?X-Amz-Signature=x',
    ]) {
      expect(isAllowedUpdateRequest(url), url).toBe(true)
    }
  })

  it('refuses other repositories, paths, hosts, schemes, and credentials', () => {
    for (const url of [
      'https://github.com/someone/supraspina/releases.atom',
      'https://github.com/qwareeq8/supraspina',
      'https://github.com/qwareeq8/supraspina/archive/main.tar.gz',
      `${RELEASES}/download/v1/latest-linux.yml/extra`,
      `${RELEASES}.atom?redirect=elsewhere`,
      'https://api.github.com/repos/qwareeq8/supraspina/releases/latest',
      'http://objects.githubusercontent.com/github-production-release-asset/1',
      'https://raw.githubusercontent.com/qwareeq8/supraspina/main/README.md',
      'https://github.com.evil.example/qwareeq8/supraspina/releases.atom',
      'http://github.com/qwareeq8/supraspina/releases.atom',
      'https://user:token@github.com/qwareeq8/supraspina/releases.atom',
      'https://github.com:8443/qwareeq8/supraspina/releases.atom',
      'http://release-assets.githubusercontent.com/asset',
      'not a url',
    ]) {
      expect(isAllowedUpdateRequest(url), url).toBe(false)
    }
  })

  it('cancels every updater request outside the allowlist', () => {
    const onBeforeRequest = vi.fn()
    guardUpdateNetwork({ webRequest: { onBeforeRequest } } as never)
    expect(onBeforeRequest).toHaveBeenCalledOnce()
    const listener = onBeforeRequest.mock.calls[0]![0] as (
      details: { url: string },
      callback: (response: { cancel: boolean }) => void,
    ) => void

    const allowed = vi.fn()
    listener({ url: `${RELEASES}.atom` }, allowed)
    expect(allowed).toHaveBeenCalledWith({ cancel: false })

    const refused = vi.fn()
    listener({ url: 'https://example.com/telemetry' }, refused)
    expect(refused).toHaveBeenCalledWith({ cancel: true })
  })
})
