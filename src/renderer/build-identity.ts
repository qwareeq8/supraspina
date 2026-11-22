/** Exposes the source identity that the renderer build embedded. */

import {
  parseBuildIdentity,
  type BuildIdentity,
} from '../shared/build-identity'

// The electron-vite build replaces this identifier with the build record
// (see electron.vite.config.ts); tests leave it undefined.
declare const __SUPRASPINA_BUILD_IDENTITY__: unknown

/** The source identity of this build, or the unknown identity without one. */
export const APP_BUILD_IDENTITY: BuildIdentity = parseBuildIdentity(
  typeof __SUPRASPINA_BUILD_IDENTITY__ === 'undefined'
    ? undefined
    : __SUPRASPINA_BUILD_IDENTITY__,
)
