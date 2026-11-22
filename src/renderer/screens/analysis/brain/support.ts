/**
 * Display capability probes for the brain viewer, kept apart so tests can
 * stand in for a display with or without WebGL2.
 */

/**
 * Say whether this display offers a WebGL2 context. The probe context is
 * released at once.
 */
export function supportsWebGl2(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

/**
 * Give the "Larger text" zoom the app applies to its root (`--ss-zoom`).
 *
 * @returns A positive factor, 1 when unset.
 */
export function appZoom(): number {
  const zoom = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--ss-zoom'),
  )
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}
