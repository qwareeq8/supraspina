import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SUBREGIONS_PYTHON_MODULES,
  checkSubregionsPython,
  type ProbeRunner,
} from './subregions-python'

let root: string
let python: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'supraspina-subregions-python-'))
  python = join(root, 'python3.12')
  await writeFile(python, '')
  await chmod(python, 0o755)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function reply(version: string, missing: string[] = []): ProbeRunner {
  return vi.fn(async () => `${JSON.stringify({ version, missing })}\n`)
}

describe('checking the subregions interpreter', () => {
  it('accepts Python 3.12 with every module and runs a fixed argv', async () => {
    const run = reply('3.12')
    await expect(checkSubregionsPython(python, run)).resolves.toEqual({
      version: '3.12',
      missing: [],
    })
    const [file, args] = vi.mocked(run).mock.calls[0]!
    expect(file).toBe(python)
    expect(args.slice(0, 2)).toEqual(['-E', '-c'])
    for (const name of SUBREGIONS_PYTHON_MODULES) {
      expect(args[2]).toContain(`"${name}"`)
    }
    // The check finds modules; it never imports samseg or its modules.
    expect(args[2]).not.toMatch(/import (numpy|samseg)/)
  })

  it('names the version or the missing modules to fix', async () => {
    await expect(checkSubregionsPython(python, reply('3.8'))).rejects.toThrow(
      'Choose a Python 3.12 interpreter; the chosen one is Python 3.8.',
    )
    await expect(
      checkSubregionsPython(python, reply('3.12', ['surfa', 'numba'])),
    ).rejects.toThrow(
      'Install surfa, numba in the chosen Python 3.12, or choose another interpreter.',
    )
  })

  it('refuses a file that does not run or answers something else', async () => {
    const fails: ProbeRunner = async () => {
      throw new Error('spawn EACCES')
    }
    await expect(checkSubregionsPython(python, fails)).rejects.toThrow(
      /did not run as Python within 5 seconds/,
    )
    for (const stdout of [
      'Python 3.12.3',
      '{"version": "3.12"}',
      '{"version": "3.12", "missing": ["os"]}',
      '{"version": "three", "missing": []}',
      '[]',
    ]) {
      await expect(
        checkSubregionsPython(python, async () => stdout),
      ).rejects.toThrow(/did not report a Python version/)
    }
  })

  it('refuses relative paths, folders, missing and non-executable files', async () => {
    const run = reply('3.12')
    await expect(checkSubregionsPython('python3', run)).rejects.toThrow(
      /absolute path/,
    )
    await expect(checkSubregionsPython(`${python}\n`, run)).rejects.toThrow(
      /absolute path/,
    )
    await mkdir(join(root, 'folder'))
    await expect(
      checkSubregionsPython(join(root, 'folder'), run),
    ).rejects.toThrow(/not a folder/)
    await expect(
      checkSubregionsPython(join(root, 'missing'), run),
    ).rejects.toThrow(/not a folder/)
    await chmod(python, 0o644)
    await expect(checkSubregionsPython(python, run)).rejects.toThrow(
      /you can run/,
    )
    expect(run).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'runs a real executable with the default runner',
    async () => {
      const fake = join(root, 'fake-python')
      await writeFile(
        fake,
        '#!/bin/sh\necho \'{"version": "3.12", "missing": ["numba"]}\'\n',
      )
      await chmod(fake, 0o755)
      await expect(checkSubregionsPython(fake)).rejects.toThrow(/Install numba/)
      const failing = join(root, 'failing-python')
      await writeFile(failing, '#!/bin/sh\nexit 3\n')
      await chmod(failing, 0o755)
      await expect(checkSubregionsPython(failing)).rejects.toThrow(
        /did not run as Python/,
      )
    },
  )
})
