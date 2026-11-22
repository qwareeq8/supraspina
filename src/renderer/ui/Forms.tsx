/**
 * Field, TextInput, PathInput, and Toggle: the shared form atoms.
 *
 * Toggle renders as a `role="switch"` button for keyboard and screen-reader
 * access. Pair each PathInput text field with a caller-provided native dialog.
 */

import { useId } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { FONTS, type Theme } from '../theme/tokens'
import { Btn } from './Button'
import {
  FieldSemanticsContext,
  useFieldControlSemantics,
} from './field-semantics'
import { InfoTip } from './Help'

/** Configuration for {@link Field}. */
export interface FieldProps {
  t: Theme
  label: string
  /** Provide a stable control ID, or let React generate one. */
  controlId?: string | undefined
  /** A sentence below the control, always set in sans like the label. */
  hint?: string
  error?: string
  /** Provide a plain-language "what is this" shown as an info glyph beside the label. */
  info?: string | undefined
  children: ReactNode
}

function safeReactId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '')
}

/**
 * Render a labeled form row with hint or error text and optional information.
 */
export function Field({
  t,
  label,
  controlId,
  hint,
  error,
  info,
  children,
}: FieldProps): ReactNode {
  const generatedId = useId()
  const prefix = controlId ?? `field-${safeReactId(generatedId)}`
  const labelId = `${prefix}-label`
  const hintId = hint && !error ? `${prefix}-hint` : undefined
  const errorId = error ? `${prefix}-error` : undefined
  const semantics = { controlId: prefix, labelId, hintId, errorId }

  const labelRow = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        color: t.dim,
        fontFamily: FONTS.sans,
        fontWeight: 400,
        letterSpacing: 0.2,
      }}
    >
      <label id={labelId} htmlFor={prefix}>
        {label}
      </label>
      {info && <InfoTip t={t} text={info} label={`About ${label}`} />}
    </span>
  )
  const control = (
    <FieldSemanticsContext.Provider value={semantics}>
      {children}
    </FieldSemanticsContext.Provider>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {labelRow}
      {control}
      {hint && !error && (
        <span
          id={hintId}
          style={{
            fontSize: 10.5,
            color: t.dimText,
            fontFamily: FONTS.sans,
          }}
        >
          {hint}
        </span>
      )}
      {error && (
        <span
          id={errorId}
          role="alert"
          style={{ fontSize: 10.5, color: t.failed, fontFamily: FONTS.sans }}
        >
          {error}
        </span>
      )}
    </div>
  )
}

/** Configuration for {@link TextInput}. */
export interface TextInputProps {
  t: Theme
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  mono?: boolean
  invalid?: boolean
  /** Report that focus left the input. */
  onBlur?: (() => void) | undefined
  /** Show a stored value that this form displays but cannot change. */
  readOnly?: boolean
  ariaLabel?: string
  id?: string | undefined
  ariaDescribedBy?: string | undefined
  ariaErrorMessage?: string | undefined
  /** The id of a `<datalist>` whose options the input suggests. */
  list?: string | undefined
  style?: CSSProperties
}

/** Render a single-line text input. */
export function TextInput({
  t,
  value,
  onChange,
  placeholder,
  mono,
  invalid,
  onBlur,
  readOnly,
  ariaLabel,
  id,
  ariaDescribedBy,
  ariaErrorMessage,
  list,
  style,
}: TextInputProps): ReactNode {
  const semantics = useFieldControlSemantics({
    id,
    ariaDescribedBy,
    ariaErrorMessage,
    invalid,
  })
  return (
    <input
      id={semantics.id}
      value={value}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      onBlur={onBlur}
      placeholder={placeholder}
      readOnly={readOnly}
      list={list}
      aria-label={ariaLabel}
      aria-describedby={semantics.describedBy}
      aria-errormessage={semantics.errorMessage}
      aria-invalid={semantics.invalid}
      style={{
        height: 'var(--ss-input-h)',
        padding: '0 9px',
        background: readOnly ? t.surface2 : t.bg,
        color: t.text,
        border: `1px solid ${semantics.invalid ? t.failed : t.dim}`,
        borderRadius: 4,
        fontFamily: mono ? FONTS.mono : FONTS.sans,
        fontSize: 12,
        width: '100%',
        ...style,
      }}
    />
  )
}

/** Configuration for {@link PathInput}. */
export interface PathInputProps {
  t: Theme
  value: string
  onChange?: (value: string) => void
  onBrowse?: (() => void) | undefined
  placeholder?: string
  action?: string
  invalid?: boolean
  /** Report that focus left the field, its Browse action included. */
  onBlur?: (() => void) | undefined
  ariaLabel?: string
  id?: string | undefined
  ariaDescribedBy?: string | undefined
  ariaErrorMessage?: string | undefined
}

/** Render a monospace path field with a Browse action. */
export function PathInput({
  t,
  value,
  onChange,
  onBrowse,
  placeholder,
  action = 'Browse...',
  invalid,
  onBlur,
  ariaLabel,
  id,
  ariaDescribedBy,
  ariaErrorMessage,
}: PathInputProps): ReactNode {
  const semantics = useFieldControlSemantics({
    id,
    ariaDescribedBy,
    ariaErrorMessage,
    invalid,
  })
  return (
    <div
      style={{ display: 'flex', gap: 6 }}
      // Moving from the input to Browse stays inside the field.
      onBlur={
        onBlur
          ? (e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) onBlur()
            }
          : undefined
      }
    >
      <input
        id={semantics.id}
        value={value}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-describedby={semantics.describedBy}
        aria-errormessage={semantics.errorMessage}
        aria-invalid={semantics.invalid}
        style={{
          height: 'var(--ss-input-h)',
          padding: '0 9px',
          background: t.bg,
          color: t.text,
          border: `1px solid ${semantics.invalid ? t.failed : t.dim}`,
          borderRadius: 4,
          fontFamily: FONTS.mono,
          fontSize: 11.5,
          flex: 1,
        }}
      />
      <Btn
        t={t}
        label={action}
        onClick={onBrowse}
        style={{ height: 'var(--ss-input-h)' }}
        disabled={!onBrowse}
        {...(onBrowse
          ? {}
          : {
              title:
                'The file dialog needs the desktop app. Type the path instead.',
            })}
      />
    </div>
  )
}

/** Configuration for {@link Toggle}. */
export interface ToggleProps {
  t: Theme
  checked: boolean
  onChange?: (checked: boolean) => void
  label?: string
  /**
   * Provide an accessible switch name when the visible `label` only describes
   * state and another label identifies the controlled setting.
   */
  ariaLabel?: string
  ariaDescribedBy?: string | undefined
  disabled?: boolean
}

/** Render an accessible on/off switch. */
export function Toggle({
  t,
  checked,
  onChange,
  label,
  ariaLabel,
  ariaDescribedBy,
  disabled,
}: ToggleProps): ReactNode {
  const semantics = useFieldControlSemantics({
    ariaDescribedBy,
    invalid: false,
  })
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        userSelect: 'none',
      }}
    >
      <button
        id={semantics.id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={semantics.labelledBy ? undefined : (ariaLabel ?? label)}
        aria-labelledby={semantics.labelledBy}
        aria-describedby={semantics.describedBy}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        style={{
          width: 32,
          height: 24,
          padding: 0,
          borderRadius: 12,
          background: 'transparent',
          border: 'none',
          position: 'relative',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1,
        }}
      >
        <span
          aria-hidden="true"
          data-component-boundary="switch-track"
          style={{
            position: 'absolute',
            top: 4,
            left: 2,
            width: 28,
            height: 16,
            borderRadius: 10,
            background: checked ? t.accent : t.surface3,
            border: `1px solid ${checked ? t.accent : t.dim}`,
            transition: 'background .15s',
          }}
        >
          <span
            data-component-boundary="switch-thumb"
            style={{
              position: 'absolute',
              top: 1,
              left: checked ? 13 : 1,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: checked ? t.accentInk : t.dim,
              transition: 'left .15s',
            }}
          />
        </span>
      </button>
      {label && (
        <span style={{ fontSize: 12, color: t.text, fontFamily: FONTS.sans }}>
          {label}
        </span>
      )}
    </span>
  )
}
