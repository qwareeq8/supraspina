import { defineConfig } from 'vitest/config'

/**
 * Configure Vitest for renderer and shared unit tests.
 *
 * Run tests in jsdom to exercise React components and DOM utilities without
 * Electron. Test main-process logic separately and test the Python sidecar with
 * pytest.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/renderer/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // Cover the whole app so the headline reflects the lowest-covered modules.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.{test,spec}.{ts,tsx}',
        'src/renderer/test/**',
        '**/*.d.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
})
