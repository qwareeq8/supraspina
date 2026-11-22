/**
 * Checks the files and folders an operator picks in the Analysis panel's
 * native dialogs (a variables table, an added atlas's files, a folder of
 * labeling outputs) before main hands their paths to the sidecar, which
 * copies them with its own bounded reads. The renderer never names a path:
 * every path here comes from a dialog main showed.
 *
 * Main refuses what the sidecar would refuse later, with the fix: a
 * relative or malformed path, a folder where a file belongs (or the
 * reverse), a link as the chosen item itself, another file kind than the
 * dialog offered, a file past its size cap, and a duplicate pick.
 */

import { lstat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

/** The largest variables CSV the sidecar copies (`MAX_VARIABLES_BYTES`). */
export const MAX_VARIABLES_CSV_BYTES = 4 * 1024 * 1024
/** The largest file an added atlas may bring (a gcs is tens of MB). */
export const MAX_ATLAS_IMPORT_FILE_BYTES = 256 * 1024 * 1024
/** The longest path main hands to the sidecar. */
const MAX_IMPORT_PATH = 4096

/** The file kinds an added atlas may bring, per import recipe. */
export const ATLAS_IMPORT_EXTENSIONS: Readonly<
  Record<'user-gcs' | 'user-annot' | 'user-volume', readonly string[]>
> = {
  'user-gcs': ['.gcs'],
  'user-annot': ['.annot'],
  'user-volume': ['.mgz', '.nii', '.nii.gz', '.txt'],
}

function assertDialogPath(path: string, what: string): void {
  if (
    !isAbsolute(path) ||
    path.length > MAX_IMPORT_PATH ||
    /[\r\n\0]/.test(path)
  ) {
    throw new Error(`Choose ${what} by its absolute path.`)
  }
}

/**
 * Check one chosen file: absolute, a regular file (not a link itself),
 * one of the offered kinds, and within its size cap.
 *
 * @throws Error naming the fix.
 */
export async function checkChosenFile(
  path: string,
  rule: {
    what: string
    extensions: readonly string[]
    maxBytes: number
  },
): Promise<void> {
  assertDialogPath(path, rule.what)
  const name = basename(path).toLowerCase()
  if (!rule.extensions.some((extension) => name.endsWith(extension))) {
    throw new Error(
      `Choose ${rule.what} ending in ${rule.extensions.join(', ')}.`,
    )
  }
  const info = await lstat(path).catch(() => null)
  if (info === null) throw new Error(`Choose ${rule.what} that exists.`)
  if (info.isSymbolicLink()) {
    throw new Error(`Choose ${rule.what} itself, not a link to it.`)
  }
  if (!info.isFile()) throw new Error(`Choose ${rule.what} as a file.`)
  if (info.size > rule.maxBytes) {
    const mib = Math.round(rule.maxBytes / (1024 * 1024))
    throw new Error(`Choose ${rule.what} of at most ${mib} MiB.`)
  }
}

/**
 * Check the files of one added atlas: each allowed for the recipe, each
 * picked once.
 *
 * @throws Error naming the fix.
 */
export async function checkChosenAtlasFiles(
  paths: readonly string[],
  recipeId: keyof typeof ATLAS_IMPORT_EXTENSIONS,
): Promise<void> {
  if (new Set(paths.map((path) => basename(path))).size !== paths.length) {
    throw new Error('Choose each atlas file once, with distinct names.')
  }
  for (const path of paths) {
    await checkChosenFile(path, {
      what: 'an atlas file',
      extensions: ATLAS_IMPORT_EXTENSIONS[recipeId],
      maxBytes: MAX_ATLAS_IMPORT_FILE_BYTES,
    })
  }
}

/**
 * Check one chosen folder: absolute and a folder (not a link itself).
 *
 * @throws Error naming the fix.
 */
export async function checkChosenFolder(path: string): Promise<void> {
  assertDialogPath(path, 'the folder')
  const info = await lstat(path).catch(() => null)
  if (info === null) throw new Error('Choose a folder that exists.')
  if (info.isSymbolicLink()) {
    throw new Error('Choose the folder itself, not a link to it.')
  }
  if (!info.isDirectory()) throw new Error('Choose a folder, not a file.')
}
