/** States why a gated control is disabled and offers the control that enables it. */

import { useState, type ReactNode } from 'react'
import { Btn, FONTS, type Theme } from '../../ui'
import type { InstallGate } from './install-gate'

/** One refusal and the enabling actions the hosting screen can run. */
export interface GateNoticeProps {
  t: Theme
  gate: InstallGate
  /** Turn on Allow live runs; omit where the screen offers no such control. */
  onEnableSafeExecution?: (() => void) | undefined
  /** Save the project; omit where the screen offers no save. */
  onSave?: (() => Promise<unknown>) | undefined
}

/**
 * Show the refusal sentence beside the disabled control, with the button that
 * resolves it when the screen supplies one.
 *
 * A disabled button alone does not say what enables it, and a toolbar Save
 * can sit out of sight, so the notice carries the Allow live runs or
 * Save project control itself. A failed save stays inline under the notice.
 */
export function GateNotice({
  t,
  gate,
  onEnableSafeExecution,
  onSave,
}: GateNoticeProps): ReactNode {
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (!onSave) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave()
    } catch (cause: unknown) {
      setSaveError(
        cause instanceof Error ? cause.message : 'Retry saving the project.',
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.textSoft }}
        >
          {gate.reason}
        </span>
        {gate.kind === 'safe-execution' && onEnableSafeExecution && (
          <Btn
            t={t}
            small
            secondary
            label="Allow live runs"
            ariaLabel={`Allow live runs to ${gate.action}`}
            onClick={onEnableSafeExecution}
          />
        )}
        {gate.kind === 'unsaved' && onSave && (
          <Btn
            t={t}
            small
            secondary
            label={saving ? 'Saving...' : 'Save project'}
            ariaLabel={`Save the project to ${gate.action}`}
            disabled={saving}
            onClick={() => void save()}
          />
        )}
      </div>
      {saveError && (
        <span
          role="alert"
          style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.failed }}
        >
          {saveError}
        </span>
      )}
    </div>
  )
}
