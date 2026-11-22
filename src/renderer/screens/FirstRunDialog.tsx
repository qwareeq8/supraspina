/**
 * Offers skippable first-run preferences through the shared accessible modal
 * and controls. Choices apply live, and the modal owns focus management.
 */

import { useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useApp } from '../state/context'
import { Btn, Divider, FONTS, Hint, Modal } from '../ui'
import {
  AccessibilityControls,
  DisplayBehaviorControls,
  SafeExecutionControls,
} from './PreferencesControls'

/** Render the skippable first-run dialog while onboarding is pending. */
export function FirstRunDialog(): ReactNode {
  const {
    t,
    tweaks,
    setTweaks,
    resetTweaks,
    safeExecution,
    setSafeExecution,
    markFirstRunDone,
  } = useApp()
  const headingRef = useRef<HTMLHeadingElement | null>(null)

  // Dismiss on Escape without forcing a choice. Leave focus management to Modal.
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      markFirstRunDone()
    }
  }

  return (
    <Modal
      t={t}
      onDismiss={markFirstRunDone}
      labelledBy="firstrun-title"
      initialFocusRef={headingRef}
      onKeyDown={onKeyDown}
      cardStyle={{
        width: 540,
        maxWidth: '92vw',
        maxHeight: '84vh',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '16px 20px 10px' }}>
        <h2
          ref={headingRef}
          id="firstrun-title"
          tabIndex={-1}
          style={{
            margin: 0,
            fontFamily: FONTS.serif,
            fontWeight: 400,
            fontSize: 18,
            color: t.textStrong,
            outline: 'none',
          }}
        >
          Welcome to Supraspina
        </h2>
        <Hint t={t} style={{ marginTop: 4 }}>
          You can change these later in Settings.
        </Hint>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '0 20px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <Divider t={t} label="Display and behavior" style={{ marginTop: 4 }} />
        <DisplayBehaviorControls t={t} tweaks={tweaks} onChange={setTweaks} />
        <Divider t={t} label="Accessibility" style={{ marginTop: 10 }} />
        <AccessibilityControls t={t} tweaks={tweaks} onChange={setTweaks} />
        {/* Running gates live work, so it takes its own group, as Settings
            gives it its own card. */}
        <Divider t={t} label="Running" style={{ marginTop: 10 }} />
        <SafeExecutionControls
          t={t}
          value={safeExecution}
          onChange={setSafeExecution}
        />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 8,
          padding: '12px 20px',
          borderTop: `1px solid ${t.border}`,
        }}
      >
        <Btn
          t={t}
          label="Use defaults"
          onClick={() => {
            resetTweaks()
            setSafeExecution(false)
            markFirstRunDone()
          }}
        />
        <Btn t={t} primary label="Continue" onClick={markFirstRunDone} />
      </div>
    </Modal>
  )
}
