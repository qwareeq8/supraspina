/**
 * Tests for the renderer-local recent-project list. Cover the tolerance
 * branches that keep unusable storage from blocking Setup and Project.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { ProjectConfig } from '../../shared/project-schema'
import {
  loadRecentProjects,
  rememberRecentProject,
  type RecentProject,
} from './recent-projects'

const STORAGE_KEY = 'supraspinaRecentProjects'

/** Build a project configuration with the given name and root. */
function config(name: string, projectRoot: string): ProjectConfig {
  return {
    ...DEFAULT_PROJECT_CONFIG,
    project: { ...DEFAULT_PROJECT_CONFIG.project, name },
    paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot },
  }
}

/** Build one stored recent-project entry. */
function entry(name: string, path: string): RecentProject {
  return { name, path, openedAt: '2026-01-01T00:00:00.000Z' }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadRecentProjects', () => {
  it('returns an empty list when nothing has been stored', () => {
    expect(loadRecentProjects()).toEqual([])
  })

  it('returns an empty list when the stored value is not valid JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadRecentProjects()).toEqual([])
  })

  it('returns an empty list when the stored value is not an array', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ path: '/data/one' }))
    expect(loadRecentProjects()).toEqual([])
  })

  it('returns an empty list when storage itself is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage is unavailable.')
    })
    expect(loadRecentProjects()).toEqual([])
  })

  it('drops entries that are not usable recent projects', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        entry('Kept study', '/data/kept'),
        null,
        'not an object',
        { name: 'No path', openedAt: '2026-01-01T00:00:00.000Z' },
        { ...entry('Blank path', '   '), path: '   ' },
        { ...entry('Bad stamp', '/data/bad'), openedAt: 7 },
      ]),
    )
    expect(loadRecentProjects()).toEqual([entry('Kept study', '/data/kept')])
  })

  it('retains at most five recent projects', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        Array.from({ length: 8 }, (_, index) =>
          entry(`Study ${index}`, `/data/study-${index}`),
        ),
      ),
    )
    expect(loadRecentProjects()).toHaveLength(5)
  })
})

describe('rememberRecentProject', () => {
  it('leaves the list unchanged when neither the config nor the path names a root', () => {
    const projects = [entry('Kept study', '/data/kept')]
    expect(
      rememberRecentProject(projects, config('Nameless', '  '), '  '),
    ).toBe(projects)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('falls back to the supplied path and names an unnamed project', () => {
    const next = rememberRecentProject(
      [],
      config('   ', '   '),
      '/data/from-path',
    )
    expect(next).toHaveLength(1)
    expect(next[0]?.name).toBe('Untitled project')
    expect(next[0]?.path).toBe('/data/from-path')
    expect(loadRecentProjects()).toEqual(next)
  })

  it('moves a re-opened project to the front without duplicating it', () => {
    const first = rememberRecentProject([], config('One', '/data/one'), '')
    const second = rememberRecentProject(first, config('Two', '/data/two'), '')
    const again = rememberRecentProject(
      second,
      config('One again', '/data/one'),
      '',
    )
    expect(again.map((project) => project.path)).toEqual([
      '/data/one',
      '/data/two',
    ])
    expect(again[0]?.name).toBe('One again')
  })

  it('still returns the updated list when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage is full.')
    })
    const next = rememberRecentProject([], config('One', '/data/one'), '')
    expect(next.map((project) => project.path)).toEqual(['/data/one'])
  })
})
