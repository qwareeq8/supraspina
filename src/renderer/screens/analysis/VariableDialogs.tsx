/**
 * The two ways to add a variable: import a table of per-subject variables
 * (main's native chooser; the sidecar copies it into the project's
 * analysis folder), or derive one from existing variables (a sum, a
 * difference, log(1 + x), or bins).
 */

import { useId, useState, type ReactNode } from 'react'
import {
  defaultBinLabels,
  type AnalysisVariableTable,
  type DerivedOp,
  type DerivedVariable,
  type GroupAnalysisSpecV2,
  type VariableRefV2,
} from '../../../shared/group-analysis'
import { useApp } from '../../state/context'
import { Btn, Field, FONTS, Hint, Modal, Segments, TextInput } from '../../ui'
import { SelectField } from './controls'
import { derivedId, draftUses } from './draft-v2'
import type { VariableChoice } from './variables'
import { parseCuts } from './rail-text'

const PRINTABLE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

/** The dialog title style (serif display, 18/400). */
function DialogTitle({ id, children }: { id: string; children: ReactNode }) {
  const { t } = useApp()
  return (
    <h2
      id={id}
      style={{
        margin: 0,
        fontFamily: FONTS.serif,
        fontWeight: 400,
        fontSize: 18,
        color: t.textStrong,
      }}
    >
      {children}
    </h2>
  )
}

/** The derive dialog's inputs. */
export interface DerivedDialogProps {
  draft: GroupAnalysisSpecV2
  choices: readonly VariableChoice[]
  onAdd: (item: DerivedVariable) => void
  onDismiss: () => void
}

const OP_LABEL: Readonly<Record<DerivedOp, string>> = {
  sum: 'Sum',
  difference: 'Difference',
  log1p: 'log(1 + x)',
  bins: 'Bins',
}

const OP_HINT: Readonly<Record<DerivedOp, string>> = {
  sum: 'Adds two to eight numeric variables, as motor = UEMS + LEMS.',
  difference: 'Subtracts the second variable from the first.',
  log1p: 'Takes log(1 + x) of one variable; values must exceed -1.',
  bins: 'Cuts one variable into left-closed bins, a categorical variable.',
}

function arity(op: DerivedOp): [number, number] {
  return op === 'sum' ? [2, 8] : op === 'difference' ? [2, 2] : [1, 1]
}

/** Ask for a derived variable. */
export function DerivedDialog({
  draft,
  choices,
  onAdd,
  onDismiss,
}: DerivedDialogProps): ReactNode {
  const { t } = useApp()
  const titleId = `derive-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const numeric = choices.filter((choice) => choice.kind === 'numeric')
  const [label, setLabel] = useState('')
  const [op, setOp] = useState<DerivedOp>('sum')
  const [inputs, setInputs] = useState<string[]>(['', ''])
  const [cutsText, setCutsText] = useState('')
  const [labelsText, setLabelsText] = useState('')
  const [low, high] = arity(op)
  const shownInputs = inputs.slice(0, high)
  while (shownInputs.length < low) shownInputs.push('')
  const trimmed = label.trim()
  const cuts = op === 'bins' ? parseCuts(cutsText) : []
  const binLabels =
    op === 'bins' && labelsText.trim()
      ? labelsText.split(',').map((part) => part.trim())
      : []
  const errors: string[] = []
  if (!(trimmed.length > 0 && trimmed.length <= 64 && PRINTABLE.test(trimmed)))
    errors.push('Name the variable with 1 to 64 printable ASCII characters.')
  if (shownInputs.some((key) => !key))
    errors.push('Choose every input variable.')
  else if (new Set(shownInputs).size !== shownInputs.length)
    errors.push('Choose each input once.')
  if (op === 'bins') {
    if (!cuts || cuts.length === 0) errors.push('Give one or more cut points.')
    else if (cuts.some((cut, i) => i > 0 && cut <= cuts[i - 1]!))
      errors.push('Give the cut points in increasing order.')
    else if (binLabels.length > 0 && binLabels.length !== cuts.length + 1)
      errors.push(`Name all ${cuts.length + 1} bins, or none.`)
    else if (
      binLabels.some((name) => !PRINTABLE.test(name) || name.length > 64)
    )
      errors.push('Name each bin with printable ASCII characters.')
  }
  const refs = shownInputs
    .map((key) => numeric.find((choice) => choice.key === key)?.ref)
    .filter((ref): ref is VariableRefV2 => Boolean(ref))
  const submit = (): void => {
    if (errors.length > 0) return
    onAdd({
      id: derivedId(trimmed, draft.variables.derived),
      label: trimmed,
      op,
      inputs: refs,
      params:
        op === 'bins'
          ? { cuts: cuts ?? [], labels: binLabels }
          : { cuts: [], labels: [] },
    })
  }
  const preview =
    op === 'bins' && cuts && cuts.length > 0 && errors.length === 0
      ? (binLabels.length > 0 ? binLabels : defaultBinLabels(cuts)).join(', ')
      : null
  return (
    <Modal
      t={t}
      labelledBy={titleId}
      onDismiss={onDismiss}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss()
      }}
      cardStyle={{ width: 'min(440px, 100%)', padding: 18, gap: 12 }}
    >
      <DialogTitle id={titleId}>Derive a variable</DialogTitle>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        style={{ display: 'grid', gap: 12 }}
      >
        <Field t={t} label="Name">
          <TextInput t={t} value={label} onChange={setLabel} />
        </Field>
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, color: t.dim, fontFamily: FONTS.sans }}>
            Operation
          </span>
          <Segments
            t={t}
            small
            ariaLabel="Operation"
            value={op}
            options={(Object.keys(OP_LABEL) as DerivedOp[]).map((value) => ({
              value,
              label: OP_LABEL[value],
            }))}
            onChange={(value) => setOp(value as DerivedOp)}
          />
          <Hint t={t}>{OP_HINT[op]}</Hint>
        </div>
        {shownInputs.map((key, index) => (
          <div
            key={index}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              gap: 6,
              alignItems: 'end',
            }}
          >
            <SelectField
              label={
                op === 'difference'
                  ? index === 0
                    ? 'From'
                    : 'Subtract'
                  : high === 1
                    ? 'Variable'
                    : `Input ${index + 1}`
              }
              value={key}
              options={[
                { value: '', label: 'Choose a variable' },
                ...numeric.map((choice) => ({
                  value: choice.key,
                  label: choice.label,
                })),
              ]}
              onChange={(value) =>
                setInputs(() => {
                  const next = [...shownInputs]
                  next[index] = value
                  return next
                })
              }
            />
            {op === 'sum' && shownInputs.length > low ? (
              <Btn
                t={t}
                small
                ghost
                label="Remove"
                ariaLabel={`Remove input ${index + 1}`}
                onClick={() =>
                  setInputs(shownInputs.filter((_, i) => i !== index))
                }
              />
            ) : (
              <span />
            )}
          </div>
        ))}
        {op === 'sum' && shownInputs.length < high && (
          <div>
            <Btn
              t={t}
              small
              ghost
              label="Add input"
              onClick={() => setInputs([...shownInputs, ''])}
            />
          </div>
        )}
        {op === 'bins' && (
          <>
            <Field
              t={t}
              label="Cut points"
              hint="Increasing numbers, for example 30, 45."
            >
              <TextInput t={t} value={cutsText} onChange={setCutsText} />
            </Field>
            <Field
              t={t}
              label="Bin names"
              hint="Optional, comma separated; one more than the cut points."
            >
              <TextInput t={t} value={labelsText} onChange={setLabelsText} />
            </Field>
            {preview && <Hint t={t}>Bins: {preview}.</Hint>}
          </>
        )}
        {errors.length > 0 && trimmed.length > 0 && (
          <Hint t={t} style={{ color: t.failed }}>
            {errors[0]}
          </Hint>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn t={t} label="Cancel" ghost onClick={onDismiss} />
          <Btn
            t={t}
            label="Add variable"
            primary
            disabled={errors.length > 0}
            onClick={submit}
          />
        </div>
      </form>
    </Modal>
  )
}

/** The import dialog's inputs. */
export interface ImportVariablesDialogProps {
  draft: GroupAnalysisSpecV2
  tables: readonly AnalysisVariableTable[]
  busy: boolean
  onImport: () => Promise<AnalysisVariableTable | null>
  onRemove: (tableId: string) => Promise<boolean>
  onDismiss: () => void
}

/** Show the imported variables tables, import another, or remove one. */
export function ImportVariablesDialog({
  draft,
  tables,
  busy,
  onImport,
  onRemove,
  onDismiss,
}: ImportVariablesDialogProps): ReactNode {
  const { t } = useApp()
  const titleId = `variables-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [note, setNote] = useState<string | null>(null)
  return (
    <Modal
      t={t}
      labelledBy={titleId}
      onDismiss={onDismiss}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss()
      }}
      cardStyle={{ width: 'min(520px, 100%)', padding: 18, gap: 12 }}
    >
      <DialogTitle id={titleId}>Imported variables</DialogTitle>
      <Hint t={t}>
        A CSV with one row per subject: one column of subject IDs and one column
        per variable. Supraspina copies it into the project&apos;s analysis
        folder; the original file is not read again.
      </Hint>
      {tables.length === 0 ? (
        <Hint t={t}>No table is imported.</Hint>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 8,
          }}
        >
          {tables.map((table) => {
            const used = draftUses(
              draft,
              (ref) => ref.source === 'imported' && ref.table === table.tableId,
            )
            return (
              <li
                key={table.tableId}
                style={{
                  display: 'grid',
                  gap: 4,
                  padding: '8px 10px',
                  border: `1px solid ${t.borderSoft}`,
                  borderRadius: 5,
                  background: t.bg,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontFamily: FONTS.sans,
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: t.text,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {table.name}
                  </span>
                  <Btn
                    t={t}
                    small
                    ghost
                    label="Remove..."
                    ariaLabel={`Remove ${table.name}`}
                    disabled={busy || used}
                    title={
                      used
                        ? 'The analysis uses this table; stop using its columns first.'
                        : undefined
                    }
                    onClick={() => {
                      void onRemove(table.tableId).then((removed) => {
                        if (removed) setNote(`Removed ${table.name}.`)
                      })
                    }}
                  />
                </div>
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 11.5,
                    color: t.textSoft,
                  }}
                >
                  {table.rows} rows, subject IDs in {table.idColumn}
                  {table.unmatched > 0
                    ? `; ${table.unmatched} ${table.unmatched === 1 ? 'row names a subject' : 'rows name subjects'} the project does not have`
                    : ''}
                  . Imported {new Date(table.importedAt).toLocaleString()}.
                </span>
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 11.5,
                    color: t.dimText,
                  }}
                >
                  {table.columns
                    .map(
                      (column) =>
                        `${column.column} (${column.kind}, n ${column.n})`,
                    )
                    .join(', ')}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {note && (
        <p
          role="status"
          style={{
            margin: 0,
            fontFamily: FONTS.sans,
            fontSize: 12,
            color: t.text,
          }}
        >
          {note}
        </p>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn
          t={t}
          label="Choose CSV..."
          disabled={busy}
          onClick={() => {
            void onImport().then((table) => {
              if (table)
                setNote(
                  `Imported ${table.name}: ${table.rows} rows, ${table.columns.length} ${table.columns.length === 1 ? 'variable' : 'variables'}.`,
                )
            })
          }}
        />
        <Btn t={t} label="Done" primary onClick={onDismiss} />
      </div>
    </Modal>
  )
}
