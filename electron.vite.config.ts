import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import {
  DEFAULT_DEVELOPMENT_RENDERER_URL,
  PRODUCTION_RENDERER_CSP,
  developmentRendererCsp,
  replaceManagedRendererCsp,
} from './src/shared/renderer-security'
import {
  UNKNOWN_BUILD_IDENTITY,
  readBuildIdentity,
} from './scripts/build-identity.mjs'
import { bundledPackagesPlugin } from './scripts/bundled-packages.mjs'

/**
 * Configure three independent electron-vite bundles.
 *
 * - Build `main` for the Electron Node process that supervises the Python
 *   orchestration sidecar and exposes IPC handlers.
 * - Build `preload` as the context bridge that publishes the typed
 *   `window.supraspina` API to the sandboxed renderer.
 * - Build `renderer` as the React UI rooted at `src/renderer/index.html`.
 *
 * Keep runtime dependencies outside the main bundle with
 * `externalizeDepsPlugin`. Emit the sandboxed preload as one self-contained
 * CommonJS bundle. Record the npm packages inlined into the renderer in
 * `out/renderer/bundled-packages.json`, from which release metadata takes
 * their licenses.
 */
function rendererCspPlugin(policy: string): Plugin {
  return {
    name: 'supraspina-renderer-csp',
    enforce: 'pre',
    transformIndexHtml(html) {
      return replaceManagedRendererCsp(html, policy)
    },
  }
}

export default defineConfig(({ command }) => {
  const rendererCsp =
    command === 'serve'
      ? developmentRendererCsp(
          process.env['ELECTRON_RENDERER_URL'] ??
            DEFAULT_DEVELOPMENT_RENDERER_URL,
        )
      : PRODUCTION_RENDERER_CSP
  // Embed the source commit, tracked-change state, and release-tag match of
  // a build for About. The development server serves live edits that no
  // commit describes, so it reports an unknown source commit.
  const buildIdentity =
    command === 'build' ? readBuildIdentity() : UNKNOWN_BUILD_IDENTITY

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: { index: resolve(import.meta.dirname, 'src/main/index.ts') },
        },
      },
    },
    preload: {
      build: {
        // Emit one self-contained CommonJS bundle for the sandboxed preload.
        // Keep one bridge entry that imports only Electron, bundled
        // dependency-free shared IPC constants, and type-only contracts. Use
        // Rollup's stable single-entry mode to avoid electron-vite's experimental
        // isolated-entry progress reporter, which requires a TTY.
        externalizeDeps: false,
        isolatedEntries: false,
        rollupOptions: {
          input: {
            index: resolve(import.meta.dirname, 'src/preload/index.ts'),
          },
          output: {
            format: 'cjs',
            entryFileNames: '[name].cjs',
            inlineDynamicImports: true,
          },
        },
      },
    },
    renderer: {
      root: resolve(import.meta.dirname, 'src/renderer'),
      resolve: {
        alias: [
          {
            // NiiVue's Zarr support imports these WebAssembly codecs on
            // demand; the brain viewer never reads Zarr, so ship a stub.
            find: /^numcodecs\/(?:blosc|lz4|zstd)$/,
            replacement: resolve(
              import.meta.dirname,
              'src/renderer/screens/analysis/brain/zarr-codec-stub.ts',
            ),
          },
        ],
      },
      define: {
        __SUPRASPINA_BUILD_IDENTITY__: JSON.stringify(buildIdentity),
      },
      server: {
        // Accept the development renderer only on this exact loopback endpoint.
        // Keep the port strict to make the IPC origin binding deterministic.
        host: '127.0.0.1',
        port: 5173,
        strictPort: true,
      },
      build: {
        rollupOptions: {
          input: {
            index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          },
        },
      },
      plugins: [
        rendererCspPlugin(rendererCsp),
        react(),
        bundledPackagesPlugin(),
      ],
    },
  }
})
