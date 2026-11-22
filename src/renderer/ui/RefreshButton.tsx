/**
 * One accessible icon-only refresh control reused in every screen header.
 * Labeled refresh actions stay ordinary buttons.
 */

import type { CSSProperties, ReactNode } from 'react'
import type { Theme } from '../theme/tokens'
import { IconButton } from './IconButton'
import { ICONS } from './icon-set'

/** The behavior and accessible text for a refresh action. */
export interface RefreshButtonProps {
  t: Theme
  onClick?: (() => void) | undefined
  ariaLabel?: string
  title?: string
  disabled?: boolean
  busy?: boolean
  busyLabel?: string
  iconSize?: number
  style?: CSSProperties
}

/** Render the shared icon-only refresh action. */
export function RefreshButton({
  t,
  onClick,
  ariaLabel = 'Refresh',
  title,
  disabled,
  busy,
  busyLabel = 'Refreshing...',
  iconSize,
  style,
}: RefreshButtonProps): ReactNode {
  return (
    <IconButton
      t={t}
      d={ICONS.refresh}
      ariaLabel={ariaLabel}
      title={busy ? busyLabel : (title ?? ariaLabel)}
      onClick={onClick}
      disabled={Boolean(disabled || busy)}
      busy={busy ?? false}
      {...(iconSize !== undefined ? { iconSize } : {})}
      {...(style ? { style } : {})}
    />
  )
}
