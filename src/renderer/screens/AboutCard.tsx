/** Shows app identity, credits, and allowlisted external links. */

import { useState, type ReactNode } from 'react'
import {
  Brandmark,
  Btn,
  Card,
  CodeText,
  FONTS,
  Hint,
  Ico,
  ICONS,
  ICON_SIZE,
  type Theme,
} from '../ui'
import { getApi } from '../state/api'
import type { SupraspinaApi } from '../../shared/contract'
import {
  describeProductVersion,
  shortBuildCommit,
} from '../../shared/build-identity'
import { APP_BUILD_IDENTITY } from '../build-identity'
import { version as APP_VERSION } from '../../../package.json'

type WebPurpose = Parameters<SupraspinaApi['external']['openWeb']>[0]['purpose']

/** Open an allow-listed HTTPS URL in the system browser, never in-app. */
function openExternal(url: string, purpose: WebPurpose): void {
  void getApi().external.openWeb({ url, purpose })
}

function AboutSection({ t, label }: { t: Theme; label: string }): ReactNode {
  return (
    <h3
      style={{
        fontFamily: FONTS.sans,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.2,
        color: t.dimText,
        margin: '6px 0 0',
      }}
    >
      {label}
    </h3>
  )
}

/** Open an allow-listed URL from a compact inline link. */
function InlineLink({
  t,
  icon,
  label,
  url,
  purpose = 'documentation',
}: {
  t: Theme
  icon: ReactNode
  label: string
  url: string
  purpose?: WebPurpose
}): ReactNode {
  return (
    <button
      type="button"
      onClick={() => openExternal(url, purpose)}
      title={url}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: 24,
        gap: 6,
        padding: '2px 0',
        border: 'none',
        background: 'transparent',
        color: t.accent,
        cursor: 'pointer',
        fontFamily: FONTS.sans,
        fontSize: 12,
        textAlign: 'left',
      }}
    >
      <Ico d={icon} stroke={t.accent} />
      <span style={{ textDecoration: 'underline', textUnderlineOffset: 2 }}>
        {label}
      </span>
    </button>
  )
}

function LinkGroup({ children }: { children: ReactNode }): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '4px 16px',
      }}
    >
      {children}
    </div>
  )
}

/** The active theme for the application identity card. */
export interface AboutCardProps {
  t: Theme
}

/** Show app identity, credits, notices, and contact links. */
export function AboutCard({ t }: AboutCardProps): ReactNode {
  // The version line sets this commit hash, and only it, in mono.
  const shortCommit = shortBuildCommit(APP_BUILD_IDENTITY)
  const [noticesError, setNoticesError] = useState('')
  const openNotices = (): void => {
    setNoticesError('')
    void getApi()
      .external.openThirdPartyNotices()
      .catch(() => setNoticesError('Could not open the third-party notices.'))
  }
  return (
    <Card t={t} title="About">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Brandmark size={44} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span
              style={{
                fontFamily: FONTS.sans,
                fontSize: 19,
                fontWeight: 700,
                lineHeight: 1.15,
                color: t.textStrong,
              }}
            >
              Supraspina
            </span>
            <span
              style={{ fontFamily: FONTS.sans, fontSize: 12, color: t.dim }}
            >
              <CodeText
                text={`Version ${describeProductVersion(APP_VERSION, APP_BUILD_IDENTITY)}`}
                code={shortCommit === null ? [] : [shortCommit]}
              />
            </span>
          </div>
        </div>
        <Hint t={t}>
          Research software for structural-MRI and brain-age workflows. Not for
          diagnosis or clinical decisions.
        </Hint>

        <AboutSection t={t} label="Pipeline" />
        <Hint t={t}>
          Thank you to Oscar Ortiz Angulo and Ryan Loke for SCI_Map, the
          structural-MRI pipeline Supraspina builds on.
        </Hint>
        <LinkGroup>
          <InlineLink
            t={t}
            icon={ICONS.github}
            label="github.com/ortizo-117/SCI_Map"
            url="https://github.com/ortizo-117/SCI_Map"
          />
        </LinkGroup>

        <AboutSection t={t} label="Built on" />
        <LinkGroup>
          <InlineLink
            t={t}
            icon={ICONS.external}
            label="FreeSurfer"
            url="https://surfer.nmr.mgh.harvard.edu"
          />
          <InlineLink
            t={t}
            icon={ICONS.external}
            label="ENIGMA FreeSurfer QC protocol"
            url="https://enigma.ini.usc.edu/protocols/imaging-protocols/"
          />
          <InlineLink
            t={t}
            icon={ICONS.external}
            label="PyBrainAge v3 model (James Cole)"
            url="https://zenodo.org/records/10406573"
          />
        </LinkGroup>

        <AboutSection t={t} label="Licenses and notices" />
        <Hint t={t}>
          MIT license for Supraspina code. Third-party components keep their own
          terms.
        </Hint>
        <div>
          <Btn
            t={t}
            small
            ghost
            icon={<Ico d={ICONS.external} size={ICON_SIZE.nav} />}
            label="Open third-party notices"
            onClick={openNotices}
          />
        </div>
        {noticesError && (
          <Hint t={t} style={{ color: t.failed }}>
            <span role="alert">{noticesError}</span>
          </Hint>
        )}

        <AboutSection t={t} label="Author" />
        <LinkGroup>
          <span
            style={{
              color: t.textSoft,
              fontFamily: FONTS.sans,
              fontSize: 12,
            }}
          >
            Yusuf Qwareeq
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: t.textSoft,
              fontFamily: FONTS.sans,
              fontSize: 12,
            }}
          >
            <Ico d={ICONS.mail} />
            yusuf@qwareeq.com
          </span>
          <InlineLink
            t={t}
            icon={ICONS.github}
            label="@qwareeq8"
            url="https://github.com/qwareeq8"
          />
          <InlineLink
            t={t}
            icon={ICONS.globe}
            label="qwareeq.com"
            url="https://qwareeq.com/"
          />
        </LinkGroup>
      </div>
    </Card>
  )
}
