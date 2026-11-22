/**
 * Finds the offline rebuild of the acquired scientific assets in an
 * environment report.
 *
 * A build that re-pins a resource revises the reviewed inventory, which
 * invalidates the generation acquired for the previous build although every
 * acquired file is still on disk. The sidecar then marks the acquisition as an
 * offline install, which Diagnostics offers as one prominent action.
 */

import type { EnvCheck, EnvReport } from '../../../shared/types'
import { isFailing } from './helpers'

/** The check that owns the acquisition of the reviewed scientific assets. */
export const SCIENTIFIC_ASSETS_CHECK_ID = 'scientific_assets'

/** The aggregate step-asset check, which repeats the per-stage asset checks. */
const PIPELINE_ASSETS_CHECK_ID = 'pipeline_assets'

/** The offline rebuild the report offers and the asset checks it restores. */
export interface OfflineAssetRebuild {
  /** The failing scientific-asset check whose installer runs the rebuild. */
  check: EnvCheck
  /** The other failing asset checks in its group, in display order. */
  restores: EnvCheck[]
}

/**
 * Find the offline scientific-asset rebuild a report offers, if any.
 *
 * Offer it only for a failing, runnable acquisition that the sidecar marked
 * as an offline install, so a first acquisition that must download the pinned
 * archive keeps its ordinary row flow.
 *
 * @param report - The environment report, or null before the first check.
 * @returns The rebuild and the asset checks it restores, or null.
 */
export function offlineAssetRebuild(
  report: EnvReport | null,
): OfflineAssetRebuild | null {
  for (const group of report?.groups ?? []) {
    const check = group.checks.find(
      (entry) => entry.id === SCIENTIFIC_ASSETS_CHECK_ID,
    )
    if (!check) continue
    if (
      !isFailing(check) ||
      check.offlineInstall !== true ||
      check.installable === false ||
      !check.recommendedCmd
    ) {
      return null
    }
    const restores = group.checks.filter(
      (entry) =>
        entry.id !== check.id &&
        entry.id !== PIPELINE_ASSETS_CHECK_ID &&
        entry.id.endsWith('_assets') &&
        isFailing(entry),
    )
    return { check, restores }
  }
  return null
}
