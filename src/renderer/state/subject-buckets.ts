/**
 * Names, orders, counts, and words the subject display buckets, so the top
 * bar, the Dashboard tiles, and Subjects give one set of subjects one name
 * and one count.
 */

import type { Subject } from '../../shared/types'
import {
  subjectDisplayBucket,
  type SubjectDisplayBucket,
} from './subject-runtime-status'

/** The buckets in the order every screen lists them. */
export const SUBJECT_BUCKETS: readonly SubjectDisplayBucket[] = [
  'done',
  'outdated',
  'partial',
  'running',
  'failed',
  'interrupted',
  'cancelled',
  'pending',
  'excluded',
]

/** The name of each bucket on tiles, filters, and in sentences. */
export const SUBJECT_BUCKET_LABEL: Record<SubjectDisplayBucket, string> = {
  done: 'Done',
  outdated: 'Out of date',
  partial: 'Partly done',
  running: 'Running',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Canceled',
  pending: 'Pending',
  excluded: 'Excluded',
}

/** The number of subjects in each bucket. */
export type SubjectBucketCounts = Record<SubjectDisplayBucket, number>

/**
 * The buckets a stage-currency read can move subjects between: it only
 * turns done cells out of date, so it moves a subject from Done to Out of
 * date or back and leaves every other bucket as it is.
 */
export const CURRENCY_BUCKETS: ReadonlySet<SubjectDisplayBucket> = new Set([
  'done',
  'outdated',
])

/**
 * The buckets that show only when a subject is in them: most cohorts never
 * have an interrupted, canceled, or QC Fail subject, and three zero counts on
 * every tile row, filter bar, and announcement would crowd out the rest.
 */
const OPTIONAL_BUCKETS: ReadonlySet<SubjectDisplayBucket> = new Set([
  'interrupted',
  'cancelled',
  'excluded',
])

/**
 * List the buckets a tile row, filter bar, or summary shows, in the shared
 * order: every bucket, with Interrupted, Canceled, and Excluded only while a
 * subject is in them.
 *
 * @param counts - The bucket counts, or null while the cohort loads.
 * @param keep - The bucket even when it is empty, such as the selected filter,
 *   so a selection never disappears under the pointer.
 */
export function shownSubjectBuckets(
  counts: SubjectBucketCounts | null,
  keep?: SubjectDisplayBucket,
): SubjectDisplayBucket[] {
  return SUBJECT_BUCKETS.filter(
    (bucket) =>
      !OPTIONAL_BUCKETS.has(bucket) ||
      bucket === keep ||
      (counts !== null && counts[bucket] > 0),
  )
}

/** Say why Done and Out of date show no count yet. */
export const CURRENCY_CHECKING_FACT =
  'Supraspina is checking which finished stages are out of date.'

/**
 * Count subjects per display bucket with the shared classifier.
 *
 * @param subjects - The runtime- and currency-projected subjects.
 * @returns One count per bucket; the counts sum to the subject count.
 */
export function tallySubjectBuckets(
  subjects: readonly Subject[],
): SubjectBucketCounts {
  const counts: SubjectBucketCounts = {
    done: 0,
    outdated: 0,
    partial: 0,
    running: 0,
    failed: 0,
    interrupted: 0,
    cancelled: 0,
    pending: 0,
    excluded: 0,
  }
  for (const subject of subjects) counts[subjectDisplayBucket(subject)] += 1
  return counts
}

/** Join phrases as "A", "A and B", or "A, B, and C". */
function listPhrase(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/**
 * List every bucket's count in the shared order, in lowercase.
 *
 * Before the stage-currency read lands, Done and Out of date are one count,
 * because the read may still move subjects between them. Interrupted,
 * Canceled, and Excluded appear only when a subject is in them (see
 * {@link shownSubjectBuckets}).
 *
 * @param checked - Whether the stage-currency read has landed.
 * @returns A phrase such as `0 done, 82 out of date, 0 in progress, 0 running,
 *   0 failed, and 0 pending`, or, before the read lands, `82 done or out of
 *   date, 0 in progress, 0 running, 0 failed, 1 canceled, and 0 pending`.
 */
export function describeSubjectBuckets(
  counts: SubjectBucketCounts,
  checked = true,
): string {
  const settled = shownSubjectBuckets(counts)
    .filter((bucket) => checked || !CURRENCY_BUCKETS.has(bucket))
    .map(
      (bucket) =>
        `${counts[bucket]} ${SUBJECT_BUCKET_LABEL[bucket].toLowerCase()}`,
    )
  return listPhrase(
    checked
      ? settled
      : [`${counts.done + counts.outdated} done or out of date`, ...settled],
  )
}
