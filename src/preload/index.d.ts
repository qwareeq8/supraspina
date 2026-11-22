/**
 * Types the `window.supraspina` bridge published by the preload layer.
 * Import this declaration through the renderer tsconfig to type every screen.
 */

import type { SupraspinaApi } from '../shared/contract'

declare global {
  interface Window {
    supraspina?: SupraspinaApi
  }
}

export {}
