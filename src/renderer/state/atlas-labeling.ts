/**
 * The atlas state of the Analysis panel: the project's atlas catalog (tier
 * A sources, tier B labeled atlases, added atlases, tool facts), the
 * labeling operation, one atlas's per-subject label states, and the
 * machine-level atlas sources with their download.
 *
 * As in `group-analysis.ts`, every answer is tagged with the project
 * generation that asked for it, so a project switch drops the old state at
 * once. A running labeling is polled every second and a running download
 * every half second, each only while it runs; the catalog is read again
 * when either ends, so new labels and atlases show at once.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AtlasCatalog,
  AtlasClearSubjects,
  AtlasDownloadOperation,
  AtlasEntry,
  AtlasLabelOperation,
  AtlasLabelSubjects,
  AtlasLabelsImportResult,
  AtlasRecipeId,
  AtlasSourceUrlKind,
  AtlasSourcesList,
  SubjectLabelStatus,
} from '../../shared/atlas-labeling'
import type { AnalysisStageCurrency } from '../../shared/group-analysis'
import type { ProjectRef } from '../../shared/types'
import { getApi } from './api'
import { analysisProjectKey, type Load } from './group-analysis'

/** The polling interval of a running labeling, in milliseconds. */
export const LABEL_POLL_MS = 1000
/** The polling interval of a running atlas download, in milliseconds. */
export const DOWNLOAD_POLL_MS = 500

const LOADING = { phase: 'loading' } as const

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** The files and license of an atlas the operator adds. */
export interface AddAtlasRequest {
  recipeId: Extract<AtlasRecipeId, 'user-gcs' | 'user-annot' | 'user-volume'>
  label: string
  license: { name: string; url: string | null }
  externalSourceId: string | null
}

/** One atlas's per-subject label states. */
export interface AtlasSubjectStates {
  atlasId: string
  load: Load<SubjectLabelStatus[]>
}

interface Core {
  key: string | null
  catalog: Load<AtlasCatalog>
  sources: Load<AtlasSourcesList>
  labeling: AtlasLabelOperation | null
  download: AtlasDownloadOperation | null
  subjects: AtlasSubjectStates | null
  actionError: string | null
  busy: boolean
}

function initial(key: string | null): Core {
  return {
    key,
    catalog: LOADING,
    sources: LOADING,
    labeling: null,
    download: null,
    subjects: null,
    actionError: null,
    busy: false,
  }
}

/** Options of {@link useAtlasLabeling}. */
export interface AtlasLabelingOptions {
  /** The stage currency shown, recorded with a labeling start. */
  stageCurrency: AnalysisStageCurrency
  /** Called when labels or atlases changed, so the measures are read again. */
  onChanged: () => void
}

/** The atlas state and its actions. */
export interface AtlasLabelingState {
  catalog: Load<AtlasCatalog>
  sources: Load<AtlasSourcesList>
  /** The project's running or last labeling. */
  labeling: AtlasLabelOperation | null
  labelingRunning: boolean
  /** The running or last atlas download. */
  download: AtlasDownloadOperation | null
  /** The per-subject states last read, with their atlas. */
  subjects: AtlasSubjectStates | null
  actionError: string | null
  busy: boolean
  reload: () => void
  start: (
    atlasId: string,
    subjects: AtlasLabelSubjects,
    jobs: number,
  ) => Promise<boolean>
  cancel: () => Promise<void>
  clear: (atlasId: string, subjects: AtlasClearSubjects) => Promise<boolean>
  readSubjects: (atlasId: string) => void
  importLabels: (atlasId: string) => Promise<AtlasLabelsImportResult | null>
  addAtlas: (request: AddAtlasRequest) => Promise<AtlasEntry | null>
  chooseSubregionsPython: () => Promise<void>
  clearSubregionsPython: () => Promise<void>
  startDownload: (sourceId: string) => Promise<boolean>
  cancelDownload: () => Promise<void>
  /** Open a source's catalog page or license in the browser. */
  openPage: (sourceId: string, kind?: AtlasSourceUrlKind) => Promise<void>
  dismissError: () => void
}

/**
 * Hold the atlas state of the open project.
 *
 * @param project - The open project, or null.
 */
export function useAtlasLabeling(
  project: ProjectRef | null,
  { stageCurrency, onChanged }: AtlasLabelingOptions,
): AtlasLabelingState {
  const key = analysisProjectKey(project)
  const [core, setCore] = useState<Core>(() => initial(key))
  const [tick, setTick] = useState(0)
  const live = core.key === key ? core : initial(key)
  const projectRef = useRef(project)
  const keyRef = useRef(key)
  const coreRef = useRef(live)
  const currencyRef = useRef(stageCurrency)
  const changedRef = useRef(onChanged)
  useEffect(() => {
    projectRef.current = project
    keyRef.current = key
    coreRef.current = live
    currencyRef.current = stageCurrency
    changedRef.current = onChanged
  })

  const patch = useCallback(
    (tag: string | null, change: (current: Core) => Core) =>
      setCore((current) => (current.key === tag ? change(current) : current)),
    [],
  )

  useEffect(() => {
    setCore((current) => (current.key === key ? current : initial(key)))
  }, [key])

  // The catalog, read on open, on reload, after an operation, and when the
  // out-of-date recons change. Only the latest answer lands.
  const outdated = stageCurrency.recon?.outdatedSubjectIds ?? []
  const outdatedKey = outdated.join('\u0000')
  const catalogSeq = useRef(0)
  useEffect(() => {
    if (!project || key === null) return
    const tag = key
    const asked = ++catalogSeq.current
    const ids = outdatedKey === '' ? [] : outdatedKey.split('\u0000')
    getApi()
      .groupAnalysis.atlases({ project, reconOutdatedSubjectIds: ids })
      .then(
        (catalog) =>
          patch(tag, (c) =>
            asked === catalogSeq.current
              ? {
                  ...c,
                  catalog: { phase: 'ready', value: catalog },
                  // The catalog carries the operation: a reopened panel
                  // finds a labeling still running.
                  labeling: catalog.labeling ?? c.labeling,
                }
              : c,
          ),
        (error: unknown) =>
          patch(tag, (c) =>
            asked !== catalogSeq.current || c.catalog.phase === 'ready'
              ? c
              : {
                  ...c,
                  catalog: {
                    phase: 'error',
                    message: message(error, 'The atlases could not be read.'),
                  },
                },
          ),
      )
    getApi()
      .atlasSources.list()
      .then(
        (sources) =>
          patch(tag, (c) => ({
            ...c,
            sources: { phase: 'ready', value: sources },
          })),
        (error: unknown) =>
          patch(tag, (c) =>
            c.sources.phase === 'ready'
              ? c
              : {
                  ...c,
                  sources: {
                    phase: 'error',
                    message: message(
                      error,
                      'The atlas sources could not be read.',
                    ),
                  },
                },
          ),
      )
  }, [project, key, tick, outdatedKey, patch])

  const reload = useCallback(() => setTick((n) => n + 1), [])

  // Poll the labeling while it runs.
  const labelingRunning = live.labeling?.state === 'running'
  const labelingId = live.labeling?.operationId ?? null
  useEffect(() => {
    if (!project || key === null || !labelingRunning) return undefined
    const tag = key
    let inFlight = false
    let settled = false
    const timer = window.setInterval(() => {
      if (inFlight || settled) return
      inFlight = true
      const shown = coreRef.current.subjects?.atlasId ?? null
      getApi()
        .groupAnalysis.labelStatus({ project, atlasId: shown })
        .then(
          (status) => {
            if (settled) return
            const operation = status.operation
            patch(tag, (c) => ({
              ...c,
              labeling: operation,
              subjects:
                status.atlasId !== null &&
                c.subjects?.atlasId === status.atlasId
                  ? {
                      atlasId: status.atlasId,
                      load: { phase: 'ready', value: status.subjects },
                    }
                  : c.subjects,
            }))
            if (!operation || operation.operationId !== labelingId) {
              settled = true
              window.clearInterval(timer)
              setTick((n) => n + 1)
              return
            }
            if (operation.state !== 'running') {
              settled = true
              window.clearInterval(timer)
              setTick((n) => n + 1)
              changedRef.current()
            }
          },
          () => undefined,
        )
        .finally(() => {
          inFlight = false
        })
    }, LABEL_POLL_MS)
    return () => {
      settled = true
      window.clearInterval(timer)
    }
  }, [project, key, labelingRunning, labelingId, patch])

  // Poll the download while it runs.
  const downloadRunning = live.download?.state === 'running'
  useEffect(() => {
    if (key === null || !downloadRunning) return undefined
    const tag = key
    let inFlight = false
    let settled = false
    const timer = window.setInterval(() => {
      if (inFlight || settled) return
      inFlight = true
      getApi()
        .atlasSources.status()
        .then(
          ({ operation }) => {
            if (settled) return
            patch(tag, (c) => ({ ...c, download: operation }))
            if (!operation || operation.state !== 'running') {
              settled = true
              window.clearInterval(timer)
              setTick((n) => n + 1)
              if (operation?.state === 'done') changedRef.current()
            }
          },
          () => undefined,
        )
        .finally(() => {
          inFlight = false
        })
    }, DOWNLOAD_POLL_MS)
    return () => {
      settled = true
      window.clearInterval(timer)
    }
  }, [key, downloadRunning, patch])

  /** Run one action with the busy flag and a fact on failure. */
  const act = useCallback(
    async <T>(
      run: (project: ProjectRef) => Promise<T>,
      fallback: string,
    ): Promise<T | null> => {
      const current = projectRef.current
      const tag = keyRef.current
      if (!current) return null
      patch(tag, (c) => ({ ...c, busy: true, actionError: null }))
      try {
        const value = await run(current)
        patch(tag, (c) => ({ ...c, busy: false }))
        return value
      } catch (error) {
        patch(tag, (c) => ({
          ...c,
          busy: false,
          actionError: message(error, fallback),
        }))
        return null
      }
    },
    [patch],
  )

  const start = useCallback(
    async (atlasId: string, subjects: AtlasLabelSubjects, jobs: number) => {
      const tag = keyRef.current
      const started = await act(
        (current) =>
          getApi().groupAnalysis.labelStart({
            project: current,
            atlasId,
            subjects,
            jobs,
            stageCurrency: currencyRef.current,
          }),
        'The labeling could not start.',
      )
      if (!started) return false
      patch(tag, (c) => ({ ...c, labeling: started.operation }))
      if (started.operation.state !== 'running') setTick((n) => n + 1)
      return started.started
    },
    [act, patch],
  )

  const cancel = useCallback(async () => {
    const operation = coreRef.current.labeling
    const tag = keyRef.current
    if (!operation || operation.state !== 'running') return
    const status = await act(async (current) => {
      await getApi().groupAnalysis.labelCancel({
        project: current,
        operationId: operation.operationId,
      })
      return getApi().groupAnalysis.labelStatus({
        project: current,
        atlasId: null,
      })
    }, 'The labeling could not be stopped.')
    if (status) {
      patch(tag, (c) => ({ ...c, labeling: status.operation }))
      setTick((n) => n + 1)
      changedRef.current()
    }
  }, [act, patch])

  const clear = useCallback(
    async (atlasId: string, subjects: AtlasClearSubjects) => {
      const catalog = coreRef.current.catalog
      if (catalog.phase !== 'ready') return false
      const cleared = await act(
        (current) =>
          getApi().groupAnalysis.clearLabels({
            project: current,
            atlasId,
            subjects,
            expectedRevision: catalog.value.revision,
          }),
        'The labels could not be removed.',
      )
      setTick((n) => n + 1)
      if (cleared) changedRef.current()
      return cleared !== null
    },
    [act],
  )

  const readSubjects = useCallback(
    (atlasId: string) => {
      const current = projectRef.current
      const tag = keyRef.current
      if (!current) return
      patch(tag, (c) => ({ ...c, subjects: { atlasId, load: LOADING } }))
      getApi()
        .groupAnalysis.labelStatus({ project: current, atlasId })
        .then(
          (status) =>
            patch(tag, (c) =>
              c.subjects?.atlasId === atlasId
                ? {
                    ...c,
                    subjects: {
                      atlasId,
                      load: { phase: 'ready', value: status.subjects },
                    },
                  }
                : c,
            ),
          (error: unknown) =>
            patch(tag, (c) =>
              c.subjects?.atlasId === atlasId
                ? {
                    ...c,
                    subjects: {
                      atlasId,
                      load: {
                        phase: 'error',
                        message: message(
                          error,
                          'The label states could not be read.',
                        ),
                      },
                    },
                  }
                : c,
            ),
        )
    },
    [patch],
  )

  const importLabels = useCallback(
    async (atlasId: string) => {
      const result = await act(
        (current) =>
          getApi().groupAnalysis.chooseLabelsFolder({
            project: current,
            atlasId,
          }),
        'The labels could not be imported.',
      )
      if (result) {
        setTick((n) => n + 1)
        changedRef.current()
      }
      return result
    },
    [act],
  )

  const addAtlas = useCallback(
    async (request: AddAtlasRequest) => {
      const result = await act(
        (current) =>
          getApi().groupAnalysis.chooseAtlasFiles({
            project: current,
            ...request,
          }),
        'The atlas could not be added.',
      )
      if (result) {
        setTick((n) => n + 1)
        changedRef.current()
      }
      return result?.atlas ?? null
    },
    [act],
  )

  const chooseSubregionsPython = useCallback(async () => {
    const path = await act(
      () => getApi().atlasSources.chooseSubregionsPython(),
      'The interpreter could not be chosen.',
    )
    if (path) setTick((n) => n + 1)
  }, [act])

  const clearSubregionsPython = useCallback(async () => {
    await act(
      () => getApi().atlasSources.clearSubregionsPython(),
      'The interpreter could not be cleared.',
    )
    setTick((n) => n + 1)
  }, [act])

  const startDownload = useCallback(
    async (sourceId: string) => {
      const tag = keyRef.current
      const started = await act(
        () =>
          getApi().atlasSources.download({
            sourceId,
            licenseAcknowledged: true,
          }),
        'The download could not start.',
      )
      if (!started) return false
      patch(tag, (c) => ({ ...c, download: started.operation }))
      return true
    },
    [act, patch],
  )

  const cancelDownload = useCallback(async () => {
    const operation = coreRef.current.download
    const tag = keyRef.current
    if (!operation || operation.state !== 'running') return
    const status = await act(async () => {
      await getApi().atlasSources.cancel({
        operationId: operation.operationId,
      })
      return getApi().atlasSources.status()
    }, 'The download could not be stopped.')
    if (status) patch(tag, (c) => ({ ...c, download: status.operation }))
  }, [act, patch])

  // Opening a page is instant and changes nothing, so it never marks busy.
  const openPage = useCallback(
    async (sourceId: string, kind: AtlasSourceUrlKind = 'page') => {
      const tag = keyRef.current
      try {
        await getApi().atlasSources.openPage({ sourceId, kind })
      } catch (error) {
        patch(tag, (c) => ({
          ...c,
          actionError: message(error, 'The page could not be opened.'),
        }))
      }
    },
    [patch],
  )

  const dismissError = useCallback(
    () => patch(keyRef.current, (c) => ({ ...c, actionError: null })),
    [patch],
  )

  return {
    catalog: live.catalog,
    sources: live.sources,
    labeling: live.labeling,
    labelingRunning,
    download: live.download,
    subjects: live.subjects,
    actionError: live.actionError,
    busy: live.busy,
    reload,
    start,
    cancel,
    clear,
    readSubjects,
    importLabels,
    addAtlas,
    chooseSubregionsPython,
    clearSubregionsPython,
    startDownload,
    cancelDownload,
    openPage,
    dismissError,
  }
}
