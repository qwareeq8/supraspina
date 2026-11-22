/**
 * Serialize an Analysis figure to a self-contained SVG file: white paper,
 * physical size in millimeters, and the Computer Modern serif (WebCM, GUST
 * Font License, which allows redistribution) embedded as data URLs, since
 * the renderer's CSP blocks font fetches and a reader may lack the font.
 * Nothing in the file refers outside it.
 */

import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { EMBEDDED_SERIF } from './style'

/** The faces a figure may use: the regular, italic, and bold serif. */
const FACES = {
  regular: {
    weight: 400,
    style: 'normal',
    load: () => import('../assets/fonts/WebCM Serif 10 Regular.woff2?inline'),
  },
  italic: {
    weight: 400,
    style: 'italic',
    load: () => import('../assets/fonts/WebCM Serif 10 Italic.woff2?inline'),
  },
  bold: {
    weight: 700,
    style: 'normal',
    load: () => import('../assets/fonts/WebCM Serif 10 Bold.woff2?inline'),
  },
} as const

/** One embeddable face. */
export type FigureFace = keyof typeof FACES

const faceCss = new Map<FigureFace, Promise<string>>()

/**
 * Build the `@font-face` rule of one embedded face, once.
 *
 * @returns The CSS rule with a data-URL source.
 */
function embeddedFaceCss(face: FigureFace): Promise<string> {
  let rule = faceCss.get(face)
  if (!rule) {
    const { weight, style, load } = FACES[face]
    rule = load().then(
      ({ default: url }) =>
        `@font-face{font-family:'${EMBEDDED_SERIF}';src:url(${url}) format('woff2');font-weight:${weight};font-style:${style};}`,
    )
    faceCss.set(face, rule)
  }
  return rule
}

/**
 * List the faces a figure's markup sets text in, so an export embeds only
 * those (each WebCM face adds about 250 KB, and main renders PDFs only from
 * SVGs up to 1.5 MiB).
 *
 * @returns The faces in embedding order.
 */
export function facesUsed(markup: string): FigureFace[] {
  return [
    'regular',
    ...(/font-style="italic"/.test(markup) ? (['italic'] as const) : []),
    ...(/font-weight="700"/.test(markup) ? (['bold'] as const) : []),
  ]
}

/** The largest SVG main renders to PDF (`MAX_PDF_SVG_BYTES` in main). */
export const MAX_PDF_SVG_BYTES = 1535 * 1024

/**
 * Serialize a figure element to SVG file text.
 *
 * @param figure - The figure drawn in export mode.
 * @param options - Whether to embed the serif; tests may skip it.
 * @returns The SVG document text, without a DOCTYPE.
 */
export async function figureSvg(
  figure: ReactElement,
  options: { embedFonts?: boolean } = {},
): Promise<string> {
  // Render into a detached element rather than pulling in react-dom/server.
  const host = document.createElement('div')
  const root = createRoot(host)
  flushSync(() => root.render(figure))
  const markup = host.innerHTML
  root.unmount()
  const css =
    options.embedFonts === false
      ? ''
      : (await Promise.all(facesUsed(markup).map(embeddedFaceCss))).join('')
  const style = css ? `<defs><style>${css}</style></defs>` : ''
  // Insert the style right after the opening tag, before any drawing.
  const withStyle = markup.replace(/^<svg([^>]*)>/, `<svg$1>${style}`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n${withStyle}\n`
}

/**
 * List the references an SVG makes to anything outside itself: `href`,
 * `src`, and `url(...)` values that are not data URLs or fragment links.
 *
 * @returns The offending values; empty for a self-contained file.
 */
export function externalReferences(svg: string): string[] {
  const found: string[] = []
  for (const match of svg.matchAll(/(?:href|src)\s*=\s*"([^"]*)"/g)) {
    const value = match[1]!
    if (!value.startsWith('#') && !value.startsWith('data:')) found.push(value)
  }
  for (const match of svg.matchAll(/url\(\s*['"]?([^'")]*)/g)) {
    const value = match[1]!
    if (!value.startsWith('#') && !value.startsWith('data:')) found.push(value)
  }
  for (const match of svg.matchAll(/@import[^;]*/g)) found.push(match[0])
  return found
}
