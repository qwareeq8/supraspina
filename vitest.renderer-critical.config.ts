import { defineConfig } from 'vitest/config'

/**
 * Gate critical modules for analysis targeting, proactive workflow blockers,
 * main-process boundary coordination, and packaged-runtime smoke checks.
 * Protect scientific launch authority and release startup from regressions that
 * could otherwise surface only as backend rejection or unsafe package startup.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'src/main/autoupdate.test.ts',
      'src/main/index.test.ts',
      'src/main/index.startup.test.ts',
      'src/main/lifecycle.test.ts',
      'src/main/package-smoke.test.ts',
      'src/main/web-destinations.test.ts',
      'src/preload/index.test.ts',
      'src/renderer/run-scope.test.ts',
      'src/renderer/state/analysis-cohort-boundary.test.ts',
      'src/renderer/state/dependency-blockers.test.ts',
      'src/renderer/state/env-applicability.test.ts',
      'src/renderer/state/stage-blockers.test.ts',
      'src/shared/analysis-cohort.test.ts',
      'src/shared/project-schema.test.ts',
      'src/shared/steps.test.ts',
      'src/shared/template.test.ts',
    ],
    setupFiles: ['./src/renderer/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/main/autoupdate.ts',
        'src/main/index.ts',
        'src/main/lifecycle.ts',
        'src/main/package-smoke.ts',
        'src/main/web-destinations.ts',
        'src/preload/index.ts',
        'src/shared/analysis-cohort.ts',
        'src/renderer/run-scope.ts',
        'src/renderer/state/dependency-blockers.ts',
        'src/renderer/state/env-applicability.ts',
        'src/renderer/state/stage-blockers.ts',
        'src/shared/project-schema.ts',
        'src/shared/steps.ts',
        'src/shared/template.ts',
      ],
      thresholds: {
        perFile: true,
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
})
