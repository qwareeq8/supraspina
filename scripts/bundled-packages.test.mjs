import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import {
  BUNDLED_PACKAGES_FILE,
  BUNDLED_PACKAGES_SCHEMA,
  bundledPackages,
  bundledPackagesPlugin,
  packageDirectoryOf,
  parseBundledPackages,
} from './bundled-packages.mjs'

const repository = '/repo'
const manifests = {
  '/repo/node_modules/react': { name: 'react', version: '19.2.6' },
  '/repo/node_modules/@niivue/niivue': {
    name: '@niivue/niivue',
    version: '0.69.0',
  },
  '/repo/node_modules/a/node_modules/b': { name: 'b', version: '1.0.0' },
}
const readPackage = (directory) => manifests[directory]

test('finds the package directory of a bundled module', () => {
  assert.equal(
    packageDirectoryOf('/repo/node_modules/react/cjs/react.production.js'),
    '/repo/node_modules/react',
  )
  assert.equal(
    packageDirectoryOf(
      '\0/repo/node_modules/@niivue/niivue/build/x.js?commonjs',
    ),
    '/repo/node_modules/@niivue/niivue',
  )
  assert.equal(
    packageDirectoryOf('/repo/node_modules/a/node_modules/b/index.js'),
    '/repo/node_modules/a/node_modules/b',
  )
  assert.equal(packageDirectoryOf('/repo/src/renderer/main.tsx'), null)
  assert.equal(packageDirectoryOf('/repo/node_modules/@scope'), null)
})

test('lists packages with rendered code once, sorted by lock path', () => {
  const chunks = [
    {
      modules: {
        '/repo/src/renderer/App.tsx': { renderedLength: 10 },
        '/repo/node_modules/react/index.js': { renderedLength: 5 },
        '/repo/node_modules/react/jsx-runtime.js': { renderedLength: 5 },
        '/repo/node_modules/a/node_modules/b/index.js': { renderedLength: 0 },
      },
    },
    {
      modules: {
        '/repo/node_modules/@niivue/niivue/build/niivue/index.js': {
          renderedLength: 900,
        },
      },
    },
    {},
  ]
  assert.deepEqual(bundledPackages(chunks, { repository, readPackage }), [
    {
      name: '@niivue/niivue',
      version: '0.69.0',
      lockPath: 'node_modules/@niivue/niivue',
    },
    { name: 'react', version: '19.2.6', lockPath: 'node_modules/react' },
  ])
})

test('refuses a bundled package it cannot name', () => {
  assert.throws(
    () =>
      bundledPackages(
        [
          {
            modules: { '/repo/node_modules/ghost/x.js': { renderedLength: 1 } },
          },
        ],
        { repository, readPackage: () => ({}) },
      ),
    /Name the bundled package at node_modules\/ghost/,
  )
})

test('writes the record beside the renderer entry', () => {
  const plugin = bundledPackagesPlugin({
    repository: join(import.meta.dirname, '..'),
  })
  const emitted = []
  plugin.generateBundle.call(
    { emitFile: (file) => emitted.push(file) },
    {},
    {
      'index.js': {
        type: 'chunk',
        modules: {
          [join(
            import.meta.dirname,
            '..',
            'node_modules',
            'react',
            'index.js',
          )]: { renderedLength: 1 },
        },
      },
      'style.css': { type: 'asset' },
    },
  )
  assert.equal(plugin.apply, 'build')
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].fileName, BUNDLED_PACKAGES_FILE)
  const record = JSON.parse(emitted[0].source)
  assert.equal(record.schema, BUNDLED_PACKAGES_SCHEMA)
  assert.deepEqual(
    parseBundledPackages(record).map((item) => item.lockPath),
    ['node_modules/react'],
  )
})

test('validates a bundled-packages record', () => {
  assert.throws(
    () => parseBundledPackages(null),
    /valid renderer bundled-packages record/,
  )
  assert.throws(
    () =>
      parseBundledPackages({
        schema: BUNDLED_PACKAGES_SCHEMA,
        schemaVersion: 1,
        packages: [{ name: 'x', version: '1', lockPath: '../x' }],
      }),
    /valid renderer bundled-packages entry/,
  )
})
