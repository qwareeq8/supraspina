/**
 * Shares recent-project helpers between Setup and Project. This renderer-local
 * list is convenience state; each IPC-loaded `supraspina.project.json` remains the
 * durable source of truth.
 */

import type { ProjectConfig } from '../../shared/project-schema'

/** The local-storage key for the renderer-local recent-project list. */
const RECENT_PROJECTS_STORAGE_KEY = 'supraspinaRecentProjects'

/** The maximum number of retained and visible recent projects. */
const MAX_RECENT_PROJECTS = 5

/**
 * The Electron open-dialog filter used to select `supraspina.project.json`.
 */
export const PROJECT_FILE_FILTER = [
  { name: 'Supraspina project', extensions: ['json'] },
]

/** One entry shown by local recent-project surfaces. */
export interface RecentProject {
  name: string
  path: string
  openedAt: string
}

/** Track whether a decoded value has the recent-project shape. */
function isRecentProject(value: unknown): value is RecentProject {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<RecentProject>
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.openedAt === 'string' &&
    candidate.path.trim().length > 0
  )
}

/** Load recent projects from local storage, tolerating missing or bad data. */
export function loadRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecentProject).slice(0, MAX_RECENT_PROJECTS)
  } catch {
    return []
  }
}

/** Persist recent projects, ignoring unavailable storage. */
function saveRecentProjects(projects: RecentProject[]): void {
  try {
    localStorage.setItem(
      RECENT_PROJECTS_STORAGE_KEY,
      JSON.stringify(projects.slice(0, MAX_RECENT_PROJECTS)),
    )
  } catch {
    // Treat recent projects as convenience state only.
  }
}

/**
 * Add or refresh one project in the recent-project list.
 *
 * @param cfg - The configuration that supplies the project name and preferred
 *   root.
 * @param path - The path when the configuration omits a project root.
 */
export function rememberRecentProject(
  projects: RecentProject[],
  cfg: ProjectConfig,
  path: string,
): RecentProject[] {
  const resolvedPath = cfg.paths.projectRoot.trim() || path.trim()
  if (!resolvedPath) return projects
  const entry: RecentProject = {
    name: cfg.project.name.trim() || 'Untitled project',
    path: resolvedPath,
    openedAt: new Date().toISOString(),
  }
  const next = [
    entry,
    ...projects.filter((project) => project.path !== resolvedPath),
  ].slice(0, MAX_RECENT_PROJECTS)
  saveRecentProjects(next)
  return next
}
