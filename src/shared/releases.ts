/** Names the public GitHub repository whose Releases carry Supraspina updates. */

import { parseAppVersion } from '../../scripts/app-version.mjs'

/** The GitHub owner and repository that publish releases. */
export const RELEASE_REPOSITORY = 'qwareeq8/supraspina'

/** The public Releases page. */
export const RELEASES_URL = `https://github.com/${RELEASE_REPOSITORY}/releases`

/**
 * Return the release page of one version, or the Releases page when the value
 * is not a machine-form version.
 *
 * @param version - The machine-form version, such as `20261121.1830.0`.
 * @example
 * releasePageUrl('20261121.1830.0')
 * // 'https://github.com/qwareeq8/supraspina/releases/tag/v20261121.1830.0'
 */
export function releasePageUrl(version: string | null): string {
  return version !== null && parseAppVersion(version) !== null
    ? `${RELEASES_URL}/tag/v${version}`
    : RELEASES_URL
}
