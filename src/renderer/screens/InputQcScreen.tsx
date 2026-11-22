import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { ArtifactImagePreview } from '../../shared/contract'
import type {
  InputFovDecision,
  InputFovItem,
  InputFovReview,
} from '../../shared/scientific-contracts'
import type { ProjectRef } from '../../shared/types'
import { getApi } from '../state/api'
import { forgetCropInventory } from '../state/crop-inventory'
import { useApp } from '../state/context'
import {
  Btn,
  Card,
  EmptyState,
  ErrorState,
  FONTS,
  Hint,
  LoadingState,
  Page,
  RefreshButton,
  ReviewChip,
  type ReviewState,
} from '../ui'
import { useAvailableHeight } from '../ui/useAvailableHeight'

type InputQcState =
  | 'pass-through'
  | 'current'
  | 'stale'
  | 'unreviewed'
  | 'rejected'

type PreviewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; image: ArtifactImagePreview }
  | { phase: 'error'; message: string }

const STATE_DETAILS: Record<
  InputQcState,
  {
    label: string
    /** The ringed glyph and tone; both cleared states draw the check. */
    review: ReviewState
    explanation: string
  }
> = {
  'pass-through': {
    label: 'Pass-through',
    review: 'pass',
    explanation:
      'The source image fits within the 256 mm physical FOV limit, so it is used without cropping.',
  },
  current: {
    label: 'Current approval',
    review: 'pass',
    explanation: 'The approval matches the crop digest and both file hashes.',
  },
  stale: {
    label: 'Stale review',
    review: 'stale',
    explanation:
      'The prior decision does not match the current crop digest or file hashes, so this crop needs another review.',
  },
  unreviewed: {
    label: 'Unreviewed',
    review: 'unreviewed',
    explanation:
      'This generated crop needs a review before reconstruction starts.',
  },
  rejected: {
    label: 'Rejected',
    review: 'fail',
    explanation: 'This rejected crop is kept out of reconstruction.',
  },
}

function inputQcState(item: InputFovItem): InputQcState {
  if (item.passThrough) return 'pass-through'
  if (item.review === null) return 'unreviewed'
  if (!item.review.current) return 'stale'
  return item.review.decision === 'approved' ? 'current' : 'rejected'
}

function sameProject(left: ProjectRef | null, right: ProjectRef): boolean {
  return (
    left?.projectId === right.projectId &&
    left.root === right.root &&
    left.configPath === right.configPath &&
    left.epoch === right.epoch
  )
}

function itemKey(item: InputFovItem): string {
  return [
    item.subjectId,
    item.sessionId ?? '',
    item.acquisitionId ?? '',
    item.preflightSignature,
  ].join(':')
}

function itemEntityKey(item: InputFovItem): string {
  return [item.subjectId, item.sessionId ?? '', item.acquisitionId ?? ''].join(
    ':',
  )
}

function itemLabel(item: InputFovItem): string {
  return [item.subjectId, item.sessionId, item.acquisitionId]
    .filter(Boolean)
    .join(' / ')
}

/** The prepared-inputs list fit: at least 200 px, above the card's border. */
const LIST_FIT = { minHeight: 200, trailing: 1 } as const

/**
 * Review generated brain-FOV montages without exposing filesystem paths to the
 * renderer.
 */
export function InputQcScreen(): ReactNode {
  const { projectEpoch, projectRef, configRevision } = useApp()
  const identity = `${projectEpoch}:${projectRef?.projectId ?? 'none'}:${configRevision}`
  return <InputQcProject key={identity} />
}

function InputQcProject(): ReactNode {
  const { t, projectRef, configRevision, cfg, dirty } = useApp()
  const [items, setItems] = useState<InputFovItem[]>([])
  // Fit the prepared-inputs list to the rest of the page's scroll area, so it
  // scrolls by itself to its last item; the card's bottom border trails it.
  const listRef = useAvailableHeight<HTMLDivElement>(LIST_FIT)
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewState>({ phase: 'idle' })
  const [reviewing, setReviewing] = useState<InputFovDecision | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const listRequestRef = useRef(0)
  const previewRequestRef = useRef(0)
  const latestProjectRef = useRef<ProjectRef | null>(projectRef)

  useLayoutEffect(() => {
    latestProjectRef.current = projectRef
    return () => {
      latestProjectRef.current = null
    }
  }, [projectRef])

  const load = useCallback(async (): Promise<void> => {
    const captured = projectRef
    const capturedRevision = configRevision
    const requestToken = ++listRequestRef.current
    setLoading(true)
    setListError(null)
    try {
      if (!captured) {
        throw new Error('Open a project before reviewing prepared inputs.')
      }
      // The inventory is bound to the saved project revision, so main refuses
      // the call outright while edits are pending. Say so plainly instead of
      // forwarding that refusal, and list again once the project is saved.
      if (dirty) {
        if (requestToken !== listRequestRef.current) return
        setItems([])
        setListError('Save the project before reviewing prepared inputs.')
        setLoading(false)
        return
      }
      const result = await getApi().inputFov.list({
        project: captured,
        cfg,
        configRevision: capturedRevision,
      })
      if (
        requestToken !== listRequestRef.current ||
        !sameProject(latestProjectRef.current, captured)
      ) {
        return
      }
      if (result.configRevision !== capturedRevision) {
        throw new Error(
          'Refresh the prepared-input inventory for the current project revision.',
        )
      }
      setItems(result.items)
      setSelectedItemKey((current) =>
        current && result.items.some((item) => itemKey(item) === current)
          ? current
          : result.items[0]
            ? itemKey(result.items[0])
            : null,
      )
    } catch (cause: unknown) {
      if (
        requestToken === listRequestRef.current &&
        (!captured || sameProject(latestProjectRef.current, captured))
      ) {
        setListError(
          cause instanceof Error
            ? cause.message
            : 'Prepared inputs could not be loaded.',
        )
      }
    } finally {
      if (
        requestToken === listRequestRef.current &&
        (!captured || sameProject(latestProjectRef.current, captured))
      ) {
        setLoading(false)
      }
    }
  }, [cfg, configRevision, dirty, projectRef])

  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])

  const selected = useMemo(
    () => items.find((item) => itemKey(item) === selectedItemKey) ?? items[0],
    [items, selectedItemKey],
  )
  const selectedPreviewKey = selected ? itemKey(selected) : null
  const selectedQcArtifactId = selected?.qcArtifactId ?? null

  useEffect(() => {
    const captured = projectRef
    const requestToken = ++previewRequestRef.current
    let active = true
    void Promise.resolve().then(async () => {
      if (!selectedQcArtifactId || !captured) {
        if (active) setPreview({ phase: 'idle' })
        return
      }
      setPreview({ phase: 'loading' })
      try {
        const image = await getApi().artifact.previewImage({
          project: captured,
          artifactId: selectedQcArtifactId,
          maxBytes: 8 * 1024 * 1024,
        })
        if (
          active &&
          requestToken === previewRequestRef.current &&
          sameProject(latestProjectRef.current, captured)
        ) {
          setPreview({ phase: 'ready', image })
        }
      } catch (cause: unknown) {
        if (
          active &&
          requestToken === previewRequestRef.current &&
          sameProject(latestProjectRef.current, captured)
        ) {
          setPreview({
            phase: 'error',
            message:
              cause instanceof Error
                ? cause.message
                : 'This montage could not be previewed.',
          })
        }
      }
    })
    return () => {
      active = false
    }
  }, [projectRef, selectedPreviewKey, selectedQcArtifactId])

  const decide = useCallback(
    async (item: InputFovItem, decision: InputFovDecision): Promise<void> => {
      const captured = projectRef
      const capturedRevision = configRevision
      if (!captured || item.passThrough || reviewing !== null) return
      setReviewing(decision)
      setReviewError(null)
      setNotice(null)
      try {
        const review: InputFovReview = await getApi().inputFov.review({
          project: captured,
          cfg,
          configRevision: capturedRevision,
          subjectId: item.subjectId,
          sessionId: item.sessionId,
          acquisitionId: item.acquisitionId,
          preflightSignature: item.preflightSignature,
          sourceSha256: item.sourceSha256,
          outputSha256: item.outputSha256,
          expectedRevision: item.review?.revision ?? 0,
          decision,
        })
        // Runs would otherwise keep the read from before this decision.
        forgetCropInventory()
        if (!sameProject(latestProjectRef.current, captured)) return
        setItems((current) =>
          current.map((candidate) => {
            if (itemKey(candidate) !== itemKey(item)) return candidate
            return { ...candidate, review }
          }),
        )
        setNotice(
          decision === 'approved'
            ? `The crop for ${itemLabel(item)} is approved.`
            : `The crop for ${itemLabel(item)} is rejected and stays out of reconstruction.`,
        )
      } catch (cause: unknown) {
        if (sameProject(latestProjectRef.current, captured)) {
          setReviewError(
            cause instanceof Error
              ? cause.message
              : 'The review decision could not be recorded.',
          )
        }
      } finally {
        if (sameProject(latestProjectRef.current, captured)) {
          setReviewing(null)
        }
      }
    },
    [cfg, configRevision, projectRef, reviewing],
  )

  const actualCrops = items.filter((item) => item.requiresReview)
  const approved = actualCrops.filter(
    (item) =>
      item.review?.current === true && item.review.decision === 'approved',
  ).length
  // Discriminate duplicate acquisitions by their current list order, never a
  // digest; the ordinal always matches the visible row order.
  const duplicateInfo = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      const key = itemEntityKey(item)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const ordinals = new Map<string, number>()
    const info = new Map<string, { ordinal: number; count: number }>()
    for (const item of items) {
      const key = itemEntityKey(item)
      const count = counts.get(key) ?? 0
      if (count < 2) continue
      const ordinal = (ordinals.get(key) ?? 0) + 1
      ordinals.set(key, ordinal)
      info.set(itemKey(item), { ordinal, count })
    }
    return info
  }, [items])

  const selectedState = selected ? inputQcState(selected) : null
  const selectedDetail = STATE_DETAILS[selectedState ?? 'unreviewed']

  return (
    <Page
      t={t}
      title="Input QC"
      right={
        <>
          {actualCrops.length > 0 && (
            <ReviewChip
              t={t}
              state={approved === actualCrops.length ? 'pass' : 'incomplete'}
              label={`${approved}/${actualCrops.length} crops approved`}
            />
          )}
          <RefreshButton
            t={t}
            ariaLabel="Refresh prepared inputs"
            title="Refresh prepared inputs"
            busy={loading}
            busyLabel="Refreshing prepared inputs..."
            onClick={() => void load()}
          />
        </>
      }
    >
      {listError && (
        <div style={{ marginBottom: 12 }}>
          <ErrorState t={t} title={listError} onRetry={() => void load()} />
        </div>
      )}
      {loading && items.length === 0 ? (
        <LoadingState t={t} label="Loading prepared inputs..." block />
      ) : items.length === 0 ? (
        <EmptyState
          t={t}
          icon="inputQc"
          message="No field of view reports are available."
          hint="Run Brain FOV preparation to create them."
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(220px, 320px) minmax(0, 1fr)',
            gap: 12,
            minHeight: 0,
          }}
        >
          <aside aria-label="Prepared inputs">
            <Card t={t} title="Crops" padded={false}>
              <div
                ref={listRef}
                role="list"
                data-testid="prepared-inputs-list"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'auto',
                }}
              >
                {items.map((item) => {
                  const state = inputQcState(item)
                  const detail = STATE_DETAILS[state]
                  const active =
                    selected !== undefined &&
                    itemKey(item) === itemKey(selected)
                  const duplicate = duplicateInfo.get(itemKey(item)) ?? null
                  const duplicateLabel = duplicate
                    ? `duplicate ${duplicate.ordinal} of ${duplicate.count}`
                    : null
                  const accessibleIdentity = [
                    item.subjectId,
                    item.sessionId,
                    item.acquisitionId,
                  ]
                    .filter(Boolean)
                    .join(', ')
                  return (
                    <div
                      key={itemKey(item)}
                      role="listitem"
                      style={{
                        borderBottom: `1px solid ${t.borderSoft}`,
                      }}
                    >
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        aria-label={`Review ${accessibleIdentity}, ${detail.label.toLowerCase()}${duplicateLabel ? `, ${duplicateLabel}` : ''}`}
                        {...(duplicateLabel
                          ? { title: item.qcDisplayPath }
                          : {})}
                        onClick={() => {
                          setSelectedItemKey(itemKey(item))
                          setReviewError(null)
                          setNotice(null)
                        }}
                        style={{
                          width: '100%',
                          minHeight: 56,
                          padding: '9px 10px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          border: 'none',
                          background: active ? t.accentSoft : 'transparent',
                          color: t.text,
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span
                          style={{
                            minWidth: 0,
                            flex: 1,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 3,
                          }}
                        >
                          <strong
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              fontFamily: FONTS.mono,
                              fontSize: 12,
                            }}
                          >
                            {item.subjectId}
                          </strong>
                          {(item.sessionId ||
                            item.acquisitionId ||
                            duplicateLabel) && (
                            <span
                              style={{
                                color: active ? t.accentDim : t.dim,
                                fontFamily: FONTS.mono,
                                fontSize: 10.5,
                              }}
                            >
                              {[
                                item.sessionId,
                                item.acquisitionId,
                                duplicateLabel,
                              ]
                                .filter(Boolean)
                                .join(' / ')}
                            </span>
                          )}
                        </span>
                        <span
                          style={{
                            width: 112,
                            minWidth: 112,
                            display: 'flex',
                            justifyContent: 'flex-end',
                          }}
                        >
                          <ReviewChip
                            t={t}
                            state={detail.review}
                            label={detail.label}
                            small
                          />
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </Card>
          </aside>

          {selected && (
            <Card t={t} title={itemLabel(selected)} wrapHeader>
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
              >
                {preview.phase === 'loading' ? (
                  <LoadingState t={t} label="Loading the bounded montage..." />
                ) : preview.phase === 'ready' ? (
                  <figure style={{ margin: 0 }}>
                    <img
                      src={preview.image.dataUrl}
                      alt={`Brain FOV QC montage for ${itemLabel(selected)}`}
                      // The file name carries an internal hash, so the path
                      // stays out of view and only the tooltip names it.
                      title={selected.qcDisplayPath}
                      // Size the montage by the height left in the window and
                      // center it, so no slab of background flanks it.
                      style={{
                        display: 'block',
                        width: 'auto',
                        maxWidth: '100%',
                        maxHeight: 'calc(100vh - 330px)',
                        margin: '0 auto',
                        objectFit: 'contain',
                      }}
                    />
                    {preview.image.truncated && (
                      <figcaption
                        style={{
                          marginTop: 6,
                          color: t.dim,
                          fontFamily: FONTS.sans,
                          fontSize: 11,
                        }}
                      >
                        The host downsampled this bounded preview; its tooltip
                        names the full montage path.
                      </figcaption>
                    )}
                  </figure>
                ) : preview.phase === 'error' ? (
                  <div
                    role="alert"
                    aria-label="The montage preview could not load"
                    style={{
                      padding: 12,
                      borderRadius: 6,
                      background: t.failedSoft,
                      color: t.text,
                      fontFamily: FONTS.sans,
                      fontSize: 12,
                    }}
                  >
                    <strong>The montage preview could not load.</strong>{' '}
                    {preview.message}
                  </div>
                ) : null}

                {/* One row under the image: the status, the latest notice,
                    and the decision. */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 28,
                  }}
                >
                  <span
                    data-testid="input-qc-selected-status-slot"
                    style={{ display: 'flex', flexShrink: 0 }}
                  >
                    <ReviewChip
                      t={t}
                      state={selectedDetail.review}
                      label={selectedDetail.label}
                      title={selectedDetail.explanation}
                    />
                  </span>
                  {/* The notice takes the spacer's place, one line no taller
                      than the buttons, so the montage above never moves. */}
                  {notice && !selected.passThrough ? (
                    <div
                      role="status"
                      aria-label="Input QC update"
                      aria-live="polite"
                      title={notice}
                      style={{
                        flex: '1 1 0',
                        minWidth: 0,
                        height: 28,
                        padding: '5px 10px',
                        borderRadius: 6,
                        background: t.doneSoft,
                        color: t.text,
                        fontFamily: FONTS.sans,
                        fontSize: 12,
                        lineHeight: '18px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {notice}
                    </div>
                  ) : (
                    <span style={{ flex: '1 1 0', minWidth: 0 }} />
                  )}
                  {!selected.passThrough && (
                    <div
                      role="group"
                      aria-label={`Crop decision for ${itemLabel(selected)}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexShrink: 0,
                      }}
                    >
                      <Btn
                        t={t}
                        ghost
                        label={
                          reviewing === 'rejected'
                            ? 'Saving the rejection...'
                            : 'Reject'
                        }
                        ariaLabel={`Reject crop for ${itemLabel(selected)}`}
                        disabled={reviewing !== null}
                        style={{ width: 88, justifyContent: 'center' }}
                        onClick={() => void decide(selected, 'rejected')}
                      />
                      <Btn
                        t={t}
                        primary
                        label={
                          reviewing === 'approved'
                            ? 'Saving the approval...'
                            : 'Approve'
                        }
                        ariaLabel={`Approve crop for ${itemLabel(selected)}`}
                        disabled={reviewing !== null}
                        style={{ width: 88, justifyContent: 'center' }}
                        onClick={() => void decide(selected, 'approved')}
                      />
                    </div>
                  )}
                </div>

                {/* A routine state explains itself in the chip's tooltip; a
                    state that needs the reviewer says so in view. */}
                {(selectedState === 'rejected' ||
                  selectedState === 'stale' ||
                  selectedState === 'pass-through') && (
                  <Hint t={t}>{selectedDetail.explanation}</Hint>
                )}
                {selected.passThrough && (
                  <Hint t={t}>
                    This input needs no approval: every physical axis is at most
                    256.0 mm, so the original raw T1 is the prepared input.
                  </Hint>
                )}
                {reviewError && (
                  <div role="alert" style={{ color: t.failed, fontSize: 12 }}>
                    {reviewError}
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      )}
    </Page>
  )
}
