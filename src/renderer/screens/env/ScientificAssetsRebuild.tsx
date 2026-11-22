/**
 * Offers the offline rebuild of the acquired scientific assets as one
 * prominent Diagnostics action. The card states why the rebuild is needed,
 * what it restores, and what enables it, instead of leaving the operator to
 * find a disabled Install inside a check group.
 */

import type { ReactNode } from 'react'
import { Btn, FONTS, Hint, Ico, ICONS, ICON_SIZE, type Theme } from '../../ui'
import type { EnvInstallState } from '../../../shared/contract'
import type { OfflineAssetRebuild } from './asset-rebuild'
import { GateNotice } from './GateNotice'
import type { InstallGate } from './install-gate'
import { EnvInstallView } from './InstallState'

/** The rebuild, its gate, and its latest operation. */
export interface ScientificAssetsRebuildProps {
  t: Theme
  rebuild: OfflineAssetRebuild
  /** The first unmet condition, or null when the rebuild can start. */
  gate: InstallGate | null
  /** Whether this card's rebuild is the running installation. */
  running: boolean
  /** The latest rebuild operation, running or settled. */
  install?: EnvInstallState | undefined
  /** Open the authorization for the rebuild. */
  onRebuild: () => void
  onEnableSafeExecution?: (() => void) | undefined
  onSave?: (() => Promise<unknown>) | undefined
}

/**
 * Show the offline rebuild with its reason, the checks it restores, the
 * condition that gates it, one primary action, and its progress.
 */
export function ScientificAssetsRebuild({
  t,
  rebuild,
  gate,
  running,
  install,
  onRebuild,
  onEnableSafeExecution,
  onSave,
}: ScientificAssetsRebuildProps): ReactNode {
  const { check, restores } = rebuild
  return (
    <section
      aria-labelledby="scientific-assets-rebuild-title"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '14px 16px',
        borderRadius: 6,
        background: t.surface,
        border: `1px solid ${t.accent}`,
        borderLeft: `3px solid ${t.accent}`,
      }}
    >
      <h2
        id="scientific-assets-rebuild-title"
        // A callout card, so its title takes the Card title treatment.
        style={{
          margin: 0,
          fontFamily: FONTS.sans,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.2,
          color: t.dim,
        }}
      >
        Rebuild the scientific assets
      </h2>
      {check.detail && (
        <span
          style={{ fontFamily: FONTS.sans, fontSize: 13, color: t.textSoft }}
        >
          {check.detail}
        </span>
      )}
      {restores.length > 0 && (
        <Hint t={t}>
          Restores {restores.map((entry) => entry.label).join(', ')}.
        </Hint>
      )}
      {gate && (
        <GateNotice
          t={t}
          gate={gate}
          onEnableSafeExecution={onEnableSafeExecution}
          onSave={onSave}
        />
      )}
      <div>
        <Btn
          t={t}
          primary={gate === null && !running}
          label={running ? 'Rebuilding assets...' : 'Rebuild assets'}
          icon={<Ico d={ICONS.play} size={ICON_SIZE.nav} />}
          disabled={gate !== null || running}
          title={gate?.reason ?? 'Rebuild the scientific assets.'}
          ariaLabel="Rebuild the scientific assets"
          onClick={onRebuild}
        />
      </div>
      {install && (
        <EnvInstallView t={t} label={check.label} state={install} rebuild />
      )}
    </section>
  )
}
