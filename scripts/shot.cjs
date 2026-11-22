/**
 * Captures screenshots and checks renderer fit in a headless browser.
 *
 * The harness serves the built renderer from out/renderer over a throwaway HTTP
 * server by default, and accepts only an unauthenticated loopback source server
 * through SUPRASPINA_RENDERER_URL. It drives Chromium through Playwright and
 * captures a named screen from the in-process mock API. Run `npm run build`
 * first when serving out/renderer.
 *
 * The harness opens a synthetic project through the in-app project switcher
 * before navigating the gated shell. Pass --no-project to capture the
 * no-project Setup surface.
 *
 * Install the browser that matches the Playwright version in package.json:
 *   ./node_modules/.bin/playwright install chromium
 *
 * Run one of these commands:
 *   npm run screenshots -- <ScreenLabel> <outBasename> [flags]
 *   node scripts/shot.cjs <ScreenLabel> <outBasename>
 *        [--light|--dark|--system] [--hc]
 *        [--density Compact|Cozy|Comfortable] [--no-project] [--firstrun]
 *        [--documentation]
 *        [--text-scale 100|115|135] [--reduced-motion]
 *        [--state populated|loading|cohort-loading|runtime-restoring|
 *                 registration-running|validation|blocking|error|long|sites|
 *                 empty|no-match|analysis-grid]
 *        [--query <text>] [--press <accessible name>]
 *        [--menu open|more] [--dialog run]
 *        [--w 1138] [--h 839] [--dsf 2] [--fit] [--wait 600]
 *
 * Pass the exact top-navigation button label as <ScreenLabel>: Setup, Dashboard,
 * Subjects, Runs, Logs, "QC review", "Input QC", Pipeline, Results, Analysis,
 * Registry, Diagnostics, or Settings.
 * Write screenshots/<outBasename>.png, or override it with SUPRASPINA_SHOT_OUTDIR.
 *
 * The --state fixtures:
 *   populated             The synthetic cohort, runs, logs, and artifacts.
 *   loading               The environment check never answers.
 *   cohort-loading        The environment check, subject discovery, and the
 *                         runtime restore never answer, as in the first
 *                         seconds after a launch: the cohort is unknown, not
 *                         empty.
 *   runtime-restoring     Subject discovery answers, but the runtime restore
 *                         never does, as in the tens of seconds after a
 *                         launch on a large project: the cohort is counted
 *                         and the run history is still restoring.
 *   registration-running  A surface registration check is running: a third
 *                         of the checked subjects are pending again, so QC
 *                         review shows the running queue line and rail.
 *   validation            Project validation reports an error.
 *   blocking              Command preview fails with a blocking error.
 *   error                 The environment check fails.
 *   long                  Long identifiers, notes, and errors.
 *   empty                 A project with no subjects, runs, logs, registry
 *                         rows, or artifacts.
 *   analysis-grid         The populated fixture whose Analysis lists the
 *                         synthetic v2 results first; Analysis opens the
 *                         within-group battery on its Grid tab.
 *   sites                 The populated cohort on two sites, Site B without
 *                         controls, with BrainCharts and the
 *                         z-score comparisons on and their outputs listed.
 *   no-match              The populated fixture with a search that matches
 *                         nothing typed into the screen's search box
 *                         (Subjects, Logs, and Results); --query sets the
 *                         text.
 * --press clicks the visible toggle or disclosure with that exact accessible
 * name (a button, switch, checkbox, radio, or tab) after navigation, checks
 * that its aria-pressed, aria-expanded, aria-checked, or aria-selected state
 * turned true, and captures it pressed; for example --press "Show JSON"
 * on Settings. --menu opens the project or More menu, and --dialog run opens
 * the run confirmation, each after the keyboard checks.
 *
 * --light, --dark, and --system choose that theme in Settings before the
 * capture. With --system the harness also switches the emulated operating
 * system color scheme and checks that the app follows it.
 */
'use strict'

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  console.error(
    `Run screenshots with Node.js 22 or later; found ${process.versions.node}.`,
  )
  process.exit(2)
}

const http = require('http')
const fs = require('fs')
const path = require('path')
const AXE_PATH = require.resolve('axe-core/axe.min.js')

let chromium
try {
  ;({ chromium } = require('playwright'))
} catch {
  console.error(
    'Install Playwright before running screenshots:\n' +
      '  npm ci && ./node_modules/.bin/playwright install chromium',
  )
  process.exit(2)
}

const ROOT =
  process.env.SUPRASPINA_RENDERER_ROOT ||
  path.resolve(__dirname, '..', 'out', 'renderer')
const EXTERNAL_RENDERER_URL = process.env.SUPRASPINA_RENDERER_URL || ''
const OUTDIR =
  process.env.SUPRASPINA_SHOT_OUTDIR ||
  path.resolve(__dirname, '..', 'screenshots')
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  if (next && !next.startsWith('--')) return next
  return true
}

const requestedScreen = process.argv[2]
const screen = requestedScreen === 'QC review' ? 'QC Review' : requestedScreen
const outName = process.argv[3] || 'shot'
if (!screen) {
  console.error(
    'Run the screenshot harness with this syntax:\n' +
      '  node scripts/shot.cjs <ScreenLabel> <outBasename> [flags]',
  )
  process.exit(2)
}
const light = arg('light', false)
const dark = arg('dark', false)
const systemTheme = arg('system', false)
const hc = arg('hc', false)
const fit = arg('fit', false)
const noProject = arg('no-project', false)
const firstrun = arg('firstrun', false)
const documentation = arg('documentation', false)
const reducedMotion = arg('reduced-motion', false)
const width = Number(arg('w', 1138))
const height = Number(arg('h', 839))
const dsf = fit ? 1 : Number(arg('dsf', 2))
const settle = Number(arg('wait', 600))
const densityName = arg('density', '')
const textScale = String(arg('text-scale', ''))
const visualState = String(arg('state', 'populated'))
const dialogMode = String(arg('dialog', ''))
const menuMode = String(arg('menu', ''))
const pressName = arg('press', '')
const noMatchQuery = arg('query', 'zz-no-such-item')
if (pressName === true || noMatchQuery === true) {
  console.error('Give --press and --query a value.')
  process.exit(2)
}

function rendererUrlFromEnvironment(value) {
  if (!value) return null
  const parsed = new URL(value)
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('Use an unauthenticated HTTP loopback renderer URL.')
  }
  return parsed.href
}

const srv = http.createServer((q, r) => {
  let p
  try {
    p = decodeURIComponent(new URL(q.url, 'http://127.0.0.1').pathname)
  } catch {
    r.statusCode = 400
    r.end('bad request')
    return
  }
  if (p === '/') p = '/index.html'
  const fp = path.resolve(ROOT, `.${path.normalize(p)}`)
  if (fp !== ROOT && !fp.startsWith(`${ROOT}${path.sep}`)) {
    r.statusCode = 403
    r.end('forbidden')
    return
  }
  fs.readFile(fp, (e, d) => {
    if (e) {
      r.statusCode = 404
      r.end('nf')
      return
    }
    r.setHeader(
      'Content-Type',
      MIME[path.extname(fp)] || 'application/octet-stream',
    )
    r.end(d)
  })
})

async function clickNav(page, label) {
  // The overflow trigger names the open screen, so a match by name alone
  // could open the menu instead of navigating.
  const direct = page
    .getByRole('button', { name: label, exact: true })
    .and(page.locator(':not([aria-haspopup="menu"])'))
    .first()
  if ((await direct.count()) > 0 && (await direct.isVisible())) {
    await direct.click()
  } else {
    await page
      .locator('nav[aria-label="Primary"] button[aria-haspopup="menu"]')
      .click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }
  await page.waitForTimeout(250)
}

/**
 * Wait for the CSS transitions and animations now running to finish.
 *
 * A capture must measure steady-state colors. A theme or density change
 * repaints through finite transitions, and a fixed settle can land in the
 * middle of one. Skip animations that never end, such as running-state pulses,
 * and cap the wait so a capture never blocks on one.
 *
 * @param {import('playwright').Page} page
 * @param {number} [capMs] - The longest wait, in milliseconds.
 */
async function settleAnimations(page, capMs = 2000) {
  await page.evaluate(async (cap) => {
    if (typeof document.getAnimations !== 'function') return
    const finite = document.getAnimations().filter((animation) => {
      if (animation.playState !== 'running') return false
      const timing = animation.effect?.getComputedTiming?.()
      return Number.isFinite(timing?.iterations ?? 1)
    })
    if (finite.length === 0) return
    await Promise.race([
      Promise.allSettled(finite.map((animation) => animation.finished)),
      new Promise((resolve) => setTimeout(resolve, cap)),
    ])
  }, capMs)
}

/** The search box each no-match capture types into, by accessible name. */
const NO_MATCH_SEARCH = {
  Subjects: 'Filter subjects by ID',
  Logs: 'Search logs',
  Results: 'Search',
}

/** Count the rows each empty or no-match capture must not show. */
async function contentRowCount(page, screenName) {
  const selector = {
    Subjects: '[aria-label="Subjects matrix"] [role="row"]:has([role="cell"])',
    Logs: '[data-level]',
    Results: '[aria-label="Output files"] > button',
  }[screenName]
  return selector ? page.locator(selector).count() : null
}

/**
 * Type a search that matches nothing into the screen's search box.
 *
 * @param {import('playwright').Page} page
 * @param {string} screenName - Subjects, Logs, or Results.
 * @param {string} query
 */
async function typeNoMatchSearch(page, screenName, query) {
  const label = NO_MATCH_SEARCH[screenName]
  if (!label) {
    throw new Error(
      `Capture the no-match state on Subjects, Logs, or Results, not ${screenName}.`,
    )
  }
  const input = page.getByLabel(label, { exact: true }).first()
  await input.waitFor({ state: 'visible' })
  await input.fill(query)
  // Let a debounced filter apply before the capture.
  await page.waitForTimeout(500)
  await settleAnimations(page)
}

/**
 * Press the visible toggle or disclosure with this exact accessible name and
 * check that it turned on, so the capture shows its pressed or expanded state.
 *
 * @param {import('playwright').Page} page
 * @param {string} name
 * @returns {Promise<object>} The control's role and state before and after.
 */
async function pressToggle(page, name) {
  const readState = (element) => ({
    pressed: element.getAttribute('aria-pressed'),
    expanded: element.getAttribute('aria-expanded'),
    checked:
      element instanceof HTMLInputElement &&
      ['checkbox', 'radio'].includes(element.type)
        ? String(element.checked)
        : element.getAttribute('aria-checked'),
    selected: element.getAttribute('aria-selected'),
  })
  for (const role of ['button', 'switch', 'checkbox', 'radio', 'tab']) {
    const candidates = page.getByRole(role, { name, exact: true })
    const count = await candidates.count()
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index)
      if (!(await candidate.isVisible())) continue
      const handle = await candidate.elementHandle()
      if (!handle) continue
      const before = await handle.evaluate(readState)
      await candidate.click()
      // Keep hover styling off the captured control.
      await page.mouse.move(0, 0)
      await page.waitForTimeout(300)
      await settleAnimations(page)
      const after = await handle.evaluate(readState)
      const turnedOn = Object.keys(after).find(
        (key) => after[key] === 'true' && before[key] !== 'true',
      )
      if (!turnedOn) {
        throw new Error(
          `Press a toggle or disclosure: "${name}" did not turn aria-pressed, aria-expanded, aria-checked, or aria-selected true: ${JSON.stringify({ before, after })}.`,
        )
      }
      return { role, name, attribute: `aria-${turnedOn}`, before, after }
    }
  }
  throw new Error(
    `Name a visible toggle or disclosure to press, not "${name}".`,
  )
}

async function activatePreference(locator, label) {
  await locator.waitFor({ state: 'visible' })
  await locator.click()
  const active = await locator.evaluate((element) => {
    if (element instanceof HTMLInputElement) return element.checked
    return (
      element.getAttribute('aria-checked') === 'true' ||
      element.getAttribute('aria-pressed') === 'true'
    )
  })
  if (!active) throw new Error(`Activate the ${label} preference.`)
}

// Open a synthetic project to reveal the gated navigation. Patch project.open to
// return a rooted configuration, and return its path from fs.chooseFile so Browse
// routes through both APIs.
async function openSyntheticProject(page, stateName, documentationMode) {
  await page.evaluate(
    async ({ requestedState, documentationMode }) => {
      const api = window.supraspina
      if (!api) return
      const projectPath = '/data/projects/example-study/supraspina.project.json'
      const base = await api.project.open({ path: projectPath, epoch: 1 })
      base.cfg.paths.projectRoot = '/data/projects/example-study'
      base.cfg.project.name = documentationMode
        ? 'Synthetic documentation study'
        : 'example-study'
      api.project.open = async ({ epoch }) => {
        const loaded = JSON.parse(JSON.stringify(base))
        loaded.project.epoch = epoch
        return loaded
      }
      api.fs.chooseFile = async () => projectPath
      // Seed a deterministic demo cohort because the mock defaults to an empty
      // cohort. Mirror makeMockCohort (Mulberry32, seed 17) to show stable, realistic
      // matrix data, dashboard roll-ups, and run-scope labels.
      const N = documentationMode ? 12 : 24
      let a = 17 | 0
      const rng = () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const COHORTS = ['CTRL', 'SCI_nNP', 'SCI_P']
      const AIS = ['A', 'B', 'C', 'D']
      const FAIL = [
        'oom_killed',
        'License check failed',
        'segfault',
        'no such file',
      ]
      const now = Date.parse('2026-07-22T16:00:00.000Z')
      // Mark a step done only after every matrix column it advances completes.
      // Preserve realistic cross-step dependency gating on the Runs screen.
      const STEP_COLS = {
        deface: [],
        recon: [0],
        enigma: [1, 2, 3],
        outliers: [],
        features: [4],
        age: [4],
        pybrainage: [5],
        clinical: [7],
        brainpad: [7],
        aggregate: [8],
        final: [9],
        braincharts: [6],
        zstats: [],
      }
      // The BrainCharts column (index 6) draws no random state, so it does
      // not shift the seeded states of the other columns.
      const NORM_COLUMN = 6
      const withNormCell = (cells, cell) => [
        ...cells.slice(0, NORM_COLUMN),
        cell,
        ...cells.slice(NORM_COLUMN),
      ]
      const subjects = []
      for (let i = 0; i < N; i++) {
        const cohort = COHORTS[Math.floor(rng() * 3)]
        const isSci = cohort.startsWith('SCI')
        const cells = []
        let stop = false
        let cursor = now - Math.floor(rng() * 7_200_000)
        for (let k = 0; k < 9; k++) {
          let st
          if (stop) {
            st = 'pending'
          } else {
            const r = rng()
            if (r < 0.62) st = 'done'
            else if (r < 0.74) st = 'failed'
            else if (r < 0.82) st = 'running'
            else if (r < 0.86) st = 'skipped'
            else st = 'pending'
            if (st === 'failed' || st === 'running' || st === 'pending')
              stop = true
            // Only recon-all (column 0) is a subject-scope stage. A cohort
            // stage's job fails for every subject at once, so one subject's
            // cohort column never fails alone; as in makeMockCohort, the
            // draw stands for a blocked cell.
            if (st === 'failed' && k !== 0) st = 'blocked'
          }
          const dur = 5000
          const finished = st === 'done' || st === 'failed' || st === 'skipped'
          cells.push({
            st,
            startedAt: st !== 'pending' ? cursor : null,
            finishedAt: finished ? cursor + dur : null,
            progress: st === 'running' ? Math.floor(rng() * 80) + 10 : null,
            rc: st === 'failed' ? 1 : st === 'done' ? 0 : null,
            err: st === 'failed' ? FAIL[Math.floor(rng() * 4)] : null,
          })
          cursor += dur
        }
        cells.splice(NORM_COLUMN, 0, {
          st: 'pending',
          startedAt: null,
          finishedAt: null,
          progress: null,
          rc: null,
          err: null,
        })
        const qc = rng() < 0.4 ? (rng() < 0.7 ? 'pass' : 'fail') : null
        subjects.push({
          id: `sub-${String(i + 1).padStart(3, '0')}`,
          age: 22 + Math.floor(rng() * 50),
          sex: rng() < 0.5 ? 'M' : 'F',
          cohort,
          ais: isSci ? AIS[Math.floor(rng() * 4)] : null,
          tSinceSci: isSci ? Number((rng() * 8).toFixed(1)) : null,
          cells,
          stepStates: Object.fromEntries(
            Object.entries(STEP_COLS).map(([k, cols]) => [
              k,
              cols.length > 0 && cols.every((c) => cells[c].st === 'done')
                ? 'done'
                : 'pending',
            ]),
          ),
          qc,
          analysisEligible: qc !== 'fail',
          cohortRole:
            cohort === 'CTRL'
              ? 'healthy'
              : cohort === 'SCI_nNP'
                ? 'sci-no-neuropathic-pain'
                : 'sci-neuropathic-pain',
          notes: '',
        })
      }
      // Reshape the seeded cells into one history the app can produce. The
      // seeded draws keep the demographics and QC verdicts. A first run
      // reconstructed and ENIGMA-checked every subject but the newest; after
      // QC review a second run took the analysis cohort through R analysis, so
      // the QC Fail subjects stop after ENIGMA QC. The newest subjects came
      // later: a reconstruction run for two of them failed, and the active
      // run reconstructs the others two at a time, the configured queue
      // size, while the cohort stages wait for all of them.
      const HOUR = 3_600_000
      const MINUTE = 60_000
      const stepStatesOf = (cells) =>
        Object.fromEntries(
          Object.entries(STEP_COLS).map(([key, columns]) => [
            key,
            columns.length > 0 &&
            columns.every((column) => cells[column].st === 'done')
              ? 'done'
              : columns.some((column) => cells[column].st === 'failed')
                ? 'failed'
                : columns.some((column) => cells[column].st === 'running')
                  ? 'running'
                  : 'pending',
          ]),
        )
      const history = documentationMode
        ? null
        : {
            reconStart: now - 56 * HOUR,
            enigmaStart: now - 31.5 * HOUR,
            enigmaEnd: now - 30.5 * HOUR,
            // Each cohort stage of the second run: [start, end] in hours ago.
            cohortStages: {
              outliers: [28, 27.95],
              features: [27.95, 27.7],
              age: [27.7, 27.65],
              pybrainage: [27.65, 27.4],
              clinical: [27.4, 27.37],
              brainpad: [27.37, 27.32],
              aggregate: [27.32, 27.15],
              final: [27.15, 26.9],
            },
            failedStart: now - 7 * HOUR,
            activeStart: now - 5 * HOUR,
            roles: new Map(),
          }
      if (history) {
        const reconDuration = 3 * HOUR
        const cell = (st, startedAt, finishedAt, extra = {}) => ({
          st,
          startedAt,
          finishedAt,
          progress: null,
          rc: st === 'done' ? 0 : null,
          err: null,
          ...extra,
        })
        const pendingCell = () => cell('pending', null, null)
        const cohortCell = (stepKey, offset) => {
          const [start, end] = history.cohortStages[stepKey]
          return cell('done', now - start * HOUR, now - end * HOUR - offset)
        }
        const newcomers = subjects.filter(
          (subject, index) => index > 0 && subject.qc === null,
        )
        const newRoles = [
          'reconDone',
          'reconDone',
          'queued',
          'failed',
          'queued',
          'failed',
          'running',
          'running',
        ]
        for (const [index, subject] of newcomers.entries()) {
          history.roles.set(subject.id, newRoles[index % newRoles.length])
        }
        const firstRun = subjects.filter(
          (subject) => !history.roles.has(subject.id),
        )
        const failedTags = ['oom_killed', 'segfault']
        let failedIndex = 0
        let activeIndex = 0
        for (const subject of subjects) {
          const role = history.roles.get(subject.id) ?? 'firstRun'
          let cells = Array.from({ length: 10 }, pendingCell)
          if (role === 'firstRun') {
            const order = firstRun.indexOf(subject)
            const reconStartedAt =
              history.reconStart +
              20 * MINUTE +
              Math.floor(order / 2) * reconDuration +
              (order % 2) * MINUTE
            cells[0] = cell(
              'done',
              reconStartedAt,
              reconStartedAt + reconDuration - (order % 2) * 6 * MINUTE,
            )
            for (const column of [1, 2, 3]) {
              cells[column] = cell(
                'done',
                history.enigmaStart,
                history.enigmaEnd,
              )
            }
            if (subject.qc !== 'fail') {
              // Stagger the detector stamps by a second per subject, so the
              // first subject reads as the most recently updated.
              const offset = order * 1_000
              cells[4] = cohortCell('features', offset)
              cells[5] = cohortCell('pybrainage', offset)
              cells[7] = cohortCell('clinical', offset)
              cells[8] = cohortCell('aggregate', offset)
              cells[9] = cohortCell('final', offset)
            }
          } else if (role === 'failed') {
            const startedAt = history.failedStart + 2 * MINUTE
            cells[0] = cell('failed', startedAt, startedAt, {
              rc: 1,
              err: failedTags[failedIndex % failedTags.length],
            })
            failedIndex += 1
          } else if (role === 'reconDone') {
            const startedAt = history.activeStart + (3 + activeIndex) * MINUTE
            cells[0] = cell(
              'done',
              startedAt,
              startedAt + reconDuration - activeIndex * 2 * MINUTE,
            )
            activeIndex += 1
          } else if (role === 'running') {
            const startedAt = now - (118 - activeIndex * 1) * MINUTE
            cells[0] = cell('running', startedAt, null, {
              progress: Math.round(((now - startedAt) / reconDuration) * 100),
            })
            activeIndex += 1
          }
          subject.cells = cells
          subject.stepStates = stepStatesOf(cells)
          // Outlier review has no matrix column; the second run did it.
          if (cells[9].st === 'done') subject.stepStates.outliers = 'done'
        }
      }
      if (documentationMode) {
        // Present every primary cohort state deliberately instead of relying on
        // a random sample to contain a complete case.
        const statePatterns = [
          Array(9).fill('done'),
          ['failed', ...Array(8).fill('pending')],
          ['running', ...Array(8).fill('pending')],
          Array(9).fill('pending'),
          // An earlier run took the cohort of its day through R analysis. A
          // cohort stage waits on every analysis subject's reconstruction, so
          // the subjects added since then stop after reconstruction, and the
          // QC Fail subject stops after ENIGMA QC, as the QC gate leaves it.
          Array(9).fill('done'),
          ['done', ...Array(8).fill('pending')],
          Array(9).fill('done'),
          [...Array(4).fill('done'), ...Array(5).fill('pending')],
          ['done', ...Array(8).fill('pending')],
          Array(9).fill('done'),
          Array(9).fill('done'),
          // An analysis subject's own reconstruction failed in the active
          // run.
          ['failed', ...Array(8).fill('pending')],
        ]
        // QC review needs a finished reconstruction, so a subject whose
        // reconstruction failed, runs, or waits has no verdict.
        const qcStates = [
          'pass',
          null,
          null,
          null,
          'pass',
          null,
          'pass',
          'fail',
          null,
          'defer',
          'pass',
          null,
        ]
        subjects.splice(0)
        for (const [subjectIndex, ninePattern] of statePatterns.entries()) {
          const pattern = withNormCell(ninePattern, 'pending')
          const cohort = COHORTS[subjectIndex % COHORTS.length]
          const isSci = cohort.startsWith('SCI')
          const cells = pattern.map((st, stepIndex) => {
            const startedAt = [
              'pending',
              'planned',
              'waiting',
              'queued',
            ].includes(st)
              ? null
              : now - (subjectIndex + 1) * 180_000 + stepIndex * 10_000
            const finished = ['done', 'failed', 'skipped'].includes(st)
            return {
              st,
              startedAt,
              finishedAt:
                finished && startedAt !== null ? startedAt + 8_000 : null,
              progress: st === 'running' ? 35 + subjectIndex * 3 : null,
              rc: st === 'failed' ? 1 : st === 'done' ? 0 : null,
              err: st === 'failed' ? FAIL[subjectIndex % FAIL.length] : null,
            }
          })
          const qc = qcStates[subjectIndex]
          subjects.push({
            id: `sub-${String(subjectIndex + 1).padStart(3, '0')}`,
            age: 28 + subjectIndex * 3,
            sex: subjectIndex % 2 === 0 ? 'F' : 'M',
            cohort,
            ais: isSci ? AIS[subjectIndex % AIS.length] : null,
            tSinceSci: isSci
              ? Number((1.2 + subjectIndex / 2).toFixed(1))
              : null,
            cells,
            stepStates: Object.fromEntries(
              Object.entries(STEP_COLS).map(([key, columns]) => [
                key,
                columns.length > 0 &&
                columns.every((column) => cells[column].st === 'done')
                  ? 'done'
                  : columns.some((column) => cells[column].st === 'failed')
                    ? 'failed'
                    : columns.some((column) => cells[column].st === 'running')
                      ? 'running'
                      : 'pending',
              ]),
            ),
            qc,
            analysisEligible: qc !== 'fail',
            cohortRole:
              cohort === 'CTRL'
                ? 'healthy'
                : cohort === 'SCI_nNP'
                  ? 'sci-no-neuropathic-pain'
                  : 'sci-neuropathic-pain',
            notes: '',
          })
        }
        // Outlier review has no matrix column; the earlier run did it.
        for (const subject of subjects) {
          if (subject.cells[9].st === 'done') {
            subject.stepStates.outliers = 'done'
          }
        }
      }
      if (requestedState === 'long' && subjects.length > 0) {
        for (const subject of subjects) {
          for (const cell of subject.cells) {
            if (cell.st === 'failed' || cell.st === 'running') {
              cell.st = 'pending'
              cell.startedAt = null
              cell.finishedAt = null
              cell.progress = null
              cell.rc = null
              cell.err = null
            }
          }
        }
        subjects[0].id =
          'sub-long-content-identifier-with-many-segments-for-layout-verification-001'
        subjects[0].notes =
          'This deliberately long review note checks bounded wrapping and intentional scrolling without exposing real study data.'
        subjects[0].cells[0].st = 'failed'
        subjects[0].cells[0].err =
          'This deliberately long synthetic processing error checks responsive wrapping and accessible overflow.'
        if (history) {
          // A failed reconstruction leaves every later stage of the subject
          // unrun.
          for (const cell of subjects[0].cells.slice(1)) {
            Object.assign(cell, {
              st: 'pending',
              startedAt: null,
              finishedAt: null,
              progress: null,
              rc: null,
              err: null,
            })
          }
          for (const subject of subjects) {
            subject.stepStates = {
              ...stepStatesOf(subject.cells),
              outliers:
                subject === subjects[0]
                  ? 'pending'
                  : (subject.stepStates?.outliers ?? 'pending'),
            }
          }
        }
      }
      if (requestedState === 'sites') {
        // Two sites, the case the site rule exists for: the last
        // three SCI subjects come from Site B, which has no controls, and
        // BrainCharts and the z-score comparisons are on. BrainCharts gave
        // z-scores where PyBrainAge finished, except at the refused site.
        const sciIndexes = subjects
          .map((subject, index) => (subject.cohort === 'CTRL' ? -1 : index))
          .filter((index) => index >= 0)
        const siteB = new Set(sciIndexes.slice(-3))
        base.cfg.steps.braincharts = {
          ...base.cfg.steps.braincharts,
          enabled: true,
        }
        base.cfg.steps.zstats = { ...base.cfg.steps.zstats, enabled: true }
        for (const [index, subject] of subjects.entries()) {
          subject.site = siteB.has(index) ? 'Site B' : 'Site A'
          const norm = subject.cells[NORM_COLUMN]
          if (subject.cells[5].st === 'done') {
            norm.st = siteB.has(index) ? 'skipped' : 'done'
            norm.startedAt = subject.cells[5].startedAt
            norm.finishedAt = subject.cells[5].finishedAt
            norm.rc = siteB.has(index) ? null : 0
            subject.stepStates.braincharts = 'done'
          } else {
            subject.stepStates.braincharts = 'pending'
          }
        }
      }
      if (requestedState === 'empty') subjects.splice(0)
      // Every synthetic subject has one T1 input, which its runs read.
      for (const subject of subjects) subject.t1Availability = 'available'
      // The synthetic host has the tools of every stage its cohort finished,
      // so neither the top bar nor Diagnostics lists them as missing.
      const finishedStage = (key) =>
        subjects.some((subject) => subject.stepStates?.[key] === 'done')
      const stageTools = [
        {
          stage: 'pybrainage',
          item: 'py',
          checks: ['pybrainpython', 'modelfile', 'scalerfile'],
        },
        {
          stage: 'final',
          item: 'r',
          checks: ['rpkgs', 'rmarkdown', 'knitr', 'pandoc'],
        },
        {
          stage: 'braincharts',
          item: 'braincharts',
          checks: ['bcenv', 'bcmodel'],
        },
      ].filter(({ stage }) => finishedStage(stage))
      const setUpChecks = new Set(stageTools.flatMap(({ checks }) => checks))
      const setUpItems = new Set(stageTools.map(({ item }) => item))
      const mockEnvCheck = api.env.check
      api.env.check = async (request) => {
        const report = await mockEnvCheck(request)
        for (const group of report.groups) {
          group.checks = group.checks.map((check) =>
            setUpChecks.has(check.id)
              ? { id: check.id, label: check.label, status: 'found' }
              : check,
          )
        }
        return report
      }
      const mockToolStatus = api.env.toolStatus
      api.env.toolStatus = async (request) => {
        const status = await mockToolStatus(request)
        const items = status.items.map((item) =>
          setUpItems.has(item.id) && item.status === 'missing'
            ? { ...item, status: 'ok' }
            : item,
        )
        const summary = items.some((item) => item.status === 'missing')
          ? 'missing'
          : items.some((item) => item.status === 'warn')
            ? 'warn'
            : 'ok'
        return { ...status, items, summary }
      }
      api.subjects.discover =
        requestedState === 'cohort-loading'
          ? () => new Promise(() => {})
          : async () => JSON.parse(JSON.stringify(subjects))
      // Report the surface-registration check for this cohort, as the mock
      // does for its own: every finished reconstruction is checked, and the
      // third one's right hemisphere fits the atlas poorly.
      const registrationReference = {
        cortex: { median: 0.8342, scale: 0.0198 },
        dfp: { median: 0.8556, scale: 0.0235 },
      }
      const registrationRows = subjects
        .filter((subject) => subject.cells[0]?.st === 'done')
        .map((subject, index) => {
          const hemispheres = ['lh', 'rh'].map((hemisphere, side) => {
            const shifted = index === 2 && hemisphere === 'rh'
            const rCortex = shifted
              ? 0.7512
              : Number(
                  (0.834 + (((index * 7 + side) % 10) - 5) * 0.004).toFixed(4),
                )
            const rDfp = shifted
              ? 0.7018
              : Number(
                  (0.855 + (((index * 3 + side) % 10) - 5) * 0.005).toFixed(4),
                )
            const zCortex =
              (rCortex - registrationReference.cortex.median) /
              registrationReference.cortex.scale
            const zDfp =
              (rDfp - registrationReference.dfp.median) /
              registrationReference.dfp.scale
            const z = Math.min(zCortex, zDfp)
            return {
              hemisphere,
              state: 'checked',
              rCortex,
              rDfp,
              flagged: z < -3 || Math.min(rCortex, rDfp) < 0.7,
              measure: zDfp <= zCortex ? 'dfp' : 'cortex',
              z: Number(z.toFixed(3)),
              message: null,
            }
          })
          return {
            subjectId: subject.id,
            flagged: hemispheres.some((item) => item.flagged),
            hemispheres,
          }
        })
      const registrationChecked = registrationRows.length * 2
      const hemisphereCount = (rows, state) =>
        rows.reduce(
          (total, row) =>
            total +
            row.hemispheres.filter((item) => item.state === state).length,
          0,
        )
      // The reference of the last complete check holds while a check runs.
      const registrationStatus = (rows, operation) => ({
        configRevision: 0,
        method: 'sulc-fsaverage-pearson-v1',
        available: true,
        unavailableReason: null,
        rule: { zLimit: -3, floor: 0.7, minCohortHemispheres: 20 },
        reference: {
          source: registrationChecked >= 20 ? 'cohort' : 'builtin',
          hemispheres: registrationChecked,
          ...registrationReference,
        },
        operation,
        subjects: JSON.parse(JSON.stringify(rows)),
        counts: {
          subjects: rows.length,
          checked: hemisphereCount(rows, 'checked'),
          pending: hemisphereCount(rows, 'pending'),
          failed: 0,
          missing: 0,
          flaggedSubjects: rows.filter((row) => row.flagged).length,
          flaggedHemispheres: rows.reduce(
            (total, row) =>
              total + row.hemispheres.filter((item) => item.flagged).length,
            0,
          ),
        },
      })
      let registration = registrationStatus(registrationRows, null)
      if (requestedState === 'registration-running') {
        // A running check: the last third of the checked subjects are pending
        // again, and the flagged third subject stays checked.
        const keep = Math.max(3, Math.ceil((registrationRows.length * 2) / 3))
        const rows = registrationRows.map((row, index) =>
          index < keep
            ? row
            : {
                subjectId: row.subjectId,
                flagged: false,
                hemispheres: row.hemispheres.map((item) => ({
                  hemisphere: item.hemisphere,
                  state: 'pending',
                  rCortex: null,
                  rDfp: null,
                  flagged: false,
                  measure: null,
                  z: null,
                  message: null,
                })),
              },
        )
        const pending = hemisphereCount(rows, 'pending')
        registration = registrationStatus(rows, {
          operationId: 'srg-synthetic-running',
          state: 'running',
          total: pending,
          completed: 0,
          failed: 0,
          startedAt: new Date(now - 30_000).toISOString(),
          finishedAt: null,
          message: null,
        })
      }
      api.surfaceRegistration.status = async () =>
        JSON.parse(JSON.stringify(registration))
      const populated =
        requestedState !== 'empty' &&
        requestedState !== 'loading' &&
        requestedState !== 'cohort-loading' &&
        requestedState !== 'error'
      const syntheticRegistry = populated
        ? [
            {
              subjectId: 'sub-001',
              age: 42,
              sex: 'F',
              sourceCohortLabel: 'CTRL',
              cohortRole: 'healthy',
              ais: null,
              tSinceSci: null,
              t1Availability: 'available',
              runnable: true,
              unavailableReason: null,
              qc: 'pass',
              qcNote: 'Deterministic synthetic fixture.',
              qcTags: [],
              revision: 1,
              updatedAt: '2026-07-22T15:58:00.000Z',
            },
          ]
        : []
      api.registry.list = async () =>
        JSON.parse(JSON.stringify(syntheticRegistry))
      const producedArtifact = {
        artifactId: 'artifact:features:cohort',
        label: 'Synthetic cohort features',
        stepKey: 'features',
        subjectId: null,
        kind: 'csv',
        presence: 'produced',
        displayPath: 'outputs/features/concatenated_results.csv',
        exists: true,
        openable: true,
        revealable: true,
        runId: 'run-synthetic-done',
        producerNodeId: 'features:cohort',
        receiptSha256: 'a'.repeat(64),
        provenance: 'current',
      }
      const documentationArtifacts = [
        producedArtifact,
        {
          artifactId: 'artifact:recon:sub-003',
          label: 'Reconstruction surfaces',
          stepKey: 'recon',
          subjectId: 'sub-003',
          kind: 'dir',
          presence: 'partial',
          displayPath: 'outputs/recon/sub-003',
          exists: true,
          openable: false,
          revealable: true,
          runId: 'run-synthetic-running',
          producerNodeId: 'recon:sub-003',
          receiptSha256: null,
          provenance: 'unknown',
          detail:
            'Reconstruction is still running, so these outputs are incomplete.',
        },
        {
          artifactId: 'artifact:pybrainage:cohort',
          label: 'Brain-age prediction',
          stepKey: 'pybrainage',
          subjectId: null,
          kind: 'csv',
          presence: 'expected',
          displayPath: 'outputs/pybrainage/predictions.csv',
          exists: false,
          openable: false,
          revealable: false,
          runId: 'run-synthetic-running',
          producerNodeId: 'pybrainage:cohort',
          receiptSha256: null,
          provenance: 'current',
          detail: 'The prediction is queued and has not started.',
        },
        {
          artifactId: 'artifact:enigma:cohort',
          label: 'ENIGMA measures',
          stepKey: 'enigma',
          subjectId: null,
          kind: 'csv',
          presence: 'absent',
          displayPath: 'outputs/enigma/measures.csv',
          exists: false,
          openable: false,
          revealable: false,
          runId: 'run-synthetic-failed',
          producerNodeId: 'enigma:cohort',
          receiptSha256: null,
          provenance: 'current',
          detail: 'The ENIGMA stage failed before it wrote this artifact.',
        },
        {
          artifactId: 'artifact:final:cohort',
          label: 'R analysis cohort report',
          stepKey: 'final',
          subjectId: null,
          kind: 'pdf',
          presence: 'unknown',
          displayPath: 'outputs/final/report.pdf',
          exists: false,
          openable: false,
          revealable: false,
          runId: 'run-synthetic-blocked',
          producerNodeId: 'final:cohort',
          receiptSha256: null,
          provenance: 'unknown',
          detail:
            'The report environment is missing, so the R analysis is blocked.',
        },
      ]
      const siteArtifact = (stepKey, label, basename, kind, presence) => ({
        artifactId: `artifact:${stepKey}:${basename}`,
        label,
        stepKey,
        subjectId: null,
        kind,
        presence,
        displayPath: `outputs/${stepKey}/${basename}`,
        exists: presence === 'produced',
        openable: presence === 'produced',
        revealable: presence === 'produced',
        runId: 'run-synthetic-done',
        producerNodeId: `${stepKey}:cohort`,
        receiptSha256: presence === 'produced' ? '5'.repeat(64) : null,
        provenance: presence === 'produced' ? 'current' : 'unknown',
      })
      const siteArtifacts = [
        siteArtifact(
          'braincharts',
          'BrainCharts z-scores',
          'braincharts_zscores.csv',
          'csv',
          'produced',
        ),
        siteArtifact(
          'braincharts',
          'BrainCharts split report',
          'braincharts_split_report.csv',
          'csv',
          'produced',
        ),
        siteArtifact(
          'braincharts',
          'BrainCharts refused sites',
          'braincharts_refused_sites.csv',
          'csv',
          'produced',
        ),
        siteArtifact(
          'final',
          'WM PvH results',
          'WM_PvH_results.xlsx',
          'xlsx',
          'produced',
        ),
        siteArtifact(
          'final',
          'Site exclusions',
          'site_exclusions.csv',
          'csv',
          'produced',
        ),
        siteArtifact(
          'final',
          'ICV summary',
          'summary_icv.csv',
          'csv',
          'produced',
        ),
        siteArtifact(
          'zstats',
          'Z_SCI PvH results',
          'Z_SCI_PvH_results.xlsx',
          'xlsx',
          'expected',
        ),
      ]
      const syntheticArtifacts = populated
        ? documentationMode
          ? documentationArtifacts
          : requestedState === 'sites'
            ? [producedArtifact, ...siteArtifacts]
            : [producedArtifact]
        : []
      // Keep the mock's detector-issued gallery inventory in the ENIGMA stage so
      // QC review renders its native montage. Use the deterministic fixture for
      // every other stage.
      const mockResultsList = api.results.list
      // Match a search as the sidecar does (results.py _matches_query): every
      // term, case-insensitive, across the stage name and the artifact's
      // attribution.
      const stepNames = new Map(
        (await api.pipeline.listSteps()).map((step) => [step.key, step.name]),
      )
      const matchesQuery = (item, query) => {
        const haystack = [
          stepNames.get(item.stepKey) ?? '',
          ...[
            'label',
            'displayPath',
            'subjectId',
            'stepKey',
            'kind',
            'presence',
            'runId',
            'producerNodeId',
          ].map((field) => String(item[field] ?? '')),
        ]
          .join(' ')
          .toLowerCase()
        return String(query)
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .every((term) => haystack.includes(term))
      }
      api.results.list = async (request) =>
        request && request.stepKey === 'enigma'
          ? mockResultsList(request)
          : {
              items: JSON.parse(
                JSON.stringify(
                  request?.query
                    ? syntheticArtifacts.filter((item) =>
                        matchesQuery(item, request.query),
                      )
                    : syntheticArtifacts,
                ),
              ),
              nextCursor: null,
              truncated: false,
              runId: documentationMode ? 'run-synthetic-done' : undefined,
              // Judge the stages the Analysis panel reads, as the mock does.
              stageCurrency: {
                aggregate: { state: 'current', outdatedSubjectIds: [] },
                pybrainage: { state: 'current', outdatedSubjectIds: [] },
                recon: { state: 'current', outdatedSubjectIds: [] },
              },
            }
      api.artifact.readText = async () => ({
        text: 'subject_id,feature\nsub-001,1.250\n',
        truncated: false,
      })
      // Stand in for QC images with plain placeholder tiles: a neutral tile
      // per panel and a short centered label, never drawn anatomy.
      const placeholderFont = "500 15px 'WebCM Sans 10'"
      await document.fonts.load(placeholderFont)
      const paintPlaceholder = (context, x, y, width, height, label) => {
        context.fillStyle = '#2b2e33'
        context.fillRect(x, y, width, height)
        context.fillStyle = '#b3b8bf'
        context.font = placeholderFont
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText(label, x + width / 2, y + height / 2)
      }
      const placeholderCanvas = (width, height, what) => {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) {
          throw new Error(`Provide a 2D canvas context for the ${what}.`)
        }
        context.fillStyle = '#1d1f23'
        context.fillRect(0, 0, width, height)
        return { canvas, context }
      }
      const montage = placeholderCanvas(900, 600, 'Input QC placeholder')
      const panelLabels = [
        'Axial inferior',
        'Axial superior',
        'Coronal anterior',
        'Coronal posterior',
        'Sagittal left',
        'Sagittal right',
      ]
      for (let index = 0; index < panelLabels.length; index += 1) {
        const x = (index % 3) * 300
        const y = Math.floor(index / 3) * 300
        paintPlaceholder(
          montage.context,
          x + 8,
          y + 8,
          284,
          284,
          panelLabels[index],
        )
      }
      const montageDataUrl = montage.canvas.toDataURL('image/png')
      const qcPanel = placeholderCanvas(220, 220, 'QC panel placeholder')
      paintPlaceholder(qcPanel.context, 0, 0, 220, 220, 'Synthetic QC panel')
      const qcPanelDataUrl = qcPanel.canvas.toDataURL('image/png')
      api.artifact.previewImage = async ({ artifactId }) => ({
        dataUrl: String(artifactId).startsWith('artifact:enigma:')
          ? qcPanelDataUrl
          : montageDataUrl,
        mimeType: 'image/png',
        truncated: false,
      })
      const syntheticInputFovItems = populated
        ? [
            {
              subjectId: 'sub-001',
              sessionId: 'ses-baseline',
              acquisitionId: 'acq-t1w',
              preflightSignature: 'b'.repeat(64),
              sourceSha256: 'c'.repeat(64),
              outputSha256: 'd'.repeat(64),
              passThrough: false,
              requiresReview: true,
              qcArtifactId: `input-fov-qc:${'e'.repeat(64)}`,
              qcDisplayPath:
                'supraspina-brainfov/sub-001/ses-baseline/anat/sub-001_ses-baseline_acq-t1w_desc-brainfovbbbbbbbbbbbbbbbb_qc.png',
              review: null,
            },
          ]
        : []
      api.inputFov.list = async ({ configRevision }) => ({
        configRevision,
        items: JSON.parse(JSON.stringify(syntheticInputFovItems)),
      })
      const workflowAcknowledgements = {
        includeDeferredAndUnreviewedQc: false,
        acknowledgeMemoryAdvisory: false,
      }
      const createRun = (runId, status, offset, summary) => ({
        runId,
        projectId: base.project.projectId,
        projectEpoch: 1,
        status,
        startedAt: now - offset,
        endedAt: ['done', 'failed', 'blocked'].includes(status)
          ? now - offset + 30_000
          : null,
        dryRun: false,
        durable: true,
        acknowledgements: workflowAcknowledgements,
        summary,
      })
      // Each summary is the sentence the sidecar writes for such a run
      // (workflow_manager.py _state_summary). A run with a blocked node leads
      // with its counts, which the app drops before it shows the reason.
      const documentationRuns = [
        createRun('run-synthetic-done', 'done', 240_000, {
          planned: 2,
          started: 2,
          waiting: 0,
          blocked: 0,
          skipped: 0,
          message: 'The run finished.',
        }),
        createRun('run-synthetic-running', 'running', 145_000, {
          planned: 4,
          started: 3,
          waiting: 1,
          blocked: 0,
          skipped: 0,
          message: 'The run is running.',
        }),
        createRun('run-synthetic-failed', 'failed', 205_000, {
          planned: 0,
          started: 1,
          waiting: 0,
          blocked: 1,
          skipped: 0,
          message:
            'This pass runs 1 node; 1 blocked node will not run. Reconstruction failed, so this step did not run.',
        }),
        createRun('run-synthetic-blocked', 'blocked', 178_000, {
          planned: 0,
          started: 0,
          waiting: 0,
          blocked: 1,
          skipped: 0,
          message: 'Resolve 1 blocked node. The report environment is missing.',
        }),
      ]
      // Give each job the command line the sidecar adapter builds for this
      // project (recon.py, brainfov.py, enigma.py, and the cohort stages),
      // and give its log the lines the tools print.
      const projectRoot = base.cfg.paths.projectRoot
      const derivativesDir = `${projectRoot}/derivatives`
      const outputDir = `${projectRoot}/outputs/run`
      const resourceDir = '/opt/Supraspina/resources/scientific'
      const python = '/usr/bin/python3'
      const t1Path = (subjectId) =>
        `${projectRoot}/rawdata/${subjectId}/anat/${subjectId}_T1w.nii.gz`
      const commandFor = (stepKey, subjectId) => {
        switch (stepKey) {
          case 'recon':
            return `recon-all -subject ${subjectId} -i ${t1Path(subjectId)} -sd ${derivativesDir}/freesurfer -all -parallel -openmp 6`
          case 'brainfov':
            return `apptainer exec --cleanenv --containall --no-home --net --network none ${resourceDir}/brainfov/synthstrip.sif python3 ${resourceDir}/brainfov/brainfov_helper.py prepare --input ${t1Path(subjectId)} --derivatives-root ${derivativesDir} --subject ${subjectId} --margin-mm 30`
          case 'enigma':
            return `bash ${resourceDir}/enigma/enigma_fs_wrapper_script.sh --subjects ${outputDir}/qc_review/subjects.txt --fsdir ${derivativesDir}/freesurfer --outdir ${outputDir}/qc_review --script ${resourceDir}/enigma/ENIGMA_QC --matlab matlab --fs_version 7 --step_1 true --step_2 true --step_3 true --step_4 true --step_5 true`
          case 'pybrainage':
            return `${python} ${resourceDir}/pybrainage/predict.py --features ${outputDir}/features/subject_features.csv --template ${resourceDir}/features/rois_input_template.txt --model ${projectRoot}/models/pybrainage_model.pkl --scaler ${projectRoot}/models/pybrainage_scaler.pkl --output ${outputDir}/pybrainage/predicted_results.csv --row-fallback`
          case 'aggregate':
            return `${python} ${resourceDir}/step8/aggregate_stats.py --subjects-dir ${derivativesDir}/freesurfer --out-dir ${outputDir}/structural --subject-glob 'sub-*'`
          case 'final':
            return `Rscript ${resourceDir}/step9/FreesurferAnalysisScript.R --render-report ${resourceDir}/step9/FreesurferAnalysisScript.Rmd ${outputDir}/structural ${projectRoot}/metadata/metadata.csv ${outputDir}/final 5 613 SCI_H,SCI_P,SCI_nNP,SCI`
          default:
            return `${python} ${resourceDir}/${stepKey}/${stepKey}.py --config ${projectRoot}/supraspina.project.json --out-dir ${outputDir}/${stepKey}`
        }
      }
      // FreeSurfer stamps its progress lines with date(1) output in the
      // host's time zone, the zone the app shows its own times in.
      const fsDate = (at) => {
        const date = new Date(at)
        const pad = (value) => String(value).padStart(2, '0')
        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
          date.getDay()
        ]
        const month = [
          'Jan',
          'Feb',
          'Mar',
          'Apr',
          'May',
          'Jun',
          'Jul',
          'Aug',
          'Sep',
          'Oct',
          'Nov',
          'Dec',
        ][date.getMonth()]
        const zone =
          new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
            .formatToParts(date)
            .find((part) => part.type === 'timeZoneName')?.value ?? 'UTC'
        return `${day} ${month} ${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone} ${date.getFullYear()}`
      }
      const subjectsDirLine = `INFO: SUBJECTS_DIR is ${derivativesDir}/freesurfer`
      const createJob = ({
        id,
        runId,
        stepKey,
        subjectId,
        scope,
        status,
        offset,
        exitCode,
        terminalReason = null,
      }) => ({
        id,
        runId,
        nodeId: `${stepKey}:${subjectId ?? 'cohort'}`,
        projectId: base.project.projectId,
        projectEpoch: 1,
        sidecarGeneration: 1,
        stepKey,
        subjectId,
        scope,
        startedAt: ['queued', 'blocked'].includes(status) ? null : now - offset,
        plannedAt: now - offset - 1_000,
        endedAt: ['done', 'failed', 'blocked'].includes(status)
          ? now - offset + 20_000
          : null,
        exitCode,
        cmd: commandFor(stepKey, subjectId),
        stdoutPath: `logs/${runId}/${stepKey}.stdout.log`,
        stderrPath: `logs/${runId}/${stepKey}.stderr.log`,
        envSnapshotPath: `runs/${runId}/environment.json`,
        configSnapshotPath: `runs/${runId}/config.json`,
        status,
        dryRun: false,
        durable: true,
        persistenceStatus: 'durable',
        terminalReason,
      })
      const documentationJobs = [
        createJob({
          id: '#synthetic-done',
          runId: 'run-synthetic-done',
          stepKey: 'recon',
          subjectId: 'sub-001',
          scope: 'subject',
          status: 'done',
          offset: 220_000,
          exitCode: 0,
        }),
        createJob({
          id: '#synthetic-running',
          runId: 'run-synthetic-running',
          stepKey: 'recon',
          subjectId: 'sub-003',
          scope: 'subject',
          status: 'running',
          offset: 120_000,
          exitCode: null,
        }),
        // One subject's reconstruction failed in the active run while the
        // others go on, so the Reconstruction card, which counts the active
        // run, states a failure of an analysis subject.
        createJob({
          id: '#synthetic-recon-failed',
          runId: 'run-synthetic-running',
          stepKey: 'recon',
          subjectId: 'sub-012',
          scope: 'subject',
          status: 'failed',
          offset: 130_000,
          exitCode: 137,
          // The reason the sidecar records for recon-all's rc=137 (recon.py
          // parse_failure).
          terminalReason:
            'Increase available memory for recon-all after rc=137; allow at least 32 GB and up to about 80 GB peak.',
        }),
        createJob({
          id: '#synthetic-queued',
          runId: 'run-synthetic-running',
          stepKey: 'brainfov',
          subjectId: 'sub-004',
          scope: 'subject',
          status: 'queued',
          offset: 110_000,
          exitCode: null,
        }),
        createJob({
          id: '#synthetic-failed',
          runId: 'run-synthetic-failed',
          stepKey: 'recon',
          subjectId: 'sub-002',
          scope: 'subject',
          status: 'failed',
          offset: 200_000,
          exitCode: 1,
          // The reason the sidecar records when recon-all fails on the
          // FreeSurfer license (recon.py parse_failure), shown as recorded.
          terminalReason:
            'Provide a valid FreeSurfer license.txt in $FREESURFER_HOME or set FS_LICENSE.',
        }),
        // Logs lists failed and blocked jobs of the run in focus only. It
        // opens on the running job's run, and the documentation capture then
        // chooses run-synthetic-failed in the Run list, so that run carries
        // the cohort job its failed reconstruction blocked, with the
        // sidecar's readiness reason.
        createJob({
          id: '#synthetic-dependency-blocked',
          runId: 'run-synthetic-failed',
          stepKey: 'enigma',
          subjectId: null,
          scope: 'cohort',
          status: 'blocked',
          offset: 196_000,
          exitCode: null,
          terminalReason: 'Reconstruction failed, so this step did not run.',
        }),
        createJob({
          id: '#synthetic-blocked',
          runId: 'run-synthetic-blocked',
          stepKey: 'final',
          subjectId: null,
          scope: 'cohort',
          status: 'blocked',
          offset: 176_000,
          exitCode: null,
          terminalReason: 'missing_report_environment',
        }),
      ]
      const documentationLogs = [
        {
          id: 'log-synthetic-001',
          runId: 'run-synthetic-done',
          jobId: '#synthetic-done',
          at: now - 210_000,
          level: 'INFO',
          line: subjectsDirLine,
        },
        {
          id: 'log-synthetic-002',
          runId: 'run-synthetic-done',
          jobId: '#synthetic-done',
          at: now - 200_000,
          level: 'INFO',
          // Documentation captures redact times, so this line carries none.
          line: '#@#%# recon-all-run-time-hours 6.214',
        },
        {
          id: 'log-synthetic-003',
          runId: 'run-synthetic-running',
          jobId: '#synthetic-running',
          at: now - 105_000,
          level: 'WARN',
          line: 'Available memory is 9.6 GB, below the 10 GB warning threshold.',
        },
        {
          id: 'log-synthetic-004',
          runId: 'run-synthetic-running',
          jobId: '#synthetic-queued',
          at: now - 100_000,
          level: 'WARN',
          line: 'Brain FOV preparation for sub-004 waits for a free job slot.',
        },
        // The All jobs stream shows the run in focus only, and the
        // documentation capture focuses run-synthetic-failed, so that run
        // carries an INFO and a WARN line beside its errors.
        {
          id: 'log-synthetic-008',
          runId: 'run-synthetic-failed',
          jobId: '#synthetic-failed',
          at: now - 199_000,
          level: 'INFO',
          line: subjectsDirLine,
        },
        {
          id: 'log-synthetic-009',
          runId: 'run-synthetic-failed',
          jobId: '#synthetic-failed',
          at: now - 195_000,
          level: 'WARN',
          line: 'FS_LICENSE is not set; recon-all reads $FREESURFER_HOME/license.txt.',
        },
        {
          id: 'log-synthetic-005',
          runId: 'run-synthetic-failed',
          jobId: '#synthetic-failed',
          at: now - 181_000,
          level: 'ERROR',
          line: 'ERROR: FreeSurfer license file /usr/local/freesurfer/license.txt not found.',
        },
        {
          // The sidecar's recorded marker for a blocked job; its log replay id
          // hashes this text, and Logs states it as "The job was blocked: ...".
          id: 'log-synthetic-007',
          runId: 'run-synthetic-failed',
          jobId: '#synthetic-dependency-blocked',
          at: now - 176_000,
          level: 'ERROR',
          line: 'Resolve the blocked job: Reconstruction failed, so this step did not run.',
        },
        {
          id: 'log-synthetic-006',
          runId: 'run-synthetic-blocked',
          jobId: '#synthetic-blocked',
          at: now - 156_000,
          level: 'ERROR',
          line: 'Resolve the blocked job: missing_report_environment',
        },
      ]
      // Give the populated cohort the runs that own its cells, as the
      // documentation fixture does: the reshaped history above, read back
      // from the cells so the long-content state's changes stay owned too.
      // The sidecar refuses a live run while another is active, so the
      // failed run ended before the active run started, and Resume failed
      // names the active run as the reason.
      // The exit code, time to failure, and reason the sidecar records for
      // each failure tag (recon.py parse_failure), and the line recon-all
      // printed last.
      const reconFailure = (subjectId, tag, endedAt) =>
        ({
          oom_killed: {
            exitCode: 137,
            duration: 38 * MINUTE,
            reason:
              'Increase available memory for recon-all after rc=137; allow at least 32 GB and up to about 80 GB peak.',
            line: 'Command terminated by signal 9',
          },
          'License check failed': {
            exitCode: 1,
            duration: 20_000,
            reason:
              'Provide a valid FreeSurfer license.txt in $FREESURFER_HOME or set FS_LICENSE.',
            line: 'ERROR: FreeSurfer license file /usr/local/freesurfer/license.txt not found.',
          },
        })[tag] ?? {
          exitCode: 1,
          duration: tag === 'segfault' ? 25 * MINUTE : MINUTE,
          // The long-content state's own error stands as its reason.
          reason: tag && tag.length > 40 ? tag : 'Inspect process exit code 1.',
          line: `recon-all -s ${subjectId} exited with ERRORS at ${fsDate(endedAt)}`,
        }
      const populatedRuns = []
      const populatedJobs = []
      const populatedLogs = []
      if (history && populated) {
        const logLine = (job, at, level, line) => ({
          id: `log-${job.id.slice(1)}-${at}`,
          runId: job.runId,
          jobId: job.id,
          at,
          level,
          line,
        })
        const addJob = (
          runId,
          stepKey,
          subjectId,
          status,
          startedAt,
          endedAt,
          extra = {},
        ) => {
          const job = {
            ...createJob({
              id: `#${runId.replace(/^run-/, '')}-${stepKey}-${subjectId ?? 'cohort'}`,
              runId,
              stepKey,
              subjectId,
              scope: subjectId ? 'subject' : 'cohort',
              status,
              offset: 0,
              exitCode: status === 'done' ? 0 : null,
              ...extra,
            }),
            plannedAt: (startedAt ?? history.activeStart) - 1_000,
            startedAt,
            endedAt,
          }
          populatedJobs.push(job)
          if (stepKey === 'recon' && startedAt !== null) {
            populatedLogs.push(
              logLine(job, startedAt + 1_000, 'INFO', subjectsDirLine),
            )
            if (status === 'done') {
              populatedLogs.push(
                logLine(
                  job,
                  endedAt,
                  'INFO',
                  `recon-all -s ${subjectId} finished without error at ${fsDate(endedAt)}`,
                ),
              )
            } else if (status === 'running') {
              const at = startedAt + 15 * MINUTE
              populatedLogs.push(
                logLine(job, at, 'INFO', `#@# Talairach ${fsDate(at)}`),
              )
            }
          } else if (stepKey !== 'recon' && stepKey !== 'brainfov') {
            populatedLogs.push(
              logLine(
                job,
                startedAt + 1_000,
                'INFO',
                `Started ${stepNames.get(stepKey) ?? stepKey} for the analysis cohort.`,
              ),
            )
          }
          return job
        }
        const addRun = (runId, startedAt) => {
          const jobs = populatedJobs.filter((job) => job.runId === runId)
          if (jobs.length === 0) return
          const count = (...statuses) =>
            jobs.filter((job) => statuses.includes(job.status)).length
          const status =
            count('running') > 0
              ? 'running'
              : count('failed') > 0
                ? 'failed'
                : 'done'
          populatedRuns.push({
            ...createRun(runId, status, now - startedAt, {
              planned: count('queued'),
              started: count('running', 'done', 'failed'),
              waiting: count('queued'),
              blocked: 0,
              skipped: 0,
              message: {
                running: 'The run is running.',
                failed: 'The run failed.',
                done: 'The run finished.',
              }[status],
            }),
            endedAt:
              status === 'running'
                ? null
                : Math.max(...jobs.map((job) => job.endedAt ?? startedAt)),
          })
        }
        const reconOf = (predicate) =>
          subjects.filter((subject) => predicate(subject.cells[0], subject))
        // The first run: brain-FOV preparation and reconstruction for every
        // subject it took, then ENIGMA QC for that cohort.
        const firstRun = reconOf(
          (cell) => cell.st === 'done' && cell.startedAt < history.failedStart,
        )
        for (const [index, subject] of firstRun.entries()) {
          const at = history.reconStart + index * MINUTE
          addJob(
            'run-synthetic-recon',
            'brainfov',
            subject.id,
            'done',
            at,
            at + 50_000,
          )
          addJob(
            'run-synthetic-recon',
            'recon',
            subject.id,
            'done',
            subject.cells[0].startedAt,
            subject.cells[0].finishedAt,
          )
        }
        if (subjects.some((subject) => subject.cells[1].st === 'done')) {
          addJob(
            'run-synthetic-recon',
            'enigma',
            null,
            'done',
            history.enigmaStart,
            history.enigmaEnd,
          )
        }
        addRun('run-synthetic-recon', history.reconStart)
        // The second run: the cohort stages, after QC review.
        if (subjects.some((subject) => subject.cells[9].st === 'done')) {
          for (const [stepKey, [start, end]] of Object.entries(
            history.cohortStages,
          )) {
            addJob(
              'run-synthetic-done',
              stepKey,
              null,
              'done',
              now - start * HOUR,
              now - end * HOUR,
            )
          }
        }
        addRun(
          'run-synthetic-done',
          now - history.cohortStages.outliers[0] * HOUR,
        )
        // The failed run: each failure gets the code, reason, and time to
        // failure the sidecar records for its tag.
        for (const [index, subject] of reconOf(
          (cell) => cell.st === 'failed',
        ).entries()) {
          const cell = subject.cells[0]
          const prepared = history.failedStart + index * MINUTE
          addJob(
            'run-synthetic-failed',
            'brainfov',
            subject.id,
            'done',
            prepared,
            prepared + 50_000,
          )
          const startedAt = history.failedStart + 2 * MINUTE
          const { duration } = reconFailure(subject.id, cell.err, startedAt)
          const endedAt = startedAt + duration
          const failure = reconFailure(subject.id, cell.err, endedAt)
          cell.startedAt = startedAt
          cell.finishedAt = endedAt
          cell.rc = failure.exitCode
          const job = addJob(
            'run-synthetic-failed',
            'recon',
            subject.id,
            'failed',
            startedAt,
            endedAt,
            { exitCode: failure.exitCode, terminalReason: failure.reason },
          )
          populatedLogs.push(logLine(job, endedAt, 'ERROR', failure.line))
        }
        addRun('run-synthetic-failed', history.failedStart)
        // The active run: two reconstructions at a time, the queue size; the
        // rest wait in the queue.
        const running = reconOf((cell) => cell.st === 'running')
        const activeSubjects = reconOf(
          (cell, subject) =>
            (cell.st === 'done' && cell.startedAt >= history.activeStart) ||
            cell.st === 'running' ||
            (running.length > 0 &&
              cell.st === 'pending' &&
              history.roles.get(subject.id) === 'queued'),
        )
        for (const [index, subject] of activeSubjects.entries()) {
          const cell = subject.cells[0]
          const prepared = history.activeStart + Math.floor(index / 2) * MINUTE
          addJob(
            'run-synthetic-running',
            'brainfov',
            subject.id,
            'done',
            prepared,
            prepared + 50_000,
          )
          addJob(
            'run-synthetic-running',
            'recon',
            subject.id,
            cell.st === 'pending' ? 'queued' : cell.st,
            cell.startedAt,
            cell.finishedAt,
          )
        }
        const activeJob = populatedJobs.find(
          (job) =>
            job.runId === 'run-synthetic-running' && job.stepKey === 'recon',
        )
        if (activeJob && running.length > 0) {
          populatedLogs.push(
            logLine(
              activeJob,
              activeJob.startedAt + 2_000,
              'WARN',
              'Available memory is 9.6 GB, below the 10 GB warning threshold.',
            ),
          )
        }
        addRun('run-synthetic-running', history.activeStart)
        populatedLogs.sort((left, right) => left.at - right.at)
      }
      const runtimeRuns = documentationMode ? documentationRuns : populatedRuns
      const runtimeJobs = documentationMode ? documentationJobs : populatedJobs
      const runtimeLogs = documentationMode ? documentationLogs : populatedLogs
      const manifestStep = (key, status, subjects, failed, durationSec) => ({
        id: Object.keys(STEP_COLS).indexOf(key),
        key,
        status,
        subjects,
        failed,
        durationSec,
      })
      const createManifest = (runId, startedOffset, endedOffset, steps) => ({
        schemaVersion: 1,
        runId,
        project: { ...base.project, epoch: 1 },
        startedAt: new Date(now - startedOffset).toISOString(),
        endedAt:
          endedOffset === null
            ? null
            : new Date(now - endedOffset).toISOString(),
        user: 'synthetic-user',
        host: 'synthetic-host',
        git: { repo: '', sha: '0123456', dirty: false },
        configSha256: '0'.repeat(64),
        steps,
        tools: { fixture: '1.0.0' },
      })
      const documentationManifests = [
        createManifest('run-synthetic-done', 240_000, 210_000, [
          manifestStep('recon', 'done', 2, 0, 30),
        ]),
        createManifest('run-synthetic-running', 145_000, null, [
          manifestStep('brainfov', 'queued', 1, 0, 0),
          manifestStep('recon', 'running', 2, 1, 120),
        ]),
        createManifest('run-synthetic-failed', 205_000, 175_000, [
          manifestStep('recon', 'failed', 1, 1, 30),
          manifestStep('enigma', 'blocked', 1, 0, 0),
        ]),
        createManifest('run-synthetic-blocked', 178_000, 148_000, [
          manifestStep('final', 'blocked', 12, 0, 0),
        ]),
      ]
      // List a manifest for each populated run, built from its jobs.
      const analysisCount = subjects.filter(
        (subject) => subject.analysisEligible,
      ).length
      const jobsManifest = (run, jobs) => {
        // A cohort job covers the subjects whose stage it finished; one with
        // no matrix column covers the cohort of the run's other stages.
        const covered = (stepKey) =>
          (STEP_COLS[stepKey] ?? []).length > 0
            ? subjects.filter((subject) =>
                STEP_COLS[stepKey].every((column) =>
                  ['done', 'running'].includes(subject.cells[column].st),
                ),
              ).length
            : 0
        const runCohort =
          Math.max(0, ...jobs.map((job) => covered(job.stepKey))) ||
          analysisCount
        const steps = new Map()
        for (const job of jobs) {
          const startedAt = job.startedAt ?? job.plannedAt
          const step = steps.get(job.stepKey) ?? {
            statuses: new Set(),
            subjects: 0,
            failed: 0,
            startedAt,
            endedAt: job.endedAt,
          }
          step.statuses.add(job.status)
          step.subjects += job.subjectId ? 1 : covered(job.stepKey) || runCohort
          step.failed += job.status === 'failed' ? 1 : 0
          step.startedAt = Math.min(step.startedAt, startedAt)
          step.endedAt =
            job.endedAt === null || step.endedAt === null
              ? null
              : Math.max(step.endedAt, job.endedAt)
          steps.set(job.stepKey, step)
        }
        const stepOrder = Object.keys(STEP_COLS)
        return createManifest(
          run.runId,
          now - run.startedAt,
          run.endedAt === null ? null : now - run.endedAt,
          [...steps.entries()]
            .sort(
              ([left], [right]) =>
                stepOrder.indexOf(left) - stepOrder.indexOf(right),
            )
            .map(([key, step]) =>
              manifestStep(
                key,
                ['failed', 'running', 'queued', 'done'].find((status) =>
                  step.statuses.has(status),
                ),
                step.subjects,
                step.failed,
                Math.round(((step.endedAt ?? now) - step.startedAt) / 1000),
              ),
            ),
        )
      }
      const populatedManifests = [...populatedRuns]
        .sort((left, right) => right.startedAt - left.startedAt)
        .map((run) =>
          jobsManifest(
            run,
            populatedJobs.filter((job) => job.runId === run.runId),
          ),
        )
      if (documentationMode || populated) {
        api.manifest.list = async () => ({
          items: JSON.parse(
            JSON.stringify(
              documentationMode ? documentationManifests : populatedManifests,
            ),
          ),
          nextCursor: null,
        })
      }
      api.runtime.bootstrap = async ({ project }) => ({
        project,
        sidecarGeneration: 1,
        sequence: populated ? runtimeLogs.length : 0,
        runs: populated ? JSON.parse(JSON.stringify(runtimeRuns)) : [],
        jobs: populated ? JSON.parse(JSON.stringify(runtimeJobs)) : [],
        logTail: populated ? JSON.parse(JSON.stringify(runtimeLogs)) : [],
        provision: null,
      })
      if (requestedState === 'loading' || requestedState === 'cohort-loading') {
        api.env.check = async () => new Promise(() => {})
      }
      if (
        requestedState === 'cohort-loading' ||
        requestedState === 'runtime-restoring'
      ) {
        api.runtime.bootstrap = () => new Promise(() => {})
      }
      if (requestedState === 'error') {
        api.env.check = async () => {
          throw new Error('The deterministic tool inspection failed.')
        }
      }
      if (requestedState === 'validation') {
        api.project.validate = async () => ({
          errors: [
            'Choose an absolute output directory before this configuration can run.',
          ],
          warnings: [],
        })
      }
      if (requestedState === 'blocking' || requestedState === 'blocked') {
        api.pipeline.previewCommand = async () => {
          throw new Error(
            'Install the required MATLAB runtime before running this stage.',
          )
        }
      }
    },
    { requestedState: stateName, documentationMode },
  )
  await page
    .getByRole('button', { name: 'Open a saved project' })
    .first()
    .click()
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: /Open project file/ }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).waitFor()
}

async function assertFontsAndLocalAssets(page, origin) {
  const result = await page.evaluate(async () => {
    await document.fonts.ready
    const faces = [
      ['400', 'normal', 'WebCM Sans 10', 'WebCM Sans 10 Regular'],
      ['400', 'italic', 'WebCM Sans 10', 'WebCM Sans 10 Oblique'],
      ['500', 'normal', 'WebCM Sans 10', 'WebCM Sans 10 Book'],
      ['500', 'italic', 'WebCM Sans 10', 'WebCM Sans 10 BookOblique'],
      ['700', 'normal', 'WebCM Sans 10', 'WebCM Sans 10 Bold'],
      ['700', 'italic', 'WebCM Sans 10', 'WebCM Sans 10 BoldOblique'],
      ['400', 'normal', 'WebCM Serif 10', 'WebCM Serif 10 Regular'],
      ['400', 'italic', 'WebCM Serif 10', 'WebCM Serif 10 Italic'],
      ['500', 'normal', 'WebCM Serif 10', 'WebCM Serif 10 Book'],
      ['500', 'italic', 'WebCM Serif 10', 'WebCM Serif 10 BookItalic'],
      ['700', 'normal', 'WebCM Serif 10', 'WebCM Serif 10 Bold'],
      ['700', 'italic', 'WebCM Serif 10', 'WebCM Serif 10 BoldItalic'],
      ['400', 'normal', 'WebCM Mono 10', 'WebCM Mono 10 Regular'],
      ['400', 'italic', 'WebCM Mono 10', 'WebCM Mono 10 Italic'],
      ['500', 'normal', 'WebCM Mono 10', 'WebCM Mono 10 Book'],
      ['500', 'italic', 'WebCM Mono 10', 'WebCM Mono 10 BookItalic'],
      ['700', 'normal', 'WebCM Mono 10', 'WebCM Mono 10 Bold'],
      ['700', 'italic', 'WebCM Mono 10', 'WebCM Mono 10 BoldOblique'],
    ]
    const loaded = []
    for (const [weight, style, family, sourceStem] of faces) {
      await document.fonts.load(`${style} ${weight} 16px "${family}"`)
      loaded.push({
        family,
        style,
        weight,
        sourceStem,
        active: document.fonts.check(`${style} ${weight} 16px "${family}"`),
      })
    }
    const cssFaces = []
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSFontFaceRule)) continue
        const family = rule.style
          .getPropertyValue('font-family')
          .trim()
          .replace(/^['"]|['"]$/g, '')
        if (!/^WebCM /.test(family)) continue
        const source = rule.style.getPropertyValue('src')
        const match = source.match(/url\(["']?([^"')]+)["']?\)/)
        cssFaces.push({
          family,
          weight: rule.style.getPropertyValue('font-weight').trim(),
          style: rule.style.getPropertyValue('font-style').trim(),
          source: match
            ? decodeURIComponent(new URL(match[1], location.href).pathname)
            : '',
        })
      }
    }
    const fontUrls = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /\.woff2(?:\?|$)/.test(url))
    return {
      loaded,
      cssFaces,
      fontUrls,
      fontSynthesis: getComputedStyle(document.documentElement).fontSynthesis,
    }
  })
  if (result.loaded.some((face) => !face.active)) {
    throw new Error(
      `Activate every expected font face: ${JSON.stringify(result.loaded)}.`,
    )
  }
  if (result.cssFaces.length !== 18) {
    throw new Error(
      `Provide exactly 18 bundled @font-face rules; found ${result.cssFaces.length}.`,
    )
  }
  for (const expected of result.loaded) {
    const matches = result.cssFaces.filter((face) => {
      const sourceName = path.basename(face.source)
      const expectedSource = `${expected.sourceStem}.woff2`
      const hashedSourcePrefix = `${expected.sourceStem}-`
      return (
        face.family === expected.family &&
        face.weight === expected.weight &&
        face.style === expected.style &&
        (sourceName === expectedSource ||
          (sourceName.startsWith(hashedSourcePrefix) &&
            sourceName.endsWith('.woff2')))
      )
    })
    if (matches.length !== 1) {
      throw new Error(
        `Match font descriptors to their sources: ${JSON.stringify({ expected, matches })}.`,
      )
    }
  }
  if (result.fontUrls.length !== 18) {
    throw new Error(
      `Load exactly 18 local WOFF2 faces; found ${result.fontUrls.length}.`,
    )
  }
  if (result.fontUrls.some((url) => new URL(url).origin !== origin)) {
    throw new Error('Load every Computer Modern face from a local origin.')
  }
  if (result.fontSynthesis !== 'none') {
    throw new Error(`Disable font synthesis; found ${result.fontSynthesis}.`)
  }
}

async function assertRouteAndState(
  page,
  screenName,
  stateName,
  hasProject,
  hasFirstRunDialog,
) {
  const headings = {
    Setup: /^Set up your project$/,
    Dashboard: /^Dashboard$/,
    Subjects: /^Subjects$/,
    Runs: /^Runs$/,
    Logs: /^Logs$/,
    'QC Review': /^(?:QC review|Subject \S+)$/,
    'Input QC': /^Input QC$/,
    Results: /^Results$/,
    Analysis: /^Analysis$/,
    Registry: /^Registry$/,
    Pipeline: /^Pipeline$/,
    Diagnostics: /^Diagnostics$/,
    Settings: /^Settings$/,
  }
  const expectedHeading = headings[screenName]
  if (!expectedHeading)
    throw new Error(`Provide a route contract for ${screenName}.`)
  const visibleHeadings = await page
    .locator('main h1')
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const style = getComputedStyle(element)
          return (
            element.getClientRects().length > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none'
          )
        })
        .map((element) => element.textContent?.trim() ?? ''),
    )
  const matchingHeadings = visibleHeadings.filter((text) =>
    expectedHeading.test(text),
  )
  if (matchingHeadings.length !== 1 || visibleHeadings.length !== 1) {
    throw new Error(
      `Match the route heading for ${screenName}: ${JSON.stringify(visibleHeadings)}.`,
    )
  }

  if (hasProject) {
    const activeRoute = await page
      .locator('nav[aria-label="Primary"] button[aria-current="page"]')
      .evaluateAll((elements) =>
        elements.map(
          (element) =>
            element.getAttribute('aria-label') ||
            element.textContent?.trim() ||
            '',
        ),
      )
    const expectedRouteLabel =
      screenName === 'QC Review' ? 'QC review' : screenName
    if (activeRoute.length !== 1) {
      throw new Error(
        `Match the active route for ${screenName}: ${JSON.stringify(activeRoute)}.`,
      )
    }
    if (activeRoute[0]?.toLowerCase() === 'more') {
      const trigger = page.locator(
        'nav[aria-label="Primary"] button[aria-haspopup="menu"]',
      )
      const alreadyOpen =
        (await trigger.getAttribute('aria-expanded')) === 'true'
      if (!alreadyOpen) await trigger.click()
      const menu = page.getByRole('menu', { name: 'More workspaces' })
      await menu.waitFor()
      const current = menu.locator('[role="menuitem"][aria-current="page"]')
      const labels = await current.allTextContents()
      if (
        labels.length !== 1 ||
        labels[0]?.trim().toLowerCase() !== expectedRouteLabel.toLowerCase()
      ) {
        throw new Error(
          `Match the overflow route for ${screenName}: ${JSON.stringify(labels)}.`,
        )
      }
      if (!alreadyOpen) {
        await page.keyboard.press('Escape')
        await menu.waitFor({ state: 'detached' })
      }
    } else if (
      activeRoute[0]?.toLowerCase() !== expectedRouteLabel.toLowerCase()
    ) {
      throw new Error(
        `Match the active route for ${screenName}: ${JSON.stringify(activeRoute)}.`,
      )
    }
  }

  if (hasFirstRunDialog) {
    const dialog = page.getByRole('dialog', { name: 'Welcome to Supraspina' })
    await dialog.waitFor()
    await dialog
      .getByRole('heading', { name: 'Welcome to Supraspina' })
      .waitFor()
    await page.waitForFunction(
      () => document.activeElement?.id === 'firstrun-title',
    )
    return
  }

  const requireVisible = async (locator, description, minimum = 1) => {
    const count = await locator.count()
    if (count < minimum) {
      throw new Error(
        `Provide ${description} for ${screenName}/${stateName}; found ${count}, expected at least ${minimum}.`,
      )
    }
    await locator.first().waitFor({ state: 'visible' })
  }
  if (
    (stateName === 'empty' || stateName === 'no-match') &&
    screenName in NO_MATCH_SEARCH
  ) {
    // Check the rows, not the wording: the empty and no-match sentences are
    // the screens' own copy, and the captures exist to review it.
    const rows = await contentRowCount(page, screenName)
    if (rows !== 0) {
      throw new Error(
        `Render no rows for the ${stateName} ${screenName} fixture; found ${rows}.`,
      )
    }
    if (stateName === 'no-match') {
      const value = await page
        .getByLabel(NO_MATCH_SEARCH[screenName], { exact: true })
        .first()
        .inputValue()
      if (value !== noMatchQuery) {
        throw new Error(
          `Keep the no-match query in the ${screenName} search box; found ${JSON.stringify(value)}.`,
        )
      }
    }
    return
  }
  if (!['populated', 'long', 'analysis-grid'].includes(stateName)) return

  switch (screenName) {
    case 'Dashboard':
      await requireVisible(
        page.getByRole('table', { name: 'Recent subjects status matrix' }),
        'the populated recent-subjects matrix',
      )
      await requireVisible(
        page.getByText('sub-001', { exact: true }),
        'synthetic subject sub-001',
      )
      break
    case 'Subjects':
      await requireVisible(
        page.locator('[aria-label="Subjects matrix"]'),
        'the populated subjects matrix',
      )
      await requireVisible(
        page.getByText(
          stateName === 'long'
            ? 'sub-long-content-identifier-with-many-segments-for-layout-verification-001'
            : 'sub-001',
          { exact: true },
        ),
        stateName === 'long'
          ? 'the deterministic long-content subject'
          : 'synthetic subject sub-001',
      )
      break
    case 'Runs':
      await requireVisible(
        page.getByRole('button', { name: /^Run all \d+$/ }),
        'a nonempty run-scope action',
      )
      break
    case 'Logs':
      await requireVisible(
        page.locator('[aria-label="Jobs"]'),
        'the jobs region',
      )
      // All jobs streams the run in focus only: the default fixture's one
      // run, or the documentation fixture's failed run.
      await requireVisible(
        page.getByText(
          /^(recon-all -s sub-001 finished without error at .+ 2026|INFO: SUBJECTS_DIR is \/data\/projects\/example-study\/derivatives\/freesurfer)$/,
        ),
        'the deterministic runtime log line',
      )
      break
    case 'QC Review':
      await requireVisible(
        page.locator('[aria-label="Subject queue"]'),
        'the subject queue',
      )
      await requireVisible(
        page.getByText('sub-001', { exact: true }),
        'synthetic subject sub-001',
      )
      // Draw the native ENIGMA montage in-app from the detector-verified PNG set
      // instead of handing it to a browser. The documentation capture opens
      // the external cortical gallery, and every other capture the first one.
      if (documentation) {
        await requireVisible(
          page.getByRole('group', {
            name: 'External cortical montage for sub-001',
          }),
          'the native external cortical montage',
        )
        await requireVisible(
          page.getByText('4/4 panels verified and drawn.'),
          'the montage panel tally',
        )
        await requireVisible(
          page.getByRole('button', {
            name: 'Left hemisphere, lateral, sub-001, panel 1 of 4',
          }),
          'the first labeled montage panel',
        )
        break
      }
      await requireVisible(
        page.getByRole('group', { name: 'Subcortical montage for sub-001' }),
        'the native subcortical montage',
      )
      await requireVisible(
        page.getByText('12/12 panels verified and drawn.'),
        'the montage panel tally',
      )
      await requireVisible(
        page.getByRole('button', { name: 'Axial 20%, sub-001, panel 1 of 12' }),
        'the first labeled montage panel',
      )
      break
    case 'Input QC':
      await requireVisible(
        page.getByRole('complementary', { name: 'Prepared inputs' }),
        'the prepared-input queue',
      )
      await requireVisible(
        page.getByRole('img', {
          name: 'Brain FOV QC montage for sub-001',
        }),
        'the deterministic brain-FOV montage',
      )
      await requireVisible(
        page.getByText('0/1 crops approved', { exact: true }),
        'the unreviewed crop summary',
      )
      await requireVisible(
        page.getByRole('group', {
          name: 'Crop decision for sub-001',
        }),
        'the crop decision controls',
      )
      break
    case 'Results':
      await requireVisible(
        page.locator('[aria-label="Output files"] > button'),
        'an output file',
      )
      await requireVisible(
        page.getByText('Synthetic cohort features', { exact: true }),
        'the deterministic artifact label',
      )
      break
    case 'Analysis':
      if (stateName === 'analysis-grid') {
        await requireVisible(
          page.getByRole('tab', { name: 'Grid', selected: true }),
          'the selected Grid tab',
        )
        await requireVisible(
          page.getByRole('table', { name: /^Grid of / }),
          'the synthetic v2 grid',
        )
        break
      }
      await requireVisible(
        page.getByRole('tab', { name: 'Forest', selected: true }),
        'the selected Forest tab',
      )
      await requireVisible(
        page.getByRole('img', { name: /^Forest plot: / }),
        'the synthetic forest plot',
      )
      break
    case 'Registry':
      await requireVisible(
        page.getByRole('table', { name: 'Recently registered subjects' }),
        'the populated registry table',
      )
      await requireVisible(
        page.getByText('sub-001', { exact: true }),
        'the deterministic registry row',
      )
      break
    case 'Pipeline':
      await requireVisible(
        page.getByText('Stages', { exact: true }),
        'the stage list',
      )
      await requireVisible(
        page.locator('main [role="switch"][aria-label$=" stage"]'),
        'the stage controls',
        11,
      )
      break
    case 'Diagnostics':
      await requireVisible(
        page.getByRole('button', {
          name: 'Show only Platform',
          exact: true,
        }),
        'the deterministic populated environment group',
      )
      break
    case 'Settings':
      await requireVisible(
        page.getByText('Display and behavior', { exact: true }),
        'machine-local display preferences',
      )
      await requireVisible(
        page.getByText('About', { exact: true }),
        'the About card',
      )
      break
    case 'Setup':
      await requireVisible(
        page.getByText(/^Step 1 of \d+$/),
        'the setup step counter',
      )
      break
    default:
      break
  }
}

/** Redact synthetic demographics and timestamps in documentation captures. */
async function applyDocumentationPresentation(page, screenName) {
  await page.evaluate((requestedScreen) => {
    const replaceText = (element, replacement) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const nodes = []
      let node = walker.nextNode()
      while (node) {
        // A hidden reserve (data-reserve) only holds a line's room; the
        // visible line is the one to redact, and the reserve keeps its size.
        if (
          node.nodeValue?.trim() &&
          !node.parentElement?.closest('[data-reserve]')
        ) {
          nodes.push(node)
        }
        node = walker.nextNode()
      }
      if (nodes[0]) nodes[0].nodeValue = replacement
      for (const extra of nodes.slice(1)) extra.nodeValue = ''
    }
    const sanitizeTime = (raw) =>
      raw
        .replace(
          /\b\d{1,2}\/\d{1,2}\/20\d{2},?\s+(?:at\s+)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?/gi,
          'at a redacted time',
        )
        .replace(
          /\b20\d{2}-\d{2}-\d{2}(?:[T ][0-9:.+-]+Z?)?\b/gi,
          'at a redacted time',
        )
        .replace(
          /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?(?:\s+at)?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?\b/gi,
          'at a redacted time',
        )
        .replace(
          /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\b/gi,
          'at a redacted time',
        )
        .replace(
          /\b(?:just now|\d+\s+(?:seconds?|minutes?|hours?|days?)\s+ago)\b/gi,
          'at a redacted time',
        )

    for (const table of document.querySelectorAll('[role="table"]')) {
      const rows = [...table.querySelectorAll('[role="row"]')]
      const headerRow = rows.find((row) =>
        [...row.children].some(
          (child) => child.getAttribute('role') === 'columnheader',
        ),
      )
      if (!headerRow) continue
      const headers = [...headerRow.children]
        .filter((child) => child.getAttribute('role') === 'columnheader')
        .map((child) =>
          (child.textContent ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z]+/g, '-'),
        )
      for (const row of rows) {
        if (row === headerRow) continue
        const cells = [...row.children].filter((child) =>
          ['cell', 'rowheader'].includes(child.getAttribute('role') ?? ''),
        )
        for (const [index, header] of headers.entries()) {
          const cell = cells[index]
          if (!cell) continue
          if (
            ['age-sex', 'age-and-sex'].includes(header) ||
            header.startsWith('cohort') ||
            header.startsWith('ais') ||
            header === 'updated'
          ) {
            replaceText(cell, 'Redacted')
            cell.setAttribute('aria-label', 'Redacted')
            cell.setAttribute('title', 'Redacted')
          }
        }
      }
    }

    if (requestedScreen === 'QC Review') {
      const heading = [...document.querySelectorAll('main h1')].find((item) =>
        /^Subject\s+\S+$/.test(item.textContent?.trim() ?? ''),
      )
      if (heading?.nextElementSibling) {
        replaceText(
          heading.nextElementSibling,
          'Synthetic participant metadata is redacted.',
        )
      }
      const queue = document.querySelector('[aria-label="Subject queue"]')
      for (const button of queue?.querySelectorAll('button') ?? []) {
        const cohort = [...button.querySelectorAll('span')].find((span) =>
          ['CTRL', 'SCI_nNP', 'SCI_P'].includes(span.title),
        )
        if (cohort) {
          replaceText(cohort, 'Redacted')
          cohort.setAttribute('title', 'Redacted')
        }
        const label = button.getAttribute('aria-label')
        if (label) {
          button.setAttribute(
            'aria-label',
            label.replace(/, (?:CTRL|SCI_nNP|SCI_P),/, ', Redacted,'),
          )
        }
      }
      const note = document.querySelector('[aria-label="Reviewer note"]')
      if (note instanceof HTMLTextAreaElement) {
        note.value = 'Redacted'
        note.placeholder = 'Redacted'
        note.setAttribute('value', 'Redacted')
      }
    }

    for (const row of document.querySelectorAll('[data-level]')) {
      const timestamp = row.firstElementChild
      if (timestamp) replaceText(timestamp, 'Redacted')
    }
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    )
    let node = walker.nextNode()
    while (node) {
      node.nodeValue = sanitizeTime(node.nodeValue ?? '')
      node = walker.nextNode()
    }
    for (const element of document.body.querySelectorAll('*')) {
      for (const attribute of [
        'aria-label',
        'aria-description',
        'placeholder',
        'title',
      ]) {
        if (element.hasAttribute(attribute)) {
          element.setAttribute(
            attribute,
            sanitizeTime(element.getAttribute(attribute) ?? ''),
          )
        }
      }
    }
  }, screenName)
  await page.waitForTimeout(50)
}

/** Verify the visible state coverage required by documentation captures. */
async function assertDocumentationState(page, screenName, stateName) {
  const shell = await page.evaluate(() => {
    const project = document.querySelector(
      '[aria-label="Current project: Synthetic documentation study"]',
    )
    const rect = project?.getBoundingClientRect()
    return {
      theme: document.documentElement.dataset.theme ?? null,
      projectVisible:
        project instanceof HTMLElement &&
        Boolean(rect) &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        project.scrollWidth <= project.clientWidth + 1,
      redacted: document.body.innerText.toLowerCase().includes('redacted'),
    }
  })
  if (shell.theme !== 'dark' || !shell.projectVisible || !shell.redacted) {
    throw new Error(
      `Present the complete dark synthetic documentation shell: ${JSON.stringify(shell)}.`,
    )
  }

  const requireCount = async (locator, description, minimum = 1) => {
    const count = await locator.count()
    if (count < minimum) {
      throw new Error(
        `Show ${description} in the ${screenName} documentation capture; found ${count}.`,
      )
    }
  }
  switch (screenName) {
    case 'Dashboard':
      for (const state of ['Done', 'Running', 'Failed', 'Pending']) {
        await requireCount(
          page.getByRole('button', {
            name: new RegExp(`\\(${state}: [1-9]\\d*\\)`),
          }),
          `a positive ${state.toLowerCase()} subject count`,
        )
      }
      {
        // Needs attention leaves Excluded subjects out, as the Failed tile
        // does, so the two state the same number of failed subjects.
        const tile = await page
          .getByRole('button', { name: /\(Failed: \d+\)/ })
          .first()
          .getAttribute('aria-label')
        const failed = /\(Failed: (\d+)\)/.exec(tile ?? '')?.[1]
        await requireCount(
          page.getByText(new RegExp(`(^|: )${failed} failed(,|$)`)),
          `Needs attention counting the ${failed} failed subjects of the Failed tile`,
        )
      }
      for (const label of ['Run completed', 'Run in progress', 'Run failed']) {
        await requireCount(
          page.getByLabel(label, { exact: true }),
          `the ${label.toLowerCase()} history state`,
        )
      }
      break
    case 'Subjects':
      for (const state of ['Done', 'Running', 'Failed', 'Pending']) {
        await requireCount(
          page.getByRole('radio', {
            name: new RegExp(`^${state} [1-9]\\d*$`),
          }),
          `a positive ${state.toLowerCase()} filter count`,
        )
      }
      await requireCount(
        page.locator('[aria-label*=": done,"]'),
        'a completed matrix state',
      )
      await requireCount(
        page.locator('[aria-label*=": running,"]'),
        'a running matrix state',
      )
      await requireCount(
        page.locator('[aria-label*=": failed,"]'),
        'a failed matrix state',
      )
      {
        const ageAndSexCells = page.locator(
          '[role="table"][aria-label="Subjects matrix"] [role="row"] [role="cell"]:nth-child(3)',
        )
        const values = (await ageAndSexCells.allTextContents()).map((value) =>
          value.trim(),
        )
        if (
          values.length === 0 ||
          values.some((value) => value !== 'Redacted')
        ) {
          throw new Error(
            `Redact every age-and-sex cell in the Subjects documentation capture: ${JSON.stringify(values)}.`,
          )
        }
      }
      break
    case 'Runs':
      for (const state of ['done', 'running', 'failed']) {
        await requireCount(
          page.getByText(new RegExp(`^[1-9]\\d* ${state}( of \\d+)?$`)),
          `a nonzero ${state} stage count`,
        )
      }
      break
    case 'Logs':
      for (const level of ['INFO', 'WARN', 'ERROR']) {
        await requireCount(
          page.locator(`[data-level="${level}"]`),
          `${level} log output`,
        )
      }
      for (const state of ['Done', 'Running', 'Queued', 'Failed', 'Blocked']) {
        await requireCount(
          page.getByText(state, { exact: true }),
          `a ${state.toLowerCase()} job`,
        )
      }
      {
        // The Run list and the collapsed Run details name one run. Open the
        // details for the check, then close them for the capture.
        const focusRunId = await page
          .getByRole('complementary', { name: 'Jobs' })
          .getByRole('combobox', { name: 'Run', exact: true })
          .inputValue()
        const controls = page.getByRole('complementary', { name: 'Controls' })
        const details = controls.getByRole('button', { name: 'Run details' })
        await details.click()
        await requireCount(
          controls.getByText(focusRunId, { exact: true }),
          `the Run list's run ${focusRunId} in the Run details`,
        )
        await details.click()
      }
      break
    case 'QC Review': {
      const montage = page.getByRole('group', {
        name: /^External cortical montage for /,
      })
      await montage.waitFor({ state: 'attached' })
      if (
        await page
          .getByText(/gallery is produced yet\./, { exact: false })
          .isVisible()
      ) {
        throw new Error(
          'Show the QC panels instead of the missing-artifact state.',
        )
      }
      await requireCount(
        page.getByText('4/4 panels verified and drawn.', { exact: true }),
        'the drawn placeholder panel tally',
      )
      await requireCount(
        montage.locator('[data-qc-panel]').locator('img'),
        'the placeholder QC panels',
        4,
      )
      if (
        await page
          .getByText('Loading the panels...', { exact: true })
          .isVisible()
      ) {
        throw new Error('Capture the QC panels after they finish loading.')
      }
      for (const verdict of ['Pass', 'Fail', 'Defer', 'Unreviewed']) {
        await requireCount(
          page.getByText(verdict, { exact: true }),
          `the ${verdict.toLowerCase()} QC verdict`,
        )
      }
      break
    }
    case 'Results':
      for (const state of [
        'Produced',
        'Partial',
        'Expected',
        'Absent',
        'Unknown',
      ]) {
        await requireCount(
          page.getByText(state, { exact: true }),
          `the ${state.toLowerCase()} result state`,
        )
      }
      break
    case 'Analysis': {
      // The judged synthetic result on the Forest tab, or the v2 battery on
      // its Grid tab; documentation captures never draw a brain.
      await requireCount(
        page.getByText('Current', { exact: true }),
        'the current result chip',
      )
      if (stateName === 'analysis-grid') {
        await requireCount(
          page.getByRole('table', { name: /^Grid of / }),
          'the synthetic v2 grid',
        )
      } else {
        await requireCount(
          page.getByRole('img', { name: /^Forest plot: / }),
          'the synthetic forest plot',
        )
      }
      const canvases = await page.locator('main canvas').count()
      if (canvases !== 0) {
        throw new Error(
          `Keep the Analysis documentation capture free of brain drawings; found ${canvases}.`,
        )
      }
      break
    }
    case 'Diagnostics':
      for (const state of [
        'found',
        'warning',
        'wrong version',
        'missing',
        'not checked',
      ]) {
        await requireCount(
          page.getByText(new RegExp(`^${state}$`, 'i')),
          `the ${state} diagnostic state`,
        )
      }
      break
    default:
      throw new Error(`Define documentation-state coverage for ${screenName}.`)
  }
}

async function assertAppliedVariant(page) {
  const expectedDensity = {
    Compact: { inputH: '26px', bodyPadY: '9px', barH: '40px' },
    Cozy: { inputH: '28px', bodyPadY: '12px', barH: '44px' },
    Comfortable: { inputH: '30px', bodyPadY: '16px', barH: '50px' },
  }[densityName]
  const expectedZoom = { 100: '1', 115: '1.15', 135: '1.35' }[textScale]
  const requestedTheme = light ? 'light' : dark ? 'dark' : null
  const read = () =>
    page.evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement)
      const heading = document.querySelector('main h1')
      const header = heading?.parentElement?.parentElement
      return {
        resolvedTheme: document.documentElement.dataset.theme ?? null,
        colorScheme: document.documentElement.style.colorScheme,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        zoom: rootStyle.getPropertyValue('--ss-zoom').trim(),
        inputH: rootStyle.getPropertyValue('--ss-input-h').trim(),
        bodyPadY: rootStyle.getPropertyValue('--ss-body-pad-y').trim(),
        barH: rootStyle.getPropertyValue('--ss-bar-h').trim(),
        reducedMotion: document.documentElement.getAttribute(
          'data-reduced-motion',
        ),
        mediaReducedMotion: matchMedia('(prefers-reduced-motion: reduce)')
          .matches,
        mediaDark: matchMedia('(prefers-color-scheme: dark)').matches,
        headerBorder:
          header instanceof HTMLElement
            ? getComputedStyle(header).borderBottomColor
            : null,
      }
    })
  let evidence = await read()
  const resolvedExpected =
    requestedTheme ??
    (systemTheme ? (evidence.mediaDark ? 'dark' : 'light') : null)
  if (
    resolvedExpected &&
    (evidence.resolvedTheme !== resolvedExpected ||
      evidence.colorScheme !== resolvedExpected)
  ) {
    throw new Error(
      `Apply the theme variant: ${JSON.stringify({ resolvedExpected, evidence })}.`,
    )
  }
  if (
    expectedDensity &&
    (evidence.inputH !== expectedDensity.inputH ||
      evidence.bodyPadY !== expectedDensity.bodyPadY ||
      evidence.barH !== expectedDensity.barH)
  ) {
    throw new Error(
      `Apply the density variant: ${JSON.stringify({ expectedDensity, evidence })}.`,
    )
  }
  if (expectedZoom && evidence.zoom !== expectedZoom) {
    throw new Error(
      `Apply the text-scale variant: ${JSON.stringify({ expectedZoom, evidence })}.`,
    )
  }
  if (
    reducedMotion &&
    (evidence.reducedMotion !== 'true' || !evidence.mediaReducedMotion)
  ) {
    throw new Error(
      `Apply the reduced-motion variant: ${JSON.stringify(evidence)}.`,
    )
  }
  if (hc && evidence.resolvedTheme) {
    const highContrastExpected = {
      dark: {
        headerBorder: 'rgb(58, 65, 78)',
      },
      light: {
        headerBorder: 'rgb(182, 188, 196)',
      },
    }[evidence.resolvedTheme]
    if (
      highContrastExpected &&
      evidence.headerBorder !== highContrastExpected.headerBorder
    ) {
      throw new Error(
        `Apply the high-contrast variant: ${JSON.stringify({ highContrastExpected, evidence })}.`,
      )
    }
  }
  if (systemTheme) {
    const original = evidence.resolvedTheme
    const opposite = original === 'dark' ? 'light' : 'dark'
    await page.emulateMedia({
      colorScheme: opposite,
      reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    })
    await page.waitForFunction(
      (theme) =>
        document.documentElement.dataset.theme === theme &&
        document.documentElement.style.colorScheme === theme,
      opposite,
    )
    const transitioned = await read()
    const systemControl = page
      .getByRole('radio', { name: 'System', exact: true })
      .first()
    if (
      (await systemControl.getAttribute('aria-checked')) !== 'true' ||
      transitioned.bodyBackground === evidence.bodyBackground
    ) {
      throw new Error(
        `Keep System theme selected across a live OS change: ${JSON.stringify({ evidence, transitioned })}.`,
      )
    }
    await page.emulateMedia({
      colorScheme: original,
      reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    })
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      original,
    )
    evidence = {
      ...evidence,
      liveSystemTransition: {
        from: original,
        to: transitioned.resolvedTheme,
        bodyBackgroundChanged:
          transitioned.bodyBackground !== evidence.bodyBackground,
        selectionPreserved: true,
      },
    }
  }
  return evidence
}

async function assertSequentialKeyboardTraversal(page) {
  const expected = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll(
        'button, input, select, textarea, a[href], summary, [tabindex]',
      ),
    ).filter((element) => {
      if (!(element instanceof HTMLElement)) return false
      const style = getComputedStyle(element)
      return (
        element.tabIndex >= 0 &&
        !('disabled' in element && element.disabled === true) &&
        element.getClientRects().length > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        !element.closest('[aria-hidden="true"], [inert]')
      )
    })
    const positives = candidates
      .filter((element) => element.tabIndex > 0)
      .sort((left, right) => left.tabIndex - right.tabIndex)
    const ordered = [
      ...positives,
      ...candidates.filter((element) => element.tabIndex === 0),
    ]
    return ordered.map((element, index) => {
      const id = `tab-order-${index + 1}`
      element.setAttribute('data-supraspina-tab-order-id', id)
      return {
        id,
        tag: element.tagName,
        name:
          element.getAttribute('aria-label') ||
          element.textContent?.trim().slice(0, 80) ||
          element.getAttribute('name') ||
          '',
      }
    })
  })
  // The bound keeps one traversal short; the sites fixture's Subjects matrix
  // alone holds 24 rows of ten status cells.
  if (expected.length === 0 || expected.length > 400) {
    throw new Error(
      `Keep the sequential focus target count between 1 and 400; found ${expected.length}.`,
    )
  }
  await page.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
  })
  const visited = []
  for (const target of expected) {
    await page.keyboard.press('Tab')
    const actual = await page.evaluate(() => {
      const element = document.activeElement
      if (!(element instanceof HTMLElement)) return null
      const style = getComputedStyle(element)
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
      const composite = (front, back) => ({
        r: front.r * front.a + back.r * (1 - front.a),
        g: front.g * front.a + back.g * (1 - front.a),
        b: front.b * front.a + back.b * (1 - front.a),
        a: 1,
      })
      const background = (start) => {
        const layers = []
        let current = start
        while (current instanceof Element) {
          const color = parseColor(getComputedStyle(current).backgroundColor)
          if (color && color.a > 0) layers.push(color)
          current = current.parentElement
        }
        let result = { r: 255, g: 255, b: 255, a: 1 }
        for (const layer of layers.reverse()) result = composite(layer, result)
        return result
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
      const contrast = (left, right) => {
        const a = luminance(left)
        const b = luminance(right)
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      }
      const adjacent = background(element.parentElement)
      const outline = parseColor(style.outlineColor)
      const renderedOutline = outline ? composite(outline, adjacent) : null
      const zoom = Number.parseFloat(
        getComputedStyle(document.getElementById('root')).zoom || '1',
      )
      const rect = element.getBoundingClientRect()
      return {
        id: element.getAttribute('data-supraspina-tab-order-id'),
        html: element.outerHTML.slice(0, 240),
        visible:
          element.getClientRects().length > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth) * zoom,
        outlineContrast: renderedOutline
          ? contrast(renderedOutline, adjacent)
          : null,
      }
    })
    if (
      !actual ||
      actual.id !== target.id ||
      !actual.visible ||
      actual.outlineStyle === 'none' ||
      actual.outlineWidth < 1.9 ||
      actual.outlineContrast === null ||
      actual.outlineContrast < 3
    ) {
      throw new Error(
        `Follow the sequential keyboard order and show qualifying focus: ${JSON.stringify({ expected: target, actual, visited: visited.slice(-4) })}.`,
      )
    }
    visited.push(target.id)
  }
  if (expected.length > 1) {
    await page.keyboard.press('Shift+Tab')
    const reverseId = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-supraspina-tab-order-id'),
    )
    if (reverseId !== expected.at(-2).id) {
      throw new Error(
        `Follow the reverse keyboard order; expected ${expected.at(-2).id}, got ${reverseId}.`,
      )
    }
    await page.keyboard.press('Tab')
  }
  await page.evaluate(() => {
    document.body.focus()
  })
  return { count: expected.length, visited: visited.length }
}

async function assertFirstRunKeyboardTraversal(page) {
  const sequential = await assertSequentialKeyboardTraversal(page)
  const dialog = page.getByRole('dialog', { name: 'Welcome to Supraspina' })
  const controls = dialog.locator(
    'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([tabindex="-1"]), select:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled):not([tabindex="-1"]), a[href]:not([tabindex="-1"])',
  )
  const count = await controls.count()
  if (count !== sequential.count) {
    throw new Error(
      `Keep every first-run sequential target inside the dialog: ${JSON.stringify({ dialog: count, sequential: sequential.count })}.`,
    )
  }
  await controls.first().focus()
  await page.keyboard.press('Shift+Tab')
  const wrappedBackward = await controls
    .last()
    .evaluate((element) => element === document.activeElement)
  await page.keyboard.press('Tab')
  const wrappedForward = await controls
    .first()
    .evaluate((element) => element === document.activeElement)
  const containment = await dialog.evaluate((element) => ({
    focusContained: element.contains(document.activeElement),
    inertOutsideCount: Array.from(document.querySelectorAll('[inert]')).filter(
      (candidate) => !candidate.contains(element),
    ).length,
  }))
  if (
    !wrappedBackward ||
    !wrappedForward ||
    !containment.focusContained ||
    containment.inertOutsideCount < 1
  ) {
    throw new Error(
      `Trap first-run keyboard focus and make the background inert: ${JSON.stringify({ wrappedBackward, wrappedForward, containment })}.`,
    )
  }
  await page.evaluate(() => document.body.focus())
  return {
    ...sequential,
    surface: 'first-run-dialog',
    wrappedBackward,
    wrappedForward,
    ...containment,
  }
}

async function assertElementFocusIndicator(locator, context) {
  const evidence = await locator.evaluate((element) => {
    const style = getComputedStyle(element)
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
    const composite = (front, back) => ({
      r: front.r * front.a + back.r * (1 - front.a),
      g: front.g * front.a + back.g * (1 - front.a),
      b: front.b * front.a + back.b * (1 - front.a),
      a: 1,
    })
    const layers = []
    let current = element.parentElement
    while (current instanceof Element) {
      const color = parseColor(getComputedStyle(current).backgroundColor)
      if (color && color.a > 0) layers.push(color)
      current = current.parentElement
    }
    let adjacent = { r: 255, g: 255, b: 255, a: 1 }
    for (const layer of layers.reverse()) adjacent = composite(layer, adjacent)
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
    const contrast = (left, right) => {
      const a = luminance(left)
      const b = luminance(right)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    const outline = parseColor(style.outlineColor)
    const renderedOutline = outline ? composite(outline, adjacent) : null
    const zoom = Number.parseFloat(
      getComputedStyle(document.getElementById('root')).zoom || '1',
    )
    return {
      active: element === document.activeElement,
      visible: element.getClientRects().length > 0,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth) * zoom,
      outlineColor: style.outlineColor,
      outlineContrast: renderedOutline
        ? contrast(renderedOutline, adjacent)
        : null,
    }
  })
  if (
    !evidence.active ||
    !evidence.visible ||
    evidence.outlineStyle === 'none' ||
    evidence.outlineWidth < 1.9 ||
    evidence.outlineContrast === null ||
    evidence.outlineContrast < 3
  ) {
    throw new Error(
      `Provide a qualifying focus indicator for ${context}: ${JSON.stringify(evidence)}.`,
    )
  }
  return evidence
}

async function exerciseMenuSemantics(page, mode, requestedScreen) {
  const trigger =
    mode === 'open'
      ? page.getByRole('button', { name: 'Open a saved project' }).first()
      : page
          .locator('nav[aria-label="Primary"] button[aria-haspopup="menu"]')
          .first()
  const menu =
    mode === 'more'
      ? page.getByRole('menu', { name: 'More workspaces' })
      : page.getByRole('menu', { name: 'Open project' })
  const isActive = (locator) =>
    locator.evaluate((item) => item === document.activeElement)
  const openWithPointer = async () => {
    await trigger.click()
    await menu.waitFor()
    const items = menu.getByRole('menuitem')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('role') === 'menuitem',
    )
    if (!(await isActive(items.first()))) {
      throw new Error(`Focus the first ${mode} menu item after pointer open.`)
    }
    return items
  }
  const items = await openWithPointer()
  const count = await items.count()
  if (count < 2) {
    throw new Error(`Provide at least two deterministic ${mode} menu items.`)
  }
  await page.keyboard.press('End')
  if (!(await isActive(items.last())))
    throw new Error(`Focus the last ${mode} menu item with End.`)
  await page.keyboard.press('Home')
  if (!(await isActive(items.first())))
    throw new Error(`Focus the first ${mode} menu item with Home.`)
  await page.keyboard.press('ArrowDown')
  if (!(await isActive(items.nth(1))))
    throw new Error(`Advance ${mode} menu focus with ArrowDown.`)
  await page.keyboard.press('ArrowUp')
  if (!(await isActive(items.first())))
    throw new Error(`Reverse ${mode} menu focus with ArrowUp.`)
  await page.keyboard.press('ArrowUp')
  if (!(await isActive(items.last())))
    throw new Error(`Wrap ${mode} menu focus to the last item with ArrowUp.`)
  await page.keyboard.press('ArrowDown')
  if (!(await isActive(items.first())))
    throw new Error(`Wrap ${mode} menu focus to the first item with ArrowDown.`)
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  if (!(await isActive(trigger)))
    throw new Error(`Return ${mode} menu focus to its trigger with Escape.`)

  await trigger.focus()
  await page.keyboard.press('ArrowUp')
  await menu.waitFor()
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('role') === 'menuitem',
  )
  if (!(await isActive(menu.getByRole('menuitem').last()))) {
    throw new Error(
      `Focus the last ${mode} menu item from its trigger with ArrowUp.`,
    )
  }
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })

  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await menu.waitFor()
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('role') === 'menuitem',
  )
  if (!(await isActive(menu.getByRole('menuitem').first()))) {
    throw new Error(
      `Focus the first ${mode} menu item from its trigger with ArrowDown.`,
    )
  }
  if (mode === 'more') {
    // The menu holds whichever tabs do not fit, and Settings is always the
    // last of them, so activate that one at any width.
    const settingsItem = menu.getByRole('menuitem', {
      name: 'Settings',
      exact: true,
    })
    await settingsItem.focus()
    if (!(await isActive(settingsItem))) {
      throw new Error('Focus Settings for activation from the More menu.')
    }
    await page.keyboard.press('Enter')
    await menu.waitFor({ state: 'detached' })
    await page
      .locator('main h1')
      .filter({ hasText: /^Settings$/ })
      .waitFor()
    await clickNav(
      page,
      requestedScreen === 'QC Review' ? 'QC review' : requestedScreen,
    )
  } else {
    // Close this keyboard-opened menu without invoking a native picker because
    // the deterministic project is already open.
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
  }
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await menu.waitFor()
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('role') === 'menuitem',
  )
  const finalItems = menu.getByRole('menuitem')
  if (!(await isActive(finalItems.first()))) {
    throw new Error(
      `Focus the first ${mode} menu item after the final keyboard open.`,
    )
  }
  return { items: await finalItems.count(), activation: mode === 'more' }
}

async function exerciseRunDialog(page) {
  const opener = page.getByRole('button', { name: /^Run all \d+/ }).first()
  const dialog = page.getByRole('dialog', {
    name: 'Review the run plan?',
  })
  const open = async () => {
    await opener.focus()
    await page.keyboard.press('Enter')
    await dialog.waitFor()
    await page.waitForFunction(
      () =>
        document.activeElement instanceof HTMLButtonElement &&
        document.activeElement.textContent?.trim() === 'Cancel',
    )
    await assertElementFocusIndicator(
      dialog.getByRole('button', { name: 'Cancel', exact: true }),
      'run dialog initial Cancel',
    )
  }
  await open()
  const focusables = dialog.locator(
    'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([tabindex="-1"]), select:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"]):not(:disabled)',
  )
  const count = await focusables.count()
  if (count < 2)
    throw new Error('Provide a bounded focus sequence in the run dialog.')
  await focusables.first().focus()
  await page.keyboard.press('Shift+Tab')
  if (
    !(await focusables
      .last()
      .evaluate((element) => element === document.activeElement))
  ) {
    throw new Error(
      'Wrap focus from the first to the last control in the run dialog with Shift+Tab.',
    )
  }
  await page.keyboard.press('Tab')
  if (
    !(await focusables
      .first()
      .evaluate((element) => element === document.activeElement))
  ) {
    throw new Error(
      'Wrap focus from the last to the first control in the run dialog with Tab.',
    )
  }
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  if (
    !(await opener.evaluate((element) => element === document.activeElement))
  ) {
    throw new Error('Return focus from the run dialog to its Run trigger.')
  }
  await open()
  return { focusableControls: count, initialFocus: 'Cancel' }
}

async function assertAccessibility(
  page,
  hasProject,
  hasFirstRunDialog,
  expectedState,
  screenName,
) {
  const semanticIssues = await page.evaluate(
    ({ projectLoaded, state, screenLabel }) => {
      const issues = []
      for (const control of document.querySelectorAll(
        'button:disabled, input:disabled, select:disabled, textarea:disabled',
      )) {
        const labels = Array.from(control.labels || [])
          .map((label) => label.textContent || '')
          .join(' ')
        const name =
          control.getAttribute('aria-label') ||
          control.getAttribute('aria-labelledby') ||
          control.getAttribute('title') ||
          labels ||
          control.textContent ||
          ''
        if (!name.trim()) issues.push('Name every disabled control accessibly.')
        const describedBy = control.getAttribute('aria-describedby')
        if (describedBy) {
          for (const id of describedBy.split(/\s+/)) {
            if (!document.getElementById(id)) {
              issues.push(
                `Provide description ${id} referenced by the disabled control.`,
              )
            }
          }
        }
      }
      const bodyText = document.body.textContent || ''
      // The run dock states the cohort load and the run history restore. Runs
      // draws no dock but states them on the page beside its own Add subject;
      // Setup and QC review have neither.
      const runDock = Array.from(document.querySelectorAll('button')).some(
        (button) =>
          button.textContent?.trim() === 'Add subject' &&
          button.getClientRects().length > 0,
      )
      const expectedPattern = {
        'registration-running':
          screenLabel === 'QC Review'
            ? /Surface registration: \d+ of \d+ checked/
            : null,
      }[state]
      if (expectedPattern && !expectedPattern.test(bodyText)) {
        issues.push(`Communicate the ${state} fixture in rendered text.`)
      }
      const expectedText = {
        loading: 'Checking the environment...',
        'cohort-loading': runDock ? 'Loading the cohort...' : null,
        'runtime-restoring': runDock ? 'Restoring run history...' : null,
        validation:
          'Choose an absolute output directory before this configuration can run.',
        blocking:
          'Runtime resources and automatic choices appear during exact plan review.',
        blocked:
          'Runtime resources and automatic choices appear during exact plan review.',
        error: 'The deterministic tool inspection failed.',
        long: 'sub-long-content-identifier-with-many-segments-for-layout-verification-001',
      }[state]
      if (expectedText && !bodyText.includes(expectedText)) {
        issues.push(`Communicate the ${state} fixture in rendered text.`)
      }
      if (projectLoaded && state === 'populated' && !bodyText.trim()) {
        issues.push('Render content for the populated fixture.')
      }
      return issues
    },
    {
      projectLoaded: hasProject,
      state: expectedState,
      screenLabel: screenName,
    },
  )
  if (semanticIssues.length > 0) {
    throw new Error(
      `Resolve the accessibility semantics findings: ${semanticIssues.join('; ')}.`,
    )
  }

  const existingDialog = page.getByRole('dialog').first()
  const hasExistingDialog = (await existingDialog.count()) > 0
  const existingMenu = page.getByRole('menu').first()
  const hasExistingMenu = (await existingMenu.count()) > 0
  if (hasExistingDialog) {
    await existingDialog.waitFor()
  } else if (hasExistingMenu) {
    await existingMenu.waitFor()
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute('role') === 'menuitem' &&
        Boolean(document.activeElement.closest('[role="menu"]')),
    )
  } else {
    // Establish a deterministic pre-tab origin. Avoid pointer-dependent Tab
    // ordering, which can place the next focus target after every control on a
    // sparse screen.
    await page.evaluate(() => {
      document.body.tabIndex = -1
      document.body.focus()
    })
  }
  if (!hasExistingMenu) await page.keyboard.press('Tab')
  const focus = await page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return null
    const style = getComputedStyle(active)
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
    const composite = (front, back) => ({
      r: front.r * front.a + back.r * (1 - front.a),
      g: front.g * front.a + back.g * (1 - front.a),
      b: front.b * front.a + back.b * (1 - front.a),
      a: 1,
    })
    const background = (element) => {
      const layers = []
      let current = element
      while (current instanceof Element) {
        const color = parseColor(getComputedStyle(current).backgroundColor)
        if (color && color.a > 0) layers.push(color)
        current = current.parentElement
      }
      let result = { r: 255, g: 255, b: 255, a: 1 }
      for (const layer of layers.reverse()) result = composite(layer, result)
      return result
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
    const contrast = (left, right) => {
      const a = luminance(left)
      const b = luminance(right)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    const outline = parseColor(style.outlineColor)
    const adjacent = background(active.parentElement)
    const renderedOutline = outline ? composite(outline, adjacent) : null
    const rootZoom = Number.parseFloat(
      getComputedStyle(document.getElementById('root')).zoom || '1',
    )
    const outlineWidth = Number.parseFloat(style.outlineWidth)
    return {
      tag: active.tagName,
      visible: active.getClientRects().length > 0,
      outlineWidth,
      renderedOutlineWidth: outlineWidth * rootZoom,
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
      outlineContrast: renderedOutline
        ? contrast(renderedOutline, adjacent)
        : null,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      inertRegions: document.querySelectorAll('[inert]').length,
      buttons: document.querySelectorAll('button').length,
      tabbableControls: Array.from(
        document.querySelectorAll(
          'button, input, select, textarea, a[href], summary, [tabindex]',
        ),
      ).filter(
        (element) =>
          element instanceof HTMLElement &&
          element.tabIndex >= 0 &&
          element.getClientRects().length > 0 &&
          !element.closest('[inert]'),
      ).length,
    }
  })
  if (
    !focus ||
    !focus.visible ||
    focus.tag === 'BODY' ||
    focus.outlineStyle === 'none' ||
    focus.renderedOutlineWidth < 1.9 ||
    focus.outlineContrast === null ||
    focus.outlineContrast < 3
  ) {
    throw new Error(`Provide visible keyboard focus: ${JSON.stringify(focus)}.`)
  }

  if (hasExistingMenu) {
    const contained = await existingMenu.evaluate((element) =>
      element.contains(document.activeElement),
    )
    if (!contained) throw new Error('Keep keyboard focus inside the open menu.')
  } else if (hasExistingDialog) {
    const dialog = existingDialog
    const controls = dialog.locator(
      'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([tabindex="-1"]), select:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), summary:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"]):not(:disabled)',
    )
    const count = await controls.count()
    if (count === 0) throw new Error('Provide keyboard controls in the dialog.')
    await controls.first().focus()
    await page.keyboard.press('Shift+Tab')
    if (
      !(await controls
        .last()
        .evaluate((element) => element === document.activeElement))
    ) {
      throw new Error(
        'Wrap focus from the first to the final dialog control with Shift+Tab.',
      )
    }
    await page.keyboard.press('Tab')
    if (
      !(await controls
        .first()
        .evaluate((element) => element === document.activeElement))
    ) {
      throw new Error(
        'Wrap focus from the final to the first dialog control with Tab.',
      )
    }
  } else if (hasProject) {
    const trigger = page.getByRole('button', { name: 'Open command palette' })
    await trigger.focus()
    await trigger.click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('role') === 'combobox',
    )
    await assertElementFocusIndicator(
      page.getByRole('combobox', { name: 'Command palette query' }),
      'command palette query',
    )
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab')
      const contained = await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      )
      if (!contained) {
        const active = await page.evaluate(() =>
          document.activeElement?.outerHTML.slice(0, 240),
        )
        throw new Error(
          `Keep keyboard focus inside the command palette at Tab ${index + 1}: ${active}.`,
        )
      }
    }
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    if (
      !(await trigger.evaluate((element) => element === document.activeElement))
    ) {
      throw new Error('Return focus from the command palette to its trigger.')
    }
  }
}

async function runAxeAudit(page) {
  await page.addScriptTag({ path: AXE_PATH })
  return page.evaluate(async () => {
    const results = await globalThis.axe.run(document, {
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
      rules: {
        'target-size': { enabled: true },
      },
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
      testEnvironment: results.testEnvironment,
      testRunner: results.testRunner,
      timestamp: results.timestamp,
      url: results.url,
      violations: results.violations.map(serialise),
      incomplete: results.incomplete.map(serialise),
    }
  })
}

async function runApplicationAccessibilityAudit(page) {
  return page.evaluate(() => {
    const findings = []
    const contrastChecks = []
    const nonTextContrastChecks = []
    const componentContrastChecks = []
    const targetChecks = []
    let auditSequence = 0

    const rendered = (element) => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement))
        return false
      const style = getComputedStyle(element)
      return (
        element.getClientRects().length > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number.parseFloat(style.opacity || '1') > 0
      )
    }
    const visible = (element) =>
      rendered(element) && !element.closest('[aria-hidden="true"], [inert]')
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
        const parsed = parseColor(style.backgroundColor)
        if (parsed && parsed.a > 0) layers.push(parsed)
        current = current.parentElement
      }
      let result = { r: 255, g: 255, b: 255, a: 1 }
      for (const layer of layers.reverse()) result = composite(layer, result)
      return { color: result, image }
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
    const selector = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`
      const label = element.getAttribute('aria-label')
      if (label)
        return `${element.tagName.toLowerCase()}[aria-label="${label.slice(0, 80)}"]`
      const role = element.getAttribute('role')
      return `${element.tagName.toLowerCase()}${role ? `[role="${role}"]` : ''}`
    }
    const auditIdentity = (element) => {
      const existing = element.getAttribute('data-supraspina-a11y-audit-id')
      if (existing) return existing
      auditSequence += 1
      const identity = `audit-${auditSequence}`
      element.setAttribute('data-supraspina-a11y-audit-id', identity)
      return identity
    }
    const cumulativeOpacity = (element, style, pseudo = false) => {
      let opacity = Number.parseFloat(style.opacity || '1')
      let current = pseudo ? element : element.parentElement
      while (current instanceof Element) {
        opacity *= Number.parseFloat(getComputedStyle(current).opacity || '1')
        current = current.parentElement
      }
      return Math.min(1, Math.max(0, opacity))
    }
    const auditText = (element, style, variant) => {
      const auditId = auditIdentity(element)
      // SVG text and its tspans are drawn with fill, not color.
      const sourceColor =
        element instanceof SVGTextContentElement && variant === 'text'
          ? style.fill
          : style.color
      const foreground = parseColor(sourceColor)
      const underlay = background(element)
      if (!foreground) {
        findings.push({
          kind: 'text-contrast-unresolved',
          target: selector(element),
          auditId,
          variant,
          reason: `Parse the foreground color: ${sourceColor}.`,
        })
        return
      }
      if (underlay.image) {
        findings.push({
          kind: 'text-contrast-unresolved',
          target: selector(element),
          auditId,
          variant,
          reason: 'Render text over a solid background.',
        })
        return
      }
      foreground.a *= cumulativeOpacity(
        element,
        style,
        variant === 'placeholder',
      )
      const renderedForeground = composite(foreground, underlay.color)
      const exactRatio = ratio(renderedForeground, underlay.color)
      const fontSize = Number.parseFloat(style.fontSize)
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400
      const large =
        fontSize >= 24 || (fontSize >= 18.666666666666668 && fontWeight >= 700)
      const inactive = Boolean(
        element.closest(':disabled, [aria-disabled="true"]'),
      )
      const required = inactive ? 0 : large ? 3 : 4.5
      const check = {
        target: selector(element),
        auditId,
        variant,
        ratio: exactRatio,
        required,
        foreground: sourceColor,
        background: `rgb(${underlay.color.r}, ${underlay.color.g}, ${underlay.color.b})`,
        fontSize,
        fontWeight,
        inactive,
      }
      contrastChecks.push(check)
      if (exactRatio < required) {
        findings.push({ kind: 'text-contrast', ...check })
      }
    }

    for (const element of document.querySelectorAll('body *')) {
      if (!rendered(element)) continue
      const hasText = Array.from(element.childNodes).some(
        (node) =>
          node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      )
      const formText =
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
          ].includes(element.type)) ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      if (!hasText && !formText) continue
      const style = getComputedStyle(element)
      auditText(element, style, 'text')
      if (
        (element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement) &&
        element.placeholder
      ) {
        auditText(
          element,
          getComputedStyle(element, '::placeholder'),
          'placeholder',
        )
      }
    }

    for (const element of document.querySelectorAll(
      '[data-nontext-contrast]',
    )) {
      if (!rendered(element)) continue
      if (element.closest(':disabled, [aria-disabled="true"]')) continue
      const style = getComputedStyle(element)
      const auditId = auditIdentity(element)
      const foreground = parseColor(style.color)
      const underlay = background(element)
      if (!foreground || underlay.image) {
        findings.push({
          kind: 'nontext-contrast-unresolved',
          target: selector(element),
          auditId,
          reason: !foreground
            ? `Parse the foreground color: ${style.color}.`
            : 'Render the component over a solid background.',
        })
        continue
      }
      foreground.a *= cumulativeOpacity(element, style)
      const renderedForeground = composite(foreground, underlay.color)
      const exactRatio = ratio(renderedForeground, underlay.color)
      const check = {
        target: selector(element),
        auditId,
        ratio: exactRatio,
        required: 3,
        foreground: style.color,
        background: `rgb(${underlay.color.r}, ${underlay.color.g}, ${underlay.color.b})`,
      }
      nonTextContrastChecks.push(check)
      if (exactRatio < check.required) {
        findings.push({ kind: 'nontext-contrast', ...check })
      }
    }

    for (const element of document.querySelectorAll(
      'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [data-component-boundary]',
    )) {
      if (!rendered(element)) continue
      if (element.closest(':disabled, [aria-disabled="true"]')) continue
      const style = getComputedStyle(element)
      const auditId = auditIdentity(element)
      const inside = background(element)
      const outside = background(element.parentElement)
      if (inside.image || outside.image) {
        findings.push({
          kind: 'component-contrast-unresolved',
          target: selector(element),
          auditId,
          reason:
            'Keep the control boundary away from background images and gradients.',
        })
        continue
      }
      const fillRatio = ratio(inside.color, outside.color)
      const borderRatios = []
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const borderStyle = style[`border${side}Style`]
        const borderWidth = Number.parseFloat(style[`border${side}Width`])
        if (borderStyle === 'none' || borderWidth <= 0) continue
        const border = parseColor(style[`border${side}Color`])
        if (!border) continue
        border.a *= cumulativeOpacity(element, style)
        borderRatios.push(
          ratio(composite(border, outside.color), outside.color),
        )
      }
      const borderRatio =
        borderRatios.length > 0 ? Math.min(...borderRatios) : 0
      const identityRatio = Math.max(fillRatio, borderRatio)
      const check = {
        target: selector(element),
        auditId,
        ratio: identityRatio,
        required: 3,
        fillRatio,
        borderRatio,
        inside: `rgb(${inside.color.r}, ${inside.color.g}, ${inside.color.b})`,
        outside: `rgb(${outside.color.r}, ${outside.color.g}, ${outside.color.b})`,
      }
      componentContrastChecks.push(check)
      if (identityRatio < check.required) {
        findings.push({ kind: 'component-contrast', ...check })
      }
      if (
        element instanceof HTMLInputElement &&
        ['checkbox', 'radio'].includes(element.type) &&
        (element.checked || element.indeterminate)
      ) {
        const glyph = parseColor(style.color)
        if (!glyph) {
          findings.push({
            kind: 'nontext-contrast-unresolved',
            target: selector(element),
            auditId,
            reason: `Parse the checked-control glyph color: ${style.color}.`,
          })
        } else {
          glyph.a *= cumulativeOpacity(element, style)
          const renderedGlyph = composite(glyph, inside.color)
          const glyphCheck = {
            target: selector(element),
            auditId,
            variant: 'checked-control-glyph',
            ratio: ratio(renderedGlyph, inside.color),
            required: 3,
            foreground: style.color,
            background: `rgb(${inside.color.r}, ${inside.color.g}, ${inside.color.b})`,
          }
          nonTextContrastChecks.push(glyphCheck)
          if (glyphCheck.ratio < glyphCheck.required) {
            findings.push({ kind: 'nontext-contrast', ...glyphCheck })
          }
        }
      }
    }

    const controls = document.querySelectorAll(
      'button, input, select, textarea, a[href], [role="button"], [role="menuitem"], [role="radio"], [role="switch"], [role="checkbox"], [role="tab"], [contenteditable="true"]',
    )
    for (const element of controls) {
      if (!visible(element)) continue
      const own = element.getBoundingClientRect()
      let width = own.width
      let height = own.height
      if (
        (element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement) &&
        element.labels
      ) {
        for (const label of element.labels) {
          if (!visible(label)) continue
          const rect = label.getBoundingClientRect()
          width = Math.max(width, rect.width)
          height = Math.max(height, rect.height)
        }
      }
      const check = {
        target: selector(element),
        width,
        height,
        enabled:
          !('disabled' in element) ||
          !(element instanceof HTMLButtonElement) ||
          !element.disabled,
      }
      targetChecks.push(check)
      if (width < 24 || height < 24) {
        findings.push({ kind: 'target-size', ...check })
      }
      if (
        !('disabled' in element && element.disabled) &&
        element instanceof HTMLElement &&
        element.tabIndex < 0
      ) {
        const role = element.getAttribute('role')
        const composite = element.closest(
          '[role="radiogroup"], [role="menu"], [role="tablist"]',
        )
        const managedMenuItem =
          role === 'menuitem' &&
          composite?.getAttribute('role') === 'menu' &&
          composite.contains(document.activeElement)
        const rovingPeer =
          composite &&
          ['radio', 'menuitem', 'tab'].includes(role || '') &&
          Array.from(
            composite.querySelectorAll(
              '[role="radio"], [role="menuitem"], [role="tab"]',
            ),
          ).some(
            (peer) =>
              peer instanceof HTMLElement &&
              peer.tabIndex >= 0 &&
              visible(peer),
          )
        if (!managedMenuItem && !rovingPeer) {
          findings.push({
            kind: 'keyboard-reachability',
            target: selector(element),
            tabIndex: element.tabIndex,
          })
        }
      }
    }

    return {
      findings,
      contrastChecks,
      nonTextContrastChecks,
      componentContrastChecks,
      targetChecks,
      summary: {
        visibleTextPairs: contrastChecks.length,
        meaningfulNonTextPairs: nonTextContrastChecks.length,
        enabledControlBoundaries: componentContrastChecks.length,
        visibleTargets: targetChecks.length,
        minimumTextContrast:
          contrastChecks.length > 0
            ? Math.min(...contrastChecks.map((check) => check.ratio))
            : null,
        minimumNonTextContrast:
          nonTextContrastChecks.length > 0
            ? Math.min(...nonTextContrastChecks.map((check) => check.ratio))
            : null,
        minimumControlBoundaryContrast:
          componentContrastChecks.length > 0
            ? Math.min(...componentContrastChecks.map((check) => check.ratio))
            : null,
      },
    }
  })
}

async function partitionAxeIncomplete(page, incomplete, applicationAudit) {
  const checkedAuditIds = new Set(
    applicationAudit.contrastChecks.map((check) => check.auditId),
  )
  const failedAuditIds = new Set(
    applicationAudit.findings
      .filter((finding) =>
        ['text-contrast', 'text-contrast-unresolved'].includes(finding.kind),
      )
      .map((finding) => finding.auditId),
  )
  const resolved = []
  const unresolved = []

  for (const finding of incomplete) {
    if (finding.id !== 'color-contrast') {
      unresolved.push(finding)
      continue
    }
    const auditIds = await page.evaluate((nodes) => {
      return nodes.map((node) => {
        if (
          !Array.isArray(node.target) ||
          node.target.length !== 1 ||
          typeof node.target[0] !== 'string'
        ) {
          return null
        }
        try {
          return (
            document
              .querySelector(node.target[0])
              ?.getAttribute('data-supraspina-a11y-audit-id') ?? null
          )
        } catch {
          return null
        }
      })
    }, finding.nodes)
    const resolvedNodes = []
    const unresolvedNodes = []
    finding.nodes.forEach((node, index) => {
      const auditId = auditIds[index]
      if (
        auditId &&
        checkedAuditIds.has(auditId) &&
        !failedAuditIds.has(auditId)
      ) {
        resolvedNodes.push(node)
      } else {
        unresolvedNodes.push(node)
      }
    })
    if (resolvedNodes.length > 0) {
      resolved.push({
        ...finding,
        nodes: resolvedNodes,
        resolution:
          'Confirm each listed Axe node with an exact raw computed-color audit and a passing foreground/background ratio.',
      })
    }
    if (unresolvedNodes.length > 0) {
      unresolved.push({ ...finding, nodes: unresolvedNodes })
    }
  }

  return { resolved, unresolved }
}

async function fitIssues(page) {
  return page.evaluate(() => {
    const issues = []
    const root = document.documentElement
    if (root.scrollWidth - root.clientWidth > 1) {
      issues.push(
        `Prevent page horizontal overflow: ${root.scrollWidth}/${root.clientWidth}.`,
      )
    }
    if (root.scrollHeight - root.clientHeight > 1) {
      issues.push(
        `Prevent page vertical overflow: ${root.scrollHeight}/${root.clientHeight}.`,
      )
    }
    const dialog = document.querySelector('[role="dialog"]')
    if (dialog instanceof HTMLElement) {
      const rect = dialog.getBoundingClientRect()
      if (rect.top < -1) {
        issues.push(
          `Keep the dialog within the viewport; found top ${rect.top.toFixed(1)}.`,
        )
      }
    }
    for (const row of document.querySelectorAll('[role="row"]')) {
      if (!(row instanceof HTMLElement) || row.getClientRects().length === 0)
        continue
      const rowRect = row.getBoundingClientRect()
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      let textNode = walker.nextNode()
      while (textNode) {
        if (textNode.textContent?.trim()) {
          const range = document.createRange()
          range.selectNodeContents(textNode)
          const textRect = range.getBoundingClientRect()
          if (
            textRect.height > 0 &&
            (textRect.top < rowRect.top - 1 ||
              textRect.bottom > rowRect.bottom + 1)
          ) {
            issues.push(
              `Keep row text within vertical bounds: ${textNode.textContent.trim().slice(0, 60)}.`,
            )
            break
          }
        }
        textNode = walker.nextNode()
      }
    }
    for (const element of document.querySelectorAll(
      'button, input, select, textarea, a[href], [role="button"], [role="menuitem"]',
    )) {
      if (
        !(element instanceof HTMLElement) ||
        element.getClientRects().length === 0
      ) {
        continue
      }
      const style = getComputedStyle(element)
      const intentionalX = ['auto', 'scroll'].includes(style.overflowX)
      const intentionalY = ['auto', 'scroll'].includes(style.overflowY)
      if (!intentionalX && element.scrollWidth - element.clientWidth > 2) {
        issues.push(
          `Prevent control-width clipping: ${(element.textContent || element.getAttribute('aria-label') || element.tagName).trim().slice(0, 60)}.`,
        )
      }
      if (!intentionalY && element.scrollHeight - element.clientHeight > 2) {
        issues.push(
          `Prevent control-height clipping: ${(element.textContent || element.getAttribute('aria-label') || element.tagName).trim().slice(0, 60)}.`,
        )
      }
    }
    return issues.slice(0, 25)
  })
}

let browser = null
let serverListening = false

;(async () => {
  try {
    let url = rendererUrlFromEnvironment(EXTERNAL_RENDERER_URL)
    if (!url) {
      await new Promise((r) => srv.listen(0, r))
      serverListening = true
      url = `http://localhost:${srv.address().port}/`
    }
    const origin = new URL(url).origin
    fs.mkdirSync(OUTDIR, { recursive: true })
    // Headless Chromium hides scrollbars by default; draw the app's own thin
    // scrollbars, as the desktop window does, so a scrolling list reads as one.
    // Linux headless Chromium hints the bundled WebCM faces to whole pixels,
    // which opens uneven gaps inside words at deviceScaleFactor 2; render
    // their outlines unhinted.
    browser = await chromium.launch({
      ignoreDefaultArgs: ['--hide-scrollbars'],
      args: ['--font-render-hinting=none'],
    })
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: dsf,
      bypassCSP: true,
    })
    await page.emulateMedia({
      colorScheme: 'light',
      reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    })
    await page.addInitScript(() => {
      const fixedNow = Date.parse('2026-07-22T16:00:00.000Z')
      const NativeDate = Date
      class FixedDate extends NativeDate {
        constructor(...args) {
          super(...(args.length === 0 ? [fixedNow] : args))
        }
        static now() {
          return fixedNow
        }
      }
      globalThis.Date = FixedDate
    })
    // List the synthetic v2 analysis results first for the Analysis grid.
    if (visualState === 'analysis-grid') {
      await page.addInitScript(() => {
        try {
          localStorage.setItem('supraspinaMockAnalysisV2', '1')
        } catch (e) {
          void e
        }
      })
    }
    // Seed the first-run sentinel so the preferences dialog does not block
    // captures. Pass --firstrun to capture the dialog instead.
    if (!firstrun) {
      await page.addInitScript(() => {
        try {
          localStorage.setItem('supraspinaFirstRunDone', '1')
        } catch (e) {
          void e
        }
      })
    }
    // First-run and no-project captures cannot reach Settings through the
    // shell, so seed the machine-preference record the mock bridge reads back.
    if (firstrun || noProject) {
      await page.addInitScript(
        ({
          useLight,
          useDark,
          useHighContrast,
          requestedDensity,
          requestedScale,
          useReducedMotion,
        }) => {
          const density = requestedDensity?.toLowerCase()
          localStorage.setItem(
            'supraspinaMockMachinePreferences',
            JSON.stringify({
              schemaVersion: 1,
              ...(useLight ? { theme: 'light' } : {}),
              ...(useDark ? { theme: 'dark' } : {}),
              ...(useHighContrast ? { highContrast: true } : {}),
              ...(density ? { density } : {}),
              ...(requestedScale ? { textScale: requestedScale } : {}),
              ...(useReducedMotion ? { reducedMotion: true } : {}),
            }),
          )
        },
        {
          useLight: light,
          useDark: dark,
          useHighContrast: hc,
          requestedDensity: densityName,
          requestedScale: textScale,
          useReducedMotion: reducedMotion,
        },
      )
    }
    const errs = []
    page.on('pageerror', (e) => errs.push(`PAGEERR ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(`CONSOLE ${m.text()}`)
    })
    page.on('request', (request) => {
      const requestUrl = request.url()
      if (/^(data|blob):/.test(requestUrl)) return
      if (new URL(requestUrl).origin !== origin) {
        errs.push(
          `REMOTE ${request.resourceType()} ${new URL(requestUrl).origin}`,
        )
      }
    })
    page.on('requestfailed', (request) => {
      errs.push(
        `REQUEST ${request.resourceType()} ${request.failure()?.errorText || 'failed'}`,
      )
    })
    await page.goto(url, { waitUntil: 'load' })
    try {
      await page.locator('#root').waitFor({ timeout: 15_000 })
    } catch (error) {
      const startup = await page.evaluate(() => ({
        readyState: document.readyState,
        rootPresent: Boolean(document.querySelector('#root')),
        rootHtml:
          document.querySelector('#root')?.innerHTML.slice(0, 500) ?? null,
        body: document.body?.innerHTML.slice(0, 500) ?? null,
      }))
      throw new Error(
        `Render the root visibly: ${JSON.stringify({ startup, errors: errs, cause: String(error) })}.`,
      )
    }
    await assertFontsAndLocalAssets(page, origin)

    // Load a project so the navigation appears (unless capturing first-run or the
    // deliberate no-project surface).
    if (!firstrun && !noProject) {
      await openSyntheticProject(page, visualState, documentation)
    }

    let variantEvidence = null
    let keyboardEvidence = null
    let menuEvidence = null
    let dialogEvidence = null

    if (
      !firstrun &&
      !noProject &&
      (light ||
        dark ||
        systemTheme ||
        hc ||
        densityName ||
        textScale ||
        reducedMotion)
    ) {
      await clickNav(page, 'Settings')
      if (light) {
        const t = page
          .getByRole('radio', { name: 'Light', exact: true })
          .first()
        await activatePreference(t, 'Light theme')
      }
      if (dark) {
        const t = page.getByRole('radio', { name: 'Dark', exact: true }).first()
        await activatePreference(t, 'Dark theme')
      }
      if (systemTheme) {
        const t = page
          .getByRole('radio', { name: 'System', exact: true })
          .first()
        await activatePreference(t, 'System theme')
      }
      if (hc) {
        const row = page.locator('div', { hasText: /^High contrast/ }).last()
        const h = row.getByRole('switch').first()
        await activatePreference(h, 'High contrast')
      }
      if (densityName) {
        const d = page
          .getByRole('radio', { name: densityName, exact: true })
          .first()
        await activatePreference(d, `${densityName} density`)
      }
      if (textScale) {
        const z = page
          .getByRole('radio', { name: `${textScale}%`, exact: true })
          .first()
        await activatePreference(z, `${textScale}% text scale`)
      }
      if (reducedMotion) {
        const row = page.locator('div', { hasText: /^Reduced motion/ }).last()
        const toggle = row.getByRole('switch').first()
        await activatePreference(toggle, 'Reduced motion')
      }
      await page.waitForTimeout(200)
      variantEvidence = await assertAppliedVariant(page)
    }

    // Navigate only the loaded shell because first-run makes it inert and
    // no-project mode already opens Setup.
    if (!firstrun && !noProject) {
      await clickNav(page, screen === 'QC Review' ? 'QC review' : screen)
    }
    await page.waitForTimeout(settle)
    await settleAnimations(page)
    if (documentation && screen === 'QC Review') {
      const external = page.getByRole('radio', {
        name: /^External cortical$/,
      })
      await external.waitFor({ state: 'visible' })
      await external.click()
      await page
        .getByRole('group', { name: /^External cortical montage for / })
        .waitFor({ state: 'attached' })
      // Capture the drawn placeholder panels, not the loading line.
      await page
        .getByText('4/4 panels verified and drawn.', { exact: true })
        .waitFor({ state: 'visible', timeout: 15_000 })
      await settleAnimations(page)
    }
    if (screen === 'Analysis' && visualState === 'analysis-grid') {
      // The battery result opens on Forest; the capture shows its Grid.
      const gridTab = page.getByRole('tab', { name: 'Grid', exact: true })
      await gridTab.waitFor({ state: 'visible' })
      await gridTab.click()
      await page
        .getByRole('table', { name: /^Grid of / })
        .waitFor({ state: 'visible' })
      await settleAnimations(page)
    }
    if (documentation && screen === 'Logs') {
      // Logs opens on the running job's run, which has no failure. Choose the
      // failed run in the Run list, as an operator reviewing a failure does,
      // so the rail lists its failed and blocked jobs beside the running and
      // queued ones, and wait until the Run details follow it. The details
      // stay closed in the capture, so open them for the check only.
      const runList = page
        .getByRole('complementary', { name: 'Jobs' })
        .getByRole('combobox', { name: 'Run', exact: true })
      await runList.waitFor({ state: 'visible' })
      await runList.selectOption('run-synthetic-failed')
      const controls = page.getByRole('complementary', { name: 'Controls' })
      const details = controls.getByRole('button', { name: 'Run details' })
      await details.click()
      await controls
        .getByText('run-synthetic-failed', { exact: true })
        .waitFor({ state: 'visible' })
      await details.click()
      await settleAnimations(page)
    }
    if (documentation && screen === 'Results') {
      const partialArtifact = page.getByRole('button', {
        name: /Reconstruction surfaces/,
      })
      await partialArtifact.waitFor({ state: 'visible' })
      await partialArtifact.click()
      await page
        .getByText(
          'Reconstruction is still running, so these outputs are incomplete.',
          { exact: true },
        )
        .waitFor({ state: 'visible' })
    }
    if (visualState === 'no-match') {
      await typeNoMatchSearch(page, screen, noMatchQuery)
    }
    await assertRouteAndState(
      page,
      screen,
      visualState,
      !firstrun && !noProject,
      firstrun,
    )
    if (documentation) {
      await applyDocumentationPresentation(page, screen)
      await assertDocumentationState(page, screen, visualState)
    }
    const pressEvidence = pressName ? await pressToggle(page, pressName) : null
    if (variantEvidence === null) {
      variantEvidence = await assertAppliedVariant(page)
    }
    // Record every scroll position before keyboard traversal, which leaves each
    // pane that scrolls on its own at its last focused control, so the capture
    // can show the screen as it opened.
    await page.evaluate(() => {
      globalThis.__smScrollPositions = [...document.querySelectorAll('*')]
        .filter(
          (element) =>
            element instanceof HTMLElement &&
            (element.scrollHeight > element.clientHeight ||
              element.scrollWidth > element.clientWidth),
        )
        .map((element) => [element, element.scrollTop, element.scrollLeft])
    })
    keyboardEvidence = firstrun
      ? await assertFirstRunKeyboardTraversal(page)
      : await assertSequentialKeyboardTraversal(page)
    if (menuMode === 'open' || menuMode === 'more') {
      menuEvidence = await exerciseMenuSemantics(page, menuMode, screen)
      await assertRouteAndState(page, screen, visualState, true, false)
    }
    if (dialogMode === 'run') {
      dialogEvidence = await exerciseRunDialog(page)
    }
    if (errs.length > 0) {
      throw new Error(
        `Pass the visual gate before interaction: ${JSON.stringify(errs.slice(0, 12))}.`,
      )
    }
    // Keep the focus the capture state set, such as an open menu's item or a
    // dialog's initial control, and the surfaces open now; the probes below
    // move focus and open the command palette.
    await page.evaluate(() => {
      const active = document.activeElement
      globalThis.__smCapturedFocus =
        active instanceof HTMLElement &&
        active.closest('[role="menu"], [role="dialog"]')
          ? active
          : null
      globalThis.__smOpenSurfaces = document.querySelectorAll(
        '[role="menu"], [role="dialog"]',
      ).length
    })
    try {
      await assertAccessibility(
        page,
        !firstrun && !noProject,
        firstrun,
        visualState,
        screen,
      )
    } catch (error) {
      errs.push(
        `ACCESSIBILITY ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const axeReport = await runAxeAudit(page)
    const applicationAudit = await runApplicationAccessibilityAudit(page)
    const incomplete = await partitionAxeIncomplete(
      page,
      axeReport.incomplete,
      applicationAudit,
    )
    const resolvedIncomplete = incomplete.resolved
    const unresolvedIncomplete = incomplete.unresolved
    fs.writeFileSync(
      path.join(OUTDIR, `${outName}.accessibility.json`),
      `${JSON.stringify(
        {
          screen,
          state: visualState,
          theme: light ? 'light' : dark ? 'dark' : 'system',
          highContrast: Boolean(hc),
          density: densityName || 'default',
          textScale: textScale || 'default',
          reducedMotion: Boolean(reducedMotion),
          viewport: { width, height, deviceScaleFactor: dsf },
          applicationAudit,
          variantEvidence,
          keyboardEvidence,
          menuEvidence,
          dialogEvidence,
          pressEvidence,
          ...axeReport,
          incomplete: unresolvedIncomplete,
          resolvedIncomplete,
        },
        null,
        2,
      )}\n`,
    )
    for (const violation of axeReport.violations) {
      errs.push(
        `AXE ${violation.id}: ${violation.nodes
          .map((node) => node.target.join(' '))
          .slice(0, 4)
          .join(', ')}`,
      )
    }
    for (const finding of unresolvedIncomplete) {
      errs.push(
        `AXE INCOMPLETE ${finding.id}: ${finding.nodes
          .map((node) => node.target.join(' '))
          .slice(0, 4)
          .join(', ')}`,
      )
    }
    for (const finding of applicationAudit.findings) {
      errs.push(
        `A11Y ${finding.kind}: ${finding.target}${
          'ratio' in finding
            ? ` ratio=${finding.ratio} required=${finding.required}`
            : 'width' in finding
              ? ` ${finding.width}x${finding.height}`
              : ''
        }`,
      )
    }
    if (firstrun) {
      await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const overlay = dialog?.closest('[role="presentation"]')
        if (overlay instanceof HTMLElement) overlay.scrollTop = 0
        if (dialog instanceof HTMLElement) {
          for (const element of dialog.querySelectorAll('*')) {
            if (element instanceof HTMLElement) element.scrollTop = 0
          }
        }
      })
    }

    // Keyboard traversal leaves the Setup fields touched, so they show their
    // validation errors. The probes have run on the traversed page; reload
    // the no-project surface so the capture shows the form at rest.
    if (noProject && !firstrun) {
      await page.reload({ waitUntil: 'load' })
      await page.locator('#root').waitFor({ timeout: 15_000 })
      await assertFontsAndLocalAssets(page, origin)
      await page.waitForTimeout(settle)
      await settleAnimations(page)
      await assertRouteAndState(page, screen, visualState, false, false)
    }

    // Close what the probes opened, and leave no probe focus ring or hover
    // in the capture: restore the state's own focus or blur the last stop.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const extra = await page.evaluate(
        () =>
          document.querySelectorAll('[role="menu"], [role="dialog"]').length -
          (globalThis.__smOpenSurfaces ?? 0),
      )
      if (extra <= 0) break
      await page.keyboard.press('Escape')
      await settleAnimations(page)
    }
    await page.mouse.move(0, 0)
    await page.evaluate(() => {
      const kept = globalThis.__smCapturedFocus
      if (kept instanceof HTMLElement && kept.isConnected) {
        kept.focus({ preventScroll: true })
      } else if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    })
    await settleAnimations(page)

    // Restore the canonical top-left evidence position after keyboard traversal
    // because Chromium may scroll a focused control at high device scale factors.
    // Keep repeated documentation captures stable without disabling intentional
    // screen-level scrolling.
    await page.evaluate(() => {
      for (const [element, top, left] of globalThis.__smScrollPositions ?? []) {
        if (element.isConnected) element.scrollTo(left, top)
      }
      globalThis.scrollTo(0, 0)
      document.scrollingElement?.scrollTo(0, 0)
      const main = document.querySelector('main')
      if (main instanceof HTMLElement) main.scrollTo(0, 0)
    })
    if (documentation) {
      await page.evaluate(() => {
        for (const element of document.body.querySelectorAll('*')) {
          if (!(element instanceof HTMLElement)) continue
          const style = getComputedStyle(element)
          if (
            ['auto', 'scroll'].includes(style.overflowY) &&
            element.scrollHeight > element.clientHeight
          ) {
            element.scrollTop = 0
          }
          if (
            ['auto', 'scroll'].includes(style.overflowX) &&
            element.scrollWidth > element.clientWidth
          ) {
            element.scrollLeft = 0
          }
        }
      })
    }

    // Keep documentation-capture pixels independent of scheduler timing. Finish
    // finite animations at their end state, and pin repeating animations to their
    // first frame.
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        const timing = animation.effect?.getComputedTiming()
        if (timing?.iterations === Infinity) {
          animation.pause()
          animation.currentTime = 0
        } else {
          animation.finish()
        }
      }
    })

    const out = path.join(OUTDIR, `${outName}.png`)
    await page.screenshot({ path: out, fullPage: false })

    if (fit) {
      const issues = await fitIssues(page)
      console.log('FIT', JSON.stringify({ issues }))
      errs.push(...issues.map((issue) => `FIT ${issue}`))
    }

    console.log('WROTE', out)
    if (errs.length) {
      throw new Error(
        `Pass the visual gate: ${JSON.stringify(errs.slice(0, 12))}.`,
      )
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined)
      browser = null
    }
    if (serverListening) {
      await new Promise((resolve) => srv.close(resolve))
      serverListening = false
    }
  }
})().catch((e) => {
  console.error('FATAL', e)
  process.exitCode = 1
})
