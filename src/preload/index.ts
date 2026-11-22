/**
 * Exposes a minimal sandbox-compatible preload bridge.
 *
 * Only the typed Supraspina API reaches the renderer. Native filesystem access
 * stays limited to path pickers and opaque project artifact identities.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import type {
  BoundaryRequest,
  HostState,
  SupraspinaApi,
  Unsubscribe,
  UpdateState,
  WindowPlacementPreference,
  WindowPlacementState,
} from '../shared/contract'
import { parsePublicRpcError } from '../shared/rpc-errors'
import {
  parseSidecarRpcResult,
  SIDECAR_RPC_RESULT_METHODS,
} from '../shared/rpc-result-contracts'
import {
  parseInputFovListResult,
  parseInputFovReviewRequest,
  parseInputFovReviewResult,
  parseManagedResourceProgress,
  parseManagedResourceRequest,
  parseManagedResourceStatusResult,
} from '../shared/scientific-contracts'
import {
  parseEnvInstallState,
  parsePipelineStdout,
  parseProvisionLog,
  parseProvisionProgress,
  parseRuntimeEvent,
  parseRuntimeJob,
} from '../shared/runtime-contracts'
import {
  parseAnalysisVariableTable,
  parseGroupAnalysisExportResult,
  type GroupAnalysisMeasureDetail,
  type GroupAnalysisMeasureDetailV2,
} from '../shared/group-analysis'
import {
  ATLAS_SOURCE_URL_KINDS,
  parseAtlasDownloadCancelResult,
  parseAtlasDownloadStartResult,
  parseAtlasDownloadStatus,
  parseAtlasImportResult,
  parseAtlasLabelsImportResult,
  parseAtlasSourcesList,
} from '../shared/atlas-labeling'
import { parseBrainAsset, parseBrainAssetsReport } from '../shared/brain-atlas'
import {
  isMachinePreferencesState,
  type MachinePreferencesPatch,
  type MachinePreferencesState,
} from '../shared/preferences'

interface EventEnvelope {
  topic: string
  payload: unknown
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { topic?: unknown }).topic === 'string' &&
    'payload' in value
  )
}

/**
 * Electron's transport wrapper on every rejected `invoke`. Treat
 * `Error invoking remote method '<channel>': Error: <message>` as pure plumbing
 * with no operator value. Remove it before the window sees the failure, and
 * preserve only the message that main chose to publish.
 */
const ELECTRON_INVOKE_PREFIX =
  /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/

/** Strip the transport wrapper while preserving the published message. */
function operatorFacingError(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const message = error.message.replace(ELECTRON_INVOKE_PREFIX, '')
  if (!message || message === error.message) return error
  const stripped = new Error(message)
  if (error.stack !== undefined) stripped.stack = error.stack
  return stripped
}

async function invoke<T>(
  domain: string,
  method: string,
  args: unknown[],
): Promise<T> {
  try {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.invoke, {
      domain,
      method,
      args,
    })
    const key = `${domain}.${method}`
    return (
      SIDECAR_RPC_RESULT_METHODS.has(key)
        ? parseSidecarRpcResult(key, result)
        : result
    ) as T
  } catch (error) {
    const parsed = parsePublicRpcError(
      error instanceof Error ? error.message : null,
    )
    throw parsed ?? operatorFacingError(error)
  }
}

function subscribe<T>(
  topic: string,
  handler: (payload: T) => void,
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, message: unknown): void => {
    if (!isEventEnvelope(message) || message.topic !== topic) return
    handler(message.payload as T)
  }
  ipcRenderer.on(IPC_CHANNELS.event, listener)
  return () => ipcRenderer.removeListener(IPC_CHANNELS.event, listener)
}

/**
 * Copy each PNG into a buffer it fully spans: structured clone sends a view's
 * whole backing buffer, which main's size cap would not see.
 */
function exactExportFigures<T extends { figures?: unknown }>(request: T): T {
  if (!isRecord(request) || !Array.isArray(request.figures)) return request
  return {
    ...request,
    figures: request.figures.map((figure: unknown) =>
      isRecord(figure) && figure.png instanceof Uint8Array
        ? { ...figure, png: figure.png.slice() }
        : figure,
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafeDisplayLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 80 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )
}

function isWindowPlacementPreference(
  value: unknown,
): value is WindowPlacementPreference {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  if (value['mode'] === 'remember' || value['mode'] === 'primary') {
    return keys.length === 1 && keys[0] === 'mode'
  }
  return (
    value['mode'] === 'display' &&
    keys.length === 2 &&
    keys[0] === 'displayId' &&
    keys[1] === 'mode' &&
    typeof value['displayId'] === 'string' &&
    /^display-[a-f0-9]{24}$/.test(value['displayId'])
  )
}

function isWindowPlacementState(value: unknown): value is WindowPlacementState {
  const stateKeys = isRecord(value) ? Object.keys(value).sort() : []
  if (
    !isRecord(value) ||
    !(
      stateKeys.join(',') ===
        'displays,fallbackReason,preference,resolvedDisplayId' ||
      stateKeys.join(',') ===
        'displays,fallbackReason,preference,resolvedDisplayId,unavailableDisplayLabel'
    ) ||
    !isWindowPlacementPreference(value['preference']) ||
    !Array.isArray(value['displays']) ||
    value['displays'].length === 0 ||
    typeof value['resolvedDisplayId'] !== 'string' ||
    !/^display-[a-f0-9]{24}$/.test(value['resolvedDisplayId']) ||
    (value['fallbackReason'] !== null &&
      value['fallbackReason'] !== 'selected-display-unavailable') ||
    (value['unavailableDisplayLabel'] !== undefined &&
      !isSafeDisplayLabel(value['unavailableDisplayLabel']))
  ) {
    return false
  }
  const identifiers = new Set<string>()
  const numbers = new Set<number>()
  let primaryCount = 0
  for (const display of value['displays']) {
    if (!isRecord(display)) return false
    const keys = Object.keys(display).sort().join(',')
    if (
      keys !== 'id,number,primary,resolution,scaleFactor,workArea' &&
      keys !== 'id,label,number,primary,resolution,scaleFactor,workArea'
    ) {
      return false
    }
    const label = display['label']
    const validLabel = label === undefined || isSafeDisplayLabel(label)
    const resolution = display['resolution']
    const workArea = display['workArea']
    const validSize = (size: unknown): boolean =>
      isRecord(size) &&
      Object.keys(size).sort().join(',') === 'height,width' &&
      Number.isSafeInteger(size['width']) &&
      (size['width'] as number) > 0 &&
      Number.isSafeInteger(size['height']) &&
      (size['height'] as number) > 0
    if (
      typeof display['id'] !== 'string' ||
      !/^display-[a-f0-9]{24}$/.test(display['id']) ||
      identifiers.has(display['id']) ||
      !Number.isSafeInteger(display['number']) ||
      (display['number'] as number) <= 0 ||
      numbers.has(display['number'] as number) ||
      typeof display['primary'] !== 'boolean' ||
      !validSize(resolution) ||
      !validSize(workArea) ||
      typeof display['scaleFactor'] !== 'number' ||
      !Number.isFinite(display['scaleFactor']) ||
      display['scaleFactor'] <= 0 ||
      display['scaleFactor'] > 16 ||
      !validLabel
    ) {
      return false
    }
    identifiers.add(display['id'])
    numbers.add(display['number'] as number)
    if (display['primary']) primaryCount += 1
  }
  return (
    primaryCount === 1 &&
    identifiers.has(value['resolvedDisplayId']) &&
    (value['fallbackReason'] === 'selected-display-unavailable'
      ? value['preference'].mode === 'display'
      : value['unavailableDisplayLabel'] === undefined)
  )
}

async function invokePreferencesState(
  method: 'get' | 'patch' | 'reset',
  args: [] | [MachinePreferencesPatch],
): Promise<MachinePreferencesState> {
  const value = await invoke<unknown>('preferences', method, args)
  if (!isMachinePreferencesState(value)) {
    throw new Error('Return valid machine preferences from the desktop host.')
  }
  return value
}

async function invokeWindowPlacementState(
  method: 'getState' | 'setPreference' | 'moveNow',
  args: [] | [WindowPlacementPreference],
): Promise<WindowPlacementState> {
  const value = await invoke<unknown>('windowPlacement', method, args)
  if (!isWindowPlacementState(value)) {
    throw new Error('Return valid display information from the desktop host.')
  }
  return value
}

const api: SupraspinaApi = {
  project: {
    create: (request) => invoke('project', 'create', [request]),
    open: (request) => invoke('project', 'open', [request]),
    close: (request) => invoke('project', 'close', [request]),
    save: (request) => invoke('project', 'save', [request]),
    validate: (cfg) => invoke('project', 'validate', [cfg]),
  },
  host: {
    getState: () => invoke('host', 'getState', []),
    retrySidecar: () => invoke('host', 'retrySidecar', []),
    onState: (cb) => subscribe<HostState>(IPC_EVENTS.hostState, cb),
  },
  preferences: {
    get: () => invokePreferencesState('get', []),
    patch: (patch) => invokePreferencesState('patch', [patch]),
    reset: () => invokePreferencesState('reset', []),
    onChanged: (cb) =>
      subscribe<unknown>(IPC_EVENTS.preferencesChanged, (payload) => {
        if (isMachinePreferencesState(payload)) cb(payload)
      }),
  },
  windowPlacement: {
    getState: () => invokeWindowPlacementState('getState', []),
    setPreference: (preference) => {
      if (!isWindowPlacementPreference(preference)) {
        return Promise.reject(
          new TypeError('Provide a valid window placement preference.'),
        )
      }
      return invokeWindowPlacementState('setPreference', [preference])
    },
    moveNow: () => invokeWindowPlacementState('moveNow', []),
    identifyDisplays: () =>
      invoke<void>('windowPlacement', 'identifyDisplays', []),
    onTopologyChanged: (cb) =>
      subscribe<unknown>(IPC_EVENTS.windowPlacementChanged, (payload) => {
        if (isWindowPlacementState(payload)) cb(payload)
      }),
  },
  platform: {
    detect: () => invoke('platform', 'detect', []),
    cpuCount: () => invoke('platform', 'cpuCount', []),
    toNative: (p) => invoke('platform', 'toNative', [p]),
    fromNative: (p) => invoke('platform', 'fromNative', [p]),
  },
  fs: {
    chooseDir: (opts) => invoke('fs', 'chooseDir', [opts]),
    chooseFile: (opts) => invoke('fs', 'chooseFile', [opts]),
    chooseSavePath: (opts) => invoke('fs', 'chooseSavePath', [opts]),
  },
  external: {
    openWeb: (request) => invoke('external', 'openWeb', [request]),
    openThirdPartyNotices: () =>
      invoke('external', 'openThirdPartyNotices', []),
  },
  execution: {
    authorize: (request) => invoke('execution', 'authorize', [request]),
  },
  artifact: {
    open: (request) => invoke('artifact', 'open', [request]),
    reveal: (request) => invoke('artifact', 'reveal', [request]),
    list: (request) => invoke('artifact', 'list', [request]),
    readText: (request) => invoke('artifact', 'readText', [request]),
    previewImage: (request) => invoke('artifact', 'previewImage', [request]),
  },
  qc: {
    authoritativeRun: (request) => invoke('qc', 'authoritativeRun', [request]),
    galleryImages: (request) => invoke('qc', 'galleryImages', [request]),
    attestGalleryView: (request) =>
      invoke('qc', 'attestGalleryView', [request]),
  },
  env: {
    check: (request) => invoke('env', 'check', [request]),
    optInInstall: (request) => invoke('env', 'optInInstall', [request]),
    installStatus: (request) => invoke('env', 'installStatus', [request]),
    createOutputDir: (request) => invoke('env', 'createOutputDir', [request]),
    toolStatus: (request) => invoke('env', 'toolStatus', [request]),
    onInstallProgress: (cb) =>
      subscribe<unknown>(IPC_EVENTS.envInstallProgress, (payload) => {
        try {
          cb(parseEnvInstallState(payload))
        } catch {
          // Drop malformed sidecar data at the isolated-world boundary.
        }
      }),
  },
  provision: {
    pybrainage: (request) => invoke('provision', 'pybrainage', [request]),
    braincharts: (request) => invoke('provision', 'braincharts', [request]),
    synthstrip: (request) => invoke('provision', 'synthstrip', [request]),
    fastsurfer: (request) => invoke('provision', 'fastsurfer', [request]),
    status: (request) => invoke('provision', 'status', [request]),
    cancel: (request) => invoke('provision', 'cancel', [request]),
    onProgress: (cb) =>
      subscribe<unknown>(IPC_EVENTS.provisionProgress, (payload) => {
        try {
          cb(parseProvisionProgress(payload))
        } catch {
          // Drop malformed sidecar data at the isolated-world boundary.
        }
      }),
    onLog: (cb) =>
      subscribe<unknown>(IPC_EVENTS.provisionLog, (payload) => {
        try {
          cb(parseProvisionLog(payload))
        } catch {
          // Drop malformed sidecar data at the isolated-world boundary.
        }
      }),
  },
  managedResource: {
    status: async (request) => {
      parseManagedResourceRequest({
        resource: request.resource,
        variant: request.variant,
      })
      return parseManagedResourceStatusResult(
        await invoke<unknown>('managedResource', 'status', [request]),
      )
    },
    cancel: (request) => {
      parseManagedResourceRequest({
        resource: request.resource,
        variant: request.variant,
      })
      return invoke('managedResource', 'cancel', [request])
    },
    importOffline: (request) => {
      parseManagedResourceRequest({
        resource: request.resource,
        variant: request.variant,
      })
      return invoke('managedResource', 'importOffline', [request])
    },
    onProgress: (cb) =>
      subscribe<unknown>(IPC_EVENTS.managedResourceProgress, (payload) => {
        try {
          cb(parseManagedResourceProgress(payload))
        } catch {
          // Drop malformed sidecar data at the isolated-world boundary.
        }
      }),
  },
  inputFov: {
    list: async (request) =>
      parseInputFovListResult(
        await invoke<unknown>('inputFov', 'list', [request]),
      ),
    review: async (request) => {
      const identity = parseInputFovReviewRequest({
        subjectId: request.subjectId,
        ...('sessionId' in request ? { sessionId: request.sessionId } : {}),
        acquisitionId: request.acquisitionId,
        preflightSignature: request.preflightSignature,
        sourceSha256: request.sourceSha256,
        outputSha256: request.outputSha256,
        expectedRevision: request.expectedRevision,
        decision: request.decision,
      })
      return parseInputFovReviewResult(
        await invoke<unknown>('inputFov', 'review', [
          {
            ...request,
            ...('sessionId' in request
              ? { sessionId: identity.sessionId ?? null }
              : {}),
            acquisitionId: identity.acquisitionId ?? null,
          },
        ]),
      )
    },
  },
  subjects: {
    discover: (request) => invoke('subjects', 'discover', [request]),
    refreshOne: (request) => invoke('subjects', 'refreshOne', [request]),
    openFolder: (request) => invoke('subjects', 'openFolder', [request]),
    openLog: (request) => invoke('subjects', 'openLog', [request]),
    exportCsv: (request) => invoke('subjects', 'exportCsv', [request]),
    markQc: (request) => invoke('subjects', 'markQc', [request]),
  },
  surfaceRegistration: {
    status: (request) => invoke('surfaceRegistration', 'status', [request]),
    check: (request) => invoke('surfaceRegistration', 'check', [request]),
    cancel: (request) => invoke('surfaceRegistration', 'cancel', [request]),
  },
  groupAnalysis: {
    catalog: (request) => invoke('groupAnalysis', 'catalog', [request]),
    inputs: (request) => invoke('groupAnalysis', 'inputs', [request]),
    start: (request) => invoke('groupAnalysis', 'start', [request]),
    status: (request) => invoke('groupAnalysis', 'status', [request]),
    cancel: (request) => invoke('groupAnalysis', 'cancel', [request]),
    list: (request) => invoke('groupAnalysis', 'list', [request]),
    result: (request) => invoke('groupAnalysis', 'result', [request]),
    termRows: (request) => invoke('groupAnalysis', 'termRows', [request]),
    measureDetail: ((request: object) =>
      invoke<GroupAnalysisMeasureDetail | GroupAnalysisMeasureDetailV2>(
        'groupAnalysis',
        'measureDetail',
        [request],
      )) as SupraspinaApi['groupAnalysis']['measureDetail'],
    saveSpec: (request) => invoke('groupAnalysis', 'saveSpec', [request]),
    deleteSpec: (request) => invoke('groupAnalysis', 'deleteSpec', [request]),
    saveSet: (request) => invoke('groupAnalysis', 'saveSet', [request]),
    lockSet: (request) => invoke('groupAnalysis', 'lockSet', [request]),
    deleteSet: (request) => invoke('groupAnalysis', 'deleteSet', [request]),
    chooseSetCsv: (request) =>
      invoke('groupAnalysis', 'chooseSetCsv', [request]),
    chooseExportFolder: (request) =>
      invoke('groupAnalysis', 'chooseExportFolder', [request]),
    writeExport: async (request) =>
      parseGroupAnalysisExportResult(
        await invoke<unknown>('groupAnalysis', 'writeExport', [
          exactExportFigures(request),
        ]),
      ),
    chooseVariablesCsv: async (request) => {
      const table = await invoke<unknown>(
        'groupAnalysis',
        'chooseVariablesCsv',
        [request],
      )
      return table === null ? null : parseAnalysisVariableTable(table)
    },
    removeVariables: async (request) => {
      const removed = await invoke<unknown>(
        'groupAnalysis',
        'removeVariables',
        [request],
      )
      if (typeof removed !== 'boolean') {
        throw new TypeError('Provide a valid variables removal result.')
      }
      return removed
    },
    atlases: (request) => invoke('groupAnalysis', 'atlases', [request]),
    labelStart: (request) => invoke('groupAnalysis', 'labelStart', [request]),
    labelStatus: (request) => invoke('groupAnalysis', 'labelStatus', [request]),
    labelCancel: (request) => invoke('groupAnalysis', 'labelCancel', [request]),
    clearLabels: (request) => invoke('groupAnalysis', 'clearLabels', [request]),
    chooseAtlasFiles: async (request) => {
      const result = await invoke<unknown>(
        'groupAnalysis',
        'chooseAtlasFiles',
        [request],
      )
      return result === null ? null : parseAtlasImportResult(result)
    },
    chooseLabelsFolder: async (request) => {
      const result = await invoke<unknown>(
        'groupAnalysis',
        'chooseLabelsFolder',
        [request],
      )
      return result === null ? null : parseAtlasLabelsImportResult(result)
    },
  },
  atlasSources: {
    list: async () =>
      parseAtlasSourcesList(await invoke<unknown>('atlasSources', 'list', [])),
    download: async (request) =>
      parseAtlasDownloadStartResult(
        await invoke<unknown>('atlasSources', 'download', [request]),
      ),
    status: async () =>
      parseAtlasDownloadStatus(
        await invoke<unknown>('atlasSources', 'status', []),
      ),
    cancel: async (request) =>
      parseAtlasDownloadCancelResult(
        await invoke<unknown>('atlasSources', 'cancel', [request]),
      ),
    openPage: async (request) => {
      // Only a source and one of its two catalog URL kinds cross the bridge.
      const keys = Object.keys(request).sort().join(',')
      if (
        keys !== 'kind,sourceId' ||
        typeof request.sourceId !== 'string' ||
        !ATLAS_SOURCE_URL_KINDS.includes(request.kind)
      ) {
        throw new TypeError('Provide a valid atlas page request.')
      }
      await invoke<unknown>('atlasSources', 'openPage', [
        { sourceId: request.sourceId, kind: request.kind },
      ])
    },
    chooseSubregionsPython: async () => {
      const path = await invoke<unknown>(
        'atlasSources',
        'chooseSubregionsPython',
        [],
      )
      if (path !== null && (typeof path !== 'string' || path.length > 4096)) {
        throw new TypeError('Provide a valid interpreter path.')
      }
      return path
    },
    clearSubregionsPython: async () => {
      await invoke<unknown>('atlasSources', 'clearSubregionsPython', [])
    },
  },
  brainViewer: {
    assets: async (request) =>
      parseBrainAssetsReport(
        await invoke<unknown>('brainViewer', 'assets', [request]),
      ),
    readAsset: async (request) =>
      parseBrainAsset(
        await invoke<unknown>('brainViewer', 'readAsset', [request]),
      ),
  },
  registry: {
    list: (request) => invoke('registry', 'list', [request]),
    upsert: (request) => invoke('registry', 'upsert', [request]),
    chooseImportCsv: (request) =>
      invoke('registry', 'chooseImportCsv', [request]),
    importCsv: (request) => invoke('registry', 'importCsv', [request]),
    saveExampleCsv: (request) =>
      invoke('registry', 'saveExampleCsv', [request]),
    remove: (request) => invoke('registry', 'remove', [request]),
    setSite: (request) => invoke('registry', 'setSite', [request]),
  },
  pipeline: {
    listSteps: () => invoke('pipeline', 'listSteps', []),
    previewCommand: (cfg, key, subjectId) =>
      invoke('pipeline', 'previewCommand', [cfg, key, subjectId]),
    planWorkflow: (request) => invoke('pipeline', 'planWorkflow', [request]),
    runWorkflow: (request) => invoke('pipeline', 'runWorkflow', [request]),
    resumeWorkflow: (request) =>
      invoke('pipeline', 'resumeWorkflow', [request]),
    retryWorkflow: (request) => invoke('pipeline', 'retryWorkflow', [request]),
    cancelRun: (request) => invoke('pipeline', 'cancelRun', [request]),
    onJobUpdate: (cb) =>
      subscribe<unknown>(IPC_EVENTS.jobUpdate, (payload) => {
        try {
          cb(parseRuntimeJob(payload))
        } catch {
          // Drop malformed sidecar data at the isolated-world boundary.
        }
      }),
    onStdout: (cb) =>
      subscribe<unknown>(IPC_EVENTS.stdout, (payload) => {
        try {
          const { jobId, line, lev } = parsePipelineStdout(payload)
          cb(jobId, line, lev)
        } catch {
          // Drop malformed sidecar data at the isolated-world boundary.
        }
      }),
  },
  runtime: {
    bootstrap: (request) => invoke('runtime', 'bootstrap', [request]),
    onEvent: (cb) =>
      subscribe<unknown>(IPC_EVENTS.runtimeEvent, (payload) => {
        try {
          cb(parseRuntimeEvent(payload))
        } catch {
          // Drop malformed sidecar data at the isolated-world boundary.
        }
      }),
  },
  manifest: {
    forRun: (request) => invoke('manifest', 'forRun', [request]),
    list: (request) => invoke('manifest', 'list', [request]),
    previewDebug: (request) => invoke('manifest', 'previewDebug', [request]),
    bundleDebug: (request) => invoke('manifest', 'bundleDebug', [request]),
  },
  results: {
    list: (request) => invoke('results', 'list', [request]),
  },
  lifecycle: {
    onBoundaryRequested: (cb) =>
      subscribe<BoundaryRequest>(IPC_EVENTS.lifecycleBoundary, cb),
    respondBoundary: (request) =>
      invoke('lifecycle', 'respondBoundary', [request]),
  },
  window: {
    minimize: () => invoke('window', 'minimize', []),
    toggleMaximize: () => invoke('window', 'toggleMaximize', []),
    close: () => invoke('window', 'close', []),
    isMaximized: () => invoke('window', 'isMaximized', []),
    onMaximizeChange: (cb) =>
      subscribe<boolean>(IPC_EVENTS.windowMaximize, (payload) =>
        cb(Boolean(payload)),
      ),
  },
  update: {
    check: () => invoke('update', 'check', []),
    download: () => invoke('update', 'download', []),
    installNow: () => invoke('update', 'installNow', []),
    getStatus: () => invoke('update', 'getStatus', []),
    onStatus: (cb) => subscribe<UpdateState>(IPC_EVENTS.updateStatus, cb),
  },
}

contextBridge.exposeInMainWorld('supraspina', api)
