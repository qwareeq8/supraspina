/**
 * The results table of one term of a v2 result, the text alternative of
 * its figures. Its columns follow the term: a two-group or pairwise term
 * shows the group sizes, the adjusted difference, d with its CI, and t; an
 * association or slope difference the slope (and the slope per SD), the
 * partial r with its CI, and t; an F term F with both degrees of freedom
 * and partial eta squared. Every term ends with p, the corrected p, and a
 * text significance mark; a pairwise term after a gated omnibus test adds
 * the omnibus column, and a term outside the correction family drops the
 * corrected p and says so.
 *
 * Rows sort, filter to the significant ones, and move with the keyboard
 * (arrow keys, Home, End, Page Up and Down, Enter to open the measure
 * figure); long tables render only the rows in view and read further pages
 * on request.
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
import { measureLabel } from '../../../../shared/brain-atlas'
import type {
  GroupAnalysisResultV2,
  GroupAnalysisRowV2,
  GroupAnalysisTerm,
} from '../../../../shared/group-analysis'
import {
  CORRECTION_SHORT,
  correctedFloor,
  formatFixed,
  formatP,
  formatValue,
} from '../../../figures/format'
import { useApp } from '../../../state/context'
import type { TermRowsState } from '../../../state/analysis-terms'
import { Btn, FONTS, Toggle } from '../../../ui'
import { useAvailableHeight } from '../../../ui/useAvailableHeight'
import { Notice } from '../CurrencyNotice'
import { sigCellColor, tableHemisphere, tableMeasureName } from '../describe'
import { OUTSIDE_FAMILY_TEXT, rowStat, termEffect, termTest } from './terms'

/** The row height the window arithmetic assumes, in CSS pixels. */
export const TERM_ROW_HEIGHT = 28
const WINDOW_THRESHOLD = 120
const OVERSCAN = 12

type SortKey = 'order' | 'measure' | 'pct' | 'effect' | 'stat' | 'p' | 'pc'

/** One column of the table. */
interface Column {
  key: string
  sort: SortKey | null
  label: ReactNode
  title?: string
  align: 'left' | 'right'
  cell: (row: GroupAnalysisRowV2, selected: boolean) => ReactNode
  bold?: (row: GroupAnalysisRowV2) => boolean
  color?: (row: GroupAnalysisRowV2, selected: boolean) => string
}

function interval(
  value: number | null,
  low: number | null,
  high: number | null,
  digits: number,
): string {
  if (value === null) return ''
  const point = formatFixed(value, digits)
  return low === null || high === null
    ? point
    : `${point} [${formatFixed(low, digits)}, ${formatFixed(high, digits)}]`
}

/** The term table's inputs. */
export interface TermTableProps {
  result: GroupAnalysisResultV2
  term: GroupAnalysisTerm
  rows: TermRowsState
  selectedId: string | null
  onSelect: (measureId: string) => void
  onOpen: (measureId: string) => void
  /** Read the term's next page of rows. */
  onReadMore: () => void
}

export function TermTable({
  result,
  term,
  rows: state,
  selectedId,
  onSelect,
  onOpen,
  onReadMore,
}: TermTableProps): ReactNode {
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
  const effect = termEffect(result, term)
  const test = termTest(result, term)
  const { correction, permutations, omnibusGate } = result.spec.inference
  const floor = correctedFloor(correction, permutations)
  const short = CORRECTION_SHORT[correction]
  const inFamily = term.family !== null
  const showCorrected = inFamily && correction !== 'none'
  const gate = omnibusGate && term.role === 'pairwise'

  const columns = useMemo((): Column[] => {
    const list: Column[] = [
      {
        key: 'n',
        sort: null,
        label: <i>n</i>,
        align: 'right',
        cell: (row) =>
          effect === 'd' && row.nFocal !== null && row.nReference !== null
            ? `${row.nFocal}/${row.nReference}`
            : row.nTotal,
      },
    ]
    if (effect === 'd') {
      list.push(
        {
          key: 'pct',
          sort: 'pct',
          label: 'Diff %',
          title: 'Adjusted difference as a percentage of the reference mean',
          align: 'right',
          cell: (row) =>
            row.pctOfReference === null
              ? ''
              : `${formatFixed(row.pctOfReference, 1, true)}%`,
        },
        {
          key: 'd',
          sort: 'effect',
          label: (
            <>
              <i>d</i> [95% CI]
            </>
          ),
          title: 'Adjusted standardized difference with its 95% CI',
          align: 'right',
          cell: (row) => interval(row.d, row.dLow, row.dHigh, 2),
        },
      )
    } else if (effect === 'r') {
      list.push({
        key: 'slope',
        sort: null,
        label: 'Slope',
        title: 'The tested coefficient in the measure unit',
        align: 'right',
        cell: (row) => (row.estimate === null ? '' : formatValue(row.estimate)),
      })
      if (test?.kind === 'association') {
        list.push({
          key: 'slope-sd',
          sort: null,
          label: 'Per SD',
          title: 'The slope per SD of the tested variable',
          align: 'right',
          cell: (row) =>
            row.slopePerSd === null ? '' : formatValue(row.slopePerSd),
        })
      }
      list.push({
        key: 'r',
        sort: 'effect',
        label: (
          <>
            Partial <i>r</i> [95% CI]
          </>
        ),
        title: 'Partial correlation with its Fisher-z 95% CI',
        align: 'right',
        cell: (row) =>
          interval(row.partialR, row.partialRLow, row.partialRHigh, 2),
      })
    }
    if (term.kind === 'F') {
      list.push(
        {
          key: 'F',
          sort: 'stat',
          label: (
            <>
              <i>F</i> (df)
            </>
          ),
          align: 'right',
          cell: (row) =>
            `${formatFixed(row.F ?? NaN, 2)} (${row.df1}, ${Math.round(row.df2)})`,
        },
        {
          key: 'eta',
          sort: 'effect',
          label: (
            <>
              Partial <i>{'\u03b7'}</i>
              {'\u00b2'}
            </>
          ),
          align: 'right',
          cell: (row) => formatFixed(row.partialEta2, 3),
        },
      )
    } else {
      list.push({
        key: 't',
        sort: 'stat',
        label: (
          <>
            <i>t</i> (df)
          </>
        ),
        align: 'right',
        cell: (row) =>
          `${formatFixed(row.t ?? NaN, 2)} (${Math.round(row.df2)})`,
      })
    }
    list.push({
      key: 'p',
      sort: 'p',
      label: <i>p</i>,
      align: 'right',
      cell: (row) => formatP(row.p),
    })
    if (showCorrected) {
      list.push({
        key: 'pc',
        sort: 'pc',
        label: (
          <>
            {short} <i>p</i>
          </>
        ),
        align: 'right',
        cell: (row) =>
          row.pCorrected === null ? '' : formatP(row.pCorrected, floor),
        bold: (row) => row.significant,
      })
    }
    if (gate) {
      list.push({
        key: 'gate',
        sort: null,
        label: 'Omnibus',
        title: 'Whether the omnibus test of this measure was significant',
        align: 'left',
        cell: (row) => (row.gated ? 'Not significant' : 'Significant'),
        color: (row, selected) =>
          row.gated ? (selected ? t.textSoft : t.dimText) : t.text,
      })
    }
    list.push({
      key: 'sig',
      sort: null,
      label: 'Sig.',
      align: 'left',
      cell: (row) => (row.significant ? 'Yes' : 'No'),
      bold: (row) => row.significant,
      color: (row, selected) => sigCellColor(t, row.significant, selected),
    })
    return list
  }, [effect, test?.kind, term.kind, showCorrected, short, floor, gate, t])

  const sorted = useMemo(() => {
    const order = new Map(
      state.rows.map((row, index) => [row.measureId, index]),
    )
    const value = (row: GroupAnalysisRowV2): number | string => {
      switch (sort.key) {
        case 'order':
          return order.get(row.measureId)!
        case 'measure':
          return `${tableMeasureName(row.measureId)} ${tableHemisphere(row.measureId)}`
        case 'pct':
          return row.pctOfReference ?? 0
        case 'effect':
          return effect === 'd'
            ? (row.d ?? 0)
            : effect === 'r'
              ? (row.partialR ?? 0)
              : row.partialEta2
        case 'stat':
          return rowStat(row)
        case 'p':
          return row.p
        case 'pc':
          return row.pCorrected ?? row.p
      }
    }
    const filtered = significantOnly
      ? state.rows.filter((row) => row.significant)
      : state.rows
    return [...filtered].sort((a, b) => {
      const va = value(a)
      const vb = value(b)
      const cmp =
        typeof va === 'string'
          ? va.localeCompare(vb as string)
          : va - (vb as number)
      return sort.desc ? -cmp : cmp
    })
  }, [state.rows, sort, significantOnly, effect])

  const selectedIndex = sorted.findIndex((row) => row.measureId === selectedId)
  const windowed = sorted.length > WINDOW_THRESHOLD
  const first = windowed
    ? Math.max(0, Math.floor(scrollTop / TERM_ROW_HEIGHT) - OVERSCAN)
    : 0
  const last = windowed
    ? Math.min(
        sorted.length,
        Math.ceil((scrollTop + viewport) / TERM_ROW_HEIGHT) + OVERSCAN,
      )
    : sorted.length

  useEffect(() => {
    if (!focusPending.current) return
    focusPending.current = false
    scrollRef.current
      ?.querySelector<HTMLElement>('tr[data-selected="true"]')
      ?.focus()
  })

  const move = (index: number): void => {
    const row = sorted[Math.max(0, Math.min(sorted.length - 1, index))]
    if (!row) return
    focusPending.current = true
    const el = scrollRef.current
    if (el) {
      const top = sorted.indexOf(row) * TERM_ROW_HEIGHT
      if (top < el.scrollTop) el.scrollTop = top
      else if (top + TERM_ROW_HEIGHT * 2 > el.scrollTop + el.clientHeight) {
        el.scrollTop = top + TERM_ROW_HEIGHT * 2 - el.clientHeight
      }
      setScrollTop(el.scrollTop)
    }
    onSelect(row.measureId)
    const target = el?.querySelector<HTMLElement>(
      `tr[data-measure-id="${CSS.escape(row.measureId)}"]`,
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
    const page = Math.max(1, Math.floor(viewport / TERM_ROW_HEIGHT) - 1)
    const target =
      event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowUp'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? sorted.length - 1
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
      onOpen(sorted[index]!.measureId)
    }
  }

  const headStyle = {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    background: t.surface2,
    borderBottom: `1px solid ${t.border}`,
    padding: 0,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  } as const
  const header = (
    column: Pick<Column, 'key' | 'sort' | 'label' | 'align' | 'title'>,
  ) => {
    const active = column.sort !== null && sort.key === column.sort
    const sortKey = column.sort
    return (
      <th
        key={column.key}
        scope="col"
        aria-sort={
          active ? (sort.desc ? 'descending' : 'ascending') : undefined
        }
        style={{ ...headStyle, textAlign: column.align }}
      >
        {sortKey === null ? (
          <span
            title={column.title}
            style={{
              display: 'block',
              padding: '0 8px',
              color: t.dim,
              lineHeight: '26px',
            }}
          >
            {column.label}
          </span>
        ) : (
          <button
            type="button"
            title={column.title}
            onClick={() =>
              setSort((s) =>
                s.key === sortKey
                  ? s.desc
                    ? { key: 'order', desc: false }
                    : { key: sortKey, desc: true }
                  : { key: sortKey, desc: false },
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
              textAlign: column.align,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {column.label}
            <span
              aria-hidden="true"
              style={{ display: 'inline-block', width: 10, color: t.dim }}
            >
              {active ? (sort.desc ? '\u2193' : '\u2191') : ''}
            </span>
          </button>
        )}
      </th>
    )
  }

  const cell = {
    padding: '0 8px',
    height: TERM_ROW_HEIGHT,
    whiteSpace: 'nowrap',
    borderBottom: `1px solid ${t.borderSoft}`,
  } as const
  const num = {
    textAlign: 'right',
  } as const
  const span = columns.length + 2
  const significantCount = state.rows.filter((row) => row.significant).length
  const read = state.rows.length
  const counts = `${significantCount} of ${read.toLocaleString('en-US')} significant${
    !inFamily
      ? ''
      : correction === 'none'
        ? ' (uncorrected)'
        : ` after ${short} correction`
  }${read < state.total ? `; ${read.toLocaleString('en-US')} of ${state.total.toLocaleString('en-US')} rows read` : ''}`

  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      {!inFamily && (
        <Notice
          tone="info"
          headline={`${OUTSIDE_FAMILY_TEXT}.`}
          detail="This test is a sensitivity analysis: its p values are uncorrected and no row is marked significant by the correction."
        />
      )}
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
          {counts}
        </span>
        {state.nextOffset !== null && (
          <Btn
            t={t}
            small
            label={
              state.loading
                ? 'Reading rows...'
                : `Read ${Math.min(2000, state.total - read).toLocaleString('en-US')} more rows`
            }
            disabled={state.loading}
            onClick={onReadMore}
          />
        )}
      </div>
      {state.error && (
        <Notice
          tone="error"
          headline={state.error}
          action={{
            label: 'Retry',
            onClick: onReadMore,
            title: 'Read the rows of this term again.',
          }}
        />
      )}
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
          aria-label={`Results of ${result.name}, ${term.label}`}
          aria-rowcount={sorted.length + 1}
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
              {header({
                key: 'measure',
                sort: 'measure',
                label: 'Measure',
                align: 'left',
              })}
              <th
                scope="col"
                style={{
                  ...headStyle,
                  padding: '0 8px',
                  color: t.dim,
                  textAlign: 'left',
                }}
              >
                Hemi
              </th>
              {columns.map((column) => header(column))}
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr aria-hidden="true">
                <td
                  colSpan={span}
                  style={{ height: first * TERM_ROW_HEIGHT, padding: 0 }}
                />
              </tr>
            )}
            {sorted.slice(first, last).map((row, offset) => {
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
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      style={{
                        ...cell,
                        ...(column.align === 'right' ? num : {}),
                        fontWeight: column.bold?.(row) ? 700 : 400,
                        ...(column.color
                          ? { color: column.color(row, selected) }
                          : {}),
                      }}
                    >
                      {column.cell(row, selected)}
                    </td>
                  ))}
                </tr>
              )
            })}
            {last < sorted.length && (
              <tr aria-hidden="true">
                <td
                  colSpan={span}
                  style={{
                    height: (sorted.length - last) * TERM_ROW_HEIGHT,
                    padding: 0,
                  }}
                />
              </tr>
            )}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div
            style={{
              padding: 12,
              fontFamily: FONTS.sans,
              fontSize: 12,
              color: t.dimText,
            }}
          >
            {state.loading
              ? 'Reading the rows of this term.'
              : read === 0
                ? 'This term has no rows.'
                : 'No measure is significant.'}
          </div>
        )}
      </div>
    </div>
  )
}
