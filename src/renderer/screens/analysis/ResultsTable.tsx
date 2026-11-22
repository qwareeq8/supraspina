/**
 * The results table: one row per measure with its sample, adjusted
 * difference, effect size with CI, t, p, corrected p, and a text
 * significance mark. It is the text alternative of every figure. Rows are
 * sortable, filterable to the significant ones, and keyboard navigable
 * (arrow keys, Home, End, and Enter to open the measure figure); long tables
 * render only the rows in view.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { measureLabel } from '../../../shared/brain-atlas'
import {
  type GroupAnalysisResult,
  type GroupAnalysisRow,
} from '../../../shared/group-analysis'
import {
  CORRECTION_SHORT,
  correctedFloor,
  formatFixed,
  formatP,
  formatValue,
} from '../../figures/format'
import { useApp } from '../../state/context'
import { sigCellColor, tableHemisphere, tableMeasureName } from './describe'
import { FONTS, Toggle } from '../../ui'
import { useAvailableHeight } from '../../ui/useAvailableHeight'

/** The row height the window arithmetic assumes, in CSS pixels. */
export const TABLE_ROW_HEIGHT = 28
/** Tables longer than this render only the rows in view. */
const WINDOW_THRESHOLD = 120
const OVERSCAN = 12

type SortKey = 'order' | 'measure' | 'pct' | 'd' | 't' | 'p' | 'pCorrected'

/** The results table's inputs. */
export interface ResultsTableProps {
  result: GroupAnalysisResult
  selectedId: string | null
  onSelect: (measureId: string) => void
  /** Open the selected measure's figure (Enter on a row). */
  onOpen: (measureId: string) => void
}

export function ResultsTable({
  result,
  selectedId,
  onSelect,
  onOpen,
}: ResultsTableProps): ReactNode {
  const { t } = useApp()
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'order',
    desc: false,
  })
  const [significantOnly, setSignificantOnly] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(480)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const fitRef = useAvailableHeight<HTMLDivElement>({
    minHeight: 220,
    trailing: 1,
  })
  const focusPending = useRef(false)
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el
      return fitRef(el)
    },
    [fitRef],
  )
  const groups = result.spec.contrast.type === 'groups'
  const { correction, permutations } = result.spec.inference
  const floor = correctedFloor(correction, permutations)
  const short = CORRECTION_SHORT[correction]

  const rows = useMemo(() => {
    const order = new Map(
      result.rows.map((row, index) => [row.measureId, index]),
    )
    const value = (row: GroupAnalysisRow): number | string => {
      switch (sort.key) {
        case 'order':
          return order.get(row.measureId)!
        case 'measure':
          return `${tableMeasureName(row.measureId)} ${tableHemisphere(row.measureId)}`
        case 'pct':
          return row.pctOfReference ?? 0
        case 'd':
          return row.d ?? row.t
        case 't':
          return row.t
        case 'p':
          return row.p
        case 'pCorrected':
          return row.pCorrected ?? row.p
      }
    }
    const filtered = significantOnly
      ? result.rows.filter((row) => row.significant)
      : result.rows
    return [...filtered].sort((a, b) => {
      const va = value(a)
      const vb = value(b)
      const cmp =
        typeof va === 'string'
          ? va.localeCompare(vb as string)
          : va - (vb as number)
      return sort.desc ? -cmp : cmp
    })
  }, [result.rows, sort, significantOnly])

  const selectedIndex = rows.findIndex((row) => row.measureId === selectedId)
  const windowed = rows.length > WINDOW_THRESHOLD
  const first = windowed
    ? Math.max(0, Math.floor(scrollTop / TABLE_ROW_HEIGHT) - OVERSCAN)
    : 0
  const last = windowed
    ? Math.min(
        rows.length,
        Math.ceil((scrollTop + viewport) / TABLE_ROW_HEIGHT) + OVERSCAN,
      )
    : rows.length

  useEffect(() => {
    if (!focusPending.current) return
    focusPending.current = false
    const row = scrollRef.current?.querySelector<HTMLElement>(
      'tr[data-selected="true"]',
    )
    row?.focus()
  })

  const move = (index: number): void => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))]
    if (!row) return
    focusPending.current = true
    const el = scrollRef.current
    if (el) {
      const top = rows.indexOf(row) * TABLE_ROW_HEIGHT
      if (top < el.scrollTop) el.scrollTop = top
      else if (top + TABLE_ROW_HEIGHT * 2 > el.scrollTop + el.clientHeight) {
        el.scrollTop = top + TABLE_ROW_HEIGHT * 2 - el.clientHeight
      }
      setScrollTop(el.scrollTop)
    }
    onSelect(row.measureId)
    // Focus a rendered row now; a windowed-out row takes focus once drawn.
    const target = el?.querySelector<HTMLElement>(
      `tr[data-measure-id="${row.measureId}"]`,
    )
    if (target) {
      focusPending.current = false
      target.focus()
    }
  }

  const onKeyDown = (
    event: KeyboardEvent<HTMLTableRowElement>,
    index: number,
  ): void => {
    const page = Math.max(1, Math.floor(viewport / TABLE_ROW_HEIGHT) - 1)
    const target =
      event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowUp'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? rows.length - 1
              : event.key === 'PageDown'
                ? index + page
                : event.key === 'PageUp'
                  ? index - page
                  : null
    if (target !== null) {
      event.preventDefault()
      move(target)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen(rows[index]!.measureId)
    }
  }

  const header = (
    key: SortKey,
    label: ReactNode,
    align: 'left' | 'right' = 'right',
    title?: string,
  ) => {
    const active = sort.key === key
    return (
      <th
        scope="col"
        aria-sort={
          active ? (sort.desc ? 'descending' : 'ascending') : undefined
        }
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          background: t.surface2,
          borderBottom: `1px solid ${t.border}`,
          padding: 0,
          textAlign: align,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        <button
          type="button"
          title={title}
          onClick={() =>
            setSort((s) =>
              s.key === key
                ? s.desc
                  ? { key: 'order', desc: false }
                  : { key, desc: true }
                : { key, desc: false },
            )
          }
          style={{
            width: '100%',
            minHeight: 26,
            padding: '0 8px',
            border: 'none',
            background: 'transparent',
            color: active ? t.text : t.dim,
            font: 'inherit',
            fontWeight: 600,
            textAlign: align,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
          <span
            aria-hidden="true"
            style={{ display: 'inline-block', width: 10, color: t.dim }}
          >
            {active ? (sort.desc ? '\u2193' : '\u2191') : ''}
          </span>
        </button>
      </th>
    )
  }

  const num = {
    fontFamily: FONTS.mono,
    fontSize: 11.5,
    textAlign: 'right',
  } as const
  const cell = {
    padding: '0 8px',
    height: TABLE_ROW_HEIGHT,
    whiteSpace: 'nowrap',
    borderBottom: `1px solid ${t.borderSoft}`,
  } as const
  const significantCount = result.rows.filter((row) => row.significant).length

  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <Toggle
          t={t}
          checked={significantOnly}
          onChange={setSignificantOnly}
          label="Significant only"
        />
        <span
          style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.dimText }}
        >
          {significantCount} of {result.rows.length} significant
          {correction === 'none'
            ? ' (uncorrected)'
            : ` after ${short} correction`}
          {result.skipped.length > 0
            ? `; ${result.skipped.length} skipped`
            : ''}
        </span>
      </div>
      <div
        ref={attach}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop)
          setViewport(event.currentTarget.clientHeight || viewport)
        }}
        style={{
          overflow: 'auto',
          border: `1px solid ${t.borderSoft}`,
          borderRadius: 6,
          background: t.surface,
        }}
      >
        <table
          aria-label={`Results of ${result.name}`}
          aria-rowcount={rows.length + 1}
          style={{
            width: '100%',
            borderCollapse: 'separate',
            borderSpacing: 0,
            fontFamily: FONTS.sans,
            fontSize: 12,
            color: t.text,
          }}
        >
          <thead>
            <tr aria-rowindex={1}>
              {header('measure', 'Measure', 'left')}
              <th
                scope="col"
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  background: t.surface2,
                  borderBottom: `1px solid ${t.border}`,
                  padding: '0 8px',
                  color: t.dim,
                  fontWeight: 600,
                  textAlign: 'left',
                }}
              >
                Hemi
              </th>
              <th
                scope="col"
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  background: t.surface2,
                  borderBottom: `1px solid ${t.border}`,
                  padding: '0 8px',
                  color: t.dim,
                  fontWeight: 600,
                  textAlign: 'right',
                  whiteSpace: 'nowrap',
                }}
              >
                n
              </th>
              {groups &&
                header(
                  'pct',
                  'Diff %',
                  'right',
                  'Adjusted difference as a percentage of the reference mean',
                )}
              {groups
                ? header(
                    'd',
                    <>
                      <i>d</i> [95% CI]
                    </>,
                    'right',
                    'Adjusted standardized difference with its 95% CI',
                  )
                : header('d', 'Slope', 'right')}
              {header(
                't',
                <>
                  <i>t</i> (df)
                </>,
              )}
              {header('p', <i>p</i>)}
              {correction !== 'none' &&
                header(
                  'pCorrected',
                  <>
                    {short} <i>p</i>
                  </>,
                )}
              <th
                scope="col"
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  background: t.surface2,
                  borderBottom: `1px solid ${t.border}`,
                  padding: '0 8px',
                  color: t.dim,
                  fontWeight: 600,
                  textAlign: 'left',
                }}
              >
                Sig.
              </th>
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr aria-hidden="true">
                <td
                  colSpan={9}
                  style={{ height: first * TABLE_ROW_HEIGHT, padding: 0 }}
                />
              </tr>
            )}
            {rows.slice(first, last).map((row, offset) => {
              const index = first + offset
              const selected = row.measureId === selectedId
              const focusable =
                selected || (selectedIndex === -1 && index === 0)
              return (
                <tr
                  key={row.measureId}
                  aria-rowindex={index + 2}
                  aria-current={selected ? 'true' : undefined}
                  data-selected={selected ? 'true' : undefined}
                  data-measure-id={row.measureId}
                  tabIndex={focusable ? 0 : -1}
                  onClick={() => onSelect(row.measureId)}
                  onDoubleClick={() => onOpen(row.measureId)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  onFocus={() => {
                    if (!selected && selectedIndex === -1)
                      onSelect(row.measureId)
                  }}
                  style={{
                    cursor: 'pointer',
                    background: selected ? t.accentSoft : undefined,
                    boxShadow: selected
                      ? `inset 3px 0 0 ${t.accent}`
                      : undefined,
                  }}
                >
                  <td
                    style={{
                      ...cell,
                      maxWidth: 260,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={measureLabel(row.measureId)}
                  >
                    {tableMeasureName(row.measureId)}
                  </td>
                  <td style={{ ...cell, color: t.textSoft }}>
                    {tableHemisphere(row.measureId)}
                  </td>
                  <td style={{ ...cell, ...num }}>
                    {groups && row.nFocal !== null && row.nReference !== null
                      ? `${row.nFocal}/${row.nReference}`
                      : row.nTotal}
                  </td>
                  {groups && (
                    <td style={{ ...cell, ...num }}>
                      {row.pctOfReference === null
                        ? ''
                        : `${formatFixed(row.pctOfReference, 1, true)}%`}
                    </td>
                  )}
                  <td style={{ ...cell, ...num }}>
                    {groups && row.d !== null
                      ? `${formatFixed(row.d, 2)} [${formatFixed(row.dLow ?? NaN, 2)}, ${formatFixed(row.dHigh ?? NaN, 2)}]`
                      : formatValue(row.estimate)}
                  </td>
                  <td style={{ ...cell, ...num }}>
                    {formatFixed(row.t, 2)} ({Math.round(row.df)})
                  </td>
                  <td style={{ ...cell, ...num }}>{formatP(row.p)}</td>
                  {correction !== 'none' && (
                    <td
                      style={{
                        ...cell,
                        ...num,
                        fontWeight: row.significant ? 700 : 400,
                      }}
                    >
                      {row.pCorrected === null
                        ? ''
                        : formatP(row.pCorrected, floor)}
                    </td>
                  )}
                  <td
                    style={{
                      ...cell,
                      color: sigCellColor(t, row.significant, selected),
                      fontWeight: row.significant ? 700 : 400,
                    }}
                  >
                    {row.significant ? 'Yes' : 'No'}
                  </td>
                </tr>
              )
            })}
            {last < rows.length && (
              <tr aria-hidden="true">
                <td
                  colSpan={9}
                  style={{
                    height: (rows.length - last) * TABLE_ROW_HEIGHT,
                    padding: 0,
                  }}
                />
              </tr>
            )}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div
            style={{
              padding: 12,
              fontFamily: FONTS.sans,
              fontSize: 12,
              color: t.dimText,
            }}
          >
            No measure is significant.
          </div>
        )}
      </div>
    </div>
  )
}
