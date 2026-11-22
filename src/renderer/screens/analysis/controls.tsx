/**
 * Small form pieces the Analysis controls share, built on the app's atoms:
 * a rail section, a labeled native select, a checkbox row, and a name
 * prompt.
 */

import { useId, useRef, useState, type ReactNode } from 'react'
import { useApp } from '../../state/context'
import {
  Btn,
  Collapsible,
  Field,
  FONTS,
  Modal,
  StateLine,
  TextInput,
} from '../../ui'

/** One section of the controls rail. */
export interface RailSectionProps {
  id: string
  title: string
  /** A short fact beside the title, such as "20 selected". */
  summary?: string | undefined
  open: boolean
  onToggle: () => void
  children: ReactNode
}

/** Render one collapsible rail section with an imperative heading. */
export function RailSection({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: RailSectionProps): ReactNode {
  const { t } = useApp()
  return (
    <section
      aria-label={title}
      style={{ borderTop: `1px solid ${t.borderSoft}` }}
    >
      <Collapsible
        t={t}
        id={id}
        open={open}
        onToggle={onToggle}
        header={
          <span
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontFamily: FONTS.sans,
                fontSize: 12,
                fontWeight: 600,
                color: t.text,
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </span>
            {summary && (
              <span
                style={{
                  marginLeft: 'auto',
                  fontFamily: FONTS.sans,
                  fontSize: 11,
                  color: t.dimText,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                {summary}
              </span>
            )}
          </span>
        }
      >
        <div
          style={{
            display: 'grid',
            gap: 10,
            padding: '2px 12px 12px 12px',
          }}
        >
          {children}
        </div>
      </Collapsible>
    </section>
  )
}

/** One option of a {@link SelectField}. */
export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

/** A labeled native select. */
export interface SelectFieldProps {
  label: string
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  hint?: string | undefined
  disabled?: boolean
}

/** Render a labeled native select in the app's input style. */
export function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: SelectFieldProps): ReactNode {
  const { t } = useApp()
  const id = `sel-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <Field t={t} label={label} controlId={id} {...(hint ? { hint } : {})}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        // A narrow select clips a long option; the tooltip states it whole.
        title={options.find((option) => option.value === value)?.label}
        onChange={(event) => onChange(event.target.value)}
        style={selectStyle(t)}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

/** The shared native-select style. */
function selectStyle(t: ReturnType<typeof useApp>['t']) {
  return {
    height: 'var(--ss-input-h)',
    width: '100%',
    minWidth: 0,
    padding: '0 6px',
    border: `1px solid ${t.dim}`,
    borderRadius: 4,
    background: t.bg,
    color: t.text,
    fontFamily: FONTS.sans,
    fontSize: 11.5,
  } as const
}

/** One checkbox with its label and an optional trailing fact. */
export interface CheckRowProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  trailing?: ReactNode
  disabled?: boolean
  title?: string | undefined
}

/** Render a checkbox row that keeps the 24 px target. */
export function CheckRow({
  checked,
  onChange,
  label,
  trailing,
  disabled,
  title,
}: CheckRowProps): ReactNode {
  const { t } = useApp()
  return (
    <label
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        // Leave 4 px around the 24 px box so stacked rows never touch.
        minHeight: 28,
        fontFamily: FONTS.sans,
        fontSize: 12,
        color: disabled ? t.dimText : t.text,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        {label}
      </span>
      {trailing !== undefined && <StateLine t={t}>{trailing}</StateLine>}
    </label>
  )
}

/** A dialog that asks for a name. */
export interface NameDialogProps {
  title: string
  label: string
  initial: string
  confirmLabel: string
  note?: string
  onConfirm: (name: string) => void
  onDismiss: () => void
}

const PRINTABLE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

/** Ask for a printable name of at most 120 characters. */
export function NameDialog({
  title,
  label,
  initial,
  confirmLabel,
  note,
  onConfirm,
  onDismiss,
}: NameDialogProps): ReactNode {
  const { t } = useApp()
  const [name, setName] = useState(initial)
  const inputRef = useRef<HTMLElement | null>(null)
  const titleId = `name-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const trimmed = name.trim()
  const valid =
    trimmed.length > 0 && trimmed.length <= 120 && PRINTABLE.test(trimmed)
  const submit = (): void => {
    if (valid) onConfirm(trimmed)
  }
  return (
    <Modal
      t={t}
      labelledBy={titleId}
      onDismiss={onDismiss}
      initialFocusRef={inputRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss()
      }}
      cardStyle={{ width: 'min(420px, 100%)', padding: 18, gap: 12 }}
    >
      <h2
        id={titleId}
        style={{
          margin: 0,
          fontFamily: FONTS.serif,
          fontWeight: 400,
          fontSize: 18,
          color: t.textStrong,
        }}
      >
        {title}
      </h2>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        style={{ display: 'grid', gap: 12 }}
      >
        <Field
          t={t}
          label={label}
          {...(valid || trimmed.length === 0
            ? {}
            : { error: 'Use 1 to 120 printable ASCII characters.' })}
          {...(note ? { hint: note } : {})}
        >
          <div
            ref={(el) => {
              inputRef.current = el?.querySelector('input') ?? null
            }}
          >
            <TextInput
              t={t}
              value={name}
              onChange={setName}
              style={{ fontSize: 12.5 }}
            />
          </div>
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn t={t} label="Cancel" ghost onClick={onDismiss} />
          <Btn
            t={t}
            label={confirmLabel}
            primary
            disabled={!valid}
            onClick={submit}
          />
        </div>
      </form>
    </Modal>
  )
}

/**
 * Render a small heading inside a rail section, such as "Tests". It is a
 * paragraph, not a heading element: the rail sections' own titles are
 * disclosure buttons, so a heading here would skip a level.
 */
export function SubHeading({ children }: { children: ReactNode }): ReactNode {
  const { t } = useApp()
  return (
    <p
      style={{
        margin: '4px 0 0',
        fontFamily: FONTS.sans,
        fontSize: 11.5,
        fontWeight: 600,
        color: t.textSoft,
      }}
    >
      {children}
    </p>
  )
}
