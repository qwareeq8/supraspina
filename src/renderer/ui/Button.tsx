import { forwardRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { FONTS, type Theme } from '../theme/tokens'
import { ICONS, ICON_SIZE } from './icon-set'
import { Ico } from './icons'

/** The content, behavior, and tone for a shared button. */
export interface BtnProps {
  t: Theme
  label?: string
  icon?: ReactNode
  primary?: boolean
  /**
   * Draw a secondary action in the neutral outline while unpressed, so the
   * accent stays with the primary action, selection, focus, and progress. A
   * pressed secondary toggle takes the accent fill, which marks a selection.
   */
  secondary?: boolean
  ghost?: boolean
  danger?: boolean
  /**
   * Mark a positive choice, such as the Pass verdict, with the status green: a
   * soft green fill and green edge, and a solid green fill once pressed. The
   * label stays neutral on the soft fill, as on a status chip, to hold 4.5:1.
   */
  success?: boolean
  small?: boolean
  hint?: string
  onClick?: (() => void) | undefined
  disabled?: boolean
  ariaLabel?: string
  /**
   * The toggle state. `true` draws the pressed look: the tone's color as the
   * fill, a contrasting label, and an inset keyline, all at the unpressed size.
   * A caller that overrides `background` or `color` through `style` cancels
   * this look, so a toggle takes its tone from props.
   */
  ariaPressed?: boolean
  /**
   * The disclosure state, which makes the button a WAI-ARIA disclosure for the
   * region named by `ariaControls`. A leading chevron points right while the
   * region is hidden and down while it shows, and the button keeps its tone's
   * unpressed look in both states, so an open disclosure never reads as a
   * pressed toggle or a primary action. A disclosure has no pressed state, so
   * it ignores `ariaPressed`.
   */
  ariaExpanded?: boolean
  /** The id of the region a disclosure shows and hides. */
  ariaControls?: string
  /** The id of the text that describes the button, such as why it is off. */
  ariaDescribedBy?: string
  title?: string | undefined
  style?: CSSProperties
}

/** Render the shared button and forward its native element reference. */
export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  {
    t,
    label,
    icon,
    primary,
    secondary,
    ghost,
    danger,
    success,
    small,
    hint,
    onClick,
    disabled,
    ariaLabel,
    ariaPressed,
    ariaExpanded,
    ariaControls,
    ariaDescribedBy,
    title,
    style,
  }: BtnProps,
  ref,
): ReactNode {
  const [hover, setHover] = useState(false)
  // Invert a pressed toggle: the tone's color becomes the fill, and the label
  // takes the contrasting color. The fill differs from the unpressed look by at
  // least 4:1 in lightness in every theme, and the inset keyline adds a shape
  // cue, so the state reads without hue. Keep the border width and font
  // weight so the two states take the same size. Danger stays red, success
  // stays green, and neutral stays neutral, so a pressed Defer never reads as a
  // Pass.
  const disclosure = ariaExpanded !== undefined
  const pressed = !disclosure && ariaPressed === true
  const accentTone = primary || secondary
  const pressedFill = accentTone
    ? t.accent
    : danger
      ? t.failed
      : success
        ? t.done
        : t.text
  const pressedLabel = accentTone || success ? t.accentInk : t.surface
  // Hover moves a pressed fill toward the surface. The success green moves
  // toward the text instead, because a lighter green drops its white label
  // under 4.5:1 in the light theme.
  const pressedHoverMix = success ? t.text : t.surface
  const background = disabled
    ? t.surface2
    : pressed
      ? hover
        ? `color-mix(in srgb, ${pressedFill} 85%, ${pressedHoverMix})`
        : pressedFill
      : primary
        ? t.accent
        : danger
          ? t.failedSoft
          : success
            ? t.doneSoft
            : ghost
              ? hover
                ? t.surface2
                : 'transparent'
              : hover
                ? t.surface3
                : t.surface2
  const color = disabled
    ? t.dim
    : pressed
      ? pressedLabel
      : primary
        ? t.accentInk
        : danger
          ? t.failed
          : t.text
  const border = disabled
    ? `1px solid ${t.border}`
    : primary
      ? 'none'
      : pressed
        ? `1px solid ${pressedFill}`
        : danger
          ? `1px solid ${t.failed}`
          : success
            ? `1px solid ${t.done}`
            : ghost
              ? '1px solid transparent'
              : `1px solid ${t.dim}`
  // Draw the keyline in the label color so it follows a caller's color override.
  // A disabled pressed toggle keeps a doubled edge in place of the fill.
  const boxShadow = pressed
    ? `inset 0 0 0 1px ${disabled ? t.dim : 'currentColor'}`
    : undefined
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-component-boundary={
        !disabled && (!ghost || pressed) ? 'button' : undefined
      }
      aria-label={ariaLabel ?? label}
      aria-pressed={disclosure ? undefined : ariaPressed}
      aria-expanded={ariaExpanded}
      aria-controls={disclosure ? ariaControls : undefined}
      aria-describedby={ariaDescribedBy}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: small ? 24 : 28,
        padding: small ? '0 8px' : '0 11px',
        borderRadius: 5,
        background,
        color,
        border,
        boxShadow,
        fontFamily: FONTS.sans,
        fontSize: small ? 11 : 12,
        fontWeight: 400,
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        opacity: disabled ? 0.7 : 1,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {disclosure && (
        <Ico
          d={ICONS.chevron}
          size={ICON_SIZE.nav}
          style={{
            transform: ariaExpanded ? 'rotate(90deg)' : 'none',
            transition: 'transform .12s',
          }}
        />
      )}
      {icon}
      {label}
      {hint && (
        <span
          style={{
            fontFamily: FONTS.mono,
            // Keep shortcut chips legible across every contrast and density mode.
            fontSize: 11,
            fontWeight: 700,
            padding: '0 5px',
            background: primary
              ? `color-mix(in srgb, ${t.accentInk} 22%, transparent)`
              : t.surface3,
            color: primary ? t.accentInk : t.textSoft,
            borderRadius: 2,
            marginLeft: 2,
          }}
        >
          {hint}
        </span>
      )}
    </button>
  )
})
