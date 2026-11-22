/** Extends Vitest with DOM matchers, and clears persisted state between tests. */

import '@testing-library/jest-dom/vitest'
import { beforeEach } from 'vitest'

beforeEach(() => {
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    // Ignore unavailable web storage in this environment.
  }
})
