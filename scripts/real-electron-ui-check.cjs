#!/usr/bin/env node
/**
 * Audits a visible, real Supraspina Electron window from a manifest.
 *
 * The driver launches the executable named by the manifest and leaves the
 * caller's profile intact between staged runs. It keeps the Chromium sandbox
 * enabled so the audited window runs the shipped process model. It uses the
 * rendered controls for project opening and route changes, and reserves
 * renderer evaluation for read-only geometry, font, fit, and accessibility
 * measurements.
 *
 * Run:
 *   node scripts/real-electron-ui-check.cjs --manifest /absolute/run.json
 *
 * Set `target.kind` to source, unpacked, appimage, or deb-installed. Provide
 * schemaVersion, runId, target (id, kind, executable), profile, outdir, display,
 * and stage.mode. For populated and completed stages, also
 * name stage.recentProject.path so the driver can choose that existing entry
 * from the visible Open menu. The empty stage audits the Setup route the
 * shell displays before any project is open, so it needs no recent project
 * and reaches that route without the Primary navigation. When provided,
 * include installationRoot, licensePath, and xdotool in
 * stage.freesurferConfiguration; use them to select both paths in native X11
 * file choosers and commit them with the rendered Save action.
 */

'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { _electron: electron } = require('playwright')

const AXE_PATH = require.resolve('axe-core/axe.min.js')
const TARGET_KINDS = new Set([
  'source',
  'unpacked',
  'appimage',
  'deb-installed',
])
const STAGE_MODES = new Set(['first-run', 'empty', 'populated', 'completed'])
const RESERVED_ENVIRONMENT = new Set([
  'DISPLAY',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'NODE_OPTIONS',
  'SUPRASPINA_PACKAGE_SMOKE',
  'SUPRASPINA_SMOKE',
])

/** Use the canonical route sequence for visible acceptance. */
const CANONICAL_ROUTES = Object.freeze([
  { label: 'Setup', slug: 'setup', heading: /^Set up your project$/ },
  { label: 'Dashboard', slug: 'dashboard', heading: /^Dashboard$/ },
  { label: 'Subjects', slug: 'subjects', heading: /^Subjects$/ },
  { label: 'Runs', slug: 'runs', heading: /^Runs$/ },
  { label: 'Logs', slug: 'logs', heading: /^Logs$/ },
  {
    label: 'QC review',
    slug: 'qc-review',
    heading: /^(?:QC review|Subject .+)$/,
  },
  { label: 'Input QC', slug: 'input-qc', heading: /^Input QC$/ },
  {
    label: 'Pipeline',
    slug: 'pipeline',
    heading: /^Pipeline$/,
  },
  { label: 'Results', slug: 'results', heading: /^Results$/ },
  { label: 'Analysis', slug: 'analysis', heading: /^Analysis$/ },
  {
    label: 'Registry',
    slug: 'registry',
    heading: /^Registry$/,
  },
  {
    label: 'Diagnostics',
    slug: 'diagnostics',
    heading: /^Diagnostics$/,
  },
  { label: 'Settings', slug: 'settings', heading: /^Settings$/ },
])

/**
 * Use the accessible names the Diagnostics screen renders for the FreeSurfer
 * choosers.
 *
 * Each control is labeled Choose before a path is saved and Replace
 * afterward, so both spellings belong to the contract. See
 * `src/renderer/screens/DiagnosticsScreen.tsx`.
 */
const FREESURFER_CHOOSERS = Object.freeze([
  Object.freeze({
    setting: 'installationRoot',
    groupName: 'FreeSurfer installation root',
    pathKind: 'installation root',
    chooseName: 'Choose installation root for FreeSurfer',
    replaceName: 'Replace installation root for FreeSurfer',
    anyName: /^(?:Choose|Replace) installation root for FreeSurfer$/,
  }),
  Object.freeze({
    setting: 'licensePath',
    groupName: 'FreeSurfer license configuration',
    pathKind: 'license path',
    chooseName: 'Choose license file for FreeSurfer',
    replaceName: 'Replace license file for FreeSurfer',
    anyName: /^(?:Choose|Replace) license file for FreeSurfer$/,
  }),
])

/** Use the complete reviewed bundled font-face contract. */
const FONT_FACES = Object.freeze([
  ['sans-400-normal', 'normal', 400, 'WebCM Sans 10', 'WebCM Sans 10 Regular'],
  ['sans-400-italic', 'italic', 400, 'WebCM Sans 10', 'WebCM Sans 10 Oblique'],
  ['sans-500-normal', 'normal', 500, 'WebCM Sans 10', 'WebCM Sans 10 Book'],
  [
    'sans-500-italic',
    'italic',
    500,
    'WebCM Sans 10',
    'WebCM Sans 10 BookOblique',
  ],
  ['sans-700-normal', 'normal', 700, 'WebCM Sans 10', 'WebCM Sans 10 Bold'],
  [
    'sans-700-italic',
    'italic',
    700,
    'WebCM Sans 10',
    'WebCM Sans 10 BoldOblique',
  ],
  [
    'serif-400-normal',
    'normal',
    400,
    'WebCM Serif 10',
    'WebCM Serif 10 Regular',
  ],
  [
    'serif-400-italic',
    'italic',
    400,
    'WebCM Serif 10',
    'WebCM Serif 10 Italic',
  ],
  ['serif-500-normal', 'normal', 500, 'WebCM Serif 10', 'WebCM Serif 10 Book'],
  [
    'serif-500-italic',
    'italic',
    500,
    'WebCM Serif 10',
    'WebCM Serif 10 BookItalic',
  ],
  ['serif-700-normal', 'normal', 700, 'WebCM Serif 10', 'WebCM Serif 10 Bold'],
  [
    'serif-700-italic',
    'italic',
    700,
    'WebCM Serif 10',
    'WebCM Serif 10 BoldItalic',
  ],
  ['mono-400-normal', 'normal', 400, 'WebCM Mono 10', 'WebCM Mono 10 Regular'],
  ['mono-400-italic', 'italic', 400, 'WebCM Mono 10', 'WebCM Mono 10 Italic'],
  ['mono-500-normal', 'normal', 500, 'WebCM Mono 10', 'WebCM Mono 10 Book'],
  [
    'mono-500-italic',
    'italic',
    500,
    'WebCM Mono 10',
    'WebCM Mono 10 BookItalic',
  ],
  ['mono-700-normal', 'normal', 700, 'WebCM Mono 10', 'WebCM Mono 10 Bold'],
  [
    'mono-700-italic',
    'italic',
    700,
    'WebCM Mono 10',
    'WebCM Mono 10 BoldOblique',
  ],
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Provide ${label} as a non-empty string.`)
  }
  return value
}

function absolutePath(value, label) {
  const candidate = nonEmptyString(value, label)
  if (!path.isAbsolute(candidate)) {
    throw new Error(`Provide ${label} as an absolute path.`)
  }
  return path.normalize(candidate)
}

function boundedInteger(value, label, minimum, maximum, fallback) {
  const candidate = value === undefined ? fallback : value
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new Error(
      `Provide ${label} as an integer from ${minimum} to ${maximum}.`,
    )
  }
  return candidate
}

/**
 * Parse the required absolute acceptance-manifest path.
 *
 * @param {string[]} args
 * @param {object} [context] - The working-directory context, as `{ cwd }`.
 * @returns {{manifest: string}} The validated absolute manifest path.
 * @throws {Error} On missing, repeated, relative, or unknown arguments.
 */
function parseArgs(args, context = {}) {
  const cwd = context.cwd ?? process.cwd()
  let manifest = null
  for (let index = 0; index < args.length; ) {
    const current = args[index]
    if (current === '--manifest' || current.startsWith('--manifest=')) {
      if (manifest !== null) throw new Error('Provide --manifest only once.')
      if (current.startsWith('--manifest=')) {
        manifest = current.slice('--manifest='.length)
        index += 1
      } else {
        const value = args[index + 1]
        if (!value || value.startsWith('--')) {
          throw new Error('Provide a value for --manifest.')
        }
        manifest = value
        index += 2
      }
      continue
    }
    if (current.startsWith('--'))
      throw new Error(`Remove the unknown option: ${current}.`)
    if (manifest !== null) {
      throw new Error(`Remove the unexpected positional argument: ${current}.`)
    }
    manifest = current
    index += 1
  }
  if (manifest === null) throw new Error('Provide an absolute --manifest path.')
  if (!path.isAbsolute(manifest)) {
    throw new Error('Provide --manifest as an absolute path.')
  }
  return { manifest: absolutePath(path.resolve(cwd, manifest), '--manifest') }
}

function validateWindow(raw, index) {
  if (!isRecord(raw)) throw new Error(`Provide windows[${index}] as an object.`)
  const name = nonEmptyString(raw.name, `windows[${index}].name`)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(
      `Remove unsupported characters from windows[${index}].name.`,
    )
  }
  return {
    name,
    width: boundedInteger(raw.width, `windows[${index}].width`, 800, 7680),
    height: boundedInteger(raw.height, `windows[${index}].height`, 600, 4320),
    x: boundedInteger(raw.x, `windows[${index}].x`, -32768, 32767, 40),
    y: boundedInteger(raw.y, `windows[${index}].y`, -32768, 32767, 40),
  }
}

function validateExpectations(raw) {
  if (raw === undefined) return {}
  if (!isRecord(raw)) throw new Error('Provide expectations as an object.')
  const routeLabels = new Set(CANONICAL_ROUTES.map((route) => route.label))
  const expectations = {}
  for (const [route, value] of Object.entries(raw)) {
    if (!routeLabels.has(route)) {
      throw new Error(`Remove the unknown expectations route: ${route}.`)
    }
    if (!isRecord(value)) {
      throw new Error(`Provide expectations.${route} as an object.`)
    }
    const validateList = (candidate, label) => {
      if (candidate === undefined) return []
      if (!Array.isArray(candidate))
        throw new Error(`Provide ${label} as an array.`)
      return candidate.map((entry, index) =>
        nonEmptyString(entry, `${label}[${index}]`),
      )
    }
    expectations[route] = {
      visibleText: validateList(
        value.visibleText,
        `expectations.${route}.visibleText`,
      ),
      absentText: validateList(
        value.absentText,
        `expectations.${route}.absentText`,
      ),
    }
  }
  return expectations
}

/**
 * Validate and normalize one visible-acceptance manifest.
 *
 * @param {unknown} raw - The parsed manifest value.
 * @returns {object} The normalized acceptance options.
 * @throws {Error} On unsafe, incomplete, or malformed acceptance inputs.
 */
function validateManifest(raw) {
  if (!isRecord(raw)) throw new Error('Provide the manifest root as an object.')
  if (raw.schemaVersion !== 1) throw new Error('Set schemaVersion to 1.')
  const runId = nonEmptyString(raw.runId, 'runId')
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(runId)) {
    throw new Error('Remove unsupported characters from runId.')
  }
  if (!isRecord(raw.target)) throw new Error('Provide target as an object.')
  const kind = nonEmptyString(raw.target.kind, 'target.kind')
  if (!TARGET_KINDS.has(kind)) {
    throw new Error(
      `Set target.kind to one of: ${[...TARGET_KINDS].join(', ')}.`,
    )
  }
  const targetId = nonEmptyString(raw.target.id, 'target.id')
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(targetId)) {
    throw new Error('Remove unsupported characters from target.id.')
  }
  const executable = absolutePath(raw.target.executable, 'target.executable')
  const cwd =
    raw.target.cwd === undefined
      ? path.dirname(executable)
      : absolutePath(raw.target.cwd, 'target.cwd')
  const targetArgs = raw.target.args ?? []
  if (!Array.isArray(targetArgs))
    throw new Error('Provide target.args as an array.')
  const args = targetArgs.map((entry, index) =>
    nonEmptyString(entry, `target.args[${index}]`),
  )
  for (const argument of args) {
    if (/^--user-data-dir(?:=|$)/i.test(argument)) {
      throw new Error('Do not override the manifest profile in target.args.')
    }
    if (
      /^--headless(?:=|$)/i.test(argument) ||
      /^--ozone-platform=headless$/i.test(argument)
    ) {
      throw new Error(
        'Do not use headless launch arguments for visible acceptance.',
      )
    }
    if (/(?:mock|smoke|fixture|test-mode)/i.test(argument)) {
      throw new Error(
        `Do not use a state-substitution launch argument for visible acceptance: ${argument}.`,
      )
    }
    if (/^--(?:no|disable)-(?:[a-z0-9-]+-)?sandbox(?:=|$)/i.test(argument)) {
      throw new Error(
        `Do not use a sandbox-disabling launch argument for visible acceptance: ${argument}.`,
      )
    }
  }
  const environment = raw.target.env ?? {}
  if (!isRecord(environment))
    throw new Error('Provide target.env as an object.')
  const env = {}
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(`Provide a valid target.env key: ${key}.`)
    }
    if (
      RESERVED_ENVIRONMENT.has(key) ||
      /^(?:SUPRASPINA|ELECTRON).*?(?:MOCK|SMOKE|TEST|FIXTURE|RENDERER)/.test(
        key,
      )
    ) {
      throw new Error(`Do not override ${key} in target.env.`)
    }
    env[key] = nonEmptyString(value, `target.env.${key}`)
  }

  const profile = absolutePath(raw.profile, 'profile')
  if (profile === path.parse(profile).root) {
    throw new Error('Do not use a filesystem root as profile.')
  }
  const outdir = absolutePath(raw.outdir, 'outdir')
  if (outdir === path.parse(outdir).root) {
    throw new Error('Do not use a filesystem root as outdir.')
  }
  const display = nonEmptyString(raw.display, 'display')
  if (!isRecord(raw.stage)) throw new Error('Provide stage as an object.')
  const mode = nonEmptyString(raw.stage.mode, 'stage.mode')
  if (!STAGE_MODES.has(mode)) {
    throw new Error(`Set stage.mode to one of: ${[...STAGE_MODES].join(', ')}.`)
  }
  const defaultFirstRunAction = mode === 'empty' ? 'continue' : 'preserve'
  const firstRunAction = raw.stage.firstRunAction ?? defaultFirstRunAction
  if (!['preserve', 'continue'].includes(firstRunAction)) {
    throw new Error('Set stage.firstRunAction to preserve or continue.')
  }
  if (mode === 'first-run' && firstRunAction !== 'preserve') {
    throw new Error('Preserve the first-run modal for auditing.')
  }
  let recentProject = null
  if (raw.stage.recentProject !== undefined) {
    if (!isRecord(raw.stage.recentProject)) {
      throw new Error('Provide stage.recentProject as an object.')
    }
    recentProject = {
      path: absolutePath(
        raw.stage.recentProject.path,
        'stage.recentProject.path',
      ),
      name:
        raw.stage.recentProject.name === undefined
          ? null
          : nonEmptyString(
              raw.stage.recentProject.name,
              'stage.recentProject.name',
            ),
    }
  }
  if (['populated', 'completed'].includes(mode) && recentProject === null) {
    throw new Error(`Provide stage.recentProject for ${mode} stages.`)
  }
  let freesurferConfiguration = null
  if (raw.stage.freesurferConfiguration !== undefined) {
    if (!['populated', 'completed'].includes(mode)) {
      throw new Error(
        'Use stage.freesurferConfiguration only with a populated or completed project stage.',
      )
    }
    if (!isRecord(raw.stage.freesurferConfiguration)) {
      throw new Error('Provide stage.freesurferConfiguration as an object.')
    }
    const expectedInitialState =
      raw.stage.freesurferConfiguration.expectedInitialState ?? 'either'
    if (
      !['configured', 'not-configured', 'either'].includes(expectedInitialState)
    ) {
      throw new Error(
        'Set stage.freesurferConfiguration.expectedInitialState to configured, not-configured, or either.',
      )
    }
    freesurferConfiguration = {
      installationRoot: absolutePath(
        raw.stage.freesurferConfiguration.installationRoot,
        'stage.freesurferConfiguration.installationRoot',
      ),
      licensePath: absolutePath(
        raw.stage.freesurferConfiguration.licensePath,
        'stage.freesurferConfiguration.licensePath',
      ),
      xdotool: absolutePath(
        raw.stage.freesurferConfiguration.xdotool ?? '/usr/bin/xdotool',
        'stage.freesurferConfiguration.xdotool',
      ),
      expectedInitialState,
      dialogTimeoutMs: boundedInteger(
        raw.stage.freesurferConfiguration.dialogTimeoutMs,
        'stage.freesurferConfiguration.dialogTimeoutMs',
        5_000,
        60_000,
        30_000,
      ),
    }
  }

  const rawWindows = raw.windows ?? [
    { name: 'restored-1100x700', width: 1100, height: 700, x: 40, y: 40 },
  ]
  if (!Array.isArray(rawWindows) || rawWindows.length === 0) {
    throw new Error('Provide at least one window geometry in windows.')
  }
  if (rawWindows.length > 8) throw new Error('Keep windows within 8 entries.')
  const windows = rawWindows.map(validateWindow)
  if (new Set(windows.map((window) => window.name)).size !== windows.length) {
    throw new Error('Provide unique windows names.')
  }

  return {
    schemaVersion: 1,
    runId,
    target: { kind, id: targetId, executable, cwd, args, env },
    profile,
    outdir,
    display,
    stage: {
      mode,
      firstRunAction,
      recentProject,
      freesurferConfiguration,
    },
    windows,
    screenshotRepeats: boundedInteger(
      raw.screenshotRepeats,
      'screenshotRepeats',
      2,
      10,
      2,
    ),
    timeoutMs: boundedInteger(
      raw.timeoutMs,
      'timeoutMs',
      5_000,
      300_000,
      60_000,
    ),
    settleMs: boundedInteger(raw.settleMs, 'settleMs', 0, 30_000, 750),
    expectedTitle:
      raw.expectedTitle === undefined
        ? 'Supraspina'
        : nonEmptyString(raw.expectedTitle, 'expectedTitle'),
    failOnAxeIncomplete: (() => {
      if (raw.failOnAxeIncomplete === undefined) return true
      if (typeof raw.failOnAxeIncomplete !== 'boolean') {
        throw new Error('Provide failOnAxeIncomplete as a boolean.')
      }
      return raw.failOnAxeIncomplete
    })(),
    expectations: validateExpectations(raw.expectations),
  }
}

/**
 * Load and validate one visible-acceptance manifest.
 *
 * @param {string} manifestPath - An absolute path.
 * @returns {Promise<object>} The normalized acceptance options.
 * @throws {Error} On an unreadable, invalid, or unsafe manifest.
 */
async function loadManifest(manifestPath) {
  let raw
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Make manifest ${manifestPath} readable: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    )
  }
  return validateManifest(raw)
}

/**
 * Build sanitized Electron launch options for visible acceptance.
 *
 * @param {object} options - The normalized acceptance options.
 * @param {NodeJS.ProcessEnv} [baseEnvironment]
 * @returns {object}
 */
function buildLaunchOptions(options, baseEnvironment = process.env) {
  const env = {
    ...baseEnvironment,
    ...options.target.env,
    DISPLAY: options.display,
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return {
    executablePath: options.target.executable,
    cwd: options.target.cwd,
    args: [`--user-data-dir=${options.profile}`, ...options.target.args],
    // Playwright prepends `--no-sandbox` on Linux unless the caller asks for
    // the sandbox, which would audit a weaker process model than the one the
    // application ships and than the manifest contract allows.
    chromiumSandbox: true,
    env,
    timeout: options.timeoutMs,
  }
}

/**
 * Serialize one thrown value into a stable report record.
 *
 * @param {unknown} error
 * @returns {{name: string, message: string, stack: string | null}}
 */
function serialiseError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    }
  }
  return { name: 'Error', message: String(error), stack: null }
}

/**
 * Format one imperative visible-acceptance CLI failure.
 *
 * @param {unknown} error
 * @returns {string}
 */
function formatCliFailure(error) {
  const detail = error instanceof Error ? error.message : String(error)
  return `Resolve the real Electron UI check failure: ${detail.replace(/[.!?]+$/, '')}.`
}

function timestamped(value) {
  return { at: new Date().toISOString(), ...value }
}

function createEventCollector() {
  const events = {
    rendererConsole: [],
    mainConsole: [],
    pageErrors: [],
    requestFailures: [],
    errorResponses: [],
    crashes: [],
    processStdout: [],
    processStderr: [],
    lifecycle: [],
  }
  const attachedPages = new WeakSet()
  const pending = new Set()

  const track = (promise) => {
    pending.add(promise)
    void promise.finally(() => pending.delete(promise))
  }
  const attachPage = (page) => {
    if (attachedPages.has(page)) return
    attachedPages.add(page)
    page.on('console', (message) => {
      const task = Promise.all(
        message.args().map(async (argument) => {
          try {
            return await argument.jsonValue()
          } catch {
            return '<unserializable>'
          }
        }),
      ).then((args) => {
        events.rendererConsole.push(
          timestamped({
            type: message.type(),
            text: message.text(),
            location: message.location(),
            args,
          }),
        )
      })
      track(task)
    })
    page.on('pageerror', (error) => {
      events.pageErrors.push(timestamped(serialiseError(error)))
    })
    page.on('requestfailed', (request) => {
      events.requestFailures.push(
        timestamped({
          method: request.method(),
          resourceType: request.resourceType(),
          url: request.url(),
          failure: request.failure(),
        }),
      )
    })
    page.on('response', (response) => {
      if (response.status() < 400) return
      events.errorResponses.push(
        timestamped({
          method: response.request().method(),
          resourceType: response.request().resourceType(),
          status: response.status(),
          statusText: response.statusText(),
          url: response.url(),
        }),
      )
    })
    page.on('crash', () => {
      events.crashes.push(
        timestamped({ source: 'renderer', detail: 'page crash' }),
      )
    })
  }
  const attachApplication = (application) => {
    application.on('window', attachPage)
    application.on('console', (message) => {
      events.mainConsole.push(
        timestamped({
          type: message.type(),
          text: message.text(),
          location: message.location(),
        }),
      )
    })
    for (const page of application.windows()) attachPage(page)
    const child = application.process()
    child.stdout?.on('data', (chunk) => {
      events.processStdout.push(timestamped({ text: String(chunk) }))
    })
    child.stderr?.on('data', (chunk) => {
      events.processStderr.push(timestamped({ text: String(chunk) }))
    })
    child.on('exit', (code, signal) => {
      events.lifecycle.push(
        timestamped({ event: 'process-exit', code, signal }),
      )
    })
  }
  return {
    events,
    attachApplication,
    attachPage,
    async flush() {
      await Promise.allSettled([...pending])
    },
  }
}

/**
 * Collect every renderer and main console entry that fails the acceptance gate.
 *
 * Apply no message allowlist and no severity downgrade. An expected operator
 * precondition must be a typed result at its owning boundary; it must never be
 * filtered out of this gate.
 *
 * @param {object} events - The collected event buckets.
 * @returns {object[]} Every error or assert console entry, in order.
 * @example
 * collectConsoleErrors({ rendererConsole: [], mainConsole: [] })
 */
function collectConsoleErrors(events) {
  return [
    ...(events.rendererConsole ?? []),
    ...(events.mainConsole ?? []),
  ].filter((entry) => ['error', 'assert'].includes(entry.type))
}

async function waitForRenderer(page, options) {
  page.setDefaultTimeout(options.timeoutMs)
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#root').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.fonts?.status === 'loaded')
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  const title = await page.title()
  if (title !== options.expectedTitle) {
    throw new Error(
      `Use window title ${options.expectedTitle}; received ${title}.`,
    )
  }
}

async function assertVisibleWindow(application, page) {
  const main = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return null
    return {
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      destroyed: window.isDestroyed(),
    }
  })
  const renderer = await page.evaluate(() => ({
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
  }))
  if (
    main === null ||
    !main.visible ||
    main.minimized ||
    main.destroyed ||
    renderer.visibilityState !== 'visible'
  ) {
    throw new Error(
      `Render the Electron window visibly: ${JSON.stringify({ main, renderer })}.`,
    )
  }
  return { main, renderer }
}

async function setWindowGeometry(application, geometry) {
  await application.evaluate(
    ({ BrowserWindow }, bounds) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Open the Supraspina window.')
      if (window.isFullScreen()) window.setFullScreen(false)
      if (window.isMaximized()) window.unmaximize()
      window.setBounds(bounds)
      window.show()
      window.focus()
    },
    {
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
    },
  )
}

async function collectGeometry(application, page, requested) {
  const main = await application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('Open the Supraspina window.')
    return {
      bounds: window.getBounds(),
      contentBounds: window.getContentBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
      visible: window.isVisible(),
      displays: screen.getAllDisplays().map((display) => ({
        id: display.id,
        label: display.label,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        rotation: display.rotation,
        internal: display.internal,
        touchSupport: display.touchSupport,
        colorDepth: display.colorDepth,
        monochrome: display.monochrome,
        displayFrequency: display.displayFrequency,
      })),
      nearestDisplayId: screen.getDisplayMatching(window.getBounds()).id,
      primaryDisplayId: screen.getPrimaryDisplay().id,
    }
  })
  const renderer = await page.evaluate(() => ({
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    outerWidth: globalThis.outerWidth,
    outerHeight: globalThis.outerHeight,
    devicePixelRatio: globalThis.devicePixelRatio,
    screen: {
      width: globalThis.screen.width,
      height: globalThis.screen.height,
      availWidth: globalThis.screen.availWidth,
      availHeight: globalThis.screen.availHeight,
      colorDepth: globalThis.screen.colorDepth,
      pixelDepth: globalThis.screen.pixelDepth,
    },
    visualViewport: globalThis.visualViewport
      ? {
          width: globalThis.visualViewport.width,
          height: globalThis.visualViewport.height,
          offsetLeft: globalThis.visualViewport.offsetLeft,
          offsetTop: globalThis.visualViewport.offsetTop,
          scale: globalThis.visualViewport.scale,
        }
      : null,
    preferences: {
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      highContrast: matchMedia('(prefers-contrast: more)').matches,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      forcedColors: matchMedia('(forced-colors: active)').matches,
    },
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
  }))
  return { requested, main, renderer }
}

async function handleFirstRun(page, options) {
  const dialog = page.getByRole('dialog', { name: 'Welcome to Supraspina' })
  const visible = await dialog.isVisible().catch(() => false)
  if (options.stage.mode === 'first-run') {
    await dialog.waitFor({ state: 'visible' })
    return { observed: true, action: 'preserved' }
  }
  if (!visible) return { observed: false, action: 'none' }
  if (options.stage.firstRunAction !== 'continue') {
    throw new Error(
      `Initialize the profile before running the ${options.stage.mode} stage.`,
    )
  }
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  return { observed: true, action: 'continued-through-visible-control' }
}

async function openRecentProjectViaUi(page, recentProject, timeoutMs) {
  const trigger = page.getByRole('button', { name: 'Open a saved project' })
  await trigger.waitFor({ state: 'visible', timeout: timeoutMs })
  await trigger.click()
  const menu = page.getByRole('menu', { name: 'Open project' })
  await menu.waitFor({ state: 'visible' })
  const items = menu.getByRole('menuitem')
  const available = []
  for (let index = 0; index < (await items.count()); index += 1) {
    const item = items.nth(index)
    const title = await item.getAttribute('title')
    const name = (await item.innerText()).replace(/\s+/g, ' ').trim()
    available.push({ title, name })
    if (
      title === recentProject.path &&
      (recentProject.name === null || name.includes(recentProject.name))
    ) {
      await item.click()
      const dashboard = page.getByRole('heading', {
        name: 'Dashboard',
        level: 1,
      })
      await dashboard.waitFor({ state: 'visible', timeout: timeoutMs })
      return { selected: { title, name }, available }
    }
  }
  await page.keyboard.press('Escape')
  throw new Error(
    `Add recent project ${recentProject.path} to the Open menu: ${JSON.stringify(available)}.`,
  )
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function runCommand(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  const allowedExitCodes = new Set(options.allowedExitCodes ?? [0])
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(
        new Error(
          `Complete ${path.basename(executable)} ${args[0] ?? ''} within ${timeoutMs} ms.`,
        ),
      )
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== null && allowedExitCodes.has(code)) {
        resolve({ code, signal, stdout, stderr })
        return
      }
      reject(
        new Error(
          `Run ${path.basename(executable)} ${args[0] ?? ''} successfully (${String(
            code,
          )}/${String(signal)}): ${stderr.trim()}.`,
        ),
      )
    })
  })
}

async function listVisibleX11Windows(xdotool, display) {
  const env = { ...process.env, DISPLAY: display }
  const search = await runCommand(
    xdotool,
    ['search', '--onlyvisible', '--name', '.+'],
    { env, allowedExitCodes: [0, 1] },
  )
  const ids = search.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value))
  const windows = []
  for (const id of ids) {
    const name = await runCommand(xdotool, ['getwindowname', id], {
      env,
      allowedExitCodes: [0, 1],
    })
    windows.push({ id, name: name.stdout.trim() })
  }
  return windows
}

async function waitForNewNativeWindow(
  xdotool,
  display,
  baselineIds,
  timeoutMs,
) {
  const deadline = Date.now() + timeoutMs
  let candidates = []
  while (Date.now() < deadline) {
    const windows = await listVisibleX11Windows(xdotool, display)
    candidates = windows.filter((window) => !baselineIds.has(window.id))
    const named = candidates.find((window) =>
      /(?:open|choose|select|license|file)/i.test(window.name),
    )
    if (named) return { selected: named, candidates }
    if (candidates.length === 1) return { selected: candidates[0], candidates }
    await delay(200)
  }
  throw new Error(
    `Open the native file chooser within ${timeoutMs} ms; candidates: ${JSON.stringify(
      candidates,
    )}.`,
  )
}

async function waitForCondition(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(200)
  }
  throw new Error(`Complete ${label} within ${timeoutMs} ms.`)
}

async function chooseNativePathViaUi(page, options, request) {
  const group = page.getByRole('group', {
    name: request.chooser.groupName,
    exact: true,
  })
  await group.waitFor({ state: 'visible' })
  const configured = group.getByText('Configured', { exact: true })
  const notConfigured = group.getByText('Not configured', { exact: true })
  const initialState = (await configured.isVisible().catch(() => false))
    ? 'configured'
    : (await notConfigured.isVisible().catch(() => false))
      ? 'not-configured'
      : 'unknown'
  if (
    request.expectedInitialState !== 'either' &&
    initialState !== request.expectedInitialState
  ) {
    throw new Error(
      `Set ${request.chooser.groupName} initial state to ${request.expectedInitialState}; received ${initialState}.`,
    )
  }
  // The screen labels one control Choose while nothing is saved and Replace
  // once a path is stored, so read the rendered name from the state it just
  // reported and accept either spelling while that state is unreadable.
  const buttonName =
    initialState === 'configured'
      ? request.chooser.replaceName
      : initialState === 'not-configured'
        ? request.chooser.chooseName
        : request.chooser.anyName
  const before = await listVisibleX11Windows(request.xdotool, options.display)
  const baselineIds = new Set(before.map((window) => window.id))
  await group.getByRole('button', { name: buttonName, exact: true }).click()
  const chooser = await waitForNewNativeWindow(
    request.xdotool,
    options.display,
    baselineIds,
    request.dialogTimeoutMs,
  )
  const nativeEnvironment = { ...process.env, DISPLAY: options.display }
  await runCommand(
    request.xdotool,
    ['windowactivate', '--sync', chooser.selected.id],
    { env: nativeEnvironment },
  ).catch(() =>
    runCommand(
      request.xdotool,
      ['windowfocus', '--sync', chooser.selected.id],
      { env: nativeEnvironment },
    ),
  )
  await runCommand(request.xdotool, ['key', '--clearmodifiers', 'ctrl+l'], {
    env: nativeEnvironment,
  })
  await delay(200)
  await runCommand(
    request.xdotool,
    ['type', '--clearmodifiers', '--delay', '1', request.targetPath],
    { env: nativeEnvironment },
  )
  await runCommand(request.xdotool, ['key', '--clearmodifiers', 'Return'], {
    env: nativeEnvironment,
  })
  await delay(500)
  const chooserStillVisible = (
    await listVisibleX11Windows(request.xdotool, options.display)
  ).some((window) => window.id === chooser.selected.id)
  if (chooserStillVisible) {
    await runCommand(request.xdotool, ['key', '--clearmodifiers', 'Return'], {
      env: nativeEnvironment,
    })
  }
  await waitForCondition(
    () => configured.isVisible().catch(() => false),
    request.dialogTimeoutMs,
    `${request.chooser.groupName} configured-state update`,
  )
  const groupText = await group.innerText()
  if (groupText.includes(request.targetPath)) {
    throw new Error(
      `Keep the selected ${request.chooser.pathKind} hidden from the Diagnostics screen.`,
    )
  }
  return {
    selectedPath: request.targetPath,
    initialState,
    buttonName: String(buttonName),
    chooser: {
      id: chooser.selected.id,
      name: chooser.selected.name,
      candidateCount: chooser.candidates.length,
    },
    configuredAfterPicker: true,
    pathHiddenFromDiagnostics: true,
  }
}

async function configureFreesurferViaUi(page, options) {
  const configuration = options.stage.freesurferConfiguration
  if (configuration === null) return null
  const [installationStat, licenseStat] = await Promise.all([
    fs.stat(configuration.installationRoot),
    fs.stat(configuration.licensePath),
  ])
  if (!installationStat.isDirectory()) {
    throw new Error('Select a FreeSurfer installation root directory.')
  }
  if (!licenseStat.isFile()) {
    throw new Error('Select a regular FreeSurfer license file.')
  }
  await fs.access(configuration.xdotool)
  const diagnostics = CANONICAL_ROUTES.find(
    (route) => route.label === 'Diagnostics',
  )
  const navigation = await openRouteViaUi(page, diagnostics)
  const [installationChooser, licenseChooser] = FREESURFER_CHOOSERS
  const installationRoot = await chooseNativePathViaUi(page, options, {
    chooser: installationChooser,
    targetPath: configuration.installationRoot,
    expectedInitialState: configuration.expectedInitialState,
    xdotool: configuration.xdotool,
    dialogTimeoutMs: configuration.dialogTimeoutMs,
  })
  const license = await chooseNativePathViaUi(page, options, {
    chooser: licenseChooser,
    targetPath: configuration.licensePath,
    expectedInitialState: configuration.expectedInitialState,
    xdotool: configuration.xdotool,
    dialogTimeoutMs: configuration.dialogTimeoutMs,
  })

  const projectActions = page.getByRole('navigation', {
    name: 'Project actions',
  })
  const save = projectActions.getByRole('button', { name: 'Save', exact: true })
  if (!(await save.isEnabled())) {
    throw new Error('Enable Save after choosing the FreeSurfer paths.')
  }
  await save.click()
  await waitForCondition(
    () => save.isDisabled(),
    options.timeoutMs,
    'project Save action',
  )
  await openRouteViaUi(page, CANONICAL_ROUTES[1])
  await openRouteViaUi(page, diagnostics)
  for (const { groupName } of FREESURFER_CHOOSERS) {
    await page
      .getByRole('group', { name: groupName, exact: true })
      .getByText('Configured', { exact: true })
      .waitFor({ state: 'visible' })
  }
  return {
    navigation,
    installationRoot,
    license,
    savedThroughProjectActions: true,
    configuredAfterRouteRoundTrip: true,
  }
}

/**
 * Decide how the audited route is reached from the current shell state.
 *
 * The shell renders the Primary navigation only while a project is open, and
 * without one it shows the Setup route directly. Empty-stage runs therefore
 * reach their route by display rather than by a navigation control.
 *
 * @param {{navigationVisible: boolean, headingVisible: boolean, label: string}} state
 * @returns {'primary-navigation' | 'already-displayed'}
 * @throws {Error} On a shell that neither displays nor can open the route.
 */
function decideRouteEntry({ navigationVisible, headingVisible, label }) {
  if (navigationVisible) return 'primary-navigation'
  if (headingVisible) return 'already-displayed'
  throw new Error(
    `Display the ${label} route or the Primary navigation that opens it.`,
  )
}

async function openRouteViaUi(page, route) {
  const navigation = page.getByRole('navigation', { name: 'Primary' })
  const heading = page.getByRole('heading', { level: 1, name: route.heading })
  const entry = decideRouteEntry({
    navigationVisible: await navigation.isVisible().catch(() => false),
    headingVisible: await heading.isVisible().catch(() => false),
    label: route.label,
  })
  let method = 'already-displayed'
  if (entry === 'primary-navigation') {
    const direct = navigation.getByRole('button', {
      name: route.label,
      exact: true,
    })
    if (await direct.isVisible().catch(() => false)) {
      await direct.click()
      method = 'primary-navigation-button'
    } else {
      const more = navigation.locator('button[aria-haspopup="menu"]')
      await more.click()
      const menu = page.getByRole('menu', { name: 'More workspaces' })
      const item = menu.getByRole('menuitem', {
        name: route.label,
        exact: true,
      })
      await item.click()
      method = 'more-workspaces-menuitem'
    }
  }
  await heading.waitFor({ state: 'visible' })
  return { method, heading: (await heading.innerText()).trim() }
}

async function assertRouteExpectations(page, route, expectations) {
  const expected = expectations[route.label] ?? {
    visibleText: [],
    absentText: [],
  }
  for (const text of expected.visibleText) {
    await page
      .getByText(text, { exact: false })
      .first()
      .waitFor({ state: 'visible' })
  }
  for (const text of expected.absentText) {
    if (
      await page
        .getByText(text, { exact: false })
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      throw new Error(`Hide unexpected ${route.label} text: ${text}.`)
    }
  }
  return expected
}

async function auditFonts(page) {
  return page.evaluate(async (faces) => {
    await document.fonts.ready
    const loaded = []
    for (const [name, style, weight, family, sourceStem] of faces) {
      const descriptor = `${style} ${weight} 16px "${family}"`
      const matches = await document.fonts.load(
        descriptor,
        'Supraspina 0123456789',
      )
      loaded.push({
        name,
        family,
        style,
        weight,
        sourceStem,
        descriptor,
        active:
          matches.length === 1 &&
          matches[0].status === 'loaded' &&
          matches[0].family.replace(/^["']|["']$/g, '') === family &&
          Number(matches[0].weight) === weight &&
          matches[0].style === style &&
          document.fonts.check(descriptor, 'Supraspina 0123456789'),
      })
    }
    await document.fonts.ready
    const activation = document.querySelector(
      '[data-font-activation="fonts-18"]',
    )
    const activationFaces = activation
      ? [...activation.querySelectorAll('[data-font-face]')].map((element) => {
          const style = getComputedStyle(element)
          return {
            name: element.getAttribute('data-font-face'),
            family: style.fontFamily
              .split(',')[0]
              .trim()
              .replace(/^["']|["']$/g, ''),
            weight: Number(style.fontWeight),
            style: style.fontStyle,
          }
        })
      : []
    const rules = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules]
        } catch {
          return []
        }
      })
      .filter((rule) => rule.type === CSSRule.FONT_FACE_RULE)
      .map((rule) => {
        const source = rule.style.getPropertyValue('src')
        const match = source.match(/url\(["']?([^"')]+)["']?\)/)
        const url = match ? new URL(match[1], location.href) : null
        return {
          family: rule.style
            .getPropertyValue('font-family')
            .trim()
            .replace(/^["']|["']$/g, ''),
          weight: Number(rule.style.getPropertyValue('font-weight')),
          style: rule.style.getPropertyValue('font-style').trim(),
          source,
          url: url?.href ?? null,
          protocol: url?.protocol ?? null,
          filename: url
            ? decodeURIComponent(url.pathname.split('/').pop() ?? '')
            : null,
        }
      })
    const synthesis = getComputedStyle(document.documentElement)
      .getPropertyValue('font-synthesis')
      .trim()
    const ruleComplete =
      rules.length === faces.length &&
      new Set(rules.map((rule) => rule.url)).size === faces.length &&
      faces.every(([, style, weight, family, sourceStem]) =>
        rules.some(
          (rule) =>
            rule.family === family &&
            rule.style === style &&
            rule.weight === weight &&
            rule.filename?.startsWith(sourceStem) &&
            rule.filename.endsWith('.woff2') &&
            /format\(["']?woff2["']?\)/.test(rule.source),
        ),
      )
    const activationComplete =
      activationFaces.length === faces.length &&
      faces.every(([name, style, weight, family]) =>
        activationFaces.some(
          (face) =>
            face.name === name &&
            face.family === family &&
            face.style === style &&
            face.weight === weight,
        ),
      )
    const localProtocols = rules.every((rule) =>
      ['file:', 'data:'].includes(rule.protocol),
    )
    return {
      status: document.fonts.status,
      requestedCount: faces.length,
      loadedCount: loaded.filter((face) => face.active).length,
      loaded,
      activationFaces,
      rules,
      synthesis,
      checks: {
        allFacesLoaded: loaded.every((face) => face.active),
        activationComplete,
        ruleComplete,
        localProtocols,
        synthesisDisabled: synthesis === 'none',
      },
    }
  }, FONT_FACES)
}

/**
 * Wrap the axe-core bundle in one expression that installs its global.
 *
 * The renderer serves `script-src 'self'`, so an injected inline `<script>` is
 * refused. Evaluating the bundle through the debugger installs the same global
 * without relaxing the application's content-security policy.
 *
 * @param {string} source
 * @returns {string} An expression that evaluates to whether the global
 *   arrived.
 */
function axeInstallExpression(source) {
  return `(() => {\n${source}\n;return typeof globalThis.axe === 'object'\n})()`
}

async function addAxe(page) {
  const present = await page.evaluate(() => typeof globalThis.axe === 'object')
  if (present) return
  const source = await fs.readFile(AXE_PATH, 'utf8')
  const installed = await page.evaluate(axeInstallExpression(source))
  if (!installed) {
    throw new Error('Load axe-core into the renderer before auditing it.')
  }
}

async function runAxeAudit(page, contextSelector) {
  await addAxe(page)
  return page.evaluate(async (selector) => {
    const context = document.querySelector(selector)
    if (!context) throw new Error(`Provide the Axe context: ${selector}.`)
    const results = await globalThis.axe.run(context, {
      runOnly: {
        type: 'tag',
        values: [
          'wcag2a',
          'wcag2aa',
          'wcag21a',
          'wcag21aa',
          'wcag22aa',
          'best-practice',
        ],
      },
      rules: { 'target-size': { enabled: true } },
      resultTypes: ['violations', 'incomplete'],
    })
    const serialise = (finding) => ({
      id: finding.id,
      impact: finding.impact,
      help: finding.help,
      helpUrl: finding.helpUrl,
      tags: finding.tags,
      nodes: finding.nodes.map((node) => ({
        impact: node.impact,
        target: node.target,
        html: node.html.slice(0, 500),
        failureSummary: node.failureSummary,
      })),
    })
    return {
      testEngine: results.testEngine,
      timestamp: results.timestamp,
      url: results.url,
      violations: results.violations.map(serialise),
      incomplete: results.incomplete.map(serialise),
    }
  }, contextSelector)
}

async function runCustomAccessibilityAudit(page, contextSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector)
    if (!root) throw new Error(`Provide the custom audit context: ${selector}.`)
    const findings = []
    const contrastChecks = []
    const targetChecks = []
    const parseColor = (value) => {
      const match = value.match(
        /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/,
      )
      if (!match) return null
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] === undefined ? 1 : Number(match[4]),
      }
    }
    const composite = (front, back) => {
      const alpha = front.a + back.a * (1 - front.a)
      if (alpha === 0) return { r: 255, g: 255, b: 255, a: 1 }
      return {
        r: (front.r * front.a + back.r * back.a * (1 - front.a)) / alpha,
        g: (front.g * front.a + back.g * back.a * (1 - front.a)) / alpha,
        b: (front.b * front.a + back.b * back.a * (1 - front.a)) / alpha,
        a: alpha,
      }
    }
    const background = (element) => {
      const layers = []
      let current = element
      let image = false
      while (current instanceof Element) {
        const style = getComputedStyle(current)
        if (style.backgroundImage !== 'none') image = true
        const color = parseColor(style.backgroundColor)
        if (color && color.a > 0) layers.push(color)
        current = current.parentElement
      }
      let color = { r: 255, g: 255, b: 255, a: 1 }
      for (const layer of layers.reverse()) color = composite(layer, color)
      return { color, image }
    }
    const channel = (value) => {
      const normal = value / 255
      return normal <= 0.04045
        ? normal / 12.92
        : ((normal + 0.055) / 1.055) ** 2.4
    }
    const luminance = (color) =>
      0.2126 * channel(color.r) +
      0.7152 * channel(color.g) +
      0.0722 * channel(color.b)
    const ratio = (left, right) => {
      const a = luminance(left)
      const b = luminance(right)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    const rendered = (element) => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
        return false
      }
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return (
        element.getClientRects().length > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        !element.closest('[aria-hidden="true"], [inert]')
      )
    }
    const identify = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`
      const label = element.getAttribute('aria-label')
      if (label)
        return `${element.tagName.toLowerCase()}[aria-label="${label.slice(0, 100)}"]`
      const role = element.getAttribute('role')
      const text = (element.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
      return `${element.tagName.toLowerCase()}${role ? `[role="${role}"]` : ''}${
        text ? `:${text}` : ''
      }`
    }
    const cumulativeOpacity = (element, style) => {
      let opacity = Number.parseFloat(style.opacity || '1')
      let current = element.parentElement
      while (current instanceof Element) {
        opacity *= Number.parseFloat(getComputedStyle(current).opacity || '1')
        current = current.parentElement
      }
      return Math.min(1, Math.max(0, opacity))
    }
    const elements = [root, ...root.querySelectorAll('*')]
    for (const element of elements) {
      if (!rendered(element)) continue
      const hasOwnText = [...element.childNodes].some(
        (node) =>
          node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      )
      const formText =
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement ||
        (element instanceof HTMLInputElement &&
          ![
            'button',
            'checkbox',
            'color',
            'file',
            'hidden',
            'image',
            'radio',
            'range',
            'reset',
            'submit',
          ].includes(element.type))
      if (!hasOwnText && !formText) continue
      const style = getComputedStyle(element)
      const foreground = parseColor(style.color)
      const underlay = background(element)
      const target = identify(element)
      if (!foreground || underlay.image) {
        findings.push({
          kind: 'contrast-unresolved',
          target,
          reason: !foreground
            ? `unparsed foreground ${style.color}`
            : 'background image or gradient',
        })
        continue
      }
      foreground.a *= cumulativeOpacity(element, style)
      const exact = ratio(composite(foreground, underlay.color), underlay.color)
      const fontSize = Number.parseFloat(style.fontSize)
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400
      const large = fontSize >= 24 || (fontSize >= 18.6667 && fontWeight >= 700)
      const inactive = Boolean(
        element.closest(':disabled, [aria-disabled="true"]'),
      )
      const required = inactive ? 0 : large ? 3 : 4.5
      const check = {
        target,
        ratio: exact,
        required,
        fontSize,
        fontWeight,
        inactive,
      }
      contrastChecks.push(check)
      if (exact < required) findings.push({ kind: 'text-contrast', ...check })
    }

    const controlSelector =
      'button, input, select, textarea, a[href], [role="button"], [role="menuitem"], [role="radio"], [role="switch"], [role="checkbox"], [role="tab"]'
    const controls = [...root.querySelectorAll(controlSelector)].filter(
      rendered,
    )
    for (const element of controls) {
      const rect = element.getBoundingClientRect()
      let width = rect.width
      let height = rect.height
      if (
        (element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement) &&
        element.labels
      ) {
        for (const label of element.labels) {
          if (!rendered(label)) continue
          const labelRect = label.getBoundingClientRect()
          width = Math.max(width, labelRect.width)
          height = Math.max(height, labelRect.height)
        }
      }
      const check = { target: identify(element), width, height }
      targetChecks.push(check)
      if (width < 24 || height < 24) {
        findings.push({ kind: 'target-size', ...check })
      }
      const style = getComputedStyle(element)
      if (
        !['auto', 'scroll'].includes(style.overflowX) &&
        element.scrollWidth - element.clientWidth > 2
      ) {
        findings.push({
          kind: 'control-content-clipped-x',
          target: identify(element),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        })
      }
      if (
        !['auto', 'scroll'].includes(style.overflowY) &&
        element.scrollHeight - element.clientHeight > 2
      ) {
        findings.push({
          kind: 'control-content-clipped-y',
          target: identify(element),
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        })
      }
    }
    return {
      findings,
      contrastChecks,
      targetChecks,
      summary: {
        visibleTextPairs: contrastChecks.length,
        visibleTargets: targetChecks.length,
        minimumTextContrast:
          contrastChecks.length > 0
            ? Math.min(...contrastChecks.map((check) => check.ratio))
            : null,
      },
    }
  }, contextSelector)
}

async function auditFitAndClipping(page, contextSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector)
    if (!root) throw new Error(`Provide the fit context: ${selector}.`)
    const issues = []
    const documentRoot = document.documentElement
    if (documentRoot.scrollWidth - documentRoot.clientWidth > 1) {
      issues.push({
        kind: 'page-overflow-x',
        scrollWidth: documentRoot.scrollWidth,
        clientWidth: documentRoot.clientWidth,
      })
    }
    if (documentRoot.scrollHeight - documentRoot.clientHeight > 1) {
      issues.push({
        kind: 'page-overflow-y',
        scrollHeight: documentRoot.scrollHeight,
        clientHeight: documentRoot.clientHeight,
      })
    }
    const scrollContainers = []
    for (const element of [root, ...root.querySelectorAll('*')]) {
      if (
        !(element instanceof HTMLElement) ||
        element.getClientRects().length === 0
      ) {
        continue
      }
      const style = getComputedStyle(element)
      const scrollX = element.scrollWidth - element.clientWidth > 1
      const scrollY = element.scrollHeight - element.clientHeight > 1
      if (
        (scrollX && ['auto', 'scroll'].includes(style.overflowX)) ||
        (scrollY && ['auto', 'scroll'].includes(style.overflowY))
      ) {
        scrollContainers.push({
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          label: element.getAttribute('aria-label'),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        })
      }
    }
    const dialog = root.matches('[role="dialog"]')
      ? root
      : root.querySelector('[role="dialog"]')
    if (dialog instanceof HTMLElement) {
      const rect = dialog.getBoundingClientRect()
      if (rect.top < -1 || rect.left < -1 || rect.right > innerWidth + 1) {
        issues.push({ kind: 'dialog-clipped', rect: rect.toJSON() })
      }
    }
    for (const row of root.querySelectorAll('[role="row"]')) {
      if (!(row instanceof HTMLElement) || row.getClientRects().length === 0)
        continue
      const rowRect = row.getBoundingClientRect()
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      let textNode = walker.nextNode()
      while (textNode) {
        if (textNode.textContent?.trim()) {
          const range = document.createRange()
          range.selectNodeContents(textNode)
          const rect = range.getBoundingClientRect()
          if (
            rect.height > 0 &&
            (rect.top < rowRect.top - 1 || rect.bottom > rowRect.bottom + 1)
          ) {
            issues.push({
              kind: 'row-text-clipped',
              text: textNode.textContent.trim().slice(0, 100),
            })
            break
          }
        }
        textNode = walker.nextNode()
      }
    }
    return { issues, scrollContainers }
  }, contextSelector)
}

async function runSurfaceAudit(page, contextSelector) {
  const axe = await runAxeAudit(page, contextSelector)
  const custom = await runCustomAccessibilityAudit(page, contextSelector)
  const fit = await auditFitAndClipping(page, contextSelector)
  const customContrastClean = !custom.findings.some((finding) =>
    ['text-contrast', 'contrast-unresolved'].includes(finding.kind),
  )
  const resolvedIncomplete = axe.incomplete.filter(
    (finding) => finding.id === 'color-contrast' && customContrastClean,
  )
  const unresolvedIncomplete = axe.incomplete.filter(
    (finding) => !resolvedIncomplete.includes(finding),
  )
  return { axe, custom, fit, resolvedIncomplete, unresolvedIncomplete }
}

/**
 * Wait until one locator holds the document focus.
 *
 * Playwright's `waitFor` accepts only attachment and visibility states, so a
 * focus expectation needs its own bounded poll.
 *
 * @param {{evaluate: Function}} locator
 * @param {string} description - The surface name for the failure message.
 * @param {number} [timeoutMs] - Milliseconds before giving up.
 * @param {number} [intervalMs] - Milliseconds between polls.
 * @throws {Error} On a locator that never takes focus in time.
 */
async function waitForFocus(
  locator,
  description,
  timeoutMs = 10_000,
  intervalMs = 50,
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const focused = await locator.evaluate(
      (element) => element === document.activeElement,
    )
    if (focused) return
    if (Date.now() >= deadline) {
      throw new Error(`Focus ${description} when its surface opens.`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function auditKeyboardFocus(page, mode) {
  if (mode === 'first-run') {
    const dialog = page.getByRole('dialog', { name: 'Welcome to Supraspina' })
    const controls = dialog.locator(
      'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([tabindex="-1"]), select:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled):not([tabindex="-1"]), a[href]:not([tabindex="-1"])',
    )
    const count = await controls.count()
    if (count === 0)
      throw new Error('Provide keyboard controls in the first-run dialog.')
    await controls.first().focus()
    await page.keyboard.press('Shift+Tab')
    const wrappedBackward = await controls
      .last()
      .evaluate((element) => element === document.activeElement)
    await page.keyboard.press('Tab')
    const wrappedForward = await controls
      .first()
      .evaluate((element) => element === document.activeElement)
    if (!wrappedBackward || !wrappedForward) {
      throw new Error('Wrap keyboard focus within the first-run dialog.')
    }
    return {
      surface: 'first-run-dialog',
      count,
      wrappedBackward,
      wrappedForward,
    }
  }

  const trigger = page.getByRole('button', { name: 'Open command palette' })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  await dialog.waitFor({ state: 'visible' })
  const query = dialog.getByRole('combobox', { name: 'Command palette query' })
  await query.waitFor({ state: 'visible' })
  await waitForFocus(query, 'the command palette query')
  const contained = []
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab')
    contained.push(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    )
  }
  if (contained.some((value) => !value)) {
    throw new Error('Contain keyboard focus within the command palette.')
  }
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  const restored = await trigger.evaluate(
    (element) => element === document.activeElement,
  )
  if (!restored)
    throw new Error('Restore trigger focus after closing the command palette.')

  await page.keyboard.press('Tab')
  const focusIndicator = await page.evaluate(() => {
    const element = document.activeElement
    if (!(element instanceof HTMLElement)) return null
    const style = getComputedStyle(element)
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role'),
      label: element.getAttribute('aria-label'),
      focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
    }
  })
  if (
    focusIndicator === null ||
    !focusIndicator.focusVisible ||
    ((focusIndicator.outlineStyle === 'none' ||
      focusIndicator.outlineWidth === '0px') &&
      focusIndicator.boxShadow === 'none')
  ) {
    throw new Error(
      `Show a visible sequential-focus indicator: ${JSON.stringify(focusIndicator)}.`,
    )
  }
  return { surface: 'command-palette', contained, restored, focusIndicator }
}

async function auditMoreMenuKeyboard(page) {
  const navigation = page.getByRole('navigation', { name: 'Primary' })
  if (!(await navigation.isVisible().catch(() => false))) {
    return {
      applicable: false,
      reason: 'Render the Primary navigation only with an open project.',
    }
  }
  const more = navigation.locator('button[aria-haspopup="menu"]')
  if (!(await more.isVisible().catch(() => false))) {
    return { applicable: false, reason: 'Fit all routes directly.' }
  }
  await more.focus()
  await page.keyboard.press('ArrowDown')
  const menu = page.getByRole('menu', { name: 'More workspaces' })
  await menu.waitFor({ state: 'visible' })
  const items = menu.getByRole('menuitem')
  const itemCount = await items.count()
  const firstFocused = await items
    .first()
    .evaluate((element) => element === document.activeElement)
  await page.keyboard.press('End')
  const lastFocused = await items
    .last()
    .evaluate((element) => element === document.activeElement)
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  const restored = await more.evaluate(
    (element) => element === document.activeElement,
  )
  if (!firstFocused || !lastFocused || !restored) {
    throw new Error(
      'Complete More workspaces menu keyboard behavior successfully.',
    )
  }
  return {
    applicable: true,
    itemCount,
    firstFocused,
    lastFocused,
    restored,
  }
}

async function captureRepeats(page, directory, basename, repeats) {
  const screenshots = []
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const file = path.join(
      directory,
      `${basename}-repeat-${String(repeat).padStart(2, '0')}.png`,
    )
    await page.screenshot({ path: file, fullPage: false })
    screenshots.push(file)
  }
  return screenshots
}

function auditFailureMessages(audit, options) {
  const messages = []
  for (const finding of audit.axe.violations) {
    messages.push(`AXE ${finding.id} (${finding.nodes.length} nodes)`)
  }
  if (options.failOnAxeIncomplete) {
    for (const finding of audit.unresolvedIncomplete) {
      messages.push(
        `AXE INCOMPLETE ${finding.id} (${finding.nodes.length} nodes)`,
      )
    }
  }
  for (const finding of audit.custom.findings) {
    messages.push(
      `CUSTOM ${finding.kind}: ${finding.target ?? finding.text ?? ''}`,
    )
  }
  for (const issue of audit.fit.issues) {
    messages.push(`FIT ${issue.kind}`)
  }
  return messages
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function sanitisedManifest(options) {
  return {
    ...options,
    target: {
      ...options.target,
      envKeys: Object.keys(options.target.env).sort(),
      env: undefined,
    },
  }
}

/**
 * Run visible Electron acceptance across every configured window and route.
 *
 * @param {object} options - The normalized acceptance options.
 * @param {object} [dependencies] - Injected launch dependencies, such as
 *   `launch`.
 * @returns {Promise<object>} The complete visible-acceptance report.
 * @throws {Error} On a launch, rendering, accessibility, interaction, or
 *   cleanup failure.
 */
async function run(options, dependencies = {}) {
  const launch =
    dependencies.launch ?? ((launchOptions) => electron.launch(launchOptions))
  const startedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    runId: options.runId,
    ok: false,
    startedAt,
    finishedAt: null,
    visibleAcceptance: true,
    interactionContract: {
      persistentCallerProfile: true,
      renderedControlProjectOpening: true,
      renderedControlRouteTraversal: true,
      rendererEvaluationLimitedToInspection: true,
    },
    manifest: sanitisedManifest(options),
    firstRun: null,
    projectOpen: null,
    freesurferConfiguration: null,
    fonts: null,
    geometries: [],
    keyboard: [],
    surfaces: [],
    eventSummary: null,
    errors: [],
    failure: null,
  }
  const collector = createEventCollector()
  let application = null
  let closing = false
  try {
    await fs.mkdir(options.profile, { recursive: true })
    await fs.mkdir(options.outdir, { recursive: true })
    await fs.mkdir(path.join(options.outdir, 'audits'), { recursive: true })
    await fs.mkdir(path.join(options.outdir, 'screenshots'), {
      recursive: true,
    })
    application = await launch(buildLaunchOptions(options))
    collector.attachApplication(application)
    application.on('close', () => {
      if (!closing) {
        collector.events.crashes.push(
          timestamped({ source: 'application', detail: 'unexpected close' }),
        )
      }
    })
    const page = await application.firstWindow({ timeout: options.timeoutMs })
    collector.attachPage(page)
    await waitForRenderer(page, options)
    await assertVisibleWindow(application, page)
    report.firstRun = await handleFirstRun(page, options)

    if (['populated', 'completed'].includes(options.stage.mode)) {
      report.projectOpen = await openRecentProjectViaUi(
        page,
        options.stage.recentProject,
        options.timeoutMs,
      )
    }

    if (options.stage.freesurferConfiguration !== null) {
      await setWindowGeometry(application, options.windows[0])
      await page.waitForTimeout(options.settleMs)
      report.freesurferConfiguration = await configureFreesurferViaUi(
        page,
        options,
      )
      report.freesurferConfiguration.screenshots = await captureRepeats(
        page,
        path.join(options.outdir, 'screenshots'),
        `${options.windows[0].name}-diagnostics-license-configured`,
        options.screenshotRepeats,
      )
    }

    report.fonts = await auditFonts(page)
    const failedFontChecks = Object.entries(report.fonts.checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
    if (failedFontChecks.length > 0) {
      report.errors.push(`FONT ${failedFontChecks.join(', ')}`)
    }

    for (const geometry of options.windows) {
      await setWindowGeometry(application, geometry)
      await page.waitForTimeout(options.settleMs)
      await assertVisibleWindow(application, page)
      const geometryEvidence = await collectGeometry(
        application,
        page,
        geometry,
      )
      report.geometries.push(geometryEvidence)

      if (options.stage.mode === 'first-run') {
        report.keyboard.push(await auditKeyboardFocus(page, 'first-run'))
        const contextSelector = '[role="dialog"][aria-modal="true"]'
        const audit = await runSurfaceAudit(page, contextSelector)
        const auditFile = path.join(
          options.outdir,
          'audits',
          `${geometry.name}-first-run.json`,
        )
        await writeJson(auditFile, audit)
        const screenshots = await captureRepeats(
          page,
          path.join(options.outdir, 'screenshots'),
          `${geometry.name}-first-run`,
          options.screenshotRepeats,
        )
        const errors = auditFailureMessages(audit, options)
        report.errors.push(
          ...errors.map((error) => `${geometry.name}/first-run ${error}`),
        )
        report.surfaces.push({
          geometry: geometry.name,
          route: 'First run',
          navigationMethod: 'startup-modal',
          auditFile,
          screenshots,
          errors,
        })
        continue
      }

      report.keyboard.push(await auditKeyboardFocus(page, options.stage.mode))
      report.keyboard.push(await auditMoreMenuKeyboard(page))

      const routes =
        options.stage.mode === 'empty'
          ? [CANONICAL_ROUTES[0]]
          : CANONICAL_ROUTES
      for (const route of routes) {
        const navigation = await openRouteViaUi(page, route)
        await page.waitForTimeout(options.settleMs)
        const expectations = await assertRouteExpectations(
          page,
          route,
          options.expectations,
        )
        await page.evaluate(async () => {
          await document.fonts.ready
        })
        const audit = await runSurfaceAudit(page, 'body')
        const auditFile = path.join(
          options.outdir,
          'audits',
          `${geometry.name}-${route.slug}.json`,
        )
        await writeJson(auditFile, audit)
        const screenshots = await captureRepeats(
          page,
          path.join(options.outdir, 'screenshots'),
          `${geometry.name}-${route.slug}`,
          options.screenshotRepeats,
        )
        const errors = auditFailureMessages(audit, options)
        report.errors.push(
          ...errors.map((error) => `${geometry.name}/${route.label} ${error}`),
        )
        report.surfaces.push({
          geometry: geometry.name,
          route: route.label,
          ...navigation,
          expectations,
          auditFile,
          screenshots,
          errors,
        })
      }
    }

    await collector.flush()
    const errorConsole = collectConsoleErrors(collector.events)
    if (errorConsole.length > 0) {
      report.errors.push(`EVENT console errors: ${errorConsole.length}`)
    }
    if (collector.events.pageErrors.length > 0) {
      report.errors.push(
        `EVENT page errors: ${collector.events.pageErrors.length}`,
      )
    }
    if (collector.events.requestFailures.length > 0) {
      report.errors.push(
        `EVENT request failures: ${collector.events.requestFailures.length}`,
      )
    }
    if (collector.events.errorResponses.length > 0) {
      report.errors.push(
        `EVENT error responses: ${collector.events.errorResponses.length}`,
      )
    }
    if (collector.events.crashes.length > 0) {
      report.errors.push(`EVENT crashes: ${collector.events.crashes.length}`)
    }
    report.ok = report.errors.length === 0
  } catch (error) {
    report.failure = serialiseError(error)
    report.errors.push(`DRIVER ${report.failure.message}`)
  } finally {
    closing = true
    if (application) await application.close().catch(() => undefined)
    await collector.flush()
    report.finishedAt = new Date().toISOString()
    report.eventSummary = Object.fromEntries(
      Object.entries(collector.events).map(([name, entries]) => [
        name,
        entries.length,
      ]),
    )
    await writeJson(path.join(options.outdir, 'events.json'), collector.events)
    await writeJson(path.join(options.outdir, 'report.json'), report)
  }
  if (!report.ok) {
    const error = new Error(
      `Resolve ${report.errors.length} visible Electron acceptance finding(s).`,
    )
    error.report = report
    throw error
  }
  return report
}

module.exports = {
  CANONICAL_ROUTES,
  FONT_FACES,
  axeInstallExpression,
  collectConsoleErrors,
  buildLaunchOptions,
  decideRouteEntry,
  FREESURFER_CHOOSERS,
  waitForFocus,
  formatCliFailure,
  loadManifest,
  parseArgs,
  run,
  serialiseError,
  validateManifest,
}

if (require.main === module) {
  let cli
  try {
    cli = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 2
  }
  if (cli) {
    void loadManifest(cli.manifest)
      .then((options) => run(options))
      .then((report) => {
        process.stdout.write(
          `${JSON.stringify({ ok: true, report: path.join(report.manifest.outdir, 'report.json') })}\n`,
        )
      })
      .catch((error) => {
        process.stderr.write(`${formatCliFailure(error)}\n`)
        process.exitCode = 1
      })
  }
}
