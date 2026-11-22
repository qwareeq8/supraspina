/**
 * The rows and measure details of a shown v2 result. `groupAnalysis.result`
 * returns every term and the first term's leading rows; the other rows come
 * in pages of up to 2,000 from `groupAnalysis.termRows`, read on demand and
 * kept while the result is shown. Measure details are read per term.
 *
 * Every answer is tagged with the project generation and result it was
 * asked for, so a late answer for another result never lands.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GroupAnalysisMeasureDetailV2,
  GroupAnalysisResultV2,
  GroupAnalysisRowV2,
} from '../../shared/group-analysis'
import type { ProjectRef } from '../../shared/types'
import { getApi } from './api'
import { analysisProjectKey, type Load } from './group-analysis'

/** The rows of one term read so far. */
export interface TermRowsState {
  rows: GroupAnalysisRowV2[]
  /** The term's row count. */
  total: number
  /** The offset of the next page, or null once every row is read. */
  nextOffset: number | null
  loading: boolean
  error: string | null
}

interface Store {
  key: string | null
  rows: Record<string, TermRowsState>
  details: Record<string, Load<GroupAnalysisMeasureDetailV2>>
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function seed(result: GroupAnalysisResultV2 | null): Store['rows'] {
  const rows: Store['rows'] = {}
  if (!result) return rows
  for (const term of result.terms) {
    const first = term.termId === result.terms[0]?.termId
    const seeded = first ? result.rows : []
    rows[term.termId] = {
      rows: seeded,
      total: term.rowCount,
      // The header carries the first term's leading rows; the rest page on.
      nextOffset:
        first && seeded.length >= term.rowCount ? null : seeded.length,
      loading: false,
      error: null,
    }
  }
  return rows
}

/** The term rows and measure details of the shown v2 result. */
export interface AnalysisTermsState {
  /** The rows read of a term, or null for a term the result lacks. */
  termRows: (termId: string) => TermRowsState | null
  /** Read the next page of each named term that has one and is idle. */
  readMore: (termIds: readonly string[]) => void
  /** Read the first page of each named term not read yet. */
  ensure: (termIds: readonly string[]) => void
  detail: (
    termId: string,
    measureId: string,
  ) => Load<GroupAnalysisMeasureDetailV2> | null
  requestDetail: (termId: string, measureId: string) => void
}

/**
 * Hold the rows and details of the shown v2 result.
 *
 * @param project - The open project, or null.
 * @param result - The shown v2 result, or null.
 */
export function useAnalysisTerms(
  project: ProjectRef | null,
  result: GroupAnalysisResultV2 | null,
): AnalysisTermsState {
  const key =
    project && result
      ? `${analysisProjectKey(project) ?? ''}\u0000${result.resultId}\u0000${result.resultSha256}`
      : null
  const [store, setStore] = useState<Store>(() => ({
    key,
    rows: seed(result),
    details: {},
  }))
  const live: Store =
    store.key === key ? store : { key, rows: seed(result), details: {} }
  const liveRef = useRef(live)
  const projectRef = useRef(project)
  const resultRef = useRef(result)
  useEffect(() => {
    liveRef.current = live
    projectRef.current = project
    resultRef.current = result
  })
  useEffect(() => {
    setStore((current) =>
      current.key === key
        ? current
        : { key, rows: seed(resultRef.current), details: {} },
    )
  }, [key])

  const patch = useCallback(
    (tag: string | null, change: (current: Store) => Store) =>
      setStore((current) => {
        const base =
          current.key === tag
            ? current
            : tag === key
              ? { key, rows: seed(resultRef.current), details: {} }
              : null
        return base ? change(base) : current
      }),
    [key],
  )

  const read = useCallback(
    (termIds: readonly string[], onlyUnread: boolean) => {
      const project = projectRef.current
      const shown = resultRef.current
      const tag = liveRef.current.key
      if (!project || !shown || tag === null) return
      for (const termId of termIds) {
        const entry = liveRef.current.rows[termId]
        if (!entry || entry.loading || entry.nextOffset === null) continue
        if (onlyUnread && entry.rows.length > 0) continue
        const offset = entry.nextOffset
        const loading = { ...entry, loading: true, error: null }
        liveRef.current = {
          ...liveRef.current,
          rows: { ...liveRef.current.rows, [termId]: loading },
        }
        patch(tag, (c) => ({ ...c, rows: { ...c.rows, [termId]: loading } }))
        getApi()
          .groupAnalysis.termRows({
            project,
            resultId: shown.resultId,
            termId,
            offset,
          })
          .then(
            (page) =>
              patch(tag, (c) => {
                const current = c.rows[termId]
                if (
                  !current ||
                  page.termId !== termId ||
                  page.offset !== current.rows.length
                ) {
                  return c
                }
                return {
                  ...c,
                  rows: {
                    ...c.rows,
                    [termId]: {
                      rows: [...current.rows, ...page.rows],
                      total: page.total,
                      nextOffset: page.nextOffset,
                      loading: false,
                      error: null,
                    },
                  },
                }
              }),
            (error: unknown) =>
              patch(tag, (c) => {
                const current = c.rows[termId]
                return current
                  ? {
                      ...c,
                      rows: {
                        ...c.rows,
                        [termId]: {
                          ...current,
                          loading: false,
                          error: message(
                            error,
                            'The rows of this term could not be read.',
                          ),
                        },
                      },
                    }
                  : c
              }),
          )
      }
    },
    [patch],
  )

  const readMore = useCallback(
    (termIds: readonly string[]) => read(termIds, false),
    [read],
  )
  const ensure = useCallback(
    (termIds: readonly string[]) => read(termIds, true),
    [read],
  )

  const rows = live.rows
  const termRows = useCallback((termId: string) => rows[termId] ?? null, [rows])
  const details = live.details
  const detail = useCallback(
    (termId: string, measureId: string) =>
      details[`${termId}\u0000${measureId}`] ?? null,
    [details],
  )
  const requestDetail = useCallback(
    (termId: string, measureId: string) => {
      const project = projectRef.current
      const shown = resultRef.current
      const tag = liveRef.current.key
      if (!project || !shown || tag === null) return
      const cacheKey = `${termId}\u0000${measureId}`
      // A failed read is asked again; a loading or ready one is kept.
      const cached = liveRef.current.details[cacheKey]
      if (cached && cached.phase !== 'error') return
      liveRef.current = {
        ...liveRef.current,
        details: {
          ...liveRef.current.details,
          [cacheKey]: { phase: 'loading' },
        },
      }
      patch(tag, (c) => ({
        ...c,
        details: { ...c.details, [cacheKey]: { phase: 'loading' } },
      }))
      getApi()
        .groupAnalysis.measureDetail({
          project,
          resultId: shown.resultId,
          measureId,
          termId,
        })
        .then(
          (value) =>
            patch(tag, (c) => ({
              ...c,
              details: { ...c.details, [cacheKey]: { phase: 'ready', value } },
            })),
          (error: unknown) =>
            patch(tag, (c) => ({
              ...c,
              details: {
                ...c.details,
                [cacheKey]: {
                  phase: 'error',
                  message: message(
                    error,
                    'The measure values could not be read.',
                  ),
                },
              },
            })),
        )
    },
    [patch],
  )

  return { termRows, readMore, ensure, detail, requestDetail }
}
