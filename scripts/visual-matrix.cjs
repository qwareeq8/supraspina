#!/usr/bin/env node
/** Runs the bounded pairwise Supraspina visual and accessibility gate.
 *
 * Use `--source` to transform the renderer through an ephemeral loopback Vite
 * server without writing build output. Otherwise, require a current renderer
 * build under out/renderer.
 */

'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { extractRendererReferences } = require('./visual-matrix-references.cjs')

const root = path.resolve(__dirname, '..')
const output =
  process.env.SUPRASPINA_VISUAL_OUTDIR || path.join(root, 'visual-evidence')
const shot = path.join(__dirname, 'shot.cjs')
const rendererRoot = path.join(root, 'out', 'renderer')
const shotTimeoutMs = 90_000
const terminationGraceMs = 5_000
const terminationPollMs = 50
const forcedTerminationWaitMs = 1_000
const packageInputNames = new Set([
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])
const relevantSourceExtension =
  /\.(?:[cm]?[jt]sx?|css|html|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm)$/i
const sourceMode = process.argv.includes('--source')
const cases = [
  [
    'Setup',
    'empty-system-100',
    '--no-project',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Dashboard',
    'populated-dark-cozy-115',
    '--dark',
    '--density',
    'Cozy',
    '--text-scale',
    '115',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Setup',
    'first-run-light-135',
    '--firstrun',
    '--light',
    '--text-scale',
    '135',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Subjects',
    'populated-light-compact',
    '--light',
    '--density',
    'Compact',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Runs',
    'populated-hc-comfortable-135',
    '--dark',
    '--hc',
    '--density',
    'Comfortable',
    '--text-scale',
    '135',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Logs',
    'populated-system-cozy-115',
    '--system',
    '--density',
    'Cozy',
    '--text-scale',
    '115',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'QC Review',
    'populated-dark-compact',
    '--dark',
    '--density',
    'Compact',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Input QC',
    'unreviewed-light-cozy-115',
    '--light',
    '--density',
    'Cozy',
    '--text-scale',
    '115',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Results',
    'empty-light-comfortable-115',
    '--light',
    '--density',
    'Comfortable',
    '--text-scale',
    '115',
    '--state',
    'empty',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Results',
    'populated-dark-compact-100',
    '--dark',
    '--density',
    'Compact',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Analysis',
    'forest-light-cozy-135',
    '--light',
    '--density',
    'Cozy',
    '--text-scale',
    '135',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1214',
    '--h',
    '768',
  ],
  [
    'Analysis',
    'forest-dark-compact-100',
    '--dark',
    '--density',
    'Compact',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Registry',
    'populated-dark-compact-135',
    '--dark',
    '--density',
    'Compact',
    '--text-scale',
    '135',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Diagnostics',
    'loading-system-compact-reduced-115',
    '--system',
    '--density',
    'Compact',
    '--reduced-motion',
    '--text-scale',
    '115',
    '--state',
    'loading',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Diagnostics',
    'error-light-cozy-100',
    '--light',
    '--density',
    'Cozy',
    '--state',
    'error',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Diagnostics',
    'ready-dark-comfortable-135',
    '--dark',
    '--density',
    'Comfortable',
    '--text-scale',
    '135',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Settings',
    'populated-dark-comfortable-135',
    '--dark',
    '--density',
    'Comfortable',
    '--text-scale',
    '135',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Settings',
    'about-light-compact-100',
    '--light',
    '--density',
    'Compact',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Pipeline',
    'validation-light-comfortable',
    '--light',
    '--density',
    'Comfortable',
    '--state',
    'validation',
    '--fit',
    '--w',
    '1440',
    '--h',
    '900',
  ],
  [
    'Pipeline',
    'blocked-light-hc-compact-reduced',
    '--light',
    '--hc',
    '--density',
    'Compact',
    '--reduced-motion',
    '--state',
    'blocked',
    '--fit',
    '--w',
    '1440',
    '--h',
    '900',
  ],
  [
    'Pipeline',
    'ready-system-cozy-115',
    '--system',
    '--density',
    'Cozy',
    '--text-scale',
    '115',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1440',
    '--h',
    '900',
  ],
  [
    'Subjects',
    'long-dark-comfortable-135',
    '--dark',
    '--density',
    'Comfortable',
    '--text-scale',
    '135',
    '--state',
    'long',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Dashboard',
    'open-menu-light-compact',
    '--light',
    '--density',
    'Compact',
    '--menu',
    'open',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Dashboard',
    'more-menu-system-compact',
    '--system',
    '--density',
    'Compact',
    '--menu',
    'more',
    '--state',
    'populated',
    '--text-scale',
    '135',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'QC Review',
    'montage-light-comfortable-135',
    '--light',
    '--density',
    'Comfortable',
    '--text-scale',
    '135',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1440',
    '--h',
    '900',
  ],
  [
    'QC Review',
    'montage-hc-cozy-115',
    '--dark',
    '--hc',
    '--density',
    'Cozy',
    '--text-scale',
    '115',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1440',
    '--h',
    '900',
  ],
  [
    'Runs',
    'run-dialog-dark-cozy',
    '--dark',
    '--density',
    'Cozy',
    '--dialog',
    'run',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'Logs',
    'jobs-rail-light-comfortable-135',
    '--light',
    '--density',
    'Comfortable',
    '--text-scale',
    '135',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
  [
    'QC Review',
    'minimum-light-comfortable-135',
    '--light',
    '--density',
    'Comfortable',
    '--text-scale',
    '135',
    '--state',
    'populated',
    '--fit',
    '--w',
    '1100',
    '--h',
    '700',
  ],
]

let activeRun = null
let interruptedSignal = null
let sourceRendererUrl = null

async function startSourceRendererServer() {
  const [{ createServer }, { default: react }] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-react'),
  ])
  const server = await createServer({
    clearScreen: false,
    configFile: false,
    logLevel: 'error',
    plugins: [react()],
    root: path.join(root, 'src', 'renderer'),
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
    },
  })
  await server.listen()
  const url = server.resolvedUrls?.local?.[0]
  if (!url) {
    await server.close()
    throw new Error('Resolve the loopback source-renderer URL.')
  }
  return { server, url }
}

function sourceTreeInputs(directory) {
  const inputs = [directory]
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!/(?:^|[\\/])(?:tests?|__tests__)$/.test(entryPath)) {
        inputs.push(...sourceTreeInputs(entryPath))
      }
    } else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      isRelevantSourceFile(entryPath)
    ) {
      inputs.push(entryPath)
    }
  }
  return inputs
}

function pathTimestamp(filePath) {
  return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs }
}

function relativePath(filePath) {
  return path.relative(root, filePath) || '.'
}

function isRelevantSourceFile(filePath) {
  const relative = path
    .relative(root, filePath)
    .split(path.sep)
    .join(path.posix.sep)
  return (
    relevantSourceExtension.test(filePath) &&
    !/(?:^|\/)(?:tests?|__tests__)\//.test(relative) &&
    !/\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(filePath)
  )
}

function resolveRendererReference(parentPath, reference) {
  if (
    !reference ||
    reference.startsWith('#') ||
    reference.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(reference)
  ) {
    return null
  }

  const withoutQuery = reference.split(/[?#]/, 1)[0]
  if (!withoutQuery) return null
  const decoded = decodeURIComponent(withoutQuery)
  const resolved = reference.startsWith('/')
    ? path.join(rendererRoot, decoded.slice(1))
    : path.resolve(path.dirname(parentPath), decoded)
  const relative = path.relative(rendererRoot, resolved)
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null
  }
  return resolved
}

function rendererOutputFiles(rendererIndex) {
  const pending = [rendererIndex]
  const outputs = new Set()
  while (pending.length > 0) {
    const outputPath = pending.pop()
    if (outputs.has(outputPath)) continue
    fs.statSync(outputPath)
    outputs.add(outputPath)
    for (const reference of extractRendererReferences(outputPath)) {
      const referencedPath = resolveRendererReference(outputPath, reference)
      if (referencedPath && !outputs.has(referencedPath)) {
        pending.push(referencedPath)
      }
    }
  }
  return [...outputs]
}

function failForRendererBuild(detail) {
  throw new Error(
    `Resolve the visual matrix failure: ${detail}.\nRun \`npm run build\` before running the visual matrix.`,
  )
}

function assertRendererBuildIsCurrent() {
  const rendererIndex = path.join(rendererRoot, 'index.html')
  const rendererAssets = path.join(rendererRoot, 'assets')
  let newestInput
  let oldestOutput

  try {
    const sourceEntries = [
      ...sourceTreeInputs(path.join(root, 'src', 'renderer')),
      ...sourceTreeInputs(path.join(root, 'src', 'shared')),
      ...fs
        .readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            (packageInputNames.has(entry.name) ||
              /^(?:electron\.)?vite\.config\.[cm]?[jt]s$/.test(entry.name)),
        )
        .map((entry) => path.join(root, entry.name)),
    ]
    fs.statSync(rendererAssets)
    const outputEntries = rendererOutputFiles(rendererIndex)

    if (outputEntries.length === 1) {
      failForRendererBuild(
        'Reference at least one renderer asset from the renderer index.',
      )
    }

    newestInput = sourceEntries
      .map(pathTimestamp)
      .reduce((newest, entry) =>
        entry.mtimeMs > newest.mtimeMs ? entry : newest,
      )
    oldestOutput = outputEntries
      .map(pathTimestamp)
      .reduce((oldest, entry) =>
        entry.mtimeMs < oldest.mtimeMs ? entry : oldest,
      )
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const missingPath =
        typeof error.path === 'string'
          ? relativePath(error.path)
          : 'a required path'
      failForRendererBuild(
        `Restore ${missingPath} before verifying the renderer build.`,
      )
    }
    throw error
  }

  if (oldestOutput.mtimeMs < newestInput.mtimeMs) {
    failForRendererBuild(
      `Rebuild the renderer because ${relativePath(oldestOutput.filePath)} ` +
        `predates ${relativePath(newestInput.filePath)}.`,
    )
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error && error.code === 'ESRCH') return false
    throw error
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error && error.code === 'ESRCH') return false
    throw error
  }
}

async function terminatePosixProcessGroup(pid) {
  if (!signalProcessGroup(pid, 'SIGTERM')) return

  const deadline = Date.now() + terminationGraceMs
  while (isProcessGroupAlive(pid) && Date.now() < deadline) {
    await delay(terminationPollMs)
  }
  if (isProcessGroupAlive(pid)) signalProcessGroup(pid, 'SIGKILL')
}

function runTaskkill(pid, force) {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T']
    if (force) args.push('/F')

    let settled = false
    let taskkill
    try {
      taskkill = spawn('taskkill.exe', args, {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      resolve(false)
      return
    }

    const finish = (didTerminate) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(didTerminate)
    }
    const timeout = setTimeout(() => {
      try {
        taskkill.kill('SIGKILL')
      } catch {
        // Ignore a taskkill process that exits between the timer and kill attempt.
      }
      finish(false)
    }, terminationGraceMs)
    taskkill.once('error', () => finish(false))
    taskkill.once('close', (status) => finish(status === 0))
  })
}

async function terminateWindowsProcessTree(pid) {
  if (await runTaskkill(pid, false)) return
  if (await runTaskkill(pid, true)) return
  throw new Error(`Terminate the process tree with taskkill.exe: ${pid}.`)
}

async function terminateProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(pid)
  } else {
    await terminatePosixProcessGroup(pid)
  }
}

function forceTerminateActiveProcessTree() {
  const pid = activeRun?.child.pid
  if (!Number.isInteger(pid) || pid <= 0) return

  if (process.platform !== 'win32') {
    try {
      signalProcessGroup(pid, 'SIGKILL')
    } catch {
      // Allow the process to exit because no further synchronous cleanup exists.
    }
    return
  }

  try {
    const taskkill = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    taskkill.unref()
  } catch {
    // Allow the process to exit because no further synchronous cleanup exists.
  }
}

function runShot(screen, name, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [shot, screen, name, ...args], {
        cwd: root,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          SUPRASPINA_SHOT_OUTDIR: output,
          ...(sourceRendererUrl
            ? { SUPRASPINA_RENDERER_URL: sourceRendererUrl }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({
        status: null,
        stdout: '',
        stderr: `Start ${name} for the visual matrix: ${error.message}.\n`,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let spawnError = null
    let timedOut = false
    let settled = false
    let forcedSettlement = null
    let timeout = null

    const appendDiagnostics = () => {
      if (spawnError) {
        stderr += `Run ${name} for the visual matrix: ${spawnError.message}.\n`
      }
      if (timedOut) {
        stderr += `Complete visual matrix target ${name} within ${shotTimeoutMs / 1000} seconds.\n`
      }
      if (run.terminationError) {
        stderr +=
          `Terminate visual matrix target ${name}: ` +
          `${run.terminationError.message}\n`
      }
    }
    const finish = async (status, didClose) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(forcedSettlement)
      if (run.termination) await run.termination
      if (didClose && !run.terminationError && activeRun === run) {
        activeRun = null
      }
      if (!didClose) {
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
      }
      appendDiagnostics()
      resolve({ status: timedOut ? null : status, stdout, stderr })
    }
    const scheduleForcedSettlement = () => {
      if (settled || forcedSettlement) return
      forcedSettlement = setTimeout(() => {
        void finish(null, false)
      }, forcedTerminationWaitMs)
    }
    const run = {
      child,
      termination: null,
      terminationError: null,
      terminate() {
        if (!this.termination) {
          this.termination = terminateProcessTree(child.pid)
            .catch((error) => {
              this.terminationError = error
            })
            .finally(scheduleForcedSettlement)
        }
        return this.termination
      },
    }
    activeRun = run

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      spawnError = error
    })

    timeout = setTimeout(() => {
      timedOut = true
      void run.terminate()
    }, shotTimeoutMs)

    child.once('close', (status) => {
      if (settled) {
        if (!run.terminationError && activeRun === run) activeRun = null
        return
      }
      void finish(status, true)
    })
  })
}

const signalExitCodes =
  process.platform === 'win32'
    ? { SIGBREAK: 149, SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }
    : { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 }

for (const [signal, exitCode] of Object.entries(signalExitCodes)) {
  process.on(signal, () => {
    if (interruptedSignal) {
      forceTerminateActiveProcessTree()
      process.exit(exitCode)
    }
    interruptedSignal = signal
    process.exitCode = exitCode
    if (activeRun) void activeRun.terminate()
  })
}
process.once('exit', forceTerminateActiveProcessTree)

async function main() {
  let sourceServer = null
  try {
    if (sourceMode) {
      const started = await startSourceRendererServer()
      sourceServer = started.server
      sourceRendererUrl = started.url
    } else {
      assertRendererBuildIsCurrent()
    }
    fs.mkdirSync(output, { recursive: true })
    const report = []
    for (const [screen, name, ...args] of cases) {
      if (interruptedSignal) break
      const result = await runShot(screen, name, args)
      report.push({
        name,
        screen,
        status: result.status,
        stdout: result.stdout.trim().split('\n').slice(-3),
        stderr: result.stderr.trim().split('\n').slice(-3),
      })
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      if (result.status !== 0 || interruptedSignal) break
    }
    fs.writeFileSync(
      path.join(output, 'matrix-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    if (interruptedSignal) return
    if (
      report.length !== cases.length ||
      report.some(({ status }) => status !== 0)
    ) {
      process.exitCode = 1
      return
    }
    console.log(`Verified the visual matrix across ${cases.length} cases.`)
  } finally {
    sourceRendererUrl = null
    if (sourceServer) await sourceServer.close()
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
