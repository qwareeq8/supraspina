import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

/**
 * Configure flat ESLint rules for ESLint 10 and typescript-eslint 8.
 *
 * Check the renderer for React Hooks correctness and fast-refresh
 * compatibility. Check main and preload as Node TypeScript. Check maintainer
 * tooling under `scripts/` as Node JavaScript, reading CommonJS entry points as
 * scripts rather than modules. Apply Prettier last to disable the stylistic
 * rules that it owns.
 */
export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'build/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      // Check the Python sidecar, including vendored JavaScript in its virtual
      // environment, with Ruff.
      'sidecar/**',
      // Check these two Playwright drivers with their dedicated tests
      // (`scripts/visual-matrix-references.test.mjs` and
      // `scripts/capture-documentation-screenshots.test.mjs` for
      // `scripts/shot.cjs`, `scripts/real-electron-ui-check.test.mjs` for
      // `scripts/real-electron-ui-check.cjs`). Both interleave Node scope with
      // in-page `page.evaluate` bodies in one file, so a single global set
      // cannot describe them, and both intentionally rethrow a caught error
      // without a `cause`. Every other file under `scripts/` is linted below.
      'scripts/shot.cjs',
      'scripts/real-electron-ui-check.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', '*.{ts,js}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['scripts/**/*.{mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Maintainer tooling drops a field from a record by naming it beside a
      // rest element; the named binding is deliberately unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
)
