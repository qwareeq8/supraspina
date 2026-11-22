import { createContext, useContext } from 'react'

/** How recovery handles newly eligible QC subjects. */
export type RecoveryQcChoice = 'include' | 'exclude' | 'cancel'

/** The recovery acknowledgment operation. */
export interface RecoveryReviewValue {
  /**
   * Ask how recovery treats the source run's Defer and unreviewed subjects.
   *
   * @param subjectIds - The subjects that need a fresh QC decision.
   * @param remainingSubjectCount - How many source-run subjects the recovery
   *   keeps if those subjects are excluded; with none, Exclude is not offered.
   */
  choose(
    subjectIds: readonly string[],
    remainingSubjectCount: number,
  ): Promise<RecoveryQcChoice>
}

/** Recovery acknowledgment shared with renderer consumers. */
export const RecoveryReviewContext = createContext<RecoveryReviewValue | null>(
  null,
)

/** Use the recovery acknowledgment operation. */
export function useRecoveryReview(): RecoveryReviewValue {
  const value = useContext(RecoveryReviewContext)
  if (value) return value
  return {
    choose: async () => {
      throw new Error(
        'Restore the recovery acknowledgment surface before recovery.',
      )
    },
  }
}
