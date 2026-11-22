/**
 * Reads the FreeSurfer files the brain viewer draws: the fsaverage5 surfaces,
 * sulcal depth, and DK annotations, fsaverage's `brain.mgz` and
 * `aparc+aseg.mgz`, the optional v2 template atlases (Destrieux and Yeo
 * annotations, Brodmann-area labels), FreeSurfer's color table, one
 * subject's volumes, and files of the project's labeling cache.
 *
 * The FreeSurfer home is the saved `tools.freesurferHome`, then
 * `FREESURFER_HOME`. Every template path is confined under
 * `realpath(home)/subjects`, and the color table to `realpath(home)`;
 * subject volumes resolve through `derivatives/freesurfer/<subject>/mri/`
 * and main's artifact confinement. Labeling-cache files are confined under
 * `.supraspina/analysis/atlases/`, may not be symlinks themselves, and must be
 * a file the atlas's recipe lets the viewer read. Only regular files up to
 * `MAX_BRAIN_ASSET_BYTES` are read, and the bytes travel to the renderer as
 * a structured-clone `Uint8Array`, never through the sidecar's JSON-RPC.
 * FreeSurfer data is never bundled.
 */

import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import {
  ADDED_ATLAS_ID,
  ATLAS_CACHE_VIEWER_FILES,
  ATLAS_SOURCES,
  BUILT_IN_ATLASES,
  expandAtlasFile,
  type AtlasRecipeId,
} from '../shared/atlas-labeling'
import {
  FREESURFER_LUT_ASSET_ID,
  FSAVERAGE_ASSET_IDS,
  MAX_BRAIN_ASSETS,
  MAX_BRAIN_ASSET_BYTES,
  SUBJECT_ASSET_IDS,
  TEMPLATE_ATLAS_ASSET_IDS,
  isAtlasCacheAssetId,
  isBrainAssetId,
  isSubjectAssetId,
  type BrainAsset,
  type BrainAssetId,
  type BrainAssetReadRequest,
  type BrainAssetsReport,
  type BrainAssetsRequest,
  type AtlasCacheAssetId,
} from '../shared/brain-atlas'
import type { ProjectConfig } from '../shared/project-schema'

/** A subject folder name the viewer may read; never a template subject. */
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Template subjects that `derivatives/freesurfer/` links, never a subject. */
const TEMPLATE_SUBJECT = /^fsaverage/i
/** The project's labeling cache, relative to the project root. */
const ATLAS_CACHE_DIR = ['.supraspina', 'analysis', 'atlases'] as const
/** The fsaverage5 template labels inside the labeling cache. */
const ATLAS_TEMPLATE_DIR = ['templates', 'fsaverage5'] as const
/** The recipes whose files an added (`user-...`) atlas may have. */
const ADDED_ATLAS_RECIPES: readonly AtlasRecipeId[] = [
  'user-gcs',
  'user-annot',
  'user-volume',
]

/** What reading viewer assets needs from main. */
export interface BrainAssetContext {
  cfg: ProjectConfig
  projectRoot: string
  env: NodeJS.ProcessEnv
  /** The resolved `paths.derivativesDir`, or null when it does not resolve. */
  derivativesDir: string | null
  /**
   * Confine one subject path to the active project's output roots (main's
   * artifact validation): no final symlink, the real path inside a root.
   */
  confineSubjectPath: (path: string) => Promise<{ path: string; info: Stats }>
}

/**
 * Resolve the FreeSurfer home: the saved setting, then the environment.
 *
 * @returns An absolute path, or null when neither is set.
 */
export function resolveFreesurferHome(
  cfg: ProjectConfig,
  env: NodeJS.ProcessEnv,
): string | null {
  const saved = cfg.tools.freesurferHome.trim()
  if (saved && isAbsolute(saved)) return saved
  const fromEnv = env.FREESURFER_HOME?.trim()
  return fromEnv && isAbsolute(fromEnv) ? fromEnv : null
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  )
}

/** The file kind each asset must resolve to, so a link cannot swap formats. */
function expectedSuffix(id: BrainAssetId): string | null {
  if (id.endsWith('.mgz')) return '.mgz'
  if (id.endsWith('.annot')) return '.annot'
  if (id.endsWith('.label')) return '.label'
  if (id.endsWith('.txt')) return '.txt'
  if (id.endsWith('.ctab')) return '.ctab'
  return null
}

function assertSubjectId(subjectId: unknown): asserts subjectId is string {
  if (
    typeof subjectId !== 'string' ||
    !SUBJECT_ID.test(subjectId) ||
    TEMPLATE_SUBJECT.test(subjectId)
  ) {
    throw new Error('Provide a valid subject ID for the brain viewer.')
  }
}

/**
 * Resolve the template subjects folder, `realpath(home)/subjects`.
 *
 * @returns The real folder, or a reason when it is missing.
 */
async function templateRoot(
  context: BrainAssetContext,
): Promise<{ root: string } | { reason: string }> {
  const home = resolveFreesurferHome(context.cfg, context.env)
  if (home === null) return { reason: 'FreeSurfer home is not set.' }
  try {
    const realHome = await realpath(home)
    return { root: await realpath(join(realHome, 'subjects')) }
  } catch {
    return { reason: 'The FreeSurfer home has no readable subjects folder.' }
  }
}

/**
 * Resolve one template asset to a confined real path and its identity.
 *
 * The identity (device and inode) is rechecked on the opened handle, as for
 * subject volumes, so a path swapped after confinement is refused.
 *
 * @throws Error when the real path leaves the subjects folder or changes kind.
 */
async function confineTemplatePath(
  root: string,
  id: BrainAssetId,
): Promise<{ path: string; info: Stats }> {
  let real: string
  try {
    real = await realpath(join(root, id))
  } catch {
    throw new Error('The FreeSurfer home lacks this template file.')
  }
  const suffix = expectedSuffix(id)
  if (!inside(root, real) || (suffix !== null && !real.endsWith(suffix))) {
    throw new Error(
      'Keep the FreeSurfer template files inside the FreeSurfer subjects folder.',
    )
  }
  return { path: real, info: await lstat(real) }
}

/**
 * Resolve one subject volume through main's artifact confinement.
 *
 * @throws Error when the path is unresolved, a symlink, or outside the roots.
 */
async function confineSubjectVolume(
  context: BrainAssetContext,
  id: BrainAssetId,
  subjectId: string,
): Promise<{ path: string; info: Stats }> {
  if (context.derivativesDir === null) {
    throw new Error('Set the derivatives folder before opening subject brains.')
  }
  const candidate = join(
    context.derivativesDir,
    'freesurfer',
    subjectId,
    'mri',
    basename(id),
  )
  const confined = await context.confineSubjectPath(candidate)
  if (!confined.path.endsWith('.mgz')) {
    throw new Error('Open subject volumes only as .mgz files.')
  }
  return confined
}

/**
 * Resolve FreeSurfer's color table, `realpath(home)/FreeSurferColorLUT.txt`.
 *
 * @throws Error when the home is unset, the file is missing, or its real path
 *   leaves the home or is not a `.txt` file.
 */
async function confineColorTable(
  context: BrainAssetContext,
): Promise<{ path: string; info: Stats }> {
  const home = resolveFreesurferHome(context.cfg, context.env)
  if (home === null) throw new Error('FreeSurfer home is not set.')
  let realHome: string
  let real: string
  try {
    realHome = await realpath(home)
    real = await realpath(join(realHome, FREESURFER_LUT_ASSET_ID))
  } catch {
    throw new Error('The FreeSurfer home lacks FreeSurferColorLUT.txt.')
  }
  if (!inside(realHome, real) || !real.endsWith('.txt')) {
    throw new Error(
      'Keep FreeSurferColorLUT.txt inside the FreeSurfer home folder.',
    )
  }
  return { path: real, info: await lstat(real) }
}

/**
 * Give the files the viewer may read from one atlas's labeling cache: the
 * atlas recipe's `ATLAS_CACHE_VIEWER_FILES`, expanded for the atlas. DKT
 * has template labels only (`template-fsaverage5`); an added atlas may
 * come from any of the three import recipes, whose names all carry its ID.
 *
 * @returns The subject and template file names, or null for an atlas without
 *   viewer files.
 */
export function atlasViewerFiles(
  atlasId: string,
): { subject: string[]; template: string[] } | null {
  let recipes: readonly AtlasRecipeId[]
  const builtIn = BUILT_IN_ATLASES.find((item) => item.atlasId === atlasId)
  if (builtIn?.recipeId) {
    recipes = [builtIn.recipeId]
  } else if (atlasId === 'dkt') {
    recipes = ['template-fsaverage5']
  } else if (ADDED_ATLAS_ID.test(atlasId)) {
    recipes = ADDED_ATLAS_RECIPES
  } else {
    const source = ATLAS_SOURCES.find(
      (item) => item.recipeId !== null && item.atlasIds.includes(atlasId),
    )
    if (!source?.recipeId) return null
    recipes = [source.recipeId]
  }
  const expand = (patterns: readonly string[]) => [
    ...new Set(
      patterns.flatMap((pattern) => expandAtlasFile(pattern, atlasId)),
    ),
  ]
  return {
    subject: expand(
      recipes.flatMap((id) => ATLAS_CACHE_VIEWER_FILES[id].subject),
    ),
    template: expand(
      recipes.flatMap((id) => ATLAS_CACHE_VIEWER_FILES[id].template),
    ),
  }
}

/** The parts of a labeling-cache asset ID. */
function cacheAssetParts(id: AtlasCacheAssetId): {
  atlasId: string
  scope: 'subject' | 'templates-fsaverage5'
  file: string
} {
  const [, atlasId, scope, file] = id.split('/')
  return {
    atlasId: atlasId!,
    scope: scope as 'subject' | 'templates-fsaverage5',
    file: file!,
  }
}

/**
 * Resolve the project's labeling cache, `.supraspina/analysis/atlases/`, to a
 * real folder inside the real project root.
 *
 * @throws Error when the cache is missing or resolves outside the project.
 */
async function atlasCacheRoot(context: BrainAssetContext): Promise<string> {
  let project: string
  let cache: string
  try {
    project = await realpath(context.projectRoot)
    cache = await realpath(join(context.projectRoot, ...ATLAS_CACHE_DIR))
  } catch {
    throw new Error('The project has no labeling cache yet.')
  }
  if (!inside(project, cache)) {
    throw new Error('Keep the labeling cache inside the project folder.')
  }
  return cache
}

/**
 * Resolve one labeling-cache asset to a confined real path: the file must
 * be on the atlas recipe's viewer allowlist, its final component may not be
 * a symlink, and its real path must stay inside the cache.
 *
 * Subject files live at `<cache>/<atlasId>/<subject>/<file>`; template
 * labels at `<cache>/templates/fsaverage5/<file>`, whose allowlisted names
 * carry the atlas ID.
 *
 * @throws Error when the file is not allowlisted, missing, a symlink, or
 *   outside the cache.
 */
async function confineCacheAsset(
  context: BrainAssetContext,
  id: AtlasCacheAssetId,
  subjectId: string | null,
): Promise<{ path: string; info: Stats }> {
  const { atlasId, scope, file } = cacheAssetParts(id)
  if ((scope === 'subject') !== (subjectId !== null)) {
    throw new Error('Name the subject for subject labels only.')
  }
  const allowed = atlasViewerFiles(atlasId)
  const names = allowed
    ? scope === 'subject'
      ? allowed.subject
      : allowed.template
    : []
  if (!names.includes(file)) {
    throw new Error("Request a file the atlas's labeling lets the viewer read.")
  }
  const root = await atlasCacheRoot(context)
  const candidate =
    scope === 'subject'
      ? join(root, atlasId, subjectId!, file)
      : join(root, ...ATLAS_TEMPLATE_DIR, file)
  let info: Stats
  try {
    info = await lstat(candidate)
  } catch {
    throw new Error('The labeling cache lacks this file.')
  }
  if (info.isSymbolicLink()) {
    throw new Error('Open labeling-cache files only through real files.')
  }
  // The cache root is real and every segment is validated, so any link
  // below it (a linked atlas or subject folder) changes the real path.
  const real = await realpath(candidate)
  if (real !== candidate || !inside(root, real)) {
    throw new Error('Keep labeling-cache files inside the labeling cache.')
  }
  return { path: real, info }
}

/**
 * Read one confined regular file whole, bounded, into its own buffer.
 *
 * @param expected - The device and inode that confinement validated.
 * @returns The bytes in a buffer they fully span.
 * @throws Error on a non-regular, oversized, swapped, or changing file.
 */
async function readConfinedFile(
  path: string,
  expected: Stats,
): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      throw new Error('Open brain assets only from regular files.')
    }
    if (info.dev !== expected.dev || info.ino !== expected.ino) {
      throw new Error('The brain asset changed while it was being opened.')
    }
    if (info.size > MAX_BRAIN_ASSET_BYTES) {
      throw new Error('The brain asset exceeds the 16 MiB viewer limit.')
    }
    // One spare byte proves the file did not grow past its stat size.
    const data = new Uint8Array(info.size + 1)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        data.length - offset,
        offset,
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat()
    if (
      offset !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs
    ) {
      throw new Error('The brain asset changed while it was being read.')
    }
    // Copy into an exact-length buffer: structured clone sends the whole
    // backing ArrayBuffer, never just a view of it.
    return data.slice(0, offset)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      return info.isFile() && info.size <= MAX_BRAIN_ASSET_BYTES
        ? info.size
        : null
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch {
    return null
  }
}

/** The most labeling-cache entries one listing scans. */
const MAX_CACHE_SCAN_ENTRIES = 1000
/** A template label file of an added atlas, `<hemi>.user-<hex8>.annot`. */
const ADDED_TEMPLATE_FILE = /^(?:lh|rh)\.(user-[a-f0-9]{8})\.annot$/

/** List up to `MAX_CACHE_SCAN_ENTRIES` names in a folder, or none. */
async function folderNames(path: string): Promise<string[]> {
  const names: string[] = []
  try {
    const entries = await readdir(path)
    for (const name of entries.slice(0, MAX_CACHE_SCAN_ENTRIES)) {
      names.push(name)
    }
  } catch {
    // A missing folder lists nothing.
  }
  return names
}

/**
 * Name the labeling-cache assets worth checking: every template label of a
 * known or added atlas and, for a subject, that subject's label maps.
 * Added atlases are found by their folder or template file names.
 */
async function cacheAssetCandidates(
  context: BrainAssetContext,
  subjectId: string | null,
): Promise<AtlasCacheAssetId[]> {
  const root = await atlasCacheRoot(context).catch(() => null)
  if (root === null) return []
  const atlasIds = new Set<string>([
    ...BUILT_IN_ATLASES.filter((item) => item.recipeId !== null).map(
      (item) => item.atlasId,
    ),
    'dkt',
    ...ATLAS_SOURCES.flatMap((source) => source.atlasIds),
  ])
  for (const name of await folderNames(root)) {
    if (ADDED_ATLAS_ID.test(name)) atlasIds.add(name)
  }
  for (const name of await folderNames(join(root, ...ATLAS_TEMPLATE_DIR))) {
    const added = ADDED_TEMPLATE_FILE.exec(name)?.[1]
    if (added) atlasIds.add(added)
  }
  const ids: AtlasCacheAssetId[] = []
  for (const atlasId of [...atlasIds].sort()) {
    const files = atlasViewerFiles(atlasId)
    if (!files) continue
    for (const file of files.template) {
      ids.push(`atlas/${atlasId}/templates-fsaverage5/${file}`)
    }
    if (subjectId === null) continue
    for (const file of files.subject) {
      ids.push(`atlas/${atlasId}/subject/${file}`)
    }
  }
  return ids.filter((id) => isAtlasCacheAssetId(id))
}

/**
 * List the readable assets and their sizes.
 *
 * The template is available only when every fsaverage asset is readable;
 * the v2 template atlases, the color table, subject volumes, and
 * labeling-cache files are listed when present and never affect
 * availability. The list stops at `MAX_BRAIN_ASSETS`.
 */
export async function listBrainAssets(
  context: BrainAssetContext,
  request: BrainAssetsRequest,
): Promise<BrainAssetsReport> {
  if (request.subjectId !== undefined) assertSubjectId(request.subjectId)
  const subjectId = request.subjectId ?? null
  const assets: BrainAssetsReport['assets'] = []
  let unavailableReason: string | null = null
  const template = await templateRoot(context)
  if ('reason' in template) {
    unavailableReason = template.reason
  } else {
    for (const id of FSAVERAGE_ASSET_IDS) {
      const confined = await confineTemplatePath(template.root, id).catch(
        () => null,
      )
      const bytes = confined === null ? null : await sizeOf(confined.path)
      if (bytes === null) continue
      assets.push({ assetId: id, bytes })
    }
    if (assets.length !== FSAVERAGE_ASSET_IDS.length) {
      unavailableReason =
        'The FreeSurfer home lacks readable fsaverage5 or fsaverage template files.'
    }
    // The v2 template atlases and the color table are optional.
    for (const id of TEMPLATE_ATLAS_ASSET_IDS) {
      const confined = await confineTemplatePath(template.root, id).catch(
        () => null,
      )
      const bytes = confined === null ? null : await sizeOf(confined.path)
      if (bytes !== null) assets.push({ assetId: id, bytes })
    }
    const table = await confineColorTable(context).catch(() => null)
    const tableBytes = table === null ? null : await sizeOf(table.path)
    if (tableBytes !== null) {
      assets.push({ assetId: FREESURFER_LUT_ASSET_ID, bytes: tableBytes })
    }
  }
  if (subjectId !== null) {
    for (const id of SUBJECT_ASSET_IDS) {
      const confined = await confineSubjectVolume(context, id, subjectId).catch(
        () => null,
      )
      if (
        confined === null ||
        !confined.info.isFile() ||
        confined.info.size > MAX_BRAIN_ASSET_BYTES
      ) {
        continue
      }
      assets.push({ assetId: id, bytes: confined.info.size })
    }
  }
  for (const id of await cacheAssetCandidates(context, subjectId)) {
    if (assets.length >= MAX_BRAIN_ASSETS) break
    const confined = await confineCacheAsset(
      context,
      id,
      isSubjectAssetId(id) ? subjectId : null,
    ).catch(() => null)
    if (
      confined !== null &&
      confined.info.isFile() &&
      confined.info.size <= MAX_BRAIN_ASSET_BYTES
    ) {
      assets.push({ assetId: id, bytes: confined.info.size })
    }
  }
  return {
    available: unavailableReason === null,
    unavailableReason,
    subjectId,
    assets,
  }
}

/**
 * Read one allowlisted asset with its SHA-256.
 *
 * @param request - The asset and, for a subject asset, the subject.
 * @throws Error when the asset is not allowlisted, escapes its root, is not a
 *   regular file, or exceeds `MAX_BRAIN_ASSET_BYTES`.
 */
export async function readBrainAsset(
  context: BrainAssetContext,
  request: BrainAssetReadRequest,
): Promise<BrainAsset> {
  const { assetId } = request
  if (!isBrainAssetId(assetId)) {
    throw new Error('Request an allowlisted brain asset.')
  }
  let confined: { path: string; info: Stats }
  if (isAtlasCacheAssetId(assetId)) {
    let subjectId: string | null = null
    if (isSubjectAssetId(assetId)) {
      assertSubjectId(request.subjectId)
      subjectId = request.subjectId
    } else if (request.subjectId !== undefined) {
      throw new Error('Name the subject for subject labels only.')
    }
    confined = await confineCacheAsset(context, assetId, subjectId)
  } else if (assetId === FREESURFER_LUT_ASSET_ID) {
    if (request.subjectId !== undefined) {
      throw new Error('Name the subject for subject volumes only.')
    }
    confined = await confineColorTable(context)
  } else if (isSubjectAssetId(assetId)) {
    assertSubjectId(request.subjectId)
    confined = await confineSubjectVolume(context, assetId, request.subjectId)
  } else {
    if (request.subjectId !== undefined) {
      throw new Error('Name the subject for subject volumes only.')
    }
    const template = await templateRoot(context)
    if ('reason' in template) throw new Error(template.reason)
    confined = await confineTemplatePath(template.root, assetId)
  }
  const data = await readConfinedFile(confined.path, confined.info)
  return {
    assetId,
    sha256: createHash('sha256').update(data).digest('hex'),
    data,
  }
}
