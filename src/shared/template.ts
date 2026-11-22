/**
 * Resolves `${...}` placeholders in {@link ProjectConfig} path fields, such as
 * `${projectRoot}/rawdata`, against other configuration values. Both the
 * renderer's Results browser and the Setup wizard's create-time guard use this
 * shared logic. Keep it aligned with the Python sidecar's `schema` validator
 * and `paths.interpolate`: string leaves only, a trimmed reference matched by
 * exact key, a bare last-segment alias resolved at flatten time, and the same
 * pass limit. `fixtures/template-resolution/cases.json` locks all three
 * implementations to one resolution table.
 */

import type { ProjectConfig } from './project-schema'

/** The number of passes after which substitution stops when a placeholder cycle remains. */
const MAX_PASSES = 6

/**
 * Map every string leaf to its dotted key and first available bare key.
 *
 * @returns String leaves indexed by dotted and available bare keys.
 */
export function flattenConfig(cfg: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      out[prefix] = node
      const leaf = prefix.split('.').pop()
      if (leaf && !(leaf in out)) out[leaf] = node
      return
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, prefix ? `${prefix}.${k}` : k)
      }
    }
  }
  walk(cfg, '')
  return out
}

/**
 * Resolve nested placeholders against a flattened configuration. Leave unknown
 * tokens intact for operator review.
 */
export function resolveTemplate(
  template: string,
  flat: Record<string, string>,
): string {
  let value = template
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (!value.includes('${')) break
    const next = value.replace(/\$\{([^}]+)\}/g, (whole, token: string) => {
      const key = token.trim()
      // Match the Python sidecar's dict membership test, which never reaches
      // Object.prototype members such as ${toString}.
      const hit = Object.hasOwn(flat, key) ? flat[key] : undefined
      return hit !== undefined ? hit : whole
    })
    if (next === value) break
    value = next
  }
  return value
}

/**
 * Return whether a string still contains an unresolved `${...}` placeholder.
 */
export function hasPlaceholder(value: string): boolean {
  return value.includes('${')
}

/**
 * Return whether a project-root path is absolute for the declared path style.
 *
 * Make the final host-correct decision in the main process with
 * `path.isAbsolute`. Use this renderer-safe check in the Setup wizard, which
 * cannot import `node:path`, to refuse relative and `~`-prefixed roots before
 * they reach `project.create`. Keep it aligned with the Python sidecar's
 * `_is_absolute_project_path`: a `posix` configuration accepts only POSIX roots
 * (`/...`), while a `windows` configuration also accepts drive roots (`C:\...`
 * or `C:/...`) and UNC roots (`\\server`). Reject empty, relative, and
 * `~`-prefixed values because the shell does not expand `~`.
 *
 * @returns True for an absolute path under that path style.
 */
export function isAbsoluteProjectRoot(
  root: string,
  pathStyle: ProjectConfig['platform']['pathStyle'],
): boolean {
  const value = root.trim()
  if (value === '') return false
  if (value.startsWith('/')) return true
  if (pathStyle !== 'windows') return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  return false
}

/**
 * A `paths.*` field whose value still carries an unresolved `${...}`
 * token after resolution against the full configuration.
 */
export interface UnresolvedPath {
  readonly field: string
  readonly value: string
}

/**
 * Return the `paths.*` entries that still contain an unresolved `${...}` token
 * after resolution against the configuration. Return an empty array when every
 * project path resolves to a concrete value. Name exactly which fields a
 * create-time guard must block when returning a nonempty array.
 */
export function unresolvedPaths(cfg: ProjectConfig): UnresolvedPath[] {
  const flat = flattenConfig(cfg)
  const out: UnresolvedPath[] = []
  for (const [field, raw] of Object.entries(cfg.paths)) {
    if (typeof raw !== 'string') continue
    const value = resolveTemplate(raw, flat)
    if (hasPlaceholder(value)) out.push({ field, value })
  }
  return out
}
