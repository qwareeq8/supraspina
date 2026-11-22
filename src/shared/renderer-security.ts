/** Fixes the privileged development renderer to its reviewed port. */
export const DEVELOPMENT_RENDERER_PORT = '5173'
/** The canonical loopback development renderer URL. */
export const DEFAULT_DEVELOPMENT_RENDERER_URL = 'http://127.0.0.1:5173/'

const LOOPBACK_RENDERER_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

const BASE_RENDERER_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
] as const

/** The policy that prevents packaged renderers from making network connections or running inline JavaScript. */
export const PRODUCTION_RENDERER_CSP = [
  ...BASE_RENDERER_DIRECTIVES.slice(0, 5),
  "connect-src 'none'",
  ...BASE_RENDERER_DIRECTIVES.slice(5),
  "script-src 'self'",
].join('; ')

/**
 * Normalize the only development renderer locations main will load.
 *
 * Require the exact root path because accepting an arbitrary path on a local
 * development server would also broaden privileged IPC to that page.
 *
 * @throws Error when the URL violates the development boundary.
 */
export function normalizeDevelopmentRendererUrl(value: string): string {
  let candidate: URL
  try {
    candidate = new URL(value)
  } catch {
    throw new Error('Provide a valid development renderer URL.')
  }
  if (
    !['http:', 'https:'].includes(candidate.protocol) ||
    !LOOPBACK_RENDERER_HOSTS.has(candidate.hostname.toLowerCase()) ||
    candidate.port !== DEVELOPMENT_RENDERER_PORT ||
    candidate.username !== '' ||
    candidate.password !== '' ||
    candidate.pathname !== '/' ||
    candidate.search !== '' ||
    candidate.hash !== ''
  ) {
    throw new Error(
      'Use a credential-free loopback HTTP(S) development URL on port 5173 with path "/".',
    )
  }
  return candidate.href
}

/**
 * Build a development CSP for one validated loopback renderer URL.
 *
 * @returns The renderer policy for that loopback origin.
 * @throws Error when the URL violates the development boundary.
 */
export function developmentRendererCsp(rendererUrl: string): string {
  const normalized = normalizeDevelopmentRendererUrl(rendererUrl)
  const candidate = new URL(normalized)
  const websocketProtocol = candidate.protocol === 'https:' ? 'wss:' : 'ws:'
  const websocketOrigin = `${websocketProtocol}//${candidate.host}`
  return [
    ...BASE_RENDERER_DIRECTIVES.slice(0, 5),
    `connect-src 'self' ${websocketOrigin}`,
    ...BASE_RENDERER_DIRECTIVES.slice(5),
    "script-src 'self' 'unsafe-inline'",
  ].join('; ')
}

/** The CSP for the canonical development renderer URL. */
export const DEFAULT_DEVELOPMENT_RENDERER_CSP = developmentRendererCsp(
  DEFAULT_DEVELOPMENT_RENDERER_URL,
)

/** The marker for the single renderer CSP element managed during the build. */
export const MANAGED_RENDERER_CSP_ATTRIBUTE = 'data-supraspina-csp="managed"'

/**
 * Replace the single managed CSP meta element during Vite development.
 *
 * Use the checked marker to make source/build drift fail the build instead of
 * silently shipping a development policy or an unprotected document.
 *
 * @throws Error when the policy or managed element is invalid.
 */
export function replaceManagedRendererCsp(
  html: string,
  policy: string,
): string {
  if (policy.length === 0 || /["<>\r\n]/.test(policy)) {
    throw new Error('Represent the renderer CSP safely in HTML.')
  }
  const markerCount = html.split(MANAGED_RENDERER_CSP_ATTRIBUTE).length - 1
  if (markerCount !== 1) {
    throw new Error(
      'Include exactly one managed CSP meta element in renderer HTML.',
    )
  }
  const markerIndex = html.indexOf(MANAGED_RENDERER_CSP_ATTRIBUTE)
  const tagStart = html.lastIndexOf('<meta', markerIndex)
  const tagEnd = html.indexOf('>', markerIndex)
  if (tagStart < 0 || tagEnd < 0) {
    throw new Error('Provide a well-formed managed renderer CSP meta element.')
  }
  const tag = html.slice(tagStart, tagEnd + 1)
  const contentAttributes = tag.match(/\bcontent="[^"]*"/g)
  if (contentAttributes?.length !== 1) {
    throw new Error(
      'Include exactly one content attribute on the managed renderer CSP meta element.',
    )
  }
  const securedTag = tag.replace(contentAttributes[0], `content="${policy}"`)
  return `${html.slice(0, tagStart)}${securedTag}${html.slice(tagEnd + 1)}`
}

/** Response headers accepted by the renderer CSP hardener. */
export type RendererResponseHeaders = Record<string, string | readonly string[]>

/**
 * Replace any existing CSP header with the reviewed renderer policy.
 *
 * @param responseHeaders - The original response headers when present.
 * @returns Copied headers with exactly one canonical CSP entry.
 */
export function withRendererCsp(
  responseHeaders: RendererResponseHeaders | undefined,
  policy: string,
): Record<string, string | string[]> {
  const secured: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(responseHeaders ?? {})) {
    if (name.toLowerCase() === 'content-security-policy') continue
    secured[name] = typeof value === 'string' ? value : [...value]
  }
  secured['Content-Security-Policy'] = [policy]
  return secured
}
