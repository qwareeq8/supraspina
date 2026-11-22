import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  CANONICAL_ROUTES,
  FREESURFER_CHOOSERS,
  FONT_FACES,
  axeInstallExpression,
  buildLaunchOptions,
  collectConsoleErrors,
  decideRouteEntry,
  formatCliFailure,
  parseArgs,
  serialiseError,
  validateManifest,
  waitForFocus,
} = require('./real-electron-ui-check.cjs')

test('the CLI failure diagnostic is imperative and punctuated', () => {
  assert.equal(
    formatCliFailure(new Error('Provide the application window.')),
    'Resolve the real Electron UI check failure: Provide the application window.',
  )
})

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'ubuntu24-source-first-run',
    target: {
      id: 'source',
      kind: 'source',
      executable: '/opt/supraspina/node_modules/electron/dist/electron',
      cwd: '/opt/supraspina',
      args: ['.'],
      env: { LIBGL_ALWAYS_SOFTWARE: '1' },
    },
    profile: '/home/sci/profiles/source',
    outdir: '/home/sci/evidence/source-first-run',
    display: ':0',
    stage: { mode: 'first-run' },
    windows: [
      { name: 'minimum', width: 1100, height: 700, x: 25, y: 30 },
      { name: 'large', width: 1400, height: 850, x: 10, y: 10 },
    ],
    screenshotRepeats: 2,
    ...overrides,
  }
}

test('parseArgs requires one explicitly absolute manifest path', () => {
  assert.deepEqual(parseArgs(['--manifest=/tmp/acceptance.json']), {
    manifest: '/tmp/acceptance.json',
  })
  assert.deepEqual(parseArgs(['/tmp/acceptance.json']), {
    manifest: '/tmp/acceptance.json',
  })
  assert.throws(() => parseArgs([]), /absolute --manifest path/i)
  assert.throws(() => parseArgs(['acceptance.json']), /as an absolute path/i)
  assert.throws(
    () => parseArgs(['--manifest', '/tmp/a.json', '--extra']),
    /unknown option/i,
  )
  assert.throws(
    () => parseArgs(['--manifest=/tmp/a.json', '--manifest=/tmp/b.json']),
    /Provide --manifest only once/i,
  )
})

test('validateManifest normalizes a visible source launch and safe defaults', () => {
  const options = validateManifest(manifest())

  assert.equal(options.target.kind, 'source')
  assert.equal(options.target.executable, manifest().target.executable)
  assert.equal(options.profile, manifest().profile)
  assert.equal(options.display, ':0')
  assert.equal(options.stage.mode, 'first-run')
  assert.equal(options.stage.firstRunAction, 'preserve')
  assert.equal(options.timeoutMs, 60_000)
  assert.equal(options.settleMs, 750)
  assert.equal(options.failOnAxeIncomplete, true)
  assert.deepEqual(
    options.windows.map(({ name, width, height }) => ({ name, width, height })),
    [
      { name: 'minimum', width: 1100, height: 700 },
      { name: 'large', width: 1400, height: 850 },
    ],
  )
})

test('validateManifest accepts every explicit release target format', () => {
  const executables = {
    source: '/opt/supraspina/node_modules/electron/dist/electron',
    unpacked: '/opt/supraspina/linux-unpacked/supraspina',
    appimage: '/opt/supraspina/Supraspina.AppImage',
    'deb-installed': '/usr/bin/supraspina',
  }
  for (const [kind, executable] of Object.entries(executables)) {
    const options = validateManifest(
      manifest({
        target: {
          id: kind,
          kind,
          executable,
          args: kind === 'source' ? ['/opt/supraspina'] : [],
        },
      }),
    )
    assert.equal(options.target.kind, kind)
    assert.equal(options.target.executable, executable)
  }
})

test('validateManifest rejects launch paths and switches that weaken the contract', () => {
  assert.throws(
    () => validateManifest(manifest({ profile: 'relative/profile' })),
    /Provide profile as an absolute path/i,
  )
  assert.throws(
    () =>
      validateManifest(
        manifest({
          target: { ...manifest().target, executable: 'electron' },
        }),
      ),
    /Provide target\.executable as an absolute path/i,
  )
  assert.throws(
    () =>
      validateManifest(
        manifest({
          target: { ...manifest().target, args: ['.', '--headless'] },
        }),
      ),
    /Do not use headless launch arguments/i,
  )
  assert.throws(
    () =>
      validateManifest(
        manifest({
          target: {
            ...manifest().target,
            args: ['.', '--user-data-dir=/tmp/other'],
          },
        }),
      ),
    /Do not override the manifest profile/i,
  )
  assert.throws(
    () =>
      validateManifest(
        manifest({
          target: {
            ...manifest().target,
            env: { ELECTRON_RUN_AS_NODE: '1' },
          },
        }),
      ),
    /Do not override ELECTRON_RUN_AS_NODE/i,
  )
  assert.throws(
    () =>
      validateManifest(
        manifest({
          target: {
            ...manifest().target,
            env: { SUPRASPINA_USE_MOCK_DATA: '1' },
          },
        }),
      ),
    /Do not override SUPRASPINA_USE_MOCK_DATA/i,
  )
  assert.throws(
    () =>
      validateManifest(
        manifest({
          target: {
            ...manifest().target,
            args: ['.', '--package-smoke'],
          },
        }),
      ),
    /state-substitution launch argument/i,
  )
  for (const argument of [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-zygote-sandbox',
    '--disable-gpu-sandbox',
  ]) {
    assert.throws(
      () =>
        validateManifest(
          manifest({
            target: { ...manifest().target, args: ['.', argument] },
          }),
        ),
      /sandbox-disabling launch argument/i,
      `Reject ${argument}.`,
    )
  }
})

test('populated and completed stages require a recent project opened by UI', () => {
  for (const mode of ['populated', 'completed']) {
    assert.throws(
      () => validateManifest(manifest({ stage: { mode } })),
      new RegExp(`Provide stage\\.recentProject for ${mode} stages`, 'i'),
    )
    const options = validateManifest(
      manifest({
        stage: {
          mode,
          recentProject: {
            path: '/home/sci/projects/pilot/supraspina.project.json',
            name: 'pilot',
          },
        },
      }),
    )
    assert.equal(options.stage.recentProject.path.endsWith('.json'), true)
  }
})

test('the FreeSurfer picker requires a loaded project and two absolute paths', () => {
  assert.throws(
    () =>
      validateManifest(
        manifest({
          stage: {
            mode: 'first-run',
            freesurferConfiguration: {
              installationRoot: '/usr/local/freesurfer/8.2.0',
              licensePath: '/home/sci/Downloads/license.txt',
            },
          },
        }),
      ),
    /only with a populated or completed project stage/i,
  )
  const options = validateManifest(
    manifest({
      stage: {
        mode: 'populated',
        recentProject: {
          path: '/home/sci/projects/pilot/supraspina.project.json',
          name: 'pilot',
        },
        freesurferConfiguration: {
          installationRoot: '/usr/local/freesurfer/8.2.0',
          licensePath: '/home/sci/Downloads/license.txt',
          xdotool: '/opt/acceptance/bin/xdotool',
          expectedInitialState: 'not-configured',
        },
      },
    }),
  )

  assert.deepEqual(options.stage.freesurferConfiguration, {
    installationRoot: '/usr/local/freesurfer/8.2.0',
    licensePath: '/home/sci/Downloads/license.txt',
    xdotool: '/opt/acceptance/bin/xdotool',
    expectedInitialState: 'not-configured',
    dialogTimeoutMs: 30_000,
  })
  assert.throws(
    () =>
      validateManifest(
        manifest({
          stage: {
            mode: 'populated',
            recentProject: {
              path: '/home/sci/projects/pilot/supraspina.project.json',
            },
            freesurferConfiguration: {
              installationRoot: 'freesurfer/8.2.0',
              licensePath: '/home/sci/Downloads/license.txt',
            },
          },
        }),
      ),
    /Provide stage\.freesurferConfiguration\.installationRoot as an absolute path/i,
  )
})

test('route expectations are limited to the complete canonical route set', () => {
  assert.equal(CANONICAL_ROUTES.length, 13)
  assert.deepEqual(
    CANONICAL_ROUTES.map((route) => route.label),
    [
      'Setup',
      'Dashboard',
      'Subjects',
      'Runs',
      'Logs',
      'QC review',
      'Input QC',
      'Pipeline',
      'Results',
      'Analysis',
      'Registry',
      'Diagnostics',
      'Settings',
    ],
  )
  assert.throws(
    () =>
      validateManifest(
        manifest({ expectations: { HiddenRoute: { visibleText: ['x'] } } }),
      ),
    /unknown .*route/i,
  )
  const options = validateManifest(
    manifest({
      expectations: {
        Results: {
          visibleText: ['Output files'],
          absentText: ['Unhandled exception'],
        },
      },
    }),
  )
  assert.deepEqual(options.expectations.Results.visibleText, ['Output files'])
})

test('the launch configuration uses the supplied executable, display, and profile', () => {
  const options = validateManifest(manifest())
  const launch = buildLaunchOptions(options, {
    PATH: '/usr/bin',
    DISPLAY: ':77',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_RENDERER_URL: 'http://example.invalid',
  })

  assert.equal(launch.executablePath, options.target.executable)
  assert.equal(launch.cwd, '/opt/supraspina')
  assert.deepEqual(launch.args, [
    '--user-data-dir=/home/sci/profiles/source',
    '.',
  ])
  assert.equal(launch.env.DISPLAY, ':0')
  assert.equal(launch.env.LIBGL_ALWAYS_SOFTWARE, '1')
  assert.equal('ELECTRON_RUN_AS_NODE' in launch.env, false)
  assert.equal('ELECTRON_RENDERER_URL' in launch.env, false)
  assert.equal('headless' in launch, false)
})

test('the launch configuration keeps the Chromium sandbox enabled', () => {
  const launch = buildLaunchOptions(validateManifest(manifest()), {
    PATH: '/usr/bin',
  })

  // Playwright only skips its Linux `--no-sandbox` prefix when the launch
  // options ask for the sandbox explicitly.
  assert.equal(launch.chromiumSandbox, true)
  assert.deepEqual(
    launch.args.filter((argument) => /sandbox/i.test(argument)),
    [],
  )
})

test('an empty stage reaches the displayed Setup route without the nav', () => {
  // The shell renders the Primary navigation only with a project open, so an
  // empty-stage run must accept the Setup route it already displays.
  assert.equal(
    decideRouteEntry({
      navigationVisible: false,
      headingVisible: true,
      label: 'Setup',
    }),
    'already-displayed',
  )
  // A populated shell keeps using its rendered navigation controls even when
  // the requested route is the one already on screen.
  assert.equal(
    decideRouteEntry({
      navigationVisible: true,
      headingVisible: true,
      label: 'Dashboard',
    }),
    'primary-navigation',
  )
  assert.equal(
    decideRouteEntry({
      navigationVisible: true,
      headingVisible: false,
      label: 'Results',
    }),
    'primary-navigation',
  )
  assert.throws(
    () =>
      decideRouteEntry({
        navigationVisible: false,
        headingVisible: false,
        label: 'Results',
      }),
    /Display the Results route or the Primary navigation that opens it\./,
  )
})

test('the font contract enumerates the exact 18 local faces', () => {
  assert.equal(FONT_FACES.length, 18)
  assert.deepEqual(
    new Set(FONT_FACES.map((face) => face[3])),
    new Set(['WebCM Sans 10', 'WebCM Serif 10', 'WebCM Mono 10']),
  )
  for (const family of ['WebCM Sans 10', 'WebCM Serif 10', 'WebCM Mono 10']) {
    assert.equal(FONT_FACES.filter((face) => face[3] === family).length, 6)
  }
})

test('the driver source contains no renderer-state or bridge action bypass', async () => {
  const source = await readFile(
    new URL('./real-electron-ui-check.cjs', import.meta.url),
    'utf8',
  )
  const forbidden = [
    ['local', 'Storage'].join('') + String.raw`\s*\.\s*setItem`,
    String.raw`(?:globalThis|window)\s*\.\s*supraspina`,
    String.raw`\.project\s*\.\s*open\s*\(`,
    String.raw`\.pipeline\s*\.\s*previewCommand\s*\(`,
    String.raw`page\s*\.\s*addInitScript\s*\(`,
    // The renderer serves `script-src 'self'`, which refuses an injected
    // inline <script>, so an added script tag can never load the auditor.
    String.raw`page\s*\.\s*addScriptTag\s*\(`,
    // Locator.waitFor accepts only attachment and visibility states, so any
    // other state silently turns an audit step into a guaranteed failure.
    String.raw`waitFor\(\{\s*state:\s*'(?!attached|detached|visible|hidden)`,
  ]
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, new RegExp(pattern))
  }
  assert.match(source, /async function openRecentProjectViaUi\(/)
  assert.match(source, /async function openRouteViaUi\(/)
  assert.match(source, /async function configureFreesurferViaUi\(/)
  assert.match(
    source,
    /getByRole\('button', \{ name: 'Open a saved project' \}\)/,
  )
  assert.match(source, /getByRole\('navigation', \{ name: 'Primary' \}\)/)
  assert.match(source, /const FREESURFER_CHOOSERS = Object\.freeze\(/)
  assert.match(source, /name: 'Project actions'/)
  assert.doesNotMatch(source, /mkdtemp\s*\(/)
  assert.doesNotMatch(source, /fs\.rm\s*\(\s*options\.profile/)
})

test('the FreeSurfer chooser names match the Diagnostics screen source', async () => {
  const source = await readFile(
    new URL('../src/renderer/screens/DiagnosticsScreen.tsx', import.meta.url),
    'utf8',
  )
  // The screen composes each chooser name from a Replace/Choose alternative
  // and a shared suffix, so read both spellings back out of the source. The
  // native chooser itself stays undriven here because xdotool is absent, which
  // leaves this source-level contract as the only guard on the names.
  const rendered = new Set()
  const pattern =
    /ariaLabel=\{`\$\{[^}]*\?\s*'([^']+)'\s*:\s*'([^']+)'\s*\}([^`]*)`\}/g
  for (const [, replaceLabel, chooseLabel, suffix] of source.matchAll(
    pattern,
  )) {
    rendered.add(`${replaceLabel}${suffix}`)
    rendered.add(`${chooseLabel}${suffix}`)
  }
  assert.equal(rendered.size >= 4, true)

  assert.deepEqual(
    FREESURFER_CHOOSERS.map((chooser) => chooser.setting),
    ['installationRoot', 'licensePath'],
  )
  for (const chooser of FREESURFER_CHOOSERS) {
    assert.equal(
      rendered.has(chooser.chooseName),
      true,
      `Render ${chooser.chooseName}.`,
    )
    assert.equal(
      rendered.has(chooser.replaceName),
      true,
      `Render ${chooser.replaceName}.`,
    )
    assert.match(source, new RegExp(`aria-label="${chooser.groupName}"`))
    assert.match(chooser.chooseName, chooser.anyName)
    assert.match(chooser.replaceName, chooser.anyName)
  }
  // The screen never renders these generic names, so the driver must not
  // target them.
  assert.equal(rendered.has('Choose FreeSurfer installation root'), false)
  assert.equal(rendered.has('Choose FreeSurfer license file'), false)
})

test('serialiseError preserves actionable name, message, and stack', () => {
  const result = serialiseError(new TypeError('bad manifest'))
  assert.equal(result.name, 'TypeError')
  assert.equal(result.message, 'bad manifest')
  assert.match(result.stack, /bad manifest/)
})

test('the axe installer evaluates the bundle instead of injecting a script tag', () => {
  const expression = axeInstallExpression('globalThis.axe = { run() {} }')
  assert.match(expression, /^\(\(\) => \{/)
  assert.match(expression, /globalThis\.axe = \{ run\(\) \{\} \}/)
  assert.match(expression, /return typeof globalThis\.axe === 'object'/)
  // A statement-bodied bundle must stay valid, so the wrapper cannot be an
  // expression-only evaluation, and it must report whether the global arrived.
  const evaluate = (source) => {
    delete globalThis.axe
    try {
      return new Function(`return ${axeInstallExpression(source)}`)()
    } finally {
      delete globalThis.axe
    }
  }
  assert.equal(evaluate('globalThis.axe = { run() {} }'), true)
  assert.equal(evaluate('const unused = 1'), false)
})

test('the driver polls for focus because waitFor has no focused state', async () => {
  let polls = 0
  const focusesOnThirdPoll = {
    evaluate: async () => {
      polls += 1
      return polls >= 3
    },
  }
  await waitForFocus(focusesOnThirdPoll, 'the test surface', 1_000, 1)
  assert.equal(polls, 3)

  await assert.rejects(
    waitForFocus({ evaluate: async () => false }, 'the test surface', 30, 1),
    /Focus the test surface when its surface opens\./,
  )
})

test('the console gate counts every error line without a message allowlist', () => {
  const events = {
    rendererConsole: [
      { type: 'log', text: 'ready' },
      { type: 'error', text: 'Renderer failure.' },
    ],
    mainConsole: [
      { type: 'warning', text: 'noisy' },
      {
        type: 'error',
        text:
          "Error occurred in handler for 'supraspina:invoke': Error: Run ENIGMA QC " +
          'under the saved project configuration to review galleries.',
      },
      { type: 'assert', text: 'Assertion failed.' },
    ],
  }

  const collected = collectConsoleErrors(events)

  assert.equal(collected.length, 3)
  assert.deepEqual(
    collected.map((entry) => entry.type),
    ['error', 'error', 'assert'],
  )
  assert.deepEqual(collectConsoleErrors({}), [])
  assert.deepEqual(
    collectConsoleErrors({
      rendererConsole: [{ type: 'log' }],
      mainConsole: [{ type: 'info' }],
    }),
    [],
  )
})
