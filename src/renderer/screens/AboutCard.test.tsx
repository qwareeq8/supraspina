import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { THEMES } from '../theme/tokens'
import type { UpdateState } from '../../shared/contract'
import type { BuildIdentity } from '../../shared/build-identity'
import { version as APP_VERSION } from '../../../package.json'
import { formatAppVersion } from '../../../scripts/app-version.mjs'

const SHOWN_VERSION = formatAppVersion(APP_VERSION)

const h = vi.hoisted(() => ({
  openWeb: vi.fn(async () => undefined),
  openThirdPartyNotices: vi.fn(async () => undefined),
  check: vi.fn(async () => ({
    available: false,
    version: null,
    releaseNotes: null,
  })),
  state: { current: null as UpdateState | null },
  build: { kind: 'unknown', commit: '', dirty: false } as BuildIdentity,
}))

vi.mock('../build-identity', () => ({ APP_BUILD_IDENTITY: h.build }))

vi.mock('../state/api', () => ({
  getApi: () => ({
    external: {
      openWeb: h.openWeb,
      openThirdPartyNotices: h.openThirdPartyNotices,
    },
    update: {
      check: h.check,
      getStatus: async () => h.state.current,
      onStatus: () => () => undefined,
    },
  }),
}))

const { AboutCard } = await import('./AboutCard')

const t = THEMES.dark
const VERSION = '20261122.905.0'

function st(patch: Partial<UpdateState>): UpdateState {
  return {
    phase: 'idle',
    version: null,
    releaseNotes: null,
    percent: null,
    error: null,
    capability: 'full',
    ...patch,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.current = null
  Object.assign(h.build, { kind: 'unknown', commit: '', dirty: false })
})

describe('AboutCard description', () => {
  it('describes what Supraspina is as a fact', () => {
    render(<AboutCard t={t} />)
    expect(
      screen.getByText(
        'Research software for structural-MRI and brain-age workflows. Not for diagnosis or clinical decisions.',
      ),
    ).toBeInTheDocument()
  })

  it('states the license scope in one short paragraph', () => {
    render(<AboutCard t={t} />)
    expect(
      screen.getByText(
        'MIT license for Supraspina code. Third-party components keep their own terms.',
      ),
    ).toBeInTheDocument()
  })
})

describe('AboutCard credits', () => {
  it('thanks the upstream authors and credits the developer', () => {
    render(<AboutCard t={t} />)
    expect(
      screen.getByText(
        /^Thank you to Oscar Ortiz Angulo and Ryan Loke for SCI_Map/,
      ),
    ).toBeInTheDocument()
    const author = screen.getByRole('heading', { name: 'Author' })
    const contact = author.nextElementSibling as HTMLElement
    expect(contact.firstElementChild).toHaveTextContent(/^Yusuf Qwareeq$/)
    expect(
      screen.queryByText('Desktop application by Yusuf Qwareeq.'),
    ).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Desktop app' })).toBeNull()
    expect(screen.getByText('yusuf@qwareeq.com')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'qwareeq.com' }),
    ).toBeInTheDocument()
  })
})

describe('AboutCard version line', () => {
  const commit = '0123456789abcdef0123456789abcdef01234567'

  it('names the version alone for the exact release build', () => {
    Object.assign(h.build, { kind: 'release', commit, dirty: false })
    render(<AboutCard t={t} />)
    expect(screen.getByText(`Version ${SHOWN_VERSION}`)).toBeInTheDocument()
  })

  it('names the short source commit of a development build', () => {
    Object.assign(h.build, { kind: 'development', commit, dirty: false })
    const view = render(<AboutCard t={t} />)
    // The line reads in sans; only the commit hash is set as code.
    const hash = screen.getByText('0123456')
    expect(hash.tagName).toBe('CODE')
    expect(hash.parentElement).toHaveTextContent(
      `Version ${SHOWN_VERSION}, development build 0123456`,
    )
    expect(hash.parentElement?.style.fontFamily).toContain('WebCM Sans 10')
    view.unmount()

    Object.assign(h.build, { kind: 'development', commit, dirty: true })
    render(<AboutCard t={t} />)
    expect(screen.getByText('0123456').parentElement).toHaveTextContent(
      `Version ${SHOWN_VERSION}, development build 0123456 (modified)`,
    )
  })

  it('states an unknown source commit for an unpackaged run', () => {
    render(<AboutCard t={t} />)
    expect(
      screen.getByText(`Version ${SHOWN_VERSION}, source commit unknown`),
    ).toBeInTheDocument()
  })
})

describe('AboutCard content', () => {
  it('sets its text in the app sans face, not Arial', () => {
    const { container } = render(<AboutCard t={t} />)
    expect(screen.getByText('Supraspina').style.fontFamily).toContain(
      'WebCM Sans 10',
    )
    for (const element of container.querySelectorAll<HTMLElement>('*')) {
      expect(element.style.fontFamily).not.toMatch(/Arial|Helvetica/)
    }
  })

  it('Keeps internal font-activation evidence out of product content.', () => {
    const { container } = render(<AboutCard t={t} />)
    expect(screen.queryByText('Local typography')).not.toBeInTheDocument()
    expect(container.querySelector('[data-visible-font-face]')).toBeNull()
  })

  it('leaves the update status and its actions to the Updates card', async () => {
    // Settings shows About beside Updates, which states the status and holds
    // Check for updates and Open release page; About repeats neither.
    for (const current of [
      st({ capability: 'full', phase: 'available', version: VERSION }),
      st({ capability: 'notify', phase: 'available', version: VERSION }),
      st({ capability: 'notify', phase: 'not-available' }),
    ]) {
      h.state.current = current
      const view = render(<AboutCard t={t} />)
      await screen.findByText('Yusuf Qwareeq')
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.queryByText(/is available|is up to date/)).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Check for updates' }),
      ).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Open release page' }),
      ).toBeNull()
      view.unmount()
    }
    expect(h.check).not.toHaveBeenCalled()
  })

  it('opens documentation links only through the authorized web bridge', async () => {
    render(<AboutCard t={t} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'github.com/ortizo-117/SCI_Map' }),
    )
    expect(h.openWeb).toHaveBeenCalledWith({
      url: 'https://github.com/ortizo-117/SCI_Map',
      purpose: 'documentation',
    })
  })

  it('opens bundled third-party notices through the path-free native action', () => {
    render(<AboutCard t={t} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Open third-party notices' }),
    )
    expect(h.openThirdPartyNotices).toHaveBeenCalledOnce()
    expect(h.openWeb).not.toHaveBeenCalled()
  })
})
