import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ConfirmDialog, FONTS } from '../ui'
import { useApp } from './context'
import {
  RecoveryReviewContext,
  type RecoveryQcChoice,
  type RecoveryReviewValue,
} from './recovery-review-state'

interface PendingRecoveryReview {
  subjectIds: string[]
  remainingSubjectCount: number
  resolve: (choice: RecoveryQcChoice) => void
}

/**
 * Centralize fresh acknowledgment for every Resume and Retry entry point.
 *
 * Resume and Retry start from the run dock, Runs, Subjects, and Logs, and
 * only the sidecar's strict preview names the run's subjects without a Pass
 * verdict and whether any subject with one would remain, so the choice is
 * asked here, after that preview, rather than in each entry point's
 * confirmation.
 */
export function RecoveryReviewProvider({
  children,
}: {
  children: ReactNode
}): ReactNode {
  const app = useApp()
  const [pending, setPending] = useState<PendingRecoveryReview | null>(null)
  const pendingRef = useRef<PendingRecoveryReview | null>(null)

  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  useEffect(
    () => () => {
      pendingRef.current?.resolve('cancel')
      pendingRef.current = null
    },
    [app.projectEpoch],
  )

  const settle = useCallback((choice: RecoveryQcChoice) => {
    const current = pendingRef.current
    if (!current) return
    pendingRef.current = null
    setPending(null)
    current.resolve(choice)
  }, [])

  const choose = useCallback<RecoveryReviewValue['choose']>(
    (subjectIds, remainingSubjectCount) => {
      if (pendingRef.current) {
        return Promise.reject(
          new Error(
            'Finish the current recovery acknowledgment before opening another.',
          ),
        )
      }
      const exactIds = [...new Set(subjectIds)].sort()
      if (exactIds.length === 0) return Promise.resolve('exclude')
      return new Promise<RecoveryQcChoice>((resolve) => {
        const next = { subjectIds: exactIds, remainingSubjectCount, resolve }
        pendingRef.current = next
        setPending(next)
      })
    },
    [],
  )

  const value = useMemo<RecoveryReviewValue>(() => ({ choose }), [choose])

  return (
    <RecoveryReviewContext value={value}>
      {children}
      {pending && (
        <ConfirmDialog
          t={app.t}
          title="Choose how to handle subjects without a Pass verdict"
          message={
            <div style={{ display: 'grid', gap: 10 }}>
              <p style={{ margin: 0 }}>
                These subjects of the run have no Pass verdict; each is Defer or
                unreviewed:
              </p>
              <code
                style={{
                  fontFamily: FONTS.mono,
                  overflowWrap: 'anywhere',
                }}
              >
                {pending.subjectIds.join(', ')}
              </code>
              {pending.remainingSubjectCount > 0 ? (
                <p style={{ margin: 0 }}>
                  Include and re-plan keeps them in the plan. Exclude and
                  continue keeps only the {pending.remainingSubjectCount}{' '}
                  {pending.remainingSubjectCount === 1 ? 'subject' : 'subjects'}{' '}
                  with a Pass verdict.
                </p>
              ) : (
                <p style={{ margin: 0 }}>
                  Include and re-plan keeps them in the plan. Exclude and
                  continue is unavailable because no subject with a Pass verdict
                  would remain.
                </p>
              )}
            </div>
          }
          onDismiss={() => settle('cancel')}
          actions={[
            {
              label: 'Cancel recovery',
              initialFocus: true,
              onSelect: () => settle('cancel'),
            },
            {
              label: 'Exclude and continue',
              disabled: pending.remainingSubjectCount === 0,
              onSelect: () => settle('exclude'),
            },
            {
              label: 'Include and re-plan',
              tone: 'primary',
              onSelect: () => settle('include'),
            },
          ]}
        />
      )}
    </RecoveryReviewContext>
  )
}
