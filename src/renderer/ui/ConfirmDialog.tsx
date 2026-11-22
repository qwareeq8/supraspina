import { useId, useRef, type ReactNode } from 'react'
import type { Theme } from '../theme/tokens'
import { Btn } from './Button'
import { FONTS } from '../theme/tokens'
import { Modal } from './Modal'

/** One explicit confirmation-dialog action. */
export interface ConfirmDialogAction {
  label: string
  onSelect: () => void
  tone?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  initialFocus?: boolean
  /** Tooltip text, such as why the action is disabled. */
  title?: string
  /**
   * Describe the action by the footnote, such as an action the footnote says
   * is unavailable and why.
   */
  describedByFootnote?: boolean
}

/** The content, actions, and state for a confirmation dialog. */
export interface ConfirmDialogProps {
  t: Theme
  title: string
  message: ReactNode
  actions: ConfirmDialogAction[]
  onDismiss: () => void
  error?: string | null
  /**
   * Text that stays beside the actions while the message scrolls, such as
   * why an action is disabled. The dialog's description includes it unless
   * `descriptionId` names the description.
   */
  footnote?: ReactNode
  /**
   * The id of the element in `message` that describes the dialog, for a
   * message too long to read out when the dialog opens, such as a whole plan.
   * By default the whole message and the footnote describe it.
   */
  descriptionId?: string
  busy?: boolean
}

/** Render a confirmation dialog named by its visible heading. */
export function ConfirmDialog({
  t,
  title,
  message,
  actions,
  onDismiss,
  error,
  footnote,
  descriptionId: messageDescriptionId,
  busy = false,
}: ConfirmDialogProps): ReactNode {
  const safeRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const footnoteId = useId()
  const initial = actions.findIndex((action) => action.initialFocus)
  return (
    <Modal
      t={t}
      onDismiss={() => {
        if (!busy) onDismiss()
      }}
      labelledBy={titleId}
      describedBy={
        messageDescriptionId ??
        (footnote === undefined
          ? descriptionId
          : `${descriptionId} ${footnoteId}`)
      }
      {...(initial >= 0 ? { initialFocusRef: safeRef } : {})}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault()
          onDismiss()
        }
      }}
      cardStyle={{ width: 460, maxWidth: '90vw', gap: 14, padding: 18 }}
    >
      <h2
        id={titleId}
        // A dialog title is the display heading of its surface, so it takes
        // the serif face of page titles.
        style={{
          margin: 0,
          fontFamily: FONTS.serif,
          fontSize: 18,
          fontWeight: 400,
          color: t.textStrong,
          flexShrink: 0,
        }}
      >
        {title}
      </h2>
      {/* The card is bounded to the window, so a long message scrolls here
          while the title and the actions stay in view. Under the Larger text
          zoom a message that fits can overflow by a fraction of a pixel and
          show a scroll track; the pixel of bottom padding absorbs it. */}
      <div
        id={descriptionId}
        data-dialog-body=""
        style={{
          fontFamily: FONTS.sans,
          fontSize: 13,
          lineHeight: 1.5,
          color: t.textSoft,
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          paddingBottom: 1,
        }}
      >
        {message}
      </div>
      {footnote !== undefined && (
        <div
          id={footnoteId}
          style={{
            fontFamily: FONTS.sans,
            fontSize: 12,
            lineHeight: 1.5,
            color: t.textSoft,
            flexShrink: 0,
          }}
        >
          {footnote}
        </div>
      )}
      {error && (
        <div
          role="alert"
          style={{ color: t.failed, fontSize: 12, flexShrink: 0 }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          flexShrink: 0,
        }}
      >
        {actions.map((action, index) => (
          <Btn
            key={action.label}
            {...(index === initial ? { ref: safeRef } : {})}
            t={t}
            label={action.label}
            primary={action.tone === 'primary'}
            danger={action.tone === 'danger'}
            disabled={busy || action.disabled === true}
            {...(action.title === undefined ? {} : { title: action.title })}
            {...(action.describedByFootnote === true && footnote !== undefined
              ? { ariaDescribedBy: footnoteId }
              : {})}
            onClick={action.onSelect}
          />
        ))}
      </div>
    </Modal>
  )
}
