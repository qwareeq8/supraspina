import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REQUIRED_ICON_SIZES,
  assertAppImageLauncher,
  assertAppRunSandboxPolicy,
  assertDebianControl,
  assertDebianLauncher,
  parseDesktopEntry,
} from './inspect-linux-packages.mjs'
import {
  RELEASE_CONTRACT,
  REQUIRED_DEB_DEPENDENCIES,
} from './check-release.mjs'

const VERSION = '20261121.1830.0'

function appImageEntry(overrides = {}) {
  return {
    Name: 'Supraspina',
    Exec: 'AppRun %U',
    Terminal: 'false',
    Type: 'Application',
    Icon: 'supraspina',
    StartupWMClass: 'supraspina',
    Categories: 'Science;',
    'X-AppImage-Version': VERSION,
    ...overrides,
  }
}

function debianEntry(overrides = {}) {
  return {
    Name: 'Supraspina',
    Exec: '"/opt/Supraspina/supraspina" %U',
    Terminal: 'false',
    Type: 'Application',
    Icon: 'supraspina',
    StartupWMClass: 'supraspina',
    Categories: 'Science;',
    ...overrides,
  }
}

function controlFields(overrides = {}) {
  return {
    Package: 'supraspina',
    Version: VERSION,
    Architecture: 'amd64',
    Maintainer: 'Yusuf Qwareeq <yusuf@qwareeq.com>',
    Section: 'science',
    Priority: 'optional',
    Homepage: 'https://qwareeq.com/',
    Description: RELEASE_CONTRACT.linuxSynopsis,
    Depends: REQUIRED_DEB_DEPENDENCIES.join(', '),
    ...overrides,
  }
}

describe('desktop-entry parsing', () => {
  it('reads only the Desktop Entry group', () => {
    const fields = parseDesktopEntry(
      '# Comment\n[Desktop Entry]\nName=Supraspina\nExec=AppRun %U\n\n' +
        '[Desktop Action New]\nExec=AppRun --no-sandbox\n',
    )

    assert.equal(fields.Name, 'Supraspina')
    assert.equal(fields.Exec, 'AppRun %U')
    assert.equal(Object.keys(fields).length, 2)
  })

  it('rejects a file without a Desktop Entry group', () => {
    assert.throws(
      () => parseDesktopEntry('Name=Supraspina\n'),
      /Provide a desktop entry with a \[Desktop Entry\] group/,
    )
  })
})

describe('the AppImage launcher contract', () => {
  it('accepts the reviewed AppRun launcher', () => {
    assert.doesNotThrow(() => assertAppImageLauncher(appImageEntry(), VERSION))
  })

  it('rejects a sandbox-disabling launcher', () => {
    assert.throws(
      () =>
        assertAppImageLauncher(
          appImageEntry({ Exec: 'AppRun --no-sandbox %U' }),
          VERSION,
        ),
      /Remove --no-sandbox from the AppImage desktop entry/,
    )
  })

  it('requires the AppRun launch path', () => {
    assert.throws(
      () =>
        assertAppImageLauncher(
          appImageEntry({ Exec: 'supraspina %U' }),
          VERSION,
        ),
      /Set Exec=AppRun %U in the AppImage desktop entry/,
    )
  })

  it('rejects stale window association and versions', () => {
    assert.throws(
      () =>
        assertAppImageLauncher(
          appImageEntry({ StartupWMClass: 'Supraspina' }),
          VERSION,
        ),
      /Set StartupWMClass=supraspina/,
    )
    assert.throws(
      () =>
        assertAppImageLauncher(
          appImageEntry({ 'X-AppImage-Version': '20261120.1830.0' }),
          VERSION,
        ),
      /Stamp X-AppImage-Version=20261121\.1830\.0/,
    )
  })

  it('requires the Science category and product name', () => {
    assert.throws(
      () =>
        assertAppImageLauncher(
          appImageEntry({ Categories: 'Utility;' }),
          VERSION,
        ),
      /List the Science category/,
    )
    assert.throws(
      () =>
        assertAppImageLauncher(appImageEntry({ Name: 'supraspina' }), VERSION),
      /Set Name=Supraspina/,
    )
  })
})

describe('the AppRun sandbox policy', () => {
  const safe = [
    'NO_SANDBOX=()',
    'if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then',
    '  NO_SANDBOX=(--no-sandbox)',
    'fi',
    'exec "$BIN" "${NO_SANDBOX[@]}" "${args[@]}"',
  ].join('\n')

  it('accepts the conditional fail-safe', () => {
    assert.doesNotThrow(() => assertAppRunSandboxPolicy(safe))
  })

  it('rejects an unconditional sandbox opt-out', () => {
    assert.throws(
      () =>
        assertAppRunSandboxPolicy(
          'NO_SANDBOX=(--no-sandbox)\nexec "$BIN" "${NO_SANDBOX[@]}"\n',
        ),
      /Start AppRun with an empty NO_SANDBOX array/,
    )
    assert.throws(
      () =>
        assertAppRunSandboxPolicy('NO_SANDBOX=()\nexec "$BIN" --no-sandbox\n'),
      /Remove the unconditional --no-sandbox launch from AppRun/,
    )
  })

  it('rejects a launcher with no sandbox declaration', () => {
    assert.throws(
      () => assertAppRunSandboxPolicy('exec "$BIN"\n'),
      /Start AppRun with an empty NO_SANDBOX array/,
    )
  })

  it('rejects an unguarded later reassignment', () => {
    assert.throws(
      () =>
        assertAppRunSandboxPolicy(
          [
            'NO_SANDBOX=()',
            'NO_SANDBOX=(--no-sandbox)',
            'exec "$BIN" "${NO_SANDBOX[@]}"',
          ].join('\n'),
        ),
      /Guard every --no-sandbox assignment in AppRun behind the user-namespace probe/,
    )
    assert.throws(
      () =>
        assertAppRunSandboxPolicy(
          [
            'NO_SANDBOX=()',
            'if [ -n "$SUPRASPINA_FORCE" ] ; then',
            '  NO_SANDBOX=(--no-sandbox)',
            'fi',
            'exec "$BIN" "${NO_SANDBOX[@]}"',
          ].join('\n'),
        ),
      /Guard every --no-sandbox assignment in AppRun behind the user-namespace probe/,
    )
  })
})

describe('the Debian package contract', () => {
  it('accepts the reviewed control record and launcher', () => {
    assert.doesNotThrow(() => assertDebianControl(controlFields(), VERSION))
    assert.doesNotThrow(() => assertDebianLauncher(debianEntry()))
    assert.doesNotThrow(() =>
      assertDebianLauncher(
        debianEntry({ Exec: '/opt/Supraspina/supraspina %U' }),
      ),
    )
  })

  it('rejects a stale maintainer, section, or priority', () => {
    for (const [key, value] of [
      ['Maintainer', 'Example Maintainer <maintainer@example.test>'],
      ['Section', 'utils'],
      ['Priority', 'extra'],
      ['Homepage', 'https://example.test/'],
    ]) {
      assert.throws(
        () => assertDebianControl(controlFields({ [key]: value }), VERSION),
        new RegExp(`Set ${key}=`),
      )
    }
  })

  it('requires the supported Ubuntu runtimes', () => {
    for (const dependency of REQUIRED_DEB_DEPENDENCIES) {
      assert.throws(
        () =>
          assertDebianControl(
            controlFields({
              Depends: REQUIRED_DEB_DEPENDENCIES.filter(
                (candidate) => candidate !== dependency,
              ).join(', '),
            }),
            VERSION,
          ),
        /Depend on exactly the reviewed Debian runtimes/,
      )
    }
    assert.throws(
      () =>
        assertDebianControl(
          controlFields({
            Depends: [...REQUIRED_DEB_DEPENDENCIES, 'unexpected-runtime'].join(
              ', ',
            ),
          }),
          VERSION,
        ),
      /Depend on exactly the reviewed Debian runtimes/,
    )
  })

  it('requires the exact Linux synopsis as the first Description line', () => {
    assert.doesNotThrow(() =>
      assertDebianControl(
        controlFields({
          Description: `${RELEASE_CONTRACT.linuxSynopsis}\nLong package details follow.`,
        }),
        VERSION,
      ),
    )
    for (const description of [
      'Operator console for the Supraspina pipeline',
      undefined,
      `${RELEASE_CONTRACT.linuxSynopsis} with extra text`,
    ]) {
      assert.throws(
        () =>
          assertDebianControl(
            controlFields({ Description: description }),
            VERSION,
          ),
        /Set the first Debian Description line/,
      )
    }
  })

  it('rejects a sandbox-disabling install prefix', () => {
    assert.throws(
      () =>
        assertDebianLauncher(
          debianEntry({ Exec: '"/opt/Supraspina/supraspina" --no-sandbox %U' }),
        ),
      /Remove --no-sandbox from the Debian desktop entry/,
    )
    assert.throws(
      () =>
        assertDebianLauncher(debianEntry({ Exec: '/usr/bin/supraspina %U' })),
      /Launch \/opt\/Supraspina\/supraspina with %U/,
    )
  })

  it('requires every reviewed hicolor icon size', () => {
    assert.deepEqual(REQUIRED_ICON_SIZES, [
      '16x16',
      '32x32',
      '48x48',
      '64x64',
      '128x128',
      '256x256',
      '512x512',
    ])
  })
})
