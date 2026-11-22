/**
 * Checks the interpreter an operator chooses for FreeSurfer's subregion
 * segmentation before main stores it as the machine preference
 * `subregionsPython`.
 *
 * FreeSurfer 8.2.0's own fspython 3.8 cannot load samseg's CPython 3.12
 * bindings, so the labeling runs samseg under a separate Python 3.12 (with
 * samseg itself on a PYTHONPATH link to FreeSurfer's package). The check
 * runs the chosen file once with a fixed argv, no shell, `-E` (ignore
 * PYTHON* variables), and a 5 s limit; it asks for the version and whether
 * samseg's third-party modules can be found, without importing them. It is
 * never part of the environment check; the labeling manager probes its tools
 * again on its own.
 */

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/** The Python version samseg's bindings need. */
export const SUBREGIONS_PYTHON_VERSION = '3.12'
/** The third-party modules samseg's subregion segmentation imports. */
export const SUBREGIONS_PYTHON_MODULES = [
  'numpy',
  'scipy',
  'nibabel',
  'surfa',
  'numba',
] as const
/** How long the check may run before the interpreter is killed. */
export const SUBREGIONS_PROBE_TIMEOUT_MS = 5_000
/** The most output the check reads. */
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024
/** The longest interpreter path main stores. */
const MAX_INTERPRETER_PATH = 4096

const PROBE_SCRIPT = [
  'import importlib.util, json, sys',
  `mods = ${JSON.stringify(SUBREGIONS_PYTHON_MODULES)}`,
  'print(json.dumps({"version": "%d.%d" % sys.version_info[:2], "missing": [m for m in mods if importlib.util.find_spec(m) is None]}))',
].join('\n')

/** What the check learned about an interpreter. */
export interface SubregionsPythonProbe {
  version: string
  missing: string[]
}

/** Run a file with arguments; resolves with its standard output. */
export type ProbeRunner = (
  file: string,
  args: readonly string[],
) => Promise<string>

/** Run the interpreter with no shell, a timeout, and bounded output. */
const runProbe: ProbeRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: SUBREGIONS_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })

function parseProbe(stdout: string): SubregionsPythonProbe | null {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const known: readonly string[] = SUBREGIONS_PYTHON_MODULES
  if (
    Object.keys(record).sort().join(',') !== 'missing,version' ||
    typeof record.version !== 'string' ||
    !/^\d{1,2}\.\d{1,3}$/.test(record.version) ||
    !Array.isArray(record.missing) ||
    !record.missing.every(
      (name) => typeof name === 'string' && known.includes(name),
    )
  ) {
    return null
  }
  return { version: record.version, missing: record.missing as string[] }
}

/**
 * Check that a chosen file is a runnable Python 3.12 that can find samseg's
 * third-party modules.
 *
 * @param run - A replacement runner, for tests.
 * @throws Error with the fix when the file is not such an interpreter.
 */
export async function checkSubregionsPython(
  path: string,
  run: ProbeRunner = runProbe,
): Promise<SubregionsPythonProbe> {
  if (
    !isAbsolute(path) ||
    path.length > MAX_INTERPRETER_PATH ||
    /[\r\n\0]/.test(path)
  ) {
    throw new Error('Choose the interpreter by its absolute path.')
  }
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    throw new Error('Choose the interpreter file, not a folder.')
  }
  if (
    !(await access(path, constants.X_OK).then(
      () => true,
      () => false,
    ))
  ) {
    throw new Error('Choose an interpreter file you can run.')
  }
  let stdout: string
  try {
    stdout = await run(path, ['-E', '-c', PROBE_SCRIPT])
  } catch {
    throw new Error(
      'Choose a Python 3.12 interpreter; the chosen file did not run as Python within 5 seconds.',
    )
  }
  const probe = parseProbe(stdout)
  if (probe === null) {
    throw new Error(
      'Choose a Python 3.12 interpreter; the chosen file did not report a Python version.',
    )
  }
  if (probe.version !== SUBREGIONS_PYTHON_VERSION) {
    throw new Error(
      `Choose a Python 3.12 interpreter; the chosen one is Python ${probe.version}.`,
    )
  }
  if (probe.missing.length > 0) {
    throw new Error(
      `Install ${probe.missing.join(', ')} in the chosen Python 3.12, or choose another interpreter.`,
    )
  }
  return probe
}
