/**
 * Parses, formats, and derives Supraspina's UTC date-time versions.
 *
 * The machine form is `YYYYMMDD.HHMM.0` with HHMM as an integer without
 * leading zeros, so 09:05 UTC on 2026-11-21 is `20261121.905.0`. It stays a
 * valid semantic version, so npm, electron-builder, and electron-updater order
 * releases by time. People see the display form, `2026-11-21 09:05 UTC`.
 *
 * The renderer, the main process, and the release scripts import this one
 * module so that every surface agrees.
 */

const MACHINE_VERSION = /^([1-9]\d{3})(\d{2})(\d{2})\.(0|[1-9]\d{0,3})\.0$/

function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * Parse a machine-form version into its UTC date and time.
 *
 * @param {string} version
 * @returns {{year: number, month: number, day: number, hour: number,
 *   minute: number} | null} The UTC fields, or null when the value is not
 *   a real UTC date and time in machine form.
 * @example
 * parseAppVersion('20261121.1830.0')
 * // { year: 2026, month: 11, day: 21, hour: 18, minute: 30 }
 */
export function parseAppVersion(version) {
  const match =
    typeof version === 'string' ? MACHINE_VERSION.exec(version) : null
  if (!match) return null
  const [year, month, day, time] = match.slice(1).map(Number)
  const hour = Math.floor(time / 100)
  const minute = time % 100
  if (hour > 23 || minute > 59) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return { year, month, day, hour, minute }
}

/**
 * Format a version for people.
 *
 * Return any other string unchanged, so records written under the earlier
 * semantic versions still show the version they recorded.
 *
 * @param {string} version
 * @returns {string} `YYYY-MM-DD HH:MM UTC` for a machine-form version.
 * @example
 * formatAppVersion('20261121.905.0')
 * // '2026-11-21 09:05 UTC'
 */
export function formatAppVersion(version) {
  const parsed = parseAppVersion(version)
  if (!parsed) return version
  const { year, month, day, hour, minute } = parsed
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)} UTC`
}

/**
 * Return the UTC calendar date that a machine-form version names.
 *
 * @param {string} version
 * @returns {string} The date as `YYYY-MM-DD`.
 * @throws {Error} On a value that is not a machine-form version.
 * @example
 * appVersionDate('20261121.1830.0')
 * // '2026-11-21'
 */
export function appVersionDate(version) {
  const parsed = parseAppVersion(version)
  if (!parsed) {
    throw new Error(
      `Use a YYYYMMDD.HHMM.0 UTC date-time version without leading zeros in HHMM: ${version}.`,
    )
  }
  return `${parsed.year}-${pad(parsed.month)}-${pad(parsed.day)}`
}

/**
 * Derive the machine-form version for one instant, truncated to the minute.
 *
 * @param {Date} date
 * @returns {string} The machine-form version in UTC.
 * @example
 * appVersionFromDate(new Date('2026-11-21T09:05:59Z'))
 * // '20261121.905.0'
 */
export function appVersionFromDate(date) {
  const year = date.getUTCFullYear()
  const time = date.getUTCHours() * 100 + date.getUTCMinutes()
  return `${year}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}.${time}.0`
}

/**
 * Order two machine-form versions by the instant they name.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 * @throws {Error} On a value that is not a machine-form version.
 */
export function compareAppVersions(left, right) {
  const key = (version) => {
    appVersionDate(version)
    const [date, time] = version.split('.').map(Number)
    return date * 10000 + time
  }
  return key(left) - key(right)
}
