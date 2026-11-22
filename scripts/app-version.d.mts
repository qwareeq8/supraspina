/** Declares the date-time version helpers that TypeScript sources import. */

/** The UTC fields that one machine-form version names. */
export interface AppVersionParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** Parse a machine-form version, or return null for any other value. */
export function parseAppVersion(version: string): AppVersionParts | null

/** Format a machine-form version for people, and return other values unchanged. */
export function formatAppVersion(version: string): string

/** Return the `YYYY-MM-DD` UTC date that a machine-form version names. */
export function appVersionDate(version: string): string

/** Derive the machine-form version for one instant, truncated to the minute. */
export function appVersionFromDate(date: Date): string

/** Order two machine-form versions by the instant they name. */
export function compareAppVersions(left: string, right: string): number
