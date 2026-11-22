/** Declares the bundled-package helpers that the electron-vite config imports. */

import type { Plugin } from 'vite'

/** One npm package with code in the renderer bundle. */
export interface BundledPackage {
  name: string
  version: string
  /** The package directory relative to the repository, as package-lock names it. */
  lockPath: string
}

/** The file the plugin writes next to the renderer entry. */
export const BUNDLED_PACKAGES_FILE: string

/** The schema of that file. */
export const BUNDLED_PACKAGES_SCHEMA: string

/** Give the package directory a bundled module lives in. */
export function packageDirectoryOf(moduleId: string): string | null

/** List the packages that contribute rendered code to a bundle. */
export function bundledPackages(
  chunks: Iterable<{ modules?: Record<string, { renderedLength: number }> }>,
  options?: {
    repository?: string
    readPackage?: (directory: string) => { name: string; version: string }
  },
): BundledPackage[]

/** Build the Vite plugin that writes `bundled-packages.json`. */
export function bundledPackagesPlugin(options?: { repository?: string }): Plugin

/** Validate a `bundled-packages.json` record. */
export function parseBundledPackages(value: unknown): BundledPackage[]
