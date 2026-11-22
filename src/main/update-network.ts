/**
 * Confines the updater's network session to the GitHub hosts that serve
 * public release metadata and assets.
 *
 * electron-updater's GitHub provider reads the Releases feed, the latest
 * release, and `latest-linux.yml` from github.com, which redirects each asset
 * download to the release-asset CDN. Every other request on the updater
 * session is cancelled before it leaves the machine.
 */

import type { Session } from 'electron'
import { RELEASE_REPOSITORY } from '../shared/releases'

/** The Electron session partition that electron-updater requests use. */
export const UPDATER_PARTITION = 'electron-updater'

/**
 * The CDN hosts that github.com redirects release-asset downloads to. GitHub
 * moved assets from the second host to the first; both stay allowed so a
 * host change does not strand installed copies. Integrity rests on the
 * SHA-512 in `latest-linux.yml`, which comes from github.com.
 */
const ASSET_HOSTS = Object.freeze([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])

/** The exact hosts the updater may contact. */
export const UPDATE_HOSTS = Object.freeze(['github.com', ...ASSET_HOSTS])

const escapedRepository = RELEASE_REPOSITORY.replace(/[.]/g, '\\.')
const RELEASE_PATH = new RegExp(
  `^/${escapedRepository}/releases(?:\\.atom|/latest|/tag/[^/]+|/download/[^/]+/[^/]+)$`,
)

/**
 * Say whether one updater request is allowed.
 *
 * @returns True for HTTPS release reads on github.com and for any HTTPS asset
 *   download from the release-asset CDN.
 */
export function isAllowedUpdateRequest(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) {
    return false
  }
  if (url.hostname === 'github.com') {
    return url.search === '' && RELEASE_PATH.test(url.pathname)
  }
  // The CDN serves short-lived signed URLs whose paths and queries vary.
  return ASSET_HOSTS.includes(url.hostname)
}

/** Cancel every updater request outside the release allowlist. */
export function guardUpdateNetwork(session: Pick<Session, 'webRequest'>): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedUpdateRequest(details.url) })
  })
}
