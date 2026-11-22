/**
 * Defines IPC channel and event-topic constants shared by preload and main.
 *
 * Keep this module dependency-free so the preload bundle stays small.
 */

/** The names of the shared invocation and event transport channels. */
export const IPC_CHANNELS = {
  invoke: 'supraspina:invoke',
  event: 'supraspina:event',
} as const

/** The name of every event topic emitted across the shared IPC bridge. */
export const IPC_EVENTS = {
  jobUpdate: 'pipeline.jobUpdate',
  stdout: 'pipeline.stdout',
  runtimeEvent: 'runtime.event',
  provisionProgress: 'provision.progress',
  provisionLog: 'provision.log',
  managedResourceProgress: 'managedResource.progress',
  envInstallProgress: 'envInstall.progress',
  hostState: 'host.state',
  lifecycleBoundary: 'lifecycle.boundaryRequested',
  windowMaximize: 'window.maximize',
  preferencesChanged: 'preferences.changed',
  windowPlacementChanged: 'window.placementChanged',
  updateStatus: 'update.status',
} as const
